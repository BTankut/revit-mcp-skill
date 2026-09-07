import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { JsonValue } from "@revagent/protocol";

import type { IdentityPort } from "./authContext.js";
import type { FilesystemBridgeReleaseObjectStore } from "./bridgeReleaseObjectStore.js";
import type { BridgeUpdateReleaseAuthority } from "./releaseChannelStore.js";

export interface BridgeUpdateReleaseReader {
  readBridgeUpdateForDevice(input: { readonly tenantId: string; readonly deviceId: string }): Promise<Readonly<{
    readonly release: BridgeUpdateReleaseAuthority;
    readonly deviceRing: number;
  }> | null>;
}

export interface BridgeUpdateEndpointOptions {
  readonly identity: IdentityPort;
  readonly releases: BridgeUpdateReleaseReader;
  readonly objects: FilesystemBridgeReleaseObjectStore;
  readonly verifyManifest: (input: {
    readonly manifest: JsonValue;
    readonly signatureEnvelope: JsonValue;
  }) => Readonly<{ readonly keyId: string; readonly contentSha256: string }>;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function token(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" && authorization.startsWith("Bearer ") && authorization.length > 7
    ? authorization.slice(7)
    : undefined;
}

async function authenticate(request: FastifyRequest, options: BridgeUpdateEndpointOptions) {
  if (header(request, "x-revagent-tenant-id") !== undefined) return null;
  const deviceId = header(request, "x-revagent-device-id");
  const machineFingerprint = header(request, "x-revagent-machine-fingerprint");
  const authenticated = await options.identity.authenticateDevice({
    deviceToken: token(request),
    connectionId: randomUUID(),
    claimedDeviceId: deviceId,
    machineFingerprint,
  });
  return authenticated.ok && authenticated.value.deviceStatus === "active" &&
      authenticated.value.actor.deviceId === deviceId &&
      authenticated.value.machineFingerprint === machineFingerprint
    ? authenticated.value
    : null;
}

function hidden(reply: FastifyReply) {
  return reply.code(404).send({ error: "update_not_available" });
}

export function createBridgeUpdateEndpoint(options: BridgeUpdateEndpointOptions): Readonly<{
  mount(app: FastifyInstance): void;
}> {
  return Object.freeze({
    mount(app: FastifyInstance): void {
      app.get("/bridge/update/manifest", async (request, reply) => {
        const authenticated = await authenticate(request, options);
        if (authenticated === null) return hidden(reply);
        const visible = await options.releases.readBridgeUpdateForDevice({
          tenantId: authenticated.actor.tenantId,
          deviceId: authenticated.actor.deviceId,
        });
        if (visible === null) return hidden(reply);
        try {
          const verified = options.verifyManifest({
            manifest: visible.release.manifest,
            signatureEnvelope: visible.release.signatureEnvelope,
          });
          if (verified.keyId !== visible.release.signingKeyId ||
              verified.contentSha256 !== visible.release.manifestDigest) return hidden(reply);
        } catch {
          return hidden(reply);
        }
        reply.header("cache-control", "private, no-store");
        return reply.send({
          manifest: visible.release.manifest,
          signatureEnvelope: visible.release.signatureEnvelope,
          deviceRing: visible.deviceRing,
        });
      });

      app.get<{ Params: { releaseId: string; component: string } }>(
        "/bridge/update/artifact/:releaseId/:component",
        async (request, reply) => {
          if (request.headers.range !== undefined) return hidden(reply);
          const authenticated = await authenticate(request, options);
          if (authenticated === null) return hidden(reply);
          const visible = await options.releases.readBridgeUpdateForDevice({
            tenantId: authenticated.actor.tenantId,
            deviceId: authenticated.actor.deviceId,
          });
          if (visible === null || visible.release.id !== request.params.releaseId ||
              request.params.component !== "bridge" && request.params.component !== "addin") return hidden(reply);
          const component = visible.release.components[request.params.component];
          try {
            const verified = options.verifyManifest({
              manifest: visible.release.manifest,
              signatureEnvelope: visible.release.signatureEnvelope,
            });
            if (verified.keyId !== visible.release.signingKeyId || verified.contentSha256 !== visible.release.manifestDigest) return hidden(reply);
            const bytes = await options.objects.getVerified({
              key: component.storageKey,
              sha256: component.sha256,
              sizeBytes: component.sizeBytes,
            });
            reply.header("content-type", "application/zip");
            reply.header("content-length", String(bytes.byteLength));
            reply.header("cache-control", "private, no-store");
            reply.header("accept-ranges", "none");
            return reply.send(bytes);
          } catch {
            return hidden(reply);
          }
        },
      );
    },
  });
}
