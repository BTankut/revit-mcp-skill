import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

import { canonicalizeJson, type JsonValue } from "@revagent/protocol";

export const BRIDGE_MANIFEST_SIGNED_OBJECT = "bridge-manifest" as const;
export const BRIDGE_MANIFEST_CANONICALIZATION =
  "RFC8785-JCS-SHA256-v1" as const;

export interface BridgeManifestTrustedKey {
  readonly publicKeyXml: string;
  readonly publicKeyFingerprint: string;
  readonly algorithm: "RS256";
}

export interface BridgeManifestSignatureEnvelope {
  readonly schemaVersion: 1;
  readonly app: "revAgent";
  readonly signedObject: typeof BRIDGE_MANIFEST_SIGNED_OBJECT;
  readonly algorithm: "RS256";
  readonly keyId: string;
  readonly publicKeyFingerprint: string;
  readonly canonicalization: typeof BRIDGE_MANIFEST_CANONICALIZATION;
  readonly contentSha256: string;
  readonly createdAtUtc: string;
  readonly signature: string;
}

const ENVELOPE_FIELDS = Object.freeze([
  "schemaVersion", "app", "signedObject", "algorithm", "keyId",
  "publicKeyFingerprint", "canonicalization", "contentSha256",
  "createdAtUtc", "signature",
] as const);
const PROJECTION_FIELDS = ENVELOPE_FIELDS.slice(0, 9);
const HEX64 = /^[0-9a-f]{64}$/iu;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u;
const MANIFEST_FIELDS = new Set(["schemaVersion", "channel", "version", "releaseSequence", "components", "rolloutPercent", "minSupportedVersion", "notes"]);
const COMPONENT_FIELDS = new Set(["name", "version", "sha256", "sizeBytes", "url"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function parseRsaXml(xml: string): { readonly key: KeyObject; readonly fingerprint: string } {
  if (Buffer.byteLength(xml, "utf8") > 64 * 1024 || xml.trim().length === 0 ||
      xml.includes("<?") || xml.includes("<!")) {
    throw new Error("bridge trusted RSA XML is invalid");
  }
  const normalized = xml.trim().replace(/\s+/gu, "");
  const root = /^<RSAKeyValue>(.*)<\/RSAKeyValue>$/u.exec(normalized);
  if (root === null) throw new Error("bridge trusted RSA XML root is invalid");
  const children = [...root[1]!.matchAll(/<([A-Za-z]+)>([^<]*)<\/\1>/gu)];
  if (children.length !== 2 || children.map((match) => match[0]).join("") !== root[1] ||
      children.filter((match) => match[1] === "Modulus").length !== 1 ||
      children.filter((match) => match[1] === "Exponent").length !== 1) {
    throw new Error("bridge trusted RSA XML fields are invalid");
  }
  const read = (name: string): Buffer => {
    const encoded = children.find((match) => match[1] === name)?.[2] ?? "";
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
      throw new Error("bridge trusted RSA XML base64 is invalid");
    }
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length === 0 || decoded.toString("base64") !== encoded) {
      throw new Error("bridge trusted RSA XML contains an empty or non-canonical value");
    }
    return decoded;
  };
  const modulus = read("Modulus");
  const exponent = read("Exponent");
  return Object.freeze({
    key: createPublicKey({
      key: { kty: "RSA", n: base64Url(modulus), e: base64Url(exponent) },
      format: "jwk",
    }),
    fingerprint: createHash("sha256").update(normalized, "utf8").digest("hex"),
  });
}

export function bridgeManifestDigest(manifest: JsonValue): string {
  return createHash("sha256")
    .update(canonicalizeJson(manifest), "utf8")
    .digest("hex");
}

export function validateBridgeUpdateManifest(manifest: JsonValue): void {
  if (!isRecord(manifest) || Object.keys(manifest).length !== MANIFEST_FIELDS.size ||
      Object.keys(manifest).some((field) => !MANIFEST_FIELDS.has(field)) ||
      manifest.schemaVersion !== 1 || manifest.channel !== "stable" && manifest.channel !== "pilot" ||
      typeof manifest.version !== "string" || !VERSION.test(manifest.version) ||
      !Number.isSafeInteger(manifest.releaseSequence) || (manifest.releaseSequence as number) < 1 ||
      !Number.isSafeInteger(manifest.rolloutPercent) || (manifest.rolloutPercent as number) < 0 || (manifest.rolloutPercent as number) > 100 ||
      typeof manifest.minSupportedVersion !== "string" || !VERSION.test(manifest.minSupportedVersion) ||
      typeof manifest.notes !== "string" || manifest.notes.length > 4096 ||
      !Array.isArray(manifest.components) || manifest.components.length !== 2) {
    throw new Error("bridge update manifest shape is invalid");
  }
  const names: string[] = [];
  for (const component of manifest.components) {
    if (!isRecord(component) || Object.keys(component).length !== COMPONENT_FIELDS.size ||
        Object.keys(component).some((field) => !COMPONENT_FIELDS.has(field)) ||
        component.name !== "bridge" && component.name !== "addin" ||
        typeof component.version !== "string" || component.version !== manifest.version ||
        typeof component.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(component.sha256) ||
        !Number.isSafeInteger(component.sizeBytes) || (component.sizeBytes as number) < 1 ||
        typeof component.url !== "string" || !URL.canParse(component.url)) {
      throw new Error("bridge update manifest component is invalid");
    }
    const url = new URL(component.url);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
      throw new Error("bridge update manifest component URL is invalid");
    }
    names.push(component.name);
  }
  if (names.sort().join(",") !== "addin,bridge") throw new Error("bridge update manifest component set is invalid");
}

export function verifyBridgeManifestSignature(input: {
  readonly manifest: JsonValue;
  readonly envelope: unknown;
  readonly trustedKeys: Readonly<Record<string, BridgeManifestTrustedKey>>;
}): Readonly<{ readonly keyId: string; readonly contentSha256: string }> {
  validateBridgeUpdateManifest(input.manifest);
  const { envelope } = input;
  if (!isRecord(envelope) || Object.keys(envelope).length !== ENVELOPE_FIELDS.length ||
      Object.keys(envelope).some((field) => !ENVELOPE_FIELDS.includes(field as never)) ||
      envelope.schemaVersion !== 1 || envelope.app !== "revAgent" ||
      envelope.signedObject !== BRIDGE_MANIFEST_SIGNED_OBJECT || envelope.algorithm !== "RS256" ||
      envelope.canonicalization !== BRIDGE_MANIFEST_CANONICALIZATION ||
      typeof envelope.keyId !== "string" || !IDENTIFIER.test(envelope.keyId) ||
      typeof envelope.publicKeyFingerprint !== "string" || !HEX64.test(envelope.publicKeyFingerprint) ||
      typeof envelope.contentSha256 !== "string" || !HEX64.test(envelope.contentSha256) ||
      typeof envelope.createdAtUtc !== "string" || !UTC_TIMESTAMP.test(envelope.createdAtUtc) ||
      typeof envelope.signature !== "string") {
    throw new Error("bridge manifest signature envelope is invalid");
  }
  const trusted = input.trustedKeys[envelope.keyId];
  if (trusted === undefined || trusted.algorithm !== "RS256") {
    throw new Error("bridge manifest signing key is not trusted");
  }
  const parsed = parseRsaXml(trusted.publicKeyXml);
  if (!HEX64.test(trusted.publicKeyFingerprint) ||
      !timingSafeEqual(Buffer.from(parsed.fingerprint, "hex"), Buffer.from(trusted.publicKeyFingerprint, "hex")) ||
      !timingSafeEqual(Buffer.from(parsed.fingerprint, "hex"), Buffer.from(envelope.publicKeyFingerprint, "hex"))) {
    throw new Error("bridge manifest public-key fingerprint is invalid");
  }
  const actualDigest = bridgeManifestDigest(input.manifest);
  if (!timingSafeEqual(Buffer.from(actualDigest, "hex"), Buffer.from(envelope.contentSha256, "hex"))) {
    throw new Error("bridge manifest content digest is invalid");
  }
  const projection: Record<string, JsonValue> = {};
  for (const field of PROJECTION_FIELDS) projection[field] = envelope[field] as JsonValue;
  let signature: Buffer;
  try {
    signature = Buffer.from(envelope.signature, "base64");
  } catch {
    throw new Error("bridge manifest signature encoding is invalid");
  }
  if (signature.length === 0 || signature.toString("base64") !== envelope.signature ||
      !verifySignature("RSA-SHA256", Buffer.from(canonicalizeJson(projection), "utf8"), parsed.key, signature)) {
    throw new Error("bridge manifest signature verification failed");
  }
  return Object.freeze({ keyId: envelope.keyId, contentSha256: actualDigest });
}

export function parseBridgeManifestTrustedKeys(document: unknown): Readonly<Record<string, BridgeManifestTrustedKey>> {
  if (!isRecord(document)) throw new Error("bridge trusted-key document is invalid");
  const candidate = isRecord(document.trustedKeys) ? document.trustedKeys : document;
  const parsed: Record<string, BridgeManifestTrustedKey> = {};
  for (const [keyId, value] of Object.entries(candidate)) {
    if (!IDENTIFIER.test(keyId) || !isRecord(value) || Object.keys(value).length !== 3 ||
        typeof value.publicKeyXml !== "string" || typeof value.publicKeyFingerprint !== "string" ||
        value.algorithm !== "RS256") {
      throw new Error("bridge trusted-key entry is invalid");
    }
    parsed[keyId] = Object.freeze({
      publicKeyXml: value.publicKeyXml,
      publicKeyFingerprint: value.publicKeyFingerprint,
      algorithm: "RS256",
    });
  }
  if (Object.keys(parsed).length === 0) throw new Error("bridge trusted-key document is empty");
  return Object.freeze(parsed);
}
