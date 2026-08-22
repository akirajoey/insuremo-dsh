# @icomposer/icomposer-write

Approval-gated iComposer push write path: dry-run preview, receipted push
request/execute, explicit conflict resolution, and status reads. This is the
only package in the Workbench that may cause remote writes, and it never does
so without an approved operation record.

Host-only. Injects `[subprocess, workspaceBinding, imoAuth, operationLog]`.

## Face `ctx.icomposerWrite` (frozen)

- `pushPreview({workspaceId, files, batch?})` — read-only `push current|batch
  … --dry-run --json` inside an imoAuth lease. Per-file allowlist projection
  `{file, target, localVersion, serverVersion, conflict, compileChecks?,
  warnings≤20}`; `localVersion` is a sha256 digest of the local file content
  (never the content itself). Digest-only evidence; raw output never crosses
  the face.
- `pushRequest({workspaceId, files, batch?, checkUsages?, skipCompile?})` —
  appends a pending operation record (kind `imo-icomposer-push`,
  `paramsDigest` = sha256 of canonical files+flags) after running the same
  dry-run preview, and returns the pending view with the embedded preview.
- `pushExecute(operationId)` — the write gate. Requires the operation record
  to be externally approved and pending; a one-shot in-process journal
  guarantees at most one external push attempt (retries are pure evidence
  reads). Runs the real push **without any prefer flag**; a CLI conflict
  becomes a `conflict`-status receipt (zero auto-resolution) recorded via
  `recordResult`.
- `pushResolve({operationId, choice, by})` — explicit conflict decision.
  `cancel` appends a resolve operation (kind `imo-icomposer-push-resolve`)
  and immediately finalizes it as `rejected` with `reason=cancel`.
  `prefer-local` / `prefer-server` append a **pending** resolve operation
  (paramsDigest hashes choice + original operation id); only after it is
  approved does `pushExecute(resolveOperationId)` re-push with the
  corresponding prefer flag. The whole chain is receipted.
- `pushStatus(operationId)` — operation record + journal state projection.

## Safety properties

- Zero spawn until an approved operation exists (`pushExecute` on a pending
  or rejected record never spawns).
- Conflict is never auto-resolved: no prefer flag is ever passed unless an
  explicitly approved resolve operation says so.
- Timeout/cancel after the spawn is marked outcome-unknown and the operation
  is never re-run.
- File arguments are workspace-relative `.groovy` paths (same contract as
  `@icomposer/icomposer-verify`); `../`, absolute paths, backslashes, and
  duplicates are rejected client-side. `--insecure` is never passed.
- Errors are a closed union (`invalid-auth`, `not-approved`,
  `already-executed`, `conflict-resolution-required`, …) with fixed
  messages; hostile CLI output is dropped, only digests and bounded
  allowlist fields survive.

## TASK-029: test evidence + release closed loop

- `testRun({workspaceId, kind, name, data?, method?, overrideUnpushed?})` —
  appends a pending `imo-icomposer-test` operation (paramsDigest hashes the
  canonical params including the override flag) and projects the local join
  state for the target asset. `testExecute(operationId)` is the approval-gated
  execution: the **local unpushed guard** re-checks the metadata-md5 join at
  execute time and blocks `local-modified` assets with the fixed code
  `local-unpushed-changes` (zero spawn) unless the request carried
  `overrideUnpushed:true` — the choice is receipted on the immutable
  `TestReceipt`. Evidence is persisted as an allowlisted artifact at
  `<DSH_HOME>/write/<hash>/artifacts/test-<operationId>.json` (elapsed,
  httpStatus, request/response sha256 digests, traceId, testUrl, savedAt) and
  `recordResult` carries the artifact ref. One-shot journal semantics match
  push: retries are pure evidence reads.
- `releasePreview` — read-only `release apply --dry-run --json` preview.
- `releaseRepos` / `releaseBranches` — read-only repo/branch listings
  (object-map and array output shapes both supported).
- `releaseApply({workspaceId, type, name, repo, branch, message})` — appends
  a pending `imo-icomposer-release` operation (independent from push receipts
  — kinds never mix; `pushExecute` refuses release operations and
  `releaseExecute` refuses push operations). `releaseExecute(operationId)`
  runs the full apply argv after external approval; message is validated to
  1–500 chars without control characters.

## TASK-030: create + metadata closed loop

- `createOptions({workspaceId, kind})` — read-only live option vocabularies
  (`status`/`funcScope`/`requestMethod`/`requestType`/`responseType`, each
  capped at 50 `{code,label,canonicalInput,allowedMethods?}` entries) parsed
  from the real `create options api|function --json` shape. Future UI cards
  use this to drive dynamic field enabling.
- `createPreview` / `createRequest` + `createExecute` — dry-run preview, then
  an approval-gated `imo-icomposer-create` operation (one-shot journal).
  Params are narrowly validated (asset-name syntax, numeric ids, alias
  tokens, description ≤500, API path shape). Real create runs the full argv;
  afterwards the workspace is **re-scanned through `ctx.icomposerCatalog`**
  and the receipt records `catalogVerified` evidence that the new asset
  actually appeared (best-effort, never faked).
- `metadataPreview` / `metadataRequest` + `metadataExecute` — FILE validated
  like push (workspace-relative groovy); at least one of
  status/description/sse/integration/funcScope is required or the request is
  refused with `invalid-metadata-fields` (zero spawn); the applied field
  list is receipted.
- P2 fixes: failed artifact writes now unlink their `.tmp-*` file, and
  `isValidBranchName` rejects `..`/`.` path segments.

## Tests

`pnpm --filter @icomposer/icomposer-write run test` covers the dry-run argv
exactness (no prefer flags), file validation, pending request appends,
unapproved zero-spawn gate, one-shot execution with already-executed retries,
the full conflict → cancel / prefer-local approval chain, batch order,
auth-error passthrough, cancel/dispose, and digest-only output.
`test/real-write-smoke.tmp.mts` is a deliberately-run real-project dry-run
smoke (no real push in this card; `src/dev` verified unchanged).
