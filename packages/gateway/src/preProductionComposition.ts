import type { IncomingMessage } from "node:http";
import type { AuthInfo } from "@modelcontextprotocol/server";
import type { FastifyInstance } from "fastify";

import type { EntitlementPort } from "./authContext.js";
import { GatewayBridgeSessionAuthority } from "./bridgeSession.js";
import type {
  GatewayConfig,
  GatewayConfigLoadResult,
} from "./config.js";
import type { GatewayEventSink } from "./events.js";
import type { GuardrailPort } from "./guardrails.js";
import type {
  AuthenticatedNorthMcpRequest,
  NorthMcpAuthenticator,
  NorthMcpEndpointOptions,
} from "./northMcpEndpoint.js";
import {
  createPreProductionIdentityAuthority,
  type PreProductionIdentityAuthority,
  type PreProductionIdentityOptions,
} from "./preProductionIdentity.js";
import {
  createProductionRbpIngressHost,
  type RbpIngressHost,
} from "./rbpIngress.js";
import { createPreProductionEnrollmentEndpoint } from "./preProductionEnrollmentEndpoint.js";
import type { GatewayServerPorts } from "./server.js";
import type {
  GatewayProtocolStore,
  ObjectStorePort,
} from "./store.js";
import type { GatewayServingOwnership } from "./gatewayServingOwnership.js";

export const PRE_PRODUCTION_LAN_TEST_PROFILE = "lan_test" as const;

export type PreProductionCompositionErrorCode =
  | "invalid_profile"
  | "invalid_mode"
  | "invalid_gateway_configuration"
  | "production_mode_refused"
  | "unavailable_protocol_store"
  | "startup_coordinator_unavailable"
  | "invalid_north_authority"
  | "c39_protected_object_unavailable";

export class PreProductionCompositionError extends Error {
  public constructor(
    readonly code: PreProductionCompositionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PreProductionCompositionError";
  }
}

export interface PreProductionNorthMcpAuthenticator
  extends NorthMcpAuthenticator {
  readonly kind: "preproduction";
  readonly identity: PreProductionIdentityAuthority;
  readonly trust: {
    readonly mode: "preproduction";
    readonly adapterKind: "preproduction";
    readonly identity: PreProductionIdentityAuthority;
  };
}

export interface PreProductionRbpIngressHost extends RbpIngressHost {
  readonly kind: "preproduction";
  readonly enabled: true;
  readonly authority: GatewayBridgeSessionAuthority;
}

export interface PreProductionLanTestCompositionOptions {
  /** Both discriminants are mandatory; there is no ambient/default selector. */
  readonly profile: typeof PRE_PRODUCTION_LAN_TEST_PROFILE;
  readonly mode: "preproduction";
  readonly config: GatewayConfigLoadResult;
  readonly identityOptions: Omit<
    PreProductionIdentityOptions,
    "mode" | "nodeEnv"
  >;
  readonly protocolStore: GatewayProtocolStore;
  readonly entitlement: EntitlementPort;
  readonly events: GatewayEventSink;
  readonly objectStore: ObjectStorePort;
  /** Internal session durability graph; never installed as the public object port. */
  readonly servingOwnership?: GatewayServingOwnership;
  readonly guardrails: GuardrailPort;
  readonly northAuth: {
    /** Explicit authorization scopes copied into each request-lifetime AuthInfo. */
    readonly scopes: readonly string[];
    /** Exact RFC 8707 resource identifier; must be the configured public /mcp. */
    readonly resource: URL;
  };
  /** The factory owns and overwrites the authenticator seam. */
  readonly northMcp?: Omit<NorthMcpEndpointOptions, "authenticator">;
  /**
   * Serving-only factory for a north graph that needs this exact Bridge
   * authority. Mutually exclusive with `northMcp`.
   */
  readonly northMcpFor?: (input: {
    readonly identity: PreProductionIdentityAuthority;
    readonly bridgeAuthority: GatewayBridgeSessionAuthority;
  }) => Omit<NorthMcpEndpointOptions, "authenticator">;
}

export interface PreProductionLanTestComposition {
  readonly profile: typeof PRE_PRODUCTION_LAN_TEST_PROFILE;
  readonly mode: "preproduction";
  readonly config: GatewayConfig;
  readonly identity: PreProductionIdentityAuthority;
  readonly northAuthenticator: PreProductionNorthMcpAuthenticator;
  readonly bridgeAuthority: GatewayBridgeSessionAuthority;
  readonly rbpIngress: PreProductionRbpIngressHost;
  readonly northMcp: NorthMcpEndpointOptions;
  readonly ports: GatewayServerPorts;
}

function fail(
  code: PreProductionCompositionErrorCode,
  message: string,
): never {
  throw new PreProductionCompositionError(code, message);
}

function bearerToken(authorization: string | undefined): string | null {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return null;
  }
  const token = authorization.slice("Bearer ".length);
  return token.length === 0 ? null : token;
}

function canonicalScopes(scopes: readonly string[]): readonly string[] {
  if (
    scopes.length === 0 ||
    scopes.some(
      (scope) =>
        scope.length === 0 ||
        scope.length > 256 ||
        scope.trim() !== scope ||
        /\s/u.test(scope),
    ) ||
    new Set(scopes).size !== scopes.length
  ) {
    fail(
      "invalid_north_authority",
      "pre-production north scopes must be explicit, unique, bounded tokens",
    );
  }
  return Object.freeze([...scopes]);
}

function createNorthAuthenticator(options: {
  readonly identity: PreProductionIdentityAuthority;
  readonly scopes: readonly string[];
  readonly resourceHref: string;
}): PreProductionNorthMcpAuthenticator {
  const { identity, resourceHref } = options;
  const frozenScopes = canonicalScopes(options.scopes);
  return Object.freeze({
    kind: "preproduction" as const,
    identity,
    trust: Object.freeze({
      mode: "preproduction" as const,
      adapterKind: "preproduction" as const,
      identity,
    }),
    async authenticate(
      request: IncomingMessage,
    ): Promise<AuthenticatedNorthMcpRequest | null> {
      const authorization = request.headers.authorization;
      const token = bearerToken(authorization);
      if (token === null) {
        return null;
      }
      const authenticated = await identity.authenticateNorthRequest({
        authorization,
      });
      if (!authenticated.ok) {
        return null;
      }
      const authContext = authenticated.value;
      const clientId = authContext.session.oauthClientId;
      if (clientId === null) {
        return null;
      }
      const scopes = [...frozenScopes];
      Object.freeze(scopes);
      const authInfo: AuthInfo = {
        // The SDK requires the validated raw access token. It is prefix-free,
        // request-lifetime only, and is never retained by the identity authority.
        token,
        clientId,
        scopes,
        resource: new URL(resourceHref),
        ...(authContext.expiresAtMs === null
          ? {}
          : { expiresAt: Math.floor(authContext.expiresAtMs / 1_000) }),
      };
      return Object.freeze({
        authInfo: Object.freeze(authInfo),
        authContext,
        principalKey: authContext.principalKey,
      });
    },
  });
}

function createPreProductionRbpIngress(
  authority: GatewayBridgeSessionAuthority,
  identity: PreProductionIdentityAuthority,
): PreProductionRbpIngressHost {
  const delegate = createProductionRbpIngressHost({ authority });
  let acceptingEnrollment = true;
  const enrollmentEndpoint = createPreProductionEnrollmentEndpoint(identity, {
    isAccepting: () => acceptingEnrollment,
  });
  return Object.freeze({
    ...delegate,
    kind: "preproduction" as const,
    authority,
    mount(app: FastifyInstance): void {
      delegate.mount?.(app);
      enrollmentEndpoint.mount(app);
    },
    beginDrain(): void {
      acceptingEnrollment = false;
      delegate.beginDrain?.();
    },
    async close(): Promise<void> {
      acceptingEnrollment = false;
      await delegate.close?.();
    },
  });
}

/**
 * Composes the deterministic M4 LAN/test simulator seam.
 *
 * It creates exactly one identity authority and owns every adapter that can
 * authenticate against it. It does not read environment variables, choose a
 * host, create a store, start ingress, or open a listener.
 */
export function createPreProductionLanTestComposition(
  options: PreProductionLanTestCompositionOptions,
): PreProductionLanTestComposition {
  if (options.profile !== PRE_PRODUCTION_LAN_TEST_PROFILE) {
    fail(
      "invalid_profile",
      "the pre-production composition requires the explicit LAN/test profile",
    );
  }
  if (options.mode !== "preproduction") {
    fail(
      "invalid_mode",
      "the LAN/test composition requires explicit pre-production mode",
    );
  }
  if (!options.config.ok) {
    fail(
      "invalid_gateway_configuration",
      "pre-production composition requires a successfully validated Gateway configuration",
    );
  }
  const config = options.config.value;
  if (config.nodeEnv === "production") {
    fail(
      "production_mode_refused",
      "the LAN/test pre-production composition is unavailable in production",
    );
  }
  // This LAN/test graph has no durable receipt inventory.  It must never
  // register C39 merely because a key-file path was supplied; the production
  // composition added by C2b must provide both durable inventory and a passed
  // startup self-test before it can wire the protected-object port.
  if (config.objectStore.protectedObjectKeyFile != null) {
    fail(
      "c39_protected_object_unavailable",
      "C39 protected objects require a durable inventory and startup self-test",
    );
  }
  if (options.protocolStore.kind === "unavailable") {
    fail(
      "unavailable_protocol_store",
      "the LAN/test composition requires an explicit protocol store adapter",
    );
  }
  if (options.protocolStore.startupCoordinator === undefined) {
    fail(
      "startup_coordinator_unavailable",
      "the LAN/test composition requires the durable startup coordinator",
    );
  }
  if (
    (options.northMcp === undefined) ===
    (options.northMcpFor === undefined)
  ) {
    fail(
      "invalid_north_authority",
      "exactly one pre-production north MCP configuration must be supplied",
    );
  }
  const canonicalResource = new URL("/mcp", config.publicUrl).href;
  if (options.northAuth.resource.href !== canonicalResource) {
    fail(
      "invalid_north_authority",
      "the pre-production north resource must be the configured public /mcp URL",
    );
  }

  const identity = createPreProductionIdentityAuthority({
    ...options.identityOptions,
    mode: "preproduction",
    nodeEnv: config.nodeEnv,
  });
  const northAuthenticator = createNorthAuthenticator({
    identity,
    scopes: options.northAuth.scopes,
    resourceHref: canonicalResource,
  });
  const bridgeAuthority = new GatewayBridgeSessionAuthority(
    options.protocolStore,
    identity,
    {
      clock: options.identityOptions.clock,
      eventSink: options.events,
      ...(options.servingOwnership === undefined
        ? {}
        : { servingOwnership: options.servingOwnership }),
    },
  );
  const rbpIngress = createPreProductionRbpIngress(bridgeAuthority, identity);
  const configuredNorthMcp =
    options.northMcp ?? options.northMcpFor!({ identity, bridgeAuthority });
  const northMcp: NorthMcpEndpointOptions = Object.freeze({
    ...configuredNorthMcp,
    authenticator: northAuthenticator,
  });
  const ports: GatewayServerPorts = Object.freeze({
    identity,
    entitlement: options.entitlement,
    events: options.events,
    protocolStore: bridgeAuthority.store,
    objectStore: options.objectStore,
    guardrails: options.guardrails,
    rbpIngress,
  });

  return Object.freeze({
    profile: PRE_PRODUCTION_LAN_TEST_PROFILE,
    mode: "preproduction" as const,
    config,
    identity,
    northAuthenticator,
    bridgeAuthority,
    rbpIngress,
    northMcp,
    ports,
  });
}
