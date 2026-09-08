import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { GatewayConfig } from "./config.js";
import { composeProductionM5Identity } from "./productionM5IdentityComposition.js";
import { PostgresProtocolStore } from "./postgresProtocolStore.js";
import { FilesystemPrivateObjectStore } from "./filesystemPrivateObjectStore.js";
import { GatewayServingOwnership } from "./gatewayServingOwnership.js";
import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import { createProductionRbpIngressHost } from "./rbpIngress.js";
import { createFailClosedPorts, type GatewayServerOptions } from "./server.js";
import { createOidcNorthMcpAuthenticator } from "./oidcIdentity.js";
import { buildCatalog, EntitledCatalogView } from "./entitledRegistry.js";
import { verifyRegistrySeed } from "./registrySeed.js";
import { buildNorthFirstSliceCallableRegistry, M2_NORTH_FIRST_SLICE_CALLABLE } from "./northFirstSlice.js";
import { GatewayDispatcher, type GatewayExecutor } from "./dispatch.js";
import { GatewayRecoveryAuthority } from "./recoveryAuthority.js";
import type { AuthContext, EntitlementPort } from "./authContext.js";
import { parseBridgeManifestTrustedKeys, verifyBridgeManifestSignature } from "./bridgeManifestSignature.js";
import { FilesystemBridgeReleaseObjectStore } from "./bridgeReleaseObjectStore.js";
import { createBridgeUpdateEndpoint } from "./bridgeUpdateEndpoint.js";
import { PostgresEu12DataStore } from "./postgresEu12DataStore.js";
import type { ResultObjectStore } from "./resultReferenceStore.js";

/** Actual image composition. No fixture ports or configurable adapter factories
 * enter this graph. Read-only EU-20 catalog; further tools require their own
 * already-defined entitlement and executable-registry wiring. */
export async function composeProductionGateway(
  config: GatewayConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GatewayServerOptions> {
  const databaseUrl = env.DATABASE_URL?.trim();
  const pepper = env.M5_TOKEN_PEPPER?.trim();
  if (!databaseUrl || !pepper || pepper.length < 32 ||
      !config.oidc?.configured || !config.objectStore.root) {
    throw new Error("production_gateway_configuration_incomplete");
  }
  const certPath = env.GATEWAY_TLS_CERT_FILE?.trim();
  const keyPath = env.GATEWAY_TLS_KEY_FILE?.trim();
  if (Boolean(certPath) !== Boolean(keyPath)) throw new Error("production_gateway_tls_incomplete");
  const tls = certPath && keyPath
    ? { cert: await readFile(certPath), key: await readFile(keyPath) }
    : undefined;
  const catalog = buildCatalog(verifyRegistrySeed(JSON.parse(
    await readFile(new URL("../registry-seed.json", import.meta.url), "utf8"))));
  const registry = buildNorthFirstSliceCallableRegistry(catalog);
  const m5 = composeProductionM5Identity(config, env)!;
  const rawStore = new PostgresProtocolStore(databaseUrl);
  const ownership = new GatewayServingOwnership({
    protocolStore: rawStore,
    privateObjectStore: new FilesystemPrivateObjectStore(config.objectStore.root),
    profile: "production_private",
  });
  const bridge = new GatewayBridgeSessionAuthority(ownership.protocolStore, m5.identity, {
    servingOwnership: ownership,
    eventSink: m5.repository,
  });
  const ingress = createProductionRbpIngressHost({ authority: bridge });
  const entitledDevice = async (tenantId: string, userId: string): Promise<string | null> => {
    const result = await m5.plane.entitledDeviceIds({ tenantId, principalUserId: userId, toolName: M2_NORTH_FIRST_SLICE_CALLABLE });
    return result.ok && result.value.length === 1 ? result.value[0]! : null;
  };
  const entitled = async (auth: AuthContext): Promise<boolean> =>
    await entitledDevice(auth.actor.tenantId, auth.actor.userId) !== null;
  const entitlement = Object.freeze<EntitlementPort>({
    kind: "postgres" as const,
    async checkModuleEntitlement(input) { return { ok: true as const, value: input.moduleName === "core" && await entitled(input.auth) }; },
    async checkToolEntitlement(input) { return { ok: true as const, value: input.toolName === M2_NORTH_FIRST_SLICE_CALLABLE && input.toolVersion === "1.0.0" && await entitled(input.auth) }; },
  });
  const bridgeExecutor = bridge.createExecutor();
  const executor = Object.freeze<GatewayExecutor>({
    binding: "bridge" as const,
    async execute(request) {
      const deviceId = await entitledDevice(request.context.actor.tenantId, request.context.actor.userId);
      if (request.toolName !== M2_NORTH_FIRST_SLICE_CALLABLE || request.context.mutating || deviceId === null) {
        return { state: "failed" as const, error: { code: "entitlement_denied", message: "production read entitlement refused" } };
      }
      const scope = request.context.effectiveMcpRequestScope;
      if (scope === undefined) return { state: "failed" as const, error: { code: "scope_required", message: "request scope unavailable" } };
      const route = bridge.resolveLiveInvocationRoute({ tenantId: request.context.actor.tenantId, userId: request.context.actor.userId, deviceId, effectiveMcpRequestScope: scope });
      if (route.rsid !== request.context.rsid) return { state: "failed" as const, error: { code: "route_changed", message: "request route changed" } };
      return bridgeExecutor.execute(request);
    },
  });
  const recovery = new GatewayRecoveryAuthority(bridge.store, {
    bridgeEvidence: bridge,
    evidenceDecision: { async decideEvidence() { return { kind: "unavailable" as const, message: "read-only production composition" }; } },
  });
  const dispatcher = new GatewayDispatcher(registry, [executor], {
    eventSink: m5.repository,
    eventSource: { component: "revagent-gateway", version: "eu20-production/v1", instance: "north-mcp" },
    recoveryAuthority: recovery,
  });
  const bridgeUpdateEnabled = env.BRIDGE_UPDATE_DELIVERY_ENABLED === "true";
  let bridgeUpdate: ReturnType<typeof createBridgeUpdateEndpoint> | null = null;
  let bridgeUpdateReleases: PostgresEu12DataStore | null = null;
  if (bridgeUpdateEnabled) {
    const trustedKeyPath = env.BRIDGE_UPDATE_TRUSTED_KEYS_FILE?.trim();
    if (!trustedKeyPath) throw new Error("production_bridge_update_trust_incomplete");
    const trustedKeys = parseBridgeManifestTrustedKeys(JSON.parse(await readFile(trustedKeyPath, "utf8")));
    const unavailableObjects: ResultObjectStore = Object.freeze({
      async put() { throw new Error("runtime release reader cannot write result objects"); },
      async get() { return null; },
      async delete() { throw new Error("runtime release reader cannot delete result objects"); },
    });
    bridgeUpdateReleases = new PostgresEu12DataStore({
      databaseUrl,
      objects: unavailableObjects,
      signatureVerifier: Object.freeze({ verify() { return false; } }),
      pinnedSigningKeyIds: Object.keys(trustedKeys),
      bridgeManifestVerifier: input => verifyBridgeManifestSignature({
        manifest: input.manifest,
        envelope: input.signatureEnvelope,
        trustedKeys,
      }),
    });
    bridgeUpdate = createBridgeUpdateEndpoint({
      identity: m5.identity,
      releases: bridgeUpdateReleases,
      objects: new FilesystemBridgeReleaseObjectStore(config.objectStore.root),
      verifyManifest: input => verifyBridgeManifestSignature({
        manifest: input.manifest,
        envelope: input.signatureEnvelope,
        trustedKeys,
      }),
    });
  }
  return {
    config,
    ...(tls === undefined ? {} : { tls }),
    ports: { ...createFailClosedPorts(), identity: m5.identity, entitlement,
      events: m5.repository, protocolStore: bridge.store,
      objectStore: ownership.resourceObjectStore!, rbpIngress: ingress },
    m5EnrollmentEntitlement: m5.plane,
    northMcp: {
      authenticator: createOidcNorthMcpAuthenticator({ identity: m5.identity, resource: new URL("/mcp", config.publicUrl) }),
      catalogViewFor: async authenticated => await entitled(authenticated.authContext)
        ? new EntitledCatalogView(catalog, entry => entry.name === M2_NORTH_FIRST_SLICE_CALLABLE)
        : null,
      invocationRouteFor: async (authenticated, _session, effectiveMcpRequestScope) => {
        const { tenantId, userId } = authenticated.authContext.actor;
        const deviceId = await entitledDevice(tenantId, userId);
        if (deviceId === null) throw new Error("production read route unavailable");
        return bridge.resolveLiveInvocationRoute({ tenantId, userId, deviceId, effectiveMcpRequestScope });
      },
      dispatcher, registry,
      requestState: { key: createHmac("sha256", pepper).update("revagent/north-request-state/v1").digest() },
      resourceMetadataUrl: new URL("/.well-known/oauth-protected-resource/mcp", config.publicUrl),
    },
    beforeListen: app => {
      bridgeUpdate?.mount(app);
      app.addHook("onClose", async () => {
        await bridgeUpdateReleases?.close();
        await m5.repository.close();
      });
    },
  };
}
