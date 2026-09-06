# EU-20 / M6-V1 — Clean-machine install to live read: lab runbook

> Part of the RevAgent implementation plan. Normativity:
> `docs/TARGET_ARCHITECTURE.md` → `docs/implementation-plan/00-INDEX.md`
> resolutions → `docs/implementation-plan/03-bridge-addin-installer.md` →
> this runbook. Where this runbook conflicts with those, they win.

## Status

This is the **repo-preparation** artifact for EU-20. The two true gates
below (machine selection/destructive lab authorization, and bounded live
Revit read) are **not granted** and were **not exercised** while preparing
this runbook or the scripts it drives. Every step in this document is a
plan the operator executes later, in a separately approved gated session,
against a disposable lab machine.

Do **not** run the mutating steps below (Steps 3-11) against `PETRUCCI` (the
known Revit 2022 workstation — not confirmed disposable) or against
`DESKTOP-OKNV128` (explicitly excluded; do not look for Revit there) without
a fresh, explicit operator authorization naming the exact target machine for
that session.

## Scripts this runbook drives

- `installer/bridge/Install-RevAgentBridge.ps1` (P3-T9)
- `installer/bridge/Uninstall-RevAgentBridge.ps1` (P3-T10)
- `installer/bridge/lib/RevAgent.BridgeInstall.psm1` (shared primitives)
- Machine report schema: `config/bridge-machine-report.schema.json`

Every machine-mutating action in both scripts is routed through the single
guarded choke point `Invoke-RevAgentBridgeGuardedMutation`; `-WhatIf` or
`-DryRun` makes every step below a `skipped_dry_run` plan entry instead of a
real action. **Run every step once with `-DryRun` first** and read the
emitted report before the committed run.

## Prerequisites

| # | Prerequisite | How to verify | Acceptance clause |
|---|---|---|---|
| P1 | Operator has named and authorized one specific disposable Windows/Revit 2022 lab machine for this session. | Written authorization naming the exact machine (hostname + confirmation it is disposable). | True gate (below) |
| P2 | The signed Bridge release payload (`bridge-release.json` + `.json.sig`, host/worker/addin binaries) is available and its `trusted-keys.json` is the pinned production/lab key set. | `Test-RevitMcpDetachedJsonSignatureFile` succeeds against the payload (the installer performs this itself and fails closed if not). | P-INST-2, P3-T9 |
| P3 | An admin is ready to mint a single-use P-ENROLL-1 token against the public fingerprint emitted during the installer invocation (short TTL, ≤ 24h). | Protected-file handoff or secure prompt is selected; token and expiry never enter repository evidence. Pre-minted tokens require the existing matching identity. | P-ENROLL-1, R9 |
| P4 | Target machine has Revit 2022 installed at a location `Resolve-RevitMcpInstallRoot -Version 2022` can find (registry or `config/revit-versions.json` candidate paths). | `installer/bridge/Install-RevAgentBridge.ps1` step 3 (Revit detection) succeeds without `-SkipRevitDetection`. | P3-T9 |
| P5 | Operator has local Administrator rights on the target machine (service registration + ACL lockdown require it). | `whoami /groups` shows `BUILTIN\Administrators` enabled. | P-INST-1 |
| P6 | Machine identity verified: confirm the actual `$env:COMPUTERNAME` on the console matches the machine named in P1, and is **not** `DESKTOP-OKNV128`. | `$env:COMPUTERNAME` on the target console. | Card "Environment" clause |

## Lab-machine preflight card

Run this whole card on the named machine's own console, in order, **before**
Step 1. Every check must pass before the session proceeds; a failed check
sends the operator back to the requesting party, not around this runbook.

| # | Check | Command (run on the target console) | Pass condition |
|---|---|---|---|
| F1 | Hostname matches the P1 authorization exactly. | `$env:COMPUTERNAME` | Equals the named machine; is not `DESKTOP-OKNV128`. |
| F2 | Machine is confirmed disposable (not a production/shared workstation such as `PETRUCCI` unless separately confirmed). | Operator's written authorization from P1. | Authorization text names this exact hostname as disposable. |
| F3 | No `revAgentBridge` service already exists from a prior partial run. | `Get-Service -Name revAgentBridge -ErrorAction SilentlyContinue` | Returns nothing (fresh machine) **or**, if present, its state is understood before proceeding (see R1 if a prior session was interrupted). |
| F4 | The three P-SEQ-2 rollback anchors are present and healthy before this session touches anything. | `Test-Path 'C:\ProgramData\DPE\revAgent\bootstrap'`; `Test-Path 'C:\ProgramData\DPE\revAgent\prestage\install-revagent-local-bootstrap.ps1'`; `Test-Path 'C:\ProgramData\DPE\revAgent\updater\config\release-trusted-keys.json'` | All three return `True`. Record their `Get-FileHash`/directory-tree hash now as the pre-session baseline for Step 12's before/after comparison. |
| F5 | Revit 2022 is installed and closed (no running `Revit.exe` process). | `Resolve-RevitMcpInstallRoot -Version 2022`; `Get-Process Revit -ErrorAction SilentlyContinue` | Install root resolves; no running Revit process. |
| F6 | Operator has local Administrator rights. | `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)` | Returns `True`. |
| F7 | No orphaned local process is bound to the legacy add-in TCP port range (8080-8085) that could collide with bridge discovery. | `Get-NetTCPConnection -LocalPort 8080-8085 -ErrorAction SilentlyContinue` | Empty, or every bound process is understood and expected (e.g. Revit's own add-in listener once running). |
| F8 | The signed release payload and trusted-keys file for this session are staged locally and their directory is not shared/writable by other users. | `icacls <PackageRoot>` | Only the operator/Administrators have write access. |
| F9 | The P3 admin is available for the bounded fingerprint-to-token handoff; no old enrollment artifact is present. | Operator's out-of-band coordination and canonical artifact absence. | The newly minted token is unused and leaves ≥ 50s and ≤ 24h+5s lifetime when consumed. The actual token is bound after genuine C# preparation inside Step 3. |
| F10 | A rollback contact/escalation path is known in case R4 (full restore) is needed. | Operator's own runbook/on-call reference. | Named and reachable for the duration of the session. |

## Step 1 — Machine identity verification

On the target console (not this repo's dev machine):

```powershell
$env:COMPUTERNAME
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version
```

Confirm the hostname matches the operator's P1 authorization exactly and is
not `DESKTOP-OKNV128`. Stop here if it does not match — do not proceed on an
unconfirmed machine.

**Evidence:** console transcript of the hostname/OS query.
**Satisfies:** Card "Environment" clause; True gate precondition.

## Step 2 — Dry-run install (zero mutation)

```powershell
$Report = & "installer\bridge\Install-RevAgentBridge.ps1" `
  -PackageRoot "<path to the extracted signed payload>" `
  -TrustedKeysPath "<path to trusted-keys.json>" `
  -WaitForEnrollmentArtifact `
  -EnrollmentHandoffTimeoutSeconds 300 `
  -RevitVersion "2022" `
  -GatewayHostName "<gateway.dpe.internal-style DNS name, never an IP>" `
  -MachineReportPath "C:\Temp\eu20-install-dryrun-report.json" `
  -DryRun
$Report.status               # expect: success
$Report.steps | Format-Table # expect: every mutating step 'skipped_dry_run'
```

Confirm no `C:\Program Files\revAgent`, `C:\ProgramData\revAgent`, or
`C:\ProgramData\Autodesk\Revit\Addins\2022\revAgent.addin` were created.

**Evidence:** `eu20-install-dryrun-report.json`, directory-listing
before/after showing no new paths.
**Satisfies:** Deliverable A ("dry-run performs zero mutations"); Acceptance
"uninstaller dry-run" sibling clause for install.

## Step 3 — Committed install (true gate)

Remove `-DryRun` from Step 2's command. This is the first machine-mutating
action and requires the P1 authorization to be in force.

**Evidence:** `eu20-install-report.json` with `status: "success"`; every
step `applied`, `verified`, or an idempotency `skipped_*` reason.
**Satisfies:** P-INST-1 (disjoint roots), P3-T2 (service install), P3-T9
(installer end state).

## Step 4 — Expected roots and ACLs

```powershell
Test-Path "C:\Program Files\revAgent\Bridge\revagent-bridge-host.exe"
Test-Path "C:\Program Files\revAgent\Bridge\versions\current\revagent-bridge.exe"
Test-Path "C:\ProgramData\revAgent\bridge\bridge-config.json"
Test-Path "C:\ProgramData\revAgent\bridge\credentials"
icacls "C:\ProgramData\revAgent\bridge\credentials"
icacls "C:\Program Files\revAgent\Bridge"
```

Confirm the credential directory's ACL is protected with exactly SYSTEM +
BUILTIN\Administrators FullControl (no other principal), and the install
root/add-in root are protected with SYSTEM + Administrators FullControl plus
BUILTIN\Users ReadAndExecute.

**Evidence:** `icacls` output captured to the session log.
**Satisfies:** P-INST-1; P3-T8 (device-token storage root).

## Step 5 — One-time enrollment

Enrollment is driven by the same Step 3 invocation. The signed host first
prepares the genuine C# identity and emits only its public fingerprint. The
admin mints a token for that fingerprint and atomically supplies the protected
canonical artifact within the bounded wait. Interactive setup may instead use
`-PromptForEnrollment`; no manual bootstrap plus doctor re-enrollment is counted
as a fresh install. See [the production-path verification guide](EU20_B1_PRODUCTION_PATH_TESTS.md).

The installer or protected handoff supplies
`C:\ProgramData\revAgent\bridge\credentials\enrollment.json` (the exact M4
artifact contract `BridgeEnrollmentArtifactConsumer` expects) before
starting the service. On first start the bridge worker consumes and deletes
that file and persists a DPAPI-protected device credential.

```powershell
Get-Service revAgentBridge
Test-Path "C:\ProgramData\revAgent\bridge\credentials\enrollment.json"   # expect: False (consumed)
Test-Path "C:\ProgramData\revAgent\bridge\credentials\device-credential.dpapi"  # expect: True
& "C:\Program Files\revAgent\Bridge\revagent-bridge-host.exe" doctor
```

`doctor` output must show a device id/machine fingerprint (non-secret) and
no enrollment error.

**Evidence:** `doctor` console output; artifact-absence check.
**Satisfies:** P-ENROLL-1, P3-T8 acceptance ("fresh machine enrolls with a
single-use token").

## Step 6 — Token reuse is rejected

Re-run Step 2's dry-run command again with the **same** token and expiry
(now already consumed). Expect the installer to report
`install.alreadyEnrolled = true` and skip enrollment — the token is not
re-sent to the Gateway. If a genuinely fresh single-use-token-reuse probe is
required, that is a Gateway-side (EU-11) test, not this installer's surface.

**Evidence:** report showing `alreadyEnrolled: true`,
`enrollmentAttempted: false`.
**Satisfies:** P3-T8 acceptance ("token reuse rejected").

## Step 7 — Gateway session registration (Bridge connect)

```powershell
& "C:\Program Files\revAgent\Bridge\revagent-bridge-host.exe" doctor
```

Confirm `doctor` reports the Gateway connection as established (WSS primary
or the capability-gated fallback) and the local add-in TCP client's bounded
port scan found the running Revit 2022 add-in session.

**Evidence:** `doctor` output.
**Satisfies:** P3-T4 (session registration); the card's "remote MCP
registration" outcome bullet — see **Decision** below.

> **Decision (scope boundary):** "remote MCP client registration" in this
> step means the Bridge registering its own session with the Gateway
> (P3-T4/O3 device+session flow), verified via `doctor`. It does **not**
> include re-registering the ChatGPT/Codex Desktop application's remote MCP
> URL against the Gateway north surface — that is WP9/P-CODEX-1's own
> procedure (`docs/implementation-plan/03-bridge-addin-installer.md`
> P-CODEX-1, P3-T14), owned separately and explicitly out of EU-20/P3-T9's
> row in the work breakdown.

## Step 8 — One live Revit read (true gate)

With Revit 2022 open on the lab machine and a document loaded, drive one
read-only invocation through the connected session (e.g. the equivalent of
`get_current_view_info`) from the Gateway side / a connected MCP client.

**Evidence:** the tool response payload (redacted of any project-sensitive
content as appropriate) plus the Bridge's structured log line showing the
round trip.
**Satisfies:** Card "Outcome" ("one live read"); P3-T9 acceptance
("bridge connected + one round-trip tool call").

## Step 9 — Idempotent re-run

Re-run Step 3's **committed** install command unchanged (same PackageRoot,
same/no token).

```powershell
$Report2 = & "installer\bridge\Install-RevAgentBridge.ps1" -PackageRoot ... -TrustedKeysPath ... -MachineReportPath "C:\Temp\eu20-install-rerun-report.json"
$Report2.status                          # expect: success
$Report2.install.alreadyEnrolled         # expect: True
$Report2.install.serviceAlreadyInstalled # expect: True
```

Confirm the service was not re-registered and no new enrollment artifact was
written; the manifest/binaries may be safely rewritten (deterministic
content, same hash).

**Evidence:** `eu20-install-rerun-report.json`.
**Satisfies:** P3-T9 acceptance ("re-run is a no-op").

## Step 10 — Uninstall dry-run

```powershell
$UninstallDryRun = & "installer\bridge\Uninstall-RevAgentBridge.ps1" `
  -Scope LegacyCutover `
  -CodexConfigPath "<path to the machine's Codex config.toml>" `
  -MachineReportPath "C:\Temp\eu20-uninstall-dryrun-report.json" `
  -DryRun
$UninstallDryRun.status                    # expect: success
$UninstallDryRun.uninstall.anchors | Format-Table  # expect: all preserved=true
```

**Evidence:** `eu20-uninstall-dryrun-report.json`.
**Satisfies:** Card Acceptance "uninstaller dry-run".

## Step 11 — Committed uninstall (true gate, lab removal)

Remove `-DryRun`.

**Evidence:** `eu20-uninstall-report.json` (`wipe-report.json`-equivalent)
with per-item found/removed/kept/failed dispositions.
**Satisfies:** P-INST-3, P3-T10 acceptance.

## Step 12 — Anchor verification

```powershell
Test-Path "C:\ProgramData\DPE\revAgent\bootstrap"
Test-Path "C:\ProgramData\DPE\revAgent\prestage\install-revagent-local-bootstrap.ps1"
Test-Path "C:\ProgramData\DPE\revAgent\updater\config\release-trusted-keys.json"
Get-FileHash "C:\ProgramData\DPE\revAgent\prestage\install-revagent-local-bootstrap.ps1"
Get-FileHash "C:\ProgramData\DPE\revAgent\updater\config\release-trusted-keys.json"
```

Compare hashes against the pre-uninstall baseline captured before Step 11.
All three must be present and byte-identical; the uninstall report's
`uninstall.anchors[].preserved` must be `true` for all three (the script
throws — status `failed` — if any anchor changed, so `status: success`
already proves this, but re-verify independently).

**Evidence:** hash comparison; report `anchors` array.
**Satisfies:** P-SEQ-2; Card Acceptance "rollback anchors preserved".

## Step 13 — Unrelated user configuration untouched

Diff the target machine's Codex `config.toml` before/after Step 11 (outside
the two managed `[mcp_servers.revAgent]` / `[mcp_servers.revAgent-api-docs]`
sections) and confirm no other section, `AGENTS.md`, skill directory, or
PowerShell profile content changed. The uninstall script's own
`unchangedElsewhere` flag in `uninstall.codexConfig` proves this
structurally (the script throws otherwise), but a manual diff is the
independent check.

**Evidence:** `diff` output (or equivalent) showing zero unrelated changes.
**Satisfies:** Card Acceptance "unrelated user config untouched"; R4.

## Step 14 — Report collection

Collect into the session evidence folder:

- `eu20-install-dryrun-report.json`, `eu20-install-report.json`,
  `eu20-install-rerun-report.json`
- `eu20-uninstall-dryrun-report.json`, `eu20-uninstall-report.json`
- `doctor` console transcripts from Steps 5, 7
- The Step 8 live-read evidence
- The Step 12/13 hash and diff evidence

Validate every report JSON against `config/bridge-machine-report.schema.json`
before filing it as gate evidence.

**Evidence-forgeability rule (mandatory before accepting any report as
true-gate evidence):** every report carries `install.icaclsInvokerInjected`
/ `uninstall.icaclsInvokerInjected` and `install.elevated` /
`uninstall.elevated`. A test run can inject a mock ACL primitive
(`-IcaclsInvoker`) to run hermetically without ever touching a real ACL —
that is correct and expected in `scripts/test-eu20-bridge-install.ps1`,
but it also means a report alone (`status: success`, `dryRun: false`, ACL
steps `applied`) is not on its own distinguishable from a genuine machine
mutation. **Reject any report as true-gate lab evidence if
`icaclsInvokerInjected == true` or `elevated == false`.** Only a report
with `icaclsInvokerInjected: false` and `elevated: true` may be filed as
proof that Steps 3/11 actually ran against real machine state.

**Satisfies:** Card Acceptance "machine report and exact review/checks
green".

---

## True gate request

This runbook cannot be executed to completion by an autonomous agent. Two
explicit operator authorizations are required before Steps 3, 5-9, and
11-13 may run:

1. **Machine selection / destructive lab authorization.** Name the exact
   disposable Windows/Revit 2022 lab machine for this session (not
   `PETRUCCI` unless separately confirmed disposable; never
   `DESKTOP-OKNV128`), and confirm the operator accepts that Steps 3 and
   11 install a Windows service, write to `C:\Program Files` and
   `C:\ProgramData`, and remove the legacy stack named in P-INST-3 on that
   machine.
2. **Bounded live Revit read authorization.** Confirm Revit 2022 may be
   opened with a specific (named, non-sensitive) document on the lab
   machine for Step 8's one read-only round trip, and name the Gateway/MCP
   client that will drive it.

Until both are granted, this document remains a plan; EU-20's repo
preparation (installer script, uninstaller script, tests, this runbook,
and the machine-report schema) is complete and gated behind these two
approvals.

## Rollback plan

This package introduces no new rollback mechanism of its own. Its entire
contribution to rollback safety is Step 12's guarantee: the three P-SEQ-2
anchors are structurally never selected for removal or rewrite (enforced by
`Get-RevAgentBridgeTreeWipePlan`'s construction, not by care), so whatever
happens during Steps 3-11, the machine's path back to the pre-cutover legacy
stack stays intact. What the operator actually does with that path depends
on where the failure occurred.

### R1 — Install (Step 3) fails partway through

1. Read the emitted `eu20-install-report.json`. Its `steps[]` array shows
   exactly which guarded mutations reached `applied` before the failing one
   is recorded `failed`; everything after that never ran (P-INST-1 disjoint
   roots mean nothing here can have touched the legacy
   `C:\ProgramData\DPE\revAgent` tree).
2. Diagnose the exact failing step before retrying. A repeatable permission,
   ownership or foreign-surface refusal requires correction/recovery, not an
   unchanged installer rerun. Directory creation, deterministic owned manifest
   publication, existing service detection and existing enrollment remain
   idempotent only when their real preconditions still hold.
3. If re-running is not desired (e.g., the failure indicates a bad payload
   or a compromised machine), explicitly select **BridgeOwned**, first with
   `-DryRun`, using the matching signed package and trusted keys:

   ```powershell
   & 'installer\bridge\Uninstall-RevAgentBridge.ps1' `
     -Scope BridgeOwned -PackageRoot '<extracted signed package>' `
     -TrustedKeysPath '<pinned trusted-keys.json>' -RevitVersion 2022 `
     -MachineReportPath '<fresh external recovery report.json>' -DryRun
   ```

   After reviewing the plan, use a new external report path for the committed
   invocation. This scope checks the complete inventory before removal,
   rejects modified/unrecognized payloads, unknown state, reparse points and
   foreign/deny ACLs, and deletes listed files followed by empty directories.
   Missing files from a partial install are allowed. Only empty app-named
   ancestors may be pruned; shared Autodesk directories are preserved.
   Runtime/credential contents are not read or included in the cleanup report.
   Normal service removal verifies the exact Bridge service image/account;
   Revit must be closed. A refusal leaves unknown content for diagnosis.
4. **LegacyCutover remains the default** and removes the original legacy
   wipe-list/tasks/Codex sections; it is not BridgeOwned cleanup. BridgeOwned
   never invokes those legacy operations. The Bridge files use disjoint roots,
   but Step 3 can upgrade the managed `revAgent.addin` manifest. Preserve its
   pre-install backup for rollback: cleanup removes only the exact current
   Bridge manifest, preserves a recognized legacy manifest pointing elsewhere,
   and refuses foreign/modified canonical-name files. Restore the original
   manifest through the recorded legacy restoration procedure when required.

### R2 — Enrollment (Step 5) succeeds but the device is rejected/misbehaves

1. `revagent-bridge-host.exe doctor` reports the specific enrollment/auth
   diagnostic. Do not re-run the installer with a new `-EnrollmentToken`
   while a device credential already exists — that path is
   `skipped_already_enrolled` by design (Step 6).
2. Use the supported re-enrollment path instead: mint a fresh single-use
   token for this machine's fingerprint from the Gateway, then run
   `revagent-bridge-host.exe doctor --re-enroll` after placing the fresh
   artifact (P3-T8's documented flow). This is a Gateway/Bridge-owned
   operation, not something this runbook's scripts perform.
3. If re-enrollment does not resolve it, fall through to R4 (full
   uninstall) rather than leaving a half-trusted device credential in
   place.

### R3 — Uninstall (Step 11) fails partway through

1. Read `eu20-uninstall-report.json`. `uninstall.anchors[]` is checked
   **before** the report is marked `success`; a `failed` status here means
   at least one anchor hash changed and the run stopped — treat this as a
   stop-the-line event, capture the report, and escalate rather than
   re-running blindly.
2. If the failure is instead a `legacy_tree_wipe_incomplete` (some non-anchor
   item could not be removed — e.g. a file locked by a running process),
   close whatever holds the lock and re-run
   `Uninstall-RevAgentBridge.ps1` unchanged: it is idempotent per item
   (`Get-RevAgentBridgeTreeWipePlan` re-plans from current disk state each
   time) and will simply skip everything already gone.
3. Because the anchors are excluded from every wipe plan by construction,
   an interrupted or partially failed uninstall can never itself be the
   reason the legacy NAS-restore path (R4) becomes unavailable.

### R4 — Full restore to the pre-cutover legacy stack

Use this when the machine must be returned to exactly its pre-EU-20 state,
regardless of what Steps 3-11 did:

1. Run `Uninstall-RevAgentBridge.ps1 -Scope BridgeOwned` with the matching
   signed package, trusted keys, Revit version and fresh external report
   described in R1 (committed after its dry-run). Confirm
   `uninstall.scope == 'BridgeOwned'`, `uninstall.ownedCleanup.completed == true`
   and
   `uninstall.anchors[].preserved == true` for all three anchors in the
   resulting report.
2. Follow the existing frozen NAS-restore procedure (Section 8 step 4 of
   the target architecture; `docs/ROLLBACK_CRITERION_DRAFT.md`) using the
   preserved anchors as its starting point:
   `C:\ProgramData\DPE\revAgent\bootstrap\` and
   `prestage\install-revagent-local-bootstrap.ps1` re-establish the local
   bootstrap trust chain, and `updater\config\release-trusted-keys.json`
   re-establishes signature trust for the legacy updater, exactly as they
   would have been found before this session ever ran — Step 12's
   byte-identical hash proof is what makes "exactly as they would have
   been found" true rather than assumed.
3. Re-run the legacy stack's own health check (whatever the pre-cutover
   updater/dashboard verification is) to confirm the restore succeeded.
4. File the failure (report JSONs, the point of failure, and the restore
   outcome) as gate evidence; do not silently retry the EU-20 install on
   the same machine without understanding why R1-R3 were needed.
