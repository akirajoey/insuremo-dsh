// These tests exercise approved mutations, activation CAS, failures, receipt/event, and the catalog.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withFixture, findInvocation, installInput, checkInvalid, openFixture } from "./support/skill-actions-fixture.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import { InsuremoSkillProvider } from "../src/skill-provider.ts";
import { digest } from "../src/run.ts";
import { SKILL_ACTION_COMPLETED_EVENT, SKILL_ACTION_FAILED_EVENT } from "../src/index.ts";
test("approved install mutates the store but keeps the new skill disabled", async () => {
  await withFixture(["alpha"], async (fx) => {
    fx.state.installPreview = JSON.stringify([{ name: "beta" }]);
    const requested = await fx.actions.request(installInput({ skills: ["beta"] }));
    if (!requested.ok) return;
    await fx.approve(requested.value.operationId);
    const result = await fx.actions.execute(requested.value.operationId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.status, "completed");
    assert.deepEqual(result.receipt.added, ["beta"]);
    assert.deepEqual(result.receipt.removed, []);
    assert.equal(result.receipt.catalogInvalidated, true);
    assert.deepEqual(Object.keys(fx.state.rows).sort(), ["alpha", "beta"]);
    const state = await fx.activation.snapshot(["alpha", "beta"]);
    assert.deepEqual(state.enabled, ["alpha"]);
    assert.deepEqual(state.disabled, ["beta"]);
    const exec = fx.state.invocations.find(args => args.includes("-y"));
    assert.ok(exec !== undefined);
    assert.ok(fx.state.invocations.some(args => args.includes("--list")));
  });
});

test("approved remove reconciles stale enabled names and reports removal", async () => {
  await withFixture(["alpha"], async (fx) => {
    const requested = await fx.actions.request({ kind: "skill-remove", agent: "codex", names: ["alpha"] });
    if (!requested.ok) return;
    await fx.approve(requested.value.operationId);
    const result = await fx.actions.execute(requested.value.operationId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.receipt.removed, ["alpha"]);
    assert.equal(result.receipt.catalogInvalidated, true);
    assert.deepEqual(Object.keys(fx.state.rows), []);
    const args = findInvocation(fx, "remove") ?? [];
    assert.deepEqual(args.slice(2, 4), ["alpha", "-g"]);
    assert.equal(args.includes("--all"), false);
    assert.equal(args.includes("-y"), true);
  });
});

test("approved update reports same-path digest changes and preserves enablement", async () => {
  await withFixture(["alpha"], async (fx) => {
    const requested = await fx.actions.request({ kind: "skill-update" });
    if (!requested.ok) return;
    await fx.approve(requested.value.operationId);
    const result = await fx.actions.execute(requested.value.operationId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.receipt.updated, ["alpha"]);
    assert.deepEqual(result.receipt.added, []);
    assert.deepEqual(result.receipt.removed, []);
    assert.equal(result.receipt.catalogInvalidated, true);
    assert.equal(fx.state.invocations.some(args => args.join(" ") === "skills update --all"), true);
    const state = await fx.activation.snapshot(["alpha"]);
    assert.deepEqual(state.enabled, ["alpha"]);
  });
});

test("activation disable then enable flips enabled state with a CAS revision", async () => {
  await withFixture(["alpha"], async (fx) => {
    const disable = await fx.actions.request({ kind: "skill-activation", name: "alpha", enabled: false });
    if (!disable.ok) return;
    await fx.approve(disable.value.operationId);
    const disabled = await fx.actions.execute(disable.value.operationId);
    assert.equal(disabled.ok, true);
    if (!disabled.ok) return;
    assert.equal(disabled.receipt.activationBeforeRevision, 0);
    assert.equal(disabled.receipt.activationAfterRevision, 1);
    assert.equal(disabled.receipt.catalogInvalidated, true);
    const enable = await fx.actions.request({ kind: "skill-activation", name: "alpha", enabled: true });
    if (!enable.ok) return;
    await fx.approve(enable.value.operationId);
    const enabled = await fx.actions.execute(enable.value.operationId);
    assert.equal(enabled.ok, true);
    if (!enabled.ok) return;
    assert.equal(enabled.receipt.activationBeforeRevision, 1);
    assert.equal(enabled.receipt.activationAfterRevision, 2);
    const state = await fx.activation.snapshot(["alpha"]);
    assert.deepEqual(state.enabled, ["alpha"]);
  });
});

test("activation CAS revision conflict finalizes a failed receipt without mutation", async () => {
  await withFixture(["alpha", "beta"], async (fx) => {
    // Disable beta first: the store becomes initialized at revision 1.
    const first = await fx.actions.request({ kind: "skill-activation", name: "beta", enabled: false });
    if (!first.ok) return;
    await fx.approve(first.value.operationId);
    await fx.actions.execute(first.value.operationId);
    // Request a second action against the now-revision-1 store...
    const requested = await fx.actions.request({ kind: "skill-activation", name: "alpha", enabled: false });
    if (!requested.ok) return;
    assert.equal(requested.value.preview.activation?.revision, 1);
    await fx.approve(requested.value.operationId);
    // ...and run a competing activation before it executes, bumping the revision to 2.
    const competing = await fx.actions.request({ kind: "skill-activation", name: "beta", enabled: true });
    if (!competing.ok) return;
    await fx.approve(competing.value.operationId);
    await fx.actions.execute(competing.value.operationId);
    const before = await fx.activation.snapshot(["alpha", "beta"]);
    const result = await fx.actions.execute(requested.value.operationId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.status, "failed");
    assert.equal(result.receipt.catalogInvalidated, false);
    const after = await fx.activation.snapshot(["alpha", "beta"]);
    assert.deepEqual(after, before);
  });
});

test("forced install failure recovers inventory then is a one-shot failed receipt", async () => {
  await withFixture(["alpha", "beta", "gamma"], async (fx) => {
    fx.state.installPreview = JSON.stringify([{ name: "beta" }]);
    const requested = await fx.actions.request(installInput({ skills: ["beta"] }));
    if (!requested.ok) return;
    await fx.approve(requested.value.operationId);
    await fx.activation.ensureInitialized(["alpha", "beta", "gamma"]);
    const stateBefore = await fx.activation.snapshot(["alpha", "beta", "gamma"]);
    fx.state.mutationError = { exitCode: 1, stderr: "install failed" };
    const first = await fx.actions.execute(requested.value.operationId);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.receipt.status, "failed");
    assert.equal(first.receipt.catalogInvalidated, true);
    assert.deepEqual(first.receipt.added, []);
    // No rerun: the durable record already carries the one-shot failure.
    const second = await fx.actions.execute(requested.value.operationId);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, "already-executed");
    const stateAfter = await fx.activation.snapshot(["alpha", "beta", "gamma"]);
    assert.deepEqual(stateAfter, stateBefore);
  });
});

test("401 and 403 failures expose only fixed hints", async () => {
  await withFixture(["alpha"], async (fx) => {
    for (const [stderr, hint] of [["401 unauthorized", "login-required"], ["403 forbidden", "permission-denied"]] as const) {
      const requested = await fx.actions.request({ kind: "skill-update" });
      if (!requested.ok) return;
      await fx.approve(requested.value.operationId);
      fx.state.mutationError = { exitCode: 1, stderr };
      const result = await fx.actions.execute(requested.value.operationId);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.receipt.status, "failed");
      assert.equal(result.receipt.hint, undefined);
      assert.equal(result.hint, hint);
      assert.equal(result.receipt.catalogInvalidated, true);
    }
  });
});

test("receipt and event expose only allowlisted fields", async () => {
  await withFixture(["alpha"], async (fx) => {
    const events: unknown[] = [];
    const completed: unknown[] = [];
    const removeEvent = fx.ctx.on(SKILL_ACTION_COMPLETED_EVENT, payload => { completed.push(payload); events.push(payload); });
    const removeFail = fx.ctx.on(SKILL_ACTION_FAILED_EVENT, payload => { events.push(payload); });
    try {
      fx.state.installPreview = JSON.stringify([{ name: "beta" }]);
      const requested = await fx.actions.request(installInput({ source: { type: "git", url: "https://github.com/org/repo.git?token=SECRET#frag" }, skills: ["beta"] }));
      if (!requested.ok) return;
      await fx.approve(requested.value.operationId);
      const result = await fx.actions.execute(requested.value.operationId);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      const receiptText = JSON.stringify(result.receipt);
      assert.equal(receiptText.includes("SECRET"), false);
      assert.equal(receiptText.includes("token="), false);
      assert.equal(receiptText.includes("repo.git"), false);
      assert.equal(receiptText.includes("/org/repo"), false);
      assert.equal(receiptText.includes("SKILL.md"), false);
      assert.equal(receiptText.includes("/.agents/"), false);
      assert.equal(result.receipt.sourceKind, "https-git");
      assert.equal(result.receipt.sourceHost, "github.com");
      assert.match(result.receipt.sourceDigest ?? "", /^sha256:[0-9a-f]{64}$/);
      assert.equal(completed.length, 1);
      const event = completed[0] as {
        operationId?: string; kind?: string; status?: string; resultDigest?: string;
        names?: unknown; sourceKind?: string; sourceHost?: string; sourceDigest?: string;
      };
      assert.equal(event.names, undefined);
      assert.deepEqual(Object.keys(event).sort(), ["kind", "operationId", "resultDigest", "sourceDigest", "sourceHost", "sourceKind", "status"]);
      assert.equal(JSON.stringify(event).includes("SECRET"), false);
      assert.equal(JSON.stringify(event).includes("repo.git"), false);
      assert.equal(events.length, 1);
    } finally {
      removeEvent();
      removeFail();
    }
  });
});

test("root skill-actions face exposes request, execute, runDirect, and status", async () => {
  await withFixture([], async (fx) => {
    const face = fx.ctx.get<Record<string, unknown>>("imoSkillActions");
    assert.equal(Object.isFrozen(face), true);
    assert.deepEqual(Reflect.ownKeys(face ?? {}).map(String).sort(), ["execute", "request", "runDirect", "status"]);
    const state = fx.ctx.get<ImoSkillActivation>("imoSkillActivation");
    assert.equal(typeof state?.ensureInitialized, "function");
  });
});

test("recordResult failure parks the receipt and a retry only writes evidence", async () => {
  await withFixture(["alpha"], async (fx) => {
    fx.state.installPreview = JSON.stringify([{ name: "beta" }]);
    const requested = await fx.actions.request(installInput({ skills: ["beta"] }));
    if (!requested.ok) return;
    await fx.approve(requested.value.operationId);
    fx.opLog.failResultTimes = 1;
    const events: unknown[] = [];
    const remove = fx.ctx.on(SKILL_ACTION_COMPLETED_EVENT, payload => events.push(payload));
    try {
      const first = await fx.actions.execute(requested.value.operationId);
      assert.equal(first.ok, true);
      if (!first.ok) return;
      assert.equal(first.evidencePending, true);
      assert.equal(first.receipt.status, "completed");
      assert.equal(fx.state.invocations.filter(a => a[1] === "install" && !a.includes("--list")).length, 1);
      // Retry: zero spawn, zero controller, zero invalidate — evidence only.
      const invocationCount = fx.state.invocations.length;
      const second = await fx.actions.execute(requested.value.operationId);
      assert.equal(second.ok, true);
      if (!second.ok) return;
      assert.equal(second.ok && second.evidencePending, undefined);
      assert.equal(second.ok && second.receipt === first.receipt, true);
      assert.equal(fx.state.invocations.length, invocationCount);
      assert.equal(events.length, 1);
      assert.notEqual(fx.opLog.records.get(requested.value.operationId)?.resultDigest, undefined);
    } finally { remove(); }
  });
});

test("downstream after-snapshot failure still invalidates and never reruns", async () => {
  await withFixture(["alpha"], async (fx) => {
    fx.state.installPreview = JSON.stringify([{ name: "beta" }]);
    const requested = await fx.actions.request(installInput({ skills: ["beta"] }));
    if (!requested.ok) return;
    await fx.approve(requested.value.operationId);
    fx.state.failNextList = true; // break only the recovery after-snapshot read
    const first = await fx.actions.execute(requested.value.operationId);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.receipt.status, "completed");
    assert.equal(first.receipt.catalogInvalidated, true);
    assert.deepEqual(Object.keys(fx.state.rows).sort(), ["alpha", "beta"]);
    const state = await fx.activation.snapshot(["alpha", "beta"]);
    assert.deepEqual(state.enabled, ["alpha"]);
    const mutationRuns = fx.state.invocations.filter(a => a[1] === "install" && !a.includes("--list")).length;
    const second = await fx.actions.execute(requested.value.operationId);
    assert.equal(second.ok, false);
    if (!second.ok) assert.equal(second.error.code, "already-executed");
    assert.equal(fx.state.invocations.filter(a => a[1] === "install" && !a.includes("--list")).length, mutationRuns);
  });
});

test("canonical install provenance strips userinfo query and fragment from the digest source", async () => {
  await withFixture([], async (fx) => {
    fx.state.installPreview = JSON.stringify([{ name: "beta" }]);
    const requested = await fx.actions.request(installInput({ source: { type: "git", url: "https://user:SECRETPASS@github.com/org/repo.git?token=TOKEN123#frag" }, skills: ["beta"] }));
    if (!requested.ok) return;
    await fx.approve(requested.value.operationId);
    const result = await fx.actions.execute(requested.value.operationId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.sourceKind, "https-git");
    assert.equal(result.receipt.sourceHost, "github.com");
    assert.equal(result.receipt.sourceDigest, digest("https-git:https://github.com/org/repo.git"));
    const text = JSON.stringify(result.receipt);
    assert.equal(text.includes("SECRETPASS"), false);
    assert.equal(text.includes("TOKEN123"), false);
    assert.equal(text.includes("user:"), false);
  });
});

test("catalog integration: install keeps a new skill invisible until enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-skill-actions-catalog-"));
  const storageRoot = await mkdtemp(join(tmpdir(), "imo-skill-actions-catalog-store-"));
  const fx = await openFixture(root, storageRoot, ["alpha"]);
  const registryFiber = (fx.ctx as unknown as { plugin(plugin: unknown, config?: unknown): { await(): Promise<unknown>; dispose(): Promise<void> } }).plugin(SkillRegistry, {});
  await registryFiber.await();
  const registry = fx.ctx.get("skills") as { list(): Promise<readonly { name: string }[]>; registerProvider(factory: (control: { signal: AbortSignal; invalidate(): void }) => unknown): () => void };
  const unregister = registry.registerProvider(control => new InsuremoSkillProvider(fx.ctx, control as never, fx.skills, "global", fx.activation));
  try {
    assert.deepEqual((await registry.list()).map(item => item.name), ["alpha"]);
    fx.state.installPreview = JSON.stringify([{ name: "beta" }]);
    const requested = await fx.actions.request(installInput({ skills: ["beta"] }));
    if (!requested.ok) return;
    await fx.approve(requested.value.operationId);
    await fx.actions.execute(requested.value.operationId);
    assert.deepEqual((await registry.list()).map(item => item.name), ["alpha"]);
    const enable = await fx.actions.request({ kind: "skill-activation", name: "beta", enabled: true });
    if (!enable.ok) return;
    await fx.approve(enable.value.operationId);
    await fx.actions.execute(enable.value.operationId);
    assert.deepEqual((await registry.list()).map(item => item.name).sort(), ["alpha", "beta"]);
  } finally {
    unregister();
    await registryFiber.dispose();
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
});
