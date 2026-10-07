import type { ChessPieceType } from '../../shared/chess-protocol';
import type { WizardChessCharacter } from '../../shared/wizard-chess-scene';

/** Inline, fixed SVGs keep the Wizard board recognizable when WebGL or GLBs fail. */
const figures: Readonly<Record<ChessPieceType | WizardChessCharacter, string>> = {
  p: '<path d="M21 53c0-9 4-16 11-18 7 2 11 9 11 18H21ZM25 25l-3-5 2-9 8-5 8 5 2 9-3 5-7 5-7-5Z"/><path d="M21 19h22M28 11v8m8-8v8M15 55h34" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>',
  n: '<path d="M15 54h34v-7l-8-8c3-7 6-14 1-19L29 7l-4 9-10 4 2 9 12 1-8 9-6 15Z"/><path d="m29 12 8 8-8 8M14 55h37" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><circle cx="24" cy="23" r="2.2" fill="var(--wizard-eye,#dd9c5d)"/>',
  b: '<path d="M20 54c1-12 2-19 7-25l-4-9 9-14 9 14-4 9c5 6 6 13 7 25H20Z"/><path d="M31 15v17m-9 6h20M14 55h36" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M45 12v41m-4-41h8" fill="none" stroke="var(--wizard-metal,#cd9860)" stroke-width="2.5"/>',
  r: '<path d="M17 54V22h5V9h6v7h8V9h6v13h5v32H17Z"/><path d="M15 22h34M22 31h20M23 55h18M31 33v15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M30 40h4v8h-4z" fill="var(--wizard-eye,#dd9c5d)"/>',
  q: '<path d="M16 20 23 29l8-15 8 15 9-9-5 33H21l-5-33ZM19 54h27"/><path d="M20 35h24M25 46h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><circle cx="16" cy="17" r="3"/><circle cx="32" cy="12" r="3"/><circle cx="48" cy="17" r="3"/>',
  k: '<path d="M17 54 22 27l-5-6 6-10 9 7 9-7 6 10-5 6 5 27H17Z"/><path d="M20 28h24M19 55h26M32 7v16M26 13h12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/><path d="M27 36h10l-1 12h-8l-1-12Z" fill="var(--wizard-eye,#dd9c5d)"/>',
  ron: '<path d="M12 55c1-12 8-19 20-19s19 7 20 19H12Z" fill="currentColor"/><ellipse cx="32" cy="25" rx="12" ry="14" fill="#ebbb98"/><path d="M18 25c-2-13 6-20 14-20 10 0 16 8 14 20l-5-7-8-3-11 8-4 2Z" fill="#af4f29"/><path d="M25 27h3m8 0h3M29 33c2 2 4 2 6 0" fill="none" stroke="#5f382b" stroke-width="1.7" stroke-linecap="round"/><path d="m24 40 8 8 8-8" fill="none" stroke="#d7ab64" stroke-width="2"/>',
  hermione: '<path d="M11 55c2-11 8-18 21-18s19 7 21 18H11Z" fill="currentColor"/><path d="M17 22C14 7 22 4 32 4s19 6 16 20l3 26-11-8-17 1-10 7 4-28Z" fill="#704528"/><ellipse cx="32" cy="25" rx="11" ry="14" fill="#e6b590"/><path d="M21 17c6 2 13-7 22 0M25 27h3m8 0h3M29 33c2 2 4 2 6 0" fill="none" stroke="#64402d" stroke-width="1.7" stroke-linecap="round"/><path d="m23 42 9 8 9-8" fill="none" stroke="#cda56d" stroke-width="2"/>',
  harry: '<path d="M12 55c1-12 8-19 20-19s19 7 20 19H12Z" fill="currentColor"/><ellipse cx="32" cy="25" rx="12" ry="14" fill="#e9bc97"/><path d="m18 21 4-12 8 4 6-9 6 9 6 3-2 8-6-6-9-1-9 7-4-3Z" fill="#262025"/><path d="M20 26h8m8 0h8m-16 0 8 0" fill="none" stroke="#1c2430" stroke-width="1.7"/><circle cx="26" cy="27" r="4.2" fill="none" stroke="#1c2430" stroke-width="1.8"/><circle cx="38" cy="27" r="4.2" fill="none" stroke="#1c2430" stroke-width="1.8"/><path d="M29 34c2 2 4 2 6 0m-4-22 4-5" fill="none" stroke="#80523c" stroke-width="1.5" stroke-linecap="round"/><path d="m24 40 8 9 8-9" fill="none" stroke="#d5b379" stroke-width="2"/>',
};

export function wizardPieceArt(piece: ChessPieceType,
  character: WizardChessCharacter | null): string {
  const figure = figures[character ?? piece];
  return `<svg viewBox="0 0 64 64" role="presentation" aria-hidden="true" focusable="false">${figure}</svg>`;
}
