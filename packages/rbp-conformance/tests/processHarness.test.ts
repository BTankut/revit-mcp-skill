import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";

import {
  ControlResponseError,
  ProcessExitTimeoutError,
  ProcessStdioDrainTimeoutError,
  StrictJsonlProcess,
  StrictReadyProcess,
} from "../src/processHarness.js";
import type { ProcessCommandDescriptor } from "../src/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, "fixtures", "jsonl-component.mjs");
const readyIpcFixture = path.join(here, "fixtures", "ready-ipc-shutdown-child.mjs");

function command(mode = "good"): ProcessCommandDescriptor {
  return {
    executable: process.execPath,
    args: [fixture, mode],
    workingDirectory: "packages/rbp-conformance",
    environmentKeys: [],
    readiness: { kind: "stdout_pattern", value: "ready", timeoutMs: 5_000 },
    shutdown: { signal: "SIGTERM", timeoutMs: 5_000 },
  };
}

function readyIpcCommand(mode: string, marker?: string): ProcessCommandDescriptor {
  return {
    executable: process.execPath,
    args: [readyIpcFixture, mode, ...(marker === undefined ? [] : [marker])],
    workingDirectory: "packages/rbp-conformance",
    environmentKeys: [],
    readiness: { kind: "stdout_pattern", value: "ready", timeoutMs: 5_000 },
    shutdown: { signal: "SIGTERM", timeoutMs: 5_000 },
  };
}

async function startReadyIpc(mode: string, marker?: string): Promise<StrictReadyProcess> {
  return await StrictReadyProcess.start({
    componentId: "addin_loopback_fixture",
    command: readyIpcCommand(mode, marker),
    absoluteWorkingDirectory: here,
    useTestSignalProxy: true,
    validateReadiness(value) { expect(value).toMatchObject({ ready: true, component: "fixture-test" }); },
  });
}

type TestIpcSend = (message: unknown, callback?: (error: Error | null) => void) => boolean;

function testIpcSend(child: StrictReadyProcess): { send: TestIpcSend } {
  return (child as unknown as { readonly child: { send: TestIpcSend } }).child;
}

describe("strict JSONL process control", () => {
  it("requires the exact IPC storage grant before accepting READY", async () => {
    const nonce = "a".repeat(64);
    const script = `process.on('message',(m)=>{if(m.action==='bootstrap_storage_v1'){process.send({action:'storage_owned_v1',nonce:m.nonce,ownerEpoch:7,profileDigest:'sha256:'+('${"b".repeat(64)}')});process.stdout.write(JSON.stringify({ready:true,component:'fixture-test'})+'\\n');}else if(m.action==='STOP'){process.send({action:'shutdown_complete',nonce:m.nonce,status:'closed'},()=>process.exit(0));}});`;
    const child = await StrictReadyProcess.start({
      componentId: "addin_loopback_fixture",
      command: { ...command(), args: ["--eval", script] },
      absoluteWorkingDirectory: here,
      useTestSignalProxy: true,
      preReadyBootstrap: {
        request: { action: "bootstrap_storage_v1", nonce },
        timeoutMs: 2_000,
        validateResponse(value) {
          expect(value).toStrictEqual({
            action: "storage_owned_v1",
            nonce,
            ownerEpoch: 7,
            profileDigest: `sha256:${"b".repeat(64)}`,
          });
        },
      },
      validateReadiness(value) {
        expect(value).toMatchObject({ ready: true, component: "fixture-test" });
      },
    });
    await expect(child.stop("SIGTERM", 2_000)).resolves.toMatchObject({
      exitCode: 0,
      killEscalated: false,
    });
  });

  it.each(["stop", "terminate"] as const)(
    "bounds inherited-pipe drain after a real clean child exit during %s without false kill escalation",
    async (mode) => {
      const root = mkdtempSync(path.join(tmpdir(), "wp12-inherited-pipe-"));
      const windowsSleeper = path.join(root, "inherited-pipe-child.exe");
      if (process.platform === "win32") {
        const csharp = `
          using System; using System.Diagnostics; using System.Text.RegularExpressions;
          public static class PipeHolder {
            public static int Main(string[] args) {
              if (args.Length > 0 && args[0] == "hold") { Console.Error.Write("holder"); Console.Error.Flush(); System.Threading.Thread.Sleep(30000); return 0; }
              var executable=Process.GetCurrentProcess().MainModule.FileName;
              var holder=Process.Start(new ProcessStartInfo(executable,"hold") { UseShellExecute=false });
              Console.WriteLine("{\\"ready\\":true,\\"component\\":\\"fixture-test\\",\\"controlVersion\\":1,\\"maxControlLineBytes\\":65536,\\"actions\\":[\\"shutdown\\"],\\"grandchildPid\\":"+holder.Id+"}"); Console.Out.Flush();
              var line=Console.ReadLine(); var id=Regex.Match(line,"\\\"id\\\"\\\\s*:\\\"([^\\\"]+)\\\"").Groups[1].Value; System.Threading.Thread.Sleep(250);
              Console.WriteLine("{\\"controlVersion\\":1,\\"id\\":\\""+id+"\\",\\"ok\\":true,\\"result\\":{\\"stopped\\":true}}"); Console.Out.Flush(); return 0;
            }
          }`;
        const compile = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition '${csharp}' -OutputAssembly '${windowsSleeper.replaceAll("'", "''")}' -OutputType ConsoleApplication`;
        execFileSync(path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(compile, "utf16le").toString("base64")],
          { windowsHide: true, stdio: "pipe", timeout: 5_000 });
      }
      const source = [
        "const {spawn}=require('node:child_process');",
        "const grandchild=spawn(process.execPath,['--eval','setInterval(()=>{},1000)'],{stdio:['ignore',1,2],windowsHide:true});",
        "process.stdout.write(JSON.stringify({ready:true,component:'fixture-test',controlVersion:1,maxControlLineBytes:65536,actions:['shutdown'],grandchildPid:grandchild.pid})+'\\n');",
        "process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{const value=JSON.parse(chunk.trim());process.stdout.write(JSON.stringify({controlVersion:1,id:value.id,ok:true,result:{stopped:true}})+'\\n',()=>process.exit(0));});",
      ].join("\n");
      const child = await StrictJsonlProcess.start({
        componentId: "addin_loopback_fixture",
        command: process.platform === "win32"
          ? { ...command(), executable: windowsSleeper, args: [] }
          : { ...command(), args: ["--eval", source] },
        absoluteWorkingDirectory: root,
        expectedReadinessFields: { component: "fixture-test" },
        requiredActions: ["shutdown"],
      });
      const grandchildPid = Number(child.readiness.grandchildPid);
      expect(Number.isSafeInteger(grandchildPid)).toBe(true);
      const started = Date.now();
      try {
        const operation = mode === "stop" ? child.stop(1_000) : child.terminateForConformance(1_000);
        await expect(operation).rejects.toMatchObject({
          name: "ProcessStdioDrainTimeoutError",
          componentId: "addin_loopback_fixture",
          exitCode: mode === "stop" ? 0 : expect.any(Number),
          killEscalated: false,
          evidence: { exitCode: mode === "stop" ? 0 : null },
        } satisfies Partial<ProcessStdioDrainTimeoutError>);
        expect(Date.now() - started).toBeLessThan(1_100);
        expect(child.process.exitCode).not.toBeNull();
      } finally {
        if (process.platform === "win32") {
          try { execFileSync(path.join(process.env.SystemRoot!, "System32", "taskkill.exe"), ["/pid", String(grandchildPid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* already exited */ }
        } else {
          try { process.kill(grandchildPid, "SIGKILL"); } catch { /* already exited */ }
        }
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          try { process.kill(grandchildPid, 0); } catch { break; }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
      }
    },
  );

  it("waits for child stdio close and retains an unterminated stderr tail after control shutdown", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wp12-stdio-tail-"));
    const script = path.join(root, "tail-child.mjs");
    const evidenceDirectory = path.join(root, "retained");
    mkdirSync(evidenceDirectory);
    const sentinels = ["BEARER_CANARY", "BASIC_CANARY", "SUBJECT_CANARY", "rs_RSID_CANARY", "ALLOWED_CANARY", "path-canary", "query-canary", "424242"];
    const diagnostic = {
      message: "Authorization: Basic BASIC_CANARY",
      durabilityEvents: [{ subject: "SUBJECT_CANARY", rsid: "rs_RSID_CANARY", event: "terminal_persisted" }],
      observations: [{ requestId: "SUBJECT_CANARY", request_id: "rs_RSID_CANARY" }],
      principal_id: "SUBJECT_CANARY",
      tenant_id: "SUBJECT_CANARY",
      user_id: "SUBJECT_CANARY",
      seat_id: "SUBJECT_CANARY",
      session_binding: "SUBJECT_CANARY",
      correlation_id: "SUBJECT_CANARY",
    };
    const allowedCanaries = {
      actions: ["ALLOWED_CANARY"], event: "ALLOWED_CANARY", code: "ALLOWED_CANARY",
      component: "ALLOWED_CANARY", phase: "ALLOWED_CANARY", state: "ALLOWED_CANARY",
      status: "ALLOWED_CANARY", transport: "ALLOWED_CANARY",
      ws_url: "ws://127.0.0.1:54321/path-canary?secret=query-canary#ALLOWED_CANARY",
    };
    const numericCanaries = Object.fromEntries(["actions", "event", "code", "component", "phase", "state", "status", "transport", "ws_url", "ready", "ok", "complete", "stopped", "controlVersion", "maxControlLineBytes", "exitCode"].map((key) => [key, 424242]));
    const stderr = `Authorization: Bearer BEARER_CANARY\n${JSON.stringify(diagnostic)}\ndiagnostic ALLOWED_CANARY ${JSON.stringify(diagnostic)}\n${JSON.stringify(allowedCanaries)}\n${JSON.stringify(numericCanaries)}`;
    writeFileSync(script, [
      "process.stdout.write(JSON.stringify({ready:true,component:'fixture-test',controlVersion:1,maxControlLineBytes:65536,actions:['shutdown']})+'\\n');",
      `const diagnostic=${JSON.stringify(diagnostic)}; const stderr=${JSON.stringify(stderr)};`,
      "process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{const value=JSON.parse(chunk.trim());process.stdout.write(JSON.stringify({controlVersion:1,id:value.id,ok:true,result:{stopped:true,...diagnostic}})+'\\n',()=>{process.stderr.write(stderr,()=>process.exit(0));});});",
    ].join("\n"));
    try {
      const child = await StrictJsonlProcess.start({
        componentId: "addin_loopback_fixture",
        command: { ...command(), args: [script] },
        absoluteWorkingDirectory: root,
        evidenceDirectory,
        expectedReadinessFields: { component: "fixture-test" },
        requiredActions: ["shutdown"],
      });
      const stopped = await child.stop();
      expect(stopped).toMatchObject({ exitCode: 0, killEscalated: false, evidence: { exitCode: 0 } });
      expect(child.transcript.map(({ line }) => line).join("\n")).toContain("SUBJECT_CANARY");
      const retained = JSON.stringify(stopped.evidence);
      expect(retained).toContain("Authorization=[redacted]");
      expect(retained).toContain("durabilityEvents");
      expect(retained).toContain("terminal_persisted");
      const persisted = ["stdout", "stderr"].map((stream) =>
        readFileSync(path.join(evidenceDirectory, `addin_loopback_fixture.${stream}.log`), "utf8")).join("\n");
      for (const sentinel of sentinels) {
        expect(retained).not.toContain(sentinel);
        expect(persisted).not.toContain(sentinel);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["jsonl-shutdown", "ready-natural-exit"] as const)(
    "drains a real stderr close before delayed readiness without hanging on %s",
    async (mode) => {
      const root = mkdtempSync(path.join(tmpdir(), "wp12-early-stderr-"));
      const jsonl = mode === "jsonl-shutdown";
      const readiness = { ready: true, component: "fixture-test", controlVersion: 1, maxControlLineBytes: 65536, actions: ["shutdown"] };
      const source = [
        `require('node:fs').writeSync(2,'early stderr tail');require('node:fs').closeSync(2);setTimeout(()=>process.stdout.write(${JSON.stringify(JSON.stringify(readiness) + "\n")}),100);`,
        jsonl
          ? "process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{const value=JSON.parse(chunk.trim());process.stdout.write(JSON.stringify({controlVersion:1,id:value.id,ok:true,result:{stopped:true}})+'\\n',()=>{process.stdin.destroy();process.exitCode=0;});});"
          : "process.stdin.once('data',()=>{process.stdin.destroy();process.exitCode=0;});",
      ].join("\n");
      // Node duplicates Windows std handles before user code, so closing fd 2
      // alone does not close that pipe. A real child closes the inherited OS
      // handle directly here. No parent stream events or state are mocked.
      const windowsExecutable = path.join(root, "early-stderr.exe");
      let child: StrictJsonlProcess | StrictReadyProcess | undefined;
      try {
        if (process.platform === "win32") {
          const csharp = `
            using System;
            using System.Runtime.InteropServices;
            using System.Text.RegularExpressions;
            public static class EarlyStderr {
              [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int id);
              [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
              public static int Main(string[] args) {
                Console.Error.Write("early stderr tail"); Console.Error.Flush();
                if (!CloseHandle(GetStdHandle(-12))) return 3;
                Console.SetError(System.IO.TextWriter.Null);
                System.Threading.Thread.Sleep(100);
                Console.WriteLine(@"${JSON.stringify(readiness).replaceAll('"', '""')}"); Console.Out.Flush();
                var line = Console.ReadLine();
                if (args[0] == "jsonl-shutdown") {
                  var id = Regex.Match(line, "\\\"id\\\"\\\\s*:\\\"([^\\\"]+)\\\"").Groups[1].Value;
                  Console.WriteLine("{\\\"controlVersion\\\":1,\\\"id\\\":\\\"" + id + "\\\",\\\"ok\\\":true,\\\"result\\\":{\\\"stopped\\\":true}}"); Console.Out.Flush();
                }
                return 0;
              }
            }`;
          const compile = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition '${csharp.replaceAll("'", "''")}' -OutputAssembly '${windowsExecutable.replaceAll("'", "''")}' -OutputType ConsoleApplication`;
          execFileSync(path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
            ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(compile, "utf16le").toString("base64")],
            { windowsHide: true, stdio: "pipe", timeout: 5_000 });
        }
        const options = {
          componentId: "addin_loopback_fixture" as const,
          command: process.platform === "win32"
            ? { ...command(), executable: windowsExecutable, args: [mode] }
            : { ...command(), args: ["--eval", source] },
          absoluteWorkingDirectory: root,
        };
        child = jsonl
          ? await StrictJsonlProcess.start({ ...options, expectedReadinessFields: { component: "fixture-test" }, requiredActions: ["shutdown"] })
          : await StrictReadyProcess.start({ ...options, validateReadiness(value) { expect(value.ready).toBe(true); } });
        const handle = (child as unknown as { child: ChildProcessWithoutNullStreams }).child;
        // This is an observed pipe close, not merely a child-side intent to
        // close. A second subscription after readiness would miss this event.
        expect({ closed: handle.stderr.closed, ended: handle.stderr.readableEnded, destroyed: handle.stderr.destroyed }).toEqual({ closed: true, ended: true, destroyed: true });
        if (mode === "ready-natural-exit") {
          const exited = once(handle, "exit");
          handle.stdin.write("exit\n");
          await exited;
        }
        const stopped = await child.stop();
        expect(stopped).toMatchObject({ exitCode: 0, killEscalated: false, evidence: { exitCode: 0 } });
        expect(stopped.evidence.stderr.safeLines).toEqual(["early stderr tail"]);
        expect(stopped.telemetry.acknowledgement).toBe(
          jsonl ? "response_ok" : "not_requested",
        );
        expect(handle.stdout.closed).toBe(true);
        expect(() => process.kill(child!.pid, 0)).toThrow();
      } finally {
        if (child !== undefined && child.process.exitCode === null) await child.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("uses one opaque STOP generation, accepts only its exact ack, then parent-disconnects", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wp12-ready-stop-"));
    const marker = path.join(root, "child-stop.json");
    const child = await startReadyIpc("wrong-then-right", marker);
    const first = child.stop("SIGTERM", 2_000);
    const second = child.stop("SIGTERM", 2_000);
    expect(second).toBe(first);
    const stopped = await first;
    expect(stopped).toMatchObject({ exitCode: 0, killEscalated: false });
    expect(stopped.telemetry).toMatchObject({
      correlationKind: "ipc_stop_nonce",
      correlationId: expect.any(String),
      acknowledgement: "closed",
      requestedAt: expect.any(String),
      acknowledgedAt: expect.any(String),
    });
    expect(stopped.evidence).toMatchObject({
      componentId: "addin_loopback_fixture",
      pid: expect.any(Number),
      exitCode: 0,
      stdout: { sha256: expect.stringMatching(/^sha256:/u) },
      stderr: { sha256: expect.stringMatching(/^sha256:/u) },
    });
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ stopCount: 1 });
  });

  it("treats a false IPC send return as backpressure while the exact ACK completes naturally", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wp12-ready-backpressure-"));
    const marker = path.join(root, "child-backpressure.json");
    const child = await startReadyIpc("normal", marker);
    const handle = testIpcSend(child);
    const original = handle.send.bind(handle) as TestIpcSend;
    handle.send = ((message, callback) => {
      original(message, callback);
      return false;
    }) as TestIpcSend;
    await expect(child.stop("SIGTERM", 2_000)).resolves.toMatchObject({ exitCode: 0, killEscalated: false });
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({ stopCount: 1 });
  });

  it("escalates exactly once when false-backpressure is followed by an IPC callback error", async () => {
    const child = await startReadyIpc("normal");
    const handle = testIpcSend(child);
    handle.send = ((_message, callback) => {
      setTimeout(() => callback?.(new Error("planned IPC callback failure")), 1);
      return false;
    }) as TestIpcSend;
    await expect(child.stop("SIGTERM", 2_000)).resolves.toMatchObject({ killEscalated: true });
    expect(child.process.exitCode).not.toBeNull();
  });

  it.runIf(process.platform === "win32")("rejects controller environment mutation before bound taskkill use", async () => {
    const child = await StrictReadyProcess.start({
      componentId: "addin_loopback_fixture",
      command: { ...command(), args: ["--eval", "process.stdout.write(JSON.stringify({ready:true,component:'fixture-test'})+'\\n');setTimeout(()=>process.exit(7),100);"] },
      absoluteWorkingDirectory: here,
      validateReadiness(value) { expect(value).toMatchObject({ ready: true, component: "fixture-test" }); },
    });
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.WINDIR;
    try {
      process.env.SystemRoot = path.join(tmpdir(), "mutated-system-root");
      process.env.WINDIR = process.env.SystemRoot;
      await expect(child.stop("SIGTERM", 1_000)).rejects.toThrow(/GLOBALROOT|environment changed/u);
    } finally {
      if (originalSystemRoot === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = originalSystemRoot;
      if (originalWindir === undefined) delete process.env.WINDIR; else process.env.WINDIR = originalWindir;
      if (child.process.exitCode === null) try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
    }
  });

  it.runIf(process.platform === "win32")("does not spawn taskkill after delayed verification exhausts the original deadline", async () => {
    let spawnCount = 0;
    const child = await StrictReadyProcess.start({
      componentId: "addin_loopback_fixture",
      command: { ...command(), args: ["--eval", "process.stdout.write(JSON.stringify({ready:true,component:'fixture-test'})+'\\n');setInterval(()=>{},1000);"] },
      absoluteWorkingDirectory: here,
      taskkillVerificationDelayMsForTest: 200,
      taskkillSpawnObserverForTest: () => { spawnCount += 1; },
      validateReadiness(value) { expect(value).toMatchObject({ ready: true, component: "fixture-test" }); },
    });
    const started = Date.now();
    try {
      await expect(child.stop("SIGTERM", 50)).rejects.toMatchObject({
        name: "ProcessExitTimeoutError",
        componentId: "addin_loopback_fixture",
        directChildSurvivor: true,
        killEscalationAttempted: false,
        killEscalationEffective: false,
      });
      expect(Date.now() - started).toBeLessThan(150);
      expect(spawnCount).toBe(0);
    } finally {
      if (child.process.exitCode === null) try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
    }
  });

  it.runIf(process.platform === "win32")("does not spawn taskkill when delayed spawn crosses the original deadline", async () => {
    let spawnCount = 0;
    const child = await StrictReadyProcess.start({
      componentId: "addin_loopback_fixture",
      command: { ...command(), args: ["--eval", "process.stdout.write(JSON.stringify({ready:true,component:'fixture-test'})+'\\n');setInterval(()=>{},1000);"] },
      absoluteWorkingDirectory: here,
      taskkillSpawnDelayMsForTest: 200,
      taskkillSpawnObserverForTest: () => { spawnCount += 1; },
      validateReadiness(value) { expect(value).toMatchObject({ ready: true, component: "fixture-test" }); },
    });
    try {
      await expect(child.stop("SIGTERM", 50)).rejects.toMatchObject({
        name: "ProcessExitTimeoutError",
        killEscalationAttempted: false,
        directChildSurvivor: true,
      });
      expect(spawnCount).toBe(0);
    } finally {
      if (child.process.exitCode === null) try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
    }
  });

  it.runIf(process.platform === "win32")("reaps a taskkill whose native spawn returns after its authorization deadline", async () => {
    let spawnCount = 0;
    let closeCount = 0;
    const child = await StrictReadyProcess.start({
      componentId: "addin_loopback_fixture",
      command: { ...command(), args: ["--eval", "process.stdout.write(JSON.stringify({ready:true,component:'fixture-test'})+'\\n');setInterval(()=>{},1000);"] },
      absoluteWorkingDirectory: here,
      taskkillForcePostSpawnDeadlineForTest: true,
      taskkillSpawnObserverForTest: () => { spawnCount += 1; },
      taskkillCloseObserverForTest: () => { closeCount += 1; },
      validateReadiness(value) { expect(value).toMatchObject({ ready: true, component: "fixture-test" }); },
    });
    const started = Date.now();
    try {
      let observed: ProcessExitTimeoutError | undefined;
      try { await child.stop("SIGTERM", 500); } catch (error) { observed = error as ProcessExitTimeoutError; }
      expect(observed).toMatchObject({ name: "ProcessExitTimeoutError", killEscalationAttempted: true, helperReapUncertain: false });
      expect(observed!.directChildSurvivor).toBe(observed!.evidence.exitCode === null);
      expect(observed!.killEscalationEffective).toBe(false);
      expect(spawnCount).toBe(1);
      expect(closeCount).toBe(1);
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      if (child.process.exitCode === null) try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
    }
  });

  it.runIf(process.platform === "win32")("reports zero-remaining taskkill reap uncertainty without blocking the caller", async () => {
    let closeCount = 0;
    const child = await StrictReadyProcess.start({
      componentId: "addin_loopback_fixture",
      command: { ...command(), args: ["--eval", "process.stdout.write(JSON.stringify({ready:true,component:'fixture-test'})+'\\n');setInterval(()=>{},1000);"] },
      absoluteWorkingDirectory: here,
      taskkillForcePostSpawnDeadlineForTest: true,
      taskkillForceZeroRemainingAfterSpawnForTest: true,
      taskkillCloseObserverForTest: () => { closeCount += 1; },
      validateReadiness(value) { expect(value).toMatchObject({ ready: true, component: "fixture-test" }); },
    });
    const started = Date.now();
    try {
      let observed: ProcessExitTimeoutError | undefined;
      try { await child.stop("SIGTERM", 500); } catch (error) { observed = error as ProcessExitTimeoutError; }
      expect(observed).toMatchObject({ name: "ProcessExitTimeoutError", killEscalationAttempted: true, helperReapUncertain: true });
      expect(observed!.directChildSurvivor).toBe(observed!.evidence.exitCode === null);
      expect(Date.now() - started).toBeLessThan(500);
      const deadline = Date.now() + 2_000;
      while (closeCount === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(closeCount).toBe(1);
    } finally {
      if (child.process.exitCode === null) try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
    }
  });

  it("returns a bounded truthful direct-child survivor when STOP acknowledgement and tree exit miss one deadline", async () => {
    const child = await StrictReadyProcess.start({
      componentId: "addin_loopback_fixture",
      command: readyIpcCommand("missing-ack"),
      absoluteWorkingDirectory: here,
      useTestSignalProxy: true,
      ...(process.platform === "win32" ? { taskkillVerificationDelayMsForTest: 200 } : {}),
      validateReadiness(value) { expect(value).toMatchObject({ ready: true, component: "fixture-test" }); },
    });
    const handle = testIpcSend(child);
    const original = handle.send.bind(handle) as TestIpcSend;
    handle.send = ((message, callback) => {
      original(message, callback);
      return false;
    }) as TestIpcSend;
    const started = Date.now();
    try {
      await expect(child.stop("SIGTERM", 50)).rejects.toMatchObject({
        name: "ProcessExitTimeoutError",
        componentId: "addin_loopback_fixture",
        killEscalationAttempted: process.platform !== "win32",
        killEscalationEffective: false,
        directChildSurvivor: true,
      });
      expect(Date.now() - started).toBeLessThan(150);
    } finally {
      if (child.process.exitCode === null && process.platform === "win32") {
        try { execFileSync(path.join(process.env.SystemRoot!, "System32", "taskkill.exe"), ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* already exited */ }
      } else if (child.process.exitCode === null) {
        try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
      }
    }
  });

  it("leaves no IPC-held child after parent disconnect", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wp12-ready-disconnect-"));
    const marker = path.join(root, "child-disconnect.json");
    const child = await startReadyIpc("normal", marker);
    await expect(child.stop()).resolves.toMatchObject({ exitCode: 0, killEscalated: false });
    expect(existsSync(marker)).toBe(true);
  });

  it("uses the canonical sanitized environment and rejects resolution overrides", async () => {
    const hostileEnvironment = {
      NODE_OPTIONS: "--no-warnings",
      NODE_PATH: "hostile-node-path",
      NODE_PRESERVE_SYMLINKS: "1",
      NODE_COMPILE_CACHE: "hostile-compile-cache",
      NODE_DISABLE_COMPILE_CACHE: "1",
      WS_NO_BUFFER_UTIL: "1",
      WS_NO_UTF_8_VALIDATE: "1",
    } as const;
    const original = new Map(
      Object.keys(hostileEnvironment).map((key) => [key, process.env[key]]),
    );
    try {
      Object.assign(process.env, hostileEnvironment);
      const child = await StrictJsonlProcess.start({
        componentId: "addin_loopback_fixture",
        command: command("environment"),
        absoluteWorkingDirectory: here,
        environment: { RBP_EXPLICIT_CHILD_VALUE: "retained" },
        expectedReadinessFields: {
          component: "fixture-test",
          environment: {
            NODE_OPTIONS: null,
            NODE_PATH: null,
            NODE_PRESERVE_SYMLINKS: null,
            NODE_COMPILE_CACHE: null,
            NODE_DISABLE_COMPILE_CACHE: null,
            WS_NO_BUFFER_UTIL: null,
            WS_NO_UTF_8_VALIDATE: null,
            RBP_EXPLICIT_CHILD_VALUE: "retained",
          },
        },
        requiredActions: ["shutdown"],
      });
      await expect(child.stop()).resolves.toMatchObject({ exitCode: 0 });

      await expect(StrictJsonlProcess.start({
        componentId: "addin_loopback_fixture",
        command: command(),
        absoluteWorkingDirectory: here,
        environment: { NODE_OPTIONS: "--no-warnings" },
        expectedReadinessFields: { component: "fixture-test" },
        requiredActions: ["shutdown"],
      })).rejects.toThrow(/cannot set NODE_OPTIONS/u);
    } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("requires exact readiness and correlates FIFO responses under the 64 KiB cap", async () => {
    const child = await StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command(),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["ping", "fail", "stall", "release", "shutdown"],
    });
    const result = await child.request("ping", { value: "observed" });
    expect(result).toEqual({ echoed: "observed", observation: "raw" });
    const stopped = await child.stop();
    expect(stopped.exitCode).toBe(0);
    expect(child.process.pid).toBeGreaterThan(0);
    expect(child.transcript.some((entry) => entry.stream === "stdout" && entry.line.includes('"echoed":"observed"'))).toBe(true);
    expect(child.transcript.some((entry) => entry.stream === "stderr" && entry.line === "ping:observed")).toBe(true);
  });

  it("exposes a process-only crash boundary without issuing a private shutdown control", async () => {
    const child = await StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command(),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["ping", "shutdown"],
    });
    await expect(child.terminateForConformance()).resolves.toMatchObject({
      exitCode: expect.any(Number),
      killEscalated: false,
    });
    expect(child.process.exitCode).not.toBe(0);
    expect(child.transcript.some((entry) => entry.line.includes('"stopped":true'))).toBe(false);
  });

  it("does not infer JSONL kill effectiveness from a later unrelated nonzero exit", async () => {
    const source = "process.stdout.write(JSON.stringify({ready:true,component:'fixture-test',controlVersion:1,maxControlLineBytes:65536,actions:['shutdown']})+'\\n');setTimeout(()=>process.exit(7),900);";
    const child = await StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: { ...command(), args: ["--eval", source] },
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["shutdown"],
    });
    const handle = (child as unknown as { readonly child: { kill(signal?: NodeJS.Signals | number): boolean } }).child;
    const originalKill = handle.kill.bind(handle);
    handle.kill = () => false;
    try {
      await expect(child.terminateForConformance(1_000)).resolves.toMatchObject({
        exitCode: 7,
        killEscalationAttempted: true,
        killEscalationEffective: false,
        killEscalated: false,
      });
    } finally {
      handle.kill = originalKill;
      if (child.process.exitCode === null) try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
    }
  });

  it("keeps the control chain usable after an expected control error", async () => {
    const child = await StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command(),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["ping", "fail", "shutdown"],
    });
    const expectedFailure = child.startConcurrentRequest("fail");
    const concurrentSuccess = child.startConcurrentRequest("ping", { value: "concurrent-after-error" });
    await expect(expectedFailure.response).rejects.toMatchObject({
      name: "ControlResponseError",
      code: "planned_error",
      controlMessage: "planned failure",
    } satisfies Partial<ControlResponseError>);
    await expect(concurrentSuccess.response).resolves.toEqual({
      echoed: "concurrent-after-error",
      observation: "raw",
    });
    await expect(child.request("ping", { value: "after-error" })).resolves.toEqual({
      echoed: "after-error",
      observation: "raw",
    });
    await expect(child.stop()).resolves.toMatchObject({ exitCode: 0 });
  });

  it("supports explicit non-awaited concurrent requests while preserving FIFO response order", async () => {
    const child = await StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command(),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["stall", "release", "shutdown"],
    });
    const stalled = child.startConcurrentRequest("stall", { value: "first" });
    const release = child.startConcurrentRequest("release");
    expect(stalled.id).not.toBe(release.id);
    await expect(stalled.response).resolves.toEqual({ released: "first" });
    await expect(release.response).resolves.toEqual({ releasedId: stalled.id });
    await expect(child.stop()).resolves.toMatchObject({ exitCode: 0 });
  });

  it("fails closed when a concurrent component violates strict FIFO response order", async () => {
    const child = await StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command("out-of-order"),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["stall", "release", "shutdown"],
    });
    const stalled = child.startConcurrentRequest("stall", { value: "first" });
    const release = child.startConcurrentRequest("release");
    const settled = await Promise.allSettled([stalled.response, release.response]);
    expect(settled).toEqual([
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/out-of-order/u) }) }),
      expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/out-of-order/u) }) }),
    ]);
    await expect(child.stop()).resolves.toMatchObject({ exitCode: expect.any(Number) });
  });

  it("does not write shutdown after fatal FIFO rejection before the child exit event", async () => {
    const child = await StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command("out-of-order"),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["stall", "release", "shutdown"],
    });
    const handle = (child as unknown as { child: ChildProcessWithoutNullStreams }).child;
    // Hold the real child alive across fatal rejection, making the pre-exit
    // interval deterministic instead of relying on the OS teardown schedule.
    const kill = vi.spyOn(handle, "kill").mockReturnValue(true);
    const write = vi.spyOn(handle.stdin, "write");
    try {
      const stalled = child.startConcurrentRequest("stall");
      const released = child.startConcurrentRequest("release");
      const results = await Promise.allSettled([stalled.response, released.response]);
      expect(results).toEqual([
        expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/out-of-order/u) }) }),
        expect.objectContaining({ status: "rejected", reason: expect.objectContaining({ message: expect.stringMatching(/out-of-order/u) }) }),
      ]);
      expect(child.process.exitCode).toBeNull();
      expect(kill).toHaveBeenCalledWith("SIGTERM");
      const writesAtFailure = write.mock.calls.length;
      await expect(child.request("ping")).rejects.toThrow(/closed/u);
      kill.mockRestore();
      const stopped = await child.stop(1_000);
      expect(stopped).toMatchObject({ exitCode: expect.any(Number), telemetry: { acknowledgement: "not_requested" } });
      expect(child.process.stoppedAt).not.toBeNull();
      expect(write.mock.calls).toHaveLength(writesAtFailure);
      expect(() => process.kill(child.pid, 0)).toThrow();
    } finally {
      kill.mockRestore();
      write.mockRestore();
      await child.terminateForConformance(2_000);
    }
  });

  it.each(["EPIPE", "ECONNRESET"])("owns stdin %s and rejects all pending controls", async (code) => {
    const child = await StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command(),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["stall", "shutdown"],
    });
    const handle = (child as unknown as { child: ChildProcessWithoutNullStreams }).child;
    const write = vi.spyOn(handle.stdin, "write");
    try {
      const first = child.startConcurrentRequest("stall", {}, 2_000);
      const second = child.startConcurrentRequest("stall", {}, 2_000);
      const failure = Object.assign(new Error(`owned stdin ${code}`), { code });
      // Exercise the real Writable error-event path, including its asynchronous
      // delivery; a write callback alone does not own this event.
      handle.stdin.destroy(failure);
      const results = await Promise.allSettled([first.response, second.response]);
      expect(results).toEqual([
        { status: "rejected", reason: failure },
        { status: "rejected", reason: failure },
      ]);
      const writesAtFailure = write.mock.calls.length;
      await expect(child.request("stall")).rejects.toThrow(/closed/u);
      await expect(child.stop(2_000)).resolves.toMatchObject({ exitCode: expect.any(Number), telemetry: { acknowledgement: "not_requested" } });
      expect(child.process.stoppedAt).not.toBeNull();
      expect(write.mock.calls).toHaveLength(writesAtFailure);
      expect(() => process.kill(child.pid, 0)).toThrow();
      expect(() => handle.stdin.emit("error", failure)).not.toThrow();
    } finally {
      write.mockRestore();
      await child.terminateForConformance(2_000);
    }
  });

  it("fails closed when readiness controls are absent or startup exits with stderr", async () => {
    await expect(StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command("missing-action"),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["ping", "shutdown"],
    })).rejects.toThrow(/missing controls/u);

    await expect(StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command("stderr-exit"),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["shutdown"],
    })).rejects.toThrow(
      /exited before readiness \(1\).*EADDRINUSE/u,
    );

    await expect(StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command("stderr-eacces-exit"),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["shutdown"],
    })).rejects.toThrow(
      /exited before readiness \(1\).*EACCES/u,
    );

    await expect(StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command("stderr-json-eacces-exit"),
      absoluteWorkingDirectory: here,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["shutdown"],
    })).rejects.toThrow(
      /exited before readiness \(1\).*\{"code":"EACCES"\}/u,
    );
  });

  it("persists redacted start evidence before a caller catches and re-wraps the failure", async () => {
    const evidenceDirectory = mkdtempSync(path.join(tmpdir(), "wp12-process-start-evidence-"));
    let observed: Error | undefined;
    try {
      await StrictJsonlProcess.start({
        componentId: "addin_loopback_fixture",
        command: command("stderr-exit"),
        absoluteWorkingDirectory: here,
        evidenceDirectory,
        expectedReadinessFields: { component: "fixture-test" },
        requiredActions: ["shutdown"],
      });
    } catch (error) {
      observed = new Error("caller re-wrap", { cause: error });
    }
    expect(observed).toBeDefined();
    const artifact = JSON.parse(readFileSync(path.join(evidenceDirectory, "addin_loopback_fixture.start-failure.json"), "utf8"));
    expect(artifact).toMatchObject({
      schemaVersion: "rbp-real-trio-process-start-failure/v1",
      component: "addin_loopback_fixture",
      phase: "pre_ready",
      pid: expect.any(Number),
      stderr: { hash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) },
    });
    expect(readFileSync(path.join(evidenceDirectory, "addin_loopback_fixture.stderr.log"), "utf8")).toContain("EADDRINUSE");

    const readyEvidenceDirectory = mkdtempSync(path.join(tmpdir(), "wp12-ready-start-evidence-"));
    await expect(StrictReadyProcess.start({
      componentId: "addin_loopback_fixture",
      command: command("stderr-exit"),
      absoluteWorkingDirectory: here,
      evidenceDirectory: readyEvidenceDirectory,
      validateReadiness: () => undefined,
    })).rejects.toMatchObject({ name: "ReadyProcessStartError" });
    expect(JSON.parse(readFileSync(path.join(readyEvidenceDirectory, "addin_loopback_fixture.start-failure.json"), "utf8"))).toMatchObject({
      component: "addin_loopback_fixture",
      stderr: { safeLines: expect.arrayContaining([expect.stringContaining("EADDRINUSE")]) },
    });
  });

  it("fails closed without replacing a pre-created process evidence artifact", async () => {
    const evidenceDirectory = mkdtempSync(path.join(tmpdir(), "wp12-process-no-clobber-"));
    const target = path.join(evidenceDirectory, "addin_loopback_fixture.start-failure.json");
    writeFileSync(target, "owner bytes");
    await expect(StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command("stderr-exit"),
      absoluteWorkingDirectory: here,
      evidenceDirectory,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["shutdown"],
    })).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(target, "utf8")).toBe("owner bytes");
  });

  it("fails closed when the caller-owned process evidence directory is replaced after validation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wp12-process-dir-swap-"));
    const evidenceDirectory = path.join(root, "evidence");
    const moved = path.join(root, "evidence-moved");
    const replacement = path.join(root, "replacement");
    mkdirSync(evidenceDirectory);
    mkdirSync(replacement);
    const child = await StrictJsonlProcess.start({
      componentId: "addin_loopback_fixture",
      command: command(),
      absoluteWorkingDirectory: here,
      evidenceDirectory,
      expectedReadinessFields: { component: "fixture-test" },
      requiredActions: ["shutdown"],
    });
    renameSync(evidenceDirectory, moved);
    symlinkSync(replacement, evidenceDirectory, process.platform === "win32" ? "junction" : "dir");
    try {
      await expect(child.stop()).rejects.toThrow(/identity changed|IDENTITY_CHANGED/u);
      expect(existsSync(path.join(replacement, "addin_loopback_fixture.stdout.log"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a recorder artifact replaced while its consumer identity lease is live", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "wp12-process-lease-race-"));
    const evidenceDirectory = path.join(root, "evidence");
    const reached = path.join(root, "lease-reached");
    const continued = path.join(root, "continue");
    const target = path.join(evidenceDirectory, "addin_loopback_fixture.stdout.log");
    mkdirSync(evidenceDirectory);
    const attacker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');const fs=require('node:fs');
      const timer=setInterval(()=>{if(!fs.existsSync(workerData.reached))return;clearInterval(timer);let replaced=false;let code=null;try{fs.rmSync(workerData.target);fs.writeFileSync(workerData.target,'attacker-bytes');replaced=true;}catch(error){code=error.code;}fs.writeFileSync(workerData.continued,'continue');parentPort.postMessage({attacked:true,replaced,code});},5);
    `, { eval: true, workerData: { reached, continued, target } });
    const attacked = new Promise<{ attacked: boolean; replaced: boolean; code: string | null }>((resolve, reject) => {
      attacker.once("message", resolve); attacker.once("error", reject);
    });
    try {
      const child = await StrictJsonlProcess.start({
        componentId: "addin_loopback_fixture",
        command: command(),
        absoluteWorkingDirectory: here,
        evidenceDirectory,
        evidenceStoreTest: { boundary: "lease_verified_before_return", reachedMarker: reached, continueMarker: continued, timeoutMs: 5_000 },
        expectedReadinessFields: { component: "fixture-test" },
        requiredActions: ["shutdown"],
      });
      const stopped = child.stop();
      const attack = await attacked;
      expect(attack.attacked).toBe(true);
      if (attack.replaced) {
        await expect(stopped).rejects.toMatchObject({ code: "EVIDENCE_CONSUMER_AND_LEASE_FAILED" });
        expect(readFileSync(target, "utf8")).toBe("attacker-bytes");
      } else {
        expect(["EPERM", "EBUSY"]).toContain(attack.code);
        await expect(stopped).resolves.toMatchObject({ exitCode: 0 });
        expect(readFileSync(target, "utf8")).not.toBe("attacker-bytes");
      }
    } finally {
      await attacker.terminate();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
