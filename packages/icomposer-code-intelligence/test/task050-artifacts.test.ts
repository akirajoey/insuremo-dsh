import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { harness, writeGroovy, writeMeta } from "./support/helpers.ts";
import {
  explainContextArtifactRelativePath,
  explainContextPath,
  explainStatePath,
  graphBaseDir,
  legacyGraphBaseDir,
  legacyExplainStatePath,
  loadSnapshot,
  readExplainState,
  writeAtomic,
  writeExplainContext,
  writeFileAtomic,
} from "../src/storage.ts";
import { collectFileFacts } from "../src/maintenance.ts";

test("TASK-050 fresh build/explain artifacts stay in workspace metadata, not DSH_HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-artifact-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-artifact-dsh-"));
  await writeMeta(root, "api", "ArtifactApi");
  const sourcePath = await writeGroovy(root, "api", "ArtifactApi", "class ArtifactApi { def execute() { return 1 } }");
  const h = await harness({ root, dshHome, catalogEntries: [{ name: "ArtifactApi", type: "api", sourcePath }] });
  try {
    const build: any = await h.engine.build({ workspaceId: "ws1" });
    assert.equal(build.ok, true);
    assert.equal(build.value.artifactPath, ".metadata/icomposer/ici/graph/current");
    await stat(join(root, build.value.artifactPath, "manifest.json"));
    assert.deepEqual(await readdir(dshHome), []);
    const context: any = await h.engine.explainContext({ workspaceId: "ws1", query: "ArtifactApi" });
    assert.equal(context.ok, true);
    assert.equal(context.value.artifactPath, explainContextArtifactRelativePath("ArtifactApi"));
    const artifact = JSON.parse(await readFile(join(root, context.value.artifactPath), "utf8"));
    assert.equal(artifact.schemaVersion, 2);
    assert.equal(artifact.kind, "context");
    assert.equal(artifact.bundle.manifest.sourceFingerprint, build.value.manifest.sourceFingerprint);
    const state = JSON.parse(await readFile(explainStatePath(root, "ws1"), "utf8"));
    assert.equal(state.artifactPath, context.value.artifactPath);
    assert.equal((await readExplainState(root, "ws1"))?.kind, "context");
    assert.equal(JSON.stringify(artifact).includes(root), false);
    assert.equal(JSON.stringify(artifact).includes("access_token"), false);
    const deterministic: any = await h.engine.explainDeterministic({ workspaceId: "ws1", query: "ArtifactApi" });
    assert.equal(deterministic.ok, true);
    assert.match(deterministic.value.artifactPath, /deterministic\.json$/);
    const longApi = `Long${"x".repeat(220)}`;
    await writeExplainContext(root, longApi, { api: {}, manifest: {}, technicalText: "x", downstream: [], impact: [] });
    assert.equal((await readExplainState(root, "ws1"))?.apiName, longApi);
    const controller = new AbortController();
    controller.abort();
    const cancelled: any = await h.engine.explainDeterministic({ workspaceId: "ws1", query: "ArtifactApi" }, controller.signal);
    assert.equal(cancelled.error.code, "cancelled");
    await rm(join(root, ".metadata", "icomposer", "ici", "explain"), { recursive: true, force: true });
    await writeFile(join(root, ".metadata", "icomposer", "ici", "explain"), "blocked", "utf8");
    const failed: any = await h.engine.explainContext({ workspaceId: "ws1", query: "ArtifactApi" });
    assert.equal(failed.error.code, "storage-error");
  } finally {
    await h.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("TASK-050 new graph snapshot wins over legacy fallback and safe explain slugs do not collide", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-legacy-"));
  const oldBase = legacyGraphBaseDir(root, "ws1");
  const newBase = graphBaseDir(root, "ws1");
  const manifest = { schemaVersion: 1, engineVersion: "0.1.0", sourceFingerprint: "a", builtAt: new Date().toISOString(), nodeCount: 0, edgeCount: 0, workspaceId: "ws1" };
  await writeAtomic(oldBase, manifest, [{ id: "legacy" }], []);
  await writeAtomic(newBase, { ...manifest, sourceFingerprint: "b" }, [{ id: "new" }], []);
  const snapshot: any = await loadSnapshot(newBase, oldBase);
  assert.deepEqual(snapshot.nodes, [{ id: "new" }]);
  const a = explainContextPath(root, "a/b");
  const b = explainContextPath(root, "a b");
  const unicode = explainContextPath(root, "中文");
  assert.notEqual(a, b);
  assert.match(unicode, /api-[0-9a-f]{12}\/context\.json$/);
  await rm(root, { recursive: true, force: true });
});

test("TASK-050 invalid new explain state does not mask as valid legacy state", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-state-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-state-dsh-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  try {
    const legacy = legacyExplainStatePath(root, "ws1");
    await mkdir(join(root, ".metadata", "icomposer", "ici", "explain"), { recursive: true });
    await mkdir(join(legacy, ".."), { recursive: true });
    await writeFile(legacy, JSON.stringify({ schemaVersion: 1, lastExplainAt: "old", apiName: "LegacyApi" }), "utf8");
    await writeFile(explainStatePath(root, "ws1"), JSON.stringify({ schemaVersion: 2, kind: "context", generatedAt: "now", apiName: "Broken", artifactPath: ".metadata/icomposer/ici/explain/Broken/context.json" }), "utf8");
    assert.equal(await readExplainState(root, "ws1"), null);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previous;
    await rm(root, { recursive: true, force: true });
    await rm(dshHome, { recursive: true, force: true });
  }
});

test("TASK-050 diagnostics always prefers new search vectors over legacy graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-search-priority-"));
  const legacy = join(root, "legacy");
  const current = join(root, "current");
  await mkdir(join(legacy, "graph", "search"), { recursive: true });
  await mkdir(join(current, "graph", "search"), { recursive: true });
  await writeFile(join(legacy, "graph", "search", "api_embeddings.jsonl"), '{"id":1}\n', "utf8");
  await writeFile(join(current, "graph", "search", "api_embeddings.jsonl"), '{"id":1}\n{"id":2}\n', "utf8");
  const facts = await collectFileFacts({ workspaceDir: legacy, searchWorkspaceDirs: [current, legacy] });
  assert.equal(facts.searchVectors, 2);
  await rm(root, { recursive: true, force: true });
});

test("TASK-050 aborted atomic artifact writes leave no final or staging file", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-atomic-"));
  const final = join(root, "explain", "state.json");
  const controller = new AbortController();
  await assert.rejects(writeFileAtomic(final, "{}", {
    signal: controller.signal,
    renameFn: async () => { controller.abort(); throw new DOMException("Aborted", "AbortError"); },
  }));
  await assert.rejects(stat(final));
  assert.deepEqual(await readdir(join(root, "explain")), []);
  await rm(root, { recursive: true, force: true });
});
