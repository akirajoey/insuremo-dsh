import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import { test } from "node:test";
import { parseNpmNpxShim, resolveSpawnArgv, runCapture } from "../src/run.ts";
import {
  cliFixture,
  fakeHandle,
  fakeSubprocess,
  makeFakeIo,
  skillsFixture,
} from "./support/fake-subprocess.ts";

function options(signal?: AbortSignal) {
  return { command: "imo", args: ["--version"], timeoutMs: 25, signal };
}

function rejectingRuntime(cause: string) {
  const fake = fakeSubprocess(makeFakeIo());
  fake.spawn = (spec) => {
    const base = fakeHandle({ stdout: "", stderr: "", exitCode: null, pending: true }, spec.signal);
    return { ...base, done: Promise.reject(new Error(cause)) } as SubprocessHandle;
  };
  return fake;
}

function abortRejectingRuntime(cause: string) {
  const fake = fakeSubprocess(makeFakeIo());
  fake.spawn = (spec) => {
    const base = fakeHandle({ stdout: "", stderr: "", exitCode: null, pending: true }, spec.signal);
    const done = new Promise<never>((_resolve, reject) => {
      const rejectOnAbort = (): void => reject(new Error(cause));
      if (spec.signal?.aborted) rejectOnAbort();
      else spec.signal?.addEventListener("abort", rejectOnAbort, { once: true });
    });
    return { ...base, done } as SubprocessHandle;
  };
  return fake;
}

function assertNoCause(
  result: Awaited<ReturnType<typeof runCapture>>,
  canary: string,
): asserts result is Extract<Awaited<ReturnType<typeof runCapture>>, { ok: false }> {
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(JSON.stringify(result.error).includes(canary), false);
  assert.equal(Reflect.ownKeys(result.error).includes("cause"), false);
}

test("runCapture spawn exceptions use a fixed failure message", async () => {
  const canary = ["spawn", "cause", "401", "canary"].join("_");
  const fake = fakeSubprocess(makeFakeIo());
  fake.spawn = () => { throw new Error(canary); };
  const result = await runCapture(fake, options());
  assertNoCause(result, canary);
  if (!result.ok) {
    assert.equal(result.error.code, "spawn-failed");
    assert.equal(result.error.message, "IMO CLI process could not be started");
    assert.equal(result.error.httpStatus, undefined);
  }
});

test("runCapture handle.done rejection does not expose its cause", async () => {
  const canary = ["done", "rejected", "stack", "canary"].join("_");
  const result = await runCapture(rejectingRuntime(canary), options());
  assertNoCause(result, canary);
  if (!result.ok) {
    assert.equal(result.error.code, "spawn-failed");
    assert.equal(result.error.message, "IMO CLI process failed");
  }
});

test("parent abort reasons never cross the runCapture error boundary", async () => {
  const canary = ["parent", "abort", "reason", "canary"].join("_");
  const controller = new AbortController();
  controller.abort(new Error(canary));
  const result = await runCapture(fakeSubprocess(makeFakeIo()), options(controller.signal));
  assertNoCause(result, canary);
  if (!result.ok) {
    assert.equal(result.error.code, "cancelled");
    assert.equal(result.error.message, "IMO CLI operation was cancelled");
  }
});

test("timeout reasons never cross a rejecting handle.done boundary", async () => {
  const canary = ["timeout", "reason", "secret", "canary"].join("_");
  const result = await runCapture(abortRejectingRuntime(canary), options());
  assertNoCause(result, canary);
  if (!result.ok) {
    assert.equal(result.error.code, "timeout");
    assert.equal(result.error.message, "IMO CLI operation timed out");
  }
});

test("401/403 text in a rejection cause cannot create HTTP classification", async () => {
  const canary = ["transport", "401", "forbidden", "403", "canary"].join("_");
  const result = await runCapture(rejectingRuntime(canary), options());
  assertNoCause(result, canary);
  if (!result.ok) {
    assert.equal(result.error.code, "spawn-failed");
    assert.equal(result.error.httpStatus, undefined);
  }
});

test("runCapture forwards explicit environment to lookup and spawn while retaining cwd", async () => {
  const fake = fakeSubprocess(makeFakeIo());
  const result = await runCapture(fake, {
    command: "imo",
    args: ["--version"],
    timeoutMs: 25,
    cwd: "/tmp/work space",
    env: { PATH: "C:\\Node 24\\bin", CUSTOM: "中文 value" },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(fake.resolves[0]?.env, { PATH: "C:\\Node 24\\bin", CUSTOM: "中文 value" });
  assert.deepEqual(fake.spawns[0]?.env, { PATH: "C:\\Node 24\\bin", CUSTOM: "中文 value" });
  assert.equal(fake.spawns[0]?.cwd, "/tmp/work space");
});

test("CLI version and Skills list public errors do not expose runner causes", async () => {
  const canary = ["public", "runner", "cause", "canary"].join("_");

  const cliFake = fakeSubprocess(makeFakeIo());
  cliFake.spawn = () => { throw new Error(canary); };
  const cli = await cliFixture(cliFake);
  try {
    const result = await cli.service.version();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "spawn-failed");
      assert.equal(result.error.message, "IMO CLI process could not be started");
      assert.equal(JSON.stringify(result.error).includes(canary), false);
    }
  } finally {
    await cli.dispose();
  }

  const skillsIo = makeFakeIo();
  const skillsFake = fakeSubprocess(skillsIo);
  skillsFake.spawn = () => { throw new Error(canary); };
  const skills = await skillsFixture(skillsIo, {}, undefined, skillsFake);
  try {
    const result = await skills.skills.list();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "spawn-failed");
      assert.equal(result.error.message, "IMO CLI process could not be started");
      assert.equal(JSON.stringify(result.error).includes(canary), false);
    }
  } finally {
    await skills.dispose();
  }
});

const MODERN_NPX_SHIM = [
  ":: Created by npm, please don't edit manually.",
  "@ECHO OFF",
  "",
  "SETLOCAL",
  "",
  "SET \"NODE_EXE=%~dp0\\node.exe\"",
  "IF NOT EXIST \"%NODE_EXE%\" (",
  "  SET \"NODE_EXE=node\"",
  ")",
  "",
  "SET \"NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js\"",
  "SET \"NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js\"",
  "FOR /F \"delims=\" %%F IN ('CALL \"%NODE_EXE%\" \"%NPM_PREFIX_JS%\"') DO (",
  "  SET \"NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js\"",
  ")",
  "IF EXIST \"%NPM_PREFIX_NPX_CLI_JS%\" (",
  "  SET \"NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%\"",
  ")",
  "",
  "\"%NODE_EXE%\" \"%NPX_CLI_JS%\" %*",
].join("\r\n");

const LEGACY_NPX_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "IF EXIST \"%dp0%\\node.exe\" (",
  "  SET \"_prog=%dp0%\\node.exe\"",
  ") ELSE (",
  "  SET \"_prog=node\"",
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\" \"%dp0%\\node_modules\\npm\\bin\\npx-cli.js\" %*",
].join("\r\n");

interface NpxFixture {
  root: string;
  shim: string;
  node: string;
  cli: string;
  prefix: string;
}

async function npxFixture(withSiblingNode = true): Promise<NpxFixture> {
  const root = await mkdtemp(join(tmpdir(), "imo-npx-shim-"));
  const npmBin = join(root, "node_modules", "npm", "bin");
  const shim = join(root, "npx.cmd");
  const node = join(root, "node.exe");
  const cli = join(npmBin, "npx-cli.js");
  const prefix = join(npmBin, "npm-prefix.js");
  await mkdir(npmBin, { recursive: true });
  await writeFile(shim, MODERN_NPX_SHIM);
  await writeFile(cli, "// trusted test fixture\n");
  await writeFile(prefix, "// trusted test fixture\n");
  if (withSiblingNode) await writeFile(node, "native node test fixture\n");
  await chmod(shim, 0o755);
  if (withSiblingNode) await chmod(node, 0o755);
  return { root, shim, node, cli, prefix };
}

function resolver(
  resolve: (command: string, env?: Readonly<Record<string, string>>) => Promise<string>,
  spawn?: (spec: SubprocessSpawnSpec) => SubprocessHandle,
): SubprocessRuntime {
  return { resolveExecutable: resolve, ...(spawn === undefined ? {} : { spawn }) } as unknown as SubprocessRuntime;
}

function prefixProbe(prefix: string, exitCode = 0): (spec: SubprocessSpawnSpec) => SubprocessHandle {
  return spec => fakeHandle({ stdout: `${prefix}\n`, stderr: "", exitCode }, spec.signal);
}

test("Windows npm shim parser accepts only the two known standard shapes", () => {
  assert.deepEqual(parseNpmNpxShim(MODERN_NPX_SHIM), {
    format: "modern",
    nodePolicy: "sibling-or-path",
    cliPolicy: "sibling-npm-cli",
  });
  assert.deepEqual(parseNpmNpxShim(LEGACY_NPX_SHIM), {
    format: "legacy",
    nodePolicy: "sibling-or-path",
    cliPolicy: "sibling-npm-cli",
  });
  assert.equal(parseNpmNpxShim(`${MODERN_NPX_SHIM}\r\necho C:\\evil`), undefined);
  assert.equal(parseNpmNpxShim("x".repeat(16 * 1024 + 1)), undefined);
});

test("Windows npx resolver uses verified sibling node and shell-free argv for spaced/special args", async () => {
  const fx = await npxFixture();
  const resolves: string[] = [];
  try {
    const args = ["-y", "--registry=C:\\Program Files\\npm & echo injected", "中文目录", "quote\"value"];
    const argv = await resolveSpawnArgv(
      resolver(
        async command => { resolves.push(command); throw new Error(`unexpected ${command}`); },
        prefixProbe(fx.root),
      ),
      fx.shim,
      args,
      { platform: "win32" },
    );
    assert.deepEqual(argv, [await realpath(fx.node), await realpath(fx.cli), ...args]);
    assert.deepEqual(resolves, []);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("Windows npx resolver falls back to runtime node only when sibling node is absent", async () => {
  const fx = await npxFixture(false);
  const fallbackRoot = await mkdtemp(join(tmpdir(), "imo-node-fallback-"));
  const fallbackNode = join(fallbackRoot, "node.exe");
  await writeFile(fallbackNode, "native fallback node test fixture\n");
  await chmod(fallbackNode, 0o755);
  const resolves: Array<{ command: string; env: Readonly<Record<string, string>> | undefined }> = [];
  try {
    const argv = await resolveSpawnArgv(
      resolver(
        async (command, env) => {
          resolves.push({ command, env });
          if (command === "node") return fallbackNode;
          throw new Error(`unexpected ${command}`);
        },
        prefixProbe(fx.root),
      ),
      fx.shim,
      ["--flag"],
      { platform: "win32", env: { PATH: "C:\\Node 24\\bin" } },
    );
    assert.deepEqual(argv, [await realpath(fallbackNode), await realpath(fx.cli), "--flag"]);
    assert.deepEqual(resolves, [{ command: "node", env: { PATH: "C:\\Node 24\\bin" } }]);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
    await rm(fallbackRoot, { recursive: true, force: true });
  }
});

test("modern npm npx shim preserves its global-prefix CLI relocation semantics", async () => {
  const fx = await npxFixture();
  const prefixRoot = await mkdtemp(join(tmpdir(), "imo-npx-prefix-"));
  const prefixCli = join(prefixRoot, "node_modules", "npm", "bin", "npx-cli.js");
  const siblingCli = await realpath(fx.cli);
  const prefixSpecs: SubprocessSpawnSpec[] = [];
  await mkdir(join(prefixRoot, "node_modules", "npm", "bin"), { recursive: true });
  await writeFile(prefixCli, "// relocated npm CLI test fixture\n");
  await unlink(fx.cli);
  try {
    const argv = await resolveSpawnArgv(
      resolver(
        async () => { throw new Error("sibling node should satisfy the shim"); },
        spec => {
          prefixSpecs.push(spec);
          return prefixProbe(prefixRoot)(spec);
        },
      ),
      fx.shim,
      ["--version"],
      { platform: "win32", cwd: "/tmp/work space", env: { PATH: "C:\\Node 24\\bin", CUSTOM: "value" } },
    );
    assert.deepEqual(argv, [await realpath(fx.node), await realpath(prefixCli), "--version"]);
    assert.notEqual(await realpath(prefixCli), siblingCli);
    assert.equal(prefixSpecs.length, 1);
    assert.equal(prefixSpecs[0]?.cwd, "/tmp/work space");
    assert.deepEqual(prefixSpecs[0]?.env, { PATH: "C:\\Node 24\\bin", CUSTOM: "value" });
    assert.deepEqual(prefixSpecs[0]?.argv, [await realpath(fx.node), await realpath(fx.prefix)]);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
    await rm(prefixRoot, { recursive: true, force: true });
  }
});

test("Windows npx resolver treats missing files as fallback but rejects symlink escapes", async () => {
  const fx = await npxFixture();
  const outsideRoot = await mkdtemp(join(tmpdir(), "imo-npx-outside-"));
  const outsideNode = join(outsideRoot, "node.exe");
  await writeFile(outsideNode, "outside node test fixture\n");
  await chmod(outsideNode, 0o755);
  try {
    await unlink(fx.node);
    await symlink(outsideNode, fx.node);
    await assert.rejects(
      resolveSpawnArgv(resolver(async () => { throw new Error("PATH fallback must not bypass an escaped sibling"); }, prefixProbe(fx.root)), fx.shim, [], { platform: "win32" }),
      /path outside shim directory/,
    );
  } finally {
    await rm(fx.root, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("Windows npx resolver rejects unreadable shims before any companion lookup", async () => {
  const fx = await npxFixture();
  try {
    await chmod(fx.shim, 0o000);
    await assert.rejects(
      resolveSpawnArgv(resolver(async () => { throw new Error("must not resolve a companion node"); }), fx.shim, [], { platform: "win32" }),
    );
  } finally {
    await chmod(fx.shim, 0o755);
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("Windows npx resolver rejects malformed prefix output and keeps the contained fallback", async () => {
  const fx = await npxFixture();
  try {
    const argv = await resolveSpawnArgv(
      resolver(async () => { throw new Error("sibling node should satisfy the shim"); }, spec => fakeHandle({ stdout: "relative-prefix\nsecond-line\n", stderr: "", exitCode: 0 }, spec.signal)),
      fx.shim,
      ["--version"],
      { platform: "win32" },
    );
    assert.deepEqual(argv, [await realpath(fx.node), await realpath(fx.cli), "--version"]);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("Windows npx resolver rejects wrappers and never trusts captured paths", async () => {
  const fx = await npxFixture();
  try {
    await writeFile(fx.shim, `${MODERN_NPX_SHIM}\r\nSET \"NPX_CLI_JS=C:\\attacker\\npx-cli.js\"\r\n`);
    await assert.rejects(
      resolveSpawnArgv(resolver(async () => fx.node), fx.shim, [], { platform: "win32" }),
      /unsupported npx shim/,
    );
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("Windows npx prefix probe shares the caller cancellation signal", async () => {
  const fx = await npxFixture();
  const controller = new AbortController();
  let probeSpec: SubprocessSpawnSpec | undefined;
  let signalStarted!: () => void;
  const started = new Promise<void>(resolve => { signalStarted = resolve; });
  try {
    const pendingProbe = (spec: SubprocessSpawnSpec): SubprocessHandle => {
      probeSpec = spec;
      signalStarted();
      return fakeHandle({ stdout: "", stderr: "", exitCode: 0, pending: true }, spec.signal);
    };
    const promise = resolveSpawnArgv(
      resolver(async () => { throw new Error("sibling node should satisfy the shim"); }, pendingProbe),
      fx.shim,
      [],
      { platform: "win32", signal: controller.signal },
    );
    await started;
    controller.abort(new Error("caller cancelled"));
    await assert.rejects(promise);
    assert.equal(probeSpec?.signal, controller.signal);
  } finally {
    await rm(fx.root, { recursive: true, force: true });
  }
});

test("non-Windows and non-npx shim argv preserve their existing shell-free/legacy boundaries", async () => {
  const args = ["--flag with spaces", "中文", "&not-a-shell-token"];
  const runtime = resolver(async () => { throw new Error("must not resolve a companion node"); });
  await assert.doesNotReject(async () => {
    assert.deepEqual(await resolveSpawnArgv(runtime, "/usr/bin/npx", args, { platform: "linux" }), ["/usr/bin/npx", ...args]);
  });
  assert.deepEqual(
    await resolveSpawnArgv(runtime, "C:\\Program Files\\imo.cmd", ["--version"], { platform: "win32", comspec: "C:\\Windows\\System32\\cmd.exe" }),
    ["C:\\Windows\\System32\\cmd.exe", "/d", "/s", "/c", "C:\\Program Files\\imo.cmd --version"],
  );
});
