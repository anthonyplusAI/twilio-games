import type http from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ArcadeConfigValidationError,
  parseArcadeConfigSettings,
  projectPublicArcadeConfig,
  replaceArcadeConfigSettings,
  type ArcadeGame,
  type ArcadeConfigSnapshot,
} from '../shared/arcade-config';
import { ArcadeDomainError, type LeadInput } from '../shared/arcade-domain';
import { ArcadeQueueError } from '../shared/arcade-queue';
import {
  isPlayableArcadeGame,
  PLAYABLE_ARCADE_GAMES,
  type PlayableArcadeGame,
} from '../shared/arcade-games';
import { ArcadeStationError } from '../shared/arcade-station';
import type { StationEngineParticipantResult } from '../shared/arcade-station';
import {
  ArcadeConfigDegradedError,
  ArcadeConfigIdempotencyConflictError,
  ArcadeConfigStore,
  ArcadeConfigStoreError,
  ArcadeConfigVersionConflictError,
} from './arcade-config-store';
import {
  ARCADE_CONFIG_UPDATED_EVENT,
  ArcadeEventHub,
  type ArcadeEvent,
} from './arcade-events';
import {
  ArcadePlayerRuntime,
  ArcadePlayerRuntimeError,
} from './arcade-player-runtime';
import type {
  StationMatchParticipantsChangedHandler,
  StationMatchRemoval,
} from './arcade-station-runtime';
import {
  ArcadePlayerSessionError,
  type ArcadePlayerSessionService,
} from './arcade-player-session';
import { ArcadeRateLimiter } from './arcade-rate-limiter';
import {
  ARCADE_MESSAGING_RETENTION_MS,
  ArcadeServiceError,
  type ArcadeOperatorQueueStatus,
  type ArcadeQueueStatus,
} from './arcade-service';
import { ArcadeStateStoreError, type ArcadeState } from './arcade-state-store';
import {
  ArcadeMessagingRetryError,
  recordArcadeMessagingStatus,
} from './arcade-messaging-runtime';
import {
  emptyPublicStation,
  projectDisplayStation,
  projectOperatorStation,
  projectPlayerStation,
  projectPublicStation,
  stationAggregateFromState,
} from './arcade-station-projection';
import {
  ARCADE_CHALLENGE_TOKEN_MAX_TTL_SECONDS,
  ARCADE_CHALLENGE_TOKEN_VERSION,
} from './arcade-challenge-token';

const ADMIN_CONFIG_BODY_LIMIT = 512 * 1024;
const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_MAX_EVENT_STREAMS = 100;
const IDEMPOTENCY_KEY_LIMIT = 255;
const PLAYER_IDEMPOTENCY_KEY_LIMIT = 128;
const SESSION_BODY_LIMIT = 2 * 1024;
const REGISTRATION_BODY_LIMIT = 8 * 1024;
const QUEUE_BODY_LIMIT = 4 * 1024;
const CHALLENGE_BODY_LIMIT = 8 * 1024;
const STATION_BODY_LIMIT = 4 * 1024;
const DISPLAY_CONNECT_BODY_LIMIT = 2 * 1024;
const DISPLAY_PRESENCE_TIMEOUT_MS = 20_000;
const DEFAULT_MESSAGING_ADDRESS_LIMIT = 30;
const DEFAULT_MESSAGING_ADDRESS_WINDOW_MS = 10 * 60_000;
const DEFAULT_MESSAGING_PROCESS_LIMIT = 600;
const DEFAULT_MESSAGING_PROCESS_WINDOW_MS = 60_000;
const STANDALONE_MESSAGING_MAX_RECORDS = 5_000;
type RoutedStationGame = PlayableArcadeGame;

export interface ArcadeAdminPrincipal {
  readonly email: string;
}

export interface PlayerResetCleanupContext {
  readonly nameHashes: readonly string[];
  readonly racers: readonly Readonly<{
    game: RoutedStationGame;
    roomCode: string;
    enginePlayerId: string;
    completedAt: string | null;
    durationSeconds: number | null;
  }>[];
}

export interface ArcadeApiOptions {
  readonly configStore: ArcadeConfigStore;
  readonly events: ArcadeEventHub;
  readonly authorizeAdmin: (request: http.IncomingMessage) => ArcadeAdminPrincipal | null;
  readonly publicBaseUrl: string;
  readonly heartbeatMs?: number;
  readonly maxEventStreams?: number;
  readonly tacStatus?: () => unknown;
  readonly tacRequired?: boolean;
  readonly playerRuntime?: ArcadePlayerRuntime;
  readonly now?: () => number;
  readonly displayToken?: string;
  readonly fallbackVoiceNumber?: string;
  readonly messagingCapabilities?: Readonly<{ sms: boolean; whatsapp: boolean }>;
  readonly messagingProfileNameReady?: (identity: {
    profileId: string; firstName: string; locale: 'en-US' | 'pt-BR'; phoneNumber: string;
  }) => void;
  readonly deleteMemoryProfile?: (profileId: string) => Promise<void>;
  readonly memoryProfileDeleted?: (profileId: string) => boolean;
  readonly shortenUrl?: (url: string, key: string) => Promise<string | null>;
  readonly inboundMessagingRateLimits?: Readonly<{
    addressLimit?: number;
    addressWindowMs?: number;
    processLimit?: number;
    processWindowMs?: number;
  }>;
}

type EventStream = {
  readonly response: http.ServerResponse;
  readonly close: () => void;
};

class ArcadeHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'ArcadeHttpError';
  }
}

export class ArcadeApi {
  private readonly configStore: ArcadeConfigStore;
  private readonly events: ArcadeEventHub;
  private readonly authorizeAdmin: ArcadeApiOptions['authorizeAdmin'];
  private readonly expectedOrigin: string;
  private readonly heartbeatMs: number;
  private readonly maxEventStreams: number;
  private readonly tacStatus?: () => unknown;
  private readonly tacRequired: boolean;
  private readonly playerRuntime?: ArcadePlayerRuntime;
  private readonly now: () => number;
  private readonly rateLimiter: ArcadeRateLimiter;
  private readonly processRateLimiter: ArcadeRateLimiter;
  private readonly displayToken: Buffer;
  private readonly displayPresenceStartedAt: number;
  private displayLastSeenAt: number | null = null;
  private readonly fallbackVoiceNumber: string | null;
  private readonly messagingCapabilities: Readonly<{ sms: boolean; whatsapp: boolean }>;
  private readonly messagingProfileNameReady?: ArcadeApiOptions['messagingProfileNameReady'];
  private readonly deleteMemoryProfile?: ArcadeApiOptions['deleteMemoryProfile'];
  private readonly memoryProfileDeleted?: ArcadeApiOptions['memoryProfileDeleted'];
  private readonly shortenUrl?: ArcadeApiOptions['shortenUrl'];
  private readonly inboundMessagingRateLimits: Readonly<{
    addressLimit: number;
    addressWindowMs: number;
    processLimit: number;
    processWindowMs: number;
  }>;
  private readonly streams = new Set<EventStream>();
  private readonly stationRoomCodes = new Set<string>();
  private readonly messagingProfilesByAddress = new Map<string, string>();
  private unsubscribeStationCache: (() => void) | null = null;
  private readonly stationVoiceCalls = new Map<string, { callSid: string; readyEntryId: string }>();
  private readonly stationVoiceConnections = new Map<string, string>();
  private abortStationEngine: ((game: RoutedStationGame, roomCode: string, removal: StationMatchRemoval) => void) | null = null;
  private updateStationEngineParticipants: StationMatchParticipantsChangedHandler | null = null;
  private playerResetCleanup: ((context: PlayerResetCleanupContext) => Promise<void>) | null = null;
  private started = false;
  private stopped = false;

  constructor(options: ArcadeApiOptions) {
    this.configStore = options.configStore;
    this.events = options.events;
    this.authorizeAdmin = options.authorizeAdmin;
    this.expectedOrigin = new URL(options.publicBaseUrl).origin;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.maxEventStreams = options.maxEventStreams ?? DEFAULT_MAX_EVENT_STREAMS;
    this.tacStatus = options.tacStatus;
    this.tacRequired = options.tacRequired === true;
    this.playerRuntime = options.playerRuntime;
    this.messagingProfileNameReady = options.messagingProfileNameReady;
    this.deleteMemoryProfile = options.deleteMemoryProfile;
    this.memoryProfileDeleted = options.memoryProfileDeleted;
    this.shortenUrl = options.shortenUrl;
    this.now = options.now ?? Date.now;
    this.displayPresenceStartedAt = this.now();
    this.displayToken = Buffer.from(options.displayToken?.trim() ?? '', 'utf8');
    const fallbackVoiceNumber = options.fallbackVoiceNumber?.trim() ?? '';
    this.fallbackVoiceNumber = /^\+[1-9][0-9]{7,14}$/.test(fallbackVoiceNumber)
      ? fallbackVoiceNumber
      : null;
    this.messagingCapabilities = Object.freeze({
      sms: options.messagingCapabilities?.sms === true,
      whatsapp: options.messagingCapabilities?.whatsapp === true,
    });
    this.inboundMessagingRateLimits = Object.freeze({
      addressLimit: options.inboundMessagingRateLimits?.addressLimit
        ?? DEFAULT_MESSAGING_ADDRESS_LIMIT,
      addressWindowMs: options.inboundMessagingRateLimits?.addressWindowMs
        ?? DEFAULT_MESSAGING_ADDRESS_WINDOW_MS,
      processLimit: options.inboundMessagingRateLimits?.processLimit
        ?? DEFAULT_MESSAGING_PROCESS_LIMIT,
      processWindowMs: options.inboundMessagingRateLimits?.processWindowMs
        ?? DEFAULT_MESSAGING_PROCESS_WINDOW_MS,
    });
    this.rateLimiter = new ArcadeRateLimiter(this.now);
    this.processRateLimiter = new ArcadeRateLimiter(this.now, 16);
    if (!Number.isSafeInteger(this.heartbeatMs) || this.heartbeatMs < 10) {
      throw new TypeError('Arcade API heartbeatMs must be an integer of at least 10ms');
    }
    if (!Number.isSafeInteger(this.maxEventStreams) || this.maxEventStreams < 1) {
      throw new TypeError('Arcade API maxEventStreams must be a positive integer');
    }
    if (Object.values(this.inboundMessagingRateLimits)
      .some(value => !Number.isSafeInteger(value) || value < 1)) {
      throw new TypeError('Arcade API inbound messaging rate limits must be positive integers');
    }
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error('Arcade API cannot restart after it has stopped');
    if (this.started) return;
    await this.configStore.load();
    await this.playerRuntime?.start();
    const resources = this.playerRuntime?.getInitializedResources();
    if (resources) this.bindStationAbortHandler(resources);
    this.unsubscribeStationCache = this.events.subscribe(event => {
      if (event.type === 'arcade_station_updated' || event.type === ARCADE_CONFIG_UPDATED_EVENT) {
        void this.refreshStationRoomCache();
      }
    });
    await this.refreshStationRoomCache();
    this.started = true;
  }

  getHealthStatus(): { degraded: boolean } {
    const players = this.playerRuntime?.getStatus();
    return {
      degraded: this.configStore.getStatus().degraded
        || this.stationCapabilityIssue(this.configStore.getSnapshot()) !== null
        || (this.configStore.getSnapshot().arcade.mode !== 'off' && !this.tacMessagingReady())
        || Boolean(players && players.mode !== 'off' && players.degraded),
    };
  }

  async activateMessagingDelivery(): Promise<void> {
    await this.playerRuntime?.activateMessagingDelivery();
  }

  getVoiceNumbers(): Readonly<Record<'en-US' | 'pt-BR', string | null>> {
    return this.effectiveVoiceNumbers(this.configStore.getSnapshot());
  }

  standaloneVoiceAvailable(): boolean {
    const config = this.configStore.getSnapshot();
    return config.channels.voice
      && Object.values(config.station.games).some(game => game.enabled)
      && Object.values(this.effectiveVoiceNumbers(config)).some(number => number !== null);
  }
  standaloneGameEnabled(game: PlayableArcadeGame): boolean {
    return this.configStore.getSnapshot().station.games[game].enabled;
  }

  async messagingLocaleForAddress(providerAddress: string): Promise<'en-US' | 'pt-BR' | null> {
    if (!this.playerRuntime) return null;
    const channel = providerAddress.toLowerCase().startsWith('whatsapp:') ? 'whatsapp' : 'sms';
    const normalizedAddress = providerAddress.replace(/^whatsapp:/i, '').trim();
    if (!normalizedAddress) return null;
    const state = await this.playerRuntime.getStateStoreForCleanup()
      .then(store => store.read())
      .catch(() => null);
    const locale = Object.values(state?.channelAddresses ?? {}).find(address => (
      address.channel === channel && address.normalizedAddress === normalizedAddress
    ))?.preferredLocale;
    if (locale === 'en-US' || locale === 'pt-BR') return locale;
    const localeKey = `standalone-locale:${createHash('sha256')
      .update(`${channel}:${normalizedAddress}`)
      .digest('hex')}`;
    const remembered = state?.idempotencyRecords[localeKey];
    const rememberedLocale = remembered?.operation === 'PROCESS_STATION_MESSAGE'
      && Date.parse(remembered.createdAt) >= this.now() - ARCADE_MESSAGING_RETENTION_MS
      ? (remembered.result as { locale?: unknown }).locale
      : null;
    return rememberedLocale === 'en-US' || rememberedLocale === 'pt-BR' ? rememberedLocale : null;
  }

  canonicalStationEnginePlayerId(enginePlayerId: string): string {
    return this.playerRuntime?.getInitializedResources()?.station.canonicalEnginePlayerId(enginePlayerId)
      ?? enginePlayerId;
  }

  authorizeOperatorRequest(request: http.IncomingMessage): ArcadeAdminPrincipal | null {
    try { return this.authorizeAdmin(request); }
    catch { return null; }
  }

  setStationAbortHandler(
    handler: (game: RoutedStationGame, roomCode: string, removal: StationMatchRemoval) => void,
  ): void {
    this.abortStationEngine = handler;
    this.playerRuntime?.setStationMatchRemovedHandler((game, roomCode, removal) => {
      this.removeLiveStationEngine(game, roomCode, removal);
    });
    const resources = this.playerRuntime?.getInitializedResources();
    if (resources) this.bindStationAbortHandler(resources);
  }

  setStationParticipantCountHandler(
    handler: StationMatchParticipantsChangedHandler,
  ): void {
    this.updateStationEngineParticipants = handler;
    const resources = this.playerRuntime?.getInitializedResources();
    if (resources) this.bindStationAbortHandler(resources);
  }

  setPlayerResetCleanupHandler(handler: (context: PlayerResetCleanupContext) => Promise<void>): void {
    this.playerResetCleanup = handler;
  }

  private effectiveVoiceNumbers(
    config: ArcadeConfigSnapshot,
  ): Readonly<Record<'en-US' | 'pt-BR', string | null>> {
    const configured = config.channels.voiceNumbers;
    const hasRuntimeNumber = configured['en-US'] !== null || configured['pt-BR'] !== null;
    return Object.freeze({
      'en-US': hasRuntimeNumber ? configured['en-US'] : this.fallbackVoiceNumber,
      'pt-BR': hasRuntimeNumber ? configured['pt-BR'] : this.fallbackVoiceNumber,
    });
  }

  voiceLocaleForNumber(number: string): 'en-US' | 'pt-BR' | null {
    const normalized = number.trim();
    if (!/^\+[1-9][0-9]{7,14}$/.test(normalized)) return null;
    const matches = Object.entries(this.getVoiceNumbers())
      .filter(([, candidate]) => candidate === normalized)
      .map(([locale]) => locale as 'en-US' | 'pt-BR');
    return matches.length === 1 ? matches[0]! : null;
  }

  async processMessagingWebhook(input: {
    from: string;
    body: string;
    providerMessageId: string;
    conversationProfileId?: string | null;
    conversationId?: string | null;
    recalledLocale?: 'en-US' | 'pt-BR' | null;
  }): Promise<string | null> {
    const config = this.configStore.getSnapshot();
    const providerAddress = input.from.trim();
    const channel = providerAddress.toLowerCase().startsWith('whatsapp:') ? 'whatsapp' : 'sms';
    const normalizedAddress = providerAddress.replace(/^whatsapp:/i, '');
    const conversationProfileId = input.conversationProfileId?.trim() || null;
    if (!/^\+[1-9][0-9]{7,14}$/.test(normalizedAddress)
      || !input.providerMessageId || input.providerMessageId.length > 256) {
      throw new ArcadeHttpError(400, 'INVALID_PROVIDER_MESSAGE', 'messaging provider identity is invalid');
    }
    const explicitLanguage = /\bLANG\s+(pt(?:-BR)?|en(?:-US)?)\b/i.exec(input.body)?.[1]
      ?? (/^\s*ENTRAR(?:\s|$)/i.test(input.body) ? 'pt-BR' : null)
      ?? (/^\s*JOIN(?:\s|$)/i.test(input.body) ? 'en-US' : null);
    let language = explicitLanguage ?? input.recalledLocale ?? 'en-US';
    const key = `provider:${createHash('sha256')
      .update(input.providerMessageId)
      .digest('hex')}`;
    const requestFingerprint = createHash('sha256').update(JSON.stringify({
      body: input.body.trim(), channel,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(conversationProfileId ? { conversationProfileId } : {}),
      normalizedAddress, providerAddress, providerMessageId: input.providerMessageId,
    })).digest('hex');
    const fallbackFingerprint = createHash('sha256').update(JSON.stringify({
      body: input.body.trim(), channel, normalizedAddress, providerAddress,
      providerMessageId: input.providerMessageId,
    })).digest('hex');
    const standaloneLocaleKey = `standalone-locale:${createHash('sha256')
      .update(`${channel}:${normalizedAddress}`)
      .digest('hex')}`;
    const stateStore = this.playerRuntime
      ? await this.playerRuntime.getStateStoreForCleanup()
      : null;
    if (stateStore) {
      const storedState = await stateStore.read();
      const receipt = storedState.inboundMessages[key];
      if (receipt) {
        if (receipt.requestFingerprint !== requestFingerprint) {
          if (!input.conversationProfileId && !input.conversationId
            && receipt.requestFingerprint === fallbackFingerprint) return receipt.reply;
          if ((!input.conversationProfileId && !input.conversationId)
            || receipt.requestFingerprint !== fallbackFingerprint) {
            throw new ArcadeHttpError(409, 'IDEMPOTENCY_CONFLICT', 'provider message ID was reused');
          }
          // Direct /sms fallback already returned this reply. An enriched Orchestrator replay should
          // attach no second response, otherwise the player receives duplicate messages.
          return null;
        }
        return receipt.reply;
      }
      if(!explicitLanguage&&!input.recalledLocale){
        const knownAddress=Object.values(storedState.channelAddresses).find(address=>(
          address.channel===channel&&address.normalizedAddress===normalizedAddress
        ));
        const latestLinkedAddress = channel === 'sms'
          ? Object.values(storedState.channelAddresses)
            .filter(address => address.normalizedAddress === normalizedAddress)
            .sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt))[0]
          : null;
        if (latestLinkedAddress) language = latestLinkedAddress.preferredLocale;
        else if (knownAddress) language = knownAddress.preferredLocale;
        else {
          const remembered = storedState.idempotencyRecords[standaloneLocaleKey];
          const rememberedLocale = remembered?.operation === 'PROCESS_STATION_MESSAGE'
            && Date.parse(remembered.createdAt) >= this.now() - ARCADE_MESSAGING_RETENTION_MS
            ? (remembered.result as { locale?: unknown }).locale
            : null;
          if (rememberedLocale === 'en-US' || rememberedLocale === 'pt-BR') language = rememberedLocale;
        }
      }
    }
    const addressRate = this.rateLimiter.consume(
      `messaging-inbound-address:${normalizedAddress}`,
      this.inboundMessagingRateLimits.addressLimit,
      this.inboundMessagingRateLimits.addressWindowMs,
    );
    if (!addressRate.allowed) return messagingRateLimitReply(language);
    const processRate = this.processRateLimiter.consume(
      'messaging-inbound-process',
      this.inboundMessagingRateLimits.processLimit,
      this.inboundMessagingRateLimits.processWindowMs,
    );
    if (!processRate.allowed) return messagingRateLimitReply(language);
    if (config.arcade.mode === 'off') {
      const locale = String(language).toLowerCase().startsWith('pt') ? 'pt-BR' : 'en-US';
      const standaloneAvailable = config.channels.voice
        && Object.values(config.station.games).some(game => game.enabled)
        && this.effectiveVoiceNumbers(config)[locale] !== null;
      const reply = standaloneAvailable
        ? locale === 'pt-BR'
          ? 'O jogo independente está ativo. Escolha um jogo na tela principal e escaneie o QR da sala para ligar e jogar por voz.'
          : "Standalone play is active. Choose a game on the display, then scan that lobby's call QR to play by voice."
        : locale === 'pt-BR'
          ? 'Os jogos por voz não estão disponíveis agora. Peça ajuda à equipe.'
          : 'Voice games are unavailable right now. Please ask booth staff for help.';
      if (stateStore) {
        const at = new Date(this.now()).toISOString();
        const localeFingerprint = createHash('sha256')
          .update(JSON.stringify({ channel, normalizedAddress, locale }))
          .digest('hex');
        await stateStore.transaction(state => {
          pruneStandaloneMessagingState(state, this.now());
          if (!state.inboundMessages[key]) {
            state.idempotencyRecords[key] = {
              key, operation: 'PROCESS_STATION_MESSAGE', playerId: null,
              fingerprint: requestFingerprint, result: { reply }, configVersion: config.version,
              createdAt: at,
            };
            state.inboundMessages[key] = {
              id: key, providerMessageId: input.providerMessageId, channelAddressId: null,
              requestFingerprint, command: 'STANDALONE', reply, receivedAt: at,
              configVersion: config.version,
            };
          }
          state.idempotencyRecords[standaloneLocaleKey] = {
            key: standaloneLocaleKey, operation: 'PROCESS_STATION_MESSAGE', playerId: null,
            fingerprint: localeFingerprint, result: { locale }, configVersion: config.version,
            createdAt: at,
          };
          const knownAddress = Object.values(state.channelAddresses).find(address => (
            address.channel === channel && address.normalizedAddress === normalizedAddress
          ));
          if (knownAddress) {
            state.channelAddresses[knownAddress.id] = { ...knownAddress, preferredLocale: locale, lastSeenAt: at };
            const player = state.players[knownAddress.playerId];
            if (player) state.players[player.id] = { ...player, preferredLocale: locale, updatedAt: at };
          }
        });
      }
      return reply;
    }
    const portuguese = String(language).toLowerCase().startsWith('pt');
    const channelPolicyAttempt = channel === 'sms' && portuguese;
    const smsAvailable = config.channels.sms && this.messagingCapabilities.sms;
    const whatsappAvailable = config.channels.whatsapp && this.messagingCapabilities.whatsapp;
    const channelAvailable = channel === 'sms' ? smsAvailable : whatsappAvailable;
    if (!channelAvailable && !channelPolicyAttempt) {
      const browserAvailable = config.arcade.mode === 'lead_capture';
      if (portuguese) {
        if (whatsappAvailable && browserAvailable) {
          return 'Use o WhatsApp (recomendado) ou escaneie o QR e continue no navegador.';
        }
        if (whatsappAvailable) return 'Use o WhatsApp para entrar em português.';
        if (browserAvailable) return 'Escaneie o QR e continue no navegador.';
        return 'A entrada em português não está disponível agora. Peça ajuda à equipe.';
      }
      const alternativeAvailable = channel === 'sms' ? whatsappAvailable : smsAvailable;
      const alternative = channel === 'sms' ? 'WhatsApp' : 'SMS';
      if (alternativeAvailable && browserAvailable) {
        return `Use ${alternative} (recommended), or scan the QR and continue in your browser.`;
      }
      if (alternativeAvailable) return `Use ${alternative} to join.`;
      if (browserAvailable) return 'Scan the QR and continue in your browser.';
      return 'Messaging entry is unavailable right now. Please ask booth staff for help.';
    }
    this.requireStationRuntimeCapabilities(config);
    const runtime = this.requirePlayerRuntime();
    const resources = this.configStore.getStatus().degraded
      ? await runtime.getForCleanup()
      : await this.getActivePlayerResources();
    let result = await resources.service.processInboundStationMessage({
      channel,
      normalizedAddress,
      providerAddress,
      providerMessageId: input.providerMessageId,
      body: input.body,
      stationId: config.arcade.cabinetId,
      preferredLocale: language,
      idempotencyKey: key,
      whatsappAvailable,
      conversationProfileId,
      conversationId: input.conversationId,
    });
    if (result.challengeLink && this.shortenUrl) {
      const shortLink = await this.shortenUrl(result.challengeLink, `challenge-${key.slice(-32)}`);
      if (shortLink) {
        const reply = result.reply.replace(result.challengeLink, shortLink);
        if (reply !== result.reply) {
          const originalReply = result.reply;
          result = { ...result, reply, challengeLink: shortLink };
          await resources.store.transaction(state => {
            const receipt = state.inboundMessages[key];
            if (receipt?.reply === originalReply) state.inboundMessages[key] = { ...receipt, reply };
            const record = state.idempotencyRecords[key];
            if (record && record.operation === 'PROCESS_STATION_MESSAGE') {
              const saved = record.result as Record<string, unknown>;
              if (saved?.reply === originalReply) {
                state.idempotencyRecords[key] = { ...record, result: { ...saved, reply, challengeLink: shortLink } };
              }
            }
          });
        }
      }
    }
    const pendingProfile = this.messagingProfilesByAddress.get(normalizedAddress);
    if (pendingProfile && pendingProfile !== conversationProfileId) {
      try {
        await this.attachMessagingProfile({ from: providerAddress, conversationProfileId: pendingProfile });
      } catch {
        this.messagingProfilesByAddress.delete(normalizedAddress);
      }
    }
    const memoryIdentity = await this.messagingMemoryIdentity(providerAddress);
    if (memoryIdentity) this.messagingProfileNameReady?.(memoryIdentity);
    return result.reply;
  }

  async attachMessagingProfile(input: { from: string; conversationProfileId: string }): Promise<boolean> {
    const normalizedAddress = input.from.trim().replace(/^whatsapp:/i, '');
    const profileId = input.conversationProfileId.trim();
    if (!/^\+[1-9][0-9]{7,14}$/.test(normalizedAddress)
      || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/.test(profileId)
      || this.memoryProfileDeleted?.(profileId)
      || !this.playerRuntime) return false;
    const store = await this.playerRuntime.getStateStoreForCleanup();
    const attached = await store.transaction(state => {
      const profileHash=createHash('sha256').update(`retired-profile:${profileId}`).digest('hex');
      if(this.memoryProfileDeleted?.(profileId)||Object.values(state.idempotencyRecords).some(record=>(
        record.operation==='RESET_TEST_PLAYER'
        &&(record.result as {retiredProfileHash?:unknown}|null)?.retiredProfileHash===profileHash
      )))return false;
      const playerIds = new Set(Object.values(state.channelAddresses)
        .filter(address => address.normalizedAddress === normalizedAddress)
        .map(address => address.playerId));
      if (playerIds.size === 0) return true;
      if (playerIds.size !== 1) {
        throw new ArcadeHttpError(409, 'CONVERSATION_PROFILE_CONFLICT', 'messaging address identifies multiple players');
      }
      const playerId = [...playerIds][0]!;
      const player = state.players[playerId];
      if (!player) return false;
      if (player.conversationProfileId && player.conversationProfileId !== profileId) {
        throw new ArcadeHttpError(409, 'CONVERSATION_PROFILE_CONFLICT', 'messaging identity is linked to another Conversation Memory profile');
      }
      const profileOwner = Object.values(state.players).find(candidate => (
        candidate.id !== playerId && candidate.conversationProfileId === profileId
      ));
      if (profileOwner) return false;
      if (player.conversationProfileId === profileId) return true;
      state.players[playerId] = { ...player, conversationProfileId: profileId, updatedAt: new Date(this.now()).toISOString() };
      return true;
    });
    if (attached) this.messagingProfilesByAddress.set(normalizedAddress, profileId);
    return attached;
  }

  async messagingMemoryIdentity(from: string): Promise<{
    profileId: string;
    firstName: string;
    locale: 'en-US' | 'pt-BR';
    phoneNumber: string;
  } | null> {
    if (!this.playerRuntime) return null;
    const normalizedAddress = from.trim().replace(/^whatsapp:/i, '');
    const state = await (await this.playerRuntime.getStateStoreForCleanup()).read();
    const channel = from.trim().toLowerCase().startsWith('whatsapp:') ? 'whatsapp' : 'sms';
    const addresses = Object.values(state.channelAddresses).filter(candidate => (
      candidate.normalizedAddress === normalizedAddress
    ));
    const address = addresses.find(candidate => candidate.channel === channel) ?? addresses[0];
    const player = address ? state.players[address.playerId] : undefined;
    const draft = address ? state.messagingDrafts[address.playerId] : undefined;
    const firstName = player?.lead?.firstName.trim()
      || (draft?.step === 'COMPLETE' ? draft.firstName?.trim() : '')
      || '';
    if (!player?.conversationProfileId || !firstName) return null;
    return {
      profileId: player.conversationProfileId,
      firstName: firstName.slice(0, 50),
      locale: address!.preferredLocale === 'pt-BR' ? 'pt-BR' : 'en-US',
      phoneNumber: normalizedAddress,
    };
  }

  async processMessagingStatusCallback(input: {
    notificationId: string;
    attemptId: string;
    providerMessageId: string;
    providerStatus: string;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<boolean> {
    if (!this.playerRuntime) return false;
    const resources = this.playerRuntime.getInitializedResources();
    if (resources) return resources.messaging.recordStatus(input);
    return recordArcadeMessagingStatus(
      await this.playerRuntime.getStateStoreForCleanup(), input, this.now,
    );
  }

  async stationVoiceRoute(from: string, callSid = ''): Promise<{
    game: RoutedStationGame;
    roomCode: string;
    matchId: string;
    launchGeneration: number;
    admitted: boolean;
    readyEntryId: string | null;
    participantIndex: number;
    participantCount: number;
  } | null> {
    const config = this.configStore.getSnapshot();
    if (config.arcade.mode === 'off' || !config.channels.voice) return null;
    const runtime = this.requirePlayerRuntime();
    const resources = await this.getActivePlayerResources();
    const state = await resources.store.read();
    const aggregate = stationAggregateFromState(state, config.arcade.cabinetId)
      ?? Object.values(state.stations)
        .filter(station => station.phase !== 'ATTRACT')
        .map(station => stationAggregateFromState(state, station.id))
        .find(candidate => candidate !== null)
      ?? null;
    const match = aggregate?.station.activeMatchId
      ? aggregate.matches[aggregate.station.activeMatchId]
      : undefined;
    if (!aggregate || !match || !['LAUNCHING', 'PLAYING'].includes(aggregate.station.phase)) return null;
    const normalizedAddress = from.trim().replace(/^whatsapp:/i, '');
    const participantPlayerIds = new Set(match.participantReadyEntryIds.map(id => (
      aggregate.readyEntries[id]?.playerId
    )).filter((playerId): playerId is string => Boolean(playerId)));
    const matchingPlayerIds = [...participantPlayerIds].filter(playerId => (
      state.players[playerId]?.lead?.phoneNumber === normalizedAddress
      || Object.values(state.channelAddresses).some(address => (
        address.playerId === playerId && address.normalizedAddress === normalizedAddress
      ))
    ));
    const playerId = matchingPlayerIds.length === 1 ? matchingPlayerIds[0] : undefined;
    const readyEntryId = playerId ? match.participantReadyEntryIds.find(id => (
      aggregate.readyEntries[id]?.playerId === playerId
    )) : undefined;
    let admitted = Boolean(readyEntryId);
    if (admitted && playerId && callSid) {
      const existingCall = this.stationVoiceCalls.get(playerId);
      if (existingCall && existingCall.callSid !== callSid) admitted = false;
      else if (readyEntryId) {
        this.stationVoiceCalls.set(playerId, { callSid, readyEntryId });
      }
    }
    this.stationRoomCodes.add(match.engineRoomCode);
    return {
      game: match.game,
      roomCode: match.engineRoomCode,
      matchId: match.id,
      launchGeneration: match.launchGeneration,
      admitted,
      readyEntryId: readyEntryId ?? null,
      participantIndex: readyEntryId ? match.participantReadyEntryIds.indexOf(readyEntryId) : -1,
      participantCount: match.participantReadyEntryIds.length,
    };
  }

  async validateStationVoiceSetup(input: {
    callSid: string;
    readyEntryId: string;
    matchId: string;
    launchGeneration: number;
    game: string;
    roomCode: string;
  }): Promise<boolean> {
    return (await this.resolveStationVoiceSetup(input)) !== null;
  }

  async resolveStationVoiceSetup(input: {
    callSid: string;
    readyEntryId: string;
    matchId: string;
    launchGeneration: number;
    game: string;
    roomCode: string;
  }): Promise<{ firstName: string | null; terminal: boolean; participantIndex: number; participantCount: number } | null> {
    if (!input.callSid || !input.readyEntryId || !input.matchId
      || !Number.isSafeInteger(input.launchGeneration) || input.launchGeneration < 1) return null;
    try {
      const resources = await this.requirePlayerRuntime().getForCleanup();
      const state = await resources.store.read();
      const config = this.configStore.getSnapshot();
      const station = state.stations[config.arcade.cabinetId];
      const match = station?.activeMatchId ? state.stationMatches[station.activeMatchId] : undefined;
      const entry = state.stationReadyEntries[input.readyEntryId];
      const activeCall = entry ? this.stationVoiceCalls.get(entry.playerId) : undefined;
      const valid = config.arcade.mode !== 'off'
        && Boolean(station && ['LAUNCHING', 'PLAYING', 'RESULTS'].includes(station.phase))
        && match?.id === input.matchId
        && match.launchGeneration === input.launchGeneration
        && match.game === input.game
        && match.engineRoomCode === input.roomCode
        && match.participantReadyEntryIds.includes(input.readyEntryId)
        && entry?.status !== 'LEFT'
        && activeCall?.callSid === input.callSid
        && activeCall.readyEntryId === input.readyEntryId;
      if (!valid || !entry) return null;
      const firstName = state.players[entry.playerId]?.lead?.firstName.trim()
        || (state.messagingDrafts[entry.playerId]?.step === 'COMPLETE'
          ? state.messagingDrafts[entry.playerId]?.firstName?.trim()
          : '')
        || null;
      return {
        firstName: firstName ? firstName.slice(0, 20) : null,
        terminal: station!.phase === 'RESULTS',
        participantIndex: match.participantReadyEntryIds.indexOf(input.readyEntryId),
        participantCount: match.participantReadyEntryIds.length,
      };
    } catch {
      return null;
    }
  }

  stationVoiceParticipantConnected(callSid: string, readyEntryId: string, enginePlayerId: string, connectionId: string): void {
    const active = [...this.stationVoiceCalls.values()].find(call => (
      call.callSid === callSid && call.readyEntryId === readyEntryId
    ));
    if (!active) return;
    this.stationVoiceConnections.set(readyEntryId, connectionId);
    void this.playerRuntime?.getForCleanup().then(resources => {
      resources.station.markParticipantConnected(readyEntryId, enginePlayerId);
    }).catch(() => undefined);
  }

  stationVoiceParticipantDisconnected(callSid: string, readyEntryId: string, connectionId: string): void {
    const active = [...this.stationVoiceCalls.values()].find(call => (
      call.callSid === callSid && call.readyEntryId === readyEntryId
    ));
    if (!active || this.stationVoiceConnections.get(readyEntryId) !== connectionId) return;
    this.stationVoiceConnections.delete(readyEntryId);
    void this.playerRuntime?.getForCleanup().then(resources => {
      resources.station.markParticipantDisconnected(readyEntryId);
    }).catch(() => undefined);
  }

  stationVoiceSetupActivity(readyEntryId:string):void {
    void this.playerRuntime?.getForCleanup().then(resources=>{
      resources.station.markSetupActivity(readyEntryId);
    }).catch(()=>undefined);
  }

  stationVoiceSetupReady(readyEntryId:string):boolean {
    const resources=this.playerRuntime?.getInitializedResources();if(!resources)return false;
    const state=resources.store.snapshot();
    const match=Object.values(state.stationMatches).find(candidate=>
      candidate.phase==='LAUNCHING'&&candidate.participantReadyEntryIds.includes(readyEntryId));
    if(!match)return false;
    const connected=resources.station.connectedParticipantIds();
    return match.participantReadyEntryIds.every(id=>connected.has(id));
  }

  requiresStationVoiceAssignment(): boolean {
    const config = this.configStore.getSnapshot();
    return config.arcade.mode !== 'off';
  }

  stationVoiceCallEnded(callSid: string): void {
    if (!callSid) return;
    for (const [playerId, activeCall] of this.stationVoiceCalls) {
      if (activeCall.callSid === callSid) {
        this.stationVoiceCalls.delete(playerId);
        this.stationVoiceConnections.delete(activeCall.readyEntryId);
        void this.playerRuntime?.getForCleanup().then(resources => (
          resources.station.markParticipantDisconnected(activeCall.readyEntryId)
        )).catch(() => undefined);
      }
    }
  }

  isStationEngineRoom(roomCode: string): boolean {
    return this.stationRoomCodes.has(roomCode.trim().toUpperCase())
      || this.stationRoomCodes.has(roomCode.trim());
  }

  stationEnginePhase(game: RoutedStationGame, roomCode: string): 'LAUNCHING' | 'PLAYING' | null {
    const resources = this.playerRuntime?.getInitializedResources();
    if (!resources) return null;
    const state = resources.store.snapshot();
    const code = roomCode.trim().toUpperCase();
    for (const station of Object.values(state.stations)) {
      if (station.phase !== 'LAUNCHING' && station.phase !== 'PLAYING') continue;
      const match = station.activeMatchId ? state.stationMatches[station.activeMatchId] : undefined;
      if (match?.game === game && match.engineRoomCode.toUpperCase() === code) return station.phase;
    }
    return null;
  }

  stationEngineStarted(game: RoutedStationGame, roomCode: string): void {
    void this.playerRuntime?.getForCleanup().then(resources => {
      resources.station.markEngineStarted(game, roomCode);
    }).catch(() => undefined);
  }

  stationEngineCompleted(
    game: RoutedStationGame,
    roomCode: string,
    results: readonly StationEngineParticipantResult[] = [],
  ): void {
    void this.playerRuntime?.getForCleanup().then(resources => (
      resources.station.markEngineCompleted(game, roomCode, results)
    )).catch(() => undefined);
  }

  stationEngineAbandoned(game: RoutedStationGame, roomCode: string): void {
    void this.playerRuntime?.getForCleanup().then(resources => (
      resources.station.markEngineAbandoned(game, roomCode)
    )).catch(() => undefined);
  }

  async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    pathname = requestPath(request),
  ): Promise<void> {
    try {
      if (!this.started || this.stopped) {
        throw new ArcadeHttpError(503, 'ARCADE_UNAVAILABLE', 'Twilio Games API is not available');
      }

      if (pathname === '/api/arcade/config/public') {
        this.requireMethod(request, ['GET']);
        const config = await this.configStore.read();
        const projected = projectPublicArcadeConfig(config);
        sendJson(response, 200, {
          ...projected,
          channels: { ...projected.channels, voiceNumbers: this.getVoiceNumbers() },
        }, {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
          ETag: configEtag(config.version),
        });
        return;
      }

      if (pathname === '/api/arcade/events') {
        this.requireMethod(request, ['GET']);
        this.openEventStream(request, response);
        return;
      }

      if (pathname === '/api/arcade/station/public') {
        await this.handlePublicStation(request, response);
        return;
      }


      if (pathname === '/api/arcade/station/display') {
        await this.handleDisplayStation(request, response);
        return;
      }

      if (pathname === '/api/arcade/station/me') {
        await this.handlePlayerStation(request, response);
        return;
      }

      if (pathname === '/api/arcade/station/coin') {
        await this.handleStationCoin(request, response);
        return;
      }

      if (pathname === '/api/arcade/station/game-choice') {
        await this.handleStationGameChoice(request, response);
        return;
      }

      if (pathname === '/api/arcade/station/leave') {
        await this.handleStationLeave(request, response);
        return;
      }

      if (pathname === '/api/arcade/station/display/ready') {
        await this.handleStationDisplayReady(request, response);
        return;
      }

      if (pathname === '/api/arcade/session') {
        await this.handlePlayerSession(request, response);
        return;
      }

      if (pathname === '/api/arcade/register') {
        await this.handleRegistration(request, response);
        return;
      }

      if (pathname === '/api/arcade/player') {
        await this.handlePlayerStatus(request, response);
        return;
      }

      if (pathname === '/api/arcade/wallet') {
        await this.handleWalletStatus(request, response);
        return;
      }

      if (pathname === '/api/arcade/challenges') {
        await this.handleChallengeList(request, response);
        return;
      }

      if (pathname === '/api/arcade/challenges/redeem') {
        await this.handleChallengeLinkClaim(request, response);
        return;
      }

      if (pathname === '/api/arcade/challenge-portal/status') {
        await this.handleChallengePortal(request, response, 'status');
        return;
      }

      if (pathname === '/api/arcade/challenge-portal/visit') {
        await this.handleChallengePortal(request, response, 'visit');
        return;
      }

      if (pathname === '/api/arcade/challenge-portal/claim') {
        await this.handleChallengePortal(request, response, 'claim');
        return;
      }

      const challengeRoute = parseChallengeRoute(pathname);
      if (challengeRoute) {
        if (challengeRoute.action === 'token') {
          await this.handleChallengeToken(request, response, challengeRoute.challengeId);
        } else {
          await this.handleChallengeClaim(request, response, challengeRoute.challengeId);
        }
        return;
      }

      if (pathname === '/api/arcade/queue/status') {
        await this.handleQueueStatus(request, response);
        return;
      }

      if (pathname === '/api/arcade/queue/join') {
        await this.handleJoinQueue(request, response);
        return;
      }

      if (pathname === '/api/arcade/queue/confirm') {
        await this.handleCurrentQueueAction(request, response, 'confirm');
        return;
      }

      if (pathname === '/api/arcade/queue/snooze') {
        await this.handleCurrentQueueAction(request, response, 'snooze');
        return;
      }

      if (pathname === '/api/arcade/queue/leave') {
        await this.handleCurrentQueueAction(request, response, 'leave');
        return;
      }

      if (pathname === '/api/arcade/check-in') {
        await this.handleCurrentQueueAction(request, response, 'check-in');
        return;
      }

      if (pathname === '/api/admin/arcade/display/connect') {
        this.requireAdmin(request);
        this.requireMethod(request, ['POST']);
        this.requireSameOrigin(request);
        requireJsonContentType(request);
        requireExactObject(await readJson(request, DISPLAY_CONNECT_BODY_LIMIT), [], []);
        if (this.displayToken.length < 16) {
          throw new ArcadeHttpError(
            503,
            'ARCADE_DISPLAY_TOKEN_UNAVAILABLE',
            'Booth display connection is unavailable. Ask a deployment administrator to configure it.',
          );
        }
        sendJson(response, 200, { displayToken: this.displayToken.toString('utf8') }, {
          'Cache-Control': 'no-store, private',
        });
        return;
      }

      if (pathname === '/api/admin/arcade/config') {
        const principal = this.requireAdmin(request);
        if (request.method === 'GET') {
          const config = await this.configStore.read();
          sendJson(response, 200, config, {
            'Cache-Control': 'no-store',
            ETag: configEtag(config.version),
          });
          return;
        }
        if (request.method === 'PATCH') {
          this.requireSameOrigin(request);
          requireJsonContentType(request);
          const expectedVersion = parseIfMatch(request.headers['if-match']);
          const idempotencyKey = requireHeader(
            request.headers['idempotency-key'],
            'Idempotency-Key',
            IDEMPOTENCY_KEY_LIMIT,
          );
          const settings = await readJson(request, ADMIN_CONFIG_BODY_LIMIT);
          const parsedSettings = parseArcadeConfigSettings(settings);
          const update = async (state?: ArcadeState) => {
            const current = this.configStore.getSnapshot();
            const requested = replaceArcadeConfigSettings(current, parsedSettings, {
              updatedAt: current.updatedAt,
              updatedBy: current.updatedBy,
            });
            this.validateStationAdmissionConfig(requested);
            const changesMode = requested.arcade.mode !== current.arcade.mode;
            const changesLockedStationPolicy = requested.arcade.cabinetId !== current.arcade.cabinetId
              || requested.coins.chargePolicy !== current.coins.chargePolicy
              || JSON.stringify(requested.channels) !== JSON.stringify(current.channels)
              || JSON.stringify(requested.station) !== JSON.stringify(current.station);
            const hasActiveStation = state
              && Object.values(state.stations).some(station => station.phase !== 'ATTRACT');
            if (hasActiveStation && (changesLockedStationPolicy || changesMode)) {
              throw new ArcadeHttpError(
                409,
                'ACTIVE_STATION_CONFIG_LOCKED',
                'Reset the active event flow before switching player journeys or changing its policy',
              );
            }
            return this.configStore.update({
              expectedVersion,
              idempotencyKey,
              updatedBy: principal.email,
              settings,
            });
          };
          const config = this.playerRuntime
            ? await (await this.playerRuntime.getStateStoreForCleanup()).runExclusive(update)
            : await update();
          if (this.configStore.getSnapshot().arcade.mode === 'off') {
            await this.playerRuntime?.getInitializedResources()?.station.flush();
          }
          sendJson(response, 200, config, {
            'Cache-Control': 'no-store',
            ETag: configEtag(config.version),
          });
          return;
        }
        this.methodNotAllowed(['GET', 'PATCH']);
      }

      if (pathname === '/api/admin/arcade/status') {
        this.requireMethod(request, ['GET']);
        this.requireAdmin(request);
        const config = this.configStore.getSnapshot();
        let messaging = this.playerRuntime?.getMessagingStatus() ?? null;
        let messagingStorage = null;
        try {
          const resources = await this.playerRuntime?.getForCleanup();
          if (resources) {
            messaging = await resources.messaging.getAdminStatus();
            messagingStorage = await resources.service.getMessagingStorageStatus();
          }
        } catch {
          // Keep status available when player-state initialization is degraded.
        }
        sendJson(response, 200, {
          config: this.configStore.getStatus(),
          tac: this.tacStatus?.() ?? null,
          players: this.playerRuntime?.getStatus() ?? null,
          display: this.displayStatus(),
          messaging: messaging ? {
            ...messaging,
            onboarding: {
              sms: config.channels.sms && this.messagingCapabilities.sms,
              whatsapp: config.channels.whatsapp && this.messagingCapabilities.whatsapp,
            },
            storage: messagingStorage,
          } : null,
        }, { 'Cache-Control': 'no-store' });
        return;
      }

      if (pathname === '/api/admin/arcade/players') {
        await this.handleOperatorPlayers(request, response);
        return;
      }

      const playerBalanceRestore = parseOperatorPlayerBalanceRestoreRoute(pathname);
      if (playerBalanceRestore) {
        await this.handleOperatorPlayerBalanceRestore(request, response, playerBalanceRestore.playerId);
        return;
      }

      const playerReset = parseOperatorPlayerResetRoute(pathname);
      if (playerReset) {
        await this.handleOperatorPlayerReset(request, response, playerReset.playerId);
        return;
      }

      const messagingRetry = parseOperatorMessagingRetryRoute(pathname);
      if (messagingRetry) {
        await this.handleOperatorMessagingRetry(request, response, messagingRetry.notificationId);
        return;
      }

      if (pathname === '/api/admin/arcade/station') {
        await this.handleOperatorStation(request, response);
        return;
      }

      const stationCoinGrant = parseOperatorStationCoinGrantRoute(pathname);
      if (stationCoinGrant) {
        await this.handleOperatorStationCoinGrant(request, response, stationCoinGrant.readyEntryId);
        return;
      }

      const testPlayerReset = parseOperatorTestPlayerResetRoute(pathname);
      if (testPlayerReset) {
        await this.handleOperatorTestPlayerReset(request, response, testPlayerReset.readyEntryId);
        return;
      }

      const stationPlayerDrop = parseOperatorStationDropRoute(pathname);
      if (stationPlayerDrop) {
        await this.handleOperatorStationPlayerDrop(request, response, stationPlayerDrop.readyEntryId);
        return;
      }

      const stationAction = parseOperatorStationRoute(pathname);
      if (stationAction) {
        await this.handleOperatorStationAction(request, response, stationAction);
        return;
      }

      if (pathname === '/api/admin/arcade/queue') {
        await this.handleOperatorQueue(request, response);
        return;
      }

      const operatorQueueRoute = parseOperatorQueueRoute(pathname);
      if (operatorQueueRoute) {
        await this.handleOperatorQueueAction(
          request,
          response,
          operatorQueueRoute.queueEntryId,
          operatorQueueRoute.action,
        );
        return;
      }

      if (pathname === '/api/admin/arcade/matches/start') {
        await this.handleOperatorMatchStart(request, response);
        return;
      }

      const operatorMatchRoute = parseOperatorMatchRoute(pathname);
      if (operatorMatchRoute) {
        await this.handleOperatorMatchComplete(request, response, operatorMatchRoute.matchId);
        return;
      }

      if (pathname.startsWith('/api/arcade/') || pathname.startsWith('/api/admin/arcade/')) {
        throw new ArcadeHttpError(404, 'NOT_FOUND', 'Twilio Games endpoint was not found');
      }
      throw new ArcadeHttpError(404, 'NOT_FOUND', 'Twilio Games endpoint was not found');
    } catch (error) {
      this.sendError(response, error);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribeStationCache?.();
    this.unsubscribeStationCache = null;
    for (const stream of [...this.streams]) stream.close();
    await Promise.all([this.configStore.flush(), this.playerRuntime?.stop()]);
  }

  private async refreshStationRoomCache(): Promise<void> {
    if (!this.playerRuntime?.getStatus().initialized) {
      this.stationRoomCodes.clear();
      return;
    }
    try {
      const state = await (await this.playerRuntime.getForCleanup()).store.read();
      const active = new Set(Object.values(state.stations)
        .filter(station => station.activeMatchId !== null && station.phase !== 'ATTRACT')
        .map(station => state.stationMatches[station.activeMatchId!]?.engineRoomCode)
        .filter((roomCode): roomCode is string => Boolean(roomCode)));
      this.stationRoomCodes.clear();
      for (const roomCode of active) this.stationRoomCodes.add(roomCode);
      if (active.size === 0) this.stationVoiceCalls.clear();
    } catch {
      // Keep the previous cache on transient state errors so admission remains fail closed.
    }
  }

  private async handlePlayerSession(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const body = requireExactObject(await readJson(request, SESSION_BODY_LIMIT), ['cabinetId'], []);
    this.enforceProcessRate('session-process', 120, 60_000);

    const config = this.configStore.getSnapshot();
    const runtime = this.requirePlayerRuntime();
    this.requireStationRuntimeCapabilities(config);
    const resources = await runtime.getActive();
    if (body.cabinetId !== config.arcade.cabinetId) {
      throw new ArcadeHttpError(409, 'CABINET_CHANGED', 'Twilio Games QR belongs to another station');
    }
    if (config.arcade.mode === 'off') {
      throw new ArcadeHttpError(409, 'ARCADE_MODE_DISABLED', 'station mode is off');
    }
    const audience = this.playerSessionAudience(config.arcade.cabinetId);
    let playerId: string | null = null;
    try {
      playerId = resources.sessions.readCookie(request.headers.cookie, audience)?.player ?? null;
    } catch (error) {
      if (error instanceof ArcadePlayerSessionError && error.code === 'DUPLICATE_COOKIE') throw error;
      playerId = null;
    }

    let player = playerId ? await resources.service.getPlayerStatus(playerId) : null;
    if (playerId && !player) playerId = null;
    let issuance: ReturnType<ArcadePlayerSessionService['issue']> | null = null;
    if (!playerId) {
      if (config.arcade.mode === 'coin_only') {
        throw new ArcadeHttpError(
          409,
          'MESSAGING_IDENTITY_REQUIRED',
          'join through SMS or WhatsApp before entering the ready pool',
        );
      }
      issuance = resources.sessions.issue(runtime.newPlayerId(), audience);
      playerId = issuance.payload.player;
      player = null;
    }

    if (config.arcade.mode === 'coin_only' && !player) {
      throw new ArcadeHttpError(
        409,
        'MESSAGING_IDENTITY_REQUIRED',
        'join through SMS or WhatsApp before entering the ready pool',
      );
    }
    const wallet = await resources.service.getWalletStatus(playerId);
    sendJson(response, 200, {
      mode: config.arcade.mode,
      registered: player?.registered ?? false,
      availableBalance: wallet?.availableBalance ?? null,
    }, {
      'Cache-Control': 'no-store',
      ...(issuance ? { 'Set-Cookie': issuance.cookie } : {}),
    });
  }

  private async handleRegistration(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'],
      'Idempotency-Key',
      PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(
      await readJson(request, REGISTRATION_BODY_LIMIT),
      ['lead', 'termsAccepted'],
      ['marketingConsent', 'preferredLocale'],
    );
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`registration-player:${playerId}`, 5, 10 * 60_000);
    this.enforceProcessRate('registration-process', 60, 60_000);
    const result = await resources.service.registerPlayer({
      playerId,
      destination: null,
      idempotencyKey: playerServiceKey(playerId, 'register', idempotencyKey),
      lead: body.lead as LeadInput,
      termsAccepted: body.termsAccepted as boolean,
      marketingConsent: body.marketingConsent as boolean | undefined,
      preferredLocale: body.preferredLocale as string | undefined,
    });
    const player = await resources.service.getPlayerStatus(playerId);
    sendJson(response, 200, {
      ...player,
      availableBalance: result.availableBalance,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handlePlayerStatus(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`read-player-profile:${playerId}`, 120, 60_000);
    this.enforceProcessRate('read-process', 3_000, 60_000);
    const player = await resources.service.getPlayerStatus(playerId);
    if (!player && await resources.service.isRetiredPlayer(playerId)) {
      throw new ArcadeHttpError(409, 'PLAYER_SESSION_RETIRED', 'player session was reset; start a new session');
    }
    sendJson(response, 200, player ?? {
      registered: false,
      firstName: null,
      preferredLocale: null,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleWalletStatus(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`read-player-wallet:${playerId}`, 120, 60_000);
    this.enforceProcessRate('read-process', 3_000, 60_000);
    const wallet = await resources.service.getWalletStatus(playerId);
    if (!wallet) {
      throw new ArcadeHttpError(409, 'REGISTRATION_REQUIRED', 'player registration is required');
    }
    sendJson(response, 200, wallet, { 'Cache-Control': 'no-store' });
  }

  private async handleQueueStatus(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`read-player-queue:${playerId}`, 120, 60_000);
    this.enforceProcessRate('read-process', 3_000, 60_000);
    const queue = await resources.service.getQueueStatus(playerId);
    sendJson(response, 200, { queue: publicQueueStatus(queue) }, { 'Cache-Control': 'no-store' });
  }

  private async handleChallengeList(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`read-player-challenges:${playerId}`, 120, 60_000);
    this.enforceProcessRate('read-process', 3_000, 60_000);
    const challenges = await resources.service.listChallenges(playerId);
    sendJson(response, 200, { challenges }, { 'Cache-Control': 'no-store' });
  }

  private async handleChallengeToken(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    challengeId: string,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    requireExactObject(await readJson(request, SESSION_BODY_LIMIT), [], []);
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`mutation-player:${playerId}`, 30, 60_000);
    this.enforceProcessRate('mutation-process', 600, 60_000);
    const challenge = (await resources.service.listChallenges(playerId))
      .find(candidate => candidate.id === challengeId);
    if (!challenge || !challenge.available) {
      throw new ArcadeHttpError(409, 'CHALLENGE_UNAVAILABLE', 'game challenge is unavailable');
    }
    const issuedAt = Math.floor(this.now() / 1000);
    if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
      throw new ArcadeHttpError(500, 'ARCADE_INTERNAL_ERROR', 'game challenge token clock is invalid');
    }
    const expiry = issuedAt + ARCADE_CHALLENGE_TOKEN_MAX_TTL_SECONDS;
    const token = resources.challenges.sign({
      v: ARCADE_CHALLENGE_TOKEN_VERSION,
      player: playerId,
      challenge: challengeId,
      audience: this.configStore.getSnapshot().arcade.cabinetId,
      jti: `challenge:${randomUUID()}`,
      issuedAt,
      expiry,
    });
    sendJson(response, 200, {
      challengeId,
      token,
      expiresAt: new Date(expiry * 1000).toISOString(),
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleChallengeClaim(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    challengeId: string,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(await readJson(request, CHALLENGE_BODY_LIMIT), ['token'], []);
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`mutation-player:${playerId}`, 30, 60_000);
    this.enforceProcessRate('mutation-process', 600, 60_000);
    const result = await resources.service.claimChallenge({
      playerId,
      challengeId,
      token: body.token as string,
      idempotencyKey: playerServiceKey(playerId, `challenge-${challengeId}`, idempotencyKey),
    });
    sendJson(response, 200, {
      challengeId: result.challengeId,
      rewardCoins: result.rewardCoins,
      availableBalance: result.availableBalance,
      destinationUrl: result.destinationUrl,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleChallengePortal(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    action: 'status' | 'visit' | 'claim',
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const body = action === 'status'
      ? requireExactObject(await readJson(request, CHALLENGE_BODY_LIMIT), ['token'], [])
      : requireExactObject(await readJson(request, CHALLENGE_BODY_LIMIT), ['token', 'challengeId'], []);
    const token = String(body.token ?? '');
    const forwarded = request.headers['x-forwarded-for'];
    const forwardedValue = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
    const clientAddress = forwardedValue?.split(',').at(-1)?.trim().slice(0, 128)
      || request.socket.remoteAddress || 'unknown';
    this.enforceRate(`challenge-link-address:${clientAddress}`, 120, 60_000);
    this.enforceRate(`challenge-link-token:${createHash('sha256').update(token).digest('hex')}`, 60, 60_000);
    this.enforceProcessRate('challenge-link-process', 600, 60_000);
    const resources = await this.getActivePlayerResources();
    const result = action === 'status'
      ? await resources.service.getChallengePortalStatus(token)
      : action === 'visit'
        ? await resources.service.visitChallengeFromPortal(token, String(body.challengeId ?? ''))
        : await resources.service.claimChallengeFromPortal(token, String(body.challengeId ?? ''));
    sendJson(response, 200, result, {
      'Cache-Control': 'no-store, private',
      'Referrer-Policy': 'no-referrer',
    });
  }

  private async handleChallengeLinkClaim(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const body = requireExactObject(await readJson(request, CHALLENGE_BODY_LIMIT), ['token'], []);
    const token = String(body.token ?? '');
    const forwarded = request.headers['x-forwarded-for'];
    const forwardedValue = Array.isArray(forwarded) ? forwarded.at(-1) : forwarded;
    const clientAddress = forwardedValue?.split(',').at(-1)?.trim().slice(0, 128)
      || request.socket.remoteAddress || 'unknown';
    this.enforceRate(`legacy-challenge-address:${clientAddress}`, 30, 60_000);
    this.enforceRate(`legacy-challenge-token:${createHash('sha256').update(token).digest('hex')}`, 10, 60_000);
    this.enforceProcessRate('challenge-link-process', 600, 60_000);
    const resources = await this.getActivePlayerResources();
    const result = await resources.service.claimChallengeFromLink(token);
    sendJson(response, 200, {
      destinationUrl: result.destinationUrl,
      availableBalance: result.availableBalance,
      rewardCoins: result.rewardCoins,
    }, { 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer' });
  }

  private async handleJoinQueue(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(
      await readJson(request, QUEUE_BODY_LIMIT), ['preferredGame'], ['flexibleGame'],
    );
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`mutation-player:${playerId}`, 30, 60_000);
    this.enforceProcessRate('mutation-process', 600, 60_000);
    const result = await resources.service.joinQueue({
      playerId,
      preferredGame: body.preferredGame as ArcadeGame,
      flexibleGame: body.flexibleGame as boolean | undefined,
      idempotencyKey: playerServiceKey(playerId, 'queue-join', idempotencyKey),
    });
    const queue = await resources.service.getQueueStatus(playerId);
    sendJson(response, 200, {
      queue: publicQueueStatus(queue),
      availableBalance: result.availableBalance,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleCurrentQueueAction(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    action: 'confirm' | 'snooze' | 'leave' | 'check-in',
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(
      await readJson(request, QUEUE_BODY_LIMIT),
      action === 'check-in' ? ['game'] : [],
      [],
    );
    const runtime = this.requirePlayerRuntime();
    const resources = action === 'leave'
      ? await runtime.getForCleanup()
      : await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`mutation-player:${playerId}`, 30, 60_000);
    this.enforceProcessRate('mutation-process', 600, 60_000);
    const current = await resources.service.getQueueStatus(playerId);
    if (!current) throw new ArcadeHttpError(409, 'QUEUE_ENTRY_REQUIRED', 'player has no active queue entry');
    const common = {
      playerId,
      queueEntryId: current.queueEntryId,
      idempotencyKey: playerServiceKey(playerId, `queue-${action}`, idempotencyKey),
    };
    const result = action === 'confirm'
      ? await resources.service.confirmPresence(common)
      : action === 'snooze'
        ? await resources.service.snoozeQueueEntry(common)
        : action === 'leave'
          ? await resources.service.leaveQueue(common)
          : await resources.service.checkInQueueEntry({
            ...common,
            game: body.game as ArcadeGame,
          });
    const queue = await resources.service.getQueueStatus(playerId);
    sendJson(response, 200, {
      status: result.entry.status,
      queue: publicQueueStatus(queue),
      availableBalance: result.availableBalance,
      reservation: result.reservation
        ? { amount: result.reservation.amount, status: result.reservation.status }
        : null,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handlePublicStation(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    this.enforceProcessRate('station-public-read', 3_000, 60_000);
    const config = this.configStore.getSnapshot();
    if (config.arcade.mode === 'off') {
      sendJson(response, 200, emptyPublicStation(), {
        'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ETag: stationEtag(0),
      });
      return;
    }
    const resources = await this.getActivePlayerResources();
    const state = await resources.store.read();
    const projection = projectPublicStation(
      state,
      stationAggregateFromState(state, config.arcade.cabinetId),
      false,
      enabledStationGames(config),
    );
    sendJson(response, 200, projection, {
      'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', ETag: stationEtag(projection.revision),
    });
  }

  private async handleDisplayStation(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    this.requireDisplayAuthorization(request);
    const config = this.configStore.getSnapshot();
    if (config.arcade.mode === 'off') {
      this.displayLastSeenAt = this.now();
      sendJson(response, 200, emptyPublicStation(), {
        'Cache-Control': 'no-store', ETag: stationEtag(0),
      });
      return;
    }
    const resources = await this.getActivePlayerResources();
    const state = await resources.store.read();
    const projection = projectDisplayStation(
      state,
      stationAggregateFromState(state, config.arcade.cabinetId),
      enabledStationGames(config),
    );
    this.displayLastSeenAt = this.now();
    sendJson(response, 200, projection, {
      'Cache-Control': 'no-store', ETag: stationEtag(projection.revision),
    });
  }

  private displayStatus(): {
    configured: boolean;
    connected: boolean;
    checking: boolean;
    lastSeenAt: string | null;
    presenceTimeoutSeconds: number;
  } {
    const now = this.now();
    const connected = this.displayLastSeenAt !== null
      && now >= this.displayLastSeenAt
      && now - this.displayLastSeenAt <= DISPLAY_PRESENCE_TIMEOUT_MS;
    const configured = this.displayToken.length >= 16;
    return {
      configured,
      connected,
      checking: configured && this.displayLastSeenAt === null
        && now >= this.displayPresenceStartedAt
        && now - this.displayPresenceStartedAt <= DISPLAY_PRESENCE_TIMEOUT_MS,
      lastSeenAt: this.displayLastSeenAt === null ? null : new Date(this.displayLastSeenAt).toISOString(),
      presenceTimeoutSeconds: DISPLAY_PRESENCE_TIMEOUT_MS / 1000,
    };
  }

  private async handlePlayerStation(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    const runtime = this.requirePlayerRuntime();
    const resources = this.configStore.getSnapshot().arcade.mode === 'off'
      ? await runtime.getForCleanup()
      : await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`read-player-station:${playerId}`, 120, 60_000);
    const state = await resources.store.read();
    if (!state.wallets[playerId]) {
      throw new ArcadeHttpError(409, 'REGISTRATION_REQUIRED', 'player registration is required');
    }
    const config = this.configStore.getSnapshot();
    const aggregate = playerStationAggregate(state, playerId, config.arcade.cabinetId);
    const projection = projectPlayerStation(state, aggregate, playerId, enabledStationGames(config));
    const playerLocale = state.players[playerId]?.preferredLocale?.toLowerCase().startsWith('pt')
      ? 'pt-BR'
      : 'en-US';
    const browserLead = Boolean(state.players[playerId]?.lead)
      && !Object.values(state.channelAddresses).some(address => address.playerId === playerId);
    const callNumber = browserLead && projection.phase === 'LAUNCHING'
      && projection.ready?.status === 'ADMITTED' && config.arcade.mode !== 'off'
      && config.channels.voice
      ? this.effectiveVoiceNumbers(config)[playerLocale]
      : null;
    sendJson(response, 200, { ...projection, callNumber }, {
      'Cache-Control': 'no-store', ETag: stationEtag(projection.revision),
    });
  }

  private async handleStationCoin(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    requireExactObject(await readJson(request, STATION_BODY_LIMIT), [], []);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`station-coin:${playerId}`, 10, 60_000);
    this.enforceProcessRate('station-coin-process', 240, 60_000);
    const config = this.configStore.getSnapshot();
    const stationId = config.arcade.cabinetId;
    const identityState = await resources.store.read();
    const messagingLinked = Object.values(identityState.channelAddresses)
      .some(address => address.playerId === playerId);
    if (this.configStore.getSnapshot().arcade.mode === 'coin_only') {
      const draft = identityState.messagingDrafts[playerId];
      if (!messagingLinked || draft?.stationId !== stationId
        || draft.step !== 'COMPLETE' || !draft.firstName?.trim()) {
        throw new ArcadeHttpError(
          409, 'MESSAGING_IDENTITY_REQUIRED',
          'finish joining through SMS or WhatsApp before entering the ready pool',
        );
      }
    }
    await resources.service.insertStationCoin({
      stationId,
      playerId,
      idempotencyKey: playerServiceKey(playerId, 'station-coin', idempotencyKey),
    });
    const state = await resources.store.read();
    const projection = projectPlayerStation(
      state, stationAggregateFromState(state, stationId), playerId, enabledStationGames(config),
    );
    sendJson(response, 200, projection, {
      'Cache-Control': 'no-store', ETag: stationEtag(projection.revision),
    });
  }

  private async handleStationLeave(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    requireExactObject(await readJson(request, STATION_BODY_LIMIT), [], []);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`station-leave:${playerId}`, 10, 60_000);
    const state = await resources.store.read();
    const entry = Object.values(state.stationReadyEntries)
      .find(candidate => candidate.playerId === playerId && !['COMPLETED', 'LEFT'].includes(candidate.status));
    if (!entry) throw new ArcadeHttpError(409, 'READY_ENTRY_REQUIRED', 'player is not in the station ready pool');
    const station = state.stations[entry.stationId];
    if (!station) throw new ArcadeHttpError(503, 'ARCADE_STATE_UNAVAILABLE', 'Twilio Games player state is unavailable');
    await resources.service.leaveStationReadyEntry({
      stationId: entry.stationId,
      playerId,
      readyEntryId: entry.id,
      expectedRevision: station.revision,
      idempotencyKey: playerServiceKey(playerId, 'station-leave', idempotencyKey),
    });
    const updated = await resources.store.read();
    const config = this.configStore.getSnapshot();
    const projection = projectPlayerStation(
      updated, stationAggregateFromState(updated, entry.stationId), playerId, enabledStationGames(config),
    );
    sendJson(response, 200, projection, {
      'Cache-Control': 'no-store', ETag: stationEtag(projection.revision),
    });
  }

  private async handleStationGameChoice(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const body = requireExactObject(await readJson(request, STATION_BODY_LIMIT), ['game'], []);
    if (!isPlayableArcadeGame(body.game)) {
      throw new ArcadeHttpError(400, 'INVALID_GAME', 'game is not station-playable');
    }
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const resources = await this.getActivePlayerResources();
    const playerId = this.requirePlayerSession(request, resources.sessions);
    this.enforceRate(`station-game-choice:${playerId}`, 30, 60_000);
    this.enforceProcessRate('station-game-choice-process', 600, 60_000);
    const stationId = this.configStore.getSnapshot().arcade.cabinetId;
    const result = await resources.service.recordStationGameChoice({
      stationId,
      playerId,
      game: body.game,
      idempotencyKey: playerServiceKey(playerId, 'station-game-choice', idempotencyKey),
    });
    sendJson(response, 200, result, { 'Cache-Control': 'no-store' });
  }

  private async handleStationDisplayReady(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    this.requireDisplayAuthorization(request);
    requireJsonContentType(request);
    const body = requireExactObject(
      await readJson(request, STATION_BODY_LIMIT), ['matchId', 'launchGeneration'], [],
    );
    const expectedRevision = parseStationIfMatch(request.headers['if-match']);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const resources = await this.getActivePlayerResources();
    const result = await resources.station.markDisplayReady({
      matchId: body.matchId as string,
      launchGeneration: body.launchGeneration as number,
      expectedRevision,
      idempotencyKey: playerServiceKey('station-display', 'ready', idempotencyKey),
    });
    sendJson(response, 200, { phase: result.station.phase, revision: result.station.revision }, {
      'Cache-Control': 'no-store', ETag: stationEtag(result.station.revision),
    });
  }

  private async handleOperatorStation(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    this.requireAdmin(request);
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const state = await resources.store.read();
    const aggregate = stationAggregateFromState(
      state, this.configStore.getSnapshot().arcade.cabinetId,
    );
    if (!aggregate) {
      sendJson(response, 200, null, { 'Cache-Control': 'no-store', ETag: stationEtag(0) });
      return;
    }
    sendJson(response, 200, projectOperatorStation(
      state, aggregate, resources.station.connectedParticipantIds(),
    ), {
      'Cache-Control': 'no-store', ETag: stationEtag(aggregate.station.revision),
    });
  }

  private async handleOperatorMessagingRetry(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    notificationId: string,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(await readJson(request, STATION_BODY_LIMIT), ['reason'], []);
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const result = await resources.messaging.retryFailedNotification({
      notificationId,
      actorSubject: principal.email,
      reason: operatorReason(body.reason),
      idempotencyKey: playerServiceKey(
        `operator:${principal.email}`, `messaging-retry:${notificationId}`, idempotencyKey,
      ),
    });
    sendJson(response, 200, result, { 'Cache-Control': 'no-store' });
  }

  private async handleOperatorPlayers(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    this.requireAdmin(request);
    const url = new URL(request.url ?? '', 'http://localhost');
    const limitValue = url.searchParams.get('limit');
    const limit = limitValue === null ? 100 : Number(limitValue);
    const cursor = url.searchParams.get('cursor');
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const result = await resources.service.listPlayersNeedingCoins(limit, cursor);
    sendJson(response, 200, result, { 'Cache-Control': 'no-store, private' });
  }

  private async handleOperatorPlayerBalanceRestore(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    playerId: string,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const expectedConfigVersion = parseIfMatch(request.headers['if-match']);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(await readJson(request, STATION_BODY_LIMIT), ['reason'], []);
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const result = await resources.service.restorePlayerStartingBalance({
      playerId,
      expectedConfigVersion,
      reason: operatorReason(body.reason),
      idempotencyKey: playerServiceKey(
        `operator:${principal.email}`, `restore-player:${playerId}`, idempotencyKey,
      ),
      authorization: resources.operatorAuthorization(principal.email),
    });
    sendJson(response, 200, result, { 'Cache-Control': 'no-store, private' });
  }

  private async handleOperatorPlayerReset(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    playerId: string,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(await readJson(request, STATION_BODY_LIMIT), ['reason'], []);
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const before = await resources.store.read();
    const player = before.players[playerId];
    const connected = resources.station.connectedParticipantIds();
    if (player && Object.values(before.stationReadyEntries).some(entry => (
      entry.playerId === playerId && connected.has(entry.id)
    ))) throw new ArcadeHttpError(409, 'TEST_PLAYER_RESET_CONNECTED', 'Hang up the player call before resetting this player.');
    const reset = await resources.service.resetInactivePlayer({
      playerId,
      reason: operatorReason(body.reason),
      idempotencyKey: playerServiceKey(
        `operator:${principal.email}`, `player-reset:${playerId}`, idempotencyKey,
      ),
      authorization: resources.operatorAuthorization(principal.email),
      deleteMemoryProfile: this.deleteMemoryProfile,
      isReadyEntryConnected: readyEntryId => resources.station.connectedParticipantIds().has(readyEntryId),
    });
    if (reset.resetNameHashes.length || reset.racers.length) {
      await this.playerResetCleanup?.({ nameHashes: reset.resetNameHashes, racers: reset.racers });
    }
    for (const address of Object.values(before.channelAddresses)) {
      if (address.playerId === playerId) this.messagingProfilesByAddress.delete(address.normalizedAddress);
    }
    sendJson(response, 200, { reset: true }, { 'Cache-Control': 'no-store, private' });
  }

  private async handleOperatorStationCoinGrant(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    readyEntryId: string,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(await readJson(request, STATION_BODY_LIMIT), ['amount', 'reason'], []);
    const amount = body.amount;
    if (!Number.isSafeInteger(amount) || (amount as number) < 1 || (amount as number) > 100) {
      throw new ArcadeHttpError(400, 'INVALID_AMOUNT', 'coin amount must be a whole number from 1 to 100');
    }
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const result = await resources.service.grantStationPlayerCoins({
      stationId: this.configStore.getSnapshot().arcade.cabinetId,
      readyEntryId,
      amount: amount as number,
      reason: operatorReason(body.reason),
      idempotencyKey: playerServiceKey(
        `operator:${principal.email}`, `station-coins:${readyEntryId}`, idempotencyKey,
      ),
      authorization: resources.operatorAuthorization(principal.email),
    });
    sendJson(response, 200, {
      readyEntryId: result.readyEntryId,
      availableBalance: result.availableBalance,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleOperatorStationPlayerDrop(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    readyEntryId: string,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const expectedRevision = parseStationIfMatch(request.headers['if-match']);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(await readJson(request, STATION_BODY_LIMIT), ['reason'], []);
    if (this.configStore.getSnapshot().arcade.mode === 'off') {
      throw new ArcadeHttpError(
        409,
        'PAUSED_EVENT_RESET_REQUIRED',
        'The event is paused. Reset the event flow before removing a player.',
      );
    }
    const resources = await this.requirePlayerRuntime().getForCleanup();
    await resources.station.dropAdmittedEntry({
      readyEntryId,
      expectedRevision,
      reason: operatorReason(body.reason),
      idempotencyKey: playerServiceKey(
        `operator:${principal.email}`, `station-drop:${readyEntryId}`, idempotencyKey,
      ),
      authorization: resources.operatorAuthorization(principal.email),
    });
    const state = await resources.store.read();
    const aggregate = stationAggregateFromState(state, this.configStore.getSnapshot().arcade.cabinetId);
    if (!aggregate) throw new ArcadeHttpError(503, 'ARCADE_STATE_UNAVAILABLE', 'Twilio Games state is unavailable');
    sendJson(response, 200, projectOperatorStation(state, aggregate), {
      'Cache-Control': 'no-store', ETag: stationEtag(aggregate.station.revision),
    });
  }

  private async handleOperatorTestPlayerReset(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    readyEntryId: string,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const expectedRevision = parseStationIfMatch(request.headers['if-match']);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(await readJson(request, STATION_BODY_LIMIT), ['reason'], []);
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const beforeState = await resources.store.read();
    const stationId = this.configStore.getSnapshot().arcade.cabinetId;
    if (this.configStore.getSnapshot().arcade.mode === 'off') {
      throw new ArcadeHttpError(409, 'TEST_PLAYER_RESET_PAUSED', 'Open the event before resetting a test player.');
    }
    const aggregate = stationAggregateFromState(beforeState, stationId);
    if (!aggregate) throw new ArcadeHttpError(404, 'STATION_NOT_FOUND', 'Twilio Games station was not found.');
    const resetInput = {
      stationId,
      readyEntryId,
      expectedRevision,
      reason: operatorReason(body.reason),
      idempotencyKey: playerServiceKey(
        `operator:${principal.email}`, `test-player-reset:${readyEntryId}`, idempotencyKey,
      ),
      authorization: resources.operatorAuthorization(principal.email),
      deleteMemoryProfile: this.deleteMemoryProfile,
    };
    if (aggregate.station.revision !== expectedRevision) {
      // Service idempotency can still replay a completed reset; a first stale request fails closed.
      const replay = await resources.service.resetTestPlayer(resetInput);
      if (replay.resetNameHashes.length || replay.racers.length) {
        await this.playerResetCleanup?.({ nameHashes: replay.resetNameHashes, racers: replay.racers });
      }
      const replayState = await resources.store.read();
      const replayAggregate = stationAggregateFromState(replayState, stationId);
      if (!replayAggregate) throw new ArcadeHttpError(503, 'ARCADE_STATE_UNAVAILABLE', 'Twilio Games state is unavailable');
      sendJson(response, 200, projectOperatorStation(replayState, replayAggregate), {
        'Cache-Control': 'no-store', ETag: stationEtag(replayAggregate.station.revision),
      });
      return;
    }
    const entry = aggregate.readyEntries[readyEntryId];
    if (!entry || entry.status === 'LEFT') {
      throw new ArcadeHttpError(409, 'READY_ENTRY_NOT_FOUND', 'The test player is no longer in this event.');
    }
    if (!['READY', 'OVERFLOW', 'COMPLETED'].includes(entry.status)) {
      throw new ArcadeHttpError(409, 'TEST_PLAYER_RESET_UNSAFE', 'Wait until the game finishes before resetting this player.');
    }
    const player = beforeState.players[entry.playerId];
    if (!player) throw new ArcadeHttpError(409, 'READY_ENTRY_NOT_FOUND', 'The test player identity was not found.');
    const connected = resources.station.connectedParticipantIds();
    if (Object.values(beforeState.stationReadyEntries)
      .some(candidate => candidate.playerId === player.id && connected.has(candidate.id))) {
      throw new ArcadeHttpError(409, 'TEST_PLAYER_RESET_CONNECTED', 'Hang up the player call before resetting this test player.');
    }
    const reset = await resources.service.resetTestPlayer(resetInput);
    if (reset.resetNameHashes.length || reset.racers.length) {
      await this.playerResetCleanup?.({ nameHashes: reset.resetNameHashes, racers: reset.racers });
    }
    for (const address of Object.values(beforeState.channelAddresses)) {
      if (address.playerId === player.id) this.messagingProfilesByAddress.delete(address.normalizedAddress);
    }
    const state = await resources.store.read();
    const updated = stationAggregateFromState(state, stationId);
    if (!updated) throw new ArcadeHttpError(503, 'ARCADE_STATE_UNAVAILABLE', 'Twilio Games state is unavailable');
    sendJson(response, 200, projectOperatorStation(state, updated), {
      'Cache-Control': 'no-store', ETag: stationEtag(updated.station.revision),
    });
  }

  private async handleOperatorStationAction(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    action: OperatorStationAction,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const expectedRevision = parseStationIfMatch(request.headers['if-match']);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(
      await readJson(request, STATION_BODY_LIMIT),
      action === 'select' ? ['game', 'reason'] : ['reason'],
      [],
    );
    const reason = operatorReason(body.reason);
    if (this.configStore.getSnapshot().arcade.mode === 'off' && action !== 'reset') {
      throw new ArcadeHttpError(
        409,
        'PAUSED_EVENT_RESET_REQUIRED',
        'The event is paused. Reset the event flow before taking another game-control action.',
      );
    }
    const runtime = this.requirePlayerRuntime();
    const cleanup = action === 'complete' || action === 'advance' || action === 'fail' || action === 'reset';
    const resources = cleanup ? await runtime.getForCleanup() : await this.getActivePlayerResources();
    const stationId = this.configStore.getSnapshot().arcade.cabinetId;
    const before = await resources.store.read();
    const beforeStation = before.stations[stationId];
    const activeMatch = beforeStation?.activeMatchId
      ? before.stationMatches[beforeStation.activeMatchId] ?? null
      : null;
    const common = {
      stationId,
      expectedRevision,
      reason,
      idempotencyKey: playerServiceKey(`operator:${principal.email}`, `station-${action}`, idempotencyKey),
      authorization: resources.operatorAuthorization(principal.email),
    };
    if (action === 'select') {
      if (!isPlayableArcadeGame(body.game)) {
        throw new ArcadeHttpError(400, 'INVALID_GAME', 'game is not station-playable');
      }
      await resources.station.selectGame({ ...common, game: body.game });
    } else if (action === 'close') await resources.service.closeStationRecruiting(common);
    else if (action === 'launch') await resources.service.requestStationLaunch(common);
    else if (action === 'complete') await resources.service.completeStationMatch(common);
    else if (action === 'advance') await resources.service.advanceStationResults(common);
    else if (action === 'hold') await resources.service.holdStationResults(common);
    else if (action === 'fail') await resources.service.failStationLaunch(common);
    else {
      await resources.service.resetStation(common);
      await resources.station.flush();
    }
    if (activeMatch && ['complete', 'advance', 'fail', 'reset'].includes(action)) {
      this.removeLiveStationEngine(
        activeMatch.game,
        activeMatch.engineRoomCode,
        action === 'advance' ? 'retire' : 'abort',
      );
      await this.refreshStationRoomCache();
    }

    const state = await resources.store.read();
    const aggregate = stationAggregateFromState(state, stationId);
    if (!aggregate) throw new ArcadeHttpError(503, 'ARCADE_STATE_UNAVAILABLE', 'Twilio Games state is unavailable');
    sendJson(response, 200, projectOperatorStation(state, aggregate), {
      'Cache-Control': 'no-store', ETag: stationEtag(aggregate.station.revision),
    });
  }

  private async handleOperatorQueue(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['GET']);
    this.requireAdmin(request);
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const queue = (await resources.service.listOperatorQueue()).map(publicOperatorQueueStatus);
    sendJson(response, 200, { queue }, { 'Cache-Control': 'no-store' });
  }

  private async handleOperatorQueueAction(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    queueEntryId: string,
    action: 'approach' | 'call' | 'expire' | 'requeue' | 'activate' | 'release',
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(await readJson(request, QUEUE_BODY_LIMIT), ['reason'], []);
    const runtime = this.requirePlayerRuntime();
    const resources = action === 'release'
      ? await runtime.getForCleanup()
      : await this.getActivePlayerResources();
    const entry = await resources.service.getOperatorQueueEntry(queueEntryId);
    if (!entry) throw new ArcadeHttpError(404, 'QUEUE_ENTRY_NOT_FOUND', 'queue entry was not found');
    const input = {
      playerId: entry.playerId,
      queueEntryId,
      idempotencyKey: playerServiceKey(
        `operator:${principal.email}`,
        `queue-${action}:${queueEntryId}`,
        idempotencyKey,
      ),
      reason: operatorReason(body.reason),
      authorization: resources.operatorAuthorization(principal.email),
    };
    const result = action === 'approach'
      ? await resources.service.markApproaching(input)
      : action === 'call'
        ? await resources.service.callQueueEntry(input)
        : action === 'expire'
          ? await resources.service.expireQueueEntry(input)
          : action === 'requeue'
            ? await resources.service.requeueEntry(input)
            : action === 'activate'
              ? await resources.service.activateLobby(input)
              : await resources.service.releaseQueueEntry(input);
    sendJson(response, 200, {
      queueEntryId,
      status: result.entry.status,
      availableBalance: result.availableBalance,
      reservation: result.reservation
        ? { amount: result.reservation.amount, status: result.reservation.status }
        : null,
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleOperatorMatchStart(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(
      await readJson(request, QUEUE_BODY_LIMIT), ['queueEntryIds', 'game', 'reason'], [],
    );
    const resources = await this.getActivePlayerResources();
    const result = await resources.service.startMatch({
      queueEntryIds: body.queueEntryIds as string[],
      game: body.game as ArcadeGame,
      reason: operatorReason(body.reason),
      idempotencyKey: playerServiceKey(`operator:${principal.email}`, 'match-start', idempotencyKey),
      authorization: resources.operatorAuthorization(principal.email),
    });
    sendJson(response, 200, {
      matchId: result.matchId,
      entries: result.entries.map(entry => ({ queueEntryId: entry.id, status: entry.status })),
    }, { 'Cache-Control': 'no-store' });
  }

  private async handleOperatorMatchComplete(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    matchId: string,
  ): Promise<void> {
    this.requireMethod(request, ['POST']);
    const principal = this.requireAdmin(request);
    this.requireSameOrigin(request);
    requireJsonContentType(request);
    const idempotencyKey = requireHeader(
      request.headers['idempotency-key'], 'Idempotency-Key', PLAYER_IDEMPOTENCY_KEY_LIMIT,
    );
    const body = requireExactObject(
      await readJson(request, QUEUE_BODY_LIMIT), ['queueEntryIds', 'reason'], [],
    );
    const resources = await this.requirePlayerRuntime().getForCleanup();
    const entries = await resources.service.completeMatch({
      queueEntryIds: body.queueEntryIds as string[],
      matchId,
      reason: operatorReason(body.reason),
      idempotencyKey: playerServiceKey(
        `operator:${principal.email}`,
        `match-complete:${matchId}`,
        idempotencyKey,
      ),
      authorization: resources.operatorAuthorization(principal.email),
    });
    sendJson(response, 200, {
      matchId,
      entries: entries.map(entry => ({ queueEntryId: entry.id, status: entry.status })),
    }, { 'Cache-Control': 'no-store' });
  }

  private openEventStream(request: http.IncomingMessage, response: http.ServerResponse): void {
    if (this.streams.size >= this.maxEventStreams) {
      throw new ArcadeHttpError(503, 'EVENT_STREAM_LIMIT', 'Twilio Games event stream capacity is exhausted');
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();

    let closed = false;
    let unsubscribe: () => void = () => undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stream: EventStream = {
      response,
      close: () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        this.streams.delete(stream);
        response.end();
      },
    };
    this.streams.add(stream);
    const writeChunk = (chunk: string) => {
      if (closed || response.destroyed) return;
      if (!response.write(chunk)) stream.close();
    };
    const write = (event: ArcadeEvent) => writeChunk(formatEvent(event));
    unsubscribe = this.events.subscribe(write);
    heartbeat = setInterval(() => {
      writeChunk(': keep-alive\n\n');
    }, this.heartbeatMs);
    heartbeat.unref?.();
    write({
      type: ARCADE_CONFIG_UPDATED_EVENT,
      version: this.configStore.getSnapshot().version,
    });
    request.once('aborted', stream.close);
    response.once('close', stream.close);
  }

  private requirePlayerRuntime(): ArcadePlayerRuntime {
    if (!this.playerRuntime) {
      throw new ArcadeHttpError(503, 'ARCADE_STATE_UNAVAILABLE', 'Twilio Games player state is unavailable');
    }
    return this.playerRuntime;
  }

  private validateStationAdmissionConfig(config: ArcadeConfigSnapshot): void {
    const issue = this.stationCapabilityIssue(config);
    if (issue) throw new ArcadeHttpError(422, issue.code, issue.message);
  }

  private stationCapabilityIssue(
    config: ArcadeConfigSnapshot,
  ): Readonly<{ code: string; message: string }> | null {
    if (config.arcade.mode === 'off') return null;
    if (this.displayToken.length < 16) {
      return {
        code: 'STATION_DISPLAY_TOKEN_REQUIRED',
        message: 'Configure ARCADE_DISPLAY_TOKEN with at least 16 characters before enabling station mode.',
      };
    }
    if (!config.channels.voice) {
      return {
        code: 'STATION_VOICE_REQUIRED',
        message: 'Enable the Voice channel before saving an active station mode.',
      };
    }
    const voiceNumbers = this.effectiveVoiceNumbers(config);
    const missingLocales = (['en-US', 'pt-BR'] as const).filter(locale => voiceNumbers[locale] === null);
    if (missingLocales.length > 0) {
      return {
        code: 'STATION_VOICE_NUMBERS_REQUIRED',
        message: `Configure an E.164 Voice number for ${missingLocales.join(' and ')} or configure GAME_PHONE_NUMBER before saving an active station mode.`,
      };
    }
    if (config.arcade.mode === 'coin_only'
      && !((config.channels.sms && this.messagingCapabilities.sms)
        || (config.channels.whatsapp && this.messagingCapabilities.whatsapp))) {
      return {
        code: 'COIN_ONLY_MESSAGING_REQUIRED',
        message: 'coin_only requires an enabled channel with a configured sender: TWILIO_SMS_NUMBER/TWILIO_PHONE_NUMBER for SMS or TWILIO_WHATSAPP_NUMBER for WhatsApp.',
      };
    }
    return null;
  }

  private requireStationRuntimeCapabilities(config = this.configStore.getSnapshot()): void {
    const issue = this.stationCapabilityIssue(config);
    if (issue) throw new ArcadeHttpError(503, 'STATION_CAPABILITY_UNAVAILABLE', issue.message);
  }

  private async getActivePlayerResources() {
    this.requireStationRuntimeCapabilities();
    const resources = await this.requirePlayerRuntime().getActive();
    this.bindStationAbortHandler(resources);
    return resources;
  }

  private tacMessagingReady(): boolean {
    if (!this.tacRequired) return true;
    const status = this.tacStatus?.() as { started?: unknown; connected?: unknown } | undefined;
    return status?.started === true && status.connected === true;
  }

  private bindStationAbortHandler(
    resources: NonNullable<ReturnType<ArcadePlayerRuntime['getInitializedResources']>>,
  ): void {
    resources.station.setMatchRemovedHandler((game, roomCode, removal) => {
      this.removeLiveStationEngine(game, roomCode, removal);
    });
    resources.station.setMatchParticipantsChangedHandler((game, roomCode, count, activeEnginePlayerIds, participantSlots) => {
      this.updateStationEngineParticipants?.(game, roomCode, count, activeEnginePlayerIds, participantSlots);
    });
  }

  private abortLiveStationEngine(
    game: PlayableArcadeGame,
    roomCode: string,
  ): void {
    this.removeLiveStationEngine(game, roomCode, 'abort');
  }

  private removeLiveStationEngine(
    game: PlayableArcadeGame,
    roomCode: string,
    removal: StationMatchRemoval,
  ): void {
    this.abortStationEngine?.(game, roomCode, removal);
    this.stationRoomCodes.delete(roomCode);
    const station = this.playerRuntime?.getInitializedResources()?.station;
    for (const readyEntryId of this.stationVoiceConnections.keys()) {
      station?.markParticipantDisconnected(readyEntryId);
    }
    this.stationVoiceCalls.clear();
    this.stationVoiceConnections.clear();
  }

  private requirePlayerSession(
    request: http.IncomingMessage,
    sessions: ArcadePlayerSessionService,
  ): string {
    const session = sessions.readCookie(
      request.headers.cookie,
      this.playerSessionAudience(this.configStore.getSnapshot().arcade.cabinetId),
    );
    if (!session) {
      throw new ArcadeHttpError(401, 'ARCADE_SESSION_REQUIRED', 'Twilio Games player session is required');
    }
    return session.player;
  }

  private playerSessionAudience(cabinetId: string): string {
    return `${this.expectedOrigin}#${cabinetId}`;
  }

  private enforceRate(key: string, limit: number, windowMs: number): void {
    this.enforceRateWith(this.rateLimiter, key, limit, windowMs);
  }

  private enforceProcessRate(key: string, limit: number, windowMs: number): void {
    this.enforceRateWith(this.processRateLimiter, key, limit, windowMs);
  }

  private enforceRateWith(
    limiter: ArcadeRateLimiter,
    key: string,
    limit: number,
    windowMs: number,
  ): void {
    const result = limiter.consume(key, limit, windowMs);
    if (result.allowed) return;
    const error = new ArcadeHttpError(429, 'RATE_LIMITED', 'Twilio Games request rate limit exceeded');
    Object.defineProperty(error, 'retryAfter', {
      value: String(result.retryAfterSeconds), enumerable: false,
    });
    throw error;
  }

  private requireAdmin(request: http.IncomingMessage): ArcadeAdminPrincipal {
    let principal: ArcadeAdminPrincipal | null = null;
    try {
      principal = this.authorizeAdmin(request);
    } catch {
      principal = null;
    }
    const email = principal?.email.trim().toLowerCase() ?? '';
    if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+$/.test(email)) {
      throw new ArcadeHttpError(401, 'ADMIN_AUTH_REQUIRED', 'Twilio Games operator authentication is required');
    }
    return { email };
  }

  private requireDisplayAuthorization(request: http.IncomingMessage): void {
    const supplied = Buffer.from(firstHeader(request.headers['x-arcade-display-token'])?.trim() ?? '', 'utf8');
    if (this.displayToken.length < 16 || supplied.length !== this.displayToken.length
      || !timingSafeEqual(supplied, this.displayToken)) {
      throw new ArcadeHttpError(401, 'ARCADE_DISPLAY_AUTH_REQUIRED', 'Twilio Games display authentication is required');
    }
  }

  private requireSameOrigin(request: http.IncomingMessage): void {
    const origin = firstHeader(request.headers.origin);
    if (origin !== this.expectedOrigin) {
      throw new ArcadeHttpError(403, 'ORIGIN_FORBIDDEN', 'request origin is not allowed');
    }
  }

  private requireMethod(request: http.IncomingMessage, allowed: readonly string[]): void {
    if (!allowed.includes(request.method ?? '')) this.methodNotAllowed(allowed);
  }

  private methodNotAllowed(allowed: readonly string[]): never {
    const error = new ArcadeHttpError(405, 'METHOD_NOT_ALLOWED', 'method is not allowed for this endpoint');
    Object.defineProperty(error, 'allowed', { value: allowed.join(', '), enumerable: false });
    throw error;
  }

  private sendError(response: http.ServerResponse, error: unknown): void {
    if (response.headersSent) {
      if (!response.writableEnded) response.end();
      return;
    }
    let status = 500;
    let code = 'ARCADE_INTERNAL_ERROR';
    let message = 'Twilio Games request failed';
    let details: Record<string, unknown> | undefined;
    let allow: string | undefined;
    let retryAfter: string | undefined;

    if (error instanceof ArcadeHttpError) {
      ({ status, code, message } = error);
      allow = (error as ArcadeHttpError & { allowed?: string }).allowed;
      retryAfter = (error as ArcadeHttpError & { retryAfter?: string }).retryAfter;
    } else if (error instanceof ArcadeConfigValidationError) {
      status = 400;
      code = 'INVALID_ARCADE_CONFIG';
      message = error.message;
    } else if (error instanceof ArcadeConfigVersionConflictError) {
      status = 412;
      code = 'ARCADE_CONFIG_VERSION_CONFLICT';
      message = error.message;
      details = { expectedVersion: error.expectedVersion, currentVersion: error.actualVersion };
    } else if (error instanceof ArcadeConfigIdempotencyConflictError) {
      status = 409;
      code = 'IDEMPOTENCY_CONFLICT';
      message = error.message;
    } else if (error instanceof ArcadeConfigDegradedError) {
      status = 503;
      code = 'ARCADE_CONFIG_DEGRADED';
      message = error.message;
    } else if (error instanceof ArcadeConfigStoreError) {
      message = error.message;
    } else if (error instanceof ArcadePlayerRuntimeError) {
      status = error.code === 'MODE_DISABLED' ? 409 : 503;
      code = error.code === 'MODE_DISABLED'
        ? 'ARCADE_MODE_DISABLED'
        : error.code === 'CONFIG_DEGRADED' ? 'ARCADE_CONFIG_DEGRADED' : 'ARCADE_STATE_UNAVAILABLE';
      message = error.code === 'MODE_DISABLED'
        ? 'station mode is off'
        : error.code === 'CONFIG_DEGRADED'
          ? 'Twilio Games configuration integrity is degraded; new activity is disabled'
          : 'Twilio Games player state is unavailable';
    } else if (error instanceof ArcadePlayerSessionError) {
      status = 401;
      code = 'ARCADE_SESSION_REQUIRED';
      message = 'Twilio Games player session is invalid or expired';
    } else if (error instanceof ArcadeMessagingRetryError) {
      status = error.code === 'INVALID_RETRY_REQUEST' || error.code === 'INVALID_NOTIFICATION'
        ? 400
        : error.code === 'NOTIFICATION_NOT_FOUND' ? 404 : 409;
      code = error.code;
      message = error.message;
    } else if (error instanceof ArcadeServiceError) {
      ({ status, code, message } = playerServiceError(error.code));
    } else if (error instanceof ArcadeDomainError) {
      ({ status, code, message } = playerDomainError(error.code));
    } else if (error instanceof ArcadeQueueError) {
      ({ status, code, message } = playerQueueError(error.code));
    } else if (error instanceof ArcadeStationError) {
      ({ status, code, message } = playerStationError(error.code));
    } else if (error instanceof ArcadeStateStoreError) {
      status = 503;
      code = 'ARCADE_STATE_UNAVAILABLE';
      message = 'Twilio Games player state is unavailable';
    }

    sendJson(response, status, { error: { code, message, ...(details ? { details } : {}) } }, {
      'Cache-Control': 'no-store',
      ...(allow ? { Allow: allow } : {}),
      ...(retryAfter ? { 'Retry-After': retryAfter } : {}),
    });
  }
}

function requestPath(request: http.IncomingMessage): string {
  try {
    return new URL(request.url ?? '/', 'http://localhost').pathname;
  } catch {
    throw new ArcadeHttpError(400, 'INVALID_URL', 'request URL is invalid');
  }
}

function parseChallengeRoute(pathname: string): {
  challengeId: string;
  action: 'token' | 'claim';
} | null {
  const match = /^\/api\/arcade\/challenges\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\/(token|claim)$/.exec(pathname);
  if (!match) return null;
  return { challengeId: match[1]!, action: match[2]! as 'token' | 'claim' };
}

function parseOperatorQueueRoute(pathname: string): {
  queueEntryId: string;
  action: 'approach' | 'call' | 'expire' | 'requeue' | 'activate' | 'release';
} | null {
  const match = /^\/api\/admin\/arcade\/queue\/([A-Za-z0-9](?:[A-Za-z0-9:._-]{0,127}))\/(approach|call|expire|requeue|activate|release)$/.exec(pathname);
  if (!match) return null;
  return {
    queueEntryId: match[1]!,
    action: match[2]! as 'approach' | 'call' | 'expire' | 'requeue' | 'activate' | 'release',
  };
}

function parseOperatorMessagingRetryRoute(pathname: string): { notificationId: string } | null {
  const match = /^\/api\/admin\/arcade\/messaging\/notifications\/(outbound(?::|%3A)[a-f0-9]{64})\/retry$/i.exec(pathname);
  return match ? { notificationId: match[1]!.replace(/%3A/i, ':').toLowerCase() } : null;
}

function parseOperatorPlayerBalanceRestoreRoute(pathname: string): { playerId: string } | null {
  const match = /^\/api\/admin\/arcade\/players\/([A-Za-z0-9](?:(?:%3A)|[A-Za-z0-9:._-]){0,255})\/restore-starting-balance$/i.exec(pathname);
  return match ? { playerId: match[1]!.replace(/%3A/ig, ':') } : null;
}

function parseOperatorPlayerResetRoute(pathname: string): { playerId: string } | null {
  const match = /^\/api\/admin\/arcade\/players\/([A-Za-z0-9](?:(?:%3A)|[A-Za-z0-9:._-]){0,255})\/reset$/i.exec(pathname);
  return match ? { playerId: match[1]!.replace(/%3A/ig, ':') } : null;
}

function parseOperatorStationCoinGrantRoute(pathname: string): { readyEntryId: string } | null {
  const match = /^\/api\/admin\/arcade\/station\/ready\/([A-Za-z0-9](?:(?:%3A)|[A-Za-z0-9:._-]){0,127})\/coins\/grant$/i.exec(pathname);
  return match ? { readyEntryId: match[1]!.replace(/%3A/ig, ':') } : null;
}

function parseOperatorStationDropRoute(pathname: string): { readyEntryId: string } | null {
  const match = /^\/api\/admin\/arcade\/station\/ready\/([A-Za-z0-9](?:(?:%3A)|[A-Za-z0-9:._-]){0,127})\/drop$/i.exec(pathname);
  return match ? { readyEntryId: match[1]!.replace(/%3A/ig, ':') } : null;
}

function parseOperatorTestPlayerResetRoute(pathname: string): { readyEntryId: string } | null {
  const match = /^\/api\/admin\/arcade\/station\/ready\/([A-Za-z0-9](?:(?:%3A)|[A-Za-z0-9:._-]){0,127})\/reset-test-player$/i.exec(pathname);
  return match ? { readyEntryId: match[1]!.replace(/%3A/ig, ':') } : null;
}

function parseOperatorMatchRoute(pathname: string): { matchId: string } | null {
  const match = /^\/api\/admin\/arcade\/matches\/([A-Za-z0-9](?:[A-Za-z0-9:._-]{0,127}))\/complete$/.exec(pathname);
  return match ? { matchId: match[1]! } : null;
}

type OperatorStationAction = 'close' | 'select' | 'launch' | 'complete' | 'advance' | 'hold' | 'fail' | 'reset';

function parseOperatorStationRoute(pathname: string): OperatorStationAction | null {
  const routes: Readonly<Record<string, OperatorStationAction>> = {
    '/api/admin/arcade/station/recruiting/close': 'close',
    '/api/admin/arcade/station/game/select': 'select',
    '/api/admin/arcade/station/launch/request': 'launch',
    '/api/admin/arcade/station/match/complete': 'complete',
    '/api/admin/arcade/station/results/advance': 'advance',
    '/api/admin/arcade/station/results/hold': 'hold',
    '/api/admin/arcade/station/launch/fail': 'fail',
    '/api/admin/arcade/station/reset': 'reset',
  };
  return Object.prototype.hasOwnProperty.call(routes, pathname) ? routes[pathname]! : null;
}

function configEtag(version: number): string {
  return `"arcade-config-${version}"`;
}

function stationEtag(revision: number): string {
  return `"arcade-station-${revision}"`;
}

function parseIfMatch(value: string | string[] | undefined): number {
  const header = firstHeader(value);
  const match = /^"arcade-config-([1-9][0-9]*)"$/.exec(header ?? '');
  const version = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(version)) {
    throw new ArcadeHttpError(428, 'ARCADE_CONFIG_VERSION_REQUIRED', 'a current Twilio Games settings ETag is required');
  }
  return version;
}

function parseStationIfMatch(value: string | string[] | undefined): number {
  const header = firstHeader(value);
  const match = /^"arcade-station-([1-9][0-9]*)"$/.exec(header ?? '');
  const revision = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(revision)) {
    throw new ArcadeHttpError(428, 'ARCADE_STATION_REVISION_REQUIRED', 'a current station ETag is required');
  }
  return revision;
}

function playerStationAggregate(state: ArcadeState, playerId: string, defaultStationId: string) {
  const entry = Object.values(state.stationReadyEntries)
    .find(candidate => candidate.playerId === playerId && !['COMPLETED', 'LEFT'].includes(candidate.status));
  return stationAggregateFromState(state, entry?.stationId ?? defaultStationId);
}

function enabledStationGames(
  config: ArcadeConfigSnapshot,
): ReadonlySet<PlayableArcadeGame> {
  return new Set(PLAYABLE_ARCADE_GAMES
    .map(game => game.id)
    .filter(game => config.station.games[game].enabled));
}

function requireHeader(value: string | string[] | undefined, name: string, maximum: number): string {
  const header = firstHeader(value)?.trim() ?? '';
  if (!header || header.length > maximum || /[\u0000-\u001f\u007f]/.test(header)) {
    throw new ArcadeHttpError(400, 'INVALID_HEADER', `${name} must be a non-empty bounded header`);
  }
  return header;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requireJsonContentType(request: http.IncomingMessage): void {
  const contentType = firstHeader(request.headers['content-type'])?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new ArcadeHttpError(415, 'JSON_REQUIRED', 'Content-Type must be application/json');
  }
}

function requireExactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArcadeHttpError(400, 'INVALID_REQUEST', 'request body must be an object');
  }
  const object = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(object);
  if (keys.some(key => !allowed.has(key))
    || required.some(key => !Object.prototype.hasOwnProperty.call(object, key))) {
    throw new ArcadeHttpError(400, 'INVALID_REQUEST', 'request body has unexpected or missing fields');
  }
  return object;
}

function playerServiceKey(playerId: string, route: string, externalKey: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([playerId, route, externalKey]), 'utf8')
    .digest('hex');
  return `api:${digest}`;
}

function operatorReason(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ArcadeHttpError(400, 'INVALID_REQUEST', 'operator reason must be a non-empty bounded string');
  }
  return value.trim();
}

function messagingRateLimitReply(locale: string): string {
  return locale.toLowerCase().startsWith('pt')
    ? 'Muitas mensagens foram recebidas. Aguarde alguns minutos e tente novamente.'
    : 'Too many messages were received. Wait a few minutes and try again.';
}

function publicQueueStatus(status: ArcadeQueueStatus | null): Omit<ArcadeQueueStatus, 'queueEntryId'> | null {
  if (!status) return null;
  const { queueEntryId: _queueEntryId, ...safe } = status;
  return safe;
}

function publicOperatorQueueStatus(
  status: ArcadeOperatorQueueStatus,
): Omit<ArcadeOperatorQueueStatus, 'playerId'> {
  const { playerId: _playerId, ...safe } = status;
  return safe;
}

function playerServiceError(serviceCode: string): { status: number; code: string; message: string } {
  switch (serviceCode) {
    case 'INVALID_INPUT':
    case 'INVALID_REGISTRATION':
    case 'INVALID_GAME':
    case 'INVALID_MATCH':
      return { status: 400, code: serviceCode, message: 'Twilio Games request is invalid' };
    case 'TERMS_REQUIRED':
      return { status: 422, code: serviceCode, message: 'terms acknowledgement is required' };
    case 'IDEMPOTENCY_CONFLICT':
      return { status: 409, code: serviceCode, message: 'idempotency key was reused for another request' };
    case 'STALE_STATION_REVISION':
      return { status: 412, code: serviceCode, message: 'The live event changed. Refresh and review the player before retrying.' };
    case 'STALE_CONFIG_VERSION':
      return { status: 412, code: serviceCode, message: 'Event settings changed. Refresh before restoring coins.' };
    case 'MODE_DISABLED':
      return { status: 409, code: 'ARCADE_MODE_DISABLED', message: 'station mode does not allow this operation' };
    case 'PAUSED_EVENT_RESET_REQUIRED':
      return { status: 409, code: serviceCode, message: 'The event is paused. Reset the event flow before taking another game-control action.' };
    case 'UNSUPPORTED_CHARGE_POLICY':
    case 'QUEUE_DISABLED':
      return { status: 503, code: serviceCode, message: 'Twilio Games operation is unavailable' };
    case 'CONFIG_DEGRADED':
      return {
        status: 503,
        code: 'ARCADE_CONFIG_DEGRADED',
        message: 'Twilio Games configuration integrity is degraded; new activity is disabled',
      };
    case 'PLAYER_NOT_FOUND':
    case 'WALLET_NOT_FOUND':
      return { status: 409, code: 'REGISTRATION_REQUIRED', message: 'player registration is required' };
    case 'PLAYER_SESSION_RETIRED':
      return { status: 409, code: serviceCode, message: 'player session was reset; start a new session' };
    case 'CONVERSATION_MEMORY_RESET_UNAVAILABLE':
      return { status: 503, code: serviceCode, message: 'Conversation Memory reset is unavailable' };
    case 'CONVERSATION_MEMORY_RESET_FAILED':
      return { status: 502, code: serviceCode, message: 'Conversation Memory could not be cleared; retry the reset' };
    case 'PHONE_ALREADY_LINKED':
      return { status: 409, code: serviceCode, message: 'phone number is already linked to another player' };
    case 'PHONE_CHANGE_REQUIRES_RELINK':
      return { status: 409, code: serviceCode, message: 'messaging-linked phone number requires verified relinking' };
    case 'PLAYER_ACTIVE_ADMISSION':
      return { status: 409, code: serviceCode, message: 'player has an active game or coin hold' };
    case 'PLAYER_BALANCE_CHANGED':
      return { status: 409, code: serviceCode, message: 'player balance is no longer zero' };
    case 'PLAYER_BALANCE_RESTORE_UNAVAILABLE':
      return { status: 409, code: serviceCode, message: 'starting balance restoration is unavailable' };
    case 'TEST_PLAYER_RESET_CONNECTED':
      return { status: 409, code: serviceCode, message: 'Hang up the player call before resetting this player.' };
    case 'CHALLENGE_VISIT_REQUIRED':
      return { status: 409, code: serviceCode, message: 'Visit the challenge before claiming its coins.' };
    case 'MESSAGING_IDENTITY_REQUIRED':
      return { status: 409, code: serviceCode, message: 'join through SMS or WhatsApp before entering the ready pool' };
    case 'QUEUE_FULL':
    case 'GAME_NOT_ELIGIBLE':
      return { status: 409, code: serviceCode, message: 'station queue operation cannot be completed' };
    case 'CHALLENGE_UNAVAILABLE':
    case 'CHALLENGE_TOKEN_REPLAYED':
      return { status: 409, code: serviceCode, message: 'game challenge cannot be claimed' };
    case 'MATCH_NOT_READY':
    case 'MATCH_NOT_ACTIVE':
    case 'RESULTS_NOT_ACTIVE':
    case 'MATCH_PARTICIPANTS_MISMATCH':
    case 'CABINET_CHANGED':
    case 'READY_POOL_FULL':
    case 'READY_ENTRY_NOT_FOUND':
    case 'READY_ENTRY_FORBIDDEN':
    case 'READY_ENTRY_NOT_READY':
    case 'TEST_PLAYER_RESET_UNSAFE':
    case 'TEST_PLAYER_RESET_MESSAGES_PENDING':
    case 'RESERVATION_NOT_ACTIVE':
    case 'STALE_STATION_LAUNCH':
    case 'SELECTION_NOT_ACTIVE':
    case 'GAME_DISABLED':
      return { status: 409, code: serviceCode, message: 'Twilio Games match operation cannot be completed' };
    case 'STATION_NOT_FOUND':
      return { status: 404, code: serviceCode, message: 'Twilio Games station was not found' };
    case 'STATION_COIN_POLICY_UNSUPPORTED':
      return { status: 503, code: serviceCode, message: 'station coin operation is unavailable' };
    case 'STATION_ACTION_UNAUTHORIZED':
      return { status: 403, code: serviceCode, message: 'station control is not authorized' };
    case 'INVALID_CHALLENGE_TOKEN':
      return { status: 400, code: serviceCode, message: 'game challenge token is invalid' };
    case 'QUEUE_ENTRY_NOT_FOUND':
    case 'QUEUE_ENTRY_FORBIDDEN':
      return { status: 409, code: 'QUEUE_ENTRY_REQUIRED', message: 'player has no active queue entry' };
    default:
      return { status: 500, code: 'ARCADE_INTERNAL_ERROR', message: 'Twilio Games request failed' };
  }
}

function playerDomainError(domainCode: string): { status: number; code: string; message: string } {
  if (domainCode === 'INSUFFICIENT_BALANCE' || domainCode === 'IDEMPOTENCY_CONFLICT'
    || domainCode === 'CHALLENGE_CLAIM_LIMIT' || domainCode === 'CHALLENGE_UNAVAILABLE'
    || domainCode === 'ACTIVE_RESERVATION_EXISTS') {
    return { status: 409, code: domainCode, message: 'game coin wallet operation cannot be completed' };
  }
  return { status: 400, code: 'INVALID_REQUEST', message: 'Twilio Games request is invalid' };
}

function playerStationError(stationCode: string): { status: number; code: string; message: string } {
  if (stationCode === 'REVISION_CONFLICT') {
    return { status: 412, code: 'ARCADE_STATION_VERSION_CONFLICT', message: 'station state changed' };
  }
  if (stationCode.startsWith('INVALID_')) {
    return { status: 400, code: 'INVALID_REQUEST', message: 'station request is invalid' };
  }
  return { status: 409, code: stationCode, message: 'station transition cannot be completed' };
}

function playerQueueError(queueCode: string): { status: number; code: string; message: string } {
  if (queueCode === 'INVALID_QUEUE_VALUE' || queueCode === 'INVALID_SELECTION_LIMIT') {
    return { status: 400, code: 'INVALID_REQUEST', message: 'station queue request is invalid' };
  }
  return { status: 409, code: queueCode, message: 'station queue transition cannot be completed' };
}

async function readJson(request: http.IncomingMessage, maximumBytes: number): Promise<unknown> {
  const contentLength = firstHeader(request.headers['content-length']);
  if (contentLength !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new ArcadeHttpError(400, 'INVALID_CONTENT_LENGTH', 'Content-Length is invalid');
    }
    if (Number(contentLength) > maximumBytes) {
      request.resume();
      throw new ArcadeHttpError(413, 'REQUEST_TOO_LARGE', `request body exceeds ${maximumBytes} bytes`);
    }
  }

  const body = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maximumBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(bytes);
    });
    request.once('end', () => {
      if (tooLarge) reject(new ArcadeHttpError(413, 'REQUEST_TOO_LARGE', `request body exceeds ${maximumBytes} bytes`));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.once('aborted', () => reject(new ArcadeHttpError(400, 'REQUEST_ABORTED', 'request body was aborted')));
    request.once('error', reject);
  });
  if (!body.trim()) throw new ArcadeHttpError(400, 'INVALID_JSON', 'request body must contain JSON');
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new ArcadeHttpError(400, 'INVALID_JSON', 'request body is not valid JSON');
  }
}

function formatEvent(event: ArcadeEvent): string {
  const id = event.type === ARCADE_CONFIG_UPDATED_EVENT
    ? String(event.version)
    : event.type === 'arcade_ready_entry_added' ? `ready:${event.revision}` : `station:${event.revision}`;
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

function pruneStandaloneMessagingState(state: ArcadeState, now: number): void {
  const cutoff = now - ARCADE_MESSAGING_RETENTION_MS;
  const receipts = Object.values(state.inboundMessages)
    .filter(message => message.command === 'STANDALONE')
    .sort((left, right) => Date.parse(left.receivedAt) - Date.parse(right.receivedAt)
      || left.id.localeCompare(right.id));
  const expiredReceipts = receipts.filter(message => Date.parse(message.receivedAt) < cutoff);
  const retainedReceipts = receipts.filter(message => Date.parse(message.receivedAt) >= cutoff);
  const excessReceipts = retainedReceipts.slice(
    0, Math.max(0, retainedReceipts.length - STANDALONE_MESSAGING_MAX_RECORDS + 1),
  );
  for (const message of [...expiredReceipts, ...excessReceipts]) {
    delete state.inboundMessages[message.id];
    delete state.idempotencyRecords[message.id];
  }

  const localeRecords = Object.entries(state.idempotencyRecords)
    .filter(([key]) => key.startsWith('standalone-locale:'))
    .sort(([, left], [, right]) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  const expiredLocales = localeRecords.filter(([, record]) => Date.parse(record.createdAt) < cutoff);
  const retainedLocales = localeRecords.filter(([, record]) => Date.parse(record.createdAt) >= cutoff);
  const excessLocales = retainedLocales.slice(
    0, Math.max(0, retainedLocales.length - STANDALONE_MESSAGING_MAX_RECORDS + 1),
  );
  for (const [key] of [...expiredLocales, ...excessLocales]) delete state.idempotencyRecords[key];
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}
