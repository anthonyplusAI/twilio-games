import { TRIVIA_ROUND_CATEGORY_IDS, TRIVIA_ROUND_QUESTION_COUNT } from '../../shared/trivia';
import { TRIVIA_CATEGORY_LABELS } from '../../shared/i18n/trivia';
import type { SupportedLocale } from '../../shared/i18n/locales';
import type {
  TriviaPublicPlayer,
  TriviaResultPlayer,
  TriviaState,
} from '../../shared/trivia-protocol';
import { triviaCountdownCount, triviaQuestionTiming } from './trivia-client-utils';
import type { TriviaConnectionState } from './trivia-net';

export interface TriviaAnswerResultView {
  correct: boolean;
  points: number;
  rawScore: number;
}

export interface TriviaCallEntryView {
  number: string;
  qrCode: string | null;
  loading: boolean;
}

export interface TriviaViewContext {
  locale: SupportedLocale;
  roomCode: string;
  serverNowMs: number;
  connectionState: TriviaConnectionState;
  answerResults?: ReadonlyMap<string, TriviaAnswerResultView>;
  error?: string;
  pairingRequired?: boolean;
  canReplay?: boolean;
  stationMode?: boolean;
  callEntry?: TriviaCallEntryView;
}

export interface TriviaRenderedView {
  html: string;
  announcementKey: string;
  announcement: string;
}

const COPY = {
  'en-US': {
    app: 'Voice Trivia', eyebrow: 'Twilio quiz stage', tagline: 'Eight questions. Ten seconds. Answer out loud.',
    home: 'Home', homeLabel: 'Return to Twilio Games home', stageLabel: 'Voice Trivia quiz stage',
    theme: { light: 'Light theme', dark: 'Dark theme' },
    connecting: 'Opening the quiz stage', connectingBody: 'Connecting to the live Trivia room.',
    pairing: 'Display authorization needed', pairingBody: 'Launch this display from the Twilio Games station.',
    pairingAction: 'Return home', room: 'Room', players: 'Players', lobby: 'The stage is yours.',
    lobbyBody: 'Players join and answer from their phones. This screen never accepts answers.',
    callLabel: 'Join by phone', callTitle: 'Call to play', callInstructions: 'Scan to call, or tap the number below.',
    callQrAlt: 'Scan to call Voice Trivia', callNumberLabel: 'Call Voice Trivia at',
    callUnavailable: 'Call number unavailable. Ask the game host.',
    callQrPreparing: 'Preparing the call QR code. You can call the number below.',
    callQrUnavailable: 'QR code unavailable. Call the number below.',
    ready: 'Ready', confirming: 'Confirming name', reconnecting: 'Reconnecting', openSeat: 'Open seat', waiting: 'Waiting',
    category: 'Choose the category', categoryBody: 'Vote by voice. The live totals decide the round.', vote: 'vote', votes: 'votes',
    loading: 'Building the question deck', loadingBody: 'The display is checking fonts and stage readiness.',
    displayReady: 'Display ready', displayPreparing: 'Preparing display', countdown: 'Round starts in',
    question: 'Question', of: 'of', getReady: 'Get ready', promptBody: 'Phones are finishing the question prompt.',
    cueReady: 'Get ready to answer', cueBody: 'Phones are synchronizing the answer cue.',
    answerNow: 'Answer now', seconds: 'seconds', listening: 'Listening', locked: 'Answer locked',
    reveal: 'Answer reveal', correctAnswer: 'Correct answer', explanation: 'Why it is right',
    correct: 'Correct', incorrect: 'Incorrect', noAnswer: 'No answer', recorded: 'Answer recorded',
    score: 'Score', points: 'pts', bestStreak: 'Best streak', standings: 'Round standings',
    results: 'Final results', winner: 'Winner', winners: 'It is a tie', finalBoard: 'Final standings',
    correctCount: 'correct', normalized: 'Leaderboard score', replay: 'Play again', exit: 'Exit', connection: {
      connecting: 'Connecting', connected: 'Live', reconnecting: 'Reconnecting', closed: 'Disconnected',
    },
  },
  'pt-BR': {
    app: 'Quiz por Voz', eyebrow: 'Palco de quiz da Twilio', tagline: 'Oito perguntas. Dez segundos. Responda em voz alta.',
    home: 'Início', homeLabel: 'Voltar ao início do Twilio Games', stageLabel: 'Palco do Quiz por Voz',
    theme: { light: 'Tema claro', dark: 'Tema escuro' },
    connecting: 'Abrindo o palco do quiz', connectingBody: 'Conectando à sala ao vivo.',
    pairing: 'Autorização da tela necessária', pairingBody: 'Abra esta tela pela estação Twilio Games.',
    pairingAction: 'Voltar ao início', room: 'Sala', players: 'Jogadores', lobby: 'O palco é de vocês.',
    lobbyBody: 'Os jogadores entram e respondem pelo telefone. Esta tela nunca recebe respostas.',
    callLabel: 'Entre pelo telefone', callTitle: 'Ligue para jogar', callInstructions: 'Escaneie para ligar ou toque no número abaixo.',
    callQrAlt: 'Escaneie para ligar para o Quiz por Voz', callNumberLabel: 'Ligar para o Quiz por Voz no número',
    callUnavailable: 'Número para ligar indisponível. Peça ajuda à equipe do jogo.',
    callQrPreparing: 'Preparando o código QR. Você pode ligar para o número abaixo.',
    callQrUnavailable: 'Código QR indisponível. Ligue para o número abaixo.',
    ready: 'Pronto', confirming: 'Confirmando nome', reconnecting: 'Reconectando', openSeat: 'Lugar livre', waiting: 'Aguardando',
    category: 'Escolham a categoria', categoryBody: 'Votem por voz. Os totais ao vivo decidem a rodada.', vote: 'voto', votes: 'votos',
    loading: 'Montando as perguntas', loadingBody: 'A tela está verificando fontes e o palco.',
    displayReady: 'Tela pronta', displayPreparing: 'Preparando a tela', countdown: 'A rodada começa em',
    question: 'Pergunta', of: 'de', getReady: 'Preparem-se', promptBody: 'Os telefones estão terminando a pergunta.',
    cueReady: 'Preparem-se para responder', cueBody: 'Os telefones estão sincronizando o aviso de resposta.',
    answerNow: 'Respondam agora', seconds: 'segundos', listening: 'Escutando', locked: 'Resposta registrada',
    reveal: 'Revelação da resposta', correctAnswer: 'Resposta correta', explanation: 'Por que está certa',
    correct: 'Correto', incorrect: 'Incorreto', noAnswer: 'Sem resposta', recorded: 'Resposta recebida',
    score: 'Pontos', points: 'pts', bestStreak: 'Melhor sequência', standings: 'Classificação da rodada',
    results: 'Resultados finais', winner: 'Vencedor', winners: 'Empate', finalBoard: 'Classificação final',
    correctCount: 'acertos', normalized: 'Pontuação do ranking', replay: 'Jogar novamente', exit: 'Sair', connection: {
      connecting: 'Conectando', connected: 'Ao vivo', reconnecting: 'Reconectando', closed: 'Desconectado',
    },
  },
} as const;

export function triviaDisplayCopy(locale: SupportedLocale): typeof COPY[SupportedLocale] {
  return COPY[locale];
}

export function renderTriviaView(state: TriviaState | null, context: TriviaViewContext): TriviaRenderedView {
  const copy = COPY[context.locale];
  if (context.pairingRequired) {
    return rendered(
      `pairing:${context.roomCode}`,
      copy.pairing,
      panel('pairing', copy.eyebrow, copy.pairing, copy.pairingBody,
        `<a class="primary-action" href="/">${escapeHtml(copy.pairingAction)}</a>`),
      context.error,
    );
  }
  if (!state) {
    return rendered(
      `connection:${context.connectionState}`,
      copy.connecting,
      panel('connecting', copy.eyebrow, copy.connecting, copy.connectingBody, '<div class="signal-loader" aria-hidden="true"><i></i><i></i><i></i><i></i></div>'),
      context.error,
    );
  }

  let view: TriviaRenderedView;
  switch (state.phase) {
    case 'lobby': view = renderLobby(state, context); break;
    case 'category_select': view = renderCategories(state, context); break;
    case 'loading': view = renderLoading(state, context); break;
    case 'countdown': view = renderCountdown(state, context); break;
    case 'question_prompt': view = renderQuestion(state, context, 'prompt'); break;
    case 'answer_cue': view = renderQuestion(state, context, 'cue'); break;
    case 'question': view = renderQuestion(state, context, 'answering'); break;
    case 'reveal': view = renderReveal(state, context); break;
    case 'results': view = renderResults(state, context); break;
  }
  return context.error ? { ...view, html: `${view.html}${alertMarkup(context.error)}` } : view;
}

function renderLobby(state: TriviaState, context: TriviaViewContext): TriviaRenderedView {
  const copy = COPY[context.locale];
  const confirmed = state.players.filter(player => player.connected && player.nameConfirmed).length;
  const callEntry = !context.stationMode && context.callEntry
    ? renderCallEntry(context.callEntry, context.locale) : '';
  const html = `<section class="scene lobby-scene" data-view="lobby">
    <div class="hero-copy">${kicker(copy.eyebrow)}<h1>${escapeHtml(copy.lobby)}</h1><p>${escapeHtml(copy.lobbyBody)}</p>
      <div class="voice-banner"><span class="voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><strong>${escapeHtml(copy.tagline)}</strong></div>
      ${callEntry}
    </div>
    <section class="stage-card roster-card" aria-labelledby="roster-title"><header><div><span>${escapeHtml(copy.room)} ${escapeHtml(state.roomCode)}</span><h2 id="roster-title">${escapeHtml(copy.players)}</h2></div><strong>${state.players.length}/${state.expectedPlayerCount}</strong></header>${renderRoster(state, context.locale)}</section>
  </section>`;
  return rendered(`lobby:${state.players.map(player => `${player.playerId}:${player.connected}:${player.nameConfirmed}`).join('|')}`,
    `${confirmed} ${copy.ready}.`, html);
}

function renderCallEntry(entry: TriviaCallEntryView, locale: SupportedLocale): string {
  const copy = COPY[locale];
  const number = entry.number.trim();
  const qr = number && entry.qrCode
    ? `<div class="call-card-qr"><img src="${escapeHtml(entry.qrCode)}" alt="${escapeHtml(copy.callQrAlt)}"></div>` : '';
  const instruction = !number ? copy.callUnavailable
    : entry.loading ? copy.callQrPreparing
      : qr ? copy.callInstructions : copy.callQrUnavailable;
  return `<section class="call-card${qr ? '' : ' call-card-text-only'}" aria-labelledby="call-card-title">
    ${qr}<div class="call-card-content"><span>${escapeHtml(copy.callLabel)}</span><h2 id="call-card-title">${escapeHtml(copy.callTitle)}</h2>
    <p>${escapeHtml(instruction)}</p>${number
    ? `<a class="call-card-phone" href="tel:${escapeHtml(number)}" aria-label="${escapeHtml(copy.callNumberLabel)} ${escapeHtml(number)}">${escapeHtml(number)}</a>`
    : ''}</div>
  </section>`;
}

function renderCategories(state: TriviaState, context: TriviaViewContext): TriviaRenderedView {
  const copy = COPY[context.locale];
  const totalVotes = TRIVIA_ROUND_CATEGORY_IDS.reduce((total, category) => total + state.categoryVoteCounts[category], 0);
  const cards = TRIVIA_ROUND_CATEGORY_IDS.map((category, index) => {
    const votes = state.categoryVoteCounts[category];
    return `<li class="category-card${votes ? ' has-votes' : ''}"><span class="category-index" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span><strong>${escapeHtml(TRIVIA_CATEGORY_LABELS[context.locale][category])}</strong><span class="vote-count"><b>${votes}</b> ${escapeHtml(votes === 1 ? copy.vote : copy.votes)}</span><i style="--votes:${Math.min(4, votes)}" aria-hidden="true"></i></li>`;
  }).join('');
  const html = `<section class="scene category-scene" data-view="category_select">
    <header class="scene-heading">${kicker(copy.eyebrow)}<div><h1>${escapeHtml(copy.category)}</h1><p>${escapeHtml(copy.categoryBody)}</p></div><strong class="vote-total">${totalVotes}<small>${escapeHtml(copy.votes)}</small></strong></header>
    <ol class="category-grid" aria-label="${escapeHtml(copy.category)}">${cards}</ol>
  </section>`;
  return rendered(`category:${TRIVIA_ROUND_CATEGORY_IDS.map(category => state.categoryVoteCounts[category]).join(':')}`,
    `${totalVotes} ${totalVotes === 1 ? copy.vote : copy.votes}.`, html);
}

function renderLoading(state: TriviaState, context: TriviaViewContext): TriviaRenderedView {
  const copy = COPY[context.locale];
  const category = state.category ? TRIVIA_CATEGORY_LABELS[context.locale][state.category] : copy.category;
  const readiness = state.displayReady ? copy.displayReady : copy.displayPreparing;
  const html = `<section class="scene center-scene" data-view="loading">
    <div class="loading-emblem" aria-hidden="true"><span>?</span><i></i></div>${kicker(category)}<h1>${escapeHtml(copy.loading)}</h1><p>${escapeHtml(copy.loadingBody)}</p>
    <div class="deck-loader" role="status" aria-label="${escapeHtml(readiness)}"><i></i><i></i><i></i><i></i></div><strong class="readiness-label">${escapeHtml(readiness)}</strong>
    <div class="mini-roster">${state.players.map(player => playerPill(player, context.locale, false)).join('')}</div>
  </section>`;
  return rendered(`loading:${state.loadingGeneration}:${state.displayReady}`, readiness, html);
}

function renderCountdown(state: TriviaState, context: TriviaViewContext): TriviaRenderedView {
  const copy = COPY[context.locale];
  const count = state.countdownEndsAtMs === null ? 3 : triviaCountdownCount(state.countdownEndsAtMs, context.serverNowMs);
  const html = `<section class="scene countdown-scene" data-view="countdown"><span>${escapeHtml(copy.countdown)}</span><strong id="countdown-number">${count}</strong><div class="countdown-rings" aria-hidden="true"><i></i><i></i><i></i></div></section>`;
  return rendered(`countdown:${count}`, String(count), html);
}

function renderQuestion(
  state: Extract<TriviaState, { phase: 'question_prompt' | 'answer_cue' | 'question' }>,
  context: TriviaViewContext,
  stage: 'prompt' | 'cue' | 'answering',
): TriviaRenderedView {
  const copy = COPY[context.locale];
  const question = state.question;
  const answering = stage === 'answering';
  const timing = answering && state.answeringStartsAtMs !== null && state.questionEndsAtMs !== null
    ? triviaQuestionTiming(state.answeringStartsAtMs, state.questionEndsAtMs, context.serverNowMs)
    : null;
  const answered = state.players.filter(player => player.answered).length;
  const activelyAnswering = answering;
  const mode = activelyAnswering ? copy.answerNow : stage === 'cue' ? copy.cueReady : copy.getReady;
  const timer = timing
    ? `<div class="question-timer" aria-label="${escapeHtml(copy.answerNow)}"><strong id="question-seconds">${timing.remainingSeconds}</strong><span>${escapeHtml(copy.seconds)}</span><div class="timer-track" role="progressbar" aria-label="${escapeHtml(copy.answerNow)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(timing.progress * 100)}"><i id="timer-fill" style="width:${timing.progress * 100}%"></i></div></div>`
    : `<div class="prompt-status"><span class="voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span><strong>${escapeHtml(stage === 'cue' ? copy.cueBody : copy.promptBody)}</strong></div>`;
  const html = `<section class="scene question-scene" data-view="${state.phase}">
    <header class="question-header"><div><span>${escapeHtml(copy.question)} ${(state.questionIndex ?? 0) + 1} ${escapeHtml(copy.of)} ${TRIVIA_ROUND_QUESTION_COUNT}</span><strong>${escapeHtml(TRIVIA_CATEGORY_LABELS[context.locale][question.category])} · ${escapeHtml(difficultyLabel(question.difficulty, context.locale))}</strong></div><b>${escapeHtml(mode)}</b></header>
    <div class="question-layout"><article class="question-board"><h1>${escapeHtml(question.prompt)}</h1><ol class="choice-grid">${renderChoices(question.choices)}</ol>${timer}</article><aside class="answer-status" aria-label="${escapeHtml(copy.players)}">${state.players.map(player => playerPill(player, context.locale, activelyAnswering)).join('')}</aside></div>
  </section>`;
  const announcement = answering
    ? answered > 0 ? `${answered} of ${state.players.length} ${copy.locked}.` : `${copy.answerNow}. ${timing?.remainingSeconds ?? 10} ${copy.seconds}.`
    : stage === 'cue' ? `${copy.cueReady}. ${copy.cueBody}`
      : `${copy.question} ${(state.questionIndex ?? 0) + 1}. ${question.prompt}. ${question.choices.map((choice, index) => `${index + 1}. ${choice.text}`).join('. ')}`;
  return rendered(`${state.phase}:${question.id}:${stage}:${answered}`, announcement, html);
}

function renderReveal(state: Extract<TriviaState, { phase: 'reveal' }>, context: TriviaViewContext): TriviaRenderedView {
  const copy = COPY[context.locale];
  const correctIndex = state.question.choices.findIndex(choice => choice.id === state.reveal.correctChoiceId);
  const correctText = state.question.choices[correctIndex]?.text ?? '';
  const html = `<section class="scene reveal-scene" data-view="reveal">
    <header class="question-header reveal-header"><div><span>${escapeHtml(copy.reveal)}</span><strong>${escapeHtml(copy.question)} ${(state.questionIndex ?? 0) + 1} ${escapeHtml(copy.of)} ${TRIVIA_ROUND_QUESTION_COUNT}</strong></div><b>${escapeHtml(copy.correctAnswer)}</b></header>
    <div class="reveal-layout"><article class="question-board"><h1>${escapeHtml(state.question.prompt)}</h1><ol class="choice-grid reveal-choices">${renderChoices(state.question.choices, correctIndex)}</ol><div class="explanation"><span>${escapeHtml(copy.explanation)}</span><p>${escapeHtml(state.reveal.explanation)}</p></div></article>
    <section class="round-board" aria-labelledby="standings-title"><h2 id="standings-title">${escapeHtml(copy.standings)}</h2>${renderRevealStandings(state, context)}</section></div>
  </section>`;
  return rendered(`reveal:${state.question.id}`, `${copy.correctAnswer}: ${correctText}. ${state.reveal.explanation}`, html);
}

function renderResults(state: TriviaState, context: TriviaViewContext): TriviaRenderedView {
  const copy = COPY[context.locale];
  const players = state.result?.players ?? [];
  const bestRank = players.length ? Math.min(...players.map(player => player.rank)) : 1;
  const winners = players.filter(player => player.rank === bestRank);
  const winnerNames = winners.map(player => player.name).join(` ${context.locale === 'pt-BR' ? 'e' : 'and'} `);
  const winnerLabel = winners.length > 1 ? copy.winners : copy.winner;
  const rows = players.map(player => resultRow(player, context.locale, player.rank === bestRank)).join('');
  const category = state.result ? TRIVIA_CATEGORY_LABELS[context.locale][state.result.category] : copy.results;
  const actions = `<div class="results-actions">${context.canReplay
    ? `<button id="trivia-replay" class="primary-action" type="button">${escapeHtml(copy.replay)}</button>` : ''}<a id="trivia-exit" class="results-exit" href="/">${escapeHtml(copy.exit)}</a></div>`;
  const html = `<section class="scene results-scene" data-view="results">
    <div class="winner-panel">${kicker(category)}<span>${escapeHtml(winnerLabel)}</span><h1>${escapeHtml(winnerNames || copy.results)}</h1>${winners[0] ? `<strong>${formatScore(winners[0].normalizedScore, context.locale)}<small>${escapeHtml(copy.normalized)}</small></strong>` : ''}${actions}</div>
    <section class="final-board" aria-labelledby="final-board-title"><header><div><span>${escapeHtml(copy.results)}</span><h2 id="final-board-title">${escapeHtml(copy.finalBoard)}</h2></div><img src="/brand/Twilio_Logo_Bug_White.svg" alt=""></header><div class="final-rows">${rows}</div></section>
  </section>`;
  return rendered(`results:${state.result?.resultId ?? 'pending'}`, `${winnerLabel}: ${winnerNames}.`, html);
}

function renderRoster(state: TriviaState, locale: SupportedLocale): string {
  const copy = COPY[locale];
  const players = state.players.slice().sort((a, b) => a.playerOrder - b.playerOrder);
  return `<ol class="roster-list">${Array.from({ length: state.expectedPlayerCount }, (_, index) => {
    const player = players[index];
    if (!player) return `<li class="roster-player empty"><span>${index + 1}</span><div><strong>${escapeHtml(copy.openSeat)}</strong><small>${escapeHtml(copy.waiting)}</small></div><i aria-hidden="true"></i></li>`;
    const status = !player.connected ? copy.reconnecting : !player.nameConfirmed ? copy.confirming : copy.ready;
    return `<li class="roster-player${player.connected && player.nameConfirmed ? ' ready' : ''}"><span>${index + 1}</span><div><strong>${escapeHtml(player.name)}</strong><small>${escapeHtml(status)}</small></div><i aria-hidden="true"></i></li>`;
  }).join('')}</ol>`;
}

function playerPill(player: TriviaPublicPlayer, locale: SupportedLocale, answering: boolean): string {
  const copy = COPY[locale];
  const status = !player.connected ? copy.reconnecting : answering && player.answered ? copy.locked : answering ? copy.listening : copy.ready;
  return `<div class="player-pill${answering && player.answered ? ' locked' : ''}${!player.connected ? ' offline' : ''}"><span>${escapeHtml(player.name)}</span><strong>${escapeHtml(status)}</strong><i aria-hidden="true"></i></div>`;
}

function renderChoices(choices: readonly { id: string; text: string }[], correctIndex = -1): string {
  return choices.map((choice, index) => `<li${index === correctIndex ? ' class="correct-choice"' : ''}><span>${index + 1}</span><strong>${escapeHtml(choice.text)}</strong>${index === correctIndex ? '<i aria-hidden="true">&#10003;</i>' : ''}</li>`).join('');
}

function renderRevealStandings(state: Extract<TriviaState, { phase: 'reveal' }>, context: TriviaViewContext): string {
  const standings = state.standings ?? [];
  return standings.map(standing => {
    const copy = COPY[context.locale];
    const result = context.answerResults?.get(standing.playerId);
    const status = result ? (result.correct ? copy.correct : copy.incorrect) : standing.answered ? copy.recorded : copy.noAnswer;
    const resultClass = result ? (result.correct ? ' correct' : ' incorrect') : '';
    return `<div class="standing-row${resultClass}"><b>${standing.rank}</b><div><strong>${escapeHtml(standing.name)}</strong><small>${escapeHtml(status)}${result ? ` · ${result.points > 0 ? '+' : ''}${result.points} ${escapeHtml(copy.points)}` : ''}</small></div><span><strong>${formatScore(standing.rawScore, context.locale)}</strong><small>${escapeHtml(copy.bestStreak)} ${standing.bestStreak}</small></span></div>`;
  }).join('');
}

function resultRow(player: TriviaResultPlayer, locale: SupportedLocale, winner: boolean): string {
  const copy = COPY[locale];
  return `<div class="final-row${winner ? ' winner' : ''}"><b>${player.rank}</b><div><strong>${escapeHtml(player.name)}</strong><small>${player.correctCount}/${TRIVIA_ROUND_QUESTION_COUNT} ${escapeHtml(copy.correctCount)} · ${escapeHtml(copy.bestStreak)} ${player.bestStreak}</small></div><span><strong>${formatScore(player.normalizedScore, locale)}</strong><small>${formatScore(player.rawScore, locale)} ${escapeHtml(copy.points)}</small></span></div>`;
}

function panel(kind: string, eyebrow: string, title: string, body: string, extra: string): string {
  return `<section class="scene center-scene ${kind}-scene" data-view="${kind}">${kicker(eyebrow)}<h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${extra}</section>`;
}

function kicker(label: string): string {
  return `<div class="scene-kicker"><img src="/brand/Twilio_Logo_Bug_White.svg" alt=""><span>${escapeHtml(label)}</span></div>`;
}

function rendered(key: string, announcement: string, html: string, error?: string): TriviaRenderedView {
  return { announcementKey: key, announcement, html: `${html}${error ? alertMarkup(error) : ''}` };
}

function alertMarkup(message: string): string {
  return `<div class="stage-error" role="alert">${escapeHtml(message)}</div>`;
}

function difficultyLabel(difficulty: 'easy' | 'medium' | 'hard', locale: SupportedLocale): string {
  if (locale === 'pt-BR') return difficulty === 'easy' ? 'Fácil' : difficulty === 'medium' ? 'Médio' : 'Difícil';
  return difficulty[0]!.toUpperCase() + difficulty.slice(1);
}

function formatScore(score: number, locale: SupportedLocale): string { return new Intl.NumberFormat(locale).format(score); }

export function escapeTriviaHtml(value: string): string {
  return escapeHtml(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]!);
}
