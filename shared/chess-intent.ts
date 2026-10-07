import type { SupportedLocale } from './i18n/locales';
import { normalizeForMatching } from './i18n/translate';
import type { ChessCastleSide, ChessMoveRecord, ChessPieceType, ChessSquare } from './chess-protocol';

export interface ChessMoveQuery {
  piece?: ChessPieceType;
  from?: ChessSquare;
  to?: ChessSquare;
  promotion?: ChessPieceType;
  captureOnly?: boolean;
  castle?: ChessCastleSide | null;
}

export type ChessIntent =
  | { kind: 'move'; query: ChessMoveQuery }
  | { kind: 'select'; piece?: ChessPieceType; from?: ChessSquare }
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

const FILE_WORDS: Readonly<Record<string, string>> = {
  a: 'a', ay: 'a', b: 'b', bee: 'b', be: 'b', c: 'c', see: 'c', sea: 'c',
  d: 'd', dee: 'd', e: 'e', ee: 'e', f: 'f', eff: 'f', g: 'g', gee: 'g', ge: 'g',
  h: 'h', aitch: 'h',
};
const RANK_BY_WORD = new Map(RANK_WORDS);

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

export function parseChessIntent(spoken: string, locale: SupportedLocale = 'en-US'): ChessIntent {
  const text = normalizeForMatching(spoken, locale).replace(/[-']/g, ' ').trim();
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
      const previousSquares = spokenSquares(before);
      if (!previousSquares.length) continue;
      return { kind: 'move', query: {
        ...revised.query,
        ...(revised.query.piece || !previousPiece ? {} : { piece: previousPiece }),
        ...(revised.query.from || revised.query.piece || previousSquares.length < 2
          || !/\b(?:from|de|da casa|do quadrado)\b/.test(before) ? {} : { from: previousSquares[0] }),
      } };
    }
    if (revised.kind !== 'unknown' && revised.kind !== 'move'
      && parseChessIntent(before, locale).kind !== 'unknown') return revised;
  }

  if (/^(?:what|how|why|where|when|if|could i|should i|can i|tell me|explain|could you|would you|do you|i want to know|i wonder|o que|como|qual|se eu|posso|devo|eu quero saber|me explique|explique)\b/.test(text)
    || /\b(?:wonder if|whether|quero saber se)\b/.test(text)
    || /\b(?:do not|don t|dont|not|never|nao|sem)\b/.test(text)) return { kind: 'unknown' };

  if (/\b(?:castle|castling|roque)\b/.test(text) || /^o o(?: o)?$/.test(text)) {
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
  const squares = spokenSquares(moveText);
  const selecting = /^(?:select|choose|pick|selecionar|selecione|seleciona|escolher|escolha|escolhe)\b/.test(moveText);

  if (selecting) {
    if (squares.length === 1) return { kind: 'select', from: squares[0] };
    if (piece) return { kind: 'select', piece };
    return { kind: 'unknown' };
  }
  if (squares.length === 0 && piece) return { kind: 'select', piece };
  if (squares.length === 1 && /\b(?:from|de|da casa|do quadrado)\b/.test(moveText)
    && !/\b(?:to|para|pra|em|on)\b/.test(moveText)) {
    return { kind: 'select', from: squares[0], ...(piece ? { piece } : {}) };
  }
  if (squares.length === 0 || squares.length > 2) return { kind: 'unknown' };

  const captureOnly = /\b(?:capture|captures|capturing|take|takes|taking|captura|capturar|capturei|toma|tomar|come|comer)\b/.test(moveText);
  const query: ChessMoveQuery = {
    ...(piece ? { piece } : {}),
    ...(squares.length === 2 ? { from: squares[0] } : {}),
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
