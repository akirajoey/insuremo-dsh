# `@icomposer/plugin-workbench-test`

A minimal Host-only smoke plugin for the Workbench bundle composition proof.
It owns a small Service Definition (`WorkbenchTestService`) with a canonical
`ping` method and a `workbench-test/ready` event, then registers a no-op
provider from its Loader `apply` function.

The package intentionally has no React or UI dependency. It is mounted by
`@icomposer/bundle-workbench` only to prove that an out-of-tree Workbench
package can enter a Harness profile.
