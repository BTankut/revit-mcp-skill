Hedef | Plan satırı | Kabul | Kapsam | Forecast

# EU21 retained signed artifact import-resume slice

- Hedef: Retain one production-signed GitHub Actions artifact and resume only its Gateway import against freshly enrolled lab tenant/device identities without rebuilding or signing again.
- Plan satırı: EU21 P3-T12 production import recovery after the original import job was cancelled, bounded to retained artifact authority and protected-main importer code.
- Kabul: An explicit import-resume dispatch on protected `main` preserves the authenticated artifact id/digest/source run/source head, proves the retained source is the current protected-main commit or its ancestor, admits only fresh existing tenant/device identities, and cannot run after cancelled or failed normal signing.
- Kapsam: `.github/workflows/bridge-cd.yml`, one focused Gateway input resolver/helper and tests, this record, and minimal developer-runbook guidance if required. No Bridge/Add-in C# or payload changes, signing, workflow dispatch, runner registration, lab mutation, release publication, merge, or milestone acceptance.
- Forecast: 1.5-2.5 implementation hours, excluding protected review, merge, runner preparation, import execution, lab evidence, and owner acceptance.

## Fixed authority

- Protected source anchor: `601191af6fe43d9fd1811491d6512d8bba95ffc7`.
- Retained Actions run: `34200665858`.
- Successful production-sign job: `101978649217`.
- Retained artifact id: `10045704659`.
- Retained outer artifact SHA-256: `69EB4E74D6E296937873630A4BFC06F6F2A5283387610907A59BB7B6BC413997`.
- Original production-import job `101978861098` did not run.

The resume path must keep the existing authenticated GitHub artifact metadata, raw archive digest, provenance, production signature, trusted-key, component digest, immutable object, tenant/device existence, idempotency, and transaction rollback checks. It must not recreate historical tenant/device identities or produce a new signature.

## Park List

- Protected review and merge.
- Importer JIT runner readiness.
- Import-only workflow dispatch and retained artifact publication.
- Fresh lab delivery/apply/rollback evidence.
- M6 owner acceptance.
