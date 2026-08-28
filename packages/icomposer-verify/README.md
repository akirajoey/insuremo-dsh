# @icomposer/icomposer-verify

Read-only iComposer utility verification and Agent tools for a bound workspace.
Host-only, injects `[subprocess, workspaceBinding, imoAuth, tools]`, frozen face:

- `verifyUtils({ workspaceId, file }, signal?)` — verify one workspace-relative
  Groovy file (`imo icomposer verify utils --json --profile <authProfile> <file>`)
- `listUtils({ workspaceId }, signal?)` — list known utility classes (`--list`)
- `searchUtils({ workspaceId, keyword }, signal?)` — search classes/methods (`--search`)

## Semantics

- Auth follows the lifecycle pattern: inside an
  `imoAuth.prepare({profile: binding.authProfile, env: binding.environmentId})`
  lease; `--profile` always comes from the binding; `-k/--insecure` is never
  used; `--refresh-cache` is deliberately not exposed (network refresh is a
  later card). `cwd` is the workspace canonical path.
- argv validation: Groovy paths must be workspace-relative (no leading `/`,
  no `..` segments, `.groovy` suffix, safe charset); keywords are narrow
  (`[A-Za-z0-9._ -]`, ≤128); profiles/environments are character-class checked.
- stdout/stderr are digest-only (`sha256:`). JSON stdout parses within a 1MB
  bound and projects a strict allowlist: class name / method count /
  description, search matches, and the file report (`valid`,
  `classesChecked`, `used`, `unknownClasses`, `invalidMethods`) — every string
  ≤200 chars, lists capped at 1000 with a `truncated` flag. The CLI envelope
  (`base_url`, `profile_name`, `cache_file`, `warnings`) and the absolute file
  path echoed by the CLI never cross the boundary (the view carries the
  requested relative path).
- `verify utils` signals an invalid Groovy file through exit code 1 while
  still printing the JSON report; the capture therefore parses before mapping
  non-zero exits to `command-failed`.
- NOTE: the real CLI caches utility metadata under `<cwd>/.metadata/icomposer/`.
  Read-only consumers that cannot tolerate that transient write should run in a
  sandbox; the bundled smoke runs against the real tree and restores the
  created cache directory and touched directory mtimes exactly.

## Agent tools (read-only)

Registered under `ctx.tools` (all `isConcurrencySafe`, effect-free, structured
`{error:{code}}` outputs on gate failures). Seven tools in total — three
`icomposer_*` plus four `ici_*`:

- `icomposer_catalog_list` — catalog counts + ≤50 entry summary via
  `ctx.icomposerCatalog.listAssets`
- `icomposer_sdk_query` — SDK operation search via
  `ctx.icomposerReference.querySdkOperations`
- `icomposer_verify_utils` — utility listing/search via this package's faces
- `ici_query` — api-chain/impact graph queries via `ctx.iciEngine`
- `ici_build` — graph build (inline or background job)
- `ici_status` — read-only Code Intelligence diagnostics
- `ici_explain` — prepare one API with `query`, or one 2–10 API batch with `queries`, for a single Workbench confirmation card

The engine's index/search faces remain available for internal backend use, but
semantic search is temporarily unavailable as an Agent tool: no `ici_search`
ToolSkill or system-prompt section is registered.

## Injected context (TASK-067; policy 6)

`IciContextService` injects one compact structured block per session (step 1, dedup by digest, re-assert after compact/policy change): header `[iComposer workspace]`, `workspace_id`, grouped tools/auth, the workspace-relative `explain_results` contract, and short rules. It is a stable 1000-byte-bounded summary; tool schemas/system prompts remain authoritative, and the block carries no host paths, file contents, CLI examples, or secrets. For a named API business/technical question, the newest matching schemaVersion 3 `kind: final` under the workspace is the Explain Final source of truth; `prepare.json` is never an explanation result.

## Errors

`workspace-not-bound`/`workspace-not-found`/`invalid-workspace-id`/
`invalid-file-path`/`invalid-keyword`; auth subset `invalid-auth`/`forbidden`/
`prepare-invalidated`/`lease-revoked`; cli `command-failed`/`timeout`/
`parse-error`; `service-disposed`/`cancelled`; unknown → `cli-error`.
