import type { SupportedLocale } from '../../shared/i18n/locales';
import type { KaraokeSong } from '../../shared/karaoke';

export interface KaraokeCopy {
  appTitle: string;
  appKicker: string;
  tagline: string;
  nameTitle: string;
  nameLabel: string;
  namePlaceholder: string;
  join: string;
  stationTitle: string;
  stationBody: string;
  scan: string;
  phoneFallback: string;
  waiting: string;
  singerReady: string;
  chooseSongs: string;
  songTitle: string;
  songBody: string;
  selected: string;
  start: string;
  scoringDisclosure: string;
  phoneStart: string;
  loading: string;
  loadingBody: string;
  countdown: string;
  score: string;
  liveScore: string;
  combo: string;
  bestCombo: string;
  results: string;
  finalizing: string;
  finalizingBody: string;
  leaderboard: string;
  leaderboardLoading: string;
  noRecords: string;
  again: string;
  nextSinger: string;
  againByPhone: string;
  stationNextRound: string;
  exit: string;
  spectator: string;
  hostWaiting: string;
  connecting: string;
  connected: string;
  reconnecting: string;
  closed: string;
  retry: string;
  audioError: string;
  audioRecover: string;
  audioRecoverBody: string;
  keyboardGuide: string;
  guideMode: string;
  guideInstructions: string;
  outputLatency: string;
  visualOffset: string;
  visualOffsetHelp: string;
  lyricsEarlier: string;
  lyricsLater: string;
  resetOffset: string;
  lightTheme: string;
  darkTheme: string;
  home: string;
  displayAuthTitle: string;
  displayAuthBody: string;
  displayAuthAction: string;
}

const ENGLISH: KaraokeCopy = {
  appTitle: 'Voice Karaoke', appKicker: 'Live from the signal room',
  tagline: 'Give or confirm your name, choose a song by number or title, say Start or yes, then watch the display and sing each word when it reaches the target.',
  nameTitle: 'Step into the spotlight.', nameLabel: 'Stage name', namePlaceholder: 'Your name', join: 'Take the mic',
  stationTitle: 'The next singer joins by phone', stationBody: 'Give or confirm your name on the call.',
  scan: 'Call to join', phoneFallback: 'Voice line loading', waiting: 'Waiting for a singer', singerReady: 'Singer connected',
  chooseSongs: 'Choose a song', songTitle: 'Choose your song.', songBody: 'Choose by number or title, then say Start, yes, or continue.',
  selected: 'Selected', start: 'Start', scoringDisclosure: 'With scoring enabled, your live voice is sent to a third-party speech recognition service to score your song.', phoneStart: 'Say Start, yes, or continue on your phone to consent and begin. You can interrupt the host at any time.', loading: 'Sound check', loadingBody: 'Preparing your song.',
  countdown: 'GET READY', score: 'Score', liveScore: 'Confirmed so far', combo: 'Combo', bestCombo: 'Best combo', results: 'Final note',
  finalizing: 'Scoring your performance', finalizingBody: 'Holding the final note while we total your score.',
  leaderboard: 'All-time leaderboard', leaderboardLoading: 'Loading top scores', noRecords: 'No scores yet. You set the first one.',
  again: 'Sing another', nextSinger: 'Next singer', againByPhone: 'To sing again, ask the voice guide on your call.',
  stationNextRound: 'Want another turn? Rejoin the station queue on your phone.',
  exit: 'Exit to games', spectator: 'Watching the current singer', hostWaiting: 'Waiting for the display host',
  connecting: 'Connecting', connected: 'Live', reconnecting: 'Reconnecting', closed: 'Offline', retry: 'Retry sound check',
  audioError: 'The backing track could not be prepared.', audioRecover: 'Enable concert audio',
  audioRecoverBody: 'Your browser requires one click before concert audio can play. Enable it before calling.',
  keyboardGuide: 'Keys 1-4 match lanes. Hit each word as it reaches the target.',
  guideMode: 'Guide vocal mode',
  guideInstructions: 'Each tile should reach the target on the first consonant. If the tile arrives first, choose Later; if the voice arrives first, choose Earlier.',
  outputLatency: 'Device output', visualOffset: 'Visual delay',
  visualOffsetHelp: 'Positive visual delay means lyrics move later.',
  lyricsEarlier: 'Lyrics earlier', lyricsLater: 'Lyrics later', resetOffset: 'Reset',
  lightTheme: 'Light theme', darkTheme: 'Dark theme', home: 'Home',
  displayAuthTitle: 'Pair this display',
  displayAuthBody: 'Open the operator console in this tab and choose Pair this tab as the big screen. Then reopen Voice Karaoke.',
  displayAuthAction: 'Open operator console',
};

const PORTUGUESE: KaraokeCopy = {
  appTitle: 'Karaokê por Voz', appKicker: 'Ao vivo da sala de sinal',
  tagline: 'Diga ou confirme seu nome, escolha uma música pelo número ou título, diga Começar ou sim, depois olhe para a tela e cante cada palavra quando ela chegar ao alvo.',
  nameTitle: 'Entre no foco de luz.', nameLabel: 'Nome artístico', namePlaceholder: 'Seu nome', join: 'Pegar o microfone',
  stationTitle: 'O próximo cantor entra pelo telefone', stationBody: 'Diga ou confirme seu nome na ligação.',
  scan: 'Ligue para entrar', phoneFallback: 'Carregando linha de voz', waiting: 'Aguardando um cantor', singerReady: 'Cantor conectado',
  chooseSongs: 'Escolher música', songTitle: 'Escolha sua música.', songBody: 'Escolha pelo número ou título, depois diga Começar, sim ou continuar.',
  selected: 'Selecionada', start: 'Começar', scoringDisclosure: 'Com a pontuação ativada, sua voz ao vivo é enviada a um serviço terceirizado de reconhecimento de fala para avaliar sua música.', phoneStart: 'Diga Começar, sim ou continuar no telefone para consentir e iniciar. Pode interromper o apresentador a qualquer momento.', loading: 'Passagem de som', loadingBody: 'Preparando sua música.',
  countdown: 'PREPARE-SE', score: 'Pontos', liveScore: 'Confirmados até agora', combo: 'Sequência', bestCombo: 'Melhor sequência', results: 'Nota final',
  finalizing: 'Calculando sua apresentação', finalizingBody: 'Segurando a nota final enquanto calculamos sua pontuação.',
  leaderboard: 'Ranking de todos os tempos', leaderboardLoading: 'Carregando melhores pontuações', noRecords: 'Ainda não há pontuações. Faça a primeira.',
  again: 'Cantar outra', nextSinger: 'Próximo cantor', againByPhone: 'Para cantar de novo, peça ao guia de voz na ligação.',
  stationNextRound: 'Quer cantar de novo? Entre novamente na fila da estação pelo telefone.',
  exit: 'Sair para os jogos', spectator: 'Assistindo ao cantor atual', hostWaiting: 'Aguardando a tela principal',
  connecting: 'Conectando', connected: 'Ao vivo', reconnecting: 'Reconectando', closed: 'Desconectado', retry: 'Repetir passagem de som',
  audioError: 'Não foi possível preparar a faixa de apoio.', audioRecover: 'Ativar áudio do show',
  audioRecoverBody: 'O navegador exige um clique antes de tocar o áudio do show. Ative antes de ligar.',
  keyboardGuide: 'As teclas 1-4 correspondem às pistas. Acerte cada palavra no alvo.',
  guideMode: 'Modo com voz guia',
  guideInstructions: 'Cada bloco deve chegar ao alvo na primeira consoante. Se o bloco chegar primeiro, escolha Mais tarde; se a voz chegar primeiro, escolha Mais cedo.',
  outputLatency: 'Saída do dispositivo', visualOffset: 'Atraso visual',
  visualOffsetHelp: 'Atraso visual positivo move a letra para mais tarde.',
  lyricsEarlier: 'Letra mais cedo', lyricsLater: 'Letra mais tarde', resetOffset: 'Redefinir',
  lightTheme: 'Tema claro', darkTheme: 'Tema escuro', home: 'Início',
  displayAuthTitle: 'Conecte esta tela',
  displayAuthBody: 'Abra o console do operador nesta aba e escolha Conectar esta aba como tela principal. Depois, abra o Karaokê por Voz novamente.',
  displayAuthAction: 'Abrir console do operador',
};

export function karaokeCopy(locale: SupportedLocale): KaraokeCopy {
  return locale === 'pt-BR' ? PORTUGUESE : ENGLISH;
}

export function karaokeSongCredit(song: KaraokeSong): string {
  return song.artist;
}
