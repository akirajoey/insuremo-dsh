import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertManifestDshGraph, readChannelConfig, validateChannelInput, validateDshGraph } from "../packages/insuremo-dsh-workbench-bootstrap/src/channel.mjs";

const root = join(import.meta.dirname, "..");

test("bootstrap channel config carries the audited DSH graph for both channels", async () => {
  const stable = await readChannelConfig(root, "stable");
  const next = await readChannelConfig(root, "next");
  assert.equal(stable.dshGraphPackages.length, 186);
  assert.equal(next.dshGraphPackages.length, 189);
  assert.equal(stable.dshVersion, "0.1.0-rc.7");
  assert.equal(next.dshVersion, "0.1.1-rc.2");
  for (const required of ["@deepseek-ai/dsh", "@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]) {
    assert.ok(stable.dshGraphPackages.includes(required), `stable graph is missing ${required}`);
    assert.ok(next.dshGraphPackages.includes(required), `next graph is missing ${required}`);
  }
  for (const goneInNext of ["@deepseek-ai/dsh-client-schema-form", "@deepseek-ai/dsh-client-web-react", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-web"]) {
    assert.ok(!next.dshGraphPackages.includes(goneInNext), `next graph should exclude ${goneInNext}`);
  }
  for (const added of ["@deepseek-ai/dsh-authorization", "@deepseek-ai/dsh-file-reference", "@deepseek-ai/dsh-tool-pwsh-persistent"]) {
    assert.ok(next.dshGraphPackages.includes(added), `next graph should include ${added}`);
    assert.ok(!stable.dshGraphPackages.includes(added), `stable graph should exclude ${added}`);
  }
  const config = JSON.parse(await readFile(join(root, "config", "bootstrap-channels.json"), "utf8"));
  assert.match(config.dshRuntimeGraph.generatedFrom, /runtime-pins\.json/u);
  assert.match(config.dshRuntimeGraph.channelOverrides.next.reason, /EOL/u);
});

test("validateDshGraph rejects malformed graphs", async () => {
  const config = JSON.parse(await readFile(join(root, "config", "bootstrap-channels.json"), "utf8"));
  assert.throws(() => validateDshGraph({ ...config, dshRuntimeGraph: undefined }), /dshRuntimeGraph is missing/u);
  assert.throws(() => validateDshGraph({ ...config, dshRuntimeGraph: { schemaVersion: 1, packages: ["@deepseek-ai/dsh", "@deepseek-ai/dsh"] } }), /duplicate/u);
  assert.throws(() => validateDshGraph({ ...config, dshRuntimeGraph: { schemaVersion: 1, packages: ["@deepseek-ai/cordis"] } }), /invalid package name/u);
  assert.throws(() => validateDshGraph({ ...config, dshRuntimeGraph: { schemaVersion: 1, packages: ["@deepseek-ai/dsh-base"] } }), /missing @deepseek-ai\/dsh/u);
});

test("validateChannelInput rejects broken channel values", () => {
  const valid = {
    bootstrapVersion: "1.0.0",
    dshVersion: "0.1.0-rc.7",
    pnpmVersion: "11.7.0",
    workbenchVersion: "0.1.0",
    workbenchSourceCommit: "85d10ccd9a9c7f2a6b792d32eb14b8b309e2e620",
  };
  validateChannelInput("stable", { ...valid });
  assert.throws(() => validateChannelInput("stable", { ...valid, dshVersion: "^0.1.0-rc.7" }), /invalid DSH version/u);
  assert.throws(() => validateChannelInput("stable", { ...valid, pnpmVersion: "11" }), /invalid pnpm version/u);
  assert.throws(() => validateChannelInput("stable", { ...valid, workbenchSourceCommit: "abc" }), /40-hex/u);
});

test("assertManifestDshGraph fails closed on mixed or unknown DSH versions", async () => {
  const input = await readChannelConfig(root, "stable");
  const pure = Object.fromEntries(input.dshGraphPackages.map(name => [name, "0.1.0-rc.7"]));
  assertManifestDshGraph(input, { dshPackages: pure });
  const mixed = { ...pure, "@deepseek-ai/dsh-agent": "0.1.0-rc.8" };
  assert.throws(() => assertManifestDshGraph(input, { dshPackages: mixed }), /must be exactly \[0\.1\.0-rc\.7\]/u);
  const outside = { ...pure, "@deepseek-ai/dsh-brand-new": "0.1.0-rc.7" };
  assert.throws(() => assertManifestDshGraph(input, { dshPackages: outside }), /membership mismatch/u);
  const partial = Object.fromEntries(input.dshGraphPackages.slice(1).map(name => [name, "0.1.0-rc.7"]));
  assert.throws(() => assertManifestDshGraph(input, { dshPackages: partial }), /membership mismatch/u);
  const next = await readChannelConfig(root, "next");
  const wrongChannel = Object.fromEntries(input.dshGraphPackages.map(name => [name, "0.1.0-rc.7"]));
  assert.throws(() => assertManifestDshGraph(next, { dshPackages: wrongChannel }), /must be exactly \[0\.1\.1-rc\.2\]/u);
});
