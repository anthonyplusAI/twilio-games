import QRCode from 'qrcode';
import { isPlayableArcadeGame, PLAYABLE_ARCADE_GAMES, type PlayableArcadeGame } from '../shared/arcade-games';
import { gameTitle } from '../shared/i18n/content';
import { getMusicManager } from './music-manager';
import { injectMusicToggle } from './music-toggle';
import { applyDocumentLocale, injectLanguagePicker, locale } from './i18n';
import { injectMagicHat } from './magic-hat';
import { OPERATOR_ICON } from './icon-controls';
import { createFullscreenGameShell } from './fullscreen-game-shell';
import { wireFullscreenToggle } from './fullscreen-toggle';
import { wireThemeToggle } from './theme';
import { createCoinInsertionPresenter } from './coin-insertion';
import { getSoundEffectsManager } from './sound-effects';
import { ensureDisplaySessionId } from './display-session';
import { calculatePageCount, clampPageIndex, orderByConfiguredIds, STANDALONE_GAMES_PER_PAGE } from './home-nav';
import {
  captureDisplayToken,
  displayTokenWasRejected,
  effectivePublicVisitorBaseUrl,
  fetchPublicArcadeConfig,
  fetchPublicStation,
  rejectDisplayToken,
  resolveStationQrImage,
  stationJoinUrl,
  stationQrAsset,
  stationLaunchUrl,
  StationRequestError,
  subscribeToStation,
  type PublicStation,
} from './station-client';

const copy = locale === 'pt-BR' ? {
  pageTitle: 'Twilio Games', tagline: 'Uma tela. Seu telefone. Sua voz.',
  connecting: 'Conectando', recruiting: 'Recrutando agora', waiting: 'Aguardando a primeira moeda',
  ready: 'jogadores prontos', readyNext: '{count} prontos para o próximo jogo', timer: 'Próximo jogo em {time}', reconnecting: 'Reconectando', live: 'Estação ao vivo',
  attractEyebrow: 'Twilio Games', phaseTitle: 'Sua voz é o controle.',
  phaseDescription: 'Escaneie, entre e responda MOEDA ou 🪙 quando estiver pronto na tela.',
  joinEyebrow: 'Entre pelo seu telefone', joinTitle: 'Escaneie para jogar',
  joinStepOne: 'Abra a conversa no WhatsApp', joinStepTwo: 'Conclua a apresentação rápida',
  joinStepThree: 'Responda MOEDA ou 🪙 na tela', selectionEyebrow: 'Escolha dos jogadores',
  selectionTitle: 'Escolham o próximo jogo.',
  selectionDescription: 'Jogadores prontos: respondam por mensagem com o número mostrado ou o nome do jogo. Se o tempo acabar ou houver empate, a estação decide automaticamente.',
  countdownEyebrow: 'Jogadores confirmados', countdownDescription: 'Fique por perto. O jogo está carregando nesta tela.',
  freePlay: 'Jogo livre', chooseGame: 'Escolha um jogo.',
  standaloneEyebrow: 'Jogos de festa controlados por voz · com tecnologia Twilio',
  standaloneTitle: 'Jogue com sua <span>voz.</span>',
  standaloneDescription: 'Com tecnologia Twilio ConversationRelay. Sua voz é o controle.',
  quickStartOne: 'Toque no jogo', quickStartTwo: 'Escaneie o código QR', quickStartThree: 'Ligue e jogue por voz',
  standaloneUnavailable: 'Os jogos por voz não estão disponíveis agora. Peça ajuda à equipe.',
  previousPage: 'Página anterior', nextPage: 'Próxima página', pageStatus: 'Página {page} de {pages}',
  nextGame: 'Próximo jogo', gameComplete: 'Partida concluída',
  playersNext: 'jogadores já estão prontos para a próxima partida',
  displaySetup: 'Conexão segura necessária', missingDisplayToken: 'Tela não conectada',
  invalidDisplayToken: 'Acesso da tela rejeitado', connectDisplay: 'Conecte pelo console do operador',
  missingDisplayExplanation: 'Somente a tela do estande pode iniciar jogos compartilhados. Abra o console do operador para conectar este navegador.',
  invalidDisplayExplanation: 'O acesso desta tela foi rejeitado. Abra o console do operador para reconectar este navegador.',
  openOperator: 'Abrir console do operador',
  lightTheme: 'Tema claro', darkTheme: 'Tema escuro', enterFullscreen: 'Entrar em tela cheia', exitFullscreen: 'Sair da tela cheia', operator: 'Console do operador', howMade: 'Como foi feito', playerMax: 'máx. {count} jogadores',
  playNow: 'Jogando nesta rodada: {count}', keepPriority: 'Aguardando o próximo jogo: {count}',
  racerBlurb: 'Uma corrida por uma pista neon controlada por voz.',
  monstersBlurb: 'Comande os golpes em uma batalha tática de criaturas.',
  fighterBlurb: 'Transforme cada golpe gritado em um confronto na arena.',
  karaokeBlurb: 'Escolha a música e cante cada palavra no tempo certo.',
  triviaBlurb: 'Responda em voz alta a perguntas rápidas e marque pontos antes dos rivais.',
  chessBlurb: 'Comande peças encantadas por voz e desafie um mago virtual.',
  freeDescription: 'Escaneie, entre pelo WhatsApp e responda PRONTO quando estiver pronto na tela.',
  freeStep: 'Responda PRONTO na tela',
  vote: 'voto', votes: 'votos', leader: 'Na liderança', tiedLeader: 'Líder empatado', textCommand: 'Envie',
} : {
  pageTitle: 'Twilio Games', tagline: 'One screen. Your phone. Your voice.',
  connecting: 'Connecting', recruiting: 'Now recruiting', waiting: 'Waiting for first coin',
  ready: 'players ready', readyNext: '{count} ready for the next game', timer: 'Next game in {time}', reconnecting: 'Reconnecting', live: 'Station live',
  attractEyebrow: 'Twilio Games', phaseTitle: 'Your voice is the controller.',
  phaseDescription: 'Scan, join, and reply COIN or 🪙 when you are ready at the screen.',
  joinEyebrow: 'Join from your phone', joinTitle: 'Scan to play',
  joinStepOne: 'Choose SMS or WhatsApp', joinStepTwo: 'Complete the quick intro',
  joinStepThree: 'Reply COIN or 🪙 at the screen', selectionEyebrow: 'Player choice',
  selectionTitle: 'Choose the next game.',
  selectionDescription: 'Ready players: text the number shown or the game name. If time runs out or votes tie, the station chooses automatically.',
  countdownEyebrow: 'Players locked', countdownDescription: 'Stay close. The game is loading on this screen.',
  freePlay: 'Free play', chooseGame: 'Choose a game.',
  standaloneEyebrow: 'Voice-controlled party games · powered by Twilio',
  standaloneTitle: 'Play with your <span>voice.</span>',
  standaloneDescription: 'Powered by Twilio Conversation Relay. Your voice is the controller.',
  quickStartOne: 'Tap the game', quickStartTwo: 'Scan the QR code', quickStartThree: 'Call and play by voice',
  standaloneUnavailable: 'Voice games are unavailable right now. Please ask booth staff for help.',
  previousPage: 'Previous page', nextPage: 'Next page', pageStatus: 'Page {page} of {pages}',
  nextGame: 'Next game', gameComplete: 'Game complete',
  playersNext: 'players are already ready for the next game',
  displaySetup: 'Secure connection required', missingDisplayToken: 'Display not connected',
  invalidDisplayToken: 'Display access rejected', connectDisplay: 'Connect through the operator console',
  missingDisplayExplanation: 'Only the booth display may launch shared games. Open the operator console to connect this browser.',
  invalidDisplayExplanation: 'This display access was rejected. Open the operator console to reconnect this browser.',
  openOperator: 'Open operator console',
  lightTheme: 'Light theme', darkTheme: 'Dark theme', enterFullscreen: 'Enter fullscreen', exitFullscreen: 'Exit fullscreen', operator: 'Operator console', howMade: 'How it’s made', playerMax: '{count} player max',
  playNow: 'Playing this round: {count}', keepPriority: 'Waiting for next game: {count}',
  racerBlurb: 'A voice powered race dodging obstacles.',
  monstersBlurb: 'Call the moves in a tactical creature battle.',
  fighterBlurb: 'Turn every shouted move into an arena showdown.',
  karaokeBlurb: 'Pick a song and sing every word on the beat.',
  triviaBlurb: 'Answer quick-fire questions out loud and score before your rivals.',
  chessBlurb: 'Command enchanted pieces by voice and duel a computer wizard.',
  freeDescription: 'Scan, join, and reply READY when you are at the screen.',
  freeStep: 'Reply READY at the screen',
  vote: 'vote', votes: 'votes', leader: 'Leading', tiedLeader: 'Tied lead', textCommand: 'Text',
};

const format = (template: string, values: Readonly<Record<string, string | number>>): string => (
  Object.entries(values).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, String(value)), template)
);

const views = {
  standalone: document.getElementById('standaloneView')!,
  recruiting: document.getElementById('recruitingView')!,
  selection: document.getElementById('selectionView')!,
  countdown: document.getElementById('countdownView')!,
};
const readyCount = document.getElementById('readyCount')!;
const phaseTimer = document.getElementById('phaseTimer')!;
const readyRoster = document.getElementById('readyRoster')!;
const connection = document.getElementById('connectionState')!;
const selectionTimer = document.getElementById('selectionTimer')!;
const lockedCountdown = document.getElementById('lockedCountdown')!;
const lockedGame = document.getElementById('lockedGame')!;
const gameCards = document.getElementById('gameCards')!;
const phaseEyebrow = document.getElementById('phaseEyebrow')!;
const standaloneGames = document.getElementById('standaloneGames')!;
const standaloneGameRegion = document.getElementById('standaloneGameRegion')!;
const standalonePreviousPage = document.getElementById('standalonePreviousPage') as HTMLButtonElement;
const standaloneNextPage = document.getElementById('standaloneNextPage') as HTMLButtonElement;
const standalonePageStatus = document.getElementById('standalonePageStatus')!;
let standaloneGamesKey='__unset__';
let standaloneLineupKey='__unset__';
let standalonePageIndex=0;
const selectionVideos: Partial<Record<PlayableArcadeGame, string>> = {
  racer: '/video/vr-demo.mp4', monsters: '/video/vm-demo.mp4', fighter: '/video/vf-demo.mp4',
  karaoke: '/video/vk-demo.mp4', trivia: '/video/vt-demo.mp4', chess: '/video/vc-demo.mp4',
};
const gameCommands: Readonly<Record<PlayableArcadeGame, number>> = {
  racer: 1, monsters: 2, fighter: 3, karaoke: 4, trivia: 5, chess: 6,
};
const gameBlurbs: Readonly<Record<PlayableArcadeGame, string>> = {
  racer: copy.racerBlurb,
  monsters: copy.monstersBlurb,
  fighter: copy.fighterBlurb,
  karaoke: copy.karaokeBlurb,
  trivia: copy.triviaBlurb,
  chess: copy.chessBlurb,
};

interface PreviewConnection {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
}

const reducedMotionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const previewConnection = (navigator as Navigator & { connection?: PreviewConnection }).connection;
let activeView: HTMLElement = views.recruiting;

let stationId = new URLSearchParams(location.search).get('station') ?? 'ARCADE-01';
let current: PublicStation | null = null;
let refreshing = false;
let refreshPending = false;
let launched = '';
let displayToken = captureDisplayToken();
let displayTokenRejected = !displayToken && displayTokenWasRejected();
let standaloneMode = false;
let joinBaseUrl = location.origin;
let qrRailMode: 'auto' | 'always' | 'hidden' = 'auto';
let configuring = false;
let configurationPending = false;
let freePlay = false;
let leadCaptureMode = false;
let enabledGames = new Set<PlayableArcadeGame>();
let standaloneGameOrder: PlayableArcadeGame[] = PLAYABLE_ARCADE_GAMES.map(game => game.id);
let smsAvailable = false;
let whatsappAvailable = false;
let selectionLineup = '';
let selectionVotes: string | null = null;
let unsubscribeStation = (): void => undefined;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let configurationTimer: ReturnType<typeof setInterval> | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
const fullscreenGameShell = createFullscreenGameShell({
  onOpen: () => { getMusicManager().stop(); syncPreviewPlayback(); stopHomeRuntime(); },
});

function renderGameCards(station: PublicStation): void {
  const available = orderByConfiguredIds(station.games, standaloneGameOrder)
    .filter(impact => enabledGames.has(impact.id));
  const lineup = available.map(impact => impact.id).join(',');
  if (lineup !== selectionLineup) {
    selectionLineup = lineup;
    gameCards.replaceChildren(...available.map(impact => buildGameCard(impact)));
  }
  const highestChoices = Math.max(0, ...available.map(impact => impact.choices));
  const voteSignature=available.map(impact=>`${impact.id}:${impact.choices}`).join('|');
  if(selectionVotes!==null&&selectionVotes!==voteSignature)getSoundEffectsManager().playSelect();
  selectionVotes=voteSignature;
  const leaders = highestChoices > 0 ? available.filter(impact => impact.choices === highestChoices) : [];
  for (const impact of available) {
    const card = gameCards.querySelector<HTMLElement>(`[data-game="${impact.id}"]`)!;
    const leading = leaders.includes(impact);
    card.classList.toggle('game-card-leading', leading);
    card.setAttribute('aria-label', `${gameCommands[impact.id]}, ${gameTitle(locale, impact.id)}, ${impact.choices} ${impact.choices === 1 ? copy.vote : copy.votes}`);
    card.querySelector<HTMLElement>('[data-role="vote-count"]')!.textContent = `${impact.choices} ${impact.choices === 1 ? copy.vote : copy.votes}`;
    const leader = card.querySelector<HTMLElement>('[data-role="leader"]')!;
    leader.hidden = !leading;
    leader.textContent = leaders.length > 1 ? copy.tiedLeader : copy.leader;
    card.querySelector<HTMLElement>('[data-role="play-now"]')!.textContent = format(copy.playNow, { count: impact.playNow });
    card.querySelector<HTMLElement>('[data-role="overflow"]')!.textContent = format(copy.keepPriority, { count: impact.overflow });
  }
}

function buildGameCard(impact: PublicStation['games'][number]): HTMLElement {
  const definition = PLAYABLE_ARCADE_GAMES.find(game => game.id === impact.id)!;
  const title = gameTitle(locale, impact.id);
  const card = document.createElement('article');
  card.className = 'game-card';
  card.dataset.game = impact.id;
  const preview = selectionVideos[impact.id];
  card.innerHTML = `<div class="game-card-media"><span class="game-media-fallback" role="img" aria-label="${gameCommands[impact.id]}, ${title}"><strong>${gameCommands[impact.id]}</strong><b>${title}</b></span>${preview ? `<video data-src="${preview}" preload="none" loop muted playsinline aria-hidden="true"></video>` : ''}
      <span class="game-command"><small>${copy.textCommand}</small><strong>${gameCommands[impact.id]}</strong></span></div>
    <div class="game-card-body"><div class="game-card-meta"><span data-role="vote-count"></span><b data-role="leader" hidden></b></div>
      <h2>${title}</h2>
      <span class="game-capacity">${format(copy.playerMax, { count: definition.humanCapacity })}</span>
      <div class="capacity"><b data-role="play-now"></b><b data-role="overflow"></b></div></div>`;
  card.querySelector<HTMLVideoElement>('video')?.addEventListener(
    'error', () => card.classList.add('game-card-video-unavailable'), { once: true },
  );
  return card;
}

function renderStandaloneLauncher(): void {
  const games=orderByConfiguredIds(PLAYABLE_ARCADE_GAMES,standaloneGameOrder)
    .filter(game=>enabledGames.has(game.id));
  const lineupKey=games.map(game=>game.id).join(',');
  const key=lineupKey;
  if(key===standaloneGamesKey)return;
  if(lineupKey!==standaloneLineupKey)standalonePageIndex=0;
  standaloneGamesKey=key;standaloneLineupKey=lineupKey;standaloneGames.replaceChildren();
  if(!games.length){const message=document.createElement('p');message.className='standalone-unavailable';message.textContent=copy.standaloneUnavailable;standaloneGames.append(message);renderStandalonePage();return;}
  standaloneGames.append(...games.map(game => {
    const link = document.createElement('a');
    const url = new URL(game.route, location.origin);
    url.searchParams.set('display', '1');url.searchParams.set('room', '4821');url.searchParams.set('locale', locale);
    const displaySessionId = ensureDisplaySessionId();
    if (displaySessionId) url.searchParams.set('displaySessionId', displaySessionId);
    link.href=url.toString();link.className='standalone-game';link.dataset.game=game.id;
    const preview=selectionVideos[game.id];
    link.innerHTML=`${preview?`<video data-src="${preview}" preload="none" loop muted playsinline aria-hidden="true"></video>`:''}<span>${gameTitle(locale,game.id)}</span><p>${gameBlurbs[game.id]}</p>`;
    return link;
  }));
  renderStandalonePage();
}

function renderStandalonePage(nextPage=standalonePageIndex): void {
  standaloneGames.querySelectorAll('.standalone-page-placeholder').forEach(placeholder=>placeholder.remove());
  const cards=[...standaloneGames.querySelectorAll<HTMLElement>('.standalone-game')];
  const pageCount=calculatePageCount(cards.length);
  standalonePageIndex=clampPageIndex(nextPage,cards.length);
  const paginated=pageCount>1;
  const firstVisible=standalonePageIndex*STANDALONE_GAMES_PER_PAGE;
  cards.forEach((card,index) => { card.hidden=paginated&&(index<firstVisible||index>=firstVisible+STANDALONE_GAMES_PER_PAGE); });
  const visibleCount=Math.min(STANDALONE_GAMES_PER_PAGE,Math.max(0,cards.length-firstVisible));
  if(paginated)standaloneGames.append(...Array.from({length:STANDALONE_GAMES_PER_PAGE-visibleCount},()=>{
    const placeholder=document.createElement('span');placeholder.className='standalone-page-placeholder';placeholder.setAttribute('aria-hidden','true');return placeholder;
  }));
  standaloneGameRegion.classList.toggle('is-paginated',paginated);
  standalonePreviousPage.hidden=!paginated;standaloneNextPage.hidden=!paginated;standalonePageStatus.hidden=!paginated;
  standalonePreviousPage.disabled=standalonePageIndex===0;
  standaloneNextPage.disabled=standalonePageIndex>=pageCount-1;
  standalonePageStatus.textContent=pageCount>0
    ? format(copy.pageStatus,{page:standalonePageIndex+1,pages:pageCount})
    : '';
  syncPreviewPlayback();
}

function previewPlaybackAllowed(): boolean {
  return !fullscreenGameShell.active
    && document.visibilityState !== 'hidden'
    && !reducedMotionPreference.matches
    && !previewConnection?.saveData
    && !['slow-2g', '2g'].includes(previewConnection?.effectiveType ?? '');
}

function syncPreviewPlayback(): void {
  const playbackAllowed = previewPlaybackAllowed();
  document.querySelectorAll<HTMLVideoElement>('.station-view video').forEach(video => {
    const hiddenStandaloneCard=video.closest<HTMLElement>('.standalone-game')?.hidden===true;
    if (!playbackAllowed || !activeView.contains(video) || hiddenStandaloneCard) {
      video.pause();
      if(hiddenStandaloneCard&&video.hasAttribute('src')){video.removeAttribute('src');video.load();}
      return;
    }
    const source=video.dataset.src;
    if(source&&!video.getAttribute('src'))video.src=source;
    if (video.paused) void video.play().catch(() => undefined);
  });
}

function show(view: keyof typeof views): void {
  for (const [name, element] of Object.entries(views)) element.toggleAttribute('hidden', name !== view);
  activeView = views[view];
  syncPreviewPlayback();
}

function render(station: PublicStation): void {
  const previousPhase=current?.phase;
  current = station;
  if(previousPhase==='GAME_SELECTION'&&station.phase==='LOCKED')getSoundEffectsManager().playSelect();
  if(station.phase!=='GAME_SELECTION')selectionVotes=null;
  clearDisplaySetup();
  connection.textContent = copy.live;
  connection.classList.add('live');
  readyCount.textContent = String(station.phase === 'RESULTS' ? station.nextReadyCount : station.currentReadyCount);
  document.getElementById('readyLabel')!.textContent = copy.ready;
  readyRoster.replaceChildren(...station.roster.slice(0, 8).map(player => {
    const chip = document.createElement('span');
    chip.textContent = `${player.position}. ${player.displayName}`;
    return chip;
  }));
  phaseEyebrow.textContent = station.phase === 'ATTRACT' || station.phase === 'RESULTS' ? copy.attractEyebrow : copy.recruiting;
  const persistentJoin=document.getElementById('persistentJoin')!;
  persistentJoin.hidden=standaloneMode||qrRailMode==='hidden'||station.phase==='ATTRACT'||station.phase==='RECRUITING'||station.phase==='RESULTS';

  if (standaloneMode) {
    renderStandaloneLauncher();
    show('standalone');
  } else if (station.phase === 'GAME_SELECTION') {
    selectionTimer.hidden = false;
    document.getElementById('selectionEyebrow')!.textContent = copy.selectionEyebrow;
    document.getElementById('selectionTitle')!.textContent = copy.selectionTitle;
    document.getElementById('selectionDescription')!.textContent = copy.selectionDescription;
    renderGameCards(station);
    show('selection');
  } else if (station.phase === 'LOCKED') {
    show('countdown');
    document.getElementById('countdownEyebrow')!.textContent = copy.countdownEyebrow;
    document.getElementById('countdownDescription')!.textContent = copy.countdownDescription;
    lockedGame.textContent = station.activeGame ? gameTitle(locale, station.activeGame) : copy.nextGame;
  } else if (station.phase === 'RESULTS') {
    show('recruiting');
  } else if (station.phase === 'LAUNCHING' || station.phase === 'PLAYING') {
    if (!displayToken || displayTokenRejected || !station.launch) {
      showDisplaySetup(displayTokenRejected ? 'invalid' : 'missing');
      return;
    }
    const target = stationLaunchUrl(station, stationId, locale, joinBaseUrl);
    if (target && target !== launched) {
      launched = target;
      if (!fullscreenGameShell.launch(target)) location.replace(target);
    }
  } else {
    show('recruiting');
  }
  updateTimers();
}

function updateTimers(): void {
  if (!current) return;
  const seconds = current.deadline ? Math.ceil(Math.max(0, Date.parse(current.deadline) - Date.now()) / 1000) : null;
  const formatted = seconds === null ? '--:--' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  if (current.phase === 'RESULTS') {
    phaseTimer.textContent = current.nextReadyCount > 0
      ? format(copy.readyNext, { count: current.nextReadyCount })
      : copy.waiting;
  } else if (current.phase === 'RECRUITING' || current.phase === 'ATTRACT') {
    phaseTimer.textContent = seconds === null ? copy.waiting : copy.timer.replace('{time}', formatted);
  } else if (current.phase === 'GAME_SELECTION') {
    selectionTimer.textContent = formatted;
  } else if (current.phase === 'LOCKED') {
    lockedCountdown.textContent = seconds === null ? '--' : String(seconds);
  }
}

function clearDisplaySetup(): void {
  views.countdown.classList.remove('display-setup-view');
  document.getElementById('displaySetupPanel')!.hidden = true;
  lockedCountdown.hidden = false;
  document.getElementById('countdownDescription')!.hidden = false;
}

function showDisplaySetup(reason: 'missing' | 'invalid'): void {
  show('countdown');
  views.countdown.classList.add('display-setup-view');
  lockedCountdown.hidden = true;
  document.getElementById('countdownDescription')!.hidden = true;
  const panel = document.getElementById('displaySetupPanel')!;
  panel.hidden = false;
  document.getElementById('displaySetupEyebrow')!.textContent = copy.displaySetup;
  document.getElementById('displaySetupTitle')!.textContent = copy.connectDisplay;
  document.getElementById('displaySetupExplanation')!.textContent = reason === 'missing'
    ? copy.missingDisplayExplanation : copy.invalidDisplayExplanation;
  document.getElementById('displaySetupOperator')!.textContent = copy.openOperator;
  connection.textContent = reason === 'missing' ? copy.missingDisplayToken : copy.invalidDisplayToken;
}

async function refresh(): Promise<void> {
  if (fullscreenGameShell.active) return;
  if (refreshing) { refreshPending = true; return; }
  refreshing = true;
  try {
    if (standaloneMode) {
      renderStandaloneLauncher();
      show('standalone');
      return;
    }
    const result = await fetchPublicStation(displayToken);
    if (displayToken) displayTokenRejected = false;
    render(result.station);
  } catch (cause) {
    connection.textContent = copy.reconnecting;
    connection.classList.remove('live');
    if (displayToken && cause instanceof StationRequestError && [401, 403].includes(cause.status)) {
      rejectDisplayToken(displayToken);
      displayToken = null;
      displayTokenRejected = true;
      try {
        render((await fetchPublicStation()).station);
      } catch {
        connection.textContent = copy.reconnecting;
      }
    }
  } finally {
    refreshing = false;
    if (refreshPending) { refreshPending = false; void refresh(); }
  }
}

function wireTheme(): void {
  const button = document.getElementById('themeToggle')!;
  wireThemeToggle(button,{light:copy.lightTheme,dark:copy.darkTheme});
}

function wireFullscreen(): void {
  const button = document.getElementById('fullscreenToggle') as HTMLButtonElement;
  wireFullscreenToggle(button, { enter: copy.enterFullscreen, exit: copy.exitFullscreen });
}

function wireStandalonePagination(): void {
  standalonePreviousPage.addEventListener('click',()=>renderStandalonePage(standalonePageIndex-1));
  standaloneNextPage.addEventListener('click',()=>renderStandalonePage(standalonePageIndex+1));
  document.addEventListener('keydown',event=>{
    if(!standaloneMode||activeView!==views.standalone||!['ArrowLeft','ArrowRight'].includes(event.key))return;
    if(event.target instanceof Element&&event.target.closest('input,select,textarea,[contenteditable="true"]'))return;
    const nextPage=clampPageIndex(standalonePageIndex+(event.key==='ArrowLeft'?-1:1),standaloneGames.querySelectorAll('.standalone-game').length);
    if(nextPage===standalonePageIndex)return;
    event.preventDefault();renderStandalonePage(nextPage);
  });
}

function wireFullscreenGameLaunches(): void {
  standaloneGames.addEventListener('click', event => {
    if (!(event instanceof MouseEvent) || event.button !== 0
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a.standalone-game') : null;
    if (target) {
      const destination = new URL(target.href);
      const displaySessionId = ensureDisplaySessionId();
      if (displaySessionId) destination.searchParams.set('displaySessionId', displaySessionId);
      else destination.searchParams.delete('displaySessionId');
      target.href = destination.toString();
      if (fullscreenGameShell.launch(target.href)) event.preventDefault();
    }
  });
}

function stopHomeRuntime(): void {
  unsubscribeStation();
  unsubscribeStation = () => undefined;
  if (refreshTimer !== null) clearInterval(refreshTimer);
  if (configurationTimer !== null) clearInterval(configurationTimer);
  if (countdownTimer !== null) clearInterval(countdownTimer);
  refreshTimer = configurationTimer = countdownTimer = null;
  reducedMotionPreference.removeEventListener('change', syncPreviewPlayback);
  previewConnection?.removeEventListener?.('change', syncPreviewPlayback);
  document.removeEventListener('visibilitychange', syncPreviewPlayback);
}

function localizeStaticPage(): void {
  applyDocumentLocale();
  document.title = copy.pageTitle;
  document.getElementById('brandTagline')!.textContent = copy.tagline;
  connection.textContent = copy.connecting;
  document.getElementById('phaseTitle')!.textContent = copy.phaseTitle;
  document.getElementById('phaseDescription')!.innerHTML = locale === 'pt-BR'
    ? 'Escaneie, entre e responda <b>MOEDA</b> quando estiver pronto na tela.'
    : 'Scan, join, and reply <b>COIN</b> when you are ready at the screen.';
  document.getElementById('joinEyebrow')!.textContent = copy.joinEyebrow;
  document.getElementById('joinTitle')!.textContent = copy.joinTitle;
  document.getElementById('joinStepOne')!.textContent = copy.joinStepOne;
  document.getElementById('joinStepTwo')!.textContent = copy.joinStepTwo;
  document.getElementById('joinStepThree')!.innerHTML = locale === 'pt-BR'
    ? 'Responda <b>MOEDA</b> na tela' : 'Reply <b>COIN</b> at the screen';
  document.getElementById('selectionEyebrow')!.textContent = copy.selectionEyebrow;
  document.getElementById('selectionTitle')!.textContent = copy.selectionTitle;
  document.getElementById('selectionDescription')!.textContent = copy.selectionDescription;
  document.getElementById('countdownEyebrow')!.textContent = copy.countdownEyebrow;
  document.getElementById('countdownDescription')!.textContent = copy.countdownDescription;
  document.getElementById('standaloneEyebrow')!.textContent=copy.standaloneEyebrow;
  document.getElementById('standaloneTitle')!.innerHTML=copy.standaloneTitle;
  document.getElementById('standaloneDescription')!.textContent=copy.standaloneDescription;
  document.getElementById('standaloneQuickStartOne')!.textContent=copy.quickStartOne;
  document.getElementById('standaloneQuickStartTwo')!.textContent=copy.quickStartTwo;
  document.getElementById('standaloneQuickStartThree')!.textContent=copy.quickStartThree;
  standalonePreviousPage.setAttribute('aria-label',copy.previousPage);standalonePreviousPage.title=copy.previousPage;
  standaloneNextPage.setAttribute('aria-label',copy.nextPage);standaloneNextPage.title=copy.nextPage;
  document.getElementById('persistentJoinLabel')!.textContent=locale==='pt-BR'?'Proxima rodada':'Next round';
  document.getElementById('persistentJoinTitle')!.textContent=locale==='pt-BR'?'Escaneie para entrar':'Scan to join';
  const operator=document.getElementById('operatorLink')!;operator.innerHTML=OPERATOR_ICON;operator.title=copy.operator;operator.setAttribute('aria-label',copy.operator);
  const instructions=document.getElementById('instructionsLink')!;instructions.title=locale==='pt-BR'?'Como jogar':'How to play';instructions.setAttribute('aria-label',instructions.title);
  const howMade=document.getElementById('howItWorksLink')!;howMade.querySelector('span')!.textContent=copy.howMade;howMade.title=copy.howMade;howMade.setAttribute('aria-label',copy.howMade);
}

function renderEntryPolicyCopy(): void {
  const messaging = smsAvailable || whatsappAvailable;
  const entryAvailable = messaging || leadCaptureMode;
  const command = freePlay ? locale === 'pt-BR' ? 'PRONTO' : 'READY' : locale === 'pt-BR' ? 'MOEDA' : 'COIN';
  const englishMessaging = smsAvailable && whatsappAvailable
    ? 'SMS or WhatsApp'
    : smsAvailable ? 'SMS' : whatsappAvailable ? 'WhatsApp' : '';
  const channelStep = leadCaptureMode
    ? locale === 'pt-BR'
      ? whatsappAvailable
        ? 'WhatsApp recomendado · navegador como alternativa'
        : 'Continue no navegador'
      : messaging
        ? `${englishMessaging} recommended · browser as fallback`
        : 'Continue in browser'
    : smsAvailable && whatsappAvailable
      ? copy.joinStepOne
      : smsAvailable
        ? 'Open the prefilled SMS'
        : whatsappAvailable
          ? locale === 'pt-BR' ? 'Abra a conversa no WhatsApp' : 'Open the WhatsApp chat'
          : locale === 'pt-BR' ? 'WhatsApp indisponível no momento' : 'Messaging unavailable';
  document.getElementById('joinStepOne')!.textContent = channelStep;
  document.getElementById('joinStepTwo')!.textContent = entryAvailable
    ? copy.joinStepTwo
    : locale === 'pt-BR' ? 'A entrada em português exige WhatsApp' : 'Ask booth staff for help';
  document.getElementById('phaseDescription')!.innerHTML = leadCaptureMode
    ? locale === 'pt-BR'
      ? whatsappAvailable
        ? 'Escaneie e entre pelo WhatsApp (recomendado) ou continue no navegador.'
        : 'Escaneie e continue no navegador para entrar.'
      : messaging
        ? `Scan and use ${englishMessaging} (recommended), or continue in your browser.`
        : 'Scan and continue in your browser to join.'
    : messaging
      ? locale === 'pt-BR'
        ? `Escaneie, entre pelo WhatsApp e responda <b>${command}</b> quando estiver pronto na tela.`
        : `Scan, join, and reply <b>${command}</b> when you are ready at the screen.`
    : locale === 'pt-BR'
      ? 'A entrada em português exige WhatsApp, que está indisponível no momento.'
      : 'Messaging entry is unavailable right now.';
  document.getElementById('joinStepThree')!.innerHTML = leadCaptureMode
    ? locale === 'pt-BR'
      ? whatsappAvailable
        ? `WhatsApp: responda <b>${command}</b> · navegador: toque em Entrar`
        : 'No navegador, toque em Entrar no próximo jogo'
      : messaging
        ? `Messaging: reply <b>${command}</b> · browser: tap Join`
        : 'In your browser, tap Join the next game'
    : messaging
      ? locale === 'pt-BR' ? `Responda <b>${command}</b> na tela` : `Reply <b>${command}</b> at the screen`
    : locale === 'pt-BR' ? 'Fale com a equipe do estande' : 'Ask booth staff for help';
  document.getElementById('joinTitle')!.textContent = copy.joinTitle;
  (document.getElementById('joinQr') as HTMLImageElement).hidden = false;
}

async function refreshConfiguration(): Promise<void> {
  if (fullscreenGameShell.active) return;
  if (configuring) { configurationPending = true; return; }
  configuring = true;
  try {
    const bootstrapRequest: Promise<{
      publicBaseUrl?: string; smsNumber?: string; whatsappNumber?: string;
      voiceNumbers?: Partial<Record<'en-US' | 'pt-BR', string | null>>;
    }> = fetch('/api/config', { cache: 'no-store' })
      .then(async response => response.ok ? await response.json() : {})
      .catch(() => ({}));
    const [config, bootstrap] = await Promise.all([
      fetchPublicArcadeConfig(),
      bootstrapRequest,
    ]);
    joinBaseUrl = effectivePublicVisitorBaseUrl(bootstrap.publicBaseUrl);
    standaloneMode = config.arcade.mode === 'off';
    leadCaptureMode = config.arcade.mode === 'lead_capture';
    document.body.classList.toggle('standalone-mode',standaloneMode);
    freePlay = config.coins.chargePolicy === 'free';
    smsAvailable = locale !== 'pt-BR' && config.channels.sms && Boolean(bootstrap.smsNumber);
    whatsappAvailable = config.channels.whatsapp && Boolean(bootstrap.whatsappNumber);
    const configuredGames = new Set<PlayableArcadeGame>(Object.entries(config.station.games)
      .filter((entry): entry is [PlayableArcadeGame, { enabled: boolean }] => (
        isPlayableArcadeGame(entry[0]) && entry[1].enabled
      ))
      .map(([game]) => game));
    standaloneGameOrder=[...config.station.automaticSelection.order];
    const localStandalonePreview = standaloneMode && ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
    enabledGames = localStandalonePreview || (config.channels.voice && Boolean(bootstrap.voiceNumbers?.[locale]))
      ? configuredGames
      : new Set<PlayableArcadeGame>();
    stationId = config.arcade.cabinetId;
    qrRailMode=config.station.qrRail;
    renderEntryPolicyCopy();
    if(standaloneMode){renderStandaloneLauncher();show('standalone');}
    else if(current)render(current);
    if (!standaloneMode) {
      const value=stationJoinUrl(stationId,locale,joinBaseUrl),asset=stationQrAsset(locale,stationId,joinBaseUrl);
      const qr=await resolveStationQrImage(asset,()=>QRCode.toDataURL(value,{width:520,margin:1,errorCorrectionLevel:'M',color:{dark:'#000D25',light:'#FFFFFF'}}));
      if(qr){(document.getElementById('joinQr') as HTMLImageElement).src=qr;(document.getElementById('persistentJoinQr') as HTMLImageElement).src=qr;}
    }
  } catch {
    enabledGames = new Set<PlayableArcadeGame>();
    selectionLineup = '';
    if (standaloneMode) renderStandaloneLauncher();
    if (current) renderGameCards(current);
    connection.textContent = copy.reconnecting;
  } finally {
    configuring = false;
    if (configurationPending) { configurationPending = false; void refreshConfiguration(); }
  }
}

async function initialize(): Promise<void> {
  localizeStaticPage();
  wireTheme();
  wireFullscreen();
  wireStandalonePagination();
  wireFullscreenGameLaunches();
  injectMusicToggle('header-controls');
  injectLanguagePicker('header-controls');
  injectMagicHat();
  document.addEventListener('click', () => {
    if (!fullscreenGameShell.active) getMusicManager().switchContext('lobby');
  }, { once: true });
  reducedMotionPreference.addEventListener('change', syncPreviewPlayback);
  previewConnection?.addEventListener?.('change', syncPreviewPlayback);
  document.addEventListener('visibilitychange',syncPreviewPlayback);
  await refreshConfiguration();
  const coinInsertion=createCoinInsertionPresenter();
  unsubscribeStation=subscribeToStation(() => { void refreshConfiguration().then(() => refresh()); },event=>{
    if (!fullscreenGameShell.active) coinInsertion.show(event);
  });
  refreshTimer=setInterval(() => void refresh(), 5_000);
  configurationTimer=setInterval(() => void refreshConfiguration(), 30_000);
  countdownTimer=setInterval(updateTimers, 250);
  addEventListener('pagehide', event => {
    if (!(event as PageTransitionEvent).persisted) stopHomeRuntime();
  });
  await refresh();
}

void initialize();
