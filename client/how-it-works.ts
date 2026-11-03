import { applyDocumentLocale, locale, setLocale } from './i18n';
import { wireThemeToggle } from './theme';

const messages = {
  'en-US': {
    skip: 'Skip to content', brandSub: 'Inside the arcade', language: 'Language', back: 'Back to games',
    heroMarker: 'How the voice arcade works', heroTitleOne: 'A phone call', heroTitleTwo: 'moves the game.',
    heroLead: 'Call from your phone and say your move. Twilio carries the conversation, the game checks the action, and the shared screen updates. You hear the result on the same call.',
    run: 'Run a voice turn', replay: 'Replay the turn', jump: 'For builders: see the architecture',
    exampleLabel: 'Example from Voice Racer', exampleQuote: '“Give me a boost.”',
    boardTop: 'A single voice turn', boardMode: 'Example flow',
    phoneTitle: 'Your phone', phoneBody: 'Say a move in a regular call.',
    relayBody: 'Twilio carries your words and the reply.',
    serverTitle: 'Game server', serverBody: 'The game checks the move against its rules.',
    displayTitle: 'Shared screen', displayBody: 'Everyone sees the result together.',
    returnTitle: 'The game speaks back', returnBody: 'Hear the next cue on your phone.',
    ready: 'Ready to trace a voice command.', tracing: 'Following the command across the arcade…',
    finished: 'The boost reaches the screen, and the call receives a reply.',
    architectureCue: 'For builders', architectureTitle: 'From call to shared screen',
    architectureLead: 'Twilio handles speech; the game server validates actions. What players hear and see comes from the same validated state.',
    connectTitle: 'Connect the call', connectBody: 'Twilio sends a signed webhook. The server validates it, selects the game room, and returns TwiML to connect the call to Conversation Relay.',
    interpretTitle: 'Validate the move', interpretBody: 'Direct commands take a fast path. For flexible speech, optional AI selects from actions allowed on the current screen; the game validates the result.',
    renderTitle: 'Update both sides', renderBody: 'The server sends validated room state over WebSocket to the browser and a matching spoken reply through Conversation Relay.',
    codeTitle: 'Inspect the call path', codeTeaser: 'Two source excerpts: connection and spoken reply',
    codeIntro: 'These excerpts are shortened from the app server. The URL and room code are examples; the default English ElevenLabs voice, interruption settings, and reply fields match the current flow.',
    codeScrollTip: 'Swipe a code block sideways to read a full line.',
    codeConnectTitle: 'Connect the caller', codeConnectBody: 'The webhook returns TwiML that opens Conversation Relay and lets callers interrupt greetings and replies.',
    codeConnectSource: 'View TwiML source ↗',
    codeReplyTitle: 'Speak the response', codeReplyBody: 'Relay sends the transcript as a prompt. After validation, the server streams reply text for Twilio to speak.',
    codeReplySource: 'View voice reply source ↗',
    entryTitle: 'Two ways to join',
    standalonePath: 'Pick a game', standalonePathBody: 'Open its screen and scan the call QR.',
    stationPath: 'Join a live station', stationPathBody: 'Join through Twilio Messaging when available; the station gives you a game and caller slot.',
    featuresCue: 'Playing by voice', featuresTitle: 'Talk like a player.',
    featuresLead: 'Say what you want to do. The game checks each action against its current rules.',
    interruptTitle: 'Jump into the conversation', interruptBody: 'Speak over a greeting or menu; your choice can start before the voice finishes.',
    naturalTitle: 'Use your own words', naturalBody: 'Speak in your own accent or phrasing. The game uses the current screen to interpret your request and asks when it is unsure.',
    touchTitle: 'Tap a visible menu', touchBody: 'Anyone by the screen can tap a menu, while the caller controls live moves and answers by voice.',
    karaokeTitle: 'Karaoke briefly switches to live audio.',
    karaokeSummary: 'During a song, the call carries live audio for timing and pitch, then returns to the voice guide for the score.',
    karaokeDetails: 'How the audio handoff works',
    karaokeBody: 'Conversation Relay guides song choice and asks for explicit consent. During the song, an authenticated inbound Twilio Media Stream carries only the caller’s audio. The server measures timing and pitch while Deepgram recognizes lyrics. Conversation Relay returns to announce the score.',
    footerTitle: 'Try a game. Explore the code.', footerBody: 'Open the arcade to play, or follow the source and docs to see the call path in detail.',
    footerAction: 'Open the arcade', repo: 'Star on GitHub', docs: 'Conversation Relay docs',
    pageTitle: 'How it’s made · Twilio Games', pageDescription: 'See how a phone call becomes a game move and explore the Twilio architecture behind Twilio Games.',
    homeAria: 'Twilio Games home', diagramAria: 'Voice turn diagram', lightTheme: 'Light theme', darkTheme: 'Dark theme',
  },
  'pt-BR': {
    skip: 'Ir para o conteúdo', brandSub: 'Por dentro do arcade', language: 'Idioma', back: 'Voltar aos jogos',
    heroMarker: 'Como o arcade por voz funciona', heroTitleOne: 'Uma ligação', heroTitleTwo: 'move o jogo.',
    heroLead: 'Ligue pelo celular e diga sua jogada. A Twilio leva suas palavras ao jogo, que valida a ação e atualiza a tela compartilhada. Você ouve o resultado na mesma ligação.',
    run: 'Simular uma jogada', replay: 'Repetir a jogada', jump: 'Para quem desenvolve: ver a arquitetura',
    exampleLabel: 'Exemplo do Voice Racer', exampleQuote: '“Quero um turbo.”',
    boardTop: 'Uma jogada por voz', boardMode: 'Fluxo de exemplo',
    phoneTitle: 'Seu telefone', phoneBody: 'Diga uma jogada numa ligação comum.',
    relayBody: 'A Twilio leva sua fala e a resposta.',
    serverTitle: 'Servidor do jogo', serverBody: 'O jogo verifica a jogada conforme as regras.',
    displayTitle: 'Tela compartilhada', displayBody: 'Todos veem o resultado juntos.',
    returnTitle: 'O jogo responde', returnBody: 'Ouça a próxima indicação no celular.',
    ready: 'Pronto para acompanhar um comando por voz.', tracing: 'Acompanhando o comando pelo arcade…',
    finished: 'O turbo aparece na tela, e a ligação recebe uma resposta.',
    architectureCue: 'Para quem desenvolve', architectureTitle: 'Da ligação à tela compartilhada',
    architectureLead: 'A Twilio cuida da fala; o servidor valida as ações. O que as pessoas ouvem e veem vem do mesmo estado validado da partida.',
    connectTitle: 'Conectar a ligação', connectBody: 'A Twilio envia um webhook assinado. O servidor o valida, seleciona a partida e devolve TwiML para conectar a ligação ao Conversation Relay.',
    interpretTitle: 'Validar a jogada', interpretBody: 'Comandos diretos seguem um caminho rápido. Para frases flexíveis, uma IA opcional escolhe entre as ações permitidas na tela atual; o jogo valida o resultado.',
    renderTitle: 'Atualizar os dois lados', renderBody: 'O servidor envia o estado validado da partida ao navegador por WebSocket e uma resposta falada correspondente pelo Conversation Relay.',
    codeTitle: 'Explore o caminho da ligação', codeTeaser: 'Dois trechos de código: conexão e resposta por voz',
    codeIntro: 'Estes trechos foram resumidos do servidor do app. A URL e o código da partida são exemplos; a voz padrão em inglês da ElevenLabs, as opções de interrupção e os campos da resposta correspondem ao fluxo atual.',
    codeScrollTip: 'Deslize o código para o lado para ler a linha inteira.',
    codeConnectTitle: 'Conectar a pessoa', codeConnectBody: 'O webhook devolve TwiML para abrir o Conversation Relay e permitir a interrupção de saudações e respostas.',
    codeConnectSource: 'Ver código TwiML ↗',
    codeReplyTitle: 'Falar a resposta', codeReplyBody: 'O Relay envia a transcrição como prompt. Após a validação, o servidor envia o texto da resposta para a Twilio falar.',
    codeReplySource: 'Ver código da resposta por voz ↗',
    entryTitle: 'Duas formas de entrar',
    standalonePath: 'Escolha um jogo', standalonePathBody: 'Abra sua tela e escaneie o QR code da ligação.',
    stationPath: 'Entre numa estação ao vivo', stationPathBody: 'Entre pelo Twilio Messaging quando disponível; a estação atribui o jogo e a vaga na ligação.',
    featuresCue: 'Jogando por voz', featuresTitle: 'Fale como quem joga.',
    featuresLead: 'Diga o que quer fazer. O jogo valida cada ação conforme as regras da partida.',
    interruptTitle: 'Entre na conversa', interruptBody: 'Fale durante uma saudação ou menu; sua escolha pode começar antes de a voz terminar.',
    naturalTitle: 'Use suas palavras', naturalBody: 'Fale com seu sotaque e do seu jeito. O jogo usa a tela atual para entender o pedido e pergunta se houver dúvida.',
    touchTitle: 'Toque num menu da tela', touchBody: 'Qualquer pessoa perto da tela pode tocar em um menu; jogadas e respostas ao vivo continuam com quem está na ligação.',
    karaokeTitle: 'No karaokê, a ligação passa brevemente para áudio ao vivo.',
    karaokeSummary: 'Durante a música, a ligação leva áudio ao vivo para medir tempo e afinação. Depois, o guia por voz volta para anunciar a pontuação.',
    karaokeDetails: 'Como funciona a troca de áudio',
    karaokeBody: 'O Conversation Relay ajuda a escolher a música e pede consentimento explícito. Durante a canção, um Twilio Media Stream autenticado leva apenas o áudio da pessoa na ligação. O servidor mede tempo e afinação, enquanto a Deepgram reconhece a letra. O Conversation Relay volta para anunciar a pontuação.',
    footerTitle: 'Jogue. Explore o código.', footerBody: 'Abra o arcade para jogar ou veja o código e a documentação para entender o caminho da ligação em detalhes.',
    footerAction: 'Abrir o arcade', repo: 'Estrelar no GitHub', docs: 'Documentação do Conversation Relay',
    pageTitle: 'Como foi feito · Twilio Games', pageDescription: 'Entenda como uma ligação vira uma jogada e explore a arquitetura Twilio por trás do Twilio Games.',
    homeAria: 'Início do Twilio Games', diagramAria: 'Diagrama de uma jogada por voz', lightTheme: 'Tema claro', darkTheme: 'Tema escuro',
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
