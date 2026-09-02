#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { doctor, ensureSetup, ensureThenLaunch, rejectUnsafeArgs } from "./service.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(packageRoot, "channel-manifest.json");

async function loadManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || !["stable", "next"].includes(manifest.channel)) throw new Error("invalid bootstrap channel manifest");
  return manifest;
}

function help() {
  process.stdout.write(`insuremo-dsh-workbench

Usage:
  insuremo-dsh            ensure the installed generation and launch the Workbench
  insuremo-dsh setup      build and commit this release's immutable generation
  insuremo-dsh doctor     inspect installation health without changing files

Channels:
  npm install -g insuremo-dsh-workbench       Stable
  npm install -g insuremo-dsh-workbench@next  Next

Each release is an append-only immutable generation; switching channels or
versions with npm dist-tags selects another generation. Node.js and npm are
the only prerequisites.
`);
}

function version(manifest) {
  process.stdout.write(`insuremo-dsh-workbench ${manifest.bootstrapVersion} (${manifest.channel})\n`);
}

async function main() {
  const manifest = await loadManifest();
  const args = process.argv.slice(2);
  rejectUnsafeArgs(args);
  if (args.length === 0) {
    process.exitCode = await ensureThenLaunch(manifest, packageRoot);
    return;
  }
  const command = args[0];
  if (command === "--help" || command === "-h") {
    help();
    return;
  }
  if (command === "--version" || command === "-V") {
    version(manifest);
    return;
  }
  if (command === "setup") {
    if (args.length > 1) throw new Error("setup takes no arguments");
    const result = await ensureSetup(manifest, packageRoot);
    process.stdout.write(`insuremo-dsh: ${result.changed ? "generation committed" : "generation already current"} (${manifest.channel}, ${result.profileName}${result.adopted ? ", recovered" : ""})\n`);
    return;
  }
  if (command === "doctor") {
    if (args.length > 2 || (args.length === 2 && args[1] !== "--json")) throw new Error("doctor accepts at most --json");
    const result = await doctor(manifest, packageRoot);
    process.stdout.write(`${args.includes("--json") ? JSON.stringify(result, null, 2) : formatDoctor(result)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error(`unknown command: ${JSON.stringify(command)}; run: insuremo-dsh --help`);
}

function formatDoctor(result) {
  const state = result.ok ? "healthy" : "needs attention";
  const details = [
    `generation=${result.set ? "committed" : "missing"}`,
    `verified=${result.verified ? "yes" : "no"}`,
    `payload=${result.payloadMatches ? "ok" : "drift"}`,
    `receipts=${result.pendingReceipts}`,
  ];
  if (result.legacyProfilePresent) details.push("legacy-icomposer-web=present (untouched)");
  if (result.error !== undefined) details.push(`error=${result.error}`);
  return `insuremo-dsh: ${state} (${result.channel}); ${details.join("; ")}`;
}

try {
  await main();
} catch (error) {
  process.stderr.write(`insuremo-dsh: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
