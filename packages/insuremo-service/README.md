# `@icomposer/insuremo-service`

Host-only IMO CLI capability for the Workbench. `ImoCliService`
provides `ctx.imoCli` with:

- `probe()` — resolve the configured `imo` executable without starting it;
- `version()` — run `imo --version` and return the parsed version plus a
  SHA-256 stdout digest;
- `upgradeCheck()` — run `imo upgrade --check` and return current/target
  versions, update availability, and a SHA-256 stdout digest.

Every child operation goes through Harness `ctx.subprocess` with explicit
argv, cwd, stdio collection limits, grace period, and an AbortSignal deadline.
No shell is used, no environment is passed explicitly, and credential-shaped
ambient variables remain governed by the Harness subprocess scrubber. Failures
are returned as structured `ImoResult` errors; raw stdout/stderr is never
stored or returned.

The read-only `ImoCliService` does not install or upgrade IMO, authenticate,
call remote APIs, or provide UI. `ImoUpgradeService` and the Auth actions seam
below are the only side-effecting surfaces; both require an approved operation
record.

## Approved upgrade loop

`ImoUpgradeService` provides `ctx.imoUpgrade` — the approval-gated, single-
instance IMO upgrade closed loop:

- `requestUpgrade(targetVersion?)` appends a pending `imo-upgrade` operation
  record (with a params digest) and returns its `operationId`;
- the operator approves/rejects the record through the existing
  `operationLog.decide` API (not reimplemented here);
- `executeUpgrade(operationId)` refuses to start unless the record is
  `approved` (no process is spawned otherwise), enforces one in-flight upgrade
  (`busy`), records the pre/post versions, runs
  `imo upgrade [--version X] --yes` and the read-only smoke battery, and writes
  a digest-only receipt back through `operationLog.recordResult`;
- failures (non-zero exit, timeout) produce a `status: 'failed'` receipt with
  exit code, stderr digest, and an explicit restore command — the service never
  downgrades automatically.

Every child process still routes through `ctx.subprocess` with explicit argv,
stdio limits, a grace period, and a deadline AbortSignal. The loop never runs a
real upgrade implicitly: it requires a prior approval, and a real run further
requires an explicit operator authorization (`[REAL_RUN]`) — tests run only
against fake `imo` scripts.

```sh
pnpm --filter @icomposer/insuremo-service run test
```

## Read-only Skills inventory

`ImoSkillsService` provides `ctx.imoSkills` with three read-only operations:

- `list('project' | 'global')` runs `imo skills list --json [-g]`, preserving
  the reported `{ name, description, path }` rows and returning only a
  stdout digest alongside them;
- `configPath()` runs `imo skills config path`; a missing config file is a
  normal `{ exists: false }` result;
- `validate(scope)` resolves each listed path under the current `homedir()`
  only, rejects lexical and realpath/symlink escapes before candidate access,
  and checks `SKILL.md` without aborting the whole inventory when one row is
  damaged. The result exposes `inventoryComplete` and per-row reasons.

The package also mounts a real `insuremo` provider into Harness
`@deepseek-ai/dsh-skill` during plugin apply. It uses the global inventory,
assigns rank 450 (between user-dsh and user-agents), and emits only healthy
kebab-case candidates with canonical `SKILL.md` paths and directory resource
bases. The provider accepts only its opaque issued locators, repeats home-root
realpath/regular-file checks in `get()`, and reads the body on demand only.
Frontmatter closes within 64 KiB and complete files are capped at 1 MiB;
invalid YAML, unclosed/oversize files, missing files, and escaped symlinks are
unloadable without taking healthy candidates out of the catalog. Metadata is a
small allowlist of scalar fields; names/descriptions remain inventory-owned.
Inventory fingerprint changes call the real registry invalidator once, while a
first observation establishes a baseline and avoids list→event→invalidate
loops. Inventory fingerprints intentionally cover structure (name,
description, path), not same-path body edits; later approved write actions must
call the safe host-internal `invalidateInsuremoSkillCatalog(ctx)` signal after a
successful mutation. Disposal unregisters the provider and stops
invalidation/loads.

### Durable activation gate

Installed and enabled are deliberately separate. The first successful global
inventory adopts the currently valid Harness skill names as enabled, preserving
the existing 16-skill experience. The durable
`workbench_imo_skill_activation` v1 domain stores only the global activation
record (`initialized`, sorted `enabledNames`, monotonic `revision`, and
`updatedAt`). A later installed name is reported as `disabled` until an
approval action explicitly enables it; removed enabled names are reported as
`stale` and can be cleared by reconcile. Activation storage failures are
fail-closed: the provider exposes no new candidates and reports an incomplete
observation. Activation changes increment the revision once and emit only
bounded counts/revision metadata, which drives one catalog invalidation. The
public `ctx.imoSkillActivation` value is a frozen two-method read facade;
enable/disable/reconcile stay in an internal composition closure for the
approval action seam. Both provider `list()` and `get()` take a final
revision/enabled snapshot after scanning or body loading, so a completed
disable cannot publish an old candidate. Owner disposal synchronously revokes
both the read facade and internal controller; late calls return the fixed
`service-disposed` error, queued work is skipped, in-flight writes drain, and
the domain opened by the runtime is closed exactly once.

The JSON storage backend is a single-host, single-writer medium for this
state. Two independent `JsonStorageBackend` instances pointed at the same
root are unsupported by Harness: there is no cross-process CAS and concurrent
writers can produce last-writer-wins behavior. The Workbench serializes one
service instance and uses expected revisions for its approval boundary; it
does not claim multi-context atomicity or add a second lock layer.

## Architecture

The Host package keeps domain seams independent of the barrel:

- `src/config.ts` owns shared loader configuration and defaults;
- `src/run.ts` owns the `ctx.subprocess` runner, deadlines, digests, and
  allowlisted status classification;
- `src/cli.ts`, `src/upgrade.ts`, and `src/skills.ts` own their respective
  service contracts and implementations; `src/skill-path.ts` shares the
  containment resolver and `src/skill-provider.ts` owns real Harness catalog
  registration and bounded on-demand loading;
- `src/auth/index.ts` is the controlled Auth domain barrel: `types.ts` holds
  lease contracts, `sanitize.ts` owns allowlists/URL parsing, `lease.ts` owns
  opaque leases, `service.ts` owns cache/coalescing/invalidation, and
  `environment.ts`/`actions.ts`/`action-types.ts` own the approval-gated Auth
  write seam;
- `src/skill-actions/` is the Skills write-action seam: `types.ts` defines the
  four kinds, `validation.ts` normalizes strict source/agent/argv inputs,
  `preview.ts` performs read-only previews, `diff.ts` snapshots bounded
  inventory digests, `finalize.ts` emits the single approved receipt, and
  `service.ts` owns the approved `ctx.imoSkillActions` closed loop;
- `src/overview/` is the read-only Overview/Diagnostics bridge: `types.ts`
  owns the strict allowlist view, `snapshot.ts` aggregates IMO/auth/skills/
  activation/operations into per-section statuses, `service.ts` exposes
  `ctx.imoOverview.snapshot` with coalescing and an optional short TTL, and
  `route.ts` mounts the web-only same-origin GET bridge;
- `src/index.ts` is only the public export/context augmentation and plugin
  composition boundary. `operation-log-face.ts` remains the structural
  operation-log dependency and no domain module imports the bundle.

Auth cache state and lease secrets remain module-owned/private to the Auth
submodule; `run.ts` never returns raw stdout/stderr on failure.

## Read-only overview bridge

`ctx.imoOverview.snapshot(signal?)` aggregates the read-only probes into a
single strict-allowlist view (`imo`, `auth`, `skills`, `operations`, and
`diagnostics` sections). Each section is best-effort with a fixed
`status`/`code`; partial failure never fails the whole snapshot. Concurrent
calls coalesce onto one in-flight build, and an optional TTL (≤5000 ms, `0`
disables) caches completed views only for signal-free requests. The web-only
`GET /api/icomposer-workbench/insuremo/overview` route serves it same-origin
with `no-store`, `nosniff`, and no CORS; non-GET answers 405 with `Allow:
GET`, and the route 404s once disposed. It is a read bridge only — the write
transport (POST/approve/execute) with its CSRF/Origin design is a documented
Phase 2 risk, not this package.

## Skills write actions

`ctx.imoSkillActions` is the approved write seam for `skill-install`,
`skill-update`, `skill-remove`, and `skill-activation`. It is mounted by the
root composition closure once the internal activation controller is live, and
it never enters the Context object graph. Requests run read-only previews
first (install `--list`, remove/update inventory snapshots, activation
revision capture) and only append an operation-log record afterwards; pending
arguments live only in process memory, so a restart returns
`missing-pending-input`. Execution is gated by `exists / approved /
digest-bound / not executed / busy` before any spawn, then a successful run
diffs the bounded global inventory (name + manifest digest), reconciles or
preserves activation, and performs one safe catalog invalidation. Only
global scope is accepted today; project returns `workspace-not-bound` until
Phase 3. Install never auto-enables a new skill; remove clears stale names;
update leaves the enabled set untouched; activation uses the captured expected
revision as a CAS so a concurrent change finalizes a failed receipt. Sources
are typed (`alias`, HTTPS git with an allowlisted host and stripped
userinfo/query/hash, strict npm grammar, the five built-in scenarios), agents
come from the CLI allowlist, `--yes` is appended by the service, and root
`install --all` / `remove --all` are rejected.

Each approval runs against an in-memory one-shot journal
(`prepared -> executing -> executed`), published once per external attempt and
revoked on disposal. After an attempt the immutable receipt is built with its
digest first, then evidence is recorded; if `recordResult` is temporarily
unavailable the same receipt is returned with `evidencePending`, and the next
`execute` retries only the evidence write — zero spawn, zero controller, zero
invalidation — emitting the event at most once. An indeterminate failure
returns `execution-outcome-unknown` and is never re-run; once the external
attempt has started, best-effort recovery (after inventory snapshot, stale
reconcile for install/remove, safe catalog invalidation) always runs in a
contained `finally`, so a partial write cannot leave the catalog stale and the
failed run still records one receipt. The journal is memory-only: a crash
loses pending arguments and the journal, so an approved-but-unrecorded action
returns `missing-pending-input` and requires manual reconciliation — this
seam does not claim cross-process exactly-once. Install receipts carry
`sourceKind` / `sourceHost?` / `sourceDigest` (a digest over the canonical
sanitized descriptor, never the raw URL) and non-install receipts carry an
`actionTargetDigest`; the completion/failure event mirrors the same allowlist.

## Auth profile and prepare lease

`ImoAuthService` provides `ctx.imoAuth` as the only authentication seam for
future remote tools:

- `listProfiles()` uses `imo auth profile list --format json` and constructs a
  fixed allowlist view; unknown fields, including token-shaped fields, are
  discarded;
- `defaultProfile()` exposes only the sanitized profile name and a digest;
- `validate(profile?)` exposes `{ profileName, valid, status?, reason?,
  checkedAt, stdoutDigest }`. 401 is `invalid-auth` and invalidates the matching
  cache key; 403 is `forbidden` and never retries or invalidates;
- `prepare({ profile?, env? })` uses `imo auth prepare ... --json` only in the
  Host process and returns an opaque lease. The access token is held in a
  closure/private field and is available only to `lease.use(callback)`.

Lease JSON, `Object.keys`, object spread, `util.inspect`, structured clone,
events, logs, operation records, and error messages contain only sanitized view
and in-memory cache metadata. Same-key calls coalesce and reuse until explicit
`invalidate()`; fiber disposal clears the cache. The `lease.use` callback owns
responsibility for its secret: returning, logging, or throwing the token can
still intentionally leak it, which the service cannot prevent. Prefer a
callback that performs the remote call and does not return the secret.

## Auth actions approval loop

`ImoAuthActionsService` provides `ctx.imoAuthActions` with separate request and
execute methods for portal login, remote-profile creation, and default-profile
switching. Each request appends a pending operation record; the existing
operation-log decision is required before any write command can spawn.

`listEnvironmentIds()` runs `imo complete --type env` and filters strict full
IDs: segmented alphanumeric IDs contain `_insuremo_`, reject option-like and
sensitive token/OAuth/cookie/state/secret-like segments, and are replaced per
source-profile key. `resolveEnvironmentHint()` returns an exact candidate or a
sanitized not-found/ambiguous result; remote requests accept only resolver-
confirmed IDs from the same source key. Portal login always uses `--env portal`;
manual and non-portal requests are rejected. Receipts and action events contain
only digests, status, exit code, timestamps, and sanitized profile/environment
metadata. Pending action arguments are process-memory only and are lost on
restart. No action uses `--insecure`; tests and real smoke never run auth writes.

## TASK-038: workspace icons + embedding endpoint

### Slot 侦察结论（工作区行图标注入点）

- Harness `ProjectRowItem`（`ui-workspace/src/client/rows/Rows.tsx`）渲染工作区行：**无 children/slot 注入点**，props 全部由 `WorkspaceBrowser` 闭包提供；修改需动 Harness 源码（禁止）。
- `sidebar.workspaces` slot 是整个浏览区（ui-workspace 独占注册，list kind 但语义为区域整体）。
- `sidebar.footer.action` 是 **list kind**（多注册并排，按 order 排序）——`ui-insuremo-status` 已在此。
- **所选方案（最小侵入）**：在 `ui-insuremo-status` 的 `sidebar.footer.action` 追加第二个条目（order 11）`insuremo-workspace-health`——紧凑"工作区健康条"：每 workspace 一行，名称后三个 16px 图标（i=绑定 bound 点亮/pending 半透明/非 iComposer 不显示；▦=图谱；◍=大脑/explain），zh/en 悬停 tooltip；数据来自新只读路由 `GET .../insuremo/overview/workspaces/status`（60s TTL 轮询）。未来 Harness 若暴露工作区行 slot，可平移到行内。

### Embedding 端点配置

`@icomposer/icomposer-code-intelligence` 构造 config 增 `embeddingUrl`（`https://` 校验；默认不变）。Settings > InsureMO 显示当前生效端点（只读 + "经认证 Profile 调用，无需单独 key"提示）；修改走 dist/bundle config：在 profile 的 `cordis.patch.yml` 配置节或安装包 config 中设置 `embeddingUrl`（Settings 页不提供编辑框，避免新增配置写攻击面）。

### Host 路由与 overview 扩展

- `GET .../insuremo/overview/workspaces/status` → `{workspaces:[{workspaceId,detected,autoBindState,graphReady,explainReady}]}`（≤100；binding face join ici diagnostics manifest + explain-state 文件标记；全程只读、miss 降级 false）。
- explain 标记：ici 包首次 explainContext/explainDeterministic 成功后写 `<DSH_HOME>/ici/<hash>/explain-state.json` `{schemaVersion:1,lastExplainAt,apiName}`（原子 tmp+rename；文件即状态，不引入新域）。
- overview response 增可选 `ici` section `{status,embeddingUrl,graphWorkspaces,explainWorkspaces}`（向后兼容）。

## TASK-039: 设置简化重构（去审批直执行）

**架构变更（用户裁定）**：IMO upgrade / skills install-update-remove / default-profile 等本地 CLI 操作从 Settings 一键直跑——**不再走 operationLog 审批链**。operationLog 服务本身保留（write 闭环 push/test/release/create/metadata 仍审批化），仅 InsureMO 本地动作退出。

**直跑入口**：`imoUpgrade.executeDirect(targetVersion)`（共享单飞锁+smoke+事件）；`imoSkillActions.runDirect(input)`（preview→直跑内核，argv 校验/lease/digest 全复用，receipt 不落 operationLog）；`authActions.runDirectDefaultSwitch(profile)`。写桥 POST 六动作（imo-upgrade/skill-activation/skill-update/skill-install/skill-remove/default-profile）全部直调这些内核；Origin/X-Workbench-Action/JSON/8KB 门不变。

**settings.plugin.item 注册范式（侦察结论）**：Plugins 设置页的卡片来自 `settings.plugin.item` keyed slot（声明在 `@deepseek-ai/dsh-client-ui-settings-plugins`，key=卡片所编辑的 settings namespace）；ConfigurablePluginsTab 通过 `api.settings.describe({})` 读 Host serve 的 namespace 列表，与浏览器侧注册的卡片 key 求交集后逐个 dispatch（`renderSlot(key, owner, { entryKey: ns })`）。**Host 侧必须 `ctx.inject(["settings"], sctx => sctx.settings.register(ns, schema, { base }))` 注册 namespace**（insuremo-service 现注册占位 namespace `insuremo`），浏览器侧同 key 注册卡片即自动配对——不自造 tab。

**UI 重做**：ui-insuremo-settings 旧 InsuremoSection/四面板已删；新 `InsuremoCard`（settings.plugin.item, key="insuremo"）四区：IMO（版本+一键升级）、Auth（profile 单选切换+CLI 提示）、Skills（开关+更新全部+单项移除）、Code Intelligence（embedding 端点展示）。侧栏 footer 徽标/ProfilePicker（ui-insuremo-status）不变。
