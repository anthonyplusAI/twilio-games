import type { SupportedLocale } from '../shared/i18n/locales';
import './result-tech.css';

export type ResultTechGame = 'racer' | 'monsters' | 'fighter' | 'karaoke' | 'trivia' | 'chess' | 'arcade';

interface ResultTechCopy {
  heading: string;
  genericHeading: string;
  routeLabel: string;
  karaokeRouteLabel: string;
  karaokeNodeTitle: string;
  karaokeNodeRelay: string;
  karaokeNodeStream: string;
  karaokeRulesTitle: string;
  karaokeRulesDetail: string;
  nodes: readonly [
    { title: string; detail: string },
    { title: string; detail: string },
    { title: string; detail: string },
    { title: string; detail: string },
  ];
  game: Record<ResultTechGame, string>;
  deeperHeading: string;
  deeperVoice: string;
  deeperState: string;
  karaokeVoice: string;
  karaokeAudio: string;
  guideLink: string;
  newTab: string;
}

const COPY: Record<SupportedLocale, ResultTechCopy> = {
  'en-US': {
    heading: 'How your voice moved this game',
    genericHeading: 'How a voice turn reaches the screen',
    routeLabel: 'From a phone call to the shared screen',
    karaokeRouteLabel: 'Song choice, singing, and result path',
    karaokeNodeTitle: 'Twilio voice paths',
    karaokeNodeRelay: 'Conversation Relay: menus + consent',
    karaokeNodeStream: 'Media Stream: singing',
    karaokeRulesTitle: 'Rules + scoring',
    karaokeRulesDetail: 'Checks choices + singing',
    nodes: [
      { title: 'Your phone', detail: 'You speak' },
      { title: 'Twilio Conversation Relay', detail: 'Transcribes + speaks' },
      { title: 'Game rules', detail: 'Validates the action' },
      { title: 'Shared screen', detail: 'Shows the result' },
    ],
    game: {
      racer: 'A racing command is checked against the live race before the car responds on the shared track.',
      monsters: 'A creature move is checked against the current turn and legal options before the battle updates.',
      fighter: 'An attack, block, or movement request is checked against the live fight before the arena updates.',
      karaoke: 'After consent, an authenticated Twilio Media Stream carries singing for timing and pitch, with Deepgram lyric recognition when available.',
      trivia: 'A spoken answer is tied to the current timed question, then the answer reveal and score update together.',
      chess: 'A move or castle request is checked for legality before the board changes.',
      arcade: 'A caller’s words travel through Conversation Relay. The game server checks the current state and updates the shared screen.',
    },
    deeperHeading: 'Behind the turn',
    deeperVoice: 'Conversation Relay carries your speech to the game and speaks its reply. You can interrupt the guide during menus and explanations.',
    deeperState: 'The server uses the current game state to interpret your request, checks it against the rules, and sends the updated room state to the browser over a live WebSocket.',
    karaokeVoice: 'Conversation Relay handles song choice and consent. You can interrupt the voice guide instead of waiting for its full explanation.',
    karaokeAudio: 'After you explicitly start, an authenticated inbound-only Twilio Media Stream delivers your singing audio. The server measures timing and pitch; Deepgram recognizes lyrics when available. Conversation Relay returns for the result.',
    guideLink: 'Explore the full How it’s made guide',
    newTab: 'Opens in a new tab',
  },
  'pt-BR': {
    heading: 'Como sua voz moveu este jogo',
    genericHeading: 'Como a voz chega à tela',
    routeLabel: 'Da ligação à tela compartilhada',
    karaokeRouteLabel: 'Caminho da escolha, do canto e do resultado',
    karaokeNodeTitle: 'Voz na Twilio',
    karaokeNodeRelay: 'Conversation Relay: menus e consentimento',
    karaokeNodeStream: 'Media Stream: canto',
    karaokeRulesTitle: 'Regras + pontuação',
    karaokeRulesDetail: 'Confere escolhas + canto',
    nodes: [
      { title: 'Seu telefone', detail: 'Você fala' },
      { title: 'Twilio Conversation Relay', detail: 'Transcreve + fala' },
      { title: 'Regras do jogo', detail: 'Valida a ação' },
      { title: 'Tela compartilhada', detail: 'Mostra o resultado' },
    ],
    game: {
      racer: 'Um comando da corrida é conferido com a partida ao vivo antes de o carro reagir na pista compartilhada.',
      monsters: 'O golpe da criatura é conferido com o turno atual e as opções permitidas antes de a batalha mudar.',
      fighter: 'Um pedido de ataque, bloqueio ou movimento é conferido com a luta ao vivo antes de a arena mudar.',
      karaoke: 'Após consentir, um Twilio Media Stream autenticado leva o canto para medir tempo e afinação, com reconhecimento da letra pela Deepgram quando disponível.',
      trivia: 'Sua resposta é ligada à pergunta com tempo marcado; depois, a revelação da resposta e a pontuação mudam juntas.',
      chess: 'Sua jogada ou pedido de roque é conferido com as regras antes de o tabuleiro mudar.',
      arcade: 'A fala chega pelo Conversation Relay. O servidor confere o estado atual do jogo e atualiza a tela compartilhada.',
    },
    deeperHeading: 'Por trás da jogada',
    deeperVoice: 'O Conversation Relay leva sua fala ao jogo e reproduz a resposta. Você pode interromper o guia durante menus e explicações.',
    deeperState: 'O servidor usa o estado atual do jogo para interpretar o pedido, confere as regras e envia o novo estado da partida ao navegador por uma conexão WebSocket ao vivo.',
    karaokeVoice: 'O Conversation Relay ajuda a escolher a música e pede consentimento. Você pode interromper o guia de voz sem esperar a explicação inteira.',
    karaokeAudio: 'Depois que você pede para começar, um Twilio Media Stream autenticado, apenas com o áudio de entrada, leva seu canto ao servidor. O servidor mede tempo e afinação; a Deepgram reconhece a letra quando disponível. O Conversation Relay volta para anunciar o resultado.',
    guideLink: 'Conheça o guia completo de como foi feito',
    newTab: 'Abre em uma nova aba',
  },
};

/** Static, PII-free technology story for a game result surface. */
export function resultTechHtml(
  game: ResultTechGame,
  locale: SupportedLocale,
  options: { stationManaged?: boolean } = {},
): string {
  const safeLocale: SupportedLocale = locale === 'pt-BR' ? 'pt-BR' : 'en-US';
  const copy = COPY[safeLocale];
  const safeGame: ResultTechGame = Object.hasOwn(copy.game, game) ? game : 'arcade';
  const stationManaged = options.stationManaged === true;
  const heading = safeGame === 'arcade' ? copy.genericHeading : copy.heading;
  const routeLabel = safeGame === 'karaoke' ? copy.karaokeRouteLabel : copy.routeLabel;
  const nodes = copy.nodes.map((node, index) => {
    const karaokePath = safeGame === 'karaoke' && index === 1;
    const karaokeRules = safeGame === 'karaoke' && index === 2;
    return `
      <li class="result-tech__node${karaokePath ? ' result-tech__node--voice-paths' : ''}">
        <span class="result-tech__step" aria-hidden="true">${index + 1}</span>
        <strong>${karaokePath ? copy.karaokeNodeTitle : karaokeRules ? copy.karaokeRulesTitle : node.title}</strong>
        <small>${karaokePath ? copy.karaokeNodeRelay : karaokeRules ? copy.karaokeRulesDetail : node.detail}</small>${karaokePath ? `
        <small>${copy.karaokeNodeStream}</small>` : ''}
      </li>`;
  }).join('');
  const deeperVoice = safeGame === 'karaoke' ? copy.karaokeVoice : copy.deeperVoice;
  const deeperState = safeGame === 'karaoke' ? copy.karaokeAudio : copy.deeperState;

  return `
    <section class="result-tech${stationManaged ? ' result-tech--station' : ''}" aria-label="${heading}">
      <div class="result-tech__compact">
        <h2>${heading}</h2>
        <ol class="result-tech__route" role="list" aria-label="${routeLabel}">${nodes}
        </ol>
        <p class="result-tech__example">${copy.game[safeGame]}</p>
      </div>${stationManaged ? '' : `
      <div class="result-tech__more">
        <h3>${copy.deeperHeading}</h3>
        <div class="result-tech__more-grid">
          <p>${deeperVoice}</p>
          <p>${deeperState}</p>
        </div>
        <a href="/how-it-works.html?locale=${safeLocale}" target="_blank" rel="noopener noreferrer">${copy.guideLink}<span aria-hidden="true"> ↗</span><span class="result-tech__visually-hidden"> (${copy.newTab})</span></a>
      </div>`}
    </section>`;
}
