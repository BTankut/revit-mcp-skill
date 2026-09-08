# EU21 command payload packaging slice

Hedef | Plan satırı | Kabul | Kapsam | Forecast
Command payload survives signed add-in replacement | EU21 source-package repair | Clean-source addin.zip carries the canonical registry, descriptor, and Revit 2022 command-set DLL; missing shape fails closed; focused replacement proof and a real generated-test-key package are green | `packages/bridge/scripts/build-signed-bridge-update.ps1`, `packages/bridge/scripts/test-signed-bridge-update.ps1`, `packages/bridge/tests/RevAgent.Bridge.Tests/Update/BridgeUpdateEngineTests.cs`, `docs/plan/EU21_COMMAND_PAYLOAD_PACKAGING_SLICE.md` | 90 minutes

## Boundary

This slice changes only signed bridge update packaging, its focused generated-key test, and one existing Host test that directly exercises `BridgeUpdateEngine.DeployAddinSlot`. It preserves `scripts/build-revit-plugin.ps1`, production runtime lifecycle and transport code, frozen installer/runtime source, `src/revit-plugin`, the legacy signed-source-free workflow, and DistributionIntegrity.

The builder must assemble the command payload from the same clean Git source and build outputs as the add-in package. Required installer-relative paths are:

- `2022/revAgentPlugin/Commands/commandRegistry.json`
- `2022/revAgentPlugin/Commands/revAgentCommandSet/command.json`
- `2022/revAgentPlugin/Commands/revAgentCommandSet/2022/revAgentCommandSet.dll`

## Acceptance evidence

- Minimal package-shape validation refuses a missing registry, descriptor, or per-version DLL before ZIP creation or signing.
- The focused test exercises a whole-directory destination replacement and proves that registry-to-descriptor-to-DLL resolution remains intact afterward.
- A clean-HEAD source build with a generated test key produces source-free ZIPs, Git provenance matching that HEAD/tree, and a verifiable signature.
- Raw logs and package inspection evidence remain under the owned EU21 artifact directory.

## Park List

- Protected CI and final independent review.
- Ready, merge, production signing, upload, publication, activation, Revit, lab, or rollout effects.
- Replacement of the blocked v2 package in activation evidence.
