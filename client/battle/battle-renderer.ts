// The Game Boy battle SCREEN for Voice Monsters. Renders the classic boxed layout on a canvas in the
// DMG 4-shade palette: the enemy monster up-right (front-facing), your monster down-left, an HP box
// per side (name · Lv · HP bar), and the bottom command window (ATTACK / GUARD / ITEM / TAUNT + the
// 4-move list). Turn-based, so the monster whose turn it is faces the camera; here BOTH are always
// drawn (enemy front / you back) as in the originals, and we animate the attacker on each hit.
//
// Sprites: tries /assets/monsters/<id>_<view>.gif then .png (animated GIF wins when both exist);
// falls back to the procedural placeholder (monster-sprite.ts) so it's playable with zero art. Draws
// at an integer scale for crisp pixels.
import { typeMultiplier, type MonsterType } from '../../shared/monster-types';
import { moveById } from '../../shared/monster-roster';
import type { BattleSnapshot, BattleEvent } from '../../shared/battle-world';
import { accuracyPercent } from '../../shared/move-stats';
import { GB_SHADES, drawMonsterSprite, typeColor } from './monster-sprite';
import { AttackFx } from './attack-fx';
import { spriteCandidateUrls } from './sprite-sources';
import { ResolutionHp } from './resolution-hp';
import { effectivePips, fitMoveName } from './move-menu';
import { hpFraction, hpZone, hpColor } from './hp-bar';
import { DEFAULT_LOCALE, type SupportedLocale } from '../../shared/i18n/locales';
import { MONSTERS_MESSAGES, type MonstersMessageKey } from '../../shared/i18n/monsters';
import { createTranslator, type MessageValues } from '../../shared/i18n/translate';
import {
  BATTLE_HUD_RECTS,
  BATTLE_OUTCOME_RECTS,
  battleNameplateLines,
  outcomeBadgePresentation,
  outcomesBySide,
} from './battle-hud-layout';

// Logical GB resolution (160×144); we scale up to fill the element with nearest-neighbor crispness.
const GB_W = 160, GB_H = 144;
const [INK, DARK, LITE, PAPER] = GB_SHADES;   // darkest → lightest

// A sprite is either a procedural placeholder (drawn to the canvas) or a real loaded file (an <img>,
// which may be an animated GIF — shown as a live DOM element on the sprite layer, not canvas-drawn).
interface LoadedSprite { canvas: CanvasImageSource; w: number; h: number; img?: HTMLImageElement; }

/** The client-derived turn state that drives the bottom window (set by monsters.ts). */
export type UiPhase = 'idle' | 'awaiting-input' | 'command-locked' | 'resolving' | 'finished';
/** A move as shown in the command window (name + type + power for info). */
export interface MenuMove { name: string; type: string; power: number; }

export class BattleRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scale = 3;
  private sprites = new Map<string, LoadedSprite>();   // key: `${id}:${view}`
  private snap: BattleSnapshot | null = null;
  private menuMoves: MenuMove[] = [];                  // the local player's 4 moves (bottom window)
  private foeType: MonsterType | null = null;          // opponent's type → menu pips = effectiveness
  private menuView: 'root' | 'fight' = 'root';         // which command-window menu to draw
  private mySide: 'a' | 'b' = 'a';                      // the local player's side (for the ITEM count)
  private uiPhase: UiPhase = 'idle';                   // whose-turn state → what the window shows
  private statusLine = '';                             // persistent prompt ("What will X do?" / "Waiting…")
  private eventBanner = '';                            // transient event text ("It's super effective!")
  /** Transient per-side attack lunge (0..1 eased), keyed by side. Drives the "step forward" animation. */
  private lunge: { a: number; b: number } = { a: 0, b: 0 };
  private flash: { a: number; b: number } = { a: 0, b: 0 };   // hit-flash timer per side
  private shake = 0;   // screen-shake intensity (0..1, eased) — spiked by a crit hit
  private activeSide: 'a' | 'b' | null = null;   // whose turn it is → bobbing arrow over that monster
  private tick = 0;   // frame counter for cheap time-based bob/pulse animations
  /** Per-type attack FX layer drawn OVER the monsters (typed projectile on move_used + impact burst on
   *  damage) — see attack-fx.ts. Self-contained; the renderer just feeds it events + draws it. */
  private attackFx = new AttackFx();
  /** Per-side displayed HP during a paced resolution (so the two bars drop one hit at a time instead
   *  of both snapping to the settled snapshot at once). */
  private resHp = new ResolutionHp();
  private wasResolving = false;   // detects the idle↔resolving transition to begin/end the tracker
  private raf = 0;
  /** A DOM layer overlaid EXACTLY on the GB canvas that holds the real sprite <img> elements. Animated
   *  GIFs only advance their frames while the browser composits them as a VISIBLE <img> — drawing one
   *  to a canvas freezes it on frame 1. So real sprites live here as live <img>s positioned to match
   *  the canvas layout; only procedural placeholders take the canvas path. Sits above the canvas
   *  (z-index 3); sprites never overlap the HP boxes/command window, so no occlusion is lost. */
  private spriteLayer: HTMLElement;
  /** A DOM layer above the live GIF sprites, aligned to the same integer-scaled 160x144 screen. */
  private outcomeLayer: HTMLElement;
  private outcomeAnnouncer: HTMLElement;
  private outcomeBadges: Record<'a' | 'b', { root: HTMLElement; label: HTMLElement }>;
  private resizeObserver: ResizeObserver | null = null;
  /** The <img> currently shown on screen per side (so we can reposition/replace it each frame). */
  private shownImg: { a: HTMLImageElement | null; b: HTMLImageElement | null } = { a: null, b: null };
  private text: (key: MonstersMessageKey, values?: MessageValues) => string;

  constructor(private host: HTMLElement, private locale: SupportedLocale = DEFAULT_LOCALE) {
    this.text = createTranslator(locale, MONSTERS_MESSAGES);
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', this.text('access.battleCanvas'));
    // Layered ON TOP of the 3D arena canvas (which the host also holds). Transparent in the battle
    // area so the spinning arena shows through behind the monsters; the HP boxes + command window are
    // opaque panels drawn over it. z-index sits above the arena.
    this.canvas.style.cssText = 'image-rendering:pixelated;position:absolute;inset:0;margin:auto;z-index:2';
    host.appendChild(this.canvas);
    // Sprite layer: same absolute-centering as the canvas so device-pixel coords line up 1:1.
    this.spriteLayer = document.createElement('div');
    this.spriteLayer.setAttribute('aria-hidden', 'true');
    this.spriteLayer.style.cssText = 'position:absolute;inset:0;margin:auto;z-index:3;pointer-events:none;overflow:visible';
    host.appendChild(this.spriteLayer);
    this.outcomeLayer = document.createElement('div');
    this.outcomeLayer.className = 'battle-outcome-layer';
    this.outcomeLayer.style.cssText = 'position:absolute;inset:0;margin:auto;z-index:4;pointer-events:none;overflow:visible';
    this.outcomeAnnouncer = document.createElement('div');
    this.outcomeAnnouncer.className = 'battle-outcome-announcer';
    this.outcomeAnnouncer.setAttribute('role', 'status');
    this.outcomeAnnouncer.setAttribute('aria-live', 'polite');
    this.outcomeAnnouncer.setAttribute('aria-atomic', 'true');
    this.outcomeLayer.appendChild(this.outcomeAnnouncer);
    this.outcomeBadges = {
      a: this.createOutcomeBadge('a'),
      b: this.createOutcomeBadge('b'),
    };
    host.appendChild(this.outcomeLayer);
    this.ctx = this.canvas.getContext('2d')!;
    this.resize();
    window.addEventListener('resize', () => this.resize());
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(host);
    }
    this.loop();
  }

  /** Fit an integer scale of the 160×144 GB screen into the host, keeping pixels crisp. */
  private resize(): void {
    const maxW = this.host.clientWidth || 640, maxH = this.host.clientHeight || 576;
    this.scale = Math.max(2, Math.floor(Math.min(maxW / GB_W, maxH / GB_H)));
    this.canvas.width = GB_W * this.scale;
    this.canvas.height = GB_H * this.scale;
    this.ctx.imageSmoothingEnabled = false;
    // Match the sprite layer to the canvas's on-screen box so GB-logical coords map 1:1 to CSS px.
    this.spriteLayer.style.width = `${GB_W * this.scale}px`;
    this.spriteLayer.style.height = `${GB_H * this.scale}px`;
    this.outcomeLayer.style.width = `${GB_W * this.scale}px`;
    this.outcomeLayer.style.height = `${GB_H * this.scale}px`;
    for (const side of ['a', 'b'] as const) {
      const rect = BATTLE_OUTCOME_RECTS[side];
      const badge = this.outcomeBadges[side].root;
      badge.style.left = `${rect.x * this.scale}px`;
      badge.style.top = `${rect.y * this.scale}px`;
      badge.style.width = `${rect.width}px`;
      badge.style.height = `${rect.height}px`;
      badge.style.transform = `scale(${this.scale})`;
    }
  }

  /** Point the renderer at the current battle state, the local player's moves, the turn state, and
   *  the persistent status line. The bottom window branches on uiPhase (menu only when it's your
   *  turn; a "waiting" line when locked; just the event banner while resolving). */
  setState(snap: BattleSnapshot | null, myMoves: MenuMove[], uiPhase: UiPhase, statusLine: string, foeType: MonsterType | null = null): void {
    // Begin/end the paced-HP tracker on the resolving transition. Seed pre-turn HP from the CURRENT
    // snapshot (still pre-turn: events arrive before the settled state), so bars start where the turn
    // began and step down per damage event instead of snapping to the settled HP together.
    const resolving = uiPhase === 'resolving';
    if (resolving && !this.wasResolving && this.snap) this.resHp.begin(this.snap.a.hp, this.snap.b.hp);
    else if (!resolving && this.wasResolving) this.resHp.end();
    this.wasResolving = resolving;

    this.snap = snap;
    this.menuMoves = myMoves;
    this.uiPhase = uiPhase;
    this.statusLine = statusLine;
    this.foeType = foeType;   // the opponent's type → menu pips show effectiveness vs THIS foe
    // A live, unfinished battle with both sides up → clear any prior faint/win flourish (rematch).
    if (!snap || (!snap.winner && snap.a.hp > 0 && snap.b.hp > 0)) {
      this.faintedSide = null;
      this.winnerSide = null;
    }
    this.renderOutcomeBadges();
    if (snap) { this.ensureSprite(snap.a.monsterId, snap.a.type, 'back'); this.ensureSprite(snap.b.monsterId, snap.b.type, 'front'); }
  }

  /** Transient event text (move name / super-effective / faint); cleared when resolution settles. */
  setEventBanner(text: string): void { this.eventBanner = text; }

  /** Which side is currently acting (drives a turn-indicator arrow over the active monster). null in
   *  menus / when settled. */
  setActiveSide(side: 'a' | 'b' | null): void { this.activeSide = side; }

  /** Which command-window menu to draw ('root' = FIGHT/GUARD/ITEM/TAUNT, 'fight' = the 4 moves) and
   *  the local player's side (for the ITEM Potion count). Driven by the orchestrator's menu nav. */
  setMenu(view: 'root' | 'fight', mySide: 'a' | 'b'): void { this.menuView = view; this.mySide = mySide; }

  /** Play an event's animation cue: attacker lunges, defender flashes + its HP bar steps down to this
   *  hit's remaining HP (so the two bars drop one hit at a time during resolution). A crit shakes the
   *  screen and flashes harder. */
  playEvent(ev: BattleEvent): void {
    if (ev.kind === 'move_used') {
      this.lunge[ev.by] = 1;
      // Events carry no type → look the move up to theme the FX by its element (fire ≠ water ≠ …).
      // Remember it too, so the following `damage` event's impact burst matches this move.
      this.lastMoveType = moveById(ev.moveId)?.type ?? 'normal';
      this.attackFx.trigger(this.lastMoveType, ev.by, ev.by === 'a' ? 'b' : 'a');   // launch typed FX at the foe
    } else if (ev.kind === 'damage') {
      this.flash[ev.on] = 1; this.resHp.hit(ev.on, ev.hpLeft);
      this.attackFx.impact(this.lastMoveType, ev.on);   // impact burst themed by the move that just landed
      if (ev.crit) this.shake = 1;   // extra punch on a critical hit
    } else if (ev.kind === 'block') {
      this.flash[ev.on] = 0.4;
      this.attackFx.impact(this.lastMoveType, ev.on);
    } else if (ev.kind === 'heal') {
      this.resHp.hit(ev.on, ev.hpLeft);   // guard/potion heal → the bar rises to the new HP mid-resolution
    } else if (ev.kind === 'faint') {
      this.faintedSide = ev.side;
      this.renderOutcomeBadges();
    } else if (ev.kind === 'battle_over') {
      this.winnerSide = ev.winner;
      this.renderOutcomeBadges();
    }
  }
  private lastMoveType: string = 'normal';   // type of the most recent move_used → drives the impact FX
  private faintedSide: 'a' | 'b' | null = null;
  private winnerSide: 'a' | 'b' | null = null;

  /** Load a real sprite if present, else keep the synthesized placeholder. Cached per id+view. Tries
   *  an animated GIF first, then a static PNG (spriteCandidateUrls order); the first that loads wins.
   *  A loaded GIF animates because render() redraws it every frame (drawImage grabs the current
   *  frame) — but a detached <img> is paused in some browsers, so we park it offscreen in the DOM to
   *  keep its animation clock running. */
  private ensureSprite(id: string, type: MonsterType, view: 'front' | 'back'): void {
    const key = `${id}:${view}`;
    if (this.sprites.has(key)) return;
    // Placeholder immediately (so there's never a blank), then upgrade if a real file loads.
    const placeholder = drawMonsterSprite({ id, type, view, size: 96 });
    this.sprites.set(key, { canvas: placeholder, w: 96, h: 96 });
    this.tryLoadCandidates(key, spriteCandidateUrls(id, view), 0);
  }

  /** Walk the candidate URLs in order: on load, adopt the <img> as the real sprite (rendered as a live
   *  DOM element on the sprite layer so an animated GIF actually animates); on error, try the next; if
   *  none load, the canvas placeholder stays. */
  private tryLoadCandidates(key: string, urls: string[], i: number): void {
    if (i >= urls.length) return;   // exhausted → keep the placeholder
    const img = new Image();
    img.onload = () => {
      img.style.cssText = 'position:absolute;image-rendering:pixelated;pointer-events:none';
      this.sprites.set(key, { canvas: img, w: img.width, h: img.height, img });
    };
    img.onerror = () => this.tryLoadCandidates(key, urls, i + 1);   // 404 → next candidate
    img.src = urls[i]!;
  }

  // ── draw loop ────────────────────────────────────────────────────────────────────────────────
  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    if (document.hidden || this.host.style.display === 'none') return;
    // ease the transient anims toward 0
    for (const s of ['a', 'b'] as const) {
      this.lunge[s] = Math.max(0, this.lunge[s] - 0.06);
      this.flash[s] = Math.max(0, this.flash[s] - 0.08);
    }
    this.shake = Math.max(0, this.shake - 0.05);
    this.tick++;
    this.render();
  };

  private render(): void {
    const ctx = this.ctx, S = this.scale;
    // Clear to TRANSPARENT so the 3D arena canvas behind shows through the battle area (the monsters
    // + HP boxes + command window are drawn opaque on top). This is what puts the pixel creatures on
    // the spinning 3D arena instead of a flat paper card.
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.save(); ctx.scale(S, S);
    // Screen-shake (crit): jitter the whole scene a couple GB-pixels, decaying. Deterministic-ish via
    // a cheap time-independent oscillation on the eased intensity (no reliance on Math.random timing).
    if (this.shake > 0) {
      const k = this.shake * this.shake * 3;
      ctx.translate(Math.round(Math.sin(this.shake * 40) * k), Math.round(Math.cos(this.shake * 37) * k));
    }

    // ── Fixed battle layout on the 160×144 screen, designed so NOTHING overlaps ──
    //  scene area  : y 0..92  (monsters on platforms + HP boxes in opposite corners)
    //  command box : y 94..144
    // Enemy (b): front-facing, up-RIGHT on a platform; its HP box up-LEFT.
    // You (a):    back view,   down-LEFT on a platform; your HP box down-RIGHT (above the command box).
    if (this.snap) {
      // NOTE: no in-stage backdrop — the 3D arena is the stage's background and must show through
      // untouched. Only the monsters, attack FX, and HUD draw on this transparent canvas.
      this.drawMonster('b', 108, 42, 46, 'front');   // platform center (x, groundY), sprite size
      this.drawMonster('a', 44, 82, 52, 'back');
      this.attackFx.draw(ctx, S, this.tick);   // typed attack FX OVER the monsters (never below y88)
      const bHud = BATTLE_HUD_RECTS.b;
      const aHud = BATTLE_HUD_RECTS.a;
      this.drawHpBox('b', this.snap.b, bHud);   // enemy: top-left
      this.drawHpBox('a', this.snap.a, aHud);   // you: bottom-right
      // Turn indicator: a bobbing arrow to the SIDE of whoever is acting, pointing at it. To the RIGHT
      // of the top monster (b, points left) and to the LEFT of the bottom monster (a, points right).
      if (this.activeSide === 'b') this.drawTurnArrow(136, 20, 'left');    // right of b's sprite (~x131)
      else if (this.activeSide === 'a') this.drawTurnArrow(13, 56, 'right'); // left of a's sprite (~x18)
    } else {
      this.hideSpriteImg('a'); this.hideSpriteImg('b');   // no battle → clear any lingering sprite <img>
    }

    // Bottom command / text window — branches on the TURN STATE so the game reads as turn-based.
    // Grown taller (y88, h56 → ends y144, the screen edge) so the two-line move cells (name + rating
    // row) don't clip. Sits just under the 'a' HP box (which ends ~y84).
    this.drawWindow(4, 88, GB_W - 8, 56);
    const line = this.uiPhase === 'resolving'
      ? (this.eventBanner || this.statusLine)
      : (this.statusLine || (this.snap ? '' : this.text('renderer.waiting')));
    // Wrap long banners ("Sparkmouse used Thunder Jolt!") to a 2nd line instead of running off the edge.
    this.drawWrappedText(line, 11, 93, GB_W - 8 - 14, 9, this.uiPhase === 'awaiting-input' ? 2 : 5);
    if (this.uiPhase === 'awaiting-input') {
      if (this.menuView === 'fight') this.drawFightMenu();
      else this.drawRootMenu();
    }
    ctx.restore();
  }

  /** Root action menu: ATTACK / GUARD / ITEM / TAUNT in two columns. GUARD/ITEM/TAUNT show a one-word
   *  hint (ITEM shows the remaining Potion count). */
  private drawRootMenu(): void {
    const potions = this.snap ? (this.mySide === 'b' ? this.snap.potions.b : this.snap.potions.a) : 0;
    const cells: [string, string][] = [
      [`1 ${this.text('renderer.fight')}`, this.text('renderer.attack')],
      [`2 ${this.text('renderer.guard')}`, this.text('renderer.brace')],
      [`3 ${this.text('renderer.item')}`, this.text('renderer.potionCount', { count: potions })],
      [`4 ${this.text('renderer.taunt')}`, this.text('renderer.rattle')],
    ];
    cells.forEach(([label, hint], i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = 11 + col * 73, y = 113 + row * 15;
      this.drawText(label, x, y, true);
      this.drawText(hint, x + 6, y + 7, true);
    });
  }

  /** ATTACK submenu: the 4 moves in two columns. Each cell: FULL move name on one row, then a rating
   *  row below — power PIPS + accuracy %. Pips show EFFECTIVENESS VS THE CURRENT FOE (power × type
   *  multiplier), not raw power — so a weak super-effective move out-pips a strong resisted one, and
   *  "pick the fullest" becomes genuinely correct + rewards type play. Accuracy % is the risk knob. */
  private drawFightMenu(): void {
    this.menuMoves.slice(0, 4).forEach((m, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const x = 11 + col * 73, y = 111 + row * 15;
      this.drawText(`${i + 1} ${fitMoveName(m.name, 16)}`, x, y, true);
      const mult = this.foeType ? typeMultiplier(m.type as MonsterType, this.foeType) : 1;
      this.drawPips(x + 6, y + 7, effectivePips(m.power, mult), typeColor(m.type));
      this.drawText(`${accuracyPercent(m.power)}%`, x + 52, y + 7, true);   // hit chance
    });
    this.drawText(`0 ${this.text('renderer.back')}`, 112, 138, true);   // return to the root actions
  }

  /** Draw a monster centered horizontally on `cx`, standing ON the platform at `groundY` (its feet
   *  sit there). A small elliptical shadow anchors it to the arena so it doesn't float. A REAL sprite
   *  (loaded <img>, possibly an animated GIF) is placed on the DOM sprite layer so it animates; a
   *  procedural placeholder is drawn straight to the canvas as before. */
  private drawMonster(side: 'a' | 'b', cx: number, groundY: number, size: number, view: 'front' | 'back'): void {
    const st = side === 'a' ? this.snap!.a : this.snap!.b;
    const spr = this.sprites.get(`${st.monsterId}:${view}`);
    if (!spr) { this.hideSpriteImg(side); return; }
    const ctx = this.ctx;
    const lg = this.lunge[side];                       // attack lunge toward the opponent
    const dx = (side === 'a' ? 1 : -1) * lg * 6;
    const dy = (side === 'a' ? -1 : 1) * lg * 4;
    const idleBob = spr.img ? 0 : Math.round(Math.sin(this.tick * .075 + (side === 'a' ? 0 : 1.7)) * 1.2);
    // shadow platform (drawn first, under the sprite) so the creature reads as standing on the arena.
    ctx.save();
    if (!spr.img) {
      ctx.globalAlpha = .18 + Math.sin(this.tick * .055) * .035;
      ctx.fillStyle = typeColor(st.type);
      ctx.beginPath(); ctx.ellipse(cx + dx, groundY + 1, size * .34, size * .085, 0, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = 'rgba(15,30,15,0.4)';
    ctx.beginPath(); ctx.ellipse(cx + dx, groundY + 2, size * 0.38, size * 0.12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    // hit flash: blink the sprite (canvas OR DOM) while it's flashing.
    const blink = this.flash[side] > 0 && Math.floor(this.flash[side] * 10) % 2 === 0;
    if (spr.img) {
      // Real sprite → live DOM <img> on the sprite layer, positioned to match the canvas layout.
      this.hideSpriteImg(side, spr.img);   // swap element if the monster/view changed
      this.placeSpriteImg(side, spr.img, cx + dx, groundY + dy, size, blink);
    } else {
      // Placeholder → canvas draw (feet anchored on groundY, centered on cx).
      this.hideSpriteImg(side);            // ensure no stale <img> lingers
      if (!blink) ctx.drawImage(spr.canvas, cx - size / 2 + dx, groundY - size + dy + idleBob, size, size);
    }
  }

  /** Position a real sprite <img> on the DOM layer using the SAME GB-logical layout the canvas uses
   *  (converted to device px via `scale`), feet anchored on groundY, centered on cx. */
  private placeSpriteImg(side: 'a' | 'b', img: HTMLImageElement, cx: number, groundY: number, size: number, blink: boolean): void {
    const S = this.scale;
    if (img.parentElement !== this.spriteLayer) this.spriteLayer.appendChild(img);
    this.shownImg[side] = img;
    img.style.left = `${(cx - size / 2) * S}px`;
    img.style.top = `${(groundY - size) * S}px`;
    img.style.width = `${size * S}px`;
    img.style.height = `${size * S}px`;
    img.style.visibility = blink ? 'hidden' : 'visible';
  }

  /** Remove the currently-shown <img> for a side (unless it's `keep`, the one we're about to place). */
  private hideSpriteImg(side: 'a' | 'b', keep?: HTMLImageElement): void {
    const cur = this.shownImg[side];
    if (cur && cur !== keep) { cur.remove(); this.shownImg[side] = null; }
  }

  private createOutcomeBadge(side: 'a' | 'b'): { root: HTMLElement; label: HTMLElement } {
    const root = document.createElement('div');
    root.className = 'battle-outcome-badge';
    root.dataset.side = side;
    root.hidden = true;
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `<span class="battle-outcome-icon battle-outcome-icon--trophy" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false"><path d="M7 3h10v5a5 5 0 0 1-10 0V3Zm-3 2h3v3H6a2 2 0 0 1-2-2V5Zm13 0h3v1a2 2 0 0 1-2 2h-1V5Zm-6 8h2v4h4v3H7v-3h4v-4Z"/></svg>
    </span><span class="battle-outcome-icon battle-outcome-icon--ko" aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false"><path d="M5.6 3.5 12 9.9l6.4-6.4 2.1 2.1-6.4 6.4 6.4 6.4-2.1 2.1-6.4-6.4-6.4 6.4-2.1-2.1L9.9 12 3.5 5.6l2.1-2.1Z"/></svg>
    </span><span class="battle-outcome-label"></span>`;
    this.outcomeLayer.appendChild(root);
    return { root, label: root.querySelector<HTMLElement>('.battle-outcome-label')! };
  }

  private renderOutcomeBadges(): void {
    const outcomes = outcomesBySide(this.winnerSide, this.faintedSide);
    const announcements: string[] = [];
    for (const side of ['a', 'b'] as const) {
      const badge = this.outcomeBadges[side];
      const outcome = outcomes[side];
      const monster = this.snap && (side === 'a' ? this.snap.a : this.snap.b);
      if (!outcome || !monster) {
        badge.root.hidden = true;
        delete badge.root.dataset.outcome;
        badge.label.textContent = '';
        continue;
      }
      const presentation = outcomeBadgePresentation(outcome, monster.monsterName, this.locale);
      badge.root.dataset.outcome = outcome;
      badge.label.textContent = presentation.label;
      badge.root.hidden = false;
      announcements.push(presentation.accessibleLabel);
    }
    this.outcomeAnnouncer.textContent = announcements.join('. ');
  }

  private drawHpBox(side: 'a' | 'b', st: BattleSnapshot['a'], rect: { x:number;y:number;width:number;height:number }): void {
    const ctx = this.ctx;
    const { x, y, width:w, height:h } = rect;
    this.drawWindow(x, y, w, h);
    const names = battleNameplateLines(st.name, st.monsterName);
    this.drawTinyText(names.player, x + 5, y + 4);
    this.drawText(names.monster, x + 5, y + 10, true);
    // HP: during a paced resolution show the tracker's value (drops one hit at a time); else snapshot.
    const hp = this.resHp.display(side, st.hp);
    const frac = hpFraction(hp, st.maxHp);
    const barX = x + 5, barY = y + 18, barW = w - 10, barH = 4;
    ctx.fillStyle = DARK; ctx.fillRect(barX - 1, barY - 1, barW + 2, barH + 2);   // frame
    ctx.fillStyle = PAPER; ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = hpColor(hpZone(frac)); ctx.fillRect(barX, barY, Math.round(barW * frac), barH);
    this.drawText(`${hp}/${st.maxHp}`, x + 5, y + 25, true);
  }

  /** A GB-style window: light fill + a dark inner/outer border. */
  private drawWindow(x: number, y: number, w: number, h: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = INK;  ctx.fillRect(x, y, w, h);
    ctx.fillStyle = PAPER; ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
    ctx.fillStyle = DARK;
    ctx.fillRect(x + 3, y + 3, w - 6, 1);   // top inner rule (decorative)
  }

  /** Draw a short line of chunky text in ink. `small` shrinks it for the HP boxes / move list. */
  private drawText(text: string, x: number, y: number, small = false): void {
    const ctx = this.ctx;
    ctx.fillStyle = INK;
    ctx.font = `${small ? 6 : 8}px monospace`;
    ctx.textBaseline = 'top';
    ctx.fillText(text, x, y);
  }

  private drawTinyText(text: string, x: number, y: number): void {
    const ctx = this.ctx;
    ctx.fillStyle = INK;
    ctx.font = '5px monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(text, x, y);
  }

  /** Draw `text` in the 8px font, word-wrapping within the available part of the command window. */
  private drawWrappedText(text: string, x: number, y: number, maxWidth: number, lineH: number, maxLines: number): void {
    const ctx = this.ctx;
    ctx.font = '8px monospace';
    ctx.fillStyle = INK;
    ctx.textBaseline = 'top';
    const words = text.split(' ');
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const trial = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(trial).width > maxWidth && cur) { lines.push(cur); cur = w; }
      else cur = trial;
    }
    if (cur) lines.push(cur);
    lines.slice(0, maxLines).forEach((ln, i) => ctx.fillText(ln, x, y + i * lineH));
  }

  /** A bobbing SIDE-pointing arrow marking the monster whose turn it is. `dir` is which way it points
   *  ('right' → sits left of the monster; 'left' → sits right of it). Anchored at (tipX, cy); bobs
   *  horizontally toward the monster. Chunky 4px-tall triangle + a short tail. */
  private drawTurnArrow(tipX: number, cy: number, dir: 'left' | 'right'): void {
    const ctx = this.ctx;
    const sign = dir === 'right' ? 1 : -1;                         // +x points right, -x points left
    const bob = Math.round(Math.sin(this.tick * 0.18) * 1.5) * sign;   // nudge toward the monster
    const tx = tipX + bob;
    ctx.fillStyle = '#ffd23f';   // bright, reads over any backdrop
    // triangle head: widest at the base (away from the tip), narrowing to the tip
    for (let col = 0; col < 4; col++) {
      const half = col;                        // 0 at the tip, growing to the base
      ctx.fillRect(tx - sign * col, cy - half, 1, half * 2 + 1);
    }
    ctx.fillStyle = INK;         // 1px dark edge behind the base for contrast
    ctx.fillRect(tx - sign * 4, cy - 3, 1, 7);
  }

  /** A move's power rating as up to 5 tiny squares: `filled` in the type color, the rest an empty
   *  outline. Reads as "how hard does this hit" without the misleading raw base-power number. */
  private drawPips(x: number, y: number, filled: number, color: string): void {
    const ctx = this.ctx;
    for (let i = 0; i < 5; i++) {
      const px = x + i * 4;
      if (i < filled) { ctx.fillStyle = color; ctx.fillRect(px, y, 3, 3); }
      else { ctx.fillStyle = DARK; ctx.fillRect(px, y, 3, 3); ctx.fillStyle = PAPER; ctx.fillRect(px + 1, y + 1, 1, 1); }
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    this.canvas.remove();
    this.spriteLayer.remove();
    this.outcomeLayer.remove();
  }
}
