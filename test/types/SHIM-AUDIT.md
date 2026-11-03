# TASK-167a shim audit

**本卡未删除任何 `harness-shims.d.ts`，也未声称插件类型合规。** 本文件只记录逐份评估证据与后续归属。

## 方法

对每个包：把 `src` 与 `package.json` 复制到临时 `/tmp` 工程，**删除该包的 `harness-shims.d.ts`**，用 rc.2 的**发布声明**（`@deepseek-ai/*` tgz，`cordis@4.0.5`、`schemastery@3.18.5`）以 `strict` 编译；`jsx: react-jsx`、`skipLibCheck: true`；仅 `@icomposer/*` 兄弟源码做路径映射。rc.2/rc.5 的声明文件在本审计涉及面上等价（`test/types/run.mjs` 两版分别编译验证）。审计脚本为一次性隔离探针，未入库；契约门禁本身由 `run.mjs` 复跑。

结论标记：**可替换** = 0 诊断，真实声明可直接编译该包源码；**需改业务源码** = 真实声明拒绝当前源码，删 shim 必须先改源码（超出 167a 范围）。

## 逐份结果

| 包 | shim 覆盖模块面 | rc.2 / rc.5 真实声明可得性 | 删 shim 后诊断数 | 首条诊断摘要 | 结论 | 对应契约测试位置 |
|---|---|---|---|---|---|---|
| `workspace-binding` | cordis、dsh-workspace、dsh-storage-domain | 全部可得（rc.2/rc.5 均有 `lib/types`） | 0 | — | 可替换（TASK-171 连同 devDeps 删除） | `contract.ts` `hostFaces`（workspaces/domains）、`ContractService` |
| `icomposer-catalog` | cordis、dsh-workspace | 全部可得 | 0 | — | 可替换（TASK-171） | `contract.ts` `ContractService`、`hostFaces.workspaces` |
| `icomposer-reference` | cordis、dsh-workspace | 全部可得 | 0 | — | 可替换（TASK-171） | `contract.ts` `ContractService`、`hostFaces.workspaces` |
| `workbench-operation-log` | dsh-storage-domain | 可得 | 0 | — | 可替换（TASK-171） | `contract.ts` `hostFaces.domains` |
| `icomposer-lifecycle` | cordis、dsh-workspace、dsh-subprocess | 全部可得 | 1 | `src/index.ts(35,41) TS2345`：`config: unknown` 传给 typed plugin config | 需改业务源码（TASK-172） | `contract.ts` `ContractService`、`hostFaces.subprocess` |
| `icomposer-write` | cordis、dsh-subprocess | 全部可得 | 1 | `src/index.ts(114,37) TS2345`：同类 `config: unknown` | 需改业务源码（TASK-172） | 同上 |
| `icomposer-code-intelligence` | cordis、dsh-workspace、dsh-native-command、dsh-subprocess、dsh-jobs、dsh-storage-domain | 全部可得 | 1 | `src/service.ts(55,16) TS2664`：`declare module "@deepseek-ai/dsh-jobs"` 找不到模块（源码只 import `/view`） | 需改业务源码（TASK-172） | `contract.ts` `hostFaces.jobs`、`ContractSurfaces.jobSpec/jobView/nativeCommand` |
| `icomposer-verify` | cordis、dsh-workspace、dsh-jobs、dsh-llm、dsh-tools、dsh-subprocess | 全部可得 | 12 | `src/ici-explain-tools.ts(121,28) TS2345`：本地 `DefineToolFn` 返回 `unknown`，非 `ToolDefinition` | 需改业务源码（TASK-172） | `contract.ts` `ContractSurfaces.tool`、`ContractService.section`、`hostFaces.jobs/subprocess` |
| `ui-insuremo-settings` | dsh-client-ui-slots、cordis、locale/client、settings/client | 全部可得 | 3 | `src/client/index.ts(32,32) TS2345`：`ctx.slots` 增强在 `dsh-client-ui-renderer/client`，源码未 import | 需改业务源码（TASK-172） | `contract.ts` `clientFaces`（slots/locale） |
| `ui-workbench-jobs` | slots、cordis、locale/client、chat/client、primitives、jobs/view | 全部可得 | 4 | `src/client/index.ts(40,7) TS2339`：`ctx.slots` 不存在（同一增强缺口） | 需改业务源码（TASK-172） | `contract.ts` `clientFaces`、`ContractSurfaces.chat/jobView/primitive` |
| `ui-insuremo-status` | slots、cordis、locale/client、sidebar/client、primitives、session/client、`*.png` | 全部可得（`*.png` 非包 API） | 17 | `src/client/BrandChrome.tsx(3,29) TS2307`：本地 `*.png` 资产声明缺失（另有 `ctx.slots` 缺口） | 需改业务源码（TASK-172；`*.png` 属本地资产类型，保留） | `contract.ts` `clientFaces`、`ContractSurfaces.sessions/primitive` |
| `insuremo-service` | cordis、schemastery、dsh-skill、dsh-storage-domain、dsh-subprocess、dsh-llm | 全部可得 | 72 | `src/active-profile.ts(68,5) TS2740`：真实 `Service`/`Context` 泛型下 `{}` 缺 `ImoAuth` 成员 | 需改业务源码（TASK-172） | `contract.ts` `ContractService`、`contractSchema`、`hostFaces.subprocess/domains/llm`、`ContractSurfaces.skill` |
| `icomposer-workbench-dist` | cordis、dsh-workspace、dsh-jobs、dsh-skill、dsh-storage、dsh-tools、schemastery、primitives | 全部可得 | 132（含聚合的兄弟源码诊断） | 自身首条 `src/index.ts(100,17) TS2339`：`ctx.webServer` 未增强（`dsh-host-webserver` 未 import） | 需改业务源码（TASK-172） | 上述全部契约面 |

## 归属

- **4 份可替换** → `TASK-171`：添加真实包 devDeps/锁后删除，并把包级 tsconfig 映射到真实声明；本卡不动。
- **9 份需改业务源码** → `TASK-172`（已拆多卡）：imports/`config` 类型/`DefineToolFn`/`Service` 泛型/`ctx.slots` 增强等；修完后逐包删 shim。
- 在删除前，上述每个模块面都有 `test/types/contract.ts` 的真实声明契约覆盖；没有任何 shim 是唯一证据。
- `*.png` 是插件本地资产声明，不是包 API 的替代，保留。
