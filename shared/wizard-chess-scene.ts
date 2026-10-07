import type { SupportedLocale } from './i18n/locales';
import { normalizeForMatching } from './i18n/translate';
import type { ChessColor, ChessPieceType, ChessSquare } from './chess-protocol';

/** The documented position immediately before Ron's knight sacrifice. The scene
 * plays on a separate display board; it is never loaded into the live match. */
export const WIZARD_CHESS_PRE_RON_FEN = '5r1k/1pN1R1pp/1Pb5/n3P1n1/7N/b1Q5/7P/1R4K1 b - - 0 2';

export type WizardChessCharacter = 'ron' | 'hermione' | 'harry';

export const WIZARD_CHESS_CHARACTERS: Readonly<Record<WizardChessCharacter,
  { square: ChessSquare; color: ChessColor; piece: ChessPieceType }>> = {
  ron: { square: 'g5', color: 'b', piece: 'n' },
  hermione: { square: 'f8', color: 'b', piece: 'r' },
  harry: { square: 'a3', color: 'b', piece: 'b' },
};

/** Character squares are shared with the lightweight 2D board as well as WebGL. */
export function wizardCharacterAt(square: string, color: ChessColor,
  type: ChessPieceType): WizardChessCharacter | null {
  if (color !== 'b') return null;
  if (type === 'n' && (square === 'g5' || square === 'h3')) return 'ron';
  if (type === 'b' && (square === 'a3' || square === 'c5' || square === 'e3')) return 'harry';
  if (type === 'r' && square === 'f8') return 'hermione';
  return null;
}

/** These are ElevenLabs voice IDs, not credentials. Screen audio uses a server-side API key. */
export const WIZARD_CHESS_VOICE_IDS: Readonly<Record<WizardChessCharacter, string>> = {
  hermione: 'nDJIICjR9zfJExIFeSCN',
  ron: 'bDTlr4ICxntY9qVWyL0o',
  harry: 'llNlEi50DSCIEuoOIaH7',
};

export interface WizardChessDialogueLine {
  id: string;
  speaker: WizardChessCharacter;
  atMs: number;
  text: Readonly<Record<SupportedLocale, string>>;
}

/** Original dialogue for this interactive homage, not a film transcript. */
export const WIZARD_CHESS_DIALOGUE: readonly WizardChessDialogueLine[] = [
  {
    id: 'ron-sees-the-line', speaker: 'ron', atMs: 6_000,
    text: {
      'en-US': 'Once I make my move, the queen will have to answer.',
      'pt-BR': 'Assim que eu fizer minha jogada, a rainha terá de responder.',
    },
  },
  {
    id: 'hermione-sees-the-risk', speaker: 'hermione', atMs: 12_000,
    text: {
      'en-US': 'She can take your knight, Ron. Are you sure?',
      'pt-BR': 'Ela pode capturar seu cavalo, Ron. Você tem certeza?',
    },
  },
  {
    id: 'ron-accepts-the-risk', speaker: 'ron', atMs: 18_000,
    text: {
      'en-US': 'I see it. Watch where she lands after the capture.',
      'pt-BR': 'Eu sei. Observem onde ela vai parar depois da captura.',
    },
  },
  {
    id: 'harry-sees-the-reply', speaker: 'harry', atMs: 24_000,
    text: {
      'en-US': 'That opens a line for the bishop. We have a reply.',
      'pt-BR': 'Isso abre uma linha para o bispo. Temos uma resposta.',
    },
  },
  {
    id: 'hermione-calls-for-help', speaker: 'hermione', atMs: 30_000,
    text: {
      'en-US': 'The board is waiting for us. Someone has to call it.',
      'pt-BR': 'O tabuleiro está esperando. Alguém precisa anunciar a jogada.',
    },
  },
  {
    id: 'ron-invites-the-caller', speaker: 'ron', atMs: 36_000,
    text: {
      'en-US': 'Your turn. Guide my knight where the queen must follow.',
      'pt-BR': 'Sua vez. Guie meu cavalo para onde a rainha terá de segui-lo.',
    },
  },
];

export const WIZARD_CHESS_STORY_DURATION_MS = 42_000;
export const WIZARD_CHESS_RESOLVED_DURATION_MS = 26_000;

/** Silman's composed five-move endgame, including the moves cut from the film edit. */
export const WIZARD_CHESS_SEQUENCE: readonly {
  id: string; san: string; from: ChessSquare; to: ChessSquare; atMs: number;
  color: ChessColor; piece: ChessPieceType; check: boolean;
}[] = [
  { id: 'ron-knight', san: 'Nh3+', from: 'g5', to: 'h3', atMs: 0,
    color: 'b', piece: 'n', check: true },
  { id: 'queen-captures', san: 'Qxh3', from: 'c3', to: 'h3', atMs: 2_800,
    color: 'w', piece: 'q', check: false },
  { id: 'bishop-check', san: 'Bc5+', from: 'a3', to: 'c5', atMs: 5_600,
    color: 'b', piece: 'b', check: true },
  { id: 'queen-blocks', san: 'Qe3', from: 'h3', to: 'e3', atMs: 8_400,
    color: 'w', piece: 'q', check: false },
  { id: 'bishop-mate', san: 'Bxe3#', from: 'c5', to: 'e3', atMs: 11_200,
    color: 'b', piece: 'b', check: true },
];

/** The screen reveals victory after the final capture animation completes. */
export const WIZARD_CHESS_VICTORY_AT_MS = WIZARD_CHESS_SEQUENCE.at(-1)!.atMs + 1_900;

export type WizardChessVoiceAction = 'final' | 'skip' | 'exit' | 'hint' | 'unknown';

function normalizedSpeech(spoken: string, locale: SupportedLocale): string {
  return normalizeForMatching(spoken, locale).replace(/['-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A named summon is only a command, never an informational question or negation. */
export function isWizardChessTrigger(spoken: string, locale: SupportedLocale): boolean {
  const text = normalizedSpeech(spoken, locale);
  if (!/\b(?:wizard(?: s|s)? chess|wizarding chess|harry potter|ron weasley|hermione granger|hogwarts(?: chess)?|sorcer(?:er|or)(?: s|s)? stone|philosopher(?: s|s)? stone|xadrez (?:de )?(?:bruxo(?:s)?|harry potter)|pedra filosofal)\b/.test(text)) return false;
  if (/\b(?:don t|do not|not|never|nao|nunca|sem)\b/.test(text)) return false;
  if (/^(?:what|why|how|who|where|when|tell me about|explain|do you know|o que|por que|como|quem|onde|quando|me explique|voce sabe)\b/.test(text)) return false;
  return true;
}

/** Scene-only commands are checked before ordinary chess intent parsing. */
export function parseWizardChessVoiceAction(spoken: string, locale: SupportedLocale): WizardChessVoiceAction {
  const text = normalizedSpeech(spoken, locale);
  // Corrections and information questions need the conversational interpreter.
  // A word like "exit" in "don't exit; move Ron" must never run as a command.
  if (/\b(?:don t|do not|not|never|wait|hold|nao|nunca|espere|espera)\b/.test(text)) return 'unknown';
  if (/^(?:what|why|how|who|where|when|is|are|can i|could i|tell me|explain|o que|por que|como|quem|onde|quando|e|sao|posso|me diga|me explique)\b/.test(text)) return 'unknown';
  // Keep only unambiguous navigation on the fast path. Descriptions such as
  // "the exit button is red" are conversation, not an instruction to leave.
  const exit = /^(?:(?:please|now|okay|alright|can you|could you|would you|can we|could we|let s|i want to|i d like to|go|take me)\s+)*(?:exit|leave|quit|stop|cancel|back to normal|normal chess|end (?:the )?scene|sair|saia|parar|pare|cancelar|cancele|xadrez normal|voltar ao normal|encerrar a cena)\b/.test(text);
  const skip = /^(?:(?:please|now|okay|alright|can you|could you|would you|can we|could we|let s|i want to|i d like to)\s+)*(?:skip|fast forward|jump to|go to (?:the )?(?:move|end)|cut to (?:the )?move|just let me (?:move|play)|pular|pule|avancar|avance|ir para (?:a )?jogada|ir para o lance)\b/.test(text);
  const hint = /^(?:(?:please|now|can you|could you|would you|give me|show me|i need|i want|i d like|me de|quero|preciso de)\s+)*(?:a\s+)?(?:hint|clue|help|dica|ajuda|ajude)\b/.test(text);
  const h3 = /\b(?:h\s*(?:3|three|tree|tres)|aitch\s*(?:3|three|tree|tres))\b/.exec(text);
  if (h3) {
    // If H3 is named as the source, or another square follows it as a likely
    // destination, let the semantic interpreter resolve the whole utterance.
    if (/\b(?:from|off|away from|out of|de|do|da|fora de)\s+(?:the\s+)?(?:square\s+)?$/.test(text.slice(0, h3.index))) return 'unknown';
    if (/\b[a-h]\s*(?:[1-8]|one|two|three|four|five|six|seven|eight|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito)\b/.test(text.slice(h3.index + h3[0].length))) return 'unknown';
    const standalone = /^(?:h\s*(?:3|three|tree|tres)|aitch\s*(?:3|three|tree|tres))(?: please)?$/.test(text);
    // A clear spoken move wins over conversational framing such as "help me"
    // or "skip ahead and move". Descriptions still use the interpreter.
    const directRequest = /^(?:(?:please|now|okay|alright|then|let s|can you|could you|would you|i want to|i d like to|help me|skip ahead and|skip and)\s+)*(?:move|play|send|put|place|push|go|mova|mover|jogue|joga|jogar|coloque|ponha|leve)\b(?!\s+of\b)/.test(text)
      || /^(?:ron|knight|night|horse|cavalo)\s+(?:move|go|mova|vai)\b/.test(text);
    const shortCommand = /^(?:(?:ron(?: s)?(?: knight)?|(?:my |the )?(?:knight|night|horse|cavalo)|g\s*(?:5|five|cinco)|gee\s*(?:5|five|cinco))\s+(?:(?:from|de)\s+(?:g\s*(?:5|five|cinco)|gee\s*(?:5|five|cinco))\s+)?(?:(?:to|on|at|into|para|em)\s+)?)(?:h\s*(?:3|three|tree|tres)|aitch\s*(?:3|three|tree|tres))(?: please)?$/.test(text);
    const otherPiece = /\b(?:queen|bishop|rook|pawn|king|rainha|dama|bispo|torre|peao|rei)\b/.test(text);
    if ((standalone || directRequest || shortCommand) && (exit || otherPiece)) return 'unknown';
    if (standalone || directRequest || shortCommand) return 'final';
  }
  if (exit) return 'exit';
  if (skip) return 'skip';
  if (hint) return 'hint';
  return 'unknown';
}
