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
  ['n', ['knight', 'horse', 'cavalo']],
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
];

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
  const numbered = RANK_WORDS.reduce(
    (current, [word, digit]) => current.replace(new RegExp(`\\b${word}\\b`, 'g'), digit), text,
  );
  return [...numbered.matchAll(/\b([a-h])\s*([1-8])\b/g)].map(match => `${match[1]}${match[2]}` as ChessSquare);
}

export function parseChessIntent(spoken: string, locale: SupportedLocale = 'en-US'): ChessIntent {
  const text = normalizeForMatching(spoken, locale).replace(/[-']/g, ' ').trim();
  if (!text) return { kind: 'unknown' };

  if (/^(?:confirm|confirm move|yes|yes confirm|make the move|do it|confirmar|confirma|confirmo|sim|pode jogar)$/.test(text)) {
    return { kind: 'confirm' };
  }
  if (/^(?:cancel|cancel move|no|no cancel|never mind|nevermind|forget it|cancelar|cancela|nao|nao quero|deixa pra la)$/.test(text)) {
    return { kind: 'cancel' };
  }
  if (/^(?:play again|new game|restart|restart game|another game|jogar de novo|jogue de novo|nova partida|novo jogo|recomecar)$/.test(text)) {
    return { kind: 'reset' };
  }
  if (/^(?:help|how do i play|what can i say|ajuda|como jogar|o que posso dizer)$/.test(text)) {
    return { kind: 'help' };
  }

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
  if (squares.length === 1 && /\b(?:from|de|da casa|do quadrado)\s+[a-h]\s*[1-8]\b/.test(moveText)
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
