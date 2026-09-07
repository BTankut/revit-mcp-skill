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

Status: repair in progress after final review. Scope amendment: composition
fixture entrypoint below.

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

Focused evidence:

- `artifacts/eu21-p3t12-delivery/logs/bridge-build.log`: Bridge solution build,
  zero warnings/errors.
- `artifacts/eu21-p3t12-delivery/logs/signer-tests.log`: 4/4 signer tests.
- `artifacts/eu21-p3t12-delivery/logs/bridge-update-tests.log`: 14/14 update
  engine/composed tests, including generated-release consumption through a
  real loopback TLS server and exact same-origin claims.
- `artifacts/eu21-p3t12-delivery/logs/package-signer-parity.log`: 12 assertions;
  signer/oracle canonical bytes, digest, fingerprint and deterministic RS256
  parity; deterministic packages; private-key containment; frozen hashes.
- `artifacts/eu21-p3t12-delivery/logs/gateway-delivery-tests.log`: 9/9 focused
  signature/object/import/endpoint tests; Gateway lint and build logs are
  adjacent.
- `artifacts/eu21-p3t12-delivery/logs/postgres-eu12-delivery-restart.log`: 9/9
  migrations/persistence tests against a fresh loopback-only PostgreSQL 17
  fixture. The restart predicate closes/recreates the EU12 store and database
  pools against the same running disposable PostgreSQL server; it is a Gateway
  process/store restart proof, not a PostgreSQL server-restart claim.
- `artifacts/eu21-p3t12-delivery/logs/workflow-action-pins.log` and
  `workflow-yaml.log`: immutable action pins and three-job YAML parse.
- `artifacts/eu21-p3t12-delivery/actual-source-release-d8528542/`:
  generated-key actual-source proof bound by provenance to implementation
  commit `d8528542085b02c6574d4cd3e72c40ad9aed8bc5` and tree
  `5070ac5ac896565922f59061d222ed13a397c069`; it contains one
  33,610,567-byte single-file worker ZIP
  (`924a1d912d9a0be4267e26658a5fe814b02dc50f8eb3b43b6e0a5545dc4fdc3e`)
  and one 2,188,129-byte Revit 2022 add-in ZIP
  (`3f1b798255d8ced57edc314a5614fd0d5659f529e7f142db8f140aae1eb3f7a1`).

Forecast was 2.5–3.5 development days (20–28 hours). Actual elapsed source
execution from draft creation to this checkpoint was 1.0 hour (0.125 of an
8-hour development day), a variance of -19 to -27 hours. Protected checks,
review, merge, production signing/import, deployed delivery, lab drills, and
M6 ownership remain excluded from both values.
