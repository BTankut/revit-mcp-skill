import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { FilesystemBridgeReleaseObjectStore } from "./bridgeReleaseObjectStore.js";

describe("Bridge release object store", () => {
  it("creates immutable objects and accepts byte-identical retries", async () => {
    const root = await mkdtemp(join(tmpdir(), "revagent-release-object-"));
    try {
      const store = new FilesystemBridgeReleaseObjectStore(root);
      const bytes = Buffer.from("generated bridge zip");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const key = store.storageKey({ releaseId: "10000000-0000-4000-8000-000000000001", component: "bridge", sha256 });
      expect(await store.putCreateOnly({ key, bytes, sha256, sizeBytes: bytes.length })).toBe("created");
      expect(await store.putCreateOnly({ key, bytes, sha256, sizeBytes: bytes.length })).toBe("idempotent");
      expect(await store.getVerified({ key, sha256, sizeBytes: bytes.length })).toEqual(bytes);
      const objectPath = join(root, "releases", "bridge", ...key.split("/"));
      expect(await readFile(objectPath)).toEqual(bytes);
      await writeFile(objectPath, Buffer.alloc(bytes.length, 0));
      await expect(store.getVerified({ key, sha256, sizeBytes: bytes.length })).rejects.toThrow(/digest/u);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("refuses traversal, immutable conflict, and linked release ancestry", async () => {
    const root = await mkdtemp(join(tmpdir(), "revagent-release-object-"));
    const outside = await mkdtemp(join(tmpdir(), "revagent-release-outside-"));
    try {
      const store = new FilesystemBridgeReleaseObjectStore(root);
      await expect(store.putCreateOnly({ key: "../escape.zip", bytes: Buffer.of(1), sha256: "0".repeat(64), sizeBytes: 1 })).rejects.toThrow(/invalid/u);
      await writeFile(join(outside, "sentinel"), "safe");
      await symlink(outside, join(root, "releases"), "junction");
      const bytes = Buffer.from("x");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const key = store.storageKey({ releaseId: "10000000-0000-4000-8000-000000000001", component: "addin", sha256 });
      await expect(store.putCreateOnly({ key, bytes, sha256, sizeBytes: 1 })).rejects.toThrow();
      expect(await readFile(join(outside, "sentinel"), "utf8")).toBe("safe");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
