import QRCode from 'qrcode';
import { wireThemeToggle } from '../theme';
import { locale as resolvedLocale } from '../i18n';
import { effectivePublicVisitorBaseUrl, fetchPublicStation, rejectDisplayToken, resolveStationQrImage, stationQrAsset, storeDisplayToken } from '../station-client';
import { getSoundEffectsManager } from '../sound-effects';
import type { HomeConcept } from '../../shared/arcade-config';
import {
  isPlayableArcadeGame,
  PLAYABLE_ARCADE_GAMES,
  type PlayableArcadeGame,
} from '../../shared/arcade-games';
import { gameTitle } from '../../shared/i18n/content';
import { describeStationParticipantOutcome } from './result-outcome';

type ArcadeMode = 'off' | 'coin_only' | 'lead_capture';
type PlayableGame = PlayableArcadeGame;
type ChargePolicy = 'per_player' | 'per_match' | 'host_sponsors' | 'free';
type StationPhase = 'ATTRACT' | 'RECRUITING' | 'GAME_SELECTION' | 'LOCKED' | 'LAUNCHING' | 'PLAYING' | 'RESULTS';
type OperatorTab = 'operator-overview' | 'live-event' | 'messages' | 'setup';

interface PublicConfig { version:number;arcade:{mode:ArcadeMode;cabinetId:string};registration:{termsAcknowledgementRequired:boolean};coins:{startingBalance:number;chargePolicy:ChargePolicy};channels:{voice:boolean;sms:boolean;whatsapp:boolean;voiceNumbers:Record<'en-US'|'pt-BR',string|null>};station:{games:Record<PlayableGame,{enabled:boolean}>};earning:{enabled:boolean}; }
interface DeploymentConfig { publicBaseUrl?:string;phoneNumber?:string;voiceNumbers?:Partial<Record<'en-US'|'pt-BR',string|null>>;smsNumber?:string;whatsappNumber?:string; }
interface PlayerStatus { registered:boolean; firstName:string|null; preferredLocale:string|null; }
interface WalletStatus { ledgerBalance:number; reservedBalance:number; availableBalance:number; updatedAt:string; }
interface StationView { phase:string;revision:number;deadline:string|null;ready:{status:string;position:number|null;reservation:{amount:number;status:string}|null;gameChoice:PlayableGame|null}|null;availableBalance:number;callNumber:string|null; }
interface Challenge { id:string;title:string;message:string|null;rewardCoins:number;displayOrder:number;claimCount:number;maxClaimsPerPlayer:number;available:boolean;startsAt:string|null;endsAt:string|null; }
interface AdminChallenge { id:string;title:string;message:string|null;url:string;rewardCoins:number;enabled:boolean;maxClaimsPerPlayer:number;displayOrder:number;startsAt:string|null;endsAt:string|null; }
interface GameChoiceResponse { gameChoice:PlayableGame; }
interface AdminConfig extends Record<string,unknown> { version:number;updatedAt:string;updatedBy:string;schemaVersion:number;arcade:{mode:ArcadeMode;cabinetId:string};station:{timings:{recruitingSeconds:number;hardDeadlineSeconds:number;selectionSeconds:number;lockedSeconds:number;launchTimeoutSeconds:number;resultsSeconds:number;postGameRecruitingSeconds:number};games:Record<PlayableGame,{enabled:boolean}>;comingSoon:Record<HomeConcept,{enabled:false}>;automaticSelection:{policy:'best_fit_rotation'|'round_robin'|'fixed_priority';order:PlayableGame[]};qrRail:'auto'|'always'|'hidden'};coins:{startingBalance:number;chargePolicy:ChargePolicy};channels:{voice:boolean;sms:boolean;whatsapp:boolean;voiceNumbers:Record<'en-US'|'pt-BR',string|null>};earning:{enabled:boolean;challenges:AdminChallenge[]};postGame:{enabled:boolean;channels:Array<'sms'|'whatsapp'>;includeCoinBalance:boolean;includeChallenges:boolean}; }
interface OperatorStationView {
  station:{phase:StationPhase;revision:number;updatedAt:string;activeRoundId:string|null;nextRoundId:string|null;activeGame:PlayableGame|null;activeMatchId:string|null};
  round:{phase:string;firstCoinAt:string;recruitingEndsAt:string|null;hardEndsAt:string|null;selectionEndsAt:string|null;lockedEndsAt:string|null;resultsAt:string|null;selectedGame:PlayableGame|null}|null;
  match:{game:PlayableGame;phase:string;participantReadyEntryIds:string[];overflowReadyEntryIds:string[];launchGeneration:number;launchRequestedAt:string|null;displayReadyAt:string|null;startedAt:string|null;completedAt:string|null;result:{source:'ENGINE'|'RECOVERY'|'LEGACY_UNAVAILABLE';participants:Array<{readyEntryId:string;rank:number|null;completed:boolean;won:boolean|null;score:number|null;durationSeconds:number|null}>}|null}|null;
  readyEntries:Array<{id:string;roundId:string;displayName:string;originalReadyAt:string;status:string;overflowOrdinal:number|null;availableBalance:number;connected:boolean}>;
  voteCounts:Array<{game:PlayableGame;count:number}>;
  recentControls:Array<{id:string;action:string;actorKind:'operator'|'system';actorSubject:string;reason:string;fromRevision:number;toRevision:number;occurredAt:string}>;
  resultsHeld:boolean;
}
interface OperatorPlayerRecoveryItem {playerId:string;displayName:string;identities:Array<{channel:'sms'|'whatsapp'|'browser';maskedAddress:string}>;availableBalance:number;lastActivityAt:string;lastReadyStatus:string|null;registrationState:'complete'|'in_progress';canRestoreStartingBalance:boolean;canReset:boolean;blockedReason:string|null;}
interface OperatorPlayerRecoveryPage {configVersion:number;startingBalance:number;players:OperatorPlayerRecoveryItem[];nextCursor:string|null;}
interface MessagingFailedNotice { notificationId:string;kind:string;channel:'sms'|'whatsapp';status:'FAILED';attempts:number;maximumAttempts:number;lastErrorCode:string|null;lastErrorMessage:string|null;terminalReason:string|null;updatedAt:string;expiresAt:string;retryEligible:boolean;retryIneligibleReason:string|null; }
interface AdminStatus { display:{configured:boolean;connected:boolean;checking:boolean;lastSeenAt:string|null;presenceTimeoutSeconds:number};messaging:{configured:boolean;enabled:boolean;started:boolean;lastError:string|null;channels:Record<'sms'|'whatsapp',boolean>;counts:Record<string,number>;recentFailures:MessagingFailedNotice[];onboarding:Record<'sms'|'whatsapp',boolean>;storage:{players:number;messagingIdentities:number;identityCapacity:number;remainingIdentityCapacity:number;channelAddresses:number;drafts:number;cleanupEligible:number;retentionDays:number;pruneBatchSize:number}|null}|null; }
interface LeaderboardAdminSummary { games:Array<{game:PlayableGame;resettable:boolean;maps:Array<{map:string;label?:string;records:number}>}>; }
interface TriviaAudioRecoveryStatus { available:boolean;matchId?:string;questionId?:string;questionAttemptId?:number;recoveryDeadlineAtMs?:number; }

class ApiError extends Error { constructor(readonly status:number,readonly code:string,message:string){super(message);} }

const state: {
  config: PublicConfig | null;
  deployment: DeploymentConfig | null;
  player: PlayerStatus | null;
  wallet: WalletStatus | null;
  station: StationView | null;
  adminConfig: AdminConfig | null;
  operatorStation: OperatorStationView | null;
  operatorStationEtag: string | null;
  adminStatus: AdminStatus | null;
  operatorPlayers: OperatorPlayerRecoveryPage | null;
  leaderboardSummary: LeaderboardAdminSummary | null;
  leaderboardEtag: string | null;
  triviaAudioRecovery: TriviaAudioRecoveryStatus | null;
} = { config:null,deployment:null,player:null,wallet:null,station:null,adminConfig:null,operatorStation:null,operatorStationEtag:null,adminStatus:null,operatorPlayers:null,leaderboardSummary:null,leaderboardEtag:null,triviaAudioRecovery:null };

const notice = el('notice'), modeBadge = el('mode-badge'), heroBalance = el('hero-balance');
const PLAYABLE_GAMES: readonly PlayableGame[] = PLAYABLE_ARCADE_GAMES.map(game => game.id);
const operatorView = location.pathname === '/operator' || location.pathname === '/operator/';
const OPERATOR_TABS:readonly OperatorTab[]=['operator-overview','live-event','messages','setup'];
const playerPortuguese = !operatorView && resolvedLocale === 'pt-BR';
const playerText = (english:string,portuguese:string):string => playerPortuguese ? portuguese : english;
let operatorEvents:EventSource|null=null;
let operatorPoll:number|null=null;
let operatorMessagingPoll:number|null=null;
let playerEvents:EventSource|null=null;
let playerPoll:number|null=null;
let playerRefreshTimer:number|null=null;
let playerRefreshGeneration=0;
let editingChallengeId:string|null=null;
let modeFormDirty=false;
let pendingOpenSettings:{version:number;settings:Record<string,unknown>;mode:ArcadeMode}|null=null;
let stationActionSaving=false;
let stationResetIdempotencyKey:string|null=null;
let stationResetEtag:string|null=null;
let gameChoiceSaving=false;
let displayPresenceExpiresAt=0;
let playerRecoveryRequest:Promise<void>|null=null;
let triviaRecoveryRefreshGeneration=0;
el('refresh').addEventListener('click', () => void refreshAll(true));
el('operator-logout').addEventListener('click',()=>void logoutOperator());
el<HTMLFormElement>('registration-form').addEventListener('submit', event => void register(event));
el<HTMLFormElement>('join-form').addEventListener('submit', event => void joinQueue(event));
el('queue-leave').addEventListener('click', () => void leaveCurrentAdmission());
for(const button of document.querySelectorAll<HTMLButtonElement>('[data-game-choice]'))button.addEventListener('click',()=>void chooseGame(button.dataset.gameChoice as PlayableGame));
el<HTMLFormElement>('mode-form').addEventListener('submit', event => void saveMode(event));
el<HTMLFormElement>('mode-form').addEventListener('input',()=>setModeFormDirty(true));
el<HTMLFormElement>('mode-form').addEventListener('change',()=>setModeFormDirty(true));
el('discard-mode-changes').addEventListener('click',()=>void discardModeChanges());
el<HTMLFormElement>('station-controls').addEventListener('submit', event => event.preventDefault());
el<HTMLSelectElement>('admin-charge-policy').addEventListener('change', renderChargePolicy);
el<HTMLSelectElement>('admin-selection-policy').addEventListener('change',renderPrioritySettings);
for(const control of document.querySelectorAll<HTMLSelectElement>('[data-game-priority]'))control.addEventListener('change',event=>swapPriorityOrder(event.currentTarget as HTMLSelectElement));
el('add-admin-challenge').addEventListener('click',()=>openChallengeEditor());
el<HTMLInputElement>('admin-challenges-enabled').addEventListener('change',()=>void saveChallengeAvailability());
el('cancel-admin-challenge').addEventListener('click',closeChallengeEditor);
el<HTMLFormElement>('admin-challenge-form').addEventListener('submit',event=>void saveAdminChallenge(event));
el<HTMLSelectElement>('leaderboard-reset-game').addEventListener('change',renderLeaderboardReset);
el<HTMLSelectElement>('leaderboard-reset-map').addEventListener('change',renderLeaderboardReset);
el<HTMLInputElement>('leaderboard-reset-reason').addEventListener('input',renderLeaderboardReset);
el('leaderboard-reset-button').addEventListener('click',()=>void resetLeaderboard());
el('connect-booth-display').addEventListener('click', () => void connectBoothDisplay());
el('overview-action-button').addEventListener('click',openCurrentStationAction);
el('refresh-players').addEventListener('click',()=>void refreshOperatorPlayers(false,true));
el('load-more-players').addEventListener('click',()=>void refreshOperatorPlayers(true));
el('close-recruiting').addEventListener('click',()=>void stationAction('close'));
el('select-station-game').addEventListener('click',()=>void stationAction('select',el<HTMLSelectElement>('station-game').value as PlayableGame));
el('request-launch').addEventListener('click',()=>void stationAction('launch'));
el('fail-launch').addEventListener('click',()=>void stationAction('fail'));
el('emergency-complete').addEventListener('click',()=>void stationAction('complete'));
el('advance-results').addEventListener('click',()=>void stationAction('advance'));
el('hold-results').addEventListener('click',()=>void stationAction('hold'));
el('retry-trivia-audio').addEventListener('click',()=>void retryTriviaAudio());
el('open-station-reset').addEventListener('click',()=>openStationReset());
el('cancel-station-reset').addEventListener('click',cancelStationReset);
el<HTMLFormElement>('station-reset-form').addEventListener('submit',event=>{event.preventDefault();void stationAction('reset');});
el<HTMLDialogElement>('station-reset-dialog').addEventListener('cancel',event=>{event.preventDefault();cancelStationReset();});
el('review-preserved-flow').addEventListener('click',()=>activateOperatorTab('live-event',true,true));
el('admin-mode').addEventListener('change',()=>{renderPrioritySettings();renderRuntimeSummary();});
el('admin-sms').addEventListener('change',renderRuntimeSummary);
el('admin-whatsapp').addEventListener('change',renderRuntimeSummary);
el('admin-voice').addEventListener('change',renderRuntimeSummary);
el('admin-voice-en-us').addEventListener('input',renderRuntimeSummary);
el('admin-voice-pt-br').addEventListener('input',renderRuntimeSummary);
for(const game of PLAYABLE_GAMES)el(`admin-game-${game}`).addEventListener('change',renderRuntimeSummary);
window.setInterval(()=>{renderStationDeadline();renderOperatorOverview();},1000);
window.addEventListener('beforeunload',event=>{if(modeFormDirty){event.preventDefault();event.returnValue='';}});
applyTheme();
configureView();
initializeOperatorTabs();
localizePlayerPage();
void refreshAll();

async function refreshAll(showProgress=!operatorView): Promise<boolean> {
  if(showProgress)setNotice(operatorView?'Refreshing event data...':playerText('Checking your game status...','Verificando seu jogo...'));
  try {
    await refreshPublicConfig();
    if(operatorView)await refreshDeploymentConfig();
    const currentConfig=state.config;
    if(!currentConfig)throw new Error('Twilio Games settings are unavailable.');
    if(operatorView){
      await checkAdmin();show('operations',true);show('dashboard',false);
      if(state.adminConfig){await Promise.all([refreshOperatorStation(),refreshOperatorStatus(),refreshOperatorPlayers(),refreshLeaderboardSummary()]);startOperatorUpdates();}
      if(showProgress)setNotice('Event data refreshed.','success');return true;
    }
    show('operations',false);show('dashboard',true);
    if(currentConfig.arcade.mode==='coin_only'&&redirectNoLeadPlayer())return true;
    if (currentConfig.arcade.mode === 'off') {
      state.player = null; state.wallet = null; state.station = null;
      renderPlayer();startPlayerUpdates();setNotice('');
      return true;
    }
    await ensureSession();
    await refreshPlayer();
    startPlayerUpdates();
    setNotice(playerText('You are up to date.','Tudo pronto.'), 'success');
    return true;
  } catch (error) { showError(error);return false; }
}

async function refreshPublicConfig():Promise<void>{
  const config=await api<PublicConfig>('/api/arcade/config/public');
  if(state.config&&config.version<state.config.version)return;
  const changed=!state.config||config.version!==state.config.version;
  state.config=config;renderMode();if(!operatorView)renderGameChoice();
  if(changed)await renderPlayerQr();
}

async function refreshDeploymentConfig():Promise<void>{
  state.deployment=await api<DeploymentConfig>('/api/config');
  if(state.config)await renderPlayerQr();
  if(state.adminConfig)renderRuntimeSummary();
}

async function refreshOperatorConfiguration(forceConfigRender=false):Promise<void>{
  await Promise.all([refreshPublicConfig(),refreshDeploymentConfig()]);
  await checkAdmin(forceConfigRender);
  if(state.adminConfig)renderRuntimeSummary();
}

function configureView():void{
  const link=el<HTMLAnchorElement>('view-link');
  document.body.classList.add(operatorView?'operator-page':'player-page');
  if(operatorView){document.documentElement.lang='en-US';link.href='/player';link.textContent='Open player page';void refreshOperatorLogin();document.querySelector<HTMLElement>('.hero .eyebrow')!.textContent='Event operations';el('hero-title').textContent='Operator console';el('hero-lede').textContent='Monitor the live event, help players, and manage setup.';show('balance-hero',false);show('off-panel',false);}
  else{link.href='/operator';link.textContent='Operator console';}
}

function initializeOperatorTabs():void{
  if(!operatorView)return;
  for(const [index,id] of OPERATOR_TABS.entries()){
    const tab=document.querySelector<HTMLButtonElement>(`[data-operator-tab="${id}"]`)!;
    tab.addEventListener('click',()=>activateOperatorTab(id));
    tab.addEventListener('keydown',event=>{
      let next=index;
      if(event.key==='ArrowRight')next=(index+1)%OPERATOR_TABS.length;
      else if(event.key==='ArrowLeft')next=(index-1+OPERATOR_TABS.length)%OPERATOR_TABS.length;
      else if(event.key==='Home')next=0;
      else if(event.key==='End')next=OPERATOR_TABS.length-1;
      else return;
      event.preventDefault();
      const nextId=OPERATOR_TABS[next]!;
      activateOperatorTab(nextId);
      document.querySelector<HTMLButtonElement>(`[data-operator-tab="${nextId}"]`)!.focus();
    });
  }
  for(const link of document.querySelectorAll<HTMLAnchorElement>('[data-operator-target]')){
    link.addEventListener('click',event=>{
      event.preventDefault();
      const target=link.dataset.operatorTarget as OperatorTab;
      if(OPERATOR_TABS.includes(target))activateOperatorTab(target,true,true);
    });
  }
  window.addEventListener('popstate',()=>activateOperatorTab(operatorTabFromHash(),false));
  window.addEventListener('hashchange',()=>activateOperatorTab(operatorTabFromHash(),false));
  activateOperatorTab(operatorTabFromHash(),false);
}

function operatorTabFromHash():OperatorTab{
  const target=location.hash.slice(1) as OperatorTab;
  return OPERATOR_TABS.includes(target)?target:'operator-overview';
}

function activateOperatorTab(target:OperatorTab,updateHistory=true,focusPanel=false):void{
  if(!operatorView)return;
  for(const id of OPERATOR_TABS){
    const active=id===target;
    const tab=document.querySelector<HTMLButtonElement>(`[data-operator-tab="${id}"]`)!;
    tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
    el(id).hidden=!active;
  }
  if(updateHistory&&location.hash!==`#${target}`)history.pushState(null,'',`#${target}`);
  const selected=document.querySelector<HTMLButtonElement>(`[data-operator-tab="${target}"]`)!;
  selected.scrollIntoView({block:'nearest',inline:'nearest'});
  if(focusPanel)el(target).focus({preventScroll:true});
}

function focusOperatorTab(target:OperatorTab):void{
  activateOperatorTab(target);
  document.querySelector<HTMLButtonElement>(`[data-operator-tab="${target}"]`)!.focus();
}

function redirectNoLeadPlayer():boolean{
  if(operatorView||state.config?.arcade.mode!=='coin_only')return false;
  const target=new URL('/join',location.origin);
  target.searchParams.set('station',state.config.arcade.cabinetId);
  target.searchParams.set('locale',new URLSearchParams(location.search).get('locale')??storageGet('twilio-games-locale')??resolvedLocale);
  location.replace(`${target.pathname}${target.search}`);
  return true;
}

function localizePlayerPage():void{
  if(!playerPortuguese)return;
  document.documentElement.lang='pt-BR';
  document.title='Twilio Games · Jogador';
  document.querySelector<HTMLElement>('.brand')!.setAttribute('aria-label','Início do Twilio Games');
  document.querySelector('.brand span')!.textContent='TWILIO GAMES';
  el<HTMLAnchorElement>('view-link').textContent='Visão do operador';
  const refresh=el<HTMLButtonElement>('refresh');refresh.title='Atualizar dados';refresh.setAttribute('aria-label','Atualizar dados');
  document.querySelector<HTMLElement>('#registration-panel .eyebrow')!.textContent='Primeiro passo';
  document.querySelector<HTMLElement>('#registration-panel h2')!.textContent='Conte quem vai jogar';
  setLabel('firstName','Nome');setLabel('lastName','Sobrenome');setLabel('workEmail','E-mail profissional');
  setLabel('companyName','Empresa');setLabel('phoneNumber','Telefone');setLabel('countryCode','País ou região');
  el('terms-label').innerHTML='Concordo com os <a href="/join#terms-title" target="_blank" rel="noopener">termos de participação</a>.';
  el('marketing-label').textContent='Quero receber por e-mail novidades ocasionais sobre produtos e eventos da Twilio.';
  const countryNames:Record<string,string>={US:'Estados Unidos',BR:'Brasil',CA:'Canadá',MX:'México',GB:'Reino Unido',IE:'Irlanda',DE:'Alemanha',FR:'França',ES:'Espanha',IT:'Itália',NL:'Países Baixos',SE:'Suécia',PL:'Polônia',IN:'Índia',SG:'Singapura',JP:'Japão',KR:'Coreia do Sul',AU:'Austrália',NZ:'Nova Zelândia',ZA:'África do Sul',AE:'Emirados Árabes Unidos'};
  const countrySelect=document.querySelector<HTMLSelectElement>('[name="countryCode"]')!;countrySelect.options[0]!.textContent='Escolha uma opção';for(const option of [...countrySelect.options].slice(1))option.textContent=countryNames[option.value]??option.textContent;
  document.querySelector<HTMLElement>('#balance-hero span')!.textContent='Moedas disponíveis';document.querySelector<HTMLElement>('#balance-hero small')!.textContent='PRONTAS PARA JOGAR';
  document.querySelector<HTMLElement>('#off-panel .eyebrow')!.textContent='Jogo independente';document.querySelector<HTMLElement>('#off-panel h2')!.textContent='Escolha um jogo na tela principal.';document.querySelector<HTMLElement>('#off-panel p:last-child')!.textContent='Abra a sala do jogo, escaneie o QR da ligação e use sua voz como controle.';
  document.querySelector<HTMLElement>('#player-panel .eyebrow')!.textContent='Você entrou';
  document.querySelector<HTMLElement>('#player-panel p')!.textContent='Este telefone está conectado ao seu passe de jogo. Tudo pronto.';
  document.querySelector<HTMLElement>('#challenge-panel .eyebrow')!.textContent='Quer jogar de novo?';
  document.querySelector<HTMLElement>('#challenge-panel h2')!.textContent='Ganhe mais moedas';
  document.querySelector<HTMLElement>('#wallet-panel .eyebrow')!.textContent='Seu passe de jogo';
  document.querySelector<HTMLElement>('#wallet-panel h2')!.textContent='Moedas prontas';
  const walletLabels=['Total','Em uso','Disponíveis agora'];
  document.querySelectorAll<HTMLElement>('.wallet-grid span').forEach((label,index)=>{label.textContent=walletLabels[index]??label.textContent;});
  document.querySelector<HTMLElement>('#queue-panel .eyebrow')!.textContent='Próximo jogo';
  document.querySelector<HTMLElement>('#join-form p')!.textContent='Entre quando estiver pronto e fique perto da tela grande.';
  el('queue-leave').textContent='Sair da fila';
}

function setLabel(name:string,label:string):void{
  const host=document.querySelector<HTMLElement>(`[name="${name}"]`)?.closest('label');
  const textNode=host?[...host.childNodes].find(node=>node.nodeType===Node.TEXT_NODE&&node.textContent?.trim()):null;
  if(textNode)textNode.textContent=` ${label}`;
}

async function renderPlayerQr():Promise<void>{
  if(!state.config)return;const base=effectivePublicVisitorBaseUrl(state.deployment?.publicBaseUrl);const url=new URL('/join',base);url.searchParams.set('station',state.config.arcade.cabinetId);url.searchParams.set('locale',resolvedLocale);const value=url.toString();el('player-url').textContent=value;
  const custom=stationQrAsset(resolvedLocale,state.config.arcade.cabinetId,base);
  const qr=await resolveStationQrImage(custom,()=>QRCode.toDataURL(value,{width:520,margin:1,color:{dark:'#000D25',light:'#FFFFFF'},errorCorrectionLevel:'M'}));
  if(qr)el<HTMLImageElement>('player-qr').src=qr;else el<HTMLImageElement>('player-qr').removeAttribute('src');
}

async function ensureSession(): Promise<void> {
  if(!state.config)return;const scannedCabinet=new URLSearchParams(location.search).get('cabinet');
  await post('/api/arcade/session', { cabinetId: scannedCabinet??state.config.arcade.cabinetId });
}

async function refreshPlayer(): Promise<void> {
  const request=++playerRefreshGeneration;
  let player:PlayerStatus,wallet:WalletStatus|null,station:StationView|null;
  try{
    [player,wallet,station]=await Promise.all([
      api<PlayerStatus>('/api/arcade/player'),
      maybe<WalletStatus>('/api/arcade/wallet'),
      maybe<StationView>('/api/arcade/station/me'),
    ]);
  }catch(error){
    if(error instanceof ApiError&&error.code==='PLAYER_SESSION_RETIRED'){
      await ensureSession();return refreshPlayer();
    }
    throw error;
  }
  if(request!==playerRefreshGeneration)return;
  state.player=player;state.wallet=wallet;state.station=station;
  renderPlayer();
  if ((state.player.registered || state.config?.arcade.mode === 'coin_only')
    && state.config?.coins.chargePolicy !== 'free') await refreshChallenges();
}

function renderMode(): void {
  const mode = state.config?.arcade.mode ?? 'off';
  modeBadge.textContent = playerPortuguese
    ? ({off:'Jogo independente',coin_only:'Entrada por mensagem',lead_capture:'Cadastro completo'} as Record<ArcadeMode,string>)[mode]
    : ({off:'Standalone play',coin_only:'Messaging entry',lead_capture:'Lead capture entry'} as Record<ArcadeMode,string>)[mode];
  modeBadge.className = 'badge active';
  show('off-panel', mode === 'off');
}

function renderPlayer(): void {
  const mode = state.config?.arcade.mode ?? 'off';
  const configuredVoiceNumbers=state.config?.channels.voiceNumbers;
  const standaloneNumbers=effectiveVoiceNumbers(
    configuredVoiceNumbers?.['en-US']??'',configuredVoiceNumbers?.['pt-BR']??'',
  );
  const standaloneAvailable=Boolean(state.config?.channels.voice
    &&standaloneNumbers[playerPortuguese?'pt-BR':'en-US']
    &&Object.values(state.config.station.games).some(game=>game.enabled));
  modeBadge.className=`badge ${mode==='off'&&!standaloneAvailable?'off':'active'}`;
  const freePlay = state.config?.coins.chargePolicy === 'free';
  const startingBalance=freePlay?0:state.config?.coins.startingBalance??0;
  const registered = Boolean(state.player?.registered || mode === 'coin_only');
  const ready=registered;
  const termsRequired=Boolean(state.config?.registration.termsAcknowledgementRequired);
  const termsInput=el<HTMLInputElement>('termsAccepted');
  show('terms-field',termsRequired);termsInput.required=termsRequired;
  show('registration-panel', mode === 'lead_capture' && !state.player?.registered);
  show('player-panel', ready);
  show('wallet-panel', registered && Boolean(state.wallet) && !freePlay);
  show('challenge-panel', false);
  show('queue-panel', ready);
  el('player-greeting').textContent = state.player?.firstName
    ? playerText(`${state.player.firstName}, you're ready.`,`Tudo pronto, ${state.player.firstName}.`)
    : playerText("You're ready to play.",'Você está pronto para jogar.');
  el('hero-title').innerHTML=mode==='off'
    ? standaloneAvailable?playerText('Choose a game and <span>play by voice.</span>','Escolha um jogo e <span>jogue por voz.</span>'):playerText('Voice play is <span>unavailable.</span>','Os jogos por voz estão <span>indisponíveis.</span>')
    : freePlay
      ? playerText('Ready when <span>you are.</span>','Pronto quando <span>você estiver.</span>')
      : playerText('Your next game is <span>one coin away.</span>','Seu próximo jogo está a <span>uma moeda.</span>');
  el('hero-lede').textContent=mode==='off'
    ? standaloneAvailable?playerText('Open a lobby on the big screen, scan its call QR, and start playing.','Abra uma sala na tela principal, escaneie o QR da ligação e comece a jogar.'):playerText('Please ask booth staff for help.','Peça ajuda à equipe.')
    : freePlay
      ? playerText('Join the next game, then keep an eye on the big screen.','Entre no próximo jogo e acompanhe a tela grande.')
      : playerText('Use a coin to join the next game, then watch the big screen.','Use uma moeda para entrar no próximo jogo e acompanhe a tela grande.');
  show('balance-hero',mode!=='off'&&registered&&!freePlay);
  if(mode==='off'){
    document.querySelector<HTMLElement>('#off-panel h2')!.textContent=standaloneAvailable?playerText('Choose a game on the big screen.','Escolha um jogo na tela principal.'):playerText('Voice play is unavailable right now.','Os jogos por voz não estão disponíveis agora.');
    document.querySelector<HTMLElement>('#off-panel p:last-child')!.textContent=standaloneAvailable?playerText('Open a game lobby, scan its call QR, and use your voice as the controller.','Abra a sala do jogo, escaneie o QR da ligação e use sua voz como controle.'):playerText('Please ask booth staff for help.','Peça ajuda à equipe.');
  }
  el<HTMLButtonElement>('registration-submit').textContent=startingBalance===0
    ? playerText('Continue','Continuar')
    : startingBalance===1
      ? playerText('Continue · 1 coin included','Continuar · 1 moeda incluída')
      : playerText(`Continue · ${startingBalance} coins included`,`Continuar · ${startingBalance} moedas incluídas`);
  el('ready-pool-title').textContent=playerText('Join the next game','Entrar no próximo jogo');
  const noCoin=!freePlay&&!state.station?.ready&&(state.wallet?.availableBalance??0)<1;
  const joinButton=el<HTMLButtonElement>('join-form').querySelector<HTMLButtonElement>('button[type="submit"]');if(joinButton){joinButton.textContent=freePlay?playerText('Join game','Entrar no jogo'):playerText('Use 1 coin and join','Usar 1 moeda e entrar');joinButton.disabled=noCoin;}
  el('join-help').textContent=noCoin?playerText('Earn another coin to join the next game.','Ganhe outra moeda para entrar no próximo jogo.'):playerText("Join when you're ready to play and stay close to the big screen.",'Entre quando estiver pronto e fique perto da tela grande.');
  const wallet = state.wallet;
  heroBalance.textContent = wallet ? String(wallet.availableBalance) : '--';
  el('ledger-balance').textContent = wallet ? String(wallet.ledgerBalance) : '--';
  el('reserved-balance').textContent = wallet ? String(wallet.reservedBalance) : '--';
  el('available-balance').textContent = wallet ? String(wallet.availableBalance) : '--';
  renderQueue();
}

async function register(event: Event): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement, data = new FormData(form);
  setBusy(form,true); setNotice(playerText('Getting you ready to play...','Preparando você para jogar...'));
  try {
    await post('/api/arcade/register', {
      lead: {
        firstName:text(data,'firstName'), lastName:text(data,'lastName'), workEmail:text(data,'workEmail'),
        companyName:text(data,'companyName'), phoneNumber:text(data,'phoneNumber'), countryCode:text(data,'countryCode').toUpperCase(),
      },
      termsAccepted:data.get('termsAccepted') === 'on', marketingConsent:data.get('marketingConsent') === 'on',
      preferredLocale:new URLSearchParams(location.search).get('locale')??storageGet('twilio-games-locale')??resolvedLocale,
    });
    await refreshPlayer();setNotice(playerText(
      'Registration saved. You can join the next game.',
      'Cadastro concluído. Você pode entrar no próximo jogo.',
    ),'success');
  } catch(error){showError(error);} finally{setBusy(form,false);}
}

async function refreshChallenges(): Promise<void> {
  const host = el('challenges');
  try {
    const result = await api<{challenges:Challenge[]}>('/api/arcade/challenges');
    host.replaceChildren();
    if (!result.challenges.length) { show('challenge-panel',false);host.replaceChildren();return; }
    show('challenge-panel',true);
    for (const challenge of result.challenges) {
      const item = document.createElement('div'); item.className = 'list-item';
      const copy = document.createElement('div');
      const title = document.createElement('h4'); title.textContent = challenge.title;
      const detail = document.createElement('p'); detail.textContent = challenge.message ?? playerText(
        `Earn ${challenge.rewardCoins} coin${challenge.rewardCoins === 1 ? '' : 's'}`,
        `Ganhe ${challenge.rewardCoins} moeda${challenge.rewardCoins === 1 ? '' : 's'}`,
      );
      copy.append(title,detail);
      const button = document.createElement('button'); button.className='button primary'; button.type='button';
      button.textContent = challenge.available ? playerText(`Earn +${challenge.rewardCoins}`,`Receber +${challenge.rewardCoins}`) : playerText('Claimed','Resgatado'); button.disabled=!challenge.available;
      button.addEventListener('click',()=>void claimChallenge(challenge,button));
      item.append(copy,button); host.append(item);
    }
  } catch(error){show('challenge-panel',false);host.replaceChildren();showError(error);}
}

async function claimChallenge(challenge:Challenge,button:HTMLButtonElement):Promise<void>{
  button.disabled=true; setNotice(playerText(`Claiming ${challenge.title}...`,`Resgatando ${challenge.title}...`));
  const destination=window.open('about:blank','_blank');if(destination)destination.opener=null;
  try{
    const issued=await post<{token:string}>(`/api/arcade/challenges/${challenge.id}/token`,{});
    const result=await post<{destinationUrl:string;availableBalance:number}>(`/api/arcade/challenges/${challenge.id}/claim`,{token:issued.token});
    setNotice(playerText(`Coin earned. Opening ${challenge.title}.`,`Moeda recebida. Abrindo ${challenge.title}.`),'success');
    if(destination)destination.location.href=result.destinationUrl;else location.href=result.destinationUrl;await refreshPlayer();
  }catch(error){destination?.close();showError(error);button.disabled=false;}
}

async function joinQueue(event:Event):Promise<void>{
  event.preventDefault(); const form=event.currentTarget as HTMLFormElement; setBusy(form,true);
  try{await post('/api/arcade/station/coin',{});await refreshPlayer();setNotice(state.config?.coins.chargePolicy==='free'
    ? playerText("You're in line. Watch the big screen.",'Você está na fila. Acompanhe a tela grande.')
    : playerText("You're in. One coin is set aside for this game.",'Você entrou. Uma moeda está separada para este jogo.'),'success');}
  catch(error){showError(error);}finally{setBusy(form,false);}
}

async function queueAction(path:string,body:unknown):Promise<void>{
  try{await post(path,body);await refreshPlayer();setNotice(playerText('All set.','Tudo pronto.'),'success');}catch(error){showError(error);}
}
async function leaveCurrentAdmission():Promise<void>{
  await queueAction('/api/arcade/station/leave',{});
}

function renderQueue():void{
  const form=el<HTMLFormElement>('join-form'),box=el('queue-status'),actions=el('queue-actions');
  const station=state.station,callNow=el<HTMLAnchorElement>('call-now');
  renderGameChoice();
  const callNumber=station?.ready?.status==='ADMITTED'?station.callNumber?.trim():'';
  callNow.hidden=!callNumber;
  if(callNumber){callNow.href=`tel:${callNumber}`;callNow.textContent=playerText(`Call now · ${callNumber}`,`Ligue agora · ${callNumber}`);}
  else{callNow.removeAttribute('href');callNow.textContent='';}
  if(station?.ready){
    const canLeave=['READY','OVERFLOW'].includes(station.ready.status);
    form.hidden=true;box.hidden=false;actions.hidden=!canLeave;
    box.innerHTML=`<strong>${escapeHtml(playerStateName(station.ready.status))}</strong><dl><div><dt>${playerText('Your place','Sua posição')}</dt><dd>${station.ready.position ?? '--'}</dd></div><div><dt>${playerText('What happens next','Próximo passo')}</dt><dd>${escapeHtml(playerStateName(station.phase))}</dd></div>${station.ready.reservation?`<div class="coin-row"><dt>${playerText('Coin','Moeda')}</dt><dd>${playerText(`${station.ready.reservation.amount} reserved for this game`,`${station.ready.reservation.amount} reservada para este jogo`)}</dd></div>`:''}</dl>`;
    toggleButton('queue-leave',canLeave);return;
  }
  form.hidden=false;box.hidden=true;actions.hidden=true;box.replaceChildren();
}

function renderGameChoice():void{
  const station=state.station,panel=el('game-choice-panel');
  const visible=station?.phase==='GAME_SELECTION'&&station.ready?.status==='READY';
  panel.hidden=!visible;
  if(!visible)return;
  const savedChoice=station.ready?.gameChoice??null;
  const choice=savedChoice&&state.config?.station.games[savedChoice]?.enabled?savedChoice:null;
  panel.querySelector<HTMLElement>('.eyebrow')!.textContent=playerText('Choose the next game','Escolha o próximo jogo');
  el('game-choice-title').textContent=playerText('Cast your vote','Dê seu voto');
  el('game-choice-help').textContent=playerText(
    'Choose a game below. You can change your vote until time runs out.',
    'Escolha um jogo abaixo. Você pode mudar seu voto até o tempo acabar.',
  );
  el('current-game-choice').textContent=choice
    ? playerText(`Your choice: ${gameName(choice)}. You can still change it.`,`Sua escolha: ${gameName(choice)}. Você ainda pode mudar.`)
    : playerText('No choice yet. Pick one below.','Nenhuma escolha ainda. Escolha abaixo.');
  for(const button of panel.querySelectorAll<HTMLButtonElement>('[data-game-choice]')){
    const game=button.dataset.gameChoice as PlayableGame;
    button.querySelector<HTMLElement>('b')!.textContent=gameName(game);
    const enabled=state.config?.station.games[game]?.enabled===true;
    const selected=game===choice;
    button.hidden=!enabled;
    button.classList.toggle('selected',selected);
    button.setAttribute('aria-pressed',String(selected));
    button.disabled=gameChoiceSaving||!enabled;
  }
}

async function chooseGame(game:PlayableGame):Promise<void>{
  if(gameChoiceSaving||state.station?.phase!=='GAME_SELECTION'||state.station.ready?.status!=='READY'
    ||state.config?.station.games[game]?.enabled!==true)return;
  gameChoiceSaving=true;renderGameChoice();
  try{
    const result=await post<GameChoiceResponse>('/api/arcade/station/game-choice',{game});
    if(state.station?.ready){
      state.station={...state.station,ready:{...state.station.ready,gameChoice:result.gameChoice}};
    }
    renderPlayer();
    getSoundEffectsManager().playSelect();
    setNotice(playerText(`Your vote is now ${gameName(game)}. You can change it until time runs out.`,`Seu voto agora é ${gameName(game)}. Você pode mudar até o tempo acabar.`),'success');
    try{await refreshPlayer();}catch{/* Keep the saved choice; live updates will retry the projection refresh. */}
  }catch(error){showError(error);}
  finally{gameChoiceSaving=false;renderGameChoice();}
}

async function refreshPlayerConfiguration():Promise<void>{
  await refreshPublicConfig();
  if(redirectNoLeadPlayer())return;
  if(state.config?.arcade.mode==='off'){
    state.player=null;state.wallet=null;state.station=null;renderPlayer();return;
  }
  await ensureSession();
  await refreshPlayer();
}

function startPlayerUpdates():void{
  if(operatorView||state.config?.arcade.mode==='coin_only'||playerEvents)return;
  if(typeof EventSource==='undefined'){startPlayerPolling();return;}
  const events=new EventSource('/api/arcade/events');playerEvents=events;
  events.addEventListener('arcade_station_updated',schedulePlayerRefresh);
  events.addEventListener('arcade_config_updated',()=>void refreshPlayerConfiguration().catch(showError));
  events.onopen=()=>{
    if(playerPoll!==null){window.clearInterval(playerPoll);playerPoll=null;}
    void refreshPlayerConfiguration().catch(showError);
  };
  events.onerror=()=>{
    events.close();if(playerEvents===events)playerEvents=null;startPlayerPolling();
  };
}

function schedulePlayerRefresh():void{
  if(playerRefreshTimer!==null)window.clearTimeout(playerRefreshTimer);
  playerRefreshTimer=window.setTimeout(()=>{
    playerRefreshTimer=null;
    if(state.config?.arcade.mode!=='off')void refreshPlayer().catch(showError);
  },200);
}

function startPlayerPolling():void{
  if(playerPoll!==null)return;
  playerPoll=window.setInterval(()=>void refreshPlayerConfiguration().catch(showError),5000);
}

function stopPlayerUpdates():void{
  playerEvents?.close();playerEvents=null;
  if(playerPoll!==null)window.clearInterval(playerPoll);playerPoll=null;
  if(playerRefreshTimer!==null)window.clearTimeout(playerRefreshTimer);playerRefreshTimer=null;
  playerRefreshGeneration+=1;
}

async function checkAdmin(forceConfigRender=false):Promise<void>{
  const previousVersion=state.adminConfig?.version??null;
  let adminConfig:AdminConfig|null=null;
  try{adminConfig=await api<AdminConfig>('/api/admin/arcade/config');if(state.adminConfig&&adminConfig.version<state.adminConfig.version)adminConfig=state.adminConfig;if(modeFormDirty&&state.adminConfig&&adminConfig){if(adminConfig.version>state.adminConfig.version)setNotice('New event settings are available. Save or discard your draft to load them.','error');adminConfig=state.adminConfig;}}catch{/* Operator configuration unavailable. */}
  state.adminConfig=adminConfig;
  show('admin-console',Boolean(state.adminConfig));
  if(!state.adminConfig){stopOperatorUpdates();return;}
  if(previousVersion===state.adminConfig.version&&!forceConfigRender){renderOperatorOverview();return;}
  el<HTMLSelectElement>('admin-mode').value=state.adminConfig.arcade.mode;
  el<HTMLSelectElement>('admin-charge-policy').value=state.adminConfig.coins.chargePolicy;
  el<HTMLInputElement>('admin-starting-coins').value=String(state.adminConfig.coins.startingBalance);
  el<HTMLInputElement>('admin-sms').checked=state.adminConfig.channels.sms;
  el<HTMLInputElement>('admin-whatsapp').checked=state.adminConfig.channels.whatsapp;
  el<HTMLInputElement>('admin-voice').checked=state.adminConfig.channels.voice;
  el<HTMLInputElement>('admin-voice-en-us').value=state.adminConfig.channels.voiceNumbers['en-US']??'';
  el<HTMLInputElement>('admin-voice-pt-br').value=state.adminConfig.channels.voiceNumbers['pt-BR']??'';
  for(const game of PLAYABLE_GAMES)el<HTMLInputElement>(`admin-game-${game}`).checked=state.adminConfig.station.games[game].enabled;
  el<HTMLSelectElement>('admin-selection-policy').value=state.adminConfig.station.automaticSelection.policy;
  applyPriorityOrder(state.adminConfig.station.automaticSelection.order);
  el<HTMLSelectElement>('admin-qr-rail').value=state.adminConfig.station.qrRail;
  el<HTMLInputElement>('admin-challenges-enabled').checked=state.adminConfig.earning.enabled;
  el<HTMLInputElement>('admin-post-game-enabled').checked=state.adminConfig.postGame.enabled;
  el<HTMLInputElement>('admin-post-game-balance').checked=state.adminConfig.postGame.includeCoinBalance;
  el<HTMLInputElement>('admin-post-game-challenges').checked=state.adminConfig.postGame.includeChallenges;
  el<HTMLInputElement>('admin-post-game-sms').checked=state.adminConfig.postGame.channels.includes('sms');
  el<HTMLInputElement>('admin-post-game-whatsapp').checked=state.adminConfig.postGame.channels.includes('whatsapp');
  const timing=state.adminConfig.station.timings;
  el<HTMLInputElement>('admin-timing-recruiting').value=String(timing.recruitingSeconds);el<HTMLInputElement>('admin-timing-hard').value=String(timing.hardDeadlineSeconds);el<HTMLInputElement>('admin-timing-selection').value=String(timing.selectionSeconds);el<HTMLInputElement>('admin-timing-locked').value=String(timing.lockedSeconds);el<HTMLInputElement>('admin-timing-launch').value=String(timing.launchTimeoutSeconds);el<HTMLInputElement>('admin-timing-results').value=String(timing.resultsSeconds);el<HTMLInputElement>('admin-timing-postgame').value=String(timing.postGameRecruitingSeconds);
  closeChallengeEditor();renderAdminChallenges();renderChargePolicy();renderPrioritySettings();renderRuntimeSummary();setModeFormDirty(false);
}

async function connectBoothDisplay():Promise<void>{
  const button=el<HTMLButtonElement>('connect-booth-display');
  let installedToken:string|null=null;
  button.disabled=true;button.textContent='Connecting this tab...';
  try{
    const payload=await api<unknown>('/api/admin/arcade/display/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    const record=payload!==null&&typeof payload==='object'&&!Array.isArray(payload)?payload as Record<string,unknown>:null;
    const token=record?.displayToken;
    const keys=record?Object.keys(record):[];
    if(keys.length!==1||keys[0]!=='displayToken'||typeof token!=='string'||token!==token.trim()||new TextEncoder().encode(token).byteLength<16){
      throw new Error('The display connection response was invalid. Refresh and try again.');
    }
    installedToken=token;
    if(!storeDisplayToken(token))throw new Error('This browser blocked display storage. Allow session storage for this site and try again.');
    await fetchPublicStation(token);
    location.replace('/');
    installedToken=null;
  }catch(error){
    if(installedToken)rejectDisplayToken(installedToken);
    const message=error instanceof ApiError&&error.status===503
        ? 'Booth display security is not configured. Ask a deployment administrator to configure it, then retry.'
        : error instanceof ApiError
          ? 'The display connection request failed. Refresh the operator console and try again.'
          : error instanceof Error?error.message:'This browser could not be connected. Refresh and try again.';
    setNotice(message,'error');
  }finally{
    button.disabled=false;button.textContent='Pair this tab as the big screen';
  }
}

async function saveMode(event:Event):Promise<void>{
  event.preventDefault();if(!state.adminConfig)return;
  const form=event.currentTarget as HTMLFormElement;
  const chargePolicy=el<HTMLSelectElement>('admin-charge-policy').value as ChargePolicy;
  const startingBalance=Number(el<HTMLInputElement>('admin-starting-coins').value);
  const minimumBalance=chargePolicy==='free'?0:1;
  if(!Number.isSafeInteger(startingBalance)||startingBalance<minimumBalance||startingBalance>100){setNotice(chargePolicy==='free'?'No-coin events start players at zero.':'Choose a whole number from 1 to 100 for coins after sign-up.','error');return;}
  const config=state.adminConfig,{schemaVersion:_s,version,updatedAt:_a,updatedBy:_b,...rawSettings}=config;
  const settings=structuredClone(rawSettings);
  (settings.arcade as AdminConfig['arcade']).mode=el<HTMLSelectElement>('admin-mode').value as ArcadeMode;
  (settings.coins as AdminConfig['coins']).startingBalance=chargePolicy==='free'?0:startingBalance;
  (settings.coins as AdminConfig['coins']).chargePolicy=chargePolicy;
  (settings.channels as AdminConfig['channels']).sms=el<HTMLInputElement>('admin-sms').checked;
  (settings.channels as AdminConfig['channels']).whatsapp=el<HTMLInputElement>('admin-whatsapp').checked;
  (settings.channels as AdminConfig['channels']).voice=el<HTMLInputElement>('admin-voice').checked;
  const voiceEn=el<HTMLInputElement>('admin-voice-en-us').value.trim(),voicePt=el<HTMLInputElement>('admin-voice-pt-br').value.trim();
  if([voiceEn,voicePt].some(number=>number&&!/^\+[1-9][0-9]{7,14}$/.test(number))){setNotice('Enter voice numbers in full international format, for example +551155555555.','error');return;}
  if(voiceEn&&voiceEn===voicePt){setNotice('English and Portuguese voice numbers must be different.','error');return;}
  (settings.channels as AdminConfig['channels']).voiceNumbers={'en-US':voiceEn||null,'pt-BR':voicePt||null};
  const selectedMode=(settings.arcade as AdminConfig['arcade']).mode;
  if(selectedMode!=='off'&&chargePolicy==='free'){setNotice('Messaging Entry and Lead Capture require one coin per player.','error');return;}
  const smsReady=(settings.channels as AdminConfig['channels']).sms&&Boolean(deploymentChannelNumber('sms'));
  const whatsappReady=(settings.channels as AdminConfig['channels']).whatsapp&&Boolean(deploymentChannelNumber('whatsapp'));
  if(selectedMode==='coin_only'&&!smsReady&&!whatsappReady){setNotice('Message entry needs Text message or WhatsApp turned on with a valid number.','error');return;}
  const voiceNumbers=effectiveVoiceNumbers(voiceEn,voicePt);
  const voiceReady=Boolean(voiceNumbers['en-US']&&voiceNumbers['pt-BR']);
  if(selectedMode!=='off'&&!(settings.channels as AdminConfig['channels']).voice){setNotice('Open events need Voice controls turned on.','error');return;}
  if(selectedMode!=='off'&&!voiceReady){setNotice('Add valid English and Portuguese voice numbers before opening the event.','error');return;}
  const station=settings.station as AdminConfig['station'];
  for(const game of PLAYABLE_GAMES)station.games[game].enabled=el<HTMLInputElement>(`admin-game-${game}`).checked;
  station.comingSoon.trivia.enabled=false;
  if(selectedMode!=='off'&&!Object.values(station.games).some(game=>game.enabled)){setNotice('Choose at least one game before opening the event.','error');return;}
  const selectionPolicy=el<HTMLSelectElement>('admin-selection-policy').value as AdminConfig['station']['automaticSelection']['policy'];
  const selectedOrder=el<HTMLInputElement>('admin-game-order').value.split(',').map(value=>value.trim()) as PlayableGame[];
  const validOrder=selectedOrder.length===PLAYABLE_GAMES.length&&new Set(selectedOrder).size===PLAYABLE_GAMES.length&&selectedOrder.every(game=>PLAYABLE_GAMES.includes(game));
  if(!validOrder){setNotice('Choose each game once in the display order.','error');return;}
  station.automaticSelection.policy=selectionPolicy;station.automaticSelection.order=selectedOrder;station.qrRail=el<HTMLSelectElement>('admin-qr-rail').value as AdminConfig['station']['qrRail'];
  const postGame=settings.postGame as AdminConfig['postGame'];
  postGame.enabled=el<HTMLInputElement>('admin-post-game-enabled').checked;
  postGame.includeCoinBalance=el<HTMLInputElement>('admin-post-game-balance').checked;
  postGame.includeChallenges=el<HTMLInputElement>('admin-post-game-challenges').checked;
  postGame.channels=(['sms','whatsapp'] as const).filter(channel=>el<HTMLInputElement>(`admin-post-game-${channel}`).checked);
  if(config.arcade.mode==='off'&&selectedMode!=='off'&&!postGame.enabled){
    postGame.channels=(['sms','whatsapp'] as const).filter(channel=>(settings.channels as AdminConfig['channels'])[channel]);
    postGame.enabled=postGame.channels.length>0;
  }
  if(postGame.enabled&&!postGame.channels.length){setNotice('Choose Text message or WhatsApp for result messages.','error');return;}
  if(postGame.channels.includes('sms')&&!el<HTMLInputElement>('admin-sms').checked){setNotice('Turn on Text message before using it for result messages.','error');return;}
  if(postGame.channels.includes('whatsapp')&&!el<HTMLInputElement>('admin-whatsapp').checked){setNotice('Turn on WhatsApp before using it for result messages.','error');return;}
  station.timings={recruitingSeconds:numberField('admin-timing-recruiting'),hardDeadlineSeconds:numberField('admin-timing-hard'),selectionSeconds:numberField('admin-timing-selection'),lockedSeconds:numberField('admin-timing-locked'),launchTimeoutSeconds:numberField('admin-timing-launch'),resultsSeconds:numberField('admin-timing-results'),postGameRecruitingSeconds:numberField('admin-timing-postgame')};
  if(config.arcade.mode!==selectedMode&&state.operatorStation&&state.operatorStation.station.phase!=='ATTRACT'){
    await queueOpenAfterReset(version,settings,selectedMode);return;
  }
  setBusy(form,true);
  try{
    await updateConfig(version,settings);setModeFormDirty(false);
    if(!await refreshAll(false)){setNotice('Settings were saved, but the console could not reload them. Refresh before making another change.','error');return;}
    if(state.adminConfig?.arcade.mode!==selectedMode)throw new Error('The saved event status could not be confirmed. Refresh before trying again.');
    setNotice(selectedMode==='off'?'Settings saved. Standalone play is active.':'Settings saved. The messaging event is active.','success');
  }catch(error){
    if(error instanceof ApiError&&error.status===412){setModeFormDirty(false);await refreshOperatorConfiguration();setNotice('Someone else saved changes first. The latest settings are now loaded; review them before saving again.','error');}
    else if(error instanceof ApiError&&error.code==='ACTIVE_STATION_CONFIG_LOCKED'){
      if(config.arcade.mode!==selectedMode)await queueOpenAfterReset(version,settings,selectedMode);
      else setNotice(config.arcade.mode==='off'?'A previous event queue is still preserved. Reset it from Live event before changing these settings; no settings were changed.':'The live messaging event is using these settings. Switch to Standalone play before changing them; no settings were changed.','error');
    }
    else showError(error);
  }finally{setBusy(form,false);}
}

async function discardModeChanges():Promise<void>{pendingOpenSettings=null;setModeFormDirty(false);await refreshOperatorConfiguration(true);setNotice('Unsaved event setting changes were discarded.','success');}

async function queueOpenAfterReset(version:number,settings:Record<string,unknown>,mode:ArcadeMode):Promise<void>{
  if(!state.operatorStation||state.operatorStation.station.phase==='ATTRACT')await refreshOperatorStation().catch(()=>undefined);
  if(!state.operatorStation||state.operatorStation.station.phase==='ATTRACT'||!state.operatorStationEtag){
    setNotice('The saved event flow changed. Refresh the console, review the live event, and try opening again.','error');return;
  }
  pendingOpenSettings={version,settings,mode};
  activateOperatorTab('live-event');openStationReset(true);
  setNotice('Confirm the reset to clear the previous event queue and save the new player journey.');
}

function setModeFormDirty(dirty:boolean):void{
  modeFormDirty=dirty;
  el('settings-savebar').hidden=!dirty;
}

function renderAdminChallenges():void{
  const host=el('admin-challenges');host.replaceChildren();
  const challenges=[...(state.adminConfig?.earning.challenges??[])].sort((left,right)=>left.displayOrder-right.displayOrder||left.id.localeCompare(right.id));
  el('admin-challenge-status').textContent=state.adminConfig?.earning.enabled
    ? `${challenges.length} challenge${challenges.length===1?'':'s'} available to players`
    : 'Coin challenges are currently turned off';
  if(!challenges.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No coin challenges yet.';host.append(empty);return;}
  for(const challenge of challenges){
    const item=document.createElement('div');item.className='list-item admin-challenge-item';
    const copy=document.createElement('div'),title=document.createElement('h4'),detail=document.createElement('p'),message=document.createElement('p'),destination=document.createElement('a'),meta=document.createElement('div');
    title.textContent=challenge.title;
    detail.textContent=`${challenge.enabled?'Available':'Hidden'} · +${challenge.rewardCoins} coin${challenge.rewardCoins===1?'':'s'} · ${challenge.maxClaimsPerPlayer} use${challenge.maxClaimsPerPlayer===1?'':'s'} per player`;
    message.className='challenge-message';message.textContent=challenge.message??'No custom player message.';
    destination.href=challenge.url;destination.target='_blank';destination.rel='noopener noreferrer';destination.textContent=challenge.url;
    meta.className='meta';meta.textContent=challengeSchedule(challenge);
    copy.append(title,detail,message,destination,meta);
    const actions=document.createElement('div');actions.className='operator-actions';
    const edit=document.createElement('button');edit.className='button quiet';edit.type='button';edit.textContent='Edit';edit.addEventListener('click',()=>openChallengeEditor(challenge));
    const remove=document.createElement('button');remove.className='button danger';remove.type='button';remove.textContent='Remove';remove.addEventListener('click',()=>void removeAdminChallenge(challenge));
    actions.append(edit,remove);item.append(copy,actions);host.append(item);
  }
}

async function saveChallengeAvailability():Promise<void>{
  const config=state.adminConfig;if(!config)return;
  if(modeFormDirty){el<HTMLInputElement>('admin-challenges-enabled').checked=config.earning.enabled;setNotice('Save or discard the event setting changes before updating challenges.','error');return;}
  const enabled=el<HTMLInputElement>('admin-challenges-enabled').checked;
  const {schemaVersion:_s,version,updatedAt:_a,updatedBy:_b,...rawSettings}=config,settings=structuredClone(rawSettings);
  (settings.earning as AdminConfig['earning']).enabled=enabled;
  setChallengeBusy(true);
  try{await updateConfig(version,settings);setNotice(enabled?'Coin challenges are available to players.':'Coin challenges are hidden from players.','success');await refreshAll();}
  catch(error){el<HTMLInputElement>('admin-challenges-enabled').checked=config.earning.enabled;if(error instanceof ApiError&&error.status===412){await refreshOperatorConfiguration();setNotice('Challenge settings changed elsewhere. The latest settings are loaded.','error');}else showError(error);}
  finally{setChallengeBusy(false);}
}

function challengeSchedule(challenge:AdminChallenge):string{
  if(challenge.startsAt&&challenge.endsAt)return `${challenge.id} · ${formatTimestamp(challenge.startsAt)} to ${formatTimestamp(challenge.endsAt)}`;
  if(challenge.startsAt)return `${challenge.id} · starts ${formatTimestamp(challenge.startsAt)}`;
  if(challenge.endsAt)return `${challenge.id} · ends ${formatTimestamp(challenge.endsAt)}`;
  return `${challenge.id} · always available while enabled`;
}

function openChallengeEditor(challenge?:AdminChallenge):void{
  if(modeFormDirty){setNotice('Save or discard the event setting changes before editing challenges.','error');el('settings-savebar').scrollIntoView({block:'center'});return;}
  editingChallengeId=challenge?.id??null;
  const form=el<HTMLFormElement>('admin-challenge-form');form.reset();form.hidden=false;
  el('admin-challenge-form-title').textContent=challenge?'Edit challenge':'Add challenge';
  el<HTMLInputElement>('admin-challenge-id').value=challenge?.id??'';
  el<HTMLInputElement>('admin-challenge-title').value=challenge?.title??'';
  el<HTMLInputElement>('admin-challenge-message').value=challenge?.message??'';
  el<HTMLInputElement>('admin-challenge-url').value=challenge?.url??'';
  el<HTMLInputElement>('admin-challenge-reward').value=String(challenge?.rewardCoins??1);
  el<HTMLInputElement>('admin-challenge-claims').value=String(challenge?.maxClaimsPerPlayer??1);
  el<HTMLInputElement>('admin-challenge-order').value=String(challenge?.displayOrder??0);
  el<HTMLInputElement>('admin-challenge-starts').value=localDateTimeValue(challenge?.startsAt??null);
  el<HTMLInputElement>('admin-challenge-ends').value=localDateTimeValue(challenge?.endsAt??null);
  el<HTMLInputElement>('admin-challenge-enabled').checked=challenge?.enabled??true;
  el<HTMLInputElement>('admin-challenge-id').focus();
}

function closeChallengeEditor():void{
  editingChallengeId=null;const form=el<HTMLFormElement>('admin-challenge-form');form.reset();form.hidden=true;
}

async function saveAdminChallenge(event:Event):Promise<void>{
  event.preventDefault();const form=event.currentTarget as HTMLFormElement,config=state.adminConfig;if(!config)return;
  if(!form.reportValidity())return;
  const id=el<HTMLInputElement>('admin-challenge-id').value.trim(),title=el<HTMLInputElement>('admin-challenge-title').value.trim(),message=el<HTMLInputElement>('admin-challenge-message').value.trim(),url=el<HTMLInputElement>('admin-challenge-url').value.trim();
  if(!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id)||['constructor','prototype','__proto__'].includes(id)){setNotice('Use lowercase letters, numbers, and hyphens for the short ID.','error');return;}
  if(!title){setNotice('Add a title for the challenge.','error');return;}
  let destination:URL;
  try{destination=new URL(url);}catch{setNotice('Enter the full player link, starting with https://.','error');return;}
  if(destination.protocol!=='https:'||destination.username||destination.password){setNotice('The player link must be a secure https:// address without sign-in details in the URL.','error');return;}
  const rewardCoins=numberField('admin-challenge-reward'),maxClaimsPerPlayer=numberField('admin-challenge-claims'),displayOrder=numberField('admin-challenge-order');
  if(!Number.isSafeInteger(rewardCoins)||rewardCoins<1||rewardCoins>100){setNotice('Challenge reward must be a whole number from 1 to 100 coins.','error');return;}
  if(!Number.isSafeInteger(maxClaimsPerPlayer)||maxClaimsPerPlayer<1||maxClaimsPerPlayer>100){setNotice('Uses per player must be a whole number from 1 to 100.','error');return;}
  if(!Number.isSafeInteger(displayOrder)||displayOrder<0||displayOrder>1_000_000){setNotice('Sort order must be a whole number from 0 to 1000000.','error');return;}
  const startsAt=isoFromLocalInput(el<HTMLInputElement>('admin-challenge-starts').value),endsAt=isoFromLocalInput(el<HTMLInputElement>('admin-challenge-ends').value);
  if(startsAt===undefined||endsAt===undefined){setNotice('Check the challenge dates and times.','error');return;}
  if(startsAt&&endsAt&&Date.parse(startsAt)>=Date.parse(endsAt)){setNotice('The end time must be after the start time.','error');return;}
  const challenges=[...config.earning.challenges],editingIndex=editingChallengeId===null?-1:challenges.findIndex(challenge=>challenge.id===editingChallengeId);
  if(editingChallengeId!==null&&editingIndex<0){closeChallengeEditor();setNotice('That challenge changed in another operator session. Review the latest list.','error');return;}
  if(challenges.some((challenge,index)=>challenge.id===id&&index!==editingIndex)){setNotice(`Challenge ID ${id} is already configured.`,'error');return;}
  const challenge:AdminChallenge={id,title,message:message||null,url:destination.href,rewardCoins,enabled:el<HTMLInputElement>('admin-challenge-enabled').checked,maxClaimsPerPlayer,displayOrder,startsAt,endsAt};
  if(editingIndex<0)challenges.push(challenge);else challenges[editingIndex]=challenge;
  await saveChallengeSettings(challenges,editingIndex<0?'Challenge added.':'Challenge updated.',form);
}

async function removeAdminChallenge(challenge:AdminChallenge):Promise<void>{
  const config=state.adminConfig;if(!config)return;
  if(modeFormDirty){setNotice('Save or discard the event setting changes before updating challenges.','error');return;}
  if(!await confirmChallengeRemoval(challenge))return;
  const challenges=config.earning.challenges.filter(candidate=>candidate.id!==challenge.id);
  if(challenges.length===config.earning.challenges.length){setNotice('That challenge is no longer configured.','error');return;}
  await saveChallengeSettings(challenges,'Challenge removed.',el<HTMLFormElement>('admin-challenge-form'));
}

function confirmChallengeRemoval(challenge:AdminChallenge):Promise<boolean>{
  const dialog=el<HTMLDialogElement>('challenge-remove-dialog');
  const form=el<HTMLFormElement>('challenge-remove-form');
  el('challenge-remove-description').textContent=`Remove “${challenge.title}”? Players who already earned coins will keep them.`;
  dialog.showModal();
  return new Promise(resolve=>{
    const finish=(confirmed:boolean)=>{
      form.onsubmit=null;el<HTMLButtonElement>('cancel-challenge-remove').onclick=null;dialog.oncancel=null;
      dialog.close();resolve(confirmed);
    };
    form.onsubmit=event=>{event.preventDefault();finish(true);};
    el<HTMLButtonElement>('cancel-challenge-remove').onclick=()=>finish(false);
    dialog.oncancel=event=>{event.preventDefault();finish(false);};
  });
}

async function saveChallengeSettings(challenges:AdminChallenge[],successMessage:string,form:HTMLFormElement):Promise<void>{
  const config=state.adminConfig;if(!config)return;
  if(modeFormDirty){setNotice('Save or discard the event setting changes before updating challenges.','error');return;}
  const {schemaVersion:_s,version,updatedAt:_a,updatedBy:_b,...rawSettings}=config,settings=structuredClone(rawSettings);
  (settings.earning as AdminConfig['earning']).challenges=challenges;
  (settings.earning as AdminConfig['earning']).enabled=el<HTMLInputElement>('admin-challenges-enabled').checked;
  if(challenges.length>0)(settings.postGame as AdminConfig['postGame']).includeChallenges=true;
  setChallengeBusy(true);
  try{const saved=await updateConfig(version,settings);state.adminConfig=saved;closeChallengeEditor();el<HTMLInputElement>('admin-challenges-enabled').checked=saved.earning.enabled;el<HTMLInputElement>('admin-post-game-challenges').checked=saved.postGame.includeChallenges;renderAdminChallenges();renderRuntimeSummary();setNotice(successMessage,'success');}
  catch(error){
    if(error instanceof ApiError&&error.status===412){closeChallengeEditor();await refreshOperatorConfiguration();setNotice('Challenge settings changed in another operator session. The latest list is loaded; review it before retrying.','error');}
    else showError(error);
  }finally{setChallengeBusy(false);if(!form.hidden)form.querySelector<HTMLInputElement>('input:not([type="checkbox"])')?.focus();}
}

function setChallengeBusy(busy:boolean):void{
  for(const control of el('admin-challenge-panel').querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input'))control.disabled=busy;
}

function localDateTimeValue(value:string|null):string{
  if(!value)return'';const date=new Date(value),local=new Date(date.getTime()-date.getTimezoneOffset()*60_000);return local.toISOString().slice(0,19);
}

function isoFromLocalInput(value:string):string|null|undefined{
  if(!value)return null;const date=new Date(value);return Number.isNaN(date.getTime())?undefined:date.toISOString();
}

function renderChargePolicy():void{
  const free=el<HTMLSelectElement>('admin-charge-policy').value==='free',input=el<HTMLInputElement>('admin-starting-coins');
  el('starting-coins-field').hidden=free;input.min=free?'0':'1';
  if(free)input.value='0';else if(Number(input.value)<1)input.value='1';
  renderRuntimeSummary();
}
function applyPriorityOrder(order:readonly PlayableGame[]):void{
  document.querySelectorAll<HTMLSelectElement>('[data-game-priority]').forEach((control,index)=>{control.value=order[index]??PLAYABLE_GAMES[index]!;});
  syncPriorityOrder();
}
function syncPriorityOrder():void{
  el<HTMLInputElement>('admin-game-order').value=[...document.querySelectorAll<HTMLSelectElement>('[data-game-priority]')].map(control=>control.value).join(',');
}
function swapPriorityOrder(changed:HTMLSelectElement):void{
  const controls=[...document.querySelectorAll<HTMLSelectElement>('[data-game-priority]')];
  const prior=el<HTMLInputElement>('admin-game-order').value.split(',');
  const index=controls.indexOf(changed),duplicate=prior.findIndex((game,position)=>game===changed.value&&position!==index);
  if(index>=0&&duplicate>=0&&prior[index])controls[duplicate]!.value=prior[index]!;
  syncPriorityOrder();
}
function renderPrioritySettings():void{
  const standalone=el<HTMLSelectElement>('admin-mode').value==='off';
  const fixedPriority=!standalone&&el<HTMLSelectElement>('admin-selection-policy').value==='fixed_priority';
  el('selection-policy-field').hidden=standalone;
  el('priority-order-field').hidden=false;
  el('game-order-label').textContent=standalone?'Standalone display order':fixedPriority?'Priority order':'Display order';
  el('game-order-help').textContent=standalone
    ? 'Choose the order of game cards on the standalone screen. The first three appear on page one.'
    : fixedPriority
      ? 'Choose which enabled game wins in priority selection. This also orders game cards.'
      : 'Choose the order of game cards on the home screen. Automatic selection also uses this order for rotation and ties.';
}
function numberField(id:string):number{return Number(el<HTMLInputElement>(id).value);}
function renderRuntimeSummary():void{
  const modeSelect=el<HTMLSelectElement>('admin-mode');
  const sms=el<HTMLInputElement>('admin-sms').checked,whatsapp=el<HTMLInputElement>('admin-whatsapp').checked,voice=el<HTMLInputElement>('admin-voice').checked;
  const smsNumber=deploymentChannelNumber('sms'),whatsappNumber=deploymentChannelNumber('whatsapp');
  const voiceNumbers=effectiveVoiceNumbers();
  const remoteReady=(sms&&Boolean(smsNumber))||(whatsapp&&Boolean(whatsappNumber));
  const voiceReady=Boolean(voiceNumbers['en-US']&&voiceNumbers['pt-BR']);
  const gamesReady=PLAYABLE_GAMES.some(game=>el<HTMLInputElement>(`admin-game-${game}`).checked);
  const entryReady=modeSelect.value==='lead_capture'||remoteReady;
  const status=modeSelect.value==='off'?(voice&&voiceReady&&gamesReady?'Standalone ready':'Needs setup'):voice&&voiceReady&&gamesReady&&entryReady?'Ready to open':'Needs setup';
  el('runtime-summary').textContent=status;
  el('settings-open-blocker').hidden=!(state.adminConfig?.arcade.mode!==modeSelect.value&&state.operatorStation&&state.operatorStation.station.phase!=='ATTRACT');
  el('voice-number-fields').hidden=!voice;
  el('lead-capture-summary').textContent=modeSelect.value==='lead_capture'
    ? 'Full lead capture is on for browser and messaging entry.'
    : modeSelect.value==='coin_only'
      ? 'Lead capture is off. Messaging entry collects first name only.'
      : 'Standalone play skips messaging entry and lead capture.';
  el('lead-capture-fields').textContent=modeSelect.value==='lead_capture'
    ? 'Browser entry collects first and last name, work email, company, phone number, country or region, terms acknowledgement when required, and optional marketing consent. Messaging entry uses the sender phone and asks for first and last name, work email, company, and country or region. It asks for terms only when required and never asks for marketing consent.'
    : modeSelect.value==='coin_only'
      ? 'First name is collected for the game display. No lead form is created; the messaging address and game activity are used to run the session.'
      : state.operatorStation&&state.operatorStation.station.phase!=='ATTRACT'
        ? 'Players can use standalone game lobbies now. The prior event queue remains preserved until you use Reset event flow.'
        : 'Players choose a game from the home screen, then scan that game lobby QR and call. No messaging registration is collected.';
  el('sms-status').textContent=capabilityStatus(sms,smsNumber);
  el('whatsapp-status').textContent=capabilityStatus(whatsapp,whatsappNumber);
  el('voice-number-status').textContent=voice
    ? voiceReady?'Ready':'Add both phone numbers'
    : 'Off';
  const postGame=state.adminConfig?.postGame;
  el('post-game-status').textContent=!postGame?.enabled
    ? postGame?.includeChallenges?'Zero-balance challenge prompts':'Off'
    : `${postGame.channels.map(channel=>channel==='sms'?'Text': 'WhatsApp').join(' + ')}${postGame.includeCoinBalance?' with coin balance':''}${postGame.includeChallenges?' + coin challenges':''}`;
  renderOperatorOverview();
}

function renderOperatorOverview():void{
  if(!operatorView)return;
  const config=state.adminConfig,station=state.operatorStation,messaging=state.adminStatus?.messaging,display=state.adminStatus?.display;
  const eventCard=el<HTMLAnchorElement>('overview-event-card');
  const standaloneNumbers=config?effectiveVoiceNumbers(config.channels.voiceNumbers['en-US']??'',config.channels.voiceNumbers['pt-BR']??''):null;
  const standaloneReady=Boolean(config?.channels.voice&&standaloneNumbers?.['en-US']&&standaloneNumbers['pt-BR']&&Object.values(config.station.games).some(game=>game.enabled));
  el('overview-event').textContent=!config?'Loading':config.arcade.mode==='off'?'Standalone':config.arcade.mode==='lead_capture'?'Lead capture':'Messaging entry';
  el('overview-event-detail').textContent=!config?'Checking settings':config.arcade.mode==='lead_capture'?'Full registration before play':config.arcade.mode==='coin_only'?'Text first, then call':'Choose a game, then call';
  eventCard.dataset.state=!config?'neutral':config.arcade.mode==='off'&&!standaloneReady?'attention':'active';

  const gameCard=el<HTMLAnchorElement>('overview-game-card'),phase=station?.station.phase,stationKnown=state.operatorStationEtag!==null;
  el('overview-game').textContent=!stationKnown?'Loading':!station?'Waiting for players':station.station.activeGame?gameName(station.station.activeGame):phaseName(station.station.phase);
  el('overview-game-detail').textContent=!stationKnown?'Checking live event':!station?'No active game flow':station.station.activeGame?phaseName(station.station.phase):'No game active';
  gameCard.dataset.state=phase&&['LOCKED','LAUNCHING','PLAYING','RESULTS'].includes(phase)?'active':'neutral';
  const actionButton=el<HTMLButtonElement>('overview-action-button');
  const paused=config?.arcade.mode==='off';
  const preservedFlow=paused&&Boolean(station&&phase!=='ATTRACT');
  const action=paused
    ?preservedFlow
      ?{title:'Standalone play is active',description:'Players can choose games directly. A previous event queue is preserved in the background until you reset it.',label:'Review previous queue',disabled:false}
      :{title:'Standalone play is active',description:'Players choose a game on the home screen, then scan its lobby QR and call to play by voice.',label:'Review standalone setup',disabled:false}
    :phase==='RECRUITING'
      ?{title:'Ready to choose the game?',description:'End joining now and move directly to player voting. New arrivals wait for the following game.',label:'Choose game now',disabled:false}
      :phase==='GAME_SELECTION'
        ?{title:'Confirm the next game',description:'Review player votes, select the game, and lock this group in.',label:'Confirm game',disabled:false}
        :phase==='LOCKED'
          ?{title:'Players are confirmed',description:'Start the selected game when the big screen and players are ready.',label:'Start game',disabled:false}
          :phase==='RESULTS'
            ?station?.resultsHeld
              ?{title:'Results are held',description:'The scoreboard will stay up until you continue.',label:'Continue now',disabled:false}
              :{title:'Results are on screen',description:`The next flow continues automatically after ${config?.station.timings.resultsSeconds??10} seconds. Hold it now if players need more time.`,label:'Hold results',disabled:false}
            :phase==='PLAYING'||phase==='LAUNCHING'
              ?{title:phase==='PLAYING'?'Game in progress':'Game is starting',description:'Open Live event to monitor players and recovery controls.',label:'View live game',disabled:false}
              :{title:'Waiting for the first player',description:'The start-now control appears here as soon as someone inserts a coin.',label:'Choose game after a player joins',disabled:true};
  el('overview-action-title').textContent=action.title;el('overview-action-description').textContent=action.description;
  actionButton.textContent=action.label;actionButton.disabled=action.disabled;actionButton.dataset.target=paused&&!preservedFlow?'setup':'live-event';
  actionButton.dataset.stationAction=!paused&&phase==='RESULTS'?(station?.resultsHeld?'advance':'hold'):'';

  const activeRoundIds=new Set([station?.station.activeRoundId,station?.station.nextRoundId].filter((id):id is string=>Boolean(id)));
  const playerCount=station?.readyEntries.filter(entry=>entry.status!=='LEFT'&&activeRoundIds.has(entry.roundId)).length??0;
  el('overview-players').textContent=String(playerCount);
  el('overview-players-detail').textContent=`${playerCount===1?'Player':'Players'} in the current flow`;
  el<HTMLAnchorElement>('overview-players-card').dataset.state=playerCount?'active':'neutral';

  const messagingKnown=state.adminStatus!==null;
  const messagingLabel=!messagingKnown?'Loading':messaging?.enabled?'Ready':messaging?.configured?'Needs setup':'Off';
  const failureCount=messaging?.counts.FAILED??0;
  el('overview-messaging').textContent=messagingLabel;
  el('overview-messaging-detail').textContent=!messagingKnown?'Checking delivery':failureCount?`${failureCount} message${failureCount===1?'':'s'} need attention`:'No delivery failures';
  el<HTMLAnchorElement>('overview-messaging-card').dataset.state=failureCount||messagingLabel==='Needs setup'?'attention':messaging?.enabled?'active':'neutral';

  const displayKnown=state.adminStatus!==null,displayCard=el('overview-display-card'),displayConnected=isDisplayConnected(display);
  el('overview-display').textContent=!displayKnown?'Loading':displayConnected?'Connected':display?.checking?'Checking':display?.configured?'Not connected':'Unavailable';
  el('overview-display-detail').textContent=!displayKnown?'Checking booth connection':displayConnected
    ? `Authorized booth tab responding · authorization has no timer${display?.lastSeenAt?` · ${formatTimestamp(display.lastSeenAt)}`:''}`
    : display?.checking?'Waiting briefly for an existing booth tab to check in'
    : display?.configured?'Connect the booth tab before players start':'Deployment setup is required';
  displayCard.dataset.state=displayConnected?'active':displayKnown&&!display?.checking?'attention':'neutral';
  const connectButton=el<HTMLButtonElement>('connect-booth-display');connectButton.hidden=displayKnown&&!display?.configured;
  el('display-connect-description').textContent=display?.configured
    ? 'Open a second tab or booth device, pair it once, and leave it open as the shared display.'
    : 'Big-screen security is not configured in this deployment. Ask a deployment administrator to configure ARCADE_DISPLAY_TOKEN before opening the event.';
  const pairingRequired=Boolean(config&&config.arcade.mode!=='off'&&display?.configured&&!displayConnected&&!display.checking);
  show('display-connect-panel',pairingRequired);
}

function openCurrentStationAction():void{
  const button=el<HTMLButtonElement>('overview-action-button'),target=button.dataset.target==='setup'?'setup':'live-event';
  if(button.dataset.stationAction==='hold'||button.dataset.stationAction==='advance'){void stationAction(button.dataset.stationAction);return;}
  activateOperatorTab(target,true,true);
  if(target==='setup')return;
  const phase=state.operatorStation?.station.phase;
  const control=phase==='RECRUITING'?'close-recruiting':phase==='GAME_SELECTION'?'select-station-game':phase==='LOCKED'?'request-launch':phase==='RESULTS'?'advance-results':phase==='PLAYING'?'emergency-complete':null;
  if(control)window.setTimeout(()=>el<HTMLButtonElement>(control).focus(),0);
}

function isDisplayConnected(display:AdminStatus['display']|undefined):boolean{
  return Boolean(display?.connected&&Date.now()<=displayPresenceExpiresAt);
}

function validPhoneNumber(value:unknown):string|null{
  if(typeof value!=='string')return null;const number=value.trim().replace(/^whatsapp:/i,'');return /^\+[1-9][0-9]{7,14}$/.test(number)?number:null;
}

function deploymentChannelNumber(channel:'sms'|'whatsapp'):string|null{
  return validPhoneNumber(channel==='sms'?state.deployment?.smsNumber:state.deployment?.whatsappNumber);
}

function effectiveVoiceNumbers(
  english=el<HTMLInputElement>('admin-voice-en-us').value.trim(),
  portuguese=el<HTMLInputElement>('admin-voice-pt-br').value.trim(),
):Record<'en-US'|'pt-BR',string|null>{
  if(english||portuguese)return{'en-US':validPhoneNumber(english),'pt-BR':validPhoneNumber(portuguese)};
  const deployed=state.deployment?.voiceNumbers;
  const deployedMapPresent=Boolean(deployed&&('en-US' in deployed||'pt-BR' in deployed));
  return{
    'en-US':validPhoneNumber(deployed?.['en-US']??(deployedMapPresent?null:state.deployment?.phoneNumber)),
    'pt-BR':validPhoneNumber(deployed?.['pt-BR']??(deployedMapPresent?null:state.deployment?.phoneNumber)),
  };
}

function capabilityStatus(enabled:boolean,number:string|null):string{
  if(!enabled)return'Off';
  return number?'Ready':'Add a phone number';
}

async function updateConfig(version:number,settings:Record<string,unknown>):Promise<AdminConfig>{
  return api<AdminConfig>('/api/admin/arcade/config',{method:'PATCH',headers:{'Content-Type':'application/json','If-Match':`"arcade-config-${version}"`,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(settings)});
}

const stationRoutes={
  close:'/api/admin/arcade/station/recruiting/close',
  select:'/api/admin/arcade/station/game/select',
  launch:'/api/admin/arcade/station/launch/request',
  fail:'/api/admin/arcade/station/launch/fail',
  complete:'/api/admin/arcade/station/match/complete',
  advance:'/api/admin/arcade/station/results/advance',
  hold:'/api/admin/arcade/station/results/hold',
  reset:'/api/admin/arcade/station/reset',
} as const;
type StationAction=keyof typeof stationRoutes;

async function refreshOperatorStation():Promise<void>{
  if(!state.adminConfig)return;
  const {payload,response}=await request<OperatorStationView|null>('/api/admin/arcade/station');
  applyOperatorStation(payload,response);
}

async function refreshTriviaAudioRecovery():Promise<void>{
  const view=state.operatorStation;
  const matchId=view?.station.phase==='PLAYING'&&view.match?.game==='trivia'
    ?view.station.activeMatchId:null;
  const generation=++triviaRecoveryRefreshGeneration;
  if(!matchId){state.triviaAudioRecovery=null;renderTriviaAudioRecovery();return;}
  try{
    const status=await api<TriviaAudioRecoveryStatus>(`/api/admin/arcade/trivia/audio-recovery?matchId=${encodeURIComponent(matchId)}`);
    if(generation!==triviaRecoveryRefreshGeneration||state.operatorStation?.station.activeMatchId!==matchId)return;
    state.triviaAudioRecovery=status.available?status:null;
  }catch{
    if(generation!==triviaRecoveryRefreshGeneration)return;
    state.triviaAudioRecovery=null;
  }
  renderTriviaAudioRecovery();
}

function renderTriviaAudioRecovery():void{
  const recovery=state.triviaAudioRecovery;
  const active=Boolean(recovery?.available&&recovery.matchId===state.operatorStation?.station.activeMatchId
    &&state.operatorStation?.station.phase==='PLAYING'&&state.operatorStation.match?.game==='trivia');
  show('trivia-audio-recovery',active);
}

async function retryTriviaAudio():Promise<void>{
  const recovery=state.triviaAudioRecovery;
  if(!recovery?.available||!recovery.matchId||!recovery.questionId||!recovery.questionAttemptId)return;
  const button=el<HTMLButtonElement>('retry-trivia-audio');
  button.disabled=true;
  try{
    await api('/api/admin/arcade/trivia/audio-recovery',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({matchId:recovery.matchId,questionId:recovery.questionId,
        questionAttemptId:recovery.questionAttemptId}),
    });
    state.triviaAudioRecovery=null;
    renderTriviaAudioRecovery();
    setNotice('Question audio is replaying. The answer clock will start after the call audio finishes.','success');
    await refreshOperatorStation();
  }catch(error){
    await refreshOperatorStation().catch(()=>undefined);
    showError(error);
  }finally{button.disabled=false;}
}

async function refreshOperatorPlayers(append=false,force=false):Promise<void>{
  if(!state.adminConfig)return;
  if(playerRecoveryRequest){
    if(!force)return;
    await playerRecoveryRequest;
    if(!state.adminConfig)return;
  }
  if(!append&&!force&&(state.operatorPlayers?.players.length??0)>100)return;
  const cursor=append?state.operatorPlayers?.nextCursor:null;
  if(append&&!cursor)return;
  const request=(async()=>{
    const path=`/api/admin/arcade/players?limit=100${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`;
    const page=await api<OperatorPlayerRecoveryPage>(path);
    state.operatorPlayers=append&&state.operatorPlayers
      ?{...page,players:[...state.operatorPlayers.players,...page.players]}
      :page;
    renderOperatorPlayers();
  })();
  playerRecoveryRequest=request;
  try{
    await request;
  }finally{if(playerRecoveryRequest===request)playerRecoveryRequest=null;}
}

function renderOperatorPlayers():void{
  const panel=el('player-recovery-panel'),host=el('player-recovery-list'),page=state.operatorPlayers;
  panel.hidden=false;host.replaceChildren();
  const players=page?.players??[];
  el('player-recovery-count').textContent=`${players.length} ${players.length===1?'player':'players'}`;
  if(!players.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No player records yet.';host.append(empty);}
  for(const player of players){
    const item=document.createElement('div');item.className='list-item player-recovery-item';
    const copy=document.createElement('div'),title=document.createElement('h4'),meta=document.createElement('div');
    title.textContent=player.displayName;meta.className='meta';
    const identities=player.identities.map(identity=>`${identity.channel==='sms'?'Text':identity.channel==='whatsapp'?'WhatsApp':'Browser'} · ${identity.maskedAddress}`).join(' · ');
    const identityLabel=identities||'No linked phone';
    meta.textContent=`${identityLabel} · ${player.availableBalance} coins · ${player.registrationState==='complete'?'Registration complete':'Sign-up in progress'} · Last activity ${formatTimestamp(player.lastActivityAt)}${player.lastReadyStatus?` · ${phaseName(player.lastReadyStatus)}`:''}`;
    copy.append(title,meta);
    const actions=document.createElement('div');actions.className='operator-actions';
    if(player.canRestoreStartingBalance){const restore=document.createElement('button');restore.type='button';restore.className='button primary';restore.textContent=`Restore to ${page?.startingBalance??0} coin${page?.startingBalance===1?'':'s'}`;restore.addEventListener('click',()=>void restorePlayerBalance(player,restore));actions.append(restore);}
    const reset=document.createElement('button');reset.type='button';reset.className='button danger';reset.textContent='Reset everything';reset.disabled=!player.canReset;reset.title=player.blockedReason??'Remove name, phone link, coins, sign-up progress, and Conversation Memory';reset.addEventListener('click',()=>void resetPlayerData(player,reset));actions.append(reset);
    item.append(copy,actions);host.append(item);
  }
  el<HTMLButtonElement>('load-more-players').hidden=!page?.nextCursor;
}

async function resetPlayerData(player:OperatorPlayerRecoveryItem,button:HTMLButtonElement):Promise<void>{
  if(!player.canReset)return;
  if(!window.confirm(`Reset everything for ${player.displayName}? Their name, identity, coins, sign-up progress, and Conversation Memory will be cleared. Their next JOIN starts from scratch.`))return;
  button.disabled=true;button.textContent='Resetting...';
  try{
    await api(`/api/admin/arcade/players/${encodeURIComponent(player.playerId)}/reset`,{
      method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({reason:`Operator reset ${player.displayName} from directory`}),
    });
    setNotice(`${player.displayName} was fully reset. Their next JOIN will ask for their name and create a fresh wallet.`,'success');
    await Promise.all([refreshOperatorPlayers(false,true),refreshOperatorStation()]);
  }catch(error){showError(error);}finally{button.disabled=false;button.textContent='Reset everything';}
}

async function restorePlayerBalance(player:OperatorPlayerRecoveryItem,button:HTMLButtonElement):Promise<void>{
  const page=state.operatorPlayers;if(!page)return;
  button.disabled=true;button.textContent='Restoring...';
  try{
    const result=await api<{restored:boolean;amountGranted:number;availableBalance:number}>(`/api/admin/arcade/players/${encodeURIComponent(player.playerId)}/restore-starting-balance`,{
      method:'POST',headers:{'Content-Type':'application/json','If-Match':`"arcade-config-${page.configVersion}"`,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({reason:'Operator restored configured starting balance'}),
    });
    setNotice(result.restored?`Restored ${player.displayName} to ${result.availableBalance} coin${result.availableBalance===1?'':'s'}.`:`${player.displayName} already has the configured starting balance.`,'success');
    await Promise.all([refreshOperatorPlayers(false,true),refreshOperatorStation()]);
  }catch(error){
    if(error instanceof ApiError&&error.status===412){await refreshAll(false);await refreshOperatorPlayers(false,true);}
    showError(error);
  }
  finally{button.disabled=false;button.textContent=`Restore to ${page.startingBalance} coin${page.startingBalance===1?'':'s'}`;}
}

function applyOperatorStation(view:OperatorStationView|null,response:Response):void{
  const etag=response.headers.get('ETag');
  if(!etag)throw new Error('Live event status is unavailable. Refresh and try again.');
  if(state.operatorStation&&(!view||view.station.revision<state.operatorStation.station.revision))return;
  state.operatorStation=view;state.operatorStationEtag=etag;renderOperatorStation();renderRuntimeSummary();
  void refreshTriviaAudioRecovery();
}

async function stationAction(action:StationAction,game?:PlayableGame):Promise<void>{
  if(stationActionSaving)return;
  const resetting=action==='reset';
  if(action==='select'&&(!game||!PLAYABLE_GAMES.includes(game))){setNotice('Select an enabled playable game.','error');return;}
  const reason=stationAuditReason(action,game);
  if(action==='fail'&&!window.confirm('Cancel this game start and return players to recruiting?'))return;
  if(action==='complete'&&!window.confirm('End the live game and disconnect all player calls now? Use this only if the game cannot finish normally.'))return;
  if(!state.operatorStationEtag){setNotice('Refresh the event before taking action.','error');return;}
  stationActionSaving=true;
  const form=el<HTMLFormElement>(resetting?'station-reset-form':'station-controls');setBusy(form,true);
  try{
    if(resetting&&pendingOpenSettings){
      const latest=await api<AdminConfig>('/api/admin/arcade/config');
      if(latest.version!==pendingOpenSettings.version){
        pendingOpenSettings=null;stationResetIdempotencyKey=null;stationResetEtag=null;el<HTMLDialogElement>('station-reset-dialog').close();setStationResetCopy(false);setModeFormDirty(false);
        try{await refreshOperatorConfiguration(true);}catch{setModeFormDirty(true);focusOperatorTab('setup');setNotice('Settings changed before reset confirmation, and the console could not reload them. The event flow was not reset; refresh before trying again.','error');return;}
        focusOperatorTab('setup');setNotice('Settings changed before the reset was confirmed. The event flow was not reset; review the latest settings and try again.','error');return;
      }
    }
    const body=action==='select'?{game,reason}:{reason};
    const {payload,response}=await request<OperatorStationView>(stationRoutes[action],{
      method:'POST',headers:{'Content-Type':'application/json','If-Match':resetting?(stationResetEtag??=state.operatorStationEtag):state.operatorStationEtag,'Idempotency-Key':resetting?(stationResetIdempotencyKey??=crypto.randomUUID()):crypto.randomUUID()},body:JSON.stringify(body),
    });
    applyOperatorStation(payload,response);
    if(resetting){
      const openSettings=pendingOpenSettings;pendingOpenSettings=null;
      stationResetIdempotencyKey=null;stationResetEtag=null;el<HTMLFormElement>('station-reset-form').reset();el<HTMLDialogElement>('station-reset-dialog').close();setStationResetCopy(false);
      if(openSettings){await saveOpenAfterReset(openSettings);return;}
    }
    setNotice(stationActionName(action),'success');
  }catch(error){
    if(error instanceof ApiError&&error.status===412){
      try{await refreshOperatorStation();}catch{/* Keep the conflict message as the actionable notice. */}
      if(resetting&&state.operatorStation?.station.phase==='ATTRACT'){
        const openSettings=pendingOpenSettings;pendingOpenSettings=null;stationResetIdempotencyKey=null;stationResetEtag=null;
        el<HTMLFormElement>('station-reset-form').reset();el<HTMLDialogElement>('station-reset-dialog').close();setStationResetCopy(false);
        if(openSettings){await saveOpenAfterReset(openSettings);return;}
        setNotice('Event flow reset.','success');return;
      }
      if(resetting){stationResetIdempotencyKey=crypto.randomUUID();stationResetEtag=state.operatorStationEtag;}
      setNotice('The event changed before this action finished. The latest status is loaded; review it and try again.','error');
    }else showError(error);
  }finally{stationActionSaving=false;setBusy(form,false);}
}

function stationAuditReason(action:StationAction,game?:PlayableGame):string{
  switch(action){
    case'close':return'Operator ended joining and opened voting';
    case'select':if(!game)throw new Error('A playable game is required for selection');return`Operator confirmed ${gameName(game)}`;
    case'launch':return'Operator requested game start';
    case'fail':return'Operator cancelled game start';
    case'complete':return'Operator ended game from console';
    case'advance':return'Operator closed results and continued';
    case'hold':return'Operator held results on screen';
    case'reset':return'Operator reset event flow';
  }
}

function stationActionName(action:StationAction):string{
  return ({close:'Joining ended.',select:'Next game confirmed.',launch:'Game start requested.',fail:'Game start cancelled.',complete:'Game ended.',advance:'Results closed and the event moved forward.',hold:'Results will stay on screen until you continue.',reset:'Event flow reset.'} as Record<StationAction,string>)[action];
}

function openStationReset(forOpening=false):void{
  if(state.operatorStation?.station.phase==='ATTRACT'||!state.operatorStationEtag)return;
  stationResetIdempotencyKey=crypto.randomUUID();
  stationResetEtag=state.operatorStationEtag;
  setStationResetCopy(forOpening);
  el<HTMLFormElement>('station-reset-form').reset();
  el<HTMLDialogElement>('station-reset-dialog').showModal();
  el<HTMLButtonElement>('confirm-station-reset').focus();
}

function cancelStationReset():void{
  if(stationActionSaving)return;
  const wasOpening=pendingOpenSettings!==null;pendingOpenSettings=null;
  stationResetIdempotencyKey=null;
  stationResetEtag=null;
  const dialog=el<HTMLDialogElement>('station-reset-dialog');if(dialog.open)dialog.close();
  setStationResetCopy(false);
  if(wasOpening){focusOperatorTab('setup');setNotice(`The current ${state.adminConfig?.arcade.mode==='off'?'Standalone play':'messaging event'} remains active. No settings were changed.`);}
}

function setStationResetCopy(forOpening:boolean):void{
  const standalone=forOpening&&pendingOpenSettings?.mode==='off';
  el('station-reset-title').textContent=forOpening?(standalone?'Reset the event queue and use Standalone play?':'Reset the previous queue and start the new event?'):'Reset the event flow?';
  el('station-reset-warning').textContent=forOpening
    ? `Resetting removes everyone from the current line, returns any coins in use, and then ${standalone?'switches to Standalone play':'starts the new player journey'}. This cannot be undone.`
    : 'This ends the current game, removes everyone from the line, and returns any coins in use. This cannot be undone.';
  el<HTMLButtonElement>('confirm-station-reset').textContent=forOpening?(standalone?'Reset queue and use Standalone':'Reset queue and start event'):'Reset event';
}

async function saveOpenAfterReset(openSettings:NonNullable<typeof pendingOpenSettings>):Promise<void>{
  let saved=false;
  try{
    await updateConfig(openSettings.version,openSettings.settings);saved=true;setModeFormDirty(false);
    if(!await refreshAll(false)){focusOperatorTab('setup');setNotice('The previous queue was reset and the new player journey was saved, but the console could not reload it. Refresh before making another change.','error');return;}
    focusOperatorTab('setup');
    if(state.adminConfig?.arcade.mode!==openSettings.mode)throw new Error('The new player journey could not be confirmed after resetting the previous queue.');
    setNotice(openSettings.mode==='off'?'Previous queue reset. Standalone play is active.':'Previous queue reset. The new messaging event is active.','success');
  }catch(error){
    focusOperatorTab('setup');
    if(error instanceof ApiError&&error.status===412){setModeFormDirty(false);await refreshOperatorConfiguration(true);setNotice('The event flow was reset, but settings changed in another operator session. Review the latest settings before opening.','error');return;}
    const detail=error instanceof ApiError?error.message:error instanceof Error?error.message:'Unknown error';
    setNotice(saved?`The previous queue was reset and the new player journey was saved, but the result could not be confirmed. Refresh before making another change. ${detail}`:`The previous queue was reset, but the new player journey was not saved. Review the draft and save again. ${detail}`,'error');
  }
}

function requestOperatorReason(
  title:string,
  description:string,
  includeAmount=false,
):Promise<{reason:string;amount:number|null}|null>{
  const dialog=el<HTMLDialogElement>('operator-reason-dialog');
  const form=el<HTMLFormElement>('operator-reason-form');
  const input=el<HTMLInputElement>('operator-reason-input');
  const amountField=el('operator-reason-amount-field');
  const amountInput=el<HTMLInputElement>('operator-reason-amount');
  el('operator-reason-title').textContent=title;
  el('operator-reason-description').textContent=description;
  amountField.hidden=!includeAmount;
  amountInput.required=includeAmount;
  amountInput.value='1';
  input.value='';
  dialog.showModal();
  input.focus();
  return new Promise(resolve=>{
    const finish=(value:{reason:string;amount:number|null}|null)=>{
      form.onsubmit=null;el<HTMLButtonElement>('cancel-operator-reason').onclick=null;dialog.oncancel=null;
      dialog.close();resolve(value);
    };
    form.onsubmit=event=>{event.preventDefault();const reason=input.value.trim();input.setCustomValidity(reason?'':'Add a short note.');if(!form.reportValidity())return;input.setCustomValidity('');finish({reason,amount:includeAmount?Number(amountInput.value):null});};
    el<HTMLButtonElement>('cancel-operator-reason').onclick=()=>finish(null);
    dialog.oncancel=event=>{event.preventDefault();finish(null);};
  });
}

function renderOperatorStation():void{
  const view=state.operatorStation,phase=view?.station.phase??'ATTRACT';
  el('station-phase').textContent=phaseName(phase);el('station-phase-value').textContent=phaseName(phase);
  el('station-revision').textContent=String(view?.station.revision??0);renderStationDeadline();
  renderStationFacts('station-round',view?.round?[['Status',phaseName(view.round.phase)],['Started',formatTimestamp(view.round.firstCoinAt)],['Votes',formatVoteCounts(view.voteCounts)],['Next game',view.round.selectedGame?gameName(view.round.selectedGame):'Not chosen'],['Last update',formatTimestamp(view.station.updatedAt)]]:[],'Waiting for the first player.');
  renderStationFacts('station-match',view?.match?[['Game',gameName(view.match.game)],['Status',phaseName(view.match.phase)],[phase==='RESULTS'?'Players completed':'Playing now',String(view.match.participantReadyEntryIds.length)],['Waiting next',String(view.match.overflowReadyEntryIds.length)],['Big screen',view.match.displayReadyAt?'Ready':'Connecting'],...(phase==='RESULTS'?[['Outcome',matchOutcome(view)] as [string,string]]:[])]:[],'No game is active.');
  renderStationRoster(view);renderStationAudit(view);renderStationControls(phase);renderOperatorOverview();
}

function renderStationAudit(view:OperatorStationView|null):void{
  const host=el('station-audit');host.replaceChildren();const events=view?.recentControls??[];
  if(!events.length){host.innerHTML='<div class="empty">No changes recorded yet.</div>';return;}
  for(const event of events){const item=document.createElement('div');item.className='ready-entry';const action=document.createElement('strong');action.textContent=controlActionName(event.action);const actor=document.createElement('span');actor.textContent=event.actorKind==='system'?'Automatic':event.actorSubject;const reason=document.createElement('time');reason.dateTime=event.occurredAt;reason.textContent=`${event.reason} · ${formatTimestamp(event.occurredAt)}`;item.append(action,actor,reason);host.append(item);}
}

function renderStationFacts(id:string,facts:Array<[string,string]>,emptyMessage:string):void{
  const host=el(id);host.replaceChildren();
  if(!facts.length){const empty=document.createElement('div');empty.className='empty';empty.textContent=emptyMessage;host.append(empty);return;}
  const list=document.createElement('dl');
  for(const [label,value] of facts){const item=document.createElement('div'),term=document.createElement('dt'),detail=document.createElement('dd');term.textContent=label;detail.textContent=value;item.append(term,detail);list.append(item);}
  host.append(list);
}

function matchOutcome(view:OperatorStationView):string{
  const result=view.match?.result;
  if(!result||result.source==='LEGACY_UNAVAILABLE')return'Outcome unavailable';
  if(result.source==='RECOVERY')return'Match interrupted; coins returned';
  if(!result.participants.length)return'No participant results';
  return result.participants.map(participant=>{
    const name=view.readyEntries.find(entry=>entry.id===participant.readyEntryId)?.displayName??'Player';
    const outcome=describeStationParticipantOutcome(view.match!.game,participant);
    return `${name}: ${outcome}${participant.score===null?'':`, score ${participant.score}`}`;
  }).join(' · ');
}

function formatVoteCounts(counts:OperatorStationView['voteCounts']):string{
  return counts.map(item=>`${gameName(item.game)} ${item.count}`).join(' · ');
}

function renderStationRoster(view:OperatorStationView|null):void{
  const host=el('station-ready');host.replaceChildren();
  const roundIds=new Set([view?.station.activeRoundId,view?.station.nextRoundId].filter((id):id is string=>Boolean(id)));
  const entries=view?.readyEntries.filter(entry=>roundIds.has(entry.roundId))??[];
  el('station-ready-heading').textContent=view?.station.phase==='RESULTS'?'Players and next game':'Players in line';
  el('station-ready-count').textContent=`${entries.length} ${entries.length===1?'player':'players'}`;
  if(!entries.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No players are in line yet.';host.append(empty);return;}
  for(const entry of entries){
    const item=document.createElement('div');item.className='ready-entry';
    const name=document.createElement('strong');name.textContent=entry.displayName;
    const status=document.createElement('span');status.textContent=`${entry.overflowOrdinal?`${phaseName(entry.status)} ${entry.overflowOrdinal}`:phaseName(entry.status)}${entry.connected?' · Connected':''} · ${entry.availableBalance} coin${entry.availableBalance===1?'':'s'}`;
    const time=document.createElement('time');time.dateTime=entry.originalReadyAt;time.textContent=`Joined ${formatTimestamp(entry.originalReadyAt)}`;
    const actions=document.createElement('div');actions.className='operator-actions';
    if(state.adminConfig?.coins.chargePolicy!=='free'&&entry.status!=='LEFT'){
      const grant=document.createElement('button');grant.type='button';grant.className='button quiet';grant.textContent='Add coins';grant.addEventListener('click',()=>void grantPlayerCoins(entry,grant));actions.append(grant);
    }
    if(state.adminConfig?.arcade.mode!=='off'&&entry.status==='ADMITTED'&&!entry.connected&&['LOCKED','LAUNCHING'].includes(view?.station.phase??'')&&((view?.match?.participantReadyEntryIds.length??0)>1||(view?.match?.overflowReadyEntryIds.length??0)>0)){
      const drop=document.createElement('button');drop.type='button';drop.className='button danger';drop.textContent='Remove no-show';drop.addEventListener('click',()=>void dropNoShow(entry));actions.append(drop);
    }
    if(state.adminConfig?.arcade.mode!=='off'&&!entry.connected&&['READY','OVERFLOW','COMPLETED'].includes(entry.status)){
      const reset=document.createElement('button');reset.type='button';reset.className='button danger';reset.textContent=resetPlayerLabel();reset.addEventListener('click',()=>void resetTestPlayer(entry,reset));actions.append(reset);
    }
    item.append(name,status,time,actions);host.append(item);
  }
}

async function dropNoShow(entry:OperatorStationView['readyEntries'][number]):Promise<void>{
  if(!state.operatorStationEtag)return;
  const hasOverflow=Boolean(state.operatorStation?.match?.overflowReadyEntryIds.length);
  const response=await requestOperatorReason('Remove no-show',hasOverflow?`Remove ${entry.displayName} and move the next waiting player into this game.`:`Remove ${entry.displayName} from this game. No waiting player is available to replace them.`);
  if(!response)return;
  try{
    const result=await request<OperatorStationView>(`/api/admin/arcade/station/ready/${encodeURIComponent(entry.id)}/drop`,{
      method:'POST',headers:{'Content-Type':'application/json','If-Match':state.operatorStationEtag,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({reason:response.reason}),
    });
    applyOperatorStation(result.payload,result.response);setNotice(`${entry.displayName} was removed. The next player was promoted when available.`,'success');
  }catch(error){if(error instanceof ApiError&&error.status===412)await refreshOperatorStation().catch(()=>undefined);showError(error);}
}

async function grantPlayerCoins(entry:OperatorStationView['readyEntries'][number],button:HTMLButtonElement):Promise<void>{
  const response=await requestOperatorReason('Add coins',`Add coins to ${entry.displayName}'s game pass.`,true);
  if(!response||response.amount===null)return;
  button.disabled=true;
  try{
    await post(`/api/admin/arcade/station/ready/${encodeURIComponent(entry.id)}/coins/grant`,{amount:response.amount,reason:response.reason});
    setNotice(`Added ${response.amount} coin${response.amount===1?'':'s'} to ${entry.displayName}.`,'success');
    await refreshOperatorStation();
  }catch(error){showError(error);}finally{button.disabled=false;}
}

async function resetTestPlayer(entry:OperatorStationView['readyEntries'][number],button:HTMLButtonElement):Promise<void>{
  if(!state.operatorStationEtag)return;
  const paid=state.adminConfig?.coins.chargePolicy!=='free';
  if(!window.confirm(`Reset ${entry.displayName}? Their name, phone link, ${paid?'coins, ':''}and Conversation Memory will be cleared. This cannot be undone.`))return;
  button.disabled=true;button.textContent='Resetting...';
  try{
    const result=await request<OperatorStationView>(`/api/admin/arcade/station/ready/${encodeURIComponent(entry.id)}/reset-test-player`,{
      method:'POST',headers:{'Content-Type':'application/json','If-Match':state.operatorStationEtag,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({reason:`Operator reset ${entry.displayName} from live roster`}),
    });
    applyOperatorStation(result.payload,result.response);setNotice(`${entry.displayName} was reset and removed from this roster. Their next completed JOIN setup creates a new ${paid?'wallet with the configured starting balance':'player profile'}.`,'success');
  }catch(error){if(error instanceof ApiError&&error.status===412)await refreshOperatorStation().catch(()=>undefined);showError(error);}
  finally{button.disabled=false;button.textContent=resetPlayerLabel();}
}

function resetPlayerLabel():string{return state.adminConfig?.coins.chargePolicy==='free'?'Reset test player':'Reset player + coins';}

function renderStationControls(phase:StationPhase):void{
  const paused=state.adminConfig?.arcade.mode==='off';
  show('recruiting-control',!paused&&phase==='RECRUITING');show('selection-control',!paused&&phase==='GAME_SELECTION');
  show('locked-control',!paused&&phase==='LOCKED');show('launch-failure-control',!paused&&(phase==='LOCKED'||phase==='LAUNCHING'));
  show('playing-control',!paused&&phase==='PLAYING');show('results-control',!paused&&phase==='RESULTS');
  el<HTMLButtonElement>('hold-results').hidden=state.operatorStation?.resultsHeld===true;
  const actionable=phase!=='ATTRACT';show('reset-control',actionable);
  const gameSelect=el<HTMLSelectElement>('station-game');
  for(const option of [...gameSelect.options])option.disabled=!state.adminConfig?.station.games[option.value as PlayableGame].enabled;
  if(gameSelect.selectedOptions[0]?.disabled)gameSelect.value=[...gameSelect.options].find(option=>!option.disabled)?.value??'';
  el('station-control-help').textContent=paused&&actionable?'Standalone play is active. This previous event queue is preserved until you reset it.':phase==='ATTRACT'?'Waiting for players. Actions appear when the event begins.':phase==='RECRUITING'?'Choose game now skips the remaining countdown. New arrivals wait for the following game.':phase==='LAUNCHING'?'The game is connecting to the big screen. Cancel only if it cannot start.':phase==='PLAYING'?'This ends the game immediately and disconnects its player calls.':phase==='RESULTS'?(state.operatorStation?.resultsHeld?'Results are held until you continue.':`Results continue automatically after ${state.adminConfig?.station.timings.resultsSeconds??10} seconds.`):'Only actions available right now are shown.';
}

function controlActionName(value:string):string{
  return ({CLOSE_STATION_RECRUITING:'Joining ended',SELECT_STATION_GAME:'Game chosen',REQUEST_STATION_LAUNCH:'Game start requested',MARK_STATION_DISPLAY_READY:'Big screen ready',START_STATION_MATCH:'Game started',COMPLETE_STATION_MATCH:'Game completed',ADVANCE_STATION_RESULTS:'Results closed',HOLD_STATION_RESULTS:'Results held',FAIL_STATION_LAUNCH:'Game start cancelled',RECOVER_STATION_RESTART:'Event recovered',RESET_STATION:'Event reset',RESET_TEST_PLAYER:'Test player reset'} as Record<string,string>)[value]??phaseName(value);
}

function stationDeadline(view=state.operatorStation):string|null{
  if(!view?.round)return null;
  if(view.station.phase==='RECRUITING'){
    const deadlines=[view.round.recruitingEndsAt,view.round.hardEndsAt].filter((value):value is string=>Boolean(value));
    return deadlines.sort((left,right)=>Date.parse(left)-Date.parse(right))[0]??null;
  }
  if(view.station.phase==='GAME_SELECTION')return view.round.selectionEndsAt;
  if(view.station.phase==='LOCKED')return view.round.lockedEndsAt;
  if(view.station.phase==='LAUNCHING'&&view.match?.launchRequestedAt)return new Date(Date.parse(view.match.launchRequestedAt)+(state.adminConfig?.station.timings.launchTimeoutSeconds??120)*1000).toISOString();
  if(view.station.phase==='RESULTS'&&!view.resultsHeld&&view.round.resultsAt)return new Date(Date.parse(view.round.resultsAt)+(state.adminConfig?.station.timings.resultsSeconds??10)*1000).toISOString();
  return null;
}

function renderStationDeadline():void{
  const output=el('station-deadline'),deadline=stationDeadline();
  if(state.adminConfig?.arcade.mode==='off'){output.textContent='Standalone';output.removeAttribute('title');return;}
  if(!deadline){output.textContent='None';output.removeAttribute('title');return;}
  const seconds=Math.ceil((Date.parse(deadline)-Date.now())/1000);output.title=formatTimestamp(deadline);
  if(seconds<=0){output.textContent=`Elapsed · ${formatTimestamp(deadline)}`;return;}
  const minutes=Math.floor(seconds/60),remainder=seconds%60;output.textContent=`${minutes}:${String(remainder).padStart(2,'0')} · ${formatTimestamp(deadline)}`;
}

function startOperatorUpdates():void{
  if(!state.adminConfig)return;
  if(operatorMessagingPoll===null)operatorMessagingPoll=window.setInterval(()=>void refreshOperatorStatus().catch(()=>undefined),5000);
  if(operatorEvents)return;
  if(typeof EventSource==='undefined'){startOperatorPolling();return;}
  setStationConnection('Connecting','neutral');
  const events=new EventSource('/api/arcade/events');operatorEvents=events;
  events.addEventListener('arcade_station_updated',event=>{
    try{JSON.parse((event as MessageEvent<string>).data);}catch{/* Refetch malformed notifications safely. */}
    void Promise.all([refreshOperatorStation(),refreshOperatorStatus(),refreshOperatorPlayers()]).catch(()=>setStationConnection('Refresh failed','error'));
  });
  events.addEventListener('arcade_config_updated',()=>{
    void refreshAll().catch(()=>setStationConnection('Config refresh failed','error'));
  });
  events.onopen=()=>{if(operatorPoll!==null){window.clearInterval(operatorPoll);operatorPoll=null;}setStationConnection('Live','active');};
  events.onerror=()=>{events.close();if(operatorEvents===events)operatorEvents=null;startOperatorPolling();};
}

function startOperatorPolling():void{
  setStationConnection('Polling','neutral');if(operatorPoll!==null)return;
  operatorPoll=window.setInterval(()=>void Promise.all([refreshOperatorStation(),refreshOperatorConfiguration(),refreshOperatorStatus()]).catch(()=>setStationConnection('Polling failed','error')),5000);
}

function stopOperatorUpdates():void{
  operatorEvents?.close();operatorEvents=null;if(operatorPoll!==null)window.clearInterval(operatorPoll);operatorPoll=null;
  if(operatorMessagingPoll!==null)window.clearInterval(operatorMessagingPoll);operatorMessagingPoll=null;
}

function setStationConnection(label:string,kind:'active'|'error'|'neutral'):void{
  const badge=el('station-connection');badge.textContent=label;badge.className=`badge ${kind}`;
}

async function refreshOperatorStatus():Promise<void>{
  if(!state.adminConfig)return;
  state.adminStatus=await api<AdminStatus>('/api/admin/arcade/status');
  displayPresenceExpiresAt=state.adminStatus.display.connected
    ? Date.now()+state.adminStatus.display.presenceTimeoutSeconds*1000
    : 0;
  renderMessagingStatus();
}

function renderMessagingStatus():void{
  const messaging=state.adminStatus?.messaging,badge=el('messaging-effective');
  badge.textContent=messaging?.enabled?'Ready':messaging?.configured?'Needs setup':'Off';
  badge.className=`badge ${messaging?.enabled?'active':messaging?.configured?'error':'neutral'}`;
  el('messaging-onboarding-sms').textContent=messaging?.onboarding.sms?'Ready':'Off';
  el('messaging-onboarding-whatsapp').textContent=messaging?.onboarding.whatsapp?'Ready':'Off';
  el('messaging-outbound-sms').textContent=messaging?.channels.sms?'Ready':'Off';
  el('messaging-outbound-whatsapp').textContent=messaging?.channels.whatsapp?'Ready':'Off';
  el('messaging-worker').textContent=messaging?.started?'Ready':'Off';
  el('messaging-last-error').textContent=messaging?.lastError??'None';
  el('messaging-identities').textContent=String(messaging?.storage?.messagingIdentities??0);
  el('messaging-capacity').textContent=String(messaging?.storage?.remainingIdentityCapacity??0);
  el('messaging-drafts').textContent=String(messaging?.storage?.drafts??0);
  el('messaging-cleanup').textContent=String(messaging?.storage?.cleanupEligible??0);
  const counts=el('messaging-counts');counts.replaceChildren();
  for(const status of ['PENDING','SENDING','RETRY_WAIT','ACCEPTED','DELIVERED','FAILED','EXPIRED','SUPPRESSED']){
    const item=document.createElement('div'),value=document.createElement('strong'),label=document.createElement('span');
    value.textContent=String(messaging?.counts[status]??0);label.textContent=phaseName(status);item.append(value,label);counts.append(item);
  }
  renderOperatorOverview();
  const failures=el('messaging-failure-list');failures.replaceChildren();
  if(!messaging?.recentFailures.length){const empty=document.createElement('div');empty.className='empty';empty.textContent='No messages need attention.';failures.append(empty);return;}
  for(const failure of messaging.recentFailures)failures.append(messagingFailureItem(failure));
}

async function refreshLeaderboardSummary():Promise<void>{
  try{
    const {payload,response}=await request<LeaderboardAdminSummary>('/api/admin/arcade/leaderboards');
    state.leaderboardSummary={games:PLAYABLE_GAMES.map(game=>payload.games.find(item=>item.game===game)??{game,resettable:false,maps:[]})};state.leaderboardEtag=response.headers.get('ETag');renderLeaderboardReset();
  }catch(error){
    state.leaderboardSummary=null;state.leaderboardEtag=null;
    el('leaderboard-reset-status').textContent=error instanceof ApiError?error.message:'Score controls are unavailable.';
    el<HTMLButtonElement>('leaderboard-reset-button').disabled=true;
  }
}

function renderLeaderboardReset():void{
  const game=el<HTMLSelectElement>('leaderboard-reset-game').value as PlayableGame;
  const mapSelect=el<HTMLSelectElement>('leaderboard-reset-map'),previousMap=mapSelect.value;
  const summary=state.leaderboardSummary?.games.find(item=>item.game===game);
  mapSelect.replaceChildren();
  for(const map of summary?.maps??[]){const option=document.createElement('option');option.value=map.map;option.textContent=`${map.label??map.map} (${map.records} record${map.records===1?'':'s'})`;mapSelect.append(option);}
  if(previousMap&&summary?.maps.some(item=>item.map===previousMap))mapSelect.value=previousMap;
  const selected=summary?.maps.find(item=>item.map===mapSelect.value);
  const reason=el<HTMLInputElement>('leaderboard-reset-reason').value.trim();
  const button=el<HTMLButtonElement>('leaderboard-reset-button');
  mapSelect.disabled=!summary?.resettable||!summary.maps.length;
  button.disabled=!summary?.resettable||!selected||selected.records===0||!reason||!state.leaderboardEtag;
  el('leaderboard-reset-status').textContent=!summary
    ? 'Score controls are loading.'
    : !summary.resettable
      ? `${gameName(game)} does not store persistent scores, so there is nothing to reset.`
      : selected
        ? `${selected.records} stored ${gameName(game)} result${selected.records===1?'':'s'} for ${selected.label??selected.map}. This cannot be undone.`
        : `No ${gameName(game)} leaderboard categories are available.`;
}

async function resetLeaderboard():Promise<void>{
  const game=el<HTMLSelectElement>('leaderboard-reset-game').value as PlayableGame;
  const map=el<HTMLSelectElement>('leaderboard-reset-map').value;
  const reason=el<HTMLInputElement>('leaderboard-reset-reason').value.trim();
  const summary=state.leaderboardSummary?.games.find(item=>item.game===game),selected=summary?.maps.find(item=>item.map===map);
  if(!summary?.resettable||!selected||!reason||!state.leaderboardEtag){renderLeaderboardReset();return;}
  if(!window.confirm(`Delete all ${selected.records} stored ${gameName(game)} result${selected.records===1?'':'s'} for ${selected.label??map}? This cannot be undone.`))return;
  const button=el<HTMLButtonElement>('leaderboard-reset-button');button.disabled=true;button.textContent='Resetting...';
  try{
    const result=await api<{deleted:number}>('/api/admin/arcade/leaderboards/reset',{method:'POST',headers:{'Content-Type':'application/json','If-Match':state.leaderboardEtag,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({game,map,reason})});
    el<HTMLInputElement>('leaderboard-reset-reason').value='';
    await refreshLeaderboardSummary();setNotice(`Deleted ${result.deleted} stored ${gameName(game)} result${result.deleted===1?'':'s'} from ${selected.label??map}.`,'success');
  }catch(error){
    if(error instanceof ApiError&&error.status===412)await refreshLeaderboardSummary();
    showError(error);
  }finally{button.textContent='Reset selected scores';renderLeaderboardReset();}
}

function messagingFailureItem(failure:MessagingFailedNotice):HTMLElement{
  const item=document.createElement('div');item.className='list-item messaging-failure-item';
  const copy=document.createElement('div'),title=document.createElement('h4'),meta=document.createElement('div'),detail=document.createElement('p');
  title.textContent=`${messageKindName(failure.kind)} · ${failure.channel==='sms'?'Text message':'WhatsApp'}`;
  meta.className='meta';meta.textContent=`Tried ${failure.attempts} of ${failure.maximumAttempts} times · ${formatTimestamp(failure.updatedAt)}`;
  detail.textContent=failure.lastErrorMessage??failure.terminalReason??'The message could not be delivered.';
  copy.append(title,meta,detail);
  const actions=document.createElement('div');actions.className='operator-actions';
  if(failure.retryEligible){const retry=document.createElement('button');retry.className='button secondary';retry.type='button';retry.textContent='Try again';retry.addEventListener('click',()=>void retryMessagingNotice(failure,retry));actions.append(retry);}
  else{const reason=document.createElement('span');reason.className='retry-ineligible';reason.textContent=retryReason(failure.retryIneligibleReason);actions.append(reason);}
  item.append(copy,actions);return item;
}

async function retryMessagingNotice(failure:MessagingFailedNotice,button:HTMLButtonElement):Promise<void>{
  const response=await requestOperatorReason('Try this message again',`Add a note explaining why “${messageKindName(failure.kind)}” should be retried.`);
  if(!response)return;const reason=response.reason;
  button.disabled=true;button.textContent='Retrying...';
  try{
    await api(`/api/admin/arcade/messaging/notifications/${encodeURIComponent(failure.notificationId)}/retry`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({reason})});
    setNotice('Message queued to try again.','success');await refreshOperatorStatus();
  }catch(error){showError(error);await refreshOperatorStatus().catch(()=>undefined);}
  finally{button.disabled=false;button.textContent='Try again';}
}

function retryReason(reason:string|null):string{
  return ({NOTIFICATION_EXPIRED:'Expired',ATTEMPTS_EXHAUSTED:'No attempts left',OUTBOUND_MESSAGING_DISABLED:'Delivery is off',ADMISSION_OBSOLETE:'Player assignment changed',OVERFLOW_OBSOLETE:'Player order changed',CALL_NOW_OBSOLETE:'Call window ended',RESULTS_OBSOLETE:'Results changed',NEXT_GAME_OBSOLETE:'Player order changed',CHANNEL_DISABLED:'Channel is off',VOICE_ROUTE_CHANGED:'Voice number changed',NOTICE_STATE_CHANGED:'Event changed'} as Record<string,string>)[reason??'']??'Cannot try again';
}

function messageKindName(kind:string):string{
  return ({STATION_ADMITTED:'Up next',STATION_OVERFLOW:'Waiting for next game',STATION_CALL_NOW:'Call now',STATION_RESULTS:'Game results',STATION_NEXT_GAME:'Next game'} as Record<string,string>)[kind]??phaseName(kind);
}

async function post<T=unknown>(path:string,body:unknown):Promise<T>{return api<T>(path,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':crypto.randomUUID()},body:JSON.stringify(body)});}
async function request<T=unknown>(path:string,init:RequestInit={}):Promise<{payload:T;response:Response}>{const headers=new Headers(init.headers);const response=await fetch(path,{credentials:'include',...init,headers});const payload=await response.json().catch(()=>({}));if(!response.ok){if(response.status===401&&operatorView&&path.startsWith('/api/admin/')){stopOperatorUpdates();location.replace('/analytics?auth=session_expired&returnTo=%2Foperator');}const error=(payload as {error?:{code?:string;message?:string}}).error;throw new ApiError(response.status,error?.code??'REQUEST_FAILED',error?.message??`Request failed (${response.status})`);}return{payload:payload as T,response};}
async function api<T=unknown>(path:string,init:RequestInit={}):Promise<T>{return(await request<T>(path,init)).payload;}
async function logoutOperator():Promise<void>{await fetch('/auth/logout',{method:'POST',credentials:'include'});location.replace('/analytics?returnTo=%2Foperator');}
async function refreshOperatorLogin():Promise<void>{try{const response=await fetch('/api/analytics/session',{credentials:'include'});const session=await response.json() as {authenticated?:boolean};show('operator-logout',session.authenticated===true);}catch{show('operator-logout',false);}}
async function maybe<T>(path:string):Promise<T|null>{try{return await api<T>(path);}catch(error){if(error instanceof ApiError&&[401,409].includes(error.status))return null;throw error;}}
function setNotice(message:string,kind:'success'|'error'|''=''):void{notice.className=`notice ${kind}`.trim();notice.setAttribute('role',kind==='error'?'alert':'status');notice.setAttribute('aria-live',kind==='error'?'assertive':'polite');notice.setAttribute('aria-atomic','true');notice.textContent=message;}
function showError(error:unknown):void{const playerErrors:Record<string,[string,string]>={INSUFFICIENT_COINS:['Earn another coin before joining.','Ganhe outra moeda antes de entrar.'],READY_POOL_FULL:['The line is full right now. Try again soon.','A fila está cheia agora. Tente novamente em breve.']};const safe=error instanceof ApiError?playerErrors[error.code]:undefined;const message=!operatorView
  ? safe?playerText(safe[0],safe[1]):playerPortuguese?'Não foi possível concluir. Tente novamente ou fale com o anfitrião.':'That did not work. Try again or ask the host for help.'
  : error instanceof ApiError?error.message:error instanceof Error?error.message:String(error);setNotice(message,'error');}
function setBusy(form:HTMLFormElement,busy:boolean):void{for(const control of form.elements)if(control instanceof HTMLButtonElement||control instanceof HTMLInputElement||control instanceof HTMLSelectElement)control.disabled=busy;}
function show(id:string,visible:boolean):void{el(id).hidden=!visible;}function toggleButton(id:string,visible:boolean):void{el<HTMLButtonElement>(id).hidden=!visible;}
function text(data:FormData,key:string):string{return String(data.get(key)??'').trim();}function gameName(game:string):string{return isPlayableArcadeGame(game)?gameTitle(resolvedLocale,game):game;}
function phaseName(value:string):string{return({ATTRACT:'Waiting for players',RECRUITING:'Players joining',GAME_SELECTION:'Choosing the next game',LOCKED:'Players confirmed',LAUNCHING:'Starting game',PLAYING:'Game in progress',RESULTS:'Showing results',READY:'In line',ADMITTED:'Up next',OVERFLOW:'Waiting for next game',COMPLETED:'Complete',LEFT:'Left',FAILED:'Needs attention'} as Record<string,string>)[value]??value.toLowerCase().replaceAll('_',' ').replace(/(^|\s)\S/g,letter=>letter.toUpperCase());}
function playerStateName(value:string):string{const english=({READY:"You're in line",ADMITTED:"You're up next",OVERFLOW:"You're in line for the following game",PLAYING:'Game in progress',COMPLETED:'Game complete',LEFT:'You left the line',ATTRACT:'Waiting for players',RECRUITING:'Waiting for more players',GAME_SELECTION:'Choosing the next game',LOCKED:'Get ready',LAUNCHING:'Game starting',RESULTS:'Game complete',WAITING:"You're in line",APPROACHING:'Stay close',CALLED:"It's almost your turn",CHECKED_IN:"You're checked in",ACTIVE_LOBBY:'Ready to start',DEFERRED:'Playing later',NO_SHOW:'Check in missed',LEFT_QUEUE:'You left the line',RELEASED:'Coin returned',ACTIVE:'Ready',REDEEMED:'Used'} as Record<string,string>)[value];if(!playerPortuguese)return english??value.replaceAll('_',' ');return({READY:'Você está na fila',ADMITTED:'Você é o próximo',OVERFLOW:'Você está na fila para o jogo seguinte',PLAYING:'Jogo em andamento',COMPLETED:'Jogo concluído',LEFT:'Você saiu da fila',ATTRACT:'Aguardando jogadores',RECRUITING:'Aguardando mais jogadores',GAME_SELECTION:'Escolhendo o próximo jogo',LOCKED:'Prepare-se',LAUNCHING:'Jogo começando',RESULTS:'Partida concluída',WAITING:'Você está na fila',APPROACHING:'Fique por perto',CALLED:'Quase sua vez',CHECKED_IN:'Entrada confirmada',ACTIVE_LOBBY:'Pronto para começar',DEFERRED:'Jogar depois',NO_SHOW:'Entrada perdida',LEFT_QUEUE:'Você saiu da fila',RELEASED:'Moeda devolvida',ACTIVE:'Pronta',REDEEMED:'Usada'} as Record<string,string>)[value]??value.replaceAll('_',' ');}
function formatTimestamp(value:string):string{const date=new Date(value);return Number.isNaN(date.getTime())?'Unknown':date.toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}
function escapeHtml(value:string):string{const node=document.createElement('span');node.textContent=value;return node.innerHTML;}
function el<T extends HTMLElement=HTMLElement>(id:string):T{return document.getElementById(id) as T;}
function storageGet(key:string):string|null{try{return localStorage.getItem(key);}catch{return null;}}
function applyTheme():void{wireThemeToggle(el('theme-toggle'),{light:playerText('Light theme','Tema claro'),dark:playerText('Dark theme','Tema escuro')});}
