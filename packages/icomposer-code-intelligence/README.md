# @icomposer/icomposer-code-intelligence

Host-only iComposer Code Intelligence pure TypeScript graph build core. Replaces the previous Rust/sidecar dual-stack (source `/Users/junjie.zhang/cargo` — build/mod.rs semantics) with an in-Workbench TypeScript implementation. No `rust/` directory, no sidecar protocol.

Frozen face: `ctx.iciEngine.build({workspaceId}, {signal, onProgress})`

- Reuses binding gate (`workspaceBinding`) and catalog semantics (`icomposerCatalog.listAssets`) for metadata/assets; performs direct groovy source scans with containment and 5000 bound. Sources or assets whose path contains `STD_DISCARD` are skipped entirely (no nodes/edges/placeholders) — Rust `collect_build_sources` semantics.
- Extracts relationships:
  - API→Function via `getCommonService("XxxService")` / `getBean` → `CALLS`
  - Function→Method / Method→Method via method definitions and `this.xxx()` / instance calls → `CONTAINS` / `CALLS`
  - Platform dependency edges from SDK client usage (`*SdkClient`) → `inferred` confidence (no remote fetch)
- Output nodes `{id,kind:api|function|method|model|batch,name,path,evidence}` and edges `{from,to,kind:CONTAINS|CALLS,ownerFile,source:static|platform|inferred,confidence}`.
- Atomic snapshot: `<DSH_HOME>/ici/<workspaceHash>/graph/current/` with a three-phase promote — `rename(current → stale-<ts>)` (skipped when absent), `rename(staging → current)` (rolls the stale copy back on failure so `current` is never half-deleted), then best-effort `rm(stale)` (failure only warns). Manifest `schemaVersion(1)/engineVersion/sourceFingerprint(aggregated sha256)/builtAt/node/edge counts`; cancelled builds keep the previous `current`; promote failures surface as fixed `storage-error`.
- Storage: `nodes.json` / `edges.json` / `manifest.json` (JSON, no SQLite/zvec).
