# iComposer Workbench

`icomposer-workbench` 是承载 Workbench Host/Client 插件的独立 pnpm workspace。
DeepSeek Harness 是固定、只读的兼容基线：它不会被复制进本仓库，也不会被
Workbench 的包修改。

---

## 安装

插件发布为仓库中的 **payload 根分支**：`plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37` 分支**根目录本身就是插件包**
（`lib/`、`cordis.patch.yml`、`package.json`），所以一条命令就能装，不需要子目录参数。

### 发布版本（0.1.2）

| 项 | 值 |
|---|---|
| Workbench | **0.1.2** |
| 分发分支（安装用） | `plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37` |
| 源码分支 | `release/workbench-0.1.2` |
| 已验证组合（`testedWith`） | dsh `0.2.1-rc.2`、IMO `0.2.37`、`@insuremo/skills-tool` `1.1.2` |
| 平台验证 | macOS Desktop/Web 隔离验证；Windows Skills 刷新、安装由用户复测通过 |

> `testedWith` 是**已验证组合**，不是硬约束；唯一硬约束是包里的
> `engines.dsh`（`>=0.2.1-rc.2 <0.3.0-0`）。

主 spec：`github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37`
可复现 pin：`github:akirajoey/insuremo-dsh#ae99dfefffaa4ebbb3adc7550d4a035b9190faa4`（发布时由维护者填真实分发分支 SHA）

> spec 建议整体加引号：`#`/`&` 在 shell 里都有特殊含义（Windows 上引号内即安全；
> 含 `&path:` 的旧形式尤其必须加引号）。

### 官方 Desktop（默认 profile）

前置：

1. 已安装官方 **DeepSeek Harness Desktop**；本版本面向 **dsh >= 0.2.1-rc.2**
   （包内 `engines.dsh` 为 `>=0.2.1-rc.2 <0.3.0-0`）。
2. **先启动一次 App**，让它初始化默认 profile（`desktop`）。
3. 之后**完全退出 App**（macOS ⌘Q）再执行 CLI 命令：
   - profile 尚未被 App 初始化时，CLI 会提示 “Open DeepSeek Harness Desktop once to
     initialize its profile, then fully quit it before running dsh plugin --profile desktop.”；
   - App 仍在运行时，命令可能以其它方式失败（profile 被占用/写入冲突），**不保证**
     是同一条提示。两种情况都请先退出 App。
4. macOS / Linux 必须使用 **App 自带的官方 CLI**（绝对路径）：系统里另装的旧版 `dsh`
   会直接拒绝 `--profile desktop`（该 profile 由 Electron App 独占管理）。
   Windows 见下一小节（CLI 由 App 注册或直接用安装目录里的 `dsh.cmd`）。

#### macOS / Linux

```bash
# 官方 App 自带的 CLI（macOS 默认安装位置）
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# 跟随发布分支（/usr/bin/env 用绝对路径，绕开 shell 别名与 grc 等包装）
/usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37"

# 可复现：pin 到这个 commit
/usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#ae99dfefffaa4ebbb3adc7550d4a035b9190faa4"
```

`/usr/bin/env -u DSH_HOME` = 在不继承 shell 里残留 `DSH_HOME` 的情况下执行，让官方 CLI
使用默认 `~/.dsh`（默认 profile 在 `~/.dsh/profiles/desktop`）。要装到别的 home 才显式设。
装完**像平常一样点击 App 图标重新打开**，不要用 `.command` 之类的启动脚本。

#### Windows

Windows 的 `dsh` 命令由 App 注册：菜单 **Manage dsh Command… → Install/Repair** 会把
`dsh.cmd` 写进**当前用户 PATH**（不是 `/usr/local/bin`，也不要手工改 `%PATH%`）。
注册后**新开一个终端**再执行。App 内置 CLI 位于安装目录
`<install>\resources\runtime\cli\dsh.cmd`，默认
`%LOCALAPPDATA%\Programs\DeepSeek Harness`；profile 在
`%USERPROFILE%\.dsh\profiles\desktop`。

PowerShell：

```powershell
Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
dsh plugin --profile desktop add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37"
# pin
dsh plugin --profile desktop add "github:akirajoey/insuremo-dsh#46ee62d8729100e14a6867aec1f049ad9b9ab669"
```

cmd.exe：

```bat
set "DSH_HOME="
dsh plugin --profile desktop add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37"
```

`dsh` 还不可用（尚未注册或终端没重开）时，直接用安装目录里的 CLI：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\dsh.cmd" plugin --profile desktop add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37"
```

```bat
"%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\dsh.cmd" plugin --profile desktop add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37"
```

### Web UI（profile `web`）

Web 宿主由本机安装的 `dsh` 启动，要求 **dsh >= 0.2.1-rc.2**；**0.1 的旧宿主不兼容**。

#### macOS / Linux

```bash
# 安装到 web profile
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37"

# 或 pin
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#46ee62d8729100e14a6867aec1f049ad9b9ab669"

# 启动
dsh --profile web
```

#### Windows

PowerShell：

```powershell
Remove-Item Env:DSH_HOME -ErrorAction SilentlyContinue
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37"
dsh --profile web
```

cmd.exe：

```bat
set "DSH_HOME="
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37"
dsh --profile web
```

两种宿主、两个平台都是**一条命令**：不需要额外授权、不会出现
`ERR_PNPM_IGNORED_BUILDS`、不需要改 `allowBuilds`；安装后 profile 的 bundles 自动包含
`@icomposer/workbench`。

### 更新

同一个包里版本号可能不变，**必须 remove 再 add**（同一条 spec）：

```bash
# macOS / Linux + Desktop（先退出 App）
( set -eu
  DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  /usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop remove @icomposer/workbench
  /usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37"
)

# macOS / Linux + Web
( set -eu
  dsh plugin --profile web remove @icomposer/workbench
  dsh plugin --profile web add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37"
)
```

Windows（cmd.exe 同理，把 `set "DSH_HOME="` 放在最前）：

```powershell
dsh plugin --profile desktop remove @icomposer/workbench
dsh plugin --profile desktop add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37"
```

`set -eu` + 子 shell 保证任一步失败就停：remove 失败不会继续 add。

### 验证

1. 重新打开 App（或重新执行 `dsh --profile web`）。
2. 打开 **Settings → InsureMO**，应能看到 InsureMO 设置分区。
3. 侧栏应显示 InsureMO 品牌，底部 Profile 选择器能列出 profile 并切换生效。
   - **官方 macOS Desktop**：收起侧栏是 **0 宽、没有 rail**，需要先 “Open sidebar”
     展开侧栏才能看到底部选择器。
   - **Web**：收起后是 **56px rail**，Active Profile 选择器在这里以**浮层**打开
     （面板定宽、锚在触发按钮上、按视口收拢）。

### 0.1.2 增补：安装预览与诊断

安装前的已知 Skills 目录校验与 Refresh 使用相同的公开目录命令和输出环境，
再精确验证选中名称；正式安装仍只携带选中项，不放宽白名单或输出解析规则。
CLI 即使退出码为 0，格式异常、输出截断或选中项消失也会留下可供 Diagnose 读取的
脱敏诊断（含真实命令、退出码和拒绝原因）。Windows 用户已复测目录刷新、安装通过；
原失败输出未取得，不据此追认具体格式根因。

已验证的 **0.1.2** 已合入上面的兼容版本分发通道，临时带版本后缀的分支已合并并删除，
不重写历史。旧具体 pin（如 `002eb6f2…`）仍在该通道历史中可达，继续可复现；
若之前按临时分支名安装，下次更新请 remove 后 add 上面的通道或新 commit pin。
当前已安装的测试包实现不变，无需立即重装。

### Skills 操作超时（0.1.2 起）

目录刷新不再额外截断为 15 秒，而是与安装、更新、移除共享
`insuremoService.skillActionTimeoutMs`：默认 **180000 毫秒（3 分钟）**，
运行时最多 **300000 毫秒（5 分钟）**。仍保留总超时、取消和并发合并，不能设为无限等待。
普通 IMO/已安装库存读取的 `timeoutMs` 不受此修改影响。

完全退出 Desktop 后，编辑 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`
（macOS/Linux：`~/.dsh/profiles/desktop/cordis.patch.yml`）；Web 则编辑对应的
`profiles/web/cordis.patch.yml`。将下面条目合并到现有顶层数组，**保留其它配置**，
已有同一 `id` 时只合并其 `config`：

```yaml
- id: icomposer-workbench
  config:
    insuremoService:
      skillActionTimeoutMs: 240000 # 4 分钟，单位毫秒
```

保存后重新启动 App/Web 宿主。当前设置页没有这个输入框，需通过 profile 配置调整。
**此行为从 0.1.2 起生效。旧 0.1.1 分发仍有 15 秒目录刷新上限，仅修改配置不能绕过，请先升级到 0.1.2。**

### 故障排查

- `env: ~/.local/bin/env: Permission denied`（路径随环境不同）或 `grc: ... Permission denied`：
  PATH 最前有一个**不可执行**的 `env`（uv 风格的 PATH 片段脚本常见），shell 的着色包装
  （grc）把它当命令解析。与本插件无关。改用绝对路径 `/usr/bin/env -u DSH_HOME …`，
  或先 `(unset DSH_HOME; dsh …)` 再执行。
- `dsh: profile "desktop" is managed exclusively by the Electron application`：用了系统里
  另装的旧版 `dsh`。macOS 用 App 自带的绝对路径；Windows 用 App 注册的 `dsh.cmd` 或
  安装目录里的绝对路径。
- `Open DeepSeek Harness Desktop once to initialize its profile…`：Desktop profile 还没被
  App 初始化 —— 先启动一次 App。若 App 仍在运行，先完全退出再执行。

### 回滚 / 卸载

回滚 = 先 remove，再 `add` **旧版本的 spec**（上一版的 commit 或旧分支）：

```bash
( set -eu
  DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  /usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop remove @icomposer/workbench
  /usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#<old-commit-sha>"
)
```

只卸载：

```bash
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
/usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop remove @icomposer/workbench
```

不要把整个 profile 目录（`~/.dsh/profiles/desktop`，Windows 为
`%USERPROFILE%\.dsh\profiles\desktop`）换成别处的副本：那会一并覆盖 profile 里其它
插件与宿主写入的状态，把一次插件回滚变成 profile 事故。

### 兼容性与风险

- 所有 dsh profile 共用同一个 `~/.dsh`（`~/.dsh/profiles/` 下并列 `desktop`、`web`
  等；Windows 为 `%USERPROFILE%\.dsh`）：凭据与 session 数据是共享的。
- 不同版本对凭据、session 的格式**不做双向兼容承诺**：升级后不要让旧宿主继续复用
  同一份数据，降级同理；跨版本切换前先备份。
- 跨大版本回滚应连同宿主一起回退。
- 动手前先备份：`cp -R ~/.dsh ~/.dsh.bak-$(date +%Y%m%d)`。
- 只装插件、只删插件；不要手工改 profile 的依赖或整目录替换。

### 备注：`&path:` 子目录形式才需要授权

如果不用分支根 spec，而是改用 `github:akirajoey/insuremo-dsh#main&path:git-dist/icomposer-workbench`
这种**子目录**形式，pnpm 会对 git 子目录做隐式打包，首次 `add` 会 exit 1 并报
`ERR_PNPM_IGNORED_BUILDS`，需要在 profile 的 `pnpm-workspace.yaml` 里把 dsh 写入的
`allowBuilds` 占位值改成 `true` 再重跑（Desktop：
`~/.dsh/profiles/desktop/pnpm-workspace.yaml`；Web：`~/.dsh/profiles/web/pnpm-workspace.yaml`；
Windows 在 `%USERPROFILE%\.dsh\profiles\<profile>\pnpm-workspace.yaml`）。
**主路径（分支根 spec）不需要这一步。**

### 备选：离线 / 无网（clone + pack）

没有外网、或要验证工作副本时，取仓库后把 payload 打成 tgz 再安装：

```bash
( set -eu
  DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  WORKDIR="$(mktemp -d)"
  git clone --depth 1 --branch plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37 https://github.com/akirajoey/insuremo-dsh "$WORKDIR/repo"

  PACK_DIR="$WORKDIR/pack"
  mkdir -p "$PACK_DIR"
  /usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop --dir "$WORKDIR/repo" pack --pack-destination "$PACK_DIR"
  /usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "$PACK_DIR"/*.tgz

  rm -rf "$WORKDIR"
)
```

**不要用 `add .` 直接加目录**：那是 link 安装，文件留在原地，容易出现
`ERR_MODULE_NOT_FOUND`。

更细的逐条说明（包内容、宿主差异）见
[`packages/icomposer-workbench-dist/README.md`](packages/icomposer-workbench-dist/README.md)。

## 分发形态

`packages/icomposer-workbench-dist`（包名 `@icomposer/workbench`）是分发包本体；
本仓库把它的预构建产物发布成**独立的 payload 根分支**：

| 分支 | 版本 | 面向 | 说明 |
|---|---|---|---|
| `plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37` | **0.1.2** | dsh >= 0.2.1-rc.2 | **本版主路径** |
| `1369a924…`（commit pin） | 0.1.1 | dsh >= 0.2.1-rc.2 | 旧版冻结快照，仍有 15 秒目录刷新上限；通道现已推进至 0.1.2 |
| `plugin-dist-0.2` | 0.1.0 | dsh >= 0.2.1-rc.2 | 更早版本，**保留原 SHA 不覆盖** |
| `plugin-dist` | 0.1.0 | 0.1 宿主 | 旧通道，**保留原 SHA**，新宿主不要用 |

表中的分支或 commit 都对应 **payload 根目录**（根目录就是 `@icomposer/workbench` 包）。
当前兼容通道已快进合入验证通过的 0.1.2；旧版仍可 pin 原始 commit，历史未被重写。
更早的 `plugin-dist-0.2`、`plugin-dist` 分支保持不动。

```sh
# 主路径：分支根 spec（一条命令）
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#plugin-dist-dsh-0.2.1-rc.2-imo-0.2.37"

# 可复现：pin 精确 commit
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
/usr/bin/env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#ae99dfefffaa4ebbb3adc7550d4a035b9190faa4"

# 备选：离线/无网时 clone 后 pack 成 tgz 再 add（见「备选：离线 / 无网」）

# npm（未来发布，尚未发布）
dsh plugin --profile web add @icomposer/workbench
```

仓库内仍然保留 `git-dist/icomposer-workbench/` 作为**已跟踪的预构建副本**，供
`#path:` 子目录形式（需一次性授权）和离线打包使用；但它**不是**主路径。

不要使用指向 `packages/icomposer-workbench-dist` 的 `#path:` 地址：那是**开发源码
目录**（未构建、含 scripts 与 devDependencies），安装会失败。

### Release tooling（维护者）

`node scripts/pack-dist.mjs` 构建自包含 tarball
（`dist-release/icomposer-workbench-<version>.tgz`，预构建 `lib/`，不含同级源码），
`pnpm pack:git-dist` 原子刷新 `git-dist/icomposer-workbench/`，
`pnpm check:git-dist` 强制其与源码零漂移。三者是 **single-writer**：
tsdown 会在每次构建时重写共享的源 `lib/`，Git 目标通过 staging/backup 换入。

`pack:bootstrap` 生成的 npm bootstrap 包
（`packages/insuremo-dsh-workbench-bootstrap`，自带固定 harness 与 bundled pnpm）
是**另一条分发通道**：它服务的是自带运行时的 `insuremo-dsh` 启动方式，
**不是**本次装进官方 Desktop 的升级路径，两者不要混用。其生成模型见该包 README，
发布闸门见 `scripts/check-bootstrap.mjs`。

## 开发（本仓库）

以下内容只与开发/发布有关；普通安装不需要。

### Prerequisites

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- the isolated Harness worktree at `../deepseek-harness`, commit
  `687f282e8625c6b8d11ff58211a90524be2e4317` (npm `0.2.1-rc.2`).

### Isolated upgrade setup and validation

Use **only** the two worktrees under `upgrade-dsh-0.2.1`; do not modify an
existing installation or `~/.dsh`. See [migration setup and smoke instructions](docs/dsh-0.2.1-migration.md).
No global install/link or desktop build is needed. Setup does not start a service.

```sh
node scripts/setup-isolated.mjs
pnpm check
pnpm typecheck
pnpm bundle
pnpm pack:dist
pnpm pack:git-dist
pnpm check:git-dist
node scripts/test-migration.mjs
```

`pnpm check` validates the local Harness commit and the Node/pnpm versions
against `compatibility.json`. `pnpm typecheck` checks all TypeScript package
sources. `pnpm test` runs the operation-log storage tests and generates/checks
the contract JSON Schema artifacts.

In a clean checkout the Harness preset must be checked out beside Workbench at
`../deepseek-harness` at the exact `compatibility.json` commit, `687f282e86`.
The isolated setup recipe above installs the minimal preset/test requirements
and a separately pinned npm runtime without building the harness. For this
upgrade, use the exact-runtime isolated CLI and real browser/HTTP smoke in
[the migration guide](docs/dsh-0.2.1-migration.md), not the legacy source-launch
`verify-standard-install.mjs` utility.

To generate schemas directly:

```sh
pnpm --filter @icomposer/workbench-contracts run gen-json-schema
```

The generated files are written to
`packages/workbench-contracts/dist/*.schema.json`. They are build artifacts and
are intentionally ignored by Git; rerun the generation command after a clean
install.

### Development-mode profile smoke

The profile setup stays isolated from the real `~/.dsh`. By default it writes
to `.dsh-home/`; set `DSH_HOME` to another isolated directory when needed.
The setup script copies the source profile, rewrites its local bundle dependency
for the selected repository, and runs `pnpm install` in the profile directory.

```sh
pnpm run setup-profile
cd ../deepseek-harness
DSH_HOME=../icomposer-workbench/.dsh-home pnpm dsh --profile icomposer-web --dump-config
```

The composed dump should contain `workbench-test`, `workbench-operation-log`,
`insuremo-service`, `ui-insuremo-settings`, `ui-insuremo-status`, and
`ui-workbench-jobs` rows from `@icomposer/bundle-workbench`; the
`workbench-operation-log` row requires the Harness `storageDomain` service and
`insuremo-service` requires `subprocess` and the Workbench `operationLog`
service. The setup script refuses to target the real `~/.dsh` path.

### Operation evidence layer

`@icomposer/workbench-operation-log` is a Host-only storage provider for
side-effect evidence. It records pending operations and supports the one-way
`pending → approved|rejected` decision flow. Records contain only digests,
artifact references, identifiers, and decision metadata — never request
payloads or credentials. The package owns the `operation/record`,
`operation/list`, and `operation/decide` v0 contracts and emits recorded/decided
events after durable JSON-domain writes.

The package's focused tests use a temporary JSON backend:

```sh
pnpm --filter @icomposer/workbench-operation-log run test
```

### Client plugin development

`@icomposer/ui-insuremo-settings` is the first client-side placeholder. It
registers the localized `settings.section` slot and builds with Strategy A:
the package reuses the Harness `clientBundle` tsdown preset. The preset emits
the Host no-op half and a browser closure factory at `lib/client.js`; React and
other platform modules remain module-table externals.

```sh
pnpm --filter @icomposer/ui-insuremo-settings run test
pnpm bundle
```

The browser test uses the Harness production SlotRegistry and
`@deepseek-ai/dsh-client-test-runtime`; it verifies localized navigation,
placeholder rendering, and disposal.

`@icomposer/ui-insuremo-status` owns the sidebar brand slots
(`sidebar.brand.mark` / `sidebar.brand.name`), the hero mark
(`conversation.hero.brand.mark`), and the footer Active Profile picker
(`sidebar.footer.action`). The wide identity row renders the wordmark alone —
the wordmark raster already carries the globe — while the collapsed rail keeps
the standalone globe; the hero always keeps its own globe. The picker reuses the
Harness `Button` atom (compact ghost form) and its rows follow the official menu
row metrics.

```sh
pnpm --filter @icomposer/ui-insuremo-status run test
```

`@icomposer/ui-workbench-jobs` registers the keyed `workbench-job` renderer in
`conversation.chat.node`. It projects Harness `jobsBySession` `JobView` rows
through `projectJobView()` without owning mutable job state. The durable
conversation event/node producer is deferred, so this phase renders explicit
node props and keeps the row read-only.

```sh
pnpm --filter @icomposer/ui-workbench-jobs run test
```

### IMO CLI probe

`@icomposer/insuremo-service` is the Host-only, read-only seam for the IMO CLI.
`ImoCliService` provides `ctx.imoCli` with `probe()`, `version()` (runs
`imo --version`), and `upgradeCheck()` (runs `imo upgrade --check`). Every
child operation routes through Harness `ctx.subprocess` with explicit argv,
stdio limits, a grace period, and a deadline AbortSignal; failures are returned
as structured `ImoResult` errors, and raw output is never returned (only
SHA-256 digests and parsed fields). Authentication has its own Host-only seam
below; this probe itself never prepares or stores credentials.

```sh
pnpm --filter @icomposer/insuremo-service run test
```

### IMO upgrade loop

`ImoUpgradeService` (`ctx.imoUpgrade`) turns the read-only probe into an
approval-gated, single-instance upgrade closed loop. `requestUpgrade` appends
an `imo-upgrade` operation record (params digest); the operator decides it
with the existing operation-log API; `executeUpgrade` refuses to spawn without
an `approved` record, records pre/post versions, runs
`imo upgrade [--version X] --yes` plus the read-only smoke battery through
`ctx.subprocess`, and writes a digest-only receipt back via
`operationLog.recordResult`. Failures keep the exit code, stderr digest, and an
explicit restore command; the service never downgrades automatically and never
runs a real upgrade without explicit operator authorization (tests use fake
`imo`).

```sh
pnpm --filter @icomposer/insuremo-service run test
```

### Skills inventory

`ctx.imoSkills` is the read-only bridge for installed InsureMO Skills:
`list(project|global)` parses `@insuremo/skills-tool list --json [-g]` (run
through `npx`; the IMO CLI exposes no `skills` command in the observed 0.2.37),
`configPath()` reports the tool's config path plus file existence, and
`validate()` checks that each reported directory contains `SKILL.md` without
discarding healthy rows when one is damaged, backfilling each description from
the frontmatter it already parses. `validate(scope, signal, listed)` accepts a
list result the caller just read so a full overview does not query twice. Raw
CLI output stays behind a digest boundary.

The service now registers a real `insuremo` provider into Harness
`@deepseek-ai/dsh-skill` at plugin apply time. It validates the global IMO
inventory, emits only healthy kebab-case candidates at rank 450 (project/local
ranks 100–300 win; IMO wins over generic user-agent/bundled ranks 500/600), and
loads the canonical `SKILL.md` body only through `get()`. Candidate locators are
opaque provider-issued identities; every `get()` repeats home-root realpath and
regular-file checks, rejects forged/escaped/symlinked paths, and never copies
body content into inventory events, operation records, or list results.
Frontmatter is bounded to a 64 KiB closing delimiter and complete files to 1 MiB;
only allowlisted scalar metadata is exposed. Inventory fingerprints establish a
baseline and invalidate the Harness catalog only when the matching global
inventory changes. Same-name/path body edits deliberately require the safe
host-internal `invalidateInsuremoSkillCatalog(ctx)` signal after a successful
future write action; they are not inferred from the structural fingerprint.
Provider disposal unregisters it and disables later reads.

```sh
pnpm --filter @icomposer/insuremo-service run test
```

### Auth profile and prepare lease

`ctx.imoAuth` is the single Host-only authentication seam. `listProfiles()`
allowlists and renames only known profile metadata; `defaultProfile()` returns
only a profile name; and `validate()` returns sanitized status plus a digest.
No auth command output is forwarded raw.

`prepare({ profile, env })` stores the parsed credential only in a process-memory
cache and returns an opaque lease. The lease exposes sanitized `view` and cache
metadata; the access token exists only as the argument to `lease.use(callback)`.
It is absent from enumerable properties, JSON, inspection, structured clones,
events, logs, operation records, and error messages. Same profile/environment
prepares coalesce and reuse until explicit `invalidate()`. A 401 invalidates
that key for the next explicit prepare; a 403 reports forbidden without
invalidation or retry. Fiber disposal clears the cache. The `lease.use`
callback owns responsibility for its secret: returning, logging, or throwing
it can intentionally leak the token, so callbacks should perform the remote
call without returning the secret. Login and remote-profile actions are kept on
the separate approval-gated `ctx.imoAuthActions` seam below.

### Auth actions approval loop

`ctx.imoAuthActions` exposes `requestPortalLogin()`, `requestRemote()`, and
`requestDefaultSwitch()`, each followed by an existing operation-log approval
and the matching execute method. Unapproved operations never spawn. Receipts
contain only action kind/status, exit code, digests, timestamps, and sanitized
profile/environment identifiers; action events contain only operation ID, kind,
status, and result digest.

`listEnvironmentIds()` uses `imo complete --type env` and filters strict full
IDs: segmented alphanumeric IDs must contain `_insuremo_`, cannot begin with
an option marker, and reject token/OAuth/cookie/state/secret-like segments.
`resolveEnvironmentHint()` returns an exact candidate or a sanitized
not-found/ambiguous result; `requestRemote()` accepts only an ID confirmed by
the same source-profile resolver set. Portal login always sends `--env portal`;
non-portal and manual flows are rejected with structured errors. No action ever
adds `--insecure`.
Pending action arguments are intentionally in-memory only; a process restart
loses them and requires a new request. Login/remote/default writes are never
run by tests or real smoke.

```sh
pnpm --filter @icomposer/insuremo-service run test
```

#### Service module architecture

`packages/insuremo-service/src/index.ts` is a small public barrel and Cordis
composition boundary. Configuration, subprocess execution, CLI probing,
upgrades, Skills inventory, and Auth leases live independently in
`config.ts`, `run.ts`, `cli.ts`, `upgrade.ts`, and `skills.ts`; Auth is a
controlled submodule under `auth/index.ts` with contracts in `auth/types.ts`,
URL/allowlist parsing in `auth/sanitize.ts`, opaque leases in `auth/lease.ts`,
cache/coalescing in `auth/service.ts`, and approval actions in
`auth/environment.ts`/`auth/actions.ts`. The operation log is referenced only
through `operation-log-face.ts`.

### Phase 3 — Workspace binding (core, local-write)

`@icomposer/workspace-binding` reuses Harness `ctx.workspaceRegistry` (hard inject `[storageDomain, workspaceRegistry]`) and adds a durable overlay `workbench_workspace_binding` v1 (`bindings` table, strict record, `revision>=1`). It never accepts caller paths and never creates/deletes workspaces or source files; `canonicalPath`/`displayName`/`status` are read only from the registry entity.

Frozen `ctx.workspaceBinding` face: `list(signal?)` / `get(workspaceId)` / `bind({workspaceId,environmentId,tenantCode?,authProfile?,writeMode,expectedRevision})` / `unbind({workspaceId,expectedRevision})` — all `Result<T>` with fixed codes (`binding-conflict`, `path-already-bound`, `revision-conflict`, `service-disposed`, …). `bind` validates full InsureMO `environmentId` (`_insuremo_` + sensitive-segment rejection), narrow `tenantCode`/`authProfile`/`writeMode`, and enforces `expectedRevision` CAS, identity immutability, no-op (no bump), and orphan `path-already-bound` fail-safe. `list` follows registry order, includes unbound (`binding:null`) and orphan bindings. Single-host/single-writer; `env`/`tenant` are immutable after first bind; auth truth is verified only when a later remote action prepares a lease.

No browser transport exists yet — binding is local-write only.

## Workspace layout

```text
packages/
├── workbench-contracts/       # Workbench API v0 types and runtime schemas
├── plugin-workbench-test/       # Host-only Service Definition/provider smoke plugin
├── insuremo-service/            # IMO CLI read probes + approved upgrade loop
├── workbench-operation-log/     # Digest-only operation evidence provider
├── ui-insuremo-settings/        # Client Settings > InsureMO section
├── ui-insuremo-status/          # Client brand slots + footer Active Profile picker
├── ui-workbench-jobs/           # Client keyed job conversation node
├── icomposer-workbench-dist/    # Distributable plugin bundle (@icomposer/workbench)
└── bundle-icomposer-workbench/  # Profile patch layer for Workbench plugins
profiles/
└── icomposer-web/             # Source profile manifest and empty user patch
git-dist/
└── icomposer-workbench/       # Tracked prebuilt payload consumed by installs
scripts/
├── check-compatibility.mjs
└── setup-profile.mjs
compatibility.json
```
