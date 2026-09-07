# EU-20 native bundle invariant grammar slice

Hedef | Plan satırı | Kabul | Kapsam | Forecast

- Hedef: Make Bridge-owned native bundle path recognition culture invariant on Windows PowerShell 5.1.
- Plan satırı: EU-20 B2 cleanup recovery after the genuine same-package reinstall proof.
- Kabul: The actual padded bundle id is accepted under isolated `tr-TR` and `en-US` processes in Windows PowerShell 5.1 and PowerShell 7; changed grammar, Unicode, traversal, wrong-root, overlength, overpadding, and non-DLL descendants remain refused.
- Kapsam: Only the two native bundle directory/library predicates in `Test-RevAgentBridgeOwnedStatePath`, plus focused regression coverage in `scripts/test-eu20-bridge-install.ps1`.
- Forecast: 35 minutes for implementation, focused cross-shell validation, and evidence handoff.

Parent retains ownership of ready/merge, final delivery, protected checks, signing, and all PETRUCCI recovery. This slice does not perform machine, Revit, service, container, credential, or cleanup operations.

Acceptance evidence:

- Windows PowerShell 5.1.26100.9168: isolated fresh-process probes passed under `tr-TR` and `en-US`, 12/12 cases each.
- PowerShell 7.6.5: isolated fresh-process probes passed under `tr-TR` and `en-US`, 12/12 cases each.
- Both changed files parse without errors in both shells; `git diff --check` passes.
- The actual `_bye7OuDW05BPw_IhGRjA7qrECW1Wuk=` directory and native DLL leaf pass. Case-insensitive ASCII path behavior remains accepted. Embedded padding, Unicode in the root/id/library, traversal, wrong root, overlength, overpadding, and non-DLL descendants remain refused.
- Focused validation only; the broad delivery pipeline and live BridgeOwned recovery remain parent-owned.

Forecast / actual / variance: 35 minutes / 8 minutes / -27 minutes.

Park List:

- Broader cleanup grammar refactors.
- ACL test expansion unrelated to the native bundle path grammar.
- Live recovery or milestone acceptance claims.
