import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeJson, type JsonValue } from "@revagent/protocol";

import {
  bridgeManifestDigest,
  parseBridgeManifestTrustedKeys,
  verifyBridgeManifestSignature,
} from "./bridgeManifestSignature.js";

function fixture() {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const xml = `<RSAKeyValue><Modulus>${Buffer.from(jwk.n!, "base64url").toString("base64")}</Modulus><Exponent>${Buffer.from(jwk.e!, "base64url").toString("base64")}</Exponent></RSAKeyValue>`;
  const fingerprint = createHash("sha256").update(xml).digest("hex");
  const manifest = {
    schemaVersion: 1, channel: "pilot", version: "3.0.0", releaseSequence: 42,
    components: [
      { name: "bridge", version: "3.0.0", sha256: "a".repeat(64), sizeBytes: 10, url: "https://gateway.test/bridge/update/artifact/42/bridge" },
      { name: "addin", version: "3.0.0", sha256: "b".repeat(64), sizeBytes: 20, url: "https://gateway.test/bridge/update/artifact/42/addin" },
    ], rolloutPercent: 100, minSupportedVersion: "2.0.0", notes: "fixture",
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
  return { manifest, envelope, xml, fingerprint };
}

describe("bridge manifest signature", () => {
  it("verifies the exact detached nine-field projection", () => {
    const value = fixture();
    const trusted = parseBridgeManifestTrustedKeys({ trustedKeys: { "generated-p3t12": {
      publicKeyXml: value.xml, publicKeyFingerprint: value.fingerprint, algorithm: "RS256",
    } } });
    expect(verifyBridgeManifestSignature({ manifest: value.manifest, envelope: value.envelope, trustedKeys: trusted }))
      .toEqual({ keyId: "generated-p3t12", contentSha256: bridgeManifestDigest(value.manifest) });
  });

  it("refuses tamper, extra envelope fields, and wrong fingerprint", () => {
    const value = fixture();
    const trusted = parseBridgeManifestTrustedKeys({ "generated-p3t12": {
      publicKeyXml: value.xml, publicKeyFingerprint: value.fingerprint, algorithm: "RS256",
    } });
    expect(() => verifyBridgeManifestSignature({ manifest: { ...(value.manifest as object), releaseSequence: 43 } as JsonValue, envelope: value.envelope, trustedKeys: trusted })).toThrow(/content digest/u);
    expect(() => verifyBridgeManifestSignature({ manifest: value.manifest, envelope: { ...value.envelope, unsigned: true }, trustedKeys: trusted })).toThrow(/envelope/u);
    expect(() => verifyBridgeManifestSignature({ manifest: value.manifest, envelope: { ...value.envelope, publicKeyFingerprint: "0".repeat(64) }, trustedKeys: trusted })).toThrow(/fingerprint/u);
  });
});
