# @icomposer/workbench

iComposer Workbench —— 以标准 dsh 插件形态分发的 InsureMO 开发工作台
(工作区绑定、资产目录、代码智能、verify/push/test/release/create/metadata
审批写闭环、Intercom 会话消息、设置页/状态徽标/任务节点三块 UI)。

## 安装(三种方式)

前置:已安装 DeepSeek Harness(`dsh`)并可用 `pnpm`。

### 方式一:本地文件夹(离线分发,推荐 POC 阶段使用)

拿到打包文件夹(zip 或目录)后:

```bash
unzip icomposer-workbench-dist-0.1.0.zip
cd icomposer-workbench-dist
dsh plugin --profile web add .
```

zip 内已预构建 `lib/`(纯 JS 产物,无 TypeScript 源依赖),安装不触发
构建、不需要 npm registry;仅 pnpm 本身需要可用。

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
