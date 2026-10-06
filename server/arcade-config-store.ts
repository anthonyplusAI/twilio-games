import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  ARCADE_CONFIG_SCHEMA_VERSION,
  createDefaultArcadeConfig,
  parseArcadeConfig,
  parseArcadeConfigSettings,
  replaceArcadeConfigSettings,
  type ArcadeConfigSettings,
  type ArcadeConfigSnapshot,
} from '../shared/arcade-config';
import {
  createArcadeConfigUpdatedEvent,
  type ArcadeEventPublisher,
} from './arcade-events';

const CACHE_FILE_NAME = 'arcade-config.json';
const AUDIT_FILE_NAME = 'arcade-config-audit.jsonl';
const DEGRADED_FILE_SUFFIX = '.degraded.json';
const AUDIT_VERSION = 1;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const GENESIS_HASH = '0'.repeat(64);
const LEGACY_CONFIG_SCHEMA_VERSION = 1;
const STATION_CONFIG_SCHEMA_VERSION = 2;
const CHALLENGE_MESSAGE_CONFIG_SCHEMA_VERSION = 3;
const HOME_CONCEPT_CONFIG_SCHEMA_VERSION = 4;
const PRE_KARAOKE_CONFIG_SCHEMA_VERSION = 5;
const KARAOKE_CONFIG_SCHEMA_VERSION = 6;
const TRIVIA_CONFIG_SCHEMA_VERSION = 7;
const LEGACY_CONFIG_KEYS = [
  'schemaVersion', 'version', 'updatedAt', 'updatedBy',
  'arcade', 'registration', 'coins', 'earning', 'queue', 'channels', 'postGame', 'intelligence',
] as const;

export interface ArcadeConfigStoreFileSystem {
  readFile(file: string): Promise<string>;
  writeFile(file: string, contents: string, mode: number): Promise<void>;
  appendFile(file: string, contents: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(directory: string, mode: number): Promise<void>;
  chmod(file: string, mode: number): Promise<void>;
  unlink(file: string): Promise<void>;
  truncate(file: string, length: number): Promise<void>;
  syncFile(file: string): Promise<void>;
  syncDirectory(directory: string): Promise<void>;
}

export interface ArcadeConfigStoreOptions {
  directory?: string;
  cachePath?: string;
  auditPath?: string;
  events?: ArcadeEventPublisher;
  now?: () => Date;
  fs?: Partial<ArcadeConfigStoreFileSystem>;
  /** This file store intentionally has no cross-process locking. */
  deploymentMode?: 'single-process';
}

export interface ArcadeConfigUpdateRequest {
  readonly expectedVersion: number;
  readonly idempotencyKey: string;
  readonly updatedBy: string;
  readonly settings: unknown;
}

export type ArcadeConfigAuditRecord = Readonly<{
  auditVersion: typeof AUDIT_VERSION;
  idempotencyKey: string;
  requestHash: string;
  previousVersion: number;
  previousHash: string;
  config: ArcadeConfigSnapshot;
  recordHash: string;
}>;

export type ArcadeConfigStoreStatus = Readonly<{
  initialized: boolean;
  degraded: boolean;
  version: number;
  reason: string | null;
  quarantinePath: string | null;
}>;

export class ArcadeConfigStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArcadeConfigStoreError';
  }
}

export class ArcadeConfigVersionConflictError extends ArcadeConfigStoreError {
  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`arcade config version conflict: expected ${expectedVersion}, current version is ${actualVersion}`);
    this.name = 'ArcadeConfigVersionConflictError';
  }
}

export class ArcadeConfigIdempotencyConflictError extends ArcadeConfigStoreError {
  constructor(readonly idempotencyKey: string) {
    super(`idempotency key ${JSON.stringify(idempotencyKey)} was already used for a different request`);
    this.name = 'ArcadeConfigIdempotencyConflictError';
  }
}

export class ArcadeConfigAuditCorruptionError extends ArcadeConfigStoreError {
  constructor(readonly line: number, reason: string) {
    super(`arcade config audit is corrupt at line ${line}: ${reason}`);
    this.name = 'ArcadeConfigAuditCorruptionError';
  }
}

export class ArcadeConfigDegradedError extends ArcadeConfigStoreError {
  constructor(readonly reason: string) {
    super(`arcade config store is degraded and updates are disabled: ${reason}`);
    this.name = 'ArcadeConfigDegradedError';
  }
}

export class ArcadeConfigUnsupportedDeploymentError extends ArcadeConfigStoreError {
  constructor() {
    super('ArcadeConfigStore supports only single-process, single-replica deployment');
    this.name = 'ArcadeConfigUnsupportedDeploymentError';
  }
}

type IdempotencyEntry = {
  requestHash: string;
  config: ArcadeConfigSnapshot;
};

type TextFile = { exists: boolean; contents: string };

type AuditReadResult = {
  records: ArcadeConfigAuditRecord[];
  truncateTo: number | null;
  appendPrefix: '' | '\n';
  corruption: AuditCorruption | null;
};

type AuditCorruption = {
  line: number;
  reason: string;
  truncateTo: number;
  suffix: string;
};

type DegradedMarker = {
  reason: string;
  quarantinePath: string | null;
};

type ParsedStoredConfig = {
  snapshot: ArcadeConfigSnapshot;
  hashConfig: unknown;
};

type HashableAuditRecord = Readonly<{
  auditVersion: typeof AUDIT_VERSION;
  idempotencyKey: string;
  requestHash: string;
  previousVersion: number;
  previousHash: string;
  config: unknown;
}>;

const defaultFileSystem: ArcadeConfigStoreFileSystem = {
  readFile: file => readFile(file, 'utf8'),
  writeFile: async (file, contents, mode) => {
    await writeFile(file, contents, { encoding: 'utf8', flag: 'w', mode });
  },
  appendFile: async (file, contents, mode) => {
    await appendFile(file, contents, { encoding: 'utf8', flag: 'a', mode });
  },
  rename,
  mkdir: async (directory, mode) => { await mkdir(directory, { recursive: true, mode }); },
  chmod,
  unlink,
  truncate,
  syncFile: async file => {
    const handle = await open(file, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  },
  syncDirectory: syncDirectoryIfSupported,
};

/**
 * Durable runtime configuration for one Node.js process in one replica. Instances do not coordinate
 * across processes; deployments that need multiple writers must use a transactional shared store.
 */
export class ArcadeConfigStore {
  readonly cachePath: string;
  readonly auditPath: string;
  readonly degradedPath: string;

  private readonly fileSystem: ArcadeConfigStoreFileSystem;
  private readonly events?: ArcadeEventPublisher;
  private readonly now: () => Date;
  private currentSnapshot = createDefaultArcadeConfig();
  private idempotency = new Map<string, IdempotencyEntry>();
  private queue: Promise<void> = Promise.resolve();
  private initialized = false;
  private auditTruncateTo: number | null = null;
  private auditAppendPrefix: '' | '\n' = '';
  private latestAuditHash: string | null = null;
  private degraded = false;
  private degradedReason: string | null = null;
  private quarantinePath: string | null = null;

  constructor(options?: ArcadeConfigStoreOptions);
  constructor(directory: string, options?: Omit<ArcadeConfigStoreOptions, 'directory'>);
  constructor(
    directoryOrOptions: string | ArcadeConfigStoreOptions = {},
    overrides: Omit<ArcadeConfigStoreOptions, 'directory'> = {},
  ) {
    const options = typeof directoryOrOptions === 'string'
      ? { ...overrides, directory: directoryOrOptions }
      : directoryOrOptions;
    if ((options as { deploymentMode?: unknown }).deploymentMode !== undefined
      && options.deploymentMode !== 'single-process') {
      throw new ArcadeConfigUnsupportedDeploymentError();
    }
    const directory = options.directory ?? 'data';
    this.cachePath = options.cachePath ?? path.join(directory, CACHE_FILE_NAME);
    this.auditPath = options.auditPath ?? path.join(directory, AUDIT_FILE_NAME);
    this.degradedPath = `${this.auditPath}${DEGRADED_FILE_SUFFIX}`;
    this.fileSystem = { ...defaultFileSystem, ...options.fs };
    this.events = options.events;
    this.now = options.now ?? (() => new Date());
  }

  load(): Promise<ArcadeConfigSnapshot> {
    return this.enqueue(async () => {
      if (!this.initialized) await this.loadFromDisk();
      return this.currentSnapshot;
    });
  }

  read(): Promise<ArcadeConfigSnapshot> {
    return this.load();
  }

  getSnapshot(): ArcadeConfigSnapshot {
    return this.currentSnapshot;
  }

  getStatus(): ArcadeConfigStoreStatus {
    return Object.freeze({
      initialized: this.initialized,
      degraded: this.degraded,
      version: this.currentSnapshot.version,
      reason: this.degradedReason,
      quarantinePath: this.quarantinePath,
    });
  }

  /** Explicitly verifies the remediated audit and clears fail-closed update status. */
  repairAudit(): Promise<ArcadeConfigStoreStatus> {
    return this.enqueue(async () => {
      this.initialized = false;
      await this.loadFromDisk(true);
      if (this.degraded) throw new ArcadeConfigDegradedError(this.degradedReason ?? 'audit repair failed');
      return this.getStatus();
    });
  }

  update(request: ArcadeConfigUpdateRequest): Promise<ArcadeConfigSnapshot> {
    return this.enqueue(async () => {
      if (!this.initialized) await this.loadFromDisk();
      if (this.degraded) {
        throw new ArcadeConfigDegradedError(this.degradedReason ?? 'audit verification failed');
      }

      // Validation and optimistic concurrency belong inside the same serialized operation.
      const settings = parseArcadeConfigSettings(request.settings);
      const expectedVersion = parseExpectedVersion(request.expectedVersion);
      const idempotencyKey = normalizeStoredString(request.idempotencyKey, 'idempotency key', 255);
      const updatedBy = normalizeStoredString(request.updatedBy, 'updatedBy', 254);
      const requestHash = hashRequest(expectedVersion, updatedBy, settings);
      const replay = this.idempotency.get(idempotencyKey);
      if (replay) {
        if (replay.requestHash !== requestHash) {
          throw new ArcadeConfigIdempotencyConflictError(idempotencyKey);
        }
        return replay.config;
      }
      if (expectedVersion !== this.currentSnapshot.version) {
        throw new ArcadeConfigVersionConflictError(expectedVersion, this.currentSnapshot.version);
      }

      const updatedAt = this.now();
      if (!(updatedAt instanceof Date) || !Number.isFinite(updatedAt.getTime())) {
        throw new ArcadeConfigStoreError('now() must return a valid Date');
      }
      const next = replaceArcadeConfigSettings(this.currentSnapshot, settings, {
        updatedAt: updatedAt.toISOString(),
        updatedBy,
      });
      const recordWithoutHash: Omit<ArcadeConfigAuditRecord, 'recordHash'> = {
        auditVersion: AUDIT_VERSION,
        idempotencyKey,
        requestHash,
        previousVersion: this.currentSnapshot.version,
        previousHash: this.latestAuditHash ?? GENESIS_HASH,
        config: next,
      };
      const record: ArcadeConfigAuditRecord = Object.freeze({
        ...recordWithoutHash,
        recordHash: hashAuditRecord(recordWithoutHash),
      });

      await this.persist(record, this.currentSnapshot);

      this.currentSnapshot = next;
      this.latestAuditHash = record.recordHash;
      this.idempotency.set(idempotencyKey, { requestHash, config: next });
      try {
        this.events?.publish(createArcadeConfigUpdatedEvent(next.version));
      } catch {
        // A notification failure cannot roll back a durable configuration revision.
      }
      return next;
    });
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async loadFromDisk(clearDegraded = false): Promise<void> {
    let [cacheFile, auditFile, degradedFile] = await Promise.all([
      this.readTextFile(this.cachePath),
      this.readTextFile(this.auditPath),
      this.readTextFile(this.degradedPath),
    ]);

    let cached: ArcadeConfigSnapshot | null = null;
    if (cacheFile.exists) {
      try {
        cached = parseStoredConfig(cacheFile.contents).snapshot;
      } catch { /* The authoritative audit repairs an invalid cache below. */ }
    }

    let next = cached;
    let recoveredIdempotency = new Map<string, IdempotencyEntry>();
    let auditTruncateTo: number | null = null;
    let auditAppendPrefix: '' | '\n' = '';
    let repairCache = false;
    let latestAuditHash: string | null = null;
    let observedCorruption: AuditCorruption | null = null;
    let corruptionRemediated = false;
    let nextQuarantinePath: string | null = null;
    let remediationFailure: string | null = null;
    let persistedDegradation: DegradedMarker | null = null;
    if (degradedFile.exists) {
      try {
        persistedDegradation = parseDegradedMarker(degradedFile.contents);
      } catch (error) {
        persistedDegradation = {
          reason: `invalid degraded marker: ${errorMessage(error)}`,
          quarantinePath: null,
        };
      }
    }

    // A prior version may have quarantined a suffix that a newer migration can now parse. Rejoin it
    // to the retained valid prefix only when the complete candidate chain and every hash verify.
    if (persistedDegradation?.quarantinePath) {
      try {
        const quarantine = await this.readTextFile(persistedDegradation.quarantinePath);
        if (quarantine.exists) {
          const active = parseAudit(auditFile.contents);
          const separator = auditFile.contents && !auditFile.contents.endsWith('\n') ? '\n' : '';
          const candidate = `${auditFile.contents}${separator}${quarantine.contents}`;
          const recovered = parseAudit(candidate);
          if (!active.corruption && !recovered.corruption && recovered.records.length > active.records.length) {
            await this.writeAudit(candidate);
            auditFile = { exists: true, contents: candidate };
            await this.removeDegradedMarker();
            degradedFile = { exists: false, contents: '' };
            persistedDegradation = null;
          }
        }
      } catch { /* Keep the fail-closed marker when the quarantine still cannot be verified. */ }
    }

    if (auditFile.exists) {
      const audit = parseAudit(auditFile.contents);
      for (const record of audit.records) {
        recoveredIdempotency.set(record.idempotencyKey, {
          requestHash: record.requestHash,
          config: record.config,
        });
      }
      observedCorruption ??= audit.corruption;
      next = audit.records.at(-1)?.config ?? createDefaultArcadeConfig();
      latestAuditHash = audit.records.at(-1)?.recordHash ?? null;
      auditTruncateTo = audit.truncateTo;
      auditAppendPrefix = audit.appendPrefix;

      if (observedCorruption) {
        const corruptionReason = `line ${observedCorruption.line}: ${observedCorruption.reason}`;
        try {
          nextQuarantinePath = await this.writeQuarantine(observedCorruption.suffix);
          await this.writeDegradedMarker(corruptionReason, nextQuarantinePath);
          await this.truncateAudit(observedCorruption.truncateTo);
          auditTruncateTo = null;
          auditAppendPrefix = '';
          corruptionRemediated = true;
        } catch (error) {
          remediationFailure = errorMessage(error);
        }
      } else if (auditTruncateTo !== null) {
        try {
          await this.truncateAudit(auditTruncateTo);
          auditTruncateTo = null;
        } catch {
          // A partial tail remains recoverable; the next durable update retries the truncation.
        }
      }
      repairCache = cached === null || serializeConfig(cached) !== serializeConfig(next);
    } else {
      // A cache without its audit may be the uncommitted half of an interrupted first update.
      // The verified chain is authoritative, so fail safely to the default rather than trusting it.
      next = createDefaultArcadeConfig();
      repairCache = cacheFile.exists
        && (cached === null || serializeConfig(cached) !== serializeConfig(next));
    }

    next ??= createDefaultArcadeConfig();
    if (repairCache) await this.writeCache(next);

    this.currentSnapshot = next;
    this.idempotency = recoveredIdempotency;
    this.auditTruncateTo = auditTruncateTo;
    this.auditAppendPrefix = auditAppendPrefix;
    this.latestAuditHash = latestAuditHash;
    if (observedCorruption) {
      const reason = `line ${observedCorruption.line}: ${observedCorruption.reason}`
        + (remediationFailure ? `; quarantine/truncate failed: ${remediationFailure}` : '');
      const remainDegraded = !(clearDegraded && corruptionRemediated);
      if (!remainDegraded) await this.removeDegradedMarker();
      this.degraded = remainDegraded;
      this.degradedReason = this.degraded ? reason : null;
      this.quarantinePath = nextQuarantinePath ?? persistedDegradation?.quarantinePath ?? null;
    } else if (persistedDegradation && !clearDegraded) {
      this.degraded = true;
      this.degradedReason = persistedDegradation.reason;
      this.quarantinePath = persistedDegradation.quarantinePath;
    } else if (clearDegraded) {
      await this.removeDegradedMarker();
      this.degraded = false;
      this.degradedReason = null;
      this.quarantinePath = null;
    }
    this.initialized = true;
  }

  private async persist(
    record: ArcadeConfigAuditRecord,
    previous: ArcadeConfigSnapshot,
  ): Promise<void> {
    try {
      await this.ensureDirectory(this.auditPath);
      if (this.auditTruncateTo !== null) {
        await this.truncateAudit(this.auditTruncateTo);
        this.auditTruncateTo = null;
        this.auditAppendPrefix = '';
      }
      await this.writeCache(record.config);
      await this.fileSystem.appendFile(
        this.auditPath,
        `${this.auditAppendPrefix}${JSON.stringify(record)}\n`,
        FILE_MODE,
      );
      await this.makeAuditDurable();
      this.auditAppendPrefix = '';
    } catch (error) {
      try {
        if (await this.reconcileFailedPersistence(record, previous)) return;
      } catch {
        // If reconciliation itself fails, force a fresh load before the next update.
        this.initialized = false;
      }
      throw error;
    }
  }

  private async reconcileFailedPersistence(
    attempted: ArcadeConfigAuditRecord,
    previous: ArcadeConfigSnapshot,
  ): Promise<boolean> {
    const auditFile = await this.readTextFile(this.auditPath);
    if (auditFile.exists) {
      const audit = parseAudit(auditFile.contents);
      const latest = audit.records.at(-1);
      if (!audit.corruption && audit.truncateTo === null && latest
        && latest.idempotencyKey === attempted.idempotencyKey
        && latest.requestHash === attempted.requestHash
        && latest.recordHash === attempted.recordHash
        && serializeConfig(latest.config) === serializeConfig(attempted.config)) {
        try {
          await this.makeAuditDurable();
          this.auditTruncateTo = audit.truncateTo;
          this.auditAppendPrefix = audit.appendPrefix;
          return true;
        } catch (syncError) {
          const attemptedSuffix = `${this.auditAppendPrefix}${JSON.stringify(attempted)}\n`;
          const prefix = auditFile.contents.endsWith(attemptedSuffix)
            ? auditFile.contents.slice(0, -attemptedSuffix.length)
            : null;
          let rollbackError: unknown;
          if (prefix !== null) {
            try { await this.truncateAudit(Buffer.byteLength(prefix)); } catch (error) { rollbackError = error; }
          } else {
            rollbackError = syncError;
          }
          try { await this.writeCache(previous); } catch (error) { rollbackError ??= error; }
          if (rollbackError) throw rollbackError;
          return false;
        }
      }
      if (audit.corruption) {
        await this.writeQuarantine(audit.corruption.suffix);
        await this.truncateAudit(audit.corruption.truncateTo);
      }
      if (audit.truncateTo !== null) {
        await this.truncateAudit(audit.truncateTo);
      }
      this.auditTruncateTo = null;
      this.auditAppendPrefix = audit.appendPrefix;
    }
    await this.writeCache(previous);
    return false;
  }

  private async writeCache(snapshot: ArcadeConfigSnapshot): Promise<void> {
    await this.ensureDirectory(this.cachePath);
    const temporary = `${this.cachePath}.tmp-${process.pid}-${uniqueSafeId()}`;
    try {
      await this.fileSystem.writeFile(temporary, `${serializeConfig(snapshot)}\n`, FILE_MODE);
      await this.fileSystem.chmod(temporary, FILE_MODE);
      await this.fileSystem.syncFile(temporary);
      await this.fileSystem.rename(temporary, this.cachePath);
      await this.fileSystem.chmod(this.cachePath, FILE_MODE);
      await this.fileSystem.syncDirectory(path.dirname(this.cachePath));
    } catch (error) {
      try { await this.fileSystem.unlink(temporary); } catch { /* best-effort cleanup */ }
      throw error;
    }
  }

  private async writeAudit(contents: string): Promise<void> {
    await this.ensureDirectory(this.auditPath);
    const temporary = `${this.auditPath}.tmp-${process.pid}-${uniqueSafeId()}`;
    try {
      await this.fileSystem.writeFile(temporary, contents, FILE_MODE);
      await this.fileSystem.chmod(temporary, FILE_MODE);
      await this.fileSystem.syncFile(temporary);
      await this.fileSystem.rename(temporary, this.auditPath);
      await this.makeAuditDurable();
    } catch (error) {
      try { await this.fileSystem.unlink(temporary); } catch { /* best-effort cleanup */ }
      throw error;
    }
  }

  private async ensureDirectory(file: string): Promise<void> {
    const directory = path.dirname(file);
    await this.fileSystem.mkdir(directory, DIRECTORY_MODE);
    await this.fileSystem.chmod(directory, DIRECTORY_MODE);
    await this.fileSystem.syncDirectory(path.dirname(directory));
  }

  private async makeAuditDurable(): Promise<void> {
    await this.fileSystem.chmod(this.auditPath, FILE_MODE);
    await this.fileSystem.syncFile(this.auditPath);
    await this.fileSystem.syncDirectory(path.dirname(this.auditPath));
  }

  private async truncateAudit(length: number): Promise<void> {
    await this.fileSystem.truncate(this.auditPath, length);
    await this.makeAuditDurable();
  }

  private async writeQuarantine(contents: string): Promise<string> {
    const quarantine = `${this.auditPath}.corrupt-${uniqueSafeId()}.jsonl`;
    await this.ensureDirectory(quarantine);
    await this.fileSystem.writeFile(quarantine, contents, FILE_MODE);
    await this.fileSystem.chmod(quarantine, FILE_MODE);
    await this.fileSystem.syncFile(quarantine);
    await this.fileSystem.syncDirectory(path.dirname(quarantine));
    return quarantine;
  }

  private async writeDegradedMarker(reason: string, quarantinePath: string | null): Promise<void> {
    const temporary = `${this.degradedPath}.tmp-${process.pid}-${uniqueSafeId()}`;
    await this.ensureDirectory(this.degradedPath);
    try {
      await this.fileSystem.writeFile(
        temporary,
        `${JSON.stringify({ reason, quarantinePath })}\n`,
        FILE_MODE,
      );
      await this.fileSystem.chmod(temporary, FILE_MODE);
      await this.fileSystem.syncFile(temporary);
      await this.fileSystem.rename(temporary, this.degradedPath);
      await this.fileSystem.chmod(this.degradedPath, FILE_MODE);
      await this.fileSystem.syncDirectory(path.dirname(this.degradedPath));
    } catch (error) {
      try { await this.fileSystem.unlink(temporary); } catch { /* best-effort cleanup */ }
      throw error;
    }
  }

  private async removeDegradedMarker(): Promise<void> {
    try {
      await this.fileSystem.unlink(this.degradedPath);
      await this.fileSystem.syncDirectory(path.dirname(this.degradedPath));
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private async readTextFile(file: string): Promise<TextFile> {
    try {
      return { exists: true, contents: await this.fileSystem.readFile(file) };
    } catch (error) {
      if (isNotFound(error)) return { exists: false, contents: '' };
      throw error;
    }
  }
}

function parseAudit(contents: string): AuditReadResult {
  if (contents.length === 0) {
    return { records: [], truncateTo: null, appendPrefix: '', corruption: null };
  }
  const terminated = contents.endsWith('\n');
  const lines = contents.split('\n');
  if (terminated) lines.pop();
  const records: ArcadeConfigAuditRecord[] = [];
  const idempotencyKeys = new Set<string>();
  let characterOffset = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const lineStart = characterOffset;
    characterOffset += line.length + 1;
    let input: unknown;
    try {
      input = JSON.parse(line) as unknown;
    } catch (error) {
      const isPartialTail = !terminated && index === lines.length - 1;
      if (isPartialTail) {
        const lastNewline = contents.lastIndexOf('\n');
        const validPrefix = lastNewline < 0 ? '' : contents.slice(0, lastNewline + 1);
        return {
          records,
          truncateTo: Buffer.byteLength(validPrefix),
          appendPrefix: '',
          corruption: null,
        };
      }
      return corruptAuditResult(contents, records, index + 1, lineStart, errorMessage(error));
    }
    let record: ArcadeConfigAuditRecord;
    try {
      record = parseAuditRecord(input);
    } catch (error) {
      return corruptAuditResult(contents, records, index + 1, lineStart, errorMessage(error));
    }

    const previous = records.at(-1);
    let continuityError: string | null = null;
    if (record.previousVersion !== record.config.version - 1) {
      continuityError = `revision ${record.config.version} has previousVersion ${record.previousVersion}`;
    } else if (!previous && record.previousVersion !== createDefaultArcadeConfig().version) {
      continuityError = `first audit record starts after revision ${record.previousVersion}`;
    } else if (!previous && record.previousHash !== GENESIS_HASH) {
      continuityError = 'first audit record does not use the genesis hash';
    } else if (previous && record.previousVersion !== previous.config.version) {
      continuityError = `revision ${record.config.version} does not follow revision ${previous.config.version}`;
    } else if (previous && record.previousHash !== previous.recordHash) {
      continuityError = `revision ${record.config.version} previousHash does not match revision ${previous.config.version}`;
    } else if (idempotencyKeys.has(record.idempotencyKey)) {
      continuityError = `duplicate idempotency key ${JSON.stringify(record.idempotencyKey)}`;
    }
    if (continuityError) {
      return corruptAuditResult(contents, records, index + 1, lineStart, continuityError);
    }
    records.push(record);
    idempotencyKeys.add(record.idempotencyKey);
  }

  return {
    records,
    truncateTo: null,
    appendPrefix: terminated ? '' : '\n',
    corruption: null,
  };
}

function corruptAuditResult(
  contents: string,
  records: ArcadeConfigAuditRecord[],
  line: number,
  lineStart: number,
  reason: string,
): AuditReadResult {
  const prefix = contents.slice(0, lineStart);
  return {
    records,
    truncateTo: null,
    appendPrefix: '',
    corruption: {
      line,
      reason,
      truncateTo: Buffer.byteLength(prefix),
      suffix: contents.slice(lineStart),
    },
  };
}

function parseAuditRecord(input: unknown): ArcadeConfigAuditRecord {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('expected an object');
  }
  const object = input as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  const expectedKeys = [
    'auditVersion', 'config', 'idempotencyKey', 'previousHash',
    'previousVersion', 'recordHash', 'requestHash',
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('unexpected or missing audit record fields');
  }
  if (object.auditVersion !== AUDIT_VERSION) throw new Error(`expected auditVersion ${AUDIT_VERSION}`);
  const idempotencyKey = normalizeStoredString(object.idempotencyKey, 'idempotency key', 255);
  if (object.idempotencyKey !== idempotencyKey) throw new Error('idempotency key is not normalized');
  if (typeof object.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(object.requestHash)) {
    throw new Error('invalid request hash');
  }
  if (!Number.isSafeInteger(object.previousVersion) || (object.previousVersion as number) < 1) {
    throw new Error('invalid previous version');
  }
  if (typeof object.previousHash !== 'string' || !/^[a-f0-9]{64}$/.test(object.previousHash)) {
    throw new Error('invalid previous hash');
  }
  if (typeof object.recordHash !== 'string' || !/^[a-f0-9]{64}$/.test(object.recordHash)) {
    throw new Error('invalid record hash');
  }
  const storedConfig = parseStoredConfig(object.config);
  const recordWithoutHash: Omit<ArcadeConfigAuditRecord, 'recordHash'> = {
    auditVersion: AUDIT_VERSION,
    idempotencyKey,
    requestHash: object.requestHash,
    previousVersion: object.previousVersion as number,
    previousHash: object.previousHash,
    config: storedConfig.snapshot,
  };
  if (object.recordHash !== hashAuditRecord({ ...recordWithoutHash, config: storedConfig.hashConfig })) {
    throw new Error('record hash mismatch');
  }
  return Object.freeze({ ...recordWithoutHash, recordHash: object.recordHash });
}

function parseStoredConfig(input: unknown): ParsedStoredConfig {
  const decoded = typeof input === 'string' ? JSON.parse(input) as unknown : input;
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('stored config must be an object');
  }
  const object = decoded as Record<string, unknown>;
  if (object.schemaVersion === TRIVIA_CONFIG_SCHEMA_VERSION) {
    const snapshot = parseArcadeConfig(promoteChessConfig(object));
    return { snapshot, hashConfig: decoded };
  }
  if (object.schemaVersion === KARAOKE_CONFIG_SCHEMA_VERSION) {
    const snapshot = parseArcadeConfig(promoteChessConfig(promoteTriviaConfig(object)));
    return { snapshot, hashConfig: decoded };
  }
  if (object.schemaVersion === PRE_KARAOKE_CONFIG_SCHEMA_VERSION) {
    const snapshot = parseArcadeConfig(promoteChessConfig(promoteTriviaConfig(promoteKaraokeConfig(object))));
    return { snapshot, hashConfig: decoded };
  }
  if (object.schemaVersion === HOME_CONCEPT_CONFIG_SCHEMA_VERSION) {
    const snapshot = parseArcadeConfig(promoteChessConfig(promoteTriviaConfig(promoteKaraokeConfig({
      ...object,
      schemaVersion: PRE_KARAOKE_CONFIG_SCHEMA_VERSION,
      station: addHomeConceptSettings(object.station),
    }))));
    return { snapshot, hashConfig: decoded };
  }
  if (object.schemaVersion === CHALLENGE_MESSAGE_CONFIG_SCHEMA_VERSION) {
    const snapshot = parseArcadeConfig(promoteChessConfig(promoteTriviaConfig(promoteKaraokeConfig({
      ...object,
      schemaVersion: PRE_KARAOKE_CONFIG_SCHEMA_VERSION,
      station: addHomeConceptSettings(object.station),
      earning: addChallengeMessages(object.earning),
      postGame: normalizeLegacyPostGame(object.postGame, object.channels),
    }))));
    return { snapshot, hashConfig: decoded };
  }
  if (object.schemaVersion === STATION_CONFIG_SCHEMA_VERSION) {
    const legacyChannels = object.channels as Record<string, unknown>;
    const snapshot = parseArcadeConfig(promoteChessConfig(promoteTriviaConfig(promoteKaraokeConfig({
      ...object,
      schemaVersion: PRE_KARAOKE_CONFIG_SCHEMA_VERSION,
      station: addHomeConceptSettings(object.station),
      earning: addChallengeMessages(object.earning),
      postGame: normalizeLegacyPostGame(object.postGame, object.channels),
      channels: {
        ...legacyChannels,
        voiceNumbers: { 'en-US': null, 'pt-BR': null },
      },
    }))));
    return { snapshot, hashConfig: decoded };
  }
  if (object.schemaVersion !== LEGACY_CONFIG_SCHEMA_VERSION) {
    const snapshot = parseArcadeConfig(decoded);
    return { snapshot, hashConfig: snapshot };
  }

  const keys = Object.keys(object).sort();
  const expectedKeys = [...LEGACY_CONFIG_KEYS].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new Error('unexpected or missing schema 1 config fields');
  }
  const currentStation = createDefaultArcadeConfig().station;
  const { trivia: _newGame, chess: _futureGame, ...legacyGames } = currentStation.games;
  const station = {
    ...currentStation,
    games: legacyGames,
    comingSoon: { trivia: { enabled: true } },
    automaticSelection: {
      ...currentStation.automaticSelection,
      order: currentStation.automaticSelection.order.filter(game => game !== 'trivia' && game !== 'chess'),
    },
  };
  const legacyArcade = object.arcade as { mode?: unknown };
  const legacyChannels = object.channels as { voice?: unknown; sms?: unknown; whatsapp?: unknown };
  const legacyCoins = object.coins as Record<string, unknown>;
  const legacyCosts = legacyCoins.gameCosts as Record<string, unknown>;
  const legacyPostGame = object.postGame as Record<string, unknown>;
  const legacyPostGameChannels = Array.isArray(legacyPostGame.channels)
    ? legacyPostGame.channels
    : [];
  const unsupportedPostGame = legacyPostGame.enabled === true && (
    legacyPostGameChannels.length === 0
    || legacyPostGameChannels.some(channel => (
      channel === 'sms' ? legacyChannels.sms !== true
        : channel === 'whatsapp' ? legacyChannels.whatsapp !== true : false
    ))
    || [
      'includeScore', 'includeLeaderboard', 'includeChallenges', 'includeRematchLink',
      'includeAchievement', 'includeIntelligenceTip',
    ].some(field => legacyPostGame[field] === true)
  );
  const incompatibleEconomy = legacyCoins.defaultGameCost !== 1
    || ['racer', 'monsters', 'fighter', 'trivia'].some(game => legacyCosts[game] !== 1)
    || (legacyCoins.chargePolicy === 'per_player'
      && (!Number.isSafeInteger(legacyCoins.startingBalance) || (legacyCoins.startingBalance as number) < 1));
  const disableForSafety = incompatibleEconomy || unsupportedPostGame
    || (legacyArcade.mode === 'coin_only'
      && legacyChannels.sms === false && legacyChannels.whatsapp === false);
  const migratedArcade = disableForSafety
    ? { ...legacyArcade, mode: 'off' }
    : object.arcade;
  const migratedCoins = incompatibleEconomy ? {
    ...legacyCoins,
    startingBalance: legacyCoins.chargePolicy === 'per_player'
      ? Math.max(1, Number.isSafeInteger(legacyCoins.startingBalance)
        ? legacyCoins.startingBalance as number
        : 1)
      : legacyCoins.startingBalance,
    defaultGameCost: 1,
    gameCosts: { racer: 1, monsters: 1, fighter: 1, karaoke: 1, trivia: 1 },
  } : {
    ...legacyCoins,
    gameCosts: { ...legacyCosts, karaoke: 1 },
  };
  const migratedPostGame = unsupportedPostGame
    ? { ...legacyPostGame, enabled: false }
    : object.postGame;
  const snapshot = parseArcadeConfig(promoteChessConfig(promoteTriviaConfig({
    schemaVersion: KARAOKE_CONFIG_SCHEMA_VERSION,
    version: object.version,
    updatedAt: object.updatedAt,
    updatedBy: object.updatedBy,
    arcade: migratedArcade,
    station,
    registration: object.registration,
    coins: migratedCoins,
    earning: addChallengeMessages(object.earning),
    queue: object.queue,
    channels: {
      ...(object.channels as Record<string, unknown>),
      voiceNumbers: { 'en-US': null, 'pt-BR': null },
    },
    postGame: migratedPostGame,
    intelligence: object.intelligence,
  })));
  return {
    snapshot,
    // Hash historical records using their untouched v1 shape, not the safe runtime migration.
    hashConfig: decoded,
  };
}

/** Promotes only the exact schema-v5 game lists; Trivia promotion remains a separate v6 boundary. */
function promoteKaraokeConfig(object: Record<string, unknown>): Record<string, unknown> {
  const station = storedRecord(object.station, '$.station');
  const games = storedRecord(station.games, '$.station.games');
  requireStoredKeys(games, ['racer', 'monsters', 'fighter'], '$.station.games');
  const comingSoon = storedRecord(station.comingSoon, '$.station.comingSoon');
  requireStoredKeys(comingSoon, ['trivia', 'karaoke'], '$.station.comingSoon');
  const retiredKaraoke = storedRecord(comingSoon.karaoke, '$.station.comingSoon.karaoke');
  requireStoredKeys(retiredKaraoke, ['enabled'], '$.station.comingSoon.karaoke');
  if (typeof retiredKaraoke.enabled !== 'boolean') {
    throw new Error('$.station.comingSoon.karaoke.enabled must be boolean');
  }
  const automaticSelection = storedRecord(station.automaticSelection, '$.station.automaticSelection');
  const order = automaticSelection.order;
  if (!Array.isArray(order) || order.length !== 3
    || new Set(order).size !== 3
    || order.some(game => !['racer', 'monsters', 'fighter'].includes(String(game)))) {
    throw new Error('$.station.automaticSelection.order must contain the three schema-v5 station games exactly once');
  }
  const coins = storedRecord(object.coins, '$.coins');
  const gameCosts = storedRecord(coins.gameCosts, '$.coins.gameCosts');
  requireStoredKeys(gameCosts, ['racer', 'monsters', 'fighter', 'trivia'], '$.coins.gameCosts');
  const { karaoke: _retiredConcept, ...currentConcepts } = comingSoon;
  return {
    ...object,
    schemaVersion: KARAOKE_CONFIG_SCHEMA_VERSION,
    station: {
      ...station,
      games: { ...games, karaoke: { enabled: false } },
      comingSoon: currentConcepts,
      automaticSelection: { ...automaticSelection, order: [...order, 'karaoke'] },
    },
    coins: { ...coins, gameCosts: { ...gameCosts, karaoke: 1 } },
  };
}

/** Promotes the exact schema-v6 identity lists while retaining the original object for audit hashing. */
function promoteTriviaConfig(object: Record<string, unknown>): Record<string, unknown> {
  const station = storedRecord(object.station, '$.station');
  const games = storedRecord(station.games, '$.station.games');
  requireStoredKeys(games, ['racer', 'monsters', 'fighter', 'karaoke'], '$.station.games', 'schema-v6');
  const comingSoon = storedRecord(station.comingSoon, '$.station.comingSoon');
  requireStoredKeys(comingSoon, ['trivia'], '$.station.comingSoon', 'schema-v6');
  const retiredTrivia = storedRecord(comingSoon.trivia, '$.station.comingSoon.trivia');
  requireStoredKeys(retiredTrivia, ['enabled'], '$.station.comingSoon.trivia', 'schema-v6');
  if (typeof retiredTrivia.enabled !== 'boolean') {
    throw new Error('$.station.comingSoon.trivia.enabled must be boolean');
  }
  const automaticSelection = storedRecord(station.automaticSelection, '$.station.automaticSelection');
  const order = automaticSelection.order;
  if (!Array.isArray(order) || order.length !== 4
    || new Set(order).size !== 4
    || order.some(game => !['racer', 'monsters', 'fighter', 'karaoke'].includes(String(game)))) {
    throw new Error('$.station.automaticSelection.order must contain the four schema-v6 station games exactly once');
  }
  const coins = storedRecord(object.coins, '$.coins');
  const gameCosts = storedRecord(coins.gameCosts, '$.coins.gameCosts');
  requireStoredKeys(
    gameCosts,
    ['racer', 'monsters', 'fighter', 'karaoke', 'trivia'],
    '$.coins.gameCosts',
    'schema-v6',
  );
  return {
    ...object,
    schemaVersion: TRIVIA_CONFIG_SCHEMA_VERSION,
    station: {
      ...station,
      games: { ...games, trivia: { enabled: false } },
      comingSoon: { trivia: { enabled: false } },
      automaticSelection: { ...automaticSelection, order: [...order, 'trivia'] },
    },
  };
}

/** Promotes only the exact schema-v7 game lists, preserving the stored bytes for audit hashing. */
function promoteChessConfig(object: Record<string, unknown>): Record<string, unknown> {
  const station = storedRecord(object.station, '$.station');
  const games = storedRecord(station.games, '$.station.games');
  requireStoredKeys(games, ['racer', 'monsters', 'fighter', 'karaoke', 'trivia'], '$.station.games', 'schema-v7');
  const automaticSelection = storedRecord(station.automaticSelection, '$.station.automaticSelection');
  const order = automaticSelection.order;
  if (!Array.isArray(order) || order.length !== 5
    || new Set(order).size !== 5
    || order.some(game => !['racer', 'monsters', 'fighter', 'karaoke', 'trivia'].includes(String(game)))) {
    throw new Error('$.station.automaticSelection.order must contain the five schema-v7 station games exactly once');
  }
  const coins = storedRecord(object.coins, '$.coins');
  const gameCosts = storedRecord(coins.gameCosts, '$.coins.gameCosts');
  requireStoredKeys(gameCosts, ['racer', 'monsters', 'fighter', 'karaoke', 'trivia'], '$.coins.gameCosts', 'schema-v7');
  return {
    ...object,
    schemaVersion: ARCADE_CONFIG_SCHEMA_VERSION,
    station: {
      ...station,
      games: { ...games, chess: { enabled: true } },
      automaticSelection: { ...automaticSelection, order: [...order, 'chess'] },
    },
    coins: { ...coins, gameCosts: { ...gameCosts, chess: 1 } },
  };
}

function storedRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireStoredKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
  schema = 'schema-v5',
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${path} has malformed ${schema} fields`);
  }
}

function normalizeLegacyPostGame(value: unknown, channelsValue: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const postGame = value as Record<string, unknown>;
  const channels = channelsValue !== null && typeof channelsValue === 'object' && !Array.isArray(channelsValue)
    ? channelsValue as Record<string, unknown>
    : {};
  const selected = Array.isArray(postGame.channels) ? postGame.channels : [];
  const deliveryValid = selected.length > 0 && selected.every(channel => (
    channel === 'sms' ? channels.sms === true : channel === 'whatsapp' ? channels.whatsapp === true : false
  ));
  return {
    ...postGame,
    enabled: postGame.enabled === true && deliveryValid,
    includeScore: false,
    includeLeaderboard: false,
    includeRematchLink: false,
    includeAchievement: false,
    includeIntelligenceTip: false,
  };
}

function addHomeConceptSettings(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const station = value as Record<string, unknown>;
  return {
    ...station,
    comingSoon: station.comingSoon ?? {
      trivia: { enabled: true },
      karaoke: { enabled: true },
    },
  };
}

function addChallengeMessages(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const earning = value as Record<string, unknown>;
  if (!Array.isArray(earning.challenges)) return value;
  return {
    ...earning,
    challenges: earning.challenges.map(challenge => (
      challenge && typeof challenge === 'object' && !Array.isArray(challenge)
        ? { ...(challenge as Record<string, unknown>), message: null }
        : challenge
    )),
  };
}


function parseExpectedVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ArcadeConfigStoreError('expectedVersion must be a positive safe integer');
  }
  return value;
}

function parseDegradedMarker(contents: string): DegradedMarker {
  const input = JSON.parse(contents) as unknown;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('expected an object');
  }
  const object = input as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (keys.length !== 2 || keys[0] !== 'quarantinePath' || keys[1] !== 'reason') {
    throw new Error('unexpected or missing degraded marker fields');
  }
  if (typeof object.reason !== 'string' || object.reason.length === 0 || object.reason.length > 2_000) {
    throw new Error('invalid degraded reason');
  }
  if (object.quarantinePath !== null && typeof object.quarantinePath !== 'string') {
    throw new Error('invalid quarantine path');
  }
  return { reason: object.reason, quarantinePath: object.quarantinePath as string | null };
}

function normalizeStoredString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new ArcadeConfigStoreError(`${label} must be a string`);
  const normalized = value.trim().normalize('NFC');
  if (normalized.length === 0 || normalized.length > maximumLength) {
    throw new ArcadeConfigStoreError(`${label} must contain 1 through ${maximumLength} characters`);
  }
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new ArcadeConfigStoreError(`${label} cannot contain control characters`);
  }
  return normalized;
}

function hashRequest(
  expectedVersion: number,
  updatedBy: string,
  settings: ArcadeConfigSettings,
): string {
  return createHash('sha256').update(JSON.stringify({
    expectedVersion,
    updatedBy,
    settings,
  })).digest('hex');
}

function hashAuditRecord(record: HashableAuditRecord): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

function serializeConfig(snapshot: ArcadeConfigSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uniqueSafeId(): string {
  const id = randomUUID();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new ArcadeConfigStoreError('randomUUID returned an unsafe identifier');
  }
  return id;
}

async function syncDirectoryIfSupported(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !['EBADF', 'EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(code)) throw error;
  } finally {
    await handle?.close();
  }
}
