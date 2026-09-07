import { createHash, randomUUID } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { canonicalizeJson, type JsonValue } from "@revagent/protocol";
import pg, { type PoolClient } from "pg";

import type { GatewayJsonValue } from "./dispatch.js";
import { Eu12InvocationRecorder, type Eu12InvocationLifecycleProjection } from "./eventResultLifecycle.js";
import { BoundedEu12EventWriter, type Eu12EventWriteReceipt } from "./eventPersistence.js";
import { validateEu12EventEnvelope } from "./eventPersistence.js";
import type { GatewayEventEnvelope } from "./events.js";
import { PostgresEu12EventPersistence } from "./postgresEu12EventPersistence.js";
import {
  validateBridgeUpdateReleaseAuthority,
  type BridgeReleaseChannel,
  type BridgeReleaseContract,
  type BridgeUpdateDeviceRingAssignment,
  type BridgeUpdateReleaseAuthority,
  type ReleaseSignatureVerifier,
} from "./releaseChannelStore.js";
import {
  RESULT_REFERENCE_DEFAULT_PAGE_BYTES,
  RESULT_REFERENCE_DEFAULT_TTL_MS,
  RESULT_REFERENCE_MAX_BYTES,
  ResultReferenceIdempotencyError,
  type ResultObjectStore,
  type ResultReference,
  type ResultReferencePage,
  type ResultReferenceScope,
  freezeResultReference,
  resultReferenceDigest,
  resultReferenceStorageKey,
  validateResultReferencePageSize,
} from "./resultReferenceStore.js";
import { parseArchivedEventNdjson, type RetentionArchiveRun } from "./retentionArchive.js";

const { Pool } = pg;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} must be a UUID`);
}

export type RetentionSurface = "events" | "tool_invocations" | "llm_calls";
export type CanonicalRetentionClass = "standard_12m" | "lifecycle_24m";

export class RetentionLeaseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RetentionLeaseError";
  }
}

export class RetentionNotDueError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RetentionNotDueError";
  }
}

function archiveKey(tenantId: string, surface: RetentionSurface, retentionClass: CanonicalRetentionClass, month: string): string {
  return `archive/${tenantId}/${surface}/${retentionClass}/${month}.ndjson.zst`;
}

function archiveDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function monthStart(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) throw new Error("archive month must be YYYY-MM");
  return `${month}-01`;
}

function requireCanonicalRetentionClass(surface: RetentionSurface, retentionClass: CanonicalRetentionClass | undefined): CanonicalRetentionClass {
  const resolved = retentionClass ?? "standard_12m";
  if (surface !== "events" && resolved !== "standard_12m") throw new Error("typed retention surfaces are standard_12m only");
  return resolved;
}

function immutableArchiveRun(run: RetentionArchiveRun): RetentionArchiveRun {
  return Object.freeze({ ...run });
}

function canonicalTenantTargets(tenantIds: readonly string[]): readonly string[] {
  const targets = [...tenantIds];
  for (const tenantId of targets) assertUuid(tenantId, "release target tenant id");
  const sorted = [...targets].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error("release target tenant ids must be unique");
  return Object.freeze(sorted);
}

export function canonicalDurableReleaseManifest(input: {
  readonly release: BridgeReleaseContract;
  readonly releaseSequence: number;
  readonly releaseRollbackFloorSequence: number;
  readonly channelRollbackFloorSequence: number;
  readonly channelRevision: number;
  readonly tenantIds: readonly string[];
}): string {
  const release = input.release;
  return canonicalizeJson({
    id: release.id,
    version: release.version,
    channel: release.channel,
    artifact_storage_key: release.artifactStorageKey,
    artifact_sha256: release.artifactSha256,
    signing_key_id: release.signingKeyId,
    min_supported_version: release.minSupportedVersion,
    released_at_ms: release.releasedAtMs,
    released_by: release.releasedBy,
    release_sequence: input.releaseSequence,
    release_rollback_floor_sequence: input.releaseRollbackFloorSequence,
    channel_revision: input.channelRevision,
    channel_rollback_floor_sequence: input.channelRollbackFloorSequence,
    staged_tenant_ids: [...input.tenantIds].sort(),
  } as JsonValue);
}

function parseReferenceRow(row: {
  id: string; tenant_id: string; session_id: string; storage_key: string; content_digest: string;
  byte_size: number; page_size_bytes: number; page_count: number; summary: unknown; expires_at: Date;
}): ResultReference {
  const summary = row.summary as { byteLength: number; pageCount: number; firstPageBase64: string; truncated: boolean };
  return freezeResultReference({
    refId: row.id,
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    storageKey: row.storage_key,
    digest: `sha256:${row.content_digest}`,
    expiresAtMs: row.expires_at.getTime(),
    pageSizeBytes: row.page_size_bytes,
    pageCount: row.page_count,
    summary: Object.freeze({ ...summary }),
  });
}

export interface PostgresEu12DataStoreOptions {
  readonly databaseUrl: string;
  readonly publisherDatabaseUrl?: string;
  readonly objects: ResultObjectStore;
  readonly signatureVerifier: ReleaseSignatureVerifier;
  readonly pinnedSigningKeyIds: readonly string[];
  readonly bridgeManifestVerifier?: (input: {
    readonly manifest: JsonValue;
    readonly signatureEnvelope: JsonValue;
  }) => Readonly<{ readonly keyId: string; readonly contentSha256: string }>;
  readonly now?: () => number;
  readonly newRefId?: () => string;
}

export interface PersistedParityAttribution {
  readonly activeTaskCount: number;
  readonly toolUserAttribution: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly modelUserAttribution: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface DurableReleaseAuthority {
  readonly releaseSequence: number;
  readonly releaseRollbackFloorSequence: number;
  readonly channelRevision: number;
  readonly channelRollbackFloorSequence: number;
  readonly tenantIds: readonly string[];
}

export type RetentionArchiveBoundary = "prepared" | "object_written" | "object_verified" | "uploaded";

/**
 * Authoritative EU-12 persistence adapter. The memory stores remain bounded
 * conformance fixtures; restart-sensitive metadata is read from Postgres.
 */
export class PostgresEu12DataStore {
  public readonly kind = "postgres" as const;
  readonly #runtimePool: pg.Pool;
  readonly #publisherPool: pg.Pool | null;
  readonly #events: PostgresEu12EventPersistence;
  readonly #objects: ResultObjectStore;
  readonly #signatureVerifier: ReleaseSignatureVerifier;
  readonly #pinnedSigningKeyIds: ReadonlySet<string>;
  readonly #now: () => number;
  readonly #newRefId: () => string;
  readonly #bridgeManifestVerifier: PostgresEu12DataStoreOptions["bridgeManifestVerifier"];

  public constructor(options: PostgresEu12DataStoreOptions) {
    if (options.pinnedSigningKeyIds.length === 0) throw new Error("pinned signing key set is required");
    this.#runtimePool = new Pool({ connectionString: options.databaseUrl });
    this.#publisherPool = options.publisherDatabaseUrl === undefined
      ? null
      : new Pool({ connectionString: options.publisherDatabaseUrl });
    this.#events = new PostgresEu12EventPersistence(options.databaseUrl);
    this.#objects = options.objects;
    this.#signatureVerifier = options.signatureVerifier;
    this.#pinnedSigningKeyIds = new Set(options.pinnedSigningKeyIds);
    this.#now = options.now ?? Date.now;
    this.#newRefId = options.newRefId ?? randomUUID;
    this.#bridgeManifestVerifier = options.bridgeManifestVerifier;
  }

  public async close(): Promise<void> {
    await Promise.all([
      this.#runtimePool.end(),
      ...(this.#publisherPool === null ? [] : [this.#publisherPool.end()]),
      this.#events.close(),
    ]);
  }

  /** The same typed O7 writer used by PostgresTenantStore. */
  public async write(events: readonly GatewayEventEnvelope[]): Promise<readonly Eu12EventWriteReceipt[]> {
    return await this.#events.write(events);
  }

  public async read(scope: { readonly tenantId: string; readonly eventId: string }): Promise<GatewayEventEnvelope | null> {
    return await this.#events.read(scope);
  }

  public async list(scope: { readonly tenantId: string }): Promise<readonly GatewayEventEnvelope[]> {
    return await this.#events.list(scope);
  }

  public createBoundedEventWriter(maxPendingEvents = 1_024): BoundedEu12EventWriter {
    return new BoundedEu12EventWriter({ persistence: this, maxPendingEvents });
  }

  /**
   * The production composition always projects an in-flight invocation before
   * its bounded writer is allowed to persist the terminal audit/result pair.
   */
  public createInvocationRecorder(maxPendingEvents = 1_024): Eu12InvocationRecorder {
    const lifecycle: Eu12InvocationLifecycleProjection = {
      begin: async (input) => {
        await this.recoverStaleActiveInvocations({ tenantId: input.tenantId, nowMs: this.#now(), staleAfterMs: 15 * 60_000 });
        await this.beginActiveInvocation(input);
      },
      finish: async (input) => await this.completeActiveInvocation(input),
    };
    return new Eu12InvocationRecorder({ events: this.createBoundedEventWriter(maxPendingEvents), results: this, lifecycle });
  }

  /** Structural counterpart of ResultReferenceStore.put for real lifecycle composition. */
  public async put(input: {
    readonly scope: ResultReferenceScope;
    readonly payload: GatewayJsonValue;
    readonly idempotencyKey?: string;
    readonly invocationId?: string;
    readonly refLabel?: string;
    readonly expiresAtMs?: number;
    readonly pageSizeBytes?: number;
  }): Promise<ResultReference> {
    if (input.idempotencyKey === undefined || input.invocationId === undefined) {
      throw new Error("durable result composition requires idempotency and invocation identities");
    }
    return await this.putResult({
      scope: input.scope,
      payload: input.payload,
      idempotencyKey: input.idempotencyKey,
      invocationId: input.invocationId,
      refLabel: input.refLabel,
      expiresAtMs: input.expiresAtMs,
      pageSizeBytes: input.pageSizeBytes,
    });
  }

  async #tenantTransaction<T>(tenantId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
    assertUuid(tenantId, "tenant id");
    const client = await this.#runtimePool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE revagent_app");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const value = await action(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async putResult(input: {
    readonly scope: ResultReferenceScope;
    readonly payload: GatewayJsonValue;
    readonly idempotencyKey: string;
    readonly invocationId: string;
    readonly refLabel?: string;
    readonly expiresAtMs?: number;
    readonly pageSizeBytes?: number;
  }): Promise<ResultReference> {
    assertUuid(input.scope.tenantId, "tenant id");
    assertUuid(input.scope.sessionId, "session id");
    assertUuid(input.invocationId, "invocation id");
    const nowMs = this.#now();
    if (input.expiresAtMs !== undefined && (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= nowMs)) throw new Error("result reference expiry must be after creation");
    const pageSizeBytes = validateResultReferencePageSize(input.pageSizeBytes ?? RESULT_REFERENCE_DEFAULT_PAGE_BYTES);
    const bytes = Buffer.from(canonicalizeJson(input.payload as JsonValue), "utf8");
    if (bytes.byteLength > RESULT_REFERENCE_MAX_BYTES) throw new Error("result reference payload exceeds the five MiB limit");
    const digest = resultReferenceDigest(bytes);
    const existing = await this.#tenantTransaction(input.scope.tenantId, async (client) => {
      const row = await client.query<{
        id: string; tenant_id: string; session_id: string; storage_key: string; content_digest: string;
        byte_size: number; page_size_bytes: number; page_count: number; summary: unknown; expires_at: Date;
      }>(
        `SELECT id::text,tenant_id::text,session_id::text,storage_key,content_digest::text,
                byte_size,page_size_bytes,page_count,summary,expires_at
         FROM result_refs WHERE tenant_id=$1 AND session_id=$2 AND idempotency_key=$3`,
        [input.scope.tenantId, input.scope.sessionId, input.idempotencyKey],
      );
      return row.rows[0] === undefined ? null : parseReferenceRow(row.rows[0]);
    });
    if (existing !== null) {
      if (existing.digest !== digest || existing.pageSizeBytes !== pageSizeBytes || (input.expiresAtMs !== undefined && existing.expiresAtMs !== input.expiresAtMs)) {
        throw new ResultReferenceIdempotencyError("result reference idempotency replay changed immutable payload or lifecycle");
      }
      return existing;
    }
    const expiresAtMs = input.expiresAtMs ?? nowMs + RESULT_REFERENCE_DEFAULT_TTL_MS;
    const refId = this.#newRefId();
    assertUuid(refId, "result reference id");
    const refLabel = input.refLabel ?? await this.#tenantTransaction(input.scope.tenantId, async (client) => {
      const labels = await client.query<{ ref_label: string }>(
        "SELECT ref_label FROM result_refs WHERE tenant_id=$1 AND session_id=$2 FOR UPDATE",
        [input.scope.tenantId, input.scope.sessionId],
      );
      const maximum = labels.rows.reduce((current, row) => Math.max(current, Number.parseInt(row.ref_label.slice(1), 10) || 16), 16);
      return `R${String(maximum + 1)}`;
    });
    if (!/^R[1-9][0-9]{0,5}$/u.test(refLabel)) throw new Error("result reference label must be R17-style");
    const key = resultReferenceStorageKey(input.scope, refId, nowMs);
    const pageCount = Math.max(1, Math.ceil(bytes.byteLength / pageSizeBytes));
    const firstPage = bytes.subarray(0, Math.min(bytes.byteLength, pageSizeBytes));
    const ref = freezeResultReference({
      refId,
      tenantId: input.scope.tenantId,
      sessionId: input.scope.sessionId,
      storageKey: key,
      digest,
      expiresAtMs,
      pageSizeBytes,
      pageCount,
      summary: Object.freeze({ byteLength: bytes.byteLength, pageCount, firstPageBase64: firstPage.toString("base64"), truncated: pageCount > 1 }),
    });
    await this.#objects.put({ key, bytes: zstdCompressSync(bytes) });
    return await this.#tenantTransaction(input.scope.tenantId, async (client) => {
      const inserted = await client.query<{
        id: string; tenant_id: string; session_id: string; storage_key: string; content_digest: string;
        byte_size: number; page_size_bytes: number; page_count: number; summary: unknown; expires_at: Date;
      }>(
        `INSERT INTO result_refs(
           id,tenant_id,session_id,invocation_id,ref_label,content_type,storage_key,content_digest,
           byte_size,page_size_bytes,page_count,summary,idempotency_key,expires_at)
         VALUES($1,$2,$3,$4,$5,'application/json',$6,$7,$8,$9,$10,$11::jsonb,$12,to_timestamp($13/1000.0))
         ON CONFLICT (tenant_id,session_id,idempotency_key) DO NOTHING
         RETURNING id::text,tenant_id::text,session_id::text,storage_key,content_digest::text,
                   byte_size,page_size_bytes,page_count,summary,expires_at`,
        [ref.refId, ref.tenantId, ref.sessionId, input.invocationId, refLabel, ref.storageKey,
          ref.digest.slice("sha256:".length), ref.summary.byteLength, ref.pageSizeBytes,
          ref.pageCount, JSON.stringify(ref.summary), input.idempotencyKey, ref.expiresAtMs],
      );
      if (inserted.rows[0] !== undefined) return parseReferenceRow(inserted.rows[0]);
      const raced = await client.query<{
        id: string; tenant_id: string; session_id: string; storage_key: string; content_digest: string;
        byte_size: number; page_size_bytes: number; page_count: number; summary: unknown; expires_at: Date;
      }>(
        `SELECT id::text,tenant_id::text,session_id::text,storage_key,content_digest::text,
                byte_size,page_size_bytes,page_count,summary,expires_at
         FROM result_refs WHERE tenant_id=$1 AND session_id=$2 AND idempotency_key=$3`,
        [input.scope.tenantId, input.scope.sessionId, input.idempotencyKey],
      );
      const prior = raced.rows[0];
      if (prior === undefined) throw new Error("result reference insert race lost durable row");
      const durable = parseReferenceRow(prior);
      if (durable.digest !== digest || durable.expiresAtMs !== expiresAtMs || durable.pageSizeBytes !== pageSizeBytes) throw new ResultReferenceIdempotencyError("result reference idempotency replay changed immutable payload or lifecycle");
      return durable;
    });
  }

  public async getResultPage(input: { readonly scope: ResultReferenceScope; readonly refId: string; readonly pageIndex: number }): Promise<ResultReferencePage> {
    if (!Number.isSafeInteger(input.pageIndex) || input.pageIndex < 0) return Object.freeze({ kind: "page_out_of_range" });
    assertUuid(input.scope.tenantId, "tenant id"); assertUuid(input.scope.sessionId, "session id"); assertUuid(input.refId, "result reference id");
    const ref = await this.#tenantTransaction(input.scope.tenantId, async (client) => {
      const row = await client.query<{
        id: string; tenant_id: string; session_id: string; storage_key: string; content_digest: string;
        byte_size: number; page_size_bytes: number; page_count: number; summary: unknown; expires_at: Date;
      }>(
        `SELECT id::text,tenant_id::text,session_id::text,storage_key,content_digest::text,
                byte_size,page_size_bytes,page_count,summary,expires_at
         FROM result_refs WHERE tenant_id=$1 AND session_id=$2 AND id=$3 AND lifecycle='active'`,
        [input.scope.tenantId, input.scope.sessionId, input.refId],
      );
      return row.rows[0] === undefined ? null : parseReferenceRow(row.rows[0]);
    });
    if (ref === null) return Object.freeze({ kind: "not_found" });
    if (ref.expiresAtMs <= this.#now()) return Object.freeze({ kind: "expired" });
    if (input.pageIndex >= ref.pageCount) return Object.freeze({ kind: "page_out_of_range" });
    const compressed = await this.#objects.get({ key: ref.storageKey });
    if (compressed === null) return Object.freeze({ kind: "not_found" });
    const bytes = zstdDecompressSync(compressed);
    if (resultReferenceDigest(bytes) !== ref.digest) return Object.freeze({ kind: "not_found" });
    const start = input.pageIndex * ref.pageSizeBytes;
    const page = new Uint8Array(bytes.subarray(start, Math.min(bytes.byteLength, start + ref.pageSizeBytes)));
    return Object.freeze({ kind: "page", ref, pageIndex: input.pageIndex, bytes: page, base64: Buffer.from(page).toString("base64") });
  }

  public async expireResults(input: { readonly tenantId: string; readonly nowMs?: number; readonly limit?: number }): Promise<readonly ResultReference[]> {
    const nowMs = input.nowMs ?? this.#now();
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error("result expiry limit is outside the bounded range");
    const candidates = await this.#tenantTransaction(input.tenantId, async (client) => {
      const rows = await client.query<{
        id: string; tenant_id: string; session_id: string; storage_key: string; content_digest: string;
        byte_size: number; page_size_bytes: number; page_count: number; summary: unknown; expires_at: Date;
      }>(
        `SELECT id::text,tenant_id::text,session_id::text,storage_key,content_digest::text,
                byte_size,page_size_bytes,page_count,summary,expires_at
         FROM result_refs
         WHERE tenant_id=$1 AND expires_at <= to_timestamp($2/1000.0) AND lifecycle IN ('active','deleting')
         ORDER BY expires_at,id LIMIT $3 FOR UPDATE SKIP LOCKED`,
        [input.tenantId, nowMs, limit],
      );
      await client.query(
        `UPDATE result_refs SET lifecycle='deleting'
         WHERE tenant_id=$1 AND id = ANY($2::uuid[])`,
        [input.tenantId, rows.rows.map((row) => row.id)],
      );
      return rows.rows.map(parseReferenceRow);
    });
    for (const ref of candidates) await this.#objects.delete({ key: ref.storageKey });
    await this.#tenantTransaction(input.tenantId, async (client) => {
      await client.query(
        `DELETE FROM result_refs WHERE tenant_id=$1 AND id = ANY($2::uuid[]) AND lifecycle='deleting'`,
        [input.tenantId, candidates.map((ref) => ref.refId)],
      );
    });
    return Object.freeze(candidates);
  }

  public async archiveEvents(input: {
    readonly tenantId: string;
    readonly month: string;
    readonly owner: string;
    readonly asOfMs: number;
    readonly retentionClass?: CanonicalRetentionClass;
    readonly afterObjectWrite?: (run: RetentionArchiveRun) => Promise<void> | void;
    readonly onBoundary?: (input: Readonly<{ readonly stage: RetentionArchiveBoundary; readonly run: RetentionArchiveRun }>) => Promise<void> | void;
  }): Promise<RetentionArchiveRun> {
    // Typed child partitions are detached first so the canonical envelope leaf
    // can be dropped without a surviving typed foreign-key reference.
    const retentionClass = requireCanonicalRetentionClass("events", input.retentionClass);
    if (retentionClass === "standard_12m") {
      await this.#archiveSurfaceIfPresent({ tenantId: input.tenantId, month: input.month, owner: input.owner, asOfMs: input.asOfMs, surface: "tool_invocations" });
      await this.#archiveSurfaceIfPresent({ tenantId: input.tenantId, month: input.month, owner: input.owner, asOfMs: input.asOfMs, surface: "llm_calls" });
    }
    return await this.archiveSurface({ ...input, retentionClass, surface: "events" });
  }

  /** Archive each governed typed table using a durable tenant/month/surface lease. */
  public async archiveSurface(input: {
    readonly tenantId: string;
    readonly month: string;
    readonly surface: RetentionSurface;
    readonly owner: string;
    readonly asOfMs: number;
    readonly retentionClass?: CanonicalRetentionClass;
    readonly afterObjectWrite?: (run: RetentionArchiveRun) => Promise<void> | void;
    readonly onBoundary?: (input: Readonly<{ readonly stage: RetentionArchiveBoundary; readonly run: RetentionArchiveRun }>) => Promise<void> | void;
  }): Promise<RetentionArchiveRun> {
    const archiveMonth = monthStart(input.month);
    const retentionClass = requireCanonicalRetentionClass(input.surface, input.retentionClass);
    const trustedNowMs = this.#now();
    if (!Number.isSafeInteger(input.asOfMs) || input.asOfMs < 0 || input.asOfMs > trustedNowMs) {
      throw new RetentionNotDueError("retention requires an explicit trusted non-future asOf");
    }
    const prepared = await this.#tenantTransaction(input.tenantId, async (client) => {
      const priorResult = await client.query<{
        state: RetentionArchiveRun["state"]; archive_key: string; archive_digest: string; event_count: number;
        attempts: number; lease_owner: string | null; lease_expires_at: Date | null; lease_epoch: number;
      }>(
        `SELECT state,archive_key,archive_digest::text,event_count,attempts,lease_owner,lease_expires_at,lease_epoch
         FROM retention_runs WHERE tenant_id=$1 AND archive_month=$2::date AND archive_kind=$3 AND retention_class=$4 FOR UPDATE`,
        [input.tenantId, archiveMonth, input.surface, retentionClass],
      );
      const prior = priorResult.rows[0];
      if (prior?.state === "dropped") {
        return Object.freeze({
          run: immutableArchiveRun({ tenantId: input.tenantId, month: input.month, retentionClass, state: "dropped", archiveKey: prior.archive_key, archiveDigest: `sha256:${prior.archive_digest}`, eventCount: prior.event_count, attempts: prior.attempts }),
           raw: Buffer.alloc(0), epoch: prior.lease_epoch, alreadyDropped: true,
        });
      }
      const nowMs = trustedNowMs;
      if (prior !== undefined && prior.lease_owner !== null && prior.lease_owner !== input.owner && (prior.lease_expires_at?.getTime() ?? 0) > nowMs) {
        throw new RetentionLeaseError("retention partition lease is held by another owner");
      }
      const key = prior?.archive_key ?? archiveKey(input.tenantId, input.surface, retentionClass, input.month);
      const attempts = (prior?.attempts ?? 0) + 1;
      const epoch = (prior?.lease_epoch ?? 0) + 1;
      const ownership = await client.query<{ state: "active" | "prepared" | "dropped"; retention_until: Date }>(
        `SELECT state,retention_until FROM retention_partition_ownership
         WHERE tenant_id=$1 AND archive_kind=$2 AND retention_class=$3 AND archive_month=$4::date`,
        [input.tenantId, input.surface, retentionClass, archiveMonth],
      );
      if (ownership.rows[0] === undefined) {
        throw new RetentionNotDueError("canonical retention partition is unavailable");
      } else if (ownership.rows[0].state === "dropped") {
        throw new Error("retention run and canonical partition ownership disagree");
      } else if (ownership.rows[0].retention_until.getTime() > input.asOfMs) {
        throw new RetentionNotDueError("canonical retention partition is not due at trusted asOf");
      }
      const placeholderDigest = archiveDigest(Buffer.alloc(0));
      await client.query(
        `INSERT INTO retention_runs(tenant_id,archive_month,archive_kind,retention_class,state,archive_key,archive_digest,row_digest,event_count,attempts,lease_owner,lease_expires_at,lease_epoch,as_of)
         VALUES($1,$2::date,$3,$4,'prepared',$5,$6,$6,$7,$8,$9,to_timestamp($10/1000.0),$11,to_timestamp($12/1000.0))
         ON CONFLICT (tenant_id,archive_month,archive_kind,retention_class) DO UPDATE SET
            state='prepared',archive_key=EXCLUDED.archive_key,archive_digest=EXCLUDED.archive_digest,row_digest=EXCLUDED.row_digest,
            event_count=EXCLUDED.event_count,attempts=EXCLUDED.attempts,lease_owner=EXCLUDED.lease_owner,
            lease_expires_at=EXCLUDED.lease_expires_at,lease_epoch=EXCLUDED.lease_epoch,as_of=EXCLUDED.as_of,updated_at=clock_timestamp()`,
        [input.tenantId, archiveMonth, input.surface, retentionClass, key, placeholderDigest, 0, attempts, input.owner, nowMs + 300_000, epoch, input.asOfMs],
      );
      const canonical = await client.query<{ partition_key: string; partition_table: string }>(
        "SELECT partition_key,partition_table FROM revagent_prepare_canonical_retention_partition($1,$2,$3,$4::date,$5,$6,$7)",
        [input.tenantId, input.surface, retentionClass, archiveMonth, input.asOfMs, input.owner, epoch],
      );
      if (canonical.rows[0] === undefined) throw new Error("canonical retention partition preparation returned no authority");
      const rows = await this.#readArchiveRows(client, input.tenantId, archiveMonth, input.surface, retentionClass);
      const raw = Buffer.from(rows.values.map((value) => canonicalizeJson(value as JsonValue)).join(rows.values.length === 0 ? "" : "\n") + (rows.values.length === 0 ? "" : "\n"), "utf8");
      const digest = archiveDigest(raw);
      const measured = await client.query(
        `UPDATE retention_runs SET archive_digest=$7,row_digest=$7,event_count=$8,updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND archive_month=$2::date AND archive_kind=$3 AND retention_class=$4 AND state='prepared' AND lease_owner=$5 AND lease_epoch=$6 AND as_of=to_timestamp($9/1000.0)`,
        [input.tenantId, archiveMonth, input.surface, retentionClass, input.owner, epoch, digest, rows.ids.length, input.asOfMs],
      );
      if (measured.rowCount !== 1) throw new RetentionLeaseError("retention lease was lost before canonical partition enumeration");
      return Object.freeze({
        run: immutableArchiveRun({ tenantId: input.tenantId, month: input.month, retentionClass, state: "prepared", archiveKey: key, archiveDigest: `sha256:${digest}`, eventCount: rows.ids.length, attempts }),
        raw, epoch, alreadyDropped: false,
      });
    });
    if (prepared.alreadyDropped) return prepared.run;
    await input.onBoundary?.({ stage: "prepared", run: prepared.run });
    await this.#objects.put({ key: prepared.run.archiveKey, bytes: zstdCompressSync(prepared.raw) });
    await input.onBoundary?.({ stage: "object_written", run: prepared.run });
    const persistedArchive = await this.#objects.get({ key: prepared.run.archiveKey });
    if (persistedArchive === null || archiveDigest(zstdDecompressSync(persistedArchive)) !== prepared.run.archiveDigest.slice("sha256:".length)) {
      throw new Error("retention object write could not be verified before partition drop");
    }
    await input.afterObjectWrite?.(prepared.run);
    await input.onBoundary?.({ stage: "object_verified", run: prepared.run });
    await this.#tenantTransaction(input.tenantId, async (client) => {
      const uploaded = await client.query(
        `UPDATE retention_runs SET state='uploaded',lease_expires_at=to_timestamp($7/1000.0),updated_at=clock_timestamp()
         WHERE tenant_id=$1 AND archive_month=$2::date AND archive_kind=$3 AND retention_class=$4 AND state='prepared'
           AND lease_owner=$5 AND lease_epoch=$6 AND as_of=to_timestamp($8/1000.0) AND lease_expires_at > clock_timestamp()`,
        [input.tenantId, archiveMonth, input.surface, retentionClass, input.owner, prepared.epoch, this.#now() + 300_000, input.asOfMs],
      );
      if (uploaded.rowCount !== 1) throw new RetentionLeaseError("retention lease was lost before durable archive commit");
      await input.onBoundary?.({ stage: "uploaded", run: prepared.run });
      await client.query(
        "SELECT revagent_finalize_canonical_retention_partition($1,$2,$3,$4::date,$5,$6,$7)",
        [input.tenantId, input.surface, retentionClass, archiveMonth, input.asOfMs, input.owner, prepared.epoch],
      );
    });
    return immutableArchiveRun({ ...prepared.run, state: "dropped" });
  }

  async #archiveSurfaceIfPresent(input: {
    readonly tenantId: string;
    readonly month: string;
    readonly surface: Exclude<RetentionSurface, "events">;
    readonly owner: string;
    readonly asOfMs: number;
  }): Promise<RetentionArchiveRun | null> {
    const archiveMonth = monthStart(input.month);
    const ownership = await this.#tenantTransaction(input.tenantId, async (client) => await client.query<{ state: "active" | "prepared" | "dropped" }>(
      `SELECT state FROM retention_partition_ownership
       WHERE tenant_id=$1 AND archive_kind=$2 AND retention_class='standard_12m' AND archive_month=$3::date`,
      [input.tenantId, input.surface, archiveMonth],
    ));
    if (ownership.rows[0] === undefined || ownership.rows[0].state === "dropped") return null;
    return await this.archiveSurface({ ...input, retentionClass: "standard_12m" });
  }

  async #readArchiveRows(client: PoolClient, tenantId: string, archiveMonth: string, surface: RetentionSurface, retentionClass: CanonicalRetentionClass): Promise<Readonly<{ readonly ids: readonly string[]; readonly values: readonly GatewayJsonValue[] }>> {
    if (surface === "events") {
      const result = await client.query<{
        id: string; event_type: GatewayEventEnvelope["event_type"]; occurred_at: Date; recorded_at: Date;
        source: unknown; actor: unknown; session_id: string | null; turn_id: string | null; sequence: number | string; payload: unknown;
      }>(
        `SELECT event.id::text,event.event_type,event.occurred_at,event.recorded_at,event.source,event.actor,event.session_id::text,event.turn_id::text,event.sequence,event.payload
         FROM events AS event
         WHERE event.tenant_id=$1 AND event.retention_partition_month=$2::date AND event.retention_class=$3 ORDER BY event.occurred_at,event.id`, [tenantId, archiveMonth, retentionClass],
      );
      const values = result.rows.map((row) => validateEu12EventEnvelope({
        schema: "revagent.event.v2", event_id: row.id, event_type: row.event_type,
        occurred_at: row.occurred_at.toISOString(), recorded_at: row.recorded_at.toISOString(), tenant_id: tenantId,
        source: row.source, actor: row.actor, ...(row.session_id === null ? {} : { session_id: row.session_id }),
        ...(row.turn_id === null ? {} : { turn_id: row.turn_id }), seq: Number(row.sequence), payload: row.payload,
      }) as unknown as GatewayJsonValue);
      return Object.freeze({ ids: Object.freeze(result.rows.map((row) => row.id)), values: Object.freeze(values) });
    }
    const table = surface === "tool_invocations" ? "tool_invocations" : "llm_calls";
    const timeColumn = surface === "tool_invocations" ? "started_at" : "created_at";
    const result = await client.query<{ id: string; record: GatewayJsonValue }>(
      `SELECT source.id::text,row_to_json(source)::jsonb AS record FROM ${table} AS source
       WHERE source.tenant_id=$1 AND source.retention_partition_month=$2::date AND source.retention_class=$3 ORDER BY source.${timeColumn},source.id`, [tenantId, archiveMonth, retentionClass],
    );
    return Object.freeze({ ids: Object.freeze(result.rows.map((row) => row.id)), values: Object.freeze(result.rows.map((row) => row.record)) });
  }

  public async publishRelease(input: {
    readonly release: BridgeReleaseContract;
    readonly releaseSequence: number;
    readonly rollbackFloorSequence?: number;
    readonly tenantIds: readonly string[];
  }): Promise<DurableReleaseAuthority> {
    const release = input.release;
    assertUuid(release.id, "release id");
    if (!Number.isSafeInteger(input.releaseSequence) || input.releaseSequence < 1 || !Number.isSafeInteger(input.rollbackFloorSequence ?? 0) || (input.rollbackFloorSequence ?? 0) < 0 || (input.rollbackFloorSequence ?? 0) > input.releaseSequence) throw new Error("release sequence authority is invalid");
    if (!this.#pinnedSigningKeyIds.has(release.signingKeyId)) throw new Error("bridge release signing key is not pinned");
    const artifact = await this.#objects.get({ key: release.artifactStorageKey });
    if (artifact === null || resultReferenceDigest(artifact) !== release.artifactSha256) throw new Error("bridge release artifact digest does not match stored artifact");
    const tenantIds = canonicalTenantTargets(input.tenantIds);
    if (this.#publisherPool === null) throw new Error("release publisher authority is unavailable");
    const client = await this.#publisherPool.connect();
    try {
      await client.query("BEGIN");
      const prior = await client.query<{ channel_revision: number; rollback_floor_sequence: string | number }>(
        "SELECT channel_revision,rollback_floor_sequence FROM release_channels WHERE channel=$1 FOR UPDATE", [release.channel],
      );
      const channelRevision = (prior.rows[0]?.channel_revision ?? 0) + 1;
      // The channel trigger persists candidate sequence as both anti-rollback
      // floors when it advances.  Sign precisely that state, never a caller
      // default that the trigger will subsequently replace.
      const authority: DurableReleaseAuthority = Object.freeze({
        releaseSequence: input.releaseSequence,
        releaseRollbackFloorSequence: Math.max(input.rollbackFloorSequence ?? 0, input.releaseSequence),
        channelRevision,
        channelRollbackFloorSequence: Math.max(Number(prior.rows[0]?.rollback_floor_sequence ?? 0), input.releaseSequence),
        tenantIds,
      });
      const knownTargets = await client.query<{ id: string }>("SELECT id::text FROM tenants WHERE id = ANY($1::uuid[])", [tenantIds]);
      if (knownTargets.rowCount !== tenantIds.length) throw new Error("release target tenant is unavailable");
      const manifest = canonicalDurableReleaseManifest({
        release,
        releaseSequence: authority.releaseSequence,
        releaseRollbackFloorSequence: authority.releaseRollbackFloorSequence,
        channelRollbackFloorSequence: authority.channelRollbackFloorSequence,
        channelRevision: authority.channelRevision,
        tenantIds: authority.tenantIds,
      });
      if (!this.#signatureVerifier.verify({ signingKeyId: release.signingKeyId, canonicalManifest: manifest, signature: release.signature })) throw new Error("bridge release manifest signature is invalid");
      const legacyManifest = JSON.parse(manifest) as JsonValue;
      const legacyEnvelope = { legacySignature: release.signature } as unknown as JsonValue;
      const releaseWrite = await client.query<{ release_sequence: string | number; rollback_floor_sequence: string | number }>(
        `INSERT INTO bridge_releases(id,version,channel,artifact_storage_key,artifact_sha256,signature,signing_key_id,min_supported_version,released_at,released_by,release_sequence,manifest_digest,rollback_floor_sequence,
           manifest_json,signature_envelope_json,bridge_storage_key,bridge_sha256,bridge_size_bytes,addin_storage_key,addin_sha256,addin_size_bytes,rollout_percent)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9/1000.0),$10,$11,$5,$12,$13::jsonb,$14::jsonb,$4,$5,$15,$16,$5,$15,0)
          ON CONFLICT (id) DO NOTHING
          RETURNING release_sequence,rollback_floor_sequence`,
        [release.id, release.version, release.channel, release.artifactStorageKey, release.artifactSha256.slice("sha256:".length), release.signature, release.signingKeyId, release.minSupportedVersion, release.releasedAtMs, release.releasedBy, authority.releaseSequence, authority.releaseRollbackFloorSequence,
          JSON.stringify(legacyManifest), JSON.stringify(legacyEnvelope), artifact.byteLength,
          `${release.artifactStorageKey}.legacy-addin-unavailable`],
      );
      const persistedRelease = releaseWrite.rows[0] ?? (await client.query<{ release_sequence: string | number; rollback_floor_sequence: string | number }>(
        "SELECT release_sequence,rollback_floor_sequence FROM bridge_releases WHERE id=$1", [release.id],
      )).rows[0];
      if (persistedRelease === undefined || Number(persistedRelease.release_sequence) !== authority.releaseSequence || Number(persistedRelease.rollback_floor_sequence) !== authority.releaseRollbackFloorSequence) {
        throw new Error("release authority differs from the signed durable state");
      }
      const channelWrite = await client.query<{ channel_revision: number; rollback_floor_sequence: string | number }>(
        `INSERT INTO release_channels(channel,current_release_id,staged_rollout,channel_revision,rollback_floor_sequence)
          VALUES($1,$2,$3::jsonb,$4,$5)
          ON CONFLICT (channel) DO UPDATE SET current_release_id=EXCLUDED.current_release_id,staged_rollout=EXCLUDED.staged_rollout,
            channel_revision=EXCLUDED.channel_revision,rollback_floor_sequence=EXCLUDED.rollback_floor_sequence
          RETURNING channel_revision,rollback_floor_sequence`,
        [release.channel, release.id, JSON.stringify({ tenantIds: authority.tenantIds, revision: authority.channelRevision }), authority.channelRevision, authority.channelRollbackFloorSequence],
      );
      const persistedChannel = channelWrite.rows[0];
      if (persistedChannel === undefined || persistedChannel.channel_revision !== authority.channelRevision || Number(persistedChannel.rollback_floor_sequence) !== authority.channelRollbackFloorSequence) {
        throw new Error("channel authority differs from the signed durable state");
      }
      await client.query("DELETE FROM release_channel_targets WHERE channel=$1", [release.channel]);
      for (const tenantId of authority.tenantIds) {
        await client.query("INSERT INTO release_channel_targets(channel,tenant_id,rollout_revision) VALUES($1,$2,$3)", [release.channel, tenantId, authority.channelRevision]);
      }
      const persistedTargets = await client.query<{ tenant_id: string; rollout_revision: number }>(
        "SELECT tenant_id::text,rollout_revision FROM release_channel_targets WHERE channel=$1 ORDER BY tenant_id", [release.channel],
      );
      if (persistedTargets.rows.length !== authority.tenantIds.length || persistedTargets.rows.some((row, index) => row.tenant_id !== authority.tenantIds[index] || row.rollout_revision !== authority.channelRevision)) {
        throw new Error("tenant rollout authority differs from the signed durable state");
      }
      await client.query("COMMIT");
      return authority;
    } catch (error) {
      await client.query("ROLLBACK"); throw error;
    } finally { client.release(); }
  }

  public async publishBridgeUpdateRelease(input: {
    readonly release: BridgeUpdateReleaseAuthority;
    readonly tenantIds: readonly string[];
    readonly deviceRings?: readonly BridgeUpdateDeviceRingAssignment[];
  }): Promise<DurableReleaseAuthority> {
    const release = input.release;
    validateBridgeUpdateReleaseAuthority(release);
    assertUuid(release.id, "release id");
    if (this.#publisherPool === null || this.#bridgeManifestVerifier === undefined) {
      throw new Error("Bridge update publisher authority is unavailable");
    }
    const verification = this.#bridgeManifestVerifier({
      manifest: release.manifest,
      signatureEnvelope: release.signatureEnvelope,
    });
    if (verification.keyId !== release.signingKeyId || verification.contentSha256 !== release.manifestDigest) {
      throw new Error("Bridge update signature authority differs from release metadata");
    }
    const tenantIds = canonicalTenantTargets(input.tenantIds);
    const deviceRings = [...(input.deviceRings ?? [])].sort((left, right) =>
      left.tenantId.localeCompare(right.tenantId) || left.deviceId.localeCompare(right.deviceId));
    const seenDevices = new Set<string>();
    for (const assignment of deviceRings) {
      assertUuid(assignment.tenantId, "ring tenant id");
      assertUuid(assignment.deviceId, "ring device id");
      if (!tenantIds.includes(assignment.tenantId) || !Number.isSafeInteger(assignment.ring) ||
          assignment.ring < 0 || assignment.ring > 99 ||
          !seenDevices.add(`${assignment.tenantId}/${assignment.deviceId}`)) {
        throw new Error("Bridge update device-ring authority is invalid");
      }
    }
    const manifestObject = JSON.parse(canonicalizeJson(release.manifest)) as JsonValue;
    const envelopeObject = JSON.parse(canonicalizeJson(release.signatureEnvelope)) as JsonValue;
    const signature = (release.signatureEnvelope as { readonly signature?: unknown }).signature;
    if (typeof signature !== "string") throw new Error("Bridge update signature is unavailable");

    const client = await this.#publisherPool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{
        version: string; channel: BridgeReleaseChannel; signing_key_id: string; min_supported_version: string;
        released_at: Date; released_by: string; rollback_floor_sequence: string | number; rollout_percent: number;
        manifest_json: JsonValue; signature_envelope_json: JsonValue; release_sequence: string | number;
        manifest_digest: string; bridge_storage_key: string; bridge_sha256: string; bridge_size_bytes: string | number;
        addin_storage_key: string; addin_sha256: string; addin_size_bytes: string | number;
      }>(`SELECT version,channel,signing_key_id,min_supported_version,released_at,released_by,
                 rollback_floor_sequence,rollout_percent,manifest_json,signature_envelope_json,release_sequence,manifest_digest,
                 bridge_storage_key,bridge_sha256::text,bridge_size_bytes,
                 addin_storage_key,addin_sha256::text,addin_size_bytes
          FROM bridge_releases WHERE id=$1 FOR UPDATE`, [release.id]);
      const priorRelease = existing.rows[0];
      if (priorRelease !== undefined) {
        const same = canonicalizeJson(priorRelease.manifest_json) === canonicalizeJson(manifestObject) &&
          canonicalizeJson(priorRelease.signature_envelope_json) === canonicalizeJson(envelopeObject) &&
          priorRelease.version === release.version && priorRelease.channel === release.channel &&
          priorRelease.signing_key_id === release.signingKeyId && priorRelease.min_supported_version === release.minSupportedVersion &&
          priorRelease.released_at.getTime() === release.releasedAtMs && priorRelease.released_by === release.releasedBy &&
          Number(priorRelease.rollback_floor_sequence) === release.rollbackFloorSequence && priorRelease.rollout_percent === release.rolloutPercent &&
          Number(priorRelease.release_sequence) === release.releaseSequence && priorRelease.manifest_digest === release.manifestDigest &&
          priorRelease.bridge_storage_key === release.components.bridge.storageKey && priorRelease.bridge_sha256 === release.components.bridge.sha256 &&
          Number(priorRelease.bridge_size_bytes) === release.components.bridge.sizeBytes &&
          priorRelease.addin_storage_key === release.components.addin.storageKey && priorRelease.addin_sha256 === release.components.addin.sha256 &&
          Number(priorRelease.addin_size_bytes) === release.components.addin.sizeBytes;
        if (!same) throw new Error("Bridge update release identity is immutable");
      }
      const priorChannel = await client.query<{ current_release_id: string; channel_revision: number; rollback_floor_sequence: string | number }>(
        "SELECT current_release_id::text,channel_revision,rollback_floor_sequence FROM release_channels WHERE channel=$1 FOR UPDATE",
        [release.channel],
      );
      if (release.releaseSequence < Number(priorChannel.rows[0]?.rollback_floor_sequence ?? 0)) {
        throw new Error("Bridge update release is below the channel rollback floor");
      }
      const knownTargets = await client.query<{ id: string }>("SELECT id::text FROM tenants WHERE id = ANY($1::uuid[])", [tenantIds]);
      if (knownTargets.rowCount !== tenantIds.length) throw new Error("Bridge update target tenant is unavailable");
      for (const assignment of deviceRings) {
        const known = await client.query("SELECT 1 FROM devices WHERE tenant_id=$1 AND id=$2", [assignment.tenantId, assignment.deviceId]);
        if (known.rowCount !== 1) throw new Error("Bridge update ring device is unavailable");
      }
      if (priorRelease === undefined) {
        await client.query(
          `INSERT INTO bridge_releases(
             id,version,channel,artifact_storage_key,artifact_sha256,signature,signing_key_id,
             min_supported_version,released_at,released_by,release_sequence,manifest_digest,
             rollback_floor_sequence,manifest_json,signature_envelope_json,
             bridge_storage_key,bridge_sha256,bridge_size_bytes,
             addin_storage_key,addin_sha256,addin_size_bytes,rollout_percent)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9/1000.0),$10,$11,$12,$13,
             $14::jsonb,$15::jsonb,$16,$17,$18,$19,$20,$21,$22)`,
          [release.id, release.version, release.channel, release.components.bridge.storageKey,
            release.components.bridge.sha256, signature, release.signingKeyId,
            release.minSupportedVersion, release.releasedAtMs, release.releasedBy,
            release.releaseSequence, release.manifestDigest, release.rollbackFloorSequence,
            JSON.stringify(manifestObject), JSON.stringify(envelopeObject),
            release.components.bridge.storageKey, release.components.bridge.sha256,
            release.components.bridge.sizeBytes, release.components.addin.storageKey,
            release.components.addin.sha256, release.components.addin.sizeBytes,
            release.rolloutPercent],
        );
      }
      const idempotentChannel = priorChannel.rows[0]?.current_release_id === release.id;
      if (!idempotentChannel) {
        await client.query(
          `INSERT INTO release_channels(channel,current_release_id,staged_rollout,channel_revision,rollback_floor_sequence)
           VALUES($1,$2,$3::jsonb,1,$4)
           ON CONFLICT (channel) DO UPDATE SET current_release_id=EXCLUDED.current_release_id,
             staged_rollout=EXCLUDED.staged_rollout`,
          [release.channel, release.id, JSON.stringify({ tenantIds, revision: (priorChannel.rows[0]?.channel_revision ?? 0) + 1 }), release.rollbackFloorSequence],
        );
      }
      const channel = await client.query<{ channel_revision: number; rollback_floor_sequence: string | number }>(
        "SELECT channel_revision,rollback_floor_sequence FROM release_channels WHERE channel=$1", [release.channel]);
      const channelAuthority = channel.rows[0];
      if (channelAuthority === undefined) throw new Error("Bridge update channel authority was not persisted");
      if (!idempotentChannel) {
        await client.query("DELETE FROM release_channel_targets WHERE channel=$1", [release.channel]);
        await client.query("DELETE FROM bridge_release_device_rings WHERE channel=$1", [release.channel]);
        for (const tenantId of tenantIds) {
          await client.query("INSERT INTO release_channel_targets(channel,tenant_id,rollout_revision) VALUES($1,$2,$3)", [release.channel, tenantId, channelAuthority.channel_revision]);
        }
        for (const assignment of deviceRings) {
          await client.query("INSERT INTO bridge_release_device_rings(channel,tenant_id,device_id,ring,rollout_revision) VALUES($1,$2,$3,$4,$5)",
            [release.channel, assignment.tenantId, assignment.deviceId, assignment.ring, channelAuthority.channel_revision]);
        }
      }
      const persistedTargets = await client.query<{ tenant_id: string }>(
        "SELECT tenant_id::text FROM release_channel_targets WHERE channel=$1 ORDER BY tenant_id", [release.channel]);
      if (persistedTargets.rows.map((row) => row.tenant_id).join("\0") !== tenantIds.join("\0")) {
        throw new Error("Bridge update tenant target authority differs from import");
      }
      const persistedRings = await client.query<{ tenant_id: string; device_id: string; ring: number }>(
        "SELECT tenant_id::text,device_id::text,ring FROM bridge_release_device_rings WHERE channel=$1 ORDER BY tenant_id,device_id", [release.channel]);
      const comparableRings = persistedRings.rows.map((row) => ({ tenantId: row.tenant_id, deviceId: row.device_id, ring: row.ring }));
      if (canonicalizeJson(comparableRings as unknown as JsonValue) !== canonicalizeJson(deviceRings as unknown as JsonValue)) {
        throw new Error("Bridge update device-ring authority differs from import");
      }
      await client.query("COMMIT");
      return Object.freeze({
        releaseSequence: release.releaseSequence,
        releaseRollbackFloorSequence: release.rollbackFloorSequence,
        channelRevision: channelAuthority.channel_revision,
        channelRollbackFloorSequence: Number(channelAuthority.rollback_floor_sequence),
        tenantIds,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  public async readBridgeUpdateForDevice(input: { readonly tenantId: string; readonly deviceId: string }): Promise<Readonly<{
    readonly release: BridgeUpdateReleaseAuthority;
    readonly deviceRing: number;
  }> | null> {
    assertUuid(input.deviceId, "device id");
    return await this.#tenantTransaction(input.tenantId, async (client) => {
      const result = await client.query<{
        id: string; version: string; channel: BridgeReleaseChannel; release_sequence: string | number;
        rollback_floor_sequence: string | number; manifest_json: JsonValue; signature_envelope_json: JsonValue;
        manifest_digest: string; signing_key_id: string; rollout_percent: number; min_supported_version: string;
        released_at: Date; released_by: string; bridge_storage_key: string; bridge_sha256: string;
        bridge_size_bytes: string | number; addin_storage_key: string; addin_sha256: string;
        addin_size_bytes: string | number; ring: number | null;
      }>(`SELECT release.id::text,release.version,release.channel,release.release_sequence,
                  release.rollback_floor_sequence,release.manifest_json,release.signature_envelope_json,
                  release.manifest_digest::text,release.signing_key_id,release.rollout_percent,
                  release.min_supported_version,release.released_at,release.released_by,
                  release.bridge_storage_key,release.bridge_sha256::text,release.bridge_size_bytes,
                  release.addin_storage_key,release.addin_sha256::text,release.addin_size_bytes,ring.ring
           FROM release_channel_targets target
           JOIN release_channels channel ON channel.channel=target.channel
           JOIN bridge_releases release ON release.id=channel.current_release_id
           LEFT JOIN bridge_release_device_rings ring ON ring.channel=target.channel AND
             ring.tenant_id=target.tenant_id AND ring.device_id=$2 AND ring.rollout_revision=target.rollout_revision
           WHERE target.tenant_id=$1 AND (release.channel='stable' OR ring.device_id IS NOT NULL)
           ORDER BY CASE WHEN ring.device_id IS NOT NULL THEN 0 ELSE 1 END, release.channel
           LIMIT 1`, [input.tenantId, input.deviceId]);
      const row = result.rows[0];
      if (row === undefined) return null;
      const manifest = row.manifest_json as { readonly components?: readonly { readonly name?: string; readonly url?: string; readonly version?: string }[] };
      const component = (name: "bridge" | "addin", storageKey: string, sha256: string, sizeBytes: string | number) => {
        const signed = manifest.components?.find((candidate) => candidate.name === name);
        if (signed?.url === undefined || signed.version === undefined) throw new Error("Bridge update manifest component is unavailable");
        return Object.freeze({ name, version: signed.version, storageKey, sha256, sizeBytes: Number(sizeBytes), url: signed.url });
      };
      const release: BridgeUpdateReleaseAuthority = Object.freeze({
        id: row.id, version: row.version, channel: row.channel,
        releaseSequence: Number(row.release_sequence), rollbackFloorSequence: Number(row.rollback_floor_sequence),
        manifest: row.manifest_json, signatureEnvelope: row.signature_envelope_json,
        manifestDigest: row.manifest_digest, signingKeyId: row.signing_key_id,
        components: Object.freeze({
          bridge: component("bridge", row.bridge_storage_key, row.bridge_sha256, row.bridge_size_bytes),
          addin: component("addin", row.addin_storage_key, row.addin_sha256, row.addin_size_bytes),
        }),
        rolloutPercent: row.rollout_percent, minSupportedVersion: row.min_supported_version,
        releasedAtMs: row.released_at.getTime(), releasedBy: row.released_by,
      });
      validateBridgeUpdateReleaseAuthority(release);
      const ordinary = (createHash("sha256").update(input.deviceId, "utf8").digest().readUInt32BE(0) % 99) + 1;
      return Object.freeze({ release, deviceRing: row.ring ?? ordinary });
    });
  }

  public async readReleaseForTenant(input: { readonly tenantId: string; readonly channel: BridgeReleaseChannel }): Promise<BridgeReleaseContract | null> {
    return await this.#tenantTransaction(input.tenantId, async (client) => {
      const row = await client.query<{
        id: string; version: string; channel: BridgeReleaseChannel; artifact_storage_key: string; artifact_sha256: string;
        signature: string; signing_key_id: string; min_supported_version: string; released_at: Date; released_by: string;
      }>(
        `SELECT release.id::text,release.version,release.channel,release.artifact_storage_key,release.artifact_sha256::text,
                release.signature,release.signing_key_id,release.min_supported_version,release.released_at,release.released_by
         FROM release_channel_targets target
         JOIN release_channels channel ON channel.channel=target.channel
         JOIN bridge_releases release ON release.id=channel.current_release_id
         WHERE target.tenant_id=$1 AND target.channel=$2`,
        [input.tenantId, input.channel],
      );
      const release = row.rows[0];
      return release === undefined ? null : Object.freeze({
        id: release.id, version: release.version, channel: release.channel,
        artifactStorageKey: release.artifact_storage_key, artifactSha256: `sha256:${release.artifact_sha256}`,
        signature: release.signature, signingKeyId: release.signing_key_id,
        minSupportedVersion: release.min_supported_version, releasedAtMs: release.released_at.getTime(), releasedBy: release.released_by,
      });
    });
  }

  public async readArchivedEvents(input: { readonly tenantId: string; readonly month: string; readonly retentionClass?: CanonicalRetentionClass }): Promise<readonly GatewayEventEnvelope[]> {
    const retentionClass = requireCanonicalRetentionClass("events", input.retentionClass);
    const compressed = await this.#objects.get({ key: archiveKey(input.tenantId, "events", retentionClass, input.month) });
    return compressed === null ? Object.freeze([]) : parseArchivedEventNdjson(compressed);
  }

  public async readTypedArchive(input: { readonly tenantId: string; readonly month: string; readonly surface: RetentionSurface; readonly retentionClass?: CanonicalRetentionClass }): Promise<readonly GatewayJsonValue[]> {
    const retentionClass = requireCanonicalRetentionClass(input.surface, input.retentionClass);
    const compressed = await this.#objects.get({ key: archiveKey(input.tenantId, input.surface, retentionClass, input.month) });
    if (compressed === null) return Object.freeze([]);
    const ndjson = zstdDecompressSync(compressed).toString("utf8");
    return Object.freeze(ndjson.split("\n").filter((line) => line.length > 0).map((line) => JSON.parse(line) as GatewayJsonValue));
  }

  /** Durable lifecycle projection for a start that has not yet produced a terminal event. */
  public async beginActiveInvocation(input: {
    readonly tenantId: string;
    readonly invocationId: string;
    readonly sessionId: string;
    readonly actorUserId: string;
    readonly toolName: string;
    readonly startedAtMs: number;
  }): Promise<void> {
    assertUuid(input.invocationId, "invocation id");
    assertUuid(input.sessionId, "session id");
    assertUuid(input.actorUserId, "actor user id");
    await this.#tenantTransaction(input.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO active_invocations(invocation_id,tenant_id,session_id,actor_user_id,tool_name,started_at)
         VALUES($1,$2,$3,$4,$5,to_timestamp($6/1000.0))
          ON CONFLICT (invocation_id) DO UPDATE SET invocation_id=active_invocations.invocation_id
          WHERE active_invocations.tenant_id=EXCLUDED.tenant_id
            AND active_invocations.session_id=EXCLUDED.session_id
            AND active_invocations.actor_user_id=EXCLUDED.actor_user_id
            AND active_invocations.tool_name=EXCLUDED.tool_name
            AND active_invocations.started_at=EXCLUDED.started_at
          RETURNING invocation_id`,
        [input.invocationId, input.tenantId, input.sessionId, input.actorUserId, input.toolName, input.startedAtMs],
      );
      if (result.rowCount !== 1) throw new Error("active invocation replay changed immutable identity");
    });
  }

  public async completeActiveInvocation(input: { readonly tenantId: string; readonly invocationId: string; readonly outcome: string; readonly completedAtMs: number }): Promise<void> {
    assertUuid(input.invocationId, "invocation id");
    await this.#tenantTransaction(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE active_invocations SET terminal_at=to_timestamp($3/1000.0),terminal_outcome=$4
         WHERE tenant_id=$1 AND invocation_id=$2 AND terminal_at IS NULL`,
        [input.tenantId, input.invocationId, input.completedAtMs, input.outcome],
      );
      if (result.rowCount === 1) return;
      const prior = await client.query<{ terminal_outcome: string | null }>(
        "SELECT terminal_outcome FROM active_invocations WHERE tenant_id=$1 AND invocation_id=$2", [input.tenantId, input.invocationId],
      );
      if (prior.rows[0]?.terminal_outcome !== input.outcome) throw new Error("active invocation terminal transition is unavailable");
    });
  }

  /** Converts orphaned starts from a process crash into an explicit timeout. */
  public async recoverStaleActiveInvocations(input: { readonly tenantId: string; readonly nowMs?: number; readonly staleAfterMs: number }): Promise<number> {
    const nowMs = input.nowMs ?? this.#now();
    if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(input.staleAfterMs) || input.staleAfterMs < 1) {
      throw new Error("active invocation stale recovery bounds are invalid");
    }
    return await this.#tenantTransaction(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE active_invocations SET terminal_at=to_timestamp($2/1000.0),terminal_outcome='timeout'
         WHERE tenant_id=$1 AND terminal_at IS NULL AND started_at <= to_timestamp($3/1000.0)`,
        [input.tenantId, nowMs, nowMs - input.staleAfterMs],
      );
      return result.rowCount ?? 0;
    });
  }

  /** Actual attribution from persisted typed rows, not inferred placeholder values. */
  public async readPersistedParityAttribution(tenantId: string): Promise<PersistedParityAttribution> {
    return await this.#tenantTransaction(tenantId, async (client) => {
      const active = await client.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM active_invocations WHERE tenant_id=$1 AND terminal_at IS NULL", [tenantId],
      );
      const tools = await client.query<{ tool_name: string; user_id: string; count: number }>(
        `SELECT tool_name,actor_user_id::text AS user_id,count(*)::int AS count
         FROM tool_invocations AS tool
         WHERE tool.tenant_id=$1 GROUP BY tool_name,actor_user_id ORDER BY tool_name,user_id`, [tenantId],
      );
      const models = await client.query<{ model: string; user_id: string; count: number }>(
        `SELECT llm.model,session.user_id::text AS user_id,count(*)::int AS count
         FROM llm_calls llm
         JOIN sessions session ON session.tenant_id=llm.tenant_id AND session.id=llm.session_id
         WHERE llm.tenant_id=$1 GROUP BY llm.model,session.user_id ORDER BY llm.model,user_id`, [tenantId],
      );
      const collect = <T extends { readonly count: number }>(rows: readonly T[], group: (row: T) => string, user: (row: T) => string): Record<string, Record<string, number>> => {
        const result: Record<string, Record<string, number>> = {};
        for (const row of rows) {
          const groupName = group(row);
          const users = result[groupName] ?? {};
          users[user(row)] = row.count;
          result[groupName] = users;
        }
        return result;
      };
      return Object.freeze({
        activeTaskCount: active.rows[0]?.count ?? 0,
        toolUserAttribution: Object.freeze(collect(tools.rows, (row) => row.tool_name, (row) => row.user_id)),
        modelUserAttribution: Object.freeze(collect(models.rows, (row) => row.model, (row) => row.user_id)),
      });
    });
  }
}
