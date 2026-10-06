import { HttpServer } from './http-server';
import { ArcadeApi } from './arcade-api';
import { createDubLinkShortener } from './dub-link-shortener';
import { ArcadeConfigStore } from './arcade-config-store';
import { ArcadeEventHub } from './arcade-events';
import { ArcadeTacGateway } from './arcade-tac-gateway';
import { ArcadePlayerRuntime } from './arcade-player-runtime';
import { GoogleAnalyticsAuth } from './google-analytics-auth';
import { TwilioMessagingTransport } from './twilio-messaging';
import type { ArcadeMessagingChannel, ArcadeStationNotificationKind } from './arcade-state-store';

const port = Number(process.env.PORT ?? 8080);
const publicBaseUrl = process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const additionalAuthTokens = [process.env.TWILIO_PT_AUTH_TOKEN]
  .map(value => value?.trim())
  .filter((value): value is string => Boolean(value));
const smsNumber = configuredMessagingSender(
  process.env.TWILIO_SMS_NUMBER ?? process.env.TWILIO_PHONE_NUMBER,
);
const whatsappNumber = configuredMessagingSender(process.env.TWILIO_WHATSAPP_NUMBER);
const outboundRestCredentialsConfigured = configuredCredential(
  process.env.TWILIO_ACCOUNT_SID, /^AC[a-fA-F0-9]{32}$/,
) && configuredCredential(process.env.TWILIO_API_KEY, /^SK[a-fA-F0-9]{32}$/)
  && configuredCredential(process.env.TWILIO_API_SECRET);
// FAIL CLOSED: validate Twilio webhook signatures by DEFAULT whenever an auth token is set,
// regardless of NODE_ENV (a deploy that forgets NODE_ENV=production must NOT silently drop auth).
// Local dev without a token has nothing to validate against; opt out explicitly only if needed.
const validateSignatures = process.env.TWILIO_VALIDATE_SIGNATURES
  ? process.env.TWILIO_VALIDATE_SIGNATURES !== 'false'
  : Boolean(authToken || additionalAuthTokens.length) || process.env.NODE_ENV === 'production';
const standaloneVoiceEnabled = process.env.ARCADE_STANDALONE_VOICE_ENABLED === undefined
  ? process.env.NODE_ENV !== 'production'
  : process.env.ARCADE_STANDALONE_VOICE_ENABLED === 'true';
const configuredDeepgramKey = (process.env.DEEPGRAM_API_KEY ?? '').trim();
const deepgramApiKey = configuredDeepgramKey === 'disabled' ? '' : configuredDeepgramKey;
const karaokeCalibrationOffsetMs = Number(process.env.KARAOKE_CALIBRATION_OFFSET_MS || 0);
if (!Number.isInteger(karaokeCalibrationOffsetMs)
  || karaokeCalibrationOffsetMs < -5_000 || karaokeCalibrationOffsetMs > 5_000) {
  throw new Error('KARAOKE_CALIBRATION_OFFSET_MS must be an integer from -5000 to 5000');
}

if (validateSignatures && !authToken) {
  console.warn('[security] signature validation is ON but TWILIO_AUTH_TOKEN is unset — webhooks will 500 until it is configured.');
}
if (process.env.NODE_ENV === 'production' && !deepgramApiKey) {
  throw new Error('DEEPGRAM_API_KEY is required in production while Voice Karaoke is enabled');
}

// When EDITOR_TOKEN is set, /api writes (manifest + maps) require it — gate the editor on a public
// deploy. Unset (local dev) leaves writes open so the editor works with zero setup.
const editorToken = process.env.EDITOR_TOKEN;
const analyticsAuth = new GoogleAnalyticsAuth({
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  redirectUri: `${publicBaseUrl.replace(/\/$/, '')}/auth/google/callback`,
  allowedEmail: process.env.ANALYTICS_ALLOWED_EMAIL,
  adminPin: process.env.ANALYTICS_ADMIN_PIN,
});
const operatorAuthRequired = process.env.NODE_ENV === 'production'
  || analyticsAuth.configured
  || !isLoopbackUrl(publicBaseUrl);
const arcadeEvents = new ArcadeEventHub(error => {
  console.error('[arcade-events] subscriber failed:', error instanceof Error ? error.message : String(error));
});
const arcadeConfigStore = new ArcadeConfigStore({
  directory: process.env.ARCADE_CONFIG_DIRECTORY ?? 'data',
  deploymentMode: 'single-process',
  events: arcadeEvents,
});
const arcadeTacGateway = process.env.ARCADE_TAC_ENABLED === 'false'
  ? undefined
  : new ArcadeTacGateway({ configStore: arcadeConfigStore, events: arcadeEvents });
const localArcadeSigningSecret = process.env.NODE_ENV === 'production' ? undefined : '0'.repeat(64);
const arcadePlayerRuntime = new ArcadePlayerRuntime({
  configStore: arcadeConfigStore,
  events: arcadeEvents,
  stateFile: process.env.ARCADE_STATE_PATH ?? 'data/arcade-state.json',
  publicBaseUrl,
  signingSecret: () => process.env.ARCADE_SIGNING_SECRET ?? localArcadeSigningSecret,
  outboundMessaging: {
    enabled: (channel?: ArcadeMessagingChannel) => process.env.ARCADE_OUTBOUND_MESSAGING_ENABLED === 'true'
      && (channel === undefined || (outboundRestCredentialsConfigured
        && (channel === 'sms' ? smsNumber !== null : whatsappNumber !== null))),
    callNumber: locale => arcadeConfigStore.getSnapshot().channels.voiceNumbers[locale]
      ?? process.env.GAME_PHONE_NUMBER,
    whatsappContentSid: (kind, locale) => process.env[whatsappContentSidEnvironmentName(kind, locale)],
    createTransport: () => new TwilioMessagingTransport({
      accountSid: process.env.TWILIO_ACCOUNT_SID,
      apiKey: process.env.TWILIO_API_KEY,
      apiSecret: process.env.TWILIO_API_SECRET,
      smsFrom: smsNumber ?? undefined,
      whatsappFrom: whatsappNumber ?? undefined,
      messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
    }),
  },
});
const arcadeApi = new ArcadeApi({
  configStore: arcadeConfigStore,
  events: arcadeEvents,
  publicBaseUrl,
  tacStatus: () => arcadeTacGateway?.getStatus() ?? { started: false, mode: 'off', connected: false, lastError: null },
  tacRequired: arcadeTacGateway !== undefined,
  playerRuntime: arcadePlayerRuntime,
  displayToken: process.env.ARCADE_DISPLAY_TOKEN,
  fallbackVoiceNumber: process.env.GAME_PHONE_NUMBER,
  messagingCapabilities: { sms: smsNumber !== null, whatsapp: whatsappNumber !== null },
  messagingProfileNameReady: identity => {
    void arcadeTacGateway?.syncProfileName(identity).catch(error => {
      console.error('[TAC] Conversation Memory name sync failed:', error instanceof Error ? error.message : String(error));
    });
  },
  deleteMemoryProfile: arcadeTacGateway
    ? profileId => arcadeTacGateway.deleteProfile(profileId)
    : undefined,
  memoryProfileDeleted: profileId => arcadeTacGateway?.isProfileDeleted(profileId) === true,
  shortenUrl: createDubLinkShortener({
    apiKey: process.env.DUB_API_KEY === 'disabled' ? undefined : process.env.DUB_API_KEY,
    domain: process.env.DUB_SHORT_DOMAIN,
    folderId: process.env.DUB_FOLDER_ID === 'disabled' ? undefined : process.env.DUB_FOLDER_ID,
  }),
  authorizeAdmin: request => analyticsAuth.currentOperatorUser(request)
    ?? (operatorAuthRequired ? null : { email: 'operator-console@local.invalid' }),
});
arcadeTacGateway?.setMessageHandler(async input => {
  const author = input.channel === 'whatsapp' && !input.author.toLowerCase().startsWith('whatsapp:')
    ? `whatsapp:${input.author}`
    : input.author;
  if (input.profileId) {
    await arcadeApi.attachMessagingProfile({
      from: author,
      conversationProfileId: input.profileId,
    });
    const identity = await arcadeApi.messagingMemoryIdentity(author);
    if (identity) {
      void arcadeTacGateway.syncProfileName(identity).catch(error => {
        console.error('[TAC] Conversation Memory name sync failed:', error instanceof Error ? error.message : String(error));
      });
    }
  }
  // The signed provider webhook owns deterministic state and the immediate player reply. TAC only
  // enriches Conversation Memory identity, so either webhook order is safe and never sends twice.
  return null;
});
// Deploy-safe levels: the LIVE maps file lives on the persistent mount (data/maps.json) so editor-
// authored levels survive redeploys; the image's committed assets/maps/maps.json is the one-time
// SEED copied in on first boot when the persistent file doesn't exist yet.
const srv = new HttpServer({
  port, publicBaseUrl, authToken, additionalAuthTokens, validateSignatures, editorToken,
  voiceRelayToken: process.env.VOICE_RELAY_TOKEN,
  analyticsAuth, arcadeApi, arcadeTacGateway, standaloneVoiceEnabled, operatorAuthRequired,
  analyticsPath: process.env.ANALYTICS_PATH ?? 'data/analytics.json',
  googleOAuthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  mapsPath: process.env.MAPS_PATH ?? 'data/maps.json',
  bundledMapsPath: process.env.BUNDLED_MAPS_PATH ?? 'assets/maps/maps.json',
  // Voice Monsters arena config — live on the persistent mount, seeded from the committed default.
  arenaPath: process.env.ARENA_PATH ?? 'data/arena.json',
  bundledArenaPath: process.env.BUNDLED_ARENA_PATH ?? 'assets/arena/arena.json',
  karaokeVenuePath: process.env.KARAOKE_VENUE_PATH ?? 'data/karaoke-venue.json',
  bundledKaraokeVenuePath: process.env.BUNDLED_KARAOKE_VENUE_PATH ?? 'assets/karaoke/venue.json',
  karaokeTimingsPath: process.env.KARAOKE_TIMINGS_PATH ?? 'data/karaoke-timings.json',
  karaokeAssetDirectory: process.env.KARAOKE_ASSET_DIRECTORY ?? 'assets/karaoke',
  karaokeLeaderboardPath: process.env.KARAOKE_LEADERBOARD_PATH ?? 'data/karaoke-leaderboard.json',
  triviaQuestionsPath: process.env.TRIVIA_QUESTIONS_PATH ?? 'data/trivia-questions.json',
  bundledTriviaQuestionsPath: process.env.BUNDLED_TRIVIA_QUESTIONS_PATH ?? 'content/trivia/questions.json',
  triviaLeaderboardPath: process.env.TRIVIA_LEADERBOARD_PATH ?? 'data/trivia-leaderboard.json',
  triviaAnonymizationSalt: process.env.ARCADE_SIGNING_SECRET ?? authToken,
  fighterMapsPath: process.env.FIGHTER_MAPS_PATH ?? 'data/fighter-maps.json',
  bundledFighterMapsPath: process.env.BUNDLED_FIGHTER_MAPS_PATH ?? 'assets/fighters/maps/maps.json',
  fighterPreviewDir: process.env.FIGHTER_PREVIEW_DIR ?? 'data/fighter-previews',
  fighterDisplayToken: process.env.ARCADE_DISPLAY_TOKEN ?? process.env.FIGHTER_DISPLAY_TOKEN,
  karaokeDisplayToken: process.env.ARCADE_DISPLAY_TOKEN ?? process.env.FIGHTER_DISPLAY_TOKEN,
  triviaDisplayToken: process.env.ARCADE_DISPLAY_TOKEN ?? process.env.FIGHTER_DISPLAY_TOKEN,
  chessDisplayToken: process.env.ARCADE_DISPLAY_TOKEN ?? process.env.FIGHTER_DISPLAY_TOKEN,
  // The number players call to join (shown + QR-encoded on the lobby screen). Unset → placeholder.
  gamePhoneNumber: process.env.GAME_PHONE_NUMBER,
  smsNumber: smsNumber ?? undefined,
  whatsappNumber: whatsappNumber ?? undefined,
  deepgramApiKey,
  karaokeCalibrationOffsetMs,
});
srv.start().then((p) => {
  console.log(`Voice Racer listening on http://localhost:${p}`);
  console.log(`  game WS: ws://localhost:${p}/game   voice WS: ws://localhost:${p}/voice`);
  console.log(`  karaoke WS: ws://localhost:${p}/karaoke   media WS: wss://${new URL(publicBaseUrl).host}/karaoke-media`);
  console.log(`  trivia WS: ws://localhost:${p}/trivia   questions: ${process.env.TRIVIA_QUESTIONS_PATH ?? 'data/trivia-questions.json'}`);
  console.log(`  chess WS: ws://localhost:${p}/chess`);
  console.log(`  webhooks: POST ${publicBaseUrl}/voice/incoming , /voice/join`);
  console.log(`  twilio signature validation: ${validateSignatures ? 'ON' : 'OFF'}`);
});
const shutdown = () => srv.stop().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function whatsappContentSidEnvironmentName(
  kind: ArcadeStationNotificationKind,
  locale: 'en-US' | 'pt-BR',
): string {
  return `TWILIO_WHATSAPP_CONTENT_SID_${kind}_${locale === 'pt-BR' ? 'PT_BR' : 'EN_US'}`;
}

function configuredMessagingSender(value: string | undefined): string | null {
  const normalized = (value?.trim() ?? '').replace(/^whatsapp:/i, '');
  return /^\+[1-9][0-9]{7,14}$/.test(normalized) ? normalized : null;
}

function configuredCredential(value: string | undefined, pattern?: RegExp): boolean {
  const normalized = value?.trim() ?? '';
  return normalized !== '' && normalized !== 'disabled' && (!pattern || pattern.test(normalized));
}

function isLoopbackUrl(value: string): boolean {
  try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(value).hostname); }
  catch { return false; }
}
