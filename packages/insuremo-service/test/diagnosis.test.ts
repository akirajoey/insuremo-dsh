// TASK-083: last-failure diagnosis capture — store semantics, redaction,
// stream clipping, scratch-path resolution, runCaptureDetailed raw exposure
// (and runCapture's digest-only strip), and the IMO install kernel capture.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { ImoInstallService, IMO_PACKAGE } from "../src/imo-install.ts";
import { ImoCliService } from "../src/index.ts";
import {
  failureDiagnosis, FailureDiagnosisStore, redactSecrets, clipDiagnosisStream, scratchDirectory,
} from "../src/diagnosis.ts";
import { runCapture, runCaptureDetailed } from "../src/run.ts";
import { fakeHandle, fakeOperationLog, fakeSubprocess, makeFakeIo, upgradeFixture, approveAndRun } from "./support/fake-subprocess.ts";

test("store keeps only the last failure per kind and success clears exactly that kind", () => {
  const store = new FailureDiagnosisStore();
  store.record({
    kind: "imo-cli", operation: "imo-install", commands: ["npm install -g @insuremo/imo"], exitCode: 1,
    streams: { stdout: "first-stdout", stderr: "first-stderr", stdoutLossy: false, stderrLossy: false },
  });
  store.record({
    kind: "skill", operation: "skill-update", commands: ["npx @insuremo/skills-tool update"], exitCode: 2,
    streams: { stdout: "", stderr: "skill-failure", stdoutLossy: false, stderrLossy: false },
  });
  assert.equal(store.snapshot("imo-cli")?.stdout, "first-stdout");
  assert.equal(store.snapshot("skill")?.stderr, "skill-failure");

  // A second failure of the same kind replaces (never appends).
  store.record({
    kind: "imo-cli", operation: "imo-install", commands: ["npm install -g @insuremo/imo"], exitCode: 7,
    streams: { stdout: "second", stderr: "", stdoutLossy: false, stderrLossy: false },
  });
  assert.equal(store.snapshot("imo-cli")?.exitCode, 7);
  assert.equal(store.snapshot("imo-cli")?.stdout, "second");

  // Success clears only its own kind's slot.
  store.clear("skill");
  assert.equal(store.snapshot("skill"), undefined);
  assert.equal(store.snapshot("imo-cli")?.exitCode, 7);
  store.reset();
  assert.equal(store.snapshot("imo-cli"), undefined);
});

test("redaction strips npm auth values, bearer headers, URL userinfo, and token shapes", () => {
  const redacted = redactSecrets([
    "npm config set //registry.npmjs.org/:_authToken=abc123def456",
    "_auth=c2VjcmV0dmFsdWU=",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
    "request GET https://user:hunter2@public.insuremo.com/artifactory/api/npm/npm/imo",
    "token ghp_0123456789abcdefghij0123456789abcd",
  ].join("\n"));
  assert.match(redacted, /_auth=\*\*\*/);
  assert.doesNotMatch(redacted, /abc123def456/);
  assert.doesNotMatch(redacted, /c2VjcmV0dmFsdWU=/);
  assert.match(redacted, /Bearer \*\*\*/);
  assert.doesNotMatch(redacted, /eyJhbGciOiJIUzI1NiJ9/);
  assert.match(redacted, /https:\/\/\*\*\*:\*\*\*@public\.insuremo\.com/);
  assert.doesNotMatch(redacted, /hunter2/);
  assert.match(redacted, /token \*\*\*/);
  assert.doesNotMatch(redacted, /ghp_0123456789/);
  // Readable context survives.
  assert.match(redacted, /request GET https/);
});

test("a failed IMO upgrade captures its run; a successful upgrade clears it (direct + approval kernels)", async () => {
  failureDiagnosis.reset();
  // Direct kernel (the Settings upgrade button path).
  const failing = await upgradeFixture(makeFakeIo({ upgradeExitCode: 1 }));
  try {
    const result = await failing.upgrade.executeDirect(undefined);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.status, "failed");
    const diagnosis = failureDiagnosis.snapshot("imo-cli");
    assert.ok(diagnosis !== undefined);
    assert.equal(diagnosis.operation, "imo-upgrade");
    assert.equal(diagnosis.exitCode, 1);
    assert.deepEqual(diagnosis.commands, ["imo upgrade --yes"]);
    assert.ok(diagnosis.stderr.includes("upgrade failed"));
    // The receipt stays digest-only.
    assert.match(result.receipt.stderrDigest, /^sha256:/);
    assert.equal(JSON.stringify(result.receipt).includes("upgrade failed"), false);
  } finally {
    await failing.dispose();
  }

  // Approval kernel records under the same operation label.
  const approval = await upgradeFixture(makeFakeIo({ upgradeExitCode: 1 }));
  try {
    const request = await approval.upgrade.requestUpgrade();
    const decided = await approval.opLog.api.decide?.(request.operationId, true, "operator", "test");
    void decided;
    const result = await approval.upgrade.executeUpgrade(request.operationId);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.status, "failed");
    assert.equal(failureDiagnosis.snapshot("imo-cli")?.operation, "imo-upgrade");
  } finally {
    await approval.dispose();
  }

  // A successful upgrade clears the slot (both kernels settle completed).
  const succeeding = await upgradeFixture(makeFakeIo());
  try {
    const result = await succeeding.upgrade.executeDirect(undefined);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.status, "completed");
    assert.equal(failureDiagnosis.snapshot("imo-cli"), undefined);
    const approved = await approveAndRun(succeeding);
    assert.equal(approved.result.ok, true);
    assert.equal(failureDiagnosis.snapshot("imo-cli"), undefined);
  } finally {
    await succeeding.dispose();
    failureDiagnosis.reset();
  }
});

test("streams are clipped at the 256KB budget with an explicit truncation marker", () => {
  const small = clipDiagnosisStream("tiny");
  assert.deepEqual(small, { text: "tiny", truncated: false });
  const big = "x".repeat(256 * 1024 + 4_096);
  const clipped = clipDiagnosisStream(big);
  assert.equal(clipped.truncated, true);
  const marker = "\n[...output truncated]\n";
  assert.equal(clipped.text.length, 256 * 1024 + marker.length);
  assert.ok(clipped.text.endsWith(marker));
});

test("scratchDirectory resolves $DSH_HOME/scratch with the ~/.dsh default", () => {
  const underHome = scratchDirectory({ DSH_HOME: "/tmp/dsh-home-a" });
  assert.equal(underHome, resolve("/tmp/dsh-home-a", "scratch"));
  const blank = scratchDirectory({ DSH_HOME: "   " });
  assert.ok(blank.endsWith(join(".dsh", "scratch")));
  assert.equal(scratchDirectory({}), scratchDirectory({ DSH_HOME: "" }));
});

test("runCaptureDetailed exposes a failed run's raw streams while runCapture stays digest-only", async () => {
  const fake = fakeSubprocess(makeFakeIo());
  fake.spawn = (spec) => fakeHandle({ stdout: "raw stdout canary", stderr: "raw stderr canary", exitCode: 1 }, spec.signal) as never;
  const detailed = await runCaptureDetailed(fake, { command: "npm", args: ["install", "-g", IMO_PACKAGE], timeoutMs: 100 });
  assert.equal(detailed.ok, false);
  if (!detailed.ok) {
    assert.equal(detailed.error.code, "non-zero-exit");
    assert.match(detailed.error.stderrDigest, /^sha256:/);
    // Raw detail rides BESIDE the failure, never inside the digest-only error.
    assert.equal("detail" in detailed.error, false);
  }
  assert.equal(detailed.detail?.stdout, "raw stdout canary");
  assert.equal(detailed.detail?.stderr, "raw stderr canary");
  assert.equal(detailed.detail?.stdoutLossy, false);

  const plain = await runCapture(fake, { command: "npm", args: ["install", "-g", IMO_PACKAGE], timeoutMs: 100 });
  assert.equal(plain.ok, false);
  assert.equal("detail" in plain, false);
  assert.equal(JSON.stringify(plain).includes("raw stdout canary"), false);
});

test("a failed IMO install captures full output; a successful install clears it", async () => {
  failureDiagnosis.reset();
  const failing = await installFixture({ missingCommands: ["imo"], installExitCode: 1 });
  try {
    const result = await failing.install.install();
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.status, "failed");
    const diagnosis = failureDiagnosis.snapshot("imo-cli");
    assert.ok(diagnosis !== undefined);
    assert.equal(diagnosis.operation, "imo-install");
    assert.equal(diagnosis.exitCode, 1);
    assert.equal(diagnosis.packageManager, "npm");
    assert.ok(diagnosis.registry !== undefined && diagnosis.registry.startsWith("https://"));
    assert.deepEqual(diagnosis.commands, [
      "npm config set @insuremo:registry <registry>",
      "npm install -g @insuremo/imo",
    ]);
    // The captured streams carry the fake's raw stderr text (never digests).
    assert.ok(diagnosis.stderr.includes("install failed"));
    // The receipt itself stays digest-only.
    assert.match(result.receipt.steps[1]?.stderrDigest ?? "", /^sha256:/);
    assert.equal(JSON.stringify(result.receipt).includes("install failed"), false);

    // A successful install of the same kind clears the slot.
    const succeeding = await installFixture({ missingCommands: ["imo"] });
    try {
      const ok = await succeeding.install.install();
      assert.equal(ok.ok, true);
      if (!ok.ok) return;
      assert.equal(ok.receipt.status, "completed");
      assert.equal(failureDiagnosis.snapshot("imo-cli"), undefined);
    } finally {
      await succeeding.dispose();
    }
  } finally {
    await failing.dispose();
    failureDiagnosis.reset();
  }
});

test("the scratch directory materializes against a real temp DSH_HOME", async () => {
  const home = await mkdtemp(join(tmpdir(), "dsh-diagnosis-"));
  try {
    const scratch = scratchDirectory({ DSH_HOME: home });
    assert.equal(scratch, join(home, "scratch"));
    await mkdir(scratch, { recursive: true });
    await stat(scratch);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

async function installFixture(overrides: Parameters<typeof makeFakeIo>[0] = {}, config: { installTimeoutMs?: number } = {}) {
  const io = makeFakeIo(overrides);
  const ctx = new Context();
  const fake = fakeSubprocess(io);
  const opLog = fakeOperationLog();
  ctx.provide("subprocess", fake as never);
  ctx.provide("operationLog", opLog.api as never);
  const cliFiber = ctx.plugin(ImoCliService, { command: "imo", timeoutMs: 5_000 });
  await cliFiber.await();
  const installFiber = ctx.plugin(ImoInstallService, config);
  await installFiber.await();
  const install = ctx.get("imoInstall");
  if (install === undefined) throw new Error("imoInstall service was not provided");
  return {
    install,
    io,
    opLog,
    ctx,
    dispose: async () => {
      await installFiber.dispose();
      await cliFiber.dispose();
    },
  };
}
