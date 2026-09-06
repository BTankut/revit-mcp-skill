import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";

import { sanitizedProductionRuntimeEnvironment } from "./productionRuntimeIdentity.js";
import { SecureEvidenceStore, type SecureEvidenceStoreTestOptions } from "./secureEvidenceStore.js";
import type { ComponentId, ProcessCommandDescriptor, ProcessEvidence } from "./types.js";
import { resolveWindowsSystemPaths } from "./windowsSystemPaths.js";

export const MAX_CONTROL_LINE_BYTES = 64 * 1024;
export const MAX_PROCESS_TRANSCRIPT_RECORDS = 128;
export const REAL_TRIO_PROCESS_START_FAILURE_SCHEMA =
  "rbp-real-trio-process-start-failure/v1" as const;
const decoder = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new Error(`${label} is not canonical UTF-8`);
  }
}

function readinessExitError(
  componentId: ComponentId,
  code: number | null,
  signal: NodeJS.Signals | null,
  transcript: readonly ProcessTranscriptRecord[],
  trailingStderr = Buffer.alloc(0),
): Error {
  const stderrLines = transcript
    .filter((entry) => entry.stream === "stderr")
    .slice(-8)
    .map((entry) => entry.line);
  if (trailingStderr.length > 0) {
    try {
      const trailing = decodeUtf8(trailingStderr, `${componentId} trailing stderr`).trimEnd();
      if (trailing.length > 0) stderrLines.push(trailing);
    } catch {
      stderrLines.push("<invalid-utf8>");
    }
  }
  const stderr = stderrLines.map(redactDiagnosticLine).join(" | ");
  const excerpt = stderr.length <= 4_096 ? stderr : stderr.slice(-4_096);
  return new Error(
    `${componentId} exited before readiness (${String(code ?? signal)})${
      excerpt.length === 0 ? "" : `; stderr: ${excerpt}`
    }`,
  );
}

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonlReadiness extends JsonObject {
  ready: true;
  controlVersion: 1;
  maxControlLineBytes: 65536;
  actions: JsonValue[];
}

export interface ProcessTranscriptRecord {
  stream: "stdout" | "stderr";
  at: string;
  line: string;
}

export interface ProcessEvidenceDirectoryOptions {
  /** Caller-selected test evidence directory; no runtime path is inferred. */
  readonly evidenceDirectory?: string;
  /** Deterministic evidence-store synchronization used by adversarial tests. */
  readonly evidenceStoreTest?: SecureEvidenceStoreTestOptions;
}

export interface ProcessOutputEvidence {
  readonly sha256: string;
  readonly safeLines: readonly string[];
}

/**
 * Bounded, redacted child-process evidence.  It deliberately excludes the
 * command, private state paths, and raw output bytes.
 */
export interface ProcessRuntimeEvidence {
  readonly componentId: string;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: ProcessOutputEvidence;
  readonly stderr: ProcessOutputEvidence;
}

export interface ProcessStopTelemetry {
  readonly requestedAt: string | null;
  readonly correlationKind: "ipc_stop_nonce" | "jsonl_control_id" | null;
  readonly correlationId: string | null;
  readonly acknowledgedAt: string | null;
  readonly acknowledgement: "closed" | "response_ok" | "failed_or_timed_out" | "not_requested";
}

export interface ProcessStopResult {
  readonly stoppedAt: string;
  readonly exitCode: number;
  readonly killEscalated: boolean;
  readonly killEscalationAttempted?: boolean;
  readonly killEscalationEffective?: boolean;
  readonly telemetry: ProcessStopTelemetry;
  readonly evidence: ProcessRuntimeEvidence;
}

export class ProcessStdioDrainTimeoutError extends Error {
  readonly stdioSurvivor = true;

  constructor(
    readonly componentId: ComponentId,
    readonly exitCode: number,
    readonly evidence: ProcessRuntimeEvidence,
    readonly killEscalationAttempted: boolean,
    readonly killEscalationEffective: boolean,
  ) {
    super(`${componentId} exited with code ${exitCode} but inherited stdio did not close within the bounded drain window`);
    this.name = "ProcessStdioDrainTimeoutError";
  }

  get killEscalated(): boolean { return this.killEscalationEffective; }
}

export class ProcessExitTimeoutError extends Error {
  constructor(
    readonly componentId: ComponentId,
    readonly evidence: ProcessRuntimeEvidence,
    readonly killEscalationAttempted: boolean,
    readonly killEscalationEffective: boolean,
    readonly directChildSurvivor: boolean,
    readonly helperReapUncertain: boolean = false,
  ) {
    super(`${componentId} did not produce an observed direct-child exit within the bounded lifecycle deadline`);
    this.name = "ProcessExitTimeoutError";
  }
  get killEscalated(): boolean { return this.killEscalationEffective; }
}

interface ProcessFailureEvidence {
  readonly schemaVersion: typeof REAL_TRIO_PROCESS_START_FAILURE_SCHEMA;
  readonly component: string;
  readonly phase: string;
  readonly commandHash: string;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: Readonly<{ readonly hash: string; readonly safeLines: readonly string[] }>;
  readonly stderr: Readonly<{ readonly hash: string; readonly safeLines: readonly string[] }>;
  readonly timeline: readonly string[];
}

function appendBoundedTranscript(target: ProcessTranscriptRecord[], record: ProcessTranscriptRecord): void {
  target.push(record);
  if (target.length > MAX_PROCESS_TRANSCRIPT_RECORDS) target.splice(0, target.length - MAX_PROCESS_TRANSCRIPT_RECORDS);
}

function stdioClosed(child: ChildProcessWithoutNullStreams): Promise<void> {
  const closed = (stream: NodeJS.ReadableStream): Promise<void> => {
    const state = stream as NodeJS.ReadableStream & { readonly destroyed?: boolean; readonly readableEnded?: boolean };
    return state.destroyed === true || state.readableEnded === true
      ? Promise.resolve()
      : new Promise<void>((resolve) => stream.once("close", resolve));
  };
  return Promise.all([
    closed(child.stdout),
    closed(child.stderr),
  ]).then(() => undefined);
}

/** Safe, bounded process evidence for real-trio failure diagnostics. */
export interface ProcessDiagnosticSnapshot {
  readonly componentId: string;
  readonly phase: string;
  readonly exitCode: number | null;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

const MAX_DIAGNOSTIC_LINES_PER_STREAM = 8;
const MAX_DIAGNOSTIC_LINE_BYTES = 512;

const RETAINED_DIAGNOSTIC_KEYS = new Set([
  "actions", "code", "complete", "component", "controlVersion", "durabilityEvents",
  "event", "exitCode", "maxControlLineBytes", "ok", "phase", "ready", "schemaVersion",
  "signal", "state", "status", "stopped", "transport", "ws_url",
]);

const RETAINED_DIAGNOSTIC_VALUES: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  actions: new Set(["apply_document_context", "fail", "ping", "poll_document_context", "read_c39_origin_provenance", "read_recovery_observations", "release", "shutdown", "snapshot_evidence", "stall"]),
  code: new Set(["EADDRINUSE", "EACCES", "WSAEACCES", "EADDRNOTAVAIL", "planned_error"]),
  component: new Set(["addin_loopback_fixture", "bridge_simulator", "fixture-test", "gateway_stub"]),
  event: new Set(["terminal_persisted"]),
  phase: new Set(["pre_ready", "ready", "stdio_closed"]),
  schemaVersion: new Set([REAL_TRIO_PROCESS_START_FAILURE_SCHEMA]),
  signal: new Set(["SIGABRT", "SIGKILL", "SIGTERM"]),
  state: new Set(["closed", "error", "failed", "ready", "running", "stopped"]),
  status: new Set(["closed", "completed", "error", "failed", "guarded", "ok", "passed", "running", "stopped"]),
  transport: new Set(["streamable_http_sse", "wss"]),
});

function retainedDiagnosticProjection(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((entry) => retainedDiagnosticProjection(entry, key));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([entryKey]) => RETAINED_DIAGNOSTIC_KEYS.has(entryKey))
      .map(([entryKey, entryValue]) => [entryKey, retainedDiagnosticProjection(entryValue, entryKey)]));
  }
  if (typeof value === "string") {
    if (key === "ws_url") {
      try {
        const endpoint = new URL(value);
        if ((endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") ||
            !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
            endpoint.port.length === 0 || endpoint.username.length > 0 || endpoint.password.length > 0) return "[redacted]";
        return { scheme: endpoint.protocol.slice(0, -1), host: endpoint.hostname, port: Number(endpoint.port) };
      } catch { return "[redacted]"; }
    }
    return RETAINED_DIAGNOSTIC_VALUES[key]?.has(value) === true ? value : "[redacted]";
  }
  if (typeof value === "boolean") {
    return ["complete", "ok", "ready", "stopped"].includes(key) ? value : "[redacted]";
  }
  if (typeof value === "number") {
    if (key === "controlVersion" && value === 1) return value;
    if (key === "maxControlLineBytes" && value === MAX_CONTROL_LINE_BYTES) return value;
    if (key === "exitCode" && [0, 1, 128].includes(value)) return value;
    return "[redacted]";
  }
  return value === null ? null : "[redacted]";
}

function redactDiagnosticLine(input: string): string {
  let redacted: string;
  const jsonStart = input.indexOf("{");
  try {
    const parsed = JSON.parse(jsonStart < 0 ? input : input.slice(jsonStart)) as unknown;
    redacted = JSON.stringify(retainedDiagnosticProjection(parsed));
  } catch {
    const tokens: string[] = [];
    if (/Authorization:\s*(?:Bearer|Basic)\s+/iu.test(input)) tokens.push("Authorization=[redacted]");
    const retryableBindMatch = input.match(
      /\b(?:listen|bind)\b[^\r\n]{0,160}?\b(EADDRINUSE|EACCES|WSAEACCES|EADDRNOTAVAIL)\b|\b(EADDRINUSE|EACCES|WSAEACCES|EADDRNOTAVAIL)\b[^\r\n]{0,160}?\b(?:listen|bind)\b/iu,
    );
    const retryableBindCode = retryableBindMatch?.[1] ?? retryableBindMatch?.[2];
    if (retryableBindCode !== undefined) {
      tokens.push(`bind_error=${retryableBindCode.toUpperCase()}`);
    }
    if (input === "early stderr tail") tokens.push(input);
    redacted = tokens.length === 0 ? "[diagnostic omitted]" : tokens.join(" ");
  }
  const bytes = Buffer.from(redacted, "utf8");
  return bytes.length <= MAX_DIAGNOSTIC_LINE_BYTES
    ? redacted
    : `${bytes.subarray(0, MAX_DIAGNOSTIC_LINE_BYTES - 16).toString("utf8")}…[truncated]`;
}

/**
 * Writes only redacted, bounded child output.  Raw chunks never leave memory
 * and are represented in failure artifacts solely by SHA-256 digests.
 */
class ProcessEvidenceRecorder {
  readonly #stdout = createHash("sha256");
  readonly #stderr = createHash("sha256");
  readonly #safeLines: Record<"stdout" | "stderr", string[]> = { stdout: [], stderr: [] };
  readonly #partial: Record<"stdout" | "stderr", Buffer> = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  readonly #timeline: string[] = ["spawn_requested"];
  #pid: number | null = null;
  #exitCode: number | null = null;
  #signal: string | null = null;
  readonly #evidenceDirectoryReal: string | undefined;
  readonly #evidenceStore: SecureEvidenceStore | undefined;
  #persistLogsPromise: Promise<void> | null = null;

  constructor(
    private readonly component: string,
    private readonly commandHash: string,
    private readonly evidenceDirectory: string | undefined,
    evidenceStoreTest: SecureEvidenceStoreTestOptions | undefined,
  ) {
    if (evidenceDirectory === undefined) {
      this.#evidenceDirectoryReal = undefined;
      this.#evidenceStore = undefined;
    } else {
      const stat = lstatSync(evidenceDirectory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("process evidence directory must be a pre-existing plain caller-owned directory");
      }
      this.#evidenceDirectoryReal = realpathSync.native(evidenceDirectory);
      this.#evidenceStore = new SecureEvidenceStore(evidenceDirectory, { directRootOnly: true, test: evidenceStoreTest });
    }
  }

  spawned(pid: number | undefined): void {
    this.#pid = pid ?? null;
    this.#timeline.push(this.#pid === null ? "spawn_without_pid" : "spawned");
  }

  exited(code: number | null, signal: NodeJS.Signals | null): void {
    this.#exitCode = code;
    this.#signal = signal;
    this.#timeline.push("child_exit");
  }

  snapshot(): ProcessRuntimeEvidence {
    return Object.freeze({
      componentId: this.component,
      pid: this.#pid,
      exitCode: this.#exitCode,
      signal: this.#signal,
      stdout: Object.freeze({
        sha256: `sha256:${this.#stdout.copy().digest("hex")}`,
        safeLines: Object.freeze([...this.#safeLines.stdout]),
      }),
      stderr: Object.freeze({
        sha256: `sha256:${this.#stderr.copy().digest("hex")}`,
        safeLines: Object.freeze([...this.#safeLines.stderr]),
      }),
    });
  }

  observeChunk(stream: "stdout" | "stderr", chunk: Buffer): void {
    (stream === "stdout" ? this.#stdout : this.#stderr).update(chunk);
    const buffer = Buffer.concat([this.#partial[stream], chunk]);
    const lines = buffer.toString("utf8").split(/\r?\n/u);
    this.#partial[stream] = Buffer.from(lines.pop() ?? "", "utf8");
    for (const line of lines) this.#record(stream, line);
  }

  async failure(phase: string): Promise<void> {
    this.#timeline.push(`failure:${phase}`);
    this.#flushPartials();
    if (this.evidenceDirectory === undefined) return;
    const failure: ProcessFailureEvidence = Object.freeze({
      schemaVersion: REAL_TRIO_PROCESS_START_FAILURE_SCHEMA,
      component: this.component,
      phase,
      commandHash: this.commandHash,
      pid: this.#pid,
      exitCode: this.#exitCode,
      signal: this.#signal,
      stdout: Object.freeze({ hash: `sha256:${this.#stdout.copy().digest("hex")}`, safeLines: Object.freeze([...this.#safeLines.stdout]) }),
      stderr: Object.freeze({ hash: `sha256:${this.#stderr.copy().digest("hex")}`, safeLines: Object.freeze([...this.#safeLines.stderr]) }),
      timeline: Object.freeze([...this.#timeline]),
    });
    await this.#persist(`${this.component}.start-failure.json`, `${JSON.stringify(failure)}\n`);
    await this.#persistLogs();
  }

  #record(stream: "stdout" | "stderr", line: string): void {
    const safe = redactDiagnosticLine(line);
    const retained = this.#safeLines[stream];
    retained.push(safe);
    if (retained.length > MAX_DIAGNOSTIC_LINES_PER_STREAM) retained.splice(0, retained.length - MAX_DIAGNOSTIC_LINES_PER_STREAM);
  }

  #flushPartials(): void {
    for (const stream of ["stdout", "stderr"] as const) {
      const partial = this.#partial[stream];
      if (partial.length === 0) continue;
      this.#partial[stream] = Buffer.alloc(0);
      this.#record(stream, partial.toString("utf8"));
    }
  }

  async complete(): Promise<void> {
    this.#flushPartials();
    this.#timeline.push("stdio_closed");
    await this.#persistLogs();
  }

  #assertEvidenceDirectoryIdentity(): void {
    if (this.evidenceDirectory === undefined || this.#evidenceDirectoryReal === undefined) return;
    const stat = lstatSync(this.evidenceDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync.native(this.evidenceDirectory) !== this.#evidenceDirectoryReal) {
      throw new Error("process evidence directory identity changed");
    }
  }

  async #persist(fileName: string, contents: string): Promise<void> {
    if (this.evidenceDirectory === undefined) return;
    this.#assertEvidenceDirectoryIdentity();
    if (this.#evidenceStore === undefined) return;
    const bytes = Buffer.from(contents, "utf8");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await this.#evidenceStore.writeDirectAccepted(fileName, bytes, (candidate) => candidate.acceptExact({
      logicalPath: fileName,
      absolutePath: path.resolve(this.evidenceDirectory!, fileName),
      bytes,
      sha256,
    }, undefined));
    this.#assertEvidenceDirectoryIdentity();
  }

  async #persistLogs(): Promise<void> {
    if (this.evidenceDirectory === undefined) return;
    this.#persistLogsPromise ??= (async () => {
      for (const stream of ["stdout", "stderr"] as const) {
        await this.#persist(`${this.component}.${stream}.log`, `${this.#safeLines[stream].join("\n")}${this.#safeLines[stream].length === 0 ? "" : "\n"}`);
      }
    })();
    await this.#persistLogsPromise;
  }
}

function processCommandHash(command: ProcessCommandDescriptor): string {
  const canonical = JSON.stringify({ executable: command.executable, args: command.args, workingDirectory: command.workingDirectory });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function boundedProcessDiagnostics(input: {
  readonly componentId: string;
  readonly phase: string;
  readonly exitCode: number | null;
  readonly transcript: readonly ProcessTranscriptRecord[];
}): ProcessDiagnosticSnapshot {
  const lines = (stream: "stdout" | "stderr"): readonly string[] => Object.freeze(
    input.transcript
      .filter((record) => record.stream === stream)
      .slice(-MAX_DIAGNOSTIC_LINES_PER_STREAM)
      .map((record) => redactDiagnosticLine(record.line)),
  );
  return Object.freeze({
    componentId: input.componentId,
    phase: input.phase,
    exitCode: input.exitCode,
    stdout: lines("stdout"),
    stderr: lines("stderr"),
  });
}

export class ReadyProcessStartError extends Error {
  constructor(
    message: string,
    readonly diagnostic: ProcessDiagnosticSnapshot,
  ) {
    super(message);
    this.name = "ReadyProcessStartError";
  }
}

export interface JsonlProcessOptions extends ProcessEvidenceDirectoryOptions {
  componentId: ComponentId;
  command: ProcessCommandDescriptor;
  absoluteWorkingDirectory: string;
  environment?: Readonly<Record<string, string | undefined>>;
  expectedReadinessFields: Readonly<Record<string, JsonValue>>;
  requiredActions: readonly string[];
}

interface PendingResponse {
  id: string;
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface StartedControlRequest {
  id: string;
  response: Promise<JsonValue>;
}

export class ControlResponseError extends Error {
  constructor(
    readonly componentId: ComponentId,
    readonly correlationId: string,
    readonly code: string,
    readonly controlMessage: string,
  ) {
    super(`${componentId} control failed: ${code} ${controlMessage}`);
    this.name = "ControlResponseError";
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(bytes: Buffer, label: string): JsonObject {
  let text: string;
  try {
    text = decodeUtf8(bytes, label);
  } catch {
    throw new Error(`${label} is not canonical UTF-8`);
  }
  if (text.length === 0 || text.startsWith("\uFEFF")) throw new Error(`${label} is empty or BOM-prefixed`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function assertExactResponseShape(value: JsonObject): void {
  const success = value.ok === true;
  const expected = success
    ? ["controlVersion", "id", "ok", "result"]
    : ["controlVersion", "error", "id", "ok"];
  const actual = Object.keys(value).sort();
  expected.sort();
  if (actual.length !== expected.length || actual.some((entry, index) => entry !== expected[index])) {
    throw new Error("control response has unknown or missing fields");
  }
  if (value.controlVersion !== 1 || typeof value.id !== "string" || value.id.length < 1 || value.id.length > 128) {
    throw new Error("control response identity is invalid");
  }
  if (!success && !isObject(value.error)) throw new Error("control error response is missing its error object");
}

function assertReadiness(
  value: JsonObject,
  expectedFields: Readonly<Record<string, JsonValue>>,
  requiredActions: readonly string[],
): asserts value is JsonlReadiness {
  if (value.ready !== true || value.controlVersion !== 1 || value.maxControlLineBytes !== MAX_CONTROL_LINE_BYTES) {
    throw new Error("component readiness lacks the strict ready/controlVersion/maxControlLineBytes contract");
  }
  for (const [key, expected] of Object.entries(expectedFields)) {
    if (JSON.stringify(value[key]) !== JSON.stringify(expected)) {
      throw new Error(`component readiness field ${key} does not match the execution contract`);
    }
  }
  if (!Array.isArray(value.actions) || !value.actions.every((entry) => typeof entry === "string")) {
    throw new Error("component readiness actions must be a string array");
  }
  const actions = new Set(value.actions as string[]);
  const missing = requiredActions.filter((action) => !actions.has(action));
  if (missing.length > 0) throw new Error(`component readiness is missing controls: ${missing.join(", ")}`);
}

export class StrictJsonlProcess {
  readonly transcript: ProcessTranscriptRecord[] = [];
  readonly process: ProcessEvidence;
  readonly readiness: JsonlReadiness;
  readonly pid: number;
  #sequentialTail = Promise.resolve<void>(undefined);
  readonly #pending = new Map<string, PendingResponse>();
  readonly #responseOrder: string[] = [];
  #closed = false;
  #exit: Promise<{ code: number; at: string }>;
  #stdioClosed: Promise<void>;
  #exitResolve!: (value: { code: number; at: string }) => void;
  #controlCounter = 0;

  private constructor(
    readonly componentId: ComponentId,
    private readonly child: ChildProcessWithoutNullStreams,
    readiness: JsonlReadiness,
    startedAt: string,
    readyAt: string,
    private readonly evidence: ProcessEvidenceRecorder,
    stdioCompletion: Promise<void>,
  ) {
    this.readiness = readiness;
    const pid = child.pid;
    if (pid === undefined) throw new Error(`${componentId} lost its process id`);
    this.pid = pid;
    this.process = { pid, startedAt, readyAt, stoppedAt: null, exitCode: null };
    this.#exit = new Promise((resolve) => { this.#exitResolve = resolve; });
    this.#stdioClosed = stdioCompletion;
    // Writable emits an error event even when write() has an error callback.
    // Keep ownership through stdio drain, including errors after fatal teardown.
    child.stdin.on("error", (error: Error) => { this.#failControl(error); });
    child.once("exit", (code, signal) => {
      const at = new Date().toISOString();
      const normalized = code ?? (signal === null ? 1 : 128);
      this.process.stoppedAt = at;
      this.process.exitCode = normalized;
      this.evidence.exited(code, signal);
      this.#closed = true;
      this.#rejectAllPending(new Error(`${this.componentId} exited before control response`));
      this.#exitResolve({ code: normalized, at });
    });
  }

  static async start(options: JsonlProcessOptions): Promise<StrictJsonlProcess> {
    const startedAt = new Date().toISOString();
    const evidence = new ProcessEvidenceRecorder(
      options.componentId,
      processCommandHash(options.command),
      options.evidenceDirectory,
      options.evidenceStoreTest,
    );
    const child = spawn(options.command.executable, options.command.args, {
      cwd: options.absoluteWorkingDirectory,
      env: sanitizedProductionRuntimeEnvironment(process.env, options.environment),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    evidence.spawned(child.pid);
    const stdioCompletion = stdioClosed(child);
    const evidenceCompletion = stdioCompletion.then(() => evidence.complete());
    void evidenceCompletion.catch(() => undefined);
    if (child.pid === undefined) {
      await evidence.failure("spawn");
      throw new Error(`${options.componentId} did not receive a process id`);
    }

    const transcript: ProcessTranscriptRecord[] = [];
    let stdoutBuffer = Buffer.alloc(0);
    let stderrBuffer = Buffer.alloc(0);
    let settled = false;
    const active: { instance?: StrictJsonlProcess } = {};
    const appendTranscript = (record: ProcessTranscriptRecord): void => {
      appendBoundedTranscript(transcript, record);
      if (active.instance !== undefined) appendBoundedTranscript(active.instance.transcript, record);
    };
    const readiness = new Promise<{ value: JsonlReadiness; at: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(new Error(`${options.componentId} readiness timed out`));
      }, options.command.readiness.timeoutMs);
      const fail = (failure: Error): void => {
        if (settled) {
          if (active.instance !== undefined) active.instance.#failControl(failure);
          else child.kill("SIGTERM");
          return;
        }
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        void evidence.failure("pre_ready").then(
          () => reject(failure),
          (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
        );
      };
      child.once("error", fail);
      child.once("close", (code, signal) => {
        evidence.exited(code, signal);
        if (!settled) {
          fail(readinessExitError(
            options.componentId,
            code,
            signal,
            transcript,
            stderrBuffer,
          ));
        }
      });
      child.stdout.on("data", (chunk: Buffer) => {
        evidence.observeChunk("stdout", chunk);
        stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);
        if (stdoutBuffer.length > MAX_CONTROL_LINE_BYTES && !stdoutBuffer.includes(0x0a)) {
          fail(new Error(`${options.componentId} stdout line exceeds ${MAX_CONTROL_LINE_BYTES} bytes`));
          return;
        }
        while (true) {
          const newline = stdoutBuffer.indexOf(0x0a);
          if (newline < 0) break;
          let line = stdoutBuffer.subarray(0, newline);
          stdoutBuffer = stdoutBuffer.subarray(newline + 1);
          if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
          if (line.length > MAX_CONTROL_LINE_BYTES) {
            fail(new Error(`${options.componentId} stdout line exceeds ${MAX_CONTROL_LINE_BYTES} bytes`));
            return;
          }
          let lineText: string;
          try { lineText = decodeUtf8(line, `${options.componentId} stdout line`); } catch { lineText = "<invalid-utf8>"; }
          appendTranscript({ stream: "stdout", at: new Date().toISOString(), line: lineText });
          try {
            const parsed = parseJsonObject(line, `${options.componentId} stdout line`);
            if (!settled) {
              assertReadiness(parsed, options.expectedReadinessFields, options.requiredActions);
              settled = true;
              clearTimeout(timer);
              const at = new Date().toISOString();
              resolve({ value: parsed, at });
            } else if (active.instance !== undefined) {
              active.instance.#consumeResponse(parsed);
            } else {
              fail(new Error(`${options.componentId} emitted stdout between readiness and control activation`));
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        evidence.observeChunk("stderr", chunk);
        stderrBuffer = Buffer.concat([stderrBuffer, chunk]);
        if (stderrBuffer.length > MAX_CONTROL_LINE_BYTES && !stderrBuffer.includes(0x0a)) {
          fail(new Error(`${options.componentId} stderr line exceeds ${MAX_CONTROL_LINE_BYTES} bytes`));
          return;
        }
        while (true) {
          const newline = stderrBuffer.indexOf(0x0a);
          if (newline < 0) break;
          let line = stderrBuffer.subarray(0, newline);
          stderrBuffer = stderrBuffer.subarray(newline + 1);
          if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
          try {
            appendTranscript({ stream: "stderr", at: new Date().toISOString(), line: decodeUtf8(line, `${options.componentId} stderr line`) });
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
    });
    const ready = await readiness;
    active.instance = new StrictJsonlProcess(
      options.componentId,
      child,
      ready.value,
      startedAt,
      ready.at,
      evidence,
      evidenceCompletion,
    );
    for (const record of transcript) appendBoundedTranscript(active.instance.transcript, record);
    return active.instance;
  }

  #consumeResponse(value: JsonObject): void {
    try {
      assertExactResponseShape(value);
      const id = value.id as string;
      const expectedId = this.#responseOrder[0];
      const pending = this.#pending.get(id);
      if (pending === undefined || id !== expectedId) {
        throw new Error(`${this.componentId} emitted an unsolicited or out-of-order control response`);
      }
      this.#responseOrder.shift();
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      if (value.ok === true) pending.resolve(value.result as JsonValue);
      else {
        const error = value.error as JsonObject;
        pending.reject(new ControlResponseError(
          this.componentId,
          id,
          String(error.code),
          String(error.message),
        ));
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#failControl(failure);
    }
  }

  #failControl(error: Error): void {
    if (this.#closed) return;
    // Terminal control state precedes rejection callbacks and asynchronous exit.
    // stop() must still observe exit/drain, but cannot enqueue shutdown now.
    this.#closed = true;
    this.#rejectAllPending(error);
    this.child.kill("SIGTERM");
  }

  #rejectAllPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#responseOrder.length = 0;
  }

  #beginRequest(
    action: string,
    fields: Readonly<Record<string, JsonValue>>,
    timeoutMs: number,
  ): StartedControlRequest {
    const id = `${this.componentId}-${++this.#controlCounter}`;
    const response = new Promise<JsonValue>((resolve, reject) => {
      if (this.#closed) {
        reject(new Error(`${this.componentId} is closed`));
        return;
      }
      if (!this.readiness.actions.includes(action)) {
        reject(new Error(`${this.componentId} did not advertise control action ${action}`));
        return;
      }
      const record = { controlVersion: 1, id, action, ...fields };
      const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
      if (bytes.length > MAX_CONTROL_LINE_BYTES) {
        reject(new Error(`${this.componentId} control request exceeds ${MAX_CONTROL_LINE_BYTES} bytes`));
        return;
      }
      const timer = setTimeout(() => {
        if (!this.#pending.has(id)) return;
        const failure = new Error(`${this.componentId} control ${action} timed out`);
        this.#failControl(failure);
      }, timeoutMs);
      this.#pending.set(id, { id, resolve, reject, timer });
      this.#responseOrder.push(id);
      try {
        this.child.stdin.write(bytes, (error) => {
          if (error !== undefined && error !== null) this.#failControl(error);
        });
      } catch (error) {
        this.#failControl(error instanceof Error ? error : new Error(String(error)));
      }
    });
    return { id, response };
  }

  startConcurrentRequest(
    action: string,
    fields: Readonly<Record<string, JsonValue>> = {},
    timeoutMs = 30_000,
  ): StartedControlRequest {
    const started = this.#beginRequest(action, fields, timeoutMs);
    // An explicitly non-awaited request is joined later by correlation id. Keep
    // Node from treating the intentional gap as an unhandled rejection.
    void started.response.catch(() => undefined);
    return started;
  }

  requestConcurrent(
    action: string,
    fields: Readonly<Record<string, JsonValue>> = {},
    timeoutMs = 30_000,
  ): Promise<JsonValue> {
    return this.startConcurrentRequest(action, fields, timeoutMs).response;
  }

  #requestSequential(
    action: string,
    fields: Readonly<Record<string, JsonValue>>,
    timeoutMs: number,
    onStarted?: (id: string) => void,
  ): Promise<JsonValue> {
    const response = this.#sequentialTail.then(async () =>
      {
        const started = this.#beginRequest(action, fields, timeoutMs);
        onStarted?.(started.id);
        return await started.response;
      });
    this.#sequentialTail = response.then(
      () => undefined,
      () => undefined,
    );
    return response;
  }

  request(action: string, fields: Readonly<Record<string, JsonValue>> = {}, timeoutMs = 30_000): Promise<JsonValue> {
    return this.#requestSequential(action, fields, timeoutMs);
  }

  async stop(timeoutMs = 10_000): Promise<ProcessStopResult> {
    const boundedTimeout = Math.max(1, timeoutMs);
    const deadline = Date.now() + boundedTimeout;
    const reserve = Math.min(250, Math.max(1, Math.floor(boundedTimeout / 4)));
    const gracefulDeadline = deadline - reserve;
    const remaining = (): number => Math.max(1, deadline - Date.now());
    const gracefulRemaining = (): number => Math.max(1, gracefulDeadline - Date.now());
    let killEscalationAttempted = false;
    let killEscalationEffective = false;
    let requestedAt: string | null = null;
    let correlationId: string | null = null;
    let acknowledgedAt: string | null = null;
    let acknowledgement: ProcessStopTelemetry["acknowledgement"] = "not_requested";
    if (!this.#closed) {
      requestedAt = new Date().toISOString();
      try {
        await this.#requestSequential(
          "shutdown",
          {},
          this.process.readyAt === null ? Math.min(1_000, gracefulRemaining()) : gracefulRemaining(),
          (id) => { correlationId = id; },
        );
        acknowledgedAt = new Date().toISOString();
        acknowledgement = "response_ok";
      } catch {
        acknowledgedAt = new Date().toISOString();
        acknowledgement = "failed_or_timed_out";
        this.child.kill("SIGTERM");
      }
    }
    const forced = setTimeout(() => {
      if (this.child.exitCode === null) {
        killEscalationAttempted = true;
        this.child.kill("SIGKILL");
      }
    }, gracefulRemaining());
    let exit: { code: number; at: string } | null;
    try {
      exit = await awaitExitWithin(this.#exit, remaining());
    } finally {
      // Escalation is authority to terminate a live supervised child only.
      // An observed exit revokes that authority even when a descendant still
      // owns an inherited stdout/stderr pipe.
      clearTimeout(forced);
    }
    if (exit === null) {
      if (this.child.exitCode === null && !killEscalationAttempted) {
        killEscalationAttempted = true;
        this.child.kill("SIGKILL");
      }
      throw new ProcessExitTimeoutError(this.componentId, this.evidence.snapshot(), killEscalationAttempted, killEscalationEffective, this.process.exitCode === null);
    }
    killEscalationEffective = killEscalationAttempted &&
      this.child.signalCode === "SIGKILL";
    // Do not send EOF to a live Bridge: its stdin end is itself a shutdown
    // trigger. After the child has exited, release only the parent handle so
    // ChildProcess close accounting can finish and flush the final stdio tail.
    if (!this.child.stdin.destroyed) this.child.stdin.destroy();
    if (!await completionWithin(this.#stdioClosed, remaining())) {
      throw new ProcessStdioDrainTimeoutError(
        this.componentId,
        exit.code,
        this.evidence.snapshot(),
        killEscalationAttempted,
        killEscalationEffective,
      );
    }
    return {
      stoppedAt: exit.at,
      exitCode: exit.code,
      killEscalated: killEscalationEffective,
      killEscalationAttempted,
      killEscalationEffective,
      telemetry: {
        requestedAt,
        correlationKind: correlationId === null ? null : "jsonl_control_id",
        correlationId,
        acknowledgedAt,
        acknowledgement,
      },
      evidence: this.evidence.snapshot(),
    };
  }

  /**
   * Conformance-only crash boundary.  Unlike `stop`, this does not send a
   * component-private control action: it terminates the actual child process
   * and waits for its observed exit before a supervisor may relaunch it.
   */
  async terminateForConformance(timeoutMs = 10_000): Promise<ProcessStopResult> {
    const boundedTimeout = Math.max(1, timeoutMs);
    const deadline = Date.now() + boundedTimeout;
    const reserve = Math.min(250, Math.max(1, Math.floor(boundedTimeout / 4)));
    const gracefulDeadline = deadline - reserve;
    const remaining = (): number => Math.max(1, deadline - Date.now());
    const gracefulRemaining = (): number => Math.max(1, gracefulDeadline - Date.now());
    let killEscalationAttempted = false;
    let killEscalationEffective = false;
    if (this.process.exitCode === null) this.child.kill("SIGTERM");
    const forced = setTimeout(() => {
      if (this.child.exitCode === null) {
        killEscalationAttempted = true;
        this.child.kill("SIGKILL");
      }
    }, gracefulRemaining());
    let exit: { code: number; at: string } | null;
    try {
      exit = await awaitExitWithin(this.#exit, remaining());
    } finally {
      clearTimeout(forced);
    }
    if (exit === null) {
      if (this.child.exitCode === null && !killEscalationAttempted) {
        killEscalationAttempted = true;
        this.child.kill("SIGKILL");
      }
      throw new ProcessExitTimeoutError(this.componentId, this.evidence.snapshot(), killEscalationAttempted, killEscalationEffective, this.process.exitCode === null);
    }
    killEscalationEffective = killEscalationAttempted &&
      this.child.signalCode === "SIGKILL";
    if (!this.child.stdin.destroyed) this.child.stdin.destroy();
    if (!await completionWithin(this.#stdioClosed, remaining())) {
      throw new ProcessStdioDrainTimeoutError(
        this.componentId,
        exit.code,
        this.evidence.snapshot(),
        killEscalationAttempted,
        killEscalationEffective,
      );
    }
    return {
      stoppedAt: exit.at,
      exitCode: exit.code,
      killEscalated: killEscalationEffective,
      killEscalationAttempted,
      killEscalationEffective,
      telemetry: {
        requestedAt: null,
        correlationKind: null,
        correlationId: null,
        acknowledgedAt: null,
        acknowledgement: "not_requested",
      },
      evidence: this.evidence.snapshot(),
    };
  }
}

export interface HttpControlResponse {
  status: number;
  body: JsonObject;
}

export interface ReadyProcessOptions extends ProcessEvidenceDirectoryOptions {
  componentId: ComponentId;
  command: ProcessCommandDescriptor;
  absoluteWorkingDirectory: string;
  environment?: Readonly<Record<string, string | undefined>>;
  /**
   * On Windows, Node cannot deliver POSIX signals with child.kill(). The
   * Gateway CLI exposes a test-only IPC signal proxy so the supervised
   * process can still execute its real graceful signal handler and exit 0.
   */
  useTestSignalProxy?: boolean;
  taskkillVerificationDelayMsForTest?: number;
  taskkillSpawnDelayMsForTest?: number;
  taskkillForcePostSpawnDeadlineForTest?: boolean;
  taskkillForceZeroRemainingAfterSpawnForTest?: boolean;
  taskkillSpawnObserverForTest?: () => void;
  taskkillCloseObserverForTest?: () => void;
  readonly preReadyBootstrap?: Readonly<{
    readonly request: JsonObject;
    readonly timeoutMs: number;
    validateResponse(value: JsonObject): void;
  }>;
  validateReadiness(value: JsonObject): void;
}

interface WindowsTaskkillIdentity {
  readonly controllerRoot: string;
  readonly path: string;
  readonly realPath: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly sha256: string;
}

function normalizeWindowsPath(value: string): string {
  return value.replace(/^\\\\\?\\/u, "").replace(/[\\/]+$/u, "").toLowerCase();
}

function taskkillSha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function resolveWindowsTaskkillIdentity(): WindowsTaskkillIdentity | null {
  const systemPaths = resolveWindowsSystemPaths();
  if (systemPaths === null) return null;
  const controllerRoot = systemPaths.windowsRoot;
  const executable = systemPaths.taskkill;
  const entry = lstatSync(executable, { bigint: true });
  const realPath = realpathSync.native(executable);
  const stat = statSync(realPath, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink() || !stat.isFile() || entry.dev !== stat.dev || entry.ino !== stat.ino ||
      normalizeWindowsPath(executable) !== normalizeWindowsPath(realPath)) {
    throw new Error("Windows taskkill identity resolves through a substituted path");
  }
  return Object.freeze({
    controllerRoot,
    path: executable,
    realPath,
    device: stat.dev,
    inode: stat.ino,
    sha256: taskkillSha256(realPath),
  });
}

function assertTaskkillDeadline(deadlineMs: number): void {
  if (Date.now() >= deadlineMs) throw new Error("taskkill lifecycle deadline expired before spawn");
}

function verifyWindowsTaskkillIdentity(expected: WindowsTaskkillIdentity, deadlineMs: number): void {
  assertTaskkillDeadline(deadlineMs);
  const systemPaths = resolveWindowsSystemPaths();
  assertTaskkillDeadline(deadlineMs);
  if (systemPaths === null || normalizeWindowsPath(systemPaths.windowsRoot) !== normalizeWindowsPath(expected.controllerRoot) ||
      normalizeWindowsPath(systemPaths.taskkill) !== normalizeWindowsPath(expected.path)) {
    throw new Error("Windows controller environment changed after taskkill planning");
  }
  const entry = lstatSync(expected.path, { bigint: true });
  assertTaskkillDeadline(deadlineMs);
  const realPath = realpathSync.native(expected.path);
  assertTaskkillDeadline(deadlineMs);
  const stat = statSync(realPath, { bigint: true });
  assertTaskkillDeadline(deadlineMs);
  const sha256 = taskkillSha256(realPath);
  assertTaskkillDeadline(deadlineMs);
  if (!entry.isFile() || entry.isSymbolicLink() || !stat.isFile() || entry.dev !== expected.device || entry.ino !== expected.inode ||
      stat.dev !== expected.device || stat.ino !== expected.inode || normalizeWindowsPath(realPath) !== normalizeWindowsPath(expected.realPath) ||
      sha256 !== expected.sha256) {
    throw new Error("bound Windows taskkill identity or bytes changed");
  }
}

interface PendingReadyProcessStop {
  readonly nonce: string;
  readonly settle: (status: "closed" | "failed") => void;
  readonly fail: (error: Error) => void;
}

export class StrictReadyProcess {
  readonly transcript: ProcessTranscriptRecord[];
  readonly readiness: JsonObject;
  readonly process: ProcessEvidence;
  readonly pid: number;
  #exit: Promise<{ code: number; at: string }>;
  #stdioClosed: Promise<void>;
  #stopPromise: Promise<ProcessStopResult> | null = null;
  #pendingStop: PendingReadyProcessStop | null = null;

  private constructor(
    readonly componentId: ComponentId,
    private readonly child: ChildProcessWithoutNullStreams,
    readiness: JsonObject,
    transcript: ProcessTranscriptRecord[],
    startedAt: string,
    readyAt: string,
    private readonly useTestSignalProxy: boolean,
    private readonly taskkillIdentity: WindowsTaskkillIdentity | null,
    private readonly taskkillVerificationDelayMsForTest: number,
    private readonly taskkillSpawnDelayMsForTest: number,
    private readonly taskkillForcePostSpawnDeadlineForTest: boolean,
    private readonly taskkillForceZeroRemainingAfterSpawnForTest: boolean,
    private readonly taskkillSpawnObserverForTest: (() => void) | undefined,
    private readonly taskkillCloseObserverForTest: (() => void) | undefined,
    private readonly evidence: ProcessEvidenceRecorder,
    stdioCompletion: Promise<void>,
  ) {
    this.readiness = readiness;
    this.transcript = transcript;
    const pid = child.pid;
    if (pid === undefined) throw new Error(`${componentId} lost its process id`);
    this.pid = pid;
    this.process = { pid, startedAt, readyAt, stoppedAt: null, exitCode: null };
    this.#exit = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        const at = new Date().toISOString();
        const normalized = code ?? (signal === null ? 1 : 128);
        this.process.stoppedAt = at;
        this.process.exitCode = normalized;
        this.#pendingStop?.fail(new Error(`${this.componentId} exited before STOP acknowledgement`));
        resolve({ code: normalized, at });
      });
    });
    this.#stdioClosed = stdioCompletion;
    child.on("message", (message: unknown) => {
      const pending = this.#pendingStop;
      if (pending === null || message === null || typeof message !== "object" || Array.isArray(message)) return;
      const candidate = message as { readonly action?: unknown; readonly nonce?: unknown; readonly status?: unknown };
      // Only an acknowledgement for the currently pending opaque generation
      // has authority to release the parent end of IPC. Old, forged, or noisy
      // child messages are intentionally ignored.
      if (candidate.action !== "shutdown_complete" || candidate.nonce !== pending.nonce ||
          (candidate.status !== "closed" && candidate.status !== "failed") ||
          Object.keys(candidate).length !== 3) return;
      pending.settle(candidate.status);
    });
    child.on("disconnect", () => {
      this.#pendingStop?.fail(new Error(`${this.componentId} IPC disconnected before STOP acknowledgement`));
    });
  }

  static async start(options: ReadyProcessOptions): Promise<StrictReadyProcess> {
    const startedAt = new Date().toISOString();
    const taskkillIdentity = resolveWindowsTaskkillIdentity();
    const evidence = new ProcessEvidenceRecorder(
      options.componentId,
      processCommandHash(options.command),
      options.evidenceDirectory,
      options.evidenceStoreTest,
    );
    const child = spawn(options.command.executable, options.command.args, {
      cwd: options.absoluteWorkingDirectory,
      env: sanitizedProductionRuntimeEnvironment(process.env, {
        ...options.environment,
        ...(options.useTestSignalProxy === true ? { NODE_ENV: "test" } : {}),
      }),
      shell: false,
      stdio: options.useTestSignalProxy === true || options.preReadyBootstrap !== undefined
        ? ["pipe", "pipe", "pipe", "ipc"]
        : ["pipe", "pipe", "pipe"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    evidence.spawned(child.pid);
    const stdioCompletion = stdioClosed(child);
    const evidenceCompletion = stdioCompletion.then(() => evidence.complete());
    void evidenceCompletion.catch(() => undefined);
    if (child.pid === undefined) {
      await evidence.failure("spawn");
      throw new Error(`${options.componentId} did not receive a process id`);
    }
    const transcript: ProcessTranscriptRecord[] = [];
    let bootstrapComplete = options.preReadyBootstrap === undefined;
    const bootstrap = options.preReadyBootstrap === undefined
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(`${options.componentId} pre-READY bootstrap timed out`));
          }, options.preReadyBootstrap!.timeoutMs);
          timer.unref();
          const onMessage = (message: unknown): void => {
            if (message === null || typeof message !== "object" || Array.isArray(message)) return;
            try {
              options.preReadyBootstrap!.validateResponse(message as JsonObject);
              bootstrapComplete = true;
              clearTimeout(timer);
              child.off("message", onMessage);
              resolve();
            } catch (error) {
              clearTimeout(timer);
              child.off("message", onMessage);
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          };
          child.on("message", onMessage);
          child.send?.(options.preReadyBootstrap!.request);
        });
    void bootstrap.catch(() => undefined);
    let observedExitCode: number | null = null;
    child.once("exit", (code, signal) => {
      observedExitCode = code ?? (signal === null ? 1 : 128);
      evidence.exited(code, signal);
    });
    let ready: { value: JsonObject; at: string };
    try {
      ready = await new Promise<{ value: JsonObject; at: string }>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let settled = false;
      const fail = (failure: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        void evidence.failure("pre_ready").then(
          () => reject(failure),
          (error: unknown) => reject(error instanceof Error ? error : new Error(String(error))),
        );
      };
      const timer = setTimeout(() => {
        fail(new Error(`${options.componentId} readiness timed out`));
      }, options.command.readiness.timeoutMs);
      child.once("error", (error) => fail(error));
      child.once("exit", (code, signal) => {
        if (!settled) fail(new Error(`${options.componentId} exited before readiness (${String(code ?? signal)})`));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        evidence.observeChunk("stdout", chunk);
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > MAX_CONTROL_LINE_BYTES && !buffer.includes(0x0a)) {
          fail(new Error(`${options.componentId} readiness exceeds 64 KiB`));
          return;
        }
        const newline = buffer.indexOf(0x0a);
        if (newline < 0) return;
        let line = buffer.subarray(0, newline);
        if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
        try {
          const value = parseJsonObject(line, `${options.componentId} readiness`);
          if (!bootstrapComplete) {
            throw new Error(`${options.componentId} published READY before storage bootstrap`);
          }
          options.validateReadiness(value);
          settled = true;
          clearTimeout(timer);
          const at = new Date().toISOString();
          appendBoundedTranscript(transcript, { stream: "stdout", at, line: decodeUtf8(line, `${options.componentId} readiness`) });
          resolve({ value, at });
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        evidence.observeChunk("stderr", chunk);
        let line: string;
        try {
          line = decodeUtf8(chunk, `${options.componentId} stderr`).trimEnd();
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (Buffer.byteLength(line, "utf8") > MAX_CONTROL_LINE_BYTES) {
          fail(new Error(`${options.componentId} stderr chunk exceeds 64 KiB`));
          return;
        }
        if (line.length > 0) appendBoundedTranscript(transcript, { stream: "stderr", at: new Date().toISOString(), line });
      });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ReadyProcessStartError(
        message,
        boundedProcessDiagnostics({
          componentId: options.componentId,
          phase: "ready",
          exitCode: observedExitCode,
          transcript,
        }),
      );
    }
    await bootstrap;
    return new StrictReadyProcess(
      options.componentId,
      child,
      ready.value,
      transcript,
      startedAt,
      ready.at,
      options.useTestSignalProxy === true,
      taskkillIdentity,
      Math.max(0, options.taskkillVerificationDelayMsForTest ?? 0),
      Math.max(0, options.taskkillSpawnDelayMsForTest ?? 0),
      options.taskkillForcePostSpawnDeadlineForTest === true,
      options.taskkillForceZeroRemainingAfterSpawnForTest === true,
      options.taskkillSpawnObserverForTest,
      options.taskkillCloseObserverForTest,
      evidence,
      evidenceCompletion,
    );
  }

  stop(
    _signal: NodeJS.Signals = "SIGTERM",
    timeoutMs = 10_000,
  ): Promise<ProcessStopResult> {
    void _signal;
    if (this.#stopPromise !== null) return this.#stopPromise;
    this.#stopPromise = this.#stopWithHandshake(timeoutMs);
    return this.#stopPromise;
  }

  async #stopWithHandshake(timeoutMs: number): Promise<ProcessStopResult> {
    const boundedTimeout = Math.max(1, timeoutMs);
    const deadline = Date.now() + boundedTimeout;
    const reserve = Math.min(250, Math.max(1, Math.floor(boundedTimeout / 4)));
    const gracefulDeadline = deadline - reserve;
    const remaining = (): number => Math.max(1, deadline - Date.now());
    const gracefulRemaining = (): number => Math.max(1, gracefulDeadline - Date.now());
    let requestedAt: string | null = null;
    let correlationId: string | null = null;
    let acknowledgedAt: string | null = null;
    let acknowledgement: ProcessStopTelemetry["acknowledgement"] = "not_requested";
    let killEscalationAttempted = false;
    let ownedTreeTerminationConfirmed = false;
    const result = async (stoppedAt: string, exitCode: number, killEscalationAttempted: boolean): Promise<ProcessStopResult> => {
      const killEscalationEffective = killEscalationAttempted &&
        (this.child.signalCode === "SIGKILL" || ownedTreeTerminationConfirmed);
      if (!await completionWithin(this.#stdioClosed, remaining())) {
        throw new ProcessStdioDrainTimeoutError(this.componentId, exitCode, this.evidence.snapshot(), killEscalationAttempted, killEscalationEffective);
      }
      return {
      stoppedAt,
      exitCode,
      killEscalated: killEscalationEffective,
      killEscalationAttempted,
      killEscalationEffective,
      telemetry: {
        requestedAt,
        correlationKind: correlationId === null ? null : "ipc_stop_nonce",
        correlationId,
        acknowledgedAt,
        acknowledgement,
      },
      evidence: this.evidence.snapshot(),
      };
    };
    if (this.process.exitCode !== null) {
      return await result(this.process.stoppedAt ?? new Date().toISOString(), this.process.exitCode, false);
    }
    const killTree = async (): Promise<boolean> => {
      let termination: ExactTreeTerminationResult;
      try {
        termination = await terminateExactChildTree(
          this.child,
          this.taskkillIdentity,
          deadline,
          this.taskkillVerificationDelayMsForTest,
          this.taskkillSpawnDelayMsForTest,
          this.taskkillForcePostSpawnDeadlineForTest,
          this.taskkillForceZeroRemainingAfterSpawnForTest,
          this.taskkillSpawnObserverForTest,
          this.taskkillCloseObserverForTest,
        );
      } catch (error) {
        if ((error as { readonly killAttempted?: unknown }).killAttempted === true) killEscalationAttempted = true;
        if (error instanceof Error && /taskkill.*(?:lifecycle deadline|did not exit)/u.test(error.message)) {
          throw new ProcessExitTimeoutError(
            this.componentId,
            this.evidence.snapshot(),
            killEscalationAttempted,
            false,
            this.process.exitCode === null,
            (error as { readonly helperReapUncertain?: unknown }).helperReapUncertain === true,
          );
        }
        throw error;
      }
      killEscalationAttempted ||= termination.attempted;
      ownedTreeTerminationConfirmed ||= termination.confirmed;
      return true;
    };
    try {
      if (!this.useTestSignalProxy || !this.child.connected || this.child.send === undefined) {
        if (!await killTree()) throw new ProcessExitTimeoutError(this.componentId, this.evidence.snapshot(), true, false, this.process.exitCode === null);
      } else {
        const nonce = randomUUID();
        requestedAt = new Date().toISOString();
        correlationId = nonce;
        const acknowledged = await new Promise<"closed" | "failed">((resolve, reject) => {
          const fail = (error: Error): void => {
            if (this.#pendingStop?.nonce !== nonce) return;
            clearTimeout(timer);
            this.#pendingStop = null;
            reject(error);
          };
          const timer = setTimeout(() => fail(new Error(`${this.componentId} STOP acknowledgement timed out`)), gracefulRemaining());
          const pending: PendingReadyProcessStop = {
            nonce,
            settle: (status) => {
              if (this.#pendingStop !== pending) return;
              clearTimeout(timer);
              this.#pendingStop = null;
              acknowledgedAt = new Date().toISOString();
              acknowledgement = status === "closed" ? "closed" : "failed_or_timed_out";
              resolve(status);
            },
            fail,
          };
          this.#pendingStop = pending;
          try {
            this.child.send({ action: "STOP", nonce }, (error) => {
              if (error == null) return;
              pending.fail(error);
            });
          } catch (error) {
            pending.fail(error instanceof Error ? error : new Error(String(error)));
          }
        });
        if (acknowledged !== "closed") throw new Error(`${this.componentId} STOP reported failed shutdown`);
        // Only the parent releases IPC, after it has matched the exact ack.
        if (this.child.connected) this.child.disconnect();
        // The IPC fixture has no stdin EOF shutdown hook. Releasing this
        // parent-owned pipe after the exact ACK lets its IPC-disconnect exit
        // complete; JSONL children deliberately do not take this path.
        if (!this.child.stdin.destroyed) this.child.stdin.destroy();
      }
      const exit = await awaitExitWithin(this.#exit, gracefulRemaining());
      if (exit === null) {
        if (!await killTree()) throw new ProcessExitTimeoutError(this.componentId, this.evidence.snapshot(), true, false, this.process.exitCode === null);
        const forcedExit = await awaitExitWithin(this.#exit, remaining());
        if (forcedExit === null) throw new ProcessExitTimeoutError(this.componentId, this.evidence.snapshot(), true, false, this.process.exitCode === null);
        if (!this.child.stdin.destroyed) this.child.stdin.destroy();
        return await result(forcedExit.at, forcedExit.code, killEscalationAttempted);
      }
      if (!this.child.stdin.destroyed) this.child.stdin.destroy();
      return await result(exit.at, exit.code, killEscalationAttempted);
    } catch (error) {
      if (error instanceof ProcessExitTimeoutError) throw error;
      if (acknowledgement === "not_requested" && requestedAt !== null) {
        acknowledgedAt = new Date().toISOString();
        acknowledgement = "failed_or_timed_out";
      }
      this.#pendingStop = null;
      if (this.process.exitCode === null && !killEscalationAttempted && !await killTree()) {
        throw new ProcessExitTimeoutError(this.componentId, this.evidence.snapshot(), true, false, this.process.exitCode === null);
      }
      const exit = await awaitExitWithin(this.#exit, remaining());
      if (exit === null) throw new ProcessExitTimeoutError(this.componentId, this.evidence.snapshot(), killEscalationAttempted, false, this.process.exitCode === null);
      if (!this.child.stdin.destroyed) this.child.stdin.destroy();
      return await result(exit.at, exit.code, killEscalationAttempted);
    }
  }
}

async function awaitExitWithin(
  exit: Promise<{ code: number; at: string }>,
  timeoutMs: number,
): Promise<{ code: number; at: string } | null> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), Math.max(1, timeoutMs));
    void exit.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

async function completionWithin(completion: Promise<void>, timeoutMs: number): Promise<boolean> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
    void completion.then(() => { clearTimeout(timer); resolve(true); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

/** Terminate only the supervised child (and, on Windows, only its exact tree). */
interface ExactTreeTerminationResult {
  readonly attempted: boolean;
  readonly confirmed: boolean;
}

async function terminateExactChildTree(
  child: ChildProcessWithoutNullStreams,
  taskkillIdentity: WindowsTaskkillIdentity | null,
  deadlineMs: number,
  verificationDelayMsForTest: number,
  spawnDelayMsForTest: number,
  forcePostSpawnDeadlineForTest: boolean,
  forceZeroRemainingAfterSpawnForTest: boolean,
  spawnObserverForTest: (() => void) | undefined,
  closeObserverForTest: (() => void) | undefined,
): Promise<ExactTreeTerminationResult> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return { attempted: false, confirmed: false };
  if (process.platform !== "win32") {
    assertTaskkillDeadline(deadlineMs);
    try { return { attempted: child.kill("SIGKILL"), confirmed: false }; }
    catch { return { attempted: false, confirmed: false }; }
  }
  if (taskkillIdentity === null) throw new Error("bound Windows taskkill identity is unavailable");
  if (verificationDelayMsForTest > 0) {
    const completed = await completionWithin(
      new Promise<void>((resolve) => setTimeout(resolve, verificationDelayMsForTest)),
      Math.max(1, deadlineMs - Date.now()),
    );
    if (!completed) throw new Error("taskkill lifecycle deadline expired during identity verification");
  }
  const joinReserve = Math.min(100, Math.max(1, Math.floor(Math.max(1, deadlineMs - Date.now()) / 4)));
  const spawnDeadlineMs = deadlineMs - joinReserve;
  verifyWindowsTaskkillIdentity(taskkillIdentity, spawnDeadlineMs);
  assertTaskkillDeadline(spawnDeadlineMs);
  if (spawnDelayMsForTest > 0) {
    const completed = await completionWithin(
      new Promise<void>((resolve) => setTimeout(resolve, spawnDelayMsForTest)),
      Math.max(1, spawnDeadlineMs - Date.now()),
    );
    if (!completed) throw new Error("taskkill lifecycle deadline expired before spawn");
  }
  spawnObserverForTest?.();
  assertTaskkillDeadline(spawnDeadlineMs);
  const taskkill = spawn(taskkillIdentity.realPath, ["/pid", String(pid), "/T", "/F"], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
    env: sanitizedProductionRuntimeEnvironment(process.env, {
      SystemRoot: taskkillIdentity.controllerRoot,
      WINDIR: taskkillIdentity.controllerRoot,
    }),
  });
  const boundedTimeout = forceZeroRemainingAfterSpawnForTest ? 0 : deadlineMs - Date.now();
  const crossedDeadlineDuringSpawn = forcePostSpawnDeadlineForTest || Date.now() >= spawnDeadlineMs;
  return await new Promise<ExactTreeTerminationResult>((resolve, reject) => {
    let joinTimer: NodeJS.Timeout | null = null;
    let timedOut = false;
    let closeObserved = false;
    const observeClose = (): void => {
      if (closeObserved) return;
      closeObserved = true;
      closeObserverForTest?.();
    };
    let actionTimer: NodeJS.Timeout | null = null;
    const rejectCrossedSpawn = (): void => reject(Object.assign(
      new Error("taskkill lifecycle deadline expired during spawn"),
      { killAttempted: true, helperReapUncertain: !closeObserved },
    ));
    taskkill.once("error", () => {
      observeClose();
      if (actionTimer !== null) clearTimeout(actionTimer);
      if (joinTimer !== null) clearTimeout(joinTimer);
      if (crossedDeadlineDuringSpawn) rejectCrossedSpawn();
      else resolve({ attempted: true, confirmed: false });
    });
    taskkill.once("close", (code) => {
      observeClose();
      if (actionTimer !== null) clearTimeout(actionTimer);
      if (joinTimer !== null) clearTimeout(joinTimer);
      if (crossedDeadlineDuringSpawn) rejectCrossedSpawn();
      else resolve({ attempted: true, confirmed: !timedOut && code === 0 });
    });
    if (crossedDeadlineDuringSpawn) {
      if (taskkill.exitCode === null && taskkill.signalCode === null) taskkill.kill("SIGKILL");
      if (boundedTimeout > 0) {
        joinTimer = setTimeout(() => reject(Object.assign(
          new Error("bound taskkill did not exit within the original lifecycle deadline"),
          { killAttempted: true, helperReapUncertain: true },
        )), boundedTimeout);
      } else rejectCrossedSpawn();
      return;
    }
    const postSpawnJoinReserve = Math.min(100, Math.max(1, Math.floor(boundedTimeout / 4)));
    actionTimer = setTimeout(() => {
      timedOut = true;
      if (taskkill.exitCode === null && taskkill.signalCode === null) taskkill.kill("SIGKILL");
      joinTimer = setTimeout(() => reject(Object.assign(
        new Error("bound taskkill did not exit within the lifecycle deadline"),
        { killAttempted: true, helperReapUncertain: true },
      )), postSpawnJoinReserve);
    }, boundedTimeout - postSpawnJoinReserve);
  });
}

export async function strictHttpControl(
  url: string,
  token: string,
  request: JsonObject,
  timeoutMs = 30_000,
): Promise<HttpControlResponse> {
  const bytes = Buffer.from(JSON.stringify(request), "utf8");
  if (bytes.length > MAX_CONTROL_LINE_BYTES) throw new Error("Gateway control request exceeds 64 KiB");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rbp-test-control": token },
    body: bytes,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bodyBytes = Buffer.from(await response.arrayBuffer());
  if (bodyBytes.length > MAX_CONTROL_LINE_BYTES) throw new Error("Gateway control response exceeds 64 KiB");
  return { status: response.status, body: parseJsonObject(bodyBytes, "Gateway control response") };
}
