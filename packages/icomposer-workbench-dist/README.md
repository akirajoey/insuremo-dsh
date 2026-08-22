# @icomposer/workbench

iComposer Workbench —— 以标准 dsh 插件形态分发的 InsureMO 开发工作台
(工作区绑定、资产目录、代码智能、verify/push/test/release/create/metadata
审批写闭环、Intercom 会话消息、设置页/状态徽标/任务节点三块 UI)。

## 安装(三种方式)

前置:已安装 DeepSeek Harness(`dsh`)并可用 `pnpm`/`npm pack`(打包侧)。

### 方式一:tarball 本地分发(推荐,离线可用)

拿到打包产物 `icomposer-workbench-0.1.0.tgz` 后:

```bash
dsh plugin --profile web add /path/to/icomposer-workbench-0.1.0.tgz
```

tgz 内已预构建 `lib/`(纯 JS 产物),安装不触发构建、不需要 npm
registry。**tarball 是推荐形态**:npm 打包的 tar 会在 profile 的
node_modules 里实体落盘,宿主插件的 `@deepseek-ai/*` peer 依赖能沿
祖先链被 dsh loader 正确解析。目录式 `add .` 是 link: 安装,文件留在
原位置,bare import 解析依赖周围 node_modules 布局,曾实测出现
`ERR_MODULE_NOT_FOUND`——仅当该目录自身可解析 harness 包时可用
(例如位于 profile node_modules 内),请统一使用 tgz。

### 方式二:GitHub 仓库路径

```bash
dsh plugin --profile web add github:<org>/insuremo-dsh#path:packages/icomposer-workbench-dist
```

git 依赖经 pnpm 安装时会执行 `prepare` 构建;若 pnpm 拦截构建脚本,
按提示把键加入 profile 的 `pnpm-workspace.yaml` `allowBuilds` 后重试。

### 方式三:npm(未来发布)

```bash
dsh plugin --profile web add @icomposer/workbench
```

## 已知限制（源码开发 profile）

仓库的开发态 profile（`pnpm setup-profile`，14 个插件并行挂载）在真实 boot
时存在 loader 生命周期问题：函数式 apply 入口的嵌套 Service/效果会在挂载后
~25ms 被 loader 的 effect 清扫回收（服务名随之消失，6 个入口 pending）。分发包
（本包，单一 Service 入口）不受影响——`verify-standard-install` 的真实 boot +
overview 200 断言持续守护。开发调试请使用分发包安装路径。

## 安装后

`dsh --profile web --dump-config` 应出现:

```
# == @icomposer/workbench
- id: icomposer-workbench
  name: '@icomposer/workbench'
  inject: [subprocess, storageDomain, workspaceRegistry, skills, webServer, tools, jobs]
```

移除:`dsh plugin --profile web remove @icomposer/workbench`。

## 运行要求

- Harness 基线:99f6f02(@deepseek-ai/* rc.7 系列);peer 版本声明为
  `*`,在基线内解析,超出基线未经测试。
- react ^18.2.0(客户端 UI)。
- `zod` 已内联进产物,无需单独安装。

## 内容

- `lib/index.js` —— Host 聚合入口(9 个子插件按依赖序挂载:
  operation-log → workspace-binding → catalog → reference → lifecycle →
  verify → code-intelligence → intercom → insuremo-service)。
- `lib/client.js` —— 客户端聚合闭包工厂(设置节 + 状态徽标 + 任务节点)。
- `cordis.patch.yml` —— 单行插件层声明。
