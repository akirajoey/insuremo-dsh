import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import type { SubprocessHandle, SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { IcomposerWriteService } from "../src/service.ts";
import { OperationLogProvider, operationLogDomain } from "../../workbench-operation-log/src/index.ts";
import { readTestArtifact, writeBaseDir } from "../src/artifacts.ts";

const FILE_DIR = "src/dev/Tenant/G/api/SearchPaymentAPI";
const FILE = `${FILE_DIR}/SearchPaymentAPI.groovy`;
const FN_DIR = "src/dev/Tenant/G/function/FnPay";
const FN_FILE = `${FN_DIR}/FnPay.groovy`;
const SERVER_MD5_META = (name: string, md5: string) => JSON.stringify({ api: { Name: name, Md5Value: md5 } });

function reader(text: string): { readFrom(): { text: string; nextOffset: number; lossy: boolean } } {
  return { readFrom() { return { text, nextOffset: 0, lossy: false }; } };
}
function handleFor(stdout: string, exitCode: number): SubprocessHandle {
  let settle!: (o: { exitCode: number | null; signal: string | null }) => void;
  const done = new Promise<{ exitCode: number | null; signal: string | null }>(r => { settle = r; });
  const finish = (): void => settle({ exitCode, signal: null });
  const handle = {
    pid: 9,
    collected: { stdout: reader(stdout), stderr: reader("") },
    done,
    terminate: finish,
    waitForExit: async () => { finish(); return true; },
  } as unknown as SubprocessHandle;
  finish();
  return handle;
}
interface SpawnFacts { argv: readonly string[]; cwd: string }
function fakeSubprocess(over: { stdoutForKey?: Map<string, string>; exitForKey?: Map<string, number> } = {}): SubprocessRuntime & { spawns: SpawnFacts[]; stdoutForKey: Map<string, string> } {
  const io = { stdoutForKey: over.stdoutForKey ?? new Map(), exitForKey: over.exitForKey ?? new Map(), spawns: [] as SpawnFacts[] };
  return {
    spawns: io.spawns,
    stdoutForKey: io.stdoutForKey,
    async resolveExecutable() { return "/opt/homebrew/bin/imo"; },
    spawn(spec: { argv: readonly string[]; cwd: string }) {
      io.spawns.push({ argv: spec.argv, cwd: spec.cwd });
      const key = spec.argv.slice(1).join(" ");
      const stdout = io.stdoutForKey.get(key) ?? "{}";
      const exit = io.exitForKey.get(key) ?? 0;
      return handleFor(stdout, exit);
    },
  } as unknown as SubprocessRuntime & { spawns: SpawnFacts[]; stdoutForKey: Map<string, string> };
}

const stubAuth = {
  prepare: async () => ({
    ok: true,
    value: { use: async (cb: (s: { accessToken: string }) => unknown) => cb({ accessToken: "sekret-token" }) },
  }),
};
function fakeBinding(canonicalPath: string) {
  return { get: async () => ({ ok: true, value: { binding: { authProfile: "portal:demo", environmentId: "env1" }, canonicalPath } }) };
}

interface OpLog { append(...a: unknown[]): Promise<unknown>; list(): unknown[]; decide(...a: unknown[]): Promise<unknown>; recordResult(...a: unknown[]): Promise<unknown> }

const testOutJson = JSON.stringify({
  result: { elapsed_ms: 42, http_status: 200, trace_id: "trace-1", test_url: "https://t/1", saved_at: "2026-01-01T00:00:00Z", payload: { a: 1 }, response: { ok: true } },
});
const releaseDryOut = JSON.stringify({ result: { valid: true, warnings: ["w1"] } });
const releaseApplyOut = JSON.stringify({ result: { valid: true } });
const reposOut = JSON.stringify({ result: { repos: [{ repository_url: "https://git/r1" }, "https://git/r2"] } });
const branchesOut = JSON.stringify({ result: { branches: ["main", "dev"] } });

async function makeFixture(opts: { groovy: string; metaMd5?: string } = { groovy: "class SearchPaymentAPI { def q }" }) {
  const root = await mkdtemp(join(tmpdir(), "w029-"));
  await mkdir(join(root, FILE_DIR), { recursive: true });
  await writeFile(join(root, FILE), opts.groovy, "utf8");
  if (opts.metaMd5 !== undefined) {
    await mkdir(join(root, ".metadata/api"), { recursive: true });
    await writeFile(join(root, ".metadata/api/SearchPaymentAPI.metadata.json"), SERVER_MD5_META("SearchPaymentAPI", opts.metaMd5), "utf8");
  }
  return root;
}

async function harness(opts: { root: string; io?: ReturnType<typeof fakeSubprocess>; dshHome?: string }) {
  const ctx = new Context();
  const io = opts.io ?? fakeSubprocess();
  ctx.provide("subprocess", io as never);
  ctx.provide("imoAuth" as never, stubAuth as never);
  ctx.provide("workspaceBinding", fakeBinding(opts.root) as never);
  const directory = await mkdtemp(join(tmpdir(), "w029-oplog-"));
  const storage = new Storage(ctx);
  const backend = new JsonStorageBackend(directory);
  storage.backend.register("json", backend);
  const storageDomain = new DomainFacility(ctx, { backend: "json" });
  const domain = await storageDomain.open(operationLogDomain);
  const provider = new OperationLogProvider({ emit() {} } as never, domain);
  const unregisterOpLog = ctx.provide("operationLog", provider);
  const opLog = provider as unknown as OpLog;
  const fiber = await ctx.plugin(IcomposerWriteService, { command: "imo", timeoutMs: 5000 });
  await fiber.await();
  const write = ctx.get("icomposerWrite") as unknown as Record<string, (input: unknown, signal?: AbortSignal) => Promise<unknown>>;
  return {
    ctx, io: io as unknown as { spawns: SpawnFacts[]; stdoutForKey: Map<string, string> }, write,
    approve: (id: string) => opLog.decide(id, true, "tester"),
    findOp: (id: string) => opLog.list().find((o: any) => o.id === id),
    dispose: async () => {
      await fiber.dispose();
      unregisterOpLog();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const testExecKey = (name: string) => `icomposer test api --json --profile portal:demo ${name}`;

test("testRun: join-state projection (clean / local-modified / metadata-missing)", async () => {
  // clean: md5 matches
  const { createHash } = await import("node:crypto");
  const cleanMd5 = createHash("md5").update("class SearchPaymentAPI { def q }").digest("hex");
  const rootClean = await makeFixture({ groovy: "class SearchPaymentAPI { def q }", metaMd5: cleanMd5 });
  const h1 = await harness({ root: rootClean });
  try {
    const res: any = await h1.write.testRun({ workspaceId: "ws1", kind: "api", name: "SearchPaymentAPI" });
    assert.equal(res.ok, true);
    assert.equal(res.value.joinState, "clean");
    assert.equal(res.value.overrideUnpushed, false);
    assert.equal(res.value.decision, "pending");
    const op = h1.findOp(res.value.operationId);
    assert.equal(op.kind, "imo-icomposer-test");
  } finally { await h1.dispose(); await rm(rootClean, { recursive: true, force: true }); }

  // local-modified: md5 differs
  const rootMod = await makeFixture({ groovy: "class SearchPaymentAPI { def q2 }", metaMd5: "0".repeat(32) });
  const h2 = await harness({ root: rootMod });
  try {
    const res: any = await h2.write.testRun({ workspaceId: "ws1", kind: "api", name: "SearchPaymentAPI" });
    assert.equal(res.value.joinState, "local-modified");
  } finally { await h2.dispose(); await rm(rootMod, { recursive: true, force: true }); }

  // metadata-missing: local exists, no metadata
  const rootNoMeta = await makeFixture({ groovy: "class SearchPaymentAPI { def q }" });
  const h3 = await harness({ root: rootNoMeta });
  try {
    const res: any = await h3.write.testRun({ workspaceId: "ws1", kind: "api", name: "SearchPaymentAPI" });
    assert.equal(res.value.joinState, "metadata-missing");
  } finally { await h3.dispose(); await rm(rootNoMeta, { recursive: true, force: true }); }
});

test("unpushed guard: local-modified blocks with zero spawn; override runs and receipts the choice", async () => {
  const { createHash } = await import("node:crypto");
  const staleMd5 = createHash("md5").update("old").digest("hex");
  const root = await makeFixture({ groovy: "class SearchPaymentAPI { def NEW }", metaMd5: staleMd5 });
  const io = fakeSubprocess({ stdoutForKey: new Map([[testExecKey("SearchPaymentAPI"), testOutJson]]) });
  const h = await harness({ root, io });
  try {
    const req: any = await h.write.testRun({ workspaceId: "ws1", kind: "api", name: "SearchPaymentAPI" });
    await h.approve(req.value.operationId);
    const blocked: any = await h.write.testExecute(req.value.operationId);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error.code, "local-unpushed-changes");
    assert.equal(h.io.spawns.length, 0);
    // override path
    const req2: any = await h.write.testRun({ workspaceId: "ws1", kind: "api", name: "SearchPaymentAPI", overrideUnpushed: true });
    await h.approve(req2.value.operationId);
    const ran: any = await h.write.testExecute(req2.value.operationId);
    assert.equal(ran.ok, true);
    assert.equal(ran.receipt.status, "completed");
    assert.equal(ran.receipt.overrideUnpushed, true);
    assert.equal(ran.receipt.joinState, "local-modified");
    // argv: test api with name last
    const argv = h.io.spawns[0].argv.slice(1);
    assert.deepEqual(argv, ["icomposer", "test", "api", "--json", "--profile", "portal:demo", "SearchPaymentAPI"]);
    const op = h.findOp(req2.value.operationId);
    assert.equal(op.resultDigest !== undefined, true);
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("testExecute: one-shot journal; retry is already-executed with zero extra spawn", async () => {
  const { createHash } = await import("node:crypto");
  const cleanMd5 = createHash("md5").update("class SearchPaymentAPI { def q }").digest("hex");
  const root = await makeFixture({ groovy: "class SearchPaymentAPI { def q }", metaMd5: cleanMd5 });
  const io = fakeSubprocess({ stdoutForKey: new Map([[testExecKey("SearchPaymentAPI"), testOutJson]]) });
  const h = await harness({ root, io });
  try {
    const req: any = await h.write.testRun({ workspaceId: "ws1", kind: "api", name: "SearchPaymentAPI" });
    await h.approve(req.value.operationId);
    const first: any = await h.write.testExecute(req.value.operationId);
    assert.equal(first.ok, true);
    const retry: any = await h.write.testExecute(req.value.operationId);
    assert.equal(retry.ok, false);
    assert.equal(retry.error.code, "already-executed");
    assert.equal(h.io.spawns.length, 1);
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("test evidence artifact: allowlist fields, readable back, no payload leak", async () => {
  const { createHash } = await import("node:crypto");
  const cleanMd5 = createHash("md5").update("class SearchPaymentAPI { def q }").digest("hex");
  const root = await makeFixture({ groovy: "class SearchPaymentAPI { def q }", metaMd5: cleanMd5 });
  const io = fakeSubprocess({ stdoutForKey: new Map([[testExecKey("SearchPaymentAPI"), testOutJson]]) });
  const dshHome = await mkdtemp(join(tmpdir(), "w029-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  const h = await harness({ root, io });
  try {
    const req: any = await h.write.testRun({ workspaceId: "ws1", kind: "api", name: "SearchPaymentAPI" });
    await h.approve(req.value.operationId);
    const ran: any = await h.write.testExecute(req.value.operationId);
    const artifactPath = ran.receipt.artifactPath;
    assert.ok(artifactPath.startsWith(dshHome));
    assert.ok(artifactPath.includes(`test-${ran.receipt.operationId}.json`));
    const artifact = JSON.parse(await readFile(artifactPath, "utf8"));
    assert.equal(artifact.schemaVersion, 1);
    assert.equal(artifact.evidence.elapsedMs, 42);
    assert.equal(artifact.evidence.httpStatus, 200);
    assert.equal(artifact.evidence.traceId, "trace-1");
    assert.match(artifact.evidence.requestDigest, /^sha256:[0-9a-f]{64}$/);
    assert.match(artifact.evidence.responseDigest, /^sha256:[0-9a-f]{64}$/);
    // no raw payload text anywhere in the artifact or receipt
    const all = JSON.stringify(artifact) + JSON.stringify(ran.receipt);
    assert.equal(all.includes('"a":1'), false);
    assert.equal(all.includes("sekret-token"), false);
    // readable back through the exported helper
    const back = await readTestArtifact(writeBaseDir(root, "ws1"), ran.receipt.operationId);
    assert.notEqual(back, null);
    assert.equal(back!.evidence.traceId, "trace-1");
    // operation record carries the artifact ref
    const op = h.findOp(req.value.operationId);
    assert.deepEqual(op.artifactRefs, [artifactPath]);
  } finally {
    await h.dispose();
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(root, { recursive: true, force: true });
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("releasePreview: exact dry-run argv with repo/branch/message; parse valid+warnings", async () => {
  const root = await makeFixture();
  const key = "icomposer release apply --json --profile portal:demo --type api --name SearchPaymentAPI --repo https://git/r1 --branch main -m release it --dry-run";
  const io = fakeSubprocess({ stdoutForKey: new Map([[key, releaseDryOut]]) });
  const h = await harness({ root, io });
  try {
    const res: any = await h.write.releasePreview({ workspaceId: "ws1", type: "api", name: "SearchPaymentAPI", repo: "https://git/r1", branch: "main", message: "release it" });
    assert.equal(res.ok, true);
    const argv = h.io.spawns[0].argv.slice(1);
    assert.deepEqual(argv, ["icomposer", "release", "apply", "--json", "--profile", "portal:demo", "--type", "api", "--name", "SearchPaymentAPI", "--repo", "https://git/r1", "--branch", "main", "-m", "release it", "--dry-run"]);
    assert.equal(res.value.valid, true);
    assert.deepEqual(res.value.warnings, ["w1"]);
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("releaseApply approval chain: pending → approve → execute full argv; receipt independent from push", async () => {
  const root = await makeFixture();
  const key = "icomposer release apply --json --profile portal:demo --type api --name SearchPaymentAPI --repo https://git/r1 --branch main -m msg one";
  const io = fakeSubprocess({
    stdoutForKey: new Map([
      [key, releaseApplyOut],
      // push-shaped argv (used to prove a push operation cannot execute here)
      ["icomposer push current --json --profile portal:demo src/dev/Tenant/G/api/SearchPaymentAPI/SearchPaymentAPI.groovy", "{}"],
    ]),
  });
  const h = await harness({ root, io });
  try {
    const req: any = await h.write.releaseApply({ workspaceId: "ws1", type: "api", name: "SearchPaymentAPI", repo: "https://git/r1", branch: "main", message: "msg one" });
    assert.equal(req.value.kind, "imo-icomposer-release");
    assert.equal(req.value.decision, "pending");
    // unapproved execute is refused with zero spawn
    const early: any = await h.write.releaseExecute(req.value.operationId);
    assert.equal(early.error.code, "not-approved");
    assert.equal(h.io.spawns.length, 0);
    await h.approve(req.value.operationId);
    const ran: any = await h.write.releaseExecute(req.value.operationId);
    assert.equal(ran.ok, true);
    assert.equal(ran.receipt.status, "completed");
    assert.equal(ran.receipt.kind, "imo-icomposer-release");
    const argv = h.io.spawns[0].argv.slice(1);
    assert.deepEqual(argv, ["icomposer", "release", "apply", "--json", "--profile", "portal:demo", "--type", "api", "--name", "SearchPaymentAPI", "--repo", "https://git/r1", "--branch", "main", "-m", "msg one"]);
    // receipt independence: a release op cannot be push-executed and vice versa
    const wrong: any = await h.write.pushExecute(req.value.operationId);
    assert.equal(wrong.ok, false);
    // make a push op and prove releaseExecute refuses it
    const pushReq: any = await h.write.pushRequest({ workspaceId: "ws1", files: [FILE] });
    await h.approve(pushReq.value.operationId);
    const wrong2: any = await h.write.releaseExecute(pushReq.value.operationId);
    assert.equal(wrong2.ok, false);
    assert.equal(wrong2.error.code === "missing-pending-input" || wrong2.error.code === "operation-params-mismatch", true);
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("validation: data/method/message limits are enforced before any spawn", async () => {
  const root = await makeFixture();
  const h = await harness({ root });
  try {
    const badData: any = await h.write.testRun({ workspaceId: "ws1", kind: "api", name: "SearchPaymentAPI", data: "{not json" });
    assert.equal(badData.error.code, "invalid-data");
    const badMethod: any = await h.write.testRun({ workspaceId: "ws1", kind: "function", name: "FnPay", method: "1bad name" });
    assert.equal(badMethod.error.code, "invalid-method");
    const badName: any = await h.write.testRun({ workspaceId: "ws1", kind: "api", name: "../evil" });
    assert.equal(badName.error.code, "invalid-name");
    const badKind: any = await h.write.testRun({ workspaceId: "ws1", kind: "batch" as never, name: "X" });
    assert.equal(badKind.error.code, "invalid-params");
    const longMessage = "x".repeat(501);
    const badMessage: any = await h.write.releaseApply({ workspaceId: "ws1", type: "api", name: "SearchPaymentAPI", repo: "https://git/r1", branch: "main", message: longMessage });
    assert.equal(badMessage.error.code, "invalid-release-params");
    assert.equal(h.io.spawns.length, 0);
    // good data passes client-side validation
    const okData: any = await h.write.testRun({ workspaceId: "ws1", kind: "api", name: "SearchPaymentAPI", data: '{"q":1}' });
    assert.equal(okData.ok, true);
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("releaseRepos/Branches: read-only list parsing with truncation flag", async () => {
  const root = await makeFixture();
  const reposKey = "icomposer release repo list --json --profile portal:demo";
  const branchesKey = "icomposer release branch list --json --profile portal:demo --repo https://git/r1";
  const io = fakeSubprocess({ stdoutForKey: new Map([[reposKey, reposOut], [branchesKey, branchesOut]]) });
  const h = await harness({ root, io });
  try {
    const repos: any = await h.write.releaseRepos({ workspaceId: "ws1" });
    assert.equal(repos.ok, true);
    assert.deepEqual(repos.value.repos, ["https://git/r1", "https://git/r2"]);
    assert.equal(repos.value.count, 2);
    assert.equal(repos.value.truncated, false);
    const branches: any = await h.write.releaseBranches({ workspaceId: "ws1", repo: "https://git/r1" });
    assert.equal(branches.ok, true);
    assert.deepEqual(branches.value.branches, ["main", "dev"]);
    // invalid repo rejected before spawn
    const bad: any = await h.write.releaseBranches({ workspaceId: "ws1", repo: "bad repo\n" });
    assert.equal(bad.error.code, "invalid-release-params");
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("gates: cancelled signal and disposed service refuse test/release paths", async () => {
  const root = await makeFixture();
  const h = await harness({ root });
  const c = new AbortController();
  c.abort();
  const t1: any = await h.write.testRun({ workspaceId: "ws1", kind: "api", name: "SearchPaymentAPI" }, c.signal);
  assert.equal(t1.error.code, "cancelled");
  const r1: any = await h.write.releasePreview({ workspaceId: "ws1", type: "api", name: "SearchPaymentAPI", repo: "https://git/r1", branch: "main", message: "m" }, c.signal);
  assert.equal(r1.error.code, "cancelled");
  assert.equal(h.io.spawns.length, 0);
  await h.dispose();
  const t2: any = await h.write.testExecute("any");
  assert.equal(t2.error.code, "service-disposed");
  await rm(root, { recursive: true, force: true });
});
