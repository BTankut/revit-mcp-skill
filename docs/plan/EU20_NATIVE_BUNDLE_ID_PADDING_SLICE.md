# EU-20: recognize padded native bundle extraction IDs

Scope record before implementation, 2026-09-07.
Base `af305001508315cb57168e6a3e94d4ac92a75baa`, tree
`ba3a0dc2db8fc9fe8fa157eecd53e9d9dfe9e80d`.

The genuine Windows installer and enrollment path succeeded. During the
authorized lab cleanup, BridgeOwned uninstall refused a runtime-created
native extraction directory whose bundle ID ends with `=`. The current
directory and native-library path expressions exclude that character.

The extracted `e_sqlite3.dll` was proved byte-for-byte inside the exact
signed worker; the same bundle ID is embedded in that worker. The stopped
owned directory was reversibly archived with its bytes and ACLs preserved,
then the unchanged uninstaller and original-baseline restoration completed.
That maintenance recovery is not evidence that default uninstall accepts
the genuine runtime layout, and it does not close EU-20 or accept M6.

## Bounded correction

Recognize .NET-generated padded bundle IDs in the existing dedicated
`bundle-extract/revagent-bridge` and `bundle-extract/revagent-bridge-host`
namespaces. Keep bounded path shapes, native DLL leaf restrictions,
unrecognized-state refusal, no-follow checks, exact payload verification,
ACL checks and report preservation unchanged.

Owned scope:

- `installer/bridge/lib/RevAgent.BridgeInstall.psm1`
- `scripts/test-eu20-owned-surfaces-native.ps1`
- `scripts/test-eu20-bridge-install.ps1` only if needed for portable regression coverage
- This scope/evidence record.

Acceptance: the actual padded bundle-name shape is accepted in the complete
owned cleanup plan and removable in the redirected native fixture; dry-run
does not mutate it; unrelated paths, unsafe nesting, reparse/foreign state
and unsupported leaf types remain refused. Exercise relevant Windows
PowerShell 5.1 and PowerShell 7 coverage. Run the required delivery gates
once for the final source candidate, with one independent final review and
the protected PR checks.

This is an active EU-20/M6 prerequisite correction under the existing
programme authority. Forecast: 45-75 active engineering minutes excluding
gate waiting; actual and variance will be recorded from execution evidence.
Park List: publisher-handled live Revit validation and live installer
idempotency remain outside this correction. No lab, model or deployment
action is part of this source change. Automatic production signing after
merge requires its concrete operator decision once the candidate is ready;
the already consumed #415 approval is not reused for a new signing effect.
