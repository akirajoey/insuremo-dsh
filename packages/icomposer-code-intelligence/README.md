# @icomposer/icomposer-code-intelligence

Host-only iComposer Code Intelligence pure TypeScript graph build core. Replaces the previous Rust/sidecar dual-stack (source `/Users/junjie.zhang/cargo` — build/mod.rs semantics) with an in-Workbench TypeScript implementation. No `rust/` directory, no sidecar protocol.

Frozen face: `ctx.iciEngine.build({workspaceId}, {signal, onProgress})`,
`ctx.iciEngine.queryApi({workspaceId, query, depth?, focus?, maxNodes?})`,
`ctx.iciEngine.queryImpact({workspaceId, query})`,
`ctx.iciEngine.index({workspaceId, mode?, rebuild?}, {signal, onProgress})`,
`ctx.iciEngine.search({workspaceId, query, mode?, top?})`.

- Reuses binding gate (`workspaceBinding`) and catalog semantics (`icomposerCatalog.listAssets`) for metadata/assets; performs direct groovy source scans with containment and 5000 bound. Sources or assets whose path contains `STD_DISCARD` are skipped entirely (no nodes/edges/placeholders) — Rust `collect_build_sources` semantics.
- Extracts relationships:
  - API→Function via `getCommonService("XxxService")` / `getBean` → `CALLS`
  - Function→Method / Method→Method via method definitions and `this.xxx()` / instance calls → `CONTAINS` / `CALLS`
  - Platform dependency edges from SDK client usage (`*SdkClient`) → `inferred` confidence (no remote fetch)
- Output nodes `{id,kind:api|function|method|model|batch,name,path,evidence}` and edges `{from,to,kind:CONTAINS|CALLS,ownerFile,source:static|platform|inferred,confidence}`.
- Atomic snapshot: `<workspace>/.metadata/icomposer/ici/graph/current/` with a three-phase promote — `rename(current → stale-<ts>)` (skipped when absent), `rename(staging → current)` (rolls the stale copy back on failure so `current` is never half-deleted), then best-effort `rm(stale)` (failure only warns). Manifest `schemaVersion(1)/engineVersion/sourceFingerprint(aggregated sha256)/builtAt/node/edge counts`; engine-version mismatches are stale and require `ici_build` before explain preparation or finalization. Cancelled builds keep the previous `current`; promote failures surface as fixed `storage-error`.
- Storage: `nodes.json` / `edges.json` / `manifest.json` (JSON, no SQLite/zvec). Legacy `<DSH_HOME>/ici/<workspaceHash>/graph/` snapshots remain read-only fallback and are never returned as artifact paths.

## Query surface (TASK-024; Rust `query/mod.rs` semantics)

- Queries load the promoted snapshot from `<workspace>/.metadata/icomposer/ici/graph/current/`, falling back to legacy `<DSH_HOME>/ici/<hash>/graph/current/`; no snapshot → fixed `no-snapshot`. A source-fingerprint or engine-version mismatch marks results `stale: true` while queries remain readable; `ici_explain` fails closed with `stale-snapshot` and asks the user to run `ici_build`.
- `queryApi`: case-insensitive substring match over api nodes (comma-separated
  multi-query, all starts returned; no match → `no-match` with ≤20 candidates).
  Downstream tree nodes `{id,kind,name,path,children[]}` carry per-edge
  `{kind,source,confidence,evidence≤160,ownerFile}`; function `CONTAINS` edges
  are pruned unless the node is the focus (agent-compact semantics); with a
  focus only subtrees passing through the focused function are kept;
  `depth` defaults 10 (cap 50), `maxNodes` defaults 120 (cap 2000) with a
  `truncated` flag and boundary list.
- `queryImpact`: starts limited to function/method nodes; upstream traversal
  stops at the api layer and emits `paths[] {apiId, hops[{nodeId, edge}]}`.
  Redundant upstream method calls are compressed (Rust
  `is_redundant_upstream_method_call`): a CALLS hop into a method is dropped
  when the caller also calls the method's owning function directly. Edge
  confidence is summarised as `{static, platform, inferred}` counts.

## Semantic search (TASK-025; Rust `search/mod.rs` semantics)

- Embedding texts follow the Rust `api_embedding_text` template
  (`API: <name>` / `Mode: technical|business` / `Downstream: …` / body),
  truncated at 8000 chars; downstream names come from a depth-2 BFS capped
  at 80 labels.
- Embedding requests run **inside an `imoAuth.prepare` lease** through
  `ctx.subprocess` curl (`-sS`, HTTP-status trailer, fixed portal headers,
  Bearer token from the lease, `--data-raw {"text":[…],"batch_size":N}`).
  Batches are 16 texts (8 apis × technical+business). stdout is bounded
  16MB and parsed for vectors only — URL/token never escape the lease;
  failures surface as fixed-code errors (`invalid-auth` on 401,
  `embedding-error` otherwise).
- Vector store: JSONL only (`<workspace>/.metadata/icomposer/ici/graph/search/api_embeddings.jsonl`), written atomically (three-phase promote). Lines carry `text_hash` + `source_hash`; indexing reuses cached vectors per api unless the source/text changed (`rebuild: true` forces full re-embed). Legacy DSH_HOME vectors are read-only fallback.
  zvec is intentionally not migrated (P2 residual).
- `search`: query vector via the same lease flow, cosine similarity scored
  in memory over the cache, top default 10 cap 50, rows
  `{apiId, apiName, score, evidence≤200, downstream≤5}`; no cache →
  fixed `no-index`; stale sources → `stale: true`.
- Explain is an idle-confirmed flow: agent-facing `ici_explain` writes only bounded schema-3 prepare metadata and one task record. Targets come from one selector — `query` (single API), `queries` (explicit list), `group` (one code group), or `all` (every API of the workspace) — and `group`/`all` are resolved **host-side** against the workspace catalog snapshot, so the caller never enumerates or splits a task: ONE call is ONE task card with every target and no target-count ceiling. Same-named assets at different paths are refused explicitly (`ambiguous-target`) instead of being merged. The task record carries its own `maxConcurrent` (the task's batch setting), `requestedCount`, and the once-confirmed plan (provider/model/reference/not-before) that a user-clicked retry reuses; the effective concurrency is `min(task, Host ceiling)`. The member id list is persisted as immutable shard generations with an atomic header switch, so a large task stays readable and a missing shard fails the whole task instead of yielding a partial one. The keyed Workbench toolview pages the member list server-side (`?page&size`) and shows real whole-task counts.
