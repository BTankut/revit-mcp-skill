import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const DECIMAL_ID = /^[1-9][0-9]*$/u;
const HEAD_SHA = /^[0-9a-f]{40}$/u;
const ARTIFACT_DIGEST = /^(?:sha256:)?[0-9a-f]{64}$/iu;
const IMPORTER_RUNNER_LABEL = /^revagent-eu21-resume-[0-9a-f]{12}$/u;

type JobResult = "success" | "failure" | "cancelled" | "skipped";

export interface BridgeReleaseImportWorkflowInput {
  readonly eventName: string;
  readonly ref: string;
  readonly resumeExistingArtifact: boolean;
  readonly signRelease: boolean;
  readonly publishRelease: boolean;
  readonly publishConfirmation: string;
  readonly validationJobResult: JobResult;
  readonly signJobResult: JobResult;
  readonly signedArtifactId: string;
  readonly signedArtifactDigest: string;
  readonly sourceArtifactId: string;
  readonly sourceArtifactDigest: string;
  readonly sourceRunId: string;
  readonly sourceHeadSha: string;
  readonly currentRunId: string;
  readonly currentHeadSha: string;
  readonly importerRunnerLabel: string;
}

export interface BridgeReleaseImportSourceAuthority {
  readonly checkoutHeadSha: string;
  isAncestor(sourceHeadSha: string, currentHeadSha: string): boolean;
}

export interface ResolvedBridgeReleaseImportWorkflowInput {
  readonly mode: "signed" | "resume";
  readonly artifactId: string;
  readonly artifactDigest: `sha256:${string}`;
  readonly sourceRunId: string;
  readonly sourceHeadSha: string;
  readonly importerRunnerLabel: string;
}

function canonicalArtifactDigest(value: string): `sha256:${string}` {
  if (!ARTIFACT_DIGEST.test(value)) throw new Error("Bridge import artifact digest is invalid");
  return `sha256:${value.toLowerCase().replace(/^sha256:/u, "")}`;
}

function assertJobResult(value: string): asserts value is JobResult {
  if (!["success", "failure", "cancelled", "skipped"].includes(value)) {
    throw new Error("Bridge import dependency result is invalid");
  }
}

export function resolveBridgeReleaseImportWorkflowInput(
  input: BridgeReleaseImportWorkflowInput,
  sourceAuthority: BridgeReleaseImportSourceAuthority,
): ResolvedBridgeReleaseImportWorkflowInput {
  if (input.eventName !== "workflow_dispatch" || input.ref !== "refs/heads/main" ||
      !input.publishRelease || input.publishConfirmation !== "PUBLISH_BRIDGE_UPDATE") {
    throw new Error("Bridge import requires protected-main publish authority");
  }
  assertJobResult(input.validationJobResult);
  assertJobResult(input.signJobResult);
  if (!DECIMAL_ID.test(input.currentRunId) || !HEAD_SHA.test(input.currentHeadSha) ||
      sourceAuthority.checkoutHeadSha !== input.currentHeadSha) {
    throw new Error("Bridge import current protected-main checkout authority is invalid");
  }
  if (input.importerRunnerLabel !== "" && !IMPORTER_RUNNER_LABEL.test(input.importerRunnerLabel)) {
    throw new Error("Bridge import additional runner label is invalid");
  }

  let mode: "signed" | "resume";
  let artifactId: string;
  let artifactDigest: string;
  let sourceRunId: string;
  let sourceHeadSha: string;
  if (input.resumeExistingArtifact) {
    if (input.signRelease || input.validationJobResult !== "skipped" || input.signJobResult !== "skipped") {
      throw new Error("Bridge import resume requires signing and validation jobs to be skipped");
    }
    mode = "resume";
    artifactId = input.sourceArtifactId;
    artifactDigest = input.sourceArtifactDigest;
    sourceRunId = input.sourceRunId;
    sourceHeadSha = input.sourceHeadSha;
  } else {
    if (!input.signRelease || input.validationJobResult !== "success" || input.signJobResult !== "success") {
      throw new Error("Bridge import normal mode requires successful validation and signing");
    }
    mode = "signed";
    artifactId = input.signedArtifactId;
    artifactDigest = input.signedArtifactDigest;
    sourceRunId = input.currentRunId;
    sourceHeadSha = input.currentHeadSha;
  }

  if (!DECIMAL_ID.test(artifactId) || !DECIMAL_ID.test(sourceRunId) || !HEAD_SHA.test(sourceHeadSha)) {
    throw new Error("Bridge import Actions source authority is invalid");
  }
  if (!sourceAuthority.isAncestor(sourceHeadSha, input.currentHeadSha)) {
    throw new Error("Bridge import source is not an ancestor of current protected main");
  }
  return Object.freeze({
    mode,
    artifactId,
    artifactDigest: canonicalArtifactDigest(artifactDigest),
    sourceRunId,
    sourceHeadSha,
    importerRunnerLabel: input.importerRunnerLabel,
  });
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`Bridge import environment ${name} is unavailable`);
  return value;
}

function booleanEnvironment(name: string): boolean {
  const value = requiredEnvironment(name);
  if (value !== "true" && value !== "false") throw new Error(`Bridge import environment ${name} is not boolean`);
  return value === "true";
}

function gitSourceAuthority(workspace: string): BridgeReleaseImportSourceAuthority {
  const run = (args: readonly string[]) => spawnSync("git", ["-C", workspace, ...args], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const head = run(["rev-parse", "HEAD"]);
  if (head.status !== 0 || head.error !== undefined) throw new Error("Bridge import cannot resolve the protected-main checkout");
  return Object.freeze({
    checkoutHeadSha: head.stdout.trim(),
    isAncestor(sourceHeadSha: string, currentHeadSha: string): boolean {
      const result = run(["merge-base", "--is-ancestor", sourceHeadSha, currentHeadSha]);
      if (result.error !== undefined || result.status === null || ![0, 1].includes(result.status)) {
        throw new Error("Bridge import cannot verify protected-main source ancestry");
      }
      return result.status === 0;
    },
  });
}

function main(): void {
  const outputPath = requiredEnvironment("GITHUB_OUTPUT");
  const workspace = requiredEnvironment("GITHUB_WORKSPACE");
  const result = resolveBridgeReleaseImportWorkflowInput({
    eventName: requiredEnvironment("GITHUB_EVENT_NAME"),
    ref: requiredEnvironment("GITHUB_REF"),
    resumeExistingArtifact: booleanEnvironment("BRIDGE_IMPORT_RESUME_EXISTING_ARTIFACT"),
    signRelease: booleanEnvironment("BRIDGE_IMPORT_SIGN_RELEASE"),
    publishRelease: booleanEnvironment("BRIDGE_IMPORT_PUBLISH_RELEASE"),
    publishConfirmation: requiredEnvironment("BRIDGE_IMPORT_PUBLISH_CONFIRMATION"),
    validationJobResult: requiredEnvironment("BRIDGE_IMPORT_VALIDATION_JOB_RESULT") as JobResult,
    signJobResult: requiredEnvironment("BRIDGE_IMPORT_SIGN_JOB_RESULT") as JobResult,
    signedArtifactId: requiredEnvironment("BRIDGE_IMPORT_SIGNED_ARTIFACT_ID"),
    signedArtifactDigest: requiredEnvironment("BRIDGE_IMPORT_SIGNED_ARTIFACT_DIGEST"),
    sourceArtifactId: requiredEnvironment("BRIDGE_IMPORT_SOURCE_ARTIFACT_ID"),
    sourceArtifactDigest: requiredEnvironment("BRIDGE_IMPORT_SOURCE_ARTIFACT_DIGEST"),
    sourceRunId: requiredEnvironment("BRIDGE_IMPORT_SOURCE_RUN_ID"),
    sourceHeadSha: requiredEnvironment("BRIDGE_IMPORT_SOURCE_HEAD_SHA"),
    currentRunId: requiredEnvironment("GITHUB_RUN_ID"),
    currentHeadSha: requiredEnvironment("GITHUB_SHA"),
    importerRunnerLabel: requiredEnvironment("BRIDGE_IMPORT_ADDITIONAL_RUNNER_LABEL"),
  }, gitSourceAuthority(workspace));
  appendFileSync(outputPath, [
    `mode=${result.mode}`,
    `artifact_id=${result.artifactId}`,
    `artifact_digest=${result.artifactDigest}`,
    `source_run_id=${result.sourceRunId}`,
    `source_head_sha=${result.sourceHeadSha}`,
    `importer_runner_label=${result.importerRunnerLabel}`,
    "",
  ].join("\n"), { encoding: "utf8" });
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { main(); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Bridge import input resolution failed"}\n`);
    process.exitCode = 1;
  }
}
