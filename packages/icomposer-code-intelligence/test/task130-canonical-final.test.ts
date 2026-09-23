import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph } from "../src/graph.ts";
import {
  canonicalFinalArtifactPath, computeGraphDigest, createJobRecord, finalizeExplain, loadPrepare, prepareExplain,
  readExplainPublicationState, restoreExplainPublicationState, setExplainWriteFailpoint, updateJobRecord,
} from "../src/explain-artifacts.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";
import { loadSearchDocs } from "../src/search-runtime.ts";
import { immutableFinalPath, readValidatedExplainFinal } from "@icomposer/workbench-contracts/ici-explain";

/**
 * TASK-130: every publication also maintains the canonical `<slug>/final.json`, while the immutable
 * `finals/<id>.json` history stays untouched. Readers prefer the canonical copy and fall back to the
 * recorded immutable file, so a legacy workspace (or a rolled-back publication) still reads.
 */

const workspaceId = "task130";
const API = "ReduceSAAPI";
const EVIDENCE = ["src/dev/Tenant/STD_BS_PA_BUSINESS/api/ReduceSAAPI/ReduceSAAPI.groovy#1"];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task130-canonical-"));
  const dir = join(root, "src/dev/Tenant/STD_BS_PA_BUSINESS/api/ReduceSAAPI");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "ReduceSAAPI.groovy"), "class ReduceSAAPI {\n  def execute() { return String.valueOf(1) }\n}\n");
  const raw = await buildGraph(root, [{ name: API, type: "api", sourcePath: join(dir, "ReduceSAAPI.groovy") }]);
  const graph: any = { nodes: new Map(raw.nodes.map((node: any) => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64) } };
  const graphDir = join(root, ".metadata/icomposer/ici/graph/current"); await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  return { root, dir, graph, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function publish(fx: { root: string; graph: any }, technical: string, finalId: string, preparePath?: string) {
  const prepared = preparePath === undefined ? await prepareExplain(fx.root, workspaceId, fx.graph, fx.graph.nodes.get(`api:${API}`), []) : undefined;
  const artifactPath = preparePath ?? prepared!.artifactPath;
  const prepare = await loadPrepare(fx.root, artifactPath);
  return finalizeExplain(fx.root, workspaceId, artifactPath, { api: { technical, business: "business", flow: ["API returns a value"], evidence: EVIDENCE } }, { sourceFingerprint: prepare.manifest.sourceFingerprint, graphDigest: prepare.manifest.graphDigest, engineVersion: ICI_ENGINE_VERSION }, undefined, finalId);
}

test("TASK-130 (1) a publication writes the canonical final.json next to the immutable history file", async () => {
  const fx = await fixture();
  try {
    const result = await publish(fx, "first", "aaaa000000000001");
    const canonical = canonicalFinalArtifactPath(API);
    assert.equal(result.artifactPath, canonical, "the write side returns the canonical path");
    assert.equal(existsSync(join(fx.root, canonical)), true, "canonical file exists");
    const canonicalText = await readFile(join(fx.root, canonical), "utf8");
    const historyText = await readFile(join(fx.root, immutableFinalPath(API, "aaaa000000000001")), "utf8");
    assert.equal(canonicalText, historyText, "canonical copy is byte-identical to the immutable publication");
    const state: any = await readExplainPublicationState(fx.root);
    assert.equal(state.artifactPath, canonical, "state points at the canonical path");
    const read = await readValidatedExplainFinal(fx.root, API, workspaceId);
    assert.equal(read?.artifactPath, canonical, "the reader prefers the canonical path");
    assert.equal(read?.final.apiAnalysis.technical, "first");
  } finally { await fx.cleanup(); }
});

test("TASK-130 (2) republishing replaces the canonical copy and keeps every immutable publication", async () => {
  const fx = await fixture();
  try {
    await publish(fx, "first", "aaaa000000000001");
    await publish(fx, "second", "bbbb000000000002");
    const canonical = canonicalFinalArtifactPath(API);
    const canonicalRead = JSON.parse(await readFile(join(fx.root, canonical), "utf8"));
    assert.equal(canonicalRead.apiAnalysis.technical, "second", "the canonical copy carries the newest result");
    assert.equal(existsSync(join(fx.root, immutableFinalPath(API, "aaaa000000000001"))), true, "the older publication is retained");
    assert.equal(existsSync(join(fx.root, immutableFinalPath(API, "bbbb000000000002"))), true);
    const first = JSON.parse(await readFile(join(fx.root, immutableFinalPath(API, "aaaa000000000001")), "utf8"));
    assert.equal(first.apiAnalysis.technical, "first", "history files are immutable");
    assert.equal((await readValidatedExplainFinal(fx.root, API, workspaceId))?.final.apiAnalysis.technical, "second");
  } finally { await fx.cleanup(); }
});

test("TASK-130 (3) a legacy workspace without final.json reads exactly as before", async () => {
  const fx = await fixture();
  try {
    await publish(fx, "first", "aaaa000000000001");
    // Simulate the legacy layout: only the immutable publication + the state that records it.
    await rm(join(fx.root, canonicalFinalArtifactPath(API)), { force: true });
    // A legacy workspace records the immutable publication path directly (that is what the previous
    // release wrote); the canonical file simply does not exist there.
    const legacyState = { ...(await rawState(fx)), artifactPath: immutableFinalPath(API, "aaaa000000000001") };
    await writeFile(join(fx.root, ".metadata/icomposer/ici/explain/state.json"), `${JSON.stringify(legacyState, null, 2)}\n`);
    const read = await readValidatedExplainFinal(fx.root, API, workspaceId);
    assert.notEqual(read, null, "the legacy layout stays readable");
    assert.equal(read?.artifactPath, immutableFinalPath(API, "aaaa000000000001"), "fallback uses the recorded publication");
    assert.equal(read?.final.apiAnalysis.technical, "first");
    assert.equal(existsSync(join(fx.root, canonicalFinalArtifactPath(API))), false, "reading never migrates or writes");
  } finally { await fx.cleanup(); }
});

test("TASK-130 (4) a canonical copy that disagrees with the state is never served", async () => {
  const fx = await fixture();
  try {
    await publish(fx, "first", "aaaa000000000001");
    await publish(fx, "second", "bbbb000000000002");
    // Roll the state back to the first publication: the canonical copy (second) must not be served.
    const state: any = await rawState(fx);
    const firstState = { ...state, artifactPath: immutableFinalPath(API, "aaaa000000000001"), finalDigest: await digestOf(fx, immutableFinalPath(API, "aaaa000000000001")) };
    await writeFile(join(fx.root, ".metadata/icomposer/ici/explain/state.json"), `${JSON.stringify(firstState, null, 2)}\n`);
    const read = await readValidatedExplainFinal(fx.root, API, workspaceId);
    assert.notEqual(read, null, "the recorded publication is still served");
    assert.equal(read?.artifactPath, immutableFinalPath(API, "aaaa000000000001"));
    assert.equal(read?.final.apiAnalysis.technical, "first", "a stale canonical copy is skipped");
  } finally { await fx.cleanup(); }
});

test("TASK-130 (5) a failed canonical write fails the whole publication and restores both sides", async () => {
  const fx = await fixture();
  try {
    await publish(fx, "first", "aaaa000000000001");
    const before = await readValidatedExplainFinal(fx.root, API, workspaceId);
    const canonical = canonicalFinalArtifactPath(API);
    const canonicalBefore = await readFile(join(fx.root, canonical), "utf8");
    setExplainWriteFailpoint((path) => { if (path === canonical) throw new Error("canonical-boom"); });
    await assert.rejects(() => publish(fx, "second", "bbbb000000000002"), /canonical-boom/);
    setExplainWriteFailpoint(undefined);
    const after = await readValidatedExplainFinal(fx.root, API, workspaceId);
    assert.equal(after?.artifactPath, before?.artifactPath, "the previous publication is still the current one");
    assert.equal(after?.final.apiAnalysis.technical, "first");
    assert.equal(await readFile(join(fx.root, canonical), "utf8"), canonicalBefore, "the canonical copy is restored byte-for-byte");
    // The failed attempt left no half-written state: readiness and the recorded file agree.
    const state: any = await readExplainPublicationState(fx.root);
    assert.equal(state.finalDigest, before?.state.finalDigest);
  } finally { setExplainWriteFailpoint(undefined); await fx.cleanup(); }
});

test("TASK-130 (6) a rollback removes or restores the canonical copy so the rolled-back result is served", async () => {
  const fx = await fixture();
  try {
    const first = await publish(fx, "first", "aaaa000000000001");
    const firstState: any = await readExplainPublicationState(fx.root);
    await publish(fx, "second", "bbbb000000000002");
    // Roll the publication state back to the first result and repair the canonical copy the same way
    // the publication rollback does.
    await writeFile(join(fx.root, ".metadata/icomposer/ici/explain/state.json"), `${JSON.stringify(firstState, null, 2)}\n`);
    await restoreExplainPublicationState(fx.root, firstState);
    const read = await readValidatedExplainFinal(fx.root, API, workspaceId);
    assert.notEqual(read, null, "the rolled-back publication is readable");
    assert.equal(read?.final.apiAnalysis.technical, "first");
    const canonicalText = await readFile(join(fx.root, canonicalFinalArtifactPath(API)), "utf8").catch(() => null);
    if (canonicalText !== null) {
      assert.equal(JSON.parse(canonicalText).apiAnalysis.technical, "first", "a kept canonical copy matches the restored state");
    }
    assert.equal(JSON.parse(await readFile(join(fx.root, immutableFinalPath(API, "aaaa000000000001")), "utf8")).apiAnalysis.technical, "first");
    assert.equal(first.artifactPath, canonicalFinalArtifactPath(API));
  } finally { await fx.cleanup(); }
});

test("TASK-130 (7) search docs are identical for the canonical and the legacy layout", async () => {
  const fx = await fixture();
  try {
    await publish(fx, "first", "aaaa000000000001");
    const searchGraph = { nodes: new Map([[`api:${API}`, { id: `api:${API}`, kind: "api", name: API }]]), edges: [], manifest: { workspaceId } } as any;
    const withCanonical = await loadSearchDocs(fx.root, searchGraph);
    await rm(join(fx.root, canonicalFinalArtifactPath(API)), { force: true });
    const legacyState = { ...(await rawState(fx)), artifactPath: immutableFinalPath(API, "aaaa000000000001") };
    await writeFile(join(fx.root, ".metadata/icomposer/ici/explain/state.json"), `${JSON.stringify(legacyState, null, 2)}\n`);
    const legacy = await loadSearchDocs(fx.root, searchGraph);
    assert.equal(withCanonical.length, 1);
    assert.deepEqual(legacy, withCanonical, "the search surface does not depend on the layout");
  } finally { await fx.cleanup(); }
});

/** The publication state exactly as it is on disk (no validation, so a legacy rewrite can be built). */
async function rawState(fx: { root: string }): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(fx.root, ".metadata/icomposer/ici/explain/state.json"), "utf8"));
}

async function digestOf(fx: { root: string }, relPath: string): Promise<string> {
  const value = JSON.parse(await readFile(join(fx.root, relPath), "utf8"));
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(JSON.stringify({ ...value, generatedAt: undefined })).digest("hex");
}
