import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import type {
  SubprocessHandle,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from "@deepseek-ai/dsh-subprocess";
import type { OperationLogLike } from "../../src/operation-log-face.ts";
import {
  ImoAuthActionsService,
  ImoAuthService,
  ImoCliService,
  ImoSkillsService,
  ImoUpgradeService,
  type Config,
  type ImoSkillActivation,
  type ImoSkillActivationSnapshot,
  type ImoAuth,
  type ImoAuthActions,
  type ImoAuthResult,
  type ImoCli,
  type ImoResult,
  type ImoUpgrade,
} from "../../src/index.ts";

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
interface FakeAuthResponse {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

interface FakeIo {
  version: string;
  target: string;
  /** Non-null makes `imo upgrade` fail with this exit code (version unchanged). */
  upgradeExitCode: number | null;
  /** args.join(" ") keys whose smoke invocation should exit non-zero. */
  smokeFailures: Map<string, number>;
  /** args.join(" ") key that stays pending until the caller aborts/timeout. */
  pendingKey: string | null;
  /** JSON output for `skills list --json`; undefined defaults to `[]`. */
  skillsListJson?: string;
  /** Output for `skills config path`; undefined uses a harmless temp path. */
  skillsConfigPath?: string;
  /** args-only invocation history. */
  invocations: string[][];
  /** Exact auth argv responses; fake-only, never a real prepare. */
  authResponses: Map<string, FakeAuthResponse>;
  /** Pending fake handles exposed only to race/disposal tests. */
  pendingHandles: SubprocessHandle[];
}

export function makeFakeIo(over: Partial<FakeIo> = {}): FakeIo {
  return {
    version: "0.2.14",
    target: "0.2.17",
    upgradeExitCode: null,
    smokeFailures: new Map(),
    pendingKey: null,
    invocations: [],
    authResponses: new Map(),
    pendingHandles: [],
    ...over,
  };
}

export function authResponse(stdout: string, exitCode = 0, stderr = ""): FakeAuthResponse {
  return { stdout, stderr, exitCode };
}

export function fakeHandle(
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

export function fakeSubprocess(io: FakeIo): FakeSubprocess {
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
      } else if (args[0] === "skills" && args[1] === "list" && args[2] === "--json") {
        stdout = `${io.skillsListJson ?? "[]"}\n`;
      } else if (args[0] === "skills" && args[1] === "config" && args[2] === "path") {
        stdout = `${io.skillsConfigPath ?? "/tmp/skills-config.json"}\n`;
      } else if (io.authResponses.has(key)) {
        const response = io.authResponses.get(key)!;
        stdout = response.stdout;
        stderr = response.stderr;
        exitCode = response.exitCode;
      } else if (io.smokeFailures.has(key)) {
        exitCode = io.smokeFailures.get(key) ?? 0;
        stderr = "smoke failed";
      } else if (args[0] === "auth" || args[0] === "skills" || args[0] === "icomposer") {
        stdout = `${key} help\n`;
      } else {
        exitCode = 64;
        stderr = "unknown command";
      }
      const handle = fakeHandle({ stdout, stderr, exitCode, pending }, spec.signal);
      if (pending) io.pendingHandles.push(handle);
      return handle;
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

export async function cliFixture(fake: FakeSubprocess, config: Partial<Config> = {}): Promise<{
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

export async function upgradeFixture(
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

export function allowAllSkillActivation(): ImoSkillActivation {
  const snapshot = (installedNames: readonly string[]): ImoSkillActivationSnapshot => {
    const installed = [...new Set(installedNames)].sort((left, right) => left.localeCompare(right));
    return { initialized: true, installed, enabled: installed, disabled: [], stale: [], revision: 0 };
  };
  return {
    ensureInitialized: async (installedNames) => snapshot(installedNames),
    snapshot: async (installedNames) => snapshot(installedNames),
  };
}

export async function skillsFixture(
  io: FakeIo,
  config: Partial<Config> = {},
  allowedRoot?: string,
  runtime?: SubprocessRuntime,
): Promise<{
  ctx: Context;
  skills: import("../src/index.ts").ImoSkills;
  io: FakeIo;
  dispose: () => Promise<void>;
}> {
  const previousHome = process.env.HOME;
  if (allowedRoot !== undefined) process.env.HOME = allowedRoot;
  const ctx = new Context();
  const fake = runtime ?? fakeSubprocess(io);
  ctx.provide("subprocess", fake as never);
  ctx.provide("imoSkillActivation", allowAllSkillActivation());
  const fiber = ctx.plugin(ImoSkillsService, { command: "imo", timeoutMs: 5_000, ...config });
  await fiber.await();
  const skills = ctx.get("imoSkills");
  if (skills === undefined) throw new Error("imoSkills service was not provided");
  return {
    ctx,
    skills,
    io,
    dispose: async () => {
      await fiber.dispose();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    },
  };
}

export async function authFixture(
  io: FakeIo,
  config: Partial<Config> = {},
): Promise<{
  ctx: Context;
  auth: ImoAuth;
  io: FakeIo;
  fiber: { dispose(): Promise<void> };
}> {
  const ctx = new Context();
  const fake = fakeSubprocess(io);
  ctx.provide("subprocess", fake as never);
  const fiber = ctx.plugin(ImoAuthService, { command: "imo", timeoutMs: 5_000, ...config });
  await fiber.await();
  const auth = ctx.get("imoAuth");
  if (auth === undefined) throw new Error("imoAuth service was not provided");
  return { ctx, auth, io, fiber };
}

export async function authActionsFixture(
  io: FakeIo,
  config: Partial<Config> = {},
): Promise<{
  ctx: Context;
  actions: ImoAuthActions;
  auth: ImoAuth;
  io: FakeIo;
  opLog: ReturnType<typeof fakeOperationLog>;
  dispose: () => Promise<void>;
}> {
  const ctx = new Context();
  const fake = fakeSubprocess(io);
  const opLog = fakeOperationLog();
  ctx.provide("subprocess", fake as never);
  ctx.provide("operationLog", opLog.api as never);
  const authFiber = ctx.plugin(ImoAuthService, { command: "imo", timeoutMs: 5_000, ...config });
  await authFiber.await();
  const actionsFiber = ctx.plugin(ImoAuthActionsService, { command: "imo", timeoutMs: 5_000, ...config });
  await actionsFiber.await();
  const auth = ctx.get("imoAuth");
  const actions = ctx.get("imoAuthActions");
  if (auth === undefined || actions === undefined) throw new Error("auth action services were not provided");
  return {
    ctx,
    actions,
    auth,
    io,
    opLog,
    dispose: async () => {
      await actionsFiber.dispose();
      await authFiber.dispose();
    },
  };
}

export async function expectOk<T>(result: ImoResult<T>): Promise<T> {
  assert.equal(result.ok, true);
  return result.value;
}

export async function expectAuthOk<T>(result: ImoAuthResult<T>): Promise<T> {
  assert.equal(result.ok, true);
  return result.value;
}

export async function approveAndRun(fx: Awaited<ReturnType<typeof upgradeFixture>>, target?: string) {
  const request = await fx.upgrade.requestUpgrade(target);
  await fx.opLog.api.decide(request.operationId, true, "alice");
  const result = await fx.upgrade.executeUpgrade(request.operationId);
  return { request, result };
}

