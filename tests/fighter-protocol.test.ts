import { describe, expect, it } from 'vitest';
import { fighterIntroStage, parseFighterClientMessage } from '../shared/fighter-protocol';

describe('fighter protocol', () => {
  it('preserves a supported display locale', () => {
    expect(parseFighterClientMessage(JSON.stringify({ type: 'spectate', roomCode: '4821', locale: 'pt-BR' })))
      .toEqual({ type: 'spectate', roomCode: '4821', locale: 'pt-BR' });
  });
  it('accepts only one or two initial standalone seats', () => {
    expect(parseFighterClientMessage('{"type":"spectate","roomCode":"4821","initialSeatCount":2}'))
      .toEqual({ type: 'spectate', roomCode: '4821', initialSeatCount: 2 });
    expect(parseFighterClientMessage('{"type":"join","roomCode":"4821","name":"Tester","initialSeatCount":2}'))
      .toEqual({ type: 'join', roomCode: '4821', name: 'Tester', initialSeatCount: 2 });
    expect(parseFighterClientMessage('{"type":"spectate","roomCode":"4821","initialSeatCount":3}'))
      .toMatchObject({ type: 'error', code: 'bad_spectate' });
    expect(parseFighterClientMessage('{"type":"join","roomCode":"4821","name":"Tester","initialSeatCount":0}'))
      .toMatchObject({ type: 'error', code: 'bad_join' });
  });
  it('parses every combat command', () => {
    for (const command of ['forward', 'back', 'jump', 'punch', 'kick', 'block']) {
      expect(parseFighterClientMessage(JSON.stringify({ type: 'command', command }))).toEqual({ type: 'command', command });
    }
  });
  it('rejects arbitrary commands and sides', () => {
    expect(parseFighterClientMessage(JSON.stringify({ type: 'command', command: 'win', fighter: 'p2' }))).toMatchObject({ type: 'error' });
  });
  it('requires a room and session token for a reconnect-safe release', () => {
    expect(parseFighterClientMessage('{"type":"release_session","roomCode":"4821","sessionId":"session-1"}'))
      .toEqual({ type: 'release_session', roomCode: '4821', sessionId: 'session-1' });
    expect(parseFighterClientMessage('{"type":"release_session","roomCode":"4821"}'))
      .toMatchObject({ type: 'error', code: 'bad_release' });
  });
  it('parses selection and navigation messages', () => {
    expect(parseFighterClientMessage('{"type":"select_fighter","fighterId":"nyx"}')).toEqual({ type: 'select_fighter', fighterId: 'nyx' });
    expect(parseFighterClientMessage('{"type":"select_map","mapId":"void"}')).toEqual({ type: 'select_map', mapId: 'void' });
    expect(parseFighterClientMessage('{"type":"advance"}')).toEqual({ type: 'advance' });
    expect(parseFighterClientMessage('{"type":"ready"}')).toMatchObject({ type: 'error', code: 'bad_ready' });
    expect(parseFighterClientMessage('{"type":"display_auth","roomCode":"4821","token":"secret"}')).toEqual({ type: 'display_auth', roomCode: '4821', token: 'secret' });
    expect(parseFighterClientMessage('{"type":"ready","loadingGeneration":2}')).toEqual({ type: 'ready', loadingGeneration: 2 });
    expect(parseFighterClientMessage('{"type":"ready","loadingGeneration":0}')).toMatchObject({ type: 'error', code: 'bad_ready' });
    expect(parseFighterClientMessage('{"type":"retry_loading","loadingGeneration":2}')).toEqual({ type: 'retry_loading', loadingGeneration: 2 });
    expect(parseFighterClientMessage('{"type":"display_select_fighter","playerId":"f1","fighterId":"nyx"}'))
      .toEqual({ type: 'display_select_fighter', playerId: 'f1', fighterId: 'nyx' });
    expect(parseFighterClientMessage('{"type":"display_select_map","playerId":"f1","mapId":"void"}'))
      .toEqual({ type: 'display_select_map', playerId: 'f1', mapId: 'void' });
    expect(parseFighterClientMessage('{"type":"display_select_fighter","playerId":"","fighterId":"nyx"}'))
      .toMatchObject({ type: 'error', code: 'bad_select' });
    expect(parseFighterClientMessage('{"type":"ack_display","phase":"results","loadingGeneration":2}'))
      .toEqual({type:'ack_display',phase:'results',loadingGeneration:2});
    expect(parseFighterClientMessage('{"type":"ack_display","phase":"fight","loadingGeneration":0}'))
      .toMatchObject({type:'error',code:'bad_ack'});
  });
  it('uses one authoritative timeline for every intro segment', () => {
    expect(fighterIntroStage(14)).toBe('p1');
    expect(fighterIntroStage(9.9)).toBe('versus');
    expect(fighterIntroStage(7.9)).toBe('p2');
    expect(fighterIntroStage(3.9)).toBe('faceoff');
  });
});
