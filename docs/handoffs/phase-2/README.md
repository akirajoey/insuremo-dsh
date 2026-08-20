# Phase 2 Handoffs — README

Phase 2（InsureMO 设置与工具链，TASK-008～016）四角色交接。功能代码与本文档均处于本地未发布状态；本 README 指向各角色 handoff 并记录发布前置事实。

## 基线

- Phase 2 functional HEAD：`128d28e1a3e7786895116061eb9ea460565ed58d`（本地 `main`）。
- Harness 基线：`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`（未修改 Harness core，发布不包含 Harness）。
- Phase 2 发布前远端 `origin/main` 仍为 Phase 1 `cd4207ce03e70631fed9811a1dd5038e1c753e77`。

## 角色 handoff

| 文件 | 作者职责 |
| --- | --- |
| [planner.md](planner.md) | 阶段结果、TASK-008～016 提交、关键决策、Residual risks、Phase 3 顺序、发布与 `muse` 分支策略 |
| [developer.md](developer.md) | 模块/服务图、apply/inject 顺序、关键文件、运行/测试/真实 smoke、TASK-015/016 扩展接口、≤500 行规则、技术限制 |
| [verifier.md](verifier.md) | P0 安全不变量、验收摘要、最小回归、真实 smoke 边界、hygiene 门禁、风险分级 |
| [version-maintainer.md](version-maintainer.md) | functional commit 链、handoff 时快照、release preflight、push 流程、`muse` 创建规则 |

## Residual risks（详见各 handoff）

- 浏览器写 transport（POST/approve/execute）尚未实现；CSRF、Origin、body limit 与 LAN trust boundary 延后设计。
- Skill action execution journal 为进程内存态；external spawn 后 hard crash 窗口不具备跨重启 exactly-once，需人工 reconcile。
- JSON storage 为 Harness 官方 single-host/single-writer 约束；独立 backend 同 root 的 multi-writer 不受支持。
- Overview coalesced snapshot 使用共享取消语义，加入者可能收到固定降级 section。
- Sidebar status badge 仍为轻量 placeholder；真实 Overview 状态目前在 Settings 页面。

## 发布与 `muse`

- 最终 release HEAD = 提交 handoff docs 后的 commit（在发布执行时动态读取，不得硬编码为 functional HEAD）。
- 发布前必须先完成 verifier 终检与 secret scan；确认本地与远端 release HEAD 一致、worktree clean 后发布。
- 发布后从 release HEAD 创建并切换本地 `muse`；若 `muse` 已存在（本地或远端）必须停止上报，默认不 push `muse`。

## 保密约束

本文档集合不包含任何本机凭据、profile 值、真实 home hash 或 raw CLI 输出。
