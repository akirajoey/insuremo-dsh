# iComposer Workbench

`icomposer-workbench` 是承载 Workbench Host/Client 插件的独立 pnpm workspace。
DeepSeek Harness 是固定、只读的兼容基线：它不会被复制进本仓库，也不会被
Workbench 的包修改。

---

## 安装

插件以 GitHub spec 指向仓库里**已跟踪**的预构建目录 `git-dist/icomposer-workbench/`：
安装即用（零构建）、不是目录 link 安装；不需要 clone 仓库、不需要构建 harness、
也不需要 `pnpm install`。

> 整条 spec 必须用引号包住：`&` 是 shell 的运算符，不加引号会被当成后台执行并把
> 参数截断。

### 官方 Desktop（默认 profile）

前置：

1. 已安装官方 **DeepSeek Harness Desktop**；下面命令在官方 **0.2.1-rc.2** 上验证
   （包内 `engines.dsh` 为 `>=0.2.1-rc.2 <0.3.0-0`）。
2. **先启动一次 App**，让它初始化默认 profile（`desktop`）。
3. 之后**用 ⌘Q 完全退出 App**再执行 CLI 命令：
   - profile 尚未被 App 初始化时，CLI 会提示 “Open DeepSeek Harness Desktop once to
     initialize its profile, then fully quit it before running dsh plugin --profile desktop.”；
   - App 仍在运行时，命令可能以其它方式失败（profile 被占用/写入冲突），**不保证**
     是同一条提示。两种情况都请先 ⌘Q。
4. 必须使用 **App 自带的官方 CLI**（绝对路径）：本机另装的旧版 `dsh` 会直接拒绝
   `--profile desktop`（该 profile 由 Electron App 独占管理）。

```bash
# 官方 App 自带的 CLI（绝对路径；macOS 默认安装位置）
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

# 推荐：pin 到某个 commit，安装内容可复现
env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#<commit-sha>&path:git-dist/icomposer-workbench"

# 或者跟随 main（内容随提交漂移，只在想拿最新时使用）
env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#main&path:git-dist/icomposer-workbench"
```

- `env -u DSH_HOME` = **不继承** shell 里残留的 `DSH_HOME`，让官方 CLI 使用默认
  `~/.dsh`（默认 profile 在 `~/.dsh/profiles/desktop`）。要装到别的 home 才显式设。
- 装完**像平常一样点击 App 图标重新打开**，不要用 `.command` 之类的启动脚本。

### Web UI（profile `web`）

Web 宿主由本机安装的 `dsh` 启动，要求 **dsh >= 0.2.1-rc.2**；**0.1 的旧宿主不兼容**。

```bash
# 安装到 web profile（整条 spec 同样要加引号）
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#main&path:git-dist/icomposer-workbench"

# 或固定 commit
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#<commit-sha>&path:git-dist/icomposer-workbench"

# 启动
dsh --profile web
```

### 更新

同一个包里版本号可能不变，**必须 remove 再 add**，不要指望 `add` 覆盖已有安装。

```bash
# 官方 Desktop（先 ⌘Q）
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

### 验证

1. 重新打开 App（或重新执行 `dsh --profile web`）。
2. 打开 **Settings → InsureMO**，应能看到 InsureMO 设置分区。
3. 侧栏应显示 InsureMO 品牌，底部 Profile 选择器能列出 profile 并切换生效。
   - **官方 macOS Desktop**：收起侧栏是 **0 宽、没有 rail**，需要先 “Open sidebar”
     展开侧栏才能看到底部选择器。
   - **Web**：收起后是 **56px rail**，Active Profile 选择器在这里以**浮层**打开
     （面板定宽、锚在触发按钮上、按视口收拢）。

### 回滚 / 卸载

回滚 = 先 remove，再 `add` **旧 commit 的 spec**（用发布记录里的 SHA）：

```bash
( set -eu
  DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop remove @icomposer/workbench
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#<old-commit-sha>&path:git-dist/icomposer-workbench"
)
```

只卸载：

```bash
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop remove @icomposer/workbench
```

不要把整个 profile 目录（`~/.dsh/profiles/desktop`）换成别处的副本：那会一并覆盖
profile 里其它插件与宿主写入的状态，把一次插件回滚变成 profile 事故。

### 兼容性与风险

- 所有 dsh profile 共用同一个 `~/.dsh`（`~/.dsh/profiles/` 下并列 `desktop`、`web`
  等）：凭据与 session 数据是共享的。
- 不同版本对凭据、session 的格式**不做双向兼容承诺**：升级后不要让旧宿主继续复用
  同一份数据，降级同理；跨版本切换前先备份。
- 跨大版本回滚应连同宿主一起回退。
- 动手前先备份：`cp -R ~/.dsh ~/.dsh.bak-$(date +%Y%m%d)`。
- 只装插件、只删插件；不要手工改 profile 的依赖或整目录替换。

### 离线 / 维护者安装（备选）

没有外网、或要验证工作副本本身时，把本地 payload 打成 tgz 再安装：

```bash
( set -eu
  DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  PLUGIN_DIR="$PWD/git-dist/icomposer-workbench"   # 在仓库根执行；已在 payload 包根则用 $PWD
  PACK_DIR="$(mktemp -d)"
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop --dir "$PLUGIN_DIR" pack --pack-destination "$PACK_DIR"
  env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "$PACK_DIR"/*.tgz
  rm -rf "$PACK_DIR"
)
```

逐条说明（含 Web 宿主差异与包内容）见
[`packages/icomposer-workbench-dist/README.md`](packages/icomposer-workbench-dist/README.md)。

## 分发形态

`packages/icomposer-workbench-dist`（包名 `@icomposer/workbench`）是分发包本体；
`git-dist/icomposer-workbench/` 是它**已跟踪**的预构建副本——上面所有安装/更新/回滚
都通过 GitHub `#path:` 指向它。

```sh
# 默认形态：GitHub 预构建路径（零构建安装，见「安装」）
dsh plugin --profile web add "github:akirajoey/insuremo-dsh#main&path:git-dist/icomposer-workbench"

# 可复现：pin 精确 commit（SHA 以发布记录为准）
DESKTOP_DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
env -u DSH_HOME "$DESKTOP_DSH" plugin --profile desktop add "github:akirajoey/insuremo-dsh#<commit-sha>&path:git-dist/icomposer-workbench"

# 离线：本地 payload 打成 tgz 再 add（见「离线 / 维护者安装」）

# npm（未来发布）
dsh plugin --profile web add @icomposer/workbench
```

不要再使用指向 `packages/icomposer-workbench-dist` 的 `#path:` 地址：那是**开发
源码目录**（未构建、含 scripts 与 devDependencies），安装会失败；旧版
`plugin-dist` 分支也只适配旧宿主，不要装进 0.2.1。

`git-dist/` 只有 `package.json` 里**没有 scripts、没有 devDependencies** 的瘦
清单，因此安装不会触发 prepare/构建，也不受 pnpm `allowBuilds` 影响。

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
`list(project|global)` parses `imo skills list --json [-g]`, `configPath()`
reports the declarative config path plus file existence, and `validate()` checks
that each reported directory contains `SKILL.md` without discarding healthy
rows when one is damaged. Raw CLI output stays behind a digest boundary.

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
