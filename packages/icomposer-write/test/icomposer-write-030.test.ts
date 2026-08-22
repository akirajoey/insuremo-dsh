import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
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

const FILE_DIR = "src/dev/Tenant/G/api/SearchPaymentAPI";
const FILE = `${FILE_DIR}/SearchPaymentAPI.groovy`;

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
function fakeSubprocess(over: { stdoutForKey?: Map<string, string> } = {}): SubprocessRuntime & { spawns: SpawnFacts[] } {
  const spawns: SpawnFacts[] = [];
  const stdoutForKey = over.stdoutForKey ?? new Map();
  return {
    spawns,
    async resolveExecutable() { return "/opt/homebrew/bin/imo"; },
    spawn(spec: { argv: readonly string[]; cwd: string }) {
      spawns.push({ argv: spec.argv, cwd: spec.cwd });
      const key = spec.argv.slice(1).join(" ");
      const stdout = stdoutForKey.get(key) ?? "{}";
      return handleFor(stdout, 0);
    },
  } as unknown as SubprocessRuntime & { spawns: SpawnFacts[] };
}

const stubAuth = {
  prepare: async () => ({
    ok: true,
    value: { use: async (cb: (s: { accessToken: string }) => unknown) => cb({ accessToken: "sekret-token" }) },
  }),
};

const optionsApiJson = JSON.stringify({
  kind: "api",
  status: [{ code: 1, label: "Active", canonical_input: "active" }],
  func_scope: [],
  request_method: [{ code: 1, label: "Get", canonical_input: "get" }, { code: 2, label: "Post", canonical_input: "post" }],
  request_type: [{ code: 0, label: "None", allowed_methods: ["GET"], canonical_input: "none" }],
  response_type: [{ code: 1, label: "Map", canonical_input: "map" }],
});
const optionsFnJson = JSON.stringify({
  kind: "function",
  status: [{ code: 1, label: "Active", canonical_input: "active" }],
  func_scope: [{ code: 0, label: "Private", canonical_input: "private" }, { code: 1, label: "Public", canonical_input: "public" }],
  request_method: [],
  request_type: [],
  response_type: [],
});
const okPlan = JSON.stringify({ result: { valid: true, warnings: [] } });
const okCreate = JSON.stringify({ result: { valid: true, remote_saved: true } });
const okMeta = JSON.stringify({ result: { valid: true, updated_fields: ["Description"] } });

const API_PARAMS = {
  name: "NewThingAPI", moduleId: "100", groupId: "200", status: "active",
  requestMethod: "post", requestType: "json", responseType: "map",
  path: "/newthing", description: "a thing", requestModelId: "300", responseModelId: "400",
  sse: true, integration: "core",
};
const FN_PARAMS = { name: "NewFnService", moduleId: "100", groupId: "200", status: "active", funcScope: "public", description: "fn" };

async function harness(opts: { root: string; io?: ReturnType<typeof fakeSubprocess>; catalogEntries?: Array<{ name: string; type: string }> } ) {
  const ctx = new Context();
  const io = opts.io ?? fakeSubprocess();
  ctx.provide("subprocess", io as never);
  ctx.provide("imoAuth" as never, stubAuth as never);
  ctx.provide("workspaceBinding", { get: async () => ({ ok: true, value: { binding: { authProfile: "portal:demo", environmentId: "env1" }, canonicalPath: opts.root } }) } as never);
  if (opts.catalogEntries !== undefined) {
    ctx.provide("icomposerCatalog" as never, {
      listAssets: async () => ({ ok: true, value: { entries: opts.catalogEntries! } }),
    } as never);
  }
  const directory = await mkdtemp(join(tmpdir(), "w030-oplog-"));
  const storage = new Storage(ctx);
  const backend = new JsonStorageBackend(directory);
  storage.backend.register("json", backend);
  const storageDomain = new DomainFacility(ctx, { backend: "json" });
  const domain = await storageDomain.open(operationLogDomain);
  const provider = new OperationLogProvider({ emit() {} } as never, domain);
  const unregisterOpLog = ctx.provide("operationLog", provider);
  const opLog = provider as unknown as { list(): any[]; decide(...a: unknown[]): Promise<unknown> };
  const fiber = await ctx.plugin(IcomposerWriteService, { command: "imo", timeoutMs: 5000 });
  await fiber.await();
  const write = ctx.get("icomposerWrite") as unknown as Record<string, (input: unknown, signal?: AbortSignal) => Promise<unknown>>;
  return {
    ctx, io: io as unknown as { spawns: SpawnFacts[] }, write,
    approve: (id: string) => opLog.decide(id, true, "tester"),
    findOp: (id: string) => opLog.list().find((o: any) => o.id === id),
    dispose: async () => {
      await fiber.dispose();
      unregisterOpLog();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("createOptions: live option vocabularies parse with allowlist caps (api + function shapes)", async () => {
  const root = await mkdtemp(join(tmpdir(), "w030-co-"));
  const io = fakeSubprocess({
    stdoutForKey: new Map([
      ["icomposer create options api --json --profile portal:demo", optionsApiJson],
      ["icomposer create options function --json --profile portal:demo", optionsFnJson],
    ]),
  });
  const h = await harness({ root, io });
  try {
    const api: any = await h.write.createOptions({ workspaceId: "ws1", kind: "api" });
    assert.equal(api.ok, true);
    assert.deepEqual(api.value.status, [{ code: 1, label: "Active", canonicalInput: "active" }]);
    assert.equal(api.value.requestMethod.length, 2);
    assert.deepEqual(api.value.requestType[0].allowedMethods, ["GET"]);
    assert.equal(api.value.funcScope.length, 0);
    const fn: any = await h.write.createOptions({ workspaceId: "ws1", kind: "function" });
    assert.equal(fn.value.kind, "function");
    assert.equal(fn.value.funcScope.length, 2);
    assert.equal(fn.value.requestMethod.length, 0);
    // argv checks
    assert.deepEqual(h.io.spawns[0].argv.slice(1), ["icomposer", "create", "options", "api", "--json", "--profile", "portal:demo"]);
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("createPreview: exact dry-run argv for api (full params) and function shapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "w030-cp-"));
  const apiKey = "icomposer create api --json --profile portal:demo --name NewThingAPI --module-id 100 --group-id 200 --status active --request-method post --request-type json --response-type map --path /newthing --description a thing --request-model-id 300 --response-model-id 400 --sse --integration core --dry-run";
  const fnKey = "icomposer create function --json --profile portal:demo --name NewFnService --module-id 100 --group-id 200 --status active --func-scope public --description fn --dry-run";
  const io = fakeSubprocess({ stdoutForKey: new Map([[apiKey, okPlan], [fnKey, okPlan]]) });
  const h = await harness({ root, io });
  try {
    const api: any = await h.write.createPreview({ workspaceId: "ws1", kind: "api", params: API_PARAMS });
    assert.equal(api.ok, true);
    assert.equal(api.value.valid, true);
    assert.equal(api.value.name, "NewThingAPI");
    const expectedApiArgv = ["icomposer", "create", "api", "--json", "--profile", "portal:demo", "--name", "NewThingAPI", "--module-id", "100", "--group-id", "200", "--status", "active", "--request-method", "post", "--request-type", "json", "--response-type", "map", "--path", "/newthing", "--description", "a thing", "--request-model-id", "300", "--response-model-id", "400", "--sse", "--integration", "core", "--dry-run"];
    assert.deepEqual(h.io.spawns[0].argv.slice(1), expectedApiArgv);
    assert.equal(h.io.spawns[0].cwd, root);
    const fn: any = await h.write.createPreview({ workspaceId: "ws1", kind: "function", params: FN_PARAMS });
    assert.equal(fn.ok, true);
    const expectedFnArgv = ["icomposer", "create", "function", "--json", "--profile", "portal:demo", "--name", "NewFnService", "--module-id", "100", "--group-id", "200", "--status", "active", "--func-scope", "public", "--description", "fn", "--dry-run"];
    assert.deepEqual(h.io.spawns[1].argv.slice(1), expectedFnArgv);
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("create params validation: rejects bad names/ids/aliases/paths with zero spawn", async () => {
  const root = await mkdtemp(join(tmpdir(), "w030-cv-"));
  const h = await harness({ root });
  try {
    const cases: Array<Record<string, unknown>> = [
      { workspaceId: "ws1", kind: "api", params: { ...API_PARAMS, name: "../bad" } },
      { workspaceId: "ws1", kind: "api", params: { ...API_PARAMS, moduleId: "abc" } },
      { workspaceId: "ws1", kind: "api", params: { ...API_PARAMS, groupId: "12;rm" } },
      { workspaceId: "ws1", kind: "api", params: { ...API_PARAMS, status: "not valid" } },
      { workspaceId: "ws1", kind: "api", params: { ...API_PARAMS, path: "no-slash" } },
      { workspaceId: "ws1", kind: "api", params: { ...API_PARAMS, description: "x".repeat(501) } },
      { workspaceId: "ws1", kind: "api", params: { ...API_PARAMS, requestModelId: "30a" } },
      { workspaceId: "ws1", kind: "api", params: FN_PARAMS }, // function params under api kind
    ];
    for (const input of cases) {
      const res: any = await h.write.createPreview(input);
      assert.equal(res.ok, false, JSON.stringify(input));
      assert.equal(res.error.code, "invalid-create-params");
    }
    assert.equal(h.io.spawns.length, 0);
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("create approval chain: unapproved zero spawn → approve → one-shot execute with catalog rescan evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "w030-ce-"));
  // simulate the CLI-side local file landing: preset groovy + catalog entries
  await mkdir(join(root, "src/dev/Tenant/G/api/NewThingAPI"), { recursive: true });
  await writeFile(join(root, "src/dev/Tenant/G/api/NewThingAPI/NewThingAPI.groovy"), "class NewThingAPI { def x }", "utf8");
  const execKey = "icomposer create api --json --profile portal:demo --name NewThingAPI --module-id 100 --group-id 200 --status active --request-method post --request-type json --response-type map --path /newthing --description a thing --request-model-id 300 --response-model-id 400 --sse --integration core";
  const io = fakeSubprocess({ stdoutForKey: new Map([[execKey, okCreate]]) });
  const h = await harness({ root, io, catalogEntries: [{ name: "SearchPaymentAPI", type: "api" }, { name: "NewThingAPI", type: "api" }] });
  try {
    const req: any = await h.write.createRequest({ workspaceId: "ws1", kind: "api", params: API_PARAMS });
    assert.equal(req.value.kind, "imo-icomposer-create");
    assert.equal(req.value.decision, "pending");
    assert.match(req.value.paramsDigest, /^sha256:[0-9a-f]{64}$/);
    const early: any = await h.write.createExecute(req.value.operationId);
    assert.equal(early.error.code, "not-approved");
    assert.equal(h.io.spawns.length, 0);
    await h.approve(req.value.operationId);
    const ran: any = await h.write.createExecute(req.value.operationId);
    assert.equal(ran.ok, true);
    assert.equal(ran.receipt.status, "completed");
    assert.equal(ran.receipt.catalogVerified, true);
    assert.deepEqual(h.io.spawns[0].argv.slice(1), ["icomposer", "create", "api", "--json", "--profile", "portal:demo", "--name", "NewThingAPI", "--module-id", "100", "--group-id", "200", "--status", "active", "--request-method", "post", "--request-type", "json", "--response-type", "map", "--path", "/newthing", "--description", "a thing", "--request-model-id", "300", "--response-model-id", "400", "--sse", "--integration", "core"]);
    assert.equal(h.io.spawns[0].argv.includes("--dry-run"), false);
    const retry: any = await h.write.createExecute(req.value.operationId);
    assert.equal(retry.error.code, "already-executed");
    assert.equal(h.io.spawns.length, 1);
    const op = h.findOp(req.value.operationId);
    assert.equal(op.resultDigest !== undefined, true);
    // catalog miss → verified false (no false-positive evidence)
    const io2 = fakeSubprocess({ stdoutForKey: new Map([[execKey, okCreate]]) });
    const h2 = await harness({ root: root, io: io2, catalogEntries: [{ name: "SearchPaymentAPI", type: "api" }] });
    const req2: any = await h2.write.createRequest({ workspaceId: "ws1", kind: "api", params: API_PARAMS });
    await h2.approve(req2.value.operationId);
    const ran2: any = await h2.write.createExecute(req2.value.operationId);
    assert.equal(ran2.receipt.catalogVerified, false);
    await h2.dispose();
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("metadata preview/execute: at least one field required; dry-run argv; full argv after approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "w030-md-"));
  await mkdir(join(root, FILE_DIR), { recursive: true });
  await writeFile(join(root, FILE), "class SearchPaymentAPI { def q }", "utf8");
  const dryKey = "icomposer metadata --json --profile portal:demo --status active --description new desc --sse true --dry-run src/dev/Tenant/G/api/SearchPaymentAPI/SearchPaymentAPI.groovy";
  const execKey = "icomposer metadata --json --profile portal:demo --status active --description new desc --sse true src/dev/Tenant/G/api/SearchPaymentAPI/SearchPaymentAPI.groovy";
  const io = fakeSubprocess({ stdoutForKey: new Map([[dryKey, okMeta], [execKey, okMeta]]) });
  const h = await harness({ root, io });
  try {
    const fields = { status: "active", description: "new desc", sse: true };
    const dry: any = await h.write.metadataPreview({ workspaceId: "ws1", file: FILE, fields });
    assert.equal(dry.ok, true);
    assert.equal(dry.value.valid, true);
    assert.deepEqual(h.io.spawns[0].argv.slice(1), ["icomposer", "metadata", "--json", "--profile", "portal:demo", "--status", "active", "--description", "new desc", "--sse", "true", "--dry-run", FILE]);
    // no fields → invalid-metadata-fields, zero spawn
    const empty: any = await h.write.metadataPreview({ workspaceId: "ws1", file: FILE, fields: {} });
    assert.equal(empty.error.code, "invalid-metadata-fields");
    // bad file → invalid-file-path
    const badFile: any = await h.write.metadataPreview({ workspaceId: "ws1", file: "../x.groovy", fields });
    assert.equal(badFile.error.code, "invalid-file-path");
    assert.equal(h.io.spawns.length, 1);
    // request + approval chain
    const req: any = await h.write.metadataRequest({ workspaceId: "ws1", file: FILE, fields });
    assert.equal(req.value.kind, "imo-icomposer-metadata-update");
    await h.approve(req.value.operationId);
    const ran: any = await h.write.metadataExecute(req.value.operationId);
    assert.equal(ran.ok, true);
    assert.equal(ran.receipt.status, "completed");
    assert.deepEqual(ran.receipt.fieldsApplied.sort(), ["description", "sse", "status"]);
    assert.deepEqual(h.io.spawns[1].argv.slice(1), ["icomposer", "metadata", "--json", "--profile", "portal:demo", "--status", "active", "--description", "new desc", "--sse", "true", FILE]);
    assert.equal(h.io.spawns[1].argv.includes("--dry-run"), false);
    // kind isolation: pushExecute refuses a metadata op
    const wrong: any = await h.write.pushExecute(req.value.operationId);
    assert.equal(wrong.ok, false);
  } finally { await h.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("P2 regression: branch names reject '..'; artifact tmp files are cleaned on failure", async () => {
  // branch tightening
  const { isValidBranchName } = await import("../src/cli.ts");
  assert.equal(isValidBranchName("main"), true);
  assert.equal(isValidBranchName("feat/x"), true);
  assert.equal(isValidBranchName(".."), false);
  assert.equal(isValidBranchName("a/../b"), false);
  assert.equal(isValidBranchName("a/./b"), false);
  // tmp cleanup: force artifact write failure via an unwritable dir monkey-patch
  const { writeTestArtifact } = await import("../src/artifacts.ts");
  const badBase = await mkdtemp(join(tmpdir(), "w030-bad-"));
  // make artifacts a FILE so mkdir fails
  await writeFile(join(badBase, "artifacts"), "not a dir", "utf8");
  let threw = false;
  try {
    await writeTestArtifact(badBase, "op1", {
      evidence: { elapsedMs: 1, httpStatus: 200, requestDigest: "", responseDigest: "", traceId: "", testUrl: "", savedAt: "" },
      stdoutDigest: "d", stderrDigest: "d", exitCode: 0,
    });
  } catch { threw = true; }
  assert.equal(threw, true);
  const leftovers = (await readdir(badBase)).filter(name => name.startsWith(".tmp-"));
  assert.deepEqual(leftovers, []);
  await rm(badBase, { recursive: true, force: true });
});

test("gates: cancelled signal and disposed service refuse create/metadata paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "w030-g-"));
  const h = await harness({ root });
  const c = new AbortController();
  c.abort();
  const a: any = await h.write.createOptions({ workspaceId: "ws1", kind: "api" }, c.signal);
  assert.equal(a.error.code, "cancelled");
  const b: any = await h.write.createPreview({ workspaceId: "ws1", kind: "api", params: API_PARAMS }, c.signal);
  assert.equal(b.error.code, "cancelled");
  const d: any = await h.write.metadataPreview({ workspaceId: "ws1", file: FILE, fields: { status: "active" } }, c.signal);
  assert.equal(d.error.code, "cancelled");
  assert.equal(h.io.spawns.length, 0);
  await h.dispose();
  const e: any = await h.write.createExecute("any");
  assert.equal(e.error.code, "service-disposed");
  await rm(root, { recursive: true, force: true });
});
