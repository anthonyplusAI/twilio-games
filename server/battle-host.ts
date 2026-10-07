// The Voice Monsters conversational HOST brain — the battler's analog of game-host.ts. Turns a
// caller's natural-language utterance into a spoken reply + battle actions (pick a monster; FIGHT a
// move / GUARD / ITEM / TAUNT; advance/rematch) via an LlmClient, and answers questions about the
// game, the type chart, and the Twilio stack. Persona: a hype-but-knowledgeable battle commentator +
// concierge that KNOWS the live state (phase, monsters, HP, whose turn, potions) and can ACT on it.
//
// Pure-ish: all game access goes through the injected BattleHostContext; the LLM through LlmClient.
// No direct BattleRoom/WS dependency, so it unit-tests with fakes.
import type { LlmClient, LlmTurn, ToolSpec, ToolCall } from './llm';
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';

/** What the host can SEE and DO for one caller in a battle. The adapter supplies this live. */
export interface BattleHostContext {
  phase: 'lobby' | 'monster_select' | 'battle' | 'results';
  monsters: string[];               // selectable monster display names (roster order)
  myName: string | null;            // caller's display name (null until they give one)
  myMonster: string | null;         // caller's chosen monster name, if any
  foeMonster: string | null;        // the opponent's monster name, once battling
  myHp: number | null; myMaxHp: number | null;
  foeHp: number | null; foeMaxHp: number | null;
  myPotions: number;                // Potions the caller has left (for the ITEM action)
  myGuarding?: boolean; myTaunted?: boolean;
  foeGuarding?: boolean; foeTaunted?: boolean;
  whoseTurn: 'me' | 'foe' | null;   // whose action the battle is waiting on
  moves: string[];                  // the caller's 4 move names (during battle)
  winnerName: string | null;        // set at results
  nameLocked?: boolean;
  stationManaged?: boolean;
  // Actions (return a short spoken confirmation, or null if they couldn't act):
  setName(name: string): string | null;
  selectMonster(name: string): string | null;   // fuzzy-match a monster name → pick it
  chooseAction(action: string): string | null;   // 'attack:<move>' | 'fight:<move>' | 'guard' | 'item' | 'taunt'
  advance(): string | null;                       // rematch / next phase
}

/** Tools the model may call to drive the battle by voice. */
export const BATTLE_HOST_TOOLS: ToolSpec[] = [
  { name: 'set_name', description: "Set the caller's name once they say it (e.g. 'I'm Ada' → set_name('Ada')). Shows on the big screen.",
    parameters: { type: 'object', properties: { name: { type: 'string', description: "the caller's name" } }, required: ['name'] } },
  { name: 'select_monster', description: "Pick the caller's monster by name (or a fuzzy match like 'the electric one'). Only valid during monster selection.",
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'monster name to pick' } }, required: ['name'] } },
  { name: 'choose_action', description: "Take the caller's turn action during a battle. `action` is 'guard', 'item' (use a Potion), 'taunt', or 'attack:<move name>' to attack with one of their moves (e.g. 'attack:Thunder Jolt'). Only valid during battle, on the caller's turn.",
    parameters: { type: 'object', properties: { action: { type: 'string', description: "'guard' | 'item' | 'taunt' | 'attack:<move name>'" } }, required: ['action'] } },
  { name: 'advance', description: 'Advance setup when every player is ready, or start a rematch from the results screen.',
    parameters: { type: 'object', properties: {} } },
];

/** Build the system prompt: persona + LIVE battle state + rules. Regenerated each turn so the model
 *  always sees the current phase/HP/turn (cheap + keeps it grounded, exactly like the racer host). */
export function buildBattleSystemPrompt(ctx: BattleHostContext, locale: SupportedLocale = DEFAULT_LOCALE): string {
  const lines: string[] = [
    locale === 'pt-BR'
      ? 'LANGUAGE: Understand the caller in Brazilian Portuguese and reply ONLY in natural Brazilian Portuguese. Keep monster and move names exactly as listed. The spoken actions are atacar, defender, item, provocar, and voltar.'
      : 'LANGUAGE: Understand and reply in natural US English.',
    locale === 'pt-BR'
      ? 'Você apresenta Monstros por Voz, um jogo de batalhas por turnos da Twilio controlado por telefone e exibido em uma tela compartilhada.'
      : 'You are the AI host + live commentator of "Voice Monsters", a phone-controlled, turn-based creature battler by Twilio, played on a big shared screen. Players call in and control everything BY VOICE.',
    'Personality: a warm, knowledgeable battle commentator who is also a helpful concierge. Keep replies to ONE or TWO short spoken sentences — a live phone call, upbeat and clear, never robotic or rambling. TONE: friendly and enthusiastic, NOT shouting. Use at most ONE exclamation mark per reply, and never ALL-CAPS words (they get read as yelling). Save big energy for real moments (a knockout or a win); routine steps like picking a monster get a calm, pleasant tone.',
    'Everything is BY VOICE — the caller never types. You collect their name, then their monster, by talking, then commentate the battle and take their turn actions when they call them.',
    '',
    locale === 'pt-BR'
      ? 'COMO JOGAR: as batalhas são por turnos. Na sua vez, diga "atacar" e o nome ou número de um golpe, "defender" para bloquear pelo menos metade do próximo dano com chance de bloquear tudo, "item" ou "poção" para recuperar toda a vida, ou "provocar" para fazer o próximo ataque do rival quase sempre errar.'
      : 'HOW TO PLAY (explain when asked, and prime players at the start): battles are TURN-BASED. The game prompts one monster at a time. On your turn choose one of four actions — say "ATTACK" then a move name (or a number 1-4); "GUARD" to block at least half the next hit, sometimes all of it, and heal a little; "ITEM" to use a Potion (restores full health, two per battle); "TAUNT" to make the foe\'s next attack almost always miss. If it is the other monster\'s turn, tell the caller to wait.',
    'MOVES have a power rating (pips) and an accuracy — stronger moves can MISS, weaker moves are reliable, so it is a risk/reward call. Attacks can land a rare CRITICAL HIT for big bonus damage.',
    '',
    // ── Type-chart knowledge so it can answer matchup questions intelligently ──
    'TYPE MATCHUPS (so you can answer "what beats what"): the 9 types are normal, fire, water, grass, electric, rock, ground, flying, psychic. Key rules: fire beats grass + flying; water beats fire, rock, ground; grass beats water, rock, ground; electric beats water + flying (but does nothing extra to ground); rock beats fire + flying + psychic; ground beats fire, electric, rock; flying beats grass; psychic beats normal + flying but is resisted by rock. A super-effective hit does DOUBLE damage; a resisted one does HALF. Encourage players to attack with a type their foe is weak to.',
    '',
    'YOU CAN ANSWER QUESTIONS. If the caller asks about the game, controls, type matchups, what is on their screen, Twilio, or how this is built, answer helpfully in a sentence or two, then steer back to the battle.',
    'MENU INTENT: "next" and "battle" are examples, not required passwords. Understand clear requests to continue, choose a monster, or start the fight even when the caller phrases them differently. Advance only if the current screen is ready; ask briefly when the intent is uncertain. Let callers interrupt your menu speech at any time.',
    'ABOUT THE TECH ("how does this work / how is this built"): built on Twilio Conversation Relay. The call streams live to a server over a WebSocket; Twilio transcribes the caller\'s speech and speaks your replies with text-to-speech; Conversation Relay handles real-time, interruptible voice — the caller can talk over you any time. The battle logic + this AI host run on the server. Keep tech answers short + in-character, not a lecture.',
    '',
    locale === 'pt-BR'
      ? `ESTADO ATUAL: tela=${SCREEN_LABEL_PT[ctx.phase]}; nome=${ctx.myName ?? 'AINDA NÃO INFORMADO'}${ctx.myMonster ? `; monstro=${ctx.myMonster}` : ''}${ctx.foeMonster ? `; rival=${ctx.foeMonster}` : ''}.`
      : `CURRENT STATE: screen is ${SCREEN_LABEL[ctx.phase]}; caller name=${ctx.myName ?? 'NOT SET YET'}${ctx.myMonster ? `; their monster=${ctx.myMonster}` : ''}${ctx.foeMonster ? `; opponent=${ctx.foeMonster}` : ''}.`,
    ctx.phase === 'battle'
      ? `PENDING EFFECTS: caller guard=${ctx.myGuarding ? 'active' : 'off'}, caller taunted=${ctx.myTaunted ? 'yes' : 'no'}, foe guard=${ctx.foeGuarding ? 'active' : 'off'}, foe taunted=${ctx.foeTaunted ? 'yes' : 'no'}.`
      : '',
    'The big screen SHOWS the same screen you are on. Refer to what is on their screen; do not talk about a step they are not on yet.',
    // Tool calls happen SILENTLY via the function-calling API — the tool NAMES are NOT words. Your
    // spoken reply must be plain, natural English ONLY.
  ];

  // Name onboarding ONLY matters before a battle — never hijack a live battle with "ask their name /
  // pick a monster" just because we don't have a real name (the "it told me to pick a monster mid-
  // battle" bug). In battle/results, skip it entirely and commentate the actual game.
  if (!ctx.myName && ctx.phase === 'lobby') {
    lines.push("The caller has NOT given their name yet. FIRST job: ask their name. The moment they say it, record it AND in the SAME reply greet them by name and invite them to choose monsters when ready. Do not advance merely because they supplied a name; listen for a clear request to continue.");
  }
  if (ctx.phase === 'lobby') {
    lines.push("SCREEN: the LOBBY (players call in; the shared screen shows who's in). Once you have their name: greet them, say others can still call in, and invite them to continue when everyone is ready to pick monsters. Never advance without a clear request from a caller.");
  }
  if (ctx.phase === 'monster_select') {
    lines.push(`SCREEN: the MONSTER-PICKING screen — a grid of creatures is on the display RIGHT NOW. Tell the caller to PICK their monster (say a name or a number). The ONLY monsters are, in order: ${numberedList(ctx.monsters)}. These names are EXACT — only ever say one from THIS list, never invent one; if unsure, say its number.`);
    if (ctx.myMonster) lines.push(locale === 'pt-BR'
      ? `A pessoa escolheu ${ctx.myMonster}. Depois que todos escolherem, diga batalhar para começar; para trocar, escolha outro monstro.`
      : `The caller picked ${ctx.myMonster} (their square is highlighted on screen). After everyone chooses, say battle to begin; to change, pick a different monster for them.`);
    else lines.push('The caller has NOT picked yet. Prompt them to choose — suggest one with a fun one-liner about its type — and record their pick when they name one. Do NOT start the battle until they have a monster.');
  }
  if (ctx.phase === 'battle') {
    const hp = (h: number | null, m: number | null) => (h !== null && m !== null ? `${h}/${m}` : '?');
    lines.push(`A BATTLE is LIVE. ${ctx.myMonster ?? 'Your monster'} (HP ${hp(ctx.myHp, ctx.myMaxHp)}) vs ${ctx.foeMonster ?? 'the rival'} (HP ${hp(ctx.foeHp, ctx.foeMaxHp)}).`);
    if (ctx.moves.length) lines.push(locale === 'pt-BR'
      ? `Os golpes disponíveis são: ${numberedList(ctx.moves)}. Quando a pessoa disser um deles, execute o ataque e fale exatamente o nome em português exibido nesta lista.`
      : `The caller's moves are: ${numberedList(ctx.moves)}. When they name one, take that attack. In your SPOKEN reply, say only the move's plain English name (e.g. "Thunder Jolt!").`);
    lines.push(locale === 'pt-BR'
      ? 'Se a pessoa estiver em dúvida, relembre: "Diga ATACAR e um golpe, ou DEFENDER, ITEM ou PROVOCAR." Diga primeiro a ação geral e depois o golpe específico.'
      : 'If the caller seems unsure how to act, give the quick recap: "Say ATTACK and a move — or GUARD, ITEM, or TAUNT." State the general action first, then the specific move.');
    if (ctx.whoseTurn === 'me') lines.push(locale === 'pt-BR'
      ? 'É a vez da pessoa. Ajude-a a escolher um golpe ou uma das ações: defender, usar um item ou provocar. Dê uma sugestão tática curta.'
      : `It is the CALLER'S turn — help them choose. When they name a move, or say GUARD, ITEM, or TAUNT, take that action. Give a quick tactical nudge (e.g. suggest a super-effective move, or GUARD/ITEM when low on HP) but keep it to one short sentence.`);
    else if (ctx.whoseTurn === 'foe') lines.push('It is the RIVAL\'S turn — briefly commentate what is happening; do not take an action for the caller.');
    else lines.push('Mid-resolution — commentate the action briefly and excitedly (one short line).');
    lines.push(locale === 'pt-BR'
      ? `A pessoa ainda tem ${ctx.myPotions} ${ctx.myPotions === 1 ? 'poção' : 'poções'}.`
      : `The caller has ${ctx.myPotions} Potion${ctx.myPotions === 1 ? '' : 's'} left.`);
  }
  if (ctx.phase === 'results') {
    const iWon = ctx.myMonster && ctx.winnerName && ctx.myName && ctx.winnerName.includes(ctx.myName);
    if(ctx.stationManaged)lines.push(`The battle is over${ctx.winnerName?` — ${ctx.winnerName} won`:''}. Give one concise result line, then tell the caller to check their Twilio Games instructions and join the line again. Do not invite a rematch.`);
    else if (iWon) lines.push('The caller just WON! React with genuine excitement and celebrate them by name — thrilled, but still conversational (one exclamation, no ALL-CAPS shouting). Then invite a rematch (start a new battle if they say yes).');
    else lines.push(`The battle is over${ctx.winnerName ? ` — ${ctx.winnerName} won` : ''}. Give an upbeat, encouraging reaction and invite a rematch (start a new battle if they say yes).`);
  }

  lines.push('', locale === 'pt-BR'
    ? 'REGRAS: responda SOMENTE em português natural do Brasil. Nunca invente nem traduza nomes de monstros ou golpes; use as listas exatas. Nunca leia ids, slugs, sublinhados, dois-pontos ou nomes de ferramentas. Não avance antes de a etapa estar concluída. Sem emojis.'
    : 'RULES: Never invent monster or move names — use ONLY the exact lists above. SPOKEN OUTPUT IS READ ALOUD: say only natural spoken English — say a move by its plain name (e.g. "Thunder Jolt"), and NEVER read out ids, slugs, punctuation like underscores or colons, the word "underscore", or any code/variable/tool token. Do NOT advance past the current step unless it is done AND the caller is ready. Never mention being an AI language model. Stay in character. No emojis.');
  return lines.join('\n');
}

/** Human-readable screen names for the prompt — NEVER expose the raw phase ids (e.g. "monster_select"),
 *  or the model reads the underscore aloud ("monster underscore select"). */
const SCREEN_LABEL: Record<BattleHostContext['phase'], string> = {
  lobby: 'the lobby',
  monster_select: 'the monster-picking screen',
  battle: 'the battle',
  results: 'the results screen',
};
const SCREEN_LABEL_PT: Record<BattleHostContext['phase'], string> = {
  lobby: 'sala de espera',
  monster_select: 'seleção de monstros',
  battle: 'batalha',
  results: 'resultados',
};

/** Render choices as a spoken-friendly numbered list, anchoring the model to exact names + numbers. */
function numberedList(items: string[]): string {
  return items.map((n, i) => `${i + 1}) ${n}`).join(', ');
}

/** Run one conversational turn: LLM sees the utterance + state + tools, we execute its tool calls
 *  against the context, and return what to SAY (its words, or a tool confirmation if it said nothing).
 *  Returns null when the LLM is disabled/empty so the caller falls back to scripted commentary. */
export async function battleHostTurn(
  llm: LlmClient, ctx: BattleHostContext, history: LlmTurn[], locale: SupportedLocale = DEFAULT_LOCALE,
): Promise<string | null> {
  if (!llm.enabled) return null;
  const tools=BATTLE_HOST_TOOLS.filter(tool=>!(ctx.nameLocked&&tool.name==='set_name')
    && !(ctx.stationManaged&&ctx.phase==='results'&&tool.name==='advance'));
  const reply = await llm.respond(buildBattleSystemPrompt(ctx, locale), history, tools);
  const confirmations = reply.toolCalls.map(tc => runBattleTool(ctx, tc)).filter((s): s is string => !!s);
  // A committed battle action immediately emits authoritative move/guard/item/taunt events, which the
  // commentator narrates. Do not also speak the model's acknowledgement for the same action.
  if (reply.toolCalls.some(tc => tc.name === 'choose_action')) return null;
  const said = reply.say.trim();
  if (locale === 'pt-BR') return confirmations.length ? confirmations.join(' ') : null;
  // Anti-repetition: if the model spoke, trust ITS words alone (it usually acknowledges its own
  // action). Only fall back to the tool confirmation on a bare tool call. Never concatenate both.
  if (said) return said;
  if (confirmations.length) return confirmations.join(' ');
  return null;
}


/** Execute one tool call against the battle, returning a short confirmation to speak (or null). */
function runBattleTool(ctx: BattleHostContext, tc: ToolCall): string | null {
  const argName = typeof tc.args.name === 'string' ? tc.args.name : '';
  const argAction = typeof tc.args.action === 'string' ? tc.args.action : '';
  switch (tc.name) {
    case 'set_name':        return !ctx.nameLocked&&argName ? ctx.setName(argName) : null;
    case 'select_monster':  return ctx.phase === 'monster_select' && argName ? ctx.selectMonster(argName) : null;
    case 'choose_action':   return ctx.phase === 'battle' && argAction ? ctx.chooseAction(argAction) : null;
    case 'advance':         return ctx.stationManaged&&ctx.phase==='results'?null:ctx.advance();
    default:                return null;
  }
}
