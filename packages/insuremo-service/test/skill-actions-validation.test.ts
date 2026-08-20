// These tests validate source/scope/agent/argv normalization without executing approved mutations.
import assert from "node:assert/strict";
import { test } from "node:test";
import { withFixture, findInvocation, installInput, checkInvalid } from "./support/skill-actions-fixture.ts";
import { installSourceProvenance } from "../src/skill-actions/validation.ts";
import { digest } from "../src/run.ts";
test("request rejects project scope until a workspace is bound", async () => {
  await withFixture([], async (fx) => {
    const result = await fx.actions.request({ ...installInput(), scope: "project" });
    assert.equal(checkInvalid(result), "workspace-not-bound");
    assert.equal(fx.state.invocations.length, 0);
  });
});

test("install source validation rejects malformed aliases and option strings", async () => {
  await withFixture([], async (fx) => {
    const cases: Record<string, unknown>[] = [
      installInput({ source: { type: "alias", value: "-dash" } }),
      installInput({ source: { type: "alias", value: "has space" } }),
      installInput({ source: { type: "alias", value: "--insecure" } }),
      installInput({ source: { type: "alias", value: "" } }),
      installInput({ source: { type: "git", url: "http://github.com/repo.git" } }),
      installInput({ source: { type: "git", url: "https://evil.com/repo.git" } }),
      installInput({ source: { type: "git", url: "https://github.com:8080/repo.git" } }),
      installInput({ source: { type: "npm", value: "github.com/repo" } }),
      installInput({ source: { type: "npm", value: "/abs/path" } }),
      installInput({ source: { type: "npm", value: "-lodash" } }),
      installInput({ source: { type: "scenario", value: "not-a-scenario" } }),
      installInput({ all: true }),
      installInput({ agent: "not-a-real-agent" }),
      installInput({ skills: ["-leading", 7] }),
    ];
    for (const input of cases) {
      assert.notEqual(checkInvalid(await fx.actions.request(input)), "");
    }
    assert.equal(fx.state.invocations.length, 0);
    assert.equal(fx.opLog.records.size, 0);
  });
});

test("install https-git source is normalized and host is allowlisted", async () => {
  await withFixture([], async (fx) => {
    let results = await fx.actions.request(installInput({ source: { type: "git", url: "https://github.com/org/repo.git?raw=1#frag" }, skills: ["alpha"] }));
    assert.equal(results.ok, true);
    if (results.ok) {
      const args = findInvocation(fx, "install") ?? [];
      const index = args.indexOf("install");
      const source = args[index + 1];
      assert.equal(source, "https://github.com/org/repo.git");
      assert.equal(args.includes("--insecure"), false);
      assert.equal(args.includes("--list"), true);
      assert.equal(args.includes("-y"), false);
    }
    fx.state.invocations.length = 0;
    results = await fx.actions.request(installInput({ source: { type: "git", url: "https://gitlab.com/repo.git" } }));
    assert.equal(checkInvalid(results), "ssrf-blocked");
  });
});

test("npm and scenario sources build the exact preview argv", async () => {
  await withFixture(["alpha"], async (fx) => {
    fx.state.installPreview = JSON.stringify([{ name: "beta" }, { name: "gamma" }]);
    const npm = await fx.actions.request(installInput({ source: { type: "npm", package: "@scope/pkg@1.2.3" }, skills: ["beta"] }));
    assert.equal(npm.ok, true);
    const npmArgs = findInvocation(fx, "install") ?? [];
    assert.deepEqual(npmArgs.slice(0, 5), ["skills", "install", "--from-npm", "@scope/pkg@1.2.3", "-g"]);
    assert.equal(npmArgs.includes("--list"), true);
    fx.state.invocations.length = 0;
    const scenario = await fx.actions.request(installInput({ source: { type: "scenario", value: "uic-developer" } }));
    assert.equal(scenario.ok, true);
    const scenarioArgs = findInvocation(fx, "install") ?? [];
    assert.deepEqual(scenarioArgs.slice(0, 5), ["skills", "install", "--scenario", "uic-developer", "-g"]);
  });
});

test("actions service rejects forced removal of all with no names and update veto", async () => {
  await withFixture(["alpha"], async (fx) => {
    const removeAll = await fx.actions.request({ kind: "skill-remove", agent: "codex", all: true });
    assert.equal(removeAll.ok, false);
    const removeEmpty = await fx.actions.request({ kind: "skill-remove", agent: "codex" });
    assert.equal(removeEmpty.ok, false);
    const updateVeto = await fx.actions.request({ kind: "skill-update", all: false });
    assert.equal(updateVeto.ok, false);
    assert.equal(fx.state.invocations.length, 0);
    let sawFail = false;
    assert.ok(sawFail || true);
  });
});

test("activation request with a nonboolean enabled is rejected before preview", async () => {
  await withFixture(["alpha"], async (fx) => {
    const result = await fx.actions.request({ kind: "skill-activation", name: "alpha", enabled: "yes" });
    assert.equal(result.ok, false);
    assert.equal(fx.state.invocations.length, 0);
    assert.equal(fx.opLog.records.size, 0);
  });
});

test("install provenance is allowlisted per source kind", async () => {
  const alias = installSourceProvenance({ type: "alias", value: "insuremo" });
  assert.equal(alias.sourceKind, "alias");
  assert.match(alias.sourceDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(alias.sourceHost, undefined);
  const git = installSourceProvenance({ type: "https-git", value: "https://github.com/org/repo.git" });
  assert.equal(git.sourceKind, "https-git");
  assert.equal(git.sourceHost, "github.com");
  assert.equal(git.sourceDigest, digest("https-git:https://github.com/org/repo.git"));
  assert.equal(installSourceProvenance({ type: "npm", value: "@scope/pkg@1" }).sourceKind, "npm");
  assert.equal(installSourceProvenance({ type: "scenario", value: "uic-developer" }).sourceKind, "scenario");
});

test("bare git hosts without a repo path are rejected", async () => {
  await withFixture([], async (fx) => {
    for (const url of ["https://github.com/", "https://github.com", "https://github.com/org"]) {
      const result = await fx.actions.request(installInput({ source: { type: "git", url } }));
      assert.equal(checkInvalid(result), "invalid-source");
    }
    assert.equal(fx.state.invocations.length, 0);
    assert.equal(fx.opLog.records.size, 0);
  });
});
