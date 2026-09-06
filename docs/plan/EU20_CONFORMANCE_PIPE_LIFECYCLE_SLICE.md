# EU-20 delivery: conformance child-process teardown

Scope record before implementation, 2026-09-06.

Base: `e7414874ac71fb34d0aff9583147c8f26538870c`, tree
`f809d8545ed37c476618c03d6206cdc8f588fd4b`.

The required post-main CI run `34039739605`, Gateway job `101504200350`,
failed conformance shard 4/5 with an uncaught `write EPIPE` from
`packages/rbp-conformance/src/processHarness.ts:787`. Its 15 files and 213
tests passed, but the uncaught lifecycle error correctly failed the gate.
The latest test was the FIFO-violation case in `processHarness.test.ts`.
Engineering and the separately approved signed CD passed.

The suspected race is between fatal-response termination and `stop()`:
pending requests reject and the child receives termination before the exit
event marks the harness closed, allowing shutdown to write to dying stdin.
The fix must establish terminal state and own stream errors without hiding
failed requests or weakening the FIFO acceptance checks.

## Plan and ownership

This is a bounded repair of the existing EU-20/M6 delivery gate, required
before the approved installer/live-read lab sequence can proceed. It uses
the standing correction authority for a failing prerequisite. O1/RBP wire
semantics and production Gateway/Bridge/installer behavior remain fixed.

Implementation ownership is limited to:

- `packages/rbp-conformance/src/processHarness.ts`
- `packages/rbp-conformance/tests/processHarness.test.ts`
- This scope/evidence record.

## Acceptance and validation

Demonstrate the teardown race deterministically. Reject affected pending
work, prevent new control writes after a terminal failure, handle stdin
errors explicitly, and retain bounded, checked child shutdown. Run focused
process-harness regressions and required delivery checks on the final
candidate, followed by independent review and protected exact-head gates.
Do not reuse the failed main run as green delivery evidence.

Forecast: 30-60 active engineering minutes, excluding CI and review waiting.
Actual and variance are pending; do not infer active time from wall time.
Park List: none in this slice. Product IP-resilience follow-up is already
recorded separately in the local programme parking list.

No lab installation, live acceptance or milestone closure is represented by
this source/test correction.

## Implementation and focused evidence

The FIFO rejection test now holds the real fixture child alive across its
termination request, deterministically exposing the interval before the exit
event. Two additional cases destroy the actual stdin Writable with `EPIPE`
and `ECONNRESET`. On the original implementation all three new cases failed
and Vitest recorded two uncaught stream errors. These are deliberate local
fault injections, not a claim that the exact CI scheduling was replayed.

Fatal control failures now close admission before rejecting pending requests
and requesting termination. The stdin error event has an owner throughout
stdio drain; write callback errors and fatal protocol/time-budget failures
use the same terminal transition. An expected component control-error
response still leaves the channel usable. `stop()` continues to require an
observed exit and bounded pipe drain; it no longer sends shutdown after a
terminal control failure or reports a shutdown acknowledgement for that path.

Focused validation on Node 24.14.1: all 31 process-harness cases passed,
including strict FIFO rejection, all affected pending promises, absence of
post-failure writes, real process disappearance, late stream-error ownership,
and the existing checked stop/drain cases. Protocol build, conformance
typecheck, changed-file ESLint and `git diff --check` passed. The focused
configuration intentionally selects only this process test file and does not
prepare the production Gateway/Bridge stack.

Raw red/green evidence is retained outside the checkout under
`.orchestration/autopilot-v2/artifacts/EU-20/astra-b1/conformance-pipe-lifecycle`.
Required freshness, `test-all.ps1`, and `test-ci.ps1` results are recorded there
against the final committed head; their terminal receipts, not this pre-gate
record, establish delivery status. Independent review and protected checks
remain required. Active engineering time was not independently metered, so
no actual-hours or forecast variance claim is made. Park List remains empty.

## Inventory follow-up

Protected CI run `34043105264`, Gateway job `101513271433`, executed all five
shards successfully at `5f245c8e5e93826116d25dd73422cf60a5485ef2`: 73 files,
626 tests (624 passed, two expected skips), without the uncaught pipe errors.
The final wrapper correctly failed because its frozen expectation still
counted 623 tests. This slice added three regression cases: the deterministic
FIFO teardown case and the two parameterized stdin-error cases.

The authorized ownership extension is limited to the `expectedTests`
constant in `packages/rbp-conformance/scripts/run-tests.mjs`, updated from
623 to 626. Exact file, shard, test-count and failure checks remain intact;
neither the harness nor test behavior changes in this follow-up.

The five-shard execution and successful local delivery gates remain evidence
for the original `5f245c8e` head. The inventory successor receives syntax,
exact-diff and recorded-total validation only; its final protected CI must
execute separately. No earlier run is relabeled as successor execution.
