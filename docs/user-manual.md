# iComposer Workbench 用户手册

> 版本：POC（Phase 1–7 完成） · 分支 `muse` · Harness 基线 `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`
> 更新日期：2026-08-22

---

## 目录

1. [产品概述](#1-产品概述)
2. [系统架构](#2-系统架构)
3. [安装与准备](#3-安装与准备)
4. [快速开始](#4-快速开始)
5. [功能模块详解](#5-功能模块详解)
   - 5.1 InsureMO 设置与管理（insuremo-service）
   - 5.2 工作区绑定（workspace-binding）
   - 5.3 资产目录（icomposer-catalog）
   - 5.4 SDK/工具书索引（icomposer-reference）
   - 5.5 生命周期预览（icomposer-lifecycle）
   - 5.6 本地校验（icomposer-verify）
   - 5.7 iComposer Code Intelligence（代码智能）
   - 5.8 写闭环（icomposer-write）
   - 5.10 操作日志与审批（workbench-operation-log）
   - 5.11 界面插件（ui-*）
6. [Agent 工具参考（8 个本地工具）](#6-agent-工具参考)
7. [Workbench API 命令参考](#7-workbench-api-命令参考)
8. [安全模型](#8-安全模型)
9. [测试与验证](#9-测试与验证)
10. [已知限制与未验证能力](#10-已知限制与未验证能力)
11. [故障排查](#11-故障排查)

---

## 1. 产品概述

iComposer Workbench 是运行在 **DeepSeek Harness** 之上的插件化工作台，为 InsureMO/iComposer 开发者提供：

- **环境管理**：IMO CLI 探测/升级、认证 Profile 管理、Skills 安装与启用；
- **项目接入**：将本地 iComposer 项目目录绑定为 Workspace（environment + tenant + auth profile 三元身份）；
- **只读理解**：资产目录扫描、SDK/工具书索引、init/reload 预览、本地校验；
- **代码智能（iComposer Code Intelligence）**：纯 TypeScript 实现的依赖图构建、API 调用链查询、影响分析、语义检索、业务解释；
- **写闭环**：审批门控的 push / test / release / create / metadata，全部留有 digest 凭据（receipt）；
- **审批与证据**：所有高风险副作用必须经操作日志审批后才执行，结果以 SHA-256 摘要记录。

**设计原则**：不修改 Harness 核心；所有 IMO 子进程经 `ctx.subprocess`；token 不落盘不出闭包；原始输出只以 digest 形式跨越公共边界；每个生产/测试文件 ≤500 行。

---

## 2. 系统架构

```text
┌────────────────────────────────────────────────────────────┐
│                     Harness（固定 99f6f02）                  │
│   subprocess · storageDomain · workspaceRegistry · jobs ·   │
│   skills · webServer · tools · sessionPersistence           │
└───────────────▲────────────────────────────────────────────┘
                │ 插件注入（13 个 workbench 插件行）
┌───────────────┴────────────────────────────────────────────┐
│                    iComposer Workbench                      │
│                                                            │
│  insuremo-service        IMO CLI / 升级 / Auth / Skills     │
│  workspace-binding       目录 ↔ env/tenant 身份绑定          │
│  icomposer-catalog       .metadata + groovy 资产扫描         │
│  icomposer-reference     SDK swagger / 工具书 md 索引         │
│  icomposer-lifecycle     init dry-run / reload 本地推演       │
│  icomposer-verify        verify utils 校验 + Agent 工具集    │
│  icomposer-code-         图构建 / 查询 / 语义检索 / 解释 /    │
│    intelligence          后台 job / 诊断 / 清理              │
│  icomposer-write         push/test/release/create/metadata  │
│  workbench-operation-log 审批流与 receipt 存储               │
│  workbench-contracts     全部命令的 zod 契约（62 schemas）   │
│  ui-insuremo-settings    Settings > InsureMO 页面           │
│  ui-insuremo-status      侧栏状态徽标                        │
│  ui-workbench-jobs       会话内 Job 卡片                     │
└────────────────────────────────────────────────────────────┘
```

**数据存放**：

| 数据 | 位置 |
|---|---|
| 绑定/操作日志/激活状态元数据 | `<DSH_HOME>/storages/`（JSON 域存储） |
| ICI 图快照与向量 | `<workspace>/.metadata/icomposer/ici/graph/`（旧 `<DSH_HOME>/ici/<16hex>/graph/` 仅只读回退） |
| 写闭环证据 artifact | `<DSH_HOME>/write/<16hex>/artifacts/` |
| 真实 `~/.dsh` `~/.insuremo` | 测试时永不触碰（隔离 DSH_HOME） |

---

## 3. 安装与准备

### 3.1 前置条件

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- **DeepSeek Harness**（两种形态任选其一，见 3.1.1）
- IMO CLI（`/opt/homebrew/bin/imo`，当前 0.2.17）——只读功能必需，写闭环需有效认证 Profile

#### 3.1.1 获取 `dsh` 命令（二选一）

**途径 A：官方 npm 包（Harness 发布后可用）**

```sh
npm install -g @deepseek-ai/dsh
dsh --help   # 开箱即有全局命令
```

**途径 B：源码检出 + 本地 link（当前可用）** —— Harness 尚未发布 npm 包，或你需要固定特定 commit 时：

```sh
# 1. 克隆 Harness 并固定到验证过的基线
git clone <harness-url> ~/deepseek-harness
git -C ~/deepseek-harness checkout 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca

# 2. 构建全部包（含 apps/cli 的 lib/bin.js——源码检出默认没有这个产物）
cd ~/deepseek-harness
pnpm install
pnpm run build

# 3. 把 dsh 挂到全局 PATH
cd apps/cli
npm link          # macOS/Linux 产出 /usr/local/bin/dsh 或 /opt/homebrew/bin/dsh
```

验证：`which dsh` 有输出、`dsh --help` 正常。

> 注意：不构建直接 `npm link` 会因 `lib/bin.js` 不存在而失败；仅开发调试时可在
> harness 根目录用 `pnpm dsh ...`（tsx 直跑源码），但它不提供全局命令。
> Harness 升级到新 commit 后需重跑 `pnpm run build`（link 一次即可）。

### 3.2 开发态安装（源码仓库）

面向从源码开发/调试 Workbench 的用户（最终用户直接看 3.3）：

```sh
# 1. 克隆并固定 Harness（同 3.1.1 途径 B）
git clone <harness-url> ../deepseek-harness
git -C ../deepseek-harness checkout 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca

# 2. 安装 Workbench 依赖
cd icomposer-workbench
pnpm install

# 3. 健康检查（Harness 版本 / Node / pnpm 校验）
pnpm check
pnpm typecheck
pnpm test          # 325/325 期望全绿
```

### 3.3 标准插件安装（分发形态，面向最终用户）

Workbench 以标准 dsh 插件包 `@icomposer/workbench` 分发（源码位于
`packages/icomposer-workbench-dist`），三种安装方式：

**方式一：tarball 本地分发（推荐）** —— 拿到打包产物 tgz 后安装，全程
不需要 npm registry：

```sh
dsh plugin --profile web add icomposer-workbench-0.1.0.tgz
```

tgz 内已预构建 `lib/`（纯 JS），安装不触发构建。**tarball 是推荐形
态**：npm 打包的 tar 会在 profile node_modules 实体落盘，`@deepseek-ai/*`
peer 沿祖先链可被 dsh loader 解析。目录式 `add .` 为 link: 安装，bare
import 解析依赖周围 node_modules 布局（曾实测 `ERR_MODULE_NOT_FOUND`），
仅当该目录自身可解析 harness 包时可用；请统一使用 tgz。

**方式二：GitHub 路径**：

```sh
dsh plugin --profile web add github:<org>/insuremo-dsh#path:packages/icomposer-workbench-dist
```

**方式三：npm（未来发布）**：`dsh plugin --profile web add @icomposer/workbench`。

安装后校验：`dsh --profile web --dump-config` 应出现
`@icomposer/workbench` 层（inject 七项并集）。移除：
`dsh plugin --profile web remove @icomposer/workbench`。

维护者打包与验证：

```sh
node scripts/pack-dist.mjs             # 产出 dist-release/icomposer-workbench-<ver>.tgz（自包含）
node scripts/verify-standard-install.mjs # 场景验证（repo 路径/tgz，均含真实 boot 冒烟）
```

### 3.4 组合本地 profile（开发态，隔离运行）

> 开发态专用：以 `file:` 源码方式组合 profile（见 `scripts/setup-profile.mjs`）。
> 最终用户请使用 §3.3 的标准插件安装。

```sh
# 写入 .dsh-home/（自动拒绝真实 ~/.dsh）
pnpm run setup-profile

# 从 Harness 根 dump 组合结果：期望 13 个 workbench 插件行
cd ../deepseek-harness
DSH_HOME=../icomposer-workbench/.dsh-home pnpm dsh --profile icomposer-web --dump-config
```

---

## 4. 快速开始

一条真实项目的只读体验链（以 `/Users/junjie.zhang/skills/ssapocpa` 为例）：

```text
1. 在 Harness 中注册工作目录        → ctx.workspaceRegistry.create(path)
2. 绑定 environment/tenant 身份     → ctx.workspaceBinding.bind({...})
3. 扫描资产目录                     → ctx.icomposerCatalog.listAssets({...})   # 459 资产
4. 构建代码图                       → ici_build 工具（4502 节点 / 10308 边）
5. 查 API 调用链 / 影响分析          → ici_query 工具
6. 语义检索                         → ici_search 工具（先 ici_build 的 search-index 模式）
7. 业务解释上下文                    → ici_explain 工具
8. 状态诊断 / 清理                   → ici_status 工具
```

端到端自动回归：`packages/icomposer-workbench-e2e/runner.mts`（10 步默认 + 12 步 `--stability`）。

---

## 5. 功能模块详解

### 5.1 InsureMO 设置与管理（`@icomposer/insuremo-service`）

**面向接口**：`ctx.imoCli` / `ctx.imoUpgrade` / `ctx.imoSkills` / `ctx.imoSkillActivation` / `ctx.imoSkillActions` / `ctx.imoAuth` / `ctx.imoAuthActions` / `ctx.imoOverview`

| 能力 | 说明 |
|---|---|
| CLI 探测 | `probe()/version()/upgradeCheck()`——只读，stdout 只返回 digest |
| IMO 升级 | 审批门控闭环：request → approve → execute（单实例锁 + 7 项 smoke + digest receipt；失败给出恢复命令，绝不自动降级） |
| Skills 清单 | 只读 `list/validate`；路径 containment 防逃逸 |
| Skill 启用门控 | 安装 ≠ 启用；已有 Skill 首次自动采纳，新装默认禁用 |
| Skill 写动作 | install/update/remove/activation 均审批门控；执行日志保证外部命令至多执行一次；部分失败有 best-effort 恢复 |
| Auth | Profile 列表/校验为只读脱敏视图；`prepare()` 产生**不透明可撤销 lease**，token 只在 `use()` 回调内可见；401 自动失效缓存 |
| Auth 动作 | portal 登录 / remote profile 创建 / 默认 Profile 切换——全部审批门控 + canonical 参数 digest |
| Overview | `GET /api/icomposer-workbench/insuremo/overview` 聚合 IMO/Auth/Skills/Operations 诊断（严格 allowlist、no-store、无 CORS、无浏览器写端点） |

### 5.2 工作区绑定（`@icomposer/workspace-binding`）

**面向接口**：`ctx.workspaceBinding.list/get/bind/unbind`

- 只接收已有 `workspaceId`（Harness `workspaceRegistry` 权威管理 canonical path / symlink 归一 / 目录注册）；
- 绑定身份 = `environmentId + tenantCode + authProfile`（三者必填；**同目录禁止绑定不同 env/tenant**——`binding-conflict`）；
- `expectedRevision` CAS：首绑 0→1；并发写仅一方成功；
- orphan（Harness 侧已删）同路径阻止新绑定（`path-already-bound`），须显式 unbind；
- unbind 只删绑定记录，不删源码/目录/Session。

### 5.3 资产目录（`@icomposer/icomposer-catalog`）

**面向接口**：`ctx.icomposerCatalog.listAssets({workspaceId, type?})`

- 扫描 `.metadata/{api,function,batch,model}` + `src/dev/**` groovy（batch 支持嵌套 `batch.metadata.json` 布局）；
- 五态 join：`clean / local-modified / no-server-md5 / source-missing / metadata-missing`（本地 md5 与服务器 Md5Value 比对）；
- 防护：realpath containment、256KB JSON 上限、2MB groovy 上限、5000 资产截断、损坏条目标记不中断；
- 真实项目实测：api=236 / function=209 / batch=11 / model=3。

### 5.4 SDK/工具书索引（`@icomposer/icomposer-reference`）

**面向接口**：`ctx.icomposerReference.listSdkClients / querySdkOperations / listUtilities / queryUtilityMethods`

- 实时扫描（无缓存）：`sdk/*/​*_swagger.json`（45 clients / 1389 operations）+ `ref_doc/*.md`（35 utils / 313 methods）；
- keyword 大小写不敏感，client/util 精确过滤，limit 默认 50 上限 200；
- summary/tag 截断至 200 字符；损坏/超限标 `invalid` 不影响整体。

### 5.5 生命周期预览（`@icomposer/icomposer-lifecycle`）

**面向接口**：`ctx.icomposerLifecycle.initPreview / reloadPreview`

- `initPreview`：**真实执行** `imo icomposer init --dry-run --json`（经 auth lease + subprocess；mutating 流程不触发）；支持 `--list-groups` / `--group-id`；输出 groups/plan 的 allowlist 投影；
- `reloadPreview`：**纯本地推演**（零子进程）——报告资产 join 分布（clean 434 / local-modified 3 / no-server-md5 17 / source-missing 5）。真实 reload 属 Phase 5 写闭环。

### 5.6 本地校验（`@icomposer/icomposer-verify`）

**面向接口**：`ctx.icomposerVerify.verifyUtils / listUtils / searchUtils`

- 包装 `imo icomposer verify utils`（文件级校验 / `--list` / `--search`）；
- argv 白名单（拒绝对路径/`..`/非 groovy）；digest-only；
- 本包同时注册全部 **8 个 Agent 工具**（见第 6 节）。

### 5.7 iComposer Code Intelligence（`@icomposer/icomposer-code-intelligence`）

> 纯 TypeScript 实现（用户裁定弃用 Rust 双栈）；Rust 原实现仅作语义参考。

**面向接口**：`ctx.iciEngine` 与 `ctx.iciSearch`。

- 图/查询/维护：`build` · `queryApi` · `queryImpact` · `diagnostics` · `cleanupPlan` · `cleanupApply` · `explainContext` · `explainDeterministic`
- 检索：`index` · `search`

| 能力 | 说明 |
|---|---|
| 图构建 | API→Function→Method 节点 + CALLS/CONTAINS 边 + SDK 平台依赖（inferred 置信度）；`STD_DISCARD` 路径过滤；**三段式原子快照**（current→stale→promote，任何失败保持上一版本）；manifest 含 schemaVersion/engineVersion/sourceFingerprint |
| API 调用链 | `queryApi({query, depth?, focus?, maxNodes?})`：下游树、多起点、focus 子树过滤、cycle/seen 标记、截断边界列表 |
| 影响分析 | `queryImpact({query})`：function/method 反向到 API 层的路径（每条含 hop 链）+ 置信度计数；冗余 method 跳压缩 |
| 语义检索 | `index`（经 auth lease + curl embedding；增量：源未变复用旧向量）+ `search`（cosine top-N）；JSONL 为唯一向量存储 |
| 业务解释 | `ici_explain` 只准备 schema-3 调用链/源码范围并创建 awaiting-input Job；会话中的 keyed toolview 卡片选择 workspace-relative 资料目录（默认 `ref_doc`）、provider/model 与 not-before。资料仅允许 `.md/.txt/.json/.yaml/.yml/.csv/.log`，不支持浏览器上传。到所属 Agent 下一次 idle 后，Host 启动仅有 list/read/submit 三个工具的 fresh Explain Agent；submit 才发布 immutable `finals/<jobId>.json`，随后 `state.json` 最后指向它并点亮第三 Intelligence 图标。 |
| 后台 Job | `ici_build`/`ici_status` 工具：≤50 资产同步返回，>50 走 `ctx.jobs`（kind `ici-build`/`ici-index`）；kill → JobOutcome `killed` 且快照不变；readOutput 增量进度 |
| 诊断 | 索引路径/schema/engine/节点边数/最后构建/stale 判定/必需文件（对照 Rust doctor 语义） |
| 清理 | `cleanupPlan` 只列 `staging-*`/`stale-*` 残留；`cleanupApply` 逐路径复核（防 TOCTOU），仅删计划内生成物 |

真实项目规模：**4502 节点 / 10308 边**；stress：5001 资产 → 10002 节点 2 秒内完成。

### 5.8 写闭环（`@icomposer/icomposer-write`）

**面向接口**：`ctx.icomposerWrite`（pushPreview/pushRequest/pushExecute/pushResolve/pushStatus · testRun/testExecute · releasePreview/releaseRepos/releaseBranches/releaseApply · createOptions/createPreview/createRequest/createExecute · metadataPreview/metadataRequest/metadataExecute）

**统一安全流**：

```text
preview(dry-run) → request(pending + paramsDigest) → 人工 approve
→ execute(检查 approved+pending；one-shot journal 至多执行一次)
→ recordResult(digest receipt + artifactRefs)
```

| 流程 | 要点 |
|---|---|
| **push** | 冲突时**零自动解决**（不带任何 prefer 标志）；`pushResolve(choice)` 三选一：`cancel`（拒绝收尾）/`prefer-local`/`prefer-server`（各自生成**新的审批操作**，批准后才带对应标志重推）——选择全程 receipt 化 |
| **test** | **P0 未推送保护**：目标资产 `local-modified` 时默认阻断（`local-unpushed-changes`）；`overrideUnpushed:true` 例外且写入 receipt；证据 artifact 落 `<DSH_HOME>/write/.../artifacts/`（digest-only，无原始 payload） |
| **release** | `release repo/branch` 只读列表；apply 先 dry-run 预览；receipt 与 push **完全独立**（kind 隔离，双向拒绝交叉执行） |
| **create** | live options 枚举（动态合法值）→ dry-run 预览 → 审批执行 → **catalog 重扫验证**新资产真实出现（未找到则 `catalogVerified:false`，不做假证据） |
| **metadata** | 至少一个字段（status/description/sse/integration/funcScope）否则零 spawn；`fieldsApplied` 记录进 receipt |

超时/中断语义：spawn 后结果不确定 → `outcome-unknown`，**永不自动重跑**。

### 5.10 操作日志与审批（`@icomposer/workbench-operation-log`）

**面向接口**：`ctx.operationLog.append/list/decide/recordResult`

- `pending → approved | rejected` 单向决策流；
- 记录只含 digest/引用/决策元数据（绝不存请求原文或凭据）；
- 被 upgrade/skills/auth/push/test/release/create/metadata 全部高风险面共用。

### 5.11 界面插件

| 插件 | 位置 | 说明 |
|---|---|---|
| `ui-insuremo-settings` | Settings > InsureMO | Overview/Auth/Skills/Diagnostics 面板；同源 GET overview 桥；zh/en；无浏览器写端点（CSRF/Origin 设计 deferred） |
| `ui-insuremo-status` | 侧栏底栏 | InsureMO 状态徽标（轻量占位） |
| `ui-workbench-jobs` | 会话节点 | Harness JobView 的只读投影卡片 |

---

## 6. Agent 工具参考

以下 10 个工具全部注册进 Harness `ctx.tools`，**不写源文件/凭据、并发安全、canonical JSON 输出**（Agent 可直接调用）；`ici_build`/索引和 `ici_explain` 会写 workspace-local ICI artifacts。

| 工具 | 参数 | 功能 |
|---|---|---|
| `icomposer_catalog_list` | `{workspace_id, type?}` | 资产目录（counts + entries≤50 + truncated） |
| `icomposer_sdk_query` | `{workspace_id, client?, keyword?, limit?}` | SDK operation 检索 |
| `icomposer_verify_utils` | `{workspace_id, keyword?}` | 工具类检索（verify utils --search） |
| `ici_query` | `{workspace_id, mode: api-chain\|impact, query, depth?, max_nodes?}` | 调用链树 / 影响路径 |
| `ici_search` | `{workspace_id, query, mode?, top?}` | 语义检索 top-N |
| `ici_build` | `{workspace_id, mode?: graph\|search-index, rebuild?}` | 构建图/索引（≤50 资产同步；>50 后台 job 返回 jobId） |
| `ici_status` | `{workspace_id}` | 图/索引诊断（版本/计数/stale/必需文件） |
| `ici_explain` | `{workspace_id, query}` | 只准备 schema-3 完整调用链与源码范围并创建 awaiting-input Job；不调用模型、不点亮状态 |
| `ici_explain_list/read/submit` | 仅 fresh Explain Agent 内部可见 | 受限目录浏览、文本读取、严格 aggregate submit；不注册到主 Agent 工具面 |

Host routes：`GET .../jobs/:jobId/status` / `GET .../jobs/:jobId/folder?path=...`；卡片通过 `POST .../confirm|cancel|retry` 完成确认、取消和重试。

**不在工具面**（需审批流，走 Host face）：push/test/release/create/metadata/skill 写动作/升级。

---

## 7. Workbench API 命令参考

`@icomposer/workbench-contracts` 定义全部命令契约（zod strict，可生成 JSON Schema，共 62 schemas）。命令清单：

```text
system/capabilities

workspace/list · workspace/inspect · workspace/bind · workspace/unbind

insuremo/version · insuremo/check-upgrade · insuremo/apply-upgrade
insuremo/skills-list · insuremo/skills-check · insuremo/skills-install
insuremo/skills-upgrade · insuremo/skills-remove
insuremo/auth-profiles · insuremo/auth-login · insuremo/auth-remote
insuremo/auth-validate

icomposer/list-assets · icomposer/sdk-list · icomposer/sdk-query
icomposer/util-list · icomposer/util-query
icomposer/init-preview · icomposer/reload-preview
icomposer/verify-utils · icomposer/utils-list · icomposer/utils-search

ici/build · ici/build-job · ici/status
ici/query-api · ici/query-impact
ici/search-index · ici/search
ici/explain-context · ici/explain-deterministic
ici/cleanup-plan · ici/cleanup-apply

icomposer-write/push-preview · push-request · push-execute · push-resolve · push-status
icomposer-write/test-run
icomposer-write/release-preview · release-repos · release-branches · release-apply
icomposer-write/create-options · create-preview · create-execute
icomposer-write/metadata-preview · metadata-execute


operation/record · operation/list · operation/decide
```

约定：请求带 `requestId + schemaVersion`；Host face 返回 service 视图（无 transport 字段）；错误为 closed union（未知 code 固定 fallback，无 raw cause）。

---

## 8. 安全模型

| 原则 | 实现 |
|---|---|
| 审批优先 | 任何 spawn 前必须 operation `approved`；未审批零子进程 |
| 外部写至多一次 | 进程内执行日志分离 external/evidence；重试只补证据 |
| 结果不确定不重跑 | 超时/中断 → `outcome-unknown`，永不自动重试 |
| Token 边界 | 只存在于 IMO profile store 或 Host 内存 lease 回调；HTTP/DOM/事件/receipt/日志零出现 |
| Digest-only | stdout/stderr 只以 sha256 摘要跨越公共边界；原始输出不落盘 |
| 路径安全 | realpath containment；argv 白名单；拒绝对路径/`..`/`-k/--insecure` |
| 隔离 | 测试/e2e 全部使用隔离 `DSH_HOME`；真实 `~/.dsh` `~/.insuremo` 快照校验不变 |
| 诚实证据 | catalog 重扫三态（未找到=false）；POC 门槛文档显式列 8 项未验证能力 |

---

## 9. 测试与验证

```sh
pnpm install --frozen-lockfile   # 依赖完整性
pnpm check                       # Harness/Node/pnpm 兼容校验
pnpm typecheck                   # 15 包
pnpm test                        # 325/325（unit + contract + UI）

# 端到端（隔离 DSH_HOME）
cd packages/icomposer-workbench-e2e
node --import tsx runner.mts                 # 10 步
node --import tsx runner.mts --stability     # 12 步（含 5001 资产 + SIGKILL 快照保护）

# 审计
node scripts/audit-compat.mjs    # 20 项兼容检查 → docs/compat-audit.json
node scripts/audit-secrets.mjs   # 全仓脱敏扫描（token 形状/canary/路径白名单）
```

测试分层（风险分级策略）：P0（审批门/泄漏/重复写/隔离）必验阻塞；P1 代表性覆盖；P2 文档化不阻塞。

---

## 10. 已知限制与未验证能力

**显式未验证（诚实清单，见 `docs/poc-readiness.md`）**：

1. 真实 push / test / release / create / metadata 远端写——全部只做了 fake/dry-run 验证，真实执行需 `[REAL_RUN]` 授权；
2. 真实 push 冲突样本——冲突解析基于 CLI 二进制词表 + 防御性多形状 parser；
3. 多进程 multi-writer——JSON 存储单写者约束，不支持多 Host 并发写同一 root；
4. GPUI 客户端——Phase 8 另行立项；
5. 真实 Harness 升级演练——以只读审计 + 回滚预案替代（checkout 99f6f02 即恢复）；
6. 浏览器写 transport——CSRF/Origin 设计 deferred，Web 侧仅只读 GET 桥；
7. `verify utils` CLI 会在 workspace `.metadata/icomposer/` 写缓存（CLI 正常行为，已按用户裁定接受）；
8. ICI Explain 在单进程内串行 prepare/final/cancel 并在 submit 前重哈希资料；同一 OS 用户的其他进程仍可并发修改 workspace（TOCTOU 不在 MVP 的 `openat` 威胁模型内）；

**P2 残余**：README 含开发者机器绝对路径（待通用化）；`ici/service.ts` 恰 500 行贴限；并行真实 smoke 偶发超时（隔离重跑即过）；进程内 journal 重启后 conflict resolution 返回安全侧错误（需人工 reconcile）。

---

## 11. 故障排查

| 症状 | 排查 |
|---|---|
| `workspace-not-bound` | 先 `bind`；`list()` 查看 `binding:null` 的未绑工作区 |
| `path-already-bound` | 旧 workspace 记录残留——按提示 unbind 旧 ID 后重绑 |
| `no-snapshot` / `stale:true` | 先 `ici_build`；stale 表示源已变，建议重建 |
| `no-index` | 先 `ici_build {mode:"search-index"}` |
| `not-approved` | 正常安全行为——去 operationLog 审批后再 execute |
| `already-executed` | one-shot 保护——重试只读证据，不会重跑 |
| `outcome-unknown` | 子进程已启动但结果不明——**不要**自动重试，人工核实远端状态 |
| `local-unpushed-changes` | test 前先 push，或带 `overrideUnpushed:true`（会记入 receipt） |
| `conflict` (push) | 调 `pushResolve`：cancel / prefer-local / prefer-server（后两者各自需要新审批） |
| `binding-conflict` | 同目录已有其他 env/tenant 身份——换目录/worktree 或先 unbind |
| `storage-error` | 检查 DSH_HOME 可写性；digest 校验失败（文件被外部改动）也走此码 |
| IMO 401 | `imo auth login --env <env> --force` 后重新 prepare |

---

## 附：提交历史（muse 分支，Phase 3–7）

```text
677bd45 chore(e2e): add poc end-to-end regression, audits and readiness gate [TASK-033]
cba29ba feat(write): add create and metadata loops with catalog-verified receipts [TASK-030]
680d4eb feat(write): add test evidence and release loop with independent receipts [TASK-029]
2d65242 feat(write): add approval-gated icomposer push with conflict resolution chain [TASK-028]
9b500a3 feat(ici): add business explain context bundle and deterministic mode [TASK-027]
ba4b703 feat(ici): add background jobs, diagnostics and cleanup [TASK-026]
e5436e2 feat(ici): add semantic search with jsonl embeddings [TASK-025]
872bfe6 feat(ici): add api chain and impact queries with ici_query tool [TASK-024]
689f0e0 feat(ici): add pure-typescript graph build core [TASK-023]
ad58d0d feat(verify): add read-only verify utils service and agent tools [TASK-022]
0756dea feat(lifecycle): add read-only init and reload previews [TASK-021]
3a1a949 feat(reference): add read-only sdk and utility reference indexes [TASK-020]
4aa748b feat(catalog): add read-only icomposer asset catalog [TASK-019]
70213b7 feat(workspace): add durable workspace binding overlay [TASK-018]
81dbc1e docs: add Phase 2 handoff and release guide [TASK-017]
128d28e feat(ui): add read-only InsureMO overview and diagnostics bridge [TASK-016]
（更早见 git log）
```

> 本手册对应 POC 完成态。后续 `[REAL_RUN]` 授权执行与推送发布将按既定流程另行记录。
