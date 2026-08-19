# iComposer Workbench

`icomposer-workbench` is the independent pnpm workspace that will host the
Workbench Host/Client plugins. The DeepSeek Harness is a fixed, read-only
compatibility baseline; it is not copied into this repository and is not
modified by the Workbench packages.

## Prerequisites

- Node.js `^22.19.0 || >=24.0.0`
- pnpm `11.7.0`
- the Harness checkout at `../deepseek-harness`, fixed to commit
  `99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`

### Prepare the Harness baseline on a new machine

Clone the Harness repository beside this checkout, then pin the exact commit
before installing Workbench dependencies. Replace the repository URL with the
URL provided by the project:

```sh
git clone <harness-repository-url> ../deepseek-harness
git -C ../deepseek-harness checkout 99f6f02fecdb7dff40c3fbc9470f5907c29f74ca
```

If the checkout already exists, verify that it is at the same commit before
continuing. The compatibility check performs this read-only verification.

## Install and verify

From this repository root:

```sh
npm install -g pnpm@11.7.0
pnpm install
pnpm check
pnpm typecheck
pnpm test
```

`pnpm check` validates the local Harness commit and the Node/pnpm versions
against `compatibility.json`. `pnpm typecheck` checks all TypeScript package
sources. `pnpm test` runs the operation-log storage tests and generates/checks
the contract JSON Schema artifacts.

To generate schemas directly:

```sh
pnpm --filter @icomposer/workbench-contracts run gen-json-schema
```

The generated files are written to
`packages/workbench-contracts/dist/*.schema.json`. They are build artifacts and
are intentionally ignored by Git; rerun the generation command after a clean
install.

## Phase 1 profile smoke

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
`ui-insuremo-settings`, `ui-insuremo-status`, and `ui-workbench-jobs` rows from
`@icomposer/bundle-workbench`; the
`workbench-operation-log` row requires the Harness `storageDomain` service.
The setup script refuses to target the real `~/.dsh` path.

## Operation evidence layer

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

## Client plugin development

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

`@icomposer/ui-insuremo-status` contributes the static localized badge in the
sidebar footer (`sidebar.footer.action`). It shows `InsureMO · 未配置` or
`InsureMO · Not configured` with a warning dot; live environment health and
interaction are intentionally deferred.

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

## Workspace layout

```text
packages/
├── workbench-contracts/       # Workbench API v0 types and runtime schemas
├── plugin-workbench-test/       # Host-only Service Definition/provider smoke plugin
├── workbench-operation-log/     # Digest-only operation evidence provider
├── ui-insuremo-settings/        # Client Settings > InsureMO placeholder
├── ui-insuremo-status/          # Client sidebar InsureMO status placeholder
├── ui-workbench-jobs/           # Client keyed job conversation node
└── bundle-icomposer-workbench/  # Profile patch layer for Workbench plugins
profiles/
└── icomposer-web/             # Source profile manifest and empty user patch
scripts/
├── check-compatibility.mjs
└── setup-profile.mjs
compatibility.json
```
