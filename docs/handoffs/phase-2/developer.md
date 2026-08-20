# Developer Handoff — Phase 2

## 1. 模块 / 服务图

```
apply(ctx) ── root composition
 ├─ ImoCliService        (read-only CLI: probe/version/upgradeCheck)
 ├─ ImoUpgradeService    (approval-gated upgrade loop; inject imoCli/operationLog/subprocess)
 ├─ ImoSkillsService     (read-only skills list/configPath/validate; owns skillsAllowedRoot=homedir)
 ├─ ImoSkillActivationService (durable activation store + frozen imoSkillActivation face)
 │   └─ onController closure → ImoSkillActionsService (write actions; internal, not in Object graph)
 ├─ ImoAuthService / ImoAuthActionsService (req/resp + approval-gated auth writes)
 ├─ ImoOverviewService   (ctx.imoOverview.snapshot: aggregate allowlist view, coalesce+TTL)
 ├─ effect: mountOverviewRoute  (GET /api/icomposer-workbench/insuremo/overview)
 └─ effect: mountInsuremoSkillProvider (Harness catalog rank 450)
```

服务注入顺序（重要）：
1. `ImoCliService`, `ImoUpgradeService`, `ImoSkillsService`
2. `ImoSkillActivationService`（其 `onController` 回调内以 `actionsMounted` 守卫挂载 `ImoSkillActionsService` —— 保证 controller 就绪后才创建写服务）
3. `ImoAuthService`, `ImoAuthActionsService`
4. `ImoOverviewService`（一次性读齐 imoCli/imoAuth/imoSkills/imoSkillActivation/operationLog）
5. 两个 effect（route + provider）

## 2. 关键文件

- `src/index.ts`：Barrel、Cordis Context augmentation、`inject = [subprocess, operationLog, skills, storageDomain, webServer]`、apply 组合。
- `src/config.ts`：`Config` + `resolveConfig`（新增 `allowedGitHosts`、`overviewTtlMs`(0–5000)）。
- `src/run.ts`：`runCapture`/digest/`classifyHttpStatus`；raw stdout/stderr 永不出包（仅 digest）。
- `src/harness-shims.d.ts`：Context 类型 shim（含 `webServer`）。
- TASK-013/014：`skill-path.ts`/`skill-document.ts`/`skill-cancellation.ts`/`skill-provider.ts`/`skill-activation.ts`(+`-adapter.ts`)。
- TASK-015：`skill-actions/`：`types.ts`/`validation.ts`(source/agent/argv + provenance)/`preview.ts`(`--list` 等只读)/`diff.ts`(name+SKILL.md digest)/`finalize.ts`(buildSkillReceipt)/`execution-journal.ts`(one-shot/evidence-pending)/`recovery.ts`(partial-write best-effort)/`service.ts`(approval 闭环,≤361)。
- TASK-016：`overview/`：`types.ts`(allowlist view)/`snapshot.ts`(buildOverview)/`service.ts`(ImoOverviewService+OVERVIEW_PATH)/`route.ts`(mountOverviewRoute)。
- UI：`packages/ui-insuremo-settings/src/client/`：`overview.ts`(narrow validator)/`InsuremoSection.tsx`(类组件)+`OverviewPanel`/`AuthPanel`/`SkillsPanel`/`DiagnosticsPanel`/`locales.ts`。
- 测试：`packages/insuremo-service/test/*.test.ts` 按任务拆分；UI 用 `ui-insuremo-settings/test/insuremo-settings.test.tsx` + `SlotTestRuntime`。

## 3. apply / inject 语义

- root `inject` 由 bundle `cordis.patch.yml` 提供 5 项；profile dump 中 insuremo-service 行 inject 恰为 `[subprocess, operationLog, skills, storageDomain, webServer]`。
- `ctx.imoSkillActivation` 是 frozen 2-method 只读 face（ensureInitialized/snapshot）；mutator 走模块级 WeakMap face→controller，仅 `ImoSkillActivationService` 内部 + root apply 闭包 + actions service 使用；root 不导出 controller/journal/recovery。
- `ctx.imoSkillActions` 亦 frozen（request/execute/status），服务类不出 root。

## 4. 运行 / 测试 / 真实 smoke

- 安装：`pnpm install --frozen-lockfile`；静态：`pnpm check`(compatibility against harness `99f6f02`)、`pnpm typecheck`；全测：`pnpm test`。
- service 单测：`cd packages/insuremo-service && TSX_TSCONFIG_PATH=../../tsconfig.base.json node --import tsx --test test/*.test.ts`。
- UI：`cd packages/ui-insuremo-settings && pnpm test`（vitest+SlotTestRuntime）；bundle：`pnpm run bundle`（`lib` gitignored）。
- 真实只读 smoke（隔离、零写入）：使用仓库测试 helper 与临时 `DSH_HOME`，真实 IMO 仅执行已批准只读命令；运行前后校验真实 home hash 一致，只报告 section counts/status/digest（如 `hasAccessToken=false`），不回 profile 值或正文。
- 安全扫描：`rg -n 'node:child_process|--insecure'`（命中均为测试 canary 或既有 upgrade 注释）。

## 5. 扩展接口（TASK-015 / 016 接线点）

- **TASK-015 写动作**：`ImoSkillActionsService` 在 root apply 的 `onController` 闭包内挂载；新增 kind 需：types.ts 加 union+normalize，service `executePending` 分派，provenance/actionTargetDigest，preview 只读校验，execute gate 复用 journal/recovery/finalize。
- **TASK-016 只读桥**：新 route 在 `route.ts` 仿 mountOverviewRoute 注册（`webServer.register({kind:"exact",...})`）；新 section 在 `snapshot.ts` 加 best-effort builder + `types.ts` allowlist + diagnostics 派生；client 侧在 `overview.ts` narrow validator 加字段并加 panel 组件。
- 已预留：`overviewTtlMs` config、`allowedGitHosts`；写 transport（POST/approve/execute）为 deferred，CSRF/Origin 设计是 Phase 2 记录的风险。

## 6. 单文件 ≤500 规则

- 所有生产源码与测试文件 ≤500 行；TASK-015 的 `skill-actions/service.ts` ≤450（当前 361）；最大生产文件 446（`skill-activation.ts`）。超限须拆分（skill-actions 已拆 types/validation/preview/diff/finalize/journal/recovery/service）。

## 7. 已知限制与 Phase 3 接入点

- 内存 execution journal：仅单进程 one-shot；crash 后 approved-but-unrecorded action 返回 `missing-pending-input` 需人工 reconcile，不宣称跨进程 exactly-once（README 已注明）。
- 双独立 `JsonStorageBackend` 指向同一 root 为 Harness unsupported（无 CAS/last-writer-wins）；单服务单 writer + expectedRevision。
- JSON 单写者、bundle/profile 由 Harness source mapping 注入 storageDomain。
- 浏览器写 transport 未做（CSRF/Origin 待设计）；`ctx.imoSkillActions` 仅 Host 内，UI 尚无写面。
- Phase 3 候选：project/workspace scope 放开（当前 `workspace-not-bound`）、写 transport + UI、sidebar 真实总状态（当前 ui-insuremo-status 为 placeholder）、operation-log/receipt 浏览器查看、多实例/跨进程锁、升级 smoke battery 与 channel 前端。
- 必须遵守：不得记录或传递任何本机凭据、profile 值或 raw output。
