import { speechSafeText } from '../shared/speech-text';
import { DEFAULT_LOCALE, LOCALE_PROFILES, type SupportedLocale } from '../shared/i18n/locales';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** An SMS reply: one outbound message back to the sender. */
export function twimlMessage(text: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${esc(text)}</Message></Response>`;
}

/** An empty response: acknowledge the webhook without sending any SMS (e.g. duplicate retry). */
export function twimlEmpty(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response></Response>`;
}

export function twimlHangup(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Hangup /></Response>`;
}

export function twimlSayAndHangup(text: string, locale: SupportedLocale = DEFAULT_LOCALE): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say language="${esc(LOCALE_PROFILES[locale].ttsLanguage)}">${esc(text)}</Say><Hangup /></Response>`;
}

export function twimlGatherRoomCode(opts: { actionUrl: string; locale?: SupportedLocale }): string {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const prompt = locale === 'pt-BR'
    ? 'Boas-vindas à Corrida por Voz da Twilio. Digite o código de quatro números da sala.'
    : 'Welcome to Twilio Voice Racer. Enter your four digit room code.';
  const goodbye = locale === 'pt-BR' ? 'Nenhum código recebido. Até logo.' : 'No code received. Goodbye.';
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Gather input="dtmf" numDigits="4" timeout="8" action="${esc(opts.actionUrl)}" method="POST">
    <Say language="${esc(LOCALE_PROFILES[locale].ttsLanguage)}">${esc(prompt)}</Say>
  </Gather>
  <Say language="${esc(LOCALE_PROFILES[locale].ttsLanguage)}">${esc(goodbye)}</Say>
</Response>`;
}

export function twimlConnectRelay(opts: {
  wsUrl: string; sessionEndedUrl: string; roomCode: string;
  // TTS voice for talk-back (greeting/countdown/result). ElevenLabs is Conversation Relay's premium
  // provider; `voice` is an ElevenLabs voiceId. Both optional → Relay uses its default voice.
  ttsProvider?: string; voice?: string;
  // Spoken the instant the call connects (before the game WS binds) — a quick intro.
  welcomeGreeting?: string;
  // Which game this call joins, passed to the WS so it routes correctly.
  game?: string;
  readyEntryId?: string;
  matchId?: string;
  launchGeneration?: number;
  relayToken?: string;
  karaokeMode?: 'setup' | 'result';
  // ASR biasing hints — the game's key spoken words (commands / move names) for better recognition.
  hints?: string;
  locale?: SupportedLocale;
}): string {
  const locale = opts.locale ?? DEFAULT_LOCALE;
  const profile = LOCALE_PROFILES[locale];
  // Only emit tts attrs when a voice is configured (an empty voice="" would be invalid).
  const ttsAttrs = opts.voice
    ? ` ttsProvider="${esc(opts.ttsProvider ?? 'ElevenLabs')}" voice="${esc(opts.voice)}"`
    : '';
  const greeting = esc(speechSafeText(opts.welcomeGreeting ?? ''));
  const hints = esc(opts.hints ?? 'left, right, boost, go, brake, slow, stop, nitro, power');
  const gameParam = opts.game ? `\n      <Parameter name="game" value="${esc(opts.game)}" />` : '';
  const readyEntryParam = opts.readyEntryId ? `\n      <Parameter name="readyEntryId" value="${esc(opts.readyEntryId)}" />` : '';
  const matchParams = opts.matchId && Number.isSafeInteger(opts.launchGeneration)
    ? `\n      <Parameter name="matchId" value="${esc(opts.matchId)}" />\n      <Parameter name="launchGeneration" value="${opts.launchGeneration}" />`
    : '';
  const relayTokenParam = opts.relayToken ? `\n      <Parameter name="relayToken" value="${esc(opts.relayToken)}" />` : '';
  const karaokeModeParam = opts.karaokeMode
    ? `\n      <Parameter name="karaokeMode" value="${esc(opts.karaokeMode)}" />`
    : '';
  const localeParams = `\n      <Parameter name="locale" value="${esc(locale)}" />\n      <Parameter name="commandLocale" value="${esc(locale)}" />`;
  // Interruption (barge-in) is a headline Conversation Relay feature and central to this app:
  //  - interruptible="any": speech or keypad input cuts the TTS immediately.
  //  - reportInputDuringAgentSpeech="any": we RECEIVE both speech and DTMF while TTS plays (default
  //    is "none" as of May 2025, which would hide mid-speech commands entirely).
  //  - high sensitivity and backchannels enabled make short "okay" / "go" interruptions work
  //    while a caller is skipping a menu or an explanation.
  // We handle the resulting {type:"interrupt"} message on the WS (stop speaking, trim LLM history).
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect action="${esc(opts.sessionEndedUrl)}">
    <ConversationRelay url="${esc(opts.wsUrl)}"${ttsAttrs} transcriptionProvider="Deepgram" speechModel="flux" partialPrompts="true" transcriptionLanguage="${esc(profile.transcriptionLanguage)}" ttsLanguage="${esc(profile.ttsLanguage)}" interruptible="any" welcomeGreetingInterruptible="any" reportInputDuringAgentSpeech="any" interruptSensitivity="high" ignoreBackchannel="false" dtmfDetection="true" hints="${hints}" speechTimeout="600" eotThreshold="0.6" events="tokens-played" welcomeGreeting="${greeting}">
      <Parameter name="roomCode" value="${esc(opts.roomCode)}" />${gameParam}${readyEntryParam}${matchParams}${relayTokenParam}${karaokeModeParam}${localeParams}
    </ConversationRelay>
  </Connect>
</Response>`;
}

export function twimlKaraokeMedia(opts: {
  streamName: string;
  wsUrl: string;
  statusCallbackUrl: string;
  completeUrl: string;
  customParameters: Readonly<Record<string, string>>;
  pauseLengthSeconds: number;
}): string {
  const streamUrl = new URL(opts.wsUrl);
  if (streamUrl.protocol !== 'wss:' || streamUrl.search || streamUrl.hash
    || streamUrl.username || streamUrl.password) throw new TypeError('Karaoke Media Stream URL must be a query-free WSS URL');
  if (!Number.isSafeInteger(opts.pauseLengthSeconds)
    || opts.pauseLengthSeconds < 1 || opts.pauseLengthSeconds > 60) {
    throw new RangeError('Karaoke media pause must be from 1 to 60 seconds');
  }
  const parameters = Object.entries(opts.customParameters)
    .map(([name, value]) => `\n      <Parameter name="${esc(name)}" value="${esc(value)}" />`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Start>
    <Stream name="${esc(opts.streamName)}" url="${esc(opts.wsUrl)}" track="inbound_track" statusCallback="${esc(opts.statusCallbackUrl)}" statusCallbackMethod="POST">${parameters}
    </Stream>
  </Start>
  <Pause length="${opts.pauseLengthSeconds}" />
  <Stop><Stream name="${esc(opts.streamName)}" /></Stop>
  <Redirect method="POST">${esc(opts.completeUrl)}</Redirect>
</Response>`;
}
