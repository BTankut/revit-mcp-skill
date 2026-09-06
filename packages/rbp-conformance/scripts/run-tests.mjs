import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareCurrentProductionPlan } from "./prepare-current-production.mjs";

const vitestCli = fileURLToPath(
  new URL("../../../node_modules/vitest/vitest.mjs", import.meta.url),
);
if (!existsSync(vitestCli)) {
  throw new Error(`Vitest CLI is unavailable at the canonical workspace path: ${vitestCli}`);
}

const forwardedArguments = process.argv.slice(2);
const shardCount = 5;
// +0 files / +2 tests over the previous 73/620 for WP-12 verification-authority real-trio oracles.
// The cardinality gate is deliberately coupled: adding a test file has to be a
// visible edit here rather than something a shard silently absorbs.
const expectedFiles = 73;
const expectedTests = 626;
const fullSuite = forwardedArguments.length === 0;
const invocations = forwardedArguments.length > 0
  ? [["run", ...forwardedArguments]]
  : Array.from(
      { length: shardCount },
      (_unused, index) => [
        "run",
        "--reporter=dot",
        "--reporter=./scripts/cardinality-reporter.mjs",
        `--shard=${String(index + 1)}/${String(shardCount)}`,
      ],
    );

function cardinality(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} did not produce a cardinality report`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Number.isInteger(parsed.files) ||
    parsed.files < 0 ||
    !Number.isInteger(parsed.tests) ||
    parsed.tests < 0
  ) {
    throw new Error(`${label} produced an invalid cardinality report`);
  }
  return parsed;
}

const cardinalityRoot = fullSuite
  ? mkdtempSync(join(tmpdir(), "revagent-rbp-cardinality-"))
  : null;
let exitCode = 0;
let observedFiles = 0;
let observedTests = 0;
let observedShards = 0;
let reusedShards = 0;
const failures = [];

// One attested preparation for the whole invocation.
//
// tests/globalSetup.ts runs per shard, so this ~173 s step used to run five
// times -- about 14 of the suite's 42-46 minutes. It runs here instead and the
// identity is handed to each shard, which re-verifies rather than trusts it.
//
// The digest lives only in this process's memory and in each child's
// environment block. Writing it anywhere on disk would defeat it: the plan file
// is gitignored and writable, so a digest an attacker could rewrite alongside
// the plan would prove nothing.
let handoff = null;
if (fullSuite) {
  try {
    const prepared = prepareCurrentProductionPlan({ nodeExecutable: process.execPath });
    handoff = {
      REVAGENT_RBP_PREPARED_PLAN: prepared.planFile,
      REVAGENT_RBP_PREPARED_COMMIT: prepared.commitSha,
      REVAGENT_RBP_PREPARED_TREE: prepared.treeSha,
      REVAGENT_RBP_PREPARED_PLAN_SHA256: prepared.planSha256,
    };
    console.log(
      `[rbp-conformance] prepared attested production plan in ${String(prepared.elapsedMs)}ms ` +
      `(sha256 ${prepared.planSha256})`,
    );
  } catch (error) {
    // Fail before entering the loop rather than letting five shards each
    // rediscover the same failure. The suite must not run at all without a
    // preparation.
    console.error(
      `[rbp-conformance] ERROR preparation: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    console.error("[rbp-conformance] FAIL preparation: failed");
    if (cardinalityRoot !== null) {
      rmSync(cardinalityRoot, { recursive: true, force: true });
    }
    process.exitCode = 1;
    process.exit(1);
  }
}

try {
  for (const [index, argumentsValue] of invocations.entries()) {
    const label = argumentsValue.find((value) => value.startsWith("--shard=")) ??
      "targeted";
    const cardinalityPath = cardinalityRoot === null
      ? null
      : join(cardinalityRoot, `shard-${String(index + 1)}.json`);
    const reuseProofPath = cardinalityRoot === null
      ? null
      : join(cardinalityRoot, `reuse-${String(index + 1)}.json`);
    console.log(`[rbp-conformance] starting ${label}`);
    const result = spawnSync(process.execPath, [vitestCli, ...argumentsValue], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: {
        ...process.env,
        ...(handoff ?? {}),
        ...(cardinalityPath === null
          ? {}
          : { REVAGENT_RBP_CARDINALITY_PATH: cardinalityPath }),
        ...(reuseProofPath === null
          ? {}
          : { REVAGENT_RBP_REUSE_PROOF_PATH: reuseProofPath }),
      },
      stdio: "inherit",
    });
    if (result.error !== undefined || result.status !== 0) {
      console.error(`[rbp-conformance] FAIL ${label}`);
    }
    if (result.error !== undefined) {
      console.error(`[rbp-conformance] ERROR ${label}: ${result.error.message}`);
      failures.push(`${label}: spawn error`);
      exitCode ||= 1;
      continue;
    }
    if (cardinalityPath !== null) {
      try {
        const observed = cardinality(cardinalityPath, label);
        observedFiles += observed.files;
        observedTests += observed.tests;
        observedShards += 1;
      } catch (error) {
        console.error(
          `[rbp-conformance] ERROR ${label}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        failures.push(`${label}: cardinality report error`);
        exitCode ||= 1;
      }
    }
    if (reuseProofPath !== null && handoff !== null) {
      // A shard that silently prepared its own plan, or whose guard never ran,
      // is the failure mode this whole change can hide: the suite would stay
      // green at its old duration and nobody would learn the reuse never
      // happened. Requiring the proof makes that red.
      let mode = null;
      if (existsSync(reuseProofPath)) {
        try {
          mode = JSON.parse(readFileSync(reuseProofPath, "utf8")).mode;
        } catch {
          mode = null;
        }
      }
      if (mode === "reused") {
        reusedShards += 1;
      } else if (result.status === 0) {
        console.error(
          `[rbp-conformance] ERROR ${label}: plan not reused (reported ${String(mode)})`,
        );
        failures.push(`${label}: plan not reused`);
        exitCode ||= 1;
      }
    }
    if (result.status !== 0) {
      failures.push(`${label}: exit ${String(result.status ?? 1)}`);
      exitCode ||= result.status ?? 1;
      continue;
    }
    console.log(`[rbp-conformance] PASS ${label}`);
  }

  if (fullSuite && handoff !== null && exitCode === 0 && reusedShards !== shardCount) {
    console.error(
      `[rbp-conformance] reuse mismatch: expected ${String(shardCount)} shards to reuse ` +
      `the attested plan; observed ${String(reusedShards)}`,
    );
    failures.push("full suite: reuse mismatch");
    exitCode ||= 1;
  }

  if (fullSuite) {
    if (
      observedFiles !== expectedFiles ||
      observedTests !== expectedTests ||
      observedShards !== shardCount
    ) {
      console.error(
        `[rbp-conformance] cardinality mismatch: expected ${String(expectedFiles)} files / ` +
        `${String(expectedTests)} tests / ${String(shardCount)} shards; observed ` +
        `${String(observedFiles)} files / ${String(observedTests)} tests / ` +
        `${String(observedShards)} shards`,
      );
      failures.push("full suite: cardinality mismatch");
      exitCode ||= 1;
    } else {
      console.log(
        `[rbp-conformance] cardinality ${String(observedFiles)} files / ` +
        `${String(observedTests)} tests / ${String(observedShards)} shards`,
      );
    }
  }
  if (failures.length > 0) {
    console.error(`[rbp-conformance] FAIL ${failures.join("; ")}`);
  }
} finally {
  if (cardinalityRoot !== null) {
    rmSync(cardinalityRoot, { recursive: true, force: true });
  }
}

process.exitCode = exitCode;
