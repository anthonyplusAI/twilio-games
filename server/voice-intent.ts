import type { Intent } from '../shared/types';
import { DEFAULT_LOCALE, type SupportedLocale } from '../shared/i18n/locales';
import { normalizeForMatching } from '../shared/i18n/translate';

// Each intent maps to the words/phrases that trigger it. Order within the scan
// is by last-occurrence in the transcript so self-corrections ("left no right")
// take the latest command.
const WORD_TO_INTENT: Record<SupportedLocale, ReadonlyMap<string, Intent>> = {
  'en-US': new Map([
    ['left', 'MOVE_LEFT'],
    ['right', 'MOVE_RIGHT'],
    ['boost', 'BOOST'],
    ['go', 'BOOST'],
    ['accelerate', 'BOOST'],
    ['faster', 'BOOST'],
    ['brake', 'BRAKE'],
    ['brakes', 'BRAKE'],
    ['slow', 'BRAKE'],
    ['decelerate', 'BRAKE'],
    ['stop', 'BRAKE'],
    ['nitro', 'USE_POWER'],
    ['power', 'USE_POWER'],
  ]),
  'pt-BR': new Map([
    ['esquerda', 'MOVE_LEFT'],
    ['direita', 'MOVE_RIGHT'],
    ['acelerar', 'BOOST'],
    ['acelera', 'BOOST'],
    ['acelere', 'BOOST'],
    ['vai', 'BOOST'],
    ['frear', 'BRAKE'],
    ['freia', 'BRAKE'],
    ['freie', 'BRAKE'],
    ['devagar', 'BRAKE'],
    ['reduzir', 'BRAKE'],
    ['reduz', 'BRAKE'],
    ['reduza', 'BRAKE'],
    ['desacelerar', 'BRAKE'],
    ['desacelera', 'BRAKE'],
    ['desacelere', 'BRAKE'],
    ['parar', 'BRAKE'],
    ['nitro', 'USE_POWER'],
    ['turbo', 'USE_POWER'],
    ['poder', 'USE_POWER'],
  ]),
};

export function mapTranscriptToIntent(transcript: string, locale: SupportedLocale = DEFAULT_LOCALE): Intent | null {
  return intentsFromTranscript(transcript, locale).at(-1) ?? null;
}

/**
 * Low-latency path for clearly spoken race controls. A final transcript can contain
 * a correction or negation, so merely searching for control words would steer the
 * car the wrong way. Unclear speech returns no local action for semantic routing.
 */
export function intentsFromTranscript(transcript: string, locale: SupportedLocale = DEFAULT_LOCALE): Intent[] {
  const norm = normalizeForMatching(transcript, locale).replace(/\b(?:don't|dont|do not|shouldn't|shouldnt|mustn't|mustnt)\b/g, 'not');
  if (!norm) return [];
  // A caller discussing a control is not issuing it. Relay punctuation is helpful but optional;
  // leading question forms cover transcripts whose punctuation was dropped by ASR.
  if (locale === 'pt-BR'
    ? /^(?:o que|como|qual|quando|onde|por que|posso|devo)\b/.test(norm)
      || /\bo que (?:faz|e|significa)\b/.test(norm)
      || /^(?:me explica|me explique|explique|pode explicar|quero saber|gostaria de saber)\b/.test(norm)
      || /\b(?:guardar|economizar|segurar) (?:o |meu )?(?:nitro|turbo|poder)\b/.test(norm)
      || /\b(?:pare|parar|para) de falar\b/.test(norm)
    : /^(?:what|how|why|when|where|should i|can i|do i|does|is|are)\b/.test(norm)
      || /\b(?:asking what|want to know what)\b/.test(norm)
      || /^(?:tell me|explain|could you explain|can you explain|do you know|i (?:want|need|would like) to know)\b/.test(norm)
      || /\b(?:save|keep|hold|reserve) (?:my |the |a )?(?:nitro|power|boost)\b/.test(norm)
      || /\b(?:have|got) (?:a |any |some |one |my )?(?:nitro|power)\b/.test(norm)
      || /\b(?:my|the) boost (?:is|was|looks|ran|has)\b/.test(norm)
      || /\b(?:stop|quit) talking\b/.test(norm)) return [];
  if (/\b(?:was|were|did|used|went|if|would|should have|tinha|fui|se eu|teria)\b/.test(norm)) return [];
  let tokens = norm.split(/\s+/).filter(Boolean);
  // "left, no, right" and "esquerda, não, direita" replace the abandoned request;
  // sequential requests without a correction retain their order.
  const correctionWords = locale === 'pt-BR' ? new Set(['nao', 'corrigindo']) : new Set(['no', 'actually', 'sorry']);
  for (let i = tokens.length - 2; i > 0; i--) {
    if (!correctionWords.has(tokens[i]!)) continue;
    const before = tokens.slice(0, i).some(token => WORD_TO_INTENT[locale].has(token));
    const after = tokens.slice(i + 1).some(token => WORD_TO_INTENT[locale].has(token));
    if (before && after) { tokens = tokens.slice(i + 1); break; }
  }
  const out: Intent[] = [];
  let negateNext = false;
  for (let index = 0; index < tokens.length; index++) {
    const tok = tokens[index]!;
    if (['not', 'no', 'never', 'nao', 'sem'].includes(tok)) { negateNext = true; continue; }
    const hit = WORD_TO_INTENT[locale].get(tok);
    if ((tok === 'go' || tok === 'vai') && tokens.slice(index + 1, index + 4).some(word => {
      const next = WORD_TO_INTENT[locale].get(word);
      return next === 'MOVE_LEFT' || next === 'MOVE_RIGHT' || next === 'BOOST';
    })) continue;
    if (hit && negateNext) { negateNext = false; continue; }
    if (hit) out.push(hit);
  }
  return out;
}
