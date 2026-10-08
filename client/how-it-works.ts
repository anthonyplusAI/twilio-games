import { applyDocumentLocale, locale, setLocale } from './i18n';
import { wireThemeToggle } from './theme';

const messages = {
  'en-US': {
    skip: 'Skip to content', brandSub: 'Inside the arcade', language: 'Language', back: 'Back to games',
    heroMarker: 'How the voice arcade works', heroTitleOne: 'A phone call', heroTitleTwo: 'moves the game.',
    heroLead: 'Your phone is the controller. Twilio Conversation Relay listens and speaks, while the game server decides what your words mean right now. Everyone sees the move on one shared screen.',
    run: 'Run a voice turn', replay: 'Replay the turn', jump: 'See the architecture',
    exampleLabel: 'Example from Voice Racer', exampleQuote: '“Give me a boost.”',
    boardTop: 'A single voice turn', boardMode: 'Live route',
    phoneTitle: 'Your phone', phoneBody: 'You speak into a regular call. No controller app is needed.',
    relayBody: 'Twilio turns speech into a transcript and carries the reply back as voice.',
    serverTitle: 'Game server', serverBody: 'The current game checks the request, then updates its room.',
    displayTitle: 'Shared screen', displayBody: 'A live game connection sends the new state to the display.',
    returnTitle: 'The game speaks back', returnBody: 'Twilio plays the next cue through the same call.',
    ready: 'Ready to trace a voice command.', tracing: 'Following the command across the arcade…',
    finished: 'The boost reaches the screen, and the call receives a reply.',
    oneRoom: 'One room, one game state.', oneRoomBody: 'Key spoken cues and graphics come from the same game result, so victory and scoring match on phone and screen.',
    architectureCue: 'Under the hood', architectureTitle: 'What connects the call to the screen?',
    architectureLead: 'The live path has three handoffs. Twilio handles the call. The server owns the rules. The browser draws the current room.',
    connectTitle: 'Connect the call', connectBody: 'When a call arrives, Twilio sends a signed request (a webhook). The server identifies the game room and returns TwiML, Twilio’s call instructions, to connect Conversation Relay.',
    interpretTitle: 'Understand the turn', interpretBody: 'Quick commands take a fast path. For less direct speech, an optional AI interpreter chooses only from actions and facts available on the current screen. The game validates the choice before changing state.',
    renderTitle: 'Render the result', renderBody: 'A live browser connection (WebSocket) carries the room state. The browser draws the race, board, battle, stage, or score. When the voice guide is active, it describes the same result.',
    allowedAction: 'current phase → allowed action',
    codeCue: 'For curious builders', codeTitle: 'See the Twilio code behind a voice turn',
    codeTeaser: 'Two short excerpts from the live call path',
    codeIntro: 'These are shortened excerpts from this app’s server. The URL and room code are examples; the English ElevenLabs voice, interruption settings, and reply fields match the current flow.',
    codeScrollTip: 'Swipe a code block sideways to read a full line.',
    codeConnectTitle: 'Connect the caller', codeConnectBody: 'The incoming-call webhook returns instructions that open Conversation Relay. These settings let players cut into greetings and replies.',
    codeConnectSource: 'View TwiML source ↗',
    codeReplyTitle: 'Speak the response', codeReplyBody: 'Relay sends the caller’s transcript as a prompt. After the game checks the action, the server sends reply text for Twilio to speak.',
    codeReplySource: 'View voice reply source ↗',
    codeNote: 'The display gets the validated room state over a separate game WebSocket, so what players hear and see comes from the same action.',
    entryTitle: 'How players reach the call', entryBody: 'Both entry paths lead to the same live voice connection.',
    standalonePath: 'Standalone', standalonePathBody: 'Choose a game, open its display, then scan its call QR.',
    stationPath: 'Live station', stationPathBody: 'Join and vote through Twilio Messaging where available; the station assigns a game and caller slot.',
    featuresCue: 'Made for people', featuresTitle: 'You can talk like a player.',
    featuresLead: 'The call is a conversation, not a list of magic phrases. The game still checks every action against its rules.',
    interruptTitle: 'Cut in whenever you’re ready', interruptBody: 'Speak over a welcome, menu, or explanation. Conversation Relay reports your speech while the voice is still talking, so the next choice can start right away.',
    naturalTitle: 'Say it your way', naturalBody: 'Players can speak in their own accent or wording. Twilio transcribes the call; game-word hints help with names, and the current screen helps resolve likely misheard words. Ambiguous requests get a short follow-up.',
    touchTitle: 'Tap menus on the shared screen', touchBody: 'Anyone nearby can tap a visible menu or selector. Live moves, attacks, answers, and racing commands stay with the phone player.',
    karaokeCue: 'A special performance lane', karaokeTitle: 'Karaoke switches from talking to singing.',
    karaokeBody: 'Conversation Relay guides song choice and asks for explicit consent. During the song, an authenticated inbound Twilio Media Stream carries only the caller’s audio. The server measures timing and pitch, while Deepgram recognizes lyrics. Conversation Relay returns to announce the score.',
    score: 'Score', gamesCue: 'Six ways to play', gamesTitle: 'One voice arcade. Different rules.',
    racerVerb: 'Boost through the course', monstersVerb: 'Call a creature move', fighterVerb: 'Attack or block',
    karaokeVerb: 'Sing on the beat', triviaVerb: 'Answer out loud', chessVerb: 'Move and castle',
    footerTitle: 'Now try the real thing.', footerBody: 'Open the home screen to choose a game or join a live station, then call when prompted.',
    footerAction: 'Open the arcade', docs: 'Conversation Relay docs',
    pageTitle: 'How it’s made · Twilio Games', pageDescription: 'See how Twilio Conversation Relay turns a phone call into a move on the Twilio Games shared screen.',
    homeAria: 'Twilio Games home', diagramAria: 'Voice turn diagram', karaokeRouteAria: 'Karaoke audio route', lightTheme: 'Light theme', darkTheme: 'Dark theme',
  },
  'pt-BR': {
    skip: 'Ir para o conteúdo', brandSub: 'Por dentro do arcade', language: 'Idioma', back: 'Voltar aos jogos',
    heroMarker: 'Como o arcade por voz funciona', heroTitleOne: 'Uma ligação', heroTitleTwo: 'move o jogo.',
    heroLead: 'Seu telefone é o controle. O Twilio Conversation Relay escuta e fala, enquanto o servidor decide o que suas palavras significam naquele momento. Todos veem a jogada na mesma tela.',
    run: 'Simular uma jogada', replay: 'Repetir a jogada', jump: 'Ver a arquitetura',
    exampleLabel: 'Exemplo do Voice Racer', exampleQuote: '“Quero um turbo.”',
    boardTop: 'Uma jogada por voz', boardMode: 'Caminho ao vivo',
    phoneTitle: 'Seu telefone', phoneBody: 'Você fala numa ligação comum. Não precisa instalar um controle.',
    relayBody: 'A Twilio transforma a fala em texto e leva a resposta de volta em voz.',
    serverTitle: 'Servidor do jogo', serverBody: 'O jogo atual verifica o pedido e atualiza a partida.',
    displayTitle: 'Tela compartilhada', displayBody: 'Uma conexão ao vivo envia o novo estado para a tela.',
    returnTitle: 'O jogo responde', returnBody: 'A Twilio reproduz a próxima fala na mesma ligação.',
    ready: 'Pronto para acompanhar um comando por voz.', tracing: 'Acompanhando o comando pelo arcade…',
    finished: 'O turbo aparece na tela, e a ligação recebe uma resposta.',
    oneRoom: 'Uma partida, um único estado.', oneRoomBody: 'As falas importantes e os gráficos vêm do mesmo resultado, então a vitória e a pontuação batem no telefone e na tela.',
    architectureCue: 'Por trás da tela', architectureTitle: 'O que liga a chamada à tela?',
    architectureLead: 'O caminho ao vivo tem três etapas. A Twilio cuida da ligação. O servidor controla as regras. O navegador desenha a partida atual.',
    connectTitle: 'Conectar a ligação', connectBody: 'Quando a ligação chega, a Twilio envia uma solicitação assinada (um webhook). O servidor identifica a partida e devolve TwiML, as instruções da chamada, para conectar o Conversation Relay.',
    interpretTitle: 'Entender a jogada', interpretBody: 'Comandos diretos seguem um caminho rápido. Para frases menos diretas, uma IA opcional escolhe apenas entre ações e fatos disponíveis na tela atual. O jogo valida a escolha antes de mudar o estado.',
    renderTitle: 'Mostrar o resultado', renderBody: 'Uma conexão ao vivo com o navegador (WebSocket) leva o estado da partida. O navegador desenha a corrida, o tabuleiro, a batalha, o palco ou a pontuação. Quando o guia por voz está ativo, ele descreve o mesmo resultado.',
    allowedAction: 'fase atual → ação permitida',
    codeCue: 'Para quem gosta de código', codeTitle: 'Veja o código Twilio por trás de uma jogada',
    codeTeaser: 'Dois trechos curtos do caminho da ligação',
    codeIntro: 'Estes trechos foram resumidos do servidor do app. A URL e o código da partida são exemplos; a voz inglesa da ElevenLabs, as opções de interrupção e os campos da resposta correspondem ao fluxo atual.',
    codeScrollTip: 'Deslize o código para o lado para ler a linha inteira.',
    codeConnectTitle: 'Conectar a pessoa', codeConnectBody: 'O webhook da ligação devolve instruções para abrir o Conversation Relay. Essas opções deixam a pessoa interromper as boas-vindas e as respostas.',
    codeConnectSource: 'Ver código TwiML ↗',
    codeReplyTitle: 'Falar a resposta', codeReplyBody: 'O Relay envia a transcrição como uma mensagem de entrada. Depois que o jogo valida a ação, o servidor envia o texto para a Twilio falar.',
    codeReplySource: 'Ver código da resposta por voz ↗',
    codeNote: 'A tela recebe o estado validado da partida por outro WebSocket, então a fala e a imagem vêm da mesma jogada.',
    entryTitle: 'Como chegar à ligação', entryBody: 'Os dois caminhos levam à mesma conexão por voz.',
    standalonePath: 'Jogo individual', standalonePathBody: 'Escolha um jogo, abra sua tela e escaneie o QR code da ligação.',
    stationPath: 'Estação ao vivo', stationPathBody: 'Entre e vote pelo Twilio Messaging quando disponível; a estação atribui o jogo e a vaga na ligação.',
    featuresCue: 'Feito para pessoas', featuresTitle: 'Fale como quem está jogando.',
    featuresLead: 'A ligação é uma conversa, não uma lista de frases mágicas. O jogo ainda confere cada ação com suas regras.',
    interruptTitle: 'Interrompa quando quiser', interruptBody: 'Fale durante as boas-vindas, um menu ou uma explicação. O Conversation Relay transmite sua fala mesmo enquanto a voz do jogo fala, para você escolher sem esperar.',
    naturalTitle: 'Fale do seu jeito', naturalBody: 'Cada pessoa pode usar seu próprio sotaque ou suas palavras. A Twilio transcreve a ligação; dicas ajudam com nomes dos jogos, e o contexto da tela ajuda a interpretar palavras possivelmente mal reconhecidas. Pedidos ambíguos recebem uma pergunta curta.',
    touchTitle: 'Toque nos menus da tela', touchBody: 'Qualquer pessoa por perto pode tocar num menu ou seletor visível. Movimentos, ataques, respostas e comandos de corrida continuam com quem está na ligação.',
    karaokeCue: 'Um caminho especial para cantar', karaokeTitle: 'No karaokê, a conversa vira música.',
    karaokeBody: 'O Conversation Relay ajuda a escolher a música e pede consentimento explícito. Durante a canção, um Twilio Media Stream autenticado leva apenas o áudio da pessoa na ligação. O servidor mede tempo e afinação, enquanto a Deepgram reconhece as palavras. O Conversation Relay volta para anunciar a pontuação.',
    score: 'Pontuação', gamesCue: 'Seis jeitos de jogar', gamesTitle: 'Um arcade por voz. Regras diferentes.',
    racerVerb: 'Use o turbo na pista', monstersVerb: 'Comande a criatura', fighterVerb: 'Ataque ou bloqueie',
    karaokeVerb: 'Cante no ritmo', triviaVerb: 'Responda em voz alta', chessVerb: 'Mova e faça o roque',
    footerTitle: 'Agora experimente de verdade.', footerBody: 'Abra a página inicial para escolher um jogo ou entrar numa estação ao vivo. Ligue quando receber a indicação.',
    footerAction: 'Abrir o arcade', docs: 'Documentação do Conversation Relay',
    pageTitle: 'Como foi feito · Twilio Games', pageDescription: 'Veja como o Twilio Conversation Relay transforma uma ligação em uma jogada na tela compartilhada do Twilio Games.',
    homeAria: 'Início do Twilio Games', diagramAria: 'Diagrama de uma jogada por voz', karaokeRouteAria: 'Caminho de áudio do karaokê', lightTheme: 'Tema claro', darkTheme: 'Tema escuro',
  },
} as const;

const copy = messages[locale];
applyDocumentLocale();
document.title = copy.pageTitle;
document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute('content', copy.pageDescription);
for (const element of document.querySelectorAll<HTMLElement>('[data-copy]')) {
  const key = element.dataset.copy as keyof typeof copy;
  if (key in copy) element.textContent = copy[key];
}
document.querySelector<HTMLAnchorElement>('.brand')?.setAttribute('aria-label', copy.homeAria);
document.getElementById('signalBoard')?.setAttribute('aria-label', copy.diagramAria);
document.querySelector<HTMLElement>('.karaoke-route')?.setAttribute('aria-label', copy.karaokeRouteAria);
document.querySelector<HTMLAnchorElement>('.text-link')?.setAttribute('href', '#architecture');
wireThemeToggle(document.getElementById('themeToggle')!, { light: copy.lightTheme, dark: copy.darkTheme });

const language = document.getElementById('pageLocale') as HTMLSelectElement;
language.setAttribute('aria-label', copy.language);
language.value = locale;
language.addEventListener('change', () => setLocale(language.value === 'pt-BR' ? 'pt-BR' : 'en-US'));

const board = document.getElementById('signalBoard')!;
const runButton = document.getElementById('runDemo') as HTMLButtonElement;
const runLabel = runButton.querySelector('span')!;
const status = document.getElementById('demoStatus')!;
const nodes = [...board.querySelectorAll<HTMLElement>('[data-node]')];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let timers: number[] = [];

function showStep(step: number): void {
  board.dataset.step = String(step);
  for (const node of nodes) {
    const number = Number(node.dataset.node);
    node.classList.toggle('is-current', number === step);
    node.classList.toggle('is-complete', number < step);
  }
}

function clearRun(): void {
  for (const timer of timers) clearTimeout(timer);
  timers = [];
  board.dataset.running = 'false';
}

function finishRun(): void {
  showStep(5);
  board.dataset.running = 'false';
  status.textContent = copy.finished;
  runLabel.textContent = copy.replay;
  timers = [];
}

runButton.addEventListener('click', () => {
  clearRun();
  showStep(0);
  status.textContent = copy.tracing;
  if (reducedMotion.matches) { finishRun(); return; }
  board.dataset.running = 'true';
  for (let step = 1; step <= 5; step++) {
    timers.push(window.setTimeout(() => step === 5 ? finishRun() : showStep(step), step * 620));
  }
});

reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches && board.dataset.running === 'true') { clearRun(); finishRun(); }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden && board.dataset.running === 'true') { clearRun(); finishRun(); }
});
