import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalizeJson, type JsonValue } from "@revagent/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bridgeManifestDigest } from "./bridgeManifestSignature.js";
import {
  importBridgeRelease,
  importBridgeReleaseFromActions,
  type BridgeReleasePublisher,
} from "./bridgeReleaseImportCli.js";
import { FilesystemBridgeReleaseObjectStore } from "./bridgeReleaseObjectStore.js";

const repository = "BTankut/revAgent";
const headSha = "a".repeat(40);
const runId = "987654";
const artifactId = "12345";
const repositoryId = 123;

function storedZip(entries: Readonly<Record<string, Buffer>>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + bytes.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10); eocd.writeUInt32LE(centralBytes.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

function response(body: BodyInit | null, url: string, init?: ResponseInit): Response {
  const result = new Response(body, init);
  Object.defineProperty(result, "url", { value: url });
  return result;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "revagent-release-import-"));
  const artifacts = join(root, "artifact");
  await mkdir(artifacts);
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
  const projection = { ...envelope }; delete projection.signature;
  envelope.signature = sign("RSA-SHA256", Buffer.from(canonicalizeJson(projection)), pair.privateKey).toString("base64");
  const material = {
    "bridge.zip": bridge,
    "addin.zip": addin,
    "bridge-manifest.json": Buffer.from(canonicalizeJson(manifest)),
    "bridge-manifest.signature.json": Buffer.from(canonicalizeJson(envelope)),
    "provenance.json": Buffer.from(JSON.stringify({ schemaVersion: 1, releaseId, repository, headSha, headTree: "b".repeat(40), createdAtUtc: "2026-09-07T12:34:56.0000000Z" })),
  };
  await Promise.all([
    ...Object.entries(material).map(async ([name, bytes]) => await writeFile(join(artifacts, name), bytes)),
    writeFile(join(root, "trusted.json"), JSON.stringify({ trustedKeys: { "generated-p3t12": { publicKeyXml: xml, publicKeyFingerprint: fingerprint, algorithm: "RS256" } } })),
  ]);
  const archive = storedZip(material);
  return { root, artifacts, bridge, addin, releaseId, trusted: join(root, "trusted.json"), archive, digest: `sha256:${createHash("sha256").update(archive).digest("hex")}` };
}

function actionFetch(input: { readonly archive: Buffer; readonly digest: string; readonly artifactId?: number; readonly repository?: string; readonly runId?: number; readonly headSha?: string }) {
  const signedUrl = "https://revagent-artifacts.blob.core.windows.net/generated";
  return vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    const url = request instanceof Request ? request.url : request.toString();
    if (url === `https://api.github.com/repos/${repository}`) {
      return response(JSON.stringify({ id: repositoryId, full_name: input.repository ?? repository }), url, { status: 200 });
    }
    if (url.endsWith("/zip")) {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer generated-actions-token");
      return response(null, url, { status: 302, headers: { location: signedUrl } });
    }
    if (url.includes("/actions/artifacts/")) {
      return response(JSON.stringify({
        id: input.artifactId ?? Number(artifactId), expired: false, digest: input.digest,
        archive_download_url: `https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}/zip`,
        workflow_run: { id: input.runId ?? Number(runId), repository_id: repositoryId, head_repository_id: repositoryId, head_sha: input.headSha ?? headSha },
      }), url, { status: 200 });
    }
    if (url === signedUrl) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return response(Uint8Array.from(input.archive), signedUrl, { status: 200, headers: { "content-length": String(input.archive.length) } });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Bridge release import", () => {
  it("verifies generated-key local artifacts before the one publisher transaction", async () => {
    const value = await fixture();
    try {
      let published: Parameters<BridgeReleasePublisher["publishBridgeUpdateRelease"]>[0] | undefined;
      const publisher: BridgeReleasePublisher = { async publishBridgeUpdateRelease(input) { published = input; } };
      const result = await importBridgeRelease({ artifactRoot: value.artifacts, expectedRepository: repository, expectedHeadSha: headSha,
        trustedKeysPath: value.trusted, tenantIds: ["10000000-0000-4000-8000-000000000001"], deviceRings: [], releasedBy: "fixture",
      }, { publisher, objects: new FilesystemBridgeReleaseObjectStore(value.root) });
      expect(result.releaseId).toBe(value.releaseId);
      if (published === undefined) throw new Error("publisher fixture did not capture release");
      expect(published.release.components.bridge.sha256).toBe(createHash("sha256").update(value.bridge).digest("hex"));
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("binds authenticated Actions repository/run/head/id/digest to downloaded archive bytes without forwarding the token", async () => {
    const value = await fixture();
    try {
      const publisher = { publishBridgeUpdateRelease: vi.fn(async () => undefined) };
      const fetchMock = actionFetch({ archive: value.archive, digest: value.digest });
      vi.stubGlobal("fetch", fetchMock);
      const result = await importBridgeReleaseFromActions({ artifactId, artifactDigest: value.digest, runId,
        githubToken: "generated-actions-token", expectedRepository: repository, expectedHeadSha: headSha,
        trustedKeysPath: value.trusted, tenantIds: ["10000000-0000-4000-8000-000000000001"], deviceRings: [], releasedBy: "github-actions",
      }, { publisher, objects: new FilesystemBridgeReleaseObjectStore(value.root) });
      expect(result.actionsArtifact).toMatchObject({ artifactId, artifactDigest: value.digest, repository, repositoryId, runId, headSha, archiveBytes: value.archive.length });
      expect(publisher.publishBridgeUpdateRelease).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it.each([
    ["artifact id", { artifactId: 999 }],
    ["repository", { repository: "Other/revAgent" }],
    ["run id", { runId: 111 }],
    ["head sha", { headSha: "c".repeat(40) }],
  ] as const)("refuses mismatched authenticated Actions %s before object or DB publication", async (_label, override) => {
    const value = await fixture();
    try {
      const publisher = { publishBridgeUpdateRelease: vi.fn(async () => undefined) };
      vi.stubGlobal("fetch", actionFetch({ archive: value.archive, digest: value.digest, ...override }));
      await expect(importBridgeReleaseFromActions({ artifactId, artifactDigest: value.digest, runId,
        githubToken: "generated-actions-token", expectedRepository: repository, expectedHeadSha: headSha,
        trustedKeysPath: value.trusted, tenantIds: ["10000000-0000-4000-8000-000000000001"], deviceRings: [], releasedBy: "github-actions",
      }, { publisher, objects: new FilesystemBridgeReleaseObjectStore(value.root) })).rejects.toThrow(/identity/u);
      expect(publisher.publishBridgeUpdateRelease).not.toHaveBeenCalled();
      await expect(lstat(join(value.root, "releases"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });

  it("refuses archive bytes that differ from the authenticated digest before object or DB publication", async () => {
    const value = await fixture();
    try {
      const publisher = { publishBridgeUpdateRelease: vi.fn(async () => undefined) };
      const authenticatedDigest = `sha256:${"d".repeat(64)}`;
      vi.stubGlobal("fetch", actionFetch({ archive: value.archive, digest: authenticatedDigest }));
      await expect(importBridgeReleaseFromActions({ artifactId, artifactDigest: authenticatedDigest, runId,
        githubToken: "generated-actions-token", expectedRepository: repository, expectedHeadSha: headSha,
        trustedKeysPath: value.trusted, tenantIds: ["10000000-0000-4000-8000-000000000001"], deviceRings: [], releasedBy: "github-actions",
      }, { publisher, objects: new FilesystemBridgeReleaseObjectStore(value.root) })).rejects.toThrow(/archive bytes/u);
      expect(publisher.publishBridgeUpdateRelease).not.toHaveBeenCalled();
      await expect(lstat(join(value.root, "releases"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await rm(value.root, { recursive: true, force: true }); }
  });
});
