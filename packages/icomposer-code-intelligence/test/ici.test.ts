import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { IciEngineService } from "../src/service.ts";
import { graphBaseDir, currentDir } from "../src/storage.ts";

const validEnv = "portal:microsite";

function makeBinding(root: string, mode: "bound" | "unbound" | "not-found" = "bound") {
  return {
    get: async (id: string) => {
      if (mode === "not-found") return { ok: false, error: { code: "workspace-not-found" } };
      if (mode === "unbound") return { ok: true, value: { workspaceId: id, canonicalPath: root, binding: null } };
      return { ok: true, value: { workspaceId: id, canonicalPath: root, binding: { authProfile: "portal:demo", environmentId: validEnv } } };
    },
  };
}

function makeCatalog(entries: Array<{ name: string; type: string; sourcePath?: string }>) {
  return {
    listAssets: async () => ({ ok: true, value: { entries, counts: { api: 0, function: 0, batch: 0, model: 0, total: entries.length }, truncated: false } }),
  };
}

async function harness(opts: { root?: string; bindingMode?: "bound" | "unbound" | "not-found"; catalogEntries?: Array<{ name: string; type: string; sourcePath?: string }>; dshHome?: string }) {
  const ctx = new Context();
  const root = opts.root ?? await mkdtemp(join(tmpdir(), "ici-"));
  const dshHome = opts.dshHome ?? await mkdtemp(join(tmpdir(), "ici-dsh-"));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  ctx.provide("workspaceBinding", makeBinding(root, opts.bindingMode ?? "bound") as never);
  ctx.provide("icomposerCatalog", makeCatalog(opts.catalogEntries ?? []) as never);
  const fiber = await ctx.plugin(IciEngineService);
  await fiber.await();
  const engine = ctx.get("iciEngine") as IciEngineService;
  return {
    ctx, engine, fiber, root, dshHome, prev,
    dispose: async () => {
      await fiber.dispose();
      if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
      await rm(dshHome, { recursive: true, force: true });
      if (!opts.root) await rm(root, { recursive: true, force: true });
    },
  };
}

async function writeGroovy(root: string, kind: string, name: string, body: string) {
  const dir = join(root, "src", "dev", "Tenant", "Group", kind, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.groovy`), body, "utf8");
  return join(dir, `${name}.groovy`);
}
async function writeMeta(root: string, kind: string, name: string) {
  const dir = join(root, ".metadata", kind);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${name}.metadata.json`), JSON.stringify({ [kind]: { Name: name } }), "utf8");
}

test("fixture 3 api/3 function with method nesting -> nodes/edges golden", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-fixture-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  // metadata
  for (const n of ["ApiA", "ApiB", "ApiC"]) await writeMeta(root, "api", n);
  for (const n of ["FuncA", "FuncB", "FuncC"]) await writeMeta(root, "function", n);
  // groovy sources
  const apiA = `
class ApiA {
  def execute() {
    def svc = getCommonService("FuncA")
    svc.process()
    this.helper()
  }
  def helper() {
    def x = 1
  }
}
`;
  const funcA = `
class FuncA {
  def process() {
    this.inner()
  }
  def inner() {
    def c = new AppchatSdkClient()
    c.doSomething()
  }
}
`;
  const generic = (name: string) => `class ${name} { def execute() { def x=1 } }`;
  const pApiA = await writeGroovy(root, "api", "ApiA", apiA);
  const pFuncA = await writeGroovy(root, "function", "FuncA", funcA);
  await writeGroovy(root, "api", "ApiB", generic("ApiB"));
  await writeGroovy(root, "api", "ApiC", generic("ApiC"));
  await writeGroovy(root, "function", "FuncB", generic("FuncB"));
  await writeGroovy(root, "function", "FuncC", generic("FuncC"));

  const entries = [
    { name: "ApiA", type: "api", sourcePath: pApiA },
    { name: "ApiB", type: "api", sourcePath: join(root, "src/dev/Tenant/Group/api/ApiB/ApiB.groovy") },
    { name: "ApiC", type: "api", sourcePath: join(root, "src/dev/Tenant/Group/api/ApiC/ApiC.groovy") },
    { name: "FuncA", type: "function", sourcePath: pFuncA },
    { name: "FuncB", type: "function", sourcePath: join(root, "src/dev/Tenant/Group/function/FuncB/FuncB.groovy") },
    { name: "FuncC", type: "function", sourcePath: join(root, "src/dev/Tenant/Group/function/FuncC/FuncC.groovy") },
  ];
  const h = await harness({ root, catalogEntries: entries, dshHome });
  try {
    const res: any = await h.engine.build({ workspaceId: "ws1" });
    assert.equal(res.ok, true);
    const nodes = res.value.nodes; const edges = res.value.edges;
    // Expect at least api/function/method nodes
    assert.ok(nodes.some((n: any) => n.id === "api:ApiA"));
    assert.ok(nodes.some((n: any) => n.id === "method:ApiA.execute"));
    assert.ok(nodes.some((n: any) => n.id === "method:ApiA.helper"));
    assert.ok(edges.some((e: any) => e.from === "api:ApiA" && e.to === "method:ApiA.execute" && e.kind === "CONTAINS"));
    assert.ok(edges.some((e: any) => e.from === "method:ApiA.execute" && e.to === "function:FuncA" && e.source === "static"));
    assert.ok(edges.some((e: any) => e.from === "method:ApiA.execute" && e.to === "method:FuncA.process"));
    assert.ok(edges.some((e: any) => e.from === "method:ApiA.execute" && e.to === "method:ApiA.helper"));
    assert.ok(edges.some((e: any) => e.source === "inferred" && e.confidence === "inferred"));
    // manifest
    assert.equal(res.value.manifest.schemaVersion, 1);
    assert.ok(res.value.manifest.sourceFingerprint.length === 64);
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("relationship extraction positive/negative", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-rel-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-dsh2-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "ApiX");
  await writeMeta(root, "function", "FuncY");
  const src = `
class ApiX {
  def execute() {
    // negative: no getCommonService
    def x = 1
    // positive local call
    this.local()
  }
  def local() { def y=2 }
  def unrelated() { def z=getBean("Unknown") }
}
`;
  const p = await writeGroovy(root, "api", "ApiX", src);
  await writeGroovy(root, "function", "FuncY", `class FuncY { def execute(){ def a=1 } }`);
  const h = await harness({ root, catalogEntries: [{ name: "ApiX", type: "api", sourcePath: p }, { name: "FuncY", type: "function", sourcePath: join(root, "src/dev/Tenant/Group/function/FuncY/FuncY.groovy") }], dshHome });
  try {
    const res: any = await h.engine.build({ workspaceId: "ws1" });
    assert.equal(res.ok, true);
    const edges = res.value.edges;
    assert.ok(edges.some((e: any) => e.from === "method:ApiX.execute" && e.to === "method:ApiX.local"));
    assert.ok(!edges.some((e: any) => e.to === "function:Unknown"));
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("atomic snapshot: build interrupted keeps current previous version", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-atomic-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-atomic-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "A1");
  const p = await writeGroovy(root, "api", "A1", `class A1 { def execute(){ def x=1 } }`);
  const h = await harness({ root, catalogEntries: [{ name: "A1", type: "api", sourcePath: p }], dshHome });
  try {
    const r1: any = await h.engine.build({ workspaceId: "ws1" });
    assert.equal(r1.ok, true);
    const base = graphBaseDir(root, "ws1");
    const m1 = JSON.parse(await readFile(join(currentDir(base), "manifest.json"), "utf8"));
    const ac = new AbortController(); ac.abort();
    const r2: any = await h.engine.build({ workspaceId: "ws1" }, { signal: ac.signal });
    assert.equal(r2.ok, false); assert.equal(r2.error.code, "cancelled");
    const m2 = JSON.parse(await readFile(join(currentDir(base), "manifest.json"), "utf8"));
    assert.equal(m1.sourceFingerprint, m2.sourceFingerprint);
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("manifest fingerprint changes trigger rebuild", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-fp-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-fp-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "A1");
  const p = await writeGroovy(root, "api", "A1", `class A1 { def execute(){ def x=1 } }`);
  const h = await harness({ root, catalogEntries: [{ name: "A1", type: "api", sourcePath: p }], dshHome });
  try {
    const r1: any = await h.engine.build({ workspaceId: "ws1" });
    const fp1 = r1.value.manifest.sourceFingerprint;
    await writeFile(p, `class A1 { def execute(){ def x=2 } }`, "utf8");
    // Need to recreate catalog entry after file change (sourcePath same but content changed)
    // Recreate harness with new fingerprint? Instead call build again with same harness but file changed on disk
    const r2: any = await h.engine.build({ workspaceId: "ws1" });
    assert.notEqual(fp1, r2.value.manifest.sourceFingerprint);
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("cancel signal returns cancelled", async () => {
  const h = await harness({ catalogEntries: [] });
  try {
    const ac = new AbortController(); ac.abort();
    const res: any = await h.engine.build({ workspaceId: "ws1" }, { signal: ac.signal });
    assert.equal(res.ok, false); assert.equal(res.error.code, "cancelled");
  } finally {
    await h.dispose();
  }
});

test("gate: unbound and not-found and invalid id", async () => {
  const h1 = await harness({ bindingMode: "unbound" });
  try { const r: any = await h1.engine.build({ workspaceId: "ws1" }); assert.equal(r.error.code, "workspace-not-bound"); } finally { await h1.dispose(); }
  const h2 = await harness({ bindingMode: "not-found" });
  try { const r: any = await h2.engine.build({ workspaceId: "ws1" }); assert.equal(r.error.code, "workspace-not-found"); } finally { await h2.dispose(); }
  const h3 = await harness({});
  try { const r: any = await h3.engine.build({ workspaceId: "" }); assert.equal(r.error.code, "invalid-workspace-id"); } finally { await h3.dispose(); }
});

test("progress callback invoked", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-prog-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-prog-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "A1");
  const p = await writeGroovy(root, "api", "A1", `class A1 { def execute(){ def x=1 } }`);
  const h = await harness({ root, catalogEntries: [{ name: "A1", type: "api", sourcePath: p }], dshHome });
  try {
    const calls: Array<[number, number, string]> = [];
    const res: any = await h.engine.build({ workspaceId: "ws1" }, { onProgress: (c,t,l) => calls.push([c,t,l]) });
    assert.equal(res.ok, true);
    assert.ok(calls.length > 0);
    assert.ok(calls.every(([c,t]) => c <= t));
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("real ssapocpa smoke: node count, edge >0, isolated DSH_HOME, true dir zero write", async () => {
  const projectRoot = "/Users/junjie.zhang/skills/ssapocpa";
  const dshHome = await mkdtemp(join(tmpdir(), "ici-smoke-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  async function snapshot(dir: string): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    async function walk(p: string) {
      const entries = await readdir(p, { withFileTypes: true });
      for (const e of entries) {
        const full = join(p, e.name);
        if (full.includes("/.metadata/icomposer")) continue;
        if (e.isDirectory()) await walk(full);
        else map.set(full, (await stat(full)).mtimeMs);
      }
    }
    await walk(dir);
    return map;
  }
  const before = await snapshot(projectRoot);
  // Build a fake catalog that actually scans the real project via catalog logic
  // For smoke we reuse a minimal catalog that reads real .metadata counts + sources
  // Instead of faking, we use a harness that provides real catalog entries by scanning projectRoot directly
  // We will import the real catalog scan to get realistic counts
  const { scanWorkspace } = await import("../../icomposer-catalog/src/scan.ts");
  const scan = await scanWorkspace(projectRoot);
  const entries = scan.entries.map(e => ({ name: e.name, type: e.type, sourcePath: (e as any).sourcePath }));
  const h = await harness({ root: projectRoot, catalogEntries: entries, dshHome });
  try {
    const res: any = await h.engine.build({ workspaceId: "ws1" });
    assert.equal(res.ok, true);
    // catalog counts 236+209+11+3=459 plus methods; nodes should be >459
    assert.ok(res.value.nodes.length >= 459);
    assert.ok(res.value.edges.length > 0);
    assert.equal(res.value.manifest.schemaVersion, 1);
    // STD_DISCARD reconciliation: no node/edge may reference a discarded path,
    // and the independent find count of non-discarded groovy files is reported.
    const nonDiscarded = (await findCount(join(projectRoot, "src", "dev"), (n) => n.endsWith(".groovy"), "STD_DISCARD"));
    const totalGroovy = (await findCount(join(projectRoot, "src", "dev"), (n) => n.endsWith(".groovy")));
    assert.equal(totalGroovy - nonDiscarded, 24); // 478 total - 454 kept = 24 STD_DISCARD
    for (const node of res.value.nodes) {
      assert.equal(String((node as any).sourceFile ?? "").includes("STD_DISCARD"), false, `node ${(node as any).id} references a discarded path`);
    }
    for (const edge of res.value.edges) {
      assert.equal(String((edge as any).ownerFile ?? "").includes("STD_DISCARD"), false, `edge ${(edge as any).id} references a discarded path`);
      if ((edge as any).source === "inferred") {
        assert.ok(res.value.nodes.some((n: any) => n.id === (edge as any).to), `dangling inferred edge to ${(edge as any).to}`);
      }
    }
    console.log(`[ici] real build nodes=${res.value.nodes.length} edges=${res.value.edges.length} groovyTotal=${totalGroovy} groovyKept=${nonDiscarded} groovyDiscarded=${totalGroovy - nonDiscarded}`);
    // snapshot write isolated
    const base = graphBaseDir(projectRoot, "ws1");
    const cur = currentDir(base);
    assert.ok((await stat(join(cur, "nodes.json"))).isFile());
    assert.ok((await stat(join(cur, "edges.json"))).isFile());
    assert.ok((await stat(join(cur, "manifest.json"))).isFile());
  } finally {
    await h.dispose();
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
  const after = await snapshot(projectRoot);
  assert.equal(before.size, after.size);
  for (const [k, v] of before) assert.equal(after.get(k), v);
});

async function findCount(dir: string, matcher: (name: string) => boolean, exclude?: string): Promise<number> {
  let count = 0;
  async function walk(p: string) {
    let entries;
    try { entries = await readdir(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(p, e.name);
      if (exclude && full.includes(exclude)) continue;
      if (e.isDirectory()) await walk(full);
      else if (matcher(e.name)) count += 1;
    }
  }
  await walk(dir);
  return count;
}

test("STD_DISCARD paths produce zero nodes/edges/placeholders", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-discard-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-discard-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "KeepAPI");
  const keepPath = await writeGroovy(root, "api", "KeepAPI", `class KeepAPI { def execute(){ def x=1 } }`);
  // discarded function: metadata + source under a STD_DISCARD path segment
  await writeMeta(root, "function", "DroppedFunc");
  const discardDir = join(root, "src", "dev", "Tenant", "STD_DISCARD", "function", "DroppedFunc");
  await mkdir(discardDir, { recursive: true });
  const discardPath = join(discardDir, "DroppedFunc.groovy");
  await writeFile(discardPath, `class DroppedFunc { def execute(){ getCommonService("KeepAPI") } }`, "utf8");
  const h = await harness({
    root,
    catalogEntries: [
      { name: "KeepAPI", type: "api", sourcePath: keepPath },
      { name: "DroppedFunc", type: "function", sourcePath: discardPath },
    ],
    dshHome,
  });
  try {
    const res: any = await h.engine.build({ workspaceId: "ws1" });
    assert.equal(res.ok, true);
    const nodes = res.value.nodes as Array<{ id: string }>;
    const edges = res.value.edges as Array<{ from: string; to: string }>;
    assert.ok(nodes.every(n => !n.id.includes("DroppedFunc")));
    assert.ok(edges.every(e => !e.from.includes("DroppedFunc") && !e.to.includes("DroppedFunc")));
    assert.ok(nodes.some(n => n.id === "api:KeepAPI"));
    // the discarded source must not contribute a CALLS edge either
    assert.ok(!edges.some(e => e.to === "api:KeepAPI" || e.to.endsWith(":KeepAPI") && e.kind === "CALLS"));
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("promote failure injection: stale rename failure keeps previous current and returns storage-error", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-promote-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-promote-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "A1");
  const p = await writeGroovy(root, "api", "A1", `class A1 { def execute(){ def x=1 } }`);
  const h = await harness({ root, catalogEntries: [{ name: "A1", type: "api", sourcePath: p }], dshHome });
  try {
    const first: any = await h.engine.build({ workspaceId: "ws1" });
    assert.equal(first.ok, true);
    const base = graphBaseDir(root, "ws1");
    const manifestBefore = JSON.parse(await readFile(join(currentDir(base), "manifest.json"), "utf8"));
    // second build whose promote fails at phase 1 (current → stale)
    const { writeAtomic } = await import("../src/storage.ts");
    const { rename } = await import("node:fs/promises");
    const warnings: string[] = [];
    await assert.rejects(
      () => writeAtomic(
        base,
        { ...first.value.manifest, builtAt: new Date().toISOString() },
        [], [],
        {
          renameFn: async (src: any, dest: any) => {
            if (String(src).endsWith("/current")) throw new Error("injected EPERM (uchg)");
            return rename(src, dest);
          },
          warn: (m: string) => warnings.push(m),
        },
      ),
    );
    // previous current fully intact
    const manifestAfter = JSON.parse(await readFile(join(currentDir(base), "manifest.json"), "utf8"));
    assert.equal(manifestAfter.builtAt, manifestBefore.builtAt);
    assert.equal(manifestAfter.sourceFingerprint, manifestBefore.sourceFingerprint);
    assert.ok(warnings.some(w => w.includes("previous version kept")));
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("stale cleanup failure only warns and build still succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-cleanfail-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-cleanfail-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "A1");
  const p = await writeGroovy(root, "api", "A1", `class A1 { def execute(){ def x=1 } }`);
  const h = await harness({ root, catalogEntries: [{ name: "A1", type: "api", sourcePath: p }], dshHome });
  try {
    const first: any = await h.engine.build({ workspaceId: "ws1" });
    assert.equal(first.ok, true);
    const base = graphBaseDir(root, "ws1");
    const { writeAtomic } = await import("../src/storage.ts");
    const { rename, rm } = await import("node:fs/promises");
    const warnings: string[] = [];
    await writeAtomic(
      base,
      { ...first.value.manifest, builtAt: new Date().toISOString() },
      [{ id: "n1" }], [],
      {
        renameFn: rename,
        rmFn: async (path: any, opts: any) => {
          if (String(path).includes("/stale-")) throw new Error("injected cleanup failure");
          return rm(path, opts);
        },
        warn: (m: string) => warnings.push(m),
      },
    );
    assert.ok(warnings.some(w => w.includes("cleanup of stale snapshot failed")));
    // current promoted successfully despite cleanup failure
    const nodes = JSON.parse(await readFile(join(currentDir(base), "nodes.json"), "utf8"));
    assert.deepEqual(nodes, [{ id: "n1" }]);
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("queryApi roundtrip: multi-start, tree structure, depth truncation, focus filter", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-q-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-q-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  for (const n of ["ApiA", "ApiB"]) await writeMeta(root, "api", n);
  for (const n of ["FuncA", "FuncB"]) await writeMeta(root, "function", n);
  const apiA = `
class ApiA {
  def execute() {
    def svc = getCommonService("FuncA")
    svc.process()
    this.helper()
  }
  def helper() { def x=1 }
}
`;
  const funcA = `
class FuncA {
  def process() {
    this.inner()
  }
  def inner() {
    def c = new AppchatSdkClient()
    c.do()
  }
}
`;
  const pApiA = await writeGroovy(root, "api", "ApiA", apiA);
  await writeGroovy(root, "function", "FuncA", funcA);
  const pApiB = await writeGroovy(root, "api", "ApiB", `class ApiB { def execute(){ getCommonService("FuncA") } }`);
  await writeGroovy(root, "function", "FuncB", `class FuncB { def execute(){ def x=1 } }`);
  const h = await harness({
    root,
    catalogEntries: [
      { name: "ApiA", type: "api", sourcePath: pApiA },
      { name: "ApiB", type: "api", sourcePath: pApiB },
      { name: "FuncA", type: "function", sourcePath: join(root, "src/dev/Tenant/Group/function/FuncA/FuncA.groovy") },
      { name: "FuncB", type: "function", sourcePath: join(root, "src/dev/Tenant/Group/function/FuncB/FuncB.groovy") },
    ],
    dshHome,
  });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    // multi-start substring match (case-insensitive)
    const q1: any = await h.engine.queryApi({ workspaceId: "ws1", query: "api" });
    assert.equal(q1.ok, true);
    if (q1.ok) {
      assert.deepEqual(q1.value.matched.sort(), ["api:ApiA", "api:ApiB"]);
      assert.equal(q1.value.roots.length, 2);
      assert.equal(q1.value.stale, undefined);
      const rootA = q1.value.roots.find((r: any) => r.id === "api:ApiA");
      assert.ok(rootA);
      // depth 1: only direct children of the root
      const q2: any = await h.engine.queryApi({ workspaceId: "ws1", query: "ApiA", depth: 1 });
      assert.equal(q2.ok, true);
      if (q2.ok) {
        const root = q2.value.roots[0];
        assert.ok(root.children!.some(c => c.id === "method:ApiA.execute" && c.edge?.kind === "CONTAINS"));
        for (const child of root.children!) assert.equal(child.children, undefined);
      }
      // focus filter: subtree through function:FuncA
      const q3: any = await h.engine.queryApi({ workspaceId: "ws1", query: "ApiA", focus: "FuncA" });
      assert.equal(q3.ok, true);
      if (q3.ok) {
        const root = q3.value.roots[0];
        const exec = root.children!.find(c => c.id === "method:ApiA.execute");
        assert.ok(exec);
        assert.ok(exec.children!.some(c => c.id === "function:FuncA"));
      }
    }
    // no-match carries candidates
    const q4: any = await h.engine.queryApi({ workspaceId: "ws1", query: "NoSuchThing" });
    assert.equal(q4.ok, false);
    if (!q4.ok) {
      assert.equal(q4.error.code, "no-match");
      assert.ok(q4.error.message.includes("candidates:"));
    }
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("queryImpact: upstream path to api with redundancy compression and confidence counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-imp-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-imp-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "ApiA");
  await writeMeta(root, "function", "FuncA");
  const pApiA = await writeGroovy(root, "api", "ApiA", `
class ApiA {
  def execute() {
    def svc = getCommonService("FuncA")
    svc.process()
  }
}
`);
  const pFuncA = await writeGroovy(root, "function", "FuncA", `
class FuncA {
  def process() {
    this.inner()
  }
  def inner() { def x=1 }
}
`);
  const h = await harness({
    root,
    catalogEntries: [
      { name: "ApiA", type: "api", sourcePath: pApiA },
      { name: "FuncA", type: "function", sourcePath: pFuncA },
    ],
    dshHome,
  });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    const res: any = await h.engine.queryImpact({ workspaceId: "ws1", query: "FuncA" });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(res.value.matched.includes("function:FuncA"));
      assert.ok(res.value.paths.some((p: any) => p.apiId === "api:ApiA"));
      const path = res.value.paths.find((p: any) => p.apiId === "api:ApiA");
      const ids = path.hops.map((h: any) => h.nodeId);
      // path starts at the queried function and ends at the api
      assert.equal(ids[0], "function:FuncA");
      assert.equal(ids[ids.length - 1], "api:ApiA");
      // redundancy compression: method:FuncA.process is reached via CONTAINS
      // from function:FuncA, not via a duplicate CALLS hop from ApiA.execute
      // (execute already CALLS function:FuncA directly).
      const viaCalls = path.hops.filter((h: any) => h.nodeId === "method:FuncA.process" && h.edge?.kind === "CALLS");
      assert.equal(viaCalls.length, 0);
      assert.ok(res.value.confidenceCounts.static > 0);
    }
    // impact starts accept function/method nodes; substring match also hits
    // methods whose owner id carries the query (method:ApiA.execute).
    const viaMethod: any = await h.engine.queryImpact({ workspaceId: "ws1", query: "ApiA" });
    assert.equal(viaMethod.ok, true);
    if (viaMethod.ok) assert.ok(viaMethod.value.matched.includes("method:ApiA.execute"));
    // truly unmatched query is no-match
    const bad: any = await h.engine.queryImpact({ workspaceId: "ws1", query: "NoSuchThing" });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error.code, "no-match");
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("query gates: no-snapshot before build, dispose, cancel; maxNodes truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-qg-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-qg-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "A1");
  const p = await writeGroovy(root, "api", "A1", `class A1 { def execute(){ getCommonService("A1") } }`);
  const h = await harness({ root, catalogEntries: [{ name: "A1", type: "api", sourcePath: p }], dshHome });
  try {
    // no snapshot yet
    const before: any = await h.engine.queryApi({ workspaceId: "ws1", query: "A1" });
    assert.equal(before.ok, false);
    if (!before.ok) {
      assert.equal(before.error.code, "no-snapshot");
      assert.ok(before.error.message.includes("build"));
    }
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    // maxNodes truncation: budget 1 → root only + truncated flag + boundary list
    const q: any = await h.engine.queryApi({ workspaceId: "ws1", query: "A1", maxNodes: 1 });
    assert.equal(q.ok, true);
    if (q.ok) {
      assert.equal(q.value.truncated, true);
      assert.ok(q.value.truncatedAt.length > 0);
      assert.equal(q.value.roots[0].children, undefined);
    }
    // dispose
    const captured = h.ctx.get("iciEngine") as IciEngineService;
    await h.fiber.dispose();
    const after: any = await captured.queryApi({ workspaceId: "ws1", query: "A1" });
    assert.equal(after.ok, false);
    if (!after.ok) assert.equal(after.error.code, "service-disposed");
  } finally {
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("stale detection: content change after build marks queries stale", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-stale-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-stale-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "A1");
  const p = await writeGroovy(root, "api", "A1", `class A1 { def execute(){ def x=1 } }`);
  const h = await harness({ root, catalogEntries: [{ name: "A1", type: "api", sourcePath: p }], dshHome });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    const fresh: any = await h.engine.queryApi({ workspaceId: "ws1", query: "A1" });
    assert.equal(fresh.value.stale, undefined);
    // modify groovy content (fingerprint is content-based)
    await writeFile(p, `class A1 { def execute(){ def y=2 } }`, "utf8");
    const staleRes: any = await h.engine.queryApi({ workspaceId: "ws1", query: "A1" });
    assert.equal(staleRes.ok, true);
    assert.equal(staleRes.value.stale, true);
    const staleImpact: any = await h.engine.queryImpact({ workspaceId: "ws1", query: "A1" });
    assert.equal(staleImpact.ok, true);
    assert.equal(staleImpact.value.stale, true);
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("real ssapocpa query smoke: known API downstream tree, function impact to api, stale via manifest injection", async () => {
  const projectRoot = "/Users/junjie.zhang/skills/ssapocpa";
  const dshHome = await mkdtemp(join(tmpdir(), "ici-qsmoke-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  const { scanWorkspace } = await import("../../icomposer-catalog/src/scan.ts");
  const scan = await scanWorkspace(projectRoot);
  const entries = scan.entries.map(e => ({ name: e.name, type: e.type, sourcePath: (e as any).sourcePath }));
  const h = await harness({ root: projectRoot, catalogEntries: entries, dshHome });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    // known API: SearchPaymentAPI downstream tree is non-empty
    const api: any = await h.engine.queryApi({ workspaceId: "ws1", query: "SearchPaymentAPI" });
    assert.equal(api.ok, true);
    if (api.ok) {
      assert.ok(api.value.matched.some((m: string) => m === "api:SearchPaymentAPI"));
      const root = api.value.roots.find((r: any) => r.id === "api:SearchPaymentAPI");
      assert.ok(root);
      assert.ok((root.children ?? []).length > 0);
    }
    // known function impact reaches an api layer
    const impact: any = await h.engine.queryImpact({ workspaceId: "ws1", query: "SearchPaymentAPI" });
    assert.equal(impact.ok, true);
    if (impact.ok) {
      // substring semantics match methods of the API as starts; at least one
      // path must terminate at an api node.
      assert.ok(impact.value.paths.length > 0);
      assert.ok(impact.value.paths.every((p: any) => p.apiId.startsWith("api:")));
      const total = Object.values(impact.value.confidenceCounts).reduce((a: number, b: number) => a + b, 0);
      assert.ok(total > 0);
    }
    // stale trigger WITHOUT touching the real dir: tamper the snapshot manifest
    const base = graphBaseDir(projectRoot, "ws1");
    const manifestPath = join(currentDir(base), "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.sourceFingerprint = "0".repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const staleRes: any = await h.engine.queryApi({ workspaceId: "ws1", query: "SearchPaymentAPI" });
    assert.equal(staleRes.ok, true);
    assert.equal(staleRes.value.stale, true);
  } finally {
    await h.dispose();
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});
