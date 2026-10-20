# @icomposer/workbench

iComposer Workbench —— 以标准 dsh 插件形态分发的 InsureMO 开发工作台
(工作区绑定、资产目录、代码智能、verify/push/test/release/create/metadata
审批写闭环、设置页/状态徽标/任务节点三块 UI)。

本包是**预构建产物**：`lib/` 已经是纯 JS，安装时不编译、不装 npm 依赖、不需要编译器。

安装源是本仓库中**已跟踪**的预构建目录 `git-dist/icomposer-workbench/`，通过 GitHub
spec 引用，不需要 clone、不需要构建整个 harness、也不需要 `pnpm install`。

---

## 1. 安装到官方 Desktop(默认 profile)

### 1.1 前置

- 已安装 **DeepSeek Harness Desktop**(官方 App)。
- **先启动一次官方 App**，让它初始化自己的默认 profile(`desktop`)。
- 之后**用 ⌘Q 完全退出 App**，再执行任何 CLI 命令。
  - profile 还没被 App 初始化过时，CLI 会提示：
    `Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.`
  - App 仍在运行时，命令可能以别的方式失败(profile 被占用/写入冲突)，
    **不保证**是同一条提示。两种情况下都请先 ⌘Q 再执行。
- 命令必须使用**App 自带的官方 CLI**(绝对路径，见下)。系统里另装的旧版 `dsh`
  会直接拒绝 `--profile desktop`(该 profile 由 Electron App 独占管理)。

### 1.2 安装

```bash
# 官方 App 自带的 CLI(绝对路径；macOS 默认安装位置)
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# 推荐：固定到某个 commit，安装内容可复现
env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#<commit-sha>&path:git-dist/icomposer-workbench"

# 或者：跟随 main(内容随提交漂移，只在想拿最新时使用)
env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#main&path:git-dist/icomposer-workbench"
```

- **整条 spec 必须用引号包住**：`&` 是 shell 的运算符，不加引号会被当成后台执行并
  把参数截断。
- `env -u DSH_HOME` = **不继承** shell 里残留的 `DSH_HOME`，让官方 CLI 使用默认
  `~/.dsh`(默认 profile 在 `~/.dsh/profiles/desktop`)。要装到别的 home 才显式设。
- `#path:git-dist/icomposer-workbench` 指向仓库里**已构建**的包目录，安装即用：
  该目录的 `package.json` **没有 scripts、没有 devDependencies**，所以不会触发
  prepare/构建，也不受 pnpm `allowBuilds` 影响。
- 这是**包安装**而不是目录 link：装进 profile 的 `node_modules` 后，插件的
  `@deepseek-ai/*` peer 依赖沿祖先链解析。不要把工作副本用 `add .` 加进来(那是
  link 安装，文件留在原地，容易出现 `ERR_MODULE_NOT_FOUND`)。

装完**像平常一样点击 App 图标重新打开**(不要用 `.command` 之类的启动脚本)。

## 2. 安装到 Web UI(profile `web`)

Web 宿主由你在本机安装的 `dsh` CLI 启动，要求 **dsh >= 0.2.1-rc.2**
(包内 `engines.dsh` 为 `>=0.2.1-rc.2 <0.3.0-0`)。**0.1 的旧宿主不兼容**。

```bash
# 安装到 web profile(整条 spec 同样要加引号)
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#main&path:git-dist/icomposer-workbench"

# 或固定 commit
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#<commit-sha>&path:git-dist/icomposer-workbench"

# 启动
dsh --profile web
```

- 同样指向预构建的 `git-dist/icomposer-workbench`：零构建、非 link 安装。
- Web 版侧栏收起后是 **56px 的 rail**，Active Profile 选择器在这里以**浮层**打开
  (面板定宽、锚在触发按钮上、按视口收拢)。
- 官方 **macOS Desktop** 不同：收起侧栏是 **0 宽、没有 rail**，需要先
  "Open sidebar" 展开侧栏才能看到底部选择器。

## 3. 更新

同一个包里版本号可能不变，**必须 remove 再 add**，不要指望 `add` 覆盖已有安装。

官方 Desktop(先 ⌘Q)：

```bash
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

( set -eu
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop remove @icomposer/workbench
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#<commit-sha>&path:git-dist/icomposer-workbench"
)
```

Web：

```bash
( set -eu
  dsh plugin --profile web remove @icomposer/workbench
  dsh plugin --profile web add "github:akirajoey/insuremo-dsh#<commit-sha>&path:git-dist/icomposer-workbench"
)
```

`set -eu` + 子 shell 保证任一步失败就停：remove 失败不会继续 add。

## 4. 验证

1. 重新打开 App(或重新执行 `dsh --profile web`)。
2. 打开 **Settings → InsureMO**，应能看到 InsureMO 设置分区。
3. 侧栏应显示 InsureMO 品牌；底部 Profile 选择器能列出 profile 并切换生效。
   Desktop 收起侧栏时没有 rail，用 "Open sidebar" 展开后再看。

## 5. 回滚 / 卸载

回滚到旧版 = 先 remove，再 `add` **旧 commit 的 spec**(用发布记录里的 SHA)：

```bash
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

( set -eu
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop remove @icomposer/workbench
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#<old-commit-sha>&path:git-dist/icomposer-workbench"
)
```

只卸载不再安装：

```bash
env -u DSH_HOME "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop remove @icomposer/workbench
```

不要把整个 profile 目录(`~/.dsh/profiles/desktop`)换成别处的副本：那会一并覆盖
profile 里其它插件与宿主写入的状态，把一次插件回滚变成 profile 事故。

## 6. 兼容性与风险

- 所有 dsh profile 共用同一个 `~/.dsh`(`~/.dsh/profiles/` 下并列 `desktop`、`web` 等)：
  凭据与 session 数据是共享的。
- 不同版本对凭据、session 的格式**不做双向兼容承诺**：升级后不要让旧宿主继续复用
  同一份数据，降级同理；跨版本切换前先备份。
- 数据库/文件格式随宿主版本演进，跨大版本回滚应连同宿主一起回退。
- 动手前先备份：`cp -R ~/.dsh ~/.dsh.bak-$(date +%Y%m%d)`。
- 只装插件、只删插件；不要手工改 profile 的依赖或整目录替换。

## 7. 离线 / 维护者安装(备选，不是主路径)

没有外网或需要验证工作副本时，才用本地 payload 打包成 tgz 再安装。命令仍走 App
自带的 CLI：

```bash
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
PLUGIN_DIR="$PWD/git-dist/icomposer-workbench"   # 在仓库根执行；已在 payload 包根则用 $PWD

( set -eu
  PACK_DIR="$(mktemp -d)"
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop --dir "$PLUGIN_DIR" pack --pack-destination "$PACK_DIR"
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "$PACK_DIR"/*.tgz
  rm -rf "$PACK_DIR"
)
```

## 8. 包内容

- `lib/index.js` —— Host 聚合入口(9 个子插件按依赖序挂载：
  operation-log → workspace-binding → catalog → reference → lifecycle →
  verify → code-intelligence → write → insuremo-service)。
- `lib/client.js` —— 客户端聚合闭包工厂(设置节 + 状态徽标 + 任务节点 + 品牌槽 +
  Active Profile 选择器)。
- `cordis.patch.yml` —— 单行插件层声明。
- `package.json` —— 瘦清单：**无 lifecycle scripts、无 devDependencies**，
  安装不会触发任何构建。

## 9. 运行要求

- Harness 基线：npm `@deepseek-ai/dsh@0.2.1-rc.2`(`engines.dsh` 为
  `>=0.2.1-rc.2 <0.3.0-0`)；`@deepseek-ai/*` peer 由宿主提供。
- react ^18.2.0(客户端 UI)。
- `zod` 已内联进产物，无需单独安装。
- 卡片/徽标/选择器样式全部使用 Harness 设计系统变量，深浅主题自适应。
- 浏览器 bundle 以内容哈希 `?rev=` 引用：升级后 UI 未变时，确认 `remove`+`add`
  确实换了包，再重启 Host 进程即可，无需手动清缓存。

## 10. 开发

消费者不需要下面任何东西。仓库的隔离开发、测试与打包(pnpm workspace、
`pack:dist` / `pack:git-dist` / `check:git-dist`、与 `../deepseek-harness` 的固定
基线)见仓库根 `README.md` 的「开发」章节。
