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

## Local acceptance evidence

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
