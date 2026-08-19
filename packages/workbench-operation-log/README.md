# `@icomposer/workbench-operation-log`

Host-only operation evidence service for Workbench side effects. The provider
stores one schema-validated `operations` table through `ctx.storageDomain` and
exposes:

- `append()` for pending operation records;
- `list(filter)` for deterministic evidence lookup;
- `decide(id, approved, by, reason)` for the one-way pending → approved/rejected
  transition;
- `recordResult(id, { resultDigest, artifactRefs })` for the durable
  execution-receipt write-back. Only an `approved` record can record a result,
  exactly once; a pending/rejected/missing record or a duplicate write is
  rejected with `OperationLogError` (`not-approved` / `already-has-result` /
  `missing-operation`).

Records deliberately contain only request identifiers, digests, artifact
references, decisions, and timestamps. Request/response payloads and tokens do
not belong in this domain. The provider emits `operation-log/recorded`,
`operation-log/decided`, and `operation-log/result-recorded` after durable
writes.

`@icomposer/insuremo-service` consumes this seam as the approved-upgrade
authorization+evidence backend: `requestUpgrade` appends a pending
`imo-upgrade` record, and a successful approval flows into the upgrade loop.

The plugin is mounted by `@icomposer/bundle-workbench` after the Harness
`storageDomain` service is available. It has no React or client dependency.
