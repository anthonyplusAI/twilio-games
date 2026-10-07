import http from 'http';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, readdir, rename, mkdir, stat } from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import twilio from 'twilio';
import { GameServer } from './game-server';
import { BattleServer } from './battle-server';
import { FighterServer } from './fighter-server';
import { KaraokeServer } from './karaoke-server';
import { TriviaServer, type TriviaServerOptions } from './trivia-server';
import { ChessServer } from './chess-server';
import { ChessVoiceSession } from './chess-voice';
import { TriviaVoiceSession, type TriviaVoiceSnapshot } from './trivia-voice';
import { TriviaContentStore } from './trivia-content-store';
import {
  KaraokeMediaRuntime,
  type KaraokeMediaAttempt,
  type KaraokeMediaFinalResult,
} from './karaoke-media-runtime';
import { DirectDeepgramLyricRecognizerFactory } from './karaoke-deepgram-recognizer';
import type { KaraokeLyricRecognizerFactory } from './karaoke-lyric-recognizer';
import { KaraokeVoiceSession, type KaraokeSpeechOutcome, type KaraokeVoiceEndHandoff,
  type KaraokeVoiceSnapshot } from './karaoke-voice';
import { ConversationRelayAdapter } from './conversation-relay';
import { ordinal } from './voice-lines';
import { twimlConnectRelay, twimlHangup, twimlKaraokeMedia, twimlMessage, twimlEmpty, twimlSayAndHangup } from './twiml';
import { validateTwilioSignature } from './twilio-signature';
import { ManifestStore } from './manifest-store';
import { parseManifest } from '../shared/asset-manifest';
import { mergeMapConfig } from '../shared/maps-store';
import { seedMapsPlan } from './maps-seed';
import { DEFAULT_ROOM, LAP_TARGET } from '../shared/constants';
import { appendResults, MAX_LEADERBOARD_HISTORY, parseLeaderboard, parseLeaderboardStrict, topEntries, type LeaderboardEntry } from '../shared/leaderboard-store';
import {
  appendKaraokeResult,
  parseKaraokeLeaderboard,
  parseKaraokeLeaderboardStrict,
  topKaraokeEntries,
  type KaraokeLeaderboardEntry,
} from '../shared/karaoke-leaderboard-store';
import {
  TRIVIA_ALL_TIME_BOARD_ID,
  TRIVIA_BOARD_IDS,
  TriviaLeaderboardStore,
  isTriviaBoardId,
  parseTriviaLeaderboardStrict,
  type PublicTriviaLeaderboardEntry,
  type StoredTriviaLeaderboardEntry,
  type TriviaBoardId,
} from '../shared/trivia-leaderboard-store';
import { speechSafeText } from '../shared/speech-text';
import { relayVoiceForLocale } from './relay-voice';
import { SmsConcierge, type ConciergeRoom } from './sms-concierge';
import { OpenAiClient, NullLlmClient, type LlmClient } from './llm';
import { matchChoice, clearSelectionIndex, type HostContext } from './game-host';
import { interpretVoiceTurn, type VoiceInterpretAction, type VoiceInterpretChoice,
  type VoiceInterpretFact, type VoiceInterpretRequest } from './voice-interpreter';
import { BattleVoiceSession, parseSpokenName, isAdvanceWord, type BattleVoiceSnapshot } from './battle-voice';
import { FighterVoiceSession, type FighterVoiceSnapshot } from './fighter-voice';
import type { BattleHostContext } from './battle-host';
import { monsterById, rosterEntries } from '../shared/monster-roster';
import type { Room } from './room';
import type { Phase,RaceResult } from '../shared/types';
import { FIGHTER_MAPS, FIGHTER_ROSTER, type FighterMapEntry } from '../shared/fighter-roster';
import { parseFighterMaps } from '../shared/fighter-maps';
import { ANALYTICS_GAMES, type AnalyticsGame } from '../shared/analytics';
import { AnalyticsStore, validDate } from './analytics-store';
import { AnalyticsObserver } from './analytics-observer';
import { analyticsPdf } from './analytics-pdf';
import { GoogleAnalyticsAuth } from './google-analytics-auth';
import type { ArcadeApi, PlayerResetCleanupContext } from './arcade-api';
import type { ArcadeTacGateway } from './arcade-tac-gateway';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, resolveLocale, type SupportedLocale } from '../shared/i18n/locales';
import { KARAOKE_COUNTDOWN_MS, type KaraokeResult } from '../shared/karaoke-protocol';
import { isSafeKaraokeId, KARAOKE_SONG_DURATION_MS } from '../shared/karaoke';
import {
  TRIVIA_CATEGORY_IDS,
  TRIVIA_MAX_JSON_LENGTH,
  isSafeTriviaId,
  parseTriviaQuestionBankJson,
  type TriviaQuestionBank,
} from '../shared/trivia';
import { parseTriviaClientMessage, type TriviaResult } from '../shared/trivia-protocol';
import { KARAOKE_DEVELOPMENT_SONGS } from '../shared/karaoke-songs';
import {
  EMPTY_KARAOKE_TIMING_CONFIG,
  applyKaraokeTimingConfig,
  parseKaraokeTimingConfig,
  type KaraokeTimingConfig,
} from '../shared/karaoke-timings';
import {
  DEFAULT_KARAOKE_VENUE,
  cloneKaraokeVenueConfig,
  isSafeKaraokeGlbBasename,
  parseKaraokeVenueConfig,
  type KaraokeVenueConfig,
} from '../shared/karaoke-venue';
import type { PlayableArcadeGame } from '../shared/arcade-games';
import { RACER_MESSAGES } from '../shared/i18n/racer';
import { MONSTERS_MESSAGES } from '../shared/i18n/monsters';
import { createTranslator, normalizeForMatching } from '../shared/i18n/translate';
import { intentsFromTranscript } from './voice-intent';
import {
  carName as localizedCarName,
  trackName as localizedTrackName,
  localizedCarAliases,
  localizedTrackAliases,
  monsterName as localizedMonsterName,
  moveName as localizedMoveName,
  fighterName as localizedFighterName,
  fighterMapName as localizedFighterMapName,
  localizedMonsterAliases,
  localizedMoveAliases,
  localizedFighterAliases,
} from '../shared/i18n/content';

const BATTLE_VOICE_RECONNECT_GRACE_MS = 30_000;
const FIGHTER_VOICE_RECONNECT_GRACE_MS = 30_000;
const RACER_VOICE_RECONNECT_GRACE_MS = 30_000;
const KARAOKE_VOICE_RECONNECT_GRACE_MS = 30_000;
const TRIVIA_VOICE_RECONNECT_GRACE_MS = 30_000;
const CHESS_VOICE_RECONNECT_GRACE_MS = 30_000;
export const TRIVIA_PUBLIC_DISPLAY_LIMIT = 8;
export const TRIVIA_PENDING_CONNECTION_LIMIT = 8;
export const TRIVIA_IDENTIFICATION_TIMEOUT_MS = 5_000;
const TRIVIA_RESULT_PERSISTENCE_LIMIT = 256;
const KARAOKE_MEDIA_GRACE_SECONDS = 5;
const KARAOKE_FAILURE_LOCALE_RETENTION_MS = 5 * 60_000;
const KARAOKE_HANDOFF_RESPONSE_RETENTION_MS = 5 * 60_000;
const KARAOKE_MAX_HANDOFF_RESPONSES = 256;
const KARAOKE_COMPLETION_RETRY_SECONDS = 1;
const KARAOKE_MAX_COMPLETION_RETRIES = 3;
const KARAOKE_MEDIA_PAUSE_SECONDS = (KARAOKE_COUNTDOWN_MS + KARAOKE_SONG_DURATION_MS) / 1_000
  + KARAOKE_MEDIA_GRACE_SECONDS;
const VOICE_XML_HEADERS = { 'Content-Type': 'text/xml; charset=utf-8' } as const;
const VOICE_UNAVAILABLE_MESSAGES: Record<SupportedLocale, string> = {
  'en-US': 'Twilio Games voice play is unavailable right now. Please ask booth staff for help. Goodbye.',
  'pt-BR': 'Os jogos por voz do Twilio Games não estão disponíveis agora. Peça ajuda à equipe. Até logo.',
};

function runtimeFighterMaps(maps: FighterMapEntry[]): FighterMapEntry[] {
  return maps.map(map => {
    if (map.id !== 'rain' || !map.file) return map;
    const { file: _file, ...procedural } = map;
    return procedural;
  });
}

export function isRacerAdvanceWord(spoken: string, locale: SupportedLocale = DEFAULT_LOCALE): boolean {
  const text = normalizeForMatching(spoken, locale);
  // Questions and explicit negation should be interpreted in context, never treated as a
  // fast-path command just because they contain "start" or "race".
  if (/[?？¿]/u.test(spoken)
    || /\b(?:don't|dont|don t|do not|can't|cannot|not|never|no|nao|nem|wait|hold|espere|espera)\b/.test(text)
    || /^(?:when|why|what|which|who|how|can|could|would|should|do|does|did|is|are|am|may|will|tell me|explain|quando|por que|qual|quais|quem|como|posso|podemos|poderia|devo|sera|voce pode)\b/.test(text)) return false;
  return locale === 'pt-BR'
    ? /\b(comecar|iniciar|proximo|proxima|continuar|pronto|pronta|revanche|correr|corrida|de novo|correr de novo|vamos correr|sim)\b/.test(text)
    : /\b(start|begin|go|next|continue|ready|race|rematch|again|race again|go again|yes)\b/.test(text);
}

function isRacerCorrection(spoken:string,locale:SupportedLocale):boolean {
  const text=normalizeForMatching(spoken,locale);
  return locale==='pt-BR'
    ?/\b(mudar|trocar|corrigir|na verdade|em vez disso)\b/.test(text)
    :/\b(change|switch|correct|actually|instead)\b/.test(text);
}

export function isLateRacerGameplayPrompt(spoken: string, locale: SupportedLocale = DEFAULT_LOCALE): boolean {
  const text = normalizeForMatching(spoken, locale);
  const explicitRematch = locale === 'pt-BR'
    ? /\b(revanche|de novo|correr de novo|vamos correr|sim)\b/.test(text)
    : /\b(rematch|again|race again|go again|yes)\b/.test(text);
  return !explicitRematch && intentsFromTranscript(spoken, locale).length > 0;
}

interface BattleVoiceCallBinding {
  code: string;
  playerId: string;
  locale: SupportedLocale;
  activeSession: BattleVoiceSession | null;
  leaveTimer: ReturnType<typeof setTimeout> | null;
}
interface FighterVoiceCallBinding {
  code: string; playerId: string; locale: SupportedLocale; activeSession: FighterVoiceSession | null;
  leaveTimer: ReturnType<typeof setTimeout> | null;
}
interface RacerVoiceCallBinding {
  code: string;
  playerId: string;
  locale: SupportedLocale;
  activeAdapter: ConversationRelayAdapter | null;
  leaveTimer: ReturnType<typeof setTimeout> | null;
}
interface KaraokeHandoffIntent {
  handoffData: string;
  roomCode: string;
  playerId: string;
  songId: string;
  loadingGeneration: number;
  locale: SupportedLocale;
}
interface KaraokeVoiceCallBinding {
  code: string;
  playerId: string;
  locale: SupportedLocale;
  accountSid: string;
  activeSession: KaraokeVoiceSession | null;
  leaveTimer: ReturnType<typeof setTimeout> | null;
  pendingHandoff: KaraokeHandoffIntent | null;
  attemptId: string | null;
  streamName: string | null;
  streamSid: string | null;
  lifecycle: 'setup' | 'handoff-pending' | 'media-issued' | 'media-started' | 'media-finalized' | 'completed' | 'failed';
  mediaStarted: boolean;
  mediaFinalized: boolean;
  scoreAccepted: boolean;
  completed: boolean;
  completionRetries: number;
}
interface TriviaVoiceCallBinding {
  code: string;
  playerId: string;
  locale: SupportedLocale;
  participantIndex: number | null;
  activeSession: TriviaVoiceSession | null;
  leaveTimer: ReturnType<typeof setTimeout> | null;
}
interface ChessVoiceCallBinding {
  code: string;
  playerId: string;
  locale: SupportedLocale;
  stationManaged: boolean;
  activeSession: ChessVoiceSession | null;
  leaveTimer: ReturnType<typeof setTimeout> | null;
}
type MountedVoiceGame = 'racer' | 'battle' | 'fighter' | 'karaoke' | 'trivia' | 'chess';

export class HttpServer {
  private server: http.Server;
  private game: GameServer;
  private battle: BattleServer;
  private fighter: FighterServer;
  private karaoke: KaraokeServer;
  private trivia: TriviaServer;
  private chess: ChessServer;
  private readonly triviaContent: TriviaContentStore;
  private readonly triviaLeaderboard: TriviaLeaderboardStore;
  private karaokeMedia: KaraokeMediaRuntime;
  private karaokeMediaWss: WebSocketServer;
  private voiceWss: WebSocketServer;
  private readonly port: number;
  private readonly triviaIdentificationTimeoutMs: number;
  private readonly authToken?: string;
  private readonly authTokens: readonly string[];
  private readonly publicBaseUrl: string;
  private readonly triviaDisplayToken: string;
  private readonly validateSignatures: boolean;
  private manifestStore: ManifestStore;
  private readonly mapsPath: string;
  /** Image-bundled default levels, copied into `mapsPath` ONCE on first boot (when the persistent
   *  file is absent/blank/corrupt). Unset in tests + local dev so no seeding happens there. */
  private readonly bundledMapsPath?: string;
  /** LIVE Voice Monsters arena config (transform/camera/spin); persistent-mount default. */
  private readonly arenaPath: string;
  private readonly bundledArenaPath?: string;
  /** LIVE Voice Karaoke venue config and its immutable image seed. */
  private readonly karaokeVenuePath: string;
  private readonly bundledKaraokeVenuePath?: string;
  private readonly karaokeTimingsPath: string;
  private karaokeTimingConfig: KaraokeTimingConfig = EMPTY_KARAOKE_TIMING_CONFIG;
  private karaokeTimingWrite: Promise<void> = Promise.resolve();
  private readonly karaokeAssetDirectory: string;
  private readonly leaderboardPath: string;
  private readonly karaokeLeaderboardPath: string;
  private readonly triviaLeaderboardPath: string;
  private readonly editorToken?: string;
  private readonly analytics: AnalyticsStore;
  private readonly analyticsObserver: AnalyticsObserver;
  private readonly analyticsAuth: GoogleAnalyticsAuth;
  private readonly operatorAuthRequired: boolean;
  private readonly arcadeApi?: ArcadeApi;
  private readonly arcadeTacGateway?: ArcadeTacGateway;
  /** The Vite-built client directory served in production (one-process container). */
  private readonly clientDir: string;
  /** Phone number players CALL to join (from GAME_PHONE_NUMBER). '' = unset → the lobby shows a
   *  placeholder. Exposed to the client via GET /api/config so the lobby QR + copy show the real number. */
  private readonly gamePhoneNumber: string;
  private readonly smsNumber: string;
  private readonly whatsappNumber: string;
  /** ElevenLabs voice IDs for every game's Conversation Relay session. */
  private readonly crVoice: string;
  private readonly crVoicePtBr: string;
  private readonly voiceRelayToken: string;
  private readonly karaokeCalibrationOffsetMs: number;
  private readonly deepgramConfigured: boolean;
  private readonly defaultLocale: SupportedLocale;
  private readonly standaloneVoiceEnabled: boolean;
  /** Cached selectable cars/maps for the lobby (refreshed from manifest + maps.json periodically). */
  private roomConfigCache: { carCount: number; maps: string[]; carNames: string[] } = { carCount: 0, maps: [], carNames: [] };
  private roomConfigTimer: ReturnType<typeof setInterval> | null = null;
  /** Cached leaderboard rows. Host context filters this by the room's selected map, so the AI answers
   *  with the same track-specific board shown on screen instead of a stale/global record. */
  private leaderboardEntriesCache: LeaderboardEntry[] = [];
  private leaderboardLoaded = false;
  /** Serializes both leaderboard files so appends, resets, and composite ETags remain ordered. */
  private leaderboardWrite: Promise<void> = Promise.resolve();
  /** SMS concierge (per-phone onboarding + car/map selection). */
  private concierge: SmsConcierge;
  /** Cached car display names (manifest order) for concierge confirmations; refreshed with config. */
  private carNamesCache: string[] = [];
  /** Per-phone reply lock so two rapid texts from one number serialize (read-modify-write safety). */
  private smsLocks = new Map<string, Promise<unknown>>();
  private smsSweepTimer: ReturnType<typeof setInterval> | null = null;
  /** Voice talk-back registry: roomCode → the live ConversationRelay adapters (callers) in that room.
   *  The game loop's per-room events (onRoomEvents) are fanned to these so callers hear countdown/
   *  go/their finish. Each adapter speaks the caller-relevant subset. */
  private voiceAdapters = new Map<string, Set<ConversationRelayAdapter>>();
  /** Voice Monsters talk-back registry: roomCode → live battle call sessions, fed battle events so
   *  callers hear commentary (super-effective/crit/faint/win). Parallel to voiceAdapters (the racer). */
  private battleVoice = new Map<string, Set<BattleVoiceSession>>();
  /** Conversation Relay may reconnect the WS for the same phone call. Keep callSid → player binding
   *  briefly so a transport reconnect resumes the active battle instead of re-running onboarding. */
  private battleVoiceCallBindings = new Map<string, BattleVoiceCallBinding>();
  private racerVoiceCallBindings = new Map<string, RacerVoiceCallBinding>();
  private fighterVoice = new Map<string, Set<FighterVoiceSession>>();
  private fighterVoiceCallBindings = new Map<string, FighterVoiceCallBinding>();
  private karaokeVoice = new Map<string, Set<KaraokeVoiceSession>>();
  private karaokeVoiceCallBindings = new Map<string, KaraokeVoiceCallBinding>();
  private triviaVoice = new Map<string, Set<TriviaVoiceSession>>();
  private triviaVoiceCallBindings = new Map<string, TriviaVoiceCallBinding>();
  private chessVoice = new Map<string, Set<ChessVoiceSession>>();
  private chessVoiceCallBindings = new Map<string, ChessVoiceCallBinding>();
  private readonly triviaResultPersistence = new Map<string, Promise<void>>();
  private karaokeFailureLocales = new Map<string, { locale: SupportedLocale; timer: ReturnType<typeof setTimeout> }>();
  private karaokeHandoffResponses = new Map<string, { xml: string; expiresAtMs: number }>();
  private voiceAccountSids = new Map<string, string>();
  private stationVoiceReconnectRoutes = new Map<string, {
    game: PlayableArcadeGame; roomCode: string; readyEntryId: string;
    matchId: string; launchGeneration: number; locale: SupportedLocale;
  }>();
  private voiceReconnectAttempts = new Map<string, number>();
  private standaloneDisplays = new Map<MountedVoiceGame,Map<WebSocket,number>>();
  private readonly standaloneTriviaDisplayCandidates = new WeakSet<WebSocket>();
  private readonly standaloneChessDisplayCandidates = new WeakSet<WebSocket>();
  private readonly authenticatedTriviaDisplays = new WeakSet<WebSocket>();
  private readonly publicTriviaDisplays = new Set<WebSocket>();
  private readonly pendingTriviaDisplays = new Map<WebSocket, ReturnType<typeof setTimeout>>();
  private fighterMaps: FighterMapEntry[] = FIGHTER_MAPS;
  private readonly fighterMapsPath: string;
  private readonly bundledFighterMapsPath: string;
  private readonly fighterPreviewDir: string;
  private readonly activeStationEngines = new Set<string>();
  private readonly voiceSockets = new Map<WebSocket, () => { game: PlayableArcadeGame; roomCode: string } | null>();
  /** Phase-bound semantic command interpreter for all six games, with deterministic parsing when
   *  OPENAI_API_KEY is unset. Model output is revalidated by each authoritative game server. */
  private llm: LlmClient;

  constructor(opts: {
    port: number;
    authToken?: string;
    additionalAuthTokens?: readonly string[];
    publicBaseUrl: string;
    broadcastHz?: number;
    validateSignatures?: boolean;
    manifestPath?: string;   // injectable so tests don't clobber the real assets/manifest.json
    mapsPath?: string;       // injectable; LIVE level configs (default data/maps.json on the persistent mount)
    bundledMapsPath?: string;// image-bundled default levels; seeded into mapsPath once on first boot
    arenaPath?: string;      // injectable; LIVE Voice Monsters arena config (default data/arena.json)
    bundledArenaPath?: string;// image-bundled default arena config; seeds arenaPath on first boot
    karaokeVenuePath?: string;// injectable; LIVE Voice Karaoke venue config (default data/karaoke-venue.json)
    bundledKaraokeVenuePath?: string;// image-bundled venue seed copied on first boot
    karaokeTimingsPath?: string;// injectable; persistent sparse per-word timing overrides
    karaokeAssetDirectory?: string;// direct release GLB directory (default assets/karaoke)
    leaderboardPath?: string;// injectable; persistent global leaderboard JSON (default data/leaderboard.json)
    karaokeLeaderboardPath?: string;// injectable; persistent Karaoke score history (default data/karaoke-leaderboard.json)
    triviaQuestionsPath?: string;// persistent validated Trivia bank (default data/trivia-questions.json)
    bundledTriviaQuestionsPath?: string;// immutable image seed (default content/trivia/questions.json)
    triviaLeaderboardPath?: string;// persistent Trivia leaderboard (default data/trivia-leaderboard.json)
    triviaAnonymizationSalt?: string;// stable deployment secret used only to derive Trivia player hashes
    editorToken?: string;    // when set, /api writes require x-editor-token; open if unset
    clientDir?: string;      // the Vite-built client to serve (prod single-process); default client/dist
    gamePhoneNumber?: string;// the number players CALL to join (shown + QR-encoded in the lobby)
    smsNumber?: string;// SMS-capable sender/receiver, separate from locale-specific voice numbers
    whatsappNumber?: string;// approved WhatsApp sender, with or without the whatsapp: prefix
    fighterMapsPath?: string;
    bundledFighterMapsPath?: string;
    fighterPreviewDir?: string;
    fighterDisplayToken?: string;
    karaokeDisplayToken?: string;
    triviaDisplayToken?: string;
    chessDisplayToken?: string;
    triviaIdentificationTimeoutMs?: number;
    triviaServerOptions?: Omit<TriviaServerOptions, 'bank' | 'contentRevision' | 'displayToken' | 'server'>;
    analyticsPath?: string;
    googleOAuthClientId?: string;
    googleOAuthClientSecret?: string;
    analyticsAllowedEmail?: string;
    analyticsAdminPin?: string;
    operatorAuthRequired?: boolean;
    analyticsAuth?: GoogleAnalyticsAuth;
    arcadeApi?: ArcadeApi;
    arcadeTacGateway?: ArcadeTacGateway;
    standaloneVoiceEnabled?: boolean;
    voiceRelayToken?: string;
    deepgramApiKey?: string;
    karaokeCalibrationOffsetMs?: number;
    karaokeLyricRecognizerFactory?: KaraokeLyricRecognizerFactory;
  }) {
    this.port = opts.port;
    this.triviaIdentificationTimeoutMs = opts.triviaIdentificationTimeoutMs
      ?? TRIVIA_IDENTIFICATION_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.triviaIdentificationTimeoutMs)
      || this.triviaIdentificationTimeoutMs < 1 || this.triviaIdentificationTimeoutMs > 60_000) {
      throw new TypeError('triviaIdentificationTimeoutMs must be an integer from 1 to 60000');
    }
    this.authToken = opts.authToken;
    this.authTokens = Object.freeze([...new Set([
      opts.authToken,
      ...(opts.additionalAuthTokens ?? []),
    ].map(value => value?.trim()).filter((value): value is string => Boolean(value))) ]);
    this.publicBaseUrl = opts.publicBaseUrl.replace(/\/$/, '');
    this.triviaDisplayToken = (opts.triviaDisplayToken ?? opts.fighterDisplayToken ?? '').trim();
    this.validateSignatures = opts.validateSignatures ?? true;
    this.manifestStore = new ManifestStore(opts.manifestPath ?? 'assets/manifest.json');
    // LIVE levels default to the persistent mount (data/) — same fate as the leaderboard — so
    // editor-authored levels survive redeploys. The image's committed levels are the SEED source.
    this.mapsPath = opts.mapsPath ?? 'data/maps.json';
    this.bundledMapsPath = opts.bundledMapsPath;
    this.arenaPath = opts.arenaPath ?? 'data/arena.json';
    this.bundledArenaPath = opts.bundledArenaPath;
    this.karaokeVenuePath = opts.karaokeVenuePath ?? 'data/karaoke-venue.json';
    this.bundledKaraokeVenuePath = opts.bundledKaraokeVenuePath;
    this.karaokeTimingsPath = opts.karaokeTimingsPath ?? 'data/karaoke-timings.json';
    this.karaokeAssetDirectory = opts.karaokeAssetDirectory ?? 'assets/karaoke';
    this.leaderboardPath = opts.leaderboardPath ?? 'data/leaderboard.json';
    this.karaokeLeaderboardPath = opts.karaokeLeaderboardPath ?? 'data/karaoke-leaderboard.json';
    this.triviaContent = new TriviaContentStore(
      opts.triviaQuestionsPath ?? 'data/trivia-questions.json',
      opts.bundledTriviaQuestionsPath ?? 'content/trivia/questions.json',
    );
    this.triviaLeaderboardPath = opts.triviaLeaderboardPath ?? 'data/trivia-leaderboard.json';
    this.triviaLeaderboard = new TriviaLeaderboardStore(
      this.triviaLeaderboardPath,
      deriveTriviaAnonymizationSalt(
        opts.triviaAnonymizationSalt ?? opts.authToken ?? opts.editorToken ?? 'twilio-games-local',
      ),
    );
    this.editorToken = opts.editorToken;
    this.analyticsAuth = opts.analyticsAuth ?? new GoogleAnalyticsAuth({
      clientId: opts.googleOAuthClientId, clientSecret: opts.googleOAuthClientSecret,
      redirectUri: `${this.publicBaseUrl}/auth/google/callback`, allowedEmail: opts.analyticsAllowedEmail,
      adminPin: opts.analyticsAdminPin,
    });
    this.operatorAuthRequired = opts.operatorAuthRequired
      ?? (process.env.NODE_ENV === 'production' || this.analyticsAuth.configured || !isLoopbackUrl(this.publicBaseUrl));
    this.arcadeApi = opts.arcadeApi;
    this.arcadeTacGateway = opts.arcadeTacGateway;
    this.analytics = new AnalyticsStore(opts.analyticsPath ?? 'data/analytics.json', opts.googleOAuthClientSecret?.trim() || 'twilio-games-analytics');
    this.analyticsObserver = new AnalyticsObserver(this.analytics);
    if (process.env.NODE_ENV === 'production' && !this.editorToken) {
      throw new Error('EDITOR_TOKEN is required in production');
    }
    if (process.env.NODE_ENV === 'production' && !this.analyticsAuth.configured) console.warn('[security] Analytics authentication is unset; analytics access is disabled');
    this.clientDir = opts.clientDir ?? 'client/dist';
    this.gamePhoneNumber = (opts.gamePhoneNumber ?? '').trim();
    this.smsNumber = (opts.smsNumber ?? '').trim();
    this.whatsappNumber = (opts.whatsappNumber ?? '').trim().replace(/^whatsapp:/i, '');
    this.fighterMapsPath = opts.fighterMapsPath ?? 'data/fighter-maps.json';
    this.bundledFighterMapsPath = opts.bundledFighterMapsPath ?? 'assets/fighters/maps/maps.json';
    this.fighterPreviewDir = opts.fighterPreviewDir ?? 'data/fighter-previews';
    this.crVoice = relayVoiceForLocale('en-US');
    this.crVoicePtBr = relayVoiceForLocale('pt-BR');
    this.voiceRelayToken = resolveVoiceRelayToken(
      this.publicBaseUrl,
      opts.voiceRelayToken ?? process.env.VOICE_RELAY_TOKEN,
      this.authToken,
      process.env.NODE_ENV,
    );
    this.defaultLocale = resolveLocale(process.env.DEFAULT_LOCALE, DEFAULT_LOCALE);
    this.standaloneVoiceEnabled = opts.standaloneVoiceEnabled ?? process.env.NODE_ENV !== 'production';
    // The model maps conversational speech to currently legal actions. Local deterministic
    // commands continue to work when the key is unavailable.
    const configuredOpenAiKey = (process.env.OPENAI_API_KEY ?? '').trim();
    const openaiKey = configuredOpenAiKey === 'disabled' ? '' : configuredOpenAiKey;
    this.llm = openaiKey
      ? new OpenAiClient({ apiKey: openaiKey, model: (process.env.OPENAI_MODEL ?? '').trim() || undefined })
      : new NullLlmClient();
    if (this.llm.enabled) console.log(`[LLM] conversational host ENABLED (model=${process.env.OPENAI_MODEL || 'default'})`);
    this.server = http.createServer((req, res) => {
      this.onRequest(req, res).catch((err) => {
        console.error('request handler error:', err);
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('internal error');
      });
    });
    this.game = new GameServer({
      server: this.server, broadcastHz: opts.broadcastHz, displayToken: opts.fighterDisplayToken,
    });
    // Voice Monsters lives on its own /battle WebSocket (turn-based, event-driven — separate from the
    // racer's continuous-sim GameServer). Mounted on the same HTTP host so one number serves both.
    this.battle = new BattleServer({ server: this.server, displayToken: opts.fighterDisplayToken });
    this.fighter = new FighterServer({ server: this.server, displayToken: opts.fighterDisplayToken ?? process.env.FIGHTER_DISPLAY_TOKEN });
    this.karaoke = new KaraokeServer({ displayToken: opts.karaokeDisplayToken ?? opts.fighterDisplayToken });
    this.trivia = new TriviaServer({
      ...opts.triviaServerOptions,
      displayToken: opts.triviaDisplayToken ?? opts.fighterDisplayToken,
    });
    this.chess = new ChessServer({
      displayToken: opts.chessDisplayToken ?? opts.fighterDisplayToken,
    });
    this.karaokeMediaWss = new WebSocketServer({
      noServer: true,
      maxPayload: 16 * 1024,
      perMessageDeflate: false,
    });
    const deepgramApiKey = (opts.deepgramApiKey ?? '').trim();
    this.deepgramConfigured = Boolean(deepgramApiKey && deepgramApiKey !== 'disabled');
    this.karaokeCalibrationOffsetMs = opts.karaokeCalibrationOffsetMs ?? 0;
    if (!Number.isInteger(this.karaokeCalibrationOffsetMs)
      || this.karaokeCalibrationOffsetMs < -5_000 || this.karaokeCalibrationOffsetMs > 5_000) {
      throw new TypeError('karaokeCalibrationOffsetMs must be an integer from -5000 to 5000');
    }
    const karaokeLyricRecognizerFactory = opts.karaokeLyricRecognizerFactory
      ?? (deepgramApiKey && deepgramApiKey !== 'disabled'
        ? new DirectDeepgramLyricRecognizerFactory({ apiKey: deepgramApiKey })
        : undefined);
    this.karaokeMedia = new KaraokeMediaRuntime({
      karaokeServer: this.karaoke,
      lyricRecognizerFactory: karaokeLyricRecognizerFactory,
      isSecureRequest: request => isSecureKaraokeMediaRequest(request, this.publicBaseUrl),
      validateUpgradeSignature: request => {
        if (!this.validateSignatures) return true;
        const header = request.headers['x-twilio-signature'];
        const signature = Array.isArray(header) ? header.length === 1 ? header[0] : undefined : header;
        const exactUrl = `${this.publicBaseUrl.replace(/^https?/, 'wss')}/karaoke-media`;
        return this.authTokens.some(authToken => validateTwilioSignature({
          authToken, signature, url: exactUrl, params: {},
        }));
      },
      upgrade: (request, socket, head, accepted) => {
        this.karaokeMediaWss.handleUpgrade(request, socket, head, ws => accepted(ws));
      },
      onSessionStarted: (attempt, streamSid) => this.onKaraokeMediaStarted(attempt, streamSid),
      onSessionFinalized: (result, attempt) => this.onKaraokeMediaFinalized(result, attempt),
      onSessionAborted: attempt => this.onKaraokeMediaAborted(attempt),
    });
    this.arcadeApi?.setStationAbortHandler?.((game, roomCode, removal) => {
      if (removal === 'retire') this.retireStationEngine(game, roomCode);
      else this.abortStationEngine(game, roomCode);
    });
    this.arcadeApi?.setStationParticipantCountHandler?.((
      game, roomCode, count, activeEnginePlayerIds, participantSlots,
    ) => {
      if (game === 'racer') {
        const retained=new Set(activeEnginePlayerIds);
        for(const[callSid,binding]of this.racerVoiceCallBindings){
          if(binding.code!==roomCode||retained.has(binding.playerId))continue;
          if(binding.leaveTimer)clearTimeout(binding.leaveTimer);
          this.racerVoiceCallBindings.delete(callSid);
          this.stationVoiceReconnectRoutes.delete(callSid);
          this.voiceReconnectAttempts.delete(callSid);
        }
        this.game.voiceExpectHumanPlayers(roomCode,count,activeEnginePlayerIds);
      }
      else if (game === 'monsters') {
        const retained=new Set(activeEnginePlayerIds);
        for(const[callSid,binding]of this.battleVoiceCallBindings){
          if(binding.code!==roomCode||retained.has(binding.playerId))continue;
          if(binding.leaveTimer)clearTimeout(binding.leaveTimer);
          this.battleVoiceCallBindings.delete(callSid);this.stationVoiceReconnectRoutes.delete(callSid);this.voiceReconnectAttempts.delete(callSid);
        }
        this.battle.voiceExpectHumanPlayers(roomCode,count,activeEnginePlayerIds);
      } else if (game === 'fighter') {
        const retained=new Set(activeEnginePlayerIds);
        for(const[callSid,binding]of this.fighterVoiceCallBindings){
          if(binding.code!==roomCode||retained.has(binding.playerId))continue;
          if(binding.leaveTimer)clearTimeout(binding.leaveTimer);
          this.fighterVoiceCallBindings.delete(callSid);this.stationVoiceReconnectRoutes.delete(callSid);this.voiceReconnectAttempts.delete(callSid);
        }
        this.fighter.voiceExpectHumanPlayers(roomCode,count,activeEnginePlayerIds);
      } else if (game === 'karaoke') {
        const retained=new Set(activeEnginePlayerIds);
        for(const[callSid,binding]of this.karaokeVoiceCallBindings){
          if(binding.code!==roomCode||retained.has(binding.playerId))continue;
          this.clearKaraokeVoiceBinding(callSid, false);
          this.stationVoiceReconnectRoutes.delete(callSid);this.voiceReconnectAttempts.delete(callSid);
        }
        this.karaoke.voiceExpectHumanPlayers(roomCode,count,activeEnginePlayerIds);
      } else if (game === 'trivia') {
        if (!this.trivia.voiceReconcilePregameRoster(
          roomCode, count, activeEnginePlayerIds, participantSlots,
        )) return;
        const reconciledOrder = new Map(
          this.trivia.findRoom(roomCode)?.state().players.map(player => [player.playerId, player.playerOrder]) ?? [],
        );
        for (const [callSid, binding] of this.triviaVoiceCallBindings) {
          if (binding.code !== roomCode) continue;
          const participantIndex = reconciledOrder.get(binding.playerId);
          if (participantIndex !== undefined) {
            binding.participantIndex = participantIndex;
            continue;
          }
          if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
          if (binding.activeSession) {
            this.unregisterTriviaVoiceSession(binding.activeSession);
            binding.activeSession.handleReplaced();
          }
          this.arcadeApi?.stationVoiceCallEnded(callSid);
          this.triviaVoiceCallBindings.delete(callSid);
          this.stationVoiceReconnectRoutes.delete(callSid);
          this.voiceReconnectAttempts.delete(callSid);
        }
      } else if (game === 'chess') {
        const retained = new Set(activeEnginePlayerIds);
        for (const [callSid, binding] of this.chessVoiceCallBindings) {
          if (binding.code !== roomCode || retained.has(binding.playerId)) continue;
          if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
          if (binding.activeSession) {
            this.unregisterChessVoiceSession(binding.activeSession);
            binding.activeSession.handleReplaced();
          }
          this.chessVoiceCallBindings.delete(callSid);
          this.analyticsObserver.chessAborted(roomCode);
          this.chess.voiceLeave(roomCode, callSid);
          this.abandonUnfinishedChessStationRoom(roomCode);
          this.stationVoiceReconnectRoutes.delete(callSid);
          this.voiceReconnectAttempts.delete(callSid);
        }
      } else assertNever(game);
    });
    this.arcadeApi?.setPlayerResetCleanupHandler?.(context => this.cleanupResetPlayerHistory(context));
    const allowBrowserPlayer = (roomCode: string) => !this.arcadeApi?.isStationEngineRoom(roomCode);
    const localKaraokeBrowserTesting = karaokeBrowserTestingAllowed(process.env.NODE_ENV, this.publicBaseUrl);
    this.game.setBrowserPlayerAdmission(allowBrowserPlayer);
    this.battle.setBrowserPlayerAdmission(allowBrowserPlayer);
    this.fighter.setBrowserPlayerAdmission(allowBrowserPlayer);
    this.karaoke.setBrowserPlayerAdmission(roomCode => localKaraokeBrowserTesting
      && allowBrowserPlayer(roomCode)
      && this.standaloneVoiceEnabled
      && this.arcadeApi?.standaloneVoiceAvailable?.() !== false
      && this.arcadeApi?.standaloneGameEnabled?.('karaoke') !== false);
    this.trivia.setBrowserPlayerAdmission(roomCode => triviaLocalKeyboardTestingAllowed(
      process.env.NODE_ENV,
      this.publicBaseUrl,
      roomCode,
      this.arcadeApi?.isStationEngineRoom(roomCode) ?? false,
    ));
    this.karaoke.setDisplayAuthenticationRequirement(roomCode => !allowBrowserPlayer(roomCode));
    this.trivia.setDisplayAuthenticationRequirement(roomCode => (
      roomCode.trim().toUpperCase() !== DEFAULT_ROOM || !allowBrowserPlayer(roomCode)
    ));
    this.chess.setDisplayAuthenticationRequirement(roomCode => (
      roomCode.trim().toUpperCase() !== DEFAULT_ROOM || !allowBrowserPlayer(roomCode)
    ));
    // Standalone candidates are registered from ?display=1 upgrades below. Routing checks
    // their actual accepted room binding, so an upgraded but unbound socket is never presence.
    this.trivia.setOnDisplayAuthenticated(ws => {
      this.authenticatedTriviaDisplays.add(ws);
      this.publicTriviaDisplays.delete(ws);
      this.clearPendingTriviaDisplay(ws);
    });
    this.trivia.setOnDisplayRegistered((ws, roomCode) => {
      if (this.standaloneTriviaDisplayCandidates.has(ws) && roomCode === DEFAULT_ROOM
        && !this.authenticatedTriviaDisplays.has(ws) && !this.publicTriviaDisplays.has(ws)) {
        if (this.publicTriviaDisplays.size >= TRIVIA_PUBLIC_DISPLAY_LIMIT) {
          ws.close(1013, 'public trivia display capacity');
          return;
        }
        this.publicTriviaDisplays.add(ws);
        ws.once('close', () => this.publicTriviaDisplays.delete(ws));
      }
      this.clearPendingTriviaDisplay(ws);
      if (this.standaloneTriviaDisplayCandidates.has(ws)) this.registerStandaloneDisplay('trivia', ws);
    });
    this.chess.setOnDisplayRegistered(ws => {
      if (this.standaloneChessDisplayCandidates.has(ws)) {
        this.registerStandaloneDisplay('chess', ws);
      }
    });
    // Feed newly-created rooms the selectable cars (manifest) + maps (maps.json). Reads are async
    // and the provider is sync, so keep a cache refreshed at startup + on an interval; rooms read
    // the cache. Empty until the first refresh resolves (rooms then reconfigure on next create).
    this.game.setRoomConfigProvider(() => this.roomConfigCache);
    this.game.setOnRaceStarted(room => {
      this.analyticsObserver.raceStarted(room);
      this.arcadeApi?.stationEngineStarted('racer', room.code);
    });
    this.game.setOnRaceAbandoned(room => {
      this.analyticsObserver.raceAbandoned(room);
      this.arcadeApi?.stationEngineAbandoned('racer', room.code);
    });
    // Persist each finished race onto the global leaderboard (serialized, atomic).
    this.game.setOnRaceFinished((room) => {
      const persistedResults = room.results().map(result => ({
        ...result,
        playerId: this.arcadeApi?.canonicalStationEnginePlayerId?.(result.playerId) ?? result.playerId,
      }));
      this.persistRaceResults(room.selectedMap, persistedResults, room.code);
      this.analyticsObserver.raceFinished(room);
      this.arcadeApi?.stationEngineCompleted('racer', room.code, room.results().map(result => ({
        enginePlayerId: result.playerId,
        rank: result.place,
        completed: result.finished && result.finishT > 0,
        won: result.finishT > 0 ? result.place === 1 : false,
        score: null,
        durationSeconds: result.finishT > 0 ? result.finishT : null,
      })));
    });
    // Fan a room's game events out to any voice callers in it (greeting/countdown/go/finish talk-back).
    this.game.setOnRoomEvents((roomCode, events) => {
      const set = this.voiceAdapters.get(roomCode);
      if (!set) return;
      for (const ev of events) for (const a of set) a.onGameEvent(ev);
    });
    // Speak each battle beat only after the authoritative display paints and acknowledges it.
    this.battle.setOnPresentation((roomCode, presentation) => {
      const set = this.battleVoice.get(roomCode);
      if (!set) return;
      for (const session of set) session.onBattlePresentation(presentation);
    });
    this.battle.setOnRoomState((roomCode) => {
      const room = this.battle.findRoom(roomCode); if (room) this.analyticsObserver.battleState(room);
      // Enqueue the caller's current result or recovery line before a completed station
      // match can retire its voice sessions.
      const set = this.battleVoice.get(roomCode);
      if (set) for (const session of set) session.onBattleStateChanged();
      if (room?.phase !== 'results' || room.canRematch) {
        this.updateStationEngineLifecycle(
          'monsters', roomCode, room?.phase, ['battle'], ['results'], room?.participantResults() ?? [],
        );
      }
    });
    this.fighter.setOnRoomEvents((roomCode, events) => {
      const set = this.fighterVoice.get(roomCode); if (!set) return;
      for (const event of events) for (const session of set) session.onFighterEvent(event);
    });
    this.fighter.setOnVoiceCommandOutcomes((roomCode, outcomes) => {
      for (const session of this.fighterVoice.get(roomCode) ?? []) session.onVoiceCommandOutcomes(outcomes);
    });
    this.fighter.setOnRoomState(roomCode => {
      const room = this.fighter.findRoom(roomCode); if (room) this.analyticsObserver.fighterState(room);
      const state = room?.state();
      const humanPlayers = state?.players.filter(player => !player.isAi) ?? [];
      const lifecyclePhase = room?.phase === 'results' && !(room.resultsPresented || room.resultsPresentationTimedOut) ? 'victory' : room?.phase;
      // Queue the caller's terminal line before the station lifecycle may retire the room.
      for (const session of this.fighterVoice.get(roomCode) ?? []) session.onStateChanged();
      this.updateStationEngineLifecycle('fighter', roomCode, lifecyclePhase, ['intro','countdown','fight','victory'], ['results'],
        humanPlayers.map((player, index) => ({
          enginePlayerId: player.playerId,
          rank: state?.result ? (player.side === state.result.winner ? 1 : 2) : index + 1,
          completed: Boolean(state?.result),
          won: state?.result ? player.side === state.result.winner : null,
          score: null,
          durationSeconds: null,
        })), ['loading']);
    });
    this.karaoke.setOnRoomEvents((roomCode, events) => {
      for (const event of events) {
        if (event.type === 'result') this.persistKaraokeResult(roomCode, event.result);
        else if (event.type === 'loading_timeout') {
          console.warn(`[karaoke] loading timeout room=${roomCode} generation=${event.generation} displayReady=${event.displayReady} mediaReady=${event.mediaReady}`);
          this.handleKaraokeLoadingTimeout(roomCode);
        }
      }
      this.notifyKaraokeVoiceState(roomCode);
    });
    this.karaoke.setOnRoomState(roomCode => {
      const room = this.karaoke.findRoom(roomCode);
      if (room) this.analyticsObserver.karaokeState(room);
      const state = room?.state();
      const result = state?.result;
      // Station completion can synchronously retire this room. Queue both result lines first.
      if (state?.phase === 'results') this.notifyKaraokeVoiceState(roomCode);
      this.updateStationEngineLifecycle(
        'karaoke', roomCode, state?.phase, ['countdown', 'performing'], ['results'],
        result ? [{
          enginePlayerId: result.playerId,
          rank: 1,
          completed: true,
          won: null,
          score: Math.max(0, Math.min(100_000, Math.round(result.score))),
          durationSeconds: KARAOKE_SONG_DURATION_MS / 1_000,
        }] : [],
        ['loading', 'finalizing'],
      );
      this.resetCompletedKaraokeAttempt(roomCode, state?.phase);
      if (state?.phase !== 'results') this.notifyKaraokeVoiceState(roomCode);
    });
    this.trivia.setOnRoomEvents((roomCode, events) => {
      for (const event of events) {
        if (event.type === 'round_finished') this.persistTriviaResult(roomCode, event.result);
        if (event.type === 'audio_recovery_expired') {
          console.warn(`[trivia] question audio recovery expired room=${roomCode} attempt=${event.questionAttemptId}`);
        }
      }
    });
    this.trivia.setOnRoomState(roomCode => {
      const room = this.trivia.findRoom(roomCode);
      if (room) this.analyticsObserver.triviaState(room);
      const state = room?.state();
      const stationReady = Boolean(state && this.trivia.hasAuthenticatedDisplay(roomCode)
        && state.displayReady && state.hasExpectedPlayers
        && state.players.every(player => player.connected));
      const triviaStarted = this.activeStationEngines.has(`trivia:${roomCode}`);
      const lifecyclePhase = state && (triviaStarted
        || !['countdown', 'question_prompt', 'answer_cue', 'question', 'reveal', 'audio_problem'].includes(state.phase)
        || stationReady) ? state.phase : undefined;
      // audio_expired is terminal without results; updateStationEngineLifecycle abandons the
      // active station match so it cannot remain PLAYING or accept a stale operator retry.
      this.updateStationEngineLifecycle(
        'trivia', roomCode, lifecyclePhase,
        ['countdown', 'question_prompt', 'answer_cue', 'question', 'reveal', 'audio_problem'], ['results'],
        state?.result?.players.map(player => ({
          enginePlayerId: player.playerId,
          rank: player.rank,
          completed: true,
          won: player.rank === 1,
          score: player.normalizedScore,
          durationSeconds: null,
        })) ?? [],
        ['loading'],
      );
      for (const session of this.triviaVoice.get(roomCode) ?? []) session.onStateChanged();
    });
    this.chess.setOnRoomState(roomCode => {
      const room = this.chess.findRoom(roomCode);
      if (room) this.analyticsObserver.chessState(room);
      const state = room?.state();
      if (!state) return;
      if (!this.arcadeApi?.isStationEngineRoom?.(roomCode)) return;
      const result = state.result;
      this.updateStationEngineLifecycle(
        'chess', roomCode, state.phase,
        ['playing', 'pending'], ['finished'],
        result ? [{
          enginePlayerId: 'c1',
          rank: result.winner === state.humanColor ? 1 : result.winner === null ? 1 : 2,
          completed: true,
          won: result.winner === null ? null : result.winner === state.humanColor,
          score: null,
          durationSeconds: null,
        }] : [],
        ['waiting'],
      );
    });
    this.chess.setOnRoomEvents((roomCode, events) => {
      for (const session of this.chessVoice.get(roomCode) ?? []) session.onRoomEvents(events);
    });
    // SMS concierge: resolves a room code to a live Room wrapped as a ConciergeRoom (adds car names).
    this.concierge = new SmsConcierge({ findRoom: (code) => this.conciergeRoom(code) });
    this.voiceWss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '').split('?')[0];
      const requestUrl = new URL(req.url ?? '/', 'http://localhost');
      const displayValues = requestUrl.searchParams.getAll('display');
      const standaloneDisplay = this.standaloneVoiceEnabled
        && displayValues.length === 1 && displayValues[0] === '1'
        && !(this.arcadeApi?.requiresStationVoiceAssignment() ?? false);
      if ((path === '/karaoke' || path === '/trivia' || path === '/chess')
        && req.headers.origin !== new URL(this.publicBaseUrl).origin) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if ((path === '/trivia' || path === '/chess')
        && (displayValues.length !== 1 || displayValues[0] !== '1')) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (path === '/voice') {
        if (this.validateSignatures) {
          const header = req.headers['x-twilio-signature'];
          const signature = Array.isArray(header) ? header[0] : header;
          const signedUrl = `${this.publicBaseUrl.replace(/^http/, 'ws')}${req.url ?? '/voice'}`;
          const valid = this.authTokens.some(authToken => validateTwilioSignature({
            authToken, signature, url: signedUrl, params: {},
          }));
          if (!valid) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
        }
        this.voiceWss.handleUpgrade(req, socket, head, (ws) => this.onVoiceConnection(ws));
      } else if (path === '/game') {
        this.game.handleUpgrade(req, socket, head, ws => {
          if (standaloneDisplay) this.registerStandaloneDisplay('racer', ws);
        });
      } else if (path === '/battle') {
        this.battle.handleUpgrade(req, socket, head, ws => {
          if (standaloneDisplay) this.registerStandaloneDisplay('battle', ws);
        });
      } else if (path === '/fighter') {
        this.fighter.handleUpgrade(req, socket, head, ws => {
          if (standaloneDisplay) this.registerStandaloneDisplay('fighter', ws);
        });
      } else if (path === '/karaoke') {
        this.karaoke.handleUpgrade(req, socket, head, ws => {
          if (standaloneDisplay) this.registerStandaloneDisplay('karaoke', ws);
        });
      } else if (path === '/trivia') {
        if (this.pendingTriviaDisplays.size >= TRIVIA_PENDING_CONNECTION_LIMIT) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        if (this.publicTriviaDisplays.size >= TRIVIA_PUBLIC_DISPLAY_LIMIT
          && !(this.arcadeApi?.requiresStationVoiceAssignment() ?? false)) {
          socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        this.trivia.handleUpgrade(req, socket, head, ws => {
          if (standaloneDisplay) this.standaloneTriviaDisplayCandidates.add(ws);
          this.trackPendingTriviaDisplay(ws);
        });
      } else if (path === '/chess') {
        this.chess.handleUpgrade(req, socket, head, ws => {
          if (standaloneDisplay) this.standaloneChessDisplayCandidates.add(ws);
        });
      } else if (path === '/karaoke-media') {
        this.karaokeMedia.handleUpgrade(req, socket, head);
      } else {
        socket.destroy();
      }
    });
  }

  private updateStationEngineLifecycle(
    game: Exclude<PlayableArcadeGame, 'racer'>,
    roomCode: string,
    phase: string | undefined,
    startedPhases: readonly string[],
    completedPhases: readonly string[],
    results: readonly import('../shared/arcade-station').StationEngineParticipantResult[] = [],
    recoveryPhases: readonly string[] = [],
  ): void {
    const key = `${game}:${roomCode}`;
    const started = this.activeStationEngines.has(key);
    if (phase&&startedPhases.includes(phase)) {
      if (started) return;
      this.activeStationEngines.add(key);
      this.arcadeApi?.stationEngineStarted(game, roomCode);
      return;
    }
    if (!started) return;
    if (phase && recoveryPhases.includes(phase)) return;
    this.activeStationEngines.delete(key);
    if (phase && completedPhases.includes(phase)) {
      this.arcadeApi?.stationEngineCompleted(game, roomCode, results);
    } else {
      this.arcadeApi?.stationEngineAbandoned(game, roomCode);
    }
  }

  private abortStationEngine(game: PlayableArcadeGame, roomCode: string): void {
    for (const [socket, binding] of this.voiceSockets) {
      const bound = binding();
      if (bound?.game === game && bound.roomCode === roomCode) socket.close(4002, 'station recovery');
    }
    if (game === 'racer') {
      for (const adapter of [...(this.voiceAdapters.get(roomCode) ?? [])]) adapter.handleClose();
      this.voiceAdapters.delete(roomCode);
      for (const [callSid,binding] of this.racerVoiceCallBindings) {
        if(binding.code!==roomCode)continue;
        if(binding.leaveTimer)clearTimeout(binding.leaveTimer);
        this.racerVoiceCallBindings.delete(callSid);
      }
      this.game.abortRoom(roomCode);
    } else if (game === 'monsters') {
      for (const session of [...(this.battleVoice.get(roomCode) ?? [])]) session.handleReplaced();
      this.battleVoice.delete(roomCode);
      for (const [callSid, binding] of this.battleVoiceCallBindings) {
        if (binding.code !== roomCode) continue;
        if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
        this.battleVoiceCallBindings.delete(callSid);
      }
      this.battle.abortRoom(roomCode);
    } else if (game === 'fighter') {
      for (const session of [...(this.fighterVoice.get(roomCode) ?? [])]) session.handleReplaced();
      this.fighterVoice.delete(roomCode);
      for (const [callSid, binding] of this.fighterVoiceCallBindings) {
        if (binding.code !== roomCode) continue;
        if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
        this.fighterVoiceCallBindings.delete(callSid);
      }
      this.fighter.abortRoom(roomCode);
    } else if (game === 'karaoke') {
      for (const session of [...(this.karaokeVoice.get(roomCode) ?? [])]) session.handleReplaced();
      this.karaokeVoice.delete(roomCode);
      for (const [callSid, binding] of this.karaokeVoiceCallBindings) {
        if (binding.code !== roomCode) continue;
        if (binding.attemptId) this.karaokeMedia.abortAttempt(binding.attemptId);
        if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
        this.karaokeVoiceCallBindings.delete(callSid);
        this.voiceAccountSids.delete(callSid);
      }
      this.analyticsObserver.karaokeAborted(roomCode);
      this.karaoke.abortRoom(roomCode);
    } else if (game === 'trivia') {
      for (const session of [...(this.triviaVoice.get(roomCode) ?? [])]) session.handleReplaced();
      this.triviaVoice.delete(roomCode);
      for (const [callSid, binding] of this.triviaVoiceCallBindings) {
        if (binding.code !== roomCode) continue;
        if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
        this.triviaVoiceCallBindings.delete(callSid);
      }
      this.analyticsObserver.triviaAborted(roomCode);
      this.trivia.abortRoom(roomCode);
    } else if (game === 'chess') {
      for (const session of [...(this.chessVoice.get(roomCode) ?? [])]) session.handleReplaced();
      this.chessVoice.delete(roomCode);
      for (const [callSid, binding] of this.chessVoiceCallBindings) {
        if (binding.code !== roomCode) continue;
        if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
        this.chessVoiceCallBindings.delete(callSid);
      }
      this.analyticsObserver.chessAborted(roomCode);
      this.chess.abortRoom(roomCode);
    } else assertNever(game);
    for(const [callSid,route] of this.stationVoiceReconnectRoutes){
      if(route.game!==game||route.roomCode!==roomCode)continue;
      this.stationVoiceReconnectRoutes.delete(callSid);
      this.voiceReconnectAttempts.delete(callSid);
    }
    this.activeStationEngines.delete(`${game}:${roomCode}`);
  }

  private retireStationEngine(game: PlayableArcadeGame, roomCode: string): void {
    const endCalls = () => {
      for (const [socket, binding] of this.voiceSockets) {
        const bound = binding();
        if (bound?.game === game && bound.roomCode === roomCode) endRelayAfterPlayback(socket);
      }
    };
    const finalize = () => {
      endCalls();
      if (game === 'racer') {
        for(const adapter of [...(this.voiceAdapters.get(roomCode)??[])])adapter.handleClose(true);
        this.voiceAdapters.delete(roomCode);
        for(const[callSid,binding]of this.racerVoiceCallBindings){
          if(binding.code!==roomCode)continue;
          if(binding.leaveTimer)clearTimeout(binding.leaveTimer);
          this.racerVoiceCallBindings.delete(callSid);
        }
        for(const[callSid,route]of this.stationVoiceReconnectRoutes){
          if(route.game!=='racer'||route.roomCode!==roomCode)continue;
          this.stationVoiceReconnectRoutes.delete(callSid);this.voiceReconnectAttempts.delete(callSid);
        }
        this.game.abortRoom(roomCode);
      }
      else if (game === 'monsters') {
        for(const session of [...(this.battleVoice.get(roomCode)??[])])session.handleReplaced();
        this.battleVoice.delete(roomCode);
        for(const[callSid,binding]of this.battleVoiceCallBindings){
          if(binding.code!==roomCode)continue;
          if(binding.leaveTimer)clearTimeout(binding.leaveTimer);
          this.battleVoiceCallBindings.delete(callSid);
        }
        for(const[callSid,route]of this.stationVoiceReconnectRoutes){
          if(route.game!=='monsters'||route.roomCode!==roomCode)continue;
          this.stationVoiceReconnectRoutes.delete(callSid);this.voiceReconnectAttempts.delete(callSid);
        }
        this.battle.abortRoom(roomCode);
      } else if (game === 'fighter') {
        for(const session of [...(this.fighterVoice.get(roomCode)??[])])session.handleReplaced();
        this.fighterVoice.delete(roomCode);
        for(const[callSid,binding]of this.fighterVoiceCallBindings){
          if(binding.code!==roomCode)continue;
          if(binding.leaveTimer)clearTimeout(binding.leaveTimer);
          this.fighterVoiceCallBindings.delete(callSid);
        }
        for(const[callSid,route]of this.stationVoiceReconnectRoutes){
          if(route.game!=='fighter'||route.roomCode!==roomCode)continue;
          this.stationVoiceReconnectRoutes.delete(callSid);this.voiceReconnectAttempts.delete(callSid);
        }
        this.fighter.abortRoom(roomCode);
      } else if (game === 'karaoke') {
        for(const session of [...(this.karaokeVoice.get(roomCode)??[])])session.handleReplaced();
        this.karaokeVoice.delete(roomCode);
        for(const[callSid,binding]of this.karaokeVoiceCallBindings){
          if(binding.code!==roomCode)continue;
          if(binding.attemptId)this.karaokeMedia.abortAttempt(binding.attemptId);
          if(binding.leaveTimer)clearTimeout(binding.leaveTimer);
          this.karaokeVoiceCallBindings.delete(callSid);this.voiceAccountSids.delete(callSid);
        }
        for(const[callSid,route]of this.stationVoiceReconnectRoutes){
          if(route.game!=='karaoke'||route.roomCode!==roomCode)continue;
          this.stationVoiceReconnectRoutes.delete(callSid);this.voiceReconnectAttempts.delete(callSid);
        }
        this.analyticsObserver.karaokeAborted(roomCode);
        this.karaoke.abortRoom(roomCode);
      } else if (game === 'trivia') {
        for (const session of [...(this.triviaVoice.get(roomCode) ?? [])]) session.handleReplaced();
        this.triviaVoice.delete(roomCode);
        for (const [callSid, binding] of this.triviaVoiceCallBindings) {
          if (binding.code !== roomCode) continue;
          if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
          this.triviaVoiceCallBindings.delete(callSid);
        }
        for (const [callSid, route] of this.stationVoiceReconnectRoutes) {
          if (route.game !== 'trivia' || route.roomCode !== roomCode) continue;
          this.stationVoiceReconnectRoutes.delete(callSid);
          this.voiceReconnectAttempts.delete(callSid);
        }
        this.analyticsObserver.triviaAborted(roomCode);
        this.trivia.abortRoom(roomCode);
      } else if (game === 'chess') {
        for (const session of [...(this.chessVoice.get(roomCode) ?? [])]) session.handleReplaced();
        this.chessVoice.delete(roomCode);
        for (const [callSid, binding] of this.chessVoiceCallBindings) {
          if (binding.code !== roomCode) continue;
          if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
          this.chessVoiceCallBindings.delete(callSid);
        }
        for (const [callSid, route] of this.stationVoiceReconnectRoutes) {
          if (route.game !== 'chess' || route.roomCode !== roomCode) continue;
          this.stationVoiceReconnectRoutes.delete(callSid);
          this.voiceReconnectAttempts.delete(callSid);
        }
        this.analyticsObserver.chessAborted(roomCode);
        this.chess.abortRoom(roomCode);
      } else assertNever(game);
      this.activeStationEngines.delete(`${game}:${roomCode}`);
    };
    if (game === 'racer') {
      const settled = Promise.all([...this.voiceAdapters.get(roomCode) ?? []]
        .map(adapter => adapter.whenSpeechSettled()));
      void Promise.race([settled, sleep(RELAY_SPEECH_SETTLE_TIMEOUT_MS)]).then(finalize);
    } else if (game === 'monsters') {
      const settled = Promise.all([...this.battleVoice.get(roomCode) ?? []]
        .map(session => session.whenSpeechSettled()));
      void Promise.race([settled, sleep(RELAY_SPEECH_SETTLE_TIMEOUT_MS)]).then(finalize);
    } else if (game === 'trivia') {
      const settled = Promise.all([...this.triviaVoice.get(roomCode) ?? []]
        .map(session => session.whenSpeechSettled()));
      void Promise.race([settled, sleep(RELAY_SPEECH_SETTLE_TIMEOUT_MS)]).then(finalize);
    } else if (game === 'chess') {
      const settled = Promise.all([...this.chessVoice.get(roomCode) ?? []]
        .map(session => session.whenSpeechSettled()));
      void Promise.race([settled, sleep(RELAY_SPEECH_SETTLE_TIMEOUT_MS)]).then(finalize);
    } else if (game === 'karaoke') {
      const settled = Promise.allSettled([...this.karaokeVoice.get(roomCode) ?? []]
        .map(session => session.whenResultSpeechSettled()));
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const timedOut = new Promise<false>(resolve => {
        timeoutId = setTimeout(() => resolve(false), RELAY_SPEECH_SETTLE_TIMEOUT_MS);
        timeoutId.unref?.();
      });
      void Promise.race([settled.then(() => true as const), timedOut]).then(completed => {
        if (timeoutId) clearTimeout(timeoutId);
        if (!completed) {
          // A stuck Relay must not keep old result audio queued after the station is reused.
          for (const [socket, binding] of this.voiceSockets) {
            const bound = binding();
            if (bound?.game === 'karaoke' && bound.roomCode === roomCode) clearRelayTextQueue(socket);
          }
        }
        finalize();
      });
    } else if (game === 'fighter') {
      finalize();
    } else assertNever(game);
  }

  /** Refresh the cached lobby choices: car count + names from the manifest, map keys from maps.json. */
  private async refreshRoomConfig(): Promise<void> {
    let carCount = 0, maps: string[] = [], carNames: string[] = [];
    try {
      const m = await this.manifestStore.read();
      carCount = m.cars.length;
      carNames = m.cars.map(r => r.name?.trim() || r.file.replace(/\.glb$/i, '').replace(/[_-]+/g, ' ').trim());
    } catch { /* keep prior */ }
    try {
      const all = JSON.parse(await readFile(this.mapsPath, 'utf8'));
      if (all && typeof all === 'object') maps = Object.keys(all);
    } catch { /* keep prior */ }
    this.roomConfigCache = {
      carCount: carCount || this.roomConfigCache.carCount,
      maps: maps.length ? maps : this.roomConfigCache.maps,
      carNames: carNames.length ? carNames : this.roomConfigCache.carNames,
    };
    if (carNames.length) this.carNamesCache = carNames;
    // Refresh leaderboard rows for the AI host. Best-effort: a read failure keeps prior rows.
    if(!this.leaderboardLoaded)try {
      await this.leaderboardWrite;
      const entries = parseLeaderboardStrict(await readFile(this.leaderboardPath, 'utf8'));
      if (entries === null) throw new Error('leaderboard storage is corrupt');
      this.leaderboardEntriesCache = entries;
      this.leaderboardLoaded=true;
    } catch { /* keep prior rows */ }
  }

  private async refreshFighterMaps(): Promise<void> {
    let liveValid = false;
    try {
      this.fighterMaps = parseFighterMaps(JSON.parse(await readFile(this.fighterMapsPath, 'utf8'))); liveValid = true;
    } catch { /* seed/fallback below */ }
    if (!liveValid) {
      try {
        this.fighterMaps = parseFighterMaps(JSON.parse(await readFile(this.bundledFighterMapsPath, 'utf8')));
        await this.writeFileAtomic(this.fighterMapsPath, JSON.stringify(this.fighterMaps, null, 2));
        console.log(`[fighter-maps] seeded ${this.fighterMapsPath} from ${this.bundledFighterMapsPath}`);
      } catch (error) { console.error('[fighter-maps] using built-in fallback:', (error as Error).message); }
    }
    // The Rain GLB is too large for a reliable kiosk load (191 embedded textures). Keep the map's
    // atmosphere and bounds but force its deterministic procedural stage, including for persisted catalogs.
    this.fighterMaps = runtimeFighterMaps(this.fighterMaps);
    this.fighter.setMaps(this.fighterMaps);
  }

  /** Wrap a live game Room as a ConciergeRoom (adds car names/count from the cached manifest). */
  private conciergeRoom(code: string): ConciergeRoom | null {
    const room = this.game.findRoom(code) ?? this.game.getOrCreateRoom(code);
    if (!room) return null;
    const carNames = this.carNamesCache;
    return {
      get phase() { return room.phase; },
      get mapChoices() { return room.mapChoices; },
      carNames,
      carCount: this.roomConfigCache.carCount || carNames.length,
      addPlayer: (name) => room.addPlayer(name),
      setPlayerInfo: (id, info) => room.setPlayerInfo(id, info),
      selectCar: (id, idx) => room.selectCar(id, idx),
      selectMap: (m) => room.selectMap(m),
      removePlayer: (id) => room.removePlayer(id),
    };
  }

  /** Append one finished race's standings to the persistent global leaderboard (serialized + atomic).
   *  Best-effort: a write failure is logged, never thrown (a race result is not worth crashing over). */
  private persistRaceResults(map: string | null, results: import('../shared/types').RaceResult[], roomCode: string): void {
    if (!map || results.length === 0) return;
    const at = Date.now();
    // Chain onto the previous write so concurrent finishes serialize (read-modify-write safety).
    this.leaderboardWrite = this.leaderboardWrite.then(async () => {
      let existing = '';
      try { existing = await readFile(this.leaderboardPath, 'utf8'); } catch { existing = ''; }
      const out = appendResults(existing, { map, results, at, identityNamespace: roomCode });
      if (!out.ok) { console.error('leaderboard append refused:', out.error); return; }
      try {
        await this.writeFileAtomic(this.leaderboardPath, JSON.stringify(out.entries));
        this.leaderboardEntriesCache = out.entries;
        this.leaderboardLoaded = true;
      }
      catch (e) { console.error('leaderboard write failed:', (e as Error).message); }
    }).catch((e) => console.error('leaderboard persist error:', e));
  }

  private persistKaraokeResult(roomCode: string, result: KaraokeResult): void {
    this.leaderboardWrite = this.leaderboardWrite.then(async () => {
      let existing = '';
      try { existing = await readFile(this.karaokeLeaderboardPath, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const appended = appendKaraokeResult(existing, result, roomCode);
      if (!appended.ok) {
        console.error('Karaoke leaderboard append refused:', appended.error);
        return;
      }
      await this.writeFileAtomic(this.karaokeLeaderboardPath, JSON.stringify(appended.entries));
    }).catch(error => console.error('Karaoke leaderboard persist error:', (error as Error).message));
  }

  private persistTriviaResult(roomCode: string, result: TriviaResult): void {
    const persistedResult: TriviaResult = Object.freeze({
      ...result,
      players: Object.freeze(result.players.map(player => {
        const canonical = this.arcadeApi?.canonicalStationEnginePlayerId?.(player.playerId) ?? player.playerId;
        return Object.freeze({ ...player, playerId: isSafeTriviaId(canonical) ? canonical : player.playerId });
      })),
    });
    const key = triviaLeaderboardResultId(roomCode, persistedResult);
    if (this.triviaResultPersistence.has(key)) return;
    const append = this.leaderboardWrite.then(async () => {
      await this.triviaLeaderboard.appendRound({
        uniqueResultId: key,
        identityNamespace: triviaIdentityNamespace(roomCode),
        result: persistedResult,
      });
    });
    let tracked: Promise<void>;
    tracked = append.then(
      () => { if (this.triviaResultPersistence.get(key) === tracked) this.triviaResultPersistence.delete(key); },
      error => {
        if (this.triviaResultPersistence.get(key) === tracked) this.triviaResultPersistence.delete(key);
        console.error('Trivia leaderboard persist error:', error instanceof Error ? error.message : String(error));
      },
    );
    this.leaderboardWrite = tracked;
    if (this.triviaResultPersistence.size >= TRIVIA_RESULT_PERSISTENCE_LIMIT) {
      const oldest = this.triviaResultPersistence.keys().next().value;
      if (oldest !== undefined) this.triviaResultPersistence.delete(oldest);
    }
    this.triviaResultPersistence.set(key, tracked);
  }

  private leaderboardAdminSummary(): Promise<{
    games: Array<{ game: 'racer' | 'karaoke' | 'trivia'; resettable: true; maps: Array<{ map: string; label?: string; records: number }> }>;
    etag: string;
  }> {
    const task = this.leaderboardWrite.then(async () => {
      const [racerEntries, karaokeEntries, triviaStored] = await Promise.all([
        this.readLeaderboardStrict(),
        this.readKaraokeLeaderboardStrict(),
        this.readTriviaLeaderboardStrict(),
      ]);
      const mapNames = new Set([...this.roomConfigCache.maps, ...racerEntries.map(entry => entry.map)]);
      const songTitles = new Map(KARAOKE_DEVELOPMENT_SONGS.map(song => [song.id, song.title]));
      const songIds = new Set([...songTitles.keys(), ...karaokeEntries.map(entry => entry.songId)]);
      return{
        games: [
          { game: 'racer', resettable: true, maps: [...mapNames].sort().map(map => ({
            map, records: racerEntries.filter(entry => entry.map === map).length,
          })) },
          { game: 'karaoke', resettable: true, maps: [...songIds].sort().map(songId => ({
            map: songId,
            ...(songTitles.get(songId) ? { label: songTitles.get(songId) } : {}),
            records: karaokeEntries.filter(entry => entry.songId === songId).length,
          })) },
          { game: 'trivia', resettable: true, maps: TRIVIA_BOARD_IDS.map(board => ({
            map: board,
            label: board === TRIVIA_ALL_TIME_BOARD_ID ? 'All time' : board,
            records: board === TRIVIA_ALL_TIME_BOARD_ID
              ? triviaStored.length
              : triviaStored.filter(entry => entry.category === board).length,
          })) },
        ] satisfies Array<{
          game: 'racer' | 'karaoke' | 'trivia';
          resettable: true;
          maps: Array<{ map: string; label?: string; records: number }>;
        }>,
        etag:this.leaderboardEtag(racerEntries, karaokeEntries, triviaStored),
      };
    });
    this.leaderboardWrite = task.then(() => undefined, () => undefined);
    return task;
  }

  private leaderboardEtag(
    racerEntries: readonly LeaderboardEntry[],
    karaokeEntries: readonly KaraokeLeaderboardEntry[] = [],
    triviaEntries: readonly PublicTriviaLeaderboardEntry[] | readonly StoredTriviaLeaderboardEntry[] = [],
  ): string {
    return `"leaderboard-${createHash('sha256').update(JSON.stringify({ racerEntries, karaokeEntries, triviaEntries })).digest('hex').slice(0,16)}"`;
  }

  private resetLeaderboardScores(
    game: 'racer' | 'karaoke' | 'trivia',
    map: string,
    expectedEtag: string,
  ): Promise<{deleted:number;remaining:number;etag:string}> {
    const task=this.leaderboardWrite.then(async()=>{
      const [racerEntries, karaokeEntries, triviaEntries] = await Promise.all([
        this.readLeaderboardStrict(),
        this.readKaraokeLeaderboardStrict(),
        this.readTriviaLeaderboardStrict(),
      ]);
      const currentEtag=this.leaderboardEtag(racerEntries, karaokeEntries, triviaEntries);
      if(expectedEtag!==currentEtag)throw Object.assign(new Error('leaderboard changed; refresh and confirm again'),{code:'PRECONDITION_FAILED',etag:currentEtag});
      if (game === 'racer') {
        if(!new Set([...this.roomConfigCache.maps,...racerEntries.map(entry=>entry.map)]).has(map))throw Object.assign(new Error('unknown map'),{code:'UNKNOWN_MAP'});
        const remaining=racerEntries.filter(entry=>entry.map!==map),deleted=racerEntries.length-remaining.length;
        await this.writeFileAtomic(this.leaderboardPath,JSON.stringify(remaining));
        this.leaderboardEntriesCache=remaining;this.leaderboardLoaded=true;
        return{deleted,remaining:remaining.length,etag:this.leaderboardEtag(remaining,karaokeEntries,triviaEntries)};
      }
      if (game === 'karaoke') {
        if(!new Set([...KARAOKE_DEVELOPMENT_SONGS.map(song=>song.id),...karaokeEntries.map(entry=>entry.songId)]).has(map))throw Object.assign(new Error('unknown song'),{code:'UNKNOWN_MAP'});
        const remaining=karaokeEntries.filter(entry=>entry.songId!==map),deleted=karaokeEntries.length-remaining.length;
        await this.writeFileAtomic(this.karaokeLeaderboardPath,JSON.stringify(remaining));
        return{deleted,remaining:remaining.length,etag:this.leaderboardEtag(racerEntries,remaining,triviaEntries)};
      }
      if (!isTriviaBoardId(map)) throw Object.assign(new Error('unknown Trivia board'), { code: 'UNKNOWN_MAP' });
      const reset = await this.triviaLeaderboard.reset(map);
      const remaining = await this.readTriviaLeaderboardStrict();
      return { deleted: reset.deleted, remaining: remaining.length,
        etag: this.leaderboardEtag(racerEntries, karaokeEntries, remaining) };
    });
    this.leaderboardWrite=task.then(()=>undefined,()=>undefined);
    return task;
  }

  private async readLeaderboardStrict(): Promise<LeaderboardEntry[]> {
    try {
      const entries = parseLeaderboardStrict(await readFile(this.leaderboardPath, 'utf8'));
      if (entries === null) throw new Error('leaderboard storage is corrupt');
      return entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async readKaraokeLeaderboardStrict(): Promise<KaraokeLeaderboardEntry[]> {
    try {
      const entries = parseKaraokeLeaderboardStrict(await readFile(this.karaokeLeaderboardPath, 'utf8'));
      if (entries === null) throw new Error('Karaoke leaderboard storage is corrupt');
      return entries;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private async readTriviaLeaderboardStrict(): Promise<StoredTriviaLeaderboardEntry[]> {
    await this.triviaLeaderboard.flush();
    try {
      const file = parseTriviaLeaderboardStrict(await readFile(this.triviaLeaderboardPath, 'utf8'));
      if (!file) throw new Error('Trivia leaderboard storage is corrupt');
      return [...file.entries];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  private cleanupResetPlayerHistory(context: PlayerResetCleanupContext): Promise<void> {
    const targets = new Set(context.nameHashes);
    const enginePlayerIds = new Set(context.racers
      .filter(racer => racer.game === 'racer')
      .map(racer => `${racer.roomCode}:${racer.enginePlayerId}`));
    const karaokeEnginePlayerIds = new Set(context.racers
      .filter(racer => racer.game === 'karaoke')
      .map(racer => `${racer.roomCode}:${racer.enginePlayerId}`));
    for (const racer of context.racers) {
      if (racer.game === 'racer') this.game.anonymizePlayer(racer.roomCode,racer.enginePlayerId);
      else if (racer.game === 'monsters') this.battle.anonymizePlayer(racer.roomCode,racer.enginePlayerId);
      else if (racer.game === 'fighter') this.fighter.anonymizePlayer(racer.roomCode,racer.enginePlayerId);
      else if (racer.game === 'karaoke') this.karaoke.anonymizePlayer(racer.roomCode,racer.enginePlayerId);
      else if (racer.game === 'trivia') this.trivia.anonymizePlayer(racer.roomCode,racer.enginePlayerId);
      else if (racer.game === 'chess') continue;
      else assertNever(racer.game);
    }
    if (!targets.size && !enginePlayerIds.size && !karaokeEnginePlayerIds.size && !context.racers.some(racer => racer.game === 'trivia')) return Promise.resolve();
    const cleanup = this.leaderboardWrite.then(async () => {
      let entries: LeaderboardEntry[] = [];
      try {
        const parsed = parseLeaderboardStrict(await readFile(this.leaderboardPath, 'utf8'));
        if (parsed === null) throw new Error('leaderboard storage is corrupt');
        entries = parsed;
      }
      catch (error) {
        if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
      }
      let changed = false;
      const anonymized = entries.map(entry => {
        const exactEngine = entry.enginePlayerId !== undefined && enginePlayerIds.has(entry.enginePlayerId);
        const legacyRun = entry.enginePlayerId === undefined
          && targets.has(createHash('sha256').update(`reset-name:${entry.name.trim().toLocaleLowerCase()}`).digest('hex'))
          && context.racers.some(racer => racer.completedAt !== null && racer.durationSeconds !== null
            && Math.abs(entry.at - Date.parse(racer.completedAt)) <= 60_000
            && Math.abs(entry.finishT - racer.durationSeconds) < 0.001);
        if (!exactEngine && !legacyRun) return entry;
        changed = true;
        return { ...entry, name: 'PLAYER' };
      });
      if(changed)await this.writeFileAtomic(this.leaderboardPath, JSON.stringify(anonymized));
      this.leaderboardEntriesCache = anonymized;
      this.leaderboardLoaded = true;

      let karaokeEntries: KaraokeLeaderboardEntry[];
      try {
        const parsed = parseKaraokeLeaderboardStrict(await readFile(this.karaokeLeaderboardPath, 'utf8'));
        if (parsed === null) throw new Error('Karaoke leaderboard storage is corrupt');
        karaokeEntries = parsed;
      } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') karaokeEntries = [];
        else throw error;
      }
      let karaokeChanged = false;
      const anonymizedKaraoke = karaokeEntries.map(entry => {
        const exactEngine = entry.enginePlayerId !== undefined && karaokeEnginePlayerIds.has(entry.enginePlayerId);
        const legacyRun = entry.enginePlayerId === undefined
          && targets.has(createHash('sha256').update(`reset-name:${entry.name.trim().toLocaleLowerCase()}`).digest('hex'))
          && context.racers.some(racer => racer.game === 'karaoke' && racer.completedAt !== null
            && Math.abs(entry.at - Date.parse(racer.completedAt)) <= 60_000);
        if (!exactEngine && !legacyRun) return entry;
        karaokeChanged = true;
        return { ...entry, name: 'PLAYER' };
      });
      if (karaokeChanged) await this.writeFileAtomic(this.karaokeLeaderboardPath, JSON.stringify(anonymizedKaraoke));
      for (const racer of context.racers.filter(candidate => candidate.game === 'trivia')) {
        await this.triviaLeaderboard.anonymizePlayer({
          identityNamespace: triviaIdentityNamespace(racer.roomCode),
          playerId: racer.enginePlayerId,
        });
      }
    });
    this.leaderboardWrite = cleanup.catch(error => console.error('leaderboard reset cleanup failed:', error));
    return cleanup;
  }

  /** Run an SMS handler serialized per phone number (chained promises keyed by `from`). */
  private async runSmsSerialized(from: string, fn: () => string | Promise<string>): Promise<string> {
    const prior = this.smsLocks.get(from) ?? Promise.resolve();
    const run = prior.then(fn);
    const tracked = run.catch(() => {});
    this.smsLocks.set(from, tracked);
    try {
      return await run;
    } finally {
      if (this.smsLocks.get(from) === tracked) this.smsLocks.delete(from);
    }
  }

  private onVoiceConnection(ws: WebSocket): void {
    console.log('[CR] voice WebSocket connected (Conversation Relay)');
    let relayLocale = this.defaultLocale;
    let adapter: ConversationRelayAdapter;
    adapter = new ConversationRelayAdapter({
      findOrCreateRoom: (code) => this.game.getOrCreateRoom(code),
      resumePlayer: (callSid, code) => this.resumeRacerVoiceCall(callSid, code, adapter),
      // SPEAK to the caller: Conversation Relay TTS-synthesizes {type:'text'} tokens onto the call.
      // `last:true` marks a complete utterance so Relay flushes it promptly.
      say: (text, isCurrent) => sendRelayText(ws, text, relayLocale, isCurrent),
      register: (roomCode, a) => {
        let set = this.voiceAdapters.get(roomCode);
        if (!set) { set = new Set(); this.voiceAdapters.set(roomCode, set); }
        set.add(a);
      },
      unregister: (a) => {
        for (const [code, set] of this.voiceAdapters) {
          if (set.delete(a) && set.size === 0) this.voiceAdapters.delete(code);
        }
      },
      // Drop the caller's slot + reap the room if empty (a phone caller never hits the WS reap paths).
      leaveRoom: (roomCode, playerId) => this.game.voiceLeave(roomCode, playerId),
      phaseOf: (roomCode) => this.game.findRoom(roomCode)?.phase ?? 'lobby',
      hasPlayerName: (roomCode, playerId) => {
        return this.game.findRoom(roomCode)?.hasConfirmedName(playerId) === true;
      },
      onSetupChanged:(roomCode,beforePhase)=>this.game.voiceSetupChanged(roomCode,beforePhase as Phase),
      handleSetupUtterance:(roomCode,playerId,utterance,locale)=>{
        const room=this.game.findRoom(roomCode);
        const setupReady=!stationManaged||Boolean(stationReadyEntryId&&this.arcadeApi?.stationVoiceSetupReady(stationReadyEntryId));
        return room?this.directSelection(room,playerId,utterance,locale,stationFirstName!==null,setupReady):null;
      },
      setupTurnFor:(roomCode,playerId,phase)=>{
        const room=this.game.findRoom(roomCode);
        if(!room)return'waiting';
        return phase==='car_select'?(room.canSelectCar(playerId)?'active':'waiting')
          :phase==='map_select'?(room.canSelectMap(playerId)?'active':'waiting'):'active';
      },
      onIntent: () => this.analyticsObserver.voiceCommand('racer'),
      resultRecap: (roomCode, playerId, locale, isStationManaged) => {
        const room = this.game.findRoom(roomCode);
        if (!room || !['results', 'finished'].includes(room.phase)) return null;
        const context = this.hostContext(room, playerId, locale, isStationManaged);
        context.stationManaged = isStationManaged;
        return this.racerResultsRecap(context, locale);
      },
      // Interpret only actions and answers available on this caller's current screen. The
      // authoritative room applies them after the model returns; model prose never drives state.
      converse: async (roomCode, playerId, utterance, locale, isCurrent, readOnlyInquiry = false) => {
        const room = this.game.findRoom(roomCode);
        if (!room || !isCurrent()) return null;
        if (utterance.trim().startsWith('(') && ['results', 'finished'].includes(room.phase)) {
          const context = this.hostContext(room, playerId, locale, stationManaged, isCurrent);
          context.stationManaged = stationManaged;
          return this.racerResultsRecap(context, locale);
        }
        return this.resolveRacerVoiceTurn(room, playerId, utterance, locale, isCurrent,
          stationManaged, stationFirstName !== null,
          !stationManaged || Boolean(stationReadyEntryId && this.arcadeApi?.stationVoiceSetupReady(stationReadyEntryId)),
          readOnlyInquiry);
      },
    });

    // One voice WebSocket serves all six games. The setup frame supplies the station's
    // authoritative game, or standalone routing finds one accepted display for this room.
    // Fix the route for the rest of the call so later screen changes cannot move the caller.
    let route: MountedVoiceGame | null = null;
    let battle: BattleVoiceSession | null = null;
    let fighter: FighterVoiceSession | null = null;
    let karaoke: KaraokeVoiceSession | null = null;
    let trivia: TriviaVoiceSession | null = null;
    let chess: ChessVoiceSession | null = null;
    let relayCallSid = '';
    let stationCallSid = '';
    let stationReadyEntryId = '';
    let stationFirstName: string | null = null;
    let stationManaged = false;
    let stationParticipantIndex = 0;
    let stationParticipantCount = 1;
    const stationConnectionId = randomUUID();
    let socketClosed = false;
    this.voiceSockets.set(ws, () => {
      if (route === null) return null;
      if (route === 'battle') return battle?.boundRoom ? { game: 'monsters', roomCode: battle.boundRoom } : null;
      if (route === 'fighter') return fighter?.boundRoomCode ? { game: 'fighter', roomCode: fighter.boundRoomCode } : null;
      if (route === 'karaoke') return karaoke?.boundRoomCode ? { game: 'karaoke', roomCode: karaoke.boundRoomCode } : null;
      if (route === 'trivia') return trivia?.boundRoomCode ? { game: 'trivia', roomCode: trivia.boundRoomCode } : null;
      if (route === 'chess') return chess?.boundRoomCode ? { game: 'chess', roomCode: chess.boundRoomCode } : null;
      if (route === 'racer') return adapter.boundRoomCode ? { game: 'racer', roomCode: adapter.boundRoomCode } : null;
      return assertNever(route);
    });
    const say = (text: string, isCurrent?: () => boolean) => sendRelayText(ws, text, relayLocale, isCurrent);
    const sayOutcome = (text: string, isCurrent?: () => boolean) =>
      sendRelayTextOutcome(ws, text, relayLocale, isCurrent);
    const processFrame = (raw: string) => {
      if (route === null) {
        try {
          const parameters = JSON.parse(raw)?.customParameters;
          relayLocale = resolveLocale(parameters?.commandLocale ?? parameters?.locale, this.defaultLocale);
        } catch { /* session handlers validate malformed frames */ }
      }
      if (route === null && this.voiceRelayToken) {
        try {
          if (String(JSON.parse(raw)?.customParameters?.relayToken ?? '') !== this.voiceRelayToken) { ws.close(1008, 'unauthorized relay'); return; }
        } catch { ws.close(1008, 'unauthorized relay'); return; }
      }
      try {
        const frame = JSON.parse(raw);
        const type = frame?.type;
        if (type === 'setup') relayCallSid = String(frame.callSid ?? '').trim();
        if (type === 'error') {
          const errorCode = String(frame?.code ?? '').match(/\b\d{5}\b/)?.[0]
            ?? String(frame?.description ?? '').match(/\b\d{5}\b/)?.[0] ?? 'unknown';
          console.error(`[CR] relay error code=${errorCode}`);
          if (['64106', '64107', '64111', '64112'].includes(errorCode)) settleRelayPlayback(ws, 'failed');
        }
        const roomCode = adapter.boundRoomCode;
        const racerResultsPrompt = type === 'prompt' && route === 'racer'
          && roomCode !== null && ['results', 'finished'].includes(this.game.findRoom(roomCode)?.phase ?? '');
        const lateRacerCommand = racerResultsPrompt && (adapter.hasActiveLateRacingPrompt()
          || (adapter.acceptsLateRacingPrompt()
            && isLateRacerGameplayPrompt(String(frame?.voicePrompt ?? ''), relayLocale)));
        // A final ASR frame can arrive after the finish event. It still belongs to the race and must
        // not clear the recap or reinterpret "go" as a rematch that skips the scoreboard.
        if (lateRacerCommand) {
          adapter.ignoreLateRacingPrompt(frame?.last === true);
          return;
        }
        if (type === 'prompt' || type === 'interrupt' || type === 'dtmf') clearRelayTextQueue(ws, type === 'interrupt');
      } catch { /* adapter will ignore bad frames */ }
      if (route === null) route = this.pickVoiceGame(raw);
      if (route === null) {
        ws.close(1008, 'ambiguous game route');
        return;
      }
      if (route === 'battle') {
        if (!battle) battle = this.makeBattleSession(say);
        battle.setAuthoritativeName(stationFirstName);
        battle.setStationManaged(stationManaged);
        if(stationManaged)battle.setStationAssignment(stationParticipantIndex,stationParticipantCount);
        battle.handleMessage(raw);
      } else if (route === 'fighter') {
        if (!fighter) fighter = this.makeFighterSession(say);
        fighter.setAuthoritativeName(stationFirstName);
        fighter.setStationManaged(stationManaged);
        if(stationManaged)fighter.setStationAssignment(stationParticipantIndex,stationParticipantCount);
        fighter.handleMessage(raw);
      } else if (route === 'karaoke') {
        if (!karaoke) karaoke = this.makeKaraokeSession(
          sayOutcome,
          handoff => this.requestKaraokeMediaHandoff(relayCallSid, karaoke!, ws, handoff),
        );
        karaoke.setAuthoritativeName(stationFirstName);
        karaoke.setStationManaged(stationManaged);
        karaoke.handleMessage(raw);
      } else if (route === 'trivia') {
        if (!trivia) trivia = this.makeTriviaSession(
          sayOutcome,
          () => stationManaged,
          () => clearRelayTextQueue(ws),
        );
        trivia.setAuthoritativeName(stationFirstName);
        trivia.setStationManaged(stationManaged);
        trivia.setExpectedPlayers(stationManaged ? stationParticipantCount : 1);
        if (stationManaged) trivia.setStationAssignment(stationParticipantIndex);
        trivia.handleMessage(raw);
      } else if (route === 'chess') {
        if (!chess) chess = this.makeChessSession(say, () => stationManaged);
        chess.setAuthoritativeName(stationFirstName);
        chess.setStationManaged(stationManaged);
        chess.handleMessage(raw);
      } else if (route === 'racer') {
        adapter.setAuthoritativeName(stationFirstName);
        adapter.setStationManaged(stationManaged);
        if(stationManaged)adapter.setStationAssignment(stationParticipantIndex,stationParticipantCount);
        adapter.handleMessage(raw);
      } else assertNever(route);
      try {
        const setup = JSON.parse(raw);
        if (setup?.type === 'setup') {
          relayCallSid = String(setup.callSid ?? '');
          const readyEntryId = String(setup.customParameters?.readyEntryId ?? '');
          const bound = route === 'battle' ? battle?.boundPlayerId
            : route === 'fighter' ? fighter?.boundPlayerId
              : route === 'karaoke' ? karaoke?.boundPlayerId
                : route === 'trivia' ? trivia?.boundPlayerId
                : route === 'chess' ? chess?.boundPlayerId
                : route === 'racer' ? adapter.boundPlayerId : null;
          if (bound && readyEntryId) {
            this.arcadeApi?.stationVoiceParticipantConnected(String(setup.callSid ?? ''), readyEntryId, bound, stationConnectionId);
          }
          if (route === 'racer' && bound && adapter.boundRoomCode) {
            this.rememberRacerVoiceCall(relayCallSid, adapter.boundRoomCode, bound, adapter);
          }
        }
      } catch { /* individual handlers already validate malformed setup frames */ }
    };
    let frameQueue = Promise.resolve();
    let setupSeen = false;
    ws.on('message', d => {
      const raw = d.toString();
      frameQueue = frameQueue.then(async () => {
        let parsed: Record<string, unknown> | null = null;
        try {
          const candidate: unknown = JSON.parse(raw);
          parsed = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
            ? candidate as Record<string, unknown> : null;
        } catch { /* Reject malformed setup below. */ }
        if (!setupSeen && parsed?.type !== 'setup') {
          ws.close(1008, 'Relay setup required');
          return;
        }
        if (setupSeen && parsed?.type === 'setup') {
          ws.close(1008, 'duplicate Relay setup');
          return;
        }
        if (handleRelayPlaybackEvent(ws, raw)) return;
        const relayState = relayQueues.get(ws);
        if (relayState?.ending || relayState?.ended) {
          if (relayState.ending && (isRelayInterrupt(raw) || isRelayDtmf(raw) || isRelayTtsError(raw))) {
            clearRelayTextQueue(ws, true);
          }
          return;
        }
        const setup = parsed?.type === 'setup' ? parsed as Record<string, any> : null;
        const readyEntryId = String(setup?.customParameters?.readyEntryId ?? '');
        if (setup && !readyEntryId && this.arcadeApi?.requiresStationVoiceAssignment()) {
          ws.close(1008, 'station assignment required');
          return;
        }
        if (readyEntryId) {
          const identity = await this.arcadeApi?.resolveStationVoiceSetup({
            callSid: String(setup?.callSid ?? ''),
            readyEntryId,
            matchId: String(setup?.customParameters?.matchId ?? ''),
            launchGeneration: Number(setup?.customParameters?.launchGeneration),
            game: String(setup?.customParameters?.game ?? ''),
            roomCode: String(setup?.customParameters?.roomCode ?? ''),
          }) ?? null;
          if (!identity) {
            ws.close(1008, 'stale station assignment');
            return;
          }
          if (socketClosed) return;
          stationCallSid = String(setup?.callSid ?? '');
          stationReadyEntryId = readyEntryId;
          stationFirstName = identity.firstName;
          stationManaged = true;
          stationParticipantIndex = identity.participantIndex;
          stationParticipantCount = identity.participantCount;
          const assignedGame = String(setup?.customParameters?.game ?? '').toLowerCase();
          const assignedRoom = String(setup?.customParameters?.roomCode ?? '');
          const racerPhase = assignedGame === 'racer' ? this.game.findRoom(assignedRoom)?.phase : undefined;
          const resumable = assignedGame === 'monsters'
            ? this.hasResumableBattleVoiceCall(stationCallSid, assignedRoom)
            : assignedGame === 'fighter'
              ? this.hasResumableFighterVoiceCall(stationCallSid, assignedRoom)
              : assignedGame === 'karaoke'
                ? this.hasResumableKaraokeVoiceCall(stationCallSid, assignedRoom)
                : assignedGame === 'trivia'
                  ? this.hasResumableTriviaVoiceCall(stationCallSid, assignedRoom)
                : assignedGame === 'chess'
                  ? this.hasResumableChessVoiceCall(stationCallSid, assignedRoom)
                : this.hasResumableRacerVoiceCall(stationCallSid, assignedRoom);
          if ((identity.terminal || racerPhase === 'finished' || racerPhase === 'results') && !resumable) {
            ws.close(1008, 'finished station assignment');
            return;
          }
        }
        if(stationReadyEntryId){
          try{
            const activity=JSON.parse(raw) as {type?:unknown;last?:unknown};
            if(activity.type==='dtmf'||(activity.type==='prompt'&&activity.last===true))this.arcadeApi?.stationVoiceSetupActivity(stationReadyEntryId);
          }catch{/* Session parser handles malformed frames. */}
        }
        processFrame(raw);
        if (setup) setupSeen = true;
      }).catch(() => {
        console.error('[CR] voice setup failed');
        ws.close(1011, 'voice setup failed');
      });
    });
    ws.on('close', code => {
      socketClosed = true;
      disposeRelayQueue(ws);
      this.voiceSockets.delete(ws);
      console.log(`[CR] voice WebSocket closed code=${code}`);
      const karaokeBinding = stationCallSid ? this.karaokeVoiceCallBindings.get(stationCallSid) : undefined;
      const preserveStationConnection = route === 'karaoke' && Boolean(karaokeBinding
        && (karaokeBinding.pendingHandoff || karaokeBinding.attemptId)
        && ['loading', 'countdown', 'performing', 'finalizing'].includes(
          this.karaoke.findRoom(karaokeBinding.code)?.state().phase ?? '',
        ));
      if (stationCallSid && stationReadyEntryId && !preserveStationConnection) {
        this.arcadeApi?.stationVoiceParticipantDisconnected(stationCallSid, stationReadyEntryId, stationConnectionId);
      }
      if (battle) battle.handleClose();
      else if (fighter) fighter.handleClose();
      else if (trivia) {
        this.unregisterTriviaVoiceSession(trivia);
        trivia.handleClose();
      }
      else if (chess) {
        this.unregisterChessVoiceSession(chess);
        chess.handleClose();
      }
      else if (karaoke) {
        const binding = relayCallSid ? this.karaokeVoiceCallBindings.get(relayCallSid) : undefined;
        const phase = karaoke.boundRoomCode
          ? this.karaoke.findRoom(karaoke.boundRoomCode)?.state().phase
          : undefined;
        const activeMediaHandoff = Boolean(binding?.pendingHandoff || binding?.attemptId);
        const activePhase = phase === 'loading' || phase === 'countdown'
          || phase === 'performing' || phase === 'finalizing';
        const preserve = (activePhase && activeMediaHandoff) || (stationManaged && phase === 'results');
        this.unregisterKaraokeVoiceSession(karaoke);
        if (preserve) {
          if (binding?.activeSession === karaoke) binding.activeSession = null;
          karaoke.handleReplaced();
        } else if (activePhase) {
          karaoke.handleReplaced();
          if (relayCallSid) this.clearKaraokeVoiceBinding(relayCallSid, true);
        } else karaoke.handleClose();
      }
      else if (adapter.boundRoomCode && adapter.boundPlayerId && relayCallSid) {
        const preserve=stationManaged&&['results','finished'].includes(this.game.findRoom(adapter.boundRoomCode)?.phase??'');
        if(!preserve)this.scheduleRacerVoiceLeave(
          adapter.boundRoomCode, adapter.boundPlayerId, relayCallSid, adapter,
        );
        adapter.handleClose(true);
      } else adapter.handleClose();
    });
    ws.on('error', () => settleRelayPlayback(ws));
  }

  /** An explicit game parameter wins. A call with no game may infer its target only when one
   *  eligible standalone screen is open; two open screens are ambiguous even if one opened later. */
  private pickVoiceGame(firstFrame: string): MountedVoiceGame | null {
    let roomCode = DEFAULT_ROOM;
    try {
      const o = JSON.parse(firstFrame);
      const g = String(o?.customParameters?.game ?? '').toLowerCase();
      if (typeof o?.customParameters?.roomCode === 'string') roomCode = o.customParameters.roomCode;
      if (g === 'monsters' || g === 'battle') return 'battle';
      if (g === 'fighter' || g === 'fight') return 'fighter';
      if (g === 'karaoke' || g === 'sing') return 'karaoke';
      if (g === 'trivia' || g === 'quiz') return 'trivia';
      if (g === 'chess') return 'chess';
      if (g === 'racer' || g === 'race') return 'racer';
    } catch { /* fall through to auto-detect */ }
    const live = this.eligibleStandaloneVoiceGames(roomCode);
    return live.length > 1 ? null : live[0] ?? 'racer';
  }

  private recentVoiceGame(roomCode: string = DEFAULT_ROOM): MountedVoiceGame|null {
    const live = this.eligibleStandaloneVoiceGames(roomCode);
    return live.length === 1 ? live[0] ?? null : null;
  }

  private eligibleStandaloneVoiceGames(roomCode: string = DEFAULT_ROOM): MountedVoiceGame[] {
    const live: MountedVoiceGame[] = [];
    for(const [game,connections] of this.standaloneDisplays){
      const configuredGame=game==='battle'?'monsters':game;
      if(this.arcadeApi?.standaloneGameEnabled?.(configuredGame)===false)continue;
      const bound = [...connections.keys()].some(ws => {
        if (ws.readyState !== WebSocket.OPEN) return false;
        switch (game) {
          case 'racer': return this.game.hasStandaloneDisplay(ws, roomCode);
          case 'battle': return this.battle.hasStandaloneDisplay(ws, roomCode);
          case 'fighter': return this.fighter.hasStandaloneDisplay(ws, roomCode);
          case 'karaoke': return this.karaoke.hasStandaloneDisplay(ws, roomCode);
          case 'trivia': return this.trivia.hasStandaloneDisplay(ws, roomCode);
          case 'chess': return this.chess.hasStandaloneDisplay(ws, roomCode);
          default: return assertNever(game);
        }
      });
      if (!bound) continue;
      live.push(game);
    }
    return live;
  }

  private registerStandaloneDisplay(game:MountedVoiceGame,ws:WebSocket):void{
    let connections=this.standaloneDisplays.get(game);
    if(!connections){connections=new Map();this.standaloneDisplays.set(game,connections);}
    const firstRegistration = !connections.has(ws);
    connections.set(ws,Date.now());
    if (firstRegistration) ws.once('close',()=>{connections!.delete(ws);if(!connections!.size)this.standaloneDisplays.delete(game);});
  }

  private trackPendingTriviaDisplay(ws: WebSocket): void {
    const timer = setTimeout(() => {
      if (this.pendingTriviaDisplays.get(ws) !== timer) return;
      this.pendingTriviaDisplays.delete(ws);
      ws.terminate();
    }, this.triviaIdentificationTimeoutMs);
    timer.unref?.();
    this.pendingTriviaDisplays.set(ws, timer);
    ws.once('close', () => this.clearPendingTriviaDisplay(ws));
    ws.on('message', data => {
      if (!this.triviaDisplayToken) return;
      const message = parseTriviaClientMessage(data.toString());
      if (message.type !== 'display_auth' || message.token !== this.triviaDisplayToken) return;
      this.authenticatedTriviaDisplays.add(ws);
      this.clearPendingTriviaDisplay(ws);
    });
  }

  private clearPendingTriviaDisplay(ws: WebSocket): void {
    const timer = this.pendingTriviaDisplays.get(ws);
    if (!timer) return;
    clearTimeout(timer);
    this.pendingTriviaDisplays.delete(ws);
  }

  private recentVoiceLocale(game: MountedVoiceGame, roomCode: string): SupportedLocale {
    if (game === 'battle' && this.battle.connectionCount > 0) return this.battle.preferredLocale(roomCode, this.defaultLocale);
    if (game === 'fighter' && this.fighter.connectionCount > 0) return this.fighter.preferredLocale(roomCode, this.defaultLocale);
    if (game === 'racer' && this.game.connectionCount > 0) return this.game.preferredLocale(roomCode, this.defaultLocale);
    if (game === 'karaoke' && this.karaoke.connectionCount > 0) return this.karaoke.preferredLocale(roomCode, this.defaultLocale);
    if (game === 'trivia' && this.trivia.connectionCount > 0) return this.trivia.preferredLocale(roomCode, this.defaultLocale);
    if (game === 'chess' && this.chess.connectionCount > 0) return this.chess.preferredLocale(roomCode, this.defaultLocale);
    return this.defaultLocale;
  }

  private voiceHints(game: MountedVoiceGame, locale: SupportedLocale): string {
    const numbers = selectionNumberHints(locale);
    if (game === 'battle') {
      const commands = locale === 'pt-BR'
        ? ['atacar', 'ataque', 'ataca', 'lutar', 'luta', 'lute', 'batalhar', 'combater', 'defender', 'bloquear', 'item', 'poção', 'curar', 'provocar', 'voltar', 'cancelar', 'começar', 'revanche']
        : ['attack', 'fight', 'fights', 'flight', 'guard', 'item', 'potion', 'taunt', 'heal', 'back', 'start', 'rematch'];
      const monsters = rosterEntries();
      const primaryNames = monsters.map(monster => localizedMonsterName(locale, monster.id));
      const primaryMoves = monsters.flatMap(monster => monster.moves.map(move => localizedMoveName(locale, move.id)));
      const extraAliases = monsters.flatMap(monster => [
        ...localizedMonsterAliases(monster.id, monster.name),
        ...monster.moves.flatMap(move => localizedMoveAliases(move.id, move.name)),
      ]);
      return voiceHintList(commands, numbers.slice(0, 24), primaryNames, primaryMoves, extraAliases);
    }
    if (game === 'fighter') {
      const commands = locale === 'pt-BR'
        ? ['frente', 'avançar', 'avance', 'aproximar', 'aproxime-se', 'trás', 'recuar', 'recue', 'afastar', 'afaste-se', 'pular', 'pule', 'saltar', 'soco', 'socar', 'dê um soco', 'golpear', 'chute', 'chutar', 'dê um chute', 'bloquear', 'bloqueie', 'defender', 'defenda-se', 'começar', 'próximo', 'lutar', 'revanche', 'ajuda']
        : ['forward', 'closer', 'back', 'backward', 'away', 'jump', 'leap', 'hop', 'punch', 'jab', 'strike', 'kick', 'roundhouse', 'block', 'guard', 'defend', 'start', 'star', 'next', 'fight', 'fights', 'flight', 'rematch', 'help'];
      const fighters = FIGHTER_ROSTER.flatMap(fighter => localizedFighterAliases(fighter.id, fighter.name));
      const maps = this.fighterMaps.flatMap(map => [map.name, localizedFighterMapName(locale, map.id, map.name),
        ...(map.id === 'inakaya'
          ? ['Inakaya', 'Inakaya Restaurant', 'Ina Kaya', 'In a Kaya', 'In Akaya', 'Innakaya', 'Inikaya', 'Izakaya']
          : [])]);
      return voiceHintList(commands, numbers, fighters, maps);
    }
    if (game === 'karaoke') {
      const commands = locale === 'pt-BR'
        ? ['cantar', 'música', 'começar', 'iniciar', 'pronto', 'ajuda']
        : ['sing', 'song', 'start', 'begin', 'ready', 'help'];
      const localized = KARAOKE_DEVELOPMENT_SONGS.filter(song => song.locale === locale);
      const titles = (localized.length ? localized : KARAOKE_DEVELOPMENT_SONGS).map(song => song.title);
      return voiceHintList(commands, numbers, titles);
    }
    if (game === 'trivia') {
      const commands = locale === 'pt-BR'
        ? ['quiz', 'trivia', 'categoria', 'misturado', 'resposta', 'opção', 'número', 'letra', 'começar', 'próximo', 'jogar novamente', 'ajuda']
        : ['quiz', 'trivia', 'category', 'mixed', 'answer', 'choice', 'option', 'number', 'letter', 'start', 'next', 'play again', 'help'];
      const letters = locale === 'pt-BR'
        ? ['A', 'ah', 'alfa', 'B', 'bravo', 'C', 'Charlie', 'D', 'Delta']
        : ['A', 'ay', 'aye', 'alpha', 'B', 'bee', 'bravo', 'C', 'sea', 'Charlie', 'D', 'dee', 'Delta'];
      const categories = locale === 'pt-BR'
        ? ['conhecimentos gerais', 'ciências', 'geografia', 'história', 'entretenimento', 'esportes', 'tecnologia', 'Twilio']
        : ['general knowledge', 'science', 'geography', 'history', 'entertainment', 'sports', 'technology', 'Twilio'];
      return voiceHintList(commands, numbers, letters, categories);
    }
    if (game === 'chess') {
      const commands = locale === 'pt-BR'
        ? ['xadrez', 'peão', 'cavalo', 'bispo', 'torre', 'rainha', 'rei', 'para', 'de', 'capturar',
          'roque', 'promover', 'confirmar', 'sim', 'cancelar', 'não', 'ajuda', 'jogar novamente']
        : ['chess', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king', 'to', 'from', 'takes',
          'castle', 'promote', 'confirm', 'yes', 'cancel', 'no', 'help', 'play again'];
      const squares = 'abcdefgh'.split('').flatMap(file => Array.from({ length: 8 }, (_, index) => `${file}${index + 1}`));
      return voiceHintList(commands, squares);
    }
    const commands = locale === 'pt-BR'
      ? ['esquerda', 'direita', 'acelerar', 'acelere', 'acelera', 'vai', 'frear', 'freie', 'freia', 'devagar', 'reduzir', 'reduza', 'desacelerar', 'desacelere', 'parar', 'nitro', 'turbo', 'poder', 'começar', 'iniciar', 'próximo', 'próxima', 'corrida', 'correr', 'revanche', 'sim']
      : ['left', 'right', 'boost', 'go', 'brake', 'slow', 'stop', 'nitro', 'power', 'start', 'next', 'race', 'rematch'];
    const cars = this.roomConfigCache.carNames.flatMap(localizedCarAliases);
    const tracks = this.roomConfigCache.maps.flatMap(localizedTrackAliases);
    return voiceHintList(commands, numbers, cars, tracks);
  }

  private makeChessSession(
    say: (text: string, isCurrent?: () => boolean) => void | Promise<boolean>,
    stationManaged: () => boolean,
  ): ChessVoiceSession {
    let session: ChessVoiceSession;
    session = new ChessVoiceSession({
      bind: (rawCode, name, callSid, locale) => {
        const code = rawCode.trim().toUpperCase();
        const previous = this.chessVoiceCallBindings.get(callSid.trim());
        if (previous && previous.code !== code) this.endChessVoiceCall(callSid);
        const joined = this.chess.voiceJoin(code, name, callSid, locale, stationManaged());
        if (!joined) return null;
        this.analyticsObserver.chessBound(code, callSid);
        this.rememberChessVoiceCall(callSid, code, joined.playerId, locale, stationManaged(), session);
        this.registerChessVoiceSession(code, session);
        return joined;
      },
      leave: (code, playerId, callSid) => {
        this.unregisterChessVoiceSession(session);
        this.scheduleChessVoiceLeave(code, playerId, callSid, session);
      },
      command: (code, callSid, spoken, locale) => {
        const result = this.chess.voiceCommand(code, callSid, spoken, locale);
        if (result && ['selected', 'proposed', 'confirmed', 'cancelled', 'help'].includes(result.code)) {
          this.analyticsObserver.voiceCommand('chess');
        }
        return result;
      },
      restart: (code, callSid) => {
        const restarted = this.chess.voiceRestart(code, callSid);
        if (restarted) this.analyticsObserver.voiceCommand('chess');
        return restarted;
      },
      snapshot: code => this.chess.findRoom(code)?.state() ?? null,
      legalMoves: (code, callSid, locale) => this.chess.voiceLegalMoves(code, callSid, locale),
      interpret: (spoken, locale, context, isCurrent) => {
        if (!isCurrent()) return Promise.resolve({ kind: 'none' as const });
        const actions: VoiceInterpretAction[] = context.readOnlyInquiry ? [] : [
          { id: 'help', description: 'Explain the current chess controls' },
        ];
        if (!context.readOnlyInquiry && context.legalMoves.length) actions.push({
          id: 'propose_move', description: 'Propose a legal chess move; confirmation is still required',
          targetIds: context.legalMoves.map(move => move.id),
        });
        if (!context.readOnlyInquiry && context.pendingMove) {
          actions.push({ id: 'confirm', description: 'Confirm the pending move' });
          actions.push({ id: 'cancel', description: 'Cancel the pending move' });
        }
        if (!context.readOnlyInquiry && context.phase === 'finished' && !stationManaged()) {
          actions.push({ id: 'reset', description: 'Start a new standalone game' });
        }
        return interpretVoiceTurn(this.llm, {
          game: 'chess', phase: context.phase, locale, transcript: spoken, actions,
          choices: context.legalMoves, facts: context.facts,
        });
      },
      say,
    });
    return session;
  }

  private registerChessVoiceSession(code: string, session: ChessVoiceSession): void {
    let sessions = this.chessVoice.get(code);
    if (!sessions) {
      sessions = new Set();
      this.chessVoice.set(code, sessions);
    }
    sessions.add(session);
  }

  private unregisterChessVoiceSession(session: ChessVoiceSession): void {
    for (const [code, sessions] of this.chessVoice) {
      if (sessions.delete(session) && sessions.size === 0) this.chessVoice.delete(code);
    }
  }

  private rememberChessVoiceCall(
    callSid: string,
    code: string,
    playerId: string,
    locale: SupportedLocale,
    stationManaged: boolean,
    session: ChessVoiceSession,
  ): void {
    const sid = callSid.trim();
    const previous = this.chessVoiceCallBindings.get(sid);
    if (previous?.leaveTimer) clearTimeout(previous.leaveTimer);
    if (previous?.activeSession && previous.activeSession !== session) {
      this.unregisterChessVoiceSession(previous.activeSession);
      previous.activeSession.handleReplaced();
    }
    this.chessVoiceCallBindings.set(sid, {
      code, playerId, locale, stationManaged, activeSession: session, leaveTimer: null,
    });
  }

  private hasResumableChessVoiceCall(callSid: string, code: string): boolean {
    const binding = this.chessVoiceCallBindings.get(callSid.trim());
    return Boolean(binding && binding.code === code && this.chess.hasVoiceBinding(code, callSid));
  }

  private scheduleChessVoiceLeave(
    code: string,
    playerId: string,
    callSid: string,
    session: ChessVoiceSession,
  ): void {
    const sid = callSid.trim();
    const binding = this.chessVoiceCallBindings.get(sid);
    if (binding?.activeSession && binding.activeSession !== session) return;
    this.chess.voiceSetConnected(code, sid, false);
    if (!sid) {
      this.analyticsObserver.chessAborted(code);
      this.chess.voiceLeave(code, sid);
      return;
    }
    if (binding?.leaveTimer) clearTimeout(binding.leaveTimer);
    const leaveTimer = setTimeout(() => {
      const current = this.chessVoiceCallBindings.get(sid);
      if (!current || current.code !== code || current.playerId !== playerId) return;
      if (current.stationManaged) this.arcadeApi?.stationVoiceCallEnded(sid);
      this.chessVoiceCallBindings.delete(sid);
      this.analyticsObserver.chessAborted(code);
      this.chess.voiceLeave(code, sid);
      if (current.stationManaged) this.abandonUnfinishedChessStationRoom(code);
    }, CHESS_VOICE_RECONNECT_GRACE_MS);
    leaveTimer.unref?.();
    this.chessVoiceCallBindings.set(sid, {
      code, playerId, locale: binding?.locale ?? session.locale,
      stationManaged: binding?.stationManaged ?? false, activeSession: null, leaveTimer,
    });
  }

  private endChessVoiceCall(callSid: string): void {
    const sid = callSid.trim();
    const binding = this.chessVoiceCallBindings.get(sid);
    if (!binding) return;
    if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
    if (binding.activeSession) {
      this.unregisterChessVoiceSession(binding.activeSession);
      binding.activeSession.handleReplaced();
    }
    this.chessVoiceCallBindings.delete(sid);
    this.analyticsObserver.chessAborted(binding.code);
    this.chess.voiceLeave(binding.code, sid);
    if (binding.stationManaged) this.abandonUnfinishedChessStationRoom(binding.code);
  }

  private abandonUnfinishedChessStationRoom(code: string): void {
    if (this.chess.findRoom(code)?.state().phase === 'finished') return;
    // A launch-time no-show may still be replaced from the station queue. Only a
    // caller lost during active play should end the match immediately.
    if (this.arcadeApi?.stationEnginePhase('chess', code) !== 'PLAYING') return;
    this.updateStationEngineLifecycle('chess', code, undefined, ['playing', 'pending'], ['finished']);
  }

  private makeTriviaSession(
    say: (text: string, isCurrent?: () => boolean) => Promise<RelaySpeechOutcome>,
    stationFixed: () => boolean = () => false,
    preemptSpeech: () => void = () => {},
  ): TriviaVoiceSession {
    let session: TriviaVoiceSession;
    session = new TriviaVoiceSession({
      bind: (code, name, callSid, locale, nameConfirmed, expectedPlayers, participantIndex) => {
        code = code.trim().toUpperCase();
        const fixed = stationFixed();
        if (fixed && participantIndex === undefined) return null;
        const resumed = this.resumeTriviaVoiceCall(code, callSid, session, participantIndex);
        if (resumed) return { playerId: resumed, resumed: true };
        const playerId = this.trivia.voiceJoin(
          code,
          name,
          expectedPlayers,
          nameConfirmed,
          locale,
          { stationFixed: fixed, allowReplay: !fixed, ...(participantIndex !== undefined ? { participantIndex } : {}) },
        );
        if (!playerId) return null;
        this.rememberTriviaVoiceCall(callSid, code, playerId, locale, participantIndex, session);
        this.registerTriviaVoiceSession(code, session);
        return { playerId, resumed: false };
      },
      leave: (code, playerId, callSid) => {
        this.unregisterTriviaVoiceSession(session);
        this.scheduleTriviaVoiceLeave(code, playerId, callSid, session);
      },
      setName: (code, playerId, name) => {
        const accepted = this.trivia.voiceSetName(code, playerId, name);
        if (accepted) this.analyticsObserver.voiceCommand('trivia');
        return accepted;
      },
      voteCategory: (code, playerId, category) => {
        const accepted = this.trivia.voiceVoteCategory(code, playerId, category);
        if (accepted) this.analyticsObserver.voiceCommand('trivia');
        return accepted;
      },
      advance: (code, playerId) => {
        const explicit = this.trivia.findRoom(code)?.phase === 'results';
        const accepted = this.trivia.voiceAdvance(code, playerId);
        if (accepted && explicit) this.analyticsObserver.voiceCommand('trivia');
        return accepted;
      },
      beginPromptDelivery: (code, playerId, questionId, attemptId, estimatedSpeechMs) =>
        this.trivia.voiceBeginPromptDelivery(code, playerId, questionId, attemptId, estimatedSpeechMs),
      questionPromptReady: (code, playerId, questionId, attemptId, deliveryGeneration) =>
        this.trivia.voiceQuestionPromptReady(code, playerId, questionId, attemptId, deliveryGeneration),
      questionPromptSkipped: (code, playerId, questionId, attemptId) =>
        this.trivia.voiceQuestionPromptSkipped(code, playerId, questionId, attemptId),
      beginAnswerCueDelivery: (code, playerId, questionId, attemptId) =>
        this.trivia.voiceBeginAnswerCueDelivery(code, playerId, questionId, attemptId),
      questionAnswerCueReady: (code, playerId, questionId, attemptId, deliveryGeneration) =>
        this.trivia.voiceQuestionAnswerCueReady(code, playerId, questionId, attemptId, deliveryGeneration),
      questionAnswerCueSkipped: (code, playerId, questionId, attemptId) =>
        this.trivia.voiceQuestionAnswerCueSkipped(code, playerId, questionId, attemptId),
      beginRevealDelivery: (code, playerId, questionId, attemptId) =>
        this.trivia.voiceBeginRevealDelivery(code, playerId, questionId, attemptId),
      questionRevealReady: (code, playerId, questionId, attemptId, deliveryGeneration) =>
        this.trivia.voiceQuestionRevealReady(code, playerId, questionId, attemptId, deliveryGeneration),
      queueEarlyAnswer: (code, playerId, questionId, attemptId, choiceId) =>
        this.trivia.voiceQueueEarlyAnswer(code, playerId, questionId, attemptId, choiceId),
      pauseAudio: (code, questionId, attemptId) => this.trivia.voicePauseAudio(code, questionId, attemptId),
      beginAnswerResolution: (code, playerId, questionId, attemptId, onset) =>
        this.trivia.voiceBeginAnswerResolution(code, playerId, questionId, attemptId, onset),
      finishAnswerResolution: (code, playerId, questionId, attemptId, resolutionId) =>
        this.trivia.voiceFinishAnswerResolution(code, playerId, questionId, attemptId, resolutionId),
      answerAt: (code, playerId, choiceId, final, answeredAtMs, resolutionId) => {
        const accepted = this.trivia.voiceAnswerAt(code, playerId, choiceId, final, answeredAtMs, resolutionId);
        if (accepted) this.analyticsObserver.voiceCommand('trivia');
        return accepted;
      },
      snapshot: (code, playerId, locale) => this.trivia.voiceSnapshot(code, playerId, locale),
      resolveAnswer: (code, questionId, spoken, locale) => (
        this.trivia.resolveVoiceAnswer(code, questionId, spoken, locale)
      ),
      say,
      resolveIntent: request => interpretVoiceTurn(this.llm, request),
      preemptSpeech,
    });
    return session;
  }

  private registerTriviaVoiceSession(code: string, session: TriviaVoiceSession): void {
    let sessions = this.triviaVoice.get(code);
    if (!sessions) {
      sessions = new Set();
      this.triviaVoice.set(code, sessions);
    }
    sessions.add(session);
  }

  private unregisterTriviaVoiceSession(session: TriviaVoiceSession): void {
    for (const [code, sessions] of this.triviaVoice) {
      if (sessions.delete(session) && sessions.size === 0) this.triviaVoice.delete(code);
    }
  }

  private rememberTriviaVoiceCall(
    callSid: string,
    code: string,
    playerId: string,
    locale: SupportedLocale,
    participantIndex: number | undefined,
    session: TriviaVoiceSession,
  ): void {
    const sid = callSid.trim();
    if (!sid) return;
    const previous = this.triviaVoiceCallBindings.get(sid);
    if (previous?.leaveTimer) clearTimeout(previous.leaveTimer);
    if (previous?.activeSession && previous.activeSession !== session) {
      this.unregisterTriviaVoiceSession(previous.activeSession);
      previous.activeSession.handleReplaced();
    }
    if (previous && (previous.code !== code || previous.playerId !== playerId)) {
      this.trivia.voiceLeave(previous.code, previous.playerId);
    }
    this.triviaVoiceCallBindings.set(sid, {
      code, playerId, locale, participantIndex: participantIndex ?? null, activeSession: session, leaveTimer: null,
    });
  }

  private resumeTriviaVoiceCall(
    code: string,
    callSid: string,
    session: TriviaVoiceSession,
    participantIndex: number | undefined,
  ): string | null {
    const sid = callSid.trim();
    const binding = this.triviaVoiceCallBindings.get(sid);
    if (!binding || binding.code !== code || binding.participantIndex !== (participantIndex ?? null)
      || !this.trivia.findRoom(code)?.hasPlayer(binding.playerId)) return null;
    if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
    if (binding.activeSession && binding.activeSession !== session) {
      this.unregisterTriviaVoiceSession(binding.activeSession);
      binding.activeSession.handleReplaced();
    }
    binding.activeSession = session;
    binding.leaveTimer = null;
    this.registerTriviaVoiceSession(code, session);
    this.trivia.voiceSetConnected(code, binding.playerId, true);
    return binding.playerId;
  }

  private hasResumableTriviaVoiceCall(callSid: string, code: string): boolean {
    const binding = this.triviaVoiceCallBindings.get(callSid.trim());
    return Boolean(binding && binding.code === code && this.trivia.findRoom(code)?.hasPlayer(binding.playerId));
  }

  private scheduleTriviaVoiceLeave(
    code: string,
    playerId: string,
    callSid: string,
    session: TriviaVoiceSession,
  ): void {
    this.trivia.voiceSetConnected(code, playerId, false);
    const sid = callSid.trim();
    if (!sid) {
      this.trivia.voiceLeave(code, playerId);
      return;
    }
    const binding = this.triviaVoiceCallBindings.get(sid);
    if (binding?.activeSession && binding.activeSession !== session) return;
    if (binding?.leaveTimer) clearTimeout(binding.leaveTimer);
    const leaveTimer = setTimeout(() => {
      const current = this.triviaVoiceCallBindings.get(sid);
      if (!current || current.code !== code || current.playerId !== playerId) return;
      if (current.participantIndex !== null) this.arcadeApi?.stationVoiceCallEnded(sid);
      this.triviaVoiceCallBindings.delete(sid);
      this.trivia.voiceLeave(code, playerId);
    }, TRIVIA_VOICE_RECONNECT_GRACE_MS);
    leaveTimer.unref?.();
    this.triviaVoiceCallBindings.set(sid, {
      code,
      playerId,
      locale: binding?.locale ?? session.locale,
      participantIndex: binding?.participantIndex ?? null,
      activeSession: null,
      leaveTimer,
    });
  }

  private endTriviaVoiceCall(callSid: string): void {
    const sid = callSid.trim();
    const binding = this.triviaVoiceCallBindings.get(sid);
    if (!binding) return;
    if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
    if (binding.activeSession) {
      this.unregisterTriviaVoiceSession(binding.activeSession);
      binding.activeSession.handleReplaced();
    }
    this.triviaVoiceCallBindings.delete(sid);
    this.trivia.voiceLeave(binding.code, binding.playerId);
  }

  private makeFighterSession(say: (text: string, isCurrent?: () => boolean) => void): FighterVoiceSession {
    let session: FighterVoiceSession;
    session = new FighterVoiceSession({
      say,
      join: (code, name, callSid, side, expectedPlayers, nameConfirmed) => {
        code = code.trim().toUpperCase();
        const resumed = this.resumeFighterVoiceCall(code, callSid, session);
        if (resumed) return { playerId: resumed, resumed: true };
        const playerId = this.fighter.voiceJoin(code, name, side, expectedPlayers, nameConfirmed); if (!playerId) return null;
        this.rememberFighterVoiceCall(callSid, code, playerId, session); this.registerFighterVoiceSession(code, session);
        return { playerId, resumed: false };
      },
      leave: (code, id, callSid) => { this.unregisterFighterVoiceSession(session); this.scheduleFighterVoiceLeave(code, id, callSid, session); },
      setName: (code, id, name) => this.fighter.voiceSetName(code, id, name),
      selectFighter: (code, id, fighterId) => this.fighter.voiceSelectFighter(code, id, fighterId),
      selectMap: (code, id, mapId) => this.fighter.voiceSelectMap(code, id, mapId),
      advance: (code, id) => this.fighter.voiceAdvance(code, id),
      back: (code, id) => this.fighter.voiceBack(code, id),
      skipIntro: (code, id) => this.fighter.voiceSkipIntro(code, id),
      showResults: (code, id) => this.fighter.voiceShowResults(code, id),
      startNow: (code, id) => this.fighter.voiceStartNow(code, id),
      command: (code, id, command, requestId) => {
        const outcome = requestId
          ? this.fighter.voiceCommand(code, id, command, requestId)
          : this.fighter.voiceCommand(code, id, command);
        if (outcome === true || (typeof outcome === 'object' && outcome.status !== 'rejected')) {
          this.analyticsObserver.voiceCommand('fighter');
        }
        return outcome;
      },
      commandSequence: (code, id, commands, requestIds) => {
        const outcomes = this.fighter.voiceSequence(code, id, commands, requestIds);
        for (const outcome of outcomes) if (outcome.status !== 'rejected') this.analyticsObserver.voiceCommand('fighter');
        return outcomes;
      },
      interpret: (request: VoiceInterpretRequest) => interpretVoiceTurn(this.llm, request),
      snapshot: (code, id, locale) => this.fighterVoiceSnapshot(code, id, locale),
    });
    return session;
  }

  private makeKaraokeSession(
    say: (text: string, isCurrent?: () => boolean) => Promise<KaraokeSpeechOutcome>,
    requestMediaHandoff: (handoff: KaraokeVoiceEndHandoff) => void,
  ): KaraokeVoiceSession {
    let session: KaraokeVoiceSession;
    session = new KaraokeVoiceSession({
      bind: (code, name, callSid, locale, nameConfirmed) => {
        code = code.trim().toUpperCase();
        const sid = callSid.trim();
        const registeredAccountSid = this.voiceAccountSids.get(sid);
        if (!validProviderIdentity(sid) || !registeredAccountSid) return null;
        const resumed = this.resumeKaraokeVoiceCall(code, callSid, session);
        if (resumed) return { playerId: resumed, resumed: true };
        const playerId = this.karaoke.voiceJoin(code, name, 1, nameConfirmed, locale);
        if (!playerId) return null;
        this.rememberKaraokeVoiceCall(callSid, code, playerId, locale, session);
        this.registerKaraokeVoiceSession(code, session);
        return { playerId, resumed: false };
      },
      leave: (code, playerId, callSid) => {
        this.unregisterKaraokeVoiceSession(session);
        this.scheduleKaraokeVoiceLeave(code, playerId, callSid, session);
      },
      setName: (code, playerId, name) => this.karaoke.voiceSetName(code, playerId, name),
      selectSong: (code, playerId, songId) => this.karaoke.voiceSelectSong(code, playerId, songId),
      advance: (code, playerId) => this.karaoke.voiceAdvance(code, playerId),
      snapshot: (code, playerId, locale) => this.karaokeVoiceSnapshot(code, playerId, locale),
      say,
      resolveIntent: request => interpretVoiceTurn(this.llm, request),
      requestMediaHandoff,
      onSetupAction: action => this.analyticsObserver.karaokeSetupAction(action),
    });
    return session;
  }

  private karaokeVoiceSnapshot(
    code: string,
    playerId: string,
    locale: SupportedLocale = DEFAULT_LOCALE,
  ): KaraokeVoiceSnapshot | null {
    const room = this.karaoke.findRoom(code);
    const state = room?.state();
    if (!room || !state || state.singer?.playerId !== playerId) return null;
    const catalog = state.catalog.filter(song => song.locale === locale);
    return {
      phase: state.phase,
      myName: state.singer.name,
      nameConfirmed: state.singer.nameConfirmed,
      catalog: catalog.length ? catalog : state.catalog,
      selectedSong: state.selectedSong,
      selectedByPlayerId: state.selectedByPlayerId,
      selectionGeneration: state.selectionGeneration,
      loadingGeneration: state.loadingGeneration,
      displayReady: state.displayReady === true,
      score: state.score,
      bestCombo: state.bestCombo,
      result: state.result,
    };
  }

  private notifyKaraokeVoiceState(roomCode: string): void {
    for (const session of this.karaokeVoice.get(roomCode) ?? []) session.onStateChanged();
  }

  private resetCompletedKaraokeAttempt(roomCode: string, phase: string | undefined): void {
    if (phase !== 'song_select') return;
    for (const binding of this.karaokeVoiceCallBindings.values()) {
      if (binding.code !== roomCode || !binding.completed || !binding.scoreAccepted || !binding.mediaFinalized) continue;
      binding.pendingHandoff = null;
      binding.attemptId = null;
      binding.streamName = null;
      binding.streamSid = null;
      binding.mediaStarted = false;
      binding.mediaFinalized = false;
      binding.scoreAccepted = false;
      binding.completed = false;
      binding.completionRetries = 0;
      binding.lifecycle = 'setup';
    }
  }

  private registerKaraokeVoiceSession(code: string, session: KaraokeVoiceSession): void {
    let sessions = this.karaokeVoice.get(code);
    if (!sessions) {
      sessions = new Set();
      this.karaokeVoice.set(code, sessions);
    }
    sessions.add(session);
  }

  private unregisterKaraokeVoiceSession(session: KaraokeVoiceSession): void {
    for (const [code, sessions] of this.karaokeVoice) {
      if (sessions.delete(session) && sessions.size === 0) this.karaokeVoice.delete(code);
    }
  }

  private rememberKaraokeVoiceCall(
    callSid: string,
    code: string,
    playerId: string,
    locale: SupportedLocale,
    session: KaraokeVoiceSession,
  ): void {
    const sid = callSid.trim();
    if (!sid) return;
    const previous = this.karaokeVoiceCallBindings.get(sid);
    if (previous?.leaveTimer) clearTimeout(previous.leaveTimer);
    if (previous?.activeSession && previous.activeSession !== session) {
      this.unregisterKaraokeVoiceSession(previous.activeSession);
      previous.activeSession.handleReplaced();
    }
    const samePlayer = previous?.code === code && previous.playerId === playerId;
    if (previous && !samePlayer) {
      if (previous.attemptId) this.karaokeMedia.abortAttempt(previous.attemptId);
      this.karaoke.voiceLeave(previous.code, previous.playerId);
    }
    this.karaokeVoiceCallBindings.set(sid, {
      code,
      playerId,
      locale,
      accountSid: this.voiceAccountSids.get(sid) ?? '',
      activeSession: session,
      leaveTimer: null,
      pendingHandoff: samePlayer ? previous?.pendingHandoff ?? null : null,
      attemptId: samePlayer ? previous?.attemptId ?? null : null,
      streamName: samePlayer ? previous?.streamName ?? null : null,
      streamSid: samePlayer ? previous?.streamSid ?? null : null,
      lifecycle: samePlayer ? previous?.lifecycle ?? 'setup' : 'setup',
      mediaStarted: samePlayer ? previous?.mediaStarted ?? false : false,
      mediaFinalized: samePlayer ? previous?.mediaFinalized ?? false : false,
      scoreAccepted: samePlayer ? previous?.scoreAccepted ?? false : false,
      completed: samePlayer ? previous?.completed ?? false : false,
      completionRetries: samePlayer ? previous?.completionRetries ?? 0 : 0,
    });
  }

  private resumeKaraokeVoiceCall(code: string, callSid: string, session: KaraokeVoiceSession): string | null {
    const sid = callSid.trim();
    const binding = this.karaokeVoiceCallBindings.get(sid);
    if (!binding || binding.code !== code || !this.karaoke.findRoom(code)?.hasPlayer(binding.playerId)) return null;
    if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
    if (binding.activeSession && binding.activeSession !== session) {
      this.unregisterKaraokeVoiceSession(binding.activeSession);
      binding.activeSession.handleReplaced();
    }
    binding.activeSession = session;
    binding.leaveTimer = null;
    this.registerKaraokeVoiceSession(code, session);
    return binding.playerId;
  }

  private hasResumableKaraokeVoiceCall(callSid: string, code: string): boolean {
    const binding = this.karaokeVoiceCallBindings.get(callSid.trim());
    return Boolean(binding && binding.code === code && this.karaoke.findRoom(code)?.hasPlayer(binding.playerId));
  }

  private scheduleKaraokeVoiceLeave(
    code: string,
    playerId: string,
    callSid: string,
    session: KaraokeVoiceSession,
  ): void {
    const sid = callSid.trim();
    if (!sid) {
      this.karaoke.voiceLeave(code, playerId);
      return;
    }
    const binding = this.karaokeVoiceCallBindings.get(sid);
    if (!binding) {
      this.karaoke.voiceLeave(code, playerId);
      return;
    }
    if (binding?.activeSession && binding.activeSession !== session) return;
    if (binding?.leaveTimer) clearTimeout(binding.leaveTimer);
    const leaveTimer = setTimeout(() => {
      const current = this.karaokeVoiceCallBindings.get(sid);
      if (!current || current.code !== code || current.playerId !== playerId) return;
      this.clearKaraokeVoiceBinding(sid, true);
    }, KARAOKE_VOICE_RECONNECT_GRACE_MS);
    leaveTimer.unref?.();
    if (binding) {
      binding.activeSession = null;
      binding.leaveTimer = leaveTimer;
    }
  }

  private endKaraokeVoiceCall(callSid: string): void {
    const sid = callSid.trim();
    const binding = this.karaokeVoiceCallBindings.get(sid);
    if (!binding) return;
    const preserve = this.arcadeApi?.isStationEngineRoom(binding.code)
      && this.karaoke.findRoom(binding.code)?.state().phase === 'results';
    this.clearKaraokeVoiceBinding(sid, !preserve);
  }

  private clearKaraokeVoiceBinding(callSid: string, removePlayer: boolean): void {
    const binding = this.karaokeVoiceCallBindings.get(callSid);
    if (!binding) return;
    if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
    if (binding.activeSession) {
      this.unregisterKaraokeVoiceSession(binding.activeSession);
      binding.activeSession.handleReplaced();
    }
    if (binding.attemptId && !binding.mediaFinalized) this.karaokeMedia.abortAttempt(binding.attemptId);
    this.karaokeVoiceCallBindings.delete(callSid);
    this.voiceAccountSids.delete(callSid);
    if (removePlayer) this.karaoke.voiceLeave(binding.code, binding.playerId);
  }

  private requestKaraokeMediaHandoff(
    callSid: string,
    session: KaraokeVoiceSession,
    ws: WebSocket,
    handoff: KaraokeVoiceEndHandoff,
  ): void {
    const sid = callSid.trim();
    const binding = this.karaokeVoiceCallBindings.get(sid);
    const intent = parseKaraokeHandoffData(handoff.handoffData);
    const state = binding ? this.karaoke.findRoom(binding.code)?.state() : undefined;
    if (!binding || binding.activeSession !== session || binding.lifecycle !== 'setup'
      || binding.pendingHandoff || binding.attemptId
      || !intent || intent.roomCode !== binding.code || intent.playerId !== binding.playerId
      || intent.locale !== binding.locale || state?.phase !== 'loading'
      || state.selectedSong?.id !== intent.songId
      || state.loadingGeneration !== intent.loadingGeneration) return;
    binding.pendingHandoff = { ...intent, handoffData: handoff.handoffData };
    if (!sendRelayHandoff(ws, handoff)) {
      binding.pendingHandoff = null;
    } else {
      transitionKaraokeLifecycle(binding, 'handoff-pending');
      console.log(`[karaoke] media handoff requested call=${sid.slice(0, 8)} room=${binding.code} generation=${intent.loadingGeneration}`);
    }
  }

  private onKaraokeMediaStarted(attempt: KaraokeMediaAttempt, streamSid: string): void {
    const binding = this.karaokeVoiceCallBindings.get(attempt.callSid);
    if (!this.karaokeAttemptMatchesBinding(attempt, binding)) return;
    if (binding!.lifecycle !== 'media-issued' || !validProviderIdentity(streamSid)
      || (binding!.streamSid !== null && binding!.streamSid !== streamSid)) {
      this.failKaraokeCall(attempt.callSid);
      return;
    }
    binding!.streamSid = streamSid;
    binding!.mediaStarted = true;
    transitionKaraokeLifecycle(binding!, 'media-started');
    console.log(`[karaoke] media stream started call=${attempt.callSid.slice(0, 8)} room=${attempt.roomCode} generation=${attempt.loadingGeneration}`);
  }

  private onKaraokeMediaFinalized(result: KaraokeMediaFinalResult, attempt: KaraokeMediaAttempt): void {
    const binding = this.karaokeVoiceCallBindings.get(attempt.callSid);
    if (!this.karaokeAttemptMatchesBinding(attempt, binding) || binding!.attemptId !== result.attemptId) return;
    const voicedWords = result.scoring.words.filter(word => word.coverage > 0).length;
    const recognizedWords = result.scoring.words.filter(word => (word.lyricEvidence?.confidence ?? 0) > 0).length;
    const diagnostics = result.diagnostics;
    console.log(`[karaoke] score finalized call=${attempt.callSid.slice(0, 8)} room=${attempt.roomCode} score=${result.score} accepted=${result.scoreAccepted} words=${result.scoring.words.length} voicedWords=${voicedWords} recognizedWords=${recognizedWords} voicedRatio=${diagnostics.voicedRatio.toFixed(3)} pitchRatio=${diagnostics.pitchDetectionRatio.toFixed(3)} timing=${diagnostics.timingScore.toFixed(3)} lyrics=${diagnostics.lyricScore.toFixed(3)} pitch=${diagnostics.pitchScore.toFixed(3)} calibrationMs=${attempt.calibrationOffsetMs}`);
    binding!.mediaFinalized = true;
    binding!.scoreAccepted = result.scoreAccepted;
    transitionKaraokeLifecycle(binding!, 'media-finalized');
    if (!result.scoreAccepted) {
      queueMicrotask(() => {
        const current = this.karaokeVoiceCallBindings.get(attempt.callSid);
        if (this.karaokeAttemptMatchesBinding(attempt, current) && !current!.completed) {
          this.failKaraokeCall(attempt.callSid);
        }
      });
      return;
    }
    this.scheduleKaraokeCompletedCallCleanup(attempt.callSid, attempt.attemptId);
  }

  private onKaraokeMediaAborted(attempt: KaraokeMediaAttempt): void {
    const binding = this.karaokeVoiceCallBindings.get(attempt.callSid);
    if (!this.karaokeAttemptMatchesBinding(attempt, binding)) return;
    binding!.mediaFinalized = true;
    binding!.scoreAccepted = false;
    transitionKaraokeLifecycle(binding!, 'failed');
    queueMicrotask(() => {
      const current = this.karaokeVoiceCallBindings.get(attempt.callSid);
      if (this.karaokeAttemptMatchesBinding(attempt, current) && !current!.completed) {
        this.failKaraokeCall(attempt.callSid);
      }
    });
  }

  private scheduleKaraokeCompletedCallCleanup(callSid: string, attemptId: string): void {
    const binding = this.karaokeVoiceCallBindings.get(callSid);
    if (!binding || binding.attemptId !== attemptId || binding.completed) return;
    if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
    binding.leaveTimer = setTimeout(() => {
      const current = this.karaokeVoiceCallBindings.get(callSid);
      if (!current || current.attemptId !== attemptId || current.completed) return;
      if (this.karaoke.findRoom(current.code)?.state().phase === 'results') {
        this.clearKaraokeVoiceBinding(callSid, !this.arcadeApi?.isStationEngineRoom(current.code));
        this.arcadeApi?.stationVoiceCallEnded(callSid);
      } else this.failKaraokeCall(callSid);
    }, KARAOKE_VOICE_RECONNECT_GRACE_MS);
    binding.leaveTimer.unref?.();
  }

  private karaokeAttemptMatchesBinding(
    attempt: KaraokeMediaAttempt,
    binding: KaraokeVoiceCallBinding | undefined,
  ): boolean {
    return Boolean(binding
      && binding.accountSid === attempt.accountSid
      && binding.code === attempt.roomCode
      && binding.playerId === attempt.playerId
      && binding.attemptId === attempt.attemptId);
  }

  private fighterVoiceSnapshot(code: string, playerId: string, locale: SupportedLocale = DEFAULT_LOCALE): FighterVoiceSnapshot | null {
    const room = this.fighter.findRoom(code); if (!room || !room.hasPlayer(playerId)) return null;
    const state = room.state(); const me = state.players.find(player => player.playerId === playerId);
    const mySide = me?.side === 'p2' ? 'p2' : 'p1'; const foeSide = mySide === 'p1' ? 'p2' : 'p1';
    const foe = state.players.find(player => player.side === foeSide);
    const playerOne = state.players.find(player => player.side === 'p1'), playerTwo = state.players.find(player => player.side === 'p2');
    const fighterName = (id: string | null | undefined) => {
      const fighter = FIGHTER_ROSTER.find(entry => entry.id === id);
      return fighter ? localizedFighterName(locale, fighter.id, fighter.name) : null;
    };
    return { phase: state.phase, myName: room.hasConfirmedName(playerId) ? me?.name ?? null : null,
      nameConfirmed: room.hasConfirmedName(playerId), myFighterId: me?.fighterId ?? null, myFighterName: fighterName(me?.fighterId),
      foeName: foe?.name ?? null, foeFighterId: foe?.fighterId ?? null, foeFighterName: fighterName(foe?.fighterId), selectedMap: state.selectedMap,
      myMapVote:state.mapVotesByPlayerId[playerId]??null,
      allMapVotes:state.players.filter(player=>!player.isAi).every(player=>Boolean(state.mapVotesByPlayerId[player.playerId])),
      mySide, myHealth: state.world?.[mySide].health ?? null, foeHealth: state.world?.[foeSide].health ?? null,
      countdown: state.countdown, intro: state.intro, winnerName: state.result?.winnerName ?? null,
      winnerSide: state.result?.winner ?? null,
      loadingGeneration: state.loadingGeneration,
      playerOneName: playerOne?.name ?? null, playerOneFighterName: fighterName(playerOne?.fighterId),
      playerTwoName: playerTwo?.name ?? null, playerTwoFighterName: fighterName(playerTwo?.fighterId),
      playerCount: state.players.filter(player => !player.isAi).length,
      hasExpectedPlayers: state.hasExpectedPlayers,
      automaticSetup:state.automaticSetup,
      hudPresented: room.hudPresented,
      resultsPresented: room.resultsPresented,
      resultsPresentationTimedOut: room.resultsPresentationTimedOut,
      allFightersSelected: state.players.filter(player => !player.isAi).length > 0 && state.players.filter(player => !player.isAi).every(player => player.fighterId),
      isController: room.canControlSetup(playerId),
      fighters: FIGHTER_ROSTER.map(fighter => ({ id: fighter.id, name: localizedFighterName(locale, fighter.id, fighter.name) })),
      maps: this.fighterMaps.map(map => ({ id: map.id, name: localizedFighterMapName(locale, map.id, map.name) })) };
  }

  private registerFighterVoiceSession(code: string, session: FighterVoiceSession): void {
    let set = this.fighterVoice.get(code); if (!set) { set = new Set(); this.fighterVoice.set(code, set); } set.add(session);
  }

  private rememberRacerVoiceCall(
    callSid: string,
    code: string,
    playerId: string,
    adapter: ConversationRelayAdapter,
  ): void {
    const sid = callSid.trim();
    if (!sid) return;
    const prior = this.racerVoiceCallBindings.get(sid);
    if (prior?.leaveTimer) clearTimeout(prior.leaveTimer);
    if (prior?.activeAdapter && prior.activeAdapter !== adapter) prior.activeAdapter.handleClose(true);
    if (prior && (prior.code !== code || prior.playerId !== playerId)) {
      this.game.voiceLeave(prior.code, prior.playerId);
    }
    this.racerVoiceCallBindings.set(sid, {
      code, playerId, locale: adapter.locale, activeAdapter: adapter, leaveTimer: null,
    });
  }

  private resumeRacerVoiceCall(
    callSid: string,
    code: string,
    adapter: ConversationRelayAdapter,
  ): { playerId: string; lane: number; resumed: true; name:string } | null {
    const sid = callSid.trim();
    if (!this.hasResumableRacerVoiceCall(sid, code)) return null;
    const binding = this.racerVoiceCallBindings.get(sid);
    if (!binding) return null;
    const player = this.game.findRoom(code)!.lobbyPlayers()
      .find(candidate => candidate.playerId === binding.playerId)!;
    if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
    if (binding.activeAdapter && binding.activeAdapter !== adapter) binding.activeAdapter.handleClose(true);
    binding.activeAdapter = adapter;
    binding.leaveTimer = null;
    return { playerId: binding.playerId, lane: player.lane, resumed:true, name:player.name };
  }

  private hasResumableRacerVoiceCall(callSid: string, code: string): boolean {
    const binding = this.racerVoiceCallBindings.get(callSid.trim());
    return Boolean(binding && binding.code === code && this.game.findRoom(code)?.lobbyPlayers()
      .some(candidate => candidate.playerId === binding.playerId));
  }

  private scheduleRacerVoiceLeave(
    code: string,
    playerId: string,
    callSid: string,
    adapter: ConversationRelayAdapter,
  ): void {
    if(!this.game.findRoom(code))return;
    const sid = callSid.trim();
    if (!sid) { this.game.voiceLeave(code, playerId); return; }
    const binding = this.racerVoiceCallBindings.get(sid);
    if (binding?.activeAdapter && binding.activeAdapter !== adapter) return;
    if (binding?.leaveTimer) clearTimeout(binding.leaveTimer);
    const leaveTimer = setTimeout(() => {
      const current = this.racerVoiceCallBindings.get(sid);
      if (!current || current.code !== code || current.playerId !== playerId) return;
      this.racerVoiceCallBindings.delete(sid);
      this.game.voiceLeave(code, playerId);
    }, RACER_VOICE_RECONNECT_GRACE_MS);
    leaveTimer.unref?.();
    this.racerVoiceCallBindings.set(sid, {
      code, playerId, locale: binding?.locale ?? adapter.locale, activeAdapter: null, leaveTimer,
    });
  }

  private endRacerVoiceCall(callSid: string): void {
    const sid = callSid.trim();
    const binding = this.racerVoiceCallBindings.get(sid);
    if (!binding) return;
    if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
    if (binding.activeAdapter) binding.activeAdapter.handleClose(true);
    this.racerVoiceCallBindings.delete(sid);
    const preserve=this.arcadeApi?.isStationEngineRoom(binding.code)
      &&['results','finished'].includes(this.game.findRoom(binding.code)?.phase??'');
    if(!preserve)this.game.voiceLeave(binding.code, binding.playerId);
  }
  private unregisterFighterVoiceSession(session: FighterVoiceSession): void {
    for (const [code, set] of this.fighterVoice) if (set.delete(session) && set.size === 0) this.fighterVoice.delete(code);
  }
  private rememberFighterVoiceCall(callSid: string, code: string, playerId: string, session: FighterVoiceSession): void {
    const sid = callSid.trim(); if (!sid) return;
    const prior = this.fighterVoiceCallBindings.get(sid); if (prior?.leaveTimer) clearTimeout(prior.leaveTimer);
    if (prior?.activeSession && prior.activeSession !== session) { this.unregisterFighterVoiceSession(prior.activeSession); prior.activeSession.handleReplaced(); }
    if (prior && (prior.code !== code || prior.playerId !== playerId)) this.fighter.voiceLeave(prior.code, prior.playerId);
    this.fighterVoiceCallBindings.set(sid, { code, playerId, locale: session.locale, activeSession: session, leaveTimer: null });
  }
  private resumeFighterVoiceCall(code: string, callSid: string, session: FighterVoiceSession): string | null {
    const sid = callSid.trim(); if (!sid) return null;
    const binding = this.fighterVoiceCallBindings.get(sid);
    if (!binding || binding.code !== code || !this.fighter.findRoom(code)?.hasPlayer(binding.playerId)) return null;
    if (binding.leaveTimer) { clearTimeout(binding.leaveTimer); binding.leaveTimer = null; }
    if (binding.activeSession && binding.activeSession !== session) { this.unregisterFighterVoiceSession(binding.activeSession); binding.activeSession.handleReplaced(); }
    binding.activeSession = session; this.registerFighterVoiceSession(code, session); return binding.playerId;
  }
  private hasResumableFighterVoiceCall(callSid: string, code: string): boolean {
    const binding = this.fighterVoiceCallBindings.get(callSid.trim());
    return Boolean(binding && binding.code === code && this.fighter.findRoom(code)?.hasPlayer(binding.playerId));
  }
  private scheduleFighterVoiceLeave(code: string, playerId: string, callSid: string, session: FighterVoiceSession): void {
    const sid = callSid.trim(); if (!sid) { this.fighter.voiceLeave(code, playerId); return; }
    const binding = this.fighterVoiceCallBindings.get(sid);
    if (binding?.activeSession && binding.activeSession !== session) return;
    if (binding?.leaveTimer) clearTimeout(binding.leaveTimer);
    const leaveTimer = setTimeout(() => {
      const current = this.fighterVoiceCallBindings.get(sid); if (!current || current.playerId !== playerId || current.code !== code) return;
      this.fighterVoiceCallBindings.delete(sid); this.fighter.voiceLeave(code, playerId);
    }, FIGHTER_VOICE_RECONNECT_GRACE_MS);
    (leaveTimer as { unref?: () => void }).unref?.();
    this.fighterVoiceCallBindings.set(sid, { code, playerId, locale: binding?.locale ?? session.locale, activeSession: null, leaveTimer });
  }
  private endFighterVoiceCall(callSid: string): void {
    const sid = callSid.trim(), binding = this.fighterVoiceCallBindings.get(sid); if (!binding) return;
    if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
    if (binding.activeSession) { this.unregisterFighterVoiceSession(binding.activeSession); binding.activeSession.handleReplaced(); }
    this.fighterVoiceCallBindings.delete(sid);
    const preserve=this.arcadeApi?.isStationEngineRoom(binding.code)
      &&['victory','results'].includes(this.fighter.findRoom(binding.code)?.phase??'');
    if(!preserve)this.fighter.voiceLeave(binding.code, binding.playerId);
  }

  /** Build a Voice Monsters call session wired to the live BattleServer + the battle LLM host. The
   *  session registers itself in `battleVoice` on join (so it hears battle-event commentary) and
   *  unregisters on leave. */
  private makeBattleSession(say: (t: string, isCurrent?: () => boolean) => void): BattleVoiceSession {
    let session: BattleVoiceSession;   // captured so join/leave can (un)register it for events
    const deps = {
      say,
      join: (code: string, name: string, callSid: string, side?: 'a'|'b', expectedPlayers?: number, nameConfirmed?: boolean) => {
        this.battle.getOrCreateRoom(code);
        const resumed = this.resumeBattleVoiceCall(code, callSid, session);
        if (resumed) return { playerId: resumed, resumed: true };
        const id = this.battle.voiceJoin(code, name, side, expectedPlayers, nameConfirmed);
        if (id) {
          this.rememberBattleVoiceCall(callSid, code, id, session);
          this.registerBattleVoiceSession(code, session);
        }
        return id ? { playerId: id, resumed: false } : null;
      },
      leave: (code: string, id: string, callSid: string) => {
        this.unregisterBattleVoiceSession(session);
        this.scheduleBattleVoiceLeave(code, id, callSid, session);
      },
      setName: (code: string, id: string, n: string) => this.battle.voiceSetName(code, id, n),
      selectMonster: (code: string, id: string, m: string) => this.battle.voiceSelectMonster(code, id, m),
      openFight: (code: string, id: string) => this.battle.voiceOpenFight(code, id),
      backMenu: (code: string, id: string) => this.battle.voiceBackMenu(code, id),
      backSetup: (code: string, id: string) => this.battle.voiceBackSetup(code, id),
      chooseAction: (code: string, id: string, a: import('../shared/battle-world').BattleAction) => {
        const accepted = this.battle.voiceChooseAction(code, id, a);
        if (accepted) this.analyticsObserver.voiceCommand('monsters');
        return accepted;
      },
      advance: (code: string, id: string) => this.battle.voiceAdvance(code, id),
      continueResults: (code: string, id: string) => this.battle.voiceContinueResults(code, id),
      setTimer: (fn: () => void, ms: number) => { setTimeout(fn, ms); },
      snapshot: (code: string, id: string, locale?: SupportedLocale) => this.battleVoiceSnapshot(code, id, locale),
      // Legacy free-form host tools could mutate a room after its screen changed. All
      // conversational turns now use live-state proposals in `interpret` below.
      converse: async () => null,
      interpret: (request: VoiceInterpretRequest) => interpretVoiceTurn(this.llm, request),
    };
    session = new BattleVoiceSession(deps);
    return session;
  }

  private registerBattleVoiceSession(code: string, session: BattleVoiceSession): void {
    let set = this.battleVoice.get(code);
    if (!set) { set = new Set(); this.battleVoice.set(code, set); }
    set.add(session);
  }

  private unregisterBattleVoiceSession(session: BattleVoiceSession): void {
    for (const [code, set] of this.battleVoice) {
      if (set.delete(session) && set.size === 0) this.battleVoice.delete(code);
    }
  }

  private rememberBattleVoiceCall(callSid: string, code: string, playerId: string, session: BattleVoiceSession): void {
    const sid = callSid.trim();
    if (!sid) return;
    const prev = this.battleVoiceCallBindings.get(sid);
    if (prev?.leaveTimer) clearTimeout(prev.leaveTimer);
    if (prev?.activeSession && prev.activeSession !== session) {
      this.unregisterBattleVoiceSession(prev.activeSession);
      prev.activeSession.handleReplaced();
    }
    if (prev && (prev.code !== code || prev.playerId !== playerId)) this.battle.voiceLeave(prev.code, prev.playerId);
    this.battleVoiceCallBindings.set(sid, { code, playerId, locale: session.locale, activeSession: session, leaveTimer: null });
  }

  private resumeBattleVoiceCall(code: string, callSid: string, session: BattleVoiceSession): string | null {
    const sid = callSid.trim();
    if (!sid) return null;
    const binding = this.battleVoiceCallBindings.get(sid);
    if (!binding || binding.code !== code) return null;
    if (!this.battleRoomHasPlayer(code, binding.playerId)) {
      if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
      this.battleVoiceCallBindings.delete(sid);
      return null;
    }
    if (binding.leaveTimer) {
      clearTimeout(binding.leaveTimer);
      binding.leaveTimer = null;
    }
    if (binding.activeSession && binding.activeSession !== session) this.unregisterBattleVoiceSession(binding.activeSession);
    if (binding.activeSession && binding.activeSession !== session) binding.activeSession.handleReplaced();
    binding.activeSession = session;
    this.registerBattleVoiceSession(code, session);
    return binding.playerId;
  }
  private hasResumableBattleVoiceCall(callSid: string, code: string): boolean {
    const binding = this.battleVoiceCallBindings.get(callSid.trim());
    return Boolean(binding && binding.code === code && this.battleRoomHasPlayer(code, binding.playerId));
  }

  private scheduleBattleVoiceLeave(code: string, playerId: string, callSid: string, session: BattleVoiceSession): void {
    const sid = callSid.trim();
    if (!sid) { this.battle.voiceLeave(code, playerId); return; }
    const prev = this.battleVoiceCallBindings.get(sid);
    if (!prev && !this.battleRoomHasPlayer(code, playerId)) return;
    if (prev?.activeSession && prev.activeSession !== session) return;
    if (prev?.leaveTimer) clearTimeout(prev.leaveTimer);
    if (prev) prev.activeSession = null;
    const leaveTimer = setTimeout(() => {
      const binding = this.battleVoiceCallBindings.get(sid);
      if (!binding || binding.code !== code || binding.playerId !== playerId) return;
      this.battleVoiceCallBindings.delete(sid);
      this.battle.voiceLeave(code, playerId);
    }, BATTLE_VOICE_RECONNECT_GRACE_MS);
    (leaveTimer as { unref?: () => void }).unref?.();
    this.battleVoiceCallBindings.set(sid, { code, playerId, locale: prev?.locale ?? session.locale, activeSession: null, leaveTimer });
  }

  private endBattleVoiceCall(callSid: string): void {
    const sid = callSid.trim();
    if (!sid) return;
    const binding = this.battleVoiceCallBindings.get(sid);
    if (!binding) return;
    if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
    if (binding.activeSession) {
      this.unregisterBattleVoiceSession(binding.activeSession);
      binding.activeSession.handleReplaced();
    }
    this.battleVoiceCallBindings.delete(sid);
    const preserve=this.arcadeApi?.isStationEngineRoom(binding.code)
      &&this.battle.findRoom(binding.code)?.phase==='results';
    if(!preserve)this.battle.voiceLeave(binding.code, binding.playerId);
  }

  private battleRoomHasPlayer(code: string, playerId: string): boolean {
    const room = this.battle.findRoom(code);
    return !!room?.lobbyPlayers().some(p => p.playerId === playerId);
  }

  /** Deterministic selection fast-path for the conversational layer: in car/map select, if the caller
   *  CLEARLY picked one (a number or strong name, not a question), do it now + return the confirmation.
   *  Returns null when it's not a clear pick (a question, chit-chat, or wrong phase) → the LLM handles
   *  it. Makes numeric/name picks reliable regardless of the model, and works with the LLM disabled. */
  private directSelection(room:Room,playerId:string,utterance:string,locale:SupportedLocale=DEFAULT_LOCALE,
    nameLocked=false,setupReady=true):string|null {
    const text = createTranslator(locale, RACER_MESSAGES);
    const controls = text('voice.controlsIntro');
    const carChoices = this.roomConfigCache.carNames.map(name => localizedCarAliases(name).join(' '));
    const mapChoices = room.mapChoices.map(name => localizedTrackAliases(name).join(' '));
    // Internal prompts are wrapped in parentheses by the voice adapter. They are instructions to the
    // host brain, not caller commands, so they must never drive room state (for example race-over
    // recap prompts mentioning a rematch must not advance results back to car select).
    if (utterance.trim().startsWith('(')) return null;

    // NAME CAPTURE (deterministic, LLM-independent): the FIRST thing we ask is the caller's name, so in
    // the LOBBY, while they still have the auto placeholder name, treat a name-like reply as their name.
    // Late callers may answer the same prompt in selection, but an actual car/map match wins.
    const explicitName = locale === 'pt-BR'
      ? /^(?:meu nome é|meu nome e|eu sou|pode me chamar de)\b/i.test(utterance.trim())
      : /^(?:my name is|i am|i'm|im|call me|this is)\b/i.test(utterance.trim());
    const me = room.lobbyPlayers().find(p => p.playerId === playerId);
    const hasRealName = room.hasConfirmedName(playerId);
    const parsedName = !hasRealName ? parseSpokenName(utterance, locale) : null;
    const acceptingName = room.phase === 'lobby' || room.phase === 'car_select' || room.phase === 'map_select';
    const bareLateName = room.phase !== 'lobby' && acceptingName && parsedName
      && utterance.trim().split(/\s+/).length <= 2
      && clearSelectionIndex(utterance, carChoices, locale) === null
      && clearSelectionIndex(utterance, mapChoices, locale) === null;
    if (!nameLocked && acceptingName && (room.phase === 'lobby' || explicitName || bareLateName)) {
      if (!hasRealName && !isRacerAdvanceWord(utterance, locale)) {
        const name = parsedName;
        if (name) {
          this.game.voiceSetName(room.code, playerId, name);
          return room.phase === 'lobby'
            ? text('voice.niceMeetStart', { name, controls })
            : `${text('voice.niceMeet',{name})} ${controls} ${text(room.phase==='map_select'?'voice.helpMap':'voice.helpCar')}`;
        }
      }
    }
    if (room.phase === 'car_select') {
      const i = clearSelectionIndex(utterance, carChoices, locale);
      if (i !== null) {
        const correction=isRacerCorrection(utterance,locale);
        if(!room.canSelectCar(playerId,correction))return text('voice.waitingForPlayers');
        if(!this.game.voiceSelectCar(room.code,playerId,i,correction))return text('voice.repeatChoice');
        return text(room.allCarChoicesComplete?'voice.lockedCarNext':'voice.lockedCarWait',{
          car:localizedCarName(locale,room.carName(i)),
        });
      }
      // "next"/"start" advances to the track — but only once they've actually picked a car.
      if (isRacerAdvanceWord(utterance, locale)) {
        if(!setupReady)return text('voice.waitingForPlayers');
        const me = room.lobbyPlayers().find(p => p.playerId === playerId);
        if ((me?.carIndex ?? null) === null) return text('voice.pickCarFirst');
        if(!this.game.voiceAdvance(room.code,playerId))return text('voice.waitingForPlayers');
        return room.canSelectMap(playerId)?text('voice.onTrack'):text('voice.waitingForPlayers');
      }
      return null;
    }
    if (room.phase === 'map_select') {
      const current = room.lobbyPlayers().find(player => player.playerId === playerId);
      if ((current?.carIndex ?? null) === null) {
        const carIndex = clearSelectionIndex(utterance, carChoices, locale);
        if (carIndex === null) return null;
        const correction=isRacerCorrection(utterance,locale);
        if(!this.game.voiceSelectCar(room.code,playerId,carIndex,correction))return text('voice.repeatChoice');
        return `${text('voice.lockedCar', { car: localizedCarName(locale, room.carName(carIndex)) })} ${text('voice.chooseTrack')}`;
      }
      const i = clearSelectionIndex(utterance, mapChoices, locale);
      if (i === null) {
        if (!isRacerAdvanceWord(utterance, locale)) return null;
        if(!setupReady)return text('voice.waitingForPlayers');
        if(!room.hasMapVote(playerId))return text('voice.pickTrackFirst');
        return this.game.voiceAdvance(room.code,playerId)?text('voice.goRace'):text('voice.waitingForPlayers');
      }
      const correction=isRacerCorrection(utterance,locale);
      if(!room.canSelectMap(playerId,correction))return text('voice.waitingForPlayers');
      if(!this.game.voiceSelectMap(room.code,room.mapChoices[i]!,playerId,correction))return text('voice.repeatChoice');
      return text(room.allMapVotesComplete?'voice.voteTrackStart':'voice.voteTrackWait',{
        map:localizedTrackName(locale,room.mapChoices[i]!),
      });
    }
    // ADVANCE / REMATCH (deterministic, LLM-independent): "start"/"go"/"next"/"race"/"rematch" moves the
    // flow forward — this was previously LLM-only, so "start" did nothing when the model was off/slow.
    if (isRacerAdvanceWord(utterance, locale)) {
      if(!setupReady)return text('voice.waitingForPlayers');
      const me = room.lobbyPlayers().find(p => p.playerId === playerId);
      // (car_select is handled by its own branch above; reaching here means lobby/map_select/results.)
      const ok = this.game.voiceAdvance(room.code, playerId);
      if (!ok) return null;
      // room.phase is now the NEW phase we advanced INTO — describe that screen.
      const landed = String(room.phase);
      void me;
      return landed === 'car_select' ? (room.canSelectCar(playerId)?text('voice.chooseCar'):text('voice.waitingForPlayers'))
        : landed === 'map_select' ? (room.canSelectMap(playerId)?text('voice.chooseTrack'):text('voice.waitingForPlayers'))
        : landed === 'lobby' ? text(room.lobbyPlayers().length > 1 && !room.canAdvance(playerId)
          ? 'voice.waitingForPlayers' : room.hasConfirmedName(playerId) ? 'voice.helpLobbyNamed' : 'voice.helpLobby')
        : text('voice.goRace');
    }
    return null;
  }

  /** Test seam for deterministic voice routing without opening a WebSocket. */
  directSelectionForTest(room: Room, playerId: string, utterance: string, locale: SupportedLocale = DEFAULT_LOCALE): string | null {
    return this.directSelection(room, playerId, utterance, locale);
  }

  private async resolveRacerVoiceTurn(room: Room, playerId: string, utterance: string,
    locale: SupportedLocale, isCurrent: () => boolean, stationManaged: boolean,
    nameLocked: boolean, setupReady: boolean, readOnlyInquiry = false): Promise<{ text: string; phase: string } | null> {
    const phase = room.phase;
    if (['results', 'finished'].includes(phase)) {
      const direct = this.directSelection(room, playerId, utterance, locale, nameLocked, setupReady);
      if (direct) return { text: direct, phase: room.phase };
    }
    if (!this.llm.enabled) return null;
    const text = createTranslator(locale, RACER_MESSAGES);
    const me = room.lobbyPlayers().find(player => player.playerId === playerId);
    const choices: VoiceInterpretChoice[] = [];
    const actions: VoiceInterpretAction[] = [];
    const facts: VoiceInterpretFact[] = [];
    const fact = (id: string, value: string) => facts.push({ id, text: value });
    const current = () => isCurrent() && this.game.findRoom(room.code) === room && room.phase === phase;

    if (phase === 'lobby') {
      fact('screen', text('voice.helpLobby'));
      if (setupReady) actions.push({ id: 'advance', description: 'Continue from the lobby to car selection' });
    } else if (phase === 'car_select') {
      const allowed = room.canSelectCar(playerId, true);
      if (allowed) {
        this.roomConfigCache.carNames.forEach((name, index) => choices.push({
          id: String(index), label: localizedCarName(locale, name), aliases: localizedCarAliases(name),
        }));
        actions.push({ id: 'select_car', description: 'Choose or change your car shown on screen',
          targetIds: choices.map(choice => choice.id) });
      }
      if (setupReady && (me?.carIndex ?? null) !== null) {
        actions.push({ id: 'advance', description: 'Continue to track selection after choosing a car' });
      }
      fact('screen', allowed ? text('voice.helpCar') : text('voice.waitingForPlayers'));
      if ((me?.carIndex ?? null) !== null) fact('selection', locale === 'pt-BR'
        ? `Seu carro é ${localizedCarName(locale, room.carName(me!.carIndex!))}.`
        : `Your car is ${localizedCarName(locale, room.carName(me!.carIndex!))}.`);
    } else if (phase === 'map_select') {
      const allowed = room.canSelectMap(playerId, true);
      if (allowed) {
        room.mapChoices.forEach((name, index) => choices.push({
          id: String(index), label: localizedTrackName(locale, name), aliases: localizedTrackAliases(name),
        }));
        actions.push({ id: 'select_track', description: 'Vote for or change your track shown on screen',
          targetIds: choices.map(choice => choice.id) });
      }
      if (setupReady && room.hasMapVote(playerId)) {
        actions.push({ id: 'advance', description: 'Start the race after voting for a track' });
      }
      fact('screen', allowed ? text('voice.helpMap') : text('voice.waitingForPlayers'));
    } else if (phase === 'racing') {
      const commands = [
        ['MOVE_LEFT', locale === 'pt-BR' ? 'Mover ou dirigir para a esquerda' : 'Steer or move left'],
        ['MOVE_RIGHT', locale === 'pt-BR' ? 'Mover ou dirigir para a direita' : 'Steer or move right'],
        ['BOOST', locale === 'pt-BR' ? 'Acelerar ou usar impulso' : 'Accelerate or boost'],
        ['BRAKE', locale === 'pt-BR' ? 'Frear ou desacelerar' : 'Brake or slow down'],
        ['USE_POWER', locale === 'pt-BR' ? 'Usar o poder ou nitro' : 'Use power or nitro'],
      ] as const;
      for (const [id, description] of commands) actions.push({ id, description });
      fact('screen', text('voice.help'));
      facts.push(...this.racerLiveFacts(room, playerId, locale));
    } else if (phase === 'results' || phase === 'finished') {
      const context = this.hostContext(room, playerId, locale, stationManaged, current);
      context.stationManaged = stationManaged;
      fact('results', this.racerResultsRecap(context, locale));
      if (!stationManaged) actions.push({ id: 'advance', description: 'Start a rematch or race again' });
    } else {
      fact('screen', text('voice.help'));
    }

    const resolution = await interpretVoiceTurn(this.llm, {
      game: 'racer', phase, locale, transcript: utterance,
      actions: readOnlyInquiry ? [] : actions, choices, facts,
    });
    if (!current()) return null;
    if (resolution.kind === 'answer') {
      // Position and charges change every tick. Refresh those facts after the
      // interpreter returns so the caller hears the current race, not a stale snapshot.
      const answer = (phase === 'racing'
        ? [...facts.filter(candidate => candidate.id === 'screen'),
          ...this.racerLiveFacts(room, playerId, locale)] : facts)
        .find(candidate => candidate.id === resolution.factId);
      return answer ? { text: answer.text, phase } : null;
    }
    if (readOnlyInquiry) return { text: phase === 'racing' ? text('voice.help') : facts[0]?.text ?? text('voice.help'), phase };
    if (resolution.kind === 'clarify') {
      const clarification = phase === 'car_select'
        ? locale === 'pt-BR' ? 'Qual carro na tela você quer?' : 'Which car on screen do you want?'
        : phase === 'map_select'
          ? locale === 'pt-BR' ? 'Qual pista na tela você quer?' : 'Which track on screen do you want?'
          : locale === 'pt-BR' ? 'Pode dizer de outro jeito?' : 'Could you say that another way?';
      return { text: clarification, phase };
    }
    if (resolution.kind !== 'action') return null;
    if (resolution.actionId === 'select_car' && phase === 'car_select') {
      const index = Number(resolution.targetId);
      if (!Number.isInteger(index) || index < 0 || index >= this.roomConfigCache.carNames.length) return null;
      const revision = (me?.carIndex ?? null) !== null;
      if (!this.game.voiceSelectCar(room.code, playerId, index, revision)) return null;
      return { text: text(room.allCarChoicesComplete ? 'voice.lockedCarNext' : 'voice.lockedCarWait',
        { car: localizedCarName(locale, room.carName(index)) }), phase: room.phase };
    }
    if (resolution.actionId === 'select_track' && phase === 'map_select') {
      const index = Number(resolution.targetId);
      if (!Number.isInteger(index) || index < 0 || index >= room.mapChoices.length) return null;
      const revision = room.hasMapVote(playerId);
      if (!this.game.voiceSelectMap(room.code, room.mapChoices[index]!, playerId, revision)) return null;
      return { text: text(room.allMapVotesComplete ? 'voice.voteTrackStart' : 'voice.voteTrackWait',
        { map: localizedTrackName(locale, room.mapChoices[index]!) }), phase: room.phase };
    }
    if (resolution.actionId === 'advance') {
      const canonical = phase === 'results' || phase === 'finished'
        ? locale === 'pt-BR' ? 'revanche' : 'rematch'
        : locale === 'pt-BR' ? 'vamos começar' : 'next';
      const reply = this.directSelection(room, playerId, canonical, locale, nameLocked, setupReady);
      return reply ? { text: reply, phase: room.phase } : null;
    }
    const controls: Record<string, import('../shared/types').Intent> = {
      MOVE_LEFT: 'MOVE_LEFT', MOVE_RIGHT: 'MOVE_RIGHT', BOOST: 'BOOST',
      BRAKE: 'BRAKE', USE_POWER: 'USE_POWER',
    };
    const command = controls[resolution.actionId];
    if (phase === 'racing' && command && room.applyIntent(playerId, command)) {
      this.analyticsObserver.voiceCommand('racer');
      const acknowledgements: Record<string, [string, string]> = {
        MOVE_LEFT: ['Left.', 'Esquerda.'], MOVE_RIGHT: ['Right.', 'Direita.'],
        BOOST: ['Boost.', 'Acelerando.'], BRAKE: ['Braking.', 'Freando.'],
        USE_POWER: ['Power used.', 'Poder usado.'],
      };
      return { text: acknowledgements[command]![locale === 'pt-BR' ? 1 : 0], phase };
    }
    return null;
  }

  /** Build the AI host's view of a live room for one caller: what it can see + the actions it can take
   *  (pick a car/map by fuzzy name, start the race). Actions delegate to the same Room methods + the
   *  game-server broadcast, so a voice-driven pick shows up on the screen exactly like a texted one. */
  private hostContext(room: Room, playerId: string, locale: SupportedLocale = DEFAULT_LOCALE,
    nameLocked=false, isCurrent: () => boolean = () => true): HostContext {
    const text = createTranslator(locale, RACER_MESSAGES);
    const controls = text('voice.controlsIntro');
    const canonicalCars = this.roomConfigCache.carNames;
    const canonicalMaps = room.mapChoices;
    const capturedPhase = room.phase;
    const cars = canonicalCars.map(name => localizedCarName(locale, name));
    const maps = canonicalMaps.map(name => localizedTrackName(locale, name));
    const carChoices = canonicalCars.map(name => localizedCarAliases(name).join(' '));
    const mapChoices = canonicalMaps.map(name => localizedTrackAliases(name).join(' '));
    const me = room.lobbyPlayers().find(p => p.playerId === playerId);
    const myCarIdx = me?.carIndex ?? null;
    // Confirmation is authoritative; a selected name may itself contain the word "Racer".
    const rawName = me?.name ?? '';
    const realName = room.hasConfirmedName(playerId) || nameLocked ? rawName || null : null;
    const myResult = room.results().find(r => r.playerId === playerId) ?? null;
    const board = this.leaderboardSummaryForMap(room, playerId);
    return {
      phase: room.phase as HostContext['phase'],
      cars, maps, selectedMap: room.selectedMap ? localizedTrackName(locale, room.selectedMap) : null,
      myName: realName,
      myCar: myCarIdx !== null ? localizedCarName(locale, room.carName(myCarIdx)) : null,
      myPlace: myResult?.place ?? null,
      myFinishTime: myResult && myResult.finished && myResult.finishT > 0 ? myResult.finishT : null,
      myCurrentTrackRank: board.currentRunRank,
      currentTrackRankedRunCount: board.rankedRunCount,
      racerCount: room.playerCount,
      nameLocked,
      stationManaged:nameLocked,
      raceStandings: room.results().map(r => ({ name: r.name, place: r.place, time: r.finished && r.finishT > 0 ? r.finishT : null, finished: r.finished })),
      leaderboardTop: board.top,
      allTimeTop: board.topNames,
      allTimeBest: board.bestName !== null && board.bestTime !== null
        ? { name: board.bestName, time: board.bestTime } : null,
      setName: (name) => {
        if(nameLocked || !isCurrent())return null;
        const clean = name.trim().slice(0, 20);
        if (!clean) return null;
        this.game.voiceSetName(room.code, playerId, clean);
        // Always chain into the NEXT step so a bare tool call never leaves dead air (the "it just said
        // 'nice to meet you' and stopped" issue). In the lobby, point them at getting into the race.
        return room.phase === 'lobby'
          ? text('voice.niceMeetOthers', { name: clean, controls })
          : text('voice.niceMeet', { name: clean });
      },
      selectCarByName: (name) => {
        if (!isCurrent()) return null;
        const i = matchChoice(name, carChoices, locale);
        // No match → the model likely invented a name; DON'T act, and tell it (so it re-asks with the
        // real list) rather than confirming a car that doesn't exist.
        if (i < 0) return null;
        if (room.phase !== 'car_select') return null;
        this.game.voiceSelectCar(room.code, playerId, i);
        // Confirm using the ACTUAL matched car name — never the caller's/model's raw words.
        return text('voice.lockedCar', { car: localizedCarName(locale, room.carName(i)) });
      },
      selectMapByName: (name) => {
        if (!isCurrent()) return null;
        const i = matchChoice(name, mapChoices, locale);
        if (i < 0) return null;   // invented/unknown track → do nothing (no hallucinated confirmation)
        if (room.phase !== 'map_select') return null;
        this.game.voiceSelectMap(room.code, room.mapChoices[i]!, playerId);   // vote
        return text('voice.voteTrack', { map: localizedTrackName(locale, room.mapChoices[i]!) });
      },
      startRace: () => {
        if (!isCurrent() || room.phase !== capturedPhase) return null;
        // Guard against SKIPPING a step: don't leave car_select until THIS caller has actually picked
        // a car (the "it jumped to track select while I was still choosing" bug). The LLM is also told
        // this in the prompt; this is the hard backstop.
        const meNow = room.lobbyPlayers().find(p => p.playerId === playerId);
        if (room.phase === 'car_select' && (meNow?.carIndex ?? null) === null) {
          return text('voice.pickCarFirst');
        }
        const ok = this.game.voiceAdvance(room.code, playerId);
        if(!ok)return null;
        return room.phase==='car_select'?text('voice.chooseCar')
          :room.phase==='map_select'?text('voice.onTrack')
          :text('voice.goRace');
      },
    };
  }

  private leaderboardSummaryForMap(room: Room, currentPlayerId: string): { top: { name: string; time: number }[]; topNames: string[]; bestName: string | null; bestTime: number | null; currentRunRank: number | null; rankedRunCount: number } {
    const map=room.selectedMap,currentResults=room.results();
    if (!map) return { top: [], topNames: [], bestName: null, bestTime: null, currentRunRank:null, rankedRunCount:0 };
    const currentEntries: LeaderboardEntry[] = currentResults
      .filter(r => r.finished && r.finishT > 0)
      .map(r => ({name:r.name,map,carIndex:r.carIndex,finishT:r.finishT,at:Number.MAX_SAFE_INTEGER,
        enginePlayerId:`${room.code}:${this.arcadeApi?.canonicalStationEnginePlayerId?.(r.playerId)??r.playerId}`}));
    const duplicateRemoved=new Set<string>();
    const historical=this.leaderboardEntriesCache.filter(entry=>{
      const current=currentEntries.find(candidate=>candidate.enginePlayerId===entry.enginePlayerId&&Math.abs(candidate.finishT-entry.finishT)<0.001);
      if(!current||!entry.enginePlayerId||duplicateRemoved.has(entry.enginePlayerId))return true;
      duplicateRemoved.add(entry.enginePlayerId);return false;
    });
    const ranked=[...currentEntries,...historical].slice(0,MAX_LEADERBOARD_HISTORY)
      .filter(entry=>entry.map===map)
      .sort((left,right)=>left.finishT-right.finishT||right.at-left.at);
    const top=ranked.slice(0,5);
    const myCanonicalId=`${room.code}:${this.arcadeApi?.canonicalStationEnginePlayerId?.(currentPlayerId)??currentPlayerId}`;
    const currentRun=ranked.find(entry=>entry.enginePlayerId===myCanonicalId&&entry.at===Number.MAX_SAFE_INTEGER);
    const currentRunRank=currentRun?ranked.indexOf(currentRun)+1:null;
    return {
      top: top.map(e => ({ name: e.name, time: e.finishT })),
      topNames: top.map(e => e.name),
      bestName: top[0]?.name ?? null,
      bestTime: top[0]?.finishT ?? null,
      currentRunRank,
      rankedRunCount:ranked.length,
    };
  }

  private racerResultsRecap(context:HostContext,locale:SupportedLocale):string{
    const rank=context.myCurrentTrackRank,count=context.currentTrackRankedRunCount??0;
    const time=(seconds:number)=>locale==='pt-BR'?seconds.toFixed(2).replace('.',','):seconds.toFixed(2);
    if(locale==='pt-BR'){
      const race=context.myPlace?(context.myFinishTime
        ?`${context.myPlace===1?'Você venceu em 1º lugar':`Você ficou em ${ordinal(context.myPlace,locale)}`} com ${time(context.myFinishTime)} segundos.`
        :`Você ficou em ${ordinal(context.myPlace,locale)} sem concluir a corrida.`):'A corrida terminou.';
      const board=rank&&count?`Você está em ${ordinal(rank,locale)} de ${count} na classificação.`
        :context.allTimeBest?`${context.allTimeBest.name} lidera a classificação com ${time(context.allTimeBest.time)} segundos.`
          :'A classificação está na tela.';
      return `${race} ${board}${context.stationManaged
        ? ' Para correr novamente, veja nas mensagens as instruções sobre moedas.'
        : ' Quer correr de novo?'}`;
    }
    const race=context.myPlace?(context.myFinishTime
      ?`${context.myPlace===1?'You won first place':`You placed ${ordinal(context.myPlace,locale)}`} in ${time(context.myFinishTime)} seconds.`
      :`You placed ${ordinal(context.myPlace,locale)} without finishing.`):'The race is complete.';
    const board=rank&&count?`You rank ${ordinal(rank,locale)} of ${count} on the leaderboard.`
      :context.allTimeBest?`${context.allTimeBest.name} leads the leaderboard at ${time(context.allTimeBest.time)} seconds.`
        :'The leaderboard is on the display.';
    return `${race} ${board}${context.stationManaged
      ? ' For another race, check your messages for game coin instructions.'
      : ' Want another race?'}`;
  }

  private racerLiveFacts(room: Room, playerId: string, locale: SupportedLocale): VoiceInterpretFact[] {
    const snapshot = room.snapshot();
    const me = snapshot?.cars.find(car => car.id === playerId);
    if (!snapshot || !me) return [];
    const leader = snapshot.cars.find(car => car.place === 1);
    const lap = Math.min(LAP_TARGET, Math.max(1, me.lap));
    const count = snapshot.cars.length;
    if (locale === 'pt-BR') return [
      { id: 'position', text: `Você está em ${ordinal(me.place, locale)} de ${count} na corrida.` },
      { id: 'leader', text: leader?.id === playerId ? 'Você está liderando a corrida.'
        : leader ? `${leader.name} está liderando a corrida.` : 'Ainda não há líder definido.' },
      { id: 'lap', text: `Você está na volta ${lap} de ${LAP_TARGET}.` },
      { id: 'nitro', text: me.powerActive > 0 ? 'Seu nitro está ativo agora.'
        : `Você tem ${me.power} ${me.power === 1 ? 'carga' : 'cargas'} de nitro.` },
    ];
    return [
      { id: 'position', text: `You are ${ordinal(me.place, locale)} of ${count} in the race.` },
      { id: 'leader', text: leader?.id === playerId ? 'You are leading the race.'
        : leader ? `${leader.name} is leading the race.` : 'There is no race leader yet.' },
      { id: 'lap', text: `You are on lap ${lap} of ${LAP_TARGET}.` },
      { id: 'nitro', text: me.powerActive > 0 ? 'Your nitro is active now.'
        : `You have ${me.power} nitro ${me.power === 1 ? 'charge' : 'charges'}.` },
    ];
  }

  /** Test seam for verifying voice host context. */
  hostContextForTest(room: Room, playerId: string, locale: SupportedLocale = DEFAULT_LOCALE,
    isCurrent: () => boolean = () => true): HostContext {
    return this.hostContext(room, playerId, locale, false, isCurrent);
  }

  // ── Voice Monsters voice helpers: flatten a battle room for one caller ────────────────────────────
  /** Which side (a/b) the caller's playerId is, or null (spectator / not in this battle). */
  private battleSideOf(room: import('./battle-room').BattleRoom, playerId: string): 'a' | 'b' | null {
    const snap = room.snapshot();
    if (!snap) return room.playerSide(playerId);
    if (snap.a.id === playerId) return 'a';
    if (snap.b.id === playerId) return 'b';
    return null;
  }

  /** Flatten a battle room into the voice session's snapshot (for deterministic routing). */
  private battleVoiceSnapshot(code: string, playerId: string, locale: SupportedLocale = DEFAULT_LOCALE): BattleVoiceSnapshot | null {
    const room = this.battle.findRoom(code);
    if (!room) return null;
    const monsterNames = rosterEntries().map(monster => localizedMonsterName(locale, monster.id));
    const players = room.lobbyPlayers();
    const player = players.find(p => p.playerId === playerId);
    const canStartBattle = room.canStart();
    const rawName = player?.name ?? '';
    const myName = room.hasConfirmedName(playerId) ? rawName || null : null;
    const snap = room.snapshot();
    const res = room.result();
    const battleSide = this.battleSideOf(room, playerId);
    const side = battleSide ?? 'a';
    if (!snap || !battleSide) {
      const mon = player?.monsterId ? monsterById(player.monsterId) : null;
      return {
        phase: room.phase, mySide: side, monsterNames, myName,
        generation: room.generation, presentationPending: this.battle.hasPendingPresentation(code),
        resultsPresented: room.resultsPresented,
        resultsPresentationTimedOut: room.resultsPresentationTimedOut,
        myMonsterId: player?.monsterId ?? null,
        myMonsterName: mon ? localizedMonsterName(locale, mon.id) : null,
        myMonsterType: mon?.type ?? null,
        canAdvanceLobby:room.canAdvanceLobby,
        canStartBattle,
        canRematch: room.canRematch,
        foeName: null, foeMonsterName: null, foeMonsterType: null, myHp: null, myMaxHp: null, foeHp: null, foeMaxHp: null,
        myPotions: 2, myGuarding: false, myTaunted: false, foeGuarding: false, foeTaunted: false,
        turn: null, activeSide: null, activeMenu: 'root', whoseTurn: null, participating: false, myMoves: [], winnerName: res?.winnerName ?? null,
      };
    }
    const me = side === 'a' ? snap.a : snap.b;
    const foe = side === 'a' ? snap.b : snap.a;
    const activeSide = room.activeSide();
    return {
      phase: room.phase, mySide: side, monsterNames, myName,
      generation: room.generation, presentationPending: this.battle.hasPendingPresentation(code),
      resultsPresented: room.resultsPresented,
      resultsPresentationTimedOut: room.resultsPresentationTimedOut,
      myMonsterId: me.monsterId, myMonsterName: localizedMonsterName(locale, me.monsterId),
      myMonsterType: me.type,
      canAdvanceLobby:room.canAdvanceLobby,
      canStartBattle,
      canRematch: room.canRematch,
      foeName: foe.name,
      foeMonsterName: localizedMonsterName(locale, foe.monsterId),
      foeMonsterType: foe.type,
      myHp: me.hp, myMaxHp: me.maxHp, foeHp: foe.hp, foeMaxHp: foe.maxHp,
      myPotions: side === 'a' ? snap.potions.a : snap.potions.b,
      myGuarding: me.guarding, myTaunted: me.taunted,
      foeGuarding: foe.guarding, foeTaunted: foe.taunted,
      turn: snap.turn,
      activeSide,
      participating: true,
      activeMenu: room.activeMenu(),
      whoseTurn: room.phase === 'battle' && activeSide ? (activeSide === side ? 'me' : 'foe') : null,
      myMoves: me.moves.map(move => ({ id: move.id, name: localizedMoveName(locale, move.id) })),
      winnerName: res?.winnerName ?? null,
    };
  }

  /** Build the battle LLM host's context for one caller (delegating actions to the BattleServer). */
  private battleHostContext(code: string, playerId: string, isCurrent: () => boolean = () => true,
    locale: SupportedLocale = DEFAULT_LOCALE,nameLocked=false,stationManaged=false,authoritativeName:string|null=null): BattleHostContext | null {
    const room = this.battle.findRoom(code);
    if (!room) return null;
    const s = this.battleVoiceSnapshot(code, playerId, locale);
    if (!s) return null;
    const text = createTranslator(locale, MONSTERS_MESSAGES);
    return {
      phase: s.phase, monsters: s.monsterNames, myName: authoritativeName??s.myName,
      myMonster: s.myMonsterName, foeMonster: s.foeMonsterName,
      myHp: s.myHp, myMaxHp: s.myMaxHp, foeHp: s.foeHp, foeMaxHp: s.foeMaxHp,
      myPotions: s.myPotions, myGuarding: s.myGuarding, myTaunted: s.myTaunted,
      foeGuarding: s.foeGuarding, foeTaunted: s.foeTaunted,
      whoseTurn: s.whoseTurn, moves: s.myMoves.map(m => m.name),
      winnerName: s.winnerName,
      nameLocked,
      stationManaged,
      setName: (name) => {
        if(nameLocked)return null;
        if (!isCurrent() || (room.phase !== 'lobby' && room.phase !== 'monster_select')) return null;
        const c = name.trim().slice(0, 20); if (!c) return null;
        this.battle.voiceSetName(code, playerId, c); return text('voice.niceMeet', { name: c });
      },
      selectMonster: (name) => {
        if (!isCurrent()) return null;
        const i = matchChoice(name, s.monsterNames, locale);
        if (i < 0 || room.phase !== 'monster_select') return null;
        const id = rosterEntries()[i]!.id;
        this.battle.voiceSelectMonster(code, playerId, id);
        return text('voice.lockedMonster', { name: s.monsterNames[i]! });
      },
      chooseAction: (action) => {
        // Gate on the caller's TURN, not just the phase: after the caller acts, the room may still be
        // in battle while the other side/AI is active. Do not let the LLM act out of turn.
        if (!isCurrent()) return null;
        const current = this.battleVoiceSnapshot(code, playerId, locale);
        if (room.phase !== 'battle' || current?.whoseTurn !== 'me' || current.turn !== s.turn) return null;
        const parsed = this.parseVoiceHostAction(action, current.myMoves);
        if (!parsed) return null;
        if (this.battle.voiceChooseAction(code, playerId, parsed)) this.analyticsObserver.voiceCommand('monsters');
        return null;   // the model's own words carry the reply; avoid double-speak
      },
      advance: () => {
        if (!isCurrent() || room.phase !== s.phase) return null;
        this.battle.voiceAdvance(code, playerId); return null;
      },
    };
  }

  /** Parse the LLM's `choose_action` string ('guard'|'item'|'taunt'|'fight:<move>') into a BattleAction. */
  private parseVoiceHostAction(action: string, moves: { id: string; name: string }[]): import('../shared/battle-world').BattleAction | null {
    const a = action.trim().toLowerCase();
    if (a === 'guard') return { kind: 'guard' };
    if (a === 'item' || a === 'potion') return { kind: 'item', item: 'potion' };
    if (a === 'taunt') return { kind: 'taunt' };
    if (/^(?:attack|fight)\b/i.test(a)) {
      const moveName = action.split(':').slice(1).join(':').trim() || action.replace(/^(?:attack|fight)\s*/i, '').trim();
      const i = matchChoice(moveName, moves.map(m => m.name));
      if (i >= 0) return { kind: 'fight', moveId: moves[i]!.id };
    }
    return null;
  }

  private validatePrimaryTwilioForm(
    signature: string | undefined,
    url: string,
    params: Record<string, string>,
  ): boolean {
    return Boolean(this.authToken) && validateTwilioSignature({
      authToken: this.authToken!, signature, url, params,
    });
  }

  private validateTwilioVoiceForm(
    signature: string | undefined,
    url: string,
    params: Record<string, string>,
  ): boolean {
    return this.authTokens.some(authToken => validateTwilioSignature({
      authToken, signature, url, params,
    }));
  }

  private validatePrimaryTwilioBody(signature: string | undefined, url: string, rawBody: string): boolean {
    if (!signature || !this.authToken) return false;
    if (url.includes('bodySHA256=')) {
      return twilio.validateRequestWithBody(this.authToken, signature, url, rawBody);
    }
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(rawBody || '{}') as Record<string, unknown>; }
    catch { return false; }
    return twilio.validateRequest(this.authToken, signature, url, payload);
  }

  private karaokeHandoffTwiML(params: Record<string, string>): string | null {
    const handoffData = params['HandoffData'] ?? params['handoffData'] ?? '';
    if (!isKaraokeHandoffData(handoffData)) return null;
    const intent = parseKaraokeHandoffData(handoffData);
    const callSid = (params['CallSid'] ?? params['callSid'] ?? '').trim();
    const accountSid = (params['AccountSid'] ?? params['accountSid'] ?? '').trim();
    const responseKey = karaokeHandoffResponseKey(params);
    this.reapKaraokeHandoffResponses();
    const cachedResponse = this.karaokeHandoffResponses.get(responseKey);
    if (cachedResponse && params['CallStatus']?.trim().toLowerCase() === 'in-progress') {
      return cachedResponse.xml;
    }
    const binding = this.karaokeVoiceCallBindings.get(callSid);
    const locale = binding?.locale ?? intent?.locale ?? this.defaultLocale;
    const pending = binding?.pendingHandoff;
    const state = binding ? this.karaoke.findRoom(binding.code)?.state() : undefined;
    const valid = params['CallStatus']?.trim().toLowerCase() === 'in-progress'
      && validProviderIdentity(accountSid)
      && Boolean(intent && binding && pending)
      && binding?.accountSid === accountSid
      && binding?.lifecycle === 'handoff-pending'
      && pending?.handoffData === handoffData
      && intent?.roomCode === binding?.code
      && intent?.playerId === binding?.playerId
      && intent?.songId === pending?.songId
      && intent?.loadingGeneration === pending?.loadingGeneration
      && intent?.locale === binding?.locale
      && state?.phase === 'loading'
      && state.singer?.playerId === intent?.playerId
      && state.selectedSong?.id === intent?.songId
      && state.loadingGeneration === intent?.loadingGeneration
      && !binding?.attemptId;
    if (!valid || !intent || !binding) {
      if (binding && pending?.handoffData === handoffData && !binding.attemptId) this.failKaraokeCall(callSid);
      return this.karaokeFailureTwiML(locale);
    }

    try {
      const attempt = this.karaokeMedia.issueAttempt({
        accountSid,
        callSid,
        roomCode: intent.roomCode,
        playerId: intent.playerId,
        songId: intent.songId,
        loadingGeneration: intent.loadingGeneration,
        songStartTimestampMs: KARAOKE_COUNTDOWN_MS,
        calibrationOffsetMs: this.karaokeCalibrationOffsetMs,
      });
      const streamName = `karaoke-${attempt.attemptId}`;
      console.log(`[karaoke] media attempt issued call=${callSid.slice(0, 8)} room=${intent.roomCode} generation=${intent.loadingGeneration}`);
      const xml = twimlKaraokeMedia({
        streamName,
        wsUrl: `${this.publicBaseUrl.replace(/^https?/, 'wss')}/karaoke-media`,
        statusCallbackUrl: `${this.publicBaseUrl}/voice/karaoke/stream-status`,
        completeUrl: `${this.publicBaseUrl}/voice/karaoke/complete`,
        customParameters: attempt.customParameters,
        pauseLengthSeconds: KARAOKE_MEDIA_PAUSE_SECONDS,
      });
      binding.pendingHandoff = null;
      binding.attemptId = attempt.attemptId;
      binding.streamName = streamName;
      binding.streamSid = null;
      binding.mediaStarted = false;
      binding.mediaFinalized = false;
      binding.scoreAccepted = false;
      binding.completed = false;
      binding.completionRetries = 0;
      transitionKaraokeLifecycle(binding, 'media-issued');
      this.karaokeHandoffResponses.set(responseKey, {
        xml,
        expiresAtMs: Date.now() + KARAOKE_HANDOFF_RESPONSE_RETENTION_MS,
      });
      while (this.karaokeHandoffResponses.size > KARAOKE_MAX_HANDOFF_RESPONSES) {
        const oldest = this.karaokeHandoffResponses.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        this.karaokeHandoffResponses.delete(oldest);
      }
      return xml;
    } catch {
      this.failKaraokeCall(callSid);
      return this.karaokeFailureTwiML(locale);
    }
  }

  private completeKaraokeTwiML(params: Record<string, string>): string {
    const callSid = (params['CallSid'] ?? params['callSid'] ?? '').trim();
    const accountSid = (params['AccountSid'] ?? params['accountSid'] ?? '').trim();
    const binding = this.karaokeVoiceCallBindings.get(callSid);
    const locale = binding?.locale ?? this.karaokeFailureLocales.get(callSid)?.locale ?? this.defaultLocale;
    if (!binding || !binding.attemptId || !validProviderIdentity(accountSid)
      || binding.accountSid !== accountSid) {
      if (binding) this.failKaraokeCall(callSid);
      return this.karaokeFailureTwiML(locale);
    }
    const existingState = this.karaoke.findRoom(binding.code)?.state();
    if (binding.completed && existingState?.result?.playerId === binding.playerId) {
      return this.karaokeResultRelayTwiML(callSid, binding);
    }
    if (binding.leaveTimer) {
      clearTimeout(binding.leaveTimer);
      binding.leaveTimer = null;
    }
    const mediaResult = this.karaokeMedia.finalizedResult(binding.attemptId);
    if (!mediaResult) {
      const attemptState = this.karaokeMedia.attemptState(binding.attemptId);
      if ((attemptState === 'pending' || attemptState === 'finalizing')
        && binding.completionRetries < KARAOKE_MAX_COMPLETION_RETRIES) {
        binding.completionRetries += 1;
        return this.karaokeCompletionRetryTwiML();
      }
      this.failKaraokeCall(callSid);
      return this.karaokeFailureTwiML(locale);
    }
    const state = this.karaoke.findRoom(binding.code)?.state();
    if (!mediaResult?.scoreAccepted || !binding.scoreAccepted || state?.phase !== 'results'
      || state.result?.playerId !== binding.playerId
      || state.result.generation !== state.loadingGeneration) {
      this.failKaraokeCall(callSid);
      return this.karaokeFailureTwiML(locale);
    }
    binding.mediaFinalized = true;
    binding.scoreAccepted = true;
    binding.completed = true;
    transitionKaraokeLifecycle(binding, 'completed');
    if (binding.leaveTimer) {
      clearTimeout(binding.leaveTimer);
      binding.leaveTimer = null;
    }
    this.voiceReconnectAttempts.set(callSid, 0);
    return this.karaokeResultRelayTwiML(callSid, binding);
  }

  private karaokeCompletionRetryTwiML(): string {
    const completeUrl = `${this.publicBaseUrl}/voice/karaoke/complete`
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="${KARAOKE_COMPLETION_RETRY_SECONDS}" />
  <Redirect method="POST">${completeUrl}</Redirect>
</Response>`;
  }

  private reapKaraokeHandoffResponses(): void {
    const now = Date.now();
    for (const [key, response] of this.karaokeHandoffResponses) {
      if (now >= response.expiresAtMs) this.karaokeHandoffResponses.delete(key);
    }
  }

  private karaokeResultRelayTwiML(callSid: string, binding: KaraokeVoiceCallBinding): string {
    const station = this.stationVoiceReconnectRoutes.get(callSid);
    return twimlConnectRelay({
      wsUrl: `${this.publicBaseUrl.replace(/^http/, 'ws')}/voice`,
      sessionEndedUrl: `${this.publicBaseUrl}/voice/session-ended`,
      roomCode: binding.code,
      ttsProvider: 'ElevenLabs',
      voice: binding.locale === 'pt-BR' ? this.crVoicePtBr : this.crVoice,
      game: 'karaoke',
      karaokeMode: 'result',
      readyEntryId: station?.readyEntryId,
      matchId: station?.matchId,
      launchGeneration: station?.launchGeneration,
      relayToken: this.voiceRelayToken || undefined,
      locale: binding.locale,
      hints: this.voiceHints('karaoke', binding.locale),
      welcomeGreeting: '',
    });
  }

  private karaokeFailureTwiML(locale: SupportedLocale): string {
    return twimlSayAndHangup(locale === 'pt-BR'
      ? 'Não foi possível iniciar o áudio do Karaokê por Voz. Tente novamente ou peça ajuda à equipe.'
      : 'Voice Karaoke could not start the audio stream. Please try again or ask booth staff for help.', locale);
  }

  private failKaraokeCall(callSid: string): void {
    const binding = this.karaokeVoiceCallBindings.get(callSid);
    if (!binding) return;
    transitionKaraokeLifecycle(binding, 'failed');
    const previousFailure = this.karaokeFailureLocales.get(callSid);
    if (previousFailure) clearTimeout(previousFailure.timer);
    const failureTimer = setTimeout(() => this.karaokeFailureLocales.delete(callSid), KARAOKE_FAILURE_LOCALE_RETENTION_MS);
    failureTimer.unref?.();
    this.karaokeFailureLocales.set(callSid, { locale: binding.locale, timer: failureTimer });
    if (binding.attemptId) this.karaokeMedia.abortAttempt(binding.attemptId);
    if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
    if (binding.activeSession) {
      this.unregisterKaraokeVoiceSession(binding.activeSession);
      binding.activeSession.handleReplaced();
    }
    const state = this.karaoke.findRoom(binding.code)?.state();
    if (state?.phase !== 'results' && this.arcadeApi?.isStationEngineRoom(binding.code)) {
      this.arcadeApi.stationEngineAbandoned('karaoke', binding.code);
    }
    this.activeStationEngines.delete(`karaoke:${binding.code}`);
    this.karaokeVoiceCallBindings.delete(callSid);
    this.voiceAccountSids.delete(callSid);
    this.stationVoiceReconnectRoutes.delete(callSid);
    this.voiceReconnectAttempts.delete(callSid);
    this.arcadeApi?.stationVoiceCallEnded(callSid);
    this.analyticsObserver.karaokeAborted(binding.code);
    this.karaoke.abortRoom(binding.code);
  }

  private handleKaraokeLoadingTimeout(roomCode: string): void {
    for (const [callSid, binding] of this.karaokeVoiceCallBindings) {
      if (binding.code !== roomCode || binding.completed) continue;
      if (binding.lifecycle === 'setup' && binding.activeSession) {
        binding.activeSession.announceLoadingTimeout();
      } else {
        this.failKaraokeCall(callSid);
      }
    }
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? '';
    // Process liveness stays independent from repairable Twilio/configuration dependencies.
    if (req.method === 'GET' && path === '/livez') {
      res.writeHead(200, {
        'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
      });
      res.end('{"status":"alive"}');
      return;
    }
    // Dependency-aware health is used by rollout smoke and operational monitoring.
    if (req.method === 'GET' && path === '/healthz') {
      const arcadeHealth = this.arcadeApi?.getHealthStatus();
      const triviaContent = this.triviaContent.getStatus();
      const triviaLeaderboard = this.triviaLeaderboard.getStatus();
      const degraded = (arcadeHealth?.degraded ?? false)
        || triviaContent.state !== 'ready' || triviaLeaderboard.state !== 'ready';
      res.writeHead(degraded ? 503 : 200, {
        'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({
        status: degraded ? 'degraded' : 'ok',
        rooms: this.game.roomCount,
        karaokeRooms: this.karaoke.roomCount,
        triviaRooms: this.trivia.roomCount,
        chessRooms: this.chess.roomCount,
        triviaContent,
        triviaLeaderboard,
        karaokeMediaSessions: this.karaokeMedia.activeSessionCount,
        karaokeLyricRecognition: this.deepgramConfigured ? 'configured' : 'unavailable',
        semanticVoiceInterpretation: this.llm.enabled ? 'configured' : 'unavailable',
        karaokeCalibrationOffsetMs: this.karaokeCalibrationOffsetMs,
      }));
      return;
    }
    if (req.method === 'GET' && path === '/auth/google') { this.analyticsAuth.begin(req, res); return; }
    if (req.method === 'GET' && path === '/auth/google/callback') { await this.analyticsAuth.complete(req, res); return; }
    if (req.method === 'POST' && path === '/auth/pin') {
      let input: unknown;
      try { input = JSON.parse(await readBody(req)); }
      catch { res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"error":"invalid_request"}'); return; }
      const pin = (input as { pin?: unknown })?.pin;
      if (typeof pin !== 'string' || pin.length > 128) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"error":"invalid_request"}'); return;
      }
      this.analyticsAuth.completePin(req, res, pin); return;
    }
    if (req.method === 'POST' && path === '/auth/logout') { this.analyticsAuth.logout(req, res); return; }
    if (req.method === 'GET' && path === '/api/analytics/session') {
      const user = this.analyticsAuth.currentUser(req);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ authenticated: Boolean(user), analyticsAuthorized: user?.analyticsAuthorized ?? false,
        configured: this.analyticsAuth.configured, googleConfigured: this.analyticsAuth.googleConfigured,
        pinConfigured: this.analyticsAuth.pinConfigured, email: user?.email })); return;
    }
    if (this.operatorAuthRequired && path.startsWith('/api/admin/')
      && !this.analyticsAuth.currentOperatorUser(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end('{"error":{"code":"OPERATOR_AUTH_REQUIRED","message":"operator authentication required"}}');
      return;
    }
    if (this.operatorAuthRequired && req.method === 'GET' && (path === '/operator' || path === '/operator/')
      && !this.analyticsAuth.currentOperatorUser(req)) {
      res.writeHead(302, { Location: '/analytics?returnTo=%2Foperator', 'Cache-Control': 'no-store' }).end();
      return;
    }
    if (path === '/api/admin/arcade/trivia/audio-recovery'
      && (req.method === 'GET' || req.method === 'POST')) {
      const json = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          .end(JSON.stringify(payload));
      };
      const principal = this.arcadeApi?.authorizeOperatorRequest(req);
      if (!principal) { json(401, { error: { code: 'OPERATOR_AUTH_REQUIRED', message: 'operator authentication required' } }); return; }
      if (req.method === 'GET') {
        const matchId = new URL(req.url ?? path, this.publicBaseUrl).searchParams.get('matchId')?.trim() ?? '';
        if (!matchId || matchId.length > 128) { json(400, { error: { code: 'INVALID_MATCH', message: 'matchId is required' } }); return; }
        const code = this.arcadeApi?.activeStationEngineRoom('trivia', matchId);
        const room = code ? this.trivia.findRoom(code) : null;
        const state = room?.state();
        const problem = state?.phase === 'audio_problem' ? state.audioProblem : null;
        json(200, problem
          ? { available: true, matchId, questionId: problem.questionId,
              questionAttemptId: problem.questionAttemptId, recoveryDeadlineAtMs: problem.recoveryDeadlineAtMs }
          : { available: false });
        return;
      }
      if (req.headers.origin !== new URL(this.publicBaseUrl).origin) {
        json(403, { error: { code: 'SAME_ORIGIN_REQUIRED', message: 'same-origin request required' } });
        return;
      }
      let input: unknown;
      try { input = JSON.parse(await readBody(req)); }
      catch { json(400, { error: { code: 'INVALID_REQUEST', message: 'invalid JSON' } }); return; }
      const body = input as { matchId?: unknown; questionId?: unknown; questionAttemptId?: unknown } | null;
      const matchId = typeof body?.matchId === 'string' ? body.matchId.trim() : '';
      const questionId = typeof body?.questionId === 'string' ? body.questionId.trim() : '';
      const attemptId = body?.questionAttemptId;
      if (!matchId || matchId.length > 128 || !questionId || questionId.length > 128
        || !Number.isSafeInteger(attemptId) || (attemptId as number) < 1) {
        json(400, { error: { code: 'INVALID_REQUEST', message: 'current question reference is required' } });
        return;
      }
      const code = this.arcadeApi?.activeStationEngineRoom('trivia', matchId);
      const room = code ? this.trivia.findRoom(code) : null;
      const state = room?.state();
      if (!code || state?.phase !== 'audio_problem' || state.audioProblem?.questionId !== questionId
        || state.audioProblem.questionAttemptId !== attemptId
        || !this.trivia.retryQuestion(code, questionId, attemptId as number)) {
        json(409, { error: { code: 'STALE_QUESTION', message: 'this question is no longer waiting for audio recovery' } });
        return;
      }
      console.info(`[trivia] operator retried question audio match=${matchId} attempt=${attemptId} operator=${principal.email}`);
      json(200, { retried: true, matchId, nextAttemptId: room!.state().questionAttemptId });
      return;
    }
    if (path === '/api/admin/arcade/leaderboards' && req.method === 'GET') {
      const principal=this.arcadeApi?.authorizeOperatorRequest(req);
      if(!principal){res.writeHead(401,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({error:'operator authorization required'}));return;}
      try{
        const summary=await this.leaderboardAdminSummary();
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','ETag':summary.etag});
        res.end(JSON.stringify({games:[summary.games[0],{game:'monsters',resettable:false,maps:[]},{game:'fighter',resettable:false,maps:[]},summary.games[1],summary.games[2]]}));
      }catch(error){res.writeHead(503,{'Content-Type':'application/json'}).end(JSON.stringify({error:(error as Error).message}));}
      return;
    }
    if (path === '/api/admin/arcade/leaderboards/reset' && req.method === 'POST') {
      const principal=this.arcadeApi?.authorizeOperatorRequest(req);
      if(!principal){res.writeHead(401,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(JSON.stringify({error:'operator authorization required'}));return;}
      if(req.headers.origin!==new URL(this.publicBaseUrl).origin){res.writeHead(403,{'Content-Type':'application/json'}).end(JSON.stringify({error:'same-origin request required'}));return;}
      let body:unknown;try{body=JSON.parse(await readBody(req));}catch{res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:'invalid JSON'}));return;}
      const input=body as {game?:unknown;map?:unknown;reason?:unknown};
       if((input.game!=='racer'&&input.game!=='karaoke'&&input.game!=='trivia')||typeof input.map!=='string'||!input.map.trim()||typeof input.reason!=='string'||!input.reason.trim()||input.reason.trim().length>200){
        res.writeHead(400,{'Content-Type':'application/json'}).end(JSON.stringify({error:'game, leaderboard selection, and reason are required'}));return;
      }
      try{
        const result=await this.resetLeaderboardScores(input.game,input.map,String(req.headers['if-match']??''));
        console.info(`[leaderboard] reset game=${input.game} map=${input.map} deleted=${result.deleted} operator=${principal.email} reason=${input.reason.trim()}`);
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store','ETag':result.etag}).end(JSON.stringify({game:input.game,map:input.map,deleted:result.deleted,remaining:result.remaining}));
      }catch(error){
        const failure=error as Error&{code?:string;etag?:string};
        if(failure.code==='PRECONDITION_FAILED'){res.writeHead(412,{'Content-Type':'application/json',...(failure.etag?{'ETag':failure.etag}:{})}).end(JSON.stringify({error:failure.message}));}
        else if(failure.code==='UNKNOWN_MAP')res.writeHead(404,{'Content-Type':'application/json'}).end(JSON.stringify({error:failure.message}));
        else res.writeHead(503,{'Content-Type':'application/json'}).end(JSON.stringify({error:failure.message}));
      }
      return;
    }
    if (this.arcadeApi
      && (path.startsWith('/api/arcade/') || path.startsWith('/api/admin/arcade/'))) {
      await this.arcadeApi.handle(req, res, path);
      return;
    }
    if (req.method === 'POST' && path === '/twilio/messaging/status') {
      const body = await readBody(req);
      const params = Object.fromEntries(new URLSearchParams(body));
      if (this.validateSignatures) {
        if (!this.authToken) {
          res.writeHead(500).end('signature validation enabled but TWILIO_AUTH_TOKEN not configured');
          return;
        }
        const signature = req.headers['x-twilio-signature'];
        const exactUrl = `${this.publicBaseUrl}${req.url ?? path}`;
        const valid = this.validatePrimaryTwilioForm(
          Array.isArray(signature) ? signature[0] : signature, exactUrl, params,
        );
        if (!valid) {
          res.writeHead(403).end('invalid signature');
          return;
        }
      }
      const callbackUrl = new URL(req.url ?? path, 'http://localhost');
      await this.arcadeApi?.processMessagingStatusCallback({
        notificationId: callbackUrl.searchParams.get('n') ?? '',
        attemptId: callbackUrl.searchParams.get('a') ?? '',
        providerMessageId: params['MessageSid'] ?? '',
        providerStatus: params['MessageStatus'] ?? '',
        errorCode: params['ErrorCode'] || null,
        errorMessage: params['ChannelStatusMessage'] || null,
      });
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'POST' && (path === '/voice/incoming' || path === '/voice/join')) {
      const body = await readBody(req);
      const params = Object.fromEntries(new URLSearchParams(body));
      const fullUrl = `${this.publicBaseUrl}${path}`;
      if (this.validateSignatures) {
        if (!this.authTokens.length) {
          res.writeHead(500).end('signature validation enabled but TWILIO_AUTH_TOKEN not configured');
          return;
        }
        const sig = req.headers['x-twilio-signature'];
        const ok = this.validateTwilioVoiceForm(
          Array.isArray(sig) ? sig[0] : sig, fullUrl, params,
        );
        if (!ok) {
          res.writeHead(403).end('invalid signature');
          return;
        }
      }
      // Standalone calls bind to DEFAULT_ROOM without a room-code keypad step. The active
      // station assignment, when present, supplies the exact game and generated room.
      // /voice/join is kept as an alias in case a legacy DTMF-gathered call still hits it (uses the
      // dialed Digits if present, else the default room).
      const fallbackRoomCode = path === '/voice/join'
        ? ((params['Digits'] ?? '').trim() || DEFAULT_ROOM)
        : DEFAULT_ROOM;
      const dialedLocale = this.arcadeApi?.voiceLocaleForNumber(params['To'] ?? '') ?? null;
      const unavailableLocale = dialedLocale ?? this.defaultLocale;
      const unavailableXml = twimlSayAndHangup(
        VOICE_UNAVAILABLE_MESSAGES[unavailableLocale], unavailableLocale,
      );
      let eventRoutingActive = this.arcadeApi?.requiresStationVoiceAssignment() ?? false;
      if (!eventRoutingActive && (!this.standaloneVoiceEnabled || this.arcadeApi?.standaloneVoiceAvailable?.() === false)) {
        res.writeHead(200, VOICE_XML_HEADERS).end(unavailableXml);
        return;
      }
      let stationRoute: Awaited<ReturnType<ArcadeApi['stationVoiceRoute']>> = null;
      if (eventRoutingActive) {
        try {
          stationRoute = await this.arcadeApi!.stationVoiceRoute(
            params['From'] ?? '', params['CallSid'] ?? '',
          );
        } catch (error) {
          console.error('[voice] station routing failed:', error instanceof Error ? error.message : 'unknown error');
          res.writeHead(200, VOICE_XML_HEADERS).end(unavailableXml);
          return;
        }
      }
      if (eventRoutingActive && !this.arcadeApi!.requiresStationVoiceAssignment()) {
        eventRoutingActive = false;
        stationRoute = null;
        if (!this.standaloneVoiceEnabled || this.arcadeApi?.standaloneVoiceAvailable?.() === false) {
          res.writeHead(200, VOICE_XML_HEADERS).end(unavailableXml);
          return;
        }
      }
      if (!stationRoute && eventRoutingActive) {
        const xml = twimlSayAndHangup(
          dialedLocale === 'pt-BR'
            ? 'Você não está em uma partida ativa do Twilio Games. Responda STATUS na mensagem do jogo para receber ajuda.'
            : 'You are not assigned to an active Twilio Games match. Reply STATUS to the game message for help.',
          dialedLocale ?? this.defaultLocale,
        );
        res.writeHead(200, VOICE_XML_HEADERS).end(xml);
        return;
      }
      if (stationRoute && !stationRoute.admitted) {
        const xml = twimlSayAndHangup(
          dialedLocale === 'pt-BR'
            ? 'Este telefone não está na partida ativa. Responda STATUS na mensagem do jogo para receber ajuda.'
            : 'This phone is not assigned to the active match. Reply STATUS to the Twilio Games message for help.',
          dialedLocale ?? this.defaultLocale,
        );
        res.writeHead(200, VOICE_XML_HEADERS).end(xml);
        return;
      }
      const roomCode = stationRoute?.roomCode ?? fallbackRoomCode;
      // Station assignment is authoritative; connection recency remains only for non-Arcade play.
      const voiceGame = stationRoute
        ? stationRoute.game === 'monsters' ? 'battle' : stationRoute.game
        : this.recentVoiceGame(roomCode);
      if(!voiceGame){res.writeHead(200,VOICE_XML_HEADERS).end(unavailableXml);return;}
      const voiceLocale = dialedLocale ?? this.recentVoiceLocale(voiceGame, roomCode);
      const callSid = (params['CallSid'] ?? '').trim();
      const accountSid = (params['AccountSid'] ?? '').trim();
      if (validProviderIdentity(callSid) && validProviderIdentity(accountSid)) {
        const registered = this.voiceAccountSids.get(callSid);
        if (!registered || registered === accountSid) this.voiceAccountSids.set(callSid, accountSid);
      }
      if (callSid) this.voiceReconnectAttempts.set(callSid, 0);
      if (callSid && stationRoute?.admitted && stationRoute.readyEntryId) {
        this.stationVoiceReconnectRoutes.set(callSid, {
          game: stationRoute.game, roomCode, readyEntryId: stationRoute.readyEntryId,
          matchId: stationRoute.matchId, launchGeneration: stationRoute.launchGeneration, locale: voiceLocale,
        });
      }
      const xml = twimlConnectRelay({
        wsUrl: `${this.publicBaseUrl.replace(/^http/, 'ws')}/voice`,
        sessionEndedUrl: `${this.publicBaseUrl}/voice/session-ended`,
        roomCode,
        // English uses the selected ElevenLabs voice; Portuguese keeps its own voice setting.
        ttsProvider: 'ElevenLabs',
        voice: voiceLocale === 'pt-BR' ? this.crVoicePtBr : this.crVoice,
        game: voiceGame === 'battle' ? 'monsters' : voiceGame,
        karaokeMode: voiceGame === 'karaoke' ? 'setup' : undefined,
        readyEntryId: stationRoute?.readyEntryId ?? undefined,
        matchId: stationRoute?.matchId,
        launchGeneration: stationRoute?.launchGeneration,
        locale: voiceLocale,
        relayToken: this.voiceRelayToken || undefined,
        hints: this.voiceHints(voiceGame, voiceLocale),
        // Game setup sends the first line once the caller is bound to its current screen.
        welcomeGreeting: '',
      });
      res.writeHead(200, VOICE_XML_HEADERS).end(xml);
      return;
    }
    if (req.method === 'POST' && path === '/voice/karaoke/stream-status') {
      const body = await readBody(req);
      const params = Object.fromEntries(new URLSearchParams(body));
      if (this.validateSignatures) {
        if (!this.authTokens.length) {
          res.writeHead(500).end('signature validation enabled but TWILIO_AUTH_TOKEN not configured');
          return;
        }
        const signature = req.headers['x-twilio-signature'];
        if (!this.validateTwilioVoiceForm(
          Array.isArray(signature) ? signature[0] : signature,
          `${this.publicBaseUrl}${path}`,
          params,
        )) {
          res.writeHead(403).end('invalid signature');
          return;
        }
      }
      const callSid = (params['CallSid'] ?? '').trim();
      const accountSid = (params['AccountSid'] ?? '').trim();
      const binding = this.karaokeVoiceCallBindings.get(callSid);
      if (!binding) {
        res.writeHead(204).end();
        return;
      }
      const streamSid = (params['StreamSid'] ?? '').trim();
      const streamName = (params['StreamName'] ?? '').trim();
      const event = (params['StreamEvent'] ?? '').trim().toLowerCase();
      const recognizedEvent = event === 'stream-started' || event === 'stream-stopped' || event === 'stream-error';
      const mayBindEarlyStream = binding.streamSid === null && binding.lifecycle === 'media-issued'
        && (event === 'stream-started' || event === 'stream-error');
      if (!validProviderIdentity(callSid) || !validProviderIdentity(accountSid) || !validProviderIdentity(streamSid)
        || binding.accountSid !== accountSid || !binding.attemptId || binding.streamName !== streamName
        || !recognizedEvent
        || (binding.streamSid === null ? !mayBindEarlyStream : binding.streamSid !== streamSid)) {
        res.writeHead(403).end('invalid stream identity');
        return;
      }
      if (binding.streamSid === null) binding.streamSid = streamSid;
      const completedResult = binding.scoreAccepted
        && this.karaoke.findRoom(binding.code)?.state().result?.playerId === binding.playerId;
      if (event === 'stream-error' && !binding.completed && !completedResult) this.failKaraokeCall(callSid);
      else if (event === 'stream-stopped') {
        const result = this.karaokeMedia.finalizedResult(binding.attemptId);
        if (result?.scoreAccepted) {
          binding.mediaFinalized = true;
          binding.scoreAccepted = true;
          transitionKaraokeLifecycle(binding, 'media-finalized');
        }
      }
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'POST' && path === '/voice/karaoke/complete') {
      const body = await readBody(req);
      const params = Object.fromEntries(new URLSearchParams(body));
      if (this.validateSignatures) {
        if (!this.authTokens.length) {
          res.writeHead(500).end('signature validation enabled but TWILIO_AUTH_TOKEN not configured');
          return;
        }
        const signature = req.headers['x-twilio-signature'];
        if (!this.validateTwilioVoiceForm(
          Array.isArray(signature) ? signature[0] : signature,
          `${this.publicBaseUrl}${path}`,
          params,
        )) {
          res.writeHead(403).end('invalid signature');
          return;
        }
      }
      res.writeHead(200, VOICE_XML_HEADERS).end(this.completeKaraokeTwiML(params));
      return;
    }
    if (req.method === 'POST' && path === '/voice/session-ended') {
      const body = await readBody(req);
      const params = Object.fromEntries(new URLSearchParams(body));
      if (this.validateSignatures) {
        if (!this.authTokens.length) {
          res.writeHead(500).end('signature validation enabled but TWILIO_AUTH_TOKEN not configured');
          return;
        }
        const sig = req.headers['x-twilio-signature'];
        const ok = this.validateTwilioVoiceForm(
          Array.isArray(sig) ? sig[0] : sig, `${this.publicBaseUrl}${path}`, params,
        );
        if (!ok) {
          res.writeHead(403).end('invalid signature');
          return;
        }
      }
      const callSid = (params['CallSid'] ?? params['callSid'] ?? '').trim();
      const sessionStatus = (params['SessionStatus'] ?? 'unknown').trim().slice(0, 40);
      const errorCode = (params['ErrorCode'] ?? '').trim().slice(0, 20);
      const errorMessage = (params['ErrorMessage'] ?? '').trim().replace(/\s+/g, ' ').slice(0, 300);
      console.log(`[CR] session ended call=${callSid.slice(0, 8) || 'unknown'} status=${sessionStatus}${errorCode ? ` error=${errorCode}` : ''}${errorMessage ? ` message=${errorMessage}` : ''}`);
      const callStatus = (params['CallStatus'] ?? '').trim().toLowerCase();
      const karaokeHandoffXml = this.karaokeHandoffTwiML(params);
      if (karaokeHandoffXml !== null) {
        res.writeHead(200, VOICE_XML_HEADERS).end(karaokeHandoffXml);
        return;
      }
      const attempts = this.voiceReconnectAttempts.get(callSid) ?? 0;
      const recoverableError = !errorCode || ['39001','64103','64105','64111','64112'].includes(errorCode);
      if (callSid && sessionStatus.toLowerCase() === 'failed' && callStatus === 'in-progress'
        && recoverableError && attempts < 2) {
        let station = this.stationVoiceReconnectRoutes.get(callSid);
        if (station && this.arcadeApi) {
          try {
            const refreshed = await this.arcadeApi.stationVoiceRoute(params['From'] ?? '', callSid);
            if (refreshed?.admitted && refreshed.readyEntryId) {
              station = {
                game: refreshed.game, roomCode: refreshed.roomCode, readyEntryId: refreshed.readyEntryId,
                matchId: refreshed.matchId, launchGeneration: refreshed.launchGeneration, locale: station.locale,
              };
              this.stationVoiceReconnectRoutes.set(callSid, station);
            } else {
              const terminalBinding=station.game==='racer'
                ?this.hasResumableRacerVoiceCall(callSid,station.roomCode)
                :station.game==='monsters'
                  ?this.hasResumableBattleVoiceCall(callSid,station.roomCode)
                  :station.game==='fighter'
                  ?this.hasResumableFighterVoiceCall(callSid,station.roomCode)
                    :station.game==='karaoke'
                      ?this.hasResumableKaraokeVoiceCall(callSid,station.roomCode)
                      :station.game==='chess'
                        ?this.hasResumableChessVoiceCall(callSid,station.roomCode)
                      :this.hasResumableTriviaVoiceCall(callSid,station.roomCode);
              if(!terminalBinding){this.stationVoiceReconnectRoutes.delete(callSid);station=undefined;}
            }
          } catch { /* fall back to the last validated route; setup validation still fails closed */ }
        }
        const racer = this.racerVoiceCallBindings.get(callSid);
        const battle = this.battleVoiceCallBindings.get(callSid);
        const fighter = this.fighterVoiceCallBindings.get(callSid);
        const karaoke = this.karaokeVoiceCallBindings.get(callSid);
        const trivia = this.triviaVoiceCallBindings.get(callSid);
        const chess = this.chessVoiceCallBindings.get(callSid);
        const game = station?.game ?? (battle ? 'monsters' : fighter ? 'fighter' : karaoke ? 'karaoke' : trivia ? 'trivia' : chess ? 'chess' : racer ? 'racer' : null);
        const roomCode = station?.roomCode ?? battle?.code ?? fighter?.code ?? karaoke?.code ?? trivia?.code ?? chess?.code ?? racer?.code;
        const locale = station?.locale ?? battle?.locale ?? fighter?.locale ?? karaoke?.locale ?? trivia?.locale ?? chess?.locale ?? racer?.locale ?? this.defaultLocale;
        if (game && roomCode) {
          this.voiceReconnectAttempts.set(callSid, attempts + 1);
          const xml = twimlConnectRelay({
            wsUrl: `${this.publicBaseUrl.replace(/^http/, 'ws')}/voice`,
            sessionEndedUrl: `${this.publicBaseUrl}/voice/session-ended`,
            roomCode, ttsProvider: 'ElevenLabs',
            voice: locale === 'pt-BR' ? this.crVoicePtBr : this.crVoice,
            game, readyEntryId: station?.readyEntryId, matchId: station?.matchId,
            launchGeneration: station?.launchGeneration, locale,
            karaokeMode: game === 'karaoke' && karaoke?.completed ? 'result' : game === 'karaoke' ? 'setup' : undefined,
            relayToken: this.voiceRelayToken || undefined,
            hints: this.voiceHints(game === 'monsters' ? 'battle' : game, locale), welcomeGreeting: '',
          });
          res.writeHead(200, VOICE_XML_HEADERS).end(xml);
          return;
        }
      }
      this.voiceReconnectAttempts.delete(callSid);
      this.stationVoiceReconnectRoutes.delete(callSid);
      this.arcadeApi?.stationVoiceCallEnded(callSid);
      this.endRacerVoiceCall(callSid); this.endBattleVoiceCall(callSid); this.endFighterVoiceCall(callSid);
      this.endTriviaVoiceCall(callSid);
      this.endChessVoiceCall(callSid);
      const karaokeBinding = this.karaokeVoiceCallBindings.get(callSid);
      if (karaokeBinding && this.karaoke.findRoom(karaokeBinding.code)?.state().phase !== 'results') {
        this.failKaraokeCall(callSid);
      } else this.endKaraokeVoiceCall(callSid);
      this.voiceAccountSids.delete(callSid);
      const karaokeFailure = this.karaokeFailureLocales.get(callSid);
      if (karaokeFailure) clearTimeout(karaokeFailure.timer);
      this.karaokeFailureLocales.delete(callSid);
      res.writeHead(200, VOICE_XML_HEADERS).end(twimlHangup());
      return;
    }
    if (req.method === 'POST' && path === '/tac/webhook') {
      const rawBody = await readBody(req);
      if (this.validateSignatures) {
        if (!this.authToken) {
          res.writeHead(500).end('signature validation enabled but TWILIO_AUTH_TOKEN not configured');
          return;
        }
        const header = req.headers['x-twilio-signature'];
        const signature = Array.isArray(header) ? header[0] : header;
        const exactUrl = `${this.publicBaseUrl}${req.url ?? path}`;
        const valid = this.validatePrimaryTwilioBody(signature, exactUrl, rawBody);
        if (!valid) {
          res.writeHead(403).end('invalid signature');
          return;
        }
      }
      let payload: unknown;
      try { payload = JSON.parse(rawBody); }
      catch { res.writeHead(400).end('invalid JSON'); return; }
      const idempotencyHeader = req.headers['i-twilio-idempotency-token'];
      const idempotencyToken = Array.isArray(idempotencyHeader)
        ? idempotencyHeader[0]
        : idempotencyHeader;
      try {
        if (!this.arcadeTacGateway) throw new Error('TAC gateway is disabled');
        await this.arcadeTacGateway.processWebhook(payload, idempotencyToken);
      } catch (error) {
        console.error('[TAC] Conversation webhook failed:', error instanceof Error ? error.message : String(error));
        res.writeHead(503).end('TAC messaging unavailable');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    // ---- SMS concierge: onboarding + car/map selection by text ----
    if (req.method === 'POST' && path === '/sms') {
      const body = await readBody(req);
      const params = Object.fromEntries(new URLSearchParams(body));
      if (this.validateSignatures) {
        if (!this.authToken) { res.writeHead(500).end('signature validation enabled but TWILIO_AUTH_TOKEN is not configured'); return; }
        const sig = req.headers['x-twilio-signature'];
        const ok = this.validatePrimaryTwilioForm(
          Array.isArray(sig) ? sig[0] : sig, `${this.publicBaseUrl}/sms`, params,
        );
        if (!ok) { res.writeHead(403).end('invalid signature'); return; }
      }
      const from = (params['From'] ?? '').trim();
      const smsBody = params['Body'] ?? '';
      const messageSid = params['MessageSid'] ?? '';
      // Media (MMS) isn't supported — reply politely without invoking the state machine.
      if ((parseInt(params['NumMedia'] ?? '0', 10) || 0) > 0) {
        const knownLocale=await this.arcadeApi?.messagingLocaleForAddress?.(from)??null;
        const mediaReply = knownLocale === 'pt-BR' || (knownLocale === null
          && (/^\s*ENTRAR(?:\s|$)/i.test(smsBody) || from.replace(/^whatsapp:/i, '').startsWith('+55')))
          ? 'Só consigo ler respostas em texto. Envie sua resposta por escrito ou responda AJUDA para ver os comandos.'
          : 'I can read text replies only. Send your answer as text, or reply HELP for the game commands.';
        res.writeHead(200, { 'Content-Type': 'text/xml' }).end(
          twimlMessage(mediaReply));
        return;
      }
      if (!from) { res.writeHead(200, { 'Content-Type': 'text/xml' }).end(twimlEmpty()); return; }
      // Serialize per-phone so two rapid texts can't race on the same session/room mutation.
      const reply = await this.runSmsSerialized(from, async () => (
        await this.arcadeApi?.processMessagingWebhook({ from, body: smsBody, providerMessageId: messageSid })
        ?? this.concierge.handle({ from, body: smsBody, messageSid })
      ));
      res.writeHead(200, { 'Content-Type': 'text/xml' }).end(twimlMessage(reply));
      return;
    }
    // ---- client bootstrap config (public, unauthenticated): the phone number to call to join, so
    //      the lobby can show it + encode the QR. Empty string when unset (lobby shows a placeholder).
    if (path === '/api/config' && req.method === 'GET') {
      const voiceNumbers = this.arcadeApi?.getVoiceNumbers() ?? {
        'en-US': this.gamePhoneNumber || null,
        'pt-BR': this.gamePhoneNumber || null,
      };
      const phoneNumber = voiceNumbers[this.defaultLocale]
        ?? voiceNumbers['en-US']
        ?? voiceNumbers['pt-BR']
        ?? this.gamePhoneNumber;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        phoneNumber,
        voiceNumbers,
        smsNumber: this.smsNumber,
        whatsappNumber: this.whatsappNumber,
        defaultLocale: this.defaultLocale,
        supportedLocales: SUPPORTED_LOCALES,
        publicBaseUrl: this.publicBaseUrl,
      }));
      return;
    }
    if (path === '/api/trivia-questions' && req.method === 'GET') {
      if (!this.authorizeTriviaEditor(req, res)) return;
      const etag = this.triviaContent.etag;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'Cache-Control': 'no-store', ETag: etag }).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ETag: etag,
        'X-Trivia-Content-Revision': this.triviaContent.revision,
      });
      res.end(JSON.stringify(this.triviaContent.bank));
      return;
    }
    if (path === '/api/trivia-questions' && req.method === 'POST') {
      if (!this.authorizeTriviaEditor(req, res)) return;
      const expectedEtag = Array.isArray(req.headers['if-match']) ? '' : (req.headers['if-match'] ?? '');
      if (!expectedEtag) {
        res.writeHead(428, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
          .end('a current Trivia question-bank ETag is required');
        return;
      }
      let bank: TriviaQuestionBank;
      try {
        bank = parseTriviaQuestionBankJson(await readBody(req, TRIVIA_MAX_JSON_LENGTH));
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
          .end(error instanceof Error ? error.message : 'invalid Trivia question bank');
        return;
      }
      try {
        const saved = await this.triviaContent.replace(bank, expectedEtag);
        this.trivia.replaceQuestionBank(saved, this.triviaContent.revision);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          ETag: this.triviaContent.etag,
          'X-Trivia-Content-Revision': this.triviaContent.revision,
        });
        res.end(JSON.stringify(saved));
      } catch (error) {
        const failure = error as Error & { code?: string; etag?: string };
        if (failure.code === 'PRECONDITION_FAILED') {
          res.writeHead(412, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store',
            ...(failure.etag ? { ETag: failure.etag } : {}),
          }).end(failure.message);
          return;
        }
        if (failure.code === 'IMMUTABLE_TRIVIA_PROVENANCE') {
          res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
            .end('Trivia question IDs and provenance are immutable');
          return;
        }
        throw error;
      }
      return;
    }
    // ---- manifest API ----
    if (path === '/api/manifest' && req.method === 'GET') {
      const m = await this.manifestStore.read();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(m));
      return;
    }
    if (path === '/api/manifest' && req.method === 'POST') {
      if (!this.authorizeWrite(req, res)) return;
      const body = await readBody(req);
      const m = parseManifest(body);            // tolerant: validates + drops bad parts
      await this.manifestStore.write(m);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(m));
      return;
    }
    // ---- list organized Voice Racer GLBs (for Garage/editor role dropdowns) ----
    if (path === '/api/assets' && req.method === 'GET') {
      let files: string[] = [];
      try {
        for (const directory of ['racer/cars', 'racer/track']) {
          const entries = await readdir(`assets/${directory}`, { withFileTypes: true });
          files.push(...entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.glb')).map(entry => `${directory}/${entry.name}`));
        }
        files.sort();
      } catch { files = []; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(files));
      return;
    }
    // ---- list available MAP GLB files (for the New-level map picker) ----
    if (path === '/api/map-files' && req.method === 'GET') {
      let files: string[] = [];
      try {
        const entries = await readdir('assets/maps', { withFileTypes: true });
        files = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.glb'))
          .map((e) => e.name).sort();
      } catch { files = []; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(files));
      return;
    }
    // ---- delete OR rename a level ----
    if (path === '/api/maps' && req.method === 'DELETE') {
      if (!this.authorizeWrite(req, res)) return;
      const url = new URL(req.url ?? '', 'http://localhost');
      const key = url.searchParams.get('map');
      if (!key) { res.writeHead(400).end('missing map'); return; }
      let all: Record<string, unknown> = {};
      try { all = JSON.parse(await readFile(this.mapsPath, 'utf8')); }
      catch { res.writeHead(409).end('maps file unreadable — refusing to modify'); return; }
      delete all[key];
      await this.writeFileAtomic(this.mapsPath, JSON.stringify(all, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(all));
      return;
    }
    // ---- Voice Monsters arena config (transform/camera/spin), authored in the multi-game editor ----
    if (path === '/api/arena' && req.method === 'GET') {
      let body = '';
      // Prefer the LIVE (persistent) config; fall back to the bundled default so a fresh env works.
      for (const p of [this.arenaPath, this.bundledArenaPath ?? 'assets/arena/arena.json']) {
        try { body = await readFile(p, 'utf8'); if (body.trim()) break; } catch { /* try next */ }
      }
      if (!body.trim()) body = JSON.stringify({ file: 'arena.glb', pos: [0, 0, 0], rotDeg: [0, 0, 0], scale: 1, spinSpeed: 0.18 });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
      return;
    }
    if (path === '/api/arena' && req.method === 'POST') {
      if (!this.authorizeWrite(req, res)) return;
      let cfg: unknown;
      try { cfg = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end('invalid JSON'); return; }
      if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) { res.writeHead(400).end('arena config must be an object'); return; }
      await this.writeFileAtomic(this.arenaPath, JSON.stringify(cfg, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(cfg));
      return;
    }
    // ---- Voice Karaoke venue config + direct release GLB picker ----
    if (path === '/api/karaoke-venue' && req.method === 'GET') {
      const venue = await this.readKaraokeVenue();
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(venue));
      return;
    }
    if (path === '/api/karaoke-venue' && req.method === 'POST') {
      if (!this.authorizeWrite(req, res)) return;
      let input: unknown;
      try { input = JSON.parse(await readBody(req)) as unknown; }
      catch { res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('invalid JSON'); return; }
      let venue: KaraokeVenueConfig;
      try { venue = parseKaraokeVenueConfig(input); }
      catch (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
          .end((error as Error).message);
        return;
      }
      await this.writeFileAtomic(this.karaokeVenuePath, `${JSON.stringify(venue, null, 2)}\n`);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(venue));
      return;
    }
    if (path === '/api/karaoke-timings' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        ETag: this.karaokeTimingEtag(),
      });
      res.end(JSON.stringify(this.karaokeTimingConfig));
      return;
    }
    if (path === '/api/karaoke-timings' && req.method === 'POST') {
      if (!this.authorizeWrite(req, res)) return;
      const expectedEtag = Array.isArray(req.headers['if-match']) ? '' : (req.headers['if-match'] ?? '');
      if (!expectedEtag) {
        res.writeHead(428, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
          .end('a current Karaoke timing ETag is required');
        return;
      }
      let input: unknown;
      try { input = JSON.parse(await readBody(req)) as unknown; }
      catch { res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('invalid JSON'); return; }
      let timings: KaraokeTimingConfig;
      try { timings = parseKaraokeTimingConfig(input, KARAOKE_DEVELOPMENT_SONGS); }
      catch (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
          .end((error as Error).message);
        return;
      }
      try {
        const saved = await this.saveKaraokeTimings(timings, expectedEtag);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
          ETag: saved.etag,
        });
        res.end(JSON.stringify(saved.config));
      } catch (error) {
        const failure = error as Error & { code?: string; etag?: string };
        if (failure.code === 'PRECONDITION_FAILED') {
          res.writeHead(412, {
            'Content-Type': 'text/plain', 'Cache-Control': 'no-store',
            ...(failure.etag ? { ETag: failure.etag } : {}),
          }).end(failure.message);
          return;
        }
        throw error;
      }
      return;
    }
    if (path === '/api/karaoke-asset-files' && req.method === 'GET') {
      let files: string[] = [];
      try {
        const entries = await readdir(this.karaokeAssetDirectory, { withFileTypes: true });
        files = entries
          .filter(entry => entry.isFile() && isSafeKaraokeGlbBasename(entry.name))
          .map(entry => entry.name)
          .sort((a, b) => a.localeCompare(b));
      } catch { /* An empty release directory produces an empty picker. */ }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(files));
      return;
    }
    // ---- Voice Fighter map catalog + GLB picker (authored in the unified editor) ----
    if (path === '/api/fighter-maps' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(this.fighterMaps));
      return;
    }
    if (path === '/api/fighter-maps' && req.method === 'POST') {
      if (!this.authorizeWrite(req, res)) return;
      let maps: unknown;
      try { maps = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end('invalid JSON'); return; }
      try { this.fighterMaps = runtimeFighterMaps(parseFighterMaps(maps)); }
      catch (error) { res.writeHead(400).end((error as Error).message); return; }
      await this.writeFileAtomic(this.fighterMapsPath, JSON.stringify(this.fighterMaps, null, 2));
      this.fighter.setMaps(this.fighterMaps);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(this.fighterMaps));
      return;
    }
    if (path === '/api/fighter-map-files' && req.method === 'GET') {
      let files: string[] = [];
      try {
        const entries = await readdir('assets/fighters/maps', { withFileTypes: true });
        files = entries.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.glb')).map(entry => entry.name).sort();
      } catch { /* empty picker */ }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(files));
      return;
    }
    if (path === '/api/fighter/leave' && req.method === 'POST') {
      let body: unknown;
      try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400).end('invalid JSON'); return; }
      const value = body as { roomCode?: unknown; sessionId?: unknown };
      if (typeof value?.roomCode !== 'string' || typeof value?.sessionId !== 'string' || value.sessionId.length > 128) { res.writeHead(400).end('roomCode + sessionId required'); return; }
      this.fighter.releaseBrowserSession(value.roomCode, value.sessionId);
      res.writeHead(204).end(); return;
    }
    if (path === '/api/fighter-map-preview' && req.method === 'POST') {
      if (!this.authorizeWrite(req, res)) return;
      const id = new URL(req.url ?? '', 'http://localhost').searchParams.get('id') ?? '';
      if (!/^[a-z0-9-]{1,64}$/.test(id)) { res.writeHead(400).end('invalid map id'); return; }
      const image = await readBinaryBody(req, 5 * 1024 * 1024);
      if (image.length < 8 || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { res.writeHead(400).end('preview must be PNG'); return; }
      await mkdir(this.fighterPreviewDir, { recursive: true });
      await this.writeFileAtomic(`${this.fighterPreviewDir}/${id}.png`, image);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ preview: `/fighter-previews/${id}.png` }));
      return;
    }
    // ---- global leaderboard (best finish times, all-time) ----
    if (path === '/api/leaderboard' && req.method === 'GET') {
      const url = new URL(req.url ?? '', 'http://localhost');
      const map = url.searchParams.get('map') ?? undefined;
      const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') ?? '10', 10) || 10));
      let entries = [] as ReturnType<typeof parseLeaderboard>;
      try { entries = parseLeaderboard(await readFile(this.leaderboardPath, 'utf8')); } catch { entries = []; }
      const top = topEntries(entries, { map, limit });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ entries: top.map(({ enginePlayerId: _enginePlayerId, ...entry }) => entry) }));
      return;
    }
    if (path === '/api/karaoke/leaderboard' && req.method === 'GET') {
      const url = new URL(req.url ?? '', 'http://localhost');
      const songId = url.searchParams.get('song');
      const rawLimit = url.searchParams.get('limit') ?? '10';
      if (!songId || !isSafeKaraokeId(songId) || !/^\d{1,3}$/.test(rawLimit)
        || Number(rawLimit) < 1 || Number(rawLimit) > 100) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'valid song and limit from 1 to 100 are required' }));
        return;
      }
      const limit = Number(rawLimit);
      await this.leaderboardWrite;
      let entries: KaraokeLeaderboardEntry[] = [];
      try { entries = parseKaraokeLeaderboard(await readFile(this.karaokeLeaderboardPath, 'utf8')); } catch { entries = []; }
      const top = topKaraokeEntries(entries, { songId, limit });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ entries: top.map(({ enginePlayerId: _enginePlayerId, ...entry }) => entry) }));
      return;
    }
    if (path === '/api/trivia/leaderboard' && req.method === 'GET') {
      const url = new URL(req.url ?? '', 'http://localhost');
      const board = url.searchParams.get('board');
      const rawLimit = url.searchParams.get('limit') ?? '10';
      if (!isTriviaBoardId(board) || !/^\d{1,3}$/.test(rawLimit)
        || Number(rawLimit) < 1 || Number(rawLimit) > 100) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'valid Trivia board and limit from 1 to 100 are required' }));
        return;
      }
      const entries = await this.triviaLeaderboard.entries(board, Number(rawLimit));
      const response = JSON.stringify({ entries });
      const etag = `"trivia-leaderboard-${createHash('sha256').update(response).digest('hex').slice(0, 24)}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'Cache-Control': 'no-store', ETag: etag }).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        ETag: etag,
      });
      res.end(response);
      return;
    }
    // ---- private activation analytics (daily anonymous aggregates, no transcripts or phone data) ----
    if ((path === '/api/analytics' || path === '/api/analytics.pdf') && req.method === 'GET') {
      if (!this.analyticsAuth.currentAnalyticsUser(req)) {
        res.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Google sign-in required'); return;
      }
      const url = new URL(req.url ?? '', 'http://localhost');
      const today = new Date().toISOString().slice(0, 10);
      const prior = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
      const fromParam = url.searchParams.get('from'), toParam = url.searchParams.get('to');
      const from = validDate(fromParam) ?? prior, to = validDate(toParam) ?? today;
      if ((fromParam && !validDate(fromParam)) || (toParam && !validDate(toParam))) {
        res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('dates must use YYYY-MM-DD'); return;
      }
      const requestedGame = url.searchParams.get('game') ?? 'all';
      if (requestedGame !== 'all' && !ANALYTICS_GAMES.includes(requestedGame as AnalyticsGame)) {
        res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('unknown game filter'); return;
      }
      const game = requestedGame as AnalyticsGame | 'all';
      let report;
      try { report = this.analytics.report(from, to, game); }
      catch (error) { res.writeHead(400, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end((error as Error).message); return; }
      if (path.endsWith('.pdf')) {
        const pdf = analyticsPdf(report);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length),
          'Content-Disposition': `attachment; filename="twilio-games-${from}-${to}.pdf"`, 'Cache-Control': 'no-store' });
        res.end(pdf); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(report)); return;
    }
    // ---- map configs (level layouts authored in /editor) ----
    if (path === '/api/maps' && req.method === 'GET') {
      let body = '{}';
      try { body = await readFile(this.mapsPath, 'utf8'); } catch { body = '{}'; }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
      return;
    }
    if (path === '/api/maps' && req.method === 'POST') {
      if (!this.authorizeWrite(req, res)) return;
      const raw = await readBody(req);
      let cfg: unknown;
      try { cfg = JSON.parse(raw); } catch { res.writeHead(400).end('bad json'); return; }
      // Read the CURRENT file and merge SAFELY: validate the posted config, refuse to proceed if
      // the existing file is corrupt (so we never silently wipe other levels), reject unsafe keys.
      let existing = '';
      try { existing = await readFile(this.mapsPath, 'utf8'); } catch { /* first save → empty */ }
      const merged = mergeMapConfig(existing, cfg);
      if (!merged.ok) { res.writeHead(400).end(merged.error); return; }
      await this.writeFileAtomic(this.mapsPath, JSON.stringify(merged.maps, null, 2));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(merged.maps));
      return;
    }
    if (req.method === 'GET' && path.startsWith('/fighter-previews/')) {
      const name = path.slice('/fighter-previews/'.length);
      if (!/^[a-z0-9-]+\.png$/i.test(name)) { res.writeHead(403).end('forbidden'); return; }
      const file = `${this.fighterPreviewDir}/${name}`;
      try { await stat(file); } catch { res.writeHead(404).end('not found'); return; }
      return this.sendFile(file, res, req, { 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' });
    }
    // ---- static assets (built JS bundles AND GLB models, both under /assets/) ----
    if (req.method === 'GET' && path.startsWith('/assets/')) {
      return this.serveAsset(path, res, req);
    }
    // ---- the built client (HTML pages, /brand, /fonts, etc.) ----
    if (req.method === 'GET') {
      return this.serveClient(path, res, req);
    }
    res.writeHead(404).end('not found');
  }

  /**
    * Gate a disk-writing /api endpoint. When editorToken is set (production/public deploy) the
    * request must present it via the x-editor-token header; on mismatch we 401 and return false.
    * When no token is configured (local dev) writes are open. Sends the response on failure so
    * callers can early-return.
   */
  private authorizeWrite(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this.editorToken) return true;   // dev: no token configured → open
    const header = req.headers['x-editor-token'];
    const token = Array.isArray(header) ? '' : (header ?? '');
    if (token === this.editorToken) return true;
    res.writeHead(401, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }).end('unauthorized');
    return false;
  }

  private authorizeTriviaEditor(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this.editorToken) return true;
    const header = req.headers['x-editor-token'];
    const token = Array.isArray(header) ? '' : (header ?? '');
    if (token === this.editorToken) return true;
    res.writeHead(401, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('unauthorized');
    return false;
  }

  /** Write a file atomically (temp file + rename) so a crash mid-write can't truncate/corrupt it.
   *  Ensures the parent directory exists (e.g. data/ for the leaderboard on first run). */
  private async writeFileAtomic(file: string, contents: string | Buffer): Promise<void> {
    const dir = path.dirname(file);
    if (dir && dir !== '.') await mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(tmp, contents);
    await rename(tmp, file);   // rename is atomic on the same filesystem
  }

  /**
   * Serve a /assets/<rel> request. TWO things live under /assets/ in production: the Vite-built JS
   * bundles (client/dist/assets/, hashed names) and the GLB models (repo-root assets/, named files).
   * In dev Vite owned the JS and proxied the rest; in the single-process container the Node server
   * serves both. Try the built client first (hashed JS), then fall back to the repo models — the
   * filenames never collide (hashed vs. named), so first-match-wins is safe.
   */
  private async serveAsset(urlPath: string, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    let rel: string;
    try { rel = decodeURIComponent(urlPath.replace(/^\/assets\//, '')); }
    catch { res.writeHead(400).end('bad request'); return; }   // malformed %-escape
    if (rel.includes('..') || rel.startsWith('/')) { res.writeHead(403).end('forbidden'); return; }
    if (rel.split(/[\\/]+/).some(segment => segment.toLowerCase() === '_raw')) {
      res.writeHead(403).end('forbidden'); return;
    }
    const builtAssets = path.join(this.clientDir, 'assets');
    for (const base of [builtAssets, 'assets']) {
      const full = path.join(base, rel);
      try {
        await stat(full);   // existence check; throws → try next base / 404
        // Assets are content-addressed (hashed JS bundles) or stable models → cache HARD so a client
        // (and the CDN/edge) fetches each big GLB ONCE, not on every menu load. This is the main fix
        // for the slow deployed menu: the 7.8MB models were re-downloaded uncompressed every time.
        const cache = base === builtAssets ? 'public, max-age=31536000, immutable' : 'public, max-age=3600, must-revalidate';
        return this.sendFile(full, res, req, { 'Cache-Control': cache, 'Access-Control-Allow-Origin': '*' });
      } catch { /* try next base */ }
    }
    res.writeHead(404).end('not found');
  }

  /**
   * Stream a file to the response (don't buffer the whole thing — a 7.8MB GLB buffered + sent in one
   * res.end() blocks the event loop and balloons memory on a 1-CPU container). gzip text-ish files
   * on the fly when the client accepts it (the 600KB JS bundle → ~150KB); GLBs are already Draco-
   * compressed, so we stream them as-is. Honors a small static header set (cache-control, CORS).
   */
  private async sendFile(full: string, res: http.ServerResponse, req: http.IncomingMessage,
                         extraHeaders: Record<string, string> = {}): Promise<void> {
    const type = contentType(full);
    const headers: Record<string, string> = { 'Content-Type': type, ...extraHeaders };
    // gzip only compressible text types; never re-compress GLB/PNG/fonts (already compact → wastes CPU).
    const compressible = /^(text\/|application\/(javascript|json)|image\/svg)/.test(type);
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    if (compressible && acceptsGzip) {
      headers['Content-Encoding'] = 'gzip';
      headers['Vary'] = 'Accept-Encoding';
      res.writeHead(200, headers);
      createReadStream(full).pipe(zlib.createGzip()).pipe(res);
    } else {
      try { headers['Content-Length'] = String((await stat(full)).size); } catch { /* skip length */ }
      res.writeHead(200, headers);
      createReadStream(full).pipe(res);
    }
  }

  /**
   * Serve the built client: the home page at `/`, `/play.html`, the folder-index pages `/editor` and
   * `/garage` (bare path → <dir>/index.html, matching the dev redirect), and any other static file
   * (/brand, /fonts, etc.). Path-traversal guarded to clientDir. Unknown paths 404 (this is a game
   * server, not an SPA — no catch-all index fallback).
   */
  private async serveClient(urlPath: string, res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    let rel: string;
    try { rel = decodeURIComponent(urlPath); } catch { res.writeHead(400).end('bad request'); return; }
    if (rel.includes('..')) { res.writeHead(403).end('forbidden'); return; }
    if (rel === '/arcade' || rel === '/arcade/' || rel === '/arcade/index.html') { res.writeHead(404).end('not found'); return; }
    // Map bare paths to files: '/' and '/editor' → index.html; '/garage' → garage/index.html.
    let file: string;
    if (rel === '/' || rel === '') file = 'index.html';
    else if (rel === '/editor' || rel === '/editor/') file = 'editor/index.html';
    else if (rel === '/garage' || rel === '/garage/') file = 'garage/index.html';
    else if (rel === '/analytics' || rel === '/analytics/') file = 'analytics/index.html';
    else if (rel === '/player' || rel === '/player/') file = 'arcade/index.html';
    else if (rel === '/operator' || rel === '/operator/') file = 'arcade/index.html';
    else if (rel === '/join' || rel === '/join/') file = 'join/index.html';
    else if (rel === '/instructions' || rel === '/instructions/') file = 'instructions/index.html';
    else if (rel === '/challenge' || rel === '/challenge/') file = 'challenge/index.html';
    else file = rel.replace(/^\/+/, '');
    const full = path.join(this.clientDir, file);
    try {
      if (!(await stat(full)).isFile()) { res.writeHead(404).end('not found'); return; }
    } catch { res.writeHead(404).end('not found'); return; }
    // HTML must NOT cache (so a redeploy is seen immediately); hashed /assets/* JS is handled by
    // serveAsset's immutable cache. Other static files (brand/fonts) get a short cache.
    const isHtml = file.endsWith('.html');
    const cache = rel === '/operator' || rel === '/operator/'
      ? 'no-store, private'
      : isHtml ? 'no-cache' : 'public, max-age=3600';
    await this.sendFile(full, res, req, file === 'challenge/index.html' ? {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'",
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    } : { 'Cache-Control': cache });
  }

  async start(): Promise<number> {
    const triviaBank = await this.triviaContent.load();
    this.trivia.replaceQuestionBank(triviaBank, this.triviaContent.revision);
    await this.triviaLeaderboard.load();
    await this.analytics.load();
    await this.arcadeApi?.start();
    await this.arcadeTacGateway?.start();
    await this.seedMapsFile();
    await this.seedKaraokeVenueFile();
    await this.loadKaraokeTimings();
    await this.refreshFighterMaps();
    // Re-read the (possibly just-seeded) maps into the lobby cache so map choices are correct on the
    // very first connection — the constructor's initial refresh may have run before the seed wrote.
    await this.refreshRoomConfig();
    this.roomConfigTimer ??= setInterval(() => void this.refreshRoomConfig(), 5000);
    this.smsSweepTimer ??= setInterval(() => this.concierge.sweep(), 5 * 60 * 1000);
    const listeningPort = await new Promise<number>((resolve) => {
      this.server.listen(this.port, () => {
        const addr = this.server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : this.port);
      });
    });
    await this.arcadeApi?.activateMessagingDelivery();
    return listeningPort;
  }

  /** Copy the image-bundled default levels into the LIVE (persistent) maps file ONCE, on first boot
   *  — only when the live file is missing/blank/corrupt. Never overwrites a valid live file, so
   *  editor-authored levels survive redeploys. No-op when no bundle path is configured (tests/dev). */
  private async seedMapsFile(): Promise<void> {
    if (!this.bundledMapsPath) return;
    let liveText: string | null = null, liveExists = false;
    try { liveText = await readFile(this.mapsPath, 'utf8'); liveExists = true; } catch { /* absent */ }
    let bundledText: string | null = null;
    try { bundledText = await readFile(this.bundledMapsPath, 'utf8'); } catch { /* no bundle */ }
    const plan = seedMapsPlan({ liveExists, liveText, bundledText });
    if (!plan.write) return;
    try {
      await this.writeFileAtomic(this.mapsPath, plan.contents);
      console.log(`[maps] seeded ${this.mapsPath} from bundled defaults (${this.bundledMapsPath})`);
    } catch (e) {
      console.error('[maps] seed write failed:', (e as Error).message);
    }
  }

  private async readKaraokeVenue(): Promise<KaraokeVenueConfig> {
    for (const file of [this.karaokeVenuePath, this.bundledKaraokeVenuePath]) {
      if (!file) continue;
      try { return parseKaraokeVenueConfig(JSON.parse(await readFile(file, 'utf8')) as unknown); }
      catch { /* Try the immutable seed, then the compiled fallback. */ }
    }
    return cloneKaraokeVenueConfig(DEFAULT_KARAOKE_VENUE);
  }

  /** Seed only when an image seed was configured, so injected test/dev paths remain isolated. */
  private async seedKaraokeVenueFile(): Promise<void> {
    if (!this.bundledKaraokeVenuePath) return;
    try {
      parseKaraokeVenueConfig(JSON.parse(await readFile(this.karaokeVenuePath, 'utf8')) as unknown);
      return;
    } catch { /* A missing or malformed live copy is repaired from a strict seed below. */ }
    let venue = cloneKaraokeVenueConfig(DEFAULT_KARAOKE_VENUE);
    try {
      venue = parseKaraokeVenueConfig(JSON.parse(await readFile(this.bundledKaraokeVenuePath, 'utf8')) as unknown);
    } catch (error) {
      console.error('[karaoke-venue] bundled seed invalid; using compiled default:', (error as Error).message);
    }
    try {
      await this.writeFileAtomic(this.karaokeVenuePath, `${JSON.stringify(venue, null, 2)}\n`);
      console.log(`[karaoke-venue] seeded ${this.karaokeVenuePath} from ${this.bundledKaraokeVenuePath}`);
    } catch (error) {
      console.error('[karaoke-venue] seed write failed:', (error as Error).message);
    }
  }

  private karaokeTimingEtag(config: KaraokeTimingConfig = this.karaokeTimingConfig): string {
    return `"karaoke-timings-${createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16)}"`;
  }

  private async loadKaraokeTimings(): Promise<void> {
    let config = EMPTY_KARAOKE_TIMING_CONFIG;
    try {
      config = parseKaraokeTimingConfig(
        JSON.parse(await readFile(this.karaokeTimingsPath, 'utf8')) as unknown,
        KARAOKE_DEVELOPMENT_SONGS,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') console.error('[karaoke-timings] invalid live config; using compiled timings:', (error as Error).message);
    }
    this.applyKaraokeTimings(config);
  }

  private applyKaraokeTimings(config: KaraokeTimingConfig): void {
    const songs = applyKaraokeTimingConfig(KARAOKE_DEVELOPMENT_SONGS, config);
    this.karaokeTimingConfig = config;
    this.karaoke.setSongs(songs);
    this.karaokeMedia.setSongs(songs);
  }

  private async saveKaraokeTimings(
    config: KaraokeTimingConfig,
    expectedEtag: string,
  ): Promise<{ config: KaraokeTimingConfig; etag: string }> {
    const operation = this.karaokeTimingWrite.then(async () => {
      const currentEtag = this.karaokeTimingEtag();
      if (expectedEtag !== currentEtag) {
        throw Object.assign(new Error('Karaoke timings changed; reload before saving'), {
          code: 'PRECONDITION_FAILED', etag: currentEtag,
        });
      }
      await this.writeFileAtomic(this.karaokeTimingsPath, `${JSON.stringify(config, null, 2)}\n`);
      this.applyKaraokeTimings(config);
      return { config, etag: this.karaokeTimingEtag(config) };
    });
    this.karaokeTimingWrite = operation.then(() => undefined, () => undefined);
    return operation;
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.roomConfigTimer) { clearInterval(this.roomConfigTimer); this.roomConfigTimer = null; }
      if (this.smsSweepTimer) { clearInterval(this.smsSweepTimer); this.smsSweepTimer = null; }
      for (const binding of this.racerVoiceCallBindings.values()) {
        if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
        binding.activeAdapter?.handleClose(true);
      }
      this.racerVoiceCallBindings.clear();
      for (const binding of this.battleVoiceCallBindings.values()) {
        if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
      }
      this.battleVoiceCallBindings.clear();
      for (const binding of this.fighterVoiceCallBindings.values()) if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
      this.fighterVoiceCallBindings.clear(); this.fighterVoice.clear();
      for (const binding of this.karaokeVoiceCallBindings.values()) if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
      this.karaokeVoiceCallBindings.clear(); this.karaokeVoice.clear(); this.voiceAccountSids.clear();
      for (const binding of this.triviaVoiceCallBindings.values()) {
        if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
        binding.activeSession?.handleReplaced();
      }
      this.triviaVoiceCallBindings.clear(); this.triviaVoice.clear();
      for (const binding of this.chessVoiceCallBindings.values()) {
        if (binding.leaveTimer) clearTimeout(binding.leaveTimer);
        this.analyticsObserver.chessAborted(binding.code);
        binding.activeSession?.handleReplaced();
      }
      this.chessVoiceCallBindings.clear(); this.chessVoice.clear();
      this.karaokeHandoffResponses.clear();
      for (const failure of this.karaokeFailureLocales.values()) clearTimeout(failure.timer);
      this.karaokeFailureLocales.clear();
      this.activeStationEngines.clear();
      this.standaloneDisplays.clear();
      this.publicTriviaDisplays.clear();
      for (const timer of this.pendingTriviaDisplays.values()) clearTimeout(timer);
      this.pendingTriviaDisplays.clear();
      this.game.stopLoopOnly();
      this.battle.stopLoopOnly();
      this.fighter.stopLoopOnly();
      this.karaokeMedia.close();
      this.karaoke.stopLoopOnly();
      this.trivia.stopLoopOnly();
      this.chess.stopLoopOnly();
      for (const socket of this.voiceSockets.keys()) {
        disposeRelayQueue(socket);
        socket.terminate();
      }
      this.voiceSockets.clear();
      this.voiceWss.close();
      const arcadeStop = this.arcadeApi?.stop() ?? Promise.resolve();
      const arcadeTacStop = this.arcadeTacGateway?.stop() ?? Promise.resolve();
      this.server.close(() => {
        void Promise.all([
          this.analytics.flush(),
          this.leaderboardWrite,
          this.triviaContent.flush(),
          this.triviaLeaderboard.flush(),
          ...this.triviaResultPersistence.values(),
          arcadeStop,
          arcadeTacStop,
        ]).then(() => resolve(), reject);
      });
    });
  }
}

const RELAY_END_GRACE_MS = 750;
const RELAY_END_TIMEOUT_MS = 90_000;
const RELAY_SPEECH_SETTLE_TIMEOUT_MS = 10_000;
type RelaySpeechOutcome = 'played' | 'estimated' | 'interrupted' | 'failed';
type RelayPlayback = {
  token: string;
  generation: number;
  isCurrent?: () => boolean;
  settle: (outcome?: RelaySpeechOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};
type RelayQueue = {
  tail: Promise<void>;
  generation: number;
  tokenSequence: number;
  pendingPlayback: RelayPlayback | null;
  ending: boolean;
  ended: boolean;
  endGraceScheduled: boolean;
  endTimer: ReturnType<typeof setTimeout> | null;
};
const relayQueues = new WeakMap<WebSocket, RelayQueue>();

function sendRelayHandoff(ws: WebSocket, handoff: KaraokeVoiceEndHandoff): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  const queue = relayQueue(ws);
  if (queue.ending || queue.ended) return false;
  queue.ended = true;
  queue.generation += 1;
  queue.tail = Promise.resolve();
  queue.pendingPlayback?.settle('interrupted');
  queue.pendingPlayback = null;
  if (queue.endTimer) clearTimeout(queue.endTimer);
  queue.endTimer = null;
  ws.send(JSON.stringify({ type: 'end', handoffData: handoff.handoffData }));
  return true;
}

function relayQueue(ws: WebSocket): RelayQueue {
  let queue = relayQueues.get(ws);
  if (!queue) {
    queue = { tail: Promise.resolve(), generation: 0, tokenSequence: 0, pendingPlayback: null, ending: false, ended:false, endGraceScheduled:false, endTimer: null };
    relayQueues.set(ws, queue);
  }
  return queue;
}

function sendRelayText(ws: WebSocket, text: string, locale: SupportedLocale = DEFAULT_LOCALE,
  isCurrent?: () => boolean): Promise<boolean> {
  return sendRelayTextOutcome(ws, text, locale, isCurrent).then(outcome =>
    outcome === 'played' || outcome === 'estimated');
}

export function sendRelayTextOutcome(ws: WebSocket, text: string, locale: SupportedLocale = DEFAULT_LOCALE,
  isCurrent?: () => boolean): Promise<RelaySpeechOutcome> {
  const chunks = relayTextChunks(text, locale);
  if (!chunks.length || ws.readyState !== ws.OPEN) return Promise.resolve('failed');
  if (isCurrent && !isCurrent()) return Promise.resolve('interrupted');
  const queue = relayQueue(ws);
  if(queue.ending||queue.ended)return Promise.resolve('failed');
  // A newer screen may replace a prior unplayed prompt immediately. The new token's
  // preemptible flag lets Conversation Relay stop the stale audio on the caller's phone.
  if (queue.pendingPlayback?.isCurrent && !queue.pendingPlayback.isCurrent()) clearRelayTextQueue(ws);
  const generation = queue.generation;
  const delivery = queue.tail.then(async (): Promise<RelaySpeechOutcome> => {
    if ((isCurrent && !isCurrent()) || generation !== queue.generation) return 'interrupted';
    if (ws.readyState !== ws.OPEN) return 'failed';
    // Twilio streams text tokens within one talk cycle. Completing every chunk as its own
    // last:true cycle allowed the next chunk to preempt unfinished ElevenLabs playback.
    // Keep the whole cue in one cycle; only a later, distinct screen/turn may preempt it.
    const marker = (++queue.tokenSequence).toString(2)
      .replace(/0/g, '\u2060').replace(/1/g, '\u200B');
    const wireTokens = chunks.map((chunk, index) =>
      `${index === 0 ? '' : ' '}${relaySpeechMarkup(chunk, locale)}`
      + (index === chunks.length - 1 ? marker : ''));
    const played = waitForRelayPlayback(queue, wireTokens.at(-1)!, generation,
      relayEstimatedSpeechMs(chunks.join(' '), locale), isCurrent);
    const playback = queue.pendingPlayback;
    for (let index = 0; index < wireTokens.length; index++) {
      if (generation !== queue.generation) break;
      if (ws.readyState !== ws.OPEN) { playback?.settle('failed'); break; }
      try {
        ws.send(JSON.stringify({ type: 'text', token: wireTokens[index],
          last: index === wireTokens.length - 1, lang: locale,
          interruptible: true, preemptible: true }), error => {
          if (error) playback?.settle('failed');
        });
      } catch {
        playback?.settle('failed');
        break;
      }
    }
    return played;
  });
  queue.tail = delivery.then(() => undefined, () => undefined);
  return delivery.catch(() => 'failed');
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function clearRelayTextQueue(ws: WebSocket, endImmediately = false): void {
  const queue = relayQueues.get(ws);
  if (!queue) return;
  queue.generation++;
  queue.tail = Promise.resolve();
  settleRelayPlayback(ws, 'interrupted');
  queue.endGraceScheduled = false;
  maybeEndRelay(ws, queue, endImmediately);
}

export function handleRelayPlaybackEvent(ws: WebSocket, raw: string): boolean {
  let message: unknown;
  try { message = JSON.parse(raw); } catch { return false; }
  const info = message as { type?: unknown; name?: unknown; value?: unknown };
  if (info.type !== 'info' || info.name !== 'tokensPlayed') return false;
  const queue = relayQueues.get(ws);
  if (!queue) return true;
  const playedText = typeof info.value === 'string' ? info.value : '';
  if (queue.pendingPlayback && playedText.endsWith(queue.pendingPlayback.token)) {
    queue.pendingPlayback.settle('played');
  }
  maybeEndRelay(ws, queue);
  return true;
}

function relayEstimatedSpeechMs(text: string, locale: SupportedLocale): number {
  // Twilio documents a tokens-played subscription but not its exact WebSocket payload.
  // Use a conservative speech-duration fallback; a matching tokensPlayed event settles
  // earlier. This estimate is never proof that the caller heard the audio.
  const charsPerSecond = locale === 'pt-BR' ? 9 : 10;
  const punctuationPauseMs = (text.match(/[.!?;:]/g)?.length ?? 0) * 180;
  return Math.min(120_000, Math.max(1_200,
    Math.ceil(text.length / charsPerSecond * 1_000) + punctuationPauseMs + 1_500));
}

function waitForRelayPlayback(queue: RelayQueue, token: string, generation: number,
  estimatedMs: number,
  isCurrent?: () => boolean): Promise<RelaySpeechOutcome> {
  return new Promise(resolve => {
    let settled = false;
    const settle = (outcome: RelaySpeechOutcome = 'failed') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (queue.pendingPlayback?.settle === settle) queue.pendingPlayback = null;
      resolve(outcome);
    };
    const timer = setTimeout(() => settle('estimated'), estimatedMs);
    timer.unref?.();
    queue.pendingPlayback = { token, generation, isCurrent, settle, timer };
  });
}

function settleRelayPlayback(ws: WebSocket, outcome: RelaySpeechOutcome = 'interrupted'): void {
  relayQueues.get(ws)?.pendingPlayback?.settle(outcome);
}

function isRelayInterrupt(raw: string): boolean {
  try { return JSON.parse(raw)?.type === 'interrupt'; }
  catch { return false; }
}

function isRelayDtmf(raw: string): boolean {
  try { return JSON.parse(raw)?.type === 'dtmf'; }
  catch { return false; }
}

function isRelayTtsError(raw: string): boolean {
  try {
    const message = JSON.parse(raw);
    return message?.type === 'error' && /\b641(?:06|07|11|12)\b/.test(
      `${String(message.code ?? '')} ${String(message.description ?? '')}`);
  } catch { return false; }
}

function endRelayAfterPlayback(ws: WebSocket): void {
  const queue = relayQueue(ws);
  if (queue.ending||queue.ended) return;
  queue.ending = true;
  queue.endTimer = setTimeout(() => sendRelayEnd(ws, queue), RELAY_END_TIMEOUT_MS);
  queue.endTimer.unref?.();
  void queue.tail.then(() => {
    if(!queue.ending)return;
    maybeEndRelay(ws, queue);
  });
}

function maybeEndRelay(ws: WebSocket, queue: RelayQueue, immediately = false): void {
  if (!queue.ending || queue.pendingPlayback) return;
  void queue.tail.then(() => {
    if (!queue.ending || queue.pendingPlayback) return;
    if (immediately) { sendRelayEnd(ws, queue); return; }
    if (queue.endGraceScheduled) return;
    queue.endGraceScheduled = true;
    if (queue.endTimer) clearTimeout(queue.endTimer);
    queue.endTimer = setTimeout(() => sendRelayEnd(ws, queue), RELAY_END_GRACE_MS);
    queue.endTimer.unref?.();
  });
}

function sendRelayEnd(ws: WebSocket, queue: RelayQueue): void {
  if (!queue.ending||queue.ended) return;
  queue.ending = false;
  queue.ended=true;
  queue.generation++;
  queue.tail=Promise.resolve();
  queue.pendingPlayback?.settle('interrupted');
  queue.pendingPlayback=null;
  queue.endGraceScheduled=false;
  if (queue.endTimer) clearTimeout(queue.endTimer);
  queue.endTimer = null;
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type: 'end', handoffData: JSON.stringify({ reasonCode: 'match-complete' }) }));
  }
}

function disposeRelayQueue(ws: WebSocket): void {
  const queue = relayQueues.get(ws);
  if (queue?.endTimer) clearTimeout(queue.endTimer);
  queue?.pendingPlayback?.settle('failed');
  relayQueues.delete(ws);
}

const MAX_RELAY_SPEECH_CHARS = 8_000;
const MAX_RELAY_TOKEN_CHARS = 500;

export function relayTextChunks(text: string, locale: SupportedLocale = DEFAULT_LOCALE): string[] {
  const safe = speechSafeText(text, Number.MAX_SAFE_INTEGER, locale);
  if (!safe || safe.length > MAX_RELAY_SPEECH_CHARS) return [];
  const controls = splitControlText(safe);
  const segments = controls.length > 1 ? controls : [safe];
  const chunks: string[] = [];
  for (const segment of segments) {
    let remaining = segment;
    while (remaining.length > MAX_RELAY_TOKEN_CHARS) {
      const space = remaining.lastIndexOf(' ', MAX_RELAY_TOKEN_CHARS);
      const boundary = space >= MAX_RELAY_TOKEN_CHARS / 2 ? space : MAX_RELAY_TOKEN_CHARS;
      chunks.push(remaining.slice(0, boundary));
      remaining = remaining.slice(boundary).trimStart();
    }
    if (remaining) chunks.push(remaining);
  }
  return chunks;
}

export function relaySpeechMarkup(text: string, locale: SupportedLocale = DEFAULT_LOCALE): string {
  return locale === 'en-US'
    ? text.replace(/\bTwilio\b/gi, '<phoneme alphabet="ipa" ph="ˈtwɪlioʊ">Twilio</phoneme>')
    : text;
}

function selectionNumberHints(locale: SupportedLocale): string[] {
  return locale === 'pt-BR'
    ? ['um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'primeiro', 'segundo', 'terceiro', 'quarto', 'quinto']
    : ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'first', 'second', 'third', 'fourth', 'fifth'];
}

const MAX_RELAY_HINT_TERMS = 100;

function voiceHintList(...groups: readonly (readonly string[])[]): string {
  const hints: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const value of group) {
      const hint = value.trim();
      const key = hint.toLowerCase();
      if (!hint || seen.has(key)) continue;
      hints.push(hint);
      seen.add(key);
      if (hints.length === MAX_RELAY_HINT_TERMS) return hints.join(', ');
    }
  }
  return hints.join(', ');
}

function splitControlText(text: string): string[] {
  const lower = text.toLowerCase();
  const isInstruction = lower.includes('say ') || lower.includes('voice controls') || lower.includes('quick rules') || lower.includes('how to play') || lower.includes('controls on the screen')
    || lower.includes('diga ') || lower.includes('comandos de voz') || lower.includes('regras') || lower.includes('como jogar') || lower.includes('controles na tela');
  if (!isInstruction || text.length < 90) return [];
  return text
    .replace(/:\s+/g, '. ')
    .replace(/;\s+/g, '. ')
    .replace(/\s+or\s+say\s+/gi, '. Or say ')
    .replace(/\s+ou\s+diga\s+/gi, '. Ou diga ')
    .replace(/\s+and\s+nitro\s+/gi, '. And nitro ')
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** Map a filename to a Content-Type for the static server (covers the built client + GLB models). */
export function contentType(name: string): string {
  const ext = name.slice(name.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': case '.mjs': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.mp4': return 'video/mp4';
    case '.woff2': return 'font/woff2';
    case '.woff': return 'font/woff';
    case '.ttf': return 'font/ttf';
    // .otf served as octet-stream → some browsers refuse to apply the @font-face, silently falling
    // back to a system font (why the branded Twilio Sans numbers looked different in prod vs. dev,
    // where Vite sent the right type). The Twilio Sans faces are all .otf.
    case '.otf': return 'font/otf';
    case '.glb': return 'model/gltf-binary';
    case '.wasm': return 'application/wasm';
    case '.ico': return 'image/x-icon';
    // Audio (shared-screen background music) — a decodable Content-Type so the browser's Web Audio
    // API will fetch + decode them (application/octet-stream is refused by some decoders).
    case '.mp3': return 'audio/mpeg';
    case '.ogg': return 'audio/ogg';
    case '.wav': return 'audio/wav';
    case '.m4a': case '.aac': return 'audio/mp4';
    default: return 'application/octet-stream';
  }
}

function readBody(req: http.IncomingMessage, maximumBytes = 64 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maximumBytes) {
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      data += c;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function isLoopbackUrl(value: string): boolean {
  try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(value).hostname); }
  catch { return false; }
}

export function karaokeBrowserTestingAllowed(nodeEnv: string | undefined, publicBaseUrl: string): boolean {
  return nodeEnv !== 'production' && isLoopbackUrl(publicBaseUrl);
}

export function triviaLocalKeyboardTestingAllowed(
  nodeEnv: string | undefined,
  publicBaseUrl: string,
  roomCode: string,
  stationManaged: boolean,
): boolean {
  return nodeEnv !== 'production' && isLoopbackUrl(publicBaseUrl) && !stationManaged
    && roomCode.trim().toUpperCase() === DEFAULT_ROOM;
}

export function resolveVoiceRelayToken(
  publicBaseUrl: string,
  dedicatedToken?: string,
  twilioAuthToken?: string,
  nodeEnv = process.env.NODE_ENV,
): string {
  const dedicated = dedicatedToken?.trim() ?? '';
  if (dedicated) return dedicated;
  return nodeEnv !== 'production' && isLoopbackUrl(publicBaseUrl) ? twilioAuthToken?.trim() ?? '' : '';
}

export function isSecureKaraokeMediaRequest(
  request: http.IncomingMessage,
  publicBaseUrl: string,
): boolean {
  if ((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted === true) return true;
  let publicProtocol: string;
  try { publicProtocol = new URL(publicBaseUrl).protocol; }
  catch { return false; }
  const forwarded = request.headers['x-forwarded-proto'];
  const value = Array.isArray(forwarded) ? forwarded.length === 1 ? forwarded[0] : undefined : forwarded;
  return publicProtocol === 'https:' && value?.trim().toLowerCase() === 'https';
}

function validProviderIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9_-]+$/.test(value);
}

function deriveTriviaAnonymizationSalt(secret: string): string {
  const root = secret.trim() || 'twilio-games-local';
  return createHash('sha256').update(`trivia-leaderboard-anonymization-v1\0${root}`).digest('hex');
}

function triviaIdentityNamespace(roomCode: string): string {
  const normalized = roomCode.trim().toUpperCase();
  if (/^[A-Z0-9](?:[A-Z0-9-]{0,62}[A-Z0-9])?$/.test(normalized)) return `trivia-room:${normalized}`;
  return `trivia-room:${createHash('sha256').update(normalized).digest('hex').slice(0, 32)}`;
}

export function triviaLeaderboardResultId(roomCode: string, result: TriviaResult): string {
  const players = result.players
    .map(player => [player.playerId, player.rawScore, player.normalizedScore] as const)
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2]);
  const canonical = JSON.stringify([
    'trivia-leaderboard-result-v1',
    roomCode.trim().toUpperCase(),
    result.resultId,
    result.completedAtMs,
    result.category,
    players,
  ]);
  return `trivia:${createHash('sha256').update(canonical).digest('hex')}`;
}

function karaokeHandoffResponseKey(params: Record<string, string>): string {
  const canonical = Object.keys(params).sort().map(key => `${key}\u0000${params[key]}`).join('\u0001');
  return createHash('sha256').update(canonical).digest('base64url');
}

const KARAOKE_LIFECYCLE_ORDER: Record<KaraokeVoiceCallBinding['lifecycle'], number> = {
  setup: 0,
  'handoff-pending': 1,
  'media-issued': 2,
  'media-started': 3,
  'media-finalized': 4,
  completed: 5,
  failed: 6,
};

function transitionKaraokeLifecycle(
  binding: KaraokeVoiceCallBinding,
  next: KaraokeVoiceCallBinding['lifecycle'],
): boolean {
  if (KARAOKE_LIFECYCLE_ORDER[next] < KARAOKE_LIFECYCLE_ORDER[binding.lifecycle]) return false;
  binding.lifecycle = next;
  return true;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled game: ${String(value)}`);
}

function isKaraokeHandoffData(raw: string): boolean {
  if (!raw || raw.length > 2_048) return false;
  try { return JSON.parse(raw)?.reasonCode === 'karaoke-media'; }
  catch { return false; }
}

function parseKaraokeHandoffData(raw: string): Omit<KaraokeHandoffIntent, 'handoffData'> | null {
  if (!isKaraokeHandoffData(raw)) return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw) as Record<string, unknown>; }
  catch { return null; }
  const expected = ['loadingGeneration', 'locale', 'playerId', 'reasonCode', 'roomCode', 'songId'];
  if (Object.keys(value).sort().join('\u0000') !== expected.sort().join('\u0000')
    || typeof value.roomCode !== 'string' || typeof value.playerId !== 'string'
    || typeof value.songId !== 'string' || !Number.isSafeInteger(value.loadingGeneration)
    || (value.locale !== 'en-US' && value.locale !== 'pt-BR')) return null;
  return {
    roomCode: value.roomCode,
    playerId: value.playerId,
    songId: value.songId,
    loadingGeneration: value.loadingGeneration as number,
    locale: value.locale,
  };
}

function readBinaryBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += buffer.length;
      if (size > max) { req.destroy(); reject(new Error('request body too large')); return; }
      chunks.push(buffer);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
