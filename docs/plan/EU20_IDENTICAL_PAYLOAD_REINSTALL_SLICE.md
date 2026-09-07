# EU-20: identical running payload reinstall

Scope record before implementation, 2026-09-07.
Base `b8f543aa558fa519b66e0a8bd362d4259bc021b9`, tree
`d9ffe9af7de0dd57144c41688f15809fa95d7e11`.

Real PETRUCCI installation, native identity, enrollment exchange and core
seat assignment passed. Re-running the same signed package while its Bridge
service was running failed at unconditional host executable copy: Windows
refused to overwrite the mapped executable. The installed host still had the
exact signed source hash. The initial installer task had already completed
and been removed; Revit was closed throughout this test.

The initial install report SHA-256 is
`A54C874A0559C45A34A3B96BB1EC8CD66B10B7DA49F10C2B6914B1937E501022`.
The failed idempotence report SHA-256 is
`2C834C24D64BB1337C24C74D211F42FFEEDE6E9187BACDB5EA941A9A9C33E059`.
Both are failed/incomplete EU-20 acceptance evidence where applicable; this
correction does not close EU-20 or accept M6.

## Scope and acceptance

Preserve an already identical, verified installed payload on reinstall instead
of attempting to overwrite files used by the running Bridge. Cover the host
and relevant worker/add-in copy paths. Preserve signature, path, ownership,
ACL, reparse, foreign-state and existing enrollment guards. A different
payload must retain the existing protected behavior; this slice does not
implement the EU-21 upgrade/deployment state machine.

Owned implementation surface:

- `installer/bridge/Install-RevAgentBridge.ps1`
- `installer/bridge/lib/RevAgent.BridgeInstall.psm1` if a shared copy guard is needed
- `scripts/test-eu20-bridge-install.ps1`
- `scripts/test-eu20-owned-surfaces-native.ps1` if needed for actual Windows lock proof
- This slice record.

Acceptance: identical source and destination bytes can be retained while the
destination disallows writes, the result does not falsely claim a payload
replacement, and changed payload/unsafe paths remain protected. A real
same-package reinstall must preserve enrollment and the running installation.
Run focused Windows PowerShell 5.1/PowerShell 7 coverage, necessary native
lock proof and required delivery gates once on the final candidate, followed
by one independent review and the protected checks.

Forecast: 45-75 active engineering minutes excluding gate waiting. Record
actual/variance and remaining work in final evidence.

Park List: live Revit query/publisher handling, EU-21 upgrade behavior and
milestone acceptance. Parent owns current lab cleanup and all machine work.
Protected merge and its automatic production-key signing are covered by the
operator's standing Autopilot authority recorded on 2026-09-07; no repeated
merge/signing approval is required after the exact candidate is green.
