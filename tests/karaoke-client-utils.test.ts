import { describe, expect, it, vi } from 'vitest';
import { visibleKaraokeWordsAtTime } from '../shared/karaoke-timeline';
import { EN_US_ORIGINAL_DEVELOPMENT_SONG, NEVER_GONNA_GIVE_YOU_UP } from '../shared/karaoke-songs';
import {
  KARAOKE_GUIDE_AUDIO_URL,
  KARAOKE_RENDER_PIXEL_BUDGET,
  KARAOKE_VISUAL_OFFSET_LIMIT_MS,
  KARAOKE_VISUAL_OFFSET_STEP_MS,
  KARAOKE_VISUAL_OFFSET_STORAGE_KEY,
  KARAOKE_WORD_TEXTURE_HEIGHT,
  KARAOKE_WORD_TEXTURE_WIDTH,
  KARAOKE_SUSTAIN_TAIL_DEPTH,
  KARAOKE_WORD_TILE_DEPTH,
  KaraokeCountdownAnnouncer,
  KaraokeServerClock,
  clampKaraokeVisualOffsetMs,
  estimateKaraokeClockOffset,
  karaokeAdaptiveRenderMode,
  karaokeAnimatedTransform,
  karaokeAudioSchedule,
  karaokeAudioPreflightRequired,
  karaokeCameraShot,
  karaokeCanInstallOptionalAssets,
  karaokeClientAudioUrl,
  karaokeCountdownCount,
  karaokeCountdownSongTimeMs,
  karaokeDrumAnchorTransform,
  karaokeFallbackWordProjection,
  karaokeGuideModeAllowed,
  karaokeDisplayMode,
  karaokeDisplayPairingRequired,
  karaokeLocalTestingAllowed,
  karaokeHighwayPose,
  karaokeInitialRenderMode,
  karaokeRenderPixelRatio,
  karaokeResponsiveHighwayTransform,
  karaokeStageIntensity,
  karaokeStaticCameraShot,
  karaokeSustainTailPose,
  karaokeVisualTimeMs,
  resolveKaraokeWebSocketUrl,
} from '../client/karaoke/karaoke-client-utils';
import { cloneKaraokeVenueConfig, karaokeVenueModel } from '../shared/karaoke-venue';
import { KARAOKE_COUNTDOWN_MS } from '../shared/karaoke-protocol';

describe('Voice Karaoke client timeline utilities', () => {
  it('keeps optional scene swaps away from live audio and scoring phases', () => {
    expect(['lobby', 'song_select', 'results'].every(phase =>
      karaokeCanInstallOptionalAssets(phase as 'lobby' | 'song_select' | 'results'))).toBe(true);
    expect(['loading', 'countdown', 'performing', 'finalizing'].every(phase =>
      !karaokeCanInstallOptionalAssets(phase as 'loading' | 'countdown' | 'performing' | 'finalizing'))).toBe(true);
    expect(karaokeCanInstallOptionalAssets(null)).toBe(true);
  });

  it('drops expensive effects after sustained slow frames and restores them only after recovery', () => {
    expect(karaokeInitialRenderMode('ANGLE (SwiftShader)', 16)).toBe('light');
    expect(karaokeInitialRenderMode('Apple M3', 4)).toBe('light');
    expect(karaokeInitialRenderMode('Apple M3', 8)).toBe('full');
    expect(karaokeAdaptiveRenderMode('full', 26, 0)).toBe('light');
    expect(karaokeAdaptiveRenderMode('full', 20, 0)).toBe('full');
    expect(karaokeAdaptiveRenderMode('light', 16, 4_000)).toBe('light');
    expect(karaokeAdaptiveRenderMode('light', 16, 10_000)).toBe('full');
    expect(karaokeAdaptiveRenderMode('light', Number.NaN, 20_000)).toBe('light');
  });

  it('maps future, late, and completed server starts onto the Web Audio clock', () => {
    expect(karaokeAudioSchedule(12_000, 10_000, 4, 45_000)).toEqual({
      contextStartTime: 6, offsetSeconds: 0, ended: false,
    });
    expect(karaokeAudioSchedule(12_000, 14_250, 8, 45_000)).toEqual({
      contextStartTime: 8, offsetSeconds: 2.25, ended: false,
    });
    expect(karaokeAudioSchedule(12_000, 57_000, 9, 45_000)).toEqual({
      contextStartTime: 9, offsetSeconds: 45, ended: true,
    });
  });

  it('uses an exact visible 3-2-1 authority and starts audio at countdown end', () => {
    expect(KARAOKE_COUNTDOWN_MS).toBe(3_000);
    const now = 10_000;
    const countdownEndsAt = now + KARAOKE_COUNTDOWN_MS;
    expect(Array.from({ length: 3 }, (_, second) => (
      karaokeCountdownCount(countdownEndsAt, now + second * 1_000)
    ))).toEqual([3, 2, 1]);
    expect(karaokeAudioSchedule(countdownEndsAt, now, 4, 45_000)).toEqual({
      contextStartTime: 7, offsetSeconds: 0, ended: false,
    });
  });

  it('triggers the English announcer once per loading generation and resets on retry', () => {
    const announcer = new KaraokeCountdownAnnouncer();
    const play = vi.fn();
    announcer.update('loading', 1, 'en-US', 3, play);
    announcer.update('countdown', 1, 'en-US', 6, play);
    announcer.update('countdown', 1, 'en-US', 4, play);
    announcer.update('countdown', 1, 'en-US', 3, play);
    announcer.update('countdown', 1, 'en-US', 3, play);
    announcer.update('performing', 1, 'en-US', 3, play);
    expect(play).toHaveBeenCalledTimes(1);

    announcer.update('loading', 2, 'en-US', 3, play);
    announcer.update('countdown', 2, 'en-US', 4, play);
    announcer.update('countdown', 2, 'en-US', 3, play);
    announcer.update('countdown', 2, 'en-US', 2, play);
    expect(play).toHaveBeenCalledTimes(2);

    announcer.update('loading', 3, 'pt-BR', 3, play);
    announcer.update('countdown', 3, 'pt-BR', 3, play);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('rejects unusable scheduling values instead of creating an invalid source', () => {
    expect(() => karaokeAudioSchedule(Number.NaN, 0, 0, 45_000)).toThrow(RangeError);
    expect(() => karaokeAudioSchedule(0, 0, -1, 45_000)).toThrow(RangeError);
    expect(() => karaokeAudioSchedule(0, 0, 0, 0)).toThrow(RangeError);
  });

  it('estimates clock offset from the RTT midpoint and keeps the lowest-latency sample', () => {
    expect(estimateKaraokeClockOffset({
      clientSentAtMs: 20_000, clientReceivedAtMs: 20_200, serverNowMs: 30_100,
    })).toEqual({ offsetMs: 10_000, roundTripMs: 200 });

    const clock = new KaraokeServerClock(20_000, 1_000);
    expect(clock.observeSync({ clientSentAtMs: 20_000, clientReceivedAtMs: 20_200, serverNowMs: 30_100 })).toBe(true);
    expect(clock.now(1_200)).toBe(30_200);
    expect(clock.observeSync({ clientSentAtMs: 20_000, clientReceivedAtMs: 20_400, serverNowMs: 30_300 })).toBe(false);
    expect(clock.observeSync({ clientSentAtMs: 21_000, clientReceivedAtMs: 21_040, serverNowMs: 31_030 })).toBe(true);
    expect(clock.now(1_300)).toBe(30_310);
    expect(clock.now(900)).toBe(30_310);
  });

  it('rebases once when the first reliable sample finds the browser clock ahead of the server', () => {
    const clock = new KaraokeServerClock(50_000, 1_000);
    expect(clock.now(1_100)).toBe(50_100);
    expect(clock.observeSync({
      clientSentAtMs: 50_100,
      clientReceivedAtMs: 50_140,
      serverNowMs: 20_120,
    })).toBe(true);
    expect(clock.now(1_140)).toBe(20_140);
    expect(clock.now(1_130)).toBe(20_140);
  });

  it('projects shared visible words from converged far lanes to the hit line', () => {
    const spawn = visibleKaraokeWordsAtTime(EN_US_ORIGINAL_DEVELOPMENT_SONG.chart, -1_800)[0]!;
    const near = visibleKaraokeWordsAtTime(EN_US_ORIGINAL_DEVELOPMENT_SONG.chart, 1_199)[0]!;
    expect(karaokeHighwayPose(spawn).x).toBeCloseTo(-1.575, 6);
    expect(karaokeHighwayPose(spawn)).toMatchObject({ z: -3.25, scale: .54 });
    expect(karaokeHighwayPose(near).z).toBeCloseTo(5.647, 2);
    expect(karaokeHighwayPose(near).x).toBeCloseTo(-3.074, 2);
  });

  it('anchors sustained words at their onset and drains the tail from behind the hit point', () => {
    const onset = karaokeSustainTailPose(1);
    const halfway = karaokeSustainTailPose(.5);
    const attachedEdge = KARAOKE_WORD_TILE_DEPTH / 2 - .045;
    expect(onset.centerY).toBeGreaterThan(0);
    expect(onset.centerY - KARAOKE_SUSTAIN_TAIL_DEPTH * onset.scaleY / 2).toBeCloseTo(attachedEdge, 6);
    expect(halfway.centerY - KARAOKE_SUSTAIN_TAIL_DEPTH * halfway.scaleY / 2).toBeCloseTo(attachedEdge, 6);
    expect(halfway.centerY).toBeLessThan(onset.centerY);
  });

  it('projects fallback words through the full approach window and drives countdown with negative time', () => {
    const first = EN_US_ORIGINAL_DEVELOPMENT_SONG.chart.words[0]!;
    const spawnTime = first.startMs - 3_000;
    const countdownEndsAtMs = 20_000;
    expect(karaokeCountdownSongTimeMs(countdownEndsAtMs, countdownEndsAtMs + spawnTime)).toBe(spawnTime);
    const spawn = visibleKaraokeWordsAtTime(EN_US_ORIGINAL_DEVELOPMENT_SONG.chart, spawnTime)[0]!;
    const target = visibleKaraokeWordsAtTime(EN_US_ORIGINAL_DEVELOPMENT_SONG.chart, first.startMs)[0]!;
    expect(karaokeFallbackWordProjection(spawn)).toMatchObject({ topPercent: 7, scale: .72, active: false });
    expect(karaokeFallbackWordProjection(target)).toMatchObject({ topPercent: 82, scale: 1, active: true });
  });

  it('caps device scale by viewport class and a total render pixel budget', () => {
    expect(karaokeRenderPixelRatio(700, 1_000, 3)).toBe(1.45);
    const ratio = karaokeRenderPixelRatio(3_840, 2_160, 2);
    expect(3_840 * ratio * 2_160 * ratio).toBeLessThanOrEqual(KARAOKE_RENDER_PIXEL_BUDGET + 1);
    expect(KARAOKE_WORD_TEXTURE_WIDTH).toBe(384);
    expect(KARAOKE_WORD_TEXTURE_HEIGHT).toBe(128);
  });

  it('keeps camera choreography deterministic at absolute song times and fits portrait screens', () => {
    expect(karaokeCameraShot(16 / 9, 12_000, .7)).toEqual(karaokeCameraShot(16 / 9, 12_000, .7));
    const landscape = karaokeCameraShot(16 / 9, 12_000, .7);
    const portrait = karaokeCameraShot(9 / 16, 12_000, .7);
    expect(landscape.id).toBe('lead-tight');
    expect(portrait.position[2]).toBeGreaterThan(landscape.position[2]);
    expect(portrait.fov).toBeGreaterThan(landscape.fov);
  });

  it('cuts across venue, crowd, singers, and guitarist without a drummer closeup', () => {
    const shots = [0, 5, 8, 11, 14, 18, 21, 24, 28, 32, 36, 40, 44]
      .map(seconds => karaokeCameraShot(16 / 9, seconds * 1_000, .6).id);
    expect(shots).toEqual([
      'venue-crane', 'lead-left', 'crowd-left', 'lead-tight', 'guitar-close', 'venue-wide',
      'backup-close', 'crowd-right', 'guitar-close', 'lead-right', 'stage-low', 'lead-tight',
      'finale-wide',
    ]);
    expect(shots.some(shot => shot.includes('drum'))).toBe(false);
  });

  it('composes camera, performer, drum-anchor, and responsive highway edits with runtime deltas', () => {
    const venue = cloneKaraokeVenueConfig();
    venue.cameras.landscape.position = [4, 9, 22];
    venue.cameras.landscape.lookAt = [1, 2, 3];
    venue.cameras.landscape.fov = 57;
    const camera = karaokeStaticCameraShot(16 / 9, venue.cameras);
    expect(camera.position).toEqual([4, 9, 22]);
    expect(camera.lookAt).toEqual([1, 2, 3]);
    expect(camera.fov).toBe(57);

    const singer = karaokeVenueModel(venue, 'lead-singer').transform;
    singer.position = [8, 3, -6]; singer.rotation = [10, 20, 30]; singer.scale = [2, 3, 4];
    expect(karaokeAnimatedTransform(singer, [0, .25, 0], [0, 5, 0])).toEqual({
      position: [8, 3.25, -6], rotation: [10, 25, 30], scale: [2, 3, 4],
    });
    expect(karaokeDrumAnchorTransform([2, 3, 4], {
      position: [.5, 1, -2], rotation: [0, 45, 0], scale: [1, 2, 1],
    })).toEqual({ position: [2.5, 4, 2], rotation: [0, 45, 0], scale: [1, 2, 1] });
    venue.highway.portrait.position = [5, 6, 7];
    venue.highway.portrait.scale = [.4, 2, 3];
    expect(karaokeResponsiveHighwayTransform(.6, venue.highway)).toMatchObject({
      position: [5, 6, 7], scale: [.4, 2, 3],
    });
  });

  it('bounds stage energy while allowing authoritative judgments to add a short accent', () => {
    const base = karaokeStageIntensity(10, 20_000, null);
    expect(karaokeStageIntensity(10, 20_000, { judgment: 'perfect', ageMs: 0 })).toBeGreaterThan(base);
    expect(karaokeStageIntensity(1_000, 1_000_000, { judgment: 'perfect', ageMs: 0 })).toBe(1);
    expect(karaokeStageIntensity(0, 0, { judgment: 'perfect', ageMs: 2_000 })).toBe(.12);
  });

  it('uses same-origin karaoke sockets unless a valid development endpoint is explicit', () => {
    expect(resolveKaraokeWebSocketUrl({ protocol: 'https:', host: 'games.example' })).toBe('wss://games.example/karaoke');
    expect(resolveKaraokeWebSocketUrl({ protocol: 'https:', host: 'games.example' }, null, true))
      .toBe('wss://games.example/karaoke?display=1');
    expect(resolveKaraokeWebSocketUrl({ protocol: 'http:', host: 'localhost:5173' }, 'ws://localhost:8080/karaoke'))
      .toBe('ws://localhost:8080/karaoke');
    expect(resolveKaraokeWebSocketUrl({ protocol: 'http:', host: 'localhost:5173' }, 'ws://localhost:8080/karaoke?display=1'))
      .toBe('ws://localhost:8080/karaoke');
    expect(resolveKaraokeWebSocketUrl({ protocol: 'https:', host: 'games.example' }, 'wss://games.example/karaoke', true))
      .toBe('wss://games.example/karaoke?display=1');
    expect(() => resolveKaraokeWebSocketUrl({ protocol: 'https:', host: 'games.example' }, 'wss://attacker.example/karaoke', true))
      .toThrow(/same-origin/);
    expect(() => resolveKaraokeWebSocketUrl({ protocol: 'http:', host: 'localhost:5173' }, 'ws://localhost:8080/karaoke', true))
      .toThrow(/same-origin/);
    expect(() => resolveKaraokeWebSocketUrl({ protocol: 'http:', host: 'localhost:5173' }, 'ws://localhost:8080/voice'))
      .toThrow(/Karaoke endpoint/);
    expect(() => resolveKaraokeWebSocketUrl({ protocol: 'http:', host: 'localhost' }, 'https://example.com'))
      .toThrow(/ws override/);
  });

  it('allows guide-vocal calibration only in explicit local authoring mode', () => {
    expect(karaokeGuideModeAllowed(true, 'en-US', 'localhost', false)).toBe(true);
    expect(karaokeGuideModeAllowed(true, 'en-US', '127.0.0.1', false)).toBe(true);
    expect(karaokeGuideModeAllowed(true, 'en-US', 'games.example', false)).toBe(false);
    expect(karaokeGuideModeAllowed(true, 'pt-BR', 'localhost', false)).toBe(false);
    expect(karaokeGuideModeAllowed(true, 'en-US', 'localhost', true)).toBe(false);
    expect(karaokeLocalTestingAllowed('localhost', false)).toBe(true);
    expect(karaokeLocalTestingAllowed('127.0.0.1', false)).toBe(true);
    expect(karaokeLocalTestingAllowed('games.example', false)).toBe(false);
    expect(karaokeLocalTestingAllowed('localhost', true)).toBe(false);
    expect(karaokeDisplayMode('games.example', false, false)).toBe(true);
    expect(karaokeDisplayMode('games.example', true, false)).toBe(true);
    expect(karaokeDisplayMode('localhost', false, false)).toBe(false);
    expect(karaokeDisplayPairingRequired('games.example', true, null)).toBe(true);
    expect(karaokeDisplayPairingRequired('games.example', true, 'paired-token')).toBe(false);
    expect(karaokeDisplayPairingRequired('games.example', false, null)).toBe(false);
    expect(karaokeDisplayPairingRequired('localhost', true, null)).toBe(false);
    expect(karaokeAudioPreflightRequired(false, false, false, 'lobby')).toBe(true);
    expect(karaokeAudioPreflightRequired(false, true, true, 'loading')).toBe(true);
    expect(karaokeAudioPreflightRequired(false, true, false, 'lobby')).toBe(false);
    expect(karaokeAudioPreflightRequired(true, false, false, 'lobby')).toBe(false);
    expect(karaokeAudioPreflightRequired(false, false, false, 'performing')).toBe(false);
  });

  it('clamps visual calibration to 20ms steps without depending on browser storage', () => {
    expect(KARAOKE_VISUAL_OFFSET_STEP_MS).toBe(20);
    expect(KARAOKE_VISUAL_OFFSET_LIMIT_MS).toBe(300);
    expect(KARAOKE_VISUAL_OFFSET_STORAGE_KEY).toMatch(/karaoke/i);
    expect(clampKaraokeVisualOffsetMs(31)).toBe(40);
    expect(clampKaraokeVisualOffsetMs(500)).toBe(300);
    expect(clampKaraokeVisualOffsetMs(-500)).toBe(-300);
    expect(clampKaraokeVisualOffsetMs(Number.NaN)).toBe(0);
    expect(karaokeVisualTimeMs(1_000, 20)).toBe(980);
    expect(karaokeVisualTimeMs(1_000, -20)).toBe(1_020);
    expect(() => karaokeVisualTimeMs(Number.NaN, 0)).toThrow(RangeError);
  });

  it('selects the versioned guide vocal only for the licensed English demo song', () => {
    expect(KARAOKE_GUIDE_AUDIO_URL).toMatch(/^\/audio\/karaoke\/classic-45s\.mp3\?v=\S+$/);
    expect(karaokeClientAudioUrl(NEVER_GONNA_GIVE_YOU_UP, true)).toBe(KARAOKE_GUIDE_AUDIO_URL);
    expect(karaokeClientAudioUrl(NEVER_GONNA_GIVE_YOU_UP, false))
      .toBe(NEVER_GONNA_GIVE_YOU_UP.audioUrl);
    expect(karaokeClientAudioUrl(EN_US_ORIGINAL_DEVELOPMENT_SONG, true)).toBeUndefined();
  });
});
