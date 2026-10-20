# @icomposer/workbench

iComposer Workbench —— 以标准 dsh 插件形态分发的 InsureMO 开发工作台
(工作区绑定、资产目录、代码智能、verify/push/test/release/create/metadata
审批写闭环、设置页/状态徽标/任务节点三块 UI)。

本包是**预构建产物**：`lib/` 已经是纯 JS，安装时不编译、不装 npm 依赖、不需要编译器。

---

## 1. 前置条件

- 已安装 **DeepSeek Harness Desktop**(官方 App)，本文命令在官方 **0.2.1-rc.2**
  上验证通过(包内 `engines.dsh` 为 `>=0.2.1-rc.2 <0.3.0-0`)。
- **先启动一次官方 App**，让它初始化自己的默认 profile(`desktop`)。
- 之后**用 ⌘Q 完全退出 App**，再执行任何 CLI 命令。
  - profile 还没被 App 初始化过时，CLI 会提示：
    `Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.`
  - App 仍在运行时，命令可能以别的方式失败(profile 被占用/写入冲突)，
    **不保证**是同一条提示。两种情况下都请先 ⌘Q 再执行。
- 命令必须使用**App 自带的官方 CLI**(绝对路径，见下)。本机另装的旧版 `dsh`
  会直接拒绝 `--profile desktop`(该 profile 由 Electron App 独占管理)；
  系统里也不需要另装 node / npm / pnpm——App 的 CLI 内部已带 pnpm。

## 2. 拿到插件

插件来自本仓库中**已跟踪**的预构建目录：

```
git-dist/icomposer-workbench/     ← 只有这个目录是给消费者用的
```

该目录是构建好并随仓库提交的 payload(lib/assets、cordis.patch.yml、README、
不含 scripts 的瘦 package.json)，因此**不需要**：

- 不要使用 `dist-release/`(被 .gitignore 忽略，是本机打包的临时产物，仓库里没有)；
- 不需要 clone / 构建整个 DeepSeek Harness 工程；
- 不需要 pnpm install、tsc、tsdown 等任何构建步骤。

### 2.1 首次获取

用 `--branch` clone 发布分支，保证本地有 tracking 分支，后续 `git pull` 可用：

```bash
git clone --branch "<发布者提供的新版发布分支>" "<仓库地址>" icomposer-workbench
cd icomposer-workbench
```

> 发布者提供的分支/ref 是**唯一**可信发布点。本升级分支
> (`upgrade/dsh-0.2.1`)目前仍是**本地分支、尚未 push**，在发布者给出可访问的
> 发布分支之前无法远程 clone 到它——不要用 `main` 或任何跟随分支的方式安装，
> 内容会随提交漂移，装到的东西无法复现。
>
> 如果你 checkout 的是 **tag 或具体 SHA**，那你拿到的是一个固定版本：
> detached HEAD 上 `git pull` 不适用，更新时用 `git fetch` + 显式
> `git checkout <新 ref>`。

### 2.2 已有 checkout 时更新

```bash
git status                  # 先确认工作区干净：有未提交改动时 pull 会拒绝
git switch "<发布分支>"
git pull --ff-only
```

`--ff-only` 只接受快进：它拒绝的是**分叉/需要生成合并提交**的情况，而不是
“任何本地改动”；未提交的改动会由 `git` 的常规工作区检查拦住，所以先确保
`git status` 干净。

## 3. 安装到官方 Desktop 的默认 profile

```bash
# 官方 App 自带的 CLI(绝对路径；macOS 默认安装位置)
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# 插件目录：在**仓库根**执行时用下面这行；若你已经在 git-dist/icomposer-workbench 里，改成 PLUGIN_DIR="$PWD"
PLUGIN_DIR="$PWD/git-dist/icomposer-workbench"

# 子 shell + set -eu：任一步失败立即中止；临时目录只在全部成功后才清理
( set -eu
  PACK_DIR="$(mktemp -d)"

  # 1) 先把已跟踪的预构建目录打成一个临时 tgz(App 自带 pnpm，不联网、不构建)
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop --dir "$PLUGIN_DIR" pack --pack-destination "$PACK_DIR"

  # 2) 安装该 tgz 到默认 profile(pack 只产出一个 tgz，用通配取版本，避免硬编码)
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "$PACK_DIR"/*.tgz

  rm -rf "$PACK_DIR"
)
```

要点：

- `env -u DSH_HOME` 表示**不继承**你 shell 里可能残留的 `DSH_HOME`，让官方 CLI
  使用默认的 `~/.dsh`(默认 profile 位于 `~/.dsh/profiles/desktop`)。
  如果你确实要装到别的 home，才显式设 `DSH_HOME`。
- 先 `pack` 成 tgz 再 `add`：tgz 是**实体拷贝**进 profile 的 `node_modules`，
  宿主插件的 `@deepseek-ai/*` peer 依赖能沿目录链被解析；直接 `add` 一个目录是
  link 安装，文件留在原地，容易出现 `ERR_MODULE_NOT_FOUND`。

## 4. 更新已安装的插件

同一个包里版本号可能不变(0.1.0)，所以**必须 remove 再 add**，不要指望 `add`
覆盖已有安装。`set -eu` 保证：pack 失败不会继续 remove，remove 失败不会 add。

```bash
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
PLUGIN_DIR="$PWD/git-dist/icomposer-workbench"

( set -eu
  PACK_DIR="$(mktemp -d)"

  # 1) 先打包：这一步失败就停，能用的旧版不会被删
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop --dir "$PLUGIN_DIR" pack --pack-destination "$PACK_DIR"

  # 2) 卸载旧版
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop remove @icomposer/workbench

  # 3) 安装新版
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "$PACK_DIR"/*.tgz

  rm -rf "$PACK_DIR"
)
```

## 5. 验证

1. **不要用 `.command` 之类的启动脚本**。像平常一样点击官方 App 图标重新打开
   (安装前后都要保证 App 已完全退出，⌘Q)。
2. 打开 **Settings → InsureMO**，应能看到 InsureMO 设置分区。
3. 侧栏应显示 InsureMO 品牌与底部 Profile 选择器；点击选择器能列出 profile 并
   切换生效。

## 6. 回滚 / 卸载

```bash
env -u DSH_HOME "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop remove @icomposer/workbench
```

需要回到旧版本时，用**旧版本的 tgz 重新 `add`**；不要把整个 profile 目录
(`~/.dsh/profiles/desktop`)换成别处的副本——那会一并覆盖掉 profile 里其它插件
与宿主写入的状态，把一次插件回滚变成 profile 事故。

## 7. 已知风险(从 0.1 升级的用户请先看)

- 官方 Desktop 与我们此前 0.1 的 web profile **共用同一个 `~/.dsh`**：
  `~/.dsh/profiles/` 下同时存在 `desktop`、以及旧版本留下的 profile 目录，
  凭据与 session 数据存在共享/迁移关系。
- 新旧版本对凭据、session 的格式**不做双向兼容承诺**：升级后不要在旧宿主上继续
  复用同一份 `~/.dsh` 数据，也不要指望降级后旧宿主能原样读懂新宿主写下的内容。
- 动手前先备份：`cp -R ~/.dsh ~/.dsh.bak-$(date +%Y%m%d)`。
- 只装插件、只删插件；不要手工改 profile 的依赖或整个目录替换。

## 8. 包内容

- `lib/index.js` —— Host 聚合入口(9 个子插件按依赖序挂载：
  operation-log → workspace-binding → catalog → reference → lifecycle →
  verify → code-intelligence → write → insuremo-service)。
- `lib/client.js` —— 客户端聚合闭包工厂(设置节 + 状态徽标 + 任务节点)。
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

本仓库的隔离开发、测试与打包(pnpm workspace、`pack:dist` / `pack:git-dist` /
`check:git-dist`、与 `../deepseek-harness` 的固定基线)见仓库根 `README.md` 的
「开发」章节。开发者才需要 Node、pnpm 与 harness 源码；**普通安装不需要**。
