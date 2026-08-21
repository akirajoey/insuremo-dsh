import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stat } from "node:fs/promises";
import { graphBaseDir, currentDir } from "../src/storage.ts";
import { harness, writeGroovy, writeMeta } from "./support/helpers.ts";

test("STD_DISCARD paths produce zero nodes/edges/placeholders", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-discard-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-discard-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "KeepAPI");
  const keepPath = await writeGroovy(root, "api", "KeepAPI", `class KeepAPI { def execute(){ def x=1 } }`);
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
    const nodes = JSON.parse(await readFile(join(currentDir(base), "nodes.json"), "utf8"));
    assert.deepEqual(nodes, [{ id: "n1" }]);
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
  const { scanWorkspace } = await import("../../icomposer-catalog/src/scan.ts");
  const scan = await scanWorkspace(projectRoot);
  const entries = scan.entries.map(e => ({ name: e.name, type: e.type, sourcePath: (e as any).sourcePath }));
  const h = await harness({ root: projectRoot, catalogEntries: entries, dshHome });
  try {
    const res: any = await h.engine.build({ workspaceId: "ws1" });
    assert.equal(res.ok, true);
    assert.ok(res.value.nodes.length >= 459);
    assert.ok(res.value.edges.length > 0);
    assert.equal(res.value.manifest.schemaVersion, 1);
    const kept = (await findCount(join(projectRoot, "src", "dev"), (n) => n.endsWith(".groovy"), "STD_DISCARD"));
    const totalGroovy = (await findCount(join(projectRoot, "src", "dev"), (n) => n.endsWith(".groovy")));
    assert.equal(totalGroovy - kept, 24); // 478 total - 454 kept = 24 STD_DISCARD
    for (const node of res.value.nodes) {
      assert.equal(String((node as any).sourceFile ?? "").includes("STD_DISCARD"), false, `node ${(node as any).id} references a discarded path`);
    }
    for (const edge of res.value.edges) {
      assert.equal(String((edge as any).ownerFile ?? "").includes("STD_DISCARD"), false, `edge ${(edge as any).id} references a discarded path`);
      if ((edge as any).source === "inferred") {
        assert.ok(res.value.nodes.some((n: any) => n.id === (edge as any).to), `dangling inferred edge to ${(edge as any).to}`);
      }
    }
    console.log(`[ici] real build nodes=${res.value.nodes.length} edges=${res.value.edges.length} groovyTotal=${totalGroovy} groovyKept=${kept}`);
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

// ---- TASK-026: diagnostics + cleanup ----

test("diagnostics: counts, staleness, required files, index paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-diag-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-diag-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "A1");
  const p = await writeGroovy(root, "api", "A1", `class A1 { def execute(){ def x=1 } }`);
  const h = await harness({ root, catalogEntries: [{ name: "A1", type: "api", sourcePath: p }], dshHome });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    const diag: any = await h.engine.diagnostics({ workspaceId: "ws1" });
    assert.equal(diag.ok, true);
    if (diag.ok) {
      assert.equal(diag.value.workspaceId, "ws1");
      assert.equal(diag.value.schemaVersion, 1);
      assert.equal(diag.value.engineVersion, "0.1.0");
      assert.ok(diag.value.nodeCount >= 1);
      assert.equal(diag.value.stale, false);
      assert.deepEqual(diag.value.requiredFiles, { nodes: true, edges: true, manifest: true });
      assert.ok(diag.value.indexPaths.graphCurrent.includes(join("ici", "")) || diag.value.indexPaths.graphCurrent.includes("ici"));
      assert.ok(diag.value.builtAt !== null);
    }
    // stale after content change
    await writeFile(p, `class A1 { def execute(){ def y=2 } }`, "utf8");
    const diag2: any = await h.engine.diagnostics({ workspaceId: "ws1" });
    if (diag2.ok) assert.equal(diag2.value.stale, true);
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("cleanupPlan lists injected residue; cleanupApply removes exactly those; foreign paths skipped", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-cln-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-cln-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "A1");
  const p = await writeGroovy(root, "api", "A1", `class A1 { def execute(){ def x=1 } }`);
  const h = await harness({ root, catalogEntries: [{ name: "A1", type: "api", sourcePath: p }], dshHome });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    // inject residue exactly like the promote would leave behind
    const base = graphBaseDir(root, "ws1");
    const residueA = join(base, "staging-1700000000-abc");
    const residueB = join(base, "stale-1700000001-def");
    await mkdir(residueA, { recursive: true });
    await writeFile(join(residueA, "nodes.json"), "[]", "utf8");
    await mkdir(residueB, { recursive: true });

    const plan: any = await h.engine.cleanupPlan({ workspaceId: "ws1" });
    assert.equal(plan.ok, true);
    if (plan.ok) {
      assert.ok(plan.value.paths.includes(residueA));
      assert.ok(plan.value.paths.includes(residueB));
      assert.equal(plan.value.paths.length, 2);
    }
    // apply with a foreign path mixed in → foreign skipped
    const foreign = join(root, "src", "dev", "Tenant", "Group", "api", "A1", "A1.groovy");
    const apply: any = await h.engine.cleanupApply({
      workspaceId: "ws1",
      expectedPaths: [residueA, residueB, foreign],
    });
    assert.equal(apply.ok, true);
    if (apply.ok) {
      assert.deepEqual(apply.value.removed.sort(), [residueA, residueB].sort());
      assert.deepEqual(apply.value.skipped, [foreign]);
    }
    // residue gone; source file untouched
    const stillThere = await readFile(foreign, "utf8");
    assert.ok(stillThere.includes("class A1"));
    // idempotent second apply: nothing left to remove
    const apply2: any = await h.engine.cleanupApply({ workspaceId: "ws1", expectedPaths: [residueA] });
    if (apply2.ok) assert.equal(apply2.value.removed.length, 0);
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("real ssapocpa ici_status smoke: 4502 nodes / 10308 edges / stale flag; cleanup clears injected staging residue", async () => {
  const projectRoot = "/Users/junjie.zhang/skills/ssapocpa";
  const dshHome = await mkdtemp(join(tmpdir(), "ici-stsmoke-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  const { scanWorkspace } = await import("../../icomposer-catalog/src/scan.ts");
  const scan = await scanWorkspace(projectRoot);
  const entries = scan.entries.map(e => ({ name: e.name, type: e.type, sourcePath: (e as any).sourcePath }));
  const h = await harness({ root: projectRoot, catalogEntries: entries, dshHome });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    const diag: any = await h.engine.diagnostics({ workspaceId: "ws1" });
    assert.equal(diag.ok, true);
    if (diag.ok) {
      assert.equal(diag.value.nodeCount, 4502);
      assert.equal(diag.value.edgeCount, 10308);
      assert.equal(diag.value.stale, false);
      assert.equal(diag.value.schemaVersion, 1);
      assert.deepEqual(diag.value.requiredFiles, { nodes: true, edges: true, manifest: true });
    }
    // inject staging residue into the isolated DSH_HOME and clear via plan+apply
    const base = graphBaseDir(projectRoot, "ws1");
    const residue = join(base, "staging-1700000000-injected");
    await mkdir(residue, { recursive: true });
    const plan: any = await h.engine.cleanupPlan({ workspaceId: "ws1" });
    assert.equal(plan.ok, true);
    if (plan.ok) {
      assert.equal(plan.value.paths.length, 1);
      assert.equal(plan.value.paths[0], residue);
    }
    const apply: any = await h.engine.cleanupApply({ workspaceId: "ws1", expectedPaths: plan.value.paths });
    assert.equal(apply.ok, true);
    if (apply.ok) {
      assert.equal(apply.value.removed.length, 1);
      assert.equal(apply.value.skipped.length, 0);
    }
    const planAfter: any = await h.engine.cleanupPlan({ workspaceId: "ws1" });
    if (planAfter.ok) assert.equal(planAfter.value.paths.length, 0);
  } finally {
    await h.dispose();
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});
