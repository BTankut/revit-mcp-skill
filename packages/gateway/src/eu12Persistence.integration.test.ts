import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";

import { canonicalizeJson, type JsonValue } from "@revagent/protocol";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GatewayEventEnvelope } from "./events.js";
import { migrateUp } from "./migrate.js";
import { PostgresEu12DataStore, RetentionLeaseError, RetentionNotDueError, canonicalDurableReleaseManifest } from "./postgresEu12DataStore.js";
import { PostgresTenantStore } from "./postgresTenantStore.js";
import { InMemoryResultObjectStore, resultReferenceDigest } from "./resultReferenceStore.js";
import { deriveMetricParity } from "./metricParity.js";
import { Eu12EventBackpressureError } from "./eventPersistence.js";
import { bridgeManifestDigest, verifyBridgeManifestSignature } from "./bridgeManifestSignature.js";

const { Pool } = pg;
const DATABASE_URL = process.env.EU10_DATABASE_URL;
const suite = DATABASE_URL === undefined ? describe.skip : describe;

function envelope(input: {
  readonly eventId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly type: GatewayEventEnvelope["event_type"];
  readonly payload: GatewayEventEnvelope["payload"];
  readonly occurredAt?: string;
}): GatewayEventEnvelope {
  const occurredAt = input.occurredAt ?? "2026-09-02T08:00:00.000Z";
  return Object.freeze({
    schema: "revagent.event.v2",
    event_id: input.eventId,
    event_type: input.type,
    occurred_at: occurredAt,
    recorded_at: occurredAt,
    tenant_id: input.tenantId,
    source: { component: "eu12-integration", version: "1", instance: "test" },
    actor: { type: "user" as const, user_id: input.userId },
    session_id: input.sessionId,
    seq: 1,
    payload: input.payload,
  });
}

suite("EU-12 Postgres event persistence", () => {
  let admin: pg.Pool;
  let runtime: pg.Pool;
  let store: PostgresTenantStore;
  let tenantA: string;
  let tenantB: string;
  let userA: string;
  let userB: string;
  let sessionA: string;
  let sessionB: string;
  let appPassword: string;
  let runtimeDatabaseUrl: string;

  beforeAll(async () => {
    appPassword = randomBytes(32).toString("base64url");
    await migrateUp(DATABASE_URL!, { appPassword });
    admin = new Pool({ connectionString: DATABASE_URL });
    tenantA = randomUUID(); tenantB = randomUUID();
    userA = randomUUID(); userB = randomUUID();
    sessionA = randomUUID(); sessionB = randomUUID();
    await admin.query("INSERT INTO tenants(id,slug,name) VALUES ($1,$2,'EU12 Tenant A'),($3,$4,'EU12 Tenant B')", [tenantA, `eu12-a-${tenantA}`, tenantB, `eu12-b-${tenantB}`]);
    await admin.query(
      `INSERT INTO users(id,tenant_id,oidc_issuer,oidc_subject,role)
       VALUES ($1,$2,'https://issuer.test','eu12-a','user'),($3,$4,'https://issuer.test','eu12-b','user')`,
      [userA, tenantA, userB, tenantB],
    );
    await admin.query(
      `INSERT INTO sessions(id,tenant_id,user_id,client_type)
       VALUES ($1,$2,$3,'mcp'),($4,$5,$6,'mcp')`,
      [sessionA, tenantA, userA, sessionB, tenantB, userB],
    );
    const runtimeUrl = new URL(DATABASE_URL!);
    runtimeUrl.username = "revagent_runtime";
    runtimeUrl.password = appPassword;
    runtimeDatabaseUrl = runtimeUrl.href;
    runtime = new Pool({ connectionString: runtimeDatabaseUrl });
    store = new PostgresTenantStore(runtimeDatabaseUrl);
  }, 30_000);

  afterAll(async () => {
    await store?.close();
    await runtime?.end();
    await admin?.end();
  });

  it("routes tool and metering events through one RLS-bound durable envelope with idempotent redelivery", async () => {
    const toolPayload = {
      dispatch_attempt_id: "eu12-dispatch-attempt",
      invocation_id: "eu12-invocation",
      idempotency_key: "eu12-tool-replay",
      tool_name: "core.inspect",
      tool_version: "1.0.0",
      policy_class: "auto",
      executor: "bridge",
      params_digest: `sha256:${"a".repeat(64)}`,
      params_summary: { keys: [] },
      outcome: "completed",
      started_at_ms: 1_000,
      completed_at_ms: 1_001,
      duration_ms: 1,
      request_bytes: 10,
      response_bytes: 11,
    } as const;
    const first = envelope({ eventId: randomUUID(), tenantId: tenantA, sessionId: sessionA, userId: userA, type: "tool.invocation", payload: toolPayload });
    await expect(store.emit(first)).resolves.toEqual({ ok: true, value: undefined });
    const replay = envelope({
      eventId: randomUUID(), tenantId: tenantA, sessionId: sessionA, userId: userA,
      type: "tool.invocation", payload: toolPayload, occurredAt: "2026-09-02T08:00:01.000Z",
    });
    await expect(store.emit(replay)).resolves.toEqual({ ok: true, value: undefined });
    const metering = envelope({
      eventId: randomUUID(), tenantId: tenantA, sessionId: sessionA, userId: userA,
      type: "llm.call",
      payload: {
        idempotency_key: "eu12-metering", upstream_name: "external-client", model_name: "observed-model",
        engine_mode: "external_client", role: "external_client", input_tokens: 1, output_tokens: 2,
        cache_read_tokens: 0, cache_creation_tokens: 0, duration_ms: 3, latency_ms: 3,
        cost_microusd: 100_000, stop_reason: "unknown", outcome: "completed",
      },
    });
    await expect(store.emit(metering)).resolves.toEqual({ ok: true, value: undefined });
    const persisted = await admin.query(
      "SELECT event_type,idempotency_key FROM events WHERE tenant_id=$1 ORDER BY event_type",
      [tenantA],
    );
    expect(persisted.rows).toEqual([
      { event_type: "llm.call", idempotency_key: "eu12-metering" },
      { event_type: "tool.invocation", idempotency_key: "eu12-tool-replay" },
    ]);
    await expect(admin.query("SELECT event_id FROM tool_invocations WHERE tenant_id=$1 AND idempotency_key='eu12-tool-replay'", [tenantA]))
      .resolves.toMatchObject({ rowCount: 1 });
    await expect(admin.query("SELECT event_id FROM llm_calls WHERE tenant_id=$1", [tenantA]))
      .resolves.toMatchObject({ rowCount: 1 });
  });

  it("survives migration replay and restart for result refs, archive runs, and tenant-scoped release channels", async () => {
    await expect(migrateUp(DATABASE_URL!, { appPassword })).resolves.toEqual([]);
    const migration = await admin.query("SELECT version FROM schema_migrations WHERE version='009_eu12_retention_class_due_partitions.sql'");
    expect(migration.rowCount).toBe(1);
    await expect(admin.query<{ relname: string; relkind: string }>(
      "SELECT relname,relkind FROM pg_class WHERE relname = ANY($1::text[]) ORDER BY relname",
      [["events", "llm_calls", "tool_invocations"]],
    )).resolves.toMatchObject({ rows: [
      { relname: "events", relkind: "p" }, { relname: "llm_calls", relkind: "p" }, { relname: "tool_invocations", relkind: "p" },
    ] });
    await expect(admin.query<{ retired_hot_plane: string | null }>("SELECT to_regclass('public.retention_hot_rows')::text AS retired_hot_plane"))
      .resolves.toMatchObject({ rows: [{ retired_hot_plane: null }] });

    let nowMs = Date.now();
    const objects = new InMemoryResultObjectStore();
    const first = new PostgresEu12DataStore({
      databaseUrl: runtimeDatabaseUrl,
      publisherDatabaseUrl: DATABASE_URL!,
      objects,
      now: () => nowMs,
      newRefId: () => randomUUID(),
      signatureVerifier: { verify: ({ signature }) => signature === "fixture-signature" },
      pinnedSigningKeyIds: ["release-key-1"],
    });
    const boundedDurableWriter = first.createBoundedEventWriter(1);
    const boundedPayload = {
      dispatch_attempt_id: "bounded-attempt", invocation_id: "bounded-invocation", idempotency_key: "eu12/bounded-a",
      tool_name: "core.inspect", tool_version: "1.0.0", policy_class: "auto", executor: "bridge",
      params_digest: `sha256:${"e".repeat(64)}`, outcome: "completed", started_at_ms: nowMs, completed_at_ms: nowMs + 1,
      duration_ms: 1, request_bytes: 1, response_bytes: 1,
    } as const;
    await expect(boundedDurableWriter.write([
      envelope({ eventId: randomUUID(), tenantId: tenantA, sessionId: sessionA, userId: userA, type: "tool.invocation", payload: boundedPayload }),
      envelope({ eventId: randomUUID(), tenantId: tenantA, sessionId: sessionA, userId: userA, type: "tool.invocation", payload: { ...boundedPayload, idempotency_key: "eu12/bounded-b" } }),
    ])).rejects.toBeInstanceOf(Eu12EventBackpressureError);
    const ref = await first.putResult({
      scope: { tenantId: tenantA, sessionId: sessionA },
      payload: { items: [1, 2, 3] },
      idempotencyKey: "eu12/restart-ref",
      invocationId: randomUUID(),
      refLabel: "R17",
      expiresAtMs: nowMs + 1_000,
      pageSizeBytes: 8,
    });
    const composedEventId = randomUUID();
    const composedInvocationId = randomUUID();
    const composed = first.createInvocationRecorder(8);
    const composedReceipt = await composed.record({
      eventId: composedEventId,
      tenantId: tenantA,
      sessionId: sessionA,
      actorUserId: userA,
      source: { component: "north-mcp", version: "1", instance: "durable-test" },
      sequence: 88,
      idempotencyKey: "eu12/durable-composition",
      invocationId: composedInvocationId,
      dispatchAttemptId: randomUUID(),
      toolName: "core.inspect",
      toolVersion: "1.0.0",
      policyClass: "auto",
      executor: "bridge",
      outcome: "completed",
      startedAtMs: nowMs,
      completedAtMs: nowMs + 1,
      requestBytes: 3,
      responseBytes: 4,
      params: { responseMode: "compact" },
      result: { durable: true },
      resultExpiresAtMs: nowMs + 5_000,
    });
    expect(composedReceipt.eventWrite).toMatchObject({ route: "tool_invocations", disposition: "inserted" });
    const defaultTtlInvocation = {
      eventId: randomUUID(),
      tenantId: tenantA,
      sessionId: sessionA,
      actorUserId: userA,
      source: { component: "north-mcp", version: "1", instance: "durable-default-ttl" },
      sequence: 89,
      idempotencyKey: "eu12/durable-default-ttl",
      invocationId: randomUUID(),
      dispatchAttemptId: randomUUID(),
      toolName: "core.inspect",
      toolVersion: "1.0.0",
      policyClass: "auto" as const,
      executor: "bridge" as const,
      outcome: "completed" as const,
      startedAtMs: nowMs,
      completedAtMs: nowMs + 1,
      requestBytes: 3,
      responseBytes: 4,
      params: { responseMode: "compact" },
      result: { durableDefaultTtl: true },
    };
    const defaultTtlReceipt = await composed.record(defaultTtlInvocation);
    const activeInvocationId = randomUUID();
    await first.beginActiveInvocation({ tenantId: tenantA, invocationId: activeInvocationId, sessionId: sessionA, actorUserId: userA, toolName: "core.inspect", startedAtMs: nowMs });
    const activeAttribution = await first.readPersistedParityAttribution(tenantA);
    expect(activeAttribution.activeTaskCount).toBe(1);
    await first.completeActiveInvocation({ tenantId: tenantA, invocationId: activeInvocationId, outcome: "completed", completedAtMs: nowMs + 1 });
    const persistedAttribution = await first.readPersistedParityAttribution(tenantA);
    expect(persistedAttribution.activeTaskCount).toBe(0);
    expect(persistedAttribution.toolUserAttribution["core.inspect"]?.[userA]).toBeGreaterThan(0);
    expect(persistedAttribution.modelUserAttribution["observed-model"]?.[userA]).toBeGreaterThan(0);
    const persistedParity = deriveMetricParity({
      tenantId: tenantA,
      events: await first.list({ tenantId: tenantA }),
      devices: [{ tenantId: tenantA, deviceId: "parity-device", machineName: "Parity WS", userId: userA, bridgeVersion: "1.0.0", lastSeenAtMs: nowMs }],
      currentReleaseByChannel: { pilot: "release-parity" },
      activeTaskCount: persistedAttribution.activeTaskCount,
      toolUserAttribution: persistedAttribution.toolUserAttribution,
      modelUserAttribution: persistedAttribution.modelUserAttribution,
    });
    expect(persistedParity.rows.find((row) => row.metric === "taskState/activeTask")?.value).toMatchObject({ activeTaskCount: 0 });
    expect(persistedParity.rows.find((row) => row.metric === "toolUsage/commandUsage")?.value).toMatchObject({ byToolUser: expect.any(Object) });
    expect(persistedParity.rows.find((row) => row.metric === "tokenSpend/latency/costAttribution")?.value).toMatchObject({ byModelUser: expect.any(Object) });
    await first.close();

    const resumed = new PostgresEu12DataStore({
      databaseUrl: runtimeDatabaseUrl,
      publisherDatabaseUrl: DATABASE_URL!,
      objects,
      now: () => nowMs,
      newRefId: () => randomUUID(),
      signatureVerifier: { verify: ({ signature }) => signature === "fixture-signature" },
      pinnedSigningKeyIds: ["release-key-1"],
    });
    await expect(resumed.getResultPage({ scope: { tenantId: tenantA, sessionId: sessionA }, refId: ref.refId, pageIndex: 0 }))
      .resolves.toMatchObject({ kind: "page" });
    await expect(resumed.read({ tenantId: tenantA, eventId: composedEventId })).resolves.toMatchObject({ event_id: composedEventId });
    await expect(resumed.getResultPage({ scope: { tenantId: tenantA, sessionId: sessionA }, refId: composedReceipt.resultRef.refId, pageIndex: 0 }))
      .resolves.toMatchObject({ kind: "page" });
    nowMs += 1_000;
    const resumedLifecycle = resumed.createInvocationRecorder(8);
    const defaultTtlReplay = await resumedLifecycle.record({ ...defaultTtlInvocation, eventId: randomUUID(), sequence: 90 });
    expect(defaultTtlReplay.eventWrite).toMatchObject({ disposition: "duplicate" });
    expect(defaultTtlReplay.resultRef.refId).toBe(defaultTtlReceipt.resultRef.refId);
    expect(defaultTtlReplay.resultRef.expiresAtMs).toBe(defaultTtlReceipt.resultRef.expiresAtMs);
    await expect(resumed.getResultPage({ scope: { tenantId: tenantB, sessionId: sessionA }, refId: ref.refId, pageIndex: 0 }))
      .resolves.toEqual({ kind: "not_found" });
    nowMs += 1_001;
    await expect(resumed.expireResults({ tenantId: tenantA, nowMs })).resolves.toEqual([ref]);
    await expect(resumed.getResultPage({ scope: { tenantId: tenantA, sessionId: sessionA }, refId: ref.refId, pageIndex: 0 }))
      .resolves.toEqual({ kind: "not_found" });

    const archiveStartedAtMs = Date.parse("2025-08-15T00:00:00.000Z");
    const archivePayload = {
      dispatch_attempt_id: "archive-attempt", invocation_id: "archive-invocation", idempotency_key: "eu12/archive-a",
      tool_name: "core.inspect", tool_version: "1.0.0", policy_class: "auto", executor: "bridge",
      params_digest: `sha256:${"c".repeat(64)}`, outcome: "completed", started_at_ms: archiveStartedAtMs, completed_at_ms: archiveStartedAtMs + 1,
      duration_ms: 1, request_bytes: 1, response_bytes: 1,
    } as const;
    const archiveA = envelope({ eventId: randomUUID(), tenantId: tenantA, sessionId: sessionA, userId: userA, type: "tool.invocation", payload: archivePayload, occurredAt: "2025-08-15T00:00:00.000Z" });
    const archiveB = envelope({ eventId: randomUUID(), tenantId: tenantB, sessionId: sessionB, userId: userB, type: "tool.invocation", payload: { ...archivePayload, idempotency_key: "eu12/archive-b" }, occurredAt: "2025-08-15T00:00:00.000Z" });
    await expect(store.emit(archiveA)).resolves.toEqual({ ok: true, value: undefined });
    await expect(store.emit(archiveB)).resolves.toEqual({ ok: true, value: undefined });
    const archiveLlmA = envelope({
      eventId: randomUUID(), tenantId: tenantA, sessionId: sessionA, userId: userA, type: "llm.call",
      payload: { idempotency_key: "eu12/archive-llm-a", upstream_name: "external-client", model_name: "observed-model", engine_mode: "external_client", role: "external_client", input_tokens: 3, output_tokens: 4, cache_read_tokens: 1, cache_creation_tokens: 0, duration_ms: 5, latency_ms: 5, cost_microusd: 6, stop_reason: "unknown", outcome: "completed" },
      occurredAt: "2025-08-16T00:00:00.000Z",
    });
    const archiveLlmB = envelope({
      eventId: randomUUID(), tenantId: tenantB, sessionId: sessionB, userId: userB, type: "llm.call",
      payload: { idempotency_key: "eu12/archive-llm-b", upstream_name: "external-client", model_name: "observed-model", engine_mode: "external_client", role: "external_client", input_tokens: 3, output_tokens: 4, cache_read_tokens: 1, cache_creation_tokens: 0, duration_ms: 5, latency_ms: 5, cost_microusd: 6, stop_reason: "unknown", outcome: "completed" },
      occurredAt: "2025-08-16T00:00:00.000Z",
    });
    await expect(store.emit(archiveLlmA)).resolves.toEqual({ ok: true, value: undefined });
    await expect(store.emit(archiveLlmB)).resolves.toEqual({ ok: true, value: undefined });
    await expect(resumed.archiveEvents({ tenantId: tenantA, month: "2025-08", owner: "eu12-restart", asOfMs: nowMs, afterObjectWrite: () => { throw new Error("synthetic restart boundary"); } }))
      .rejects.toThrow(/synthetic restart boundary/u);
    await resumed.close();

    const afterRestart = new PostgresEu12DataStore({
      databaseUrl: runtimeDatabaseUrl,
      publisherDatabaseUrl: DATABASE_URL!,
      objects,
      now: () => nowMs,
      newRefId: () => randomUUID(),
      signatureVerifier: { verify: ({ signature }) => signature === "fixture-signature" },
      pinnedSigningKeyIds: ["release-key-1"],
    });
    const archived = await afterRestart.archiveEvents({ tenantId: tenantA, month: "2025-08", owner: "eu12-restart", asOfMs: nowMs });
    expect(archived).toMatchObject({ state: "dropped", eventCount: 2, attempts: 2 });
    expect(await afterRestart.readArchivedEvents({ tenantId: tenantA, month: "2025-08" })).toEqual([archiveA, archiveLlmA]);
    const tenantBEvents = await admin.query("SELECT count(*)::int AS count FROM events WHERE tenant_id=$1 AND retention_partition_month='2025-08-01'", [tenantB]);
    expect(tenantBEvents.rows[0]?.count).toBe(2);
    await expect(afterRestart.archiveEvents({ tenantId: tenantA, month: "2025-08", owner: "eu12-restart", asOfMs: nowMs })).resolves.toMatchObject({ state: "dropped", attempts: 2 });
    await expect(afterRestart.archiveSurface({ tenantId: tenantA, month: "2025-08", surface: "tool_invocations", owner: "eu12-restart", asOfMs: nowMs })).resolves.toMatchObject({ state: "dropped", eventCount: 1 });
    await expect(afterRestart.readTypedArchive({ tenantId: tenantA, month: "2025-08", surface: "tool_invocations" })).resolves.toHaveLength(1);
    await expect(afterRestart.archiveSurface({ tenantId: tenantA, month: "2025-08", surface: "llm_calls", owner: "eu12-restart", asOfMs: nowMs })).resolves.toMatchObject({ state: "dropped", eventCount: 1 });
    await expect(afterRestart.readTypedArchive({ tenantId: tenantA, month: "2025-08", surface: "llm_calls" })).resolves.toHaveLength(1);
    await expect(afterRestart.archiveEvents({ tenantId: tenantB, month: "2025-08", owner: "tenant-b-lease", asOfMs: nowMs, afterObjectWrite: () => { throw new Error("tenant B lease retained"); } }))
      .rejects.toThrow(/tenant B lease retained/u);
    await expect(afterRestart.archiveEvents({ tenantId: tenantB, month: "2025-08", owner: "competing-owner", asOfMs: nowMs }))
      .rejects.toBeInstanceOf(RetentionLeaseError);
    await expect(afterRestart.archiveEvents({ tenantId: tenantB, month: "2025-08", owner: "tenant-b-lease", asOfMs: nowMs }))
      .resolves.toMatchObject({ state: "dropped", eventCount: 2 });
    await expect(afterRestart.archiveSurface({ tenantId: tenantB, month: "2025-08", surface: "tool_invocations", owner: "tenant-b-lease", asOfMs: nowMs }))
      .resolves.toMatchObject({ state: "dropped", eventCount: 1 });
    await expect(afterRestart.archiveSurface({ tenantId: tenantB, month: "2025-08", surface: "llm_calls", owner: "tenant-b-lease", asOfMs: nowMs }))
      .resolves.toMatchObject({ state: "dropped", eventCount: 1 });
    const physicalPartitions = await admin.query<{ archive_kind: string; state: string; partition_table: string; table_exists: string | null }>(
      `SELECT archive_kind,state,partition_table,to_regclass(partition_table)::text AS table_exists
        FROM retention_partition_ownership WHERE tenant_id=$1 AND archive_month='2025-08-01' ORDER BY archive_kind,retention_class`,
      [tenantB],
    );
    expect(physicalPartitions.rows).toEqual([
      { archive_kind: "events", state: "dropped", partition_table: expect.any(String), table_exists: null },
      { archive_kind: "llm_calls", state: "dropped", partition_table: expect.any(String), table_exists: null },
      { archive_kind: "tool_invocations", state: "dropped", partition_table: expect.any(String), table_exists: null },
    ]);

    const artifact = Buffer.from("durable bridge archive", "utf8");
    const artifactKey = "releases/bridge/2.0.0/bridge-2.0.0.zip";
    await objects.put({ key: artifactKey, bytes: artifact });
    const releaseId = randomUUID();
    const release = {
      id: releaseId, version: "2.0.0", channel: "pilot" as const, artifactStorageKey: artifactKey,
      artifactSha256: resultReferenceDigest(artifact), signature: "fixture-signature", signingKeyId: "release-key-1",
      minSupportedVersion: "1.0.0", releasedAtMs: nowMs, releasedBy: "vendor-admin",
    };
    await afterRestart.publishRelease({
      release,
      releaseSequence: 2,
      tenantIds: [tenantA],
    });
    const newerArtifact = Buffer.from("durable bridge archive newer", "utf8");
    const newerArtifactKey = "releases/bridge/2.0.1/bridge-2.0.1.zip";
    await objects.put({ key: newerArtifactKey, bytes: newerArtifact });
    const newerReleaseId = randomUUID();
    await afterRestart.publishRelease({
      release: {
        id: newerReleaseId, version: "2.0.1", channel: "pilot", artifactStorageKey: newerArtifactKey,
        artifactSha256: resultReferenceDigest(newerArtifact), signature: "fixture-signature", signingKeyId: "release-key-1",
        minSupportedVersion: "1.0.0", releasedAtMs: nowMs + 1, releasedBy: "vendor-admin",
      },
      releaseSequence: 3,
      tenantIds: [tenantA],
    });
    await expect(afterRestart.publishRelease({ release, releaseSequence: 2, tenantIds: [tenantA] }))
      .rejects.toThrow(/rollback (is forbidden|floor)/u);
    await afterRestart.close();

    const releaseRestart = new PostgresEu12DataStore({
      databaseUrl: runtimeDatabaseUrl,
      publisherDatabaseUrl: DATABASE_URL!,
      objects,
      now: () => nowMs,
      newRefId: () => randomUUID(),
      signatureVerifier: { verify: ({ signature }) => signature === "fixture-signature" },
      pinnedSigningKeyIds: ["release-key-1"],
    });
    await expect(releaseRestart.readReleaseForTenant({ tenantId: tenantA, channel: "pilot" })).resolves.toMatchObject({ id: newerReleaseId });
    await expect(releaseRestart.readReleaseForTenant({ tenantId: tenantB, channel: "pilot" })).resolves.toBeNull();
    await releaseRestart.close();
  }, 60_000);

  it("uses actual canonical partitions across every crash boundary and drops the canonical rows", async () => {
    const objects = new InMemoryResultObjectStore();
    const nowMs = Date.parse("2028-09-01T00:00:00.000Z");
    const durable = new PostgresEu12DataStore({
      databaseUrl: runtimeDatabaseUrl,
      publisherDatabaseUrl: DATABASE_URL!,
      objects,
      now: () => nowMs,
      newRefId: () => randomUUID(),
      signatureVerifier: { verify: ({ signature }) => signature === "fixture-signature" },
      pinnedSigningKeyIds: ["release-key-1"],
    });
    const crashTenant = randomUUID();
    const crashUser = randomUUID();
    const crashSession = randomUUID();
    await admin.query("INSERT INTO tenants(id,slug,name) VALUES($1,$2,'EU12 crash tenant')", [crashTenant, `eu12-crash-${crashTenant}`]);
    await admin.query("INSERT INTO users(id,tenant_id,oidc_issuer,oidc_subject,role) VALUES($1,$2,'https://issuer.test','crash-user','user')", [crashUser, crashTenant]);
    await admin.query("INSERT INTO sessions(id,tenant_id,user_id,client_type) VALUES($1,$2,$3,'mcp')", [crashSession, crashTenant, crashUser]);
    const stages = ["prepared", "object_written", "object_verified", "uploaded"] as const;
    try {
      for (const [index, stage] of stages.entries()) {
        const month = `2026-0${index + 1}`;
        const occurredAt = `${month}-15T00:00:00.000Z`;
        const occurredAtMs = Date.parse(occurredAt);
        const toolEvent = envelope({
          eventId: randomUUID(), tenantId: crashTenant, sessionId: crashSession, userId: crashUser, type: "tool.invocation", occurredAt,
          payload: {
            dispatch_attempt_id: `crash-attempt-${stage}`, invocation_id: randomUUID(), idempotency_key: `eu12/crash-tool-${stage}`,
            tool_name: "core.inspect", tool_version: "1.0.0", policy_class: "auto", executor: "bridge",
            params_digest: `sha256:${"f".repeat(64)}`, outcome: "completed", started_at_ms: occurredAtMs, completed_at_ms: occurredAtMs + 1,
            duration_ms: 1, request_bytes: 1, response_bytes: 1,
          },
        });
        const llmEvent = envelope({
          eventId: randomUUID(), tenantId: crashTenant, sessionId: crashSession, userId: crashUser, type: "llm.call", occurredAt,
          payload: {
            idempotency_key: `eu12/crash-llm-${stage}`, upstream_name: "external-client", model_name: "crash-model",
            engine_mode: "external_client", role: "external_client", input_tokens: 2, output_tokens: 3,
            cache_read_tokens: 0, cache_creation_tokens: 0, duration_ms: 4, latency_ms: 4,
            cost_microusd: 5, stop_reason: "unknown", outcome: "completed",
          },
        });
        await expect(store.emit(toolEvent)).resolves.toEqual({ ok: true, value: undefined });
        await expect(store.emit(llmEvent)).resolves.toEqual({ ok: true, value: undefined });
        await expect(admin.query<{ archive_kind: string; count: number }>(
          `SELECT archive_kind,count(*)::int AS count FROM (
             SELECT 'events'::text AS archive_kind FROM events WHERE tenant_id=$1 AND retention_partition_month=$2::date
             UNION ALL SELECT 'tool_invocations'::text FROM tool_invocations WHERE tenant_id=$1 AND retention_partition_month=$2::date
             UNION ALL SELECT 'llm_calls'::text FROM llm_calls WHERE tenant_id=$1 AND retention_partition_month=$2::date
           ) AS canonical_rows GROUP BY archive_kind ORDER BY archive_kind`, [crashTenant, `${month}-01`],
        )).resolves.toMatchObject({ rows: [
          { archive_kind: "events", count: 2 }, { archive_kind: "llm_calls", count: 1 }, { archive_kind: "tool_invocations", count: 1 },
        ] });
        await expect(durable.archiveSurface({
          tenantId: crashTenant, month, surface: "tool_invocations", owner: `crash-owner-${stage}`, asOfMs: nowMs,
          onBoundary: ({ stage: reached }) => { if (reached === stage) throw new Error(`synthetic crash boundary ${stage}`); },
        })).rejects.toThrow(`synthetic crash boundary ${stage}`);
        await expect(admin.query<{ state: string; table_exists: string | null; attached: boolean }>(
          `SELECT state,to_regclass('public.' || partition_table)::text AS table_exists,
                  EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=to_regclass('public.' || partition_table) AND inhparent='tool_invocations'::regclass) AS attached
           FROM retention_partition_ownership WHERE tenant_id=$1 AND archive_kind='tool_invocations' AND archive_month=$2::date`,
          [crashTenant, `${month}-01`],
        )).resolves.toMatchObject({ rows: [{ state: "prepared", table_exists: expect.any(String), attached: true }] });
        await expect(durable.archiveSurface({ tenantId: crashTenant, month, surface: "tool_invocations", owner: `crash-owner-${stage}`, asOfMs: nowMs }))
          .resolves.toMatchObject({ state: "dropped", eventCount: 1, attempts: 2 });
        await expect(admin.query("SELECT count(*)::int AS count FROM tool_invocations WHERE tenant_id=$1 AND retention_partition_month=$2::date", [crashTenant, `${month}-01`]))
          .resolves.toMatchObject({ rows: [{ count: 0 }] });
        await expect(durable.archiveEvents({ tenantId: crashTenant, month, owner: `events-owner-${stage}`, asOfMs: nowMs }))
          .resolves.toMatchObject({ state: "dropped", eventCount: 2 });
        await expect(durable.read({ tenantId: crashTenant, eventId: toolEvent.event_id })).resolves.toBeNull();
        await expect(admin.query("SELECT count(*)::int AS count FROM events WHERE tenant_id=$1 AND retention_partition_month=$2::date", [crashTenant, `${month}-01`]))
          .resolves.toMatchObject({ rows: [{ count: 0 }] });
        await expect(admin.query<{ archive_kind: string; state: string; table_exists: string | null }>(
          `SELECT archive_kind,state,to_regclass('public.' || partition_table)::text AS table_exists
           FROM retention_partition_ownership WHERE tenant_id=$1 AND archive_month=$2::date ORDER BY archive_kind`, [crashTenant, `${month}-01`],
        )).resolves.toMatchObject({ rows: [
          { archive_kind: "events", state: "dropped", table_exists: null },
          { archive_kind: "llm_calls", state: "dropped", table_exists: null },
          { archive_kind: "tool_invocations", state: "dropped", table_exists: null },
        ] });
      }
    } finally {
      await durable.close();
    }
  }, 60_000);

  it("separates same-month standard and lifecycle leaves and fails closed on retention due boundaries", async () => {
    const objects = new InMemoryResultObjectStore();
    const trustedNowMs = Date.parse("2028-08-20T00:00:00.000Z");
    const durable = new PostgresEu12DataStore({
      databaseUrl: runtimeDatabaseUrl,
      publisherDatabaseUrl: DATABASE_URL!,
      objects,
      now: () => trustedNowMs,
      newRefId: () => randomUUID(),
      signatureVerifier: { verify: ({ signature }) => signature === "fixture-signature" },
      pinnedSigningKeyIds: ["release-key-1"],
    });
    const classTenantA = randomUUID();
    const classUserA = randomUUID();
    const classSessionA = randomUUID();
    const classTenantB = randomUUID();
    const classUserB = randomUUID();
    const classSessionB = randomUUID();
    await admin.query("INSERT INTO tenants(id,slug,name) VALUES($1,$2,'EU12 class tenant A'),($3,$4,'EU12 class tenant B')", [classTenantA, `eu12-class-a-${classTenantA}`, classTenantB, `eu12-class-b-${classTenantB}`]);
    await admin.query("INSERT INTO users(id,tenant_id,oidc_issuer,oidc_subject,role) VALUES($1,$2,'https://issuer.test','class-a','user'),($3,$4,'https://issuer.test','class-b','user')", [classUserA, classTenantA, classUserB, classTenantB]);
    await admin.query("INSERT INTO sessions(id,tenant_id,user_id,client_type) VALUES($1,$2,$3,'mcp'),($4,$5,$6,'mcp')", [classSessionA, classTenantA, classUserA, classSessionB, classTenantB, classUserB]);
    const standardOccurredAt = "2025-06-15T00:00:00.000Z";
    const standardStartedAtMs = Date.parse(standardOccurredAt);
    const standardA = envelope({
      eventId: randomUUID(), tenantId: classTenantA, sessionId: classSessionA, userId: classUserA, type: "tool.invocation", occurredAt: standardOccurredAt,
      payload: {
        dispatch_attempt_id: "class-standard-a", invocation_id: randomUUID(), idempotency_key: "eu12/class-standard-a",
        tool_name: "core.inspect", tool_version: "1.0.0", policy_class: "auto", executor: "bridge",
        params_digest: `sha256:${"1".repeat(64)}`, outcome: "completed", started_at_ms: standardStartedAtMs, completed_at_ms: standardStartedAtMs + 1,
        duration_ms: 1, request_bytes: 1, response_bytes: 1,
      },
    });
    const lifecycleA = envelope({
      eventId: randomUUID(), tenantId: classTenantA, sessionId: classSessionA, userId: classUserA, type: "bridge.connected", occurredAt: standardOccurredAt,
      payload: { device_id: "class-device-a", bridge_version: "1.0.0", addin_version: "1.0.0", revit_version: "2025", protocol_version: "1" },
    });
    const standardB = envelope({
      eventId: randomUUID(), tenantId: classTenantB, sessionId: classSessionB, userId: classUserB, type: "tool.invocation", occurredAt: standardOccurredAt,
      payload: { ...standardA.payload, dispatch_attempt_id: "class-standard-b", invocation_id: randomUUID(), idempotency_key: "eu12/class-standard-b" },
    });
    await expect(store.emit(standardA)).resolves.toEqual({ ok: true, value: undefined });
    await expect(store.emit(lifecycleA)).resolves.toEqual({ ok: true, value: undefined });
    await expect(store.emit(standardB)).resolves.toEqual({ ok: true, value: undefined });
    await expect(admin.query<{ retention_class: string; count: number }>(
      "SELECT retention_class,count(*)::int AS count FROM events WHERE tenant_id=$1 AND retention_partition_month='2025-06-01' GROUP BY retention_class ORDER BY retention_class", [classTenantA],
    )).resolves.toMatchObject({ rows: [{ retention_class: "lifecycle_24m", count: 1 }, { retention_class: "standard_12m", count: 1 }] });
    await expect(admin.query<{ retention_class: string; partition_key: string; state: string }>(
      "SELECT retention_class,partition_key,state FROM retention_partition_ownership WHERE tenant_id=$1 AND archive_kind='events' AND archive_month='2025-06-01' ORDER BY retention_class", [classTenantA],
    )).resolves.toMatchObject({ rows: [
      { retention_class: "lifecycle_24m", partition_key: `${classTenantA}:events:lifecycle_24m:202506`, state: "active" },
      { retention_class: "standard_12m", partition_key: `${classTenantA}:events:standard_12m:202506`, state: "active" },
    ] });
    const classLeafDue = await admin.query<{ retention_class: string; retention_until: Date }>(
      "SELECT retention_class,retention_until FROM retention_partition_ownership WHERE tenant_id=$1 AND archive_kind='events' AND archive_month='2025-06-01' ORDER BY retention_class", [classTenantA],
    );
    expect(classLeafDue.rows.map((row) => [row.retention_class, row.retention_until.toISOString()])).toEqual([
      ["lifecycle_24m", "2027-06-15T00:00:00.000Z"], ["standard_12m", "2026-06-15T00:00:00.000Z"],
    ]);
    await expect(durable.archiveEvents({ tenantId: classTenantA, month: "2025-06", owner: "class-owner", retentionClass: "standard_12m", asOfMs: Date.parse("2026-06-01T00:00:00.000Z") }))
      .rejects.toBeInstanceOf(RetentionNotDueError);
    const standardDueMs = Date.parse("2026-06-16T00:00:00.000Z");
    await expect(durable.archiveEvents({
      tenantId: classTenantA, month: "2025-06", owner: "class-owner", retentionClass: "standard_12m", asOfMs: standardDueMs,
      afterObjectWrite: () => { throw new Error("class-standard crash"); },
    })).rejects.toThrow(/class-standard crash/u);
    await expect(durable.archiveEvents({ tenantId: classTenantA, month: "2025-06", owner: "class-owner", retentionClass: "standard_12m", asOfMs: standardDueMs }))
      .resolves.toMatchObject({ state: "dropped", retentionClass: "standard_12m", eventCount: 1, attempts: 2 });
    await expect(durable.readArchivedEvents({ tenantId: classTenantA, month: "2025-06", retentionClass: "standard_12m" })).resolves.toEqual([standardA]);
    await expect(durable.read({ tenantId: classTenantA, eventId: standardA.event_id })).resolves.toBeNull();
    await expect(durable.read({ tenantId: classTenantA, eventId: lifecycleA.event_id })).resolves.toMatchObject({ event_id: lifecycleA.event_id });
    await expect(admin.query<{ retention_class: string; state: string }>(
      "SELECT retention_class,state FROM retention_partition_ownership WHERE tenant_id=$1 AND archive_kind='events' AND archive_month='2025-06-01' ORDER BY retention_class", [classTenantA],
    )).resolves.toMatchObject({ rows: [
      { retention_class: "lifecycle_24m", state: "active" }, { retention_class: "standard_12m", state: "dropped" },
    ] });
    await expect(durable.read({ tenantId: classTenantB, eventId: standardB.event_id })).resolves.toMatchObject({ event_id: standardB.event_id });
    await expect(store.emit(standardA)).resolves.toEqual({ ok: true, value: undefined });
    await expect(durable.read({ tenantId: classTenantA, eventId: standardA.event_id })).resolves.toBeNull();
    await expect(durable.archiveEvents({ tenantId: classTenantA, month: "2025-06", owner: "class-owner", retentionClass: "lifecycle_24m", asOfMs: Date.parse("2027-06-01T00:00:00.000Z") }))
      .rejects.toBeInstanceOf(RetentionNotDueError);
    const lifecycleDueMs = Date.parse("2027-06-16T00:00:00.000Z");
    await expect(durable.archiveEvents({ tenantId: classTenantA, month: "2025-06", owner: "class-owner", retentionClass: "lifecycle_24m", asOfMs: lifecycleDueMs }))
      .resolves.toMatchObject({ state: "dropped", retentionClass: "lifecycle_24m", eventCount: 1 });
    await expect(durable.readArchivedEvents({ tenantId: classTenantA, month: "2025-06", retentionClass: "lifecycle_24m" })).resolves.toEqual([lifecycleA]);
    await expect(durable.read({ tenantId: classTenantA, eventId: lifecycleA.event_id })).resolves.toBeNull();
    const currentA = envelope({ eventId: randomUUID(), tenantId: classTenantA, sessionId: classSessionA, userId: classUserA, type: "session.started", occurredAt: "2028-08-10T00:00:00.000Z", payload: { client_type: "mcp", entitled_modules: ["core"] } });
    const futureA = envelope({ eventId: randomUUID(), tenantId: classTenantA, sessionId: classSessionA, userId: classUserA, type: "session.started", occurredAt: "2028-09-01T00:00:00.000Z", payload: { client_type: "mcp", entitled_modules: ["core"] } });
    await expect(store.emit(currentA)).resolves.toEqual({ ok: true, value: undefined });
    await expect(store.emit(futureA)).resolves.toEqual({ ok: true, value: undefined });
    await expect(durable.archiveEvents({ tenantId: classTenantA, month: "2028-08", owner: "class-owner", retentionClass: "standard_12m", asOfMs: trustedNowMs }))
      .rejects.toBeInstanceOf(RetentionNotDueError);
    await expect(durable.archiveEvents({ tenantId: classTenantA, month: "2028-09", owner: "class-owner", retentionClass: "standard_12m", asOfMs: trustedNowMs }))
      .rejects.toBeInstanceOf(RetentionNotDueError);
    await durable.close();
  }, 60_000);

  it("projects real composed invocation activity through terminal finally and stale-restart recovery", async () => {
    const objects = new InMemoryResultObjectStore();
    const nowMs = Date.now();
    const durable = new PostgresEu12DataStore({
      databaseUrl: runtimeDatabaseUrl,
      publisherDatabaseUrl: DATABASE_URL!,
      objects,
      now: () => nowMs,
      newRefId: () => randomUUID(),
      signatureVerifier: { verify: ({ signature }) => signature === "fixture-signature" },
      pinnedSigningKeyIds: ["release-key-1"],
    });
    const productTenant = randomUUID();
    const productUser = randomUUID();
    const productSession = randomUUID();
    await admin.query("INSERT INTO tenants(id,slug,name) VALUES($1,$2,'EU12 product lifecycle tenant')", [productTenant, `eu12-product-${productTenant}`]);
    await admin.query("INSERT INTO users(id,tenant_id,oidc_issuer,oidc_subject,role) VALUES($1,$2,'https://issuer.test','product-user','user')", [productUser, productTenant]);
    await admin.query("INSERT INTO sessions(id,tenant_id,user_id,client_type) VALUES($1,$2,$3,'mcp')", [productSession, productTenant, productUser]);
    const recorder = durable.createInvocationRecorder(1);
    const invocationId = randomUUID();
    const productInput = {
      eventId: randomUUID(), tenantId: productTenant, sessionId: productSession, actorUserId: productUser,
      source: { component: "eu12-product-lifecycle", version: "1", instance: "integration" }, sequence: 1,
      idempotencyKey: "eu12/product-lifecycle", invocationId, dispatchAttemptId: randomUUID(),
      toolName: "core.inspect", toolVersion: "1.0.0", policyClass: "auto" as const, executor: "bridge" as const,
      outcome: "completed" as const, startedAtMs: nowMs, completedAtMs: nowMs + 1, requestBytes: 1, responseBytes: 1,
      params: { responseMode: "compact" }, result: { productLifecycle: true }, resultExpiresAtMs: nowMs + 10_000,
    };
    const lock = await admin.connect();
    try {
      await lock.query("BEGIN");
      await lock.query("LOCK TABLE events IN ACCESS EXCLUSIVE MODE");
      const pending = recorder.record(productInput);
      let active = 0;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        active = (await durable.readPersistedParityAttribution(productTenant)).activeTaskCount;
        if (active === 1) break;
        await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
      }
      expect(active).toBe(1);
      await lock.query("COMMIT");
      await pending;
      await expect(durable.readPersistedParityAttribution(productTenant)).resolves.toMatchObject({ activeTaskCount: 0 });
      await expect(recorder.record({
        ...productInput,
        eventId: randomUUID(), invocationId: randomUUID(), idempotencyKey: "eu12/product-lifecycle-failure",
        resultExpiresAtMs: nowMs - 1,
      })).rejects.toThrow(/expiry must be after creation/u);
      await expect(admin.query<{ terminal_outcome: string }>(
        "SELECT terminal_outcome FROM active_invocations WHERE tenant_id=$1 AND terminal_outcome='failed'", [productTenant],
      )).resolves.toMatchObject({ rowCount: 1, rows: [{ terminal_outcome: "failed" }] });
      const staleInvocationId = randomUUID();
      await durable.beginActiveInvocation({
        tenantId: productTenant, invocationId: staleInvocationId, sessionId: productSession, actorUserId: productUser,
        toolName: "core.inspect", startedAtMs: nowMs - 60_000,
      });
      await durable.close();
      const resumed = new PostgresEu12DataStore({
        databaseUrl: runtimeDatabaseUrl,
        publisherDatabaseUrl: DATABASE_URL!,
        objects,
        now: () => nowMs,
        newRefId: () => randomUUID(),
        signatureVerifier: { verify: ({ signature }) => signature === "fixture-signature" },
        pinnedSigningKeyIds: ["release-key-1"],
      });
      try {
        await expect(resumed.recoverStaleActiveInvocations({ tenantId: productTenant, nowMs, staleAfterMs: 1_000 })).resolves.toBe(1);
        await expect(resumed.readPersistedParityAttribution(productTenant)).resolves.toMatchObject({ activeTaskCount: 0 });
        await expect(admin.query<{ terminal_outcome: string }>(
          "SELECT terminal_outcome FROM active_invocations WHERE tenant_id=$1 AND invocation_id=$2", [productTenant, staleInvocationId],
        )).resolves.toMatchObject({ rows: [{ terminal_outcome: "timeout" }] });
      } finally {
        await resumed.close();
      }
    } finally {
      try { await lock.query("ROLLBACK"); } catch { /* committed or rolled back */ }
      lock.release();
      await durable.close().catch(() => undefined);
    }
  }, 60_000);

  it("binds signed release sequence and rollback authority into the canonical durable manifest", async () => {
    const objects = new InMemoryResultObjectStore();
    const verifier = {
      verify: ({ canonicalManifest, signature }: { readonly canonicalManifest: string; readonly signature: string }) =>
        signature === resultReferenceDigest(Buffer.from(canonicalManifest, "utf8")),
    };
    const durable = new PostgresEu12DataStore({
      databaseUrl: runtimeDatabaseUrl,
      publisherDatabaseUrl: DATABASE_URL!,
      objects,
      signatureVerifier: verifier,
      pinnedSigningKeyIds: ["release-key-1"],
    });
    const artifact = Buffer.from("signed authority artifact", "utf8");
    const artifactKey = "releases/bridge/3.0.0/bridge-3.0.0.zip";
    await objects.put({ key: artifactKey, bytes: artifact });
    const unsigned = {
      id: randomUUID(), version: "3.0.0", channel: "stable" as const, artifactStorageKey: artifactKey,
      artifactSha256: resultReferenceDigest(artifact), signature: "", signingKeyId: "release-key-1",
      minSupportedVersion: "1.0.0", releasedAtMs: Date.parse("2026-09-02T00:00:00.000Z"), releasedBy: "vendor-admin",
    };
    const release = {
      ...unsigned,
      signature: resultReferenceDigest(Buffer.from(canonicalDurableReleaseManifest({ release: unsigned, releaseSequence: 5, releaseRollbackFloorSequence: 5, channelRollbackFloorSequence: 5, channelRevision: 1, tenantIds: [tenantA] }), "utf8")),
    };
    await expect(durable.publishRelease({ release, releaseSequence: 5, rollbackFloorSequence: 5, tenantIds: [tenantA] })).resolves.toEqual({
      releaseSequence: 5,
      releaseRollbackFloorSequence: 5,
      channelRevision: 1,
      channelRollbackFloorSequence: 5,
      tenantIds: [tenantA],
    });
    await expect(admin.query<{ release_sequence: string; rollback_floor_sequence: string }>(
      "SELECT release_sequence,rollback_floor_sequence FROM bridge_releases WHERE id=$1", [release.id],
    )).resolves.toMatchObject({ rows: [{ release_sequence: "5", rollback_floor_sequence: "5" }] });
    await expect(admin.query<{ channel_revision: number; rollback_floor_sequence: string }>(
      "SELECT channel_revision,rollback_floor_sequence FROM release_channels WHERE channel='stable'",
    )).resolves.toMatchObject({ rows: [{ channel_revision: 1, rollback_floor_sequence: "5" }] });
    const defaultFloorTamperUnsigned = { ...unsigned, id: randomUUID(), version: "3.0.0-default-floor-tamper" };
    const defaultFloorTamper = {
      ...defaultFloorTamperUnsigned,
      signature: resultReferenceDigest(Buffer.from(canonicalDurableReleaseManifest({
        release: defaultFloorTamperUnsigned, releaseSequence: 6, releaseRollbackFloorSequence: 0,
        channelRollbackFloorSequence: 6, channelRevision: 2, tenantIds: [tenantA],
      }), "utf8")),
    };
    await expect(durable.publishRelease({ release: defaultFloorTamper, releaseSequence: 6, tenantIds: [tenantA] }))
      .rejects.toThrow(/signature is invalid/u);
    await expect(durable.publishRelease({ release, releaseSequence: 6, rollbackFloorSequence: 5, tenantIds: [tenantA] }))
      .rejects.toThrow(/signature is invalid/u);

    const newerArtifact = Buffer.from("signed authority artifact newer", "utf8");
    const newerKey = "releases/bridge/3.0.1/bridge-3.0.1.zip";
    await objects.put({ key: newerKey, bytes: newerArtifact });
    const newerUnsigned = {
      id: randomUUID(), version: "3.0.1", channel: "stable" as const, artifactStorageKey: newerKey,
      artifactSha256: resultReferenceDigest(newerArtifact), signature: "", signingKeyId: "release-key-1",
      minSupportedVersion: "1.0.0", releasedAtMs: Date.parse("2026-09-02T00:00:01.000Z"), releasedBy: "vendor-admin",
    };
    const newer = {
      ...newerUnsigned,
      signature: resultReferenceDigest(Buffer.from(canonicalDurableReleaseManifest({ release: newerUnsigned, releaseSequence: 6, releaseRollbackFloorSequence: 6, channelRollbackFloorSequence: 6, channelRevision: 2, tenantIds: [tenantA] }), "utf8")),
    };
    await expect(durable.publishRelease({ release: newer, releaseSequence: 6, rollbackFloorSequence: 6, tenantIds: [tenantA] })).resolves.toEqual({
      releaseSequence: 6,
      releaseRollbackFloorSequence: 6,
      channelRevision: 2,
      channelRollbackFloorSequence: 6,
      tenantIds: [tenantA],
    });
    await expect(admin.query<{ rollout_revision: number }>(
      "SELECT rollout_revision FROM release_channel_targets WHERE channel='stable' AND tenant_id=$1", [tenantA],
    )).resolves.toMatchObject({ rows: [{ rollout_revision: 2 }] });
    await expect(admin.query<{ release_sequence: string; release_floor: string; channel_revision: number; channel_floor: string }>(
      `SELECT release.release_sequence,release.rollback_floor_sequence AS release_floor,
              channel.channel_revision,channel.rollback_floor_sequence AS channel_floor
       FROM bridge_releases AS release JOIN release_channels AS channel ON channel.current_release_id=release.id
       WHERE release.id=$1`, [newer.id],
    )).resolves.toMatchObject({ rows: [{ release_sequence: "6", release_floor: "6", channel_revision: 2, channel_floor: "6" }] });
    const concurrentArtifact = Buffer.from("signed authority artifact concurrent", "utf8");
    const concurrentKey = "releases/bridge/3.0.2/bridge-3.0.2.zip";
    await objects.put({ key: concurrentKey, bytes: concurrentArtifact });
    const concurrentUnsigned = {
      id: randomUUID(), version: "3.0.2", channel: "stable" as const, artifactStorageKey: concurrentKey,
      artifactSha256: resultReferenceDigest(concurrentArtifact), signature: "", signingKeyId: "release-key-1",
      minSupportedVersion: "1.0.0", releasedAtMs: Date.parse("2026-09-02T00:00:02.000Z"), releasedBy: "vendor-admin",
    };
    const concurrent = {
      ...concurrentUnsigned,
      signature: resultReferenceDigest(Buffer.from(canonicalDurableReleaseManifest({ release: concurrentUnsigned, releaseSequence: 7, releaseRollbackFloorSequence: 7, channelRollbackFloorSequence: 7, channelRevision: 3, tenantIds: [tenantA] }), "utf8")),
    };
    const concurrentResults = await Promise.allSettled([
      durable.publishRelease({ release: concurrent, releaseSequence: 7, rollbackFloorSequence: 7, tenantIds: [tenantA] }),
      durable.publishRelease({ release: concurrent, releaseSequence: 7, rollbackFloorSequence: 7, tenantIds: [tenantA] }),
    ]);
    expect(concurrentResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(concurrentResults.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rollback = {
      ...unsigned,
      signature: resultReferenceDigest(Buffer.from(canonicalDurableReleaseManifest({ release: unsigned, releaseSequence: 5, releaseRollbackFloorSequence: 5, channelRollbackFloorSequence: 7, channelRevision: 4, tenantIds: [tenantA] }), "utf8")),
    };
    await expect(durable.publishRelease({ release: rollback, releaseSequence: 5, rollbackFloorSequence: 5, tenantIds: [tenantA] }))
      .rejects.toThrow(/rollback (is forbidden|floor)|below rollback floor/u);
    await durable.close();
  }, 60_000);

  it("persists exact two-component signed delivery and device-ring authority across restart", async () => {
    const deviceId = randomUUID();
    await admin.query("INSERT INTO devices(id,tenant_id,machine_name,status) VALUES($1,$2,$3,'active')", [deviceId, tenantA, `p3t12-${deviceId}`]);
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = pair.publicKey.export({ format: "jwk" });
    const publicXml = `<RSAKeyValue><Modulus>${Buffer.from(jwk.n!, "base64url").toString("base64")}</Modulus><Exponent>${Buffer.from(jwk.e!, "base64url").toString("base64")}</Exponent></RSAKeyValue>`;
    const fingerprint = createHash("sha256").update(publicXml).digest("hex");
    const releaseId = randomUUID();
    const manifest = {
      schemaVersion: 1, channel: "stable", version: "9.9.12", releaseSequence: 420,
      components: [
        { name: "bridge", version: "9.9.12", sha256: "a".repeat(64), sizeBytes: 101, url: `https://gateway.test/bridge/update/artifact/${releaseId}/bridge` },
        { name: "addin", version: "9.9.12", sha256: "b".repeat(64), sizeBytes: 202, url: `https://gateway.test/bridge/update/artifact/${releaseId}/addin` },
      ], rolloutPercent: 25, minSupportedVersion: "2.0.0", notes: "Postgres restart fixture",
    } as JsonValue;
    const signatureEnvelope: Record<string, JsonValue> = {
      schemaVersion: 1, app: "revAgent", signedObject: "bridge-manifest", algorithm: "RS256",
      keyId: "generated-p3t12", publicKeyFingerprint: fingerprint,
      canonicalization: "RFC8785-JCS-SHA256-v1", contentSha256: bridgeManifestDigest(manifest),
      createdAtUtc: "2026-09-08T00:00:00.0000000Z", signature: "",
    };
    const projection = { ...signatureEnvelope };
    delete projection.signature;
    signatureEnvelope.signature = sign("RSA-SHA256", Buffer.from(canonicalizeJson(projection)), pair.privateKey).toString("base64");
    const trustedKeys = { "generated-p3t12": { publicKeyXml: publicXml, publicKeyFingerprint: fingerprint, algorithm: "RS256" as const } };
    const bridgeManifestVerifier = (input: { readonly manifest: JsonValue; readonly signatureEnvelope: JsonValue }) =>
      verifyBridgeManifestSignature({ manifest: input.manifest, envelope: input.signatureEnvelope, trustedKeys });
    const objects = new InMemoryResultObjectStore();
    const release = Object.freeze({
      id: releaseId, channel: "stable" as const, version: "9.9.12", releaseSequence: 420, rollbackFloorSequence: 420,
      manifest, signatureEnvelope, manifestDigest: bridgeManifestDigest(manifest), signingKeyId: "generated-p3t12",
      components: Object.freeze({
        bridge: Object.freeze({ name: "bridge" as const, version: "9.9.12", storageKey: `${releaseId}/bridge-${"a".repeat(64)}.zip`, sha256: "a".repeat(64), sizeBytes: 101, url: `https://gateway.test/bridge/update/artifact/${releaseId}/bridge` }),
        addin: Object.freeze({ name: "addin" as const, version: "9.9.12", storageKey: `${releaseId}/addin-${"b".repeat(64)}.zip`, sha256: "b".repeat(64), sizeBytes: 202, url: `https://gateway.test/bridge/update/artifact/${releaseId}/addin` }),
      }), rolloutPercent: 25, minSupportedVersion: "2.0.0", releasedAtMs: Date.parse("2026-09-08T00:00:00Z"), releasedBy: "github-actions",
    });
    const publisher = new PostgresEu12DataStore({
      databaseUrl: runtimeDatabaseUrl, publisherDatabaseUrl: DATABASE_URL!, objects,
      signatureVerifier: { verify: () => false }, pinnedSigningKeyIds: ["generated-p3t12"], bridgeManifestVerifier,
    });
    const publication = { release, tenantIds: [tenantA, tenantB], deviceRings: [{ tenantId: tenantA, deviceId, ring: 0 }] };
    const firstAuthority = await publisher.publishBridgeUpdateRelease(publication);
    expect(firstAuthority).toMatchObject({ releaseSequence: 420, releaseRollbackFloorSequence: 420, tenantIds: [tenantA, tenantB].sort() });
    await expect(publisher.publishBridgeUpdateRelease(publication)).resolves.toEqual(firstAuthority);
    await expect(publisher.publishBridgeUpdateRelease({
      ...publication,
      release: Object.freeze({ ...release, releasedAtMs: release.releasedAtMs + 1 }),
    })).rejects.toThrow(/identity is immutable/u);
    await expect(publisher.publishBridgeUpdateRelease({ ...publication, tenantIds: [randomUUID()], deviceRings: [] }))
      .rejects.toThrow(/target tenant is unavailable/u);
    await expect(publisher.readBridgeUpdateForDevice({ tenantId: tenantA, deviceId })).resolves.toMatchObject({
      deviceRing: 0,
      release: { id: releaseId, releaseSequence: 420 },
    });
    await publisher.close();
    const restarted = new PostgresEu12DataStore({
      databaseUrl: runtimeDatabaseUrl, objects, signatureVerifier: { verify: () => false },
      pinnedSigningKeyIds: ["generated-p3t12"], bridgeManifestVerifier,
    });
    await expect(restarted.readBridgeUpdateForDevice({ tenantId: tenantA, deviceId })).resolves.toMatchObject({
      deviceRing: 0,
      release: { id: releaseId, releaseSequence: 420, manifestDigest: bridgeManifestDigest(manifest),
        components: { bridge: { sha256: "a".repeat(64), sizeBytes: 101 }, addin: { sha256: "b".repeat(64), sizeBytes: 202 } } },
    });
    await restarted.close();
  }, 30_000);

  it("upgrades multiple legacy result refs deterministically before the R17 uniqueness constraint", async () => {
    const databaseName = `eu12_legacy_${randomBytes(8).toString("hex")}`;
    const clusterUrl = new URL(DATABASE_URL!);
    clusterUrl.pathname = "/postgres";
    const cluster = new Pool({ connectionString: clusterUrl.href });
    const legacyUrl = new URL(DATABASE_URL!);
    legacyUrl.pathname = `/${databaseName}`;
    let legacy: pg.Pool | undefined;
    try {
      await cluster.query(`CREATE DATABASE ${databaseName}`);
      await migrateUp(legacyUrl.href, { appPassword, throughVersion: "003_eu12_event_result_retention_parity.sql" });
      legacy = new Pool({ connectionString: legacyUrl.href });
      const legacyTenant = randomUUID();
      const legacyUser = randomUUID();
      const legacySession = randomUUID();
      await legacy.query("INSERT INTO tenants(id,slug,name) VALUES($1,$2,'Legacy tenant')", [legacyTenant, `legacy-${legacyTenant}`]);
      await legacy.query("INSERT INTO users(id,tenant_id,oidc_issuer,oidc_subject,role) VALUES($1,$2,'https://issuer.test','legacy-user','user')", [legacyUser, legacyTenant]);
      await legacy.query("INSERT INTO sessions(id,tenant_id,user_id,client_type) VALUES($1,$2,$3,'mcp')", [legacySession, legacyTenant, legacyUser]);
      await legacy.query(
        `INSERT INTO result_refs(id,tenant_id,session_id,storage_key,content_digest,byte_size,page_size_bytes,page_count,summary,expires_at)
         VALUES($1,$2,$3,'tenants/legacy/results/a.json.zst',$4,1,1,1,'{}',clock_timestamp()),
               ($5,$2,$3,'tenants/legacy/results/b.json.zst',$4,1,1,1,'{}',clock_timestamp())`,
        [randomUUID(), legacyTenant, legacySession, "d".repeat(64), randomUUID()],
      );
      await expect(migrateUp(legacyUrl.href, { appPassword, throughVersion: "004_eu12_reviewer_durability.sql" }))
        .resolves.toContain("004_eu12_reviewer_durability.sql");
      const labels = await legacy.query<{ ref_label: string }>(
        "SELECT ref_label FROM result_refs WHERE tenant_id=$1 AND session_id=$2 ORDER BY ref_label", [legacyTenant, legacySession],
      );
      expect(labels.rows.map((row) => row.ref_label)).toEqual(["R17", "R18"]);
      await expect(migrateUp(legacyUrl.href, { appPassword, throughVersion: "006_eu12_physical_retention_partitions.sql" }))
        .resolves.toEqual(expect.arrayContaining(["005_eu12_leased_typed_retention.sql", "006_eu12_physical_retention_partitions.sql"]));
      const legacyToolEvent = randomUUID();
      const legacyToolEventTwo = randomUUID();
      const legacyLlmEvent = randomUUID();
      const legacyLlmEventTwo = randomUUID();
      await legacy.query(
        `INSERT INTO events(id,tenant_id,event_type,occurred_at,recorded_at,source,actor,sequence,payload,envelope_digest,idempotency_digest,idempotency_key)
         VALUES($1,$5,'tool.invocation','2026-06-10T00:00:00.000Z','2026-06-10T00:00:00.000Z','{}','{}',1,'{}',$6,$7,'legacy-tool-event-a'),
               ($2,$5,'tool.invocation','2026-06-10T00:00:02.000Z','2026-06-10T00:00:02.000Z','{}','{}',2,'{}',$6,$7,'legacy-tool-event-b'),
               ($3,$5,'llm.call','2026-06-11T00:00:00.000Z','2026-06-11T00:00:00.000Z','{}','{}',3,'{}',$6,$7,'legacy-llm-event-a'),
               ($4,$5,'llm.call','2026-06-11T00:00:02.000Z','2026-06-11T00:00:02.000Z','{}','{}',4,'{}',$6,$7,'legacy-llm-event-b')`,
        [legacyToolEvent, legacyToolEventTwo, legacyLlmEvent, legacyLlmEventTwo, legacyTenant, "a".repeat(64), "b".repeat(64)],
      );
      await legacy.query(
        `INSERT INTO tool_invocations(id,tenant_id,session_id,actor_user_id,tool_name,tool_version,policy_class,executor,params_digest,outcome,idempotency_key,started_at,finished_at,duration_ms,params_summary,code_summary,request_bytes,response_bytes,event_id)
         VALUES($1,$3,$4,$5,'core.inspect','1.0.0','auto','bridge',$6,'completed','legacy-tool-invocation-a','2026-06-10T00:00:00.000Z','2026-06-10T00:00:01.000Z',1,'{}','{}',1,1,$1),
               ($2,$3,$4,$5,'core.inspect','1.0.0','auto','bridge',$6,'completed','legacy-tool-invocation-b','2026-06-10T00:00:02.000Z','2026-06-10T00:00:03.000Z',1,'{}','{}',1,1,$2)`,
        [legacyToolEvent, legacyToolEventTwo, legacyTenant, legacySession, legacyUser, "c".repeat(64)],
      );
      await legacy.query(
        `INSERT INTO llm_calls(event_id,tenant_id,session_id,input_tokens,output_tokens,cache_read_tokens,duration_ms,cost,created_at,id,provider,model,role,engine_mode,cache_creation_input_tokens,latency_ms,stop_reason,outcome,cost_microusd)
         VALUES($1,$3,$4,2,3,0,4,0.000005,'2026-06-11T00:00:00.000Z',$1,'external-client','legacy-model','external_client','external_client',0,4,'unknown','completed',5),
               ($2,$3,$4,5,7,1,8,0.000009,'2026-06-11T00:00:02.000Z',$2,'external-client','legacy-model','external_client','external_client',0,8,'unknown','completed',9)`,
        [legacyLlmEvent, legacyLlmEventTwo, legacyTenant, legacySession],
      );
      await expect(migrateUp(legacyUrl.href, { appPassword, throughVersion: "008_eu12_canonical_time_partitions.sql" })).resolves.toEqual(expect.arrayContaining([
        "007_eu12_hot_retention_authority.sql",
        "008_eu12_canonical_time_partitions.sql",
      ]));
      await expect(legacy.query<{ count: number; partition_key: string }>(
        "SELECT count(*)::int AS count,min(retention_partition_key) AS partition_key FROM events WHERE tenant_id=$1", [legacyTenant],
      )).resolves.toMatchObject({ rows: [{ count: 4, partition_key: `${legacyTenant}:events:202606` }] });
      await expect(migrateUp(legacyUrl.href, { appPassword })).resolves.toEqual(expect.arrayContaining([
        "009_eu12_retention_class_due_partitions.sql",
      ]));
      await expect(legacy.query<{ count: number; partition_key: string }>(
        "SELECT count(*)::int AS count,min(retention_partition_key) AS partition_key FROM events WHERE tenant_id=$1", [legacyTenant],
      )).resolves.toMatchObject({ rows: [{ count: 4, partition_key: `${legacyTenant}:events:standard_12m:202606` }] });
      await expect(legacy.query<{ idempotency_key: string; envelope_digest: string; retention_partition_key: string }>(
        "SELECT idempotency_key,envelope_digest::text,retention_partition_key FROM events WHERE tenant_id=$1 ORDER BY idempotency_key", [legacyTenant],
      )).resolves.toMatchObject({ rows: [
        { idempotency_key: "legacy-llm-event-a", envelope_digest: "a".repeat(64), retention_partition_key: `${legacyTenant}:events:standard_12m:202606` },
        { idempotency_key: "legacy-llm-event-b", envelope_digest: "a".repeat(64), retention_partition_key: `${legacyTenant}:events:standard_12m:202606` },
        { idempotency_key: "legacy-tool-event-a", envelope_digest: "a".repeat(64), retention_partition_key: `${legacyTenant}:events:standard_12m:202606` },
        { idempotency_key: "legacy-tool-event-b", envelope_digest: "a".repeat(64), retention_partition_key: `${legacyTenant}:events:standard_12m:202606` },
      ] });
      await expect(legacy.query<{ count: number; partition_key: string }>(
        "SELECT count(*)::int AS count,min(retention_partition_key) AS partition_key FROM tool_invocations WHERE tenant_id=$1", [legacyTenant],
      )).resolves.toMatchObject({ rows: [{ count: 2, partition_key: `${legacyTenant}:tool_invocations:standard_12m:202606` }] });
      await expect(legacy.query<{ idempotency_key: string; tool_name: string; event_id: string }>(
        "SELECT idempotency_key,tool_name,event_id::text FROM tool_invocations WHERE tenant_id=$1 ORDER BY idempotency_key", [legacyTenant],
      )).resolves.toMatchObject({ rows: [
        { idempotency_key: "legacy-tool-invocation-a", tool_name: "core.inspect", event_id: legacyToolEvent },
        { idempotency_key: "legacy-tool-invocation-b", tool_name: "core.inspect", event_id: legacyToolEventTwo },
      ] });
      await expect(legacy.query<{ count: number; partition_key: string }>(
        "SELECT count(*)::int AS count,min(retention_partition_key) AS partition_key FROM llm_calls WHERE tenant_id=$1", [legacyTenant],
      )).resolves.toMatchObject({ rows: [{ count: 2, partition_key: `${legacyTenant}:llm_calls:standard_12m:202606` }] });
      await expect(legacy.query<{ event_id: string; model: string; input_tokens: number; output_tokens: number }>(
        "SELECT event_id::text,model,input_tokens,output_tokens FROM llm_calls WHERE tenant_id=$1 ORDER BY input_tokens", [legacyTenant],
      )).resolves.toMatchObject({ rows: [
        { event_id: legacyLlmEvent, model: "legacy-model", input_tokens: 2, output_tokens: 3 },
        { event_id: legacyLlmEventTwo, model: "legacy-model", input_tokens: 5, output_tokens: 7 },
      ] });
      await expect(migrateUp(legacyUrl.href, { appPassword })).resolves.toEqual([]);
    } finally {
      await legacy?.end();
      await cluster.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1", [databaseName]);
      await cluster.query(`DROP DATABASE IF EXISTS ${databaseName}`);
      await cluster.end();
    }
  }, 60_000);

  it("enforces nonempty two-tenant RLS and definer privilege negatives for every EU-12 surface", async () => {
    const tenantBLiveLlm = envelope({
      eventId: randomUUID(), tenantId: tenantB, sessionId: sessionB, userId: userB, type: "llm.call", occurredAt: "2026-09-05T00:00:00.000Z",
      payload: {
        idempotency_key: "eu12/tenant-b-live-llm", upstream_name: "external-client", model_name: "tenant-b-model",
        engine_mode: "external_client", role: "external_client", input_tokens: 8, output_tokens: 9,
        cache_read_tokens: 1, cache_creation_tokens: 0, duration_ms: 10, latency_ms: 10,
        cost_microusd: 11, stop_reason: "unknown", outcome: "completed",
      },
    });
    await expect(store.emit(tenantBLiveLlm)).resolves.toEqual({ ok: true, value: undefined });
    await admin.query(
      `INSERT INTO result_refs(id,tenant_id,session_id,ref_label,storage_key,content_digest,byte_size,page_size_bytes,page_count,summary,expires_at)
       VALUES ($1,$2,$3,'R999','tenants/a/results/ref.json.zst',$4,1,1,1,'{}',clock_timestamp()),
              ($5,$6,$7,'R999','tenants/b/results/ref.json.zst',$4,1,1,1,'{}',clock_timestamp())`,
      [randomUUID(), tenantA, sessionA, "b".repeat(64), randomUUID(), tenantB, sessionB],
    );
    await admin.query(
      `INSERT INTO retention_runs(tenant_id,archive_month,archive_kind,state,archive_key,archive_digest,row_digest,event_count,attempts,lease_owner,lease_expires_at,lease_epoch)
       VALUES ($1,'2026-07-01','events','prepared','archive/a/events/2026-07.ndjson.zst',$3,$3,1,1,'tenant-a-lease',clock_timestamp()+interval '5 minutes',1),
              ($2,'2026-07-01','events','prepared','archive/b/events/2026-07.ndjson.zst',$3,$3,1,1,'tenant-b-lease',clock_timestamp()+interval '5 minutes',1)`,
      [tenantA, tenantB, "c".repeat(64)],
    );
    const tenantBActive = randomUUID();
    await admin.query(
      `INSERT INTO active_invocations(invocation_id,tenant_id,session_id,actor_user_id,tool_name,started_at)
       VALUES($1,$2,$3,$4,'core.inspect',clock_timestamp())`, [tenantBActive, tenantB, sessionB, userB],
    );
    await admin.query(
      `INSERT INTO release_channel_targets(channel,tenant_id,rollout_revision)
       SELECT 'stable',$1,channel_revision FROM release_channels WHERE channel='stable'
       ON CONFLICT (channel,tenant_id) DO UPDATE SET rollout_revision=EXCLUDED.rollout_revision`, [tenantB],
    );
    await expect(runtime.query(
      "SELECT revagent_prepare_canonical_retention_partition($1,'llm_calls','standard_12m','2026-09-01',$2,'tenant-b-lease',1)", [tenantB, Date.parse("2030-01-01T00:00:00.000Z")],
    )).rejects.toThrow(/permission denied/u);
    const client = await runtime.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE revagent_app");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantA]);
      for (const relation of ["events", "llm_calls", "tool_invocations", "result_refs", "retention_runs", "release_channel_targets", "retention_partition_ownership", "eu12_event_identity_registry", "eu12_tool_invocation_identity_registry", "eu12_llm_call_identity_registry", "active_invocations"] as const) {
        await expect(client.query(`SELECT tenant_id FROM ${relation} WHERE tenant_id=$1`, [tenantB]))
          .resolves.toMatchObject({ rowCount: 0 });
      }
      await client.query("SAVEPOINT cross_tenant_definer");
      await expect(client.query(
        "SELECT revagent_prepare_canonical_retention_partition($1,'llm_calls','standard_12m','2026-09-01',$2,'tenant-b-lease',1)", [tenantB, Date.parse("2030-01-01T00:00:00.000Z")],
      )).rejects.toThrow(/tenant scope/u);
      await client.query("ROLLBACK TO SAVEPOINT cross_tenant_definer");
      await expect(client.query(
        "UPDATE active_invocations SET terminal_at=clock_timestamp(),terminal_outcome='failed' WHERE tenant_id=$1", [tenantB],
      )).resolves.toMatchObject({ rowCount: 0 });
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE revagent_app");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantB]);
      const tenantBLlmCount = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM llm_calls WHERE tenant_id=$1", [tenantB]);
      const tenantBHotCount = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM retention_partition_ownership WHERE tenant_id=$1", [tenantB]);
      const tenantBRunCount = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM retention_runs WHERE tenant_id=$1", [tenantB]);
      const tenantBEventIdentityCount = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM eu12_event_identity_registry WHERE tenant_id=$1", [tenantB]);
      const tenantBToolIdentityCount = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM eu12_tool_invocation_identity_registry WHERE tenant_id=$1", [tenantB]);
      const tenantBLlmIdentityCount = await client.query<{ count: number }>("SELECT count(*)::int AS count FROM eu12_llm_call_identity_registry WHERE tenant_id=$1", [tenantB]);
      for (const result of [tenantBLlmCount, tenantBHotCount, tenantBRunCount, tenantBEventIdentityCount, tenantBToolIdentityCount, tenantBLlmIdentityCount]) expect(result.rows[0]?.count ?? 0).toBeGreaterThan(0);
      await expect(client.query("SELECT count(*)::int AS count FROM active_invocations WHERE tenant_id=$1", [tenantB]))
        .resolves.toMatchObject({ rows: [{ count: 1 }] });
      await expect(client.query("SELECT count(*)::int AS count FROM release_channel_targets WHERE tenant_id=$1", [tenantB]))
        .resolves.toMatchObject({ rows: [{ count: 1 }] });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
