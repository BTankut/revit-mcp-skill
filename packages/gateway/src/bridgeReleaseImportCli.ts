import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { JsonValue } from "@revagent/protocol";

import { parseBridgeManifestTrustedKeys, verifyBridgeManifestSignature } from "./bridgeManifestSignature.js";
import { FilesystemBridgeReleaseObjectStore } from "./bridgeReleaseObjectStore.js";
import { PostgresEu12DataStore } from "./postgresEu12DataStore.js";
import type { BridgeUpdateDeviceRingAssignment, BridgeUpdateReleaseAuthority } from "./releaseChannelStore.js";
import type { ResultObjectStore } from "./resultReferenceStore.js";

const GITHUB_API_ORIGIN = "https://api.github.com";
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const MAX_ACTIONS_ARCHIVE_BYTES = 1100 * 1024 * 1024;
const EXPECTED_ARCHIVE_ENTRIES = new Set([
  "bridge-manifest.json",
  "bridge-manifest.signature.json",
  "bridge.zip",
  "addin.zip",
  "provenance.json",
]);

export interface BridgeReleasePublisher {
  publishBridgeUpdateRelease(input: {
    readonly release: BridgeUpdateReleaseAuthority;
    readonly tenantIds: readonly string[];
    readonly deviceRings?: readonly BridgeUpdateDeviceRingAssignment[];
  }): Promise<unknown>;
}

interface BridgeReleaseImportAuthority {
  readonly expectedRepository: string;
  readonly expectedHeadSha: string;
  readonly trustedKeysPath: string;
  readonly tenantIds: readonly string[];
  readonly deviceRings: readonly BridgeUpdateDeviceRingAssignment[];
  readonly releasedBy: string;
}

export interface BridgeReleaseImportInput extends BridgeReleaseImportAuthority {
  readonly artifactRoot: string;
}

export interface ActionsBridgeReleaseImportInput extends BridgeReleaseImportAuthority {
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly runId: string;
  readonly githubToken: string;
}

export interface VerifiedActionsArtifactReceipt {
  readonly artifactId: string;
  readonly artifactDigest: `sha256:${string}`;
  readonly repository: string;
  readonly repositoryId: number;
  readonly runId: string;
  readonly headSha: string;
  readonly archiveBytes: number;
}

interface Provenance {
  readonly schemaVersion: 1;
  readonly releaseId: string;
  readonly repository: string;
  readonly headSha: string;
  readonly headTree: string;
  readonly createdAtUtc: string;
}

interface BridgeReleaseMaterial {
  readonly manifestBytes: Buffer;
  readonly envelopeBytes: Buffer;
  readonly bridgeBytes: Buffer;
  readonly addinBytes: Buffer;
  readonly provenanceBytes: Buffer;
  readonly trustedBytes: Buffer;
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

function canonicalDigest(value: string): `sha256:${string}` {
  const normalized = value.toLowerCase().replace(/^sha256:/u, "");
  if (!/^[0-9a-f]{64}$/u.test(normalized)) throw new Error("Actions artifact digest is invalid");
  return `sha256:${normalized}`;
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw new Error("Authenticated Actions response exceeds its byte limit");
  }
  if (response.body === null) throw new Error("Authenticated Actions response has no body");
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("Authenticated Actions response exceeds its byte limit");
    }
    chunks.push(Buffer.from(next.value));
  }
  return Buffer.concat(chunks, total);
}

async function actionsJson(url: URL, token: string): Promise<unknown> {
  if (url.origin !== GITHUB_API_ORIGIN) throw new Error("GitHub credential destination is invalid");
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    redirect: "error",
  });
  if (!response.ok || response.url !== url.href) throw new Error("Authenticated Actions metadata lookup failed");
  return JSON.parse((await readBoundedResponse(response, MAX_API_RESPONSE_BYTES)).toString("utf8")) as unknown;
}

function parseActionsZip(archive: Buffer): Readonly<Record<string, Buffer>> {
  let eocd = -1;
  const minimum = Math.max(0, archive.length - 65_557);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0 || eocd + 22 > archive.length || archive.readUInt16LE(eocd + 4) !== 0 ||
      archive.readUInt16LE(eocd + 6) !== 0 || archive.readUInt16LE(eocd + 8) !== archive.readUInt16LE(eocd + 10)) {
    throw new Error("Actions artifact ZIP authority is invalid");
  }
  const entryCount = archive.readUInt16LE(eocd + 10);
  const centralSize = archive.readUInt32LE(eocd + 12);
  const centralOffset = archive.readUInt32LE(eocd + 16);
  if (entryCount !== EXPECTED_ARCHIVE_ENTRIES.size || centralOffset + centralSize > eocd) {
    throw new Error("Actions artifact ZIP entry set is invalid");
  }
  const entries: Record<string, Buffer> = {};
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Actions artifact ZIP central directory is invalid");
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const nextCursor = cursor + 46 + nameLength + extraLength + commentLength;
    if ((flags & 1) !== 0 || ![0, 8].includes(method) || nextCursor > archive.length ||
        compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error("Actions artifact ZIP entry is unsupported");
    }
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    if (!EXPECTED_ARCHIVE_ENTRIES.has(name) || entries[name] !== undefined || name.includes("\\") || name.includes("..") || name.startsWith("/")) {
      throw new Error("Actions artifact ZIP contains an unexpected path");
    }
    if (localOffset + 30 > archive.length || archive.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error("Actions artifact ZIP local header is invalid");
    }
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const maximumExpanded = name.endsWith(".json") ? MAX_API_RESPONSE_BYTES : 1024 * 1024 * 1024;
    const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
    if (localName !== name || uncompressedSize < 1 || uncompressedSize > maximumExpanded ||
        dataOffset + compressedSize > archive.length) throw new Error("Actions artifact ZIP data is invalid or truncated");
    const compressed = archive.subarray(dataOffset, dataOffset + compressedSize);
    const bytes = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: uncompressedSize });
    if (bytes.length !== uncompressedSize) throw new Error("Actions artifact ZIP expanded size differs from authority");
    entries[name] = bytes;
    cursor = nextCursor;
  }
  if (cursor !== centralOffset + centralSize || Object.keys(entries).length !== EXPECTED_ARCHIVE_ENTRIES.size) {
    throw new Error("Actions artifact ZIP central authority is incomplete");
  }
  return Object.freeze(entries);
}

export async function verifyActionsArtifactSource(input: {
  readonly artifactId: string;
  readonly artifactDigest: string;
  readonly repository: string;
  readonly runId: string;
  readonly headSha: string;
  readonly githubToken: string;
}): Promise<Readonly<{ readonly receipt: VerifiedActionsArtifactReceipt; readonly entries: Readonly<Record<string, Buffer>> }>> {
  if (!/^[1-9][0-9]*$/u.test(input.artifactId) || !/^[1-9][0-9]*$/u.test(input.runId) ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(input.repository) || !/^[0-9a-f]{40}$/u.test(input.headSha) ||
      input.githubToken.length < 1 || input.githubToken.length > 4096 || input.githubToken.trim() !== input.githubToken) {
    throw new Error("Actions artifact authority input is invalid");
  }
  const expectedDigest = canonicalDigest(input.artifactDigest);
  const [owner, repositoryName] = input.repository.split("/") as [string, string];
  const repositoryUrl = new URL(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}`, GITHUB_API_ORIGIN);
  const repository = await actionsJson(repositoryUrl, input.githubToken);
  if (!record(repository) || repository.full_name !== input.repository || !Number.isSafeInteger(repository.id) || (repository.id as number) < 1) {
    throw new Error("Authenticated Actions repository identity differs from import authority");
  }
  const artifactUrl = new URL(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/actions/artifacts/${input.artifactId}`, GITHUB_API_ORIGIN);
  const artifact = await actionsJson(artifactUrl, input.githubToken);
  const workflowRun = record(artifact) && record(artifact.workflow_run) ? artifact.workflow_run : null;
  if (!record(artifact) || artifact.id !== Number(input.artifactId) || artifact.expired !== false ||
      typeof artifact.digest !== "string" || canonicalDigest(artifact.digest) !== expectedDigest ||
      typeof artifact.archive_download_url !== "string" || !URL.canParse(artifact.archive_download_url) ||
      workflowRun === null || workflowRun.id !== Number(input.runId) || workflowRun.head_sha !== input.headSha ||
      workflowRun.repository_id !== repository.id || workflowRun.head_repository_id !== repository.id) {
    throw new Error("Authenticated Actions artifact identity differs from import authority");
  }
  const archiveUrl = new URL(artifact.archive_download_url);
  if (archiveUrl.origin !== GITHUB_API_ORIGIN) throw new Error("Actions archive authority escaped the GitHub API origin");
  const redirect = await fetch(archiveUrl, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.githubToken}`,
      "x-github-api-version": "2022-11-28",
    },
    redirect: "manual",
  });
  const location = redirect.headers.get("location");
  if (![302, 303, 307].includes(redirect.status) || location === null || !URL.canParse(location)) {
    throw new Error("Authenticated Actions artifact download did not return a bounded redirect");
  }
  const signedUrl = new URL(location);
  if (signedUrl.protocol !== "https:" || signedUrl.username !== "" || signedUrl.password !== "") {
    throw new Error("Actions signed artifact URL is invalid");
  }
  let archiveResponse: Response;
  try {
    archiveResponse = await fetch(signedUrl, { redirect: "error" });
  } catch {
    throw new Error("Actions signed artifact download failed");
  }
  if (!archiveResponse.ok || archiveResponse.url !== signedUrl.href) throw new Error("Actions signed artifact download failed");
  const archive = await readBoundedResponse(archiveResponse, MAX_ACTIONS_ARCHIVE_BYTES);
  if (`sha256:${sha256(archive)}` !== expectedDigest) throw new Error("Actions artifact archive bytes differ from authenticated digest");
  const receipt: VerifiedActionsArtifactReceipt = Object.freeze({
    artifactId: input.artifactId,
    artifactDigest: expectedDigest,
    repository: input.repository,
    repositoryId: repository.id as number,
    runId: input.runId,
    headSha: input.headSha,
    archiveBytes: archive.length,
  });
  return Object.freeze({ receipt, entries: parseActionsZip(archive) });
}

async function materialFromDirectory(input: BridgeReleaseImportInput): Promise<BridgeReleaseMaterial> {
  const root = resolve(input.artifactRoot);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("Bridge release artifact root is unsafe");
  const [manifestBytes, envelopeBytes, bridgeBytes, addinBytes, provenanceBytes, trustedBytes] = await Promise.all([
    regularFile(resolve(root, "bridge-manifest.json"), MAX_API_RESPONSE_BYTES),
    regularFile(resolve(root, "bridge-manifest.signature.json"), MAX_API_RESPONSE_BYTES),
    regularFile(resolve(root, "bridge.zip"), 1024 * 1024 * 1024),
    regularFile(resolve(root, "addin.zip"), 1024 * 1024 * 1024),
    regularFile(resolve(root, "provenance.json"), MAX_API_RESPONSE_BYTES),
    regularFile(resolve(input.trustedKeysPath), MAX_API_RESPONSE_BYTES),
  ]);
  return Object.freeze({ manifestBytes, envelopeBytes, bridgeBytes, addinBytes, provenanceBytes, trustedBytes });
}

async function importMaterial(
  input: BridgeReleaseImportAuthority,
  material: BridgeReleaseMaterial,
  dependencies: { readonly publisher: BridgeReleasePublisher; readonly objects: FilesystemBridgeReleaseObjectStore },
): Promise<Readonly<{ readonly releaseId: string; readonly manifestDigest: string; readonly componentDigests: Readonly<Record<"bridge" | "addin", string>> }>> {
  const manifest = JSON.parse(material.manifestBytes.toString("utf8")) as JsonValue;
  const signatureEnvelope = JSON.parse(material.envelopeBytes.toString("utf8")) as JsonValue;
  const provenance = JSON.parse(material.provenanceBytes.toString("utf8")) as Provenance;
  if (!record(provenance) || provenance.schemaVersion !== 1 ||
      provenance.repository !== input.expectedRepository || provenance.headSha !== input.expectedHeadSha ||
      !/^[0-9a-f]{40}$/u.test(provenance.headSha) || !/^[0-9a-f]{40}$/u.test(provenance.headTree) ||
      !/^[0-9a-f-]{36}$/u.test(provenance.releaseId)) {
    throw new Error("Bridge release provenance differs from the authenticated import authority");
  }
  const trustedKeys = parseBridgeManifestTrustedKeys(JSON.parse(material.trustedBytes.toString("utf8")));
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
  const bridge = component("bridge", material.bridgeBytes);
  const addin = component("addin", material.addinBytes);
  await dependencies.objects.putCreateOnly({ key: bridge.storageKey, bytes: material.bridgeBytes, sha256: bridge.sha256, sizeBytes: bridge.sizeBytes });
  await dependencies.objects.putCreateOnly({ key: addin.storageKey, bytes: material.addinBytes, sha256: addin.sha256, sizeBytes: addin.sizeBytes });
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
  await dependencies.publisher.publishBridgeUpdateRelease({ release, tenantIds: input.tenantIds, deviceRings: input.deviceRings });
  return Object.freeze({
    releaseId: release.id,
    manifestDigest: release.manifestDigest,
    componentDigests: Object.freeze({ bridge: bridge.sha256, addin: addin.sha256 }),
  });
}

export async function importBridgeRelease(
  input: BridgeReleaseImportInput,
  dependencies: { readonly publisher: BridgeReleasePublisher; readonly objects: FilesystemBridgeReleaseObjectStore },
) {
  return await importMaterial(input, await materialFromDirectory(input), dependencies);
}

export async function importBridgeReleaseFromActions(
  input: ActionsBridgeReleaseImportInput,
  dependencies: { readonly publisher: BridgeReleasePublisher; readonly objects: FilesystemBridgeReleaseObjectStore },
) {
  const verified = await verifyActionsArtifactSource({
    artifactId: input.artifactId,
    artifactDigest: input.artifactDigest,
    repository: input.expectedRepository,
    runId: input.runId,
    headSha: input.expectedHeadSha,
    githubToken: input.githubToken,
  });
  const trustedBytes = await regularFile(resolve(input.trustedKeysPath), MAX_API_RESPONSE_BYTES);
  const result = await importMaterial(input, {
    manifestBytes: verified.entries["bridge-manifest.json"]!,
    envelopeBytes: verified.entries["bridge-manifest.signature.json"]!,
    bridgeBytes: verified.entries["bridge.zip"]!,
    addinBytes: verified.entries["addin.zip"]!,
    provenanceBytes: verified.entries["provenance.json"]!,
    trustedBytes,
  }, dependencies);
  return Object.freeze({ ...result, actionsArtifact: verified.receipt });
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
  const githubToken = process.env.GITHUB_TOKEN;
  if (args.publish !== "true" || args.confirm !== "PUBLISH_BRIDGE_UPDATE" || !databaseUrl || !githubToken ||
      !args["object-store-root"] || !args["trusted-keys"] || !args["tenant-ids"] || !args["artifact-id"] ||
      !args["artifact-digest"] || !args.repository || !args["run-id"] || !args["head-sha"] || !args["released-by"]) {
    throw new Error("Bridge release import requires explicit publish controls and authenticated Actions provenance");
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
    const result = await importBridgeReleaseFromActions({
      artifactId: args["artifact-id"], artifactDigest: args["artifact-digest"], runId: args["run-id"],
      githubToken, expectedRepository: args.repository, expectedHeadSha: args["head-sha"], trustedKeysPath: args["trusted-keys"],
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
