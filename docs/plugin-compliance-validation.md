# 插件合规报告核验（TASK-160，待独立复核）

> 本文核验 `/Users/junjie.zhang/Downloads/plugin-compliance-report.md`，不是修复方案或验收 PASS。未修改原报告、插件实现、产物、宿主、用户资料或任务板。**能解析/运行、符合公开插件规范、跨版本兼容是三个不同结论。**

## 1. 基线、证据与限制

- **W**：Workbench `release/workbench-0.1.2`，`e87b86190f2f5fb7859eba943c0ddaa3d06976c6`；`compatibility.json:2-12` 锁定 H2、IMO 0.2.37 和发布分支。`packages/icomposer-workbench-dist/package.json:7-10,91-93` 声明 tested-with rc.2，engines 范围包含 rc.5；范围声明不是实际兼容证书。
- **H2**：本机 `../deepseek-harness` 为 `687f282e8625c6b8d11ff58211a90524be2e4317` / 0.2.1-rc.2，git 工作树 clean。以 H2 为唯一现有 checkout，未切换。
- **H5**：上游公开 tag `dsh-v0.2.1-rc.5` 解析为 `b830ec950faba0a46dda564be3e2d854afed94f1`；从该提交的 GitHub codeload tarball 只读解包到 `/tmp/workbench-rc5-validation.8MZjPr/source/deepseek-harness-b830ec950faba0a46dda564be3e2d854afed94f1`。归档 SHA-256 `4281be5574c2eb94d1024d0e165ee24581efc59876e0849610b2dfb0784e5b23`；根 `package.json:2-5` 是 0.2.1-rc.5。它是**上游源码对照**，不是报告的 Windows app.asar 实物，也不是已安装包/现场状态。本文 H5 相对路径均相对于该解包根；临时目录可失效，复现方法见 §7。
- **规范原文**：H2 和 H5 的 `packages/preset/agent-preset/skills/cordis-plugin-development/references/{host-plugin,ui-plugin,practices}.md` 对所引用内容一致。`practices.md:33-36` 禁止外部插件运行时加载 Harness Client 模块、要求 slot/组件内 DOM；`ui-plugin.md:5,9-13` 规定模块表、`shell.overlay` 和宿主 DOM 边界；`host-plugin.md:29-35,51-64` 规定显示资源、导出形态和 Config。不能将宿主内部实现自动当成第三方许可。
- 本机 Mac 的 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 用已存在的 `@electron/asar` 只读提取 `package.json` 和 `dsh/package.json`，两个版本均为 **rc.2**。报告是另一台 **Windows / rc.5**；其安装版本、现场调用输出和 live inspection 原文只作为报告声称，不当作本机实测。
- 评价术语：**成立**＝限定范围证据支持；**部分成立**＝现象/建议的一部分成立，但原表述或推论过强；**不成立**＝有反证；**待证**＝缺少必要现场或运行链证据。`R1`～`R7` 是 §7 可复现命令组。每条中的路径和行号均针对 W 或明确标注的 H2/H5；W 源码行号可能与报告其他机器不同。

## 2. C-01～C-09：原报告“已合规”逐项核验

| ID | 结论、版本及证据（见命令组） | 修正建议 / 证据限制 |
|---|---|---|
| C-01 | **成立**。W `packages/icomposer-workbench-dist/package.json:17-31`、`packages/bundle-icomposer-workbench/package.json:6-16` 均包含 patch export/files 及 `dsh.bundle.patch`（R2）。 | 保留；只核验声明，不代表安装后所有资源可用。 |
| C-02 | **部分成立**。W 两份 `cordis.patch.yml:1-4` / `:1-48` 是 insert，无 override；但 bundle 多行如 `:2-3,41-48` **没有 inject**（R2）。H5 `host-plugin.md:20-27` 的示例也不要求每行均有 inject。 | 修正为“按需声明 inject”，不要把每行必须有 inject 当规范；具体加载/依赖见 V-10。 |
| C-03 | **部分成立**。W 聚合入口 `packages/icomposer-workbench-dist/src/index.ts:39-54,68-70,107` 默认导出 Service；其他子包并非全都符合单一形式，`insuremo-service/src/index.ts:94-97,127-144,181` 混用（V-04）。H5 `host-plugin.md:57-64` 明说不得混用（R2、R4）。 | 不能盖章整个 Host 均合规。**聚合默认类没有 static inject**；H2/H5 loader unwrap 默认类后不会使用 namespace 上的 named `inject`，不能仅看 `:42-54` 判断根 fiber 依赖，见 V-10。独立/聚合能力需分开复测。 |
| C-04 | **部分成立**。报告列的 10 个 Harness 服务名均见 H5 `packages/extensions/tool-cordis/src/api-catalog.ts:225,1018,1362,1427,2773,2978,3120,3415,3679,3911`；`systemPrompt` 也在 `:3152`（R4）。W 两份 patch 还引用 Workbench 自己提供的 `workspaceBinding`、`imoAuth` 等，不能说 patch 的**所有**名字都属于官方 Host Service。 | 名称存在不证明当前 profile 已启用/激活，更不证明运行有效。单独验证 patch、类与子插件实际 inject，尤其遗漏的 systemPrompt。 |
| C-05 | **不成立，全称有反例**。W `packages/insuremo-service/src/overview/route-service.ts:20-28,36-60` 在 `Service.init` 直接注册，把返回的 disposer 收入 `#disposers`，全文件没有调用该数组；H2/H5 `packages/host/webserver/src/index.ts:360-373` 的 `register` 只入 Map 并返回手动删除函数。W `icomposer-verify/src/tool-service.ts:15-25` 也依赖额外内部事件（R2、R5）。 | 示例成立不能推导所有注册都有 effect/释放。路由卸载后遗留/重装冲突是源码支持的**待实测风险**；现环境该模块导入受缺失依赖阻碍，不能声称已观察真实 Host 泄漏。先在隔离宿主验证 routes/handlers、卸载、重装和并发，而非只改注释。 |
| C-06 | **部分成立**。W `insuremo-service/src/index.ts:127-141` 对 `settings` 使用 `ctx.inject`；H5 `practices.md:20` 支持此机制（R2、R4）。 | 这证明**该调用形式**，不是证明所有可选服务的生命周期均正确；loader 默认类路径是否到达该调用须与 aggregate 区分（V-04）。 |
| C-07 | **部分成立**。W 三个 Client 的注册位于 `ui-insuremo-status/src/client/index.ts:49-95`、`ui-insuremo-settings/src/client/index.ts:28-52`、`prefill-slot.tsx:80-90`、`ui-workbench-jobs/src/client/index.ts:38-49`。H5 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:331,824,1069,3251,3537,3570,3643,4854` 有列出的槽（R3、R4）。 | 存在于静态目录不等于当前 profile 中已声明、占用、materialize 或可见；健康点另绕过 slot 改宿主分组行，见 V-02。 |
| C-08 | **成立，限服务名静态存在**。W 三个 client `index.ts` 的 inject 分别为 `slots/locale`、`slots/locale/workspaces/uiWorkspace`、`slots/locale/sessions`；H5 `packages/extensions/cordis-client-runner/src/client/api-catalog.ts:119,181,237,334,398` 均有相应目录项（R3、R4）。 | 不等于 profile 实际激活、方法可满足具体业务或客户端成功渲染。 |
| C-09 | **部分成立**。W dist `package.json:32-46` 为 web 且未设置 immediately；H5 `packages/client/modules/src/client/manifest.ts:44-67` 称 immediately 控制 stage-one **prefetch**（R2、R4）。 | 可称“未请求立即预取”，不能将这一项单独推断所有组件直到用户动作才 materialize，也不能以缺省字段证明运行成功。 |

## 3. V-01～V-13：问题真实性、规范与处置必要性

| ID | 结论、版本及可复核证据 | 建议、边界及原报告修正 |
|---|---|---|
| V-01 | **部分成立**。W `ui-workbench-jobs/src/client/JobNode.tsx:1-7`、`ui-insuremo-status/src/client/WorkspaceHealth.tsx:1-8`、`ProfilePicker.tsx:1-10` 真有 Harness Client **值导入**。W 已跟踪 `git-dist/icomposer-workbench/lib/client.js` require 列表是 `@deepseek-ai/dsh-client-ui-primitives`、`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`（R3）。H5 `practices.md:35` 的禁止确实适用第三方插件。**反证**：H2/H5 `packages/client/web/src/seed.ts:9-19,30-42` 和 `platform.ts:7-15` 均把 primitives、slots、React/React DOM 加入浏览器静态表；`packages/client/modules/src/client/system.ts:297-335` 先查 seed，再查已 materialize/已注册工厂。 | 应消除不稳定 Harness Client **运行时值**依赖以符合规范，不是因为“磁盘找不到包就必然 require 失败”；Windows rc.5 页面 materialize 未测，H5 源码 seed 也不等于其现场实物已渲染。`PropsRuntime`、`PropsLocale` 等 type-only 编译擦除；`dsh.client.inject` 是包激活/工厂到达顺序，不是 JS require 供应商；`external` 是非基线依赖声明而非自动安装供应。R3 列出所有 Picker 依赖。不要简单禁止所有 `react-dom` require：对 portal 与 createRoot 按调用上下文审查，见 V-02。复制基元前核实具体文件许可/归属（H5 根 `LICENSE` 为 MIT，要求保留版权及许可；仍须确认涉及文件无其他许可）。 |
| V-02 | **部分成立**。W `WorkspaceHealth.tsx:124-160,196-215,265-299,313-320` 观察 body、按宿主结构找节点并手工 createRoot；H5 `ui-plugin.md:13`、`practices.md:9,36` 不允许这种外部 DOM 探测/注入（R3、R4）。但该选择器是 `[role=treeitem][aria-expanded]` 加 `projectText`，H2/H5 `packages/client/ui-workspace/src/client/rows/Rows.tsx:220-267` 正是 **Workspace 分组行**；不是报告所说 Session 行。 | 必须改善不稳定耦合，但报告的 session-slot 替换不是等价实现。H2/H5 `contract/slots.ts:106-136` owner 仅 `sessionId`；`Rows.tsx:627-635` leading 仅非 blank、未归档、无更高状态时出现；`:443` hover 仅卡片。workspace 可零/多 session、折叠/未绑定，不能机械替换；§4 列待决。另漏掉 `BrandChrome.tsx:83-129,145-158` 的 observer/createRoot/隐藏宿主 SVG；原生 brand slot 已注册但不证明旧 driver 在各版本无副作用。 |
| V-03 | **成立为内部 API 风险；直接删除建议不成立**。W `icomposer-verify/src/tool-service.ts:15-25` 在 effect 外监听 `internal/plugin` 并比较 `ctx.fiber`。H2/H5 `vendor/cordis/src/fiber.ts:265-276,675-686` 是先同步通知、再异步卸载 effect（R5）。 | 真实 H2 Cordis + 模拟工具表的 §5 探针证实同步释放语义不等价、同 turn 直接注册存在理论冲突窗口；但紧接着 `ctx.plugin` 重装的探针两种均未复现冲突。**不声称现有 HMR 必坏**；须设计等价公开生命周期并对真工具表、依赖失活、重复注册/部分失败、await dispose 和热重装回归后才能移除。 |
| V-04 | **混用违反规范成立；“default 死代码、删除等价”不成立**。W `insuremo-service/src/index.ts:94-97,127-178,181` 两种形式共存；H5 `host-plugin.md:57-62` 禁止。H2/H5 `vendor/loader/src/config/entry.ts:223-237` 经 `unwrapExports`，`vendor/loader/src/index.ts:200-207` 优先 default；直接 `ctx.plugin(namespace)` 经 `vendor/cordis/src/registry.ts:216-227` 选 namespace 的 apply（R4）。 | **独立 bundle patch** 指向此包时，按源码 loader 选择 `ImoCliService`（`cli.ts:47-55`，提供 imoCli、static Config/inject），不会执行模块 `apply` 中 settings 可选注册及其它子服务挂载；**聚合** `icomposer-workbench-dist/src/index.ts:87` 直接传 namespace，选择 `apply`，按依赖条件执行 `:134-178` 的 settings/服务挂载。删除 default 会改变独立路径选中的入口及其能力，不能作为纯删除；当前 profile 的实际激活及功能尚未运行证明。先决定并回归两条分发路径、settings 有/无、Config 与依赖行为。 |
| V-05 | **部分成立**。W 聚合 `icomposer-workbench-dist/src/index.ts:56-62,68-75` 只有 TS interface，默认类未提供 static Config；H2/H5 `vendor/cordis/src/fiber.ts:42-61` 无 runtime Config 则原样返回 config（R2、R4）。子插件可有自己的校验，不能说整个系统处处没有校验：如 `insuremo-service/src/cli.ts:47-55` 与 `config.ts:34-45`。 | 如要支持受约束的用户配置，应为实际聚合入口的 lifecycle/verify/write/insuremoService 设计并测试**嵌套可校验 schema**、默认值、未知字段、边界及诊断；报告的四个 `Schema.any()` 即使包了 object，也只校验外层形状，不能校验内层值。`config: {}` 或 Config.listConfigs 可见性不等于完成配置校验。 |
| V-06 | **成立，限显示资源**。W dist `package.json:14-27` 无 locale/icon export 或 files；H5 `host-plugin.md:29-36,51-55` 要求标题/描述/合法授权图标并写出 fallback（R2、R4）。 | 按分发内容补资源并验包与渲染，或明确记录合规例外；W `lib/assets/*.png` 是页面品牌资源而非已声明插件 icon。没有 live Plugin Manager 视图，不能声称现场一定显示某个图。 |
| V-07 | **成立为验证覆盖缺口，不等于所有类型检查无效**。W 13 个 `harness-shims.d.ts`；例如 `ui-insuremo-status/tsconfig.json:7-15` 直接映射 shim，`scripts/audit-compat.mjs:56-79` 明确接受 shim，根 `tsconfig.base.json` 也有 H2 源码映射（R2、R6）。 | 按关键服务/slot 逐步用目标版本真实声明交叉校验、发现差异；当前四个 noEmit 仅证明 shim 自洽。不要因此推断 rc.5 不兼容，或无条件删除 type-only 导入。真实 d.ts 可获得性/导出形式需逐包核对。 |
| V-08 | **成立为工程耦合**。W `packages/icomposer-workbench-dist/tsdown.config.ts:1-15` 直接从同级 H2 checkout 导入 `clientBundle`；UI 包 build 配置及 test aliases 亦指向 checkout（R2、R6）。 | 需要可复现的已版本化 build/真实类型依赖并核对许可；不自动把 compatibility pin 改为 H5。新版本支持须单独经过分发/运行回归和用户决策。 |
| V-09 | **部分成立**。W `scripts/check-compatibility.mjs:47-56,81-85` 直接 `execFileSync('pnpm',...)` 并吞所有启动错误；报告 Windows/Node 24 上的 `.cmd` ENOENT/EINVAL 属其现场自报，当前 Mac `pnpm check` 成功（R2、R6）。 | 如果 PATH 首选 `.cmd/.bat`，Node 无 shell 不能直接执行的风险具体成立；但 pnpm 可由真正 `.exe`、不同 shim 或调用环境启动，不能宣称所有 Windows/Node 24 必失败。优先验证可信 `npm_execpath` 确为 pnpm JS 入口后用 `process.execPath`、argv 直接调用；其缺失/非 pnpm 时需受控 fallback。Windows 固定命令的 `cmd /d /s /c` 须处理路径/引号，严禁把可控输入拼入命令或全局 `shell:true`。用 Windows 矩阵覆盖 cmd、PowerShell、带空格和 shell 特殊字符路径及缺失可执行文件，保留错误分类；本机未实测 Windows。 |
| V-10 | **部分成立，原“并集所以肯定不致命”过强**。W patch 对 verify、insuremo、dist 缺名分别见 `bundle/cordis.patch.yml:25-39`、`dist/cordis.patch.yml:1-4` 与对应模块名；H2/H5 `vendor/loader/src/index.ts:129-135` 确将**选中插件的** inject 与 entry inject 合并（R2、R4）。 | 先确定选中 export：默认 Service 类被 unwrap 后，namespace named inject 未自动参与合并；聚合类无 static inject，dist 行没有 systemPrompt，子 `IcomposerVerifyToolService` 自己有 static inject（`tool-service.ts:5-7`），是否等待取决于实际服务。不可仅机械同步两份数组或据并集宣称运行正常。 |
| V-11 | **部分成立，描述需准确**。H5 `packages/client/ui-primitives/package.json`、`ui-slots/package.json` 都是源码包名，但无 `dsh.client` 插件声明；W dist `package.json:34-45` 把两者列为 client inject。H5 `packages/client/modules/src/client/system.ts:251-277` 查到 graph row 才递归到达；`seed.ts:17-18,38-40` 又把两者放进静态表（R3、R4）。 | 不是“名称/模块不存在”，而是这两个源码包不是上述意义的 Client 插件行；要将 package arrival、Cordis service inject、静态模块表分开。无证据证明多余项导致当前失败；清理必须验证两版图、激活顺序与全部功能。 |
| V-12 | **不成立为强制规范；计数也不准确**。W dist `package.json:55-69` 有 **13 个 peer，总计 12 个 `*`，React 是 `^18.2.0`**（R2）；H5 `host-plugin.md:5-17` 是 Host-only 示例“needs no dependencies”，不是禁止有实际依赖的混合 Host/Client 包声明 peers 的普遍规则。 | 分类核查 Host external、React singleton、Client 模块表及真实 npm/pnpm 安装解析与版本边界后再定最小声明；不要按报告一键删 peer 或用 peer 清单证明浏览器 module 供应。无隔离安装证据。 |
| V-13 | **不成立为强制违规**。W `dist/src/index.ts:68-70` 使用 `@icomposer/workbench` service key；H2/H5 `vendor/cordis/src/service.ts:29-57` 接受 name 并注册，`reflect.ts:225-242` 以字符串查询；引用的插件规范没有要求去掉 `@/`（R4）。 | 若为了可读性而改名，是兼容性/设计选择，先查消费方与生命周期；非必须改，也没有因特殊字符必坏的证据。 |

## 4. 关键语义与报告遗漏

### 4.1 Session slot 不是 Workspace 行替身

H2/H5 `ui-workspace/src/client/contract/slots.ts:106-136` 表明 `sidebar.session.row.leading` 与 `sidebar.session.row.hover` 为 root-scoped list、owner 只给 `sessionId`；这不排除标准 kit 提供全局 selector hooks。H5 `ui-workspace/src/client/index.ts:71-76` 声明 `useWorkspaces`，`packages/api/workspace-controller/src/types.ts:17-25` 的 `WorkspaceView` 有 `workspaceId/sessionIds`，`.../client/model.ts:28-40` 还有 pending/ready、loading/error。可按 snapshot 反查 membership，但必须处理未加载、unbound/临时、0 或多个 Session、权限、过滤与状态变化；不能只按标题或默认 1:1。

报告建议的 `ctx.sessions.binding(sessionId)` **确为公开方法但不是 workspace 映射 API**：H5 `packages/extensions/cordis-client-runner/src/client/api-catalog.ts:223-232`、`packages/api/session-controller/src/client/sessions/service.ts:100-108,534-541` 显示它只借用已 retain 的 Session binding，可能为 undefined，结构没有 workspaceId；为每一行 retain 又改变激活与资源语义。H2/H5 `ui-workspace/README.md:70,94`、`rows/Rows.tsx:443,627-635` 明确 leading 在空白、归档、活动状态或搜索场景不保证出现，hover 仅打开时可见。

现有健康数据是 workspace 维度（W `WorkspaceHealth.tsx:21-33,196-245`），位于 Workspace **分组行**，与在每个 Session 复制一组状态不等价。现有公开 slot 清单未发现对应 Workspace 分组行的等价装饰点，不应据此断言绝对不存在其他可扩展能力。后续设计须保留现有体验为目标，列出官方 slot/其他 UI 的降级选择、是否改变位置/语义及用户决策；本任务不选择或实施。

### 4.2 漏扫的 DOM 与 Picker

- `WorkspaceHealth` 用 createRoot 注入 host group；它还在 `:313-320` 挂载 `BrandChrome`。`BrandChrome.tsx:83-129,145-158` 独立观察 body，按 SVG viewBox/邻居发现宿主元素、隐藏原 SVG、追加 host 并 createRoot，卸载时尝试还原（`:108-142`）。即使正常 brand slot 注册（`index.ts:43-67`），不能不经版本实测就假设 fallback 永远不触发。
- `ProfilePicker.tsx:3-8,145-157,174-198` 的运行时值有 **Button、MenuSurface、useAnchoredPosition、useDismissOnOutsidePointer**；`WorkspaceHealth` 为 Tooltip，`JobNode.tsx:2-6` 为 IconApiOutlineRegular、StateDot（StateDotState 是 type-only）。删除 primitives 时四个组件加两个 hooks 都要考虑，不是报告的四项就完成。
- Picker 使用 React 组件生命周期管理 `createPortal(..., document.body)`、focus/escape/外部点击，不是扫描并修改宿主既有 DOM，也不是另起应用 root。H5 `practices.md:36` 对第三方仍明确要求不要写组件外 DOM/append body；`ui-plugin.md:5,13` 提供需要已知位置 overlay 时的 `shell.overlay` 边界。H5 自身 `ui-primitives/src/HoverCard.tsx:310-314`、`MenuSurface.tsx:26-43` 内部也 portal 到 body，**不能据此授予第三方例外**。这是与 WorkspaceHealth/BrandChrome 侵入不同性质的规范/兼容审查项；先在授权设计中比较官方 overlay、定位、主题、焦点恢复、Escape、卸载与 rail clipping，不把所有 `react-dom` 判为违规。

### 4.3 补充 Host 生命周期风险

报告 C-05 的两个正面例子不能覆盖 `InsuremoRoutesService`：其 `#disposers` 只收集未消费，`safe()` 还吞掉重复注册错误（W `route-service.ts:36-60`）；H2/H5 WebServer `register` 的 disposer 并非自动执行（`host/webserver/src/index.ts:360-373`）。这支持**潜在旧 handler 留存、重装被静默跳过**的风险，尚未有真实 fiber 实例探针结果；缺少项目依赖 `dsh-util-values/lib/index.js` 阻止直接 import，禁止把待验证风险写成已发生故障。优先补隔离卸载后路由可命中/重装指向新 handler 的测试。

## 5. V-03 生命周期最小可复现实验

原脚本 `/tmp/workbench-rc5-validation.8MZjPr/lifecycle-probe.mjs`，原始输出 `.../lifecycle-probe.out`；SHA-256 分别为 `cfc4f5a8a975bd73f7f4152c07f812f7901c444f883d3c6a6881eb3a9e5514e3`、`5b27c3524f810cdfcf2d11bced3be6a79e9445b6870f342db4aa2130fcaabc32`。它用**真实 H2 Cordis**、内存 Set 假工具表，不加载 Workbench 真实工具实现、不改项目。为避免临时目录清理影响复现，核心脚本如下（在工作台目录运行，所有测试文件写隔离临时目录）：

```sh
T=$(mktemp -d /tmp/workbench-lifecycle.XXXXXX)
cat > "$T/probe.mjs" <<'EOF'
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
for (const early of [false, true]) {
  const ctx = new Context(), active = new Set(), log = [];
  function register() { if (active.has('tool')) { log.push('DUPLICATE'); return; } active.add('tool'); log.push('register'); }
  class Probe extends Service {
    constructor(c) { super(c, 'probe'); }
    [Service.init]() {
      register(); let live = true;
      const cleanup = () => { if (live) { live = false; active.delete('tool'); log.push('cleanup'); } };
      this.ctx.effect(() => cleanup);
      if (early) { const owner = this.ctx.fiber; this.ctx.on('internal/plugin', f => { if (f === owner) { log.push('event'); cleanup(); } }); }
    }
  }
  const old = await ctx.plugin(Probe); await old.await();
  const stopping = old.dispose(); log.push(`after-dispose-call:${active.has('tool')}`);
  register(); await stopping; log.push(`after-await:${active.has('tool')}`);
  assert.equal(log.includes('DUPLICATE'), !early);
  console.log(JSON.stringify({ experiment: 'direct', early, log })); await ctx.fiber.dispose();
}
for (const early of [false, true]) {
  const ctx = new Context(), active = new Set(), log = [];
  const plugin = (name, first) => ({ name, apply(c) {
    if (active.has('tool')) { log.push(`${name}:DUPLICATE`); throw Error('duplicate'); }
    active.add('tool'); log.push(`${name}:register`); let live = true;
    const cleanup = () => { if (live) { live = false; active.delete('tool'); log.push(`${name}:cleanup`); } };
    c.effect(() => cleanup);
    if (first && early) { const owner = c.fiber; c.on('internal/plugin', f => { if (f === owner) { log.push(`${name}:event`); cleanup(); } }); }
  }});
  const old = await ctx.plugin(plugin('old', true)); const stopping = old.dispose(); log.push('dispose-return');
  let result = 'ok'; try { const fresh = await ctx.plugin(plugin('new', false)); await fresh.await(); } catch (e) { result = e.message; }
  await stopping; log.push('stop-awaited'); assert.equal(result, 'ok');
  assert.ok(log.indexOf('old:cleanup') < log.indexOf('new:register'));
  console.log(JSON.stringify({ experiment: 'ctx.plugin', early, result, log })); await ctx.fiber.dispose();
}
EOF
(cd packages/icomposer-verify && TMPDIR="$T" HOME="$T" TSX_TSCONFIG_PATH=../../tsconfig.base.json node --import tsx "$T/probe.mjs")
```

实际原始输出：无 listener 同 turn `after-dispose-call:true, DUPLICATE, cleanup`；有 listener `event, cleanup, after-dispose-call:false, register`；两种紧接 `ctx.plugin` 替换均 `old:cleanup` 在 `new:register` 前，`startResult=ok`。前者模拟另一调用方在同 turn **直接**注册，后者才是此最小场景下的插件重装；两者均非真实 HMR/真实工具表测试，不能等同。

## 6. U-01～U-04、风险分级和最小回归

| ID | 结论与证据 | 修正建议 / 限制 |
|---|---|---|
| U-01 | **报告现场待证；本机部分可验证**。R6：Mac Node 25.2.1 / pnpm 11.7.0 的 `pnpm check` 通过；三个 UI 包和 verify 的 `tsc --noEmit` 均通过，但使用 shim/H2。定向 verify 测试命令在测试收集前报 `ERR_MODULE_NOT_FOUND`，缺 H2 `@deepseek-ai/dsh-util-values/lib/index.js`。 | 不据此推断业务失败；Windows 全量四项仍未测。`pnpm typecheck` 的 dist 脚本会 build；`pnpm bundle` 会写产物，`pnpm check:git-dist` 实际先删除重建 dist `lib`（W `scripts/dist-payload.mjs:48-67,207-225`），本次按授权均不运行；不可称全量通过。 |
| U-02 | **仍待证**。H2/H5 seed 和 loader 静态证据只能说明源码供应能力（V-01），W 产物 require 枚举只能静态审查。 | 授权后在隔离 rc.2/rc.5 页面分别检查实际 client factory materialize、slot 占用和错误；HTTP 200、存在源码、shim typecheck 均不替代此证据。本次无 `cua_repl` 工具，未使用 CDP 替代。 |
| U-03 | **仍待证**。没有可用受授权 CUA 页面自动化，未观察 Settings、品牌、Workspace 健康、Picker、ICI 卡或键盘交互。 | 未来在两版本、明暗、宽/窄、slot 无声明及失败状态验证渲染、清理与 focus；真实写动作需另行授权，不因有单测或 HTTP 200 判通过。 |
| U-04 | **仍待证**。未执行任何 plugin add/升级、打包安装或重启。R2 可读取 W 的源码/跟踪分发 manifest 与 engines，不能证明现场安装。 | 后续在隔离 HOME/DSH_HOME、无用户 profile/网络副作用的授权沙箱，对 git-dist 和 tarball 分开验证安装、升级、回滚、依赖解析和安装文件；Windows 单独验证。 |

### 重新分级（提案，不等于已确认 P0 事故）

1. **P1，优先研究与后续修复**：V-01 违反外部 Client 模块规范，V-02 依赖宿主 DOM 且有 Workspace 语义迁移难题；C-05 的 route disposer 风险应先验证影响范围。可导致升级/卸载时可用性、陈旧 handler 或交互退化，**没有现场失败证据，不将它们称为当前 P0 事故**。不建议据报告直接执行 B1/B2。
2. **P1，修复建议须先证明安全**：V-03 同步卸载语义、V-04 两个入口行为、V-05 真实 schema、V-09 跨平台脚本。报告中“直接删”“只加 any”“全局 shell:true”均不应照搬。V-07/V-08 是版本保障缺口，真实声明和 build 解耦要与发布兼容一起排期。
3. **P2，体验/清晰度**：V-06 元数据、V-10/V-11 声明与依赖图核验；V-12/V-13 没有强制违规证据，暂不为清单整洁单独改动。优先级可按实际故障、外部发布风险及用户意图调整。

### 最小回归矩阵（待授权执行，不是本次 PASS）

| 层 | 必需场景与断言 | 本次状态 |
|---|---|---|
| 静态/版本 | W 源与 git-dist 漂移；分别核对 H2/H5 manifest、真实 d.ts、factory module allowlist；跟踪 type-only vs 运行时值 | 部分：R1–R4、R6；未重建对比 |
| Host 生命周期 | 单独 patch vs aggregate：提供/缺失 settings、实际 service/Config；工具与 prompt 注册/卸载、同 turn 及 await 后重装；route 卸载不能命中旧 handler、重装不能吞重复错误；依赖失活/回归 | 仅模拟时序 §5；真实 Workbench 实例受缺库阻碍 |
| UI 功能/无障碍 | 在真实页面分别触发 brand、Settings、picker、Workspace status、ICI 工具卡；宽窄/明暗、焦点/Escape/外点、卸载后无遗留 DOM；console 无 slot crash | 无 cua_repl，未执行；不能用 DOM 静态查询或 HTTP 代替 |
| 数据语义 | 0/1/多 Session、临时/未绑定、多个同标题、workspace 折叠/过滤/切换；loading/error/unknown、缓存去重/失效、取消；旧工作流与降级明确 | 设计及实测均待授权 |
| 分发/兼容 | 独立隔离的 rc.2/rc.5 × 本机/Windows；真实 d.ts、构建、测试、git-dist 比较、pack 文件、安装/升级/回滚、client materialize 和槽可见性 | 未执行；不更改当前 pin 或宣称 rc.5 支持 |
| Windows 进程 | PowerShell/cmd，`.cmd`、可执行 `.exe`、npm_execpath 缺失/错误，空格/特殊字符路径，`--version`，恶意参数无注入 | 无 Windows 实机，未执行 |

## 7. 可复现命令与本次执行结果

以下从 `/Users/junjie.zhang/dsh` 运行，`W=icomposer-workbench`，`H2=deepseek-harness`。查看源码/清单命令不修改仓库。H5 根用上面 `/tmp` 路径，失效时**仅在隔离临时目录**重取：

```sh
# R1：身份、源码与报告；git 只读，不取 token、不改 home
W=icomposer-workbench; H2=deepseek-harness
cat "$W/compatibility.json"
git -C "$W" status --short --branch; git -C "$W" rev-parse HEAD
git -C "$H2" status --short --branch; git -C "$H2" rev-parse HEAD
git -C "$H2" ls-remote --tags origin 'dsh-v0.2.1-rc.5*'
nl -ba /Users/junjie.zhang/Downloads/plugin-compliance-report.md | sed -n '1,95p'
# 需要重新获取 H5 时：无需 git checkout/fetch 到现有仓库
T=$(mktemp -d /tmp/workbench-rc5-validation.XXXXXX)
curl --fail --location --silent --show-error \
  https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/b830ec950faba0a46dda564be3e2d854afed94f1 -o "$T/rc5.tar.gz"
shasum -a 256 "$T/rc5.tar.gz"
mkdir "$T/source"; tar -xzf "$T/rc5.tar.gz" -C "$T/source"
H5="$T/source/deepseek-harness-b830ec950faba0a46dda564be3e2d854afed94f1"
```

```sh
# R2：Workbench manifest、入口、配置信息和生命周期反例
cd /Users/junjie.zhang/dsh/icomposer-workbench
for f in packages/{icomposer-workbench-dist,bundle-icomposer-workbench}/{package.json,cordis.patch.yml} \
 packages/icomposer-workbench-dist/src/index.ts packages/insuremo-service/src/index.ts \
 packages/insuremo-service/src/cli.ts packages/insuremo-service/src/config.ts \
 packages/insuremo-service/src/overview/route-service.ts \
 packages/icomposer-verify/src/tool-service.ts scripts/check-compatibility.mjs; do echo "=== $f"; nl -ba "$f"; done
find packages -name harness-shims.d.ts -print | wc -l
node -e 'const p=require("./packages/icomposer-workbench-dist/package.json");console.log("peers",Object.keys(p.peerDependencies).length,"wildcards",Object.values(p.peerDependencies).filter(x=>x==="*").length)'
```

```sh
# R3：全部 UI 值导入、type-only、slot 注册与产物 require（静态，不是 materialize）
cd /Users/junjie.zhang/dsh/icomposer-workbench
rg -n '(from |require\()["\x27](@deepseek-ai/dsh-client|react-dom)' packages/{ui-insuremo-status,ui-workbench-jobs,ui-insuremo-settings}/src --glob '*.{ts,tsx}'
for f in packages/ui-insuremo-status/src/client/{WorkspaceHealth,BrandChrome,ProfilePicker}.tsx packages/ui-workbench-jobs/src/client/JobNode.tsx packages/ui-insuremo-status/src/client/index.ts packages/ui-insuremo-settings/src/client/{index.ts,prefill-slot.tsx} packages/ui-workbench-jobs/src/client/index.ts; do echo "=== $f"; nl -ba "$f"; done
node -e 'const s=require("fs").readFileSync("git-dist/icomposer-workbench/lib/client.js","utf8"); console.log([...new Set([...s.matchAll(/require\(["\x27]([^"\x27]+)["\x27]\)/g)].map(m=>m[1]))].sort().join("\n"))'
```

```sh
# R4：官方原文、模块表、slot/会话/工作区、loader、路由；H5 如 R1 所设
for H in /Users/junjie.zhang/dsh/deepseek-harness "$H5"; do
  echo "=== $H"
  for f in packages/preset/agent-preset/skills/cordis-plugin-development/references/{host-plugin,ui-plugin,practices}.md \
    packages/client/web/src/{seed,platform}.ts packages/client/modules/src/client/system.ts \
    packages/client/ui-workspace/src/client/{contract/slots.ts,rows/Rows.tsx,tree.ts,index.ts} \
    packages/api/session-controller/src/client/sessions/service.ts \
    packages/api/workspace-controller/src/{types.ts,client/model.ts} \
    vendor/cordis/src/{registry,fiber,service,reflect}.ts vendor/loader/src/{index.ts,config/entry.ts} \
    packages/host/webserver/src/index.ts; do echo "=== $f"; nl -ba "$H/$f"; done
done
rg -n "key: '(agents|directoryPicker|jobs|llm|skills|storageDomain|subprocess|systemPrompt|tools|webServer|workspaceRegistry)'" "$H5/packages/extensions/tool-cordis/src/api-catalog.ts"
rg -n "key: '(locale|sessions|slots|uiWorkspace|workspaces)'" "$H5/packages/extensions/cordis-client-runner/src/client/api-catalog.ts"
rg -n 'sidebar.session.row.leading|sidebar.session.row.hover|sidebar.brand.mark|sidebar.brand.name|conversation.hero.brand.mark|sidebar.footer.action|settings.section|conversation.chat.node|tool.call.toolview|conversation.input.dock' "$H5/packages/extensions/cordis-client-runner/src/client/slot-catalog.ts"
```

```sh
# R5：复跑原始最小时序探针；或使用 §5 中的自包含版本
cd /Users/junjie.zhang/dsh/icomposer-workbench/packages/icomposer-verify
T=/tmp/workbench-rc5-validation.8MZjPr
TMPDIR="$T" HOME="$T" TSX_TSCONFIG_PATH=../../tsconfig.base.json node --import tsx "$T/lifecycle-probe.mjs"
```

```sh
# R6：已执行的无产物闸门；测试命令本机缺 H2 lib，失败非业务断言
cd /Users/junjie.zhang/dsh/icomposer-workbench
pnpm check
for P in ui-insuremo-status ui-insuremo-settings ui-workbench-jobs icomposer-verify; do
  TMPDIR=/tmp/workbench-rc5-validation.8MZjPr HOME=/tmp/workbench-rc5-validation.8MZjPr \
    "./packages/$P/node_modules/.bin/tsc" --project "packages/$P/tsconfig.json" --noEmit || exit
done
(cd packages/icomposer-verify && TMPDIR=/tmp/workbench-rc5-validation.8MZjPr HOME=/tmp/workbench-rc5-validation.8MZjPr \
 TSX_TSCONFIG_PATH=../../tsconfig.base.json node --import tsx --test \
 --test-name-pattern='apply mounts all eight Agent tools persistently and disposes them with the plugin' test/icomposer-verify.test.ts)
# 本机结果：pnpm check PASS；4× noEmit PASS；最后命令启动前 ERR_MODULE_NOT_FOUND dsh-util-values/lib/index.js。
```

```sh
# R7：只读本机 Desktop 版本（不证明 Windows）
cd /Users/junjie.zhang/dsh
node - <<'NODE'
const a=require('./deepseek-harness/node_modules/.pnpm/node_modules/@electron/asar');
const p='/Applications/DeepSeek Harness.app/Contents/Resources/app.asar';
for (const f of ['package.json','dsh/package.json']) { const j=JSON.parse(a.extractFile(p,f).toString()); console.log(f,j.name,j.version); }
NODE
```

**状态**：R1–R3、R4 对引用位置、R5、R6、R7 已执行或等价 `nl`/`rg` 单项执行；R1 的重取命令为复现模板，本次实取归档和摘要如 §1。未执行涉及仓库 build、pack、install、用户真实 Host/IMO/Skills 写操作或 App 重启的命令。工作台仓库原有 untracked `assets/`、`pages/`、`docs/product-*.md` 保留；本文为本任务唯一新增仓库文件。后续由 verifier 独立复核，设计另属 TASK-161。
