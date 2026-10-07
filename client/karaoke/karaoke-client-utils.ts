import {
  KARAOKE_COUNTDOWN_MS,
  KARAOKE_MAX_SCORE,
  type KaraokeJudgment,
  type KaraokePhase,
} from '../../shared/karaoke-protocol';
import type { KaraokeSong } from '../../shared/karaoke';
import type { SupportedLocale } from '../../shared/i18n/locales';
import type { VisibleKaraokeWord } from '../../shared/karaoke-timeline';
import {
  DEFAULT_KARAOKE_VENUE,
  karaokeCameraMode,
  type KaraokeCameraPose,
  type KaraokeTransform,
  type KaraokeVenueConfig,
  type KaraokeVec3,
} from '../../shared/karaoke-venue';

export interface KaraokeCameraShot {
  id: KaraokeCameraShotId;
  position: readonly [number, number, number];
  lookAt: readonly [number, number, number];
  fov: number;
}

export type KaraokeCameraShotId =
  | 'static'
  | 'venue-crane'
  | 'venue-wide'
  | 'crowd-left'
  | 'crowd-right'
  | 'stage-low'
  | 'lead-left'
  | 'lead-right'
  | 'lead-tight'
  | 'backup-close'
  | 'guitar-close'
  | 'finale-wide';

export interface KaraokeCameraTargets {
  lead: readonly [number, number, number];
  backup: readonly [number, number, number];
  guitarist: readonly [number, number, number];
}

export interface KaraokeAudioSchedule {
  contextStartTime: number;
  offsetSeconds: number;
  ended: boolean;
}

export interface KaraokeHighwayPose {
  x: number;
  z: number;
  scale: number;
  sustain: number;
}

export interface KaraokeSustainTailPose {
  centerY: number;
  scaleY: number;
}

export interface KaraokeClockSyncSample {
  serverNowMs: number;
  clientSentAtMs?: number;
  clientReceivedAtMs: number;
}

export interface KaraokeClockOffsetEstimate {
  offsetMs: number;
  roundTripMs: number;
}

export interface KaraokeFallbackWordProjection {
  leftPercent: number;
  topPercent: number;
  scale: number;
  active: boolean;
}

export const KARAOKE_RENDER_PIXEL_BUDGET = 3_000_000;
export const KARAOKE_WORD_TEXTURE_WIDTH = 384;
export const KARAOKE_WORD_TEXTURE_HEIGHT = 128;
export const KARAOKE_WORD_TILE_DEPTH = .7;
export const KARAOKE_SUSTAIN_TAIL_DEPTH = 1.35;
export const KARAOKE_VISUAL_OFFSET_STEP_MS = 20;
export const KARAOKE_VISUAL_OFFSET_LIMIT_MS = 300;
export const KARAOKE_VISUAL_OFFSET_STORAGE_KEY = 'voice-karaoke-visual-offset-ms';
export const KARAOKE_GUIDE_AUDIO_URL = '/audio/karaoke/classic-45s.mp3?v=20260828-calibration-1';
export type KaraokeRenderMode = 'full' | 'light';

export function karaokeInitialRenderMode(rendererName: string, cpuCores: number): KaraokeRenderMode {
  return /swiftshader|llvmpipe|software/i.test(rendererName)
    || (Number.isFinite(cpuCores) && cpuCores > 0 && cpuCores <= 4)
    ? 'light' : 'full';
}

/** GLB swaps and shader compilation must not compete with timed lyrics or backing audio. */
export function karaokeCanInstallOptionalAssets(phase: KaraokePhase | null): boolean {
  return phase === null || phase === 'lobby' || phase === 'song_select' || phase === 'results';
}

/** Hysteresis prevents visual quality from oscillating during a brief network or decode stall. */
export function karaokeAdaptiveRenderMode(
  current: KaraokeRenderMode,
  averageFrameMs: number,
  timeSinceSwitchMs: number,
): KaraokeRenderMode {
  if (!Number.isFinite(averageFrameMs)) return current;
  if (current === 'full' && averageFrameMs > 25) return 'light';
  if (current === 'light' && averageFrameMs < 18 && timeSinceSwitchMs >= 10_000) return 'full';
  return current;
}

export class KaraokeCountdownAnnouncer {
  private generation = 0;
  private announced = false;

  update(
    phase: KaraokePhase,
    loadingGeneration: number,
    locale: SupportedLocale,
    count: number,
    announce: () => void,
  ): void {
    if (loadingGeneration !== this.generation) {
      this.generation = loadingGeneration;
      this.announced = false;
    }
    if (phase !== 'countdown' || locale !== 'en-US' || loadingGeneration < 1 || count !== 3 || this.announced) return;
    this.announced = true;
    announce();
  }
}

const clamp = (value: number, min = 0, max = 1): number => Math.min(max, Math.max(min, value));

/** Uses the request/response midpoint so network time is not added to the clock offset. */
export function estimateKaraokeClockOffset(sample: Required<KaraokeClockSyncSample>): KaraokeClockOffsetEstimate {
  const { serverNowMs, clientSentAtMs, clientReceivedAtMs } = sample;
  if (![serverNowMs, clientSentAtMs, clientReceivedAtMs].every(Number.isFinite)
    || clientReceivedAtMs < clientSentAtMs) {
    throw new RangeError('Karaoke clock sync values must be finite and ordered');
  }
  const roundTripMs = clientReceivedAtMs - clientSentAtMs;
  return {
    offsetMs: serverNowMs - (clientSentAtMs + roundTripMs / 2),
    roundTripMs,
  };
}

/** Maintains a monotonic server clock using the lowest-RTT sync response seen so far. */
export class KaraokeServerClock {
  private offsetMs = 0;
  private bestRoundTripMs = Number.POSITIVE_INFINITY;
  private hasRttEstimate = false;
  private hasEstimate = false;
  private lastNowMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly localEpochAtAnchorMs = Date.now(),
    private readonly monotonicAnchorMs = performance.now(),
  ) {}

  observeSync(sample: KaraokeClockSyncSample): boolean {
    if (![sample.serverNowMs, sample.clientReceivedAtMs].every(Number.isFinite)) return false;
    if (sample.clientSentAtMs === undefined) {
      if (this.hasEstimate) return false;
      this.offsetMs = sample.serverNowMs - sample.clientReceivedAtMs;
      this.hasEstimate = true;
      this.lastNowMs = Number.NEGATIVE_INFINITY;
      return true;
    }
    let estimate: KaraokeClockOffsetEstimate;
    try {
      estimate = estimateKaraokeClockOffset(sample as Required<KaraokeClockSyncSample>);
    } catch {
      return false;
    }
    if (this.hasRttEstimate && estimate.roundTripMs > this.bestRoundTripMs) return false;
    const firstReliableEstimate = !this.hasRttEstimate;
    this.offsetMs = estimate.offsetMs;
    this.bestRoundTripMs = estimate.roundTripMs;
    this.hasRttEstimate = true;
    this.hasEstimate = true;
    if (firstReliableEstimate) this.lastNowMs = Number.NEGATIVE_INFINITY;
    return true;
  }

  now(monotonicNowMs = performance.now()): number {
    const elapsedMs = Number.isFinite(monotonicNowMs) ? Math.max(0, monotonicNowMs - this.monotonicAnchorMs) : 0;
    this.lastNowMs = Math.max(this.lastNowMs, this.localEpochAtAnchorMs + elapsedMs + this.offsetMs);
    return this.lastNowMs;
  }
}

/** Maps an absolute server start onto Web Audio's monotonic clock. */
export function karaokeAudioSchedule(
  startedAtMs: number,
  serverNowMs: number,
  contextNowSeconds: number,
  durationMs: number,
): KaraokeAudioSchedule {
  if (![startedAtMs, serverNowMs, contextNowSeconds, durationMs].every(Number.isFinite)
    || durationMs <= 0 || contextNowSeconds < 0) {
    throw new RangeError('Karaoke audio schedule values must be finite and in range');
  }
  const elapsedMs = serverNowMs - startedAtMs;
  if (elapsedMs >= durationMs) {
    return { contextStartTime: contextNowSeconds, offsetSeconds: durationMs / 1000, ended: true };
  }
  if (elapsedMs <= 0) {
    return {
      contextStartTime: contextNowSeconds + (-elapsedMs / 1000),
      offsetSeconds: 0,
      ended: false,
    };
  }
  return { contextStartTime: contextNowSeconds, offsetSeconds: elapsedMs / 1000, ended: false };
}

const DEFAULT_CAMERA_TARGETS: KaraokeCameraTargets = Object.freeze({
  lead: [-1.35, 1.8, -.25] as const,
  backup: [1.35, 1.8, -.25] as const,
  guitarist: [3.45, 1.8, -1.2] as const,
});

const CAMERA_TIMELINE = Object.freeze([
  { id: 'venue-crane', end: 4 },
  { id: 'lead-left', end: 7 },
  { id: 'crowd-left', end: 10 },
  { id: 'lead-tight', end: 13 },
  { id: 'guitar-close', end: 16.5 },
  { id: 'venue-wide', end: 20 },
  { id: 'backup-close', end: 23 },
  { id: 'crowd-right', end: 26 },
  { id: 'guitar-close', end: 30 },
  { id: 'lead-right', end: 34 },
  { id: 'stage-low', end: 38 },
  { id: 'lead-tight', end: 42 },
  { id: 'finale-wide', end: Number.POSITIVE_INFINITY },
] as const satisfies readonly { id: Exclude<KaraokeCameraShotId, 'static'>; end: number }[]);

export function karaokeStaticCameraShot(
  aspect: number,
  cameras: KaraokeVenueConfig['cameras'] = DEFAULT_KARAOKE_VENUE.cameras,
): KaraokeCameraShot {
  const mode = karaokeCameraMode(Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9);
  const base = cameras[mode];
  return { id: 'static', position: [...base.position], lookAt: [...base.lookAt], fov: base.fov };
}

/** Deterministic concert direction with hard cuts and in-shot dollies indexed by absolute song time. */
export function karaokeCameraShot(
  aspect: number,
  songTimeMs: number,
  intensity: number,
  cameras: KaraokeVenueConfig['cameras'] = DEFAULT_KARAOKE_VENUE.cameras,
  targets: KaraokeCameraTargets = DEFAULT_CAMERA_TARGETS,
): KaraokeCameraShot {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  const time = Number.isFinite(songTimeMs) ? Math.max(0, songTimeMs) / 1000 : 0;
  const energy = clamp(Number.isFinite(intensity) ? intensity : 0);
  const mode = karaokeCameraMode(safeAspect);
  const portrait = mode === 'portrait';
  const compact = mode === 'compact';
  const base: KaraokeCameraPose = cameras[mode];
  const timelineIndex = CAMERA_TIMELINE.findIndex(entry => time < entry.end);
  const segment = CAMERA_TIMELINE[Math.max(0, timelineIndex)]!;
  const priorEnd = timelineIndex <= 0 ? 0 : CAMERA_TIMELINE[timelineIndex - 1]!.end;
  const duration = Number.isFinite(segment.end) ? segment.end - priorEnd : 3;
  const progress = clamp((time - priorEnd) / duration);
  const distance = portrait ? 1.42 : compact ? 1.16 : 1;
  const handheld = Math.sin(time * 1.7) * (.025 + energy * .055);
  const stageCenter: readonly [number, number, number] = [
    (targets.lead[0] + targets.backup[0]) / 2,
    (targets.lead[1] + targets.backup[1]) / 2 - .35,
    (targets.lead[2] + targets.backup[2]) / 2 - 1.25,
  ];
  const closeFov = (value: number): number => value + (portrait ? 9 : compact ? 4 : 0);
  const subjectShot = (
    id: KaraokeCameraShotId,
    subject: readonly [number, number, number],
    side: number,
    tight = false,
  ): KaraokeCameraShot => ({
    id,
    position: [
      subject[0] + side * (tight ? 1.15 : 2.15) * distance + handheld,
      subject[1] + (tight ? .55 : .9) * distance,
      subject[2] + (tight ? 3.15 : 4.7) * distance - progress * .4,
    ],
    lookAt: [subject[0] + handheld * .35, subject[1] + .05, subject[2]],
    fov: closeFov(tight ? 27 : 32),
  });

  switch (segment.id) {
    case 'lead-left': return subjectShot(segment.id, targets.lead, -1);
    case 'lead-right': return subjectShot(segment.id, targets.lead, 1);
    case 'lead-tight': return subjectShot(segment.id, targets.lead, progress < .5 ? -1 : 1, true);
    case 'backup-close': return subjectShot(segment.id, targets.backup, 1);
    case 'guitar-close': return subjectShot(segment.id, targets.guitarist, 1.15);
    case 'crowd-left':
    case 'crowd-right': {
      const side = segment.id === 'crowd-left' ? -1 : 1;
      return {
        id: segment.id,
        position: [stageCenter[0] + side * 6.4 * distance, 2.15 * distance, stageCenter[2] + 10.2 * distance - progress * .8],
        lookAt: [stageCenter[0] - side * .5, stageCenter[1] + .15, stageCenter[2] - 1.2],
        fov: closeFov(43),
      };
    }
    case 'stage-low':
      return {
        id: segment.id,
        position: [stageCenter[0] - 1.4 + progress * 2.8, 1.18, stageCenter[2] + 9.2 * distance],
        lookAt: [stageCenter[0], stageCenter[1] + .65, stageCenter[2] - .8],
        fov: closeFov(39),
      };
    case 'venue-crane':
      return {
        id: segment.id,
        position: [base.position[0] - 2.2 + progress * 4.4, base.position[1] + 1.1 - progress * .7, base.position[2] + .8 - progress * .9],
        lookAt: [base.lookAt[0], base.lookAt[1] + .35, base.lookAt[2] - .8],
        fov: base.fov + (portrait ? 3 : 0),
      };
    case 'finale-wide':
      return {
        id: segment.id,
        position: [base.position[0] + Math.sin(time * .42) * 1.2, base.position[1] - .65, base.position[2] - 1.4 - energy * .6],
        lookAt: [base.lookAt[0], base.lookAt[1] + .25, base.lookAt[2] - .8],
        fov: base.fov + 4,
      };
    case 'venue-wide':
      return {
        id: segment.id,
        position: [base.position[0] + 1.5 - progress * 3, base.position[1] - .25, base.position[2] - .8],
        lookAt: [base.lookAt[0], base.lookAt[1], base.lookAt[2] - .65],
        fov: base.fov + 2,
      };
  }
}

/** Adds animation deltas without replacing editor-authored anchors. */
export function karaokeAnimatedTransform(
  base: KaraokeTransform,
  positionDelta: readonly [number, number, number] = [0, 0, 0],
  rotationDelta: readonly [number, number, number] = [0, 0, 0],
): KaraokeTransform {
  return {
    position: base.position.map((value, axis) => value + positionDelta[axis]!) as [number, number, number],
    rotation: base.rotation.map((value, axis) => value + rotationDelta[axis]!) as [number, number, number],
    scale: [...base.scale],
  };
}

export function karaokeResponsiveHighwayTransform(
  aspect: number,
  highway: KaraokeVenueConfig['highway'] = DEFAULT_KARAOKE_VENUE.highway,
): KaraokeTransform {
  const source = Number.isFinite(aspect) && aspect < .8 ? highway.portrait : highway.landscape;
  return { position: [...source.position], rotation: [...source.rotation], scale: [...source.scale] };
}

export function karaokeDrumAnchorTransform(
  anchor: KaraokeVec3,
  nodeTransform: KaraokeTransform,
): KaraokeTransform {
  return {
    position: anchor.map((value, axis) => value + nodeTransform.position[axis]!) as [number, number, number],
    rotation: [...nodeTransform.rotation],
    scale: [...nodeTransform.scale],
  };
}

/** Converts shared timeline projection into the converging four-lane stage highway. */
export function karaokeHighwayPose(visible: VisibleKaraokeWord): KaraokeHighwayPose {
  const progress = clamp(visible.fallProgress);
  const farLaneX = (visible.word.lane - 1.5) * 1.05;
  const nearLaneX = (visible.word.lane - 1.5) * 2.05;
  const duration = Math.max(1, visible.word.endMs - visible.word.startMs);
  return {
    x: farLaneX + (nearLaneX - farLaneX) * progress,
    z: -3.25 + progress * 8.9,
    scale: .54 + progress * .46,
    sustain: visible.phase === 'active'
      ? clamp(visible.timeToEndMs / duration)
      : 1,
  };
}

/** Keeps the sustain attached behind the word onset while its far end drains toward the target. */
export function karaokeSustainTailPose(remaining: number): KaraokeSustainTailPose {
  const scaleY = Math.max(.08, clamp(Number.isFinite(remaining) ? remaining : 0));
  const attachedEdgeY = KARAOKE_WORD_TILE_DEPTH / 2 - .045;
  return {
    centerY: attachedEdgeY + KARAOKE_SUSTAIN_TAIL_DEPTH * scaleY / 2,
    scaleY,
  };
}

export function karaokeFallbackWordProjection(visible: VisibleKaraokeWord): KaraokeFallbackWordProjection {
  const progress = clamp(visible.fallProgress);
  const farLeft = 38.75 + visible.word.lane * 7.5;
  const nearLeft = 12.5 + visible.word.lane * 25;
  return {
    leftPercent: farLeft + (nearLeft - farLeft) * progress,
    topPercent: 7 + progress * 75,
    scale: .72 + progress * .28,
    active: visible.phase === 'active',
  };
}

export function karaokeCountdownSongTimeMs(countdownEndsAtMs: number, serverNowMs: number): number {
  if (![countdownEndsAtMs, serverNowMs].every(Number.isFinite)) return 0;
  return Math.min(0, serverNowMs - countdownEndsAtMs);
}

export function karaokeCountdownCount(countdownEndsAtMs: number, serverNowMs: number): 1 | 2 | 3 {
  const count = Math.ceil((countdownEndsAtMs - serverNowMs) / 1_000);
  return Math.max(1, Math.min(KARAOKE_COUNTDOWN_MS / 1_000, count)) as 1 | 2 | 3;
}

export function karaokeRenderPixelRatio(
  width: number,
  height: number,
  deviceRatio: number,
  pixelBudget = KARAOKE_RENDER_PIXEL_BUDGET,
): number {
  if (![width, height, deviceRatio, pixelBudget].every(Number.isFinite)
    || width <= 0 || height <= 0 || deviceRatio <= 0 || pixelBudget <= 0) return 1;
  const responsiveCap = width <= 700 ? 1.45 : 2;
  return Math.min(deviceRatio, responsiveCap, Math.sqrt(pixelBudget / (width * height)));
}

export function karaokeStageIntensity(
  combo: number,
  score: number,
  recentJudgment?: { judgment: KaraokeJudgment; ageMs: number } | null,
): number {
  const comboEnergy = clamp((Number.isFinite(combo) ? combo : 0) / 24);
  const scoreEnergy = clamp((Number.isFinite(score) ? score : 0) / KARAOKE_MAX_SCORE);
  const judgmentEnergy = recentJudgment && recentJudgment.judgment !== 'miss'
    ? clamp(1 - recentJudgment.ageMs / 900) * (recentJudgment.judgment === 'perfect' ? .28 : .16)
    : 0;
  return clamp(.12 + comboEnergy * .48 + scoreEnergy * .3 + judgmentEnergy);
}

export function resolveKaraokeWebSocketUrl(
  page: Pick<Location, 'protocol' | 'host'>,
  override?: string | null,
  display = false,
): string {
  const pageUrl = new URL(`${page.protocol}//${page.host}`);
  const defaultUrl = `${page.protocol === 'https:' ? 'wss:' : 'ws:'}//${page.host}/karaoke`;
  const parsed = new URL(override ?? defaultUrl);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new TypeError('ws override must use ws or wss');
  if (parsed.pathname !== '/karaoke') throw new TypeError('ws override must use the Karaoke endpoint');
  const targetProtocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  const sameOrigin = targetProtocol === pageUrl.protocol && parsed.host === pageUrl.host;
  const loopbackDevelopment = pageUrl.protocol === 'http:' && targetProtocol === 'http:'
    && karaokeLoopbackHostname(pageUrl.hostname) && karaokeLoopbackHostname(parsed.hostname);
  if (!sameOrigin && (!loopbackDevelopment || display)) {
    throw new TypeError(display
      ? 'display websocket must be same-origin'
      : 'ws override must be same-origin or loopback development');
  }
  if (display) parsed.searchParams.set('display', '1');
  else parsed.searchParams.delete('display');
  return parsed.toString();
}

export function karaokeGuideModeAllowed(
  guideRequested: boolean,
  locale: SupportedLocale,
  hostname: string,
  stationDisplay: boolean,
): boolean {
  return guideRequested && !stationDisplay && locale === 'en-US' && karaokeLoopbackHostname(hostname);
}

export function karaokeLocalTestingAllowed(hostname: string, stationDisplay: boolean): boolean {
  return !stationDisplay && karaokeLoopbackHostname(hostname);
}

export function karaokeDisplayMode(
  hostname: string,
  explicitDisplay: boolean,
  stationDisplay: boolean,
): boolean {
  return explicitDisplay || stationDisplay || !karaokeLoopbackHostname(hostname);
}

export function karaokeDisplayPairingRequired(
  hostname: string,
  stationLaunchRequested: boolean,
  displayToken: string | null,
): boolean {
  return !karaokeLoopbackHostname(hostname) && stationLaunchRequested && !displayToken;
}

export function karaokeAudioPreflightRequired(
  localTesting: boolean,
  audioRunning: boolean,
  muted: boolean,
  phase?: KaraokePhase,
): boolean {
  return !localTesting && (!audioRunning || muted)
    && (phase === undefined || phase === 'lobby' || phase === 'song_select' || phase === 'loading');
}

export function clampKaraokeVisualOffsetMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const stepped = Math.round(value / KARAOKE_VISUAL_OFFSET_STEP_MS) * KARAOKE_VISUAL_OFFSET_STEP_MS;
  return Math.max(-KARAOKE_VISUAL_OFFSET_LIMIT_MS, Math.min(KARAOKE_VISUAL_OFFSET_LIMIT_MS, stepped));
}

/** Positive delay renders and judges lyrics later than the audible presentation clock. */
export function karaokeVisualTimeMs(presentationTimeMs: number, visualDelayMs: number): number {
  if (!Number.isFinite(presentationTimeMs)) throw new RangeError('Karaoke presentation time must be finite');
  return presentationTimeMs - clampKaraokeVisualOffsetMs(visualDelayMs);
}

/** Selects the guide vocal only for the licensed English song in explicit local authoring mode. */
export function karaokeClientAudioUrl(
  song: Pick<KaraokeSong, 'id' | 'locale' | 'provenance' | 'audioUrl'>,
  guideMode: boolean,
): string | undefined {
  if (guideMode && song.id === 'never-gonna-give-you-up'
    && song.locale === 'en-US' && song.provenance === 'user-confirmed-licensed') {
    return KARAOKE_GUIDE_AUDIO_URL;
  }
  return song.audioUrl;
}

function karaokeLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}
