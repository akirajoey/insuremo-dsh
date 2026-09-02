// TASK-079: scenario sync via the unpinned @insuremo/skills-tool adapter.
// Real isolated-HOME behavior (verified by the maintainer): `add -l` is
// catalog-wide, installs run `-y --skip-update-check` with the trusted
// registry, and `update -g` reconciles already-installed sources.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from "@deepseek-ai/dsh-subprocess";
import {
  applyInstall,
  applyUpdate,
  flagValues,
  openFixture,
  reader,
  SCENARIO_MEMBERS,
  withFixture,
  type Fixture,
  type ScriptedState,
} from "./support/skill-actions-fixture.ts";
import { IMO_REGISTRY } from "../src/imo-install.ts";
import { parsePreviewNames, SKILLS_TOOL_COMMAND, SKILLS_TOOL_PACKAGE, SKILLS_TOOL_REGISTRY } from "../src/skill-actions/preview.ts";

const REGISTRY_FLAG = `--registry=${SKILLS_TOOL_REGISTRY}`;
const ADD_ARGV_BASE = ["-y", REGISTRY_FLAG, SKILLS_TOOL_PACKAGE, "add", "insuremo-skills", "-g", "-a", "universal"];

type ManualState = ScriptedState & { releaseAll?: () => void };

function scenarioRuntime(state: ManualState, root: string): SubprocessRuntime {
  const pending = new Map<(value: { exitCode: number | null; signal: string | null }) => void, NodeJS.Timeout>();
  const finishWith = (settle: (value: { exitCode: number | null; signal: string | null }) => void, value: { exitCode: number | null; signal: string | null }): void => {
    const fallback = pending.get(settle);
    if (fallback !== undefined) clearTimeout(fallback);
    pending.delete(settle);
    settle(value);
  };
  state.releaseAll = () => {
    for (const [settle] of [...pending]) finishWith(settle, { exitCode: 0, signal: null });
  };
  async function resolveExecutable(command: string) {
    if (state.npxMissing === true && command === "npx") throw new Error(`executable "${command}" was not found`);
    return `/usr/bin/${command}`;
  }
  function spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const args = [...spec.argv.slice(1)];
    state.invocations.push([...args]);
    const stdout = args[0] === "skills" && args[1] === "list" && args[2] === "--json"
      ? `${JSON.stringify(Object.entries(state.rows).map(([name, row]) => ({ name, description: `desc-${name}`, path: row.path })))}\n`
      : args.includes("-l") ? state.installPreview : "";
    let settle!: (value: { exitCode: number | null; signal: string | null }) => void;
    const done = new Promise<{ exitCode: number | null; signal: string | null }>(resolve => { settle = resolve; });
    const finish = (value: { exitCode: number | null; signal: string | null }): void => finishWith(settle, value);
    const isPreview = args.includes("-l");
    const hang = state.hangPreview === true && isPreview
      || state.hangExecution === true && args.includes("add") && !isPreview;
    if (hang) {
      // Emulates a hung process: settles when the deadline aborts, when the
      // test releases it, or via a bounded fallback so tests can never wedge.
      pending.set(settle, setTimeout(() => finish({ exitCode: null, signal: "SIGKILL" }), 5_000));
      spec.signal?.addEventListener("abort", () => finish({ exitCode: null, signal: "SIGTERM" }), { once: true });
    } else {
      // Only the execution spawn (never the -l preview) mutates the store.
      const isExecution = args.includes("add") && !isPreview;
      if (isExecution) {
        for (const scenario of flagValues(args, "-s")) {
          for (const name of SCENARIO_MEMBERS[scenario] ?? [`scenario-${scenario}`]) applyInstall(state, root, name);
        }
      }
      if (isExecution || args.includes("update")) {
        for (const name of Object.keys(state.rows)) applyUpdate(state, root, name);
      }
      queueMicrotask(() => finish({ exitCode: 0, signal: null }));
    }
    return {
      pid: 1, done, terminate: () => finish({ exitCode: null, signal: "SIGTERM" }),
      waitForExit: async () => true,
      collected: { stdout: reader(stdout), stderr: reader("") },
    } as unknown as SubprocessHandle;
  }
  return { resolveExecutable, spawn } as unknown as SubprocessRuntime;
}

async function scenarioFixture(
  initial: readonly string[],
  configure?: (state: ManualState) => void,
  actionsTimeoutMs?: number,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "imo-scenario-"));
  const storageRoot = await mkdtemp(join(tmpdir(), "imo-scenario-store-"));
  const fixture = await openFixture(root, storageRoot, initial, {
    runtime: (state, dir) => {
      const manual = state as ManualState;
      configure?.(manual);
      return scenarioRuntime(manual, dir);
    },
    ...(actionsTimeoutMs === undefined ? {} : { actionsTimeoutMs }),
  });
  return fixture;
}

const HUMAN_PREVIEW = [
  "\u001B[1m\u001B[36m╭──────────────────────────────────────────╮\u001B[0m",
  "\u001B[0m│ \u001B[32m✔\u001B[0m insuremo-auth-cli │ Audit & IMOHUB auth helper \u001B[0m",
  "│ insuremo-deep-search │ Deep search over IMO docs",
  "· Universal 34 skills-tool",
  "└──────────────────────────────────────────┘",
].join("\n");

test("the skills-tool adapter reuses the shared registry and npx command", () => {
  assert.equal(SKILLS_TOOL_REGISTRY, IMO_REGISTRY);
  assert.equal(SKILLS_TOOL_COMMAND, "npx");
  assert.equal(SKILLS_TOOL_PACKAGE, "@insuremo/skills-tool");
});

test("scenario preview and sync build the exact unpinned skills-tool argv", async () => {
  await withFixture(["alpha"], async fx => {
    fx.state.installPreview = HUMAN_PREVIEW;
    const requested = await fx.actions.request({ kind: "skill-install", source: { type: "scenario", value: "ask-insuremo" }, agent: "universal" });
    assert.equal(requested.ok, true);
    if (!requested.ok) return;
    assert.deepEqual(fx.state.invocations.filter(args => args.includes("add") && args.includes("-l"))[0], [...ADD_ARGV_BASE, "-s", "ask-insuremo", "-l", "--skip-update-check"]);
    // Catalog-wide, sanitized name-only tokens (never descriptions/raw output).
    assert.deepEqual(requested.value.preview.candidateNames, ["insuremo-auth-cli", "insuremo-deep-search"]);
    await fx.approve(requested.value.operationId);
    const result = await fx.actions.execute(requested.value.operationId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.status, "completed");
    assert.deepEqual(result.receipt.added, ["insuremo-auth-cli", "insuremo-deep-search"]);
    assert.deepEqual(result.receipt.removed, []);
    const execArgs = fx.state.invocations.find(args => args.includes("add") && !args.includes("-l"));
    assert.deepEqual(execArgs?.slice(-2), ["-y", "--skip-update-check"]);
    assert.deepEqual(Object.keys(fx.state.rows).sort(), ["alpha", "insuremo-auth-cli", "insuremo-deep-search"]);
  });
});

test("scenario install rejects non-universal agents with zero spawn", async () => {
  await withFixture(["alpha"], async fx => {
    const result = await fx.actions.request({ kind: "skill-install", source: { type: "scenario", value: "uic-developer" }, agent: "codex" });
    assert.equal(result.ok, false);
    assert.equal(fx.state.invocations.length, 0);
  });
});

test("update-all uses the skills-tool argv and reports updated rows", async () => {
  await withFixture(["a-one", "b-two"], async fx => {
    const result = await fx.actions.runDirect({ kind: "skill-update" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(fx.state.invocations.find(args => args.includes("@insuremo/skills-tool")), ["-y", REGISTRY_FLAG, SKILLS_TOOL_PACKAGE, "update", "-g", "--skip-update-check"]);
    assert.equal(result.receipt.status, "completed");
    assert.deepEqual([...result.receipt.updated].sort(), ["a-one", "b-two"]);
  });
});

test("a hung skills-tool run times out into a failed receipt and never reruns", async () => {
  const fx = await scenarioFixture(["alpha"], state => {
    state.installPreview = "[]";
    state.hangExecution = true; // the -y execution spawn hangs
  }, 80);
  try {
    const outcome = await fx.actions.runDirect({ kind: "skill-install", source: { type: "scenario", value: "ask-insuremo" }, agent: "universal" });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.receipt.status, "failed");
    assert.deepEqual(outcome.receipt.added, []);
    assert.equal(fx.state.invocations.filter(args => args.includes("add") && !args.includes("-l")).length, 1);
    assert.deepEqual(Object.keys(fx.state.rows).sort(), ["alpha"]);
  } finally {
    await fx.dispose();
  }
});

test("runDirect holds the single-flight lock across the preview phase", async () => {
  const fx = await scenarioFixture(["alpha"], state => {
    state.installPreview = "[]";
    state.hangPreview = true; // the -l preview spawn hangs
  });
  try {
    const first = fx.actions.runDirect({ kind: "skill-install", source: { type: "scenario", value: "ask-insuremo" }, agent: "universal" });
    await new Promise(resolve => setTimeout(resolve, 20));
    const busy = await fx.actions.runDirect({ kind: "skill-update" });
    assert.equal(busy.ok, false);
    if (!busy.ok) assert.equal(busy.error.code, "busy");
    fx.state.releaseAll?.();
    const firstOutcome = await first;
    assert.equal(firstOutcome.ok, true);
    if (firstOutcome.ok) assert.equal(firstOutcome.receipt.status, "completed");
    assert.equal(fx.actions.status().running, false);
    // The lock is released: a follow-up action proceeds normally.
    const next = await fx.actions.runDirect({ kind: "skill-update" });
    assert.equal(next.ok, true);
  } finally {
    await fx.dispose();
  }
});

test("unresolvable npx surfaces the structured tool-unavailable error", async () => {
  const fx = await scenarioFixture(["alpha"], state => { state.npxMissing = true; });
  try {
    const update = await fx.actions.runDirect({ kind: "skill-update" });
    assert.equal(update.ok, false);
    if (!update.ok) assert.equal(update.error.code, "tool-unavailable");
    const install = await fx.actions.runDirect({ kind: "skill-install", source: { type: "scenario", value: "uic-developer" }, agent: "universal" });
    assert.equal(install.ok, false);
    if (!install.ok) assert.equal(install.error.code, "tool-unavailable");
    // Zero ACTION spawn: inventory probing is read-only IMO listing, but the
    // skills-tool binary itself is never resolved or spawned.
    assert.equal(fx.state.invocations.filter(args => args.includes("@insuremo/skills-tool")).length, 0);
  } finally {
    await fx.dispose();
  }
});

test("preview parsing strips ANSI/box decoration and keeps bounded name-only candidates", () => {
  assert.deepEqual(parsePreviewNames(HUMAN_PREVIEW), ["insuremo-auth-cli", "insuremo-deep-search"]);
  assert.deepEqual(parsePreviewNames(JSON.stringify([{ name: "beta" }, { name: "gamma" }])), ["beta", "gamma"]);
  assert.deepEqual(parsePreviewNames(JSON.stringify({ available: ["imo-log", "N0T-VALID"] })), ["imo-log"]);
  assert.deepEqual(parsePreviewNames("Universal 34 skills-tool · found nothing!"), []);
});
