import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  resolveBridgeReleaseImportWorkflowInput,
  type BridgeReleaseImportSourceAuthority,
  type BridgeReleaseImportWorkflowInput,
} from "./bridgeReleaseImportWorkflowInput.js";

const currentHeadSha = "6".repeat(40);
const retainedHeadSha = "5".repeat(40);
const digest = "69eb4e74d6e296937873630a4bfc06f6f2a5283387610907a59bb7b6bc413997";

function authority(ancestors: readonly string[] = [currentHeadSha, retainedHeadSha]): BridgeReleaseImportSourceAuthority {
  return Object.freeze({
    checkoutHeadSha: currentHeadSha,
    isAncestor(sourceHeadSha: string, candidateHeadSha: string): boolean {
      return candidateHeadSha === currentHeadSha && ancestors.includes(sourceHeadSha);
    },
  });
}

function normalInput(overrides: Partial<BridgeReleaseImportWorkflowInput> = {}): BridgeReleaseImportWorkflowInput {
  return {
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    resumeExistingArtifact: false,
    signRelease: true,
    publishRelease: true,
    publishConfirmation: "PUBLISH_BRIDGE_UPDATE",
    validationJobResult: "success",
    signJobResult: "success",
    signedArtifactId: "10045704659",
    signedArtifactDigest: `sha256:${digest}`,
    sourceArtifactId: "",
    sourceArtifactDigest: "",
    sourceRunId: "",
    sourceHeadSha: "",
    currentRunId: "34200665858",
    currentHeadSha,
    importerRunnerLabel: "",
    ...overrides,
  };
}

function resumeInput(overrides: Partial<BridgeReleaseImportWorkflowInput> = {}): BridgeReleaseImportWorkflowInput {
  return normalInput({
    resumeExistingArtifact: true,
    signRelease: false,
    validationJobResult: "skipped",
    signJobResult: "skipped",
    signedArtifactId: "",
    signedArtifactDigest: "",
    sourceArtifactId: "10045704659",
    sourceArtifactDigest: digest.toUpperCase(),
    sourceRunId: "34200665858",
    sourceHeadSha: retainedHeadSha,
    importerRunnerLabel: "revagent-eu21-resume-eb4c6d04502f",
    ...overrides,
  });
}

describe("resolveBridgeReleaseImportWorkflowInput", () => {
  it("keeps the normal signed path bound to successful same-run outputs", () => {
    expect(resolveBridgeReleaseImportWorkflowInput(normalInput(), authority())).toEqual({
      mode: "signed",
      artifactId: "10045704659",
      artifactDigest: `sha256:${digest}`,
      sourceRunId: "34200665858",
      sourceHeadSha: currentHeadSha,
      importerRunnerLabel: "",
    });
  });

  it.each(["failure", "cancelled", "skipped"] as const)(
    "rejects normal import when the signing dependency is %s",
    signJobResult => {
      expect(() => resolveBridgeReleaseImportWorkflowInput(normalInput({ signJobResult }), authority()))
        .toThrow("requires successful validation and signing");
    },
  );

  it("resolves a retained artifact independently from the new workflow run", () => {
    expect(resolveBridgeReleaseImportWorkflowInput(resumeInput({ currentRunId: "40000000000" }), authority())).toEqual({
      mode: "resume",
      artifactId: "10045704659",
      artifactDigest: `sha256:${digest}`,
      sourceRunId: "34200665858",
      sourceHeadSha: retainedHeadSha,
      importerRunnerLabel: "revagent-eu21-resume-eb4c6d04502f",
    });
  });

  it("rejects resume when signing is enabled or either dependency was admitted", () => {
    expect(() => resolveBridgeReleaseImportWorkflowInput(resumeInput({ signRelease: true }), authority()))
      .toThrow("requires signing and validation jobs to be skipped");
    expect(() => resolveBridgeReleaseImportWorkflowInput(resumeInput({ validationJobResult: "success" }), authority()))
      .toThrow("requires signing and validation jobs to be skipped");
    expect(() => resolveBridgeReleaseImportWorkflowInput(resumeInput({ signJobResult: "success" }), authority()))
      .toThrow("requires signing and validation jobs to be skipped");
  });

  it("rejects retained source outside current protected-main ancestry", () => {
    expect(() => resolveBridgeReleaseImportWorkflowInput(resumeInput(), authority([currentHeadSha])))
      .toThrow("not an ancestor of current protected main");
  });

  it("rejects a checkout that differs from the protected-main workflow identity", () => {
    expect(() => resolveBridgeReleaseImportWorkflowInput(normalInput(), {
      ...authority(),
      checkoutHeadSha: "7".repeat(40),
    })).toThrow("checkout authority is invalid");
  });

  it("rejects malformed retained authority and non-scoped additional labels", () => {
    expect(() => resolveBridgeReleaseImportWorkflowInput(resumeInput({ sourceArtifactDigest: "0".repeat(63) }), authority()))
      .toThrow("artifact digest is invalid");
    expect(() => resolveBridgeReleaseImportWorkflowInput(resumeInput({ importerRunnerLabel: "revagent-gateway-publish" }), authority()))
      .toThrow("additional runner label is invalid");
  });

  it("requires the existing main publish controls in either mode", () => {
    expect(() => resolveBridgeReleaseImportWorkflowInput(resumeInput({ ref: "refs/heads/topic" }), authority()))
      .toThrow("protected-main publish authority");
    expect(() => resolveBridgeReleaseImportWorkflowInput(resumeInput({ publishRelease: false }), authority()))
      .toThrow("protected-main publish authority");
    expect(() => resolveBridgeReleaseImportWorkflowInput(resumeInput({ publishConfirmation: "" }), authority()))
      .toThrow("protected-main publish authority");
  });
});

describe("bridge-cd import wiring", () => {
  const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/bridge-cd.yml"), "utf8");
  const importJob = workflow.slice(workflow.indexOf("  production-import:"));

  it("keeps fixed importer labels and admits only explicit successful or skip-only dependency states", () => {
    expect(importJob).toContain('["self-hosted","Linux","revagent-gateway-publish",{0}]');
    expect(importJob).toContain("toJSON(inputs.importer_runner_label)");
    expect(importJob).toMatch(/if: >-\s+github\.event_name == 'workflow_dispatch' &&\s+github\.ref == 'refs\/heads\/main' &&\s+inputs\.publish_release == true &&\s+inputs\.publish_confirmation == 'PUBLISH_BRIDGE_UPDATE'/su);
    expect(importJob).toContain("!cancelled()");
    expect(importJob).toContain("needs.generated-key-validation.result == 'success'");
    expect(importJob).toContain("needs.production-sign.result == 'success'");
    expect(importJob).toContain("needs.generated-key-validation.result == 'skipped'");
    expect(importJob).toContain("needs.production-sign.result == 'skipped'");
    expect(importJob).toContain("inputs.sign_release == false");
  });

  it("authorizes source before migration and scopes migration credentials to that step", () => {
    const resolverIndex = importJob.indexOf("Resolve and authorize exact import source");
    const migrationIndex = importJob.indexOf("Build and apply the pinned migration set");
    const importIndex = importJob.indexOf("Import exact signed release and channel authority");
    expect(resolverIndex).toBeGreaterThan(-1);
    expect(migrationIndex).toBeGreaterThan(resolverIndex);
    expect(importIndex).toBeGreaterThan(migrationIndex);
    const migrationStep = importJob.slice(migrationIndex, importIndex);
    expect(migrationStep).toContain("DATABASE_MIGRATION_URL: ${{ secrets.BRIDGE_RELEASE_MIGRATION_DATABASE_URL }}");
    expect(migrationStep).toContain("REVAGENT_APP_DATABASE_PASSWORD: ${{ secrets.REVAGENT_APP_DATABASE_PASSWORD }}");
    expect(importJob.slice(importIndex)).not.toContain("DATABASE_MIGRATION_URL");
    expect(importJob).toContain("--run-id \"$SOURCE_RUN_ID\"");
    expect(importJob).toContain("--head-sha \"$SOURCE_HEAD_SHA\"");
  });
});
