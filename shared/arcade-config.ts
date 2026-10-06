// Activate v8 writes only after every rollback target can read v8. Promotion is intentionally one-way;
// deployment must provide the staged compatibility gate rather than relying on a lossy downmigration.
export const ARCADE_CONFIG_SCHEMA_VERSION = 8 as const;

export type ArcadeMode = 'off' | 'coin_only' | 'lead_capture';
export type ArcadeGame = 'racer' | 'monsters' | 'fighter' | 'karaoke' | 'trivia' | 'chess';
export type RegistrationFieldKey =
  | 'firstName'
  | 'lastName'
  | 'workEmail'
  | 'companyName'
  | 'phoneNumber'
  | 'countryCode';
export type CoinChargePolicy = 'per_player' | 'per_match' | 'host_sponsors' | 'free';
export type PostGameChannel = 'sms' | 'whatsapp';
export type MarketingConsentMode = 'separate';
export type CountryCode = string & { readonly __countryCode: unique symbol };
export type IsoTimestamp = string & { readonly __isoTimestamp: unique symbol };

export type BasicRegistrationField = {
  readonly key: 'firstName' | 'lastName' | 'companyName';
  readonly enabled: boolean;
  readonly required: boolean;
};

export type UnverifiedRegistrationField = {
  readonly key: 'workEmail' | 'phoneNumber';
  readonly enabled: boolean;
  readonly required: boolean;
  readonly verify: false;
};

export type CountryRegistrationField = {
  readonly key: 'countryCode';
  readonly enabled: boolean;
  readonly required: boolean;
  readonly length: 2;
};

export type RegistrationField =
  | BasicRegistrationField
  | UnverifiedRegistrationField
  | CountryRegistrationField;

export type ArcadeSettings = {
  readonly mode: ArcadeMode;
  readonly cabinetId: string;
  readonly displayName: string;
};

export type StationGame = ArcadeGame;
/** @deprecated Compatibility tombstone retained for persisted Trivia configs. */
export type HomeConcept = 'trivia';
export type AutomaticSelectionPolicy = 'best_fit_rotation' | 'round_robin' | 'fixed_priority';
export type StationQrRail = 'auto' | 'always' | 'hidden';

export type StationTimingSettings = {
  readonly recruitingSeconds: number;
  readonly hardDeadlineSeconds: number;
  readonly selectionSeconds: number;
  readonly lockedSeconds: number;
  readonly launchTimeoutSeconds: number;
  readonly resultsSeconds: number;
  readonly postGameRecruitingSeconds: number;
};

export type StationGameSettings = {
  readonly enabled: boolean;
};

export type StationGamesSettings = Readonly<Record<StationGame, StationGameSettings>>;
export type HomeConceptSettings = Readonly<Record<HomeConcept, { readonly enabled: false }>>;

export type StationAutomaticSelectionSettings = {
  readonly policy: AutomaticSelectionPolicy;
  readonly order: readonly StationGame[];
};

export type StationSettings = {
  readonly timings: StationTimingSettings;
  readonly games: StationGamesSettings;
  readonly comingSoon: HomeConceptSettings;
  readonly automaticSelection: StationAutomaticSelectionSettings;
  readonly qrRail: StationQrRail;
};

export type RegistrationSettings = {
  readonly requiredByDefault: boolean;
  readonly fields: readonly RegistrationField[];
  readonly termsAcknowledgementRequired: boolean;
  readonly marketingConsentMode: MarketingConsentMode;
};

export type GameCosts = Readonly<Record<ArcadeGame, number>>;

export type CoinSettings = {
  readonly startingBalance: number;
  readonly defaultGameCost: number;
  readonly gameCosts: GameCosts;
  readonly chargePolicy: CoinChargePolicy;
  readonly consumeWhen: 'match_start';
  readonly expiresAfterHours: number | null;
  readonly refundOnLobbyTimeout: boolean;
  readonly disconnectGraceSeconds: number;
};

export type EarningChallenge = {
  readonly id: string;
  readonly title: string;
  readonly message: string | null;
  readonly url: string;
  readonly rewardCoins: number;
  readonly enabled: boolean;
  readonly maxClaimsPerPlayer: number;
  readonly displayOrder: number;
  readonly startsAt: IsoTimestamp | null;
  readonly endsAt: IsoTimestamp | null;
};

export type EarningSettings = {
  readonly enabled: boolean;
  readonly defaultRewardCoins: number;
  readonly challenges: readonly EarningChallenge[];
};

export type QueueSettings = {
  readonly enabled: boolean;
  readonly maximumWaitingPlayers: number;
  readonly approachingNotificationGroups: number;
  readonly checkInWindowSeconds: number;
  readonly baseJoinWindowSeconds: number;
  readonly readyGraceSeconds: number;
  readonly hardStartDeadlineSeconds: number;
  readonly standbyPlayers: number;
  readonly automaticDeferrals: number;
  readonly removeAfterMisses: number;
  readonly snoozeSeconds: number;
};

export type ChannelSettings = {
  readonly voice: boolean;
  readonly sms: boolean;
  readonly whatsapp: boolean;
  readonly voiceNumbers: Readonly<{
    readonly 'en-US': string | null;
    readonly 'pt-BR': string | null;
  }>;
};

export type PostGameSettings = {
  readonly enabled: boolean;
  readonly channels: readonly PostGameChannel[];
  readonly includeScore: boolean;
  readonly includeLeaderboard: boolean;
  readonly includeCoinBalance: boolean;
  readonly includeChallenges: boolean;
  readonly includeRematchLink: boolean;
  readonly includeAchievement: boolean;
  readonly includeIntelligenceTip: boolean;
};

export type IntelligenceSettings = {
  readonly enabled: boolean;
  readonly analyzeConfusion: boolean;
  readonly analyzeSentiment: boolean;
  readonly analyzeRecognitionProblems: boolean;
  readonly analyzeLanguageMismatch: boolean;
  readonly analyzeHelpRequests: boolean;
  readonly analyzeProductInterest: boolean;
};

export type ArcadeConfigSettings = {
  readonly arcade: ArcadeSettings;
  readonly station: StationSettings;
  readonly registration: RegistrationSettings;
  readonly coins: CoinSettings;
  readonly earning: EarningSettings;
  readonly queue: QueueSettings;
  readonly channels: ChannelSettings;
  readonly postGame: PostGameSettings;
  readonly intelligence: IntelligenceSettings;
};

export type ArcadeConfig = ArcadeConfigSettings & {
  /** Format discriminator. This changes only when the schema changes. */
  readonly schemaVersion: typeof ARCADE_CONFIG_SCHEMA_VERSION;
  /** Monotonic configuration revision. */
  readonly version: number;
  readonly updatedAt: IsoTimestamp;
  readonly updatedBy: string;
};

export type ArcadeConfigSnapshot = ArcadeConfig;
export type ArcadeRuntimeConfig = ArcadeConfig;

export type PublicEarningChallenge = Omit<EarningChallenge, 'url'>;
export type PublicArcadeConfig = Omit<ArcadeConfig, 'updatedAt' | 'updatedBy' | 'earning'> & {
  readonly earning: Omit<EarningSettings, 'challenges'> & {
    readonly challenges: readonly PublicEarningChallenge[];
  };
};

export type ArcadeConfigUpdateMetadata = {
  readonly updatedAt?: string;
  readonly updatedBy?: string;
};

export class ArcadeConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArcadeConfigValidationError';
  }
}

const CONFIG_KEYS = [
  'schemaVersion', 'version', 'updatedAt', 'updatedBy',
  'arcade', 'station', 'registration', 'coins', 'earning', 'queue', 'channels', 'postGame', 'intelligence',
] as const;
const SETTINGS_KEYS = [
  'arcade', 'station', 'registration', 'coins', 'earning', 'queue', 'channels', 'postGame', 'intelligence',
] as const;
export const STATION_GAMES: readonly StationGame[] = Object.freeze(['racer', 'monsters', 'fighter', 'karaoke', 'trivia', 'chess']);
const HOME_CONCEPTS: readonly HomeConcept[] = ['trivia'];
const REGISTRATION_FIELD_KEYS: readonly RegistrationFieldKey[] = [
  'firstName', 'lastName', 'workEmail', 'companyName', 'phoneNumber', 'countryCode',
];
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_COIN_AMOUNT = 100;
const MAX_CHALLENGES = 100;
const MAX_POST_GAME_CHANNELS = 2;
const MAX_QUEUE_WAITING_PLAYERS = 5_000;
const MAX_IDENTIFIER_LENGTH = 64;
const MAX_DISPLAY_NAME_LENGTH = 100;
const MAX_CHALLENGE_TITLE_LENGTH = 200;
const MAX_UPDATED_BY_LENGTH = 254;
const MAX_URL_LENGTH = 2_048;
const MAX_SECONDS = 86_400;

function invalid(path: string, message: string): never {
  throw new ArcadeConfigValidationError(`${path}: ${message}`);
}

/** Rejects values that cannot have come from ordinary, pollution-safe JSON. */
function assertSafeInput(value: unknown, path = '$', seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) invalid(path, 'cyclic or shared object references are not allowed');
  seen.add(value);

  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) invalid(path, 'unsafe array prototype');
    const keys = Reflect.ownKeys(value);
    for (const key of keys) {
      if (typeof key !== 'string') invalid(path, 'symbol keys are not allowed');
      if (key === 'length') continue;
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        invalid(path, `unknown array property ${JSON.stringify(key)}`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        invalid(`${path}[${key}]`, 'accessor or hidden properties are not allowed');
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) invalid(path, 'sparse arrays are not allowed');
      assertSafeInput(value[index], `${path}[${index}]`, seen);
    }
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(path, 'unsafe object prototype');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') invalid(path, 'symbol keys are not allowed');
    if (FORBIDDEN_KEYS.has(key)) invalid(`${path}.${key}`, 'prototype-polluting key is not allowed');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      invalid(`${path}.${key}`, 'accessor or hidden properties are not allowed');
    }
    assertSafeInput(descriptor.value, `${path}.${key}`, seen);
  }
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(path, 'expected an object');
  }
  return value as Record<string, unknown>;
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
  path: string,
): Record<string, unknown> {
  const object = objectAt(value, path);
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(object)) {
    if (!expected.has(key)) invalid(`${path}.${key}`, 'unknown field');
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(object, key)) invalid(`${path}.${key}`, 'field is required');
  }
  return object;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') invalid(path, 'expected a boolean');
  return value;
}

function integerAt(value: unknown, minimum: number, maximum: number, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    invalid(path, `expected an integer from ${minimum} through ${maximum}`);
  }
  return value as number;
}

function stationGameCostAt(value: unknown, path: string): number {
  if (value !== 1) invalid(path, 'must be exactly 1 because station admission costs one coin per player');
  return 1;
}

function enumAt<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    invalid(path, `expected one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function safeStringAt(value: unknown, path: string, maximumLength: number): string {
  if (typeof value !== 'string') invalid(path, 'expected a string');
  const normalized = value.trim().normalize('NFC');
  if (normalized.length === 0 || normalized.length > maximumLength) {
    invalid(path, `expected 1 through ${maximumLength} characters after trimming`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    invalid(path, 'control characters are not allowed');
  }
  return normalized;
}

export function normalizeCountryCode(value: unknown): CountryCode {
  if (typeof value !== 'string') invalid('countryCode', 'expected a string');
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) {
    invalid('countryCode', 'expected exactly two ASCII letters');
  }
  // UK remains UK. Any future UK-to-GB CRM mapping belongs at that integration boundary.
  return normalized as CountryCode;
}

function isoTimestampAt(value: unknown, path: string): IsoTimestamp {
  const input = safeStringAt(value, path, 64);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(input);
  if (!match) invalid(path, 'expected an ISO 8601 timestamp with a timezone');

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) {
    invalid(path, 'invalid ISO 8601 calendar date or time');
  }
  const zone = match[8]!;
  if (zone !== 'Z') {
    const zoneHours = Number(zone.slice(1, 3));
    const zoneMinutes = Number(zone.slice(4, 6));
    if (zoneHours > 14 || zoneMinutes > 59 || (zoneHours === 14 && zoneMinutes !== 0)) {
      invalid(path, 'invalid ISO 8601 timezone offset');
    }
  }
  const milliseconds = Date.parse(input);
  if (!Number.isFinite(milliseconds)) invalid(path, 'invalid ISO 8601 timestamp');
  return new Date(milliseconds).toISOString() as IsoTimestamp;
}

function nullableIsoTimestampAt(value: unknown, path: string): IsoTimestamp | null {
  return value === null ? null : isoTimestampAt(value, path);
}

function privateIpv4(octets: readonly number[]): boolean {
  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second! >= 64 && second! <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second! >= 16 && second! <= 31)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first! >= 224;
}

function ipv4Octets(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.every(octet => octet >= 0 && octet <= 255) ? octets : null;
}

function ipv6Groups(hostname: string): number[] | null {
  const halves = hostname.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right];
  if (groups.length !== 8 || groups.some(group => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.map(group => Number.parseInt(group, 16));
}

function privateIpv6(hostname: string): boolean {
  const groups = ipv6Groups(hostname);
  if (!groups) return true;
  const first = groups[0]!;
  const isUnspecified = groups.every(group => group === 0);
  const isLoopback = groups.slice(0, 7).every(group => group === 0) && groups[7] === 1;
  if (isUnspecified || isLoopback) return true;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0) return true;
  if ((first & 0xff00) === 0xff00) return true;

  const isIpv4Mapped = groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff;
  const isIpv4Compatible = groups.slice(0, 6).every(group => group === 0);
  if (isIpv4Mapped || isIpv4Compatible) {
    const high = groups[6]!;
    const low = groups[7]!;
    return privateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  }
  return false;
}

function unsafeDestinationHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const ipv4 = ipv4Octets(hostname);
  if (ipv4) return privateIpv4(ipv4);
  if (hostname.includes(':')) return privateIpv6(hostname);
  return !hostname.includes('.')
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.lan')
    || hostname.endsWith('.home')
    || hostname.endsWith('.localdomain');
}

function parseArcade(value: unknown): ArcadeSettings {
  const object = exactObject(value, ['mode', 'cabinetId', 'displayName'], '$.arcade');
  const cabinetId = safeStringAt(object.cabinetId, '$.arcade.cabinetId', MAX_IDENTIFIER_LENGTH);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(cabinetId)) {
    invalid('$.arcade.cabinetId', 'must contain only letters, numbers, dot, underscore, and hyphen');
  }
  return {
    mode: enumAt(object.mode, ['off', 'coin_only', 'lead_capture'], '$.arcade.mode'),
    cabinetId,
    displayName: safeStringAt(object.displayName, '$.arcade.displayName', MAX_DISPLAY_NAME_LENGTH),
  };
}

function parseStation(value: unknown, mode: ArcadeMode): StationSettings {
  const object = exactObject(value, ['timings', 'games', 'comingSoon', 'automaticSelection', 'qrRail'], '$.station');
  const timingInput = exactObject(object.timings, [
    'recruitingSeconds', 'hardDeadlineSeconds', 'selectionSeconds', 'lockedSeconds',
    'launchTimeoutSeconds', 'resultsSeconds', 'postGameRecruitingSeconds',
  ], '$.station.timings');
  const timings: StationTimingSettings = {
    recruitingSeconds: integerAt(timingInput.recruitingSeconds, 15, 600, '$.station.timings.recruitingSeconds'),
    hardDeadlineSeconds: integerAt(timingInput.hardDeadlineSeconds, 15, 900, '$.station.timings.hardDeadlineSeconds'),
    selectionSeconds: integerAt(timingInput.selectionSeconds, 5, 180, '$.station.timings.selectionSeconds'),
    lockedSeconds: integerAt(timingInput.lockedSeconds, 3, 60, '$.station.timings.lockedSeconds'),
    launchTimeoutSeconds: integerAt(timingInput.launchTimeoutSeconds, 10, 180, '$.station.timings.launchTimeoutSeconds'),
    resultsSeconds: integerAt(timingInput.resultsSeconds, 3, 120, '$.station.timings.resultsSeconds'),
    postGameRecruitingSeconds: integerAt(
      timingInput.postGameRecruitingSeconds,
      10,
      300,
      '$.station.timings.postGameRecruitingSeconds',
    ),
  };
  if (timings.hardDeadlineSeconds < timings.recruitingSeconds) {
    invalid('$.station.timings', 'hardDeadlineSeconds cannot be less than recruitingSeconds');
  }
  if (timings.hardDeadlineSeconds < timings.postGameRecruitingSeconds) {
    invalid('$.station.timings', 'hardDeadlineSeconds cannot be less than postGameRecruitingSeconds');
  }
  if (timings.postGameRecruitingSeconds < timings.resultsSeconds) {
    invalid('$.station.timings', 'postGameRecruitingSeconds cannot be less than resultsSeconds');
  }

  const gameInput = exactObject(object.games, STATION_GAMES, '$.station.games');
  const games: StationGamesSettings = {
    racer: parseStationGame(gameInput.racer, '$.station.games.racer'),
    monsters: parseStationGame(gameInput.monsters, '$.station.games.monsters'),
    fighter: parseStationGame(gameInput.fighter, '$.station.games.fighter'),
    karaoke: parseStationGame(gameInput.karaoke, '$.station.games.karaoke'),
    trivia: parseStationGame(gameInput.trivia, '$.station.games.trivia'),
    chess: parseStationGame(gameInput.chess, '$.station.games.chess'),
  };
  if (mode !== 'off' && !STATION_GAMES.some(game => games[game].enabled)) {
    invalid('$.station.games', 'at least one game must be enabled when arcade mode is not off');
  }
  const conceptInput = exactObject(object.comingSoon, HOME_CONCEPTS, '$.station.comingSoon');
  const comingSoon: HomeConceptSettings = {
    trivia: parseComingSoonTombstone(conceptInput.trivia, '$.station.comingSoon.trivia'),
  };

  const selectionInput = exactObject(
    object.automaticSelection,
    ['policy', 'order'],
    '$.station.automaticSelection',
  );
  if (!Array.isArray(selectionInput.order)) {
    invalid('$.station.automaticSelection.order', 'expected an array');
  }
  if (selectionInput.order.length !== STATION_GAMES.length) {
    invalid('$.station.automaticSelection.order', 'must contain all station games exactly once');
  }
  const order = selectionInput.order.map((game, index) => (
    enumAt(game, STATION_GAMES, `$.station.automaticSelection.order[${index}]`)
  ));
  if (new Set(order).size !== STATION_GAMES.length) {
    invalid('$.station.automaticSelection.order', 'must contain all station games exactly once');
  }

  return {
    timings,
    games,
    comingSoon,
    automaticSelection: {
      policy: enumAt(
        selectionInput.policy,
        ['best_fit_rotation', 'round_robin', 'fixed_priority'],
        '$.station.automaticSelection.policy',
      ),
      order,
    },
    qrRail: enumAt(object.qrRail, ['auto', 'always', 'hidden'], '$.station.qrRail'),
  };
}

function parseStationGame(value: unknown, path: string): StationGameSettings {
  const object = exactObject(value, ['enabled'], path);
  return { enabled: booleanAt(object.enabled, `${path}.enabled`) };
}

function parseComingSoonTombstone(value: unknown, path: string): HomeConceptSettings[HomeConcept] {
  const setting = parseStationGame(value, path);
  if (setting.enabled) invalid(`${path}.enabled`, 'deprecated compatibility tombstone must remain false');
  return { enabled: false };
}

function parseRegistrationField(value: unknown, index: number): RegistrationField {
  const path = `$.registration.fields[${index}]`;
  const object = objectAt(value, path);
  const key = enumAt(object.key, REGISTRATION_FIELD_KEYS, `${path}.key`);
  const common = {
    enabled: booleanAt(object.enabled, `${path}.enabled`),
    required: booleanAt(object.required, `${path}.required`),
  };
  if (common.required && !common.enabled) invalid(path, 'a disabled field cannot be required');

  if (key === 'workEmail' || key === 'phoneNumber') {
    exactObject(value, ['key', 'enabled', 'required', 'verify'], path);
    if (object.verify !== false) invalid(`${path}.verify`, 'verification must be false');
    return { key, ...common, verify: false };
  }
  if (key === 'countryCode') {
    exactObject(value, ['key', 'enabled', 'required', 'length'], path);
    if (object.length !== 2) invalid(`${path}.length`, 'must be 2');
    return { key, ...common, length: 2 };
  }
  exactObject(value, ['key', 'enabled', 'required'], path);
  return { key, ...common };
}

function parseRegistration(value: unknown, mode: ArcadeMode): RegistrationSettings {
  const object = exactObject(
    value,
    ['requiredByDefault', 'fields', 'termsAcknowledgementRequired', 'marketingConsentMode'],
    '$.registration',
  );
  if (!Array.isArray(object.fields)) invalid('$.registration.fields', 'expected an array');
  if (object.fields.length !== REGISTRATION_FIELD_KEYS.length) {
    invalid('$.registration.fields', 'must contain exactly the approved six fields');
  }
  const fields = object.fields.map(parseRegistrationField);
  const seen = new Set<RegistrationFieldKey>();
  for (const field of fields) {
    if (seen.has(field.key)) invalid('$.registration.fields', `duplicate field ${field.key}`);
    seen.add(field.key);
  }
  for (const key of REGISTRATION_FIELD_KEYS) {
    if (!seen.has(key)) invalid('$.registration.fields', `missing field ${key}`);
  }

  const requiredByDefault = booleanAt(object.requiredByDefault, '$.registration.requiredByDefault');
  if (mode === 'lead_capture' && (!requiredByDefault || fields.some(field => !field.enabled || !field.required))) {
    invalid('$.registration', 'lead_capture mode requires all six fields to be enabled and required');
  }
  return {
    requiredByDefault,
    fields,
    termsAcknowledgementRequired: booleanAt(
      object.termsAcknowledgementRequired,
      '$.registration.termsAcknowledgementRequired',
    ),
    marketingConsentMode: enumAt(object.marketingConsentMode, ['separate'], '$.registration.marketingConsentMode'),
  };
}

function parseCoins(value: unknown): CoinSettings {
  const object = exactObject(value, [
    'startingBalance', 'defaultGameCost', 'gameCosts', 'chargePolicy', 'consumeWhen',
    'expiresAfterHours', 'refundOnLobbyTimeout', 'disconnectGraceSeconds',
  ], '$.coins');
  const costs = exactObject(object.gameCosts, STATION_GAMES, '$.coins.gameCosts');
  const expiresAfterHours = object.expiresAfterHours === null
    ? null
    : integerAt(object.expiresAfterHours, 1, 87_600, '$.coins.expiresAfterHours');
  const chargePolicy = enumAt(
    object.chargePolicy,
    ['per_player', 'free'] as const,
    '$.coins.chargePolicy',
  );
  const startingBalance = integerAt(object.startingBalance, 0, MAX_COIN_AMOUNT, '$.coins.startingBalance');
  if (chargePolicy === 'per_player' && startingBalance < 1) {
    invalid('$.coins.startingBalance', 'must be at least 1 when chargePolicy is per_player');
  }
  return {
    startingBalance,
    defaultGameCost: stationGameCostAt(object.defaultGameCost, '$.coins.defaultGameCost'),
    gameCosts: {
      racer: stationGameCostAt(costs.racer, '$.coins.gameCosts.racer'),
      monsters: stationGameCostAt(costs.monsters, '$.coins.gameCosts.monsters'),
      fighter: stationGameCostAt(costs.fighter, '$.coins.gameCosts.fighter'),
      karaoke: stationGameCostAt(costs.karaoke, '$.coins.gameCosts.karaoke'),
      trivia: stationGameCostAt(costs.trivia, '$.coins.gameCosts.trivia'),
      chess: stationGameCostAt(costs.chess, '$.coins.gameCosts.chess'),
    },
    chargePolicy,
    consumeWhen: enumAt(object.consumeWhen, ['match_start'], '$.coins.consumeWhen'),
    expiresAfterHours,
    refundOnLobbyTimeout: booleanAt(object.refundOnLobbyTimeout, '$.coins.refundOnLobbyTimeout'),
    disconnectGraceSeconds: integerAt(
      object.disconnectGraceSeconds,
      0,
      MAX_SECONDS,
      '$.coins.disconnectGraceSeconds',
    ),
  };
}

function parseChallenge(value: unknown, index: number): EarningChallenge {
  const path = `$.earning.challenges[${index}]`;
  const object = exactObject(value, [
    'id', 'title', 'message', 'url', 'rewardCoins', 'enabled', 'maxClaimsPerPlayer',
    'displayOrder', 'startsAt', 'endsAt',
  ], path);
  const id = safeStringAt(object.id, `${path}.id`, MAX_IDENTIFIER_LENGTH);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(id) || FORBIDDEN_KEYS.has(id)) {
    invalid(`${path}.id`, 'must be a safe lowercase slug');
  }
  const url = safeStringAt(object.url, `${path}.url`, MAX_URL_LENGTH);
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    invalid(`${path}.url`, 'expected an absolute HTTPS URL');
  }
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username !== '' || parsedUrl.password !== '') {
    invalid(`${path}.url`, 'expected an HTTPS URL without embedded credentials');
  }
  if (unsafeDestinationHostname(parsedUrl.hostname)) {
    invalid(`${path}.url`, 'loopback, private, and local destinations are not allowed');
  }
  const startsAt = nullableIsoTimestampAt(object.startsAt, `${path}.startsAt`);
  const endsAt = nullableIsoTimestampAt(object.endsAt, `${path}.endsAt`);
  if (startsAt !== null && endsAt !== null && Date.parse(startsAt) >= Date.parse(endsAt)) {
    invalid(path, 'startsAt must be earlier than endsAt');
  }
  return {
    id,
    title: safeStringAt(object.title, `${path}.title`, MAX_CHALLENGE_TITLE_LENGTH),
    message: object.message === null
      ? null
      : safeStringAt(object.message, `${path}.message`, 300),
    url: parsedUrl.href,
    rewardCoins: integerAt(object.rewardCoins, 1, MAX_COIN_AMOUNT, `${path}.rewardCoins`),
    enabled: booleanAt(object.enabled, `${path}.enabled`),
    maxClaimsPerPlayer: integerAt(object.maxClaimsPerPlayer, 1, 100, `${path}.maxClaimsPerPlayer`),
    displayOrder: integerAt(object.displayOrder, 0, 1_000_000, `${path}.displayOrder`),
    startsAt,
    endsAt,
  };
}

function parseEarning(value: unknown): EarningSettings {
  const object = exactObject(value, ['enabled', 'defaultRewardCoins', 'challenges'], '$.earning');
  if (!Array.isArray(object.challenges)) invalid('$.earning.challenges', 'expected an array');
  if (object.challenges.length > MAX_CHALLENGES) {
    invalid('$.earning.challenges', `cannot contain more than ${MAX_CHALLENGES} challenges`);
  }
  const challenges = object.challenges.map(parseChallenge);
  const ids = new Set<string>();
  for (const challenge of challenges) {
    if (ids.has(challenge.id)) invalid('$.earning.challenges', `duplicate challenge ${challenge.id}`);
    ids.add(challenge.id);
  }
  return {
    enabled: booleanAt(object.enabled, '$.earning.enabled'),
    defaultRewardCoins: integerAt(
      object.defaultRewardCoins,
      1,
      MAX_COIN_AMOUNT,
      '$.earning.defaultRewardCoins',
    ),
    challenges,
  };
}

function parseQueue(value: unknown): QueueSettings {
  const object = exactObject(value, [
    'enabled', 'maximumWaitingPlayers', 'approachingNotificationGroups', 'checkInWindowSeconds',
    'baseJoinWindowSeconds', 'readyGraceSeconds', 'hardStartDeadlineSeconds', 'standbyPlayers',
    'automaticDeferrals', 'removeAfterMisses', 'snoozeSeconds',
  ], '$.queue');
  const queue: QueueSettings = {
    enabled: booleanAt(object.enabled, '$.queue.enabled'),
    maximumWaitingPlayers: integerAt(
      object.maximumWaitingPlayers,
      1,
      MAX_QUEUE_WAITING_PLAYERS,
      '$.queue.maximumWaitingPlayers',
    ),
    approachingNotificationGroups: integerAt(
      object.approachingNotificationGroups,
      0,
      1_000,
      '$.queue.approachingNotificationGroups',
    ),
    checkInWindowSeconds: integerAt(object.checkInWindowSeconds, 1, MAX_SECONDS, '$.queue.checkInWindowSeconds'),
    baseJoinWindowSeconds: integerAt(object.baseJoinWindowSeconds, 1, MAX_SECONDS, '$.queue.baseJoinWindowSeconds'),
    readyGraceSeconds: integerAt(object.readyGraceSeconds, 0, MAX_SECONDS, '$.queue.readyGraceSeconds'),
    hardStartDeadlineSeconds: integerAt(
      object.hardStartDeadlineSeconds,
      1,
      MAX_SECONDS,
      '$.queue.hardStartDeadlineSeconds',
    ),
    standbyPlayers: integerAt(object.standbyPlayers, 0, 1_000, '$.queue.standbyPlayers'),
    automaticDeferrals: integerAt(object.automaticDeferrals, 0, 100, '$.queue.automaticDeferrals'),
    removeAfterMisses: integerAt(object.removeAfterMisses, 1, 100, '$.queue.removeAfterMisses'),
    snoozeSeconds: integerAt(object.snoozeSeconds, 1, MAX_SECONDS, '$.queue.snoozeSeconds'),
  };
  if (queue.checkInWindowSeconds > queue.hardStartDeadlineSeconds) {
    invalid('$.queue', 'checkInWindowSeconds cannot exceed hardStartDeadlineSeconds');
  }
  if (queue.baseJoinWindowSeconds + queue.readyGraceSeconds > queue.hardStartDeadlineSeconds) {
    invalid('$.queue', 'baseJoinWindowSeconds plus readyGraceSeconds cannot exceed hardStartDeadlineSeconds');
  }
  if (queue.automaticDeferrals >= queue.removeAfterMisses) {
    invalid('$.queue', 'automaticDeferrals must be less than removeAfterMisses');
  }
  return queue;
}

function parseChannels(value: unknown): ChannelSettings {
  const object = exactObject(value, ['voice', 'sms', 'whatsapp', 'voiceNumbers'], '$.channels');
  const voiceNumbers = exactObject(object.voiceNumbers, ['en-US', 'pt-BR'], '$.channels.voiceNumbers');
  const englishVoiceNumber = nullablePhoneNumberAt(voiceNumbers['en-US'], '$.channels.voiceNumbers.en-US');
  const portugueseVoiceNumber = nullablePhoneNumberAt(voiceNumbers['pt-BR'], '$.channels.voiceNumbers.pt-BR');
  if (englishVoiceNumber !== null && englishVoiceNumber === portugueseVoiceNumber) {
    invalid('$.channels.voiceNumbers', 'locale voice numbers must be different');
  }
  return {
    voice: booleanAt(object.voice, '$.channels.voice'),
    sms: booleanAt(object.sms, '$.channels.sms'),
    whatsapp: booleanAt(object.whatsapp, '$.channels.whatsapp'),
    voiceNumbers: {
      'en-US': englishVoiceNumber,
      'pt-BR': portugueseVoiceNumber,
    },
  };
}

function nullablePhoneNumberAt(value: unknown, path: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') invalid(path, 'expected an E.164 number or null');
  const normalized = value.trim();
  if (!/^\+[1-9][0-9]{7,14}$/.test(normalized)) invalid(path, 'expected an E.164 number or null');
  return normalized;
}

function parsePostGame(value: unknown): PostGameSettings {
  const object = exactObject(value, [
    'enabled', 'channels', 'includeScore', 'includeLeaderboard', 'includeCoinBalance',
    'includeChallenges', 'includeRematchLink', 'includeAchievement', 'includeIntelligenceTip',
  ], '$.postGame');
  if (!Array.isArray(object.channels)) invalid('$.postGame.channels', 'expected an array');
  if (object.channels.length > MAX_POST_GAME_CHANNELS) {
    invalid('$.postGame.channels', `cannot contain more than ${MAX_POST_GAME_CHANNELS} channels`);
  }
  const channels: PostGameChannel[] = object.channels.map((channel, index) => (
    enumAt(channel, ['sms', 'whatsapp'] as const, `$.postGame.channels[${index}]`)
  ));
  if (new Set(channels).size !== channels.length) invalid('$.postGame.channels', 'duplicate channel');
  const postGame: PostGameSettings = {
    enabled: booleanAt(object.enabled, '$.postGame.enabled'),
    channels,
    includeScore: booleanAt(object.includeScore, '$.postGame.includeScore'),
    includeLeaderboard: booleanAt(object.includeLeaderboard, '$.postGame.includeLeaderboard'),
    includeCoinBalance: booleanAt(object.includeCoinBalance, '$.postGame.includeCoinBalance'),
    includeChallenges: booleanAt(object.includeChallenges, '$.postGame.includeChallenges'),
    includeRematchLink: booleanAt(object.includeRematchLink, '$.postGame.includeRematchLink'),
    includeAchievement: booleanAt(object.includeAchievement, '$.postGame.includeAchievement'),
    includeIntelligenceTip: booleanAt(object.includeIntelligenceTip, '$.postGame.includeIntelligenceTip'),
  };
  if (postGame.enabled && postGame.channels.length === 0) {
    invalid('$.postGame.channels', 'must contain at least one channel when post-game delivery is enabled');
  }
  if (postGame.enabled) {
    for (const field of [
      'includeScore',
      'includeLeaderboard',
      'includeRematchLink',
      'includeAchievement',
      'includeIntelligenceTip',
    ] as const) {
      if (postGame[field]) invalid(`$.postGame.${field}`, 'is not supported for enabled post-game delivery');
    }
  }
  return postGame;
}

function parseIntelligence(value: unknown): IntelligenceSettings {
  const object = exactObject(value, [
    'enabled', 'analyzeConfusion', 'analyzeSentiment', 'analyzeRecognitionProblems',
    'analyzeLanguageMismatch', 'analyzeHelpRequests', 'analyzeProductInterest',
  ], '$.intelligence');
  return {
    enabled: booleanAt(object.enabled, '$.intelligence.enabled'),
    analyzeConfusion: booleanAt(object.analyzeConfusion, '$.intelligence.analyzeConfusion'),
    analyzeSentiment: booleanAt(object.analyzeSentiment, '$.intelligence.analyzeSentiment'),
    analyzeRecognitionProblems: booleanAt(
      object.analyzeRecognitionProblems,
      '$.intelligence.analyzeRecognitionProblems',
    ),
    analyzeLanguageMismatch: booleanAt(object.analyzeLanguageMismatch, '$.intelligence.analyzeLanguageMismatch'),
    analyzeHelpRequests: booleanAt(object.analyzeHelpRequests, '$.intelligence.analyzeHelpRequests'),
    analyzeProductInterest: booleanAt(object.analyzeProductInterest, '$.intelligence.analyzeProductInterest'),
  };
}

function parseSettingsObject(object: Record<string, unknown>): ArcadeConfigSettings {
  const arcade = parseArcade(object.arcade);
  const channels = parseChannels(object.channels);
  if (arcade.mode === 'coin_only' && !channels.sms && !channels.whatsapp) {
    invalid('$.channels', 'coin_only mode requires SMS or WhatsApp identity');
  }
  const postGame = parsePostGame(object.postGame);
  const coins = parseCoins(object.coins);
  if (arcade.mode !== 'off' && coins.chargePolicy !== 'per_player') {
    invalid('$.coins.chargePolicy', 'Messaging Entry and Lead Capture require one coin per player');
  }
  if (postGame.enabled) {
    for (const channel of postGame.channels) {
      if (!channels[channel]) invalid(`$.postGame.channels`, `${channel} must also be enabled in $.channels`);
    }
  }
  return {
    arcade,
    station: parseStation(object.station, arcade.mode),
    registration: parseRegistration(object.registration, arcade.mode),
    coins,
    earning: parseEarning(object.earning),
    queue: parseQueue(object.queue),
    channels,
    postGame,
    intelligence: parseIntelligence(object.intelligence),
  };
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function decodeInput(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  try {
    return JSON.parse(input) as unknown;
  } catch {
    invalid('$', 'invalid JSON');
  }
}

/** Parses, normalizes, deeply clones, and freezes a complete stored configuration. */
export function parseArcadeConfig(input: unknown): ArcadeConfigSnapshot {
  const decoded = decodeInput(input);
  assertSafeInput(decoded);
  const object = exactObject(decoded, CONFIG_KEYS, '$');
  if (object.schemaVersion !== ARCADE_CONFIG_SCHEMA_VERSION) {
    invalid('$.schemaVersion', `expected ${ARCADE_CONFIG_SCHEMA_VERSION}`);
  }
  const parsed: ArcadeConfig = {
    schemaVersion: ARCADE_CONFIG_SCHEMA_VERSION,
    version: integerAt(object.version, 1, Number.MAX_SAFE_INTEGER, '$.version'),
    updatedAt: isoTimestampAt(object.updatedAt, '$.updatedAt'),
    updatedBy: safeStringAt(object.updatedBy, '$.updatedBy', MAX_UPDATED_BY_LENGTH),
    ...parseSettingsObject(object),
  };
  return freezeDeep(parsed);
}

/** Parses a full replacement settings payload. Server-owned metadata is intentionally not accepted. */
export function parseArcadeConfigSettings(input: unknown): ArcadeConfigSettings {
  const decoded = decodeInput(input);
  assertSafeInput(decoded);
  const object = exactObject(decoded, SETTINGS_KEYS, '$');
  return freezeDeep(parseSettingsObject(object));
}

export function createArcadeConfigSnapshot(input: unknown): ArcadeConfigSnapshot {
  return parseArcadeConfig(input);
}

export function projectPublicArcadeConfig(input: unknown): PublicArcadeConfig {
  const config = parseArcadeConfig(input);
  const challenges = config.earning.challenges.map(challenge => ({
    id: challenge.id,
    title: challenge.title,
    message: challenge.message,
    rewardCoins: challenge.rewardCoins,
    enabled: challenge.enabled,
    maxClaimsPerPlayer: challenge.maxClaimsPerPlayer,
    displayOrder: challenge.displayOrder,
    startsAt: challenge.startsAt,
    endsAt: challenge.endsAt,
  }));
  return freezeDeep({
    schemaVersion: config.schemaVersion,
    version: config.version,
    arcade: config.arcade,
    station: config.station,
    registration: config.registration,
    coins: config.coins,
    earning: {
      enabled: config.earning.enabled,
      defaultRewardCoins: config.earning.defaultRewardCoins,
      challenges,
    },
    queue: config.queue,
    channels: config.channels,
    postGame: config.postGame,
    intelligence: config.intelligence,
  });
}

function parseUpdateMetadata(
  current: ArcadeConfig,
  metadata: ArcadeConfigUpdateMetadata | undefined,
): Pick<ArcadeConfig, 'updatedAt' | 'updatedBy'> {
  if (metadata === undefined) return { updatedAt: current.updatedAt, updatedBy: current.updatedBy };
  assertSafeInput(metadata, '$.metadata');
  const object = objectAt(metadata, '$.metadata');
  for (const key of Object.keys(object)) {
    if (key !== 'updatedAt' && key !== 'updatedBy') invalid(`$.metadata.${key}`, 'unknown field');
  }
  let updatedAt = current.updatedAt;
  if (metadata.updatedAt !== undefined) {
    updatedAt = isoTimestampAt(metadata.updatedAt, '$.metadata.updatedAt');
  }
  return {
    updatedAt,
    updatedBy: metadata.updatedBy === undefined
      ? current.updatedBy
      : safeStringAt(metadata.updatedBy, '$.metadata.updatedBy', MAX_UPDATED_BY_LENGTH),
  };
}

/**
 * Atomically replaces every client-editable setting. Metadata cannot be supplied in the replacement;
 * trusted metadata may be supplied separately, and the revision always advances by exactly one.
 */
export function replaceArcadeConfigSettings(
  currentInput: unknown,
  replacementInput: unknown,
  metadata?: ArcadeConfigUpdateMetadata,
): ArcadeConfigSnapshot {
  const current = parseArcadeConfig(currentInput);
  if (current.version === Number.MAX_SAFE_INTEGER) invalid('$.version', 'cannot advance beyond MAX_SAFE_INTEGER');
  const settings = parseArcadeConfigSettings(replacementInput);
  const serverMetadata = parseUpdateMetadata(current, metadata);
  return parseArcadeConfig({
    schemaVersion: current.schemaVersion,
    version: current.version + 1,
    ...serverMetadata,
    ...settings,
  });
}

export const updateArcadeConfig = replaceArcadeConfigSettings;
export const toPublicArcadeConfig = projectPublicArcadeConfig;

const DEFAULT_CONFIG_INPUT = {
  schemaVersion: ARCADE_CONFIG_SCHEMA_VERSION,
  version: 1,
  updatedAt: '1970-01-01T00:00:00.000Z',
  updatedBy: 'system',
  arcade: {
    mode: 'off',
    cabinetId: 'ARCADE-01',
    displayName: 'Twilio Games',
  },
  station: {
    timings: {
      recruitingSeconds: 90,
      hardDeadlineSeconds: 120,
      selectionSeconds: 30,
      lockedSeconds: 10,
      launchTimeoutSeconds: 120,
      resultsSeconds: 10,
      postGameRecruitingSeconds: 45,
    },
    games: {
      racer: { enabled: true },
      monsters: { enabled: true },
      fighter: { enabled: true },
      karaoke: { enabled: true },
      trivia: { enabled: true },
      chess: { enabled: true },
    },
    comingSoon: {
      trivia: { enabled: false },
    },
    automaticSelection: {
      policy: 'best_fit_rotation',
      order: ['racer', 'monsters', 'fighter', 'karaoke', 'trivia', 'chess'],
    },
    qrRail: 'auto',
  },
  registration: {
    requiredByDefault: true,
    fields: [
      { key: 'firstName', enabled: true, required: true },
      { key: 'lastName', enabled: true, required: true },
      { key: 'workEmail', enabled: true, required: true, verify: false },
      { key: 'companyName', enabled: true, required: true },
      { key: 'phoneNumber', enabled: true, required: true, verify: false },
      { key: 'countryCode', enabled: true, required: true, length: 2 },
    ],
    termsAcknowledgementRequired: true,
    marketingConsentMode: 'separate',
  },
  coins: {
    startingBalance: 1,
    defaultGameCost: 1,
    gameCosts: { racer: 1, monsters: 1, fighter: 1, karaoke: 1, trivia: 1, chess: 1 },
    chargePolicy: 'per_player',
    consumeWhen: 'match_start',
    expiresAfterHours: null,
    refundOnLobbyTimeout: true,
    disconnectGraceSeconds: 30,
  },
  earning: {
    enabled: true,
    defaultRewardCoins: 1,
    challenges: [],
  },
  queue: {
    enabled: true,
    maximumWaitingPlayers: 250,
    approachingNotificationGroups: 2,
    checkInWindowSeconds: 60,
    baseJoinWindowSeconds: 45,
    readyGraceSeconds: 20,
    hardStartDeadlineSeconds: 90,
    standbyPlayers: 2,
    automaticDeferrals: 1,
    removeAfterMisses: 2,
    snoozeSeconds: 300,
  },
  channels: {
    voice: true,
    sms: true,
    whatsapp: false,
    voiceNumbers: { 'en-US': null, 'pt-BR': null },
  },
  postGame: {
    enabled: false,
    channels: [],
    includeScore: false,
    includeLeaderboard: false,
    includeCoinBalance: true,
    includeChallenges: true,
    includeRematchLink: false,
    includeAchievement: false,
    includeIntelligenceTip: false,
  },
  intelligence: {
    enabled: false,
    analyzeConfusion: true,
    analyzeSentiment: true,
    analyzeRecognitionProblems: true,
    analyzeLanguageMismatch: true,
    analyzeHelpRequests: true,
    analyzeProductInterest: true,
  },
};

export const DEFAULT_ARCADE_CONFIG: ArcadeConfigSnapshot = parseArcadeConfig(DEFAULT_CONFIG_INPUT);

export function createDefaultArcadeConfig(): ArcadeConfigSnapshot {
  return parseArcadeConfig(DEFAULT_CONFIG_INPUT);
}
