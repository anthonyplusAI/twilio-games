import type { FighterCommand } from './fighter-world';
import { DEFAULT_LOCALE, type SupportedLocale } from './i18n/locales';
import { normalizeForMatching } from './i18n/translate';

const MAX_COMMANDS_PER_UTTERANCE = 2;

const COMMANDS: Record<SupportedLocale, [FighterCommand, RegExp][]> = {
  'en-US': [
    ['forward', /^(?:move |step |go )?(?:forward|closer|in)$/],
    ['back', /^(?:move |step |go )?(?:back|backward|away)$/],
    ['jump', /^(?:jump|leap|hop)$/],
    ['punch', /^(?:punch|jab|strike|hit)$/],
    ['kick', /^(?:kick|roundhouse)$/],
    ['block', /^(?:block|guard|defend)$/],
  ],
  'pt-BR': [
    ['forward', /^(?:(?:mover|andar|ir|va|vai) )?(?:(?:para|pra) (?:a )?)?(?:frente|avancar|avanca|avance|aproximar|aproxime-se|se aproxime|chegue mais perto)$/],
    ['back', /^(?:(?:mover|andar|ir|va|vai) )?(?:(?:para|pra) )?(?:tras|recuar|recua|recue|afastar|afaste-se|se afaste)$/],
    ['jump', /^(?:pular|pule|saltar)$/],
    ['punch', /^(?:soco|soca|socar|golpear|(?:de|da|dar) um soco)$/],
    ['kick', /^(?:chute|chuta|chutar|(?:de|da|dar) um chute)$/],
    ['block', /^(?:bloquear|bloqueia|bloqueie|defender|defende|defenda|defenda-se)$/],
  ],
};

const COUNTS: Record<SupportedLocale, Record<string, number>> = {
  'en-US': { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 },
  'pt-BR': { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6 },
};

const FILLER: Record<SupportedLocale, Set<string>> = {
  'en-US': new Set(['and', 'then', 'move', 'step', 'go', 'please', 'now']),
  'pt-BR': new Set(['a', 'e', 'depois', 'entao', 'em', 'seguida', 'mover', 'andar', 'ir', 'para', 'pra', 'va', 'vai', 'por', 'favor', 'agora']),
};

export function matchFighterCommand(spoken: string, locale: SupportedLocale = DEFAULT_LOCALE): FighterCommand | null {
  const text = normalizeForMatching(spoken, locale);
  for (const [command, pattern] of COMMANDS[locale]) if (pattern.test(text)) return command;
  return null;
}

export function matchFighterCommands(spoken: string, locale: SupportedLocale = DEFAULT_LOCALE): FighterCommand[] {
  let text = normalizeForMatching(spoken, locale);
  if (spoken.includes('?') || /^(?:can i|could i|should i|do i|what|how|posso|devo|como)\b/.test(text)) return [];
  // A correction cancels the earlier command in the same final transcript. Never execute
  // both "punch" and "block" when the player says "punch, no, block".
  const correction = locale === 'pt-BR' ? /\b(?:nao|na verdade|melhor)\b/g : /\b(?:no|actually|instead|rather)\b/g;
  const markers = [...text.matchAll(correction)];
  if (markers.length) {
    const marker = markers.at(-1)!;
    if ((marker.index ?? 0) === 0) return [];
    text = text.slice((marker.index ?? 0) + marker[0].length).trim();
  }
  if (/\b(?:don't|dont|not|never|nao|nunca)\b/.test(text)) return [];
  const single = matchFighterCommand(text, locale); if (single) return [single];
  const counts = COUNTS[locale];
  const repeatUnit = locale === 'pt-BR' ? 'vez(?:es)?' : 'times?';
  const repeated = text.match(new RegExp(`^(.+?)\\s+(${Object.keys(counts).join('|')}|[1-6])\\s+${repeatUnit}$`));
  if (repeated) {
    const command = matchFighterCommand(repeated[1]!, locale);
    const count = Number(repeated[2]) || counts[repeated[2]!] || 0;
    return command ? Array.from({ length: Math.min(count, MAX_COMMANDS_PER_UTTERANCE) }, () => command) : [];
  }
  const commands: FighterCommand[] = [];
  for (const token of text.split(' ')) {
    const command = matchFighterCommand(token, locale);
    if (command) commands.push(command);
    else if (!FILLER[locale].has(token)) return [];
    if (commands.length === MAX_COMMANDS_PER_UTTERANCE) break;
  }
  return commands;
}
