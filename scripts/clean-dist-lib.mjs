#!/usr/bin/env node
/** Remove generated distributable artifacts before every clean build. */
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
await rm(join(repoRoot, "packages", "icomposer-workbench-dist", "lib"), { recursive: true, force: true });
