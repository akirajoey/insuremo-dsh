# POC Readiness — 十项完成定义核对

> TASK-033 交付物。逐条映射十项 POC 完成定义到实现卡、验证证据与当前状态。
> 状态图例：**VERIFIED**（自动化测试/审计覆盖）、**MANUAL**（真实环境手工验证过）、**GAP**（POC 未覆盖，显式列出）。
> 证据中的测试计数以 Phase7 收官时全仓 `pnpm test` 结果为准（315 node + 12 UI 全绿；端到端回归另有 12/12 步骤全绿，`--stability` 模式含 5000 资产与 SIGKILL 存活）。

| # | 完成定义 | 状态 | 实现与证据 |
|---|---------|------|-----------|
| 1 | 可以添加一个真实 iComposer 项目并恢复到同一 workspace | **VERIFIED** | `@icomposer/workspace-binding`（TASK-018）：canonicalPath 绑定、revision CAS、unbind/orphan 状态；持久化于 storage domain，进程重启后可恢复（`workspace-binding.test.ts` 9 tests；catalog/lifecycle/ici 各包 reopen 测试）。真实项目 `/Users/junjie.zhang/skills/ssapocpa` 在 TASK-019/021/026 smoke 中反复绑定成功（api=236/function=209/batch=11/model=3）。 |
| 2 | workspace 明确显示 environment、tenant、profile，且不能静默切换 | **VERIFIED** | BindingView 暴露 environmentId/tenantCode/authProfile/writeMode；environment/tenant 对活动绑定不可变（`binding-conflict` 错误码）；所有 CLI 调用显式携带 `--profile`，无默认回落（verify/write/lifecycle argv 精确断言）。 |
| 3 | 可以从 InsureMO 设置页执行 IMO/Skills 检查、升级和升级后验证 | **VERIFIED**（升级演练为只读审计替代） | `@icomposer/insuremo-service`（TASK-002–013）：`imo` 升级 0.2.17 全链（备份→安装→验证→回滚预案）+ skills 安装/激活审批闭环（operationLog receipt）；`ui-insuremo-settings` 设置页（12 UI tests）。**Harness 升级演练**以 `scripts/audit-compat.mjs` 只读审计 + 固定 99f6f02 回滚预案替代真实升级（项目约束：Harness 固定；真实升级属发布后演练）。 |
| 4 | access token 不进入浏览器状态、session transcript 和普通日志 | **VERIFIED** | token 仅在 `imoAuth.prepare` lease `use(callback)` 闭包内可见；所有 face 返回 digest-only（stdoutDigest/textDigest）；`scripts/audit-secrets.mjs` 全仓扫描通过（token 形状/canary/home 路径白名单）；测试断言无 `access_token`/`sekret` 泄漏（intercom/write/ici 各包）。 |
| 5 | 能完成 `imo icomposer verify` 和一次 `push --dry-run` | **VERIFIED**（dry-run 级） | `@icomposer/icomposer-verify`（TASK-022）：真实 smoke 经快照→还原零写闭环；`@icomposer/icomposer-write` pushPreview（TASK-028）：dry-run argv 无 prefer 标志、allowlist 投影、真目录零写。真实 push 非本卡范围——见 GAP 列表。 |
| 6 | 能从真实 `.metadata` 和 Groovy 源码生成代码图并查询 API、影响和搜索结果 | **VERIFIED** | `@icomposer/icomposer-code-intelligence`（TASK-023–027）：真项目 454 保留源 → 4502 节点/10308 边；queryApi/queryImpact/search（embedding 真实端点 lease 内）/explain 全套；三段式原子 promote + SIGKILL 存活（026 + e2e stability 复验）。 |
| 7 | 两个 session 可以互相发送消息，后台 session 有运行、等待、完成和未读标识 | **PARTIAL** | `@icomposer/workbench-intercom`（TASK-031/032）：register/heartbeat/send/ask/reply/cancel/pending/resolveStatus 全 domain 推导（315 tests 含并发 CAS、reopen durability）；未读=pending 计数、等待=waiting+waitingFor。**GAP**：真实两个 Harness session 的接线（Host 内多 session 桥）与后台 session UI 标识属后续 UI/接线卡（Phase6 后续），当前以进程内双 session 测试与 e2e 步骤覆盖协议层。 |
| 8 | 所有远端写入和升级操作都有审批记录 | **VERIFIED** | `@icomposer/icomposer-write`（TASK-028/029/030）：push/test/release/create/metadata 五类远端写全部 operationLog 审批门（pending→approved→execute）+ one-shot journal + resultDigest/artifactRefs receipt；skills 升级/安装同为审批闭环。冲突永不自动解决（conflict → 显式 resolve 审批链）。 |
| 9 | Web 页面刷新后，已持久化 session、workspace 和操作证据仍可恢复 | **VERIFIED** | workspace/operationLog/intercom 全部持久化于 storage domain（JsonStorageBackend）；reopen durability 测试（binding/operation-log/intercom 三包）；e2e 报告 `<DSH_HOME>/e2e-report.json` 重新生成可复跑。 |
| 10 | Harness 升级演练可以在不破坏以上闭环的情况下通过，失败时可回到已固定版本 | **VERIFIED**（只读审计替代） | `compatibility.json` 固定 `99f6f02`；`pnpm run check` 每次验证；`scripts/audit-compat.mjs` 20 项检查全过（HEAD pinned、tree clean、全部 @deepseek-ai/* peer 解析到固定 checkout、bundle 14 插件依赖齐、lockfile 快照）。回滚预案：Harness 目录独立 checkout，`git -C ../deepseek-harness checkout 99f6f02` 即恢复，Workbench 无需改动。 |

## 未验证能力（显式列出）

以下能力在 POC 中**未真实执行**，均以 fake/只读路径验证，标注为后续 [REAL_RUN] 演练项：

1. **真实 push**（写远端）：仅 dry-run + 冲突 resolve 审批链 fake 测试；真实执行需有效 ssapocpa token（已过期）+ 人工确认目标租户。
2. **真实 test api/function**：证据 artifact 落盘/读回已验证，真实远端执行未跑。
3. **真实 release apply**：仅 dry-run 预览 + repos/branches 真实只读列表；真实 apply（写 Git）未执行。
4. **真实 create / metadata 更新**：createOptions 真实枚举 + createPreview dry-run valid=true（真实 CLI 接受计划），真实创建未执行。
5. **真实冲突样本**：push 冲突 JSON 形状基于 imo 二进制词表 + 防御性解析，无真实冲突输出样本。
6. **多进程 multiwriter**：intercom 写链 CAS 为进程内语义；跨进程并发（两个 Host 进程同时写 domain）依赖 storage 后端串行化，未做双进程压测。
7. **GPUI**：Phase 8 另行立项，不在 POC 范围。
8. **真实 Harness 升级**：以只读审计 + 回滚预案替代（见第 3/10 条）。

## 端到端回归入口

```
pnpm --filter @icomposer/icomposer-workbench-e2e run e2e            # 12 步全链（默认）
pnpm --filter @icomposer/icomposer-workbench-e2e run e2e:stability  # + 5000 资产 + SIGKILL 存活
node scripts/audit-compat.mjs                                       # 兼容审计（快照 docs/compat-audit.json）
node scripts/audit-secrets.mjs                                      # 脱敏检查（只读）
```

e2e 报告输出至隔离 `<DSH_HOME>/e2e-report.json`（12 步 {step, ok, durationMs, counts}，失败非零退出）。
