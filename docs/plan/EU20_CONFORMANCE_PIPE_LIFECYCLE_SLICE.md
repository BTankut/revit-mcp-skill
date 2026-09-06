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
