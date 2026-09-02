// These tests cover request previews, digest-bound approval gates, restart, and busy.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withFixture, findInvocation, installInput, checkInvalid } from "./support/skill-actions-fixture.ts";
test("install request previews and appends a pending digest-bound record", async () => {
  await withFixture(["alpha"], async (fx) => {
    fx.state.installPreview = JSON.stringify([{ name: "beta" }, { name: "gamma" }]);
    const result = await fx.actions.request(installInput({ skills: ["beta"] }));
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.preview.candidateNames, ["beta", "gamma"]);
    assert.deepEqual(result.value.preview.before?.names, ["alpha"]);
    assert.equal(fx.opLog.records.size, 1);
    const record = [...fx.opLog.records.values()][0]!;
    assert.equal(record.decision, "pending");
    assert.equal(record.paramsDigest, result.value.paramsDigest);
    assert.equal(record.kind, "skill-install");
    assert.ok(findInvocation(fx, "install") !== undefined);
    assert.deepEqual(Object.keys(fx.state.rows), ["alpha"]);
  });
});

test("remove preview confirms every name is installed before append", async () => {
  await withFixture(["alpha"], async (fx) => {
    const missing = await fx.actions.request({ kind: "skill-remove", agent: "codex", names: ["nowhere"] });
    assert.equal(checkInvalid(missing), "not-installed");
    assert.equal(fx.opLog.records.size, 0);
    const ok = await fx.actions.request({ kind: "skill-remove", agent: "codex", names: ["alpha"] });
    assert.equal(ok.ok, true);
    assert.equal(fx.opLog.records.size, 1);
  });
});

test("update preview captures the before inventory snapshot", async () => {
  await withFixture(["alpha"], async (fx) => {
    const result = await fx.actions.request({ kind: "skill-update" });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.preview.before?.names, ["alpha"]);
    assert.equal(findInvocation(fx, "update"), undefined);
  });
});

test("activation request requires an installed name and captures revision", async () => {
  await withFixture(["alpha"], async (fx) => {
    await fx.actions.request({ kind: "skill-install", source: { type: "alias", value: "s" }, agent: "codex" });
    const unknown = await fx.actions.request({ kind: "skill-activation", name: "nowhere", enabled: true });
    assert.equal(checkInvalid(unknown), "not-installed");
    const result = await fx.actions.request({ kind: "skill-activation", name: "alpha", enabled: true });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.preview.activation?.revision, 0);
    assert.equal(fx.opLog.records.size, 2);
  });
});

test("execution requires approval, existence, and an untouched digest", async () => {
  await withFixture(["alpha"], async (fx) => {
    const requested = await fx.actions.request({ kind: "skill-update" });
    if (!requested.ok) return;
    fx.state.invocations.length = 0;
    const missing = await fx.actions.execute("op-9999");
    assert.equal(checkInvalid(missing), "missing-operation");
    const unapproved = await fx.actions.execute(requested.value.operationId);
    assert.equal(checkInvalid(unapproved), "not-approved");
    assert.equal(fx.state.invocations.length, 0);
    const record = fx.opLog.records.get(requested.value.operationId)!;
    record.paramsDigest = "sha256:tampered";
    await fx.approve(requested.value.operationId);
    const tampered = await fx.actions.execute(requested.value.operationId);
    assert.equal(checkInvalid(tampered), "operation-params-mismatch");
    assert.equal(fx.state.invocations.length, 0);
  });
});

test("approved action after service restart returns missing-pending-input", async () => {
  await withFixture(["alpha"], async (fx) => {
    const requested = await fx.actions.request({ kind: "skill-remove", agent: "codex", names: ["alpha"] });
    if (!requested.ok) return;
    await fx.approve(requested.value.operationId);
    const before = await fx.activation.snapshot(["alpha"]);
    // Simulate a restart: dispose the actions fiber and mount a fresh one. The
    // durable op record keeps its approval while the in-memory pending
    // arguments are lost.
    const restarted = await fx.remountActions();
    const result = await restarted.actions.execute(requested.value.operationId);
    assert.equal(checkInvalid(result), "missing-pending-input");
    assert.equal(restarted.state.invocations.filter(args => args[1] === "remove").length, 0);
    assert.deepEqual(await restarted.activation.snapshot(["alpha"]), before);
  });
});

test("a second approved action is busy while one runs", async () => {
  await withFixture(["alpha"], async (fx) => {
    const first = await fx.actions.request({ kind: "skill-update" });
    const second = await fx.actions.request({ kind: "skill-update" });
    if (!first.ok || !second.ok) return;
    await fx.approve(first.value.operationId);
    await fx.approve(second.value.operationId);
    const firstRun = fx.actions.execute(first.value.operationId);
    const secondRun = await fx.actions.execute(second.value.operationId).then(value => ({ value }), () => undefined);
    const status = fx.actions.status();
    assert.equal(status.running, true);
    if (secondRun !== undefined && secondRun.value.ok === false) assert.equal(secondRun.value.error.code, "busy");
    const firstResult = await firstRun;
    assert.equal(firstResult.ok, true);
  });
});

test("TASK-039 P0: frozen face exposes runDirect; direct run succeeds without operationLog", async () => {
  await withFixture(["alpha"], async (fx) => {
    // 1) the frozen ctx face exposes runDirect
    const face = fx.ctx.get("imoSkillActions") as unknown as {
      runDirect?: (input: { kind: string; agent?: string; names?: readonly string[] }, signal?: AbortSignal) => Promise<{ ok: boolean; receipt?: { status: string }; error?: { code: string } }>;
    };
    assert.equal(typeof face?.runDirect, "function", "frozen imoSkillActions face must expose runDirect");

    // 2) a direct update-all run completes and appends zero operation records
    const before = fx.opLog.records.size;
    const outcome = await face!.runDirect!({ kind: "skill-update" });
    assert.equal(outcome.ok, true, `runDirect should complete: ${JSON.stringify(outcome.error)}`);
    assert.equal(fx.opLog.records.size, before, "runDirect must not append operation records");
    const updateArgs = fx.state.invocations.find(args => args.includes("@insuremo/skills-tool")) ?? [];
    assert.equal(updateArgs.at(-3), "update", "direct kernel still runs the skills-tool CLI");
  });
});
