# Plugin compliance worklog

Stage record for the plugin-compliance remediation. One section per card; each
section records what was committed, how it was verified, what remains open, and
which report findings it addresses. Commands are summarized; raw logs and
machine paths are intentionally omitted.

## TASK-162 — isolated behaviour baseline and authorization sync

- **Commit**: `2fa3fc9ef0a39ce2f5652290926ce41bca7dc499` (parent `e87b8619…`)
- **Scope**: `docs/plugin-compliance-design.md`, `docs/plugin-compliance-validation.md`, new `test/compat/{run.mjs,baseline.test.ts,README.md}`.
- **Changes**: documented the user's staged implementation authorization and the single accepted conflict (`EX-WH-01`: Workspace-row health icons keep the existing in-place observer/root driver); added an isolated H2 source-runtime harness (real Cordis/Loader/WebServer/ToolRuntime/SystemPrompt) with standalone/aggregate golden, route-owner diagnostics, tool-lifecycle observations, and a static health-driver/footer guard.
- **Verification**: verifier ran `node test/compat/run.mjs` (8/8), confirmed ten real H2 source resolutions, the fail-closed isolation guard, cleanup of the runner's own `/tmp` directory, and that no repo shim was used; service/UI materialization was not claimed.
- **Residuals**: real UI, rc.5, Windows, HMR and installation unverified; the ad-hoc mixed-source `tsc` closure stayed non-green (later card 167).
- **Report**: C-01–C-09, V-01–V-13, U-01–U-04 baseline.

## TASK-163 — route registration/release transaction

- **Commit**: `bff658819c879b5c610008e3f111068a1bfd3b59` (parent `2fa3fc9e…`)
- **Scope**: `packages/insuremo-service/src/overview/{route-service,write-routes}.ts`, `test/compat/{baseline.test.ts,README.md}`.
- **Changes**: route registration moved onto the service fiber's public `ctx.effect`, each acquired disposer tracked and released newest-first; `mountWriteRoutes` rolls back its own partial handles when a registration fails before returning the composite disposer; duplicate/registration errors stay loud; no new internal hook or timer.
- **Verification**: verifier ran the compat suite (13/13 ×3), the existing route suites (21/21), and independent probes for six rollback shapes (first/mid-write/late duplicate, injected failure, throwing rollback). Confirmed 40 ms stability, 404 for all owned paths after unload, generation-2 remount, and preservation of foreign/unrelated owners. The aggregate root's ACTIVE state with a failed route child was recorded as an entry-point propagation boundary (later card 165).
- **Residuals**: real HMR not claimed; root-level failure propagation left to 165.
- **Report**: C-05.

## TASK-164 — tool/prompt registration lifecycle

- **Commit**: `98d08dce1900bdf93e5ef987c7f401c8635514e9` (parent `bff6588…`)
- **Scope**: `packages/icomposer-verify/src/{tool-service,tool-defs,ici-tools,ici-jobs-tools,ici-explain-tools,ici-search-tool}.ts`, `test/compat/{baseline.test.ts,README.md}`.
- **Changes**: tool/prompt registration owned through the public `ctx.effect`, one disposer per item, transactional rollback that rethrows the original error; registrars accept an optional `onRegister` collector. The existing `internal/plugin` listener is retained to keep same-turn synchronous release (public effects only release after the unload turn yields); handles are single-shot, so later teardown is a no-op. No tool name/schema/prompt text changes.
- **Verification**: verifier ran compat 15/15 and the verify suite (24 pass, 1 pre-existing skip); confirmed 8 tools/7 prompts exactly once, same-turn release, awaited remount, partial-failure rollback with the original error, foreign registration preservation, and AST literal comparison showing no prompt/schema changes. Three probes covered dispose/effect/listener combinations.
- **Residuals**: same-turn release still depends on `internal/plugin`; removal needs a public synchronous-unload API plus a real HMR test. Real HMR unverified.
- **Report**: V-03.

## TASK-165 — single entry shape, real root inject, child-failure observability

- **Commit**: `d27935e5633264fc1c0741fa52f6d36f1e81aabc` (parent `98d08dc…`)
- **Scope**: `packages/insuremo-service/src/index.ts`, `packages/icomposer-workbench-dist/src/index.ts`, `packages/icomposer-workbench-dist/test/dist.test.mjs`, `test/compat/{baseline.test.ts,README.md}`, `docs/plugin-compliance-design.md` (§9 D2 only).
- **Changes**: the insuremo root keeps one plugin shape (default CLI) and exposes the full mount as an explicit `insuremoServiceMount` object used only by the aggregate; `WORKBENCH_ROOT_INJECT` is the single source for `static inject` and the dist patch (10 services, `systemPrompt` stays child-level); child mounts report activation-time failures through a structured host log while healthy siblings keep running; D2 wording synced to “keep existing synchronous release, disclose the internal listener if no equivalent public mechanism”.
- **Verification**: verifier ran compat 16/16 ×2, the service suite 322/322, dist 8/8 + 2/2, and probes for the dual loader golden, the three-source inject equality, the duplicate-route child (FAILED + structured log + healthy siblings), and the pending-await semantics. Two wording corrections were required (F1: no deadlock claim; F2: label/truncation only for activation-time failures) and passed targeted re-verification.
- **Residuals**: aggregate root stays ACTIVE when an unawaited child fails; that is logged, not propagated. Real HMR/rc.5/UI unverified.
- **Report**: C-03, C-06, V-04, V-10, plus the 163 entry-point residue.

## TASK-166 — aggregate static Config with real nested schema

- **Commit**: `27126540b8883c470924d85d2fce24d354c73f4e` (parent `d27935e…`)
- **Scope**: `packages/icomposer-workbench-dist/src/{config.ts,index.ts,harness-shims.d.ts}`, `test/compat/{baseline.test.ts,README.md}`.
- **Changes**: `WorkbenchDistService.static Config` is a real nested schema with four optional objects; `lifecycle`/`verify`/`write` share one `{command, timeoutMs}` definition (defaults `imo`/30 000 ms); `insuremoService` reuses the existing Insuremo schema so its defaults and clamps are unchanged; object-level and leaf validators strip the host's `but got <value>` tail; unknown keys stay merged (D4) with a key-name-only warning.
- **Verification**: verifier ran the 16-case value matrix (no sentinel in errors or host log), the real-loader end-to-end cases (fiber FAILED, zero partial mount), compat 22/22, and confirmed the unknown-key wording ruling. F1/F2 fixes were re-verified.
- **Residuals**: `schema(null)` still passes null (YAML `config:` empty value would fail later); recorded as a future small card. Real loader only, no rc.5/UI.
- **Report**: V-05.

## TASK-167a — published-declaration contract gate

- **Commit**: `df7c0a8bb6af69467614af05f8e73469697633ed` (parent `2712654…`)
- **Scope**: new `test/types/{run.mjs,contract.ts,negative.ts,README.md,SHIM-AUDIT.md}`.
- **Changes**: rc.2 and rc.5 tarballs installed into throwaway projects; strict positive contract; five negative cases that must fail; `--listFiles`/`--traceResolution` prove the target declarations were loaded (no repo shim, no sibling checkout); per-shim audit with diagnostics and ownership.
- **Verification**: verifier ran both versions (rc.2 9389 declarations / rc.5 9421; 5 negative diagnostics each), confirmed the negative cases are effective by compiling a copy with them removed (exit 0), checked the audit numbers and scope purity.
- **Residuals**: audit diagnostics were measured on rc.2 only (rc.5 per-package re-run belongs to TASK-172); no shim was deleted; 4 replaceable shims wait for TASK-171 devDependencies, 9 need source typing in TASK-172. `skipLibCheck` applies to third-party declarations only.
- **Report**: V-07, V-08, U-01.

## TASK-168 — local UI primitives, brand slots, client inject cleanup

- **Commit**: pending (maintainer commit after verifier PASS).
- **Scope**: `packages/ui-insuremo-status/src/client/` (new `primitives/`, `InsuremoBrand.module.css`, `ProfilePicker.tsx`, `WorkspaceHealth.tsx`, deleted `BrandChrome.tsx`/`.module.css`), `packages/ui-insuremo-status/{README.md,vitest.config.ts}`, `packages/ui-workbench-jobs/src/client/` (new `primitives/`, `JobNode.tsx`), both package manifests' `dsh.client.inject`, package tests, `test/compat/baseline.test.ts` (health source hash only).
- **Changes**: plugin-owned Tooltip/Button/MenuSurface/anchored-position/dismiss and job StateDot/icon replace `@deepseek-ai/dsh-client-ui-primitives` runtime values; `BrandChrome` removed and brand identity only comes from the three official brand slots; `EX-WH-01` driver/position/observer/polling/footer registration unchanged (only the Tooltip import and the removed brand child changed); `dsh.client.inject` no longer lists primitives in the status/jobs packages. The status README discloses the transitional Picker portal, its planned TASK-173 replacement, the absence of a final DOM compliance claim, and the two `react-dom` call sites.
- **Verification**: status package 42/42, jobs 44/44, settings 60/60; compat 22/22; bundle audit shows no `@deepseek-ai/dsh-client-*` require (React allowed; `react-dom` remains only for the existing Picker body portal, a documented transition to TASK-173). First verification FAIL (F1: a deleted BrandChrome test block also dropped a still-valid WorkspaceHealth brand-token assertion; F2: README disclosure missing) → fixed → targeted re-verification confirmed F1/F2 passed but identified F3 (inaccurate worklog test count, scope and verification rounds) → documentation-only fix; final card result is pending independent re-verification. Real page/focus/visual behaviour is **not verified** (no browser automation available).
- **Residuals**: Picker still uses a component-owned body portal as a documented transition (TASK-173 replaces it with the official `shell.overlay`; this card does not claim final DOM compliance; the only `react-dom` call sites are that portal and the `EX-WH-01` `createRoot`); real page/focus/visual behaviour unverified. The `BrandChrome`-specific cases were removed with the component; one health CSS assertion from that block (detected glyph uses `--dsw-alias-brand-primary`, not `--dsw-alias-state-success-primary`) was migrated into `task064-brand.test.tsx`'s health theme case, and brand-slot tests remain.
- **Report**: V-01, V-02, V-11, U-02, U-03.
