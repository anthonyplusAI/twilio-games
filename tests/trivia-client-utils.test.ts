import { describe, expect, it } from 'vitest';
import {
  TriviaCountdownSoundCue,
  TriviaServerClock,
  resolveTriviaWebSocketUrl,
  triviaCountdownCount,
  triviaDisplayPairingRequired,
  triviaQuestionTiming,
} from '../client/trivia/trivia-client-utils';

describe('Trivia display timing and URLs', () => {
  it('derives the twenty-five-second display timer from server timestamps', () => {
    expect(triviaQuestionTiming(20_000, 45_000, 23_401)).toEqual({
      remainingMs: 21_599,
      remainingSeconds: 22,
      progress: 0.86396,
    });
    expect(triviaQuestionTiming(20_000, 45_000, 46_000)).toEqual({
      remainingMs: 0,
      remainingSeconds: 0,
      progress: 0,
    });
    expect(triviaCountdownCount(10_000, 7_100)).toBe(3);
    expect(triviaCountdownCount(10_000, 8_100)).toBe(2);
    expect(triviaCountdownCount(10_000, 9_100)).toBe(1);
  });

  it('keeps a monotonic server clock using the lowest round-trip sample', () => {
    const clock = new TriviaServerClock(1_000, 50);
    expect(clock.observeSync({ serverNowMs: 5_100, clientSentAtMs: 1_000, clientReceivedAtMs: 1_200 })).toBe(true);
    expect(clock.now(150)).toBe(5_100);
    expect(clock.observeSync({ serverNowMs: 5_350, clientSentAtMs: 1_200, clientReceivedAtMs: 1_500 })).toBe(false);
    expect(clock.now(160)).toBe(5_110);
    expect(clock.now(140)).toBe(5_110);
  });

  it('uses a same-origin display socket and only permits cross-port loopback for non-displays', () => {
    expect(resolveTriviaWebSocketUrl({ protocol: 'https:', host: 'games.example' }))
      .toBe('wss://games.example/trivia?display=1');
    expect(resolveTriviaWebSocketUrl(
      { protocol: 'http:', host: 'localhost:5173' },
      'ws://localhost:8080/trivia',
      false,
    )).toBe('ws://localhost:8080/trivia');
    expect(() => resolveTriviaWebSocketUrl(
      { protocol: 'http:', host: 'localhost:5173' },
      'ws://localhost:8080/trivia',
      true,
    )).toThrow(/same-origin/);
    expect(() => resolveTriviaWebSocketUrl(
      { protocol: 'https:', host: 'games.example' },
      'wss://games.example/voice',
    )).toThrow(/Trivia endpoint/);
  });

  it('requires pairing only for a non-loopback station launch without a display token', () => {
    expect(triviaDisplayPairingRequired('games.example', true, null)).toBe(true);
    expect(triviaDisplayPairingRequired('games.example', true, 'token')).toBe(false);
    expect(triviaDisplayPairingRequired('localhost', true, null)).toBe(false);
    expect(triviaDisplayPairingRequired('games.example', false, null)).toBe(false);
  });

  it('starts the shared English countdown clip once at server-timed 3 for each generation', () => {
    const cue = new TriviaCountdownSoundCue();
    let plays = 0;
    const play = () => { plays += 1; };
    cue.update('loading', 1, 'en-US', 3, play);
    cue.update('countdown', 1, 'en-US', 2, play);
    cue.update('countdown', 1, 'en-US', 3, play);
    cue.update('countdown', 1, 'en-US', 3, play);
    cue.update('countdown', 2, 'pt-BR', 3, play);
    cue.update('countdown', 2, 'en-US', 3, play);
    expect(plays).toBe(2);
  });
});
