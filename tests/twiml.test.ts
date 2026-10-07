import { describe, it, expect } from 'vitest';
import { twimlGatherRoomCode, twimlConnectRelay, twimlKaraokeMedia, twimlMessage, twimlSayAndHangup } from '../server/twiml';

describe('twimlMessage',()=>{
  it('preserves plain-text line breaks while escaping XML',()=>{
    expect(twimlMessage('Line one\nLine two & safe')).toContain('<Message>Line one\nLine two &amp; safe</Message>');
  });
});

describe('twimlSayAndHangup', () => {
  it('escapes spoken text and applies the requested locale', () => {
    const xml = twimlSayAndHangup('Paused <now> & say "goodbye".', 'pt-BR');
    expect(xml).toContain('<Say language="pt-BR">Paused &lt;now&gt; &amp; say &quot;goodbye&quot;.</Say>');
    expect(xml).toContain('<Hangup />');
    expect(xml).not.toContain('Paused <now>');
  });
});

describe('twimlGatherRoomCode', () => {
  it('asks for a 4-digit room code via DTMF', () => {
    const xml = twimlGatherRoomCode({ actionUrl: 'https://x.test/voice/join' });
    expect(xml).toContain('<?xml');
    expect(xml).toContain('<Gather');
    expect(xml).toContain('input="dtmf"');
    expect(xml).toContain('numDigits="4"');
    expect(xml).toContain('action="https://x.test/voice/join"');
  });
  it('escapes the action URL in the gather', () => {
    const xml = twimlGatherRoomCode({ actionUrl: 'https://x.test/join?a=1&b=2' });
    expect(xml).toContain('https://x.test/join?a=1&amp;b=2');
  });
  it('localizes the legacy room-code prompt', () => {
    const xml = twimlGatherRoomCode({ actionUrl: 'https://x.test/voice/join', locale: 'pt-BR' });
    expect(xml).toContain('language="pt-BR"');
    expect(xml).toContain('Corrida por Voz');
    expect(xml).toContain('código de quatro números');
  });
});

describe('twimlConnectRelay', () => {
  const xml = twimlConnectRelay({
    wsUrl: 'wss://x.test/voice',
    sessionEndedUrl: 'https://x.test/voice/session-ended',
    roomCode: 'ABCD',
  });
  it('connects to ConversationRelay with the wss url', () => {
    expect(xml).toContain('<Connect');
    expect(xml).toContain('<ConversationRelay');
    expect(xml).toContain('url="wss://x.test/voice"');
  });
  it('enables partial transcripts and biases the vocabulary', () => {
    expect(xml).toContain('speechModel="flux"');
    expect(xml).toContain('partialPrompts="true"');
    // Hints must cover every command word the intent parser accepts (voice-intent.ts),
    // so Twilio's STT is primed for the full vocabulary — not just a subset.
    const hints = /hints="([^"]*)"/.exec(xml)?.[1] ?? '';
    for (const word of ['left', 'right', 'boost', 'go', 'brake', 'slow', 'stop', 'nitro', 'power'])
      expect(hints).toContain(word);
    expect(xml).toContain('speechTimeout="600"');
    expect(xml).toContain('eotThreshold="0.6"');
  });
  it('sets the required transcription provider', () => {
    expect(xml).toContain('transcriptionProvider="Deepgram"');
    expect(xml).toContain('transcriptionLanguage="en-US"');
    expect(xml).toContain('ttsLanguage="en-US"');
  });
  it('omits tts voice attrs when no voice is configured (Relay default)', () => {
    expect(xml).toContain('welcomeGreeting=""');
    expect(xml).not.toContain('ttsProvider=');
    expect(xml).not.toContain('voice=');
  });
  it('enables barge-in interruption + receiving speech during TTS (headline CR feature)', () => {
    expect(xml).toContain('interruptible="any"');
    expect(xml).toContain('welcomeGreetingInterruptible="any"');
    expect(xml).toContain('reportInputDuringAgentSpeech="any"');
    // Even a short acknowledgement can interrupt a menu or explanation.
    expect(xml).toContain('interruptSensitivity="high"');
    expect(xml).toContain('ignoreBackchannel="false"');
  });
  it('subscribes to playback completion for graceful call retirement', () => {
    expect(xml).toContain('events="tokens-played"');
  });
  it('emits ElevenLabs tts + welcome greeting when a voice is configured', () => {
    const x = twimlConnectRelay({
      wsUrl: 'wss://x.test/voice', sessionEndedUrl: 'https://x.test/e', roomCode: 'ABCD',
      ttsProvider: 'ElevenLabs', voice: 'voice-123', welcomeGreeting: 'Welcome to Twilio Voice Racer!',
    });
    expect(x).toContain('ttsProvider="ElevenLabs"');
    expect(x).toContain('voice="voice-123"');
    expect(x).toContain('welcomeGreeting="Welcome to Twilio Voice Racer!"');
  });
  it('sanitizes the Relay welcome greeting before XML escaping', () => {
    const x = twimlConnectRelay({
      wsUrl: 'wss://x.test/voice', sessionEndedUrl: 'https://x.test/e', roomCode: 'ABCD',
      welcomeGreeting: 'Load `18_mclaren_senna.glb` <fast> & say “go”…',
    });
    expect(x).toContain('welcomeGreeting="Load 18 mclaren senna &amp; say &quot;go&quot;."');
    expect(x).not.toContain('glb');
    expect(x).not.toContain('`');
    expect(x).not.toContain('<fast>');
  });
  it('passes the room code as a Parameter', () => {
    expect(xml).toContain('<Parameter name="roomCode" value="ABCD"');
    expect(xml).toContain('<Parameter name="commandLocale" value="en-US"');
  });
  it('binds station Relay setup to one match generation', () => {
    const x = twimlConnectRelay({
      wsUrl: 'wss://x.test/voice', sessionEndedUrl: 'https://x.test/e', roomCode: 'ROOM',
      game: 'racer', readyEntryId: 'ready-1', matchId: 'match-1', launchGeneration: 3,
    });
    expect(x).toContain('<Parameter name="readyEntryId" value="ready-1"');
    expect(x).toContain('<Parameter name="matchId" value="match-1"');
    expect(x).toContain('<Parameter name="launchGeneration" value="3"');
  });
  it('configures Brazilian Portuguese recognition and speech', () => {
    const x = twimlConnectRelay({
      wsUrl: 'wss://x.test/voice', sessionEndedUrl: 'https://x.test/e', roomCode: 'ABCD',
      locale: 'pt-BR', hints: 'esquerda, direita, nitro',
    });
    expect(x).toContain('transcriptionLanguage="pt-BR"');
    expect(x).toContain('ttsLanguage="pt-BR"');
    expect(x).toContain('<Parameter name="commandLocale" value="pt-BR"');
    expect(x).toContain('hints="esquerda, direita, nitro"');
  });
  it('escapes XML-special characters in the room code', () => {
    const x = twimlConnectRelay({ wsUrl: 'wss://x.test/voice',
      sessionEndedUrl: 'https://x.test/e', roomCode: 'A&B' });
    expect(x).toContain('value="A&amp;B"');
  });
  it('escapes XML-special characters in all interpolated URLs', () => {
    const x = twimlConnectRelay({
      wsUrl: 'wss://x.test/voice?a=1&b=2',
      sessionEndedUrl: 'https://x.test/end?x=1&y=2',
      roomCode: 'ABCD',
    });
    expect(x).toContain('wss://x.test/voice?a=1&amp;b=2');
    expect(x).toContain('https://x.test/end?x=1&amp;y=2');
    expect(x).not.toContain('&b=2');   // raw unescaped ampersand must not appear
  });
});

describe('twimlKaraokeMedia', () => {
  it('orders Start, bounded Pause, Stop, and Redirect with a query-free inbound stream', () => {
    const xml = twimlKaraokeMedia({
      streamName: 'karaoke-a&b',
      wsUrl: 'wss://games.example/karaoke-media',
      statusCallbackUrl: 'https://games.example/voice/karaoke/stream-status?a=1&b=2',
      completeUrl: 'https://games.example/voice/karaoke/complete?a=1&b=2',
      customParameters: { roomCode: 'A&B', attemptToken: 'token<secret>' },
      pauseLengthSeconds: 53,
    });
    const start = xml.indexOf('<Start>');
    const pause = xml.indexOf('<Pause');
    const stop = xml.indexOf('<Stop>');
    const redirect = xml.indexOf('<Redirect');
    expect(start).toBeLessThan(pause);
    expect(pause).toBeLessThan(stop);
    expect(stop).toBeLessThan(redirect);
    expect(xml).toContain('url="wss://games.example/karaoke-media" track="inbound_track"');
    expect(xml).toContain('<Pause length="53" />');
    expect(xml).toContain('name="roomCode" value="A&amp;B"');
    expect(xml).toContain('value="token&lt;secret&gt;"');
    expect(xml).not.toContain('wss://games.example/karaoke-media?');
    expect(xml).not.toContain('A&B');
  });

  it('rejects query-bearing, insecure, or unbounded stream plans', () => {
    const input = {
      streamName: 'karaoke-test', statusCallbackUrl: 'https://games.example/status',
      completeUrl: 'https://games.example/complete', customParameters: {}, pauseLengthSeconds: 53,
    };
    expect(() => twimlKaraokeMedia({ ...input, wsUrl: 'wss://games.example/karaoke-media?token=x' })).toThrow(/query-free/);
    expect(() => twimlKaraokeMedia({ ...input, wsUrl: 'ws://games.example/karaoke-media' })).toThrow(/WSS/);
    expect(() => twimlKaraokeMedia({ ...input, wsUrl: 'wss://games.example/karaoke-media', pauseLengthSeconds: 61 })).toThrow(/1 to 60/);
  });
});
