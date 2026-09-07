import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const gatewaySource = path.join(repoRoot, "packages", "gateway", "src");

function source(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

describe("WP-12 bounded retention current topology", () => {
  it("keeps the resource-less preproduction graph private and profile-driven", () => {
    const composition = source("packages/gateway/src/preProductionComposition.ts");
    const serving = source("packages/gateway/src/preProductionServing.ts");
    const bridge = source("packages/gateway/src/bridgeSession.ts");
    expect(composition).not.toContain("new GatewayResourceAuthority");
    expect(serving).not.toContain("new GatewayResourceAuthority");
    expect(serving).toContain("objectStore: createUnavailableObjectStore()");
    expect(bridge).toContain("const durabilityProfile = this.#durabilityProfile()");
    expect(bridge).toContain("max_result_bytes: durabilityProfile.maxResultBytes");
    expect(bridge).toContain("max_partial_bytes: durabilityProfile.maxPartialBytes");
  });

  it("has no raw-v2 readiness or public private-object key surface", () => {
    const supervisor = source("packages/rbp-conformance/src/realTrioSupervisor.ts");
    const north = [
      source("packages/gateway/src/northMcpEndpoint.ts"),
      source("packages/gateway/src/server.ts"),
      source("packages/gateway/src/preProductionServing.ts"),
      source("packages/gateway/src/productionGatewayComposition.ts"),
    ].join("\n");
    expect(supervisor).not.toContain("gateway.rbp-session/v2");
    expect(supervisor).toContain("readRbpSessionV3Readiness");
    expect(north).not.toContain("privateObjectStore()");
    expect(north).not.toContain("gateway.session-blob-intent/v1");
  });

  it("freezes every direct Bridge authority consumer outside the retention allowlist", () => {
    const retentionConsumers = new Set([
      "bridgeSessionRevocation.test.ts", "bridgeSessionRoute.test.ts",
      "bridgeSessionUnregister.test.ts", "preProductionComposition.ts",
      "productionConformanceHost.test.ts", "productionConformanceHostCli.test.ts",
      "productionConformanceHostCli.ts", "recoveryAuthority.test.ts",
      // EU-20 B1 owns real PostgreSQL lifecycle/retention readiness. These
      // consumers belong inside the ownership-sensitive boundary, not among
      // the ordinary restartable-memory fixtures frozen below.
      "productionGatewayComposition.ts", "postgresProtocolStore.integration.test.ts",
    ]);
    for (const [file, profile, owner] of [
      ["productionGatewayComposition.ts", "production_private", "ownership"],
      ["postgresProtocolStore.integration.test.ts", "refuse_dispatch", "owner"],
    ] as const) {
      const text = source(`packages/gateway/src/${file}`);
      expect(text).toContain("new PostgresProtocolStore(");
      expect(text).toContain("new GatewayServingOwnership(");
      expect(text).toContain(`profile: "${profile}"`);
      expect(text).toContain(`servingOwnership: ${owner}`);
      expect(text.match(/new GatewayBridgeSessionAuthority\(/gu)).toHaveLength(1);
    }
    const outside: string[] = [];
    for (const entry of readdirSync(gatewaySource, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const text = readFileSync(path.join(gatewaySource, entry.name), "utf8");
      if (!text.includes("new GatewayBridgeSessionAuthority(")) continue;
      if (!retentionConsumers.has(entry.name)) outside.push(entry.name);
    }
    expect(outside.sort()).toEqual([
      "batchDispatch.test.ts",
      // EU-21 reporting uses the same restartable-memory fixture; it owns no
      // production retention/resource authority.
      "bridgeUpdateReporting.test.ts",
      // EU-20-AUTH-INGRESS (PR #409): constructs `GatewayBridgeSessionAuthority`
      // directly, with the ordinary `createRestartableTestStore` fixture (like
      // the other entries here), to drive production-ingress evidence for the
      // M5-backed identity adapter — it is not part of the retention/resource-
      // authority-sensitive composition boundary this freeze protects.
      "m5BridgeIdentityAuthority.test.ts",
      "preProductionIdentity.test.ts",
      "rbpIngress.test.ts",
      "server.test.ts",
    ]);
    for (const file of outside) {
      expect(file.endsWith(".test.ts")).toBe(true);
      expect(source(`packages/gateway/src/${file}`)).toContain("createRestartableTestStore");
    }
  });
});
