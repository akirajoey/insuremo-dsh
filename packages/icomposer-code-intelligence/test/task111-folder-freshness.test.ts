import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildGraph } from "../src/graph.ts";
import { computeGraphDigest, finalizeExplain, prepareExplain } from "../src/explain-artifacts.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";

/**
 * TASK-111 FIX-2: the verifier's read-only probe caught a job failing with
 * `folder-changed` inside `finalizeExplain`'s folder re-review. The re-review is a
 * freshness guarantee and stays strict — but the child agent may legitimately read the
 * same reference file more than once (e.g. once before and once after a corrective
 * turn), and an identical re-read is not a change. These tests are the controlled
 * reproduction: duplicate identical reads pass, while ANY changed content, an
 * out-of-target path, or a malformed entry still fails.
 */
const refContent = "reference material for the explanation\n";

async function fixture(): Promise<{ root: string; preparePathRel: string; sha: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "task111-folder-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "ref_doc", "nested"), { recursive: true });
  await writeFile(join(root, "ref_doc", "nested", "meaning.md"), refContent);
  await writeFile(join(root, "src", "Shared.groovy"), "class Shared { def run() { 1 } }\n");
  const raw = await buildGraph(root, [{ name: "Alpha", type: "api", sourcePath: join(root, "src", "Shared.groovy") }]);
  const graph: any = { nodes: new Map(raw.nodes.map(node => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64), engineVersion: ICI_ENGINE_VERSION } };
  await mkdir(join(root, ".metadata/icomposer/ici/graph/current"), { recursive: true });
  await writeFile(join(root, ".metadata/icomposer/ici/graph/current/manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const prepared = await prepareExplain(root, "ws", graph, graph.nodes.get("api:Alpha"), []);
  // The reader records sha256 over its JSON-stringified content, so mirror that here.
  return { root, preparePathRel: prepared.artifactPath, sha: createHash("sha256").update(JSON.stringify(refContent)).digest("hex"), cleanup: () => rm(root, { recursive: true, force: true }) };
}

const analysis = { api: { technical: "technical", business: "business", flow: ["reads a request"], evidence: ["src/Shared.groovy#1"] } };
const current = (): { sourceFingerprint: string; graphDigest: string; engineVersion: string } => ({ sourceFingerprint: "f".repeat(64), graphDigest: "", engineVersion: ICI_ENGINE_VERSION });

async function finalizeWith(root: string, preparePathRel: string, graph: any, folderReads: any[]): Promise<void> {
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, ".metadata/icomposer/ici/graph/current/manifest.json"), "utf8"));
  await finalizeExplain(root, "ws", preparePathRel, analysis, { sourceFingerprint: manifest.sourceFingerprint, graphDigest: manifest.graphDigest, engineVersion: ICI_ENGINE_VERSION }, undefined, undefined, folderReads, "ref_doc", { path: "ref_doc", kind: "directory" });
}

test("TASK-111 FIX-2 an identical duplicate reference read is not a folder change", async () => {
  const fx = await fixture();
  try {
    // The child read the same file twice (before and after a corrective turn): the read
    // list legitimately repeats, and both reads saw exactly the same bytes.
    await finalizeWith(fx.root, fx.preparePathRel, null, [{ path: "ref_doc/nested/meaning.md", sha256: fx.sha }, { path: "ref_doc/nested/meaning.md", sha256: fx.sha }]);
  } finally { await fx.cleanup(); }
});

test("TASK-111 FIX-2 a reference whose content changed still fails as folder-changed", async () => {
  const fx = await fixture();
  try {
    const stale = createHash("sha256").update(JSON.stringify("older bytes\n")).digest("hex");
    await assert.rejects(() => finalizeWith(fx.root, fx.preparePathRel, null, [{ path: "ref_doc/nested/meaning.md", sha256: stale }]), /folder-changed/);
    // Two reads that disagree mean the file changed mid-run: still refused.
    await assert.rejects(() => finalizeWith(fx.root, fx.preparePathRel, null, [{ path: "ref_doc/nested/meaning.md", sha256: fx.sha }, { path: "ref_doc/nested/meaning.md", sha256: stale }]), /folder-changed/);
  } finally { await fx.cleanup(); }
});

test("TASK-111 FIX-2 out-of-target and malformed reads are still refused", async () => {
  const fx = await fixture();
  try {
    await assert.rejects(() => finalizeWith(fx.root, fx.preparePathRel, null, [{ path: "src/Shared.groovy", sha256: fx.sha }]), /folder-changed/);
    await assert.rejects(() => finalizeWith(fx.root, fx.preparePathRel, null, [{ path: "ref_doc/nested/meaning.txt", sha256: fx.sha }]), /folder-changed/);
    await assert.rejects(() => finalizeWith(fx.root, fx.preparePathRel, null, [{ path: "ref_doc/nested/meaning.md", sha256: "not-a-digest" }]), /folder-changed/);
    await assert.rejects(() => finalizeWith(fx.root, fx.preparePathRel, null, [{ path: "../outside.md", sha256: fx.sha }]), /folder-changed/);
  } finally { await fx.cleanup(); }
});
