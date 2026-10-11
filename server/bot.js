// Bot inteligente. Recebe EXATAMENTE as mesmas mensagens que um cliente humano (snapshots limitados pela visão,
// avisos, chat…) e age pelas mesmas mensagens (input, kill, vote, ab…), então as regras/recargas são as do jogador.
// Nunca lê o estado de outros jogadores no servidor: tudo o que "sabe" vem de percepção, habilidades ou chat.
import { STATIONS, SPECIAL, VENTS, ROOMS, TASK_MIN, roomAt } from '../shared/map.js';
import { JOB, JOBS, colorTone } from '../shared/jobs.js';
import { findPath } from './nav.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const roll = p => Math.random() < p;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const KILL_R = 95, REPORT_R = 150;
const STN = Object.fromEntries(STATIONS.map(s => [s.id, s]));
const roomName = (x, y) => roomAt(x, y)?.name || 'um corredor';
const CENTERS = ROOMS.filter(r => !r.hidden).map(r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2, name: r.name }));
const JOB_BY_NAME = Object.fromEntries(JOBS.map(j => [j.name.toLowerCase(), j]));

export class Bot {
  constructor(room, p) {
    Object.assign(this, { room, p, clock: 0, job: null, ghostJob: null, team: null, target: null, mates: new Set(), roster: new Map(), tasks: [], pos: { x: p.x, y: p.y },
      vis: new Map(), prevVis: new Map(), seen: new Map(), bodies: new Map(), deadKnown: new Set(), meetDead: new Set(), hiddenDead: new Set(), known: new Map(), susp: new Map(), why: new Map(), heat: new Map(),
      ab: { cd: {}, act: {}, us: {}, sup: 0 }, sab: null, cdKill: 99, sabCd: 99, vr: 420, tk: [0, 1], loc: null, goal: null, path: null, pi: 0, repath: 0, pause: 0, work: null, lastIn: '', stuckT: 0, stuckP: { x: p.x, y: p.y },
      phase: 'play', mtg: null, mtgAlive: new Set(), chatQ: [], voted: false, voteAt: 0, supLeft: 0, jp: false, lastKillAt: -99, meetEnd: 0, abT: 0, danger: null, ventUntil: 0, watching: false, watchUntil: 0,
      lastRoom: '', ended: false, nextPanel: 40, camLed: 0, accusedBy: new Set(), pendKill: null, panelDone: false, deathBy: null, killerJob: null, mtgStart: 0, lastGoalPick: 0, gameT0: 0, usedEmerg: 0, ghostT: 0, comp: new Map() });
    this.trait = { chatty: rnd(0.7, 1.3), brave: rnd(0.6, 1.4), curious: rnd(0.6, 1.4) };
  }
  c(k) { return this.room.settings[k]; }
  pc(k) { return this.room.settings[k] / 100; }
  get imp() { return this.team === 'imp'; }
  eff() { return this.p.alive ? this.job : this.ghostJob; }
  nm(id) { return this.roster.get(id)?.name || '?'; }
  act(m) { this.room.handle(this.p, m); }
  input(x, y) { const k = x.toFixed(1) + ',' + y.toFixed(1); if (k === this.lastIn) return; this.lastIn = k; this.act({ t: 'input', x, y }); }
  stop() { this.input(0, 0); }

  // ================= mensagens recebidas (só memória; nenhuma ação aqui) =================
  onMsg(m) {
    switch (m.t) {
      case 'start': case 'resume': this.init(m); break;
      case 'snap': this.onSnap(m); break;
      case 'taskOk': { const t = this.tasks.find(x => x.id === m.id); if (t) t.done = true; break; }
      case 'fx': this.onKillFx(m); break;
      case 'died': this.deathBy = m.by; break;
      case 'ghost': this.ghostJob = m.job; break;
      case 'meeting': this.onMeeting(m); break;
      case 'phase': if (m.p === 'vote') { this.phase = 'vote'; this.voteDur = m.time; this.voteAt = this.clock + Math.min(m.time - 2.5, rnd(0.12, 0.65) * m.time * (0.6 + this.c('bot_react') / 3)); } break;
      case 'chat': this.hear(m); break;
      case 'result': this.onResult(m); break;
      case 'play': this.onPlay(); break;
      case 'hint': this.onHint(m.text); break;
      case 'panel': this.onPanel(m.list); break;
      case 'jobpanel': for (const [id, job, al] of m.list) { this.known.set(id, job); if (!al) this.deadKnown.add(id); } this.jpDone = true; break;
      case 'reveal': for (const [id, job] of m.list) this.known.set(id, job); break;
      case 'unlock': this.jp = true; break;
      case 'sup': this.supLeft = m.left; break;
      case 'infmsg': this.onInf(m.text); break;
      case 'camOff': this.watching = false; break;
      case 'end': this.ended = true; break;
    }
  }
  init(m) {
    this.job = m.job; this.team = m.team; this.ghostJob = m.ghostJob; this.target = m.target; this.supLeft = m.sup || 0; this.jp = !!m.jp;
    this.mates = new Set(m.mates.map(x => x[0])); for (const [id, j] of m.mates) this.known.set(id, j);
    this.roster = new Map(m.players.map(q => [q.id, q])); this.tasks = m.tasks.map(t => ({ ...t })); this.pos = { x: m.x, y: m.y }; this.gameT0 = this.clock;
  }
  sus(id, d, why) {
    if (id === this.p.id || this.mates.has(id) || this.deadKnown.has(id) || !this.roster.has(id)) return;
    const v = clamp((this.susp.get(id) ?? 20) + d * (0.45 + this.pc('bot_sus')), 0, 100); this.susp.set(id, v); if (why && d > 0) this.why.set(id, why);
  }
  onSnap(m) {
    const me = this.p; this.pos = { x: m.you[0], y: m.you[1] }; this.sab = m.sab; this.tk = m.tk; this.ab = m.ab; this.vr = m.vr == null ? 3000 : m.vr; this.loc = m.loc; this.intro = m.intro;
    if (m.cd) { this.cdKill = m.cd[0]; this.sabCd = m.cd[1]; } this.lastRoom = roomName(this.pos.x, this.pos.y);
    const cur = new Map(); for (const [id, x, y, face, mv, gh, ap, inv] of m.pl) cur.set(id, { id, x, y, mv: !!mv, ghost: !!gh, ap, inv: !!inv });
    const look = Math.min(this.vr, 420);
    if (me.alive && me.vent < 0 && !this.watching) {
      for (const [id, o] of this.prevVis) if (!cur.has(id) && !o.ghost && dist(o, this.pos) < look * 0.75) { if (VENTS.some(v => dist(v, o) < 70)) this.sus(id, 45, 'vent'); else if (roll(0.7)) this.sus(id, 14, 'sumiu'); }
      const aps = new Map(); for (const o of cur.values()) { const k = o.ap ?? o.id; if (aps.has(k)) { this.sus(o.id, 12, 'duplo'); this.sus(aps.get(k), 12, 'duplo'); } aps.set(k, o.id); }
      for (const [id, o] of cur) { const pv = this.prevVis.get(id); if (pv && pv.ap !== o.ap && dist(o, this.pos) < 380) this.sus(id, 40, 'transformou'); }
    }
    this.vis = cur; this.prevVis = cur; for (const [id, o] of cur) this.seen.set(id, { x: o.x, y: o.y, t: this.clock });
    { const arr = [...cur.values()].filter(o => !o.ghost); for (const a of arr) for (const b of arr) if (a !== b && dist(a, b) < 220) this.comp.set(b.id, { id: a.id, t: this.clock }); } // quem estava com quem
    const seenB = new Set();
    for (const [id, x, y, g] of m.bd) { seenB.add(id); const b = this.bodies.get(id); if (!b) this.onBody(id, x, y); else { b.t = this.clock; b.remote = false; } }
    for (const [id, b] of [...this.bodies]) if (!seenB.has(id) && !b.remote && !b.cam && me.alive && dist(b, this.pos) < look * 0.7) { this.bodies.delete(id); this.hiddenDead.add(id); for (const o of cur.values()) if (dist(o, b) < 350) this.sus(o.id, 18, 'near'); }
    const arrowIds = new Set();
    for (const [ax, ay] of m.ar) { const key = 'a' + ax + '_' + ay; arrowIds.add(key); if (![...this.bodies.values()].some(b => dist(b, { x: ax, y: ay }) < 90)) this.bodies.set(key, { id: key, x: ax, y: ay, remote: true, t: this.clock, reactAt: this.clock + this.c('bot_react') * rnd(0.4, 1.1) }); }
    for (const [id, b] of [...this.bodies]) if (b.remote && String(id).startsWith('a') && !arrowIds.has(id)) this.bodies.delete(id);
    if (m.cams) this.onCams(m.cams);
    if (m.co && this.camLedNear()) this.camLed = this.clock;
  }
  camLedNear() { return [[1500, 650], [980, 930], [2000, 930], [2000, 1530]].some(([x, y]) => dist({ x, y }, this.pos) < 380); }
  onBody(id, x, y, viaCam) {
    const b = { id, x, y, t: this.clock, rep: false, cam: !!viaCam, reactAt: this.clock + this.c('bot_react') * rnd(0.4, 1.1) }; this.bodies.set(id, b); this.deadKnown.add(id); this.hiddenDead.delete(id);
    for (const [pid, o] of this.seen) if (pid !== id && this.clock - o.t < 12 && dist(o, b) < 380) this.sus(pid, (dist(o, b) < 200 ? 28 : 16) * (this.clock - o.t < 3 ? 1 : 0.6), 'near');
    if (this.loc && dist({ x: this.loc[0], y: this.loc[1] }, b) < 450) this.sus(this.loc[2], 18, 'near');
    const cp = this.comp.get(id); if (cp && cp.id !== this.p.id && this.clock - cp.t < 90) this.sus(cp.id, 32, 'last');
    if (this.imp && this.clock - this.lastKillAt < 4) b.mine = true;
  }
  onCams(cams) {
    for (const [pl, bd] of cams) { for (const e of pl) this.seen.set(e[0], { x: e[1], y: e[2], t: this.clock }); for (const [id, x, y] of bd) if (!this.bodies.has(id) && !this.meetDead.has(id)) this.onBody(id, x, y, true); }
  }
  onKillFx(m) {
    this.deadKnown.add(m.id); const at = { x: m.x, y: m.y }, near = [...this.vis.values()].filter(o => !o.ghost && o.id !== m.id && dist(o, at) < 230);
    for (const o of near) this.sus(o.id, near.length === 1 ? 85 : 45, 'kill');
    if (!this.imp && this.p.alive && dist(at, this.pos) < 420 && near.length) this.danger = { from: near[0], until: this.clock + 7 };
    if (!this.imp && this.p.alive && !this.bodies.size && m.k === 'killg') this.hiddenDead.add(m.id);
  }
  onMeeting(m) {
    Object.assign(this, { phase: 'meet', mtg: m, voted: false, mtgAlive: new Set(m.alive), panelDone: false, mtgStart: this.clock, goal: null, path: null, work: null, watching: false, ventUntil: 0, pendKill: null, danger: null });
    for (const d of m.dead) { this.deadKnown.add(d); this.meetDead.add(d); this.hiddenDead.delete(d); } this.bodies.clear(); this.accusedBy.clear(); this.heat.clear();
    this.chatQ = this.p.alive ? this.compose(m) : [];
  }
  onPlay() { Object.assign(this, { phase: 'play', mtg: null, goal: null, path: null, work: null, lastIn: '', meetEnd: this.clock, sab: null, danger: null, watching: false }); this.bodies.clear(); for (const [id, v] of this.susp) this.susp.set(id, v + (20 - v) * 0.2); }
  onResult(m) {
    if (m.ejected != null) { this.deadKnown.add(m.ejected); this.meetDead.add(m.ejected); const vs = m.votes[m.ejected] || []; for (const v of vs) { if (m.imp === false) this.sus(v, 10, 'accused'); else if (m.imp === true) this.sus(v, -14); } if (m.imp === true) this.known.set(m.ejected, 'impostor'); }
  }
  onHint(text) { const t = /cor (?:de quem matou é )?(\w+)/.exec(text || ''); if (t) this.applyTone(t[1].replace(/\W/g, '')); }
  applyTone(tone) { for (const [id, r] of this.roster) if (id !== this.p.id && !this.deadKnown.has(id)) { if (colorTone(r.look.c) === tone) this.sus(id, 38, 'tone'); else this.sus(id, -6); } this.toneHint = tone; }
  onInf(text) {
    const t = /tem cor (\w+)/.exec(text), j = /era ([^.]+)\./.exec(text), w = /fui morto em ([^.]+)\./.exec(text);
    if (t) this.applyTone(t[1]); if (j) this.killerJob = JOB_BY_NAME[j[1].trim().toLowerCase()] || null;
    if (w) { const room = ROOMS.find(r => r.name === w[1].trim()); if (room) { const c = { x: room.x + room.w / 2, y: room.y + room.h / 2 }; for (const [id, o] of this.seen) if (this.clock - o.t < 70 && dist(o, c) < 420) this.sus(id, 12, 'near'); } }
  }
  onPanel(list) { for (const [id, al] of list) if (!al) { this.deadKnown.add(id); if (!this.meetDead.has(id) && !this.bodies.has(id)) this.hiddenDead.add(id); } }
  hear(m) {
    if (m.id === this.p.id) return; const text = String(m.text).toLowerCase();
    const accuse = /(sus|suspeit|matou|impostor|mentiu|mente|mentira|vent|duto|sumiu|perto do corpo|votem|votar|vota |foi o|foi a|culpa|estranh)/.test(text), defend = /(inocente|limpo|confio|n[aã]o foi|n[aã]o fui|tava|estava|fazendo task)/.test(text);
    const trust = 1 - (this.susp.get(m.id) ?? 20) / 130;
    for (const [id, r] of this.roster) {
      if (id === m.id || !text.includes(r.name.toLowerCase())) continue;
      if (accuse) { this.heat.set(id, (this.heat.get(id) || 0) + 1); this.sus(id, 13 * trust, 'accused'); if (id === this.p.id && !this.accusedBy.has(m.id)) { this.accusedBy.add(m.id); this.defend(m.id); } }
      else if (defend) this.sus(id, -5 * trust);
    }
  }

  // ================= decisão =================
  tick(dt) {
    this.clock += dt; if (this.ended || this.room.phase === 'end' || this.room.phase === 'lobby') return;
    const ph = this.room.phase; if (ph === 'play') this.playTick(dt); else if (ph === 'meet') this.meetTick(dt); else if (ph === 'vote') { this.meetTick(dt); this.voteTick(); }
  }
  playTick(dt) {
    const p = this.p; if (this.room.intro > 0) return;
    if (this.pendKill && this.clock - this.pendKill.at > 0.3) { const pk = this.pendKill; this.pendKill = null; if (this.cdKill > 5) this.afterKill(pk); }
    if (this.watching) return this.camTick();
    if (p.vent >= 0) return this.ventTick();
    if (this.pause > 0) { this.pause -= dt; this.stop(); return; }
    if (this.hold > this.clock) { this.stop(); return; }
    if (this.work) return this.workTick();
    if (this.clock - this.abT > 0.5) { this.abT = this.clock; this.abilityTick(); }
    this.react();
    if (!this.goal || this.goalDone()) this.pickGoal();
    this.runGoal(); this.moveAlong();
  }
  // ---- reações de alta prioridade ----
  react() {
    const p = this.p, imp = this.imp;
    if (p.alive && this.sab && (!imp || roll(0.01))) { const g = this.fixGoal(); if (g && (!imp || this.sab.k !== 'heat')) this.setGoal(g); }
    if (p.alive) {
      const b = this.nearestBody();
      if (b && this.clock >= b.reactAt) {
        if (!imp) this.setGoal({ k: 'report', x: b.x, y: b.y, r: 105, pr: 90, bid: b.id });
        else if (!b.mine && roll(0.002 + this.pc('bot_lie') * 0.01)) this.setGoal({ k: 'report', x: b.x, y: b.y, r: 105, pr: 90, bid: b.id });
        else if (b.mine && !b.decided) { b.decided = true; const alone = this.witnesses(-1) === 0; if (alone && roll(0.1 * this.pc('bot_lie'))) this.setGoal({ k: 'report', x: b.x, y: b.y, r: 105, pr: 90, bid: b.id }); }
      }
      if (!imp && this.danger && this.clock < this.danger.until && !(this.job === 'xerife' && this.ab.cd.skill <= 0)) this.setGoal(this.fleeGoal(this.danger.from, 85));
      if (!imp && this.p.alive && this.emergencyWanted()) this.setGoal({ k: 'emerg', x: SPECIAL.emergency.x, y: SPECIAL.emergency.y + 30, r: 80, pr: 70 });
    }
  }
  nearestBody() { let best = null, bd = 1e9; for (const b of this.bodies.values()) { if (b.rep) continue; const d = dist(b, this.pos); if (d < bd) { bd = d; best = b; } } return best; }
  emergencyWanted() {
    if (this.usedEmerg >= this.room.settings.emergencies || this.clock - this.meetEnd < 25) return false;
    if (this.hiddenDead.size && this.clock - this.meetEnd > 20 && roll(0.05)) return true;
    const top = this.topSuspect(); return !!top && top.v > 92 && roll(0.01);
  }
  fixGoal() {
    const s = this.sab; if (!s) return null; const pts = s.k === 'lights' ? [['lights', SPECIAL.lights]] : s.k === 'comms' ? [['comms', SPECIAL.comms]] : [['A', SPECIAL.heatA, 0], ['B', SPECIAL.heatB, 1]].filter(q => !s.fixed[q[2]]);
    if (!pts.length) return null; pts.sort((a, b) => dist(a[1], this.pos) - dist(b[1], this.pos));
    const [id, pt] = pts[0]; if (this.job === 'engenheiro' && this.ab.cd.remoteFix <= 0) return null;
    return { k: 'fix', x: pt.x, y: pt.y, r: 70, pr: 80, id };
  }
  fleeGoal(from, pr) {
    let best = null, bs = -1; for (const c of CENTERS) { const d = dist(c, from) - dist(c, this.pos) * 0.3 + (this.crowd(c) * 120) + rnd(0, 200); if (d > bs) { bs = d; best = c; } }
    return { k: 'flee', x: best.x + rnd(-60, 60), y: best.y + rnd(-60, 60), r: 70, pr, until: this.clock + 9 };
  }
  crowd(c) { let n = 0; for (const [id, o] of this.seen) if (this.clock - o.t < 20 && dist(o, c) < 350) n++; return n; }
  witnesses(excl) {
    const R = this.sab?.k === 'lights' ? 175 : 430; let n = 0;
    for (const o of this.vis.values()) if (!o.ghost && o.id !== excl && !this.mates.has(o.id) && dist(o, this.pos) < R) n++; return n;
  }
  topSuspect(filter) {
    let best = null; for (const [id, v] of this.susp) { if (this.deadKnown.has(id) || id === this.p.id || this.mates.has(id) || (filter && !filter(id))) continue; if (!best || v > best.v) best = { id, v }; } return best;
  }
  // ---- metas ----
  setGoal(g) {
    const cg = this.goal; if (cg && !this.goalDone()) { if (cg.pr > g.pr) return false; if (cg.k === g.k && cg.id === g.id && cg.bid === g.bid) return true; }
    this.goal = { ...g, t0: this.clock }; this.path = null; this.pi = 0; this.repath = 0; return true;
  }
  goalDone() { const g = this.goal; return !g || g.done || (g.until && this.clock > g.until); }
  pickGoal() {
    const p = this.p, J = this.eff(); this.lastGoalPick = this.clock;
    if (p.alive && this.team === 'neu') { const g = this.neutralGoal(); if (g) return void this.setGoal(g); }
    if (p.alive && this.imp) { const g = this.impGoal(); if (g) return void this.setGoal(g); }
    if (p.alive && J === 'xerife' || J === 'mentalista') { const t = this.topSuspect(id => !this.known.has(id) || JOB[this.known.get(id)].team !== 'inn'); if (t && t.v > 55 && p.alive && roll(0.6)) return void this.setGoal({ k: 'follow', id: t.id, r: 140, pr: 35, until: this.clock + rnd(10, 22) }); }
    const pend = this.tasks.filter(t => !t.done), task = this.pc('bot_task');
    if (pend.length && roll(task)) { const t = this.chooseTask(pend); return void this.setGoal({ k: 'task', id: t.id, x: STN[t.id].x, y: STN[t.id].y + 34, r: 50, pr: 40 }); }
    if (p.alive && roll(this.pc('bot_follow') * 0.5)) { const o = this.someoneRecent(); if (o) return void this.setGoal({ k: 'follow', id: o, r: 160, pr: 30, until: this.clock + rnd(6, 16) }); }
    if (p.alive && !this.imp && roll(this.pc('bot_cam') * 0.1)) return void this.setGoal({ k: 'cam', x: SPECIAL.camConsole.x, y: SPECIAL.camConsole.y + 30, r: 60, pr: 25 });
    this.setGoal(this.wanderGoal());
  }
  chooseTask(pend) { const w = pend.map(t => 1 / (dist(STN[t.id], this.pos) + 250)); let r = Math.random() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < pend.length; i++) { r -= w[i]; if (r <= 0) return pend[i]; } return pend[0]; }
  someoneRecent() { const a = [...this.seen].filter(([id, o]) => this.clock - o.t < 15 && !this.deadKnown.has(id)); return a.length ? pick(a)[0] : null; }
  wanderGoal() { const c = pick(CENTERS); return { k: 'wander', x: c.x + rnd(-110, 110), y: c.y + rnd(-90, 90), r: 60, pr: 10 }; }
  neutralGoal() {
    if (this.job === 'execution' && this.target != null && !this.deadKnown.has(this.target)) { const s = this.seen.get(this.target); if (s && roll(0.8)) return { k: 'follow', id: this.target, r: 150, pr: 35, until: this.clock + rnd(12, 25) }; }
    if (this.job === 'joker') { const r = roll(0.5), o = this.someoneRecent(); if (o && r) return { k: 'follow', id: o, r: 90, pr: 35, until: this.clock + rnd(8, 18) }; const b = [...this.bodies.values()][0]; if (b) return { k: 'wander', x: b.x, y: b.y, r: 120, pr: 35 }; }
    return null;
  }
  impGoal() {
    const ready = this.cdKill === 0 && this.clock - this.gameT0 > 14 && this.clock - this.meetEnd > 8, prey = ready ? this.preyCandidate() : null;
    if (prey && roll(0.25 + this.pc('bot_aggr') * 0.7)) return { k: 'hunt', id: prey.id, r: 70, pr: 60, until: this.clock + 14 };
    if (ready && roll(this.pc('bot_aggr') * 0.6)) { const t = this.isolatedTarget(); if (t) return { k: 'seek', x: t.x, y: t.y, r: 120, pr: 45 }; }
    if (!this.ab.cd.vent && roll(0.05 * this.pc('bot_aggr'))) { const v = VENTS.filter(q => dist(q, this.pos) < 500).sort((a, b) => dist(a, this.pos) - dist(b, this.pos))[0]; if (v) return { k: 'vent', x: v.x, y: v.y + 8, r: 50, pr: 55 }; }
    const pend = this.tasks.filter(t => !t.done); if (pend.length && roll(0.6)) { const t = this.chooseTask(pend); return { k: 'task', id: t.id, x: STN[t.id].x, y: STN[t.id].y + 34, r: 50, pr: 40, fake: true }; }
    return null;
  }
  preyCandidate() { let best = null, bd = 1e9; for (const o of this.vis.values()) { if (o.ghost || this.mates.has(o.id)) continue; const d = dist(o, this.pos); if (d < bd && this.witnesses(o.id) <= (roll(this.pc('bot_err') * 0.4) ? 1 : 0)) { bd = d; best = o; } } return best; }
  isolatedTarget() { let best = null, bs = 1e9; for (const [id, o] of this.seen) { if (this.mates.has(id) || this.deadKnown.has(id) || this.clock - o.t > 25) continue; let near = 0; for (const [id2, o2] of this.seen) if (id2 !== id && !this.mates.has(id2) && this.clock - o2.t < 25 && dist(o, o2) < 400) near++; const s = near * 400 + dist(o, this.pos) * 0.3; if (s < bs) { bs = s; best = o; } } return best; }
  runGoal() {
    const g = this.goal; if (!g || g.done) return;
    if (g.k === 'follow' || g.k === 'hunt') {
      const o = this.vis.get(g.id) || this.seen.get(g.id); if (!o || this.clock - (o.t ?? this.clock) > 12) { g.done = true; return; } g.x = o.x; g.y = o.y; g.dyn = true;
      if (g.k === 'hunt') { const t = this.vis.get(g.id); if (t) { const d = dist(t, this.pos); if (d < KILL_R - 12 && this.nearestIs(t)) { if (this.cdKill === 0 && this.witnesses(t.id) <= (this.sabKillTol())) { this.doKill(t); g.done = true; } else if (this.cdKill > 0) g.done = true; } } }
    }
    if (g.k === 'task' && this.p.alive && !g.fake && this.tasks.find(t => t.id === g.id)?.done) g.done = true;
  }
  sabKillTol() { return roll(this.pc('bot_err') * 0.3) ? 1 : 0; }
  nearestIs(t) { const d = dist(t, this.pos); for (const o of this.vis.values()) if (o.id !== t.id && !o.ghost && !this.mates.has(o.id) && dist(o, this.pos) < d + 8) return false; return true; }
  moveAlong() {
    const g = this.goal; if (!g || g.done) { this.stop(); return; }
    const d = Math.hypot(g.x - this.pos.x, g.y - this.pos.y); if (d < (g.r ?? 55)) { this.arrive(); return; }
    if (!this.path || (g.dyn && this.clock > this.repath)) { this.path = findPath(this.pos.x, this.pos.y, g.x, g.y); this.pi = 0; this.repath = this.clock + 0.9; if (!this.path || !this.path.length) { g.done = true; this.stop(); return; } }
    let w = this.path[this.pi]; while (w && Math.hypot(w.x - this.pos.x, w.y - this.pos.y) < 24 && this.pi < this.path.length - 1) { this.pi++; w = this.path[this.pi]; if (roll(0.05 * this.pc('bot_wait') * this.trait.brave)) { this.pause = rnd(0.4, 1.4); } }
    if (!w) return;
    if (this.clock - this.stuckT > 1.4) { if (Math.hypot(this.pos.x - this.stuckP.x, this.pos.y - this.stuckP.y) < 8 && this.lastIn !== '0.0,0.0') this.path = null; this.stuckT = this.clock; this.stuckP = { ...this.pos }; }
    const dx = w.x - this.pos.x, dy = w.y - this.pos.y, l = Math.hypot(dx, dy) || 1; this.input(dx / l, dy / l);
  }
  arrive() {
    const g = this.goal; this.stop();
    switch (g.k) {
      case 'task': this.startWork(g.id, g.fake); g.done = true; break;
      case 'report': { const b = this.bodies.get(g.bid); g.done = true; if (!b) break; if (this.eff() === 'detetive') this.act({ t: 'ab', a: 'investigate' }); this.act({ t: 'report' }); b.rep = true; break; }
      case 'fix': this.act({ t: 'fix', id: g.id }); this.pause = rnd(0.3, 0.9); g.done = true; break;
      case 'emerg': this.act({ t: 'emergency' }); this.usedEmerg++; g.done = true; break;
      case 'cam': this.act({ t: 'ab', a: 'cam' }); this.watching = true; this.watchUntil = this.clock + rnd(6, 11); g.done = true; break;
      case 'vent': this.act({ t: 'vent', a: 'in' }); this.ventUntil = this.clock + rnd(2, 5); g.done = true; break;
      case 'wander': case 'seek': case 'flee': g.done = true; this.pause = roll(this.pc('bot_wait')) ? rnd(0.3, 1.6) : 0; break;
      default: break;
    }
  }
  startWork(id, fake) {
    const t = this.tasks.find(x => x.id === id && !x.done); if (!t) return; this.act({ t: 'taskStart', id });
    this.work = { id, fake, until: this.clock + TASK_MIN[t.type] / 1000 + 0.35 + rnd(0.5, 2.8) * (1.6 - this.pc('bot_skill')) };
  }
  urgent() { if (!this.p.alive) return false; const b = this.nearestBody(); if (b && this.clock >= b.reactAt && !this.imp) return true; return !this.imp && !!this.sab && roll(0.1); }
  workTick() {
    this.stop(); if (this.urgent()) { this.work = null; return; }
    if (this.clock < this.work.until) return; const w = this.work; this.work = null;
    if (roll(this.pc('bot_err') * 0.25)) return; // erro humano: desistiu no meio
    this.act({ t: 'taskDone', id: w.id });
  }
  ventTick() {
    this.stop(); if (this.clock < this.ventUntil) return;
    if ([...this.vis.values()].some(o => !o.ghost && !this.mates.has(o.id) && dist(o, this.pos) < 160) && this.clock < this.ventUntil + 7) return;
    if (roll(0.35)) { this.act({ t: 'vent', a: 'next' }); this.ventUntil = this.clock + rnd(1, 2.5); return; }
    this.act({ t: 'vent', a: 'out' }); this.pause = rnd(0.4, 1); this.goal = null;
  }
  camTick() {
    this.stop(); const hb = [...this.bodies.values()].find(b => !b.rep && b.cam);
    if (hb || this.clock > this.watchUntil) { this.act({ t: 'ab', a: 'camOff' }); this.watching = false; if (hb) this.setGoal({ k: 'report', x: hb.x, y: hb.y, r: 105, pr: 90, bid: hb.id }); }
  }
  doKill(t) { this.act({ t: 'kill' }); this.lastKillAt = this.clock; this.pendKill = { id: t.id, at: this.clock, x: t.x, y: t.y }; }
  afterKill(pk) {
    const wit = this.witnesses(-1), J = this.job; this.stop();
    if (J === 'espectro' && wit > 0 && !(this.ab.cd.invis > 0) && !(this.ab.act.invis > 0)) this.act({ t: 'ab', a: 'invis' });
    if (J === 'metamorfo' && (wit > 0 || roll(0.4)) && !(this.ab.cd.morph > 0)) { const c = [...this.seen].filter(([id, o]) => !this.mates.has(id) && !this.deadKnown.has(id) && id !== this.p.id && this.clock - o.t < 40 && dist(o, pk) > 500); const to = (c.length ? pick(c) : pick([...this.seen].filter(([id]) => !this.mates.has(id) && !this.deadKnown.has(id))) || [null])[0]; if (to != null) this.act({ t: 'ab', a: 'morph', to }); }
    const v = VENTS.filter(q => dist(q, this.pos) < 230).sort((a, b) => dist(a, this.pos) - dist(b, this.pos))[0];
    if (v && wit === 0 && J !== 'vibora' && roll(0.55)) this.setGoal({ k: 'vent', x: v.x, y: v.y + 8, r: 50, pr: 88 });
    else this.setGoal(this.fleeGoal(pk, 86)), J === 'vibora' && (this.goal.until = this.clock + 3);
  }

  // ---- habilidades por profissão (sempre via mensagens do jogo; recargas/usos conferidos pelo servidor) ----
  abilityTick() {
    const p = this.p, J = this.eff(), use = this.pc('bot_abil'), ab = this.ab;
    switch (J) {
      case 'engenheiro': if (p.alive && this.sab && !(ab.cd.remoteFix > 0) && roll(0.4 + use * 0.5)) this.act({ t: 'ab', a: 'remoteFix' }); break;
      case 'cientista': if (p.alive && ab.us.panel > 1 && this.clock > this.nextPanel && roll(use * 0.3)) { this.act({ t: 'ab', a: 'panel' }); this.nextPanel = this.clock + rnd(60, 120); } break;
      case 'xerife': this.shootCheck(); break;
      case 'mentalista': this.shootCheck(); this.locateSuspect(use); this.probeCheck(use); break;
      case 'localizador': this.locateSuspect(use); break;
      case 'anjo': this.angelTick(use); break;
      case 'metamorfo': case 'espectro': case 'impostor': case 'vibora': break;
    }
    if (p.alive && this.imp) this.impSab();
    if (p.alive && this.job === 'espectro' && !(ab.cd.invis > 0) && !(ab.act.invis > 0) && this.cdKill === 0 && roll(use * 0.25)) { const pr = this.preyCandidate(); if (pr && dist(pr, this.pos) < 450) this.act({ t: 'ab', a: 'invis' }); }
  }
  evidence(id) { const j = this.known.get(id); if (j) return JOB[j].team !== 'inn' && j !== 'joker' ? 100 : -100; return this.susp.get(id) ?? 20; }
  shootCheck() {
    const p = this.p; if (!p.alive || this.ab.cd.skill > 0 || p.vent >= 0) return;
    const cand = [...this.vis.values()].filter(o => !o.ghost && !this.deadKnown.has(o.id)).map(o => ({ o, e: this.evidence(o.id) + ((this.heat.get(o.id) || 0) >= 2 && !this.known.has(o.id) ? 10 : 0) })).filter(x => x.e >= 94 && !(this.known.get(x.o.id) === 'joker')).sort((a, b) => b.e - a.e)[0];
    if (!cand) { const t = this.topSuspect(); if (t && t.v >= 94 && this.seen.get(t.id) && this.clock - this.seen.get(t.id).t < 20 && roll(0.2)) this.setGoal({ k: 'hunt', id: t.id, r: 70, pr: 70, until: this.clock + 12 }); return; }
    const d = dist(cand.o, this.pos); if (d < KILL_R - 14 && this.nearestIs(cand.o)) { this.act({ t: 'ab', a: 'skill' }); } else this.setGoal({ k: 'hunt', id: cand.o.id, r: 70, pr: 70, until: this.clock + 10 });
  }
  locateSuspect(use) { if (!this.p.alive || this.ab.cd.locate > 0 || this.ab.act.locate > 0 || !roll(use * 0.5)) return; const t = this.topSuspect() || { id: pick([...this.roster.keys()].filter(i => i !== this.p.id && !this.deadKnown.has(i)) || [0]) }; if (t && t.id != null) this.act({ t: 'ab', a: 'locate', to: t.id }); }
  probeCheck(use) {
    if (!this.p.alive || this.ab.cd.probe > 0 || this.probeBusy) return; const cand = [...this.vis.values()].filter(o => !o.ghost && !o.mv && dist(o, this.pos) < 100 && !this.known.has(o.id) && (this.susp.get(o.id) ?? 20) > 28).sort((a, b) => (this.susp.get(b.id) ?? 20) - (this.susp.get(a.id) ?? 20))[0];
    if (cand && roll(use)) { this.act({ t: 'ab', a: 'probe' }); this.hold = this.clock + this.c('men_inv') + 0.6; }
  }
  angelTick(use) {
    if (this.p.alive || this.ab.cd.shield > 0 || !roll(use * 0.5) || this.room.phase !== 'play') return; let best = null, bs = 0;
    for (const o of this.vis.values()) { if (o.ghost || this.deadKnown.has(o.id)) continue; const others = [...this.vis.values()].filter(q => q.id !== o.id && !q.ghost); const close = others.filter(q => dist(q, o) < 260), farGroup = others.filter(q => dist(q, o) < 480); if (close.length === 1 && farGroup.length === 1) { const s = 1 + (260 - dist(close[0], o)) / 260; if (s > bs) { bs = s; best = o; } } }
    if (!best && roll(0.04)) best = pick([...this.vis.values()].filter(o => !o.ghost && !this.deadKnown.has(o.id)) || [null]); if (best) this.act({ t: 'ab', a: 'shield', to: best.id });
  }
  impSab() {
    if (this.sab || this.sabCd > 0 || this.clock - this.gameT0 < 25 || this.clock - this.meetEnd < 12 || !roll(this.pc('bot_sab') * 0.05)) return;
    const prey = this.cdKill === 0 ? this.preyCandidate() : null; let k;
    if (prey && roll(0.7)) k = 'lights'; else if (this.clock - this.camLed < 30 || roll(0.35)) k = 'comms'; else k = pick(['heat', 'lights', 'comms']);
    this.act({ t: 'sabotage', k });
  }

  // ================= reuniões: chat e voto =================
  meetTick() {
    const p = this.p, t = this.clock - this.mtgStart;
    if (p.alive) {
      if (!this.panelDone && t > 1.2) { this.panelDone = true; this.meetAbilities(); }
      const q = this.chatQ[0]; if (q && this.clock >= q.at) { this.chatQ.shift(); this.act({ t: 'chat', text: q.text }); }
    } else if (this.ghostJob === 'influencer' && !this.panelDone && t > 1.5) { this.panelDone = true; this.infSend(); }
  }
  meetAbilities() {
    const J = this.job, use = this.pc('bot_abil');
    if ((J === 'cientista' || J === 'mentalista') && this.ab.us.panel > 0 && roll(0.4 + use * 0.6)) this.act({ t: 'ab', a: 'panel' });
    if (J === 'mentalista' && this.jp) this.act({ t: 'ab', a: 'jobpanel' });
  }
  infSend() {
    if (!(this.ab.us.inf > 0) && this.ab.us.inf !== undefined) return; const alive = [...this.mtgAlive].filter(i => i !== this.p.id); if (!alive.length || !roll(0.4 + this.pc('bot_abil') * 0.6)) return;
    alive.sort((a, b) => (this.susp.get(a) ?? 20) - (this.susp.get(b) ?? 20)); const to = alive[0]; const kind = this.deathBy === 'kill' ? (roll(0.65) ? 'job' : 'tone') : 'where';
    this.act({ t: 'ab', a: 'infmsg', to, kind });
  }
  defend(accuser) {
    if (!roll(0.35 + this.pc('bot_talk') * 0.6) || !this.p.alive) return; const at = this.clock + rnd(1.5, 4), room = this.lastRoom || 'um corredor', J = this.job, me = this.p.id; let text;
    if (this.imp || J === 'joker') { const o = this.lieTarget(accuser); text = pick([`Eu? Tava na ${pick(CENTERS).name} fazendo task. E o ${o}, ninguém viu ele?`, `Que absurdo, ${this.nm(accuser)}. Tá tentando me tirar do jogo?`, `Não fui eu! Vi o ${o} bem estranho antes.`]); }
    else text = pick([`Não fui eu, eu tava na ${room} fazendo task.`, `Pode confiar, tava na ${room} o tempo todo.`, `Eu? Nunca! Estava na ${room}.`]);
    this.chatQ.push({ at, text }); this.chatQ.sort((a, b) => a.at - b.at);
  }
  lieTarget(excl) {
    const cands = [...this.mtgAlive].filter(i => i !== this.p.id && !this.mates.has(i) && i !== excl); if (!cands.length) return this.nm(excl);
    cands.sort((a, b) => ((this.heat.get(b) || 0) * 12 + (this.susp.get(b) ?? 20)) - ((this.heat.get(a) || 0) * 12 + (this.susp.get(a) ?? 20))); return this.nm(roll(0.7) ? cands[0] : pick(cands));
  }
  compose(m) {
    const out = [], me = this.p.id, imp = this.imp, J = this.job, D = this.room.settings.discuss, room = this.lastRoom || 'um corredor';
    const nMsg = Math.max(0, Math.round(this.pc('bot_talk') * this.trait.chatty * rnd(1, 3.6))), body = m.body != null ? m.body : null;
    const top = this.topSuspect(); const reason = id => ({ near: 'estava perto do corpo', vent: 'sumiu perto de um duto', sumiu: 'sumiu do nada na minha frente', duplo: 'apareceu duplicado', transformou: 'mudou de aparência', kill: 'eu vi matando', tone: 'tem a cor da pista', accused: 'tá muito suspeito', last: 'foi o último que vi com a vítima' })[this.why.get(id)] || 'age de forma estranha';
    if (m.by === me) out.push(m.reason === 'body' ? pick([`Achei um corpo na ${room}!`, `Corpo na ${room}, gente!`, `Morreu alguém na ${room}.`]) : pick([`Chamei porque tem algo errado.`, `Reunião: precisamos conversar.`]));
    if (J === 'detetive' && this.toneHint) out.push(`Minha pista aponta para cor ${this.toneHint}.`);
    if (!imp && J !== 'joker' && J !== 'execution') {
      out.push(pick([`Eu tava na ${room} fazendo task.`, `Estava na ${room}, não vi nada.`, `Passei pela ${room} agora há pouco.`]));
      if (top && top.v >= 32) out.push(pick([`Acho o ${this.nm(top.id)} suspeito: ${reason(top.id)}.`, `Desconfio do ${this.nm(top.id)}, ${reason(top.id)}.`, `${this.nm(top.id)} ${reason(top.id)}. Voto nele.`]));
      else out.push(pick([`Não tenho certeza de ninguém ainda.`, `Sem informação, vou pular se ninguém tiver nada.`]));
      if (this.hiddenDead.size) out.push(`Alguém morreu e ninguém achou o corpo, tem algo estranho.`);
      if ((J === 'cientista' || J === 'mentalista') && this.ab.us.panel > 0) out.push(`Vou checar quem está vivo.`);
      if (J === 'mentalista' && this.jp) out.push(`Tenho informação confiável, vou falar já.`);
      if (J === 'juiz' && this.supLeft > 0 && top && top.v > 80) out.push(`Se for preciso, eu resolvo isso.`);
    } else if (imp) {
      const o = this.lieTarget(-1), r2 = pick(CENTERS).name;
      out.push(pick([`Eu tava na ${r2} fazendo task.`, `Fiquei na ${r2} o tempo todo.`, `Passei na ${r2} e depois vim pra cá.`]));
      if (roll(0.3 + this.pc('bot_lie') * 0.65)) out.push(pick([`Vi o ${o} perto do corpo, ${pick(['achei estranho', 'saindo correndo', 'sozinho'])}.`, `O ${o} tá muito suspeito, votem nele.`, `Desconfio do ${o}, sumiu depois.`]));
      if (roll(0.2)) out.push(pick([`Sem acusação sem prova, galera.`, `Calma, vamos pensar antes de votar.`]));
    } else if (J === 'execution') {
      const t = this.nm(this.target ?? -1), r2 = pick(CENTERS).name;
      out.push(pick([`O ${t} tava estranho, vi ele na ${r2} sozinho.`, `Não confio no ${t}.`, `${t} some toda hora, voto nele.`]));
      out.push(pick([`Alguém mais viu o ${t}?`, `Todo mundo devia votar no ${t}.`]));
    } else if (J === 'joker') {
      const o = this.lieTarget(-1);
      out.push(pick([`Não vi ninguém. Mas o ${o} me seguiu.`, `Tava na ${pick(CENTERS).name}, mas não sei se alguém me viu.`, `Sei lá, ${o} tá com cara de culpado.`, `Hmm... foi o ${o}? Ou foi o ${this.nm(pick([...this.mtgAlive]))}?`]));
      out.push(pick([`Eu tava perto do corpo, mas só passei por ali.`, `Ninguém me viu fazendo task, né? Estranho.`]));
    }
    const slots = out.slice(0, Math.max(nMsg, m.by === me ? 1 : 0)), res = []; let at = this.clock + rnd(1.5, 5);
    for (const text of slots) { res.push({ at, text }); at += rnd(2.2, Math.max(4, D * 0.22)); }
    return res.filter(x => x.at < this.clock + D * 0.9 || true);
  }
  voteTick() {
    if (this.voted || !this.p.alive || this.phase !== 'vote' || this.clock < this.voteAt) return; this.voted = true; const v = this.decideVote(); this.act({ t: 'vote', to: v.to, sup: v.sup ? 1 : 0 });
  }
  decideVote() {
    const me = this.p.id, alive = [...this.mtgAlive].filter(i => i !== me), J = this.job, err = roll(this.pc('bot_err') * 0.5);
    if (!alive.length) return { to: 'skip' };
    if (J === 'execution' && this.target != null && alive.includes(this.target) && !err) return { to: this.target };
    if (this.imp) {
      const crew = alive.filter(i => !this.mates.has(i)); if (!crew.length) return { to: 'skip' };
      crew.sort((a, b) => ((this.heat.get(b) || 0) * 10 + (this.susp.get(b) ?? 20) + rnd(0, 8)) - ((this.heat.get(a) || 0) * 10 + (this.susp.get(a) ?? 20) + rnd(0, 8)));
      if (err || ((this.heat.get(crew[0]) || 0) === 0 && roll(0.4))) return roll(0.5) ? { to: pick(crew) } : { to: 'skip' };
      return { to: crew[0] };
    }
    if (J === 'joker') return roll(0.55) ? { to: pick(alive) } : { to: 'skip' };
    const cand = alive.map(id => ({ id, e: this.evidence(id) + (this.heat.get(id) || 0) * 8 })).sort((a, b) => b.e - a.e);
    const best = cand[0], thr = clamp(54 - this.pc('bot_sus') * 20 - this.pc('bot_skill') * 8, 30, 66);
    if (err) return roll(0.5) ? { to: pick(alive) } : { to: 'skip' };
    if (best.e >= thr) return { to: best.id, sup: this.supLeft > 0 && best.e >= 90 && (J === 'juiz' || J === 'mentalista') };
    return roll(0.7) ? { to: 'skip' } : { to: pick(alive) };
  }
}
