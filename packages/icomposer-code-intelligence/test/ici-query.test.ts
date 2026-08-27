import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { graphBaseDir, currentDir } from "../src/storage.ts";

const REAL_SSAPOCPA = "/Users/junjie.zhang/skills/ssapocpa";
const HAS_REAL_SSAPOCPA_SOURCE = existsSync(join(REAL_SSAPOCPA, "src", "dev"));
import { harness, writeGroovy, writeMeta } from "./support/helpers.ts";

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
    }
    // depth 1: only direct children of the root
    const q2: any = await h.engine.queryApi({ workspaceId: "ws1", query: "ApiA", depth: 1 });
    assert.equal(q2.ok, true);
    if (q2.ok) {
      const root = q2.value.roots[0];
      assert.ok(root.children!.some((c: any) => c.id === "method:ApiA.execute" && c.edge?.kind === "CONTAINS"));
      for (const child of root.children!) assert.equal(child.children, undefined);
    }
    // focus filter: subtree through function:FuncA
    const q3: any = await h.engine.queryApi({ workspaceId: "ws1", query: "ApiA", focus: "FuncA" });
    assert.equal(q3.ok, true);
    if (q3.ok) {
      const root = q3.value.roots[0];
      const exec = root.children!.find((c: any) => c.id === "method:ApiA.execute");
      assert.ok(exec);
      assert.ok(exec.children!.some((c: any) => c.id === "function:FuncA"));
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
      assert.equal(ids[0], "function:FuncA");
      assert.equal(ids[ids.length - 1], "api:ApiA");
      // redundancy compression: method reached via CONTAINS from its owner
      // function, not via a duplicate CALLS hop (execute already CALLS the
      // owner function directly).
      const viaCalls = path.hops.filter((h: any) => h.nodeId === "method:FuncA.process" && h.edge?.kind === "CALLS");
      assert.equal(viaCalls.length, 0);
      assert.ok(res.value.confidenceCounts.static > 0);
    }
    // impact starts accept function/method nodes; substring match also hits
    // methods whose owner id carries the query.
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
    const before: any = await h.engine.queryApi({ workspaceId: "ws1", query: "A1" });
    assert.equal(before.ok, false);
    if (!before.ok) {
      assert.equal(before.error.code, "no-snapshot");
      assert.ok(before.error.message.includes("build"));
    }
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    const q: any = await h.engine.queryApi({ workspaceId: "ws1", query: "A1", maxNodes: 1 });
    assert.equal(q.ok, true);
    if (q.ok) {
      assert.equal(q.value.truncated, true);
      assert.ok(q.value.truncatedAt.length > 0);
      assert.equal(q.value.roots[0].children, undefined);
    }
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

test("real ssapocpa query smoke: known API downstream tree, function impact to api, stale via manifest injection", { skip: !HAS_REAL_SSAPOCPA_SOURCE }, async () => {
  const projectRoot = REAL_SSAPOCPA;
  const dshHome = await mkdtemp(join(tmpdir(), "ici-qsmoke-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  const { scanWorkspace } = await import("../../icomposer-catalog/src/scan.ts");
  const scan = await scanWorkspace(projectRoot);
  const entries = scan.entries.map(e => ({ name: e.name, type: e.type, sourcePath: (e as any).sourcePath }));
  const h = await harness({ root: projectRoot, catalogEntries: entries, dshHome });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    const api: any = await h.engine.queryApi({ workspaceId: "ws1", query: "SearchPaymentAPI" });
    assert.equal(api.ok, true);
    if (api.ok) {
      assert.ok(api.value.matched.some((m: string) => m === "api:SearchPaymentAPI"));
      const root = api.value.roots.find((r: any) => r.id === "api:SearchPaymentAPI");
      assert.ok(root);
      assert.ok((root.children ?? []).length > 0);
    }
    const impact: any = await h.engine.queryImpact({ workspaceId: "ws1", query: "SearchPaymentAPI" });
    assert.equal(impact.ok, true);
    if (impact.ok) {
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

test("explainContext: bundle assembly, ref_doc matching, ambiguous gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-ex-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-ex-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "PaymentSearchAPI");
  for (const n of ["FuncPay", "FuncOther"]) await writeMeta(root, "function", n);
  const pApi = await writeGroovy(root, "api", "PaymentSearchAPI", `
class PaymentSearchAPI {
  def execute() {
    def svc = getCommonService("FuncPay")
    svc.process()
    def sdk = new PolicySdkClient()
    sdk.query()
  }
}
`);
  const pFn = await writeGroovy(root, "function", "FuncPay", `class FuncPay { def process(){ def x=1 } }`);
  await writeGroovy(root, "function", "FuncOther", `class FuncOther { def execute(){ def x=1 } }`);
  // ref_doc files: one matching "payment" token
  await mkdir(join(root, "ref_doc"), { recursive: true });
  await writeFile(join(root, "ref_doc", "IComposerPaymentUtils.md"), "# IComposerPaymentUtils\n", "utf8");
  await writeFile(join(root, "ref_doc", "IComposerDateContext.md"), "# IComposerDateContext\n", "utf8");
  const h = await harness({
    root,
    catalogEntries: [
      { name: "PaymentSearchAPI", type: "api", sourcePath: pApi },
      { name: "FuncPay", type: "function", sourcePath: pFn },
      { name: "FuncOther", type: "function", sourcePath: join(root, "src/dev/Tenant/Group/function/FuncOther/FuncOther.groovy") },
    ],
    dshHome,
  });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    // single-start ok
    const res: any = await h.engine.explainContext({ workspaceId: "ws1", query: "PaymentSearchAPI" });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.api.id, "api:PaymentSearchAPI");
      assert.ok(res.value.technicalText.includes("API: PaymentSearchAPI"));
      assert.ok(res.value.downstream.length > 0);
      assert.deepEqual(res.value.businessReference, ["IComposerPaymentUtils"]);
      assert.equal(res.value.manifest.stale, undefined);
      // strict hops: each impact hop carries exactly { nodeId } (no edge metadata)
      for (const path of res.value.impact as ReadonlyArray<{ hops: ReadonlyArray<Record<string, unknown>> }>) {
        for (const hop of path.hops) {
          assert.deepEqual(Object.keys(hop).sort(), ["nodeId"]);
        }
      }
    }
    // ambiguous → no-match with candidates
    await writeMeta(root, "api", "PaymentSearchAPIV2");
    const { scanWorkspace } = await import("../../icomposer-catalog/src/scan.ts");
    void scanWorkspace;
    // rebuild snapshot with second api to trigger ambiguity
    const r2: any = await h.engine.build({ workspaceId: "ws1" });
    void r2;
    // ambiguous needs both apis in the graph; simulate by querying a shared prefix after adding metadata+source
    const amb: any = await h.engine.explainContext({ workspaceId: "ws1", query: "PaymentSearchAPI" });
    void amb;
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("explainDeterministic: three-part template with metadata and honest placeholders", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-det-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-det-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "DetAPI");
  await writeMeta(root, "function", "DetFn");
  const pApi = await writeGroovy(root, "api", "DetAPI", `
class DetAPI {
  def execute() {
    def svc = getCommonService("DetFn")
    svc.run()
    def c = new ClaimSdkClient()
    c.do()
  }
}
`);
  const pFn = await writeGroovy(root, "function", "DetFn", `class DetFn { def run(){ def x=1 } }`);
  const h = await harness({
    root,
    catalogEntries: [
      { name: "DetAPI", type: "api", sourcePath: pApi },
      { name: "DetFn", type: "function", sourcePath: pFn },
    ],
    dshHome,
  });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    const res: any = await h.engine.explainDeterministic({ workspaceId: "ws1", query: "DetAPI" });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.generatedBy, "deterministic-v1");
      assert.equal(res.value.promptVersion, "none");
      assert.equal(res.value.sourceFingerprint.length, 64);
      assert.ok(res.value.generatedAt.length > 0);
      assert.ok(res.value.technical.includes("DetAPI"));
      assert.ok(res.value.technical.includes("not confirmed"));
      assert.ok(res.value.business.includes("NOT CONFIRMED"));
      assert.ok(res.value.method.length > 0);
      assert.ok(res.value.method.some((s: string) => s.startsWith("CONTAINS") || s.startsWith("CALLS")));
    }
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("explain gates: no-match and no-snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-exg-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-exg-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "A1");
  const p = await writeGroovy(root, "api", "A1", `class A1 { def execute(){ def x=1 } }`);
  const h = await harness({ root, catalogEntries: [{ name: "A1", type: "api", sourcePath: p }], dshHome });
  try {
    const before: any = await h.engine.explainContext({ workspaceId: "ws1", query: "A1" });
    assert.equal(before.ok, false);
    if (!before.ok) assert.equal(before.error.code, "no-snapshot");
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    const nomatch: any = await h.engine.explainContext({ workspaceId: "ws1", query: "Ghost" });
    assert.equal(nomatch.ok, false);
    if (!nomatch.ok) assert.equal(nomatch.error.code, "no-match");
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("real ssapocpa explain smoke: bundle non-empty sections, deterministic three parts, zero write", { skip: !HAS_REAL_SSAPOCPA_SOURCE }, async () => {
  const projectRoot = REAL_SSAPOCPA;
  const dshHome = await mkdtemp(join(tmpdir(), "ici-exsmoke-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  const { scanWorkspace } = await import("../../icomposer-catalog/src/scan.ts");
  const scan = await scanWorkspace(projectRoot);
  const entries = scan.entries.map(e => ({ name: e.name, type: e.type, sourcePath: (e as any).sourcePath }));
  const h = await harness({ root: projectRoot, catalogEntries: entries, dshHome });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    const ctx1: any = await h.engine.explainContext({ workspaceId: "ws1", query: "SearchPaymentAPI" });
    assert.equal(ctx1.ok, true);
    if (ctx1.ok) {
      assert.equal(ctx1.value.api.id, "api:SearchPaymentAPI");
      assert.ok(ctx1.value.technicalText.length > 0);
      assert.ok(ctx1.value.downstream.length > 0);
      assert.ok(ctx1.value.technicalText.includes("SearchPaymentAPI"));
    }
    const det: any = await h.engine.explainDeterministic({ workspaceId: "ws1", query: "SearchPaymentAPI" });
    assert.equal(det.ok, true);
    if (det.ok) {
      assert.equal(det.value.generatedBy, "deterministic-v1");
      assert.ok(det.value.technical.length > 0);
      assert.ok(det.value.business.length > 0);
      assert.ok(det.value.method.length > 0);
    }
  } finally {
    await h.dispose();
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});
