# EU-20 owned installer surfaces and recovery

Hedef: preserve shared Revit permissions and remove the owned Bridge footprint safely | Plan satırı: M6/P3-T9, P3-T10, P-INST-1, P-INST-3 and M6 lab runbook R1 | Kabul: native elevated install/cleanup fixtures preserve a SYSTEM-owned shared Addins directory and unrelated add-ins while removing only Bridge-owned files | Kapsam: installer ACL targets, owned distribution ACL producer, explicit Bridge cleanup and focused/native regressions | Forecast: 1-2 active engineering hours excluding CI/review

Base: protected main `80d65e661b96cdf24d546101b98df6b75dc04db7`.

The genuine PETRUCCI installation passed credential protection, binary
deployment and configuration, then failed after publishing its canonical
manifest. The installer removed inheritance from the shared
`C:\ProgramData\Autodesk\Revit\Addins\2022` directory before granting
distribution access. Its SYSTEM-owned directory and inherited children lost
their DACL entries, and the subsequent grant failed. Reordering alone is
insufficient: this shared Autodesk directory must retain its existing ACL.

The exact original ACL backup was restored through the same administrator's
already enabled Windows backup/restore rights, without privilege grants,
ownership changes or a permissive intermediate ACL. The original manifest,
33 R-D files, nine directories, task, timestamps and complete protected
snapshot were restored. No enrollment, service start or Revit operation
occurred. The failed installation remains failed.

Recovery also proved a separate inconsistency: the current cutover
uninstaller removes named legacy roots but omits the new Bridge/add-in/state
footprint, although lab runbook R1 promises cleanup of those owned paths.
Fourteen verified test-created files and fourteen empty directories therefore
needed separately recorded cleanup. Preserve existing legacy-cutover behavior;
provide an explicit bounded Bridge-owned removal path and correct its call
sites/documentation rather than silently broadening the legacy wipe scope.

The correction must preserve shared directory ACLs and unrelated files; apply
safe, locale-independent, verified distribution permissions only to owned
surfaces; preserve foreign/deny permissions through refusal; and make owned
cleanup retain rollback anchors and unrelated user state. Review the complete
install-to-cleanup path together to avoid another isolated producer-only fix.
Credential protection and the frozen protocol/enrollment contract remain intact.

Native elevated PS5/PS7 fixtures must exercise a SYSTEM-owned shared parent,
unrelated sibling files/directories, exact ACL/content preservation, owned
manifest publication, partial-install cleanup, foreign-surface refusal,
idempotency and no-mutation dry-run behavior. Focused checks precede one final
freshness/test-all/test-ci sequence, independent source review and protected
delivery checks. Live lab acceptance follows delivery from a restored baseline.

Incident evidence: local `artifacts/EU-20/astra-b1/b2-install-80d-a8f4aba39ee140bea549e26e0accfaf4`.
Full protected preservation digest:
`9C599E25F4F200F2A29057D8857CC0E8D1EEB6EBFDE5844CF14F925A7BAE5ABB`.
Park List: none. Active time is not instrumented; measured gate times and final
evidence will be reported without inventing actual/variance values. No
milestone acceptance, production publication or new live authority is implied.

## Candidate behavior and evidence boundaries

The shared manifest directory is never passed to the distribution ACL writer.
The manifest producer creates its own protected file ACL, validates a prior
managed revAgent manifest and preserves the shared directory ACL. Distribution
permissions use numeric SIDs, trusted owner/foreign-or-deny preflight,
grant-before-inheritance ordering and exact final readback.

`Uninstall-RevAgentBridge.ps1 -Scope LegacyCutover` preserves the default
behavior. The explicit `BridgeOwned` scope requires a matching signed package,
trusted keys and a fresh external report. Its preflight recognizes signed
static payloads and runtime state paths from BridgeInstallLayout,
AtomicCredentialFileWriter, RollingJsonBridgeLog and the host's dedicated
bundle-extraction root. It refuses unknown/modified surfaces before removal,
does not read runtime credential contents, preserves legacy anchors/config,
and does not recreate the state root to persist its report. There is no updater
version-history cleanup extension in this slice.

The Windows PowerShell 5.1 focused suite is green. Its existing file-copy
fixture explicitly substitutes ACL metadata/native calls and is not native
permission evidence. The separate
`scripts/test-eu20-owned-surfaces-native.ps1 -EvidenceRoot <fresh-private-path>`
uses actual PS5/PS7 ACL/file operations with an ephemeral test signer/public
payloads, a SYSTEM-owned shared parent, unrelated siblings/subdirectory,
manifest publication/replacement, partial cleanup, foreign refusals,
idempotency and no-mutation dry-run. Elevated execution remains pending at
this checkpoint; no native or live installer pass is claimed before execution.
