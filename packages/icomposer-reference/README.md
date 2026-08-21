# @icomposer/icomposer-reference

Read-only iComposer SDK-client and utility reference index for a bound workspace.
Host-only, hard-injects `workspaceBinding` (via `workspaceBinding.get()` for the
bound `canonicalPath`), frozen face:

- `listSdkClients({workspaceId})`
- `querySdkOperations({workspaceId, client?, keyword?, limit?})`
- `listUtilities({workspaceId})`
- `queryUtilityMethods({workspaceId, util?, keyword?, limit?})`

No IMO subprocess, no network, no writes, no persistent cache (each call scans
the tree in real time).

## SDK index

- Real-time scan of `sdk/*/`; the directory name is the client name and the
  swagger file is `<dir>_swagger.json` (bounded 8MB/file).
- Projection per operation: `client`, `method`, `path`, `operationId`,
  `summary?`, `tag?`. Operations without an `operationId` are skipped and
  counted in the client summary (not failed). `summary`/`tag` are clipped to a
  fixed 200 unicode chars: when longer they are truncated to 199 chars plus a
  trailing `…` (ellipsis), so the emitted value is always ≤ 200.
- Parsed-invalid or oversized swagger → client `status: "invalid"` (non-fatal);
  out-of-root (symlink escape / realpath) → `status: "skipped-escape"`.
- `querySdkOperations`: case-insensitive keyword over
  client/path/operationId/summary/tag; exact `client` filter; `limit` defaults
  to 50, caps at 200, `truncated` flag.

## Utility index

- Real-time scan of `ref_doc/*.md` (bounded 1MB/file); the util name is the file
  name minus `.md`.
- Methods extracted from `## <method>` headings (deduped, `Sample`/util-name
  headings skipped); a doc with no headings yields `methods: []` (ok, non-fail).
- `queryUtilityMethods`: exact `util` filter; case-insensitive keyword over
  util/method names; `limit`/truncated semantics as above.

## Errors

`workspace-not-bound` / `workspace-not-found` / `invalid-workspace-id` /
`invalid-client` / `invalid-util` / `invalid-limit` / `service-disposed` /
`cancelled`; unknown binding codes are collapsed to `storage-error` (no internal
messages passed through).
