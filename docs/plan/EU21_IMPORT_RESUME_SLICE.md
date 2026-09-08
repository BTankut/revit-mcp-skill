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

## Implementation and acceptance evidence

- `bridge-cd.yml` now has an explicit `resume_existing_artifact` branch. Normal import still requires successful generated-key validation and production signing; resume requires both jobs to be skipped and `sign_release=false`. Both branches retain protected `main`, `publish_release=true`, and `PUBLISH_BRIDGE_UPDATE` gates.
- The import job always retains `self-hosted`, `Linux`, and `revagent-gateway-publish`. Its optional fourth label accepts only `revagent-eu21-resume-` plus 12 lowercase hexadecimal characters and therefore only narrows runner selection.
- The protected-main helper resolves either same-run signing outputs or retained artifact coordinates, verifies the checked-out commit, and requires the retained source head to equal or precede the current protected-main head before migrations.
- Migration credentials remain step-scoped: the migration URL must come from `BRIDGE_RELEASE_MIGRATION_DATABASE_URL`, the application-role password from `REVAGENT_APP_DATABASE_PASSWORD`, and the publisher URL remains independently supplied through `BRIDGE_RELEASE_PUBLISHER_DATABASE_URL`.
- Focused resolver and workflow tests: 12/12 passed. Raw log: `artifacts/eu21-import-resume/logs/focused-tests.log`.
- Protocol/Gateway build, Gateway lint, and Gateway typecheck passed. Raw logs: `artifacts/eu21-import-resume/logs/build.log`, `lint.log`, and `typecheck.log`.
- Workflow YAML parsing and immutable action-pin validation passed. Raw logs: `artifacts/eu21-import-resume/logs/workflow-yaml.log` and `workflow-pins.log`.
- A local CLI smoke used the exact retained run/artifact/digest/source coordinates and the scoped JIT label; it resolved resume mode and preserved the normalized SHA-256 authority. Output: `artifacts/eu21-import-resume/logs/resolver-smoke-output.log`.

Forecast was 1.5-2.5 implementation hours. Actual local implementation and focused verification was approximately 0.4 hours, a variance of -1.1 to -2.1 hours. Protected review, merge, runner preparation, import execution, lab evidence, and owner acceptance remain excluded.

The draft PR must remain unmerged until protected checks and review are green and the operator grants separate merge approval. This slice does not authorize signing, import dispatch, runner registration, lab mutation, or M6 acceptance.
