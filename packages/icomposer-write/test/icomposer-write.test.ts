import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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

const validEnv = "env1";
const FILE = "src/dev/Tenant/G/api/Api1/Api1.groovy";
const FILE2 = "src/dev/Tenant/G/api/Api2/Api2.groovy";

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

const previewOK = JSON.stringify({ base_url: "x", result: { requestpath: "/g/api", name: "Api1", remote_version: "rv-1", warnings: [], would_compile: true } });
const executeOK = JSON.stringify({ base_url: "x", result: { requestpath: "/g/api", name: "Api1", remote_version: "rv-2", remote_saved: true, conflicts: [] } });
const conflictOut = JSON.stringify({ base_url: "x", result: { requestpath: "/g/api", name: "Api1", conflict: true, conflicts: [{ file: FILE, },], action: "conflict-needs-strategy" } });

function stubAuth(mode = "ok") {
  return {
    prepare: async () => {
      if (mode !== "ok") return { ok: false, error: { code: mode } };
      return { ok: true, value: { use: async (cb: (s: { accessToken: string }) => unknown) => cb({ accessToken: "sekret-token" }) } };
    },
  };
}
function fakeBinding(mode: "bound" | "unbound" | "not-found", canonicalPath: string) {
  return {
    get: async () => {
      if (mode === "not-found") return { ok: false, error: { code: "workspace-not-found" } };
      if (mode === "unbound") return { ok: true, value: { binding: null, canonicalPath } };
      return { ok: true, value: { binding: { authProfile: "portal:demo", environmentId: validEnv }, canonicalPath } };
    },
  };
}

interface OpLog { append(...a: unknown[]): Promise<unknown>; list(): unknown[]; decide(...a: unknown[]): Promise<unknown>; recordResult(...a: unknown[]): Promise<unknown> }

async function harness(opts: { root?: string; io?: ReturnType<typeof fakeSubprocess>; authMode?: string; bindingMode?: "bound" | "unbound" | "not-found" } = {}) {
  const ctx = new Context();
  const root = opts.root ?? await mkdtemp(join(tmpdir(), "write-root-"));
  const io = opts.io ?? fakeSubprocess();
  ctx.provide("subprocess", io as never);
  ctx.provide("imoAuth" as never, stubAuth(opts.authMode ?? "ok") as never);
  ctx.provide("workspaceBinding", fakeBinding(opts.bindingMode ?? "bound", root) as never);

  const directory = await mkdtemp(join(tmpdir(), "write-oplog-"));
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
  const write = ctx.get("icomposerWrite") as unknown as {
    pushPreview(input: unknown, signal?: AbortSignal): Promise<unknown>;
    pushRequest(input: unknown, signal?: AbortSignal): Promise<unknown>;
    pushExecute(id: string, signal?: AbortSignal): Promise<unknown>;
    pushResolve(input: unknown, signal?: AbortSignal): Promise<unknown>;
    pushStatus(id: string): Promise<unknown>;
  };
  return {
    ctx, io: io as unknown as { spawns: SpawnFacts[]; stdoutForKey: Map<string, string> },
    root, write,
    opLog: {
      approve: (id: string, by = "tester") => opLog.decide(id, true, by),
    },
    findOp: (id: string) => opLog.list().find((o: any) => o.id === id),
    dispose: async () => {
      await fiber.dispose();
      unregisterOpLog();
      if (opts.root === undefined) await rm(root, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const previewKey = `icomposer push current --json --profile portal:demo --dry-run ${FILE}`;
const executeKey = `icomposer push current --json --profile portal:demo ${FILE}`;
const batchPreviewKey = `icomposer push batch ${FILE} ${FILE2} --json --profile portal:demo --dry-run`;
const resolveKey = `icomposer push current --json --profile portal:demo --prefer-local ${FILE}`;

test("pushPreview: exact dry-run argv (no prefer), allowlist projection, localVersion digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "write-pv-"));
  await mkdir(join(root, "src/dev/Tenant/G/api/Api1"), { recursive: true });
  await writeFile(join(root, FILE), "class Api1 { def x }", "utf8");
  const io = fakeSubprocess({ stdoutForKey: new Map([[previewKey, previewOK]]) });
  const h = await harness({ root, io });
  try {
    const res: any = await h.write.pushPreview({ workspaceId: "ws1", files: [FILE] });
    assert.equal(res.ok, true);
    const argv = h.io.spawns[0].argv.slice(1);
    assert.deepEqual(argv, ["icomposer", "push", "current", "--json", "--profile", "portal:demo", "--dry-run", FILE]);
    assert.equal(h.io.spawns[0].cwd, root);
    // allowlist projection
    const v = res.value;
    assert.equal(v.mode, "current");
    assert.equal(v.files[0].file, FILE);
    assert.equal(v.files[0].target, "/g/api");
    assert.equal(v.files[0].serverVersion, "rv-1");
    assert.equal(v.files[0].conflict, false);
    assert.match(v.files[0].localVersion, /^sha256:[0-9a-f]{64}$/);
    assert.equal(typeof v.stdoutDigest, "string");
    // no secret / no raw leak
    assert.equal(JSON.stringify(v).includes("sekret-token"), false);
  } finally { await h.dispose(); }
});

test("pushPreview: file validation rejects traversal/absolute/non-groovy with zero spawn", async () => {
  const h = await harness({});
  try {
    for (const bad of ["../x.groovy", "/abs/x.groovy", "a/b.txt", "src/x.GROOVY", ""]) {
      const res: any = await h.write.pushPreview({ workspaceId: "ws1", files: [bad] });
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.error.code, "invalid-file-path");
    }
    assert.equal(h.io.spawns.length, 0);
    const empty: any = await h.write.pushPreview({ workspaceId: "ws1", files: [] });
    assert.equal(empty.ok, false);
    assert.equal(empty.error.code, "invalid-file-path");
  } finally { await h.dispose(); }
});

test("pushRequest: pending operation appended with hashed paramsDigest + embedded preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "write-rq-"));
  await mkdir(join(root, "src/dev/Tenant/G/api/Api1"), { recursive: true });
  await writeFile(join(root, FILE), "class Api1 { def x }", "utf8");
  const io = fakeSubprocess({ stdoutForKey: new Map([[previewKey, previewOK]]) });
  const h = await harness({ root, io });
  try {
    const res: any = await h.write.pushRequest({ workspaceId: "ws1", files: [FILE] });
    assert.equal(res.ok, true);
    const v = res.value;
    assert.equal(v.kind, "imo-icomposer-push");
    assert.equal(v.decision, "pending");
    assert.match(v.paramsDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(v.files[0], FILE);
    assert.equal(v.preview.mode, "current");
    const op = h.findOp(v.operationId);
    assert.equal(op.kind, "imo-icomposer-push");
    assert.equal(op.paramsDigest, v.paramsDigest);
    assert.equal(op.decision, "pending");
  } finally { await h.dispose(); }
});

test("pushExecute: unapproved → not-approved with zero spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "write-unapr-"));
  await mkdir(join(root, "src/dev/Tenant/G/api/Api1"), { recursive: true });
  await writeFile(join(root, FILE), "class Api1 { def x }", "utf8");
  const io = fakeSubprocess({ stdoutForKey: new Map([[previewKey, previewOK]]) });
  const h = await harness({ root, io });
  try {
    const req: any = await h.write.pushRequest({ workspaceId: "ws1", files: [FILE] });
    const res: any = await h.write.pushExecute(req.value.operationId);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "not-approved");
    assert.equal(h.io.spawns.length, 1); // only the preview spawned
  } finally { await h.dispose(); }
});

test("pushExecute: approved runs once; retry is already-executed with zero extra spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "write-run-"));
  await mkdir(join(root, "src/dev/Tenant/G/api/Api1"), { recursive: true });
  await writeFile(join(root, FILE), "class Api1 { def x }", "utf8");
  const io = fakeSubprocess({ stdoutForKey: new Map([[previewKey, previewOK], [executeKey, executeOK]]) });
  const h = await harness({ root, io });
  try {
    const req: any = await h.write.pushRequest({ workspaceId: "ws1", files: [FILE] });
    await h.opLog.approve(req.value.operationId);
    const res: any = await h.write.pushExecute(req.value.operationId);
    assert.equal(res.ok, true);
    assert.equal(res.receipt.status, "completed");
    assert.equal(res.receipt.mode, "current");
    // retry: no re-spawn
    const retry: any = await h.write.pushExecute(req.value.operationId);
    assert.equal(retry.ok, false);
    assert.equal(retry.error.code, "already-executed");
    assert.equal(h.io.spawns.length, 2); // preview + one execution
    const op = h.findOp(req.value.operationId);
    assert.equal(op.resultDigest !== undefined, true);
    assert.equal(op.decision, "approved");
  } finally { await h.dispose(); }
});

test("conflict flow: CLI conflict → status conflict, resolve cancel → rejected resolve op, prefer-local → approval → argv contains --prefer-local", async () => {
  const root = await mkdtemp(join(tmpdir(), "write-cf-"));
  await mkdir(join(root, "src/dev/Tenant/G/api/Api1"), { recursive: true });
  await writeFile(join(root, FILE), "class Api1 { def x }", "utf8");
  const io = fakeSubprocess({ stdoutForKey: new Map([
    [previewKey, previewOK],
    [executeKey, conflictOut],
    [resolveKey, executeOK],
  ]) });
  const h = await harness({ root, io });
  try {
    const req: any = await h.write.pushRequest({ workspaceId: "ws1", files: [FILE] });
    const id = req.value.operationId;
    await h.opLog.approve(id);
    const ex: any = await h.write.pushExecute(id);
    assert.equal(ex.receipt.status, "conflict");
    assert.ok(ex.receipt.conflictFiles.includes(FILE));
    // resolve cancel → rejected resolve op (decision chain receipted)
    const cancel: any = await h.write.pushResolve({ operationId: id, choice: "cancel", by: "alice" });
    assert.equal(cancel.ok, true);
    assert.equal(cancel.value.decision, "rejected");
    assert.equal(cancel.value.choice, "cancel");
    assert.equal(cancel.value.originalOperationId, id);
    const cancelOp = h.findOp(cancel.value.operationId);
    assert.equal(cancelOp.kind, "imo-icomposer-push-resolve");
    assert.equal(cancelOp.decision, "rejected");
    assert.equal(cancelOp.reason, "cancel");
    const st: any = await h.write.pushStatus(id);
    assert.equal(st.ok, true);
    assert.equal(st.value.status, "conflict");
    assert.deepEqual(st.value.conflictFiles, [FILE]);
  } finally { await h.dispose(); }
});

test("resolve prefer-local: new pending resolve op → approve → execute argv contains --prefer-local", async () => {
  const root = await mkdtemp(join(tmpdir(), "write-pr-"));
  await mkdir(join(root, "src/dev/Tenant/G/api/Api1"), { recursive: true });
  await writeFile(join(root, FILE), "class Api1 { def x }", "utf8");
  const io = fakeSubprocess({ stdoutForKey: new Map([
    [previewKey, previewOK],
    [executeKey, conflictOut],
    [resolveKey, executeOK],
  ]) });
  const h = await harness({ root, io });
  try {
    const req: any = await h.write.pushRequest({ workspaceId: "ws1", files: [FILE] });
    const id = req.value.operationId;
    await h.opLog.approve(id);
    const ex: any = await h.write.pushExecute(id);
    assert.equal(ex.receipt.status, "conflict");
    const resolve: any = await h.write.pushResolve({ operationId: id, choice: "prefer-local", by: "bob" });
    assert.equal(resolve.ok, true);
    assert.equal(resolve.value.decision, "pending");
    assert.equal(resolve.value.choice, "prefer-local");
    const rid = resolve.value.operationId;
    const rop = h.findOp(rid);
    assert.equal(rop.kind, "imo-icomposer-push-resolve");
    assert.match(rop.paramsDigest, /^sha256:[0-9a-f]{64}$/);
    // approval then execution carries prefer flag
    await h.opLog.approve(rid);
    const rex: any = await h.write.pushExecute(rid);
    assert.equal(rex.ok, true);
    assert.equal(rex.receipt.status, "completed");
    const execArgv = h.io.spawns[h.io.spawns.length - 1].argv;
    assert.ok(execArgv.includes("--prefer-local"));
    assert.equal(execArgv.includes("--prefer-server"), false);
    const rst: any = await h.write.pushStatus(rid);
    assert.equal(rst.value.status, "completed");
  } finally { await h.dispose(); }
});

test("batch: files preserve order in argv; auth invalid → invalid-auth with zero execute spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "write-bt-"));
  await mkdir(join(root, "src/dev/Tenant/G/api/Api1"), { recursive: true });
  await mkdir(join(root, "src/dev/Tenant/G/api/Api2"), { recursive: true });
  await writeFile(join(root, FILE), "class Api1 { def x }", "utf8");
  await writeFile(join(root, FILE2), "class Api2 { def x }", "utf8");
  const batch = JSON.stringify({ base_url: "x", result: { total: 2, execution_order: [FILE, FILE2], successes: [FILE, FILE2], failures: [] } });
  const io = fakeSubprocess({ stdoutForKey: new Map([[batchPreviewKey, batch], ["", ""]]) });
  const h = await harness({ root, io });
  try {
    const res: any = await h.write.pushRequest({ workspaceId: "ws1", files: [FILE, FILE2], batch: true });
    assert.equal(res.ok, true);
    const argv = h.io.spawns[0].argv.slice(1);
    assert.deepEqual(argv.slice(0, 5), ["icomposer", "push", "batch", FILE, FILE2]);
    assert.equal(argv.includes("--dry-run"), true);
    assert.equal(h.io.spawns[0].cwd, root);
    assert.equal(res.value.mode, "batch");
  } finally { await h.dispose(); }

  // auth invalid: execute rejected without spawn
  const io2 = fakeSubprocess();
  const h2 = await harness({ io: io2, authMode: "invalid-auth" });
  try {
    const req: any = await h2.write.pushRequest({ workspaceId: "ws1", files: [FILE2] });
    assert.equal(req.ok, false);
    assert.equal(req.error.code, "invalid-auth");
    assert.equal(h2.io.spawns.length, 0);
  } finally { await h2.dispose(); }
});

test("cancel signal and dispose: abort before spawn → cancelled; disposed → service-disposed", async () => {
  const h = await harness({});
  try {
    const c = new AbortController();
    c.abort();
    const res: any = await h.write.pushPreview({ workspaceId: "ws1", files: [FILE] }, c.signal);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "cancelled");
    assert.equal(h.io.spawns.length, 0);
  } finally { await h.dispose(); }
  const res2: any = await h.write.pushPreview({ workspaceId: "ws1", files: [FILE] });
  assert.equal(res2.ok, false);
  assert.equal(res2.error.code, "service-disposed");
});

test("digest-only: conflict receipt never echoes stdout text, only digests + allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "write-do-"));
  await mkdir(join(root, "src/dev/Tenant/G/api/Api1"), { recursive: true });
  await writeFile(join(root, FILE), "class Api1 { def x }", "utf8");
  const io = fakeSubprocess({ stdoutForKey: new Map([[previewKey, previewOK], [executeKey, conflictOut]]) });
  const h = await harness({ root, io });
  try {
    const req: any = await h.write.pushRequest({ workspaceId: "ws1", files: [FILE] });
    await h.opLog.approve(req.value.operationId);
    const ex: any = await h.write.pushExecute(req.value.operationId);
    const serialized = JSON.stringify(ex);
    assert.equal(serialized.includes("conflict-needs-strategy"), false);
    assert.equal(serialized.includes("sekret-token"), false);
    assert.equal(serialized.includes("conflict"), true); // only the allowlisted boolean/list
    assert.match(ex.receipt.stdoutDigest, /^sha256:/);
  } finally { await h.dispose(); }
});
