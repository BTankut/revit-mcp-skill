import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import Fastify from "fastify";
import type { AuthContext, IdentityPort } from "./authContext.js";
import { GATEWAY_AUTH_CONTRACT_VERSION, createUnavailableIdentityPort } from "./authContext.js";
import { parseBridgeManifestTrustedKeys, verifyBridgeManifestSignature } from "./bridgeManifestSignature.js";
import { FilesystemBridgeReleaseObjectStore } from "./bridgeReleaseObjectStore.js";
import { importBridgeRelease } from "./bridgeReleaseImportCli.js";
import { createBridgeUpdateEndpoint } from "./bridgeUpdateEndpoint.js";
import { M5EnrollmentEntitlementControlPlane } from "./m5EnrollmentEntitlement.js";
import { createM5BridgeIdentityAuthority } from "./m5BridgeIdentityAuthority.js";
import { migrateUp } from "./migrate.js";
import { PostgresEu12DataStore } from "./postgresEu12DataStore.js";
import type { ResultObjectStore } from "./resultReferenceStore.js";
import pg from "pg";

const { Pool } = pg;
const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const ADMIN_ID = "10000000-0000-4000-8000-000000000101";
const USER_ID = "10000000-0000-4000-8000-000000000111";
const DEVICE_ID = "10000000-0000-4000-8000-000000000311";
const FINGERPRINT = `sha256:${"31".repeat(32)}` as const;

function args(values: readonly string[]): Readonly<Record<string, string>> {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]; const value = values[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--") || parsed[key.slice(2)] !== undefined) {
      throw new Error("composed fixture arguments must be unique --name value pairs");
    }
    parsed[key.slice(2)] = value;
  }
  return Object.freeze(parsed);
}

function required(values: Readonly<Record<string, string>>, name: string): string {
  const value = values[name];
  if (value === undefined || value.length === 0) throw new Error(`composed fixture requires --${name}`);
  return value;
}

function adminAuth(): AuthContext {
  return Object.freeze({
    contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
    actor: Object.freeze({ type: "user" as const, tenantId: TENANT_ID, userId: ADMIN_ID, role: "tenant_admin" as const,
      oidcIssuer: "https://identity.fixture.test", oidcSubject: "p3t12-admin" }),
    session: Object.freeze({ sessionId: "p3t12-admin-session", clientType: "mcp" as const, mcpSessionId: "p3t12-mcp", oauthClientId: null }),
    principalKey: "p3t12-admin", issuedAtMs: Date.now(), expiresAtMs: null,
  });
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, path);
}

async function main(): Promise<void> {
  const input = args(process.argv.slice(2));
  const databaseUrl = required(input, "database-url");
  const database = new URL(databaseUrl);
  if (process.env.REVAGENT_P3T12_COMPOSED_FIXTURE !== "generated-local-only" ||
      !["postgres:", "postgresql:"].includes(database.protocol) ||
      database.hostname !== "127.0.0.1" && database.hostname !== "localhost") {
    throw new Error("composed fixture is restricted to an explicit generated loopback database");
  }
  const artifactRoot = required(input, "artifact-root");
  const objectRoot = required(input, "object-root");
  const trustedKeysPath = required(input, "trusted-keys");
  const certPath = required(input, "tls-cert");
  const keyPath = required(input, "tls-key");
  const readyFile = required(input, "ready-file");
  const stopFile = required(input, "stop-file");
  const resultFile = required(input, "result-file");
  const repository = required(input, "repository");
  const headSha = required(input, "head-sha");
  const port = Number(required(input, "port"));
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || !/^[0-9a-f]{40}$/u.test(headSha)) {
    throw new Error("composed fixture port or head identity is invalid");
  }

  await migrateUp(databaseUrl, { appPassword: randomBytes(32).toString("base64url") });
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(
    "INSERT INTO tenants(id,slug,name) VALUES($1,'p3t12-composed','P3T12 Composed') ON CONFLICT(id) DO UPDATE SET slug=EXCLUDED.slug,name=EXCLUDED.name",
    [TENANT_ID],
  );
  await admin.query(
    `INSERT INTO users(id,tenant_id,oidc_issuer,oidc_subject,role,status) VALUES
      ($1,$3,'https://identity.fixture.test','admin','tenant_admin','active'),
      ($2,$3,'https://identity.fixture.test','user','user','active')`,
    [ADMIN_ID, USER_ID, TENANT_ID],
  );
  const plane = new M5EnrollmentEntitlementControlPlane({
    databaseUrl,
    tokenPepper: randomBytes(32).toString("base64url"),
    capabilities: [{ name: "core.get_status", module: "core", summary: "fixture" }],
  });
  const granted = await plane.grantModuleLicense(adminAuth(), { module: "core", seatLimit: 1 });
  if (!granted.ok) throw new Error(`composed fixture license failed: ${granted.reason}`);
  const minted = await plane.mintEnrollmentCode(adminAuth(), { principalUserId: USER_ID, deviceId: DEVICE_ID, machineFingerprint: FINGERPRINT });
  if (!minted.ok) throw new Error(`composed fixture enrollment mint failed: ${minted.reason}`);
  const exchanged = await plane.exchangeEnrollmentCode({ enrollmentCode: minted.value.enrollmentCode, machineFingerprint: FINGERPRINT });
  if (!exchanged.ok) throw new Error(`composed fixture enrollment exchange failed: ${exchanged.reason}`);
  const assigned = await plane.assignSeat(adminAuth(), { module: "core", principalUserId: USER_ID, deviceId: DEVICE_ID });
  if (!assigned.ok) throw new Error(`composed fixture seat failed: ${assigned.reason}`);
  const fallback = createUnavailableIdentityPort();
  const north: IdentityPort & { readonly kind: "oidc" } = Object.freeze({
    kind: "oidc" as const,
    authenticateNorthRequest: (request: Parameters<IdentityPort["authenticateNorthRequest"]>[0]) => fallback.authenticateNorthRequest(request),
    authenticateDevice: (request: Parameters<IdentityPort["authenticateDevice"]>[0]) => fallback.authenticateDevice(request),
  });
  const identity = createM5BridgeIdentityAuthority({ northIdentity: north, plane });
  const trustedKeys = parseBridgeManifestTrustedKeys(JSON.parse(await readFile(trustedKeysPath, "utf8")));
  if (Object.keys(trustedKeys).length !== 1 || trustedKeys["eu21-composed-test-key"] === undefined) {
    throw new Error("composed fixture accepts only its generated test signing key");
  }
  const unavailableObjects: ResultObjectStore = Object.freeze({
    async put() { throw new Error("composed release fixture cannot write result objects"); },
    async get() { return null; },
    async delete() { throw new Error("composed release fixture cannot delete result objects"); },
  });
  const releases = new PostgresEu12DataStore({
    databaseUrl, publisherDatabaseUrl: databaseUrl, objects: unavailableObjects,
    signatureVerifier: Object.freeze({ verify() { return false; } }), pinnedSigningKeyIds: Object.keys(trustedKeys),
    bridgeManifestVerifier: value => verifyBridgeManifestSignature({ manifest: value.manifest, envelope: value.signatureEnvelope, trustedKeys }),
  });
  const objects = new FilesystemBridgeReleaseObjectStore(objectRoot);
  await importBridgeRelease({ artifactRoot, expectedRepository: repository, expectedHeadSha: headSha,
    trustedKeysPath, tenantIds: [TENANT_ID], deviceRings: [{ tenantId: TENANT_ID, deviceId: DEVICE_ID, ring: 0 }], releasedBy: "composed-fixture",
  }, { publisher: releases, objects });

  const app = Fastify({ https: { cert: await readFile(certPath), key: await readFile(keyPath) }, logger: false });
  const requests: string[] = [];
  app.addHook("onRequest", async (request) => { requests.push(request.url); });
  createBridgeUpdateEndpoint({ identity, releases, objects,
    verifyManifest: value => verifyBridgeManifestSignature({ manifest: value.manifest, envelope: value.signatureEnvelope, trustedKeys }),
  }).mount(app);
  try {
    await app.listen({ host: "127.0.0.1", port });
    await atomicJson(readyFile, { uri: `https://127.0.0.1:${port}/`, deviceId: DEVICE_ID,
      machineFingerprint: FINGERPRINT, deviceToken: exchanged.value.deviceToken });
    while (!existsSync(stopFile)) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    const visible = await releases.readBridgeUpdateForDevice({ tenantId: TENANT_ID, deviceId: DEVICE_ID });
    await atomicJson(resultFile, { requests, releaseId: visible?.release.id ?? null,
      releaseSequence: visible?.release.releaseSequence ?? null,
      rollbackFloorSequence: visible?.release.rollbackFloorSequence ?? null,
      manifestDigest: visible?.release.manifestDigest ?? null,
      deviceRing: visible?.deviceRing ?? null,
      authorityChain: ["M5EnrollmentEntitlementControlPlane", "PostgresEu12DataStore", "FilesystemBridgeReleaseObjectStore", "createBridgeUpdateEndpoint"],
    });
  } finally {
    await app.close();
    await releases.close();
    await plane.close();
    await admin.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : "unknown composed fixture error"}\n`);
  process.exitCode = 1;
});
