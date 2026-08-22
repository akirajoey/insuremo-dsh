# @icomposer/icomposer-workbench-e2e

POC 端到端回归与稳定性检查（TASK-033）。**不属于 `pnpm test` 的重负载部分**——runner 需要安装隔离 profile（pnpm install），按需手动执行；audit smoke 测试（4 项）在 `pnpm test` 内运行。

## 用法

```bash
pnpm --filter @icomposer/icomposer-workbench-e2e run e2e            # 12 步全链
pnpm --filter @icomposer/icomposer-workbench-e2e run e2e:stability  # + 稳定性两项
node scripts/audit-compat.mjs                                       # 兼容审计（repo 根）
node scripts/audit-secrets.mjs                                      # 脱敏检查（repo 根）
```

## 12 步全链（隔离 DSH_HOME）

1. **profile-composition** — setup-profile 安装 + dump 断言（14 插件行、关键 inject 行、包安装齐）
2. **catalog-scan** — 真实 catalog 服务扫描 fixture 工作区（3 api/2 function）
3. **ici-build** — 真实 ICI 引擎构建（nodes/edges/manifest schemaVersion）
4. **ici-query** — queryApi（SearchPaymentAPI 命中）+ queryImpact（function → api 上游）
5. **ici-search** — fake curl 确定性向量索引 + 余弦搜索（indexed=3, topScore>0）
6. **ici-explain** — explainContext bundle + explainDeterministic 三段
7. **verify-utils** — fake imo 的 verify 投影（valid/classesChecked/digest）
8. **push-preview** — dry-run push（allowlist 投影、无 prefer 标志断言）
9. **intercom-ask-reply** — register/list/ask→waiting/reply→restored 闭环
10. **ici-cleanup** — cleanupPlan/Apply + 诊断干净
11. （--stability）**stability-large-build** — 5001 资产 fixture → 10002 节点 + queryApi maxNodes=1000 truncated
12. （--stability）**stability-kill-mid-build** — 子进程 SIGKILL 中断重建 → current 快照字节完整 + 无 staging 残留

报告：`<DSH_HOME>/e2e-report.json`（每步 {step, ok, durationMs, counts}；任何失败非零退出）。

## 审计脚本

- `scripts/audit-compat.mjs` — Harness HEAD 固定/工作树干净/全部 @deepseek-ai peer 解析到固定 checkout（tsconfig.base 路径或 harness-shims 或包级 tsconfig 路径）/bundle 14 插件依赖齐/lockfile 快照 → `docs/compat-audit.json`
- `scripts/audit-secrets.mjs` — token 形状（JWT/长 Bearer/64+ 串/hex64）/fixture canary 越区/白名单外绝对 home 路径；sha256:/sha512- 设计摘要与 pnpm-lock 完整性豁免；支持传入目录参数

发布门槛映射见 `docs/poc-readiness.md`。
