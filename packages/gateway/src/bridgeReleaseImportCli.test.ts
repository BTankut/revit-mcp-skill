import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalizeJson, type JsonValue } from "@revagent/protocol";
import { describe, expect, it, vi } from "vitest";

import { bridgeManifestDigest } from "./bridgeManifestSignature.js";
import { importBridgeRelease, type BridgeReleasePublisher } from "./bridgeReleaseImportCli.js";
import { FilesystemBridgeReleaseObjectStore } from "./bridgeReleaseObjectStore.js";

describe("Bridge release import", () => {
  it("verifies generated-key artifacts before the one publisher transaction", async () => {
    const root = await mkdtemp(join(tmpdir(), "revagent-release-import-"));
    const artifacts = join(root, "artifact");
    await mkdir(artifacts);
    try {
      const bridge = Buffer.from("generated bridge zip");
      const addin = Buffer.from("generated addin zip");
      const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const jwk = pair.publicKey.export({ format: "jwk" });
      const xml = `<RSAKeyValue><Modulus>${Buffer.from(jwk.n!, "base64url").toString("base64")}</Modulus><Exponent>${Buffer.from(jwk.e!, "base64url").toString("base64")}</Exponent></RSAKeyValue>`;
      const fingerprint = createHash("sha256").update(xml).digest("hex");
      const releaseId = "30000000-0000-4000-8000-000000000001";
      const manifest = {
        schemaVersion: 1, channel: "pilot", version: "3.0.0", releaseSequence: 42,
        components: [
          { name: "bridge", version: "3.0.0", sha256: createHash("sha256").update(bridge).digest("hex"), sizeBytes: bridge.length, url: `https://gateway.test/bridge/update/artifact/${releaseId}/bridge` },
          { name: "addin", version: "3.0.0", sha256: createHash("sha256").update(addin).digest("hex"), sizeBytes: addin.length, url: `https://gateway.test/bridge/update/artifact/${releaseId}/addin` },
        ], rolloutPercent: 100, minSupportedVersion: "2.0.0", notes: "generated fixture",
      } as JsonValue;
      const envelope: Record<string, JsonValue> = {
        schemaVersion: 1, app: "revAgent", signedObject: "bridge-manifest", algorithm: "RS256",
        keyId: "generated-p3t12", publicKeyFingerprint: fingerprint,
        canonicalization: "RFC8785-JCS-SHA256-v1", contentSha256: bridgeManifestDigest(manifest),
        createdAtUtc: "2026-09-07T12:34:56.0000000Z", signature: "",
      };
      const projection = { ...envelope };
      delete projection.signature;
      envelope.signature = sign("RSA-SHA256", Buffer.from(canonicalizeJson(projection)), pair.privateKey).toString("base64");
      const artifactDigest = `sha256:${"d".repeat(64)}`;
      await Promise.all([
        writeFile(join(artifacts, "bridge.zip"), bridge), writeFile(join(artifacts, "addin.zip"), addin),
        writeFile(join(artifacts, "bridge-manifest.json"), canonicalizeJson(manifest)),
        writeFile(join(artifacts, "bridge-manifest.signature.json"), canonicalizeJson(envelope)),
        writeFile(join(artifacts, "provenance.json"), JSON.stringify({ schemaVersion: 1, releaseId,
          repository: "BTankut/revAgent", headSha: "a".repeat(40), headTree: "b".repeat(40),
          createdAtUtc: "2026-09-07T12:34:56.0000000Z" })),
        writeFile(join(root, "trusted.json"), JSON.stringify({ trustedKeys: { "generated-p3t12": {
          publicKeyXml: xml, publicKeyFingerprint: fingerprint, algorithm: "RS256",
        } } })),
      ]);
      let publishCount = 0;
      let published: Parameters<BridgeReleasePublisher["publishBridgeUpdateRelease"]>[0] | undefined;
      const publisher: BridgeReleasePublisher = {
        async publishBridgeUpdateRelease(input) {
          publishCount += 1;
          published = input;
        },
      };
      const objects = new FilesystemBridgeReleaseObjectStore(root);
      const result = await importBridgeRelease({ artifactRoot: artifacts, expectedArtifactId: "12345",
        expectedArtifactDigest: artifactDigest, expectedRepository: "BTankut/revAgent", expectedHeadSha: "a".repeat(40),
        trustedKeysPath: join(root, "trusted.json"), tenantIds: ["10000000-0000-4000-8000-000000000001"],
        deviceRings: [{ tenantId: "10000000-0000-4000-8000-000000000001", deviceId: "20000000-0000-4000-8000-000000000001", ring: 0 }],
        releasedBy: "github-actions",
      }, { publisher, objects });
      expect(result.releaseId).toBe(releaseId);
      expect(publishCount).toBe(1);
      if (published === undefined) throw new Error("publisher fixture did not capture the release");
      expect(published.release.components.bridge.sha256).toBe(createHash("sha256").update(bridge).digest("hex"));
      expect(published.release.components.addin.sha256).toBe(createHash("sha256").update(addin).digest("hex"));
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("does not publish when provenance or artifact bytes differ", async () => {
    const publisher = { publishBridgeUpdateRelease: vi.fn(async () => undefined) };
    await expect(importBridgeRelease({ artifactRoot: "missing", expectedArtifactId: "x", expectedArtifactDigest: "y",
      expectedRepository: "repo", expectedHeadSha: "a".repeat(40), trustedKeysPath: "missing",
      tenantIds: [], deviceRings: [], releasedBy: "test",
    }, { publisher, objects: new FilesystemBridgeReleaseObjectStore("missing") })).rejects.toThrow();
    expect(publisher.publishBridgeUpdateRelease).not.toHaveBeenCalled();
  });
});
