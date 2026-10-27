# @icomposer/workbench

iComposer Workbench —— 以标准 dsh 插件形态分发的 InsureMO 开发工作台
(工作区绑定、资产目录、代码智能、verify/push/test/release/create/metadata
审批写闭环、设置页/状态徽标/任务节点三块 UI)。

本包是**预构建产物**：`lib/` 已经是纯 JS，安装时不编译、不装 npm 依赖、不需要编译器。

发布形态是仓库中的 **payload 根分支**：`plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2` 分支的**根目录就是本包**
(`lib/`、`cordis.patch.yml`、`package.json`)，因此一条 `add` 即可安装，不需要子目录参数。

### 发布版本（0.1.2）

| 项 | 值 |
|---|---|
| Workbench | **0.1.2** |
| 分发分支（安装用） | `plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2` |
| 源码分支 | `release/workbench-0.1.2` |
| 已验证组合（`testedWith`） | dsh `0.2.1-rc.2`、IMO `0.2.37`、`@insuremo/skills-tool` `1.1.2` |
| 平台验证 | macOS Desktop、Web（本轮已验）；**Windows 未实机验证** |

> `testedWith` 是已验证组合，不是硬约束；唯一硬约束是包里的 `engines.dsh`
> （`>=0.2.1-rc.2 <0.3.0-0`）。
> 本版的 Skills 安装/更新走 `npx @insuremo/skills-tool`，**需要网络**（registry 可达）。

---

## 1. 前置条件

- **dsh >= 0.2.1-rc.2**（包内 `engines.dsh` 为 `>=0.2.1-rc.2 <0.3.0-0`）。
- Skills 同步（安装/更新/库存读取）走 `npx @insuremo/skills-tool`，**需要能访问 npm
  registry**；完全离线的环境只能安装/卸载插件本身，Skills 操作会失败并留下诊断。
- Desktop：**先启动一次官方 App**，让它初始化默认 profile(`desktop`)，之后**完全退出
  App** 再执行 CLI。
  - profile 还没被 App 初始化过时，CLI 会提示：
    `Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.`
  - App 仍在运行时，命令可能以别的方式失败(profile 被占用/写入冲突)，**不保证**是同一条
    提示。两种情况下都请先退出 App。
- macOS / Linux：Desktop 必须使用**App 自带的官方 CLI**(绝对路径)。系统里另装的旧版
  `dsh` 会直接拒绝 `--profile desktop`(该 profile 由 Electron App 独占管理)。
- Windows：`dsh` 由 App 菜单 **Manage dsh Command… → Install/Repair** 注册进当前用户
  PATH；CLI 本体在安装目录 `<install>\resources\runtime\cli\dsh.cmd`，默认
  `%LOCALAPPDATA%\Programs\DeepSeek Harness`。profile 在
  `%USERPROFILE%\.dsh\profiles\desktop`。
- Web：用本机安装的 `dsh` 直接操作 `web` profile。

主 spec：`github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2`
可复现 pin：`github:akirajoey/insuremo-dsh#<commit-sha>`

> spec 建议整体加引号：`#`/`&` 在 shell 里都有特殊含义（Windows 上引号内即安全）。

## 2. 安装到官方 Desktop(默认 profile)

### 2.1 macOS / Linux

```bash
# 官方 App 自带的 CLI(macOS 默认安装位置)
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# 跟随发布分支(/usr/bin/env 用绝对路径，绕开 shell 别名与 grc 等包装)
/usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2"

# 可复现：pin 到这个 commit
/usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#<commit-sha>"
```

- `/usr/bin/env -u DSH_HOME` = 不继承 shell 里残留的 `DSH_HOME`，让官方 CLI 使用默认
  `~/.dsh`(默认 profile 在 `~/.dsh/profiles/desktop`)。要装到别的 home 才显式设。
- 装完**像平常一样点击 App 图标重新打开**，不要用 `.command` 之类的启动脚本。

### 2.2 Windows

先确保 `dsh` 可用：App 菜单 **Manage dsh Command… → Install/Repair** 会把 `dsh.cmd`
写进当前用户 PATH(不是 `/usr/local/bin`；也不要手工改 `%PATH%`)，然后**新开一个终端**。

PowerShell：

```powershell
Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
dsh plugin --profile desktop add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2"
# pin
dsh plugin --profile desktop add "github:akirajoey/insuremo-dsh#<commit-sha>"
```

cmd.exe：

```bat
set "DSH_HOME="
dsh plugin --profile desktop add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2"
```

`dsh` 还不可用时，直接用安装目录里的 CLI：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\dsh.cmd" plugin --profile desktop add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2"
```

```bat
"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\dsh.cmd" plugin --profile desktop add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2"
```

## 3. 安装到 Web UI(profile `web`)

### 3.1 macOS / Linux

```bash
# 安装到 web profile
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2"

# 或 pin
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#<commit-sha>"

# 启动
dsh --profile web
```

### 3.2 Windows

PowerShell：

```powershell
Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2"
dsh --profile web
```

cmd.exe：

```bat
set "DSH_HOME="
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2"
dsh --profile web
```

两个平台都是**一条命令**：不需要额外授权、不会出现 `ERR_PNPM_IGNORED_BUILDS`、不需要改
`allowBuilds`；安装后 profile 的 bundles 自动包含 `@icomposer/workbench`。

## 4. 更新

同一个包里版本号可能不变，**必须 remove 再 add**（同一条 spec）：

```bash
# macOS / Linux + Desktop(先退出 App)
( set -eu
  DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  /usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop remove @icomposer/workbench
  /usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2"
)

# macOS / Linux + Web
( set -eu
  dsh plugin --profile web remove @icomposer/workbench
  dsh plugin --profile web add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2"
)
```

Windows(PowerShell；cmd.exe 同理，先 `set "DSH_HOME="`)：

```powershell
dsh plugin --profile desktop remove @icomposer/workbench
dsh plugin --profile desktop add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2"
```

`set -eu` + 子 shell 保证任一步失败就停：remove 失败不会继续 add。

## 5. 验证

1. 重新打开 App(或重新执行 `dsh --profile web`)。
2. 打开 **Settings → InsureMO**，应能看到 InsureMO 设置分区。
3. 侧栏应显示 InsureMO 品牌，底部 Profile 选择器能列出 profile 并切换生效。
   - **官方 macOS Desktop**：收起侧栏是 **0 宽、没有 rail**，需要先 “Open sidebar”
     展开侧栏才能看到底部选择器。
   - **Web**：收起后是 **56px rail**，Active Profile 选择器在这里以**浮层**打开
     (面板定宽、锚在触发按钮上、按视口收拢)。

### 0.1.2 增补：安装预览与诊断

已知 Skills alias 的安装前校验与 Refresh 使用相同的公开目录命令和输出环境，
再精确校验选中名称；正式安装仍只安装选中项，严格解析与白名单校验不放宽。
CLI 即使退出码为 0，格式异常、截断或选中项消失也会保留脱敏诊断，
Diagnose 可读取真实命令、退出码和拒绝原因。Windows 具体失败输出仍待现场复测确认。

本补丁仍为 **0.1.2**，仅快进追加现有分支提交，不重写历史。
同版本更新建议 remove 后 add **本次具体 commit SHA**，避免分支缓存读取旧包；
具体 pin 见源码分支的根 README，本包 README 保持 `<commit-sha>` 占位以避免自引用。

### Skills 操作超时（0.1.2 起）

目录刷新不再额外截断为 15 秒，与安装、更新、移除共享
`insuremoService.skillActionTimeoutMs`：默认 **180000 毫秒（3 分钟）**，
运行时最多 **300000 毫秒（5 分钟）**。保留总超时、取消和并发合并，不支持无限等待；
普通 IMO/已安装库存读取的 `timeoutMs` 不变。

完全退出 Desktop 后，编辑 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`
（macOS/Linux 为 `~/.dsh/profiles/desktop/cordis.patch.yml`）；Web 使用对应的
`profiles/web/cordis.patch.yml`。合并到现有顶层数组，保留其它条目；已有同一 `id`
时只合并其 `config`：

```yaml
- id: icomposer-workbench
  config:
    insuremoService:
      skillActionTimeoutMs: 240000 # 4 分钟，单位毫秒
```

保存后重启 App/Web 宿主。设置页暂无此输入框，需通过 profile 配置调整。
**此行为从 0.1.2 起生效。旧 0.1.1 分发仍有 15 秒目录刷新上限，仅修改配置不能绕过，请先升级到 0.1.2。**

## 6. 故障排查

- `env: ~/.local/bin/env: Permission denied`（路径随环境不同）或 `grc: ... Permission denied`：
  PATH 最前有一个**不可执行**的 `env`(uv 风格的 PATH 片段脚本常见)，shell 的着色包装把
  它当命令解析。与本插件无关。改用 `/usr/bin/env -u DSH_HOME …`，或
  `(unset DSH_HOME; dsh …)`。
- `dsh: profile "desktop" is managed exclusively by the Electron application`：用到了系统
  里另装的旧版 `dsh`。macOS 用 App 自带的绝对路径；Windows 用 App 注册的 `dsh.cmd` 或
  安装目录里的绝对路径。
- `Open DeepSeek Harness Desktop once to initialize its profile…`：Desktop profile 还没被
  App 初始化——先启动一次 App；App 仍在运行时先完全退出。

## 7. 回滚 / 卸载

回滚 = 先 remove，再 `add` **旧版本**：用上一版的 commit，或旧分支。

```bash
( set -eu
  DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  /usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop remove @icomposer/workbench
  /usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#<old-commit-sha>"
)
```

只卸载不再安装：

```bash
/usr/bin/env -u DSH_HOME "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  plugin --profile desktop remove @icomposer/workbench
```

不要把整个 profile 目录(`~/.dsh/profiles/desktop`，Windows 为
`%USERPROFILE%\.dsh\profiles\desktop`)换成别处的副本：那会一并覆盖 profile 里其它插件
与宿主写入的状态，把一次插件回滚变成 profile 事故。

## 8. 兼容性与风险

- 所有 dsh profile 共用同一个 `~/.dsh`(`~/.dsh/profiles/` 下并列 `desktop`、`web` 等；
  Windows 为 `%USERPROFILE%\.dsh`)：凭据与 session 数据是共享的。
- 不同版本对凭据、session 的格式**不做双向兼容承诺**：升级后不要让旧宿主继续复用
  同一份数据，降级同理；跨版本切换前先备份。
- 跨大版本回滚应连同宿主一起回退。
- 动手前先备份：`cp -R ~/.dsh ~/.dsh.bak-$(date +%Y%m%d)`。
- 只装插件、只删插件；不要手工改 profile 的依赖或整目录替换。

## 9. 备注：`&path:` 子目录形式才需要授权

如果改用 `github:akirajoey/insuremo-dsh#main&path:git-dist/icomposer-workbench` 这种
**子目录**形式，pnpm 会对 git 子目录做隐式打包，首次 `add` 会 exit 1 并报
`[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @icomposer/workbench@https://codeload.github.com/...`，
同时 dsh 已把占位写进 profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  '@icomposer/workbench@https://codeload.github.com/akirajoey/insuremo-dsh/tar.gz/<sha>#path:git-dist/icomposer-workbench': set this to true or false
```

把值改成 `true` 后重跑同一条 `add` 即可(macOS/Linux：
`~/.dsh/profiles/<profile>/pnpm-workspace.yaml`；Windows：
`%USERPROFILE%\.dsh\profiles\<profile>\pnpm-workspace.yaml`)。这是 pnpm 对 git 子目录
依赖的一次性授权，不是本包在构建(它的 `package.json` **没有任何 scripts、没有
devDependencies**)。**主路径(分支根 spec)不需要这一步。**

## 10. 版本通道

- `plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2` —— **本版（0.1.2）主路径**，对应 dsh >= 0.2.1-rc.2
  (`engines.dsh` `>=0.2.1-rc.2 <0.3.0-0`)。
- `plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37` —— 旧版（0.1.1），仍有 15 秒目录刷新上限，**保留原 SHA 不覆盖**。
- `plugin-dist-0.2` —— 更早版本（0.1.0），**保留原 SHA 不覆盖**，需要回滚时 pin 它的原始 commit。
- `plugin-dist` —— 0.1 宿主专用，**保留原 SHA**，新宿主上不要用。
- 四者都是**payload 根分支**(根目录即插件包)，命令形态完全相同，**区别只在版本**；
  新版本发布不覆盖旧分支。

## 11. 备选：离线 / 无网(clone + pack)

没有外网、或要验证工作副本时，取仓库后把 payload 打成 tgz 再安装：

```bash
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

( set -eu
  WORKDIR="$(mktemp -d)"
  git clone --depth 1 --branch plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37-v0.1.2 https://github.com/akirajoey/insuremo-dsh "$WORKDIR/repo"

  PACK_DIR="$WORKDIR/pack"
  mkdir -p "$PACK_DIR"
  /usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop --dir "$WORKDIR/repo" pack --pack-destination "$PACK_DIR"
  /usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "$PACK_DIR"/*.tgz

  rm -rf "$WORKDIR"
)
```

Web 版同样，把两处 `plugin --profile desktop` 换成 `plugin --profile web`(并用 `dsh`)。
**不要用 `add .` 直接加目录**：那是 link 安装，文件留在原地，容易出现
`ERR_MODULE_NOT_FOUND`。

## 12. 包内容

- `lib/index.js` —— Host 聚合入口(9 个子插件按依赖序挂载：
  operation-log → workspace-binding → catalog → reference → lifecycle →
  verify → code-intelligence → write → insuremo-service)。
- `lib/client.js` —— 客户端聚合闭包工厂(设置节 + 状态徽标 + 任务节点 + 品牌槽 +
  Active Profile 选择器)。
- `cordis.patch.yml` —— 单行插件层声明。
- `package.json` —— 瘦清单：**无 lifecycle scripts、无 devDependencies**。

## 13. 运行要求

- Harness 基线：npm `@deepseek-ai/dsh@0.2.1-rc.2`(`engines.dsh` 为
  `>=0.2.1-rc.2 <0.3.0-0`)；`@deepseek-ai/*` peer 由宿主提供。
- react ^18.2.0(客户端 UI)。
- `zod` 已内联进产物，无需单独安装。
- 卡片/徽标/选择器样式全部使用 Harness 设计系统变量，深浅主题自适应。
- 浏览器 bundle 以内容哈希 `?rev=` 引用：升级后 UI 未变时，确认 `remove`+`add`
  确实换了包，再重启 Host 进程即可，无需手动清缓存。

## 14. 开发

消费者不需要下面任何东西。仓库的隔离开发、测试与打包(pnpm workspace、
`pack:dist` / `pack:git-dist` / `check:git-dist`、与 `../deepseek-harness` 的固定
基线)见仓库根 `README.md` 的「开发」章节。
