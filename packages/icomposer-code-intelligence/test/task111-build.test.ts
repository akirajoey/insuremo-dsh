import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { harness, writeGroovy } from "./support/helpers.ts";

/**
 * TASK-111: the graph build must cover every asset of the workspace — the catalog's
 * 5000-item display bound may not cap the graph — and a same-name collision must be
 * refused BEFORE the build, never merged into an incomplete graph.
 */
test("TASK-111 build covers assets beyond the catalog display bound", async () => {
  const h = await harness({ catalogEntries: [], catalogComplete: { entries: [] } });
  try {
    const apiDir = join(h.root, "src", "dev", "acme", "Payments", "api");
    await mkdir(join(apiDir, "TailApi"), { recursive: true });
    await writeFile(join(apiDir, "TailApi", "TailApi.groovy"), "class TailApi { def run() { 1 } }\n");
    // The capped listing stops at the display bound; the complete listing still has the tail.
    const capped = Array.from({ length: 5000 }, (_, index) => ({ name: `Bulk${index}`, type: "api" }));
    const complete = [...capped, { name: "TailApi", type: "api", sourcePath: "src/dev/acme/Payments/api/TailApi/TailApi.groovy" }];
    const h2 = await harness({ root: h.root, catalogEntries: capped, catalogComplete: { entries: complete } });
    try {
      const built = await h2.engine.build({ workspaceId: "ws1" });
      assert.equal(built.ok, true, JSON.stringify(built));
      assert.equal((built as any).value.manifest.nodeCount > 5000, true, "the tail asset is inside the graph, so the display bound did not cap it");
      // The tail asset is not merely present: it can be prepared like any other target.
      const prepared = await h2.engine.explainPrepare({ workspaceId: "ws1", query: "TailApi" });
      assert.equal(prepared.ok, true, JSON.stringify(prepared));
    } finally { await h2.dispose(); }
  } finally { await h.dispose(); }
});

test("TASK-111 build refuses same-named assets at different paths instead of merging them", async () => {
  const root = await (await import("node:fs/promises")).mkdtemp(join((await import("node:os")).tmpdir(), "task111-build-"));
  try {
    await writeGroovy(root, "api", "DupApi", "class DupApi { def run() { 1 } }\n");
    const h = await harness({
      root,
      catalogEntries: [{ name: "DupApi", type: "api", sourcePath: join(root, "src", "dev", "demo", "G1", "api", "DupApi", "DupApi.groovy") }],
      catalogComplete: {
        entries: [
          { name: "DupApi", type: "api", sourcePath: "src/dev/demo/G1/api/DupApi/DupApi.groovy" },
          { name: "DupApi", type: "api", sourcePath: "src/dev/demo/G2/api/DupApi/DupApi.groovy" },
        ],
        duplicateNames: ["DupApi"],
      },
    });
    try {
      const built = await h.engine.build({ workspaceId: "ws1" });
      assert.equal(built.ok, false);
      assert.equal((built as any).error.code, "ambiguous-target");
      assert.match((built as any).error.message, /DupApi/);
      const { loadSnapshot } = await import("../src/storage.ts");
      const { graphBaseDir } = await import("../src/storage.ts");
      assert.equal(await loadSnapshot(graphBaseDir(root, "ws1")), null, "a refused build publishes no graph at all");
    } finally { await h.dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
