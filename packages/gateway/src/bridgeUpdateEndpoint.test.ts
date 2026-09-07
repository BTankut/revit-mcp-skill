import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { GATEWAY_AUTH_CONTRACT_VERSION, type DeviceAuthContext, type IdentityPort } from "./authContext.js";
import { FilesystemBridgeReleaseObjectStore } from "./bridgeReleaseObjectStore.js";
import { createBridgeUpdateEndpoint } from "./bridgeUpdateEndpoint.js";
import type { BridgeUpdateReleaseAuthority } from "./releaseChannelStore.js";

const tenantId = "10000000-0000-4000-8000-000000000001";
const deviceId = "20000000-0000-4000-8000-000000000001";
const fingerprint = `sha256:${"a".repeat(64)}` as const;
const releaseId = "30000000-0000-4000-8000-000000000001";

function identity(status: DeviceAuthContext["deviceStatus"] = "active"): IdentityPort {
  return Object.freeze({
    kind: "oidc" as const,
    async authenticateNorthRequest() { return { ok: false as const, error: { code: "unauthenticated" as const, message: "unused" } }; },
    async authenticateDevice(input) {
      if (input.deviceToken !== "device-token" || input.claimedDeviceId !== deviceId || input.machineFingerprint !== fingerprint) {
        return { ok: false as const, error: { code: "unauthenticated" as const, message: "refused" } };
      }
      return { ok: true as const, value: Object.freeze({
        contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
        actor: Object.freeze({ type: "device" as const, tenantId, userId: "40000000-0000-4000-8000-000000000001", deviceId, seatId: "50000000-0000-4000-8000-000000000001" }),
        connectionId: input.connectionId, deviceStatus: status, machineFingerprint: fingerprint,
        grantedSessionCapabilities: Object.freeze([]), deviceTokenDigest: `sha256:${"b".repeat(64)}` as const,
      }) };
    },
  });
}

describe("Bridge update endpoint", () => {
  it("derives tenant from M5 and serves only the current authenticated release", async () => {
    const root = await mkdtemp(join(tmpdir(), "revagent-update-endpoint-"));
    const objects = new FilesystemBridgeReleaseObjectStore(root);
    const bridge = Buffer.from("bridge-zip");
    const addin = Buffer.from("addin-zip");
    const bridgeSha = createHash("sha256").update(bridge).digest("hex");
    const addinSha = createHash("sha256").update(addin).digest("hex");
    const bridgeKey = objects.storageKey({ releaseId, component: "bridge", sha256: bridgeSha });
    const addinKey = objects.storageKey({ releaseId, component: "addin", sha256: addinSha });
    await objects.putCreateOnly({ key: bridgeKey, bytes: bridge, sha256: bridgeSha, sizeBytes: bridge.length });
    await objects.putCreateOnly({ key: addinKey, bytes: addin, sha256: addinSha, sizeBytes: addin.length });
    const manifest = { schemaVersion: 1, channel: "stable", version: "3.0.0", releaseSequence: 42,
      components: [
        { name: "bridge", version: "3.0.0", sha256: bridgeSha, sizeBytes: bridge.length, url: `https://gateway.test/bridge/update/artifact/${releaseId}/bridge` },
        { name: "addin", version: "3.0.0", sha256: addinSha, sizeBytes: addin.length, url: `https://gateway.test/bridge/update/artifact/${releaseId}/addin` },
      ], rolloutPercent: 100, minSupportedVersion: "2.0.0", notes: "test" } as const;
    const release = Object.freeze({
      id: releaseId, channel: "stable" as const, version: "3.0.0", releaseSequence: 42, rollbackFloorSequence: 42,
      manifest, signatureEnvelope: { keyId: "generated" }, manifestDigest: "c".repeat(64), signingKeyId: "generated",
      components: Object.freeze({
        bridge: Object.freeze({ name: "bridge" as const, version: "3.0.0", storageKey: bridgeKey, sha256: bridgeSha, sizeBytes: bridge.length, url: manifest.components[0].url }),
        addin: Object.freeze({ name: "addin" as const, version: "3.0.0", storageKey: addinKey, sha256: addinSha, sizeBytes: addin.length, url: manifest.components[1].url }),
      }), rolloutPercent: 100, minSupportedVersion: "2.0.0", releasedAtMs: 1, releasedBy: "generated",
    }) as unknown as BridgeUpdateReleaseAuthority;
    const app = Fastify();
    createBridgeUpdateEndpoint({ identity: identity(), objects,
      releases: { async readBridgeUpdateForDevice(input) { return input.tenantId === tenantId && input.deviceId === deviceId ? { release, deviceRing: 7 } : null; } },
      verifyManifest: () => ({ keyId: "generated", contentSha256: "c".repeat(64) }),
    }).mount(app);
    try {
      const headers = { authorization: "Bearer device-token", "x-revagent-device-id": deviceId, "x-revagent-machine-fingerprint": fingerprint };
      const response = await app.inject({ method: "GET", url: "/bridge/update/manifest", headers });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ manifest, signatureEnvelope: { keyId: "generated" }, deviceRing: 7 });
      const artifact = await app.inject({ method: "GET", url: `/bridge/update/artifact/${releaseId}/bridge`, headers });
      expect(artifact.statusCode).toBe(200);
      expect(artifact.rawPayload).toEqual(bridge);
      expect((await app.inject({ method: "GET", url: `/bridge/update/artifact/${releaseId}/bridge`, headers: { ...headers, range: "bytes=0-1" } })).statusCode).toBe(404);
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });

  it.each([undefined, "wrong"])("hides releases for absent or wrong bearer %s", async (bearer) => {
    const root = await mkdtemp(join(tmpdir(), "revagent-update-endpoint-"));
    const app = Fastify();
    createBridgeUpdateEndpoint({ identity: identity(), objects: new FilesystemBridgeReleaseObjectStore(root),
      releases: { async readBridgeUpdateForDevice() { throw new Error("must not reach release authority"); } },
      verifyManifest: () => { throw new Error("must not verify"); },
    }).mount(app);
    try {
      const response = await app.inject({ method: "GET", url: "/bridge/update/manifest", headers: {
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        "x-revagent-device-id": deviceId, "x-revagent-machine-fingerprint": fingerprint,
      } });
      expect(response.statusCode).toBe(404);
    } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
  });
});
