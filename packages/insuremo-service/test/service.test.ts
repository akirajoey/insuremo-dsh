import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type {
  SubprocessHandle,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import type { OperationLogLike } from "../src/operation-log-face.ts";
import {
  ImoCliService,
  ImoUpgradeService,
  type Config,
  type ImoCli,
  type ImoUpgrade,
  type ImoResult,
} from "../src/index.ts";

type Reader = { readFrom(fromByte: number): {
  text: string;
  nextOffset: number;
  lossy: boolean;
  spillPath?: string;
} };

function reader(text: string): Reader {
  return {
    readFrom(fromByte) {
      return { text: fromByte === 0 ? text : "", nextOffset: text.length, lossy: false };
    },
  };
}

/** Stateful fake process surface: upgrade changes the reported version. */
interface FakeIo {
  version: string;
  target: string;
  /** Non-null makes `imo upgrade` fail with this exit code (version unchanged). */
  upgradeExitCode: number | null;
  /** args.join(" ") keys whose smoke invocation should exit non-zero. */
  smokeFailures: Map<string, number>;
  /** args.join(" ") key that stays pending until the caller aborts/timeout. */
  pendingKey: string | null;
  /** args-only invocation history. */
  invocations: string[][];
}

function makeFakeIo(over: Partial<FakeIo> = {}): FakeIo {
  return {
    version: "0.2.14",
    target: "0.2.17",
    upgradeExitCode: null,
    smokeFailures: new Map(),
    pendingKey: null,
    invocations: [],
    ...over,
  };
}

function fakeHandle(
  opts: { stdout: string; stderr: string; exitCode: number | null; pending?: boolean },
  signal?: AbortSignal,
): SubprocessHandle {
  let settle!: (outcome: { exitCode: number | null; signal: string | null }) => void;
  const done = new Promise<{ exitCode: number | null; signal: string | null }>(resolve => { settle = resolve; });
  const finish = (): void => { settle({ exitCode: opts.exitCode, signal: null }); };
  const handle = {
    pid: 123,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: { stdout: reader(opts.stdout), stderr: reader(opts.stderr) },
    done,
    terminate: finish,
    waitForExit: async () => { finish(); return true; },
  } as unknown as SubprocessHandle;
  if (!opts.pending) finish();
  if (signal?.aborted) handle.terminate();
  else signal?.addEventListener("abort", () => { handle.terminate(); }, { once: true });
  return handle;
}

interface FakeSubprocess extends SubprocessRuntime {
  readonly resolves: Array<{ command: string; env: Readonly<Record<string, string>> | undefined; signal: AbortSignal | undefined }>;
  readonly spawns: SubprocessSpawnSpec[];
}

function fakeSubprocess(io: FakeIo): FakeSubprocess {
  const fake = {
    resolves: [],
    spawns: [],
    async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal) {
      (fake.resolves as Array<unknown>).push({ command, env, signal });
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      return "/opt/homebrew/bin/imo";
    },
    spawn(spec: SubprocessSpawnSpec) {
      (fake.spawns as SubprocessSpawnSpec[]).push(spec);
      const args = [...spec.argv.slice(1)];
      io.invocations.push(args);
      let stdout = "";
      let stderr = "";
      let exitCode: number | null = 0;
      let pending = false;
      const key = args.join(" ");
      if (key === io.pendingKey) {
        pending = true;
      } else if (args[0] === "upgrade") {
        if (io.upgradeExitCode !== null) {
          exitCode = io.upgradeExitCode;
          stderr = "upgrade failed";
        } else {
          const at = args.indexOf("--version");
          const target = at >= 0 ? (args[at + 1] ?? io.target) : io.target;
          io.version = target;
          stdout = `upgraded to ${target}\n`;
        }
      } else if (args[0] === "--version") {
        stdout = `${io.version}\n`;
      } else if (io.smokeFailures.has(key)) {
        exitCode = io.smokeFailures.get(key) ?? 0;
        stderr = "smoke failed";
      } else if (args[0] === "auth" || args[0] === "skills" || args[0] === "icomposer") {
        stdout = `${key} help\n`;
      } else {
        exitCode = 64;
        stderr = "unknown command";
      }
      return fakeHandle({ stdout, stderr, exitCode, pending }, spec.signal);
    },
  } as unknown as FakeSubprocess;
  return fake;
}

function fakeOperationLog(): {
  api: OperationLogLike;
  records: Map<string, Record<string, unknown>>;
} {
  const records = new Map<string, Record<string, unknown>>();
  const mk = (code: string, message: string): Error => {
    const error = new Error(message);
    (error as { code?: string }).code = code;
    return error;
  };
  const api = {
    async append(input: {
      id?: string;
      requestId: string;
      kind: string;
      paramsDigest: string;
      artifactRefs: string[];
    }) {
      const id = input.id ?? `op-${records.size + 1}`;
      const record: Record<string, unknown> = {
        ...input,
        id,
        decision: "pending",
        schemaVersion: "0",
        createdAt: new Date().toISOString(),
      };
      records.set(id, record);
      return { ...record };
    },
    list() {
      return [...records.values()];
    },
    async decide(id: string, approved: boolean, by: string, reason?: string) {
      const current = records.get(id);
      if (!current) throw new Error("missing");
      if (current.decision !== "pending") throw new Error("already decided");
      const next: Record<string, unknown> = {
        ...current,
        decision: approved ? "approved" : "rejected",
        decidedBy: by,
        decidedAt: new Date().toISOString(),
        ...(reason === undefined ? {} : { reason }),
      };
      records.set(id, next);
      return { ...next };
    },
    async recordResult(id: string, input: { resultDigest: string; artifactRefs: string[] }) {
      const current = records.get(id);
      if (!current) throw mk("missing-operation", "missing");
      if (current.decision !== "approved") throw mk("not-approved", "not approved");
      if (current.resultDigest !== undefined) throw mk("already-has-result", "already has result");
      const next: Record<string, unknown> = {
        ...current,
        resultDigest: input.resultDigest,
        artifactRefs: [...input.artifactRefs],
      };
      records.set(id, next);
      return { ...next };
    },
  } as unknown as OperationLogLike;
  return { api, records };
}

async function cliFixture(fake: FakeSubprocess, config: Partial<Config> = {}): Promise<{
  service: ImoCli;
  dispose: () => Promise<void>;
}> {
  const ctx = new Context();
  ctx.provide("subprocess", fake as never);
  const fiber = ctx.plugin(ImoCliService, { command: "imo", timeoutMs: 15_000, ...config });
  await fiber.await();
  const service = ctx.get("imoCli");
  if (service === undefined) throw new Error("imoCli service was not provided");
  return { service, dispose: () => fiber.dispose() };
}

async function upgradeFixture(
  io: FakeIo,
  config: Partial<Config> = {},
): Promise<{
  upgrade: ImoUpgrade;
  io: FakeIo;
  opLog: ReturnType<typeof fakeOperationLog>;
  dispose: () => Promise<void>;
}> {
  const ctx = new Context();
  const fake = fakeSubprocess(io);
  const opLog = fakeOperationLog();
  ctx.provide("subprocess", fake as never);
  ctx.provide("operationLog", opLog.api as never);
  const cliFiber = ctx.plugin(ImoCliService, { command: "imo", timeoutMs: 5_000, ...config });
  await cliFiber.await();
  const upFiber = ctx.plugin(ImoUpgradeService, { command: "imo", timeoutMs: 5_000, ...config });
  await upFiber.await();
  const upgrade = ctx.get("imoUpgrade");
  if (upgrade === undefined) throw new Error("imoUpgrade service was not provided");
  return {
    upgrade,
    io,
    opLog,
    dispose: async () => {
      await upFiber.dispose();
      await cliFiber.dispose();
    },
  };
}

async function expectOk<T>(result: ImoResult<T>): Promise<T> {
  assert.equal(result.ok, true);
  return result.value;
}

async function approveAndRun(fx: Awaited<ReturnType<typeof upgradeFixture>>, target?: string) {
  const request = await fx.upgrade.requestUpgrade(target);
  await fx.opLog.api.decide(request.operationId, true, "alice");
  const result = await fx.upgrade.executeUpgrade(request.operationId);
  return { request, result };
}

// ---- read-only ImoCliService (shared runner) ----

test("probe resolves an executable without spawning a process", async () => {
  const fake = fakeSubprocess(makeFakeIo());
  const fixture = await cliFixture(fake);
  try {
    const value = await expectOk(await fixture.service.probe());
    assert.deepEqual(value, { command: "imo", executablePath: "/opt/homebrew/bin/imo" });
    assert.equal(fake.spawns.length, 0);
  } finally {
    await fixture.dispose();
  }
});

test("probe returns a structured not-found error", async () => {
  const fake = fakeSubprocess(makeFakeIo());
  fake.resolveExecutable = async () => { throw new Error("missing executable"); };
  const fixture = await cliFixture(fake);
  try {
    const result = await fixture.service.probe();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "not-found");
  } finally {
    await fixture.dispose();
  }
});

test("version parses a semantic version and returns only a stdout digest", async () => {
  const io = makeFakeIo();
  const fake = fakeSubprocess(io);
  const fixture = await cliFixture(fake);
  try {
    const value = await expectOk(await fixture.service.version());
    assert.equal(value.currentVersion, "0.2.14");
    assert.match(value.stdoutDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal("stdout" in value, false);
    assert.deepEqual(fake.spawns[0]?.argv.slice(1), ["--version"]);
  } finally {
    await fixture.dispose();
  }
});

test("upgradeCheck parses an available update", async () => {
  const io = makeFakeIo();
  const fake = fakeSubprocess(io);
  // The fake prints the same shape the real CLI does for the --check read.
  const original = fake.spawn;
  fake.spawn = (spec) => {
    const args = [...spec.argv.slice(1)];
    if (args[0] === "upgrade" && args[1] === "--check") {
      io.invocations.push(args);
      const text = "Current version: v0.2.14\nNew version available: v0.2.17 (current: v0.2.14)\n";
      return fakeHandle({ stdout: text, stderr: "", exitCode: 0 }, spec.signal);
    }
    return original(spec);
  };
  const fixture = await cliFixture(fake);
  try {
    const value = await expectOk(await fixture.service.upgradeCheck());
    assert.equal(value.currentVersion, "0.2.14");
    assert.equal(value.targetVersion, "0.2.17");
    assert.equal(value.updateAvailable, true);
    assert.deepEqual(io.invocations[0], ["upgrade", "--check"]);
  } finally {
    await fixture.dispose();
  }
});

test("upgradeCheck recognizes an up-to-date CLI", async () => {
  const io = makeFakeIo();
  const fake = fakeSubprocess(io);
  const original = fake.spawn;
  fake.spawn = (spec) => {
    const args = [...spec.argv.slice(1)];
    if (args[0] === "upgrade" && args[1] === "--check") {
      io.invocations.push(args);
      return fakeHandle({ stdout: "Current version: v0.2.17\nAlready up to date.\n", stderr: "", exitCode: 0 }, spec.signal);
    }
    return original(spec);
  };
  const fixture = await cliFixture(fake);
  try {
    const value = await expectOk(await fixture.service.upgradeCheck());
    assert.equal(value.currentVersion, "0.2.17");
    assert.equal(value.targetVersion, "0.2.17");
    assert.equal(value.updateAvailable, false);
  } finally {
    await fixture.dispose();
  }
});

test("non-zero CLI exit is returned as a structured failure", async () => {
  const io = makeFakeIo({ upgradeExitCode: 7 });
  const fake = fakeSubprocess(io);
  const fixture = await cliFixture(fake);
  try {
    const result = await fixture.service.upgradeCheck();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "non-zero-exit");
      assert.equal(result.error.exitCode, 7);
    }
  } finally {
    await fixture.dispose();
  }
});

test("timeout aborts a pending process and returns a timeout error", async () => {
  const io = makeFakeIo({ pendingKey: "--version" });
  const fake = fakeSubprocess(io);
  const fixture = await cliFixture(fake, { timeoutMs: 10 });
  try {
    const result = await fixture.service.version();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "timeout");
  } finally {
    await fixture.dispose();
  }
});

test("caller cancellation returns a cancellation error", async () => {
  const io = makeFakeIo({ pendingKey: "--version" });
  const fake = fakeSubprocess(io);
  const fixture = await cliFixture(fake, { timeoutMs: 5_000 });
  try {
    const controller = new AbortController();
    const promise = fixture.service.version(controller.signal);
    controller.abort(new Error("caller left"));
    const result = await promise;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "cancelled");
  } finally {
    await fixture.dispose();
  }
});

test("the service leaves environment forwarding to the subprocess scrubber", async () => {
  const io = makeFakeIo();
  const fake = fakeSubprocess(io);
  const fixture = await cliFixture(fake);
  try {
    await fixture.service.version();
    assert.equal(fake.resolves[0]?.env, undefined);
    assert.equal(fake.spawns[0]?.env, undefined);
  } finally {
    await fixture.dispose();
  }
});

// ---- IMO upgrade closed loop ----

test("executeUpgrade rejects an unapproved operation without spawning", async () => {
  const io = makeFakeIo();
  const fx = await upgradeFixture(io);
  try {
    const request = await fx.upgrade.requestUpgrade();
    const result = await fx.upgrade.executeUpgrade(request.operationId);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "not-approved");
    assert.equal(io.invocations.length, 0);
    assert.equal(fx.upgrade.upgradeStatus().running, false);
  } finally {
    await fx.dispose();
  }
});

test("executeUpgrade on a missing operation rejects without spawning", async () => {
  const io = makeFakeIo();
  const fx = await upgradeFixture(io);
  try {
    const result = await fx.upgrade.executeUpgrade("does-not-exist");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "missing-operation");
    assert.equal(io.invocations.length, 0);
  } finally {
    await fx.dispose();
  }
});

test("approved execution succeeds with a complete digest-only receipt", async () => {
  const io = makeFakeIo();
  const fx = await upgradeFixture(io);
  try {
    const { request, result } = await approveAndRun(fx);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const receipt = result.receipt;
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.before, "0.2.14");
    assert.equal(receipt.after, "0.2.17");
    assert.equal(receipt.exitCode, 0);
    assert.equal(receipt.smoke.length, 7);
    assert.ok(receipt.smoke.every((entry) => entry.ok));
    assert.match(receipt.smoke[0]?.cmd ?? "", /imo --version$/);
    assert.match(receipt.recovery, /0\.2\.14/);
    // Every smoke command prints a digest, never raw output.
    assert.ok(receipt.smoke.every((entry) => /^sha256:/.test(entry.stdoutDigest)));
    // The durable record carries the receipt digest.
    const record = fx.opLog.records.get(request.operationId);
    assert.match(String(record?.resultDigest ?? ""), /^sha256:/);
    assert.equal(fx.upgrade.upgradeStatus().running, false);
    // The upgrade actually ran against the fake: pre version, upgrade, then 7 smoke.
    assert.deepEqual(io.invocations[0], ["--version"]);
    assert.deepEqual(io.invocations[1], ["upgrade", "--yes"]);
    assert.equal(io.version, "0.2.17");
  } finally {
    await fx.dispose();
  }
});

test("an explicit target becomes the --version argument", async () => {
  const io = makeFakeIo();
  const fx = await upgradeFixture(io);
  try {
    const request = await fx.upgrade.requestUpgrade("0.2.15");
    await fx.opLog.api.decide(request.operationId, true, "alice");
    const result = await fx.upgrade.executeUpgrade(request.operationId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.after, "0.2.15");
    assert.deepEqual(io.invocations[1], ["upgrade", "--version", "0.2.15", "--yes"]);
  } finally {
    await fx.dispose();
  }
});

test("a second execution while running returns busy and the lock releases", async () => {
  const io = makeFakeIo({ pendingKey: "upgrade --yes" });
  const fx = await upgradeFixture(io, { upgradeTimeoutMs: 300 });
  try {
    const request = await fx.upgrade.requestUpgrade();
    await fx.opLog.api.decide(request.operationId, true, "alice");
    const first = fx.upgrade.executeUpgrade(request.operationId);
    const second = await fx.upgrade.executeUpgrade(request.operationId);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, "busy");
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
    if (firstResult.ok) assert.equal(firstResult.receipt.status, "failed");
    assert.equal(fx.upgrade.upgradeStatus().running, false);
  } finally {
    await fx.dispose();
  }
});

test("a failed upgrade records a failed receipt with recovery and releases the lock", async () => {
  const io = makeFakeIo({ upgradeExitCode: 7 });
  const fx = await upgradeFixture(io);
  try {
    const { result } = await approveAndRun(fx);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.status, "failed");
    assert.equal(result.receipt.exitCode, 7);
    assert.equal(result.receipt.smoke.length, 0);
    assert.match(result.receipt.recovery, /恢复命令：imo upgrade --version 0\.2\.14 --yes/);
    assert.match(result.receipt.stderrDigest, /^sha256:/);
    assert.equal(fx.upgrade.upgradeStatus().running, false);
    assert.equal(io.version, "0.2.14");
  } finally {
    await fx.dispose();
  }
});

test("a partially failing smoke battery is recorded accurately", async () => {
  const io = makeFakeIo({ smokeFailures: new Map([["auth --help", 3]]) });
  const fx = await upgradeFixture(io);
  try {
    const { result } = await approveAndRun(fx);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.status, "completed");
    const auth = result.receipt.smoke.find((entry) => entry.cmd === "imo auth --help");
    assert.equal(auth?.ok, false);
    assert.equal(auth?.exitCode, 3);
    assert.ok(result.receipt.smoke.filter((entry) => entry.ok).length >= 6);
  } finally {
    await fx.dispose();
  }
});

test("a completed operation cannot be executed again (already-executed)", async () => {
  const io = makeFakeIo();
  const fx = await upgradeFixture(io);
  try {
    const { request, result } = await approveAndRun(fx);
    assert.equal(result.ok, true);
    const second = await fx.upgrade.executeUpgrade(request.operationId);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, "already-executed");
  } finally {
    await fx.dispose();
  }
});

test("requestUpgrade appends a pending imo-upgrade record with a params digest", async () => {
  const io = makeFakeIo();
  const fx = await upgradeFixture(io);
  try {
    const request = await fx.upgrade.requestUpgrade();
    const record = fx.opLog.records.get(request.operationId);
    assert.equal(record?.kind, "imo-upgrade");
    assert.equal(record?.decision, "pending");
    assert.match(String(record?.paramsDigest ?? ""), /^sha256:/);
    assert.equal(fx.upgrade.upgradeStatus().running, false);
  } finally {
    await fx.dispose();
  }
});
