import { createHash } from "node:crypto";

import { parseRbpFrame, type HelloEnvelope, type RbpEnvelope } from "@revagent/protocol";
import { describe, expect, it } from "vitest";

import {
  GATEWAY_AUTH_CONTRACT_VERSION,
  type DeviceAuthContext,
  type IdentityPort,
} from "./authContext.js";
import {
  GatewayBridgeSessionAuthority,
  type BridgeConnectionChannel,
} from "./bridgeSession.js";
import { InMemoryEu12EventPersistence } from "./eventPersistence.js";
import type { GatewayEventSink } from "./events.js";
import { gatewayUuidV7 } from "./identifiers.js";
import { createRestartableTestStore } from "./testAdapters.js";

const TENANT_ID = "10000000-0000-4000-8000-000000000001";
const USER_ID = "10000000-0000-4000-8000-000000000002";
const DEVICE_ID = "10000000-0000-4000-8000-000000000003";
const SEAT_ID = "10000000-0000-4000-8000-000000000004";
const DEVICE_TOKEN = "eu21-device-token";
let idOffset = 0;
const id = (): string => gatewayUuidV7(Date.now() + idOffset++);

function identity(): IdentityPort {
  const tokenDigest = `sha256:${createHash("sha256").update(DEVICE_TOKEN).digest("hex")}` as const;
  return {
    kind: "fake" as const,
    async authenticateNorthRequest() {
      return { ok: false as const, port: "identity" as const, code: "not_configured" as const, message: "not used" };
    },
    async authenticateDevice(input) {
      if (input.deviceToken !== DEVICE_TOKEN) {
        return { ok: false as const, port: "identity" as const, code: "unavailable" as const, message: "bad token" };
      }
      const context: DeviceAuthContext = {
        contractVersion: GATEWAY_AUTH_CONTRACT_VERSION,
        actor: { type: "device", tenantId: TENANT_ID, userId: USER_ID, deviceId: DEVICE_ID, seatId: SEAT_ID },
        connectionId: input.connectionId,
        deviceStatus: "active",
        grantedConnectionCapabilities: [],
        grantedSessionCapabilities: [],
        deviceTokenDigest: tokenDigest,
      };
      return { ok: true as const, value: context };
    },
  };
}

function hello(): HelloEnvelope {
  return {
    type: "hello",
    id: id(),
    ts: new Date().toISOString(),
    payload: {
      min_protocol: 1,
      max_protocol: 1,
      capabilities: [],
      bridge_version: "1.0.0",
      device_id: DEVICE_ID,
      machine: { hostname: "eu21-fixture", os: "windows" },
      addin_versions: ["1.0.0"],
    },
  };
}

function channel(): BridgeConnectionChannel & { readonly frames: RbpEnvelope[] } {
  const frames: RbpEnvelope[] = [];
  return {
    frames,
    async send(serialized) { frames.push(JSON.parse(serialized) as RbpEnvelope); },
    async close() {},
  };
}

function report(state: string, offset: number, deviceId = DEVICE_ID) {
  return {
    report_id: `20000000-0000-5000-8000-${offset.toString().padStart(12, "0")}`,
    device_id: deviceId,
    from_version: "1.0.0",
    to_version: "2.0.0",
    release_sequence: 2,
    manifest_digest: `sha256:${"a".repeat(64)}`,
    state,
    reason: `fixture_${state}`,
    error: state === "refused" ? "signature invalid" : null,
    occurred_at: "2026-09-07T18:00:00.000Z",
  };
}

describe("authenticated Bridge update heartbeat reporting", () => {
  it("persists canonical events before ack and deduplicates report replay", async () => {
    const persistence = new InMemoryEu12EventPersistence();
    const events: GatewayEventSink = {
      kind: "memory",
      async emit(event) { await persistence.write([event]); return { ok: true as const, value: undefined }; },
      async emitBatch(batch) { await persistence.write(batch); return { ok: true as const, value: undefined }; },
      async flush() { return { ok: true as const, value: undefined }; },
    };
    const authority = new GatewayBridgeSessionAuthority(
      createRestartableTestStore().store,
      identity(),
      { eventSink: events },
    );
    await authority.open();
    const wire = channel();
    const opened = await authority.openConnection({ deviceToken: DEVICE_TOKEN, binding: "wss", hello: hello(), channel: wire });
    const reports = ["staged", "applied", "deferred", "refused", "rollback", "quarantined"]
      .map((state, index) => report(state, index + 1));
    const heartbeat = {
      v: 1,
      type: "heartbeat",
      id: id(),
      ts: new Date().toISOString(),
      payload: { bridge_version: "2.0.0", acks: [], sessions: [], update_reports: reports },
    } as unknown as RbpEnvelope;

    const parsedHeartbeat = parseRbpFrame(
      new TextEncoder().encode(JSON.stringify(heartbeat)),
    );
    await authority.receive(opened.connectionId, parsedHeartbeat);
    const ack = wire.frames.at(-1)!;
    expect(ack.type).toBe("heartbeat_ack");
    expect((ack.payload as Record<string, unknown>).update_report_acks).toEqual(
      reports.map((value) => value.report_id),
    );
    let stored = await persistence.list({ tenantId: TENANT_ID });
    expect(stored.map((event) => [event.payload.update_state, event.payload.status])).toEqual([
      ["staged", "started"], ["applied", "applied"], ["deferred", "deferred"],
      ["refused", "failed"], ["rollback", "applied"], ["quarantined", "failed"],
    ]);

    await authority.receive(
      opened.connectionId,
      parseRbpFrame(new TextEncoder().encode(JSON.stringify({ ...heartbeat, id: id() }))),
    );
    stored = await persistence.list({ tenantId: TENANT_ID });
    expect(stored).toHaveLength(6);
    await authority.close();
  });

  it("retains reports by withholding ack when persistence fails and rejects device substitution", async () => {
    const failedSink: GatewayEventSink = {
      kind: "unavailable",
      async emit() { return { ok: false as const, port: "event_sink" as const, code: "unavailable" as const, message: "down" }; },
      async emitBatch() { return { ok: false as const, port: "event_sink" as const, code: "unavailable" as const, message: "down" }; },
      async flush() { return { ok: true as const, value: undefined }; },
    };
    const authority = new GatewayBridgeSessionAuthority(
      createRestartableTestStore().store,
      identity(),
      { eventSink: failedSink },
    );
    await authority.open();
    const wire = channel();
    const opened = await authority.openConnection({ deviceToken: DEVICE_TOKEN, binding: "wss", hello: hello(), channel: wire });
    const heartbeat = (updateReports: unknown[]) => ({
      v: 1, type: "heartbeat", id: id(), ts: new Date().toISOString(),
      payload: { bridge_version: "2.0.0", acks: [], sessions: [], update_reports: updateReports },
    } as unknown as RbpEnvelope);

    await expect(authority.receive(opened.connectionId, heartbeat([report("staged", 7)])))
      .rejects.toMatchObject({ code: "unavailable" });
    expect(wire.frames.some((frame) => frame.type === "heartbeat_ack")).toBe(false);
    await expect(authority.receive(
      opened.connectionId,
      heartbeat([report("staged", 8, "10000000-0000-4000-8000-000000000099")]),
    )).rejects.toMatchObject({ code: "auth" });
    await authority.close();
  });

  it("keeps old heartbeat peers compatible and refuses over-limit report batches", async () => {
    const authority = new GatewayBridgeSessionAuthority(
      createRestartableTestStore().store,
      identity(),
    );
    await authority.open();
    const wire = channel();
    const opened = await authority.openConnection({ deviceToken: DEVICE_TOKEN, binding: "wss", hello: hello(), channel: wire });
    await authority.receive(opened.connectionId, {
      v: 1, type: "heartbeat", id: id(), ts: new Date().toISOString(),
      payload: { bridge_version: "1.0.0", acks: [], sessions: [] },
    });
    expect((wire.frames.at(-1)!.payload as Record<string, unknown>).update_report_acks).toBeUndefined();

    const oversized = Array.from({ length: 17 }, (_, index) => report("staged", index + 20));
    await expect(authority.receive(opened.connectionId, {
      v: 1, type: "heartbeat", id: id(), ts: new Date().toISOString(),
      payload: { bridge_version: "1.0.0", acks: [], sessions: [], update_reports: oversized },
    } as unknown as RbpEnvelope)).rejects.toMatchObject({ code: "protocol" });
    await authority.close();
  });

  it("rejects duplicate ids within one heartbeat before persistence or ack", async () => {
    let persistenceCalls = 0;
    const events: GatewayEventSink = {
      kind: "capture",
      async emit() { persistenceCalls += 1; return { ok: true as const, value: undefined }; },
      async emitBatch() { persistenceCalls += 1; return { ok: true as const, value: undefined }; },
      async flush() { return { ok: true as const, value: undefined }; },
    };
    const authority = new GatewayBridgeSessionAuthority(
      createRestartableTestStore().store,
      identity(),
      { eventSink: events },
    );
    await authority.open();
    const wire = channel();
    const opened = await authority.openConnection({ deviceToken: DEVICE_TOKEN, binding: "wss", hello: hello(), channel: wire });
    const first = report("staged", 90);
    const duplicate = { ...report("applied", 91), report_id: first.report_id };

    await expect(authority.receive(opened.connectionId, {
      v: 1, type: "heartbeat", id: id(), ts: new Date().toISOString(),
      payload: { bridge_version: "2.0.0", acks: [], sessions: [], update_reports: [first, duplicate] },
    } as unknown as RbpEnvelope)).rejects.toMatchObject({ code: "protocol" });
    expect(persistenceCalls).toBe(0);
    expect(wire.frames.some((frame) => frame.type === "heartbeat_ack")).toBe(false);
    await authority.close();
  });
});
