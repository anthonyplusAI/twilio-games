import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { handleRelayPlaybackEvent, relaySpeechMarkup, relayTextChunks,
  sendRelayTextOutcome } from '../server/http-server';

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
afterEach(() => vi.useRealTimers());

describe('relayTextChunks', () => {
  it('uses Twilio official SSML pronunciation only for English Relay speech', () => {
    expect(relaySpeechMarkup('Powered by Twilio Conversation Relay.', 'en-US')).toContain('<phoneme alphabet="ipa" ph="ˈtwɪlioʊ">Twilio</phoneme>');
    expect(relaySpeechMarkup('TWILIO', 'en-US')).toContain('>Twilio</phoneme>');
    expect(relaySpeechMarkup('Tecnologia Twilio Conversation Relay.', 'pt-BR')).toBe('Tecnologia Twilio Conversation Relay.');
  });
  it('splits long Voice Racer control instructions into paced chunks', () => {
    const chunks = relayTextChunks('Before you start, check the controls on the screen. Say left or right to steer. Say boost to speed up. Say brake to slow down. Say nitro to break through a wall.');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toContain('Before you start');
    expect(chunks.at(-1)).toContain('nitro');
  });

  it('splits dense Voice Monsters controls around or-say phrasing', () => {
    const chunks = relayTextChunks('How to play: on your turn, say attack, then pick one of the four moves. You can also say guard, item, or taunt.');
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toContain('say attack');
  });

  it('leaves short non-instruction commentary as one utterance', () => {
    expect(relayTextChunks('Sparkmouse lets loose Thunder Jolt!')).toEqual(['Sparkmouse lets loose Thunder Jolt!']);
  });

  it('preserves a full authored trivia question and all four long choices', () => {
    const question = 'Q'.repeat(240);
    const choices = Array.from({ length: 4 }, (_, index) => `${index + 1}, ${String(index + 1).repeat(100)}`);
    const prompt = `${question} ${choices.join(' ')}`;
    const chunks = relayTextChunks(prompt);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.length <= 500)).toBe(true);
    expect(chunks.join(' ')).toBe(prompt);
  });

  it('streams a long cue as one interruptible talk cycle and waits for its final token', async () => {
    const sent: { type: string; token: string; last: boolean; interruptible: boolean; preemptible: boolean }[] = [];
    const socket = {
      OPEN: 1, readyState: 1,
      send(value: string, callback?: (error?: Error) => void) {
        sent.push(JSON.parse(value));
        callback?.();
      },
    } as unknown as WebSocket;
    const prompt = `${'Q'.repeat(240)} ${Array.from({ length: 4 }, (_, index) =>
      `${index + 1}, ${String(index + 1).repeat(100)}`).join(' ')}`;
    const delivery = sendRelayTextOutcome(socket, prompt);
    let completed = false;
    void delivery.then(() => { completed = true; });
    await nextTurn();
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.slice(0, -1).every(message => message.last === false)).toBe(true);
    expect(sent.at(-1)).toMatchObject({ type: 'text', last: true, interruptible: true, preemptible: true });
    expect(sent.every(message => message.interruptible && message.preemptible)).toBe(true);
    expect(completed).toBe(false);
    handleRelayPlaybackEvent(socket, JSON.stringify({ type: 'info', name: 'tokensPlayed', value: sent[0]!.token }));
    await nextTurn();
    expect(completed).toBe(false);
    handleRelayPlaybackEvent(socket, JSON.stringify({ type: 'info', name: 'tokensPlayed', value: sent.at(-1)!.token }));
    expect(await delivery).toBe('played');
    expect(sent.map(message => message.token.replace(/[\u200B\u2060]/g, '')).join('')).toBe(prompt);
  });

  it('accepts a playback receipt after Relay strips the invisible cue marker and SSML', async () => {
    const sent: Array<{ token: string }> = [];
    const socket = { OPEN: 1, readyState: 1,
      send(value: string, callback?: (error?: Error) => void) {
        sent.push(JSON.parse(value)); callback?.();
      },
    } as unknown as WebSocket;
    const delivery = sendRelayTextOutcome(socket, 'Twilio Conversation Relay speaks your answer.');
    await nextTurn();
    const spoken = sent.at(-1)!.token
      .replace(/<phoneme[^>]*>(.*?)<\/phoneme>/g, '$1')
      .replace(/[\u200B\u2060]/g, '');
    handleRelayPlaybackEvent(socket, JSON.stringify({ type: 'info', name: 'tokensPlayed', value: spoken }));
    expect(await Promise.race([delivery, nextTurn().then(() => 'still pending')])).toBe('played');
  });

  it('does not mistake an unmarked late receipt for a repeated new cue', async () => {
    const sent: Array<{ token: string }> = [];
    const socket = { OPEN: 1, readyState: 1,
      send(value: string, callback?: (error?: Error) => void) {
        sent.push(JSON.parse(value)); callback?.();
      },
    } as unknown as WebSocket;
    const first = sendRelayTextOutcome(socket, 'Please choose a track.');
    await nextTurn();
    const oldToken = sent[0]!.token;
    handleRelayPlaybackEvent(socket, JSON.stringify({ type: 'info', name: 'tokensPlayed', value: oldToken }));
    expect(await first).toBe('played');

    const second = sendRelayTextOutcome(socket, 'Please choose a track.');
    await nextTurn();
    const oldWithoutMarker = oldToken.replace(/[\u200B\u2060]/g, '');
    handleRelayPlaybackEvent(socket, JSON.stringify({ type: 'info', name: 'tokensPlayed', value: oldWithoutMarker }));
    expect(await Promise.race([second, nextTurn().then(() => 'still pending')])).toBe('still pending');
    handleRelayPlaybackEvent(socket, JSON.stringify({ type: 'info', name: 'tokensPlayed', value: sent[1]!.token }));
    expect(await second).toBe('played');
  });

  it('does not settle a new multi-chunk cue from a longer old receipt with the same ending', async () => {
    const sent: Array<{ token: string }> = [];
    const socket = { OPEN: 1, readyState: 1,
      send(value: string, callback?: (error?: Error) => void) {
        sent.push(JSON.parse(value)); callback?.();
      },
    } as unknown as WebSocket;
    const first = sendRelayTextOutcome(socket, 'Please choose a track.');
    await nextTurn();
    const oldToken = sent[0]!.token;
    handleRelayPlaybackEvent(socket, JSON.stringify({ type: 'info', name: 'tokensPlayed', value: oldToken }));
    expect(await first).toBe('played');

    const second = sendRelayTextOutcome(socket, `${'Q'.repeat(500)} Choose a track.`);
    await nextTurn();
    expect(sent).toHaveLength(3);
    const oldWithoutMarker = oldToken.replace(/[\u200B\u2060]/g, '');
    handleRelayPlaybackEvent(socket, JSON.stringify({
      type: 'info', name: 'tokensPlayed', value: oldWithoutMarker,
    }));
    expect(await Promise.race([second, nextTurn().then(() => 'still pending')])).toBe('still pending');
    handleRelayPlaybackEvent(socket, JSON.stringify({
      type: 'info', name: 'tokensPlayed', value: sent.at(-1)!.token,
    }));
    expect(await second).toBe('played');
  });

  it('finishes ordinary speech after a duration estimate when Relay sends no playback event', async () => {
    vi.useFakeTimers();
    const sent: string[] = [];
    const socket = { OPEN: 1, readyState: 1,
      send(value: string, callback?: (error?: Error) => void) { sent.push(value); callback?.(); },
    } as unknown as WebSocket;
    const delivery = sendRelayTextOutcome(socket, 'Ready to play.');
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await delivery).toBe('estimated');
  });

  it('preempts stale screen speech without a late send failure cancelling the new cue', async () => {
    const sent: { token: string }[] = [];
    const callbacks: ((error?: Error) => void)[] = [];
    const socket = { OPEN: 1, readyState: 1,
      send(value: string, callback?: (error?: Error) => void) {
        sent.push(JSON.parse(value));
        if (callback) callbacks.push(callback);
      },
    } as unknown as WebSocket;
    let phase = 'menu';
    const oldSpeech = sendRelayTextOutcome(socket, 'Choose your car.', 'en-US', () => phase === 'menu');
    await nextTurn();
    phase = 'race';
    const newSpeech = sendRelayTextOutcome(socket, 'The race has started.', 'en-US', () => phase === 'race');
    await nextTurn();
    expect(await oldSpeech).toBe('interrupted');
    expect(sent).toHaveLength(2);
    callbacks[0]?.(new Error('late send failure'));
    handleRelayPlaybackEvent(socket, JSON.stringify({
      type: 'info', name: 'tokensPlayed', value: sent[0]!.token,
    }));
    let newSettled = false;
    void newSpeech.then(() => { newSettled = true; });
    await nextTurn();
    expect(newSettled).toBe(false);
    handleRelayPlaybackEvent(socket, JSON.stringify({
      type: 'info', name: 'tokensPlayed', value: sent[1]!.token,
    }));
    expect(await newSpeech).toBe('played');
  });
});
