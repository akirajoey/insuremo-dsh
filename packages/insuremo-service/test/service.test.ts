import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type {
  SubprocessHandle,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import {
  ImoCliService,
  type Config,
  type ImoCli,
  type ImoResult,
} from "../src/index.ts";

type Reader = { readFrom(fromByte: number): {
  text: string;
  nextOffset: number;
  lossy: boolean;
  spillPath?: string;
} };

interface FakeProcessOptions {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly pending?: boolean;
}

interface FakeSubprocess extends SubprocessRuntime {
  readonly resolves: Array<{ command: string; env: Readonly<Record<string, string>> | undefined; signal: AbortSignal | undefined }>;
  readonly spawns: SubprocessSpawnSpec[];
  next: FakeProcessOptions;
}

function reader(text: string): Reader {
  return {
    readFrom(fromByte) {
      return { text: fromByte === 0 ? text : "", nextOffset: text.length, lossy: false };
    },
  };
}

function fakeHandle(options: FakeProcessOptions, signal?: AbortSignal): SubprocessHandle {
  let settle!: (outcome: { exitCode: number | null; signal: string | null }) => void;
  const done = new Promise<{ exitCode: number | null; signal: string | null }>(resolve => { settle = resolve; });
  const finish = (): void => {
    settle({ exitCode: options.exitCode ?? 0, signal: options.signal ?? null });
  };
  const handle = {
    pid: 123,
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    collected: {
      stdout: reader(options.stdout ?? ""),
      stderr: reader(options.stderr ?? ""),
    },
    done,
    terminate: finish,
    waitForExit: async () => { finish(); return true; },
  } as unknown as SubprocessHandle;
  if (options.pending !== true) finish();
  // Already-aborted signals never fire listeners; mirror subprocess-local by
  // terminating immediately when the spec signal is already aborted.
  if (signal?.aborted) handle.terminate();
  else signal?.addEventListener("abort", () => { handle.terminate(); }, { once: true });
  return handle;
}

function fakeSubprocess(options: FakeProcessOptions = {}): FakeSubprocess {
  const fake = {
    resolves: [],
    spawns: [],
    next: options,
    async resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal) {
      fake.resolves.push({ command, env, signal });
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      return "/tmp/fake-imo";
    },
    spawn(spec: SubprocessSpawnSpec) {
      fake.spawns.push(spec);
      return fakeHandle(fake.next, spec.signal);
    },
  } as FakeSubprocess;
  return fake;
}

async function serviceWith(fake: FakeSubprocess, config: Partial<Config> = {}): Promise<{
  service: ImoCli;
  dispose: () => Promise<void>;
}> {
  const ctx = new Context();
  ctx.provide("subprocess", fake as never);
  const fiber = ctx.plugin(ImoCliService, {
    command: "imo",
    timeoutMs: 15_000,
    ...config,
  });
  await fiber.await();
  const service = ctx.get("imoCli");
  if (service === undefined) throw new Error("imoCli service was not provided");
  return { service, dispose: () => fiber.dispose() };
}

async function expectOk<T>(result: ImoResult<T>): Promise<T> {
  assert.equal(result.ok, true);
  return result.value;
}

test("probe resolves an executable without spawning a process", async () => {
  const fake = fakeSubprocess();
  const fixture = await serviceWith(fake);
  try {
    const value = await expectOk(await fixture.service.probe());
    assert.deepEqual(value, { command: "imo", executablePath: "/tmp/fake-imo" });
    assert.equal(fake.spawns.length, 0);
  } finally {
    await fixture.dispose();
  }
});

test("probe returns a structured not-found error", async () => {
  const fake = fakeSubprocess();
  fake.resolveExecutable = async () => { throw new Error("missing executable"); };
  const fixture = await serviceWith(fake);
  try {
    const result = await fixture.service.probe();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "not-found");
  } finally {
    await fixture.dispose();
  }
});

test("version parses a semantic version and returns only a stdout digest", async () => {
  const fake = fakeSubprocess({ stdout: "0.2.14\n" });
  const fixture = await serviceWith(fake);
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
  const fake = fakeSubprocess({
    stdout: "Current version: v0.2.14\nNew version available: v0.2.17 (current: v0.2.14)\n",
  });
  const fixture = await serviceWith(fake);
  try {
    const value = await expectOk(await fixture.service.upgradeCheck());
    assert.deepEqual(value, {
      executablePath: "/tmp/fake-imo",
      currentVersion: "0.2.14",
      targetVersion: "0.2.17",
      updateAvailable: true,
      stdoutDigest: value.stdoutDigest,
    });
    assert.deepEqual(fake.spawns[0]?.argv.slice(1), ["upgrade", "--check"]);
  } finally {
    await fixture.dispose();
  }
});

test("upgradeCheck recognizes an up-to-date CLI", async () => {
  const fake = fakeSubprocess({ stdout: "Current version: v0.2.17\nAlready up to date.\n" });
  const fixture = await serviceWith(fake);
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
  const fake = fakeSubprocess({ stderr: "registry unavailable\n", exitCode: 7 });
  const fixture = await serviceWith(fake);
  try {
    const result = await fixture.service.upgradeCheck();
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "non-zero-exit");
      assert.equal(result.error.exitCode, 7);
      assert.match(result.error.stderrDigest ?? "", /^sha256:[0-9a-f]{64}$/);
    }
  } finally {
    await fixture.dispose();
  }
});

test("timeout aborts a pending process and returns a timeout error", async () => {
  const fake = fakeSubprocess({ pending: true });
  const fixture = await serviceWith(fake, { timeoutMs: 10 });
  try {
    const result = await fixture.service.version();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "timeout");
  } finally {
    await fixture.dispose();
  }
});

test("caller cancellation returns a cancellation error", async () => {
  const fake = fakeSubprocess({ pending: true });
  const fixture = await serviceWith(fake, { timeoutMs: 5_000 });
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
  const fake = fakeSubprocess({ stdout: "0.2.14\n" });
  const fixture = await serviceWith(fake);
  try {
    await fixture.service.version();
    assert.equal(fake.resolves[0]?.env, undefined);
    assert.equal(fake.spawns[0]?.env, undefined);
  } finally {
    await fixture.dispose();
  }
});
