# InsureMO iComposer Workbench

## Install and run

Node.js and npm are the only prerequisites.

**Stable** (recommended):

```sh
npm install -g insuremo-dsh-workbench
insuremo-dsh
```

**Next** (preview channel):

```sh
npm install -g insuremo-dsh-workbench@next
insuremo-dsh
```

The launcher builds and launches a private, immutable Workbench generation
under your `DSH_HOME` (default `~/.dsh`). It carries the matching Harness
runtime and the prebuilt Workbench payload, so no separate `dsh`, pnpm,
Corepack, profile name, or runtime version is needed. The first run downloads
the runtime packages through npm; later starts verify and reuse the committed
generation.

## Commands

```text
insuremo-dsh          ensure the installed generation and launch the Workbench
insuremo-dsh setup    build and commit this release's immutable generation
insuremo-dsh doctor   inspect installation health without changing files
```

## Immutable generations

Every release artifact maps to exactly one generation:
`profiles/icomposer-web-<channel>-<id8>` plus
`insuremo-dsh/generations/<channel>-<id8>/` (runtime, payload snapshot,
record). Setups never overwrite or adopt an existing profile: a generation is
built in staging, verified with a real boot smoke, then committed by rename,
and the record is written last. Interrupted commits are recovered by full
verification or discarded; a conflicting target fails closed with no changes.

Switching channels or upgrading is done with npm dist-tags
(`npm install -g insuremo-dsh-workbench@next`); each artifact selects its own
generation and older committed generations stay in place untouched.

An existing legacy `icomposer-web` profile is never read, modified, or
removed; `doctor` only reports its presence. Reclaiming disk space from old
generations is not part of v1.

## Maintainer notes

The package is generated from the Workbench source with `pack-bootstrap.mjs`.
Stable and Next are separate npm artifacts from the same launcher source. Each
artifact embeds a channel manifest asserting the exact per-channel DSH graph (186 packages for stable, 189 for next)
(`dshPackages` with a single pinned version) and a frozen pnpm lockfile whose
every DSH entry matches that pin. The payload provenance is verified
byte-for-byte against the pinned plugin-dist commit before packing, and
`scripts/check-bootstrap.mjs` re-verifies both shipped artifacts (manifest,
shipped overrides, lock entries) in the release gate. The package root has no
lifecycle scripts; the bundled pnpm runs installs with `--ignore-scripts`
under a controlled native rebuild allowlist (`node-pty`, `koffi` only).

The lower-level `dsh --profile <name>` and pnpm development workflow is an
advanced source-checkout path, not the end-user installation flow.
