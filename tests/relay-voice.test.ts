import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGLISH_RELAY_VOICE, relayVoiceForLocale } from '../server/relay-voice';

describe('Conversation Relay voice selection', () => {
  it('uses the requested voice for every English game call by default', () => {
    expect(DEFAULT_ENGLISH_RELAY_VOICE).toBe('SA7eD52NRr8WAehitVt1');
    expect(relayVoiceForLocale('en-US', {})).toBe(`${DEFAULT_ENGLISH_RELAY_VOICE}-flash_v2`);
    expect(relayVoiceForLocale('en-US', { CR_TTS_VOICE: DEFAULT_ENGLISH_RELAY_VOICE }))
      .toBe(`${DEFAULT_ENGLISH_RELAY_VOICE}-flash_v2`);
  });

  it('preserves an explicit English override', () => {
    expect(relayVoiceForLocale('en-US', { CR_TTS_VOICE: 'custom-id' })).toBe('custom-id');
    expect(relayVoiceForLocale('en-US', { CR_TTS_VOICE: 'NYC9WEgkq1u4jiqBseQ9' }))
      .toBe('NYC9WEgkq1u4jiqBseQ9-flash_v2');
    expect(relayVoiceForLocale('en-US', { CR_TTS_VOICE: 'NYC9WEgkq1u4jiqBseQ9-flash_v2' }))
      .toBe('NYC9WEgkq1u4jiqBseQ9-flash_v2');
  });

  it('keeps Portuguese on its own configured voice or Twilio default', () => {
    expect(relayVoiceForLocale('pt-BR', {})).toBe('');
    expect(relayVoiceForLocale('pt-BR', { CR_TTS_VOICE_PT_BR: 'br-id' })).toBe('br-id');
  });
});
