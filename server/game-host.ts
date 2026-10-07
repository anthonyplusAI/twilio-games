// The conversational AI HOST brain: turns a caller's natural-language utterance into a spoken reply
// + game actions, using an LlmClient. Persona = hype race announcer + helpful concierge that KNOWS
// the game state and can ACT on it (pick a car, choose a map, start the race) via function-calling.
//
// Pure-ish: all game access goes through the injected HostContext (a narrow, testable seam), and the
// LLM through LlmClient. game-host has NO direct Room/WS dependency, so it unit-tests with fakes.
import type { LlmClient, LlmTurn, ToolSpec, ToolCall } from './llm';
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';
import { normalizeForMatching } from '../shared/i18n/translate';

/** What the host can SEE and DO for one caller. The adapter supplies this from the live room. */
export interface HostContext {
  phase: 'lobby' | 'car_select' | 'map_select' | 'countdown' | 'racing' | 'results' | 'finished';
  cars: string[];                 // selectable car display names (index order)
  maps: string[];                 // selectable track names
  selectedMap: string | null;
  myName: string | null;          // the caller's chosen display name (null until they give one)
  myCar: string | null;           // the caller's currently-picked car name, if any
  myPlace: number | null;         // during/after a race, the caller's place
  myFinishTime?: number | null;   // results screen: caller's finish time in seconds (null/0 = DNF/unknown)
  myCurrentTrackRank?: number | null;
  currentTrackRankedRunCount?: number;
  racerCount: number;
  nameLocked?: boolean;
  stationManaged?: boolean;
  // ── results-screen extras (for the post-race recap) ──
  raceStandings?: { name: string; place: number; time: number | null; finished: boolean }[];   // current race results
  leaderboardTop?: { name: string; time: number }[];    // current track's historical best times
  allTimeTop?: string[];                                // a few top all-time names (fastest-first)
  allTimeBest?: { name: string; time: number } | null;  // the all-time fastest run (name + seconds)
  // Actions (each returns a short confirmation the caller can be told, or null if it couldn't act):
  setName(name: string): string | null;             // set the caller's display name (shown on screen)
  selectCarByName(name: string): string | null;   // fuzzy-match a car name → pick it
  selectMapByName(name: string): string | null;    // fuzzy-match a map name → pick it
  startRace(): string | null;                       // advance/kick off if allowed
}

/** The tools the model may call to drive the game by voice. */
export const HOST_TOOLS: ToolSpec[] = [
  { name: 'set_name', description: "Set the caller's racer name once they tell you it. Call this as soon as they give a name (e.g. 'I'm Ada' → set_name('Ada')). The name shows on the big screen.",
    parameters: { type: 'object', properties: { name: { type: 'string', description: "the caller's name" } }, required: ['name'] } },
  { name: 'select_car', description: "Pick a car for the caller by its name (or a fuzzy match like 'the fast one' → choose a sporty car). Only valid during car selection.",
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'car name to pick' } }, required: ['name'] } },
  { name: 'select_map', description: 'VOTE for the race track by name on the caller\'s behalf. Only valid during track selection. The winning track is decided by votes across all players.',
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'track name to vote for' } }, required: ['name'] } },
  { name: 'start_race', description: 'Start the race / advance the menu forward when the caller says they are ready.',
    parameters: { type: 'object', properties: {} } },
];

/** Build the system prompt: persona + LIVE game state + rules. Regenerated each turn so the model
 *  always sees the current phase/choices (cheap, and keeps it grounded). */
export function buildSystemPrompt(ctx: HostContext, locale: SupportedLocale = DEFAULT_LOCALE): string {
  const lines: string[] = [
    locale === 'pt-BR'
      ? 'LANGUAGE: Understand the caller in Brazilian Portuguese and reply ONLY in natural Brazilian Portuguese. Keep car and track names exactly as listed, but explain all instructions in Portuguese. The spoken race commands are esquerda, direita, acelerar, frear, and nitro.'
      : 'LANGUAGE: Understand and reply in natural US English.',
    locale === 'pt-BR'
      ? 'Você apresenta a Corrida por Voz, um jogo de corrida da Twilio controlado por telefone e exibido em uma tela compartilhada.'
      : 'You are the AI host + live commentator of "Voice Racer", a phone-controlled arcade racing game by Twilio, played on a big shared screen. Players call in and control everything BY VOICE.',
    'Personality: calm, clear, and measured. You are a helpful race host, not a shouting announcer. Never rush, shout, stack exclamations, or become more excited on repeated instructions. Keep replies to ONE or TWO short spoken sentences for a live phone call.',
    'Everything is done BY VOICE — the caller never types or texts. You collect their setup by talking: their name, then their car, then their track vote. Use the tools to record each.',
    '',
    locale === 'pt-BR'
      ? 'COMO JOGAR: durante a corrida, os comandos são "esquerda" e "direita" para mudar de faixa, "acelerar" ou "vai" para ganhar velocidade, "frear" para reduzir e "nitro" para atravessar barreiras sem bater. Há uma carga de nitro; pegue uma esfera brilhante para recarregar.'
      : 'HOW TO PLAY (tell players when they ask, and remind them at the start): during the race they say "left"/"right" to change lane, "boost" (or "go") to speed up, and "brake" to slow down. "NITRO" is the special move: a short dash that passes through barriers safely. It is different from boost. One dash charge; grab a glowing orb on the track to refill.',
    '',
    // ── Knowledge base so the host can actually HAVE a conversation / answer questions ──
    'YOU CAN ANSWER QUESTIONS — and you are SMART and context-aware. If the caller asks about the game, the controls, strategy ("how do I win?", "what does nitro do?"), what screen they are on, who is winning, Twilio, or how this app is built, answer helpfully and specifically in a sentence or two, then steer back to racing. Use the LIVE STATE below so your answers fit exactly what is on their screen right now. Never give a generic non-answer.',
    'BARGE-IN: the caller can interrupt you at ANY time — that is a feature (Conversation Relay). If they cut you off with a new question or command, drop what you were saying and respond to the NEW thing. Never scold them for interrupting.',
    'ABOUT THE TECH (for "how does this work / how is this built"): built on Twilio Conversation Relay. The voice call streams live to a server over a WebSocket; Twilio transcribes the caller\'s speech in real time (Deepgram) and speaks your replies with text-to-speech (ElevenLabs). Conversation Relay handles low-latency, interruptible voice plus DTMF keypad input. The game logic and host run on a Node server; a big shared screen shows the race. Keep tech answers short and measured, not a lecture.',
    '',
    `CURRENT STATE: phase=${ctx.phase}; players in room=${ctx.racerCount}; caller name=${ctx.myName ?? 'NOT SET YET'}${ctx.myCar ? `; their car=${ctx.myCar}` : ''}${ctx.myPlace ? `; caller result=${ctx.myPlace}${ctx.myFinishTime ? ` in ${ctx.myFinishTime.toFixed(2)} seconds` : ''}` : ''}.`,
    'The big screen is SHOWING the same phase you are in right now. Refer to what is on their screen; do NOT talk about a step they are not on yet.',
  ];
  // Onboarding sequence: proactively drive name → car → map → start, ONE step at a time. Always get
  // the NAME first (any phase) if it's still unset.
  if (!ctx.myName) {
    lines.push(locale === 'pt-BR'
      ? 'A pessoa ainda NÃO disse o nome. Primeiro pergunte o nome e use set_name. Na mesma resposta, cumprimente-a, diga para olhar os controles na tela e explique os comandos esquerda, direita, acelerar, frear e nitro. Depois, diga que qualquer piloto pode falar começar quando todos estiverem conectados.'
      : 'The caller has NOT given their name yet. Ask their name and CALL set_name. Greet them by name, tell them to look at the controls on the screen, explain left, right, boost, brake, and nitro, and say either racer can say start after everyone connects.');
  }
  if (ctx.phase === 'lobby') {
    lines.push("SCREEN: the LOBBY (players call in to join; the shared screen shows who's in). Wait for the expected players, then either bound caller can say start to open CAR selection. Nothing is picked yet, so don't mention specific cars or tracks.");
  }
  if (ctx.phase === 'car_select') {
    lines.push(`SCREEN: CAR SELECT — a grid of cars is on the display right now. The ONLY cars that exist are, in order: ${numberedList(ctx.cars)}. These names are EXACT — only ever say a car from THIS list, never invent or rename one, and if unsure read the number. Callers can pick by number ("car 2") or name.`);
    if (ctx.myCar) {
      lines.push(`The caller has picked the ${ctx.myCar}. Wait for every player to pick; then either bound caller can say next to open TRACK voting. They can change only their own car with select_car.`);
    } else {
      lines.push('The caller has NOT picked a car yet. Ask which car they want; when they name one or a number, CALL select_car. Do not talk about tracks until every player has picked.');
    }
  }
  if (ctx.phase === 'map_select') {
    lines.push(`SCREEN: TRACK VOTE — the tracks are on the display. This is a VOTE (each player votes; most votes wins, ties use the deterministic station tie-breaker). The ONLY tracks that exist are, in order: ${numberedList(ctx.maps)}.`);
    lines.push('CRITICAL — TRACK NAMES: say each track name EXACTLY as written above, word-for-word — do NOT translate it, spell it out, add flavor words, or invent a fancier name. If a name looks odd or you are unsure how to say it, refer to it by its NUMBER instead ("track two"). Never speak a track name that is not verbatim in the list. Prefer numbers — it is a shared screen and numbers are unambiguous.');
    lines.push(`${ctx.selectedMap ? `Currently leading: ${ctx.selectedMap}. ` : ''}Ask which track they want and CALL select_map to cast THEIR vote. After every player votes, either bound caller can say start.`);
  }
  if (ctx.phase === 'racing' || ctx.phase === 'countdown') {
    lines.push(locale === 'pt-BR'
      ? 'A corrida está AO VIVO. A pessoa está pilotando com esquerda, direita, acelerar, frear e nitro. Não faça narração sem que a pessoa peça; responda perguntas em poucas palavras para não cobrir o próximo comando.'
      : 'A race is LIVE — the caller should be DRIVING (shouting left/right/boost/brake/nitro), and the scripted announcer handles the play-by-play. Do NOT narrate unprompted. But if they ASK you something mid-race ("what place am I?", "how do I use nitro?"), answer in a SNAPPY few words so it does not bury their next command. Otherwise stay quiet.');
  }
  if (ctx.phase === 'results' || ctx.phase === 'finished') {
    if (ctx.myPlace === 1 && ctx.myFinishTime !== null) lines.push('The caller won the race. Congratulate them warmly, but keep it calm and concise.');
    else if (ctx.myPlace && ctx.myFinishTime === null) lines.push(`The caller did not finish the race and was placed ${ctx.myPlace}. Encourage them without claiming they finished or won.`);
    else lines.push(`The race is over — the caller finished ${ctx.myPlace ? `in place ${ctx.myPlace}` : 'the race'}. ${ctx.stationManaged?'Encourage them without suggesting another race; they must return through the message queue.':'Encourage them to try again, without sounding disappointed or overly dramatic.'}`);
    if(ctx.myCurrentTrackRank&&ctx.currentTrackRankedRunCount){
      lines.push(`AUTHORITATIVE CURRENT-TRACK RANK: this run is number ${ctx.myCurrentTrackRank} out of ${ctx.currentTrackRankedRunCount} retained completed runs on ${ctx.selectedMap??'this track'}. Never calculate a different rank and never confuse it with place ${ctx.myPlace??'unknown'} in the current race.`);
    }
    // A proactive RECAP + leaderboard OVERVIEW — this is the results screen, don't just wait silently.
    if (ctx.raceStandings && ctx.raceStandings.length > 0) {
      const order = ctx.raceStandings.slice(0, 5)
        .map(s => `${s.place}) ${s.name} — ${s.finished && s.time ? `${s.time.toFixed(2)} seconds` : 'DNF'}`)
        .join(', ');
      lines.push(`RACE RECAP / CURRENT RACE RESULTS (${ctx.selectedMap ?? 'current track'}): ${order}. If the caller asks for their score, use their place and finish time from this list. Do NOT invent or estimate times.`);
    }
    if (ctx.leaderboardTop && ctx.leaderboardTop.length > 0) {
      const top = ctx.leaderboardTop.slice(0, 5).map((e, i) => `${i + 1}) ${e.name} — ${e.time.toFixed(2)} seconds`).join(', ');
      lines.push(`CURRENT TRACK LEADERBOARD (${ctx.selectedMap ?? 'this track'}): ${top}. Use ONLY this track-specific leaderboard data when discussing high scores or leaderboard history. Give a concise overview, not a full readout, unless the caller asks for details. Do NOT use global records or other tracks.`);
    } else if (ctx.allTimeBest) {
      lines.push(`CURRENT TRACK LEADERBOARD (${ctx.selectedMap ?? 'this track'}): the record is ${ctx.allTimeBest.name} at ${ctx.allTimeBest.time.toFixed(2)} seconds. Use ONLY this track-specific leaderboard data when discussing high scores.`);
    }
    lines.push(ctx.stationManaged
      ?(locale==='pt-BR'?'A pessoa precisa conferir as instruções do Twilio Games e entrar novamente na fila. Não convide para revanche.':'The caller must check their Twilio Games instructions and join the line again. Do not invite a rematch.')
      :(locale === 'pt-BR'?'Depois, convide a pessoa para correr novamente dizendo "revanche" ou "correr de novo".':'Then invite them to race again (say "rematch" or "go again").'));
  }
  lines.push('', locale === 'pt-BR'
    ? 'REGRAS: responda SOMENTE em português natural do Brasil. Nunca invente nem traduza nomes de carros ou pistas; use exatamente as listas acima. Não avance uma etapa antes de ela estar concluída. Não use emojis.'
    : 'RULES: Never invent car or track names — use ONLY the exact lists above. Do NOT advance the flow past the current step unless that step is done AND the caller is ready. Never mention that you are an AI language model. Stay in character as the race host. Do not use emojis (this is spoken aloud).');
  return lines.join('\n');
}

/** Render choices as a spoken-friendly numbered list ("1) Batmobile, 2) McLaren Senna, ..."). Anchors
 *  the model to EXACT names + their numbers so it never invents or mis-orders a car/track. */
function numberedList(items: string[]): string {
  return items.map((n, i) => `${i + 1}) ${n}`).join(', ');
}

/** Run one conversational turn: give the LLM the utterance + state + tools, execute any tool calls
 *  it requests against the HostContext, and return what to SAY back (reply + action confirmations).
 *  Returns null when the LLM is disabled/empty so the caller falls back to scripted lines. */
export async function hostTurn(
  llm: LlmClient, ctx: HostContext, history: LlmTurn[], locale: SupportedLocale = DEFAULT_LOCALE,
): Promise<string | null> {
  if (!llm.enabled) return null;
  const tools=HOST_TOOLS.filter(tool=>!(ctx.nameLocked&&tool.name==='set_name')
    && !(ctx.stationManaged&&['results','finished'].includes(ctx.phase)&&tool.name==='start_race'));
  const reply = await llm.respond(buildSystemPrompt(ctx, locale), history, tools);
  // Execute the tool calls (side effects: pick car/map, set name, start) — we still run them for
  // their game effect even if we don't speak their confirmation.
  const confirmations = reply.toolCalls.map(tc => runTool(ctx, tc)).filter((s): s is string => !!s);
  const said = reply.say.trim();
  // Deterministic localized confirmations are safe; free-form model text has no hard language
  // guarantee, so never send it to a Portuguese TTS session.
  if (locale === 'pt-BR') return confirmations.length ? confirmations.join(' ') : null;
  // ANTI-REPETITION: the model usually acknowledges its own action in words ("Great pick, the
  // McLaren!"). Appending the tool confirmation too ("...the McLaren!") said the car/map name TWICE.
  // So: if the model spoke, trust ITS words alone. Only fall back to the confirmation when the model
  // said nothing (a bare tool call). Never concatenate both.
  if (said) return said;
  if (confirmations.length) return confirmations.join(' ');
  return null;
}


/** Execute one tool call against the game, returning a short confirmation to speak (or null). */
function runTool(ctx: HostContext, tc: ToolCall): string | null {
  const argName = typeof tc.args.name === 'string' ? tc.args.name : '';
  switch (tc.name) {
    case 'set_name':   return !ctx.nameLocked&&argName ? ctx.setName(argName) : null;
    case 'select_car': return ctx.phase === 'car_select' ? ctx.selectCarByName(argName) : null;
    case 'select_map': return ctx.phase === 'map_select' ? ctx.selectMapByName(argName) : null;
    case 'start_race': return ctx.stationManaged&&['results','finished'].includes(ctx.phase)?null:ctx.startRace();
    default:           return null;
  }
}

/** Spoken number words → value, for "car eleven" / "number three" voice picks (ASR often gives words,
 *  not digits). Covers 1–20 which comfortably spans the roster + map list. */
const NUM_WORDS: Record<SupportedLocale, Record<string, number>> = {
  'en-US': {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20,
  },
  'pt-BR': {
    um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8,
    nove: 9, dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, quinze: 15, dezesseis: 16,
    dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20,
  },
};

/** ORDINAL words → value ("the second one" = index 2). Checked BEFORE cardinals so "second" wins
 *  over the trailing filler "one" in phrases like "the second one" (which used to match "one"→1). */
const ORDINAL_WORDS: Record<SupportedLocale, Record<string, number>> = {
  'en-US': {
    first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
    tenth: 10, eleventh: 11, twelfth: 12,
  },
  'pt-BR': {
    primeiro: 1, primeira: 1, segundo: 2, segunda: 2, terceiro: 3, terceira: 3,
    quarto: 4, quarta: 4, quinto: 5, quinta: 5, sexto: 6, sexta: 6, setimo: 7, setima: 7,
    oitavo: 8, oitava: 8, nono: 9, nona: 9, decimo: 10, decima: 10,
  },
};

/** Parse a 1-based selection NUMBER out of a spoken phrase ("car 11", "number three", "the 3rd one",
 *  "eleven", "the second one"), or null if none. Priority: digits → ordinal words → cardinal words.
 *  Ordinals beat cardinals so "the second one" is 2, not 1 (the trailing "one"). */
export function parseSelectionNumber(spoken: string, locale: SupportedLocale = DEFAULT_LOCALE): number | null {
  const q = normalizeForMatching(spoken, locale);
  const digit = q.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);   // "car 11", "3", "3rd"
  if (digit) return parseInt(digit[1]!, 10);
  for (const [word, n] of Object.entries(ORDINAL_WORDS[locale])) {
    if (new RegExp(`\\b${word}\\b`).test(q)) return n;
  }
  for (const [word, n] of Object.entries(NUM_WORDS[locale])) {
    if (new RegExp(`\\b${word}\\b`).test(q)) return n;
  }
  return null;
}

/** Match a spoken phrase to a choice index. Tries a NUMBER first ("car 11" → index 10), then falls
 *  back to fuzzy NAME matching. Returns the index or -1. Shared by HostContext impls + tests. */
export function matchChoice(spoken: string, choices: string[], locale: SupportedLocale = DEFAULT_LOCALE): number {
  const num = parseSelectionNumber(spoken, locale);
  if (num !== null && num >= 1 && num <= choices.length) return num - 1;   // 1-based → index
  return fuzzyMatch(spoken, choices, locale);
}

/** Is this utterance a QUESTION rather than a selection? ("which is fastest?", "what do you..."). */
function isQuestion(spoken: string, locale: SupportedLocale): boolean {
  const q = normalizeForMatching(spoken, locale);
  if (spoken.trim().endsWith('?')) return true;
  return locale === 'pt-BR'
    ? /\b(qual|quais|o que|quem|como|por que|quando|onde)\b/.test(q)
      || /^(pode|posso|devo|explique|me diga)\b/.test(q)
    : /\b(which|what|who|how|why|when|where)\b/.test(q)
      || /^(can |could |should |do |does |is |are |tell me|explain)/.test(q);
}

/** A DETERMINISTIC selection: return the chosen index when the caller CLEARLY picked one (an in-range
 *  number, or a strong name match) and did NOT ask a question — else null so the LLM handles it. Used
 *  as a pre-LLM fast-path in menus so "two" / "the second one" reliably picks even if the model would
 *  have chatted instead (and so selection works with the LLM disabled). Questions fall through. */
export function clearSelectionIndex(spoken: string, choices: string[], locale: SupportedLocale = DEFAULT_LOCALE): number | null {
  if (isQuestion(spoken, locale)) return null;
  const normalized = normalizeForMatching(spoken, locale);
  // A correction such as "one, actually two" is an unambiguous pick of the last clause.
  // Other negated or multiple-choice turns belong to the semantic interpreter; the fast
  // path must never select the first name/number the caller explicitly rejected.
  const correction = locale === 'pt-BR' ? /\b(?:na verdade|corrigindo)\b/g : /\b(?:actually|correction)\b/g;
  const matches = [...normalized.matchAll(correction)];
  const last = matches.at(-1);
  const candidate = last ? normalized.slice(last.index! + last[0].length).trim() : normalized;
  if (!candidate || /\b(?:don't|dont|don t|do not|can't|cannot|not|never|no|nao|nem|or|ou|either|compare|compara|comparar|versus|vs|between|entre|considering|thinking about|pensando em)\b/.test(candidate)) return null;
  const requested = (locale === 'pt-BR'
    ? candidate.replace(/^(?:(?:eu )?(?:quero|escolho|prefiro|seleciono|vou escolher)|escolha|selecione|pegue|use|me de)\s+/, '')
    : candidate.replace(/^(?:i(?:'ll|'d|ll|d| would)? (?:like to |want to )?(?:take|pick|choose|select|use|drive|race with|want)|give me|lets (?:use|pick|choose)|choose|pick|select|take|use|drive)\s+/, ''))
    .replace(/^(?:please|por favor)\s+/, '').replace(/\s+(?:please|por favor)$/, '');
  const numberWords = [...Object.keys(NUM_WORDS[locale]), ...Object.keys(ORDINAL_WORDS[locale])].join('|');
  const numberPhrase = new RegExp(`^(?:(?:the|a|o|a)\\s+)?(?:(?:car|cars|track|map|option|number|carro|pista|mapa|opcao|numero)\\s+){0,2}(?:\\d{1,2}(?:st|nd|rd|th)?|${numberWords})(?:\\s+(?:one|car|track|option|um|carro|pista|opcao))?$`);
  if (numberPhrase.test(requested)) {
    const num = parseSelectionNumber(requested, locale);
    return num !== null && num >= 1 && num <= choices.length ? num - 1 : null;
  }
  const name = requested.replace(/^(?:the|a|o|a)\s+/, '').replace(/\s+(?:one|car|track|carro|pista)$/, '');
  if (!name || name.split(/\s+/).length > 4
    || /^(?:car|cars|track|tracks|map|maps|carro|carros|pista|pistas|mapa|mapas)$/.test(name)) return null;
  const matching = choices.flatMap((choice, index) => {
    const known = normalizeForMatching(choice, locale);
    return known === name || (name.length >= 3 && known.includes(name)) ? [index] : [];
  });
  return matching.length === 1 ? matching[0]! : null;
}

/** Fuzzy-match a spoken name against a list of choices (case-insensitive substring / word overlap).
 *  Returns the matched index or -1. Exposed so HostContext impls + tests share one matcher. */
export function fuzzyMatch(spoken: string, choices: string[], locale: SupportedLocale = DEFAULT_LOCALE): number {
  const q = normalizeForMatching(spoken, locale);
  if (!q) return -1;
  const generic = locale === 'pt-BR'
    ? new Set(['carro', 'carros', 'pista', 'pistas', 'mapa', 'mapas', 'quero', 'escolha'])
    : new Set(['car', 'cars', 'track', 'tracks', 'map', 'maps', 'want', 'choose', 'pick']);
  if (generic.has(q)) return -1;
  const normalizedChoices = choices.map(choice => normalizeForMatching(choice, locale));
  // exact / substring first
  let idx = normalizedChoices.findIndex(choice => choice === q);
  if (idx >= 0) return idx;
  idx = normalizedChoices.findIndex(choice => (q.length >= 3 && choice.includes(q)) || q.includes(choice));
  if (idx >= 0) return idx;
  // word-overlap: any shared significant word
  const qWords = new Set(q.split(/\s+/).filter(w => w.length > 2 && !generic.has(w)));
  if (!qWords.size) return -1;
  idx = normalizedChoices.findIndex(choice => choice.split(/\s+/).some(word => qWords.has(word)));
  return idx;
}
