# iComposer Workbench 插件目标架构与分批改造设计

> 历史：TASK-160 核验与 TASK-161 原设计、D1 修订均已独立 PASS；这些是文档核验，不证明 rc.5/Windows 或插件完全合规。**2026-11-03 用户进一步授权按 BOARD 的 TASK-162～170 串行实施与隔离验证**；当前首卡 TASK-162 只同步本文并建立测试基线，不能提前实施后卡。唯一 `EX-WH-01` 标记为“**功能需求与官方扩展方式冲突**”：保留 Workspace 分组行健康图标及现有 driver，但仍违反公开 DOM 边界、有升级风险；例外不扩大。允许后续经 verifier PASS 由 maintainer 本地提交，不授权 push、发布、用户环境安装/部署、升级宿主或重启用户 App。输入 [TASK-160 核验](./plugin-compliance-validation.md) 的历史事实不变。

## 0. 基线、范围与不可退化约束

- W：Workbench `release/workbench-0.1.2@e87b86190f2f5fb7859eba943c0ddaa3d06976c6`；H2：固定 `687f282e8625c6b8d11ff58211a90524be2e4317` / rc.2；H5：上游 `b830ec950faba0a46dda564be3e2d854afed94f1` / rc.5，只读源码对照。证据和原报告编号以核验文档 §1–§4 为准。
- **当前分发基线冻结**：不修改 `compatibility.json` 的 rc.2 pin、`engines.dsh`、`plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37` 或其他分发 refs，不覆盖已装包；TASK-169 之前不刷新跟踪的 `git-dist`，TASK-170 可按其获批范围在本地生成并验证。推送或发布仍须另授权；不能仅凭 engines 范围包含 rc.5 称其兼容。
- 保留既有功能与安全边界：配置和 Profile 工作流、工具/提示词/路由、一次性写操作与现有防护。**唯一功能冲突 `EX-WH-01`** 沿用现有 Workspace 分组行位置及 `WorkspaceHealth` observer/createRoot driver、footer 挂载、轮询和交互；不改成 Settings、独立面板或 Session 行，不新增宿主 slot。该特定方案仍违反公开 DOM 边界并有升级风险，例外不扩到 `BrandChrome`、Picker 或内部监听；健康 v2/缓存仍未授权。
- 用户已授权本地实施及隔离 fixture/宿主准备与验证，按 BOARD 已立的 TASK-162～170 严格串行流转，不提前做后卡。真实 IMO/Skills/profile 写操作、用户 App 安装/部署、远端写、版本/pin/engines/宿主升级均未获授权；冻结的 `git-dist` 仅在 TASK-170 授权范围内刷新，本地开发期间分发未同步。

## 1. 目标边界与核验追踪

```text
DSH Host / Cordis                                 Workbench Host（不改 DSH core）
  loader、服务、生命周期      inject / ctx.plugin   聚合入口 + 子服务 + 显式 disposer
  workspaceRegistry、tools   <-------------------> workspaceBinding / ICI / IMO / routes
  webServer、systemPrompt                           只读、有界、无敏感路径的健康投影
                                                          |
                                                同源、只读状态 API
                                                          v
DSH Client                                               Workbench Client
  browser module table       React singleton       本地组件、主题 token、locale
  slots + 标准 props          注册 / 声明生命周期    footer / brand / settings / chat
  useWorkspaces 等公开 hook  --------------------> 插件拥有的控制器（候选）
  shell.overlay（root/list） <--- 注入共享状态 ---- Picker overlay（候选，非第二 React root）
  sidebar.footer.action      --- 现有挂载 ------> WorkspaceHealth 现有 driver
  Workspace 分组行           <-- DOM 注入 -------- observer/createRoot（D1 特定例外）
构建/分发：真实 d.ts 契约校验 → 固定工具链 → Client factory + Host → 分范围门禁 → 隔离安装/materialize
注：workspace 状态 v2/缓存仅为未来候选；框图不代表已经实施或客户端已 materialize。
```

| 边界/变更 | 设计结论 | 回链到核验 |
|---|---|---|
| Client 模块 | Harness Client **值模块不作为第三方运行时依赖**；React singleton 由平台表提供；type-only 和模块激活次序分开 | V-01、V-07、V-11、C-07/C-08 |
| DOM/席位 | 除用户接受的现有 `WorkspaceHealth` 例外外，其他候选改造目标是使用已声明 slot 和插件自有元素；现有未处理项不因此被视为合规，不把健康图标移到其他位置 | V-02、U-02/U-03 |
| Host 生命周期 | 路由按所有权释放、注册事务化；工具在公开可证的 dispose 边界内去重；同 turn 语义与 await 后语义分别验 | C-05、V-03 |
| Host 出口 | 独立 default 与聚合 apply 是不同现状；修形态时保持两路当前能力，解决实际被 loader 选中的 inject/Config | C-03/C-06、V-04/V-05/V-10 |
| 展示/依赖 | 本地化、icon 与包内容单独验；按实际 Host 引用/安装解析处理 peer，不为样式改 service key | V-06、V-12、V-13 |
| 类型/构建/分发 | 区分真实声明、源码、锁定工具链和已构建工件；跨平台启动、产物 allowlist、git-dist 漂移与真实 materialize 分层门禁 | V-07/V-08/V-09、U-01/U-04 |

**Client 目标 allowlist（面向后续构建产物，不是当前 PASS）**：

1. `react`、`react/jsx-runtime` 使用 Host 提供的唯一实例，不内嵌另一份 React。其他 React baseline 子路径只有在 H2/H5 实际表和测试确认后显式添加。
2. 不再有生产 `require('@deepseek-ai/dsh-client-*')` 等 Harness Client 值模块；TS `import type` 可保留，但须真实声明交叉编译且 emitted JS 消失。`dsh.client.inject` 的包名是 graph/激活信息，`ctx` 上 `slots/locale/sessions/workspaces/uiWorkspace` 是服务名，均不是 require 供应清单。
3. `react-dom` 不是一概违规：**Picker 的候选新设计不依赖 body portal**；确有经批准的组件自有 portal 时，按调用点验证归属/生命周期，单独放行 `react-dom`。按 D1，最终分范围门禁**精确允许现有 `WorkspaceHealth.tsx:2,124-175,196-310` 所需的 `react-dom/client`/`createRoot` 和既有 observer、选择宿主 Workspace 行、注入节点及清理策略**（例外 `EX-WH-01`）；保留 `index.ts:83-95` 的 health 注册和 `WorkspaceHealth.tsx:313-329` 中健康 driver 的挂载，但同一 render 中的 `BrandChrome` 不属于例外。W 原文件 SHA256 `76e84d4b6b9d832cd203a02355f2448dd61aad820d1ba74de8af84cbb3bdb44e` 是取证基线，不是其他经批准改动必须保持整文件字节不变的要求。按源码 AST/调用点及产物来源映射锁定已接受行为，禁止额外、新增或扩大的宿主 DOM 探测/注入；bundle 的一个 `require('react-dom/client')` 不足以证明所有调用者都被授权，来源映射不可核验则该项未验证。`BrandChrome` 的现有 root/observer 与 Picker body portal **不属于 EX-WH-01**，若暂未修复要作为各自未解决问题披露，不能因同包引入而泛化许可。测试产物单独分类，不粗暴禁整包或全放。
4. 产物门禁先解析 AST/构建 metafile，再核对静态 import、动态 import、require 和打包内 React 副本；所有非基线依赖必须有来源、版本、供给和许可证明。禁止未审查新增 Client 外部值模块，而不是只检索某几个示例词。

当前 W 已跟踪 Host 产物静态外部引用可见 `@deepseek-ai/cordis`、`dsh-storage-domain`、`dsh-tools`、`dsh-llm`、`schemastery`、`dsh-skill`，并有动态 `dsh-native-command`；其余 Node builtins 归 Host，不归浏览器。**这只是当前产物观察，不是完整未来 peer 清单**：逐一按目标工件、宿主解析、条件路径及真实隔离安装测试决定，现有 13 个 peer 不做一键删改。`@icomposer/workbench` service key 原样保留。

## 2. 本地 UI、slot 与 overlay

### 2.1 本地基元契约

| 组件/行为 | 要覆盖的行为及验收，不要求先复制宿主实现 |
|---|---|
| Tooltip（`WorkspaceHealth`） | pointer 与 keyboard focus、延迟/取消、`role=tooltip` 和关联、离开/blur/点击隐藏、viewport 翻转/clamp、卸载清定时器；Tooltip 自身不读取宿主 DOM，不改变 D1 保留的健康 driver。 |
| Button（Picker） | `type=button`、disabled/busy、清楚的可访问名称、键盘激活、focus ring、阻止重复提交；保留现有 Profile 目标与 POST 行为。 |
| StateDot、IconApiOutlineRegular、三个 health glyph | 明/暗主题 token、状态不靠颜色单独传达，`role`/label 与装饰性 `aria-hidden` 分别正确，16px 尺寸与高对比度；未知与失败不显示成功。 |
| MenuSurface（Picker 报告漏项） | 插件自有面层、阴影/边框/布局和受限滚动；列宽、长名称截断与完整可访问名称；不使用宿主内部基元的 DOM class。 |
| `useAnchoredPosition` 替代 | 只量自有 trigger 和自有 overlay wrapper/panel；scroll/resize/anchor/panel 尺寸改变后重算，按可见容器边界翻转/clamp；取消 rAF/observer/listener。 |
| `useDismissOnOutsidePointer` 替代 | 判断事件路径是否在插件自有 trigger 或 panel；外点关闭、Escape 关闭并在 trigger 仍存活时恢复焦点；同一 interaction 不误把 panel 当外部。所有监听器随实例解除。 |

键盘交互按实际语义选用 `button` + dialog/listbox 等可访问模式，不把 `role=menu` 套在不遵守菜单键盘约定的列表；验证 Tab/Shift-Tab、Escape、方向键（若宣称 listbox/menu）、屏幕阅读器名称、reduced-motion、窄屏、RTL 和错误恢复。初始隐藏测量后才转焦点，避免隐藏元素 focus 失败。文字走 `ctx.locale`，样式仅用可获取 `--dsw-alias-*` token；缺 token 时用 `inherit`/`currentColor` 等语义继承保持可读和焦点可见，不引入硬编码主题色作为默认视觉协议。

许可策略：默认**自行实现**行为；如参考或移植，逐文件核实源文件、衍生资源、依赖和图标许可，保存来源 commit/文件/变更及版权声明，MIT 材料随分发物保留许可证。H2/H5 根 LICENSE/相关 package manifest 声明 MIT 不等于所有图片、字体或第三方资源都已获授权。

### 2.2 `shell.overlay` 的真实 API 与数据流（V-01/V-02）

H2/H5 `packages/client/ui-layout/src/client/index.ts:95-105,178-186`：`shell.overlay` 是 **root scope / list**；`AppFrame.tsx:249,292-294` 用 `renderSlot('shell.overlay', {})` 挂载，owner 不提供 anchor、坐标或回调。`AppFrame.module.css:1-7,281-289` 是 frame 内覆盖层：layer 默认 pointer-events none、直接子元素可接收事件，frame 自身 `overflow:hidden`。这不是不受限制的浏览器 top-layer，遮挡、剪裁、层级需要实测。

可行接缝是公开 `ctx.slots.inject('shell.overlay', callback)` + callback 内 `ctx.slots.register({ name: 'shell.overlay', id, ... }, Component)`；H2/H5 `ui-workspace/src/client/index.ts:327-339` 的 dialog 注册及 `:242-246` 的 `inject` 闭包是现有用法，`ui-slots/src/index.ts:184-186,250-261,768-783,815-838` 描述 owner/标准 kit/list options。`ctx.slots.inject` 按声明生命周期安装/清理并在恢复时重装（`ui-renderer/src/client/registry.ts:194-209`）。不能把 `sidebar.footer.action` 的 `wide` 当成 overlay 的 owner props，也不能假设 slot 自带 anchor 服务。

**插件实现设计，不是声称宿主内置 API**：

1. 一次 Workbench client `apply` 创建一个插件自有 `PickerController`（稳定快照/subscribe/close/open、内部临时 trigger 引用），由两个**真实 slot register 的 `inject` 工厂闭包**分别传给 footer trigger 与 overlay 组件。React 组件通过 `useSyncExternalStore` 订阅该 controller；不是新 `ctx` 服务、不是读宿主私有 store。controller 属于本插件 fiber，卸载清空引用、监听器、未完成请求。
2. footer owner 只读实际 `wide`（`ui-sidebar/src/client/contract/slots.ts:107-111`），把**自己渲染的** button ref 交 controller。按钮打开时读取该 ref 的 `getBoundingClientRect()`；overlay 只读自己的 wrapper/panel rect，把 viewport 坐标换算为相对 wrapper 坐标，按 wrapper/可见区域 clamp/翻转。坐标可能在 resize、滚动、UI 缩放/标题栏变化或元素断连后失效，重新量测；scroll/resize listener、ResizeObserver 和 rAF 仅用于自有触发器/面层，销毁必须对称。
3. overlay 以自身 mount/unmount 通知 controller `ready/unavailable`；**注册成功不等于组件已挂载**。确保层的自有外层不会截住全屏点击，面板自身可交互；其他插件的 overlay/模态层不能被覆盖或擅自修改。失去声明、trigger 消失、目标 workspace 切换或卸载时关闭并取消请求，只有仍连接且可聚焦的 trigger 才恢复焦点。
4. 若 overlay 缺席/未 materialize：宽 sidebar 的 footer 内联 Picker 是候选；窄 rail 未证明不裁剪，也没有由 footer owner 提供的“展开 sidebar”回调。现有 Settings 卡只显示摘要（W `ui-insuremo-settings/src/client/InsuremoCard.tsx:30-35`）；**不得擅自新增 Settings 替代入口，也不把 Workspace 健康图标移入 Settings**。若无法以现有公开能力保持 Profile 交互，带证据向 planner BLOCKED，不宣称可切换或捏造导航 API。

用官方 overlay 时仍需实测 frame clipping、DOM 层级/坐标、组件身份、焦点、屏幕缩放、窗口移动和 HMR；不能只依据源码说可用。官方内部 Tooltip/MenuSurface 使用 body portal 不给予第三方例外；组件自有 portal 与 `WorkspaceHealth`/`BrandChrome` 扫描、覆盖其他插件 DOM 的风险不同。不得为去掉 `react-dom` 而牺牲 rail 可用性。

### 2.3 品牌边界（V-02）

品牌候选改造只通过已声明的 `sidebar.brand.mark`、`sidebar.brand.name`、`conversation.hero.brand.mark` 注册原品牌组件（W `ui-insuremo-status/src/client/index.ts:43-67`），保留 slot priority 行为与 locale/资源。`BrandChrome` 不属于 D1 例外；在对应的 TASK-168 中处理品牌 fallback 时，不再用它观察 body、识别 viewBox、隐藏或修改宿主 SVG。**当前 `BrandChrome` 由 `WorkspaceHealth.tsx:313-320` 渲染，处理品牌时必须保留 `WorkspaceHealth` 整体及 `index.ts:83-95` 的 footer 注册、健康 driver 和分组行图标；不能为移除品牌而删除健康挂载。** 某版本/布局缺品牌 slot 时保留宿主原品牌并明确降级；移除 fallback 前必须验证页面，当前未实测。

## 3. 健康状态：保全 Workspace 语义，而非换成 Session

### 3.1 D1 已决定：保留现状；A/B/C 为历史备选

现有数据按 workspaceId，glyph 位于 Workspace **分组行**；H2/H5 Session `leading` 只有 `sessionId`，空白、归档、活动状态/搜索等不保证出现（核验 §4.1）。**用户明确选择 D：保留现有位置及 `WorkspaceHealth` 的 `MutationObserver`、现有 DOM 行匹配/节点注入、手工 `createRoot`、footer 挂载和清理流程。** 不把图标移至 Settings、独立面板或 Session，不默认请求修改 Harness。现有实现违反公开插件 DOM 边界，存在宿主 DOM 变动、错误匹配、不可见或重复等升级风险；用户接受此特定风险，不是合规证明，实机效果仍待验证。

| 历史备选 | 与 D1 的关系 |
|---|---|
| A：向宿主提议公开 Workspace 分组行 slot | 历史方案，当前未选择、不默认请求或修改 Harness；只有将来实际不支持并有证据时才可重新向用户提出，需另授权。 |
| B：Settings 或插件独立 Workspace 状态面板 | 用户当前不接受位置/额外操作变化；不作为降级或自动替代。 |
| C：Session 行 `leading`/`hover` | 不是 Workspace 分组行等价展示；当前不采用替代或补充，不自动迁移。 |
| **D：沿用现有 WorkspaceHealth DOM driver** | **当前已决定**，仅此处为 `EX-WH-01`；不扩大到 BrandChrome、Picker 或内部事件。 |

**验收与升级**：B06 健康迁移本轮 deferred，不阻断其他已授权独立修复的分范围本地实施/验收；此类结果都要披露 `EX-WH-01`，不能称零 DOM 注入或整插件完全合规。push/发布/用户部署不在当前授权内。将来升级时定向回归原分组行图标可见、位置未变、无重复、卸载/重装清理；真实宿主不支持时保存版本/复现证据并回报用户重新决策，不自动切换到 A/B/C。未实测时标未验证，不声称健康图标实机正常。

### 3.2 健康数据与缓存：未来候选，当前不实施

以下 v2、缓存、未知态及数据语义是历史设计参考，不是对当前 driver/v1 已具备能力的断言；本次没有授权实施。未来如有独立需求须重新立项并取得用户同意；涉及替换现有行内 driver 的迁移仅在宿主实际不支持、带证据重新决策后考虑。

- **候选主键是 workspaceId，不是 Session/title/path**。未来可研究使用公开 `useWorkspaces` snapshot 的 `items[].workspaceId/sessionIds` 做授权可见范围的交集；列表 `phase=pending` 先 `loading`，错误不可当空列表。目标是 0 Session 的已注册 workspace 仍显示、多 Session 共享一个 workspace 状态；临时/未分组 Session 没有可信 membership 时显示 `unbound/unknown`，不将 active/global workspace 猜给它。重复名称不能串行配对，registry 消失/ID 复用必须撤销旧值。当前实现仍按现有逻辑运行，不声称这些未来语义已实现。
- **现有 v1 的真假不足**：W `insuremo-service/src/overview/workspaces-status.ts:50-87` 在 binding/service 缺失或异常时返回空/false，最多 100；`workspace-binding/src/service.ts:166-195` 的检测异常也会变 false。因此仅缓存旧 Boolean 无法区分“确实没有”与“读取失败”，也不能把截断等同完整列表。
- **候选向后兼容 v2 投影**：在插件 Host 内新增版本化响应（或兼容扩展字段，具体路由命名由实施卡定），每个 workspace 包含字段级状态：检测 `detected/not-detected/unknown`，绑定 `bound/pending/none/unknown`，graph/explain `ready/not-ready/unknown`，以及整体 `loading/ready/error`、只读时间戳/版本和 `complete/truncated`。只有源明确证实才能输出 not-ready；数据源没有区分能力时为 unknown，而非伪造 false。要在现有 workspaceBinding 检测与诊断源增加内部错误区分/取消传播，或暂时保留 unknown；新响应不向 Client 返回 canonical path、auth、token、原始错误或日志。
- 旧 v1 endpoint/字段及行为先保持给冻结 Client；新 Client 与新 Host 用能力/响应版本检测，旧 Host 的 false 与缺条目显示 unknown，已证实的 true 可按定义显示，旧结果标注版本/不完整。数据安全及权限不得比现有 route 更宽；`>100` 必须显式 `truncated`，可以在后续批准分页/针对合法 workspaceId 的查询，不把前 100 假称全部。
- **单 Client activation 的共享缓存**：一套按 endpoint/版本 + workspaceId + 插件 activation generation 分区的 store，多个面板/Session 共享同一批量 in-flight fetch；维持现有最多 60s 的刷新节奏作为起始 TTL 候选，而不是每行 60s 独立轮询。只缓存脱敏投影；首次 loading；失败保留有时间戳的 stale last-good + 明确 error/重试，不把 stale 当即时成功。
- workspace 列表/权限/身份变化、已知绑定/graph/explain 操作完成和用户手动刷新触发失效；若缺少可靠事件，TTL + 可见时重验证作为最终兜底，避免宣称所有变化即时捕获。逐项检查 Host 是否真的提供所需公开事件，不订阅 `internal/*` 冒充稳定接口。
- 单个订阅者卸载不取消其他消费者的请求；最后订阅者消失、插件卸载或目标 generation 改变时 abort 共享请求并丢弃过期响应。传递 AbortSignal 给支持的 Host 读操作；不支持取消的下游仍须 generation guard，避免旧结果写回。监听器/计时器均有 disposer，错误重试有退避上限；若 `workspaceBinding.list` 不能保证完整顺序/可见权限，应将此作为实现阻塞，不靠标题兜底。

## 4. Host 资源、导出与依赖

### 4.1 路由所有权（C-05）

现状 `insuremo-service/src/overview/route-service.ts:36-60` 的 `#disposers` 只收集，`safe()` 吞重复异常；H2/H5 `host/webserver/src/index.ts:360-373` 的路由表只返回注销函数，不自动替调用方消费。TASK-160 时仅属源码风险；TASK-162 用真实 H2 WebServer 和 W service 的**隔离直接挂载**复现 await unload 后旧路由残留，见 §8 B00；尚未证明真实 loader/HMR 泄漏。

候选最小修复：在 `InsuremoRoutesService` 的真实 owning fiber 上，用一个可见的 `ctx.effect`/同步 generator 对每个注册立即收集该次取得的 disposer；setup 第 N 个失败时逆序撤销前 N−1 个，原始错误以脱敏诊断向上传播，不把“重复路由”当成功，绝不删除其他 owner 的同名路由。W `overview/write-routes.ts:205-212` 当前把多个注册包成一个返回值；若内部中途抛错，外层尚未拿到组合 disposer，故须在其内部实现逐个收集与失败回滚，或提供逐项 registration 给同一 generator；仅在外层包一次 effect 不足。

保留现有路径、方法、Origin/CSRF 和功能。验收包括：真实 H2/H5 Cordis + 真 WebServer/或等语义严格 fake，先注入第 N 个失败、无遗留；正常启用后等待历史提及的 25–30ms 窗口仍有路由；`await dispose` 后同一测试服务调用旧 URL 无旧 handler；重装时恰一份且指向新 generation；无关路由保留；重复冲突 fail loud。`route-service.ts:21-28` 记录了历史 effect 被过早 sweep 的观察，必须在真实 loader/依赖消失恢复中证伪/解决，不能以“改成 effect”就认定安全。若真实场景不能保证，暂停改造而不是删除现有保护。

### 4.2 工具/提示词清理（V-03）

证据边界：核验 §5 的真实 H2 Cordis + 模拟表只证明 `internal/plugin` 与 effect 自动卸载的**同步释放时序不等价**；直接同 turn 注册可遇冲突，最小 `ctx.plugin` 重装未复现冲突。H2 `packages/core/tools/src/index.ts:734-749,1065-1095` 同一 scope 重名抛错，`system-prompt/src/index.ts:470-485` 也检查同层重复；这不等于现有真实 HMR 已失败。

**公开路径能保证什么**：`ctx.tools.register` 和 `ctx.systemPrompt.section` 返回各自的精确 Cordis effect disposer，`ctx.effect` 支持 generator 逐个 yield disposer、失败回滚和逆序释放（H2/H5 `vendor/cordis/src/fiber.ts:355-382,402-413,418-536`；H2 `packages/core/tools/tests/tools.spec.ts:2088-2109,2134-2153`）。重构注册边界为逐项、事务式收集；当调用方先调用组 disposer 并等待其完成，或 `await fiber.dispose()` 后再注册，可以建立**已释放后再重装**的公开保证。新增 owner 提供幂等 `close`，插件可控的显式替换流程先 `close`/await，再装下一代；取消/部分失败只释放自己取得的句柄，不用全局删除或吞重名错误。

**D2 的兼容边界**：本轮按已证实的现有释放语义实施，不以仅 await 后释放冒充同 turn 同步释放，也不假设 module-local 锁跨 HMR generation 共享。TASK-162 在真实 H2 ToolRuntime/SystemPrompt 上观察到当前 Workbench listener 同 turn 释放、普通 effect 直接重注册存在 duplicate 窗口；这不等于真实 HMR 已失败。`internal/plugin` 不属于 `EX-WH-01`：TASK-164 若找不到可证实等价的公开替代，必须 BLOCKED 升级，不简单删除监听、不私自把保留监听标为第二项已获例外，也不能把“只补测试”当完成修复。

在真正移除前，H2/H5 各运行真实 ToolRuntime/SystemPrompt 的：normal unload、依赖撤销/恢复、plugin HMR、同 turn 直接注册、未等待与等待 dispose、新旧 generation、注册第 N 项失败/重复、被其它 owner 占用、多个 prompt/tool 不重复，以及 25–30ms 延迟观察；报告绝不把 fake 结果当真实 HMR。若有 async disposer，显式等待其结算；引擎/管理器不能实现必要串行时禁止发布。

### 4.3 独立与 aggregate：保持现状的统一形态（C-03、V-04/V-10）

| 路径 | H2/H5 loader/registry 实际选择 | 要保持的现状 |
|---|---|---|
| bundle patch → `@icomposer/insuremo-service` | loader unwrap `default`，选择 `ImoCliService`；静态 `inject=['subprocess']`、`Config`（另合并该 patch 行的 inject） | 仅因 default 类提供的 `imoCli` 及其 Config；不把 settings、auth、routes 等当成此路径已启用。 |
| `WorkbenchDistService` → `ctx.plugin(insuremoService namespace, config)` | registry 选择 namespace 的 named `apply`；按依赖/服务条件挂载多服务与可选 settings | 保留 `imoCli/imoUpgrade/imoInstall/imoSkills/imoAuth/imoActiveProfile/imoAuthActions/imoOverview`、activation/actions、routes、skill provider/mask/profile context 和 settings optional child 的现有挂载顺序/依赖；不保证不可用服务已运行。 |

**推荐兼容形态**：保留 package root 的 default `ImoCliService`，把原完整 apply 移成内部具名 mount helper，由一个**单独内部对象插件**持有原 `name/inject/Config/apply` 并在 aggregate 明确传给 `ctx.plugin`；root 不再同时暴露顶层 named `apply` 与 default 类。这里的对象是 Workbench 内部设计，不是新 Host API；其函数引用、Config、注入、父子 fiber 所有权和 await 行为均须回归。独立路由仍只装 CLI；如用户期望独立包也具备完整服务，那是**新增能力/依赖与可能副作用变化**，另行决策，不能当删除 default 的无风险结果。

聚合默认类目前没有 static inject，module namespace 的 named `inject` 被 unwrap 后不会自动应用。建议单一来源生成 `WorkbenchDistService.static inject`：**先等于现有 dist patch 的 10 个根依赖**，并验证所选类的注入表；保留子 `IcomposerVerifyToolService.static inject=['tools','systemPrompt']`。D3 已选兼容现状，**不把 `systemPrompt` 加到根硬依赖**：当前它只在 named 列表/子服务中，提升到根可能把原来可用的其他功能一起停掉；覆盖“缺 systemPrompt 时其他功能仍可用”的对照，任何进一步能力扩张须另行决策。patch 与实际类 inject 校验为同一来源/明确差别，勿假设两个 namespace 名单总会并集。

## 5. 真实配置、展示与 peer（V-05/V-06/V-12/V-13）

### 5.1 可校验的嵌套 Config

`WorkbenchDistService` 被 loader 选中，因此将 `static Config` 绑定到真正的聚合 schema；仅 `export const Config` 在 namespace 上不足。四个字段均为**可省略的对象**而非 `any`；不能把新 schema 的默认对象无条件展开并改变现有子服务 Config 的默认/生命周期，先做旧/新输入与有效输出 golden 对比。示意为字段合同，而非已存在代码：

| 字段 | 已有默认/目标校验（实施前对现网已存在配置做迁移核对） |
|---|---|
| `lifecycle`、`verify`、`write` | 各复用/抽出同一个 `command?: string`、`timeoutMs?: 正整数`子 schema；缺省行为为 `imo`、30,000ms（各 `service.ts` 构造器）。校验字符串非空、无 NUL/控制字符，timeout 有限整数、至少 1；建议上界不超过 Node 可安全表示的定时器范围。允许带空格的合法绝对路径；不把命令当 shell 字符串执行。以前未校验的非法值可能被拒，需预检与变更说明。 |
| `insuremoService` | 复用 `packages/insuremo-service/src/config.ts:34-59` 的现有 `Config`，不再抄一份：`command=imo`、`timeoutMs=15000`、`skillActionTimeoutMs=180000`、`upgradeTimeoutMs=180000`、`smokeCommands=DEFAULT_SMOKE_COMMANDS`、`allowedGitHosts=['github.com']`、`overviewTtlMs=0`、`skillOverlayEnabled=true`、`skillOverlayNames=['insuremo-auth-cli']`。正整数/数组元素类型和实际名称校验须与现有逻辑对齐；现行 resolve 对 skill timeout 上限 300000、overview TTL 上限 5000 是**归一化 clamp**，不能悄悄变成拒绝或改变默认。 |
| 嵌套数组/输入安全 | `smokeCommands` 是二维 argv、不是 shell 命令行；`allowedGitHosts` 为主机名数组，保留现有精确 HTTPS host 校验；`skillOverlayNames` 复用现有名称/重复/数量校验。增设长度与安全边界需比较既有配置并获得兼容性批准。仅验证字符串/数组形状**不能证明 smoke 是只读**；任何更严格的命令 allowlist 是另行评估的安全策略改变，测试绝不执行真实 upgrade。 |

已核实 H2/H5 `vendor/schemastery/src/index.ts:805-822` 的 object resolver 在非 strict 时合并未知键，**不能假定 `Schema.object` 自动拒绝未知键**。推荐首批兼容策略：已知字段按上述类型/边界 fail closed；未知 root/嵌套键暂保留原行为并发**不含值**的迁移警告，字段名只允许有界安全字符，否则脱敏/摘要，防止将秘钥写在键名时泄漏；在隔离环境列出受影响配置后，由用户决定未来版本是否显式 strict reject。若开启 strict，须在 loader 可见的真实 validator 中逐层检查 own keys、返回定位错误，先证明 `Config.listConfigs` 的 schema 表达与运行时一致；不能仅依赖未验证的 `.strict()` 或 silently strip。配置不合法时不要先部分挂服务/路由再失败；禁止在日志中输出配置值/secret/命令参数。覆盖 `{}`、部分覆盖、缺失字段、错误类型、0/负数/非整数/溢出、clamp 边界、未知字段、nested 错误、数组上限、旧配置 golden、settings/standalone/aggregate 与错误回滚。

### 5.2 资源、peer 和键

- 补包级 `locale/en.json`、`locale/zh.json` 的 `meta.title/description` 和原创/有授权的 icon；manifest 保留运行时 exports 并公开 `./locale/*.json`、`./icon`。核对有效格式、相对包内、无越界 symlink、≤256 KiB、真实渲染；页面 PNG 与插件 icon 分开。H2/H5 `host-plugin.md:29-55` 的例外只能显式记录。
- W `scripts/dist-payload.mjs:203-235` 目前只复制 `lib/`、patch、README，**修改 `files` 不会自动把新资源加入 git-dist materialization**。未来需同步 staging 复制、测试 actual tarball 与 git-dist 的文件清单、bytes/许可/locale fallback，避免源码有而分发缺。
- `peerDependencies` 先按 Host 实际静态/动态 external、插件 manager 的解析、React 单例分组建表，再对 H2/H5、npm/pnpm 干净隔离安装验证；客户端通过 module table 供应不等于 npm peers 自动满足。按证据收敛而非按“Host-only 示例无 dependencies”一键删除；`@icomposer/workbench` 服务键暂不改。

## 6. 兼容策略、真实类型与构建

### 6.1 当前证据矩阵（不是未来支持承诺）

| 环境 | 已实测 | 仅静态/自报 | 尚未验证 |
|---|---|---|---|
| macOS + rc.2 | 本机 Desktop app.asar 报 rc.2；`pnpm check`、4 包 scoped **shim** noEmit；TASK-162 隔离 H2 源码 Cordis/Loader/WebServer/Tools/SystemPrompt 基线（非完整 App） | H2 源码/manifest、当前 W git-dist 静态 require；本机已构建部分 H2 d.ts | 真插件页面 materialize/视觉、隔离安装/升级、全量构建与测试；不是兼容 PASS |
| macOS + rc.5 | 无 rc.5 实装测试 | H5 tag/源码与官方 npm 包声明/样本 d.ts（§6.2） | rc.5 App、Host、client materialize、UI、安装升级均待测 |
| Windows + rc.2 | 无 | 同一 H2 源码可静态阅读，不等于 Windows 行为 | Node/pnpm 启动、安装升级、Host/Client 与视觉均待 Windows 实机 |
| Windows + rc.5 | 无独立复测 | 原报告对另一机器现场的自报；H5 源码及 npm 样本 | 原报告值不代替复测；模块 materialize、UI、安装升级及跨平台检查均待测 |

除 `EX-WH-01` 外，候选能力按 **公开 slot 声明与实际组件 mount、公开服务存在/响应版本** 分层检测；slot 通过 `slots.inject` 管理声明生命周期，overlay 以 mount ack 为准，不通过产品号或 `require` 试探伪造可用。对于现有 WorkspaceHealth，不以缺少等价 slot 自动迁移、关闭或替换：保留当前做法；若升级后实际失效则保留证据并询问用户。API 兼容是 H2/H5 **逐功能**支持，不能因为一种能力存在就跳过其他门禁。

### 6.2 真正声明与 preset 的可得性（V-07/V-08）

除 H2/H5 源码/manifest，本次只读从 npm 官方 registry 下载下列版本化 tgz 到 `/tmp/workbench-type-evidence.r6dZj4`，**未安装**：

| 包 | rc.2 tarball SHA-256 | rc.5 tarball SHA-256 | 两包中实际检查到 |
|---|---|---|---|
| `@deepseek-ai/dsh-client-ui-slots` | `11df5ddaa69724017aba11dd7de88258d31ca9ce90f201ec056e6e2ac511ee35` | `efb0485d955b104af95f0d02479366a3f09248fe9b1e661a2afa38d23ad2e42b` | `lib/types/index.d.ts` |
| `@deepseek-ai/dsh-client-ui-workspace` | `07e04cf62f9f1584257c0872d3bb4551497f6058868eb1f3b61c9115eb6d4745` | `fe2a292f446c807c7d6f8d6210526846d1225f2d893d760c4e43739e2179e30a` | `lib/types/client/index.d.ts`、`client/contract/slots.d.ts` |
| `@deepseek-ai/dsh-api-workspace-controller` | `5dbfd90c5b03dc60fc962299a23e0f1a86f571f25d4675dce25becc928d33b6a` | `1dc62f0605ef60d4ff1ed41284417abb881ed785c3ad1551c98ff77c9b62319a` | `lib/types/types.d.ts`、`client/index.d.ts`、`client/model.d.ts` |

对应源码 `package.json` 的 `exports` 指向这些 `lib/types`（H2/H5 `packages/client/{ui-slots,ui-workspace}/package.json`、`packages/api/workspace-controller/package.json`）。H2 本地已有 slots/workspace 部分 d.ts，但该 controller 的目标声明本地缺失；H5 原始源码归档没有构建 `lib`。npm tar 的**文件存在**不等于全部传递声明、安装解析、API 行为或 rc.5 兼容已通过；其他 Host/Client 包也须逐个核实其发布工件及依赖闭包。

`packages/client/tsdown.client.ts:1-25,98-135` 在 H2/H5 源码导出 `clientBundle`，但它依赖源码内部 manifest、platform、多个 scripts；对两版本仓库所有 `package.json` 搜索没有 `tsdown.client/clientBundle` 导出引用，`packages/client/web/package.json:16-27,48-53` 只列 `.`、`./injections`、`./src/*` 等，所检查 npm `dsh-client-web` 两版本 tgz 不含 `tsdown.client`。因此**尚未发现可直接作为稳定公开 npm 子路径使用的 preset**；不是宣称整个生态没有任何 build 工具，也不能把单个 TS 文件复制为无依赖预设。

实施方案：

1. 建独立 rc.2 与 rc.5 契约测试工程，从**验证过的真实 d.ts 及其依赖闭包**编译 slot props、`useWorkspaces`、服务方法、registration options、schema 与 dispose，固定 TypeScript 版本/锁文件；使用 `strict`、不靠 `any`/`unknown as` 绕过，输出 `--traceResolution`/`--listFiles` 证明确实加载目标版本声明而非 W shims。必要时测试从真实类型到插件消费接口、回调参数方向及反方向的赋值与反例；暴露不兼容而不是自动降级类型检查。
2. 如生产包因依赖/分发限制仍需**最小本地协议类型**，只保留实际使用的结构，单独列字段来源与目标版本；每个版本的真实声明与其双向/适用方向的编译契约测试必须绿。一个替换名称的新 shim 不能当作解耦完成；官方 d.ts/依赖不可得时门禁阻塞并报告，不能绿灯。
3. 构建首选确认上游真正公开、可版本化的构建工具；目前证据不足，备选为本仓库**自行维护**最小等价 factory-format 构建适配器，不默认复制庞大内部 preset。若确需 vendoring，记录 LICENSE、来源 commit 和依赖闭包，做 H2/H5 产物/slot/CSS/assets/热卸载行为对照。固定 pnpm/Node/tsdown/lightningcss 等及 lockfile，在两个隔离绝对路径重复构建比较 canonical payload 与 sourcemap/secret 扫描。构建适配器、真实声明验证和支持版本是不同问题，任何一项成功都不自动通过其余项。

### 6.3 安全跨平台 pnpm 校验（V-09）

推荐默认**不启用 shell**。先区分外层 PowerShell/cmd 启动的 pnpm shim 与 Node 内待启动的目标；当受信任的 `npm_execpath` 是可核实属于 pnpm 的绝对 JS 入口时，使用受信任 `process.execPath` + 固定 argv `--version`，不拼命令字符串；`npm_execpath` 缺失、指向 npm/Corepack 未验证脚本、相对路径或任意用户可控 `.js` 时不能盲目执行。可用可信的本地明确 pnpm JS 入口或经过身份/来源校验的原生 `.exe`，并区分“不存在/不可执行/版本错误/超时”。若仅有 `.cmd` 且无安全可信入口，给可操作的失败诊断，**不把风险悄悄降级为 PASS**。是否追加固定 `cmd.exe /d /s /c` fallback 是后续决策：只有严格固定命令、完整引用/参数安全与 hostile path 测试过关才可采用，绝不接受用户内容拼接或全局 `shell:true`。

矩阵：macOS/Linux 直启、Windows cmd 与 PowerShell，pnpm `.cmd`、原生 `.exe`、正确 JS、缺失/非 pnpm/恶意 `npm_execpath`、Node 22/24（项目支持范围内）和含空格、`&`、`^`、`%`、引号等路径；断言固定 `--version`、无命令执行、无 token/环境变量泄漏、错误诊断准确。Windows 未实测，本任务不把报告的单次失败泛化为所有启动方式。

## 7. 可复现交付与回滚门禁

1. **离线静态链**：固定 W commit/依赖锁/候选 build adapter 和 H2/H5 对照来源；类型对照、lint（如配置）、单元/合约测试、client AST/metafile allowlist、host external/peer 清单、schema/locale/icon/许可证、路径和敏感数据扫描。按 §1 的 `EX-WH-01` 识别已有调用点，防新增/扩大的 DOM 侵入；已存在但不属于此例外的 BrandChrome/Picker/内部事件分别报告，不能因未改而称为用户已接受。分范围可验收，整体规范结论仍保留偏差。真实 d.ts 不可用时不能以 shim PASS 顶替。
2. **可复现产物**：在隔离工程建立两个不同绝对路径（不能指向用户工作目录或 real HOME）构建，比较 canonical Host/Client/CSS/图片/hash；factory ID 等于 package name、延迟执行副作用、CSS 及资源生命周期、React singleton、原有 `workbenchRelease` 与 exports。版本差异要可解释，不能修改当前冻结 payload 来“通过”。
3. **`git-dist` / pack**：测试以候选源构建新目录再对比跟踪的 git-dist，验证 drift gate 确能识别每类差异；检查 tar 文件清单、locale/icon/许可证、无文件丢失和无 `file:/workspace:` 泄露。当前 `check:git-dist` 实际先重建共享 `packages/icomposer-workbench-dist/lib`，未来也仅在隔离工作树且 single-writer 执行。不能将 HTTP 200 当作文件执行成功。
4. **隔离安装/materialize**：用户已授权在后续相应任务中进行隔离验证，使用专用 HOME/USERPROFILE、DSH_HOME、临时 registry/fixture 与无真实 IMO/Skills 写操作；对候选 tar、git-dist/实际安装形态分别安装并启动独立 Host，验证 H2、H5 各 slot 注册、真实 Client factory 执行、控制台错误、设置/Picker/ICI 卡及原 Workspace 分组行健康图标可见、原位置不变、无重复、卸载/重装清理。组件测试与服务 HTTP 只作前置。无 `cua_repl` 则 UI 标未测，不用 CDP 替代；UI 未测不虚报该项通过，也不把 B06 迁移当作其他已批准独立修复的前置。
5. **回滚**：发布前归档旧可验证版本/manifest/hash、候选工件与安装引用；先在隔离 profile 验证从候选恢复旧工件和数据读取，不更改用户 state。未来由获授权发布角色在用户确认后切换**新的候选通道/引用**，必要时切回旧已验证 artifact；绝不强推或覆盖本轮冻结分支。任何生命周期/配置迁移需证明旧版可读或给出显式不可逆提示，失败不升级。

## 8. 实施映射与依赖（按 BOARD 串行）

`DESIGN-B00/B01/B02/B03/B04/B07/B05/B08/B09` 依次对应 BOARD `TASK-162/163/164/165/166/167/168/169/170`；B06 健康迁移与 v2/缓存 deferred。用户已授权这些范围的本地实施、隔离准备/验证和独立 PASS 后本地提交，但**只启动当前 TASK-162**，每卡 DEV→VERIFY→COMMIT→DONE 后才进入下一卡。所有真实外部写为零，不能改 `compatibility.json` / engines / 冻结 refs；不 push、不发布、不安装到用户环境。保留旧工件与未跟踪用户资料，TASK-170 前 `git-dist` 明确未同步。

### DESIGN-B00 — 建立不写用户状态的行为基线

- **目标/回链**：先观察 C-05、V-02/V-03/V-04、U-01～04；对旧新各自的输入和可见行为建立比较基准。
- **范围文件**：候选 `test/compat/`、`packages/insuremo-service/test/`、`packages/icomposer-verify/test/`、`packages/icomposer-workbench-dist/test/` 下的隔离 fixture/test harness；必要的测试配置。**非目标**：改生产代码、修 Harness 缺库、启动用户 App、对真实 IMO/Skills 写、声称 rc.5 支持。
- **验收证据**：`node test/compat/run.mjs` 使用隔离 HOME/DSH_HOME 与 H2 源码真 Cordis/Loader/WebServer/ToolRuntime/SystemPrompt，运行 8 项基线；fixture/fake 边界、临时源码别名、精确命令和清理见 `test/compat/README.md`。独立/aggregate Loader、真实工具同步与 await 释放，以及健康 driver/footer 的源码防误删分别验证；不执行真实 CLI/Skills 写。实机 UI、H5 与 Windows 均未验证。
- **已知观察（非长期正确性断言）**：H2 真实 WebServer + W `InsuremoRoutesService` 直接 `ctx.plugin`，40ms 后 overview 返回 200 `{}`；await owner dispose 后仍为 200、同路径直接注册 duplicate，而无关 owner 路由仍 200。重挂 fiber 保持 active；此隔离直挂结果为 C-05 待修复证据，不外推 loader/HMR。TASK-163 应复用 fixture 改为正确清理断言；测试不能要求“必须泄漏”。
- **回滚**：仅移除经审查的本卡测试与隔离 fixture，不触碰真实 profile；**待决**：H5/Windows 环境及真实页面能力，不能用源代码映射冒充真实声明契约。

### DESIGN-B01 — 路由注册/释放事务

- **目标/回链**：C-05 的明确 owner、失败回滚与不吞重复错误，见 §4.1；依赖 B00。
- **范围文件**：`packages/insuremo-service/src/overview/route-service.ts`、`write-routes.ts` 必要的注册封装及 `packages/insuremo-service/test/*route*`。**非目标**：改变 URL、HTTP 安全门/业务操作、工具生命周期或 Host core。
- **验收证据**：逐项注册中途抛错回滚、重复路由 fail loud且不删其他 owner、等待 25–30ms 不掉路由、await unload 后旧 handler 不可调用、重装准确一次且新 handler 生效；有/无依赖及新旧 generation 均测。实测前不得把现网风险当已复现。
- **回滚**：选回上一版插件工件；若现有旧 handler 已残留，需在隔离环境验证受控停止/重启路径，不能靠删除别人路由。**待决**：历史 effect sweep 的重现和修复成立条件。

### DESIGN-B02 — 工具/提示词释放语义

- **目标/回链**：V-03；依赖 B00 与真实 ToolRuntime 证据，逐项事务/幂等/显式 await，维持已定义可见语义。
- **范围文件**：`packages/icomposer-verify/src/{tool-service,tools,tool-defs,ici-tools,ici-jobs-tools,ici-explain-tools,ici-search-tool}.ts` 的必要注册结构及对应 tests。**非目标**：改变 tool 名称/schema/行为，声明 HMR 必坏，修改 Cordis core。
- **验收证据**：真实 H2/H5 tools+systemPrompt 卸载/依赖消失恢复、重装先后、无论第 N 个注册失败都不泄漏、重复不覆盖他人；同 turn 与 await 两种时序单独断言，输出实际可保证边界。**只有**公开机制保持当前已证释放语义且真实热重装通过，才移除 `internal/plugin`；否则 TASK-164 必须 BLOCKED，不能把监听当已授权例外或仅加测试后宣称修复。
- **回滚**：恢复原注册/监听代码及旧工件，避免新旧代同存；**待决**：能否证明公开路径维持已观察的同 turn 与 await 释放语义；无法等价时升级 planner，不能默认改宿主。

### DESIGN-B03 — 出口选择与根依赖真实性

- **目标/回链**：C-03/C-06、V-04/V-10；依赖 B00。以 §4.3 的 default CLI + aggregate 内部完整对象插件维持两路语义，class static inject 与 patch 按实际生效对齐。
- **范围文件**：`packages/insuremo-service/src/index.ts` 与拟新增内部 mount helper、`packages/icomposer-workbench-dist/src/index.ts`、两份 patch/对应 tests。**非目标**：默认把独立 CLI 扩展为全服务、删除现有服务、将 systemPrompt 擅提为根硬依赖、改 Host core。
- **验收证据**：通过真实 loader 而非仅 `ctx.plugin(namespace)` 分别测试独立 default 与 aggregate，列出预期 service/Config、settings 有/无及卸载；真实 loader 选中类的 inject 恰预期，缺 systemPrompt 时子工具及其他实际依赖按各自状态等待，未依赖它的根功能不因新增硬依赖被整体停用；不假设深层服务必然可用。旧 golden 配置/调用不变。
- **回滚**：恢复原入口及 patch 的一致旧工件；**待决**：无本轮 D3 分支，已决定保持独立 CLI/aggregate 能力差异和子级 `systemPrompt` 依赖，不提升根硬依赖；扩展独立包能力需另行决策。

### DESIGN-B04 — 嵌套 Config 真校验

- **目标/回链**：V-05；依赖 B03。把 §5.1 的四类实际字段装到 loader 真正选中的类 `static Config`，复用 Insuremo schema/默认并执行兼容未知键策略。
- **范围文件**：`packages/icomposer-workbench-dist/src/`、`packages/{icomposer-lifecycle,icomposer-verify,icomposer-write,insuremo-service}/src/` 的必要 schema 与配置测试。**非目标**：四个 `Schema.any`、静默收窄用户数组、修改真实用户配置或执行 smoke 升级。
- **验收证据**：旧 `{}` 与合法覆盖的 effective values 逐字段对照；边界/坏类型/溢出、clamp、未知键 warning 不含值、strict 决策、schema inspect 与实际 loader 一致；无部分服务/路由残留。使用 fake subprocess，零外部写。
- **回滚**：保留旧接受配置路径和旧工件；**待决**：无本轮 D4 分支，已决定保留现有默认、clamp 和未知键兼容，错误不泄露值；未来 strict 或更严格 smoke allowlist 属额外策略，需另行决策。

### DESIGN-B05 — 本地 UI 基元、Picker overlay 与品牌

- **目标/回链**：V-01/V-02/V-11、U-02/U-03；依赖 B00、B07 类型/构建门禁；按 §2 本地化完整值依赖并切换公开 `shell.overlay`/正规品牌 slot。
- **范围文件**：`packages/ui-insuremo-status/src/client/`、`packages/ui-workbench-jobs/src/client/`、相关 tests、许可/资源清单；不擅增 Settings 替代入口。**非目标**：改变 Profile 写入语义、靠 portal 改宿主 DOM、移除或改写 WorkspaceHealth 现有 driver/状态轮询/分组行位置、移除其 footer 健康挂载、改宿主 core。TASK-168 可替换 Tooltip 值依赖，但不得改变 driver 及图标行为；如确需触及 driver 先 BLOCKED。
- **验收证据**：经批准的 client 基元替换不再 require Harness Client 值模块，含 Picker 的 MenuSurface/两个 hook 行为；实际 H2/H5 页面验证窄 rail 定位、frame clipping、明暗/焦点/Escape/外点/目标切换/卸载/slot collapse；Picker trigger/overlay 与经处理的品牌组件消失后无其自身 listener/DOM 残留。品牌缺槽保留宿主原样；若处理 `BrandChrome`，独立断言 WorkspaceHealth 及 footer 注册仍存，原分组行图标可见、位置不变、无重复并在卸载/重装后清理。无法实测则该项未验证。按 §1 精确允许 `EX-WH-01`，局部通过不代表零 DOM 注入或全插件规范合规。
- **回滚**：选回旧工件/停止候选，不覆盖冻结分发；**待决**：overlay/brand slot 缺失时如何保持现有交互、组件及图标许可；不能擅增 Settings 入口，无法保持交互须 BLOCKED。

### DESIGN-B06 — Workspace 健康未来候选（deferred）

- **目标/回链**：V-02、U-02/U-03；本轮不启动、不作为其他经批准独立修复之本地验收前置；发布仍需另授权。按 D1 保留现有 driver；只有未来宿主实际不支持、取得版本和复现证据并由用户重新决策/授权后，才考虑行内展示迁移。§3.2 的 v2/缓存仅为未授权未来候选，任何数据改造也需另立项授权。
- **范围文件**：仅在未来重新立项后再定，候选为 `packages/insuremo-service/src/overview/workspaces-status.ts`、`packages/workspace-binding/src/`、`packages/ui-insuremo-status/src/client/` 与状态合同/测试。**非目标**：当前移除或改写 driver、把健康图标移至 Settings/独立面板/Session、默认请求修改 Harness、擅改真实用户目录。
- **验收证据**：本轮不实施；未来若用户另授权，先复现真实不支持并记录原位置、渲染、重复和清理，再依据当时用户选择重列验收；若另行批准 v2，才验证 `unknown/error/truncated`、v1 兼容及缓存取消，不能把候选能力写成已实现。
- **回滚**：未来候选须能恢复原 v1 和已验证旧工件，不触碰真实用户 profile。**待决**：未来实际失效后的用户新决策、v2/缓存及隐私权限是否另行授权；当前 D1 已决定，不再重复询问 A/B。

### DESIGN-B07 — 真实类型与可重复 Client 构建

- **目标/回链**：V-07/V-08；按 BOARD 串行，TASK-167 在 TASK-166 之后启动；为 B05 等经批准的独立修复建立真实 H2/H5 类型/工件门禁，B06 当前 deferred。
- **范围文件**：独立契约测试工程、`tsconfig.base*.json`/包级类型映射、`scripts/` 中拟议 build adapter、四个 `tsdown.config.ts`、必要的 dev dependency/lock 更新（仅在对应 TASK-167 执行，当前 TASK-162 不改）。**非目标**：擅升 pin/engines、把新 shim 当真 d.ts、复制全部 Harness 内部脚本、在用户当前 checkout 直接删除产物。
- **验收证据**：两个 npm 版本及依赖闭包实际声明可解析，严格编译无 shim 命中、正反例/调用点校验；源码/目标工件有效许可证；两个不同绝对目录可复现 factory、Host/Client、CSS、assets/hash，插件注册/销毁与旧构建对照；生成物无第二 React。任一 H5 闭包缺失则标 blocked 而非自制类型绿灯。
- **回滚**：在候选分支撤回 adapter/锁文件，继续使用冻结 H2 构建链；**待决**：上游 build helper 可用性、vendoring/第三方许可证和真实 d.ts 与代码的差异范围。

### DESIGN-B08 — 跨平台校验与依赖 allowlist

- **目标/回链**：V-01/V-09/V-11/V-12；依赖 B07 生成可检查工件。改进 pnpm 校验与 client/host external 报表，不冒充实际运行验证。
- **范围文件**：`scripts/check-compatibility.mjs`、新增 `scripts/` AST/metafile 审计、跨平台安全测试与对应 CI 配置；必要时 `packages/icomposer-workbench-dist/package.json` 的已证明声明。**非目标**：全局 `shell:true`、未经安装证据批量删 peer、升级兼容 pin/engines。
- **验收证据**：§6.3 Windows 启动/恶意环境与特殊路径矩阵 + Mac/Linux；不执行攻击 payload，错误分类不掩盖；对 `react-dom/client` 建立 §1 的 `EX-WH-01` 源码调用点与 DOM 策略基线，利用 AST/产物来源映射将**被用户接受的白名单**限定为该既有 WorkspaceHealth 路径，拒绝新增/扩大的调用点或 DOM 注入；来源不可证明时标未验证。此规则不假称其他既有调用点不存在：现存但不属例外的 BrandChrome、Picker 等在未处理时各自标为未解决项，不作为用户接受的白名单。可对与其无关的获批变更分范围验收，但不能把存在这些项的全量静态检查称为完全合规 PASS。测试禁止值模块、注入次序变化、type-only 假阳性及真实健康图标可见/位置不变/无重复/清理。**分范围 gate 可在披露例外后验收，B06 非前置；不称全插件零 DOM 注入或完全合规。**
- **回滚**：撤回 gate 与候选脚本，不改变真实用户环境；**待决**：Windows runner、可信 pnpm 入口发现策略、受控 cmd fallback 是否必要。

### DESIGN-B09 — 显示资源与隔离分发验收

- **目标/回链**：V-06/V-12、U-04；依赖适用的 B07/B08 等门禁，**B06 非前置**。隔离安装/回滚测试已在 TASK-170 范围内获授权；push、发布或用户环境安装仍需另授权。其他获批独立修复可分范围本地验收，必须披露 `EX-WH-01` 的规范偏差/升级风险及其他未解决项，不能标为全插件完全合规。
- **范围文件**：`packages/icomposer-workbench-dist/{package.json,locale/,icon...}`、`scripts/dist-payload.mjs` 及 pack/git-dist/资源测试、必要的许可证与使用文档。跟踪 `git-dist` 更新仅在 **TASK-170** 执行；在此前保持冻结并披露分发未同步。**非目标**：重写冻结分发分支/refs、重启或安装到用户 App、修改 user home。
- **验收证据**：英文/中文 title/description、合法 icon 及归属在 staged git-dist/tgz 中实际存在；两个路径构建零漂移、pack 清单与安装解析，按授权范围进行 H2/H5 隔离客户端真实 materialize 与 §7 回归；定向验证原 Workspace 行图标可见、位置未变、无重复及卸载清理。无法跑 UI/Windows 不得宣称对应 PASS；出具 `EX-WH-01` 和其他未解决项，按范围报告而非宣称全插件合规。旧 artifact/hash 和隔离回退经过验证。
- **回滚**：停止候选并使用旧已验证工件，不 force/覆盖冻结通道；**待决**：图标权利、候选发布版本/通道及任何实际发布授权；隔离安装和回滚测试已获授权。

## 9. 决策、阻塞和验收顺序

1. **D1 已决定**：保留 Workspace 行内图标原位、observer/root/footer/轮询和交互，标注唯一功能冲突 `EX-WH-01`；不迁 Settings/面板/Session、不新增宿主 slot。B06 deferred；未来实际不支持时带证据回报用户，不自动迁移。
2. **D2 兼容默认**：保现同步释放语义优先。公开机制无法等价保持同 turn 同步释放时，保留现有 `internal/plugin` 监听，并在 tests/README 明确披露依赖场景与移除条件（公开同步卸载 API + 真实 HMR 通过），不静默删除、不扩成第二例外。同 turn 与 await 分开验证，真实 HMR 尚未通过。
3. **D3 兼容默认**：保留独立 CLI 与 aggregate 各自能力，`systemPrompt` 仍为子级依赖，不新增根硬依赖。
4. **D4/D5/D6 兼容默认**：配置默认、clamp、未知键兼容保留且不记录配置值；能力缺席无法维持交互则 BLOCKED，不擅增 Settings 替代。允许本地实施、隔离依赖准备/验证和独立 PASS 后本地提交；**不授权 push、发布、用户部署、宿主升级或改版本/pin**。资源权利、Windows/H5 runner 及未来发布仍需证据/另行决定。
5. 当前正式顺序是 `TASK-162 → 163 → 164 → 165 → 166 → 167 → 168 → 169 → 170`，每卡 DEV→VERIFY→COMMIT→DONE；B06 不进入依赖链。当前只在 TASK-162 做文档和测试基线；TASK-170 前分发产物不刷新。提交仅由 maintainer 执行。
6. verifier 每卡按真实范围审查，特别是 `EX-WH-01` 未扩大、健康挂载未误删、D2 无语义降级、源码 aliases 未冒充真实类型、无真实外部写。文档或局部测试 PASS 不代表全插件规范合规、真实 HMR 或 rc.5/Windows/UI 支持 PASS。

## 附：TASK-160/161 阶段历史只读证据复现

```sh
# 在 /Users/junjie.zhang/dsh；W 与 H2 不作写入
W=icomposer-workbench
H2=deepseek-harness
H5=/tmp/workbench-rc5-validation.8MZjPr/source/deepseek-harness-b830ec950faba0a46dda564be3e2d854afed94f1
shasum -a 256 "$W/docs/plugin-compliance-validation.md"
for H in "$H2" "$H5"; do
  for f in packages/client/ui-layout/src/client/{index.ts,AppFrame.tsx,AppFrame.module.css} \
    packages/client/ui-workspace/src/client/{index.ts,contract/slots.ts} \
    packages/client/ui-slots/src/index.ts packages/client/tsdown.client.ts \
    vendor/cordis/src/{fiber,registry}.ts vendor/loader/src/index.ts; do
    echo "=== $H/$f"; nl -ba "$H/$f"
  done
  rg -n 'tsdown\.client|clientBundle' "$H" -g package.json --glob '!**/node_modules/**' || :
done
# 查看已下载的 registry 样本；tmp 被清理时，使用下述只读命令重取一个样本
T=/tmp/workbench-type-evidence.r6dZj4
for f in "$T"/*.tgz; do shasum -a 256 "$f"; tar -tzf "$f" | grep -E 'lib/types/(index|client/index|client/contract/slots|client/model|types)\.d\.ts|tsdown\.client' || :; done
```

如需重取样本，在专用临时目录操作，不用 npm install，不写用户 home：

```sh
T=$(mktemp -d /tmp/workbench-type-evidence.XXXXXX)
for p in dsh-client-ui-slots dsh-client-ui-workspace dsh-api-workspace-controller dsh-client-web; do
  for v in 0.2.1-rc.2 0.2.1-rc.5; do
    f="$T/$p-$v.tgz"
    curl -fsS --max-time 20 "https://registry.npmjs.org/@deepseek-ai/$p/-/$p-$v.tgz" -o "$f"
    shasum -a 256 "$f"
    tar -tzf "$f" | grep -E 'lib/types/(index|client/index|client/contract/slots|client/model|types)\.d\.ts|tsdown\.client' || :
  done
done
```

上述为 TASK-160/161 历史阶段执行的只读检查与公开 registry GET；当时未运行未来构建、安装、业务测试、UI 自动化或发布。其历史 PASS 不因后续实施而扩大；TASK-162 的隔离运行时基线另见 §8 B00 和 `test/compat/README.md`。
