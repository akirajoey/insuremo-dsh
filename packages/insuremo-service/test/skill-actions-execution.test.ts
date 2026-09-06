// These tests exercise approved mutations, activation CAS, failures, receipt/event, and the catalog.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withFixture, findInvocation, installInput, checkInvalid, openFixture } from "./support/skill-actions-fixture.ts";
import http from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import { InsuremoSkillProvider } from "../src/skill-provider.ts";
import { mountWriteRoutes } from "../src/overview/write-routes.ts";
import { digest } from "../src/run.ts";
import { failureDiagnosis } from "../src/diagnosis.ts";
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
    const updateArgs = fx.state.invocations.find(args => args.includes("@insuremo/skills-tool")) ?? [];
    assert.equal(updateArgs.at(-3), "update", "update runs via the skills-tool adapter");
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

test("TASK-085: a failed install dry-run preview captures the diagnosis (direct + approval), without executing", async () => {
  failureDiagnosis.reset();
  await withFixture(["alpha"], async (fx) => {
    // Offline-style dry-run failure: the preview spawn itself exits non-zero.
    fx.state.previewError = { exitCode: 1, stderr: "npm ERR! network _authToken=leaky-preview fetch failed" };
    const rowsBefore = Object.keys(fx.state.rows).sort();

    // Direct kernel (the Settings scenario button): the preview failure must
    // capture the real dry-run argv and redacted output for the UI hand-off.
    const direct = await fx.actions.runDirect(installInput({ source: { type: "scenario", scenario: "ask-insuremo" }, agent: "universal" }));
    assert.equal(direct.ok, false);
    if (!direct.ok) assert.equal(direct.error.code, "non-zero-exit");
    const diagnosis = failureDiagnosis.snapshot("skill");
    assert.ok(diagnosis !== undefined, "preview failure must capture a diagnosis");
    assert.equal(diagnosis.operation, "skill-install:scenario/ask-insuremo");
    assert.equal(diagnosis.exitCode, 1);
    // commands carry the REAL dry-run argv (the -l preview form; the execute
    // form swaps -l for a trailing -y).
    assert.equal(diagnosis.commands.length, 1);
    assert.match(diagnosis.commands[0] ?? "", /-l\b/);
    assert.ok(diagnosis.stderr.includes("fetch failed"));
    assert.ok(diagnosis.stderr.includes("_auth=***"));
    assert.ok(!diagnosis.stderr.includes("leaky-preview"));
    // No formal execution happened: rows untouched, no non-preview install argv.
    assert.deepEqual(Object.keys(fx.state.rows).sort(), rowsBefore);
    const executeForms = fx.state.invocations.filter(args => args.includes("@insuremo/skills-tool") && !args.includes("-l"));
    assert.deepEqual(executeForms, []);

    // The error envelope the action route maps stays digest-only.
    assert.match(String(direct.error.stdoutDigest ?? ""), /^sha256:/);
    assert.equal(JSON.stringify(direct).includes("fetch failed"), false);
  });

  // Approval entry: the same preview failure surfaces at request() time and
  // is captured under the same operation label.
  await withFixture(["alpha"], async (fx) => {
    fx.state.previewError = { exitCode: 1, stderr: "preview network down" };
    const requested = await fx.actions.request(installInput({ source: { type: "scenario", scenario: "ask-insuremo" }, agent: "universal" }));
    assert.equal(requested.ok, false);
    if (!requested.ok) assert.equal(requested.error.code, "non-zero-exit");
    const diagnosis = failureDiagnosis.snapshot("skill");
    assert.ok(diagnosis !== undefined, "approval-path preview failure must capture too");
    assert.equal(diagnosis.operation, "skill-install:scenario/ask-insuremo");
    assert.ok(diagnosis.stderr.includes("preview network down"));
    // No operation record was appended for the failed request.
    assert.equal(fx.opLog.records.size, 0);
  });
  failureDiagnosis.reset();
});

test("TASK-085: remove/activation never record a diagnosis", async () => {
  failureDiagnosis.reset();
  await withFixture(["alpha"], async (fx) => {
    // A failing remove execution mutates nothing and records nothing.
    fx.state.mutationError = { exitCode: 1, stderr: "remove failed" };
    const remove = await fx.actions.runDirect({ kind: "skill-remove", agent: "codex", names: ["alpha"] });
    assert.equal(remove.ok, true);
    if (!remove.ok) return;
    assert.equal(remove.receipt.status, "failed");
    assert.equal(failureDiagnosis.snapshot("skill"), undefined);
    // Activation failures are not diagnosis-worthy either.
    const activation = await fx.actions.runDirect({ kind: "skill-activation", name: "missing", enabled: true });
    assert.equal(activation.ok, false);
    assert.equal(failureDiagnosis.snapshot("skill"), undefined);
  });
  failureDiagnosis.reset();
});

test("TASK-085: an unresolvable preview tool is diagnosable (structured reason, empty streams, no execution)", async () => {
  failureDiagnosis.reset();
  await withFixture(["alpha"], async (fx) => {
    fx.state.npxMissing = true;
    const rowsBefore = Object.keys(fx.state.rows).sort();
    const direct = await fx.actions.runDirect(installInput({ source: { type: "scenario", scenario: "ask-insuremo" }, agent: "universal" }));
    assert.equal(direct.ok, false);
    if (!direct.ok) assert.equal(direct.error.code, "tool-unavailable");
    const diagnosis = failureDiagnosis.snapshot("skill");
    assert.ok(diagnosis !== undefined, "the failed button must have a diagnosis to show");
    assert.equal(diagnosis.operation, "skill-install:scenario/ask-insuremo");
    assert.deepEqual(diagnosis.commands, [
      "npx -y --registry=https://public.insuremo.com/artifactory/api/npm/npm/ @insuremo/skills-tool add insuremo-skills -g -a universal -s ask-insuremo -l --skip-update-check",
    ]);
    // Nothing executed: null exit code, empty streams, structured reason.
    assert.equal(diagnosis.exitCode, null);
    assert.equal(diagnosis.stdout, "");
    assert.equal(diagnosis.stderr, "");
    assert.deepEqual(diagnosis.error, { code: "tool-unavailable", message: "npx is unavailable; install Node.js/npm to sync Skills" });
    assert.deepEqual(Object.keys(fx.state.rows).sort(), rowsBefore);
  });
  failureDiagnosis.reset();
});

test("TASK-085: update-tool-missing is diagnosable on both kernels (execution-stage early return)", async () => {
  failureDiagnosis.reset();
  // Direct kernel: update's preview is local (no spawn), so the missing tool
  // only surfaces at the execution step — the early return must have recorded.
  await withFixture(["alpha"], async (fx) => {
    fx.state.npxMissing = true;
    const result = await fx.actions.runDirect({ kind: "skill-update" });
    assert.equal(result.ok, false, "the structured tool error is an execution failure envelope");
    if (!result.ok) assert.equal(result.error.code, "tool-unavailable");
    const diagnosis = failureDiagnosis.snapshot("skill");
    assert.ok(diagnosis !== undefined, "update execution-stage tool-missing must capture");
    assert.equal(diagnosis.operation, "skill-update");
    assert.equal(diagnosis.exitCode, null);
    assert.equal(diagnosis.stdout, "");
    assert.equal(diagnosis.stderr, "");
    assert.deepEqual(diagnosis.error, { code: "tool-unavailable", message: "npx is unavailable; install Node.js/npm to sync Skills" });
  });

  // Approval kernel: the preview-less request succeeds, the approved execution
  // hits the missing tool, and the diagnosis is still recorded.
  await withFixture(["alpha"], async (fx) => {
    const requested = await fx.actions.request({ kind: "skill-update" });
    assert.equal(requested.ok, true);
    if (!requested.ok) return;
    await fx.approve(requested.value.operationId);
    fx.state.npxMissing = true; // the tool disappears after the request
    const result = await fx.actions.execute(requested.value.operationId);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "tool-unavailable");
    const diagnosis = failureDiagnosis.snapshot("skill");
    assert.ok(diagnosis !== undefined, "approval execution-stage tool-missing must capture");
    assert.equal(diagnosis.operation, "skill-update");
    assert.deepEqual(diagnosis.error, { code: "tool-unavailable", message: "npx is unavailable; install Node.js/npm to sync Skills" });
  });
  failureDiagnosis.reset();
});

test("TASK-085 E2E (same process): real runDirect preview failure → real imo-diagnosis route over real HTTP", async () => {
  failureDiagnosis.reset();
  const home = await mkdtemp(join(tmpdir(), "dsh-diag-chain-"));
  const originalHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  // The route handlers mount into the fixture's own context: the service and
  // the write bridge share the ONE failureDiagnosis singleton and the ONE
  // subprocess/scripted world — no test double on the store or the route.
  await withFixture(["alpha"], async (fx) => {
    const routes = new Map();
    const httpServer = http.createServer((req, res) => {
      const path = (req.url ?? "").split("?")[0];
      const route = routes.get(path);
      if (route === undefined) { res.statusCode = 404; res.end(); return; }
      route.handler(req, res);
    });
    await new Promise(resolve => httpServer.listen(0, "127.0.0.1", resolve));
    const port = httpServer.address().port;
    fx.ctx.provide("webServer", {
      register: route => { routes.set(route.path, route); return () => routes.delete(route.path); },
    } as never);
    mountWriteRoutes(fx.ctx as never);
    const url = `http://127.0.0.1:${port}/api/icomposer-workbench/insuremo/overview/actions/imo-diagnosis`;
    const post = () => fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Workbench-Action": "1",
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ kind: "skill" }),
 });
    try {
      // No failure yet: the real wire answers an explicit no.
      const empty = await post();
      assert.equal(empty.status, 200);
      assert.deepEqual(await empty.json(), { ok: true, result: { available: false } });

      // The offline preview failure through the REAL service kernel...
      fx.state.previewError = { exitCode: 1, stderr: "npm ERR! network _authToken=wire-leak fetch failed" };
      const direct = await fx.actions.runDirect(installInput({ source: { type: "scenario", scenario: "ask-insuremo" }, agent: "universal" }));
      assert.equal(direct.ok, false);

      // ...and the REAL HTTP route reads the same store: available with the
      // captured dry-run argv, redacted output, and a created scratch dir.
      const response = await post();
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.ok, true);
      assert.equal(payload.result.available, true);
      assert.equal(payload.result.diagnosis.operation, "skill-install:scenario/ask-insuremo");
      assert.match(payload.result.diagnosis.commands[0], /-l --skip-update-check/);
      assert.ok(payload.result.diagnosis.stderr.includes("fetch failed"));
      assert.ok(payload.result.diagnosis.stderr.includes("_auth=***"));
      assert.ok(!payload.result.diagnosis.stderr.includes("wire-leak"));
      assert.equal(payload.result.diagnosis.error.code, "non-zero-exit");
      assert.equal(payload.result.scratchCwd, join(home, "scratch"));
      await assert.doesNotReject(() => stat(join(home, "scratch")));
    } finally {
      await new Promise(resolve => httpServer.close(resolve));
    }
  });
  if (originalHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalHome;
  failureDiagnosis.reset();
  await rm(home, { recursive: true, force: true });
});

test("TASK-083: a failed skills-tool run captures redacted raw output; success clears the slot", async () => {
  failureDiagnosis.reset();
  await withFixture(["alpha"], async (fx) => {
    const requested = await fx.actions.request({ kind: "skill-update" });
    if (!requested.ok) return;
    await fx.approve(requested.value.operationId);
    fx.state.mutationError = { exitCode: 1, stderr: "npm ERR! _authToken=leaky-token network timeout" };
    const result = await fx.actions.execute(requested.value.operationId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.status, "failed");
    // Receipt stays digest-only.
    assert.match(result.receipt.stderrDigest, /^sha256:/);
    assert.equal(result.receipt.stderrDigest.includes("leaky-token"), false);

    const diagnosis = failureDiagnosis.snapshot("skill");
    assert.ok(diagnosis !== undefined);
    assert.equal(diagnosis.operation, "skill-update");
    assert.equal(diagnosis.exitCode, 1);
    assert.match(diagnosis.commands[0] ?? "", /@insuremo\/skills-tool/);
    assert.ok(diagnosis.stderr.includes("network timeout"));
    assert.ok(diagnosis.stderr.includes("_auth=***"));
    assert.ok(!diagnosis.stderr.includes("leaky-token"));

    // A successful update clears the same slot.
    const retry = await fx.actions.request({ kind: "skill-update" });
    if (!retry.ok) return;
    await fx.approve(retry.value.operationId);
    const ok = await fx.actions.execute(retry.value.operationId);
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.equal(ok.receipt.status, "completed");
    assert.equal(failureDiagnosis.snapshot("skill"), undefined);
  });
  failureDiagnosis.reset();
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
    // TASK-043 (B): the disabled-but-installed skill appears as a non-invocable
    // insuremo mask instead of vanishing (it must shadow same-name filesystem
    // entries in the aggregated catalog).
    const afterInstall = await registry.list() as ReadonlyArray<{ name: string; provider?: string; invocation?: { modelInvocable?: boolean } }>;
    assert.deepEqual(afterInstall.map(item => item.name).sort(), ["alpha", "beta"]);
    const betaMask = afterInstall.find(item => item.name === "beta");
    assert.equal(betaMask?.provider, "insuremo");
    assert.equal(betaMask?.invocation?.modelInvocable, false);
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
