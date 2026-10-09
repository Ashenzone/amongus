# Quórum — Estação Halcyon

Jogo 2D multiplayer de dedução social (4–15 jogadores). Servidor autoritativo em Node.js + WebSocket; cliente em Canvas 2D (sem build, sem assets externos: arte vetorial e áudio sintetizados).

## Rodar
    npm install
    npm start            # http://localhost:3000
Abra 4 abas/navegadores (ou amigos na mesma rede) → CRIAR SALA → os outros ENTRAR com o código → COMEÇAR.
Para testar com menos gente: `MIN_PLAYERS=2 npm start` (a partida termina rápido, é só para ver telas).
Hospedagem: qualquer host Node com WebSocket (Railway, Render, Fly). Use a variável PORT.

## Controles
WASD/setas mover · E usar/tarefa/reparar/emergência · R reportar · Q eliminar · V ventilação (C troca, V sai) · F sabotar · ESC fecha tarefa

## Estrutura
- `shared/map.js` mapa (13 salas, 14 corredores, 20 estações de tarefa, ventilações) e colisão — usado por servidor e cliente
- `shared/cosmetics.js` cores, chapéus, roupas, acessórios, mascotes, skins
- `server/room.js` regras: papéis, movimento, visão, kill, tarefas, sabotagens, reuniões, votos, vitória, reconexão
- `server/index.js` HTTP estático + WebSocket + limite de mensagens
- `client/js/render.js` mapa, personagens, luz/sombra, partículas, câmera, portas
- `client/js/tasks.js` 6 minigames · `audio.js` música/sfx sintetizados · `ui.js` telas · `main.js` orquestração

## Profissões (17)
`shared/jobs.js` define profissões, cores, descrições e TODOS os parâmetros configuráveis; `server/room.js` aplica as regras.
- Inocentes (azul): Tripulante, Detetive, Engenheiro, Cientista, Barulhento, Juiz, Localizador, Xerife, Mentalista (nome preto)
- Neutros: Anjo (amarelo) e Influencer (ciano) — só recebidos por inocentes que morrem; Joker (cinza); Execution (laranja)
- Impostores: Impostor e Metamorfo (vermelho), Víbora (verde), Espectro (roxo)
Início da partida: Carregando → Categoria → Profissão. Habilidades: botões na tela (teclas 1–4), M abre o mapa grande (rastreio do Localizador).
O host configura no lobby (botão PROFISSÕES): chance e máximo de cada profissão, nº de neutros/impostores, recargas, durações, usos e regras de cada habilidade; chance 0 desliga a profissão.

## Segurança (servidor manda)
Função, posição, kill (alcance/cooldown), votos, tarefas, sabotagens e vitória são validados no servidor. O servidor só envia posições de quem está dentro do campo de visão (sem wallhack) e a função dos infiltrados só vai aos próprios infiltrados. Tarefas exigem proximidade + tempo mínimo desde o início.
Limite conhecido: o resultado do minigame roda no cliente; o servidor garante proximidade e tempo, não a correção da solução.

## Fase 2 (não incluída ainda)
Loja de moedas/desbloqueios, XP/nível/perfil/estatísticas com salvamento no servidor (banco), skins/animações desbloqueáveis, mais tarefas e polimento de áudio/efeitos.
