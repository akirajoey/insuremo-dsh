import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { classifyPnpm, makePnpmPlan, probePnpm, satisfies, selectTrustedPnpm } from "../scripts/pnpm-launch.mjs";

/** Own scratch only: no user pnpm, profile, config or attack payload is run. */
function fixture(t, script = 'if (process.argv.slice(2).join("|") !== "--version") process.exit(8); console.log("11.7.0");') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "task169 pnpm & space;")));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); });
  const root = join(dir, "custom prefix", "node_modules", "pnpm");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pnpm", bin: { pnpm: "bin/pnpm.mjs" } }));
  const entry = join(root, "bin", "pnpm.mjs");
  writeFileSync(entry, script);
  return { dir, root, entry };
}

function select(f, env = {}) {
  return selectTrustedPnpm({ env: { PATH: "", ...env } });
}

test("a normal user-prefix pnpm JS entry runs through Node with fixed argv, spaces and special characters", t => {
  const f = fixture(t);
  const selection = select(f, { npm_execpath: f.entry });
  assert.equal(selection.ok, true);
  assert.equal(selection.kind, "js");
  assert.deepEqual(selection.plan, { command: process.execPath, args: [f.entry, "--version"], shell: false });
  const result = probePnpm({ selection, cwd: f.dir, env: { HOME: f.dir, PATH: "" } });
  assert.deepEqual(result, { ok: true, version: "11.7.0", kind: "js" });
  assert.equal(classifyPnpm(result, "11.7.0").ok, true);
});

test("npm_execpath is only a candidate: lookalike scripts and non-pnpm packages are never executed", t => {
  const f = fixture(t);
  const hostile = join(f.dir, "outside", "pnpm.mjs");
  mkdirSync(join(f.dir, "outside"), { recursive: true });
  writeFileSync(hostile, 'throw new Error("must-not-run");');
  assert.equal(select(f, { npm_execpath: hostile }).ok, false);
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "not-pnpm", bin: { pnpm: "bin/pnpm.mjs" } }));
  assert.equal(select(f, { npm_execpath: f.entry }).ok, false);
  writeFileSync(join(f.root, "package.json"), JSON.stringify({ name: "pnpm", bin: { pnpm: "bin/other.js" } }));
  assert.equal(select(f, { npm_execpath: f.entry }).ok, false);
  assert.deepEqual(selectTrustedPnpm({ env: { PATH: "" } }), { ok: false, reason: "missing" });
});

test("PATH native pnpm is accepted by name/executable; .cmd/.bat/.ps1 are rejected without a shell", t => {
  const f = fixture(t);
  const bin = join(f.dir, "bin dir");
  mkdirSync(bin);
  for (const name of ["pnpm", "pnpm.cmd", "pnpm.ps1"]) {
    const file = join(bin, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(file, 0o755);
  }
  const native = selectTrustedPnpm({ platform: "darwin", nodePath: "/usr/local/bin/node", env: { PATH: bin } });
  assert.equal(native.ok, true);
  assert.deepEqual(native.plan, { command: join(bin, "pnpm"), args: ["--version"], shell: false });
  assert.equal(makePnpmPlan({ kind: "native", path: join(bin, "pnpm.cmd") }, { platform: "win32", nodePath: "C:\\node.exe" }), null);
  assert.equal(makePnpmPlan({ kind: "js", path: join(bin, "pnpm.ps1") }, { platform: "win32", nodePath: "C:\\node.exe" }), null);
});

test("nonzero, timeout, invalid output, version mismatch, missing and permission errors stay distinct and redacted", t => {
  const f = fixture(t, 'console.error("private-fixture"); process.exit(23);');
  const selection = select(f, { npm_execpath: f.entry });
  assert.deepEqual(probePnpm({ selection, cwd: f.dir, env: { HOME: f.dir, PATH: "" } }), { ok: false, reason: "nonzero" });
  writeFileSync(f.entry, 'setTimeout(() => console.log("11.7.0"), 5000);');
  assert.deepEqual(probePnpm({ selection, cwd: f.dir, env: { HOME: f.dir, PATH: "" }, timeout: 150 }), { ok: false, reason: "timeout" });
  writeFileSync(f.entry, 'console.log("private-fixture-not-a-version");');
  assert.deepEqual(probePnpm({ selection, cwd: f.dir, env: { HOME: f.dir, PATH: "" } }), { ok: false, reason: "invalid-version" });
  assert.deepEqual(classifyPnpm({ ok: true, version: "11.6.0", kind: "js" }, "11.7.0"), { ok: false, reason: "version-mismatch", version: "11.6.0" });
  assert.deepEqual(probePnpm({ selection, spawn: () => ({ error: { code: "EACCES", message: "private-fixture" } }) }), { ok: false, reason: "inaccessible" });
  assert.deepEqual(probePnpm({ selection, spawn: () => ({ error: { code: "ENOENT", message: "private-fixture" } }) }), { ok: false, reason: "missing" });
  assert.deepEqual(probePnpm({ selection, spawn: () => ({ error: { code: "ENOBUFS", message: "private-fixture" } }) }), { ok: false, reason: "output-limit" });
  assert.equal(satisfies("25.2.1", "^22.19.0 || >=24.0.0"), true);
  assert.equal(satisfies("22.18.0", "^22.19.0 || >=24.0.0"), false);
});

test("the child environment keeps only PATH/home/temp essentials and no Node hooks or npm variables", () => {
  const plan = { command: "node", args: ["pnpm.mjs", "--version"], shell: false };
  let options;
  const result = probePnpm({ selection: { ok: true, plan, kind: "js" }, spawn: (_command, _args, value) => {
    options = value; return { status: 0, stdout: "11.7.0\r\n" };
  }, env: { PATH: "/bin", NODE_OPTIONS: "--require=bad", npm_execpath: "/bad", SECRET_FIXTURE: "do-not-print" } });
  assert.equal(result.ok, true);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.NODE_OPTIONS, undefined);
  assert.equal(options.env.npm_execpath, undefined);
  assert.equal(options.env.SECRET_FIXTURE, undefined);
  assert.equal(options.env.PATH, "/bin");
});
