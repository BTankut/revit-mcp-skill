import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { JsonValue } from "@revagent/protocol";

import { parseBridgeManifestTrustedKeys, verifyBridgeManifestSignature } from "./bridgeManifestSignature.js";
import { FilesystemBridgeReleaseObjectStore } from "./bridgeReleaseObjectStore.js";
import { PostgresEu12DataStore } from "./postgresEu12DataStore.js";
import type { BridgeUpdateDeviceRingAssignment, BridgeUpdateReleaseAuthority } from "./releaseChannelStore.js";
import type { ResultObjectStore } from "./resultReferenceStore.js";

export interface BridgeReleasePublisher {
  publishBridgeUpdateRelease(input: {
    readonly release: BridgeUpdateReleaseAuthority;
    readonly tenantIds: readonly string[];
    readonly deviceRings?: readonly BridgeUpdateDeviceRingAssignment[];
  }): Promise<unknown>;
}

export interface BridgeReleaseImportInput {
  readonly artifactRoot: string;
  readonly expectedArtifactId: string;
  readonly expectedArtifactDigest: string;
  readonly expectedRepository: string;
  readonly expectedHeadSha: string;
  readonly trustedKeysPath: string;
  readonly tenantIds: readonly string[];
  readonly deviceRings: readonly BridgeUpdateDeviceRingAssignment[];
  readonly releasedBy: string;
}

interface Provenance {
  readonly schemaVersion: 1;
  readonly releaseId: string;
  readonly repository: string;
  readonly headSha: string;
  readonly headTree: string;
  readonly createdAtUtc: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function regularFile(path: string, maximumBytes: number): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > maximumBytes) {
    throw new Error("Bridge release import input is not a bounded regular file");
  }
  return await readFile(path);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function importBridgeRelease(
  input: BridgeReleaseImportInput,
  dependencies: {
    readonly publisher: BridgeReleasePublisher;
    readonly objects: FilesystemBridgeReleaseObjectStore;
  },
): Promise<Readonly<{ readonly releaseId: string; readonly manifestDigest: string; readonly componentDigests: Readonly<Record<"bridge" | "addin", string>> }>> {
  const root = resolve(input.artifactRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("Bridge release artifact root is unsafe");
  const [manifestBytes, envelopeBytes, bridgeBytes, addinBytes, provenanceBytes, trustedBytes] = await Promise.all([
    regularFile(resolve(root, "bridge-manifest.json"), 1024 * 1024),
    regularFile(resolve(root, "bridge-manifest.signature.json"), 1024 * 1024),
    regularFile(resolve(root, "bridge.zip"), 1024 * 1024 * 1024),
    regularFile(resolve(root, "addin.zip"), 1024 * 1024 * 1024),
    regularFile(resolve(root, "provenance.json"), 1024 * 1024),
    regularFile(resolve(input.trustedKeysPath), 1024 * 1024),
  ]);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as JsonValue;
  const signatureEnvelope = JSON.parse(envelopeBytes.toString("utf8")) as JsonValue;
  const provenance = JSON.parse(provenanceBytes.toString("utf8")) as Provenance;
  if (!record(provenance) || provenance.schemaVersion !== 1 ||
      provenance.repository !== input.expectedRepository || provenance.headSha !== input.expectedHeadSha ||
      !/^[0-9a-f]{40}$/u.test(provenance.headSha) || !/^[0-9a-f]{40}$/u.test(provenance.headTree) ||
      !/^[0-9a-f-]{36}$/u.test(provenance.releaseId) ||
      !/^[1-9][0-9]*$/u.test(input.expectedArtifactId) ||
      !/^(?:sha256:)?[0-9a-f]{64}$/u.test(input.expectedArtifactDigest)) {
    throw new Error("Bridge release provenance differs from the pinned import request");
  }
  const trustedKeys = parseBridgeManifestTrustedKeys(JSON.parse(trustedBytes.toString("utf8")));
  const verified = verifyBridgeManifestSignature({ manifest, envelope: signatureEnvelope, trustedKeys });
  if (!record(manifest) || !Array.isArray(manifest.components) || manifest.components.length !== 2 ||
      typeof manifest.channel !== "string" || !["stable", "pilot"].includes(manifest.channel) ||
      typeof manifest.version !== "string" || typeof manifest.releaseSequence !== "number" ||
      typeof manifest.rolloutPercent !== "number" || typeof manifest.minSupportedVersion !== "string") {
    throw new Error("Bridge release manifest shape is invalid");
  }
  const manifestComponents = manifest.components;
  const component = (name: "bridge" | "addin", bytes: Buffer) => {
    const signed = manifestComponents.find((value: JsonValue) => record(value) && value.name === name);
    if (!record(signed) || typeof signed.version !== "string" || signed.version !== manifest.version ||
        typeof signed.sha256 !== "string" || signed.sha256 !== sha256(bytes) ||
        signed.sizeBytes !== bytes.byteLength || typeof signed.url !== "string") {
      throw new Error(`Bridge release ${name} bytes differ from signed metadata`);
    }
    const storageKey = dependencies.objects.storageKey({ releaseId: provenance.releaseId, component: name, sha256: signed.sha256 });
    return Object.freeze({ name, version: signed.version, storageKey, sha256: signed.sha256, sizeBytes: bytes.byteLength, url: signed.url });
  };
  const bridge = component("bridge", bridgeBytes);
  const addin = component("addin", addinBytes);
  await dependencies.objects.putCreateOnly({ key: bridge.storageKey, bytes: bridgeBytes, sha256: bridge.sha256, sizeBytes: bridge.sizeBytes });
  await dependencies.objects.putCreateOnly({ key: addin.storageKey, bytes: addinBytes, sha256: addin.sha256, sizeBytes: addin.sizeBytes });
  const releasedAtMs = Date.parse(provenance.createdAtUtc);
  if (!Number.isSafeInteger(releasedAtMs) || releasedAtMs < 1) throw new Error("Bridge release provenance time is invalid");
  const release: BridgeUpdateReleaseAuthority = Object.freeze({
    id: provenance.releaseId,
    channel: manifest.channel as "stable" | "pilot",
    version: manifest.version,
    releaseSequence: manifest.releaseSequence,
    rollbackFloorSequence: manifest.releaseSequence,
    manifest,
    signatureEnvelope,
    manifestDigest: verified.contentSha256,
    signingKeyId: verified.keyId,
    components: Object.freeze({ bridge, addin }),
    rolloutPercent: manifest.rolloutPercent,
    minSupportedVersion: manifest.minSupportedVersion,
    releasedAtMs,
    releasedBy: input.releasedBy,
  });
  await dependencies.publisher.publishBridgeUpdateRelease({
    release,
    tenantIds: input.tenantIds,
    deviceRings: input.deviceRings,
  });
  return Object.freeze({
    releaseId: release.id,
    manifestDigest: release.manifestDigest,
    componentDigests: Object.freeze({ bridge: bridge.sha256, addin: addin.sha256 }),
  });
}

function parseArguments(args: readonly string[]): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--") || values[key.slice(2)] !== undefined) {
      throw new Error("Bridge release import arguments must be unique --name value pairs");
    }
    values[key.slice(2)] = value;
  }
  return Object.freeze(values);
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const databaseUrl = args["database-url"] ?? process.env.DATABASE_URL;
  if (args.publish !== "true" || args.confirm !== "PUBLISH_BRIDGE_UPDATE" || !databaseUrl ||
      !args["artifact-root"] || !args["object-store-root"] || !args["trusted-keys"] || !args["tenant-ids"] ||
      !args["artifact-id"] || !args["artifact-digest"] || !args.repository || !args["head-sha"] || !args["released-by"]) {
    throw new Error("Bridge release import requires explicit publish controls and pinned provenance");
  }
  const trusted = parseBridgeManifestTrustedKeys(JSON.parse(await readFile(args["trusted-keys"], "utf8")));
  const unavailableObjects: ResultObjectStore = Object.freeze({
    async put() { throw new Error("Bridge release import cannot write result objects"); },
    async get() { return null; },
    async delete() { throw new Error("Bridge release import cannot delete result objects"); },
  });
  const store = new PostgresEu12DataStore({
    databaseUrl, publisherDatabaseUrl: databaseUrl,
    objects: unavailableObjects, signatureVerifier: Object.freeze({ verify() { return false; } }),
    pinnedSigningKeyIds: Object.keys(trusted),
    bridgeManifestVerifier: input => verifyBridgeManifestSignature({ manifest: input.manifest, envelope: input.signatureEnvelope, trustedKeys: trusted }),
  });
  try {
    const result = await importBridgeRelease({
      artifactRoot: args["artifact-root"], expectedArtifactId: args["artifact-id"],
      expectedArtifactDigest: args["artifact-digest"], expectedRepository: args.repository,
      expectedHeadSha: args["head-sha"], trustedKeysPath: args["trusted-keys"],
      tenantIds: args["tenant-ids"].split(",").filter(Boolean),
      deviceRings: process.env.BRIDGE_RELEASE_DEVICE_RINGS_JSON
        ? JSON.parse(process.env.BRIDGE_RELEASE_DEVICE_RINGS_JSON) as BridgeUpdateDeviceRingAssignment[]
        : args["device-rings"]
          ? JSON.parse(await readFile(args["device-rings"], "utf8")) as BridgeUpdateDeviceRingAssignment[]
          : [],
      releasedBy: args["released-by"],
    }, { publisher: store, objects: new FilesystemBridgeReleaseObjectStore(args["object-store-root"]) });
    process.stdout.write(`${JSON.stringify({ success: true, ...result })}\n`);
  } finally { await store.close(); }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    process.stderr.write(`${JSON.stringify({ success: false, message: error instanceof Error ? error.message : "unknown import error" })}\n`);
    process.exitCode = 1;
  });
}
