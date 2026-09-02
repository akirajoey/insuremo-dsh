import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileSha256, treeEntries, treeSha256 } from "./paths.mjs";

export const CHANNEL_NAMES = ["stable", "next"];
export const WORKBENCH_PACKAGE = "@icomposer/workbench";
export const DSH_PACKAGE = "@deepseek-ai/dsh";
export const PNPM_PACKAGE = "pnpm";
const DSH_GRAPH_PATTERN = /^@deepseek-ai\/dsh(?:-[0-9a-z-]+)?$/u;
export const DSH_LOCK_KEY_PATTERN = /^\/?@deepseek-ai\/(dsh(?:-[0-9a-z-]+)*)@([^_(:\s]+)/u;

/** Extracts { name, version } from a pnpm lock packages/snapshots key; undefined for non-DSH keys. */
export function dshLockEntryVersion(key) {
  const match = DSH_LOCK_KEY_PATTERN.exec(key);
  return match === null ? undefined : { name: `@deepseek-ai/${match[1]}`, version: match[2] };
}

export async function readChannelConfig(root, channel) {
  const config = JSON.parse(await readFile(join(root, "config", "bootstrap-channels.json"), "utf8"));
  if (config.schemaVersion !== 1 || config.packageName !== "insuremo-dsh-workbench") {
    throw new Error("bootstrap channel config schema mismatch");
  }
  const value = config.channels?.[channel];
  if (value === undefined) throw new Error(`unknown bootstrap channel: ${channel}`);
  validateChannelInput(channel, value);
  return { channel, ...value, dshGraphPackages: validateDshGraph(config, channel) };
}

export function validateDshGraph(config, channel = undefined) {
  const packages = config.dshRuntimeGraph?.packages;
  if (config.dshRuntimeGraph?.schemaVersion !== 1 || !Array.isArray(packages)) {
    throw new Error("bootstrap config dshRuntimeGraph is missing");
  }
  if (new Set(packages).size !== packages.length) throw new Error("dshRuntimeGraph contains duplicate package names");
  for (const name of packages) {
    if (typeof name !== "string" || !DSH_GRAPH_PATTERN.test(name)) throw new Error(`dshRuntimeGraph has an invalid package name: ${JSON.stringify(name)}`);
  }
  for (const required of [DSH_PACKAGE, "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]) {
    if (!packages.includes(required)) throw new Error(`dshRuntimeGraph is missing ${required}`);
  }
  const graph = [...packages];
  if (channel !== undefined) {
    const override = config.dshRuntimeGraph.channelOverrides?.[channel];
    for (const name of override?.removedPackages ?? []) {
      if (!graph.includes(name)) throw new Error(`dshRuntimeGraph override removes an unknown package: ${name}`);
      graph.splice(graph.indexOf(name), 1);
    }
    for (const name of override?.addedPackages ?? []) {
      if (typeof name !== "string" || !DSH_GRAPH_PATTERN.test(name)) throw new Error(`dshRuntimeGraph override has an invalid package name: ${JSON.stringify(name)}`);
      if (graph.includes(name)) throw new Error(`dshRuntimeGraph override adds a duplicate package: ${name}`);
      graph.push(name);
    }
  }
  return graph.sort((a, b) => a.localeCompare(b));
}

export function assertManifestDshGraph(input, runtime) {
  const dshPackages = runtime?.dshPackages ?? {};
  const names = Object.keys(dshPackages);
  const versions = [...new Set(Object.values(dshPackages))].sort();
  if (versions.length !== 1 || versions[0] !== input.dshVersion) {
    throw new Error(`${input.channel}: DSH graph versions must be exactly [${input.dshVersion}], got [${versions.join(", ")}]`);
  }
  const graph = input.dshGraphPackages ?? [];
  const outside = names.filter(name => !graph.includes(name));
  const missing = graph.filter(name => !names.includes(name));
  if (outside.length > 0 || missing.length > 0) {
    throw new Error(`${input.channel}: DSH graph membership mismatch (outside: [${outside.join(", ")}]; missing: [${missing.join(", ")}])`);
  }
}

export function validateChannelInput(channel, value) {
  if (!CHANNEL_NAMES.includes(channel)) throw new Error(`invalid channel: ${channel}`);
  for (const key of ["bootstrapVersion", "dshVersion", "pnpmVersion", "workbenchVersion", "workbenchSourceCommit"]) {
    if (typeof value[key] !== "string" || value[key] === "") throw new Error(`${channel}: missing ${key}`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.bootstrapVersion)) throw new Error(`${channel}: invalid bootstrap version`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.dshVersion)) throw new Error(`${channel}: invalid DSH version`);
  if (!/^\d+\.\d+\.\d+$/u.test(value.pnpmVersion)) throw new Error(`${channel}: invalid pnpm version`);
  if (!/^\d+\.\d+\.\d+$/u.test(value.workbenchVersion)) throw new Error(`${channel}: invalid Workbench version`);
  if (!/^[0-9a-f]{40}$/iu.test(value.workbenchSourceCommit)) throw new Error(`${channel}: Workbench source must be a 40-hex commit`);
}

export async function describeWorkbenchPayload(payloadDir, input) {
  const entries = await treeEntries(payloadDir);
  if (entries.some(entry => entry.kind !== "file")) throw new Error("Workbench payload must contain regular files only");
  const manifest = JSON.parse(await readFile(join(payloadDir, "package.json"), "utf8"));
  if (manifest.name !== WORKBENCH_PACKAGE || manifest.version !== input.workbenchVersion) {
    throw new Error(`Workbench payload identity mismatch: expected ${WORKBENCH_PACKAGE}@${input.workbenchVersion}`);
  }
  if (manifest.private !== undefined || manifest.scripts !== undefined || manifest.devDependencies !== undefined) {
    throw new Error("Workbench payload manifest is not a scriptless release manifest");
  }
  const fileHashes = Object.fromEntries(entries.map(entry => [entry.path, entry.sha256]));
  return {
    packageName: WORKBENCH_PACKAGE,
    version: manifest.version,
    sourceCommit: input.workbenchSourceCommit,
    treeSha256: await treeSha256(payloadDir),
    fileHashes,
  };
}
