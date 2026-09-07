# EU-21 signed self-update and rollback slice

Hedef | Plan satırı | Kabul | Kapsam | Forecast

Signed Bridge/add-in self-update with loaded-add-in deferral and automatic
three-crash rollback | WP3 P3-T11 / M6 | Signed manifest and component hashes,
anti-rollback release sequence, ring/percentage selection, Revit-open deferral,
apply after close, previous-version restore, bad-version quarantine, and the
clean-install to update to rollback matrix pass in isolated fixtures |
`packages/bridge/**` plus this slice/evidence record; production signing,
PETRUCCI, live Revit, service, NAS, DNS, container, and fleet operations are
excluded | 6-8 hours

The implementation will reuse `RevAgent.Contracts` detached RS256 verification,
keep tenant/device identity bound to the authenticated manifest request and
deterministic rollout gate, persist the highest accepted sequence before apply,
stage content under redirected roots, and make version activation and rollback
idempotent. Tests use only generated test keys and fixture-owned processes and
directories.

True gates: production signing material and M6 acceptance.

## Blocking-review scope amendment — 2026-09-07

Final review of head `68edf583` blocked delivery on startup-failure rollback,
full-digest rollout bucketing, manifest-digest sequence binding, authenticated
Gateway reporting, and the lack of one composed matrix. The existing scope is
therefore corrected to include the installer paths already changed above and
this exact bounded Gateway reporting expansion:

- `packages/gateway/src/bridgeSession.ts`
- `packages/gateway/src/bridgeUpdateReporting.test.ts`
- `packages/gateway/src/productionGatewayComposition.ts`
- `packages/gateway/src/preProductionComposition.ts`

The Gateway already owns the strict canonical `bridge.update` event schema and
durable event sink. No report-ingress route exists. The rework uses the frozen
RBP heartbeat and heartbeat-ack additive-property allowance: the authenticated
connection supplies tenant, device, and session authority; Gateway validates a
bounded optional `update_reports` collection, deduplicates through the canonical
event sink, and returns report ids only after persistence. Old peers remain
compatible. The mapping is explicit: `staged` becomes canonical `started`,
`applied` becomes `applied`, `deferred` becomes `deferred`, `refused` and
`quarantined` become `failed`, and `rollback` becomes `applied` with reason
`crash_loop_rollback`.

## Local acceptance evidence

Historical evidence for head `68edf583`; final review marked this candidate
BLOCKING. The results below are retained as chronology and do not establish the
current acceptance claim. The superseding composed evidence follows.

Recorded 2026-09-07 in the isolated EU-21 worktree. The tests use generated
RSA keys, HTTPS fixture responses, redirected install/state/add-in roots, and
fixture-owned worker processes. They do not use a production key, service,
Revit process, PETRUCCI, NAS, DNS, container, or fleet device.

| Acceptance item | Local result |
|---|---|
| Detached RS256 manifest signature and exact signed content | PASS — existing signing suite 38/38 plus update-path signature tamper negative |
| Component size/hash validation | PASS — bridge hash tamper rejected before activation |
| Anti-rollback and idempotency | PASS — lower sequence and sequence rebinding rejected; exact pending transaction resumes; equal active release is a no-download no-op |
| Ring and percentage selection | PASS — non-pilot ring with zero percent skipped; ring 0 admitted |
| Authenticated principal/session binding | PASS — state is bound to the tenant-bound device principal; artifact fetch refuses a substituted session and does not forward the device bearer token to object storage |
| Revit-open add-in deferral and apply after close | PASS — add-in remains byte-identical while the process probe is open, then the durable pending slot applies after close; host retries every 15 seconds |
| Bridge/add-in v1 to v2 update | PASS — version pointer resolves v2 and both payloads verify |
| Three-crash rollback | PASS — the real host supervisor observes three abnormal exits within five minutes, resolves the previous worker, and remains alive |
| Previous version restore and bad-version quarantine | PASS — v1 Bridge/add-in restored, v2 quarantined, and a later signed v2 sequence refused |
| Clean-install to update to rollback matrix | PASS — one redirected-root test covers initial v1, signed v2 apply, Revit deferral, after-close apply, three crashes, v1 restore, and v2 quarantine |
| Installer trust handoff and owned-state regression | PASS — installed trusted-key copy is hash-recorded; redirected installer/uninstaller suite green |

Focused commands and results:

- `dotnet build packages/bridge/RevAgent.Bridge.sln --no-restore`: 0 warnings,
  0 errors.
- `dotnet test packages/bridge/tests/RevAgent.Contracts.Tests/RevAgent.Contracts.Tests.csproj --no-restore --filter FullyQualifiedName~Signing`:
  38 passed, 0 failed, 0 skipped.
- `dotnet test packages/bridge/tests/RevAgent.Bridge.Tests/RevAgent.Bridge.Tests.csproj --no-restore --filter "FullyQualifiedName~BridgeUpdateEngineTests|FullyQualifiedName~WorkerSupervisorTests|FullyQualifiedName~BridgeInstallLayoutTests"`:
  16 passed, 0 failed, 0 skipped.
- `scripts/test-eu20-bridge-install.ps1`: all focused redirected
  installer/uninstaller tests passed.

Raw logs are under `artifacts/eu21-signed-self-update-rollback/` and are kept
out of Git.

## Effort and Park List

Forecast: 6–8 hours. Actual local implementation and verification: 0.67 hours
from the scope-record commit to the final focused gates. Variance: 5.33–7.33
hours under forecast; the existing EU-20 host/installer and shared signature
verifier removed most scaffold work.

Park List:

- Production `bridge-manifest` generation with
  `revagent-prod-rsa-2026q3` and the dedicated signed delivery lane: true gate.
- M6 owner acceptance after the production-signed lab run: true gate.
- Gateway rollout freeze/alert automation after a reported quarantine belongs
  to the Gateway follow-up identified by P-UPD-4; local rollback does not wait
  on it.

## Superseding blocking-review evidence

The rework closes every blocker recorded for `68edf583`:

| Review blocker | Superseding evidence |
|---|---|
| Pre-CONNECT / pre-READY failures bypass rollback | Three consecutive failures before CONNECT and before READY each restore the previous worker and keep the host alive; explicit caller cancellation leaves the crash counter unchanged |
| Rollout used only four SHA-256 bytes | Five nontrivial golden vectors pin full unsigned SHA-256 modulo 100 buckets: `device-1=41`, `NET01=65`, `pilot-alpha=9`, UUID fixture `=82`, and `revagent-canary-17=91` |
| Sequence lacked signed-content binding | Durable state now binds accepted and pending sequence/version to `sha256:<verified canonical manifest>`; same sequence/version with changed component bytes, changed interrupted content, sequence rebinding, and higher sequence reuse of the active version all refuse |
| No authenticated Gateway reporting | Host stores deterministic bounded transition reports; the worker sends at most 16 / 64 KiB through additive heartbeat `update_reports`; Gateway derives tenant/device/connection authority from the authenticated session, maps into strict canonical `bridge.update`, deduplicates replay, and acks only after event persistence; failed persistence and device substitution return no ack |
| Matrix was manually seeded and split | One composed test invokes the real redirected installer with a generated test key, loads its installed trusted-key/output layout, performs an authenticated poll and artifact fetch, restarts the supervised worker, defers the loaded add-in, applies it after close, injects pre-CONNECT + pre-READY + runtime failures, restores v1, quarantines v2, emits all six report states, and removes rows only through the production heartbeat ack helper |

The composed matrix uses an in-process HTTPS message handler and fixture worker
process implementation. It executes the real installer script, poller, update
engine, version resolver, supervisor/control-pipe lifecycle, crash controller,
add-in applier, durable report store, heartbeat serializer, and ack deletion.
The separate Gateway-focused test executes the actual
`GatewayBridgeSessionAuthority` and canonical in-memory event persistence; it
proves the six-state mapping, idempotent replay, persistence-before-ack,
device/tenant/connection authority, old-peer compatibility, and report caps.
These two tests share the production report contract but do not open a real
network socket or touch a machine service/Revit installation.

Final focused results:

- Bridge solution build: 0 warnings, 0 errors.
- Signature compatibility: 38 passed, 0 failed.
- Update/host/layout/heartbeat report tests: 26 passed, 0 failed.
- Composed installer-to-rollback matrix: 1 passed, 0 failed.
- Gateway TypeScript build: passed.
- Authenticated Gateway update reporting: 3 passed, 0 failed.

Raw rework logs remain untracked under
`artifacts/eu21-signed-self-update-rollback/`; the earlier failed logs are
retained alongside the final green logs.

Total actual from the first scope record through rework completion: 1.93 hours.
Against the 6–8 hour forecast, variance is 4.07–6.07 hours under forecast.
Production signing material and M6 owner acceptance remain the only true gates.
