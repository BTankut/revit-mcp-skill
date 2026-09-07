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

