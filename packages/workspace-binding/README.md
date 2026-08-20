# @icomposer/workspace-binding

Durable InsureMO environment binding overlay for Harness workspaces. Reuses `ctx.workspaceRegistry` for identity and order; stores only `environmentId/tenantCode/authProfile/writeMode` per `workspaceId` in domain `workbench_workspace_binding` v1. Binding is local-write but has no browser transport yet; all remote checks remain server-side.

- Reuses `ctx.workspaceRegistry` for `workspaceId/canonicalPath/displayName/status`; never accepts caller paths, never creates/deletes workspaces, never writes source/session files.
- Domain `workbench_workspace_binding` v1, table `bindings` (strict: `workspaceId`, `canonicalPath`, `environmentId` (full `_insuremo_` ID), `tenantCode`, `authProfile`, `writeMode`, `metadataFingerprint:null`, `sourceFingerprint:null`, `revision>=1`, `createdAt/updatedAt`).
- Frozen `ctx.workspaceBinding` face: `list`/`get`/`bind`/`unbind` all return allowlist `Result<T>` with fixed `code/message`; `list` follows Harness registry order and includes unbound (`binding:null`) and orphan bindings; `bind` first `expectedRevision=0→1`, same canonical different env/tenant → `binding-conflict`, same identity may only change `authProfile`/`writeMode` via CAS, exact no-op does not bump revision, concurrent same revision only one wins, stale orphan same canonical blocks new bind (`path-already-bound`) until explicit `unbind`; `unbind` requires current revision and only deletes the binding record.
- Single-host/single-writer; `env`/`tenant` active identity is immutable after bind.
- Auth truth is checked only at remote execution time via `prepare` lease comparison; binding stores identity only.

Phase 3 limits: no browser transport, no `operationLog` approval for binding, binding is local-write.
