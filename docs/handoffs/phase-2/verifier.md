# Phase 2 Verifier Handoff

## P0 安全不变量

1. Raw params、路径、Skill 正文、token 不得进入 public API、HTTP JSON 或 DOM。`paramsDigest` 可以保留在 Host operation log/receipt evidence，但 Overview 与 DOM 不返回。
2. 所有副作用执行前必须验证 operation exists/kind/approved/canonical paramsDigest/pending input/already-executed/busy；失败路径零 spawn。
3. 单进程内 external CLI 最多执行一次。Evidence 写入失败只能重试 `recordResult`，不得重跑 CLI、controller、invalidate 或 event。
4. 外部 attempt 后必须 best-effort after-snapshot、activation reconcile 与 catalog invalidate，避免部分写导致 stale catalog。
5. 所有 argv value 使用窄语法，拒绝 leading option、控制符和空白；project scope 在 Workspace binding 前返回 `workspace-not-bound`。
6. Git source 仅 HTTPS + host allowlist，拒绝 IP、端口、非 allowlist host 与 bare host；userinfo/query/fragment 不进入 canonical provenance。
7. Dispose 后 captured face/controller/action 返回固定 disposed/cancelled 结果，零 storage/event/revision；owned domain close once。
8. Root 不导出 controller、mutator、WeakMap、journal、recovery 或 provider lifecycle；公开 face 均冻结且只含声明的方法。
9. Overview HTTP bridge 只允许 GET/HEAD，其他方法 405；`no-store`、`nosniff`、无 CORS、body bounded；无浏览器写 route。
10. Auth token 仅存在于 IMO profile store 或 Host 内存 lease callback；receipt、event、日志、inspect/reflection 不得包含 token。

## TASK-008～016 验收摘要

- TASK-008 `4046a4a`：IMO 只读 probe/version/upgrade-check，digest-only。
- TASK-009 `0cf37a9`：Upgrade 审批闭环；用户授权的真实升级 0.2.14→0.2.17 与 7/7 smoke PASS。
- TASK-010 `c81b990`：Skills inventory、路径 containment、frontmatter 安全。
- TASK-011 `a6e3807`：Auth lease/cache、URL 脱敏、runner raw/cause 边界、模块化。
- TASK-012 `08f0f32`：Auth actions approval、environment provenance、严格 argv。
- TASK-013 `e64988a`：真实 Harness SkillProvider、cancellation、catalog refresh。
- TASK-014 `c8e231c`：Durable activation gate、list/get 线性化、lifecycle FINAL PASS。
- TASK-015 `ab69990`：Skills mutations、execution journal、partial recovery、source provenance。
- TASK-016 `128d28e`：只读 Overview service/GET route/Settings UI，已提交。

## 推荐最小回归

```bash
cd /Users/junjie.zhang/dsh/icomposer-workbench
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck
pnpm test
```

定向修改 Skills/Activation/Overview 时，优先运行对应 package test；UI 使用：

```bash
pnpm --filter @icomposer/ui-insuremo-settings test
```

不修改 Harness core 时无需每次执行完整 Harness test；只需确认 Harness HEAD、clean status 与 critical diff。

## 真实 smoke 边界

默认仅允许已批准的只读命令，例如 IMO version/help、global Skills inventory 和脱敏 profile count。禁止在无 `[REAL_RUN]` 授权时运行 upgrade、Skills install/remove/update、auth prepare/login/remote/default set。每次真实探针前后对比 `.dsh`、`.insuremo`、`.agents/skills` 文件集与 mtime 快照完全一致，不在文档固化用户环境 hash。

## Hygiene 门禁

- Harness HEAD 必须为 `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca` 且 worktree clean。
- Workbench `git diff --check` 通过、scope 与声明一致。
- 对最终变更集运行配置化 secret scan；测试 canary 可以存在，但不得出现真实凭据。
- 不保留临时 runner、operation log、Skill body 或 token 日志。

## 风险分级

- P0：审批门、secret/raw 泄漏、重复外部写、真实 home/Harness 污染——阻塞发布。
- P1：activation/revision correctness、provenance、recovery、cache 一致性——代表性验证，失败阻塞。
- P2：unsupported multiwriter、穷举反射/排列、极端 churn、跨 crash exactly-once——记录 residual，不阻塞 POC。

## Residual risks

- Execution journal 是进程内状态；external spawn 后 hard crash 的窗口不具备跨重启 exactly-once。
- 两个独立 JsonStorageBackend 指向同一 root 不支持 CAS，部署必须遵守 single-host/single-writer。
- 浏览器 POST/approve/execute transport 尚未实现；需要 CSRF、Origin、body limit 和 LAN trust 设计。
- Overview coalesced snapshot 使用共享取消语义，加入者可能收到固定降级 section。
- UI narrow parser 有 bounds，但未做畸形 payload 穷举 fuzz。

本文不包含 profile 值、token、Skill 正文或 raw CLI 输出。
