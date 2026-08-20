# Phase 2 Planner Handoff

## 阶段结果

Phase 2（InsureMO 设置与工具链）功能任务 TASK-008～TASK-016 已全部完成，本地 `main` release candidate 为 `128d28e1a3e7786895116061eb9ea460565ed58d`。Harness 基线始终固定为 `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`，未修改 Harness core。Phase 2 发布前远端 `origin/main` 仍为 Phase 1 `cd4207ce03e70631fed9811a1dd5038e1c753e77`。

## 任务与提交

- TASK-008 `4046a4a`：IMO CLI 只读 probe/version/upgrade-check。
- TASK-009 `0cf37a9`：审批控制的 IMO upgrade、smoke、digest receipt；真实 IMO 已经用户批准从 0.2.14 升至 0.2.17，7/7 smoke PASS。
- TASK-010 `c81b990`：安全 Skills inventory/provider skeleton。
- TASK-011 `a6e3807`：脱敏 Auth core、opaque revocable lease、模块化边界。
- TASK-012 `08f0f32`：Portal login/remote profile/default profile 审批动作。
- TASK-013 `e64988a`：真实 Harness `ctx.skills` provider、rank 450、catalog refresh。
- TASK-014 `c8e231c`：durable Skill activation gate；已有 skills 首次 adopt，新安装默认 disabled。
- TASK-015 `ab69990`：Skills install/update/remove/activation 审批动作、one-shot recovery、source provenance。
- TASK-016 `128d28e`：只读 Overview/Diagnostics Host GET bridge 与 Settings UI。

## 关键决策

1. Workbench 仅通过插件、bundle、profile 扩展 Harness；不修改 core。
2. 所有 IMO 进程统一经过 `ctx.subprocess`，不使用裸 `child_process`；credential-shaped 环境变量由 Harness scrubber 隔离。
3. 高风险动作统一走 operation log：preview/request → pending → approved/rejected → execute → digest-only receipt。
4. Token 仅存在于 IMO profile store 或 Host 内存 lease callback；HTTP、DOM、事件、日志、receipt 不携带 token/raw stdout。
5. Skills 安装与启用分离；Provider rank 450，项目级 candidates 保持更高优先级。
6. JSON storage 采用 Harness 官方 single-host/single-writer 约束；独立 backend 同 root 的 multi-writer 不支持，不自造文件锁。
7. 测试已改为风险分级：P0 必验；P1 代表性覆盖；P2 文档化，不再以测试总数为 KPI。
8. 浏览器只提供只读 Overview GET；写 transport 的 CSRF/Origin/approval carrier 延后设计。

## Phase 2 Residual Risks

- Skill action execution journal 为进程内存态；external spawn 后进程崩溃的窗口不能声称跨重启 exactly-once，需人工 reconcile。
- JSON backend 不支持多个独立 writer 同时写同一 root。
- Overview coalesced snapshot 使用共享取消语义，一个 caller 的 abort 可使加入者收到固定 unavailable/cancelled view。
- 浏览器 POST/approve/execute transport 尚未实现；必须先设计 CSRF、Origin、body limit 与 local/LAN trust boundary。
- Manual OAuth two-step transient callback channel尚未进入浏览器 UI。
- Sidebar status badge仍是轻量 placeholder，真实 Overview 状态目前在 Settings 页面。

## Phase 3 建议顺序

1. Workspace binding 与 environment/tenant 约束。
2. 只读 iComposer asset catalog、metadata/source fingerprint、reload preview。
3. SDK/utility 查询与 verify。
4. Agent read-only tools 和 UI cards。
5. 在写 transport 安全设计完成前，继续禁止浏览器直接触发 Host 副作用。

## 发布与分支

完成四角色 handoff、终次 verifier gate、secret scan 后发布 `main`。确认本地与远端 release HEAD 一致、worktree clean 后，从 release HEAD 创建并切换本地 `muse`；若已存在必须停止上报，默认不 push `muse`。
