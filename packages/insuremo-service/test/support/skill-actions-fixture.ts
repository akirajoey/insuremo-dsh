import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import {
  ImoSkillsService,
  type ImoSkillActivation,
  type ImoSkillActions,
  type ImoSkills,
} from "../../src/index.ts";
import { ImoSkillActivationService } from "../../src/skill-activation.ts";
import { ImoSkillActionsService } from "../../src/skill-actions/service.ts";
import { fakeHandle } from "./fake-subprocess.ts";
import type { SubprocessRuntime, SubprocessSpawnSpec, SubprocessHandle } from "@deepseek-ai/dsh-subprocess";
import type { OperationLogLike } from "../../src/operation-log-face.ts";

interface Row { path: string; content: string; }
export interface ScriptedState {
  rows: Record<string, Row>;
  installPreview: string;
  mutationError: { exitCode: number; stderr: string } | null;
  /** Fail the next `skills list --json` read (used to simulate a downstream recovery failure). */
  failNextList: boolean;
  invocations: string[][];
  errorLine: string;
  /** Manual-runtime hook: leave the skills-tool preview (-l) spawn pending. */
  hangPreview?: boolean;
  /** Manual-runtime hook: leave the skills-tool execution (add/update -y) spawn pending. */
  hangExecution?: boolean;
  /** Manual-runtime hook: make npx unresolvable. */
  npxMissing?: boolean;
}

export interface OpLog {
  api: OperationLogLike;
  records: Map<string, Record<string, unknown>>;
  decide(id: string, approved: boolean): Promise<void>;
  failResultTimes: number;
}

export interface Fixture {
  ctx: Context;
  actions: ImoSkillActions;
  activation: ImoSkillActivation;
  skills: ImoSkills;
  state: ScriptedState;
  opLog: OpLog;
  approve(id: string): Promise<void>;
  remountActions(): Promise<Fixture>;
  dispose(): Promise<void>;
}

export function reader(text: string): SubprocessSpawnSpec extends never ? never : {
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string };
} {
  return { readFrom(fromByte) { return { text: fromByte === 0 ? text : "", nextOffset: text.length, lossy: false }; } };
}

export function scripted(state: ScriptedState, root: string): SubprocessRuntime {
  async function resolveExecutable() { return "/opt/homebrew/bin/imo"; }
  function spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const args = [...spec.argv.slice(1)];
    state.invocations.push([...args]);
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = 0;
    if (args[0] === "skills" && args[1] === "list" && args[2] === "--json") {
      if (state.failNextList) {
        state.failNextList = false;
        stderr = "list failed";
        exitCode = 1;
      } else {
        stdout = JSON.stringify(Object.entries(state.rows).map(([name, row]) => ({ name, description: `desc-${name}`, path: row.path })));
      }
    } else if (args[0] === "skills" && args[1] === "install") {
      if (args.includes("--list")) {
        stdout = state.installPreview;
      } else if (state.mutationError !== null) {
        ({ exitCode, stderr } = state.mutationError);
        state.mutationError = null;
      } else {
        for (const name of flagValues(args, "-s")) applyInstall(state, root, name);
        stdout = "installed\n";
      }
    } else if (args[0] === "skills" && args[1] === "remove") {
      if (state.mutationError !== null) {
        ({ exitCode, stderr } = state.mutationError);
        state.mutationError = null;
      } else {
        for (const name of args.slice(2, args.indexOf("-g"))) applyRemove(state, root, name);
        stdout = "removed\n";
      }
    } else if (args[0] === "skills" && args[1] === "update") {
      if (state.mutationError !== null) {
        ({ exitCode, stderr } = state.mutationError);
        state.mutationError = null;
      } else {
        for (const name of Object.keys(state.rows)) applyUpdate(state, root, name);
        stdout = "updated\n";
      }
    } else if (args[0] === "-y" && args.includes("@insuremo/skills-tool")) {
      if (args.includes("-l")) {
        stdout = state.installPreview;
      } else if (state.mutationError !== null) {
        ({ exitCode, stderr } = state.mutationError);
        state.mutationError = null;
      } else if (args.includes("update")) {
        for (const name of Object.keys(state.rows)) applyUpdate(state, root, name);
        stdout = "updated\n";
      } else if (args.includes("add")) {
        for (const scenario of flagValues(args, "-s")) {
          for (const name of SCENARIO_MEMBERS[scenario] ?? [`scenario-${scenario}`]) applyInstall(state, root, name);
        }
        stdout = "installed\n";
      }
    } else if (args[0] === "skills" || args[0] === "auth" || args[0] === "icomposer") {
      stdout = `${args.join(" ")} help\n`;
    } else {
      exitCode = 64;
      stderr = "unknown command";
    }
    return fakeHandle({ stdout, stderr, exitCode }, spec.signal);
  }
  return { resolveExecutable, spawn } as unknown as SubprocessRuntime;
}

export function flagValues(args: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && index + 1 < args.length) values.push(args[index + 1]!);
  }
  return values;
}

/** Real scenario membership observed from an isolated-HOME install (TASK-079). */
export const SCENARIO_MEMBERS: Record<string, readonly string[]> = {
  "ask-insuremo": ["insuremo-auth-cli", "insuremo-deep-search"],
};

export function applyInstall(state: ScriptedState, root: string, name: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const content = `# ${name}\n`;
  writeFileSync(join(dir, "SKILL.md"), content);
  state.rows[name] = { path: dir, content };
}

export function applyRemove(state: ScriptedState, root: string, name: string): void {
  const row = state.rows[name];
  if (row === undefined) return;
  rmSync(row.path, { recursive: true, force: true });
  delete state.rows[name];
}

export function applyUpdate(state: ScriptedState, root: string, name: string): void {
  const row = state.rows[name];
  if (row === undefined) return;
  const content = `${row.content}updated\n`;
  writeFileSync(join(row.path, "SKILL.md"), content);
  state.rows[name] = { ...row, content };
}

export function rowsJson(state: ScriptedState, ...names: string[]): string {
  return JSON.stringify(names.map(name => ({ name, description: `desc-${name}`, path: state.rows[name]!.path })));
}

export function miniOperationLog(): OpLog {
  const records = new Map<string, Record<string, unknown>>();
  const mk = (code: string): Error => { const error = new Error(code); (error as { code?: string }).code = code; return error; };
  const api = {
    async append(input: { requestId: string; kind: string; paramsDigest: string; artifactRefs: string[] }) {
      const id = `op-${records.size + 1}`;
      const record = { ...input, id, decision: "pending", schemaVersion: "0", createdAt: new Date().toISOString() };
      records.set(id, record);
      return { ...record };
    },
    list() { return [...records.values()]; },
    async recordResult(id: string, input: { resultDigest: string; artifactRefs: string[] }) {
      if (resultFailures.failResultTimes > 0) {
        resultFailures.failResultTimes -= 1;
        throw new Error("operation-log storage temporarily unavailable");
      }
      const current = records.get(id);
      if (current === undefined) throw mk("missing-operation");
      if (current.decision !== "approved") throw mk("not-approved");
      if (current.resultDigest !== undefined) throw mk("already-has-result");
      const next = { ...current, resultDigest: input.resultDigest, artifactRefs: [...input.artifactRefs] };
      records.set(id, next);
      return { ...next };
    },
  } as unknown as OperationLogLike;
  const resultFailures = { failResultTimes: 0 };
  return {
    api,
    records,
    get failResultTimes(): number { return resultFailures.failResultTimes; },
    set failResultTimes(value: number) { resultFailures.failResultTimes = value; },
    async decide(id: string, approved: boolean) {
      const current = records.get(id);
      if (current === undefined || current.decision !== "pending") throw new Error("cannot decide");
      const next = { ...current, decision: approved ? "approved" : "rejected", decidedBy: "alice", decidedAt: new Date().toISOString() };
      records.set(id, next);
    },
  };
}

export async function openFixture(
  root: string,
  storageRoot: string,
  initial: readonly string[],
  options: { runtime?: (state: ScriptedState, root: string) => SubprocessRuntime; actionsTimeoutMs?: number } = {},
): Promise<Fixture> {
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const state: ScriptedState = {
    rows: {},
    installPreview: "",
    mutationError: null,
    failNextList: false,
    invocations: [],
    errorLine: "fail",
  };
  for (const name of initial) applyInstall(state, root, name);
  const ctx = new Context();
  ctx.provide("subprocess", (options.runtime ? options.runtime(state, root) : scripted(state, root)) as never);
  const opLog = miniOperationLog();
  ctx.provide("operationLog", opLog.api as never);
  const storageFiber = ctx.plugin(Storage);
  await storageFiber.await();
  const backend = new JsonStorageBackend(storageRoot);
  const unregisterBackend = ctx.storage.backend.register("json", backend);
  ctx.provide("storageDomain", new DomainFacility(ctx, { backend: "json" }));
  const skillsFiber = ctx.plugin(ImoSkillsService, { command: "imo", timeoutMs: 5_000 });
  await skillsFiber.await();
  const activationFiber = ctx.plugin(ImoSkillActivationService);
  await activationFiber.await();
  const actionsFiber = ctx.plugin(ImoSkillActionsService, { command: "imo", timeoutMs: options.actionsTimeoutMs ?? 5_000, allowedGitHosts: ["github.com"] });
  await actionsFiber.await();
  const actions = ctx.get<ImoSkillActions>("imoSkillActions");
  const activation = ctx.get<ImoSkillActivation>("imoSkillActivation");
  const skills = ctx.get<ImoSkills>("imoSkills");
  if (actions === undefined || activation === undefined || skills === undefined) throw new Error("skill actions services were not provided");
  const disposeAll = async () => {
    await activationFiber.dispose();
    await skillsFiber.dispose();
    await storageFiber.dispose();
    unregisterBackend();
    await backend.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  };
  let currentActionsFiber = actionsFiber;
  let mountedActions = actions;
  const dispose = async () => {
    await currentActionsFiber.dispose();
    await disposeAll();
  };
  const mountActions = async (): Promise<Fixture> => {
    await currentActionsFiber.dispose();
    const next = ctx.plugin(ImoSkillActionsService, { command: "imo", timeoutMs: options.actionsTimeoutMs ?? 5_000, allowedGitHosts: ["github.com"] });
    await next.await();
    const remounted = ctx.get<ImoSkillActions>("imoSkillActions");
    if (remounted === undefined) throw new Error("remounted skill actions service was not provided");
    currentActionsFiber = next;
    mountedActions = remounted;
    return {
      ctx, activation, skills, state, opLog, actions: mountedActions,
      approve: async (id: string) => { await opLog.decide(id, true); },
      remountActions: mountActions,
      dispose,
    };
  };
  return {
    ctx, activation, skills, state, opLog, actions,
    approve: async (id: string) => { await opLog.decide(id, true); },
    remountActions: mountActions,
    dispose,
  };
}

export async function withFixture(initial: readonly string[], run: (fx: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "imo-skill-actions-"));
  const storageRoot = await mkdtemp(join(tmpdir(), "imo-skill-actions-store-"));
  const fixture = await openFixture(root, storageRoot, initial);
  try {
    await run(fixture);
  } finally {
    await fixture.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
}

export function findInvocation(fx: Fixture, sub: string): string[] | undefined {
  return fx.state.invocations.find(args => args[0] === "skills" && args[1] === sub);
}

export const installInput = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "skill-install",
  source: { type: "alias", value: "insuremo" },
  agent: "codex",
  ...over,
});

export function checkInvalid(result: { ok: true } | { ok: false; error: { code: string } }): string {
  assert.equal(result.ok, false);
  return (result as { ok: false; error: { code: string } }).error.code;
}
