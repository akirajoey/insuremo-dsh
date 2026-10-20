# @icomposer/workbench

iComposer Workbench —— 以标准 dsh 插件形态分发的 InsureMO 开发工作台
(工作区绑定、资产目录、代码智能、verify/push/test/release/create/metadata
审批写闭环、设置页/状态徽标/任务节点三块 UI)。

本包是**预构建产物**：`lib/` 已经是纯 JS，安装时不编译、不装 npm 依赖、不需要编译器。

安装源是仓库 `https://github.com/akirajoey/insuremo-dsh` 中**已跟踪**的预构建目录
`git-dist/icomposer-workbench/`。两种安装方式产出的 payload 完全相同：

- **方式 A：GitHub spec 直接安装** —— 不需要下载整仓，但 pnpm 对 GitHub 托管的依赖
  要求**一次授权**（见 §2）。
- **方式 B：clone 仓库 → 用宿主 CLI 把该目录 pack 成 tgz → add tgz** —— 本地实体安装，
  不触发授权。

> 安装 spec 里的 `&` 是 shell 运算符，**整条 spec 必须用引号包住**，否则命令会被
> 拆成后台执行。

---

## 1. 前置条件（两种方式都需要）

- 已安装 **DeepSeek Harness Desktop**(官方 App)，或在 Web 宿主上使用 **dsh >= 0.2.1-rc.2**。
  包内 `engines.dsh` 为 `>=0.2.1-rc.2 <0.3.0-0`，**0.1 的旧宿主不兼容**。
- Desktop：**先启动一次官方 App**，让它初始化默认 profile(`desktop`)，之后**用 ⌘Q
  完全退出 App** 再执行 CLI。
  - profile 还没被 App 初始化过时，CLI 会提示：
    `Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.`
  - App 仍在运行时，命令可能以别的方式失败(profile 被占用/写入冲突)，**不保证**是同一条
    提示。两种情况下都请先 ⌘Q 再执行。
  - 必须使用**App 自带的官方 CLI**(绝对路径)。系统里另装的旧版 `dsh` 会直接拒绝
    `--profile desktop`(该 profile 由 Electron App 独占管理)。
- Web：用本机安装的 `dsh` 直接操作 `web` profile。

## 2. 首次安装要过的一次性授权(仅方式 A)

pnpm 对 GitHub 托管的依赖要求显式授权。首次 `add` 会 **exit 1**，报类似：

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @icomposer/workbench@https://codeload.github.com/...#path:...
```

同时 dsh 已经把占位写进该 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  '@icomposer/workbench@https://codeload.github.com/akirajoey/insuremo-dsh/tar.gz/<sha>#path:git-dist/icomposer-workbench': set this to true or false
```

把这行的值改成 `true`，再**重跑同一条 `add`** 即可(exit 0，`node_modules/@icomposer/workbench/lib`
出现 `client.js`/`index.js`)。

- 这是 pnpm 针对该 GitHub 依赖的**一次性授权**，不是本包在跑构建脚本——它的
  `package.json` **没有任何 scripts、没有 devDependencies**。
- **每个 profile 各授权一次**：
  - Desktop：`~/.dsh/profiles/desktop/pnpm-workspace.yaml`
  - Web：`~/.dsh/profiles/web/pnpm-workspace.yaml`
  - 用自定义 `DSH_HOME` 时在对应目录下的 profile 里。
- 占位键里含 tar.gz 的 `<sha>`：解析到**新的 commit** 会生成新键，需要再确认一次。
  需要频繁跟随更新时，用方式 B 更省事。

## 3. 安装到官方 Desktop(默认 profile)

### 3.1 方式 A：GitHub spec

```bash
# 官方 App 自带的 CLI(绝对路径；macOS 默认安装位置)
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# 推荐：pin 到某个 commit，安装内容可复现
env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#<commit-sha>&path:git-dist/icomposer-workbench"

# 或者跟随 main(内容随提交漂移)
env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#main&path:git-dist/icomposer-workbench"
```

首次若报 `ERR_PNPM_IGNORED_BUILDS`，按 §2 把 `~/.dsh/profiles/desktop/pnpm-workspace.yaml`
里的占位值改成 `true`，再重跑同一条命令。

`env -u DSH_HOME` = 不继承 shell 里残留的 `DSH_HOME`，让官方 CLI 使用默认 `~/.dsh`
(默认 profile 在 `~/.dsh/profiles/desktop`)。要装到别的 home 才显式设。

### 3.2 方式 B：clone + pack 成 tgz(无需授权)

```bash
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

( set -eu
  WORKDIR="$(mktemp -d)"

  # 1) 取仓库；要 pin 精确版本时去掉 --depth 1，再 git checkout <commit-sha>
  git clone --depth 1 --branch main https://github.com/akirajoey/insuremo-dsh "$WORKDIR/repo"

  # 2) 用宿主 CLI 把已跟踪的预构建目录打成 tgz
  PACK_DIR="$WORKDIR/pack"
  mkdir -p "$PACK_DIR"
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop --dir "$WORKDIR/repo/git-dist/icomposer-workbench" pack --pack-destination "$PACK_DIR"

  # 3) 安装本地 tgz(实体安装，不触发 §2 的授权)
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "$PACK_DIR"/*.tgz

  rm -rf "$WORKDIR"
)
```

已有 checkout 时不要重新 clone：在该 checkout 里 `git pull --ff-only`(先确认 `git status`
干净)，再重复第 2、3 步。**不要用 `add .` 直接加目录** —— 那是 link 安装，文件留在原地，
容易出现 `ERR_MODULE_NOT_FOUND`。

## 4. 安装到 Web UI(profile `web`)

要求 **dsh >= 0.2.1-rc.2**；**0.1 的旧宿主不兼容**。

### 4.1 方式 A：GitHub spec

```bash
# 安装到 web profile(整条 spec 同样要加引号)
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#main&path:git-dist/icomposer-workbench"

# 或固定 commit
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#<commit-sha>&path:git-dist/icomposer-workbench"

# 启动
dsh --profile web
```

首次若报 `ERR_PNPM_IGNORED_BUILDS`，把 `~/.dsh/profiles/web/pnpm-workspace.yaml` 里的
占位值改成 `true`，再重跑同一条 `add`。

### 4.2 方式 B：clone + pack 成 tgz(无需授权)

```bash
( set -eu
  WORKDIR="$(mktemp -d)"
  git clone --depth 1 --branch main https://github.com/akirajoey/insuremo-dsh "$WORKDIR/repo"

  PACK_DIR="$WORKDIR/pack"
  mkdir -p "$PACK_DIR"
  dsh plugin --profile web --dir "$WORKDIR/repo/git-dist/icomposer-workbench" pack --pack-destination "$PACK_DIR"
  dsh plugin --profile web add "$PACK_DIR"/*.tgz

  rm -rf "$WORKDIR"
)
```

## 5. 更新

同一个包里版本号可能不变，**必须 remove 再 add**，不要指望 `add` 覆盖已有安装。

```bash
# Desktop(先 ⌘Q)，方式 A 的 spec；用方式 B 就把最后一行换成 add "$PACK_DIR"/*.tgz
( set -eu
  DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop remove @icomposer/workbench
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#<commit-sha>&path:git-dist/icomposer-workbench"
)

# Web
( set -eu
  dsh plugin --profile web remove @icomposer/workbench
  dsh plugin --profile web add "github:akirajoey/insuremo-dsh#<commit-sha>&path:git-dist/icomposer-workbench"
)
```

`set -eu` + 子 shell 保证任一步失败就停：remove 失败不会继续 add。
方式 A 解析到新 commit 时可能再要一次 §2 的授权；方式 B 只需重新 pack。

## 6. 验证

1. 重新打开 App(或重新执行 `dsh --profile web`)。
2. 打开 **Settings → InsureMO**，应能看到 InsureMO 设置分区。
3. 侧栏应显示 InsureMO 品牌，底部 Profile 选择器能列出 profile 并切换生效。
   - **官方 macOS Desktop**：收起侧栏是 **0 宽、没有 rail**，需要先 “Open sidebar”
     展开侧栏才能看到底部选择器。
   - **Web**：收起后是 **56px rail**，Active Profile 选择器在这里以**浮层**打开
     (面板定宽、锚在触发按钮上、按视口收拢)。

## 7. 回滚 / 卸载

回滚 = 先 remove，再装**旧版本**：方式 A 用旧 commit 的 spec，方式 B 用旧版本打出的 tgz。

```bash
# 方式 A：回到旧 commit
( set -eu
  DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
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

## 8. 兼容性与风险

- 所有 dsh profile 共用同一个 `~/.dsh`(`~/.dsh/profiles/` 下并列 `desktop`、`web` 等)：
  凭据与 session 数据是共享的。
- 不同版本对凭据、session 的格式**不做双向兼容承诺**：升级后不要让旧宿主继续复用
  同一份数据，降级同理；跨版本切换前先备份。
- 跨大版本回滚应连同宿主一起回退。
- 动手前先备份：`cp -R ~/.dsh ~/.dsh.bak-$(date +%Y%m%d)`。
- 只装插件、只删插件；不要手工改 profile 的依赖或整目录替换。

## 9. 包内容

- `lib/index.js` —— Host 聚合入口(9 个子插件按依赖序挂载：
  operation-log → workspace-binding → catalog → reference → lifecycle →
  verify → code-intelligence → write → insuremo-service)。
- `lib/client.js` —— 客户端聚合闭包工厂(设置节 + 状态徽标 + 任务节点 + 品牌槽 +
  Active Profile 选择器)。
- `cordis.patch.yml` —— 单行插件层声明。
- `package.json` —— 瘦清单：**无 lifecycle scripts、无 devDependencies**。

## 10. 运行要求

- Harness 基线：npm `@deepseek-ai/dsh@0.2.1-rc.2`(`engines.dsh` 为
  `>=0.2.1-rc.2 <0.3.0-0`)；`@deepseek-ai/*` peer 由宿主提供。
- react ^18.2.0(客户端 UI)。
- `zod` 已内联进产物，无需单独安装。
- 卡片/徽标/选择器样式全部使用 Harness 设计系统变量，深浅主题自适应。
- 浏览器 bundle 以内容哈希 `?rev=` 引用：升级后 UI 未变时，确认 `remove`+`add`
  确实换了包，再重启 Host 进程即可，无需手动清缓存。

## 11. 开发

消费者不需要下面任何东西。仓库的隔离开发、测试与打包(pnpm workspace、
`pack:dist` / `pack:git-dist` / `check:git-dist`、与 `../deepseek-harness` 的固定
基线)见仓库根 `README.md` 的「开发」章节。
