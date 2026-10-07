import { describe, it, expect } from 'vitest';
import { parseClientMessage } from '../server/game-server';

describe('parseClientMessage', () => {
  it('parses a valid join', () => {
    const m = parseClientMessage(JSON.stringify({ type: 'join', roomCode: '4821', name: 'You' }));
    expect(m).toEqual({ type: 'join', roomCode: '4821', name: 'You' });
  });
  it('accepts an opt-in browser renderer readiness gate', () => {
    const m = parseClientMessage(JSON.stringify({ type: 'join', roomCode: '4821', name: 'You', rendererReadyGate: true }));
    expect(m).toEqual({ type: 'join', roomCode: '4821', name: 'You', rendererReadyGate: true });
  });
  it('parses a valid intent', () => {
    const m = parseClientMessage(JSON.stringify({ type: 'intent', intent: 'MOVE_LEFT' }));
    expect(m).toEqual({ type: 'intent', intent: 'MOVE_LEFT' });
  });
  it('rejects an unknown intent value', () => {
    const m = parseClientMessage(JSON.stringify({ type: 'intent', intent: 'TELEPORT' })) as any;
    expect(m.type).toBe('error');
  });
  it('rejects malformed JSON', () => {
    const m = parseClientMessage('{not json') as any;
    expect(m.type).toBe('error');
  });
  it('rejects an unknown message type', () => {
    const m = parseClientMessage(JSON.stringify({ type: 'launch_missiles' })) as any;
    expect(m.type).toBe('error');
  });
  it('parses spectate', () => {
    const m = parseClientMessage(JSON.stringify({ type: 'spectate', roomCode: '4821' }));
    expect(m).toEqual({ type: 'spectate', roomCode: '4821' });
  });
  it('preserves a supported display locale', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'spectate', roomCode: '4821', locale: 'pt-BR' })))
      .toEqual({ type: 'spectate', roomCode: '4821', locale: 'pt-BR' });
  });
  it('parses leave (shared-screen play toggle → back to spectator)', () => {
    const m = parseClientMessage(JSON.stringify({ type: 'leave' }));
    expect(m).toEqual({ type: 'leave' });
  });
});
