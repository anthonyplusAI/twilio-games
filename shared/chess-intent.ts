import type { SupportedLocale } from './i18n/locales';
import { normalizeForMatching } from './i18n/translate';
import type { ChessCastleSide, ChessFile, ChessMoveRecord, ChessPieceType, ChessSquare } from './chess-protocol';

export interface ChessMoveQuery {
  piece?: ChessPieceType;
  from?: ChessSquare;
  /** A spoken file/column narrows the source without inventing a rank. */
  fromFile?: ChessFile;
  to?: ChessSquare;
  promotion?: ChessPieceType;
  captureOnly?: boolean;
  castle?: ChessCastleSide | null;
}

export type ChessIntent =
  | { kind: 'move'; query: ChessMoveQuery }
  | { kind: 'select'; piece?: ChessPieceType; from?: ChessSquare; fromFile?: ChessFile }
  | { kind: 'confirm' }
  | { kind: 'cancel' }
  | { kind: 'reset' }
  | { kind: 'help' }
  | { kind: 'unknown' };

const PIECE_WORDS: ReadonlyArray<readonly [ChessPieceType, readonly string[]]> = [
  ['p', ['pawn', 'peao']],
  ['n', ['knight', 'night', 'horse', 'cavalo']],
  ['b', ['bishop', 'bispo']],
  ['r', ['rook', 'castle piece', 'torre']],
  ['q', ['queen', 'rainha', 'dama']],
  ['k', ['king', 'rei']],
];

const RANK_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['one', '1'], ['two', '2'], ['three', '3'], ['four', '4'],
  ['five', '5'], ['six', '6'], ['seven', '7'], ['eight', '8'],
  ['um', '1'], ['uma', '1'], ['dois', '2'], ['duas', '2'],
  ['tres', '3'], ['quatro', '4'], ['cinco', '5'], ['seis', '6'],
  ['sete', '7'], ['oito', '8'],
  // Relay may transcribe a spoken coordinate as an ordinary word. These are only
  // interpreted as ranks when they follow a file letter in spokenSquares().
  ['too', '2'], ['to', '2'], ['for', '4'], ['ate', '8'],
];

const FILE_WORDS: Readonly<Record<string, ChessFile>> = {
  a: 'a', ay: 'a', b: 'b', bee: 'b', be: 'b', c: 'c', see: 'c', sea: 'c',
  d: 'd', dee: 'd', e: 'e', ee: 'e', f: 'f', eff: 'f', g: 'g', gee: 'g', ge: 'g',
  h: 'h', aitch: 'h',
};
const RANK_BY_WORD = new Map(RANK_WORDS);
const FILE_MARKERS = new Set(['file', 'column', 'coluna']);
const SOURCE_PREPOSITIONS = new Set(['from', 'on', 'at', 'in', 'de', 'da', 'do', 'em', 'na', 'no']);
const SOURCE_ARTICLES = new Set(['the', 'my', 'a', 'o', 'um', 'uma']);
const DESTINATION_PREPOSITIONS = new Set(['to', 'toward', 'towards', 'into', 'onto', 'para', 'pra']);
const FILE_SPOKEN_FORM = Object.keys(FILE_WORDS).sort((a, b) => b.length - a.length).join('|');
const RANK_SPOKEN_FORM = [...RANK_BY_WORD.keys()].sort((a, b) => b.length - a.length).join('|');
const SQUARE_SPOKEN_FORM = `(?:[a-h][1-8]|(?:${FILE_SPOKEN_FORM})\\s+(?:[1-8]|${RANK_SPOKEN_FORM}))`;
const GENERIC_DESTINATION = new RegExp(
  `^(?:(?:please|por favor)\\s+)?(?:(?:move|play|go|put|place|send|push|advance|mova|mover|joga|jogar|coloque|ponha|avance|vai)\\s+)?(?:(?:to|toward|towards|into|onto|para|pra)\\s+)?${SQUARE_SPOKEN_FORM}(?:\\s+(?:please|por favor))?$`,
);
const GENERIC_SOURCE = new RegExp(
  `^(?:(?:please|por favor)\\s+)?(?:from|on|at|de|da casa|do quadrado|em|na casa|no quadrado)\\s+${SQUARE_SPOKEN_FORM}(?:\\s+(?:please|por favor))?$`,
);
const GENERIC_COORDINATE_MOVE = new RegExp(
  `^(?:(?:please|por favor)\\s+)?(?:(?:move|play|mova|mover|joga|jogar)\\s+)?(?:(?:from|de|da casa|do quadrado)\\s+)?${SQUARE_SPOKEN_FORM}\\s+(?:(?:to|toward|towards|para|pra)\\s+)?${SQUARE_SPOKEN_FORM}(?:\\s+(?:please|por favor))?$`,
);

function findPiece(text: string): ChessPieceType | undefined {
  const padded = ` ${text} `;
  let earliest: { piece: ChessPieceType; index: number } | null = null;
  for (const [piece, words] of PIECE_WORDS) {
    for (const word of words) {
      const index = padded.indexOf(` ${word} `);
      if (index >= 0 && (!earliest || index < earliest.index)) earliest = { piece, index };
    }
  }
  return earliest?.piece;
}

const PIECE_SPOKEN_FORM = '(?:pawn|peao|knight|night|horse|cavalo|bishop|bispo|rook|castle piece|torre|queen|rainha|dama|king|rei)';
const PIECE_DETERMINER = '(?:(?:the|my|this|that|our|a|o|a|minha|meu|essa|esse)\\s+)?';
const PIECE_ONLY = new RegExp(`^${PIECE_DETERMINER}${PIECE_SPOKEN_FORM}(?:\\s+(?:please|por favor))?$`);
const PIECE_AT_SQUARE = new RegExp(
  `^${PIECE_DETERMINER}${PIECE_SPOKEN_FORM}(?:\\s+(?:on|at|from|in|em|na casa|no quadrado|de|da casa|do quadrado))?\\s+${SQUARE_SPOKEN_FORM}(?:\\s+(?:please|por favor))?$`,
);
const PIECE_COMMAND = new RegExp(
  `^(?:(?:use|move|play|pick|choose|vamos mover|mova|mover|joga|jogar|use o|use a)\\s+)${PIECE_DETERMINER}${PIECE_SPOKEN_FORM}(?:\\s+(?:please|por favor))?$`,
);

function isPieceSelection(spoken: string): boolean {
  return PIECE_ONLY.test(spoken) || PIECE_COMMAND.test(spoken);
}

function spokenSquares(text: string): ChessSquare[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  const squares: ChessSquare[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (/^[a-h][1-8]$/.test(token)) { squares.push(token as ChessSquare); continue; }
    const file = FILE_WORDS[token];
    const next = tokens[index + 1];
    const rank = next && (/^[1-8]$/.test(next) ? next : RANK_BY_WORD.get(next));
    if (file && rank) { squares.push(`${file}${rank}` as ChessSquare); index++; }
  }
  return squares;
}

function startsSquare(tokens: readonly string[], index: number): boolean {
  const token = tokens[index];
  if (!token) return false;
  if (/^[a-h][1-8]$/.test(token)) return true;
  const rank = tokens[index + 1];
  return Boolean(FILE_WORDS[token] && rank && (/^[1-8]$/.test(rank) || RANK_BY_WORD.has(rank)));
}

/** A file name next to "to" is a source hint, not the homophone B-two. */
function sourceFileHint(text: string): { text: string; fromFile?: ChessFile; conflicting: boolean } {
  const tokens = text.split(/\s+/).filter(Boolean);
  const removed = new Set<number>();
  let fromFile: ChessFile | undefined;
  let conflicting = false;
  const prefixStart = (index: number): number => {
    let start = index;
    if (start > 0 && SOURCE_ARTICLES.has(tokens[start - 1]!)) start--;
    if (start > 0 && SOURCE_PREPOSITIONS.has(tokens[start - 1]!)) start--;
    return start;
  };
  const remember = (file: ChessFile, start: number, end: number): void => {
    if (fromFile && fromFile !== file) conflicting = true;
    fromFile = file;
    for (let index = start; index <= end; index++) removed.add(index);
  };

  // Explicit "B file", "file B", and "coluna B" cues may precede the piece:
  // "B-file knight to C3" is a natural way to disambiguate two knights.
  for (let index = 0; index < tokens.length; index++) {
    const file = FILE_WORDS[tokens[index]!];
    if (!file) continue;
    const markerBefore = index > 0 && FILE_MARKERS.has(tokens[index - 1]!);
    const markerAfter = FILE_MARKERS.has(tokens[index + 1]!);
    if (!markerBefore && !markerAfter) continue;
    const start = prefixStart(markerBefore ? index - 1 : index);
    const end = markerAfter ? index + 1 : index;
    const remaining = tokens.filter((_, tokenIndex) => tokenIndex < start || tokenIndex > end).join(' ');
    if (spokenSquares(remaining).length > 0 || findPiece(remaining)) remember(file, start, end);
  }

  // A bare letter needs a source preposition or a named piece, followed by an
  // immediate destination. The extra square check preserves "E to to E four"
  // as E2-E4; explicit "two" and "too" remain rank-two source coordinates.
  for (let index = 0; index < tokens.length; index++) {
    const file = FILE_WORDS[tokens[index]!];
    if (!file || removed.has(index)) continue;
    const start = prefixStart(index);
    const sourcePreposition = start < index && SOURCE_PREPOSITIONS.has(tokens[start]!);
    const namedPieceBefore = !!findPiece(tokens.slice(0, index).join(' '));
    if (!sourcePreposition && !namedPieceBefore) continue;
    const following = tokens[index + 1];
    const destinationFollows = DESTINATION_PREPOSITIONS.has(following!) && startsSquare(tokens, index + 2);
    const sourceOnly = index === tokens.length - 1
      || (following === 'please' && index === tokens.length - 2);
    if (!destinationFollows && !sourceOnly) continue;
    remember(file, start, index);
  }

  return { text: tokens.filter((_, index) => !removed.has(index)).join(' '),
    ...(fromFile ? { fromFile } : {}), conflicting };
}

export function parseChessIntent(spoken: string, locale: SupportedLocale = 'en-US'): ChessIntent {
  const normalized = normalizeForMatching(spoken, locale).replace(/[-']/g, ' ').trim();
  // Relay passes polite requests as ordinary prompts. Keep common action
  // framing on the low-latency path; inquiries remain read-only below.
  const text = normalized
    .replace(/^(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?(?=(?:move|play|castle|make|put|send|push)\b)/, '')
    .replace(/^(?:por favor\s+)?(?:voce pode|pode)\s+(?:por favor\s+)?(?=(?:mover|mova|jogar|joga|fazer|faca)\b)/, '');
  if (!text) return { kind: 'unknown' };

  if (/^(?:confirm|confirm move|yes|yes confirm|make the move|do it|confirmar|confirma|confirmo|sim|pode jogar)$/.test(text)
    || /^(?:yes|yeah|yep|sim)\b.*\b(?:confirm|make|do|play|go ahead|confirma|confirmar|joga|jogar)\b/.test(text)) {
    return { kind: 'confirm' };
  }
  if (/^(?:cancel|cancel move|no|no cancel|never mind|nevermind|forget it|cancelar|cancela|nao|nao quero|deixa pra la)$/.test(text)
    || /^(?:actually |please )?(?:cancel|cancela|cancelar)\b.*\b(?:that|move|one|isso|jogada|lance)$/.test(text)) {
    return { kind: 'cancel' };
  }
  if (/^(?:play again|new game|restart|restart game|another game|jogar de novo|jogue de novo|nova partida|novo jogo|recomecar)$/.test(text)) {
    return { kind: 'reset' };
  }
  if (/^(?:help|how do i play|what can i say|ajuda|como jogar|o que posso dizer)$/.test(text)) {
    return { kind: 'help' };
  }

  // A self-correction replaces the earlier destination. Retain an explicit source
  // and piece only when the replacement did not name its own piece/source.
  const corrections = [...text.matchAll(/\b(?:no|actually|sorry|nao|corrigindo|quer dizer|i mean|i meant|na verdade)\b/g)]
    .reverse().filter(match => match.index > 0);
  for (const correction of corrections) {
    const before = text.slice(0, correction.index);
    const after = text.slice(correction.index! + correction[0].length).trim();
    const revised = parseChessIntent(after, locale);
    if (revised.kind === 'move' && revised.query.to) {
      const previousPiece = findPiece(before);
      const previous = parseChessIntent(before, locale);
      const previousQuery = previous.kind === 'move' ? previous.query : null;
      if (!previousQuery?.to) continue;
      return { kind: 'move', query: {
        ...revised.query,
        ...(revised.query.piece || !previousPiece ? {} : { piece: previousPiece }),
        ...(revised.query.from || revised.query.fromFile || revised.query.piece ? {} :
          previousQuery.from ? { from: previousQuery.from } :
            previousQuery.fromFile ? { fromFile: previousQuery.fromFile } : {}),
      } };
    }
    if (revised.kind !== 'unknown' && revised.kind !== 'move'
      && parseChessIntent(before, locale).kind !== 'unknown') return revised;
  }

  if (/^(?:what|how|why|where|when|is|are|if|could i|should i|can i|may i|can my|could my|would my|tell me|explain|could you|would you|do you|i want to know|i wonder|o que|como|qual|se eu|posso|devo|eu quero saber|me explique|explique)\b/.test(text)
    || /\b(?:wonder if|whether|quero saber se)\b/.test(text)
    || /\b(?:do not|don t|dont|not|never|nao|sem)\b/.test(text)) return { kind: 'unknown' };

  const castleCommand = /^(?:(?:please|por favor)\s+)?(?:castle|castling|roque)(?:\s+(?:kingside|king side|queenside|queen side|short|long|pequeno|grande|lado da dama|lado do rei))?(?:\s+(?:please|por favor))?$/.test(text)
    || /^o o(?: o)?$/.test(text);
  if (castleCommand && !/\bcastle piece\b/.test(text)) {
    const side: ChessCastleSide | null = /\b(?:queenside|queen side|long|grande|lado da dama)\b|^o o o$/.test(text)
      ? 'queen'
      : /\b(?:kingside|king side|short|pequeno|lado do rei)\b|^o o$/.test(text)
        ? 'king'
        : null;
    return { kind: 'move', query: { castle: side } };
  }

  const promotionStart = text.search(/\b(?:promote|promotion|promover|promocao|virar|transformar)\b/);
  const moveText = promotionStart >= 0 ? text.slice(0, promotionStart).trim() : text;
  const promotionText = promotionStart >= 0 ? text.slice(promotionStart) : '';
  const promotion = findPiece(promotionText);
  const piece = findPiece(moveText);
  const source = sourceFileHint(moveText);
  if (source.conflicting) return { kind: 'unknown' };
  const squares = spokenSquares(source.text);
  const captureOnly = /\b(?:capture|captures|capturing|take|takes|taking|captura|capturar|capturei|toma|tomar|come|comer)\b/.test(moveText);
  const selecting = /^(?:select|choose|pick|selecionar|selecione|seleciona|escolher|escolha|escolhe)\b/.test(moveText);

  if (selecting && !(source.fromFile && squares.length === 1
    && /\b(?:to|toward|towards|into|onto|para|pra)\b/.test(source.text))) {
    if (squares.length === 1) return { kind: 'select', from: squares[0],
      ...(piece ? { piece } : {}), ...(source.fromFile ? { fromFile: source.fromFile } : {}) };
    if (piece) return { kind: 'select', piece, ...(source.fromFile ? { fromFile: source.fromFile } : {}) };
    return { kind: 'unknown' };
  }
  if (squares.length === 0 && source.fromFile && piece && isPieceSelection(source.text))
    return { kind: 'select', piece, fromFile: source.fromFile };
  if (squares.length === 0 && piece && isPieceSelection(moveText)) return { kind: 'select', piece };
  // Relay can finalize a sentence while the caller is still thinking about the
  // destination. A source-only utterance must select the piece; the room keeps
  // that selection until the caller eventually names a destination or cancels.
  const explicitSource = /\b(?:from|starting at|starting on|de|da casa|do quadrado)\b/.test(moveText);
  const positionedPiece = locale === 'pt-BR'
    ? /\b(?:na casa|no quadrado|em)\b/.test(moveText)
      && !captureOnly && !/\b(?:mova|mover|joga|jogar|coloque|ponha|avance|vai|para|pra)\b/.test(moveText)
    : /\b(?:on|at)\b/.test(moveText)
      && !captureOnly && !/\b(?:move|put|place|send|push|play|to|toward|towards|into|onto)\b/.test(moveText);
  const clearAction = /\b(?:move|play|put|place|send|push|advance|capture|captures|take|takes|mova|mover|joga|jogar|coloque|ponha|avance|captura|capturar|tomar)\b/.test(moveText);
  const clearDestination = /\b(?:to|toward|towards|into|onto|para|pra)\b/.test(source.text);
  if (squares.length === 1 && !source.fromFile && piece && !clearAction && !clearDestination
    && !PIECE_AT_SQUARE.test(moveText)) return { kind: 'unknown' };
  if (squares.length === 1 && !piece && !source.fromFile
    && !GENERIC_DESTINATION.test(moveText) && !GENERIC_SOURCE.test(moveText)) return { kind: 'unknown' };
  if (squares.length === 2 && !piece && !source.fromFile
    && !GENERIC_COORDINATE_MOVE.test(moveText)) return { kind: 'unknown' };
  if (squares.length === 1 && !source.fromFile && (explicitSource || positionedPiece)) {
    return { kind: 'select', from: squares[0], ...(piece ? { piece } : {}) };
  }
  if (squares.length === 0 || squares.length > 2) return { kind: 'unknown' };

  const query: ChessMoveQuery = {
    ...(piece ? { piece } : {}),
    ...(squares.length === 2 ? { from: squares[0] } : {}),
    ...(source.fromFile ? { fromFile: source.fromFile } : {}),
    to: squares[squares.length - 1],
    ...(promotion ? { promotion } : {}),
    ...(captureOnly ? { captureOnly: true } : {}),
  };
  return { kind: 'move', query };
}

const EN_PIECES: Record<ChessPieceType, string> = {
  p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king',
};
const PT_PIECES: Record<ChessPieceType, string> = {
  p: 'peão', n: 'cavalo', b: 'bispo', r: 'torre', q: 'dama', k: 'rei',
};

function saySquare(square: ChessSquare, locale: SupportedLocale): string {
  const number = Number(square[1]);
  const rank = locale === 'pt-BR'
    ? ['um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito'][number - 1]
    : ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'][number - 1];
  return `${square[0]?.toUpperCase()} ${rank}`;
}

/** Spoken move text for the caller, including captured pieces and check. */
export function describeChessMove(move: ChessMoveRecord, locale: SupportedLocale = 'en-US'): string {
  const own = move.actor === 'human';
  const target = saySquare(move.to, locale);
  const source = saySquare(move.from, locale);
  if (locale === 'pt-BR') {
    const piece = PT_PIECES[move.piece];
    const opening = move.castle
      ? (own ? `Você fez roque ${move.castle === 'king' ? 'pequeno' : 'grande'}.` : `O rival fez roque ${move.castle === 'king' ? 'pequeno' : 'grande'}.`)
      : move.captured
        ? (own
          ? `Seu ${piece} captura o ${PT_PIECES[move.captured]} rival em ${target}.`
          : `O ${piece} rival captura seu ${PT_PIECES[move.captured]} em ${target}.`)
        : (own ? `Seu ${piece} vai de ${source} para ${target}.` : `O ${piece} rival vai de ${source} para ${target}.`);
    const promoted = move.promotion ? ` O peão vira ${PT_PIECES[move.promotion]}.` : '';
    return `${opening}${promoted}${move.checkmate ? ' Xeque-mate!' : move.check ? ' Xeque!' : ''}`;
  }
  const piece = EN_PIECES[move.piece];
  const opening = move.castle
    ? (own ? `You castle ${move.castle === 'king' ? 'kingside' : 'queenside'}.` : `The rival castles ${move.castle === 'king' ? 'kingside' : 'queenside'}.`)
    : move.captured
      ? (own
        ? `Your ${piece} captures their ${EN_PIECES[move.captured]} on ${target}.`
        : `The rival's ${piece} captures your ${EN_PIECES[move.captured]} on ${target}.`)
      : (own ? `Your ${piece} moves from ${source} to ${target}.` : `The rival moves a ${piece} from ${source} to ${target}.`);
  const promoted = move.promotion ? ` The pawn becomes a ${EN_PIECES[move.promotion]}.` : '';
  return `${opening}${promoted}${move.checkmate ? ' Checkmate!' : move.check ? ' Check!' : ''}`;
}
