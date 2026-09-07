# EU-21 signed self-update and rollback slice

Hedef | Plan satırı | Kabul | Kapsam | Forecast

Signed Bridge/add-in self-update with loaded-add-in deferral and automatic
three-crash rollback | WP3 P3-T11 / M6 | Signed manifest and component hashes,
anti-rollback release sequence, ring/percentage selection, Revit-open deferral,
apply after close, previous-version restore, bad-version quarantine, and the
clean-install to update to rollback matrix pass in isolated fixtures |
`packages/bridge/**` plus this slice/evidence record; production signing,
PETRUCCI, live Revit, service, NAS, DNS, container, and fleet operations are
excluded | 6-8 hours

The implementation will reuse `RevAgent.Contracts` detached RS256 verification,
keep tenant/device identity bound to the authenticated manifest request and
deterministic rollout gate, persist the highest accepted sequence before apply,
stage content under redirected roots, and make version activation and rollback
idempotent. Tests use only generated test keys and fixture-owned processes and
directories.

True gates: production signing material and M6 acceptance.

