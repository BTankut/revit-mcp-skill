Hedef | Plan satırı | Kabul | Kapsam | Forecast
EU21 normal-stop CI failure diagnostics | EU21 engineering-gate remediation, repeated normal-stop signature | Failing wait reports terminal state, teardown outcome, ownership snapshot, and secondary fault without weakening lifecycle rules | Bridge test support and the one fail-closed composition test only; no production code, retry, timeout, or assertion relaxation | Focused test plus one bounded Bridge.Tests suite if focused passes; 45 min

# EU21 normal-stop diagnostic slice

The repeated Engineering-gate failure is
`WorkerCompositionWithoutDispatchSurfaceStaysFailClosed`, which exhausts the
normal-stop helper before it requests explicit teardown. This slice makes the
existing fail-closed lifecycle observable at that boundary. It must preserve
the existing synchronization, stop-state predicate, close/drain/ownership
rules, and NormalStopped assertion.

Acceptance evidence is a focused failure path whose assertion exposes the raw
stop state, coordinator snapshot, retained teardown task/result/disposition/
deadline, and `AttemptTeardownResources.SecondaryFault`; cleanup must still
stop an active coordinator after diagnostic assertion failure. A deterministic
fixture change is allowed only if that evidence proves it, and remains bounded
to the named test.

Park List: production behavior, timeout/retry changes, CI reruns, and any
product-level lifecycle repair are out of scope.

## Local evidence

- Focused target: passed, 1/1 in 231 ms after the diagnostic assertions
  exercised the existing missing-dispatch fail-closed fixture.
- The first bounded `RevAgent.Bridge.Tests` run reached the target as passed,
  but was setup-invalid: 1315 passed, 47 failed, and 2 skipped because this
  new worktree lacked `node_modules/typescript/lib/tsc.js` and the PowerCut
  harness executable.
- Pinned Node 24.14.1 `npm ci --ignore-scripts`, the protocol and add-in
  fixture builds, locked solution restore, and Release solution build then
  completed without generated-source drift or build errors.
- No normal-stop assertion failure reproduced locally, so no state-4 or
  `AttemptTeardownResources.SecondaryFault` was captured. The later foreground
  suite log contains 1362 passed, 0 failed, and 2 skipped, but its controller
  did not report a terminal exit status; it is incomplete evidence, not a
  green gate. A subsequent detached duplicate was terminated during cleanup.

Forecast/actual/variance: forecast was one focused test and one bounded full
suite. Actual was one focused pass and one setup-invalid full suite; the target
signature remains unresolved and final full-suite validation remains with the
protected CI. No deterministic fixture adjustment was proved.
