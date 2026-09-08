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
