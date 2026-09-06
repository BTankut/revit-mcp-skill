# EU-20: align credential directory and file policy

Scope record before implementation, 2026-09-06.
Base `992ead78417f9a5a0e37ae865aa24e6e4cd80222`, tree
`0dac90f3c250f100bf63fa3b65c3c0cd9ac24f90`.

The actual installer created a genuine C# machine identity and reached the
enrollment handoff. Real M5 minting succeeded. Artifact publication failed:
the C# directory producer requires SYSTEM/Administrators inheritable ACEs,
while the PowerShell writer validates that directory with the file policy
requiring no inheritance. No enrollment or service installation occurred;
the installer timed out. The failed attempt and recovery evidence are
preserved locally and are not live acceptance.

## Bounded correction

Distinguish exact directory and file policies. Align the PowerShell directory
producer and validator with the existing C# `ContainerInherit | ObjectInherit`
policy. Keep credential files protected and non-propagating. Preserve exact
owner/SIDs/rights, deny/foreign/reparse refusal, security at creation and
create-only publication. Do not accept either policy interchangeably or
change live permissions to get around the mismatch.

Owned scope:

- `installer/bridge/lib/RevAgent.BridgeInstall.psm1`
- `scripts/test-eu20-credential-acl-native.ps1`
- `scripts/test-eu20-bridge-install.ps1`
- `packages/bridge/tests/RevAgent.Bridge.Tests/Configuration/CredentialDirectoryPolicyTests.cs` if needed for genuine C# producer coverage
- This scope/evidence record.

The C# production policy is the reference; it does not need changing. Add
native PS5/PS7 coverage that first applies genuine C# directory protection,
then runs the real PowerShell artifact writer. Verify unchanged directory
ACL, exact private file ACL and malformed/foreign/deny/reparse refusals.
Run appropriate local delivery gates and independent/protected reviews.

This repairs the active EU-20/M6 installer prerequisite under standing
correction authority. Forecast: 30-60 active engineering minutes excluding
gate waiting; actual/variance pending measurement. Park List: none.
This installer/script change will trigger automatic production signing on
merge, requiring its concrete operator decision once the candidate is ready.

## Implementation and evidence binding

The PowerShell ACL validator now distinguishes `DirectorySecurity` with
exact `ContainerInherit | ObjectInherit` from `FileSecurity` with exact
`None`. The credential directory setter grants the canonical inheritable
rights before removing inherited access and transferring ownership; file
creation and final file validation retain their existing protected,
non-propagating policy. Parent-directory validation never accepts the file
policy as an alternative. The C# production policy and code are unchanged.

A local original-policy check reproduced `bridge_credential_acl_verification_failed`
for the canonical directory shape. Focused installer tests then passed under
Windows PowerShell 5.1 and PowerShell 7, including distinct type/flag refusals
and updated explicit fixture metadata. The compiled C# policy test passes
without elevation; its real Windows producer case explicitly skips without
an Administrator token rather than using a substitute ACL implementation.

The native runner invokes that compiled real producer with the production
SID resolver and restore-privilege implementation, then uses its directory
for the actual PowerShell artifact writer. It checks unchanged parent SDDL,
private empty-file creation before bytes, exact final file ACL, create-only
publication, native failure propagation, rejection of non-propagating
directories, foreign/deny parents and junctions. Fixture payloads are public
test bytes; no machine identity, token or service is created. The two new
xUnit cases are dynamically counted; no fixed Bridge test-count inventory
requires changing, and the conformance inventory is unaffected.

Raw evidence and exact-candidate native/full-gate receipts are retained under
`.orchestration/autopilot-v2/artifacts/EU-20/astra-b1/credential-directory-policy`.
Those terminal receipts establish execution status; this pre-gate document
does not claim native or live acceptance. Active engineering time was not
separately metered, so no actual-hours or variance claim is made.
