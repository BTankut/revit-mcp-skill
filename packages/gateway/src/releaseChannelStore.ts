import { createHash, timingSafeEqual } from "node:crypto";

import { canonicalizeJson, type JsonValue } from "@revagent/protocol";

import type { ResultObjectStore } from "./resultReferenceStore.js";

export type BridgeReleaseChannel = "stable" | "pilot";

export interface BridgeReleaseContract {
  readonly id: string;
  readonly version: string;
  readonly channel: BridgeReleaseChannel;
  readonly artifactStorageKey: string;
  readonly artifactSha256: `sha256:${string}`;
  readonly signature: string;
  readonly signingKeyId: string;
  readonly minSupportedVersion: string;
  readonly releasedAtMs: number;
  readonly releasedBy: string;
}

export interface ReleaseChannelContract {
  readonly channel: BridgeReleaseChannel;
  readonly currentReleaseId: string;
  readonly stagedRollout: Readonly<{
    readonly tenantIds: readonly string[];
    readonly revision: number;
  }>;
}

export interface ReleaseChannelAuditRecord {
  readonly eventType: "registry.published";
  readonly entity: "bridge_release";
  readonly releaseId: string;
  readonly channel: BridgeReleaseChannel;
  readonly actorId: string;
}

export interface ReleaseSignatureVerifier {
  verify(input: { readonly signingKeyId: string; readonly canonicalManifest: string; readonly signature: string }): boolean;
}

export type BridgeUpdateComponentName = "bridge" | "addin";

export interface BridgeUpdateComponentAuthority {
  readonly name: BridgeUpdateComponentName;
  readonly version: string;
  readonly storageKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly url: string;
}

export interface BridgeUpdateReleaseAuthority {
  readonly id: string;
  readonly channel: BridgeReleaseChannel;
  readonly version: string;
  readonly releaseSequence: number;
  readonly rollbackFloorSequence: number;
  readonly manifest: JsonValue;
  readonly signatureEnvelope: JsonValue;
  readonly manifestDigest: string;
  readonly signingKeyId: string;
  readonly components: Readonly<Record<BridgeUpdateComponentName, BridgeUpdateComponentAuthority>>;
  readonly rolloutPercent: number;
  readonly minSupportedVersion: string;
  readonly releasedAtMs: number;
  readonly releasedBy: string;
}

export interface BridgeUpdateDeviceRingAssignment {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly ring: number;
}

export function validateBridgeUpdateReleaseAuthority(release: BridgeUpdateReleaseAuthority): void {
  if (!validId(release.id) || !validVersion(release.version) ||
      release.channel !== "stable" && release.channel !== "pilot" ||
      !Number.isSafeInteger(release.releaseSequence) || release.releaseSequence < 1 ||
      !Number.isSafeInteger(release.rollbackFloorSequence) || release.rollbackFloorSequence < 0 ||
      release.rollbackFloorSequence > release.releaseSequence ||
      !/^[0-9a-f]{64}$/u.test(release.manifestDigest) || !validId(release.signingKeyId) ||
      !Number.isSafeInteger(release.rolloutPercent) || release.rolloutPercent < 0 || release.rolloutPercent > 100 ||
      !validVersion(release.minSupportedVersion) || !Number.isSafeInteger(release.releasedAtMs) ||
      release.releasedAtMs < 1 || !validId(release.releasedBy)) {
    throw new Error("bridge update release authority is invalid");
  }
  for (const name of ["bridge", "addin"] as const) {
    const component = release.components[name];
    if (component.name !== name || component.version !== release.version ||
        !validArtifactKey(`releases/bridge/${component.storageKey}`) ||
        !/^[0-9a-f]{64}$/u.test(component.sha256) ||
        !Number.isSafeInteger(component.sizeBytes) || component.sizeBytes < 1 ||
        !URL.canParse(component.url) || new URL(component.url).protocol !== "https:") {
      throw new Error("bridge update component authority is invalid");
    }
  }
}

export interface ReleaseChannelStoreOptions {
  readonly objects: ResultObjectStore;
  readonly signatureVerifier: ReleaseSignatureVerifier;
  readonly pinnedSigningKeyIds: readonly string[];
}

function validId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);
}

function validVersion(value: string): boolean {
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u.test(value);
}

function validArtifactKey(value: string): boolean {
  return /^releases\/bridge\/[A-Za-z0-9._/-]{1,500}$/u.test(value) && !value.includes("..") && !value.includes("//");
}

function digest(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function immutableRelease(value: BridgeReleaseContract): BridgeReleaseContract {
  return Object.freeze({ ...value });
}

function immutableChannel(value: ReleaseChannelContract): ReleaseChannelContract {
  return Object.freeze({
    ...value,
    stagedRollout: Object.freeze({
      tenantIds: Object.freeze([...value.stagedRollout.tenantIds].sort()),
      revision: value.stagedRollout.revision,
    }),
  });
}

export function canonicalBridgeReleaseManifest(release: Omit<BridgeReleaseContract, "signature">): string {
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
  } as JsonValue);
}

/**
 * Release records are vendor-catalog data, but staged channel delivery is
 * explicitly tenant-scoped. A caller outside the rollout receives no catalog
 * existence oracle for the channel's current release.
 */
export class ReleaseChannelStore {
  readonly #objects: ResultObjectStore;
  readonly #signatureVerifier: ReleaseSignatureVerifier;
  readonly #pinnedSigningKeyIds: ReadonlySet<string>;
  readonly #releases = new Map<string, BridgeReleaseContract>();
  readonly #channels = new Map<BridgeReleaseChannel, ReleaseChannelContract>();

  public constructor(options: ReleaseChannelStoreOptions) {
    if (options.pinnedSigningKeyIds.length === 0 || options.pinnedSigningKeyIds.some((key) => !validId(key))) {
      throw new Error("release signing-key pin set is invalid");
    }
    this.#objects = options.objects;
    this.#signatureVerifier = options.signatureVerifier;
    this.#pinnedSigningKeyIds = new Set(options.pinnedSigningKeyIds);
  }

  public async publish(input: { readonly release: BridgeReleaseContract }): Promise<BridgeReleaseContract> {
    const release = immutableRelease(input.release);
    if (!validId(release.id) || !validVersion(release.version) || !validArtifactKey(release.artifactStorageKey) ||
      !/^sha256:[0-9a-f]{64}$/u.test(release.artifactSha256) || !validId(release.signingKeyId) ||
      !validVersion(release.minSupportedVersion) || !validId(release.releasedBy) ||
      !Number.isSafeInteger(release.releasedAtMs) || release.releasedAtMs < 1 || release.signature.length < 1) {
      throw new Error("bridge release contract is invalid");
    }
    if (!this.#pinnedSigningKeyIds.has(release.signingKeyId)) {
      throw new Error("bridge release signing key is not pinned");
    }
    const object = await this.#objects.get({ key: release.artifactStorageKey });
    if (object === null || !timingSafeEqual(Buffer.from(digest(object)), Buffer.from(release.artifactSha256))) {
      throw new Error("bridge release artifact digest does not match stored artifact");
    }
    const unsigned: Omit<BridgeReleaseContract, "signature"> = {
      id: release.id,
      version: release.version,
      channel: release.channel,
      artifactStorageKey: release.artifactStorageKey,
      artifactSha256: release.artifactSha256,
      signingKeyId: release.signingKeyId,
      minSupportedVersion: release.minSupportedVersion,
      releasedAtMs: release.releasedAtMs,
      releasedBy: release.releasedBy,
    };
    if (!this.#signatureVerifier.verify({
      signingKeyId: release.signingKeyId,
      canonicalManifest: canonicalBridgeReleaseManifest(unsigned),
      signature: release.signature,
    })) {
      throw new Error("bridge release manifest signature is invalid");
    }
    const prior = this.#releases.get(release.id);
    if (prior !== undefined) {
      if (canonicalizeJson(prior as unknown as JsonValue) !== canonicalizeJson(release as unknown as JsonValue)) {
        throw new Error("bridge release id is immutable");
      }
      return prior;
    }
    this.#releases.set(release.id, release);
    return release;
  }

  public flipChannel(input: {
    readonly channel: BridgeReleaseChannel;
    readonly releaseId: string;
    readonly tenantIds: readonly string[];
    readonly actorId: string;
  }): Readonly<{ readonly contract: ReleaseChannelContract; readonly audit: ReleaseChannelAuditRecord }> {
    if (!validId(input.actorId) || input.tenantIds.length === 0 || input.tenantIds.some((tenantId) => !validId(tenantId))) {
      throw new Error("release channel rollout scope is invalid");
    }
    const release = this.#releases.get(input.releaseId);
    if (release === undefined || release.channel !== input.channel) throw new Error("release is not published for the requested channel");
    const prior = this.#channels.get(input.channel);
    const contract = immutableChannel({
      channel: input.channel,
      currentReleaseId: release.id,
      stagedRollout: Object.freeze({
        tenantIds: input.tenantIds,
        revision: (prior?.stagedRollout.revision ?? 0) + 1,
      }),
    });
    this.#channels.set(input.channel, contract);
    return Object.freeze({
      contract,
      audit: Object.freeze({
        eventType: "registry.published" as const,
        entity: "bridge_release" as const,
        releaseId: release.id,
        channel: input.channel,
        actorId: input.actorId,
      }),
    });
  }

  public readForTenant(input: { readonly tenantId: string; readonly channel: BridgeReleaseChannel }): Readonly<{
    readonly channel: ReleaseChannelContract;
    readonly release: BridgeReleaseContract;
  }> | null {
    if (!validId(input.tenantId)) return null;
    const channel = this.#channels.get(input.channel);
    if (channel === undefined || !channel.stagedRollout.tenantIds.includes(input.tenantId)) return null;
    const release = this.#releases.get(channel.currentReleaseId);
    return release === undefined ? null : Object.freeze({ channel, release });
  }
}
