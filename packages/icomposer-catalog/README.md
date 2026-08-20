# @icomposer/icomposer-catalog

Read-only iComposer asset catalog for a bound workspace. Host-only, hard-injects
`workspaceBinding` (via `workspaceBinding.get()` for the bound `canonicalPath`),
frozen `ctx.icomposerCatalog.listAssets({ workspaceId, type? }, signal?) →
Result<AssetCatalog>`. No IMO subprocess, no network, no writes, no cache.

## Scan semantics

- **Containment**: every metadata/source file is `realpath`-resolved and must lie
  inside the workspace canonical path; symlink escapes and out-of-root reads are
  skipped (`sections.<type>.skipped`).
- **API / Function / Model**: top-level `.metadata/<type>/<Name>.metadata.json`
  (256KB bounded, strict allowlist projection), source
  `src/dev/<tenant>/<group>/<type>/<Name>/<Name>.groovy` (2MB bounded, sha256).
- **Batch**: recursive discovery of `batch.metadata.json` under `.metadata/batch/`
  (depth ≤ 6), name from `BatchName`/directory, allowlist projection includes
  `JobName/RecordUsage/_IComposerSourceEnvironment`, tenant/group from path.
  Batch source is `src/dev/<tenant>/<group>/batch/<Name>/**/*.groovy` (first
  reachable bounded file). Step (`step.metadata.json`) and step-item metadata are
  **not** assets in this card and are not read (deferred to a later card).
- **Join statuses**: `clean` / `local-modified` (md5 vs server `Md5Value`),
  `no-server-md5` (source present, no server md5), `source-missing` (metadata
  without source — the normal case for batch/model), `metadata-missing` (source
  without metadata).
- Bounded to 5000 assets (`truncated: true` beyond); damaged/corrupted metadata
  JSON is skipped non-fatally; missing directory yields empty result + `missing`
  section.
- **Errors**: `workspace-not-found` / `invalid-workspace-id` / `invalid-type` /
  `service-disposed` / `cancelled`; unknown binding codes are collapsed to
  `storage-error` (no internal messages are passed through).
