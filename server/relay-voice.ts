import type { SupportedLocale } from '../shared/i18n/locales';

/** Requested English ElevenLabs voice ID for Conversation Relay calls. */
export const DEFAULT_ENGLISH_RELAY_VOICE = 'SA7eD52NRr8WAehitVt1';

/** Keep Brazilian Portuguese on its own voice; an empty value selects Twilio's pt-BR default. */
export function relayVoiceForLocale(
  locale: SupportedLocale,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  if (locale === 'pt-BR') return (environment.CR_TTS_VOICE_PT_BR ?? '').trim();
  return (environment.CR_TTS_VOICE ?? '').trim() || DEFAULT_ENGLISH_RELAY_VOICE;
}
