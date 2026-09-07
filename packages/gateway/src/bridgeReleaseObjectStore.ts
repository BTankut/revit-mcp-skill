import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const STORAGE_KEY = /^[0-9a-f-]{36}\/(?:bridge|addin)-[0-9a-f]{64}\.zip$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export class BridgeReleaseObjectError extends Error {
  public constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BridgeReleaseObjectError";
  }
}

export class FilesystemBridgeReleaseObjectStore {
  readonly #objectStoreRoot: string;
  readonly #root: string;

  public constructor(objectStoreRoot: string) {
    if (!resolve(objectStoreRoot)) throw new Error("release object root is invalid");
    this.#objectStoreRoot = resolve(objectStoreRoot);
    this.#root = resolve(this.#objectStoreRoot, "releases", "bridge");
  }

  public storageKey(input: { readonly releaseId: string; readonly component: "bridge" | "addin"; readonly sha256: string }): string {
    const key = `${input.releaseId}/${input.component}-${input.sha256}.zip`;
    if (!STORAGE_KEY.test(key)) throw new BridgeReleaseObjectError("invalid_key", "release object key is invalid");
    return key;
  }

  public async putCreateOnly(input: { readonly key: string; readonly bytes: Uint8Array; readonly sha256: string; readonly sizeBytes: number }): Promise<"created" | "idempotent"> {
    this.#validateMetadata(input);
    const target = this.#path(input.key);
    await this.#prepareParent(dirname(target));
    try {
      const existing = await this.#readVerified(target, input.sha256, input.sizeBytes);
      if (existing !== null) return "idempotent";
    } catch (error) {
      if (!(error instanceof BridgeReleaseObjectError) || error.code !== "absent") throw error;
    }
    const temporary = join(dirname(target), `.${input.key.split("/").at(-1)}.tmp-${randomUUID()}`);
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o640);
      await handle.writeFile(input.bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = await this.#readVerified(target, input.sha256, input.sizeBytes);
        if (existing === null) throw new BridgeReleaseObjectError("immutable_conflict", "release object identity is already bound");
        return "idempotent";
      }
      return "created";
    } finally {
      await handle?.close();
      await rm(temporary, { force: true });
    }
  }

  public async getVerified(input: { readonly key: string; readonly sha256: string; readonly sizeBytes: number }): Promise<Buffer> {
    this.#validateMetadata(input);
    const bytes = await this.#readVerified(this.#path(input.key), input.sha256, input.sizeBytes);
    if (bytes === null) throw new BridgeReleaseObjectError("absent", "release object is absent");
    return bytes;
  }

  async #readVerified(path: string, sha256: string, sizeBytes: number): Promise<Buffer | null> {
    await this.#assertSafeAncestry(dirname(path));
    let handle;
    try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BridgeReleaseObjectError("absent", "release object is absent");
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size !== sizeBytes) {
        throw new BridgeReleaseObjectError("metadata_mismatch", "release object metadata differs from authority");
      }
      const bytes = await handle.readFile();
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== sha256) throw new BridgeReleaseObjectError("digest_mismatch", "release object digest differs from authority");
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async #prepareParent(parent: string): Promise<void> {
    await mkdir(this.#objectStoreRoot, { recursive: true, mode: 0o750 });
    let cursor = this.#objectStoreRoot;
    for (const segment of ["releases", "bridge"]) {
      const current = await lstat(cursor);
      if (!current.isDirectory() || current.isSymbolicLink()) throw new BridgeReleaseObjectError("unsafe_root", "release object root contains a link");
      cursor = join(cursor, segment);
      try { await mkdir(cursor, { mode: 0o750 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const releaseRoot = await lstat(this.#root);
    if (!releaseRoot.isDirectory() || releaseRoot.isSymbolicLink()) throw new BridgeReleaseObjectError("unsafe_root", "release object root contains a link");
    cursor = this.#root;
    for (const segment of relative(this.#root, parent).split(sep).filter(Boolean)) {
      const current = await lstat(cursor);
      if (!current.isDirectory() || current.isSymbolicLink()) throw new BridgeReleaseObjectError("unsafe_root", "release object root contains a link");
      cursor = join(cursor, segment);
      try { await mkdir(cursor, { mode: 0o750 }); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const final = await stat(parent);
    if (!final.isDirectory()) throw new BridgeReleaseObjectError("unsafe_parent", "release object parent is invalid");
  }

  async #assertSafeAncestry(parent: string): Promise<void> {
    let cursor = this.#objectStoreRoot;
    const relativeParent = relative(this.#objectStoreRoot, parent);
    if (relativeParent.startsWith("..") || relativeParent === "") {
      if (relativeParent.startsWith("..")) throw new BridgeReleaseObjectError("path_escape", "release object ancestry escaped its root");
    }
    for (const segment of relativeParent.split(sep).filter(Boolean)) {
      const metadata = await lstat(cursor);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new BridgeReleaseObjectError("unsafe_root", "release object ancestry contains a link");
      cursor = join(cursor, segment);
    }
    const metadata = await lstat(cursor);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new BridgeReleaseObjectError("unsafe_parent", "release object parent is unsafe");
  }

  #path(key: string): string {
    if (!STORAGE_KEY.test(key)) throw new BridgeReleaseObjectError("invalid_key", "release object key is invalid");
    const path = resolve(this.#root, ...key.split("/"));
    if (!path.startsWith(this.#root + sep)) throw new BridgeReleaseObjectError("path_escape", "release object path escaped its root");
    return path;
  }

  #validateMetadata(input: { readonly key: string; readonly bytes?: Uint8Array; readonly sha256: string; readonly sizeBytes: number }): void {
    if (!STORAGE_KEY.test(input.key) || !DIGEST.test(input.sha256) || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 ||
        (input.bytes !== undefined && (input.bytes.byteLength !== input.sizeBytes || createHash("sha256").update(input.bytes).digest("hex") !== input.sha256))) {
      throw new BridgeReleaseObjectError("invalid_metadata", "release object metadata is invalid");
    }
  }
}
