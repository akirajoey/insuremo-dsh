import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { Context } from "@deepseek-ai/cordis";
import { IciEngineService } from "../src/service.ts";
import { graphBaseDir, currentDir } from "../src/storage.ts";
import { makeBinding, makeCatalog, writeGroovy, writeMeta } from "./support/helpers.ts";

interface FakeEmbeddingOpts {
  mode?: "hash" | "fail" | "no-vectors";
  statusFor?: (body: string) => number;
  calls?: string[][];
}

function hashVector(text: string): number[] {
  const v: number[] = [];
  for (let i = 0; i < 8; i++) v.push(((text.charCodeAt(i % text.length) + i * 7) % 100) / 100);
  return v;
}

function fakeEmbeddingSubprocess(opts: FakeEmbeddingOpts = {}): SubprocessRuntime {
  return {
    async resolveExecutable() { return "/usr/bin/curl"; },
    spawn(spec: { argv: readonly string[] }) {
      const bodyIdx = spec.argv.indexOf("--data-raw");
      const body = bodyIdx >= 0 ? String(spec.argv[bodyIdx + 1]) : "{}";
      if (opts.calls) opts.calls.push([body]);
      const status = opts.statusFor ? opts.statusFor(body) : 200;
      let stdout = "";
      if (status === 200) {
        const parsed = JSON.parse(body) as { text: string[] };
        if (opts.mode === "no-vectors") {
          stdout = `{"ok":true}\n__ICI_HTTP_STATUS__:200`;
        } else {
          const vectors = parsed.text.map(t => hashVector(t));
          stdout = `${JSON.stringify(vectors)}\n__ICI_HTTP_STATUS__:200`;
        }
      } else {
        stdout = `{"message":"rejected"}\n__ICI_HTTP_STATUS__:${status}`;
      }
      let settle!: (o: { exitCode: number | null; signal: string | null }) => void;
      const done = new Promise<{ exitCode: number | null; signal: string | null }>(r => { settle = r; });
      const handle = {
        pid: 7,
        collected: {
          stdout: { readFrom() { return { text: stdout, nextOffset: 0, lossy: false }; } },
          stderr: { readFrom() { return { text: "", nextOffset: 0, lossy: false }; } },
        },
        done,
        terminate: () => settle({ exitCode: 0, signal: null }),
        waitForExit: async () => { settle({ exitCode: 0, signal: null }); return true; },
      };
      settle({ exitCode: 0, signal: null });
      return handle as never;
    },
  } as never;
}

async function searchHarness(opts: { catalogEntries: Array<{ name: string; type: string; sourcePath?: string }>; io: unknown; root?: string; dshHome?: string }) {
  const ctx = new Context();
  const root = opts.root ?? await mkdtemp(join(tmpdir(), "ici-search-"));
  const dshHome = opts.dshHome ?? await mkdtemp(join(tmpdir(), "ici-search-dsh-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  ctx.provide("workspaceBinding", makeBinding(root, "bound") as never);
  ctx.provide("icomposerCatalog", makeCatalog(opts.catalogEntries) as never);
  ctx.provide("imoAuth" as never, {
    prepare: async () => ({
      ok: true,
      value: { use: async (cb: (s: { accessToken: string }) => unknown) => cb({ accessToken: "sekret-token" }) },
    }),
  } as never);
  ctx.provide("subprocess", opts.io as never);
  const fiber = await ctx.plugin(IciEngineService, { timeoutMs: 5000 });
  await fiber.await();
  const engine = ctx.get("iciEngine") as IciEngineService;
  return {
    engine, root, dshHome,
    dispose: async () => {
      await fiber.dispose();
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
      await rm(dshHome, { recursive: true, force: true });
      if (opts.root === undefined) await rm(root, { recursive: true, force: true });
    },
  };
}

test("search index/search roundtrip with deterministic vectors and independent cosine", async () => {
  const entries: Array<{ name: string; type: string; sourcePath?: string }> = [];
  const root = await mkdtemp(join(tmpdir(), "ici-srch-fx-"));
  for (const n of ["AlphaAPI", "BetaAPI"]) {
    await writeMeta(root, "api", n);
    entries.push({ name: n, type: "api", sourcePath: await writeGroovy(root, "api", n, `class ${n} { def execute(){ def x=1 } }`) });
  }
  const io = fakeEmbeddingSubprocess({ mode: "hash", calls: [] });
  const h = await searchHarness({ catalogEntries: entries, io, root });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    const idx: any = await h.engine.index({ workspaceId: "ws1" });
    assert.equal(idx.ok, true);
    if (idx.ok) {
      assert.equal(idx.value.total, 2);
      assert.equal(idx.value.embedded, 2);
      assert.equal(idx.value.reused, 0);
    }
    // regression (P1#1): source_hash must be a real 64-hex digest — the cache
    // lines are read back and each hash checked against the strict pattern.
    const hashDirs = await readdir(join(h.dshHome, "ici"));
    const jsonlPath = join(h.dshHome, "ici", hashDirs[0], "graph", "search", "api_embeddings.jsonl");
    const jsonl = await readFile(jsonlPath, "utf8");
    for (const line of jsonl.split("\n").filter(l => l.trim())) {
      const obj = JSON.parse(line) as { source_hash?: string };
      assert.match(obj.source_hash ?? "", /^[0-9a-f]{64}$/);
    }
    const res: any = await h.engine.search({ workspaceId: "ws1", query: "AlphaAPI", mode: "technical", top: 2 });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.rows.length, 2);
      assert.equal(res.value.rows[0].apiId, "api:AlphaAPI");
      const expectedVecA = hashVector(`API: AlphaAPI\nMode: technical\nDownstream: \n`);
      const queryVec = hashVector("AlphaAPI");
      let dot = 0, ln = 0, rn = 0;
      for (let i = 0; i < queryVec.length; i++) {
        dot += queryVec[i] * expectedVecA[i];
        ln += queryVec[i] ** 2;
        rn += expectedVecA[i] ** 2;
      }
      const expectedScore = dot / (Math.sqrt(ln) * Math.sqrt(rn));
      assert.ok(Math.abs(res.value.rows[0].score - expectedScore) < 1e-9);
      assert.ok(res.value.rows[0].downstream.length <= 5);
    }
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("index incremental reuse: unchanged api reuses cached vector, changed api re-embeds", async () => {
  const entries: Array<{ name: string; type: string; sourcePath?: string }> = [];
  const root = await mkdtemp(join(tmpdir(), "ici-incr-"));
  for (const n of ["AlphaAPI", "BetaAPI"]) {
    await writeMeta(root, "api", n);
    entries.push({ name: n, type: "api", sourcePath: await writeGroovy(root, "api", n, `class ${n} { def execute(){ def x=1 } }`) });
  }
  const calls: string[][] = [];
  const io = fakeEmbeddingSubprocess({ mode: "hash", calls });
  const h = await searchHarness({ catalogEntries: entries, io, root });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    const first: any = await h.engine.index({ workspaceId: "ws1" });
    assert.equal(first.value.embedded, 2);
    const batchesAfterFirst = calls.length;
    const second: any = await h.engine.index({ workspaceId: "ws1" });
    assert.equal(second.value.embedded, 0);
    assert.equal(second.value.reused, 2);
    assert.equal(calls.length, batchesAfterFirst);
    await writeFile(join(root, "src/dev/Tenant/Group/api/AlphaAPI/AlphaAPI.groovy"), `class AlphaAPI { def execute(){ def y=2 } }`, "utf8");
    const third: any = await h.engine.index({ workspaceId: "ws1" });
    assert.equal(third.value.embedded, 1);
    assert.equal(third.value.reused, 1);
    const fourth: any = await h.engine.index({ workspaceId: "ws1", rebuild: true });
    assert.equal(fourth.value.embedded, 2);
    assert.equal(fourth.value.reused, 0);
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("embedding failure keeps previous JSONL intact (atomicity)", async () => {
  const entries: Array<{ name: string; type: string; sourcePath?: string }> = [];
  const root = await mkdtemp(join(tmpdir(), "ici-atomic2-"));
  for (const n of ["AlphaAPI"]) {
    await writeMeta(root, "api", n);
    entries.push({ name: n, type: "api", sourcePath: await writeGroovy(root, "api", n, `class ${n} { def execute(){ def x=1 } }`) });
  }
  const good = fakeEmbeddingSubprocess({ mode: "hash" });
  const h = await searchHarness({ catalogEntries: entries, io: good, root });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    assert.equal((await h.engine.index({ workspaceId: "ws1" })).ok, true);
    const hashDirs = await readdir(join(h.dshHome, "ici"));
    const jsonlPath = join(h.dshHome, "ici", hashDirs[0], "graph", "search", "api_embeddings.jsonl");
    const before = await readFile(jsonlPath, "utf8");
    const bad = fakeEmbeddingSubprocess({ statusFor: () => 500 });
    const ctx2 = new Context();
    ctx2.provide("workspaceBinding", makeBinding(root, "bound") as never);
    ctx2.provide("icomposerCatalog", makeCatalog(entries) as never);
    ctx2.provide("imoAuth" as never, { prepare: async () => ({ ok: true, value: { use: async (cb: any) => cb({ accessToken: "t" }) } }) } as never);
    ctx2.provide("subprocess", bad as never);
    const fiber2 = await ctx2.plugin(IciEngineService, { timeoutMs: 5000 });
    await fiber2.await();
    const engine2 = ctx2.get("iciEngine") as IciEngineService;
    const res: any = await engine2.index({ workspaceId: "ws1", rebuild: true });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, "embedding-error");
    await fiber2.dispose();
    const after = await readFile(jsonlPath, "utf8");
    assert.equal(after, before);
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("401 maps to invalid-auth; hostile stdout maps to embedding-error", async () => {
  const entries: Array<{ name: string; type: string; sourcePath?: string }> = [];
  const root = await mkdtemp(join(tmpdir(), "ici-401-"));
  await writeMeta(root, "api", "AlphaAPI");
  entries.push({ name: "AlphaAPI", type: "api", sourcePath: await writeGroovy(root, "api", "AlphaAPI", `class AlphaAPI { def execute(){ def x=1 } }`) });
  const unauth = fakeEmbeddingSubprocess({ statusFor: () => 401 });
  const h1 = await searchHarness({ catalogEntries: entries, io: unauth, root });
  try {
    assert.equal((await h1.engine.build({ workspaceId: "ws1" })).ok, true);
    const res: any = await h1.engine.index({ workspaceId: "ws1" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, "invalid-auth");
  } finally {
    await h1.dispose();
    await rm(root, { recursive: true, force: true });
  }
  const noVec = fakeEmbeddingSubprocess({ mode: "no-vectors" });
  const root2 = await mkdtemp(join(tmpdir(), "ici-401-b-"));
  await writeMeta(root2, "api", "AlphaAPI");
  await writeGroovy(root2, "api", "AlphaAPI", `class AlphaAPI { def execute(){ def x=1 } }`);
  const h2 = await searchHarness({ catalogEntries: [{ name: "AlphaAPI", type: "api", sourcePath: join(root2, "src/dev/Tenant/Group/api/AlphaAPI/AlphaAPI.groovy") }], io: noVec, root: root2 });
  try {
    assert.equal((await h2.engine.build({ workspaceId: "ws1" })).ok, true);
    const res: any = await h2.engine.index({ workspaceId: "ws1" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, "embedding-error");
  } finally {
    await h2.dispose();
    await rm(root2, { recursive: true, force: true });
  }
});

test("search gates: no-index before indexing; dispose", async () => {
  const entries: Array<{ name: string; type: string; sourcePath?: string }> = [];
  const root = await mkdtemp(join(tmpdir(), "ici-noidx-"));
  await writeMeta(root, "api", "AlphaAPI");
  entries.push({ name: "AlphaAPI", type: "api", sourcePath: await writeGroovy(root, "api", "AlphaAPI", `class AlphaAPI { def execute(){ def x=1 } }`) });
  const io = fakeEmbeddingSubprocess({ mode: "hash" });
  const h = await searchHarness({ catalogEntries: entries, io, root });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    const before: any = await h.engine.search({ workspaceId: "ws1", query: "anything" });
    assert.equal(before.ok, false);
    if (!before.ok) {
      assert.equal(before.error.code, "no-index");
      assert.ok(before.error.message.includes("index"));
    }
    const captured = h.engine;
    await h.dispose();
    const after: any = await captured.search({ workspaceId: "ws1", query: "x" });
    assert.equal(after.ok, false);
    if (!after.ok) assert.equal(after.error.code, "service-disposed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real ssapocpa search smoke: 3-api subset index, query=top1 self-match, token never in output, zero write", async () => {
  const projectRoot = "/Users/junjie.zhang/skills/ssapocpa";
  const dshHome = await mkdtemp(join(tmpdir(), "ici-ssmoke-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  const { scanWorkspace } = await import("../../icomposer-catalog/src/scan.ts");
  const scan = await scanWorkspace(projectRoot);
  const apiEntries = scan.entries.filter(e => e.type === "api").slice(0, 3);
  const entries = apiEntries.map(e => ({ name: e.name, type: e.type, sourcePath: (e as any).sourcePath }));
  assert.equal(entries.length, 3);
  async function snapshot(dir: string): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    async function walk(p: string) {
      const list = await readdir(p, { withFileTypes: true });
      for (const e of list) {
        const full = join(p, e.name);
        if (full.includes("/.metadata/icomposer")) continue;
        if (e.isDirectory()) await walk(full);
        else map.set(full, (await stat(full)).mtimeMs);
      }
    }
    await walk(dir);
    return map;
  }
  function hashVector(text: string): number[] {
    const v: number[] = [];
    for (let i = 0; i < 8; i++) v.push(((text.charCodeAt(i % text.length) + i * 7) % 100) / 100);
    return v;
  }
  const before = await snapshot(projectRoot);
  const io = {
    async resolveExecutable() { return "/usr/bin/curl"; },
    spawn(spec: { argv: readonly string[] }) {
      const idx = spec.argv.indexOf("--data-raw");
      const body = idx >= 0 ? String(spec.argv[idx + 1]) : "{}";
      const parsed = JSON.parse(body) as { text: string[] };
      const stdout = `${JSON.stringify(parsed.text.map(t => hashVector(t)))}\n__ICI_HTTP_STATUS__:200`;
      let settle!: (o: { exitCode: number | null; signal: string | null }) => void;
      const done = new Promise<{ exitCode: number | null; signal: string | null }>(r => { settle = r; });
      const handle = {
        pid: 7,
        collected: { stdout: { readFrom() { return { text: stdout, nextOffset: 0, lossy: false }; } }, stderr: { readFrom() { return { text: "", nextOffset: 0, lossy: false }; } } },
        done,
        terminate: () => settle({ exitCode: 0, signal: null }),
        waitForExit: async () => { settle({ exitCode: 0, signal: null }); return true; },
      };
      settle({ exitCode: 0, signal: null });
      return handle as never;
    },
  };
  const h = await searchHarness({ root: projectRoot, catalogEntries: entries, dshHome, io });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    const idx: any = await h.engine.index({ workspaceId: "ws1" });
    assert.equal(idx.ok, true);
    if (idx.ok) assert.equal(idx.value.total, 3);
    // regression (P1#1): real-project source hashes must be populated
    const hashDirs = await readdir(join(h.dshHome, "ici"));
    const jsonlPath = join(h.dshHome, "ici", hashDirs[0], "graph", "search", "api_embeddings.jsonl");
    const jsonl = await readFile(jsonlPath, "utf8");
    for (const line of jsonl.split("\n").filter(l => l.trim())) {
      const obj = JSON.parse(line) as { source_hash?: string };
      assert.match(obj.source_hash ?? "", /^[0-9a-f]{64}$/);
    }
    const target = entries[0].name;
    const res: any = await h.engine.search({ workspaceId: "ws1", query: target, mode: "technical", top: 3 });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(res.value.rows.length >= 1);
      assert.equal(res.value.rows[0].apiId, `api:${target}`);
      const serialized = JSON.stringify(res.value);
      assert.equal(serialized.includes("sekret"), false);
      assert.equal(serialized.includes("Bearer"), false);
    }
  } finally {
    await h.dispose();
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
  const after = await snapshot(projectRoot);
  assert.equal(before.size, after.size);
  for (const [k, v] of before) assert.equal(after.get(k), v);
});
