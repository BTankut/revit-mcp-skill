Hedef | Plan satırı | Kabul | Kapsam | Forecast

# EU21 P3-T12 signed Bridge delivery source slice

- Hedef: WP3-owned signer, deterministic source-free Bridge worker/add-in update package, durable Gateway import/object/release authority, device-authenticated manifest/artifact delivery, real poller claim consumption, and inert-by-default `bridge-cd.yml` source.
- Plan satırı: `docs/implementation-plan/03-bridge-addin-installer.md` P3-T12 and P-UPD, bounded by the 2026-09-07 EU21 scoped plan.
- Kabul: generated-key detached-envelope parity with the frozen oracle; deterministic source-free packages; durable and immutable two-component release identity; tenant/device/seat/ring-bound delivery; real-client HTTPS consumption; explicit manual production signing/import controls; frozen-anchor proof.
- Kapsam: only the exact P3-T12 allowlist in the scoped plan plus this slice record. No O1 changes, production-key access, workflow dispatch, artifact publication, Gateway/machine/service/Revit/NAS/DNS/container deployment, live acceptance, M6 acceptance, or EU30 work.
- Forecast: 2.5-3.5 development days, excluding protected review/merge, production dispatch, lab delivery, and M6 owner decision.

## Source identity and frozen anchors

- Protected base commit: `4eeccd530639a8a8f5a3ebd408964009335ea108`
- Protected base tree: `12d33ece5fe7078722502ff23f76139385456d18`
- Sole protected-base parent: `6487299ed3a9b5e9e44f00a4464b03b6122134d1`
- `.github/workflows/signed-source-free-cd.yml` SHA-256: `E1BD3A40D103606613114CB029B865023F323F4B12232C07AE6700AEA96FCB3E`
- `installer/lib/RevAgent.DistributionIntegrity.psm1` SHA-256: `DF8F31B60432CC26FD73345CEE143E90B4235BA2DE08779813DAEDBC8563282E`

## Authority and artifact boundaries

- Tests use locally generated RSA keys only. Private material must stay outside release payloads and raw logs.
- Runtime Gateway composition receives public trust material and read authority only.
- The bounded import process alone receives publisher authority; source merge is inert.
- Bridge release objects are immutable and disjoint from session/result object storage.
- Signing, immutable artifact transfer, Gateway import/channel activation, deployed delivery, lab apply/rollback, fleet promotion, and M6 acceptance remain separate gates.

## Park List

- Production signing with `revagent-prod-rsa-2026q3`.
- Immutable Actions artifact publication and Gateway-host import.
- Gateway migration/application and route deployment.
- Real enrolled workstation and Revit-open/crash-loop drills.
- Pilot/stable promotion and M6 owner acceptance.

## Local source candidate checkpoint — 2026-09-08

Status: locally green final-review repair candidate. Scope amendment:
composition fixture entrypoint below.

### Scope amendment — 2026-09-08 final-review composition fixture

The final review found that the C# TLS poller fixture independently returned
manifest and ZIP bytes, so it did not prove the real Gateway import,
PostgreSQL release authority, filesystem release objects, M5 device-authenticated
endpoint, and poller in one chain. The exact allowlist is amended with one
test-only orchestration entrypoint:

- `packages/gateway/src/bridgeUpdateComposedFixtureCli.ts` (new)

It may accept generated fixture material and an explicitly named disposable
loopback PostgreSQL instance, import through the production import function,
mount the real endpoint/store behind loopback TLS, and emit only bounded public
fixture coordinates. It must not expose a production bypass, accept production
keys, publish externally, or weaken runtime authentication. The existing
allowed `bridgeReleaseImportCli.ts`, its test, `bridge-cd.yml`, and
`eu12Persistence.integration.test.ts` own the Actions-receipt and retained-volume
PostgreSQL 16 restart corrections; no other path is added.

### Scope amendment — 2026-09-08 update mutation coordination

The focused `test-all` run exposed an access-denied rename in the composed
matrix while crash rollback and pending add-in apply could concurrently mutate
the same add-in slot outside the update-state mutex. The exact allowlist is
amended with these closely related runtime paths for one bounded common
mutation/version guard and deterministic interleaving proof:

- `packages/bridge/src/RevAgent.Bridge.Host/Update/BridgeUpdateEngine.cs`
- `packages/bridge/src/RevAgent.Bridge.Host/Update/BridgeUpdateStateStore.cs`
- `packages/bridge/src/RevAgent.Bridge.Host/Update/PendingAddinApplyService.cs`
- `packages/bridge/src/RevAgent.Bridge.Host/Update/CrashLoopRollbackController.cs`

Their already allowed focused update/composed tests may change. The guard must
serialize only owned update filesystem/state mutations, preserve crash-loop
rollback responsiveness, and refuse a pending add-in target that became stale
or quarantined while waiting. It must not change ACLs, add sleeps, weaken
assertions, or broaden into worker supervision or service behavior.

Implemented within the exact allowlist:

- WP3 `.NET 8` signer with strict RSA private/public-key matching, exact
  `bridge-manifest` detached projection, deterministic PKCS#1 RS256 output,
  and create-new atomic envelope publication.
- Deterministic source-free worker/add-in package builder with normalized ZIP
  order/timestamps, exact `year/revAgentPlugin/...` replacement layout,
  component size/hash binding, and Git/tool provenance.
- Migration 011 and the existing EU12 release store extension for exact
  manifest/envelope, two immutable component objects, sequence/floor/channel,
  tenant targets, device ring assignments, idempotent replay, and transaction
  rollback on publication failure.
- Disjoint `OBJECT_STORE_ROOT/releases/bridge` create-only adapter with bounded
  keys, link-safe ancestry, no-follow reads, and byte revalidation.
- M5-authenticated manifest/artifact endpoint with server-derived tenant,
  active device/seat enforcement, exact current-release recheck, uniform hidden
  failures, no range/list/redirect surface, and byte-verified ZIP responses.
- P3-T11 poller bearer/device/fingerprint claims on the manifest and same-origin
  artifacts; cross-origin signed URLs retain token non-forwarding.
- An inert-by-default `bridge-cd.yml`: generated-key validation is automatic;
  production signing and Gateway import require separate booleans, typed
  confirmations, runner labels, protected environments, and exact artifact
  id/digest/repository/run/head bindings.
- Production import authenticates repository and artifact metadata directly at
  the fixed GitHub API origin, binds artifact id/digest, repository ids,
  workflow run and head SHA, then downloads and hashes the raw outer ZIP via a
  credential-free signed redirect before parsing its five allowlisted entries.

Focused evidence:

- `artifacts/eu21-p3t12-delivery/logs/bridge-build.log`: Bridge solution build,
  zero warnings/errors.
- `artifacts/eu21-p3t12-delivery/logs/signer-tests.log`: 4/4 signer tests.
- `artifacts/eu21-p3t12-delivery/logs/real-gateway-composed-poller.log`: 1/1
  cross-process composed test. The real poller traverses generated-key local
  import, `PostgresEu12DataStore`, `FilesystemBridgeReleaseObjectStore`, the
  M5 enrollment/device/seat authority, `createBridgeUpdateEndpoint`, and
  loopback TLS for manifest plus both authenticated artifact reads.
- `artifacts/eu21-p3t12-delivery/logs/package-signer-parity.log`: 12 assertions;
  signer/oracle canonical bytes, digest, fingerprint and deterministic RS256
  parity; deterministic packages; private-key containment; frozen hashes.
- `artifacts/eu21-p3t12-delivery/logs/review-repair-gateway-focused.log`: 14/14
  focused signature/object/import/endpoint tests, including one authenticated
  Actions archive success and id/digest/repository/run/head negatives before
  any object or database publication. Adjacent repair logs prove Gateway lint,
  build, and full test-aware typecheck.
- `artifacts/eu21-p3t12-delivery/logs/postgres16-retained-volume-restart.log`:
  9/9 migrations/persistence tests against one loopback-only PostgreSQL 16
  container. The test closes every owned pool, stops and starts the same
  container, proves its 64-hex container id is unchanged, proves its exact
  named data volume remains mounted, proves `StartedAt` changed, reconnects,
  and reads the same release identity/sequence/floor/targets/ring.
- `artifacts/eu21-p3t12-delivery/logs/review-repair-workflow-pins.log` and
  `review-repair-workflow-yaml.log`: immutable action pins and three-job YAML
  parse after the authenticated Actions importer change.
- Parent read-only evidence
  `.orchestration/autopilot-v2/artifacts/EU-21/astra/p3t12-420/actions-artifact-readonly-proof/READONLY-ARTIFACT-BINDING.json`
  independently proves a real authenticated Actions artifact API digest equals
  the raw downloaded outer ZIP SHA-256 and binds repository/run/head ids. It is
  readiness evidence only, not a production release.
- `artifacts/eu21-p3t12-delivery/logs/abc-package-provenance-workflow.log`:
  21/21 package/signature/provenance/workflow assertion groups. Wrong HEAD,
  wrong tree, and tracked-dirty source each refuse before an output staging
  root exists; prepared directories require the explicit fixture switch and
  produce `fixtureOnly:true` with no source HEAD/tree claim. Branch dispatch
  is denied while protected-main dispatch plus the existing boolean/typed
  confirmation is admitted.
- `artifacts/eu21-p3t12-delivery/logs/abc-update-mutation-race.log`: 2/2,
  covering the prior composed-matrix failure and a deterministic interleaving
  where pending v2 waits, rollback restores/quarantines, and the stale pending
  attempt cannot overwrite restored v1. The full focused update classes are
  15/15 in `abc-update-focused-all.log`.
- `artifacts/eu21-p3t12-delivery/logs/abc-workflow-pins.log` and
  `abc-workflow-yaml-main-boundary.log`: immutable action pins, YAML parse,
  and the protected-main production-import job boundary.
- `artifacts/eu21-p3t12-delivery/abc-actual-source-02681777/`:
  generated-key actual-source proof whose builder independently matched clean
  implementation commit `026817779077d2240996aebbc941bf774abcd1b4` and
  tree `5716132be26bb0e78be45a0eeedac688eb6771db`; provenance records
  `sourceKind:git-clean-source-build` and `fixtureOnly:false`. It contains one
  33,610,443-byte single-file worker ZIP
  (`1df1add86cddccb0429ad3567cc3108fcd57947b971bd7ce78847d97c6f8bb93`)
  and one 2,188,123-byte Revit 2022 add-in ZIP
  (`bb97ae103b7fcd60cf0556b82836f2e5083d6a1f4a4428368d2cd46ae79af69d`).

The parent `test-all` failure at source head `23995593` was the confirmed
pending-apply/crash-rollback add-in swap race: access was denied while both
paths renamed the same `.addin-backup-*` directory. The shared mutation lease
now covers release commit, crash rollback, and pending add-in deployment;
downloads stay outside the lease, and staged commit authority is rechecked
against tenant/device/session/version/sequence/digest/quarantine state.

Forecast was 2.5–3.5 development days (20–28 hours). Actual elapsed source
execution from draft creation through final-review repair was 2.1 hours, a
variance of -17.9 to -25.9 hours. The A/B/C closure added approximately 0.6
hours, for 2.7 hours total and a final variance of -17.3 to -25.3 hours.
Protected checks,
review, merge, production signing/import, deployed delivery, lab drills, and
M6 ownership remain excluded from both values.
