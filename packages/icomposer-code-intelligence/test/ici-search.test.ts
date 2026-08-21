import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { graphBaseDir, currentDir } from "../src/storage.ts";
import { harness, writeGroovy, writeMeta } from "./support/helpers.ts";

test("fixture 3 api/3 function with method nesting -> nodes/edges golden", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-fixture-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  for (const n of ["ApiA", "ApiB", "ApiC"]) await writeMeta(root, "api", n);
  for (const n of ["FuncA", "FuncB", "FuncC"]) await writeMeta(root, "function", n);
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
    assert.ok(nodes.some((n: any) => n.id === "api:ApiA"));
    assert.ok(nodes.some((n: any) => n.id === "method:ApiA.execute"));
    assert.ok(nodes.some((n: any) => n.id === "method:ApiA.helper"));
    assert.ok(edges.some((e: any) => e.from === "api:ApiA" && e.to === "method:ApiA.execute" && e.kind === "CONTAINS"));
    assert.ok(edges.some((e: any) => e.from === "method:ApiA.execute" && e.to === "function:FuncA" && e.source === "static"));
    assert.ok(edges.some((e: any) => e.from === "method:ApiA.execute" && e.to === "method:FuncA.process"));
    assert.ok(edges.some((e: any) => e.from === "method:ApiA.execute" && e.to === "method:ApiA.helper"));
    assert.ok(edges.some((e: any) => e.source === "inferred" && e.confidence === "inferred"));
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
  const dshHome = await mkdtemp(join(tmpdir(), "ici-rel-dsh-"));
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
    const res: any = await h.engine.build({ workspaceId: "ws1" }, { onProgress: (c: number, t: number, l: string) => calls.push([c, t, l]) });
    assert.equal(res.ok, true);
    assert.ok(calls.length > 0);
    assert.ok(calls.every(([c, t]) => c <= t));
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

// ---- TASK-026: jobs lifecycle (fake registry mirrors ctx.jobs.start) ----

interface CapturedJob {
  kind: string;
  label: string;
  hooks: {
    cancel(reason?: string): void;
    done: Promise<{ status: "completed" | "killed" | "failed"; detail?: string }>;
    readOutput?(): string;
  };
}

function jobsRegistry(captured: CapturedJob[]) {
  return {
    start(spec: { kind: string; label: string; run(): CapturedJob["hooks"] }): string {
      const hooks = spec.run();
      captured.push({ kind: spec.kind, label: spec.label, hooks });
      return `${spec.kind}-1`;
    },
  };
}

test("jobs lifecycle: kill mid-build → outcome killed and current preserved", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-job-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-job-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  await writeMeta(root, "api", "A1");
  const p = await writeGroovy(root, "api", "A1", `class A1 { def execute(){ def x=1 } }`);
  // first: successful build to establish current
  const h = await harness({ root, catalogEntries: [{ name: "A1", type: "api", sourcePath: p }], dshHome });
  try {
    assert.equal((await h.engine.build({ workspaceId: "ws1" })).ok, true);
    const base = graphBaseDir(root, "ws1");
    const manifestBefore = await readFile(join(currentDir(base), "manifest.json"), "utf8");

    // second build via a job that gets killed before completion
    const captured: CapturedJob[] = [];
    const controller = new AbortController();
    const registry = jobsRegistry(captured);
    const jobId = registry.start({
      kind: "ici-build",
      label: "ici-build ws1",
      run() {
        return {
          cancel: (reason?: string) => {
            controller.abort();
            void reason;
          },
          done: h.engine.build({ workspaceId: "ws1" }, { signal: controller.signal }).then((res: any) => {
            if (res.ok) return { status: "completed" as const, detail: `nodes=${res.value.manifest.nodeCount}` };
            if (res.error.code === "cancelled") return { status: "killed" as const, detail: "cancelled" };
            return { status: "failed" as const, detail: res.error.code };
          }),
          readOutput: () => "",
        };
      },
    });
    assert.equal(jobId, "ici-build-1");
    captured[0].hooks.cancel("user requested");
    const outcome = await captured[0].hooks.done;
    assert.equal(outcome.status, "killed");
    // current preserved
    const manifestAfter = await readFile(join(currentDir(base), "manifest.json"), "utf8");
    assert.equal(manifestAfter, manifestBefore);
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("jobs progress: readOutput drains incremental progress lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-jp-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-jp-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  for (const n of ["A1", "A2"]) await writeMeta(root, "api", n);
  const e1 = await writeGroovy(root, "api", "A1", `class A1 { def execute(){ def x=1 } }`);
  const e2 = await writeGroovy(root, "api", "A2", `class A2 { def execute(){ def x=2 } }`);
  const captured: CapturedJob[] = [];
  const h = await harness({
    root,
    catalogEntries: [
      { name: "A1", type: "api", sourcePath: e1 },
      { name: "A2", type: "api", sourcePath: e2 },
    ],
    dshHome,
  });
  try {
    const registry = jobsRegistry(captured);
    registry.start({
      kind: "ici-build",
      label: "ici-build ws1",
      run() {
        const lines: string[] = [];
        const work = h.engine.build({ workspaceId: "ws1" }, {
          onProgress: (c, t, l) => lines.push(`[${c}/${t}] ${l}`),
        });
        return {
          cancel: () => {},
          done: work.then((res: any) => res.ok
            ? { status: "completed" as const, detail: `nodes=${res.value.manifest.nodeCount} edges=${res.value.manifest.edgeCount}` }
            : { status: "failed" as const, detail: res.error.code }),
          readOutput: () => lines.splice(0).join("\n"),
        };
      },
    });
    const outcome = await captured[0].hooks.done;
    assert.equal(outcome.status, "completed");
    assert.match(outcome.detail ?? "", /nodes=\d+ edges=\d+/);
    const output = captured[0].hooks.readOutput!();
    const drained = output.split("\n").filter(Boolean);
    assert.ok(drained.length >= 2);
    assert.ok(drained.every(l => l.startsWith("[")));
    // second read is empty (cursor consumed)
    assert.equal(captured[0].hooks.readOutput!(), "");
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(dshHome, { recursive: true, force: true });
  }
});
