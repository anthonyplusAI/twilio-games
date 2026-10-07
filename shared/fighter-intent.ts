import type { FighterCommand } from './fighter-world';
import { DEFAULT_LOCALE, type SupportedLocale } from './i18n/locales';
import { normalizeForMatching } from './i18n/translate';

const MAX_COMMANDS_PER_UTTERANCE = 2;

// Clear conversational requests take the fast path. Anything outside these grammatical
// forms still reaches the semantic interpreter, rather than becoming a guessed action.
const COMMANDS: Record<SupportedLocale, [FighterCommand, RegExp][]> = {
  'en-US': [
    ['forward', /^(?:(?:move|step|go|walk|advance) (?:forward|in|closer)(?: to (?:my |the |your )?(?:opponent|rival|fighter|enemy|him|her|them))?|get closer(?: to (?:my |the |your )?(?:opponent|rival|fighter|enemy|him|her|them))?|close the distance|approach (?:my |the |your )?(?:opponent|rival|fighter|enemy|him|her|them)|forward|closer|in)$/],
    ['back', /^(?:(?:move|step|go|walk|pull) (?:back|backward|away)(?: from (?:the |my |your )?(?:opponent|rival|fighter|enemy|him|her|them))?|back away(?: from (?:the |my |your )?(?:opponent|rival|fighter|enemy|him|her|them))?|back|backward|away)$/],
    ['jump', /^(?:jump|leap|hop)(?: up|over him|over her|over them)?$/],
    ['punch', /^(?:(?:punch|jab|strike|hit)(?: (?:the |my |your )?(?:opponent|rival|fighter|enemy|him|her|them))?|(?:throw|give|deliver|land)(?: (?:him|her|them))? (?:a |an )?(?:quick |fast |hard |light |strong )?(?:punch|jab|strike|hit)(?: at (?:the |my |your )?(?:opponent|rival|fighter|enemy|him|her|them))?)$/],
    ['kick', /^(?:(?:kick|roundhouse)(?: (?:the |my |your )?(?:opponent|rival|fighter|enemy|him|her|them))?|(?:throw|give|deliver|land)(?: (?:him|her|them))? (?:a |an )?(?:quick |fast |hard |light |strong )?(?:roundhouse )?kick(?: at (?:the |my |your )?(?:opponent|rival|fighter|enemy|him|her|them))?)$/],
    ['block', /^(?:(?:block|guard|defend)(?: (?:the |his |her |their )?(?:attack|punch|kick|hit|strike))?|put (?:my|your) guard up)$/],
  ],
  'pt-BR': [
    ['forward', /^(?:(?:(?:mover|andar|ir|va|vai) )?(?:(?:para|pra) (?:a )?)?(?:frente|avancar|avanca|avance|aproximar|aproxime-se|se aproxime|chegue mais perto)|(?:me |se )?aproximar (?:do|da) (?:rival|oponente|adversario)|chegar mais perto (?:do|da) (?:rival|oponente|adversario))$/],
    ['back', /^(?:(?:(?:mover|andar|ir|va|vai) )?(?:(?:para|pra) )?(?:tras|recuar|recua|recue|afastar|afaste-se|se afaste)|(?:me |se )?afastar (?:do|da) (?:rival|oponente|adversario))$/],
    ['jump', /^(?:pular|pule|saltar|salte)$/],
    ['punch', /^(?:soco|soca|socar|golpear|(?:de|da|dar) um soco)(?: (?:nele|nela|no rival|na rival|no oponente|no adversario))?$/],
    ['kick', /^(?:chute|chuta|chutar|(?:de|da|dar) um chute)(?: (?:nele|nela|no rival|na rival|no oponente|no adversario))?$/],
    ['block', /^(?:bloquear|bloqueia|bloqueie|defender|defende|defenda|defenda-se|levante a guarda)$/],
  ],
};

const COUNTS: Record<SupportedLocale, Record<string, number>> = {
  'en-US': { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 },
  'pt-BR': { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6 },
};

function actionForClause(clause: string, locale: SupportedLocale): FighterCommand | null {
  for (const [command, pattern] of COMMANDS[locale]) if (pattern.test(clause)) return command;
  return null;
}

function trimPoliteness(text: string, locale: SupportedLocale): string {
  let next = text;
  const prefix = locale === 'pt-BR'
    ? /^(?:por favor|pode|poderia|voce pode|quero|eu quero|vamos) /
    : /^(?:please|can you|could you|would you|will you|i want to|i would like to|i'd like to|let's|let us|go ahead and) /;
  const suffix = locale === 'pt-BR' ? / (?:por favor|agora)$/ : / (?:please|now|right now|for me)$/;
  while (prefix.test(next)) next = next.replace(prefix, '');
  while (suffix.test(next)) next = next.replace(suffix, '');
  return next;
}

export function matchFighterCommand(spoken: string, locale: SupportedLocale = DEFAULT_LOCALE): FighterCommand | null {
  return actionForClause(normalizeForMatching(spoken, locale), locale);
}

export function matchFighterCommands(spoken: string, locale: SupportedLocale = DEFAULT_LOCALE): FighterCommand[] {
  let text = normalizeForMatching(spoken, locale);
  if (!text) return [];
  const isDirectRequest = locale === 'pt-BR'
    ? /^(?:pode|poderia|voce pode|por favor)\b/.test(text)
    : /^(?:can you|could you|would you|will you|please)\b/.test(text);
  if (spoken.includes('?') && !isDirectRequest) return [];
  const advice = locale === 'pt-BR'
    ? /^(?:como|quando|por que|porque|posso|devo|sera que|e se)\b|\b(?:talvez|ou|se eu|me diga|me conte)\b/
    : /^(?:how|what|why|when|where|who|can i|could i|should i|would i|do i|if|maybe|perhaps)\b|\b(?:whether|or|tell me|help me|if i|would i|should i)\b/;
  if (advice.test(text)) return [];

  // A correction cancels the earlier command in the same final transcript.
  const correction = locale === 'pt-BR' ? /\b(?:nao|na verdade|melhor)\b/g : /\b(?:no|actually|instead|rather)\b/g;
  const markers = [...text.matchAll(correction)];
  if (markers.length) {
    const marker = markers.at(-1)!;
    if ((marker.index ?? 0) === 0) return [];
    text = text.slice((marker.index ?? 0) + marker[0].length).trim();
  }
  if (/\b(?:don't|dont|not|never|nao|nunca)\b/.test(text)) return [];

  text = trimPoliteness(text, locale);
  const single = actionForClause(text, locale);
  if (single) return [single];
  const counts = COUNTS[locale];
  const repeatUnit = locale === 'pt-BR' ? 'vez(?:es)?' : 'times?';
  const repeated = text.match(new RegExp(`^(.+?)\\s+(${Object.keys(counts).join('|')}|[1-6])\\s+${repeatUnit}$`));
  if (repeated) {
    const command = actionForClause(repeated[1]!, locale);
    const count = Number(repeated[2]) || counts[repeated[2]!] || 0;
    return command ? Array.from({ length: Math.min(count, MAX_COMMANDS_PER_UTTERANCE) }, () => command) : [];
  }

  const separator = locale === 'pt-BR' ? / (?:e depois|em seguida|depois|entao|e) / : / (?:and then|after that|then|and) /;
  const clauses = text.split(separator);
  const commands: FighterCommand[] = [];
  for (const clause of clauses) {
    const normalized = trimPoliteness(clause, locale);
    const action = actionForClause(normalized, locale);
    if (action) { commands.push(action); continue; }
    // Bare repeated combat verbs are an intentional burst. An unknown token anywhere,
    // including after the two-action rate limit, invalidates the whole transcript.
    const burst = normalized.split(' ').map(token => actionForClause(token, locale));
    if (burst.some(command => !command)) return [];
    commands.push(...burst as FighterCommand[]);
  }
  return commands.slice(0, MAX_COMMANDS_PER_UTTERANCE);
}
