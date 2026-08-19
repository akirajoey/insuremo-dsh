# `@icomposer/workbench-operation-log`

Host-only operation evidence service for Workbench side effects. The provider
stores one schema-validated `operations` table through `ctx.storageDomain` and
exposes:

- `append()` for pending operation records;
- `list(filter)` for deterministic evidence lookup;
- `decide(id, approved, by, reason)` for the one-way pending → approved/rejected
  transition.

Records deliberately contain only request identifiers, digests, artifact
references, decisions, and timestamps. Request/response payloads and tokens do
not belong in this domain. The provider emits `operation-log/recorded` and
`operation-log/decided` after durable writes.

The plugin is mounted by `@icomposer/bundle-workbench` after the Harness
`storageDomain` service is available. It has no React or client dependency.
