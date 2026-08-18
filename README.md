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
against `compatibility.json`. `pnpm typecheck` checks all TypeScript contract
sources. `pnpm test` generates and checks the contract JSON Schema artifacts.

To generate schemas directly:

```sh
pnpm --filter @icomposer/workbench-contracts run gen-json-schema
```

The generated files are written to
`packages/workbench-contracts/dist/*.schema.json`. They are build artifacts and
are intentionally ignored by Git; rerun the generation command after a clean
install.

## Workspace layout

```text
packages/
└── workbench-contracts/   # Workbench API v0 types and runtime schemas
scripts/
└── check-compatibility.mjs
compatibility.json
```
