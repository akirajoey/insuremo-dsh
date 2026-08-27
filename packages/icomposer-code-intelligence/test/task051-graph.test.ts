import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditGraph, buildGraph, mergeEdge, mergeNode } from "../src/graph.ts";
import { extractMethods } from "../src/parser.ts";
import type { IciEdge, IciNode } from "../src/types.ts";
import { harness, writeGroovy, writeMeta } from "./support/helpers.ts";

test("TASK-051 parser only emits top-level declarations and inclusive ranges", () => {
  const source = `class Demo {
  def execute() {
    try { return new BigDecimal(value) } catch (ignored) { }
    withTransaction() { value() }
    def closure = { value() }
  }
  private Integer local(Integer value) { return value }
  private java.time.LocalDateTime toLocalDateTime(String value) { return null }
}`;
  assert.deepEqual(extractMethods(source).map(m => ({ name: m.name, startLine: m.startLine, endLine: m.endLine })), [
    { name: "execute", startLine: 2, endLine: 6 },
    { name: "local", startLine: 7, endLine: 7 },
    { name: "toLocalDateTime", startLine: 8, endLine: 8 },
  ]);
});

test("TASK-051 node and edge merges are order-independent and preserve rich provenance", () => {
  const placeholder: IciNode = { id: "method:Svc.execute", kind: "method", name: "execute", path: "", evidence: "execute()", sourceFile: "", owner: "function:Svc" };
  const rich: IciNode = { id: "method:Svc.execute", kind: "method", name: "execute", path: "src/dev/Tenant/G/function/Svc/Svc.groovy", evidence: "execute(Request)", sourceFile: "src/dev/Tenant/G/function/Svc/Svc.groovy", startLine: 12, endLine: 20, signature: "execute(Request)", sourceHash: "hash-rich", owner: "function:Svc" };
  assert.deepEqual(mergeNode(placeholder, rich), mergeNode(rich, placeholder));
  assert.equal(mergeNode(placeholder, rich).sourceFile, rich.sourceFile);
  assert.match(mergeNode(placeholder, rich).evidence, /execute\(Request\)/);
  const platform: IciEdge = { id: "p", from: "method:Api.execute", to: "function:Svc", kind: "CALLS", ownerFile: "platform:Api.groovy", source: "inferred", confidence: "inferred", evidence: "platform hint" };
  const local: IciEdge = { id: "l", from: "method:Api.execute", to: "function:Svc", kind: "CALLS", ownerFile: "src/dev/Tenant/G/api/Api/Api.groovy", source: "static", confidence: "medium", evidence: "getCommonService(\"Svc\")" };
  assert.deepEqual(mergeEdge(platform, local), mergeEdge(local, platform));
  const edge = mergeEdge(platform, local);
  assert.equal(edge.ownerFile, local.ownerFile);
  assert.equal(edge.source, "static");
  assert.match(edge.evidence, /platform hint/);
  assert.match(edge.evidence, /getCommonService/);
});

test("TASK-051 synthetic source-rich graph has ranges, hashes, no false positives, and unique tuples", async () => {
  const root = await mkdtemp(join(tmpdir(), "task051-graph-"));
  try {
    await writeMeta(root, "api", "DemoAPI");
    await writeMeta(root, "function", "DemoService");
    const apiPath = await writeGroovy(root, "api", "DemoAPI", `class DemoAPI {\n  def execute() {\n    DemoService s = (DemoService) getCommonService("DemoService")\n    s.execute()\n    withTransaction() { value() }\n  }\n}`);
    const fnPath = await writeGroovy(root, "function", "DemoService", `class DemoService {\n  def execute() {\n    return new BigDecimal("1")\n  }\n}`);
    const graph = await buildGraph(root, [
      { name: "DemoAPI", type: "api", sourcePath: apiPath },
      { name: "DemoService", type: "function", sourcePath: fnPath },
    ]);
    const execute = graph.nodes.find(n => n.id === "method:DemoService.execute")!;
    assert.equal(execute.sourceFile, "src/dev/Tenant/Group/function/DemoService/DemoService.groovy");
    assert.equal(execute.startLine, 2);
    assert.equal(execute.endLine, 4);
    assert.ok(execute.sourceHash);
    assert.equal(graph.nodes.some(n => n.id === "method:DemoService.BigDecimal"), false);
    assert.equal(new Set(graph.nodes.map(n => n.id)).size, graph.nodes.length);
    assert.equal(new Set(graph.edges.map(e => `${e.from}|${e.to}|${e.kind}`)).size, graph.edges.length);
    assert.deepEqual(auditGraph(graph.nodes, graph.edges), { duplicateNodeIds: 0, duplicateEdgeTuples: 0, invalidRanges: 0 });
    const beforeHash = execute.sourceHash;
    await writeFile(fnPath, (await readFile(fnPath, "utf8")).replace('"1"', '"2"'), "utf8");
    const changed = await buildGraph(root, [
      { name: "DemoAPI", type: "api", sourcePath: apiPath },
      { name: "DemoService", type: "function", sourcePath: fnPath },
    ]);
    assert.notEqual(changed.nodes.find(n => n.id === "method:DemoService.execute")?.sourceHash, beforeHash);
    const h = await harness({ root, catalogEntries: [
      { name: "DemoAPI", type: "api", sourcePath: apiPath },
      { name: "DemoService", type: "function", sourcePath: fnPath },
    ] });
    try {
      const built: any = await h.engine.build({ workspaceId: "task051" });
      assert.equal(built.ok, true);
      assert.deepEqual(built.value.manifest.audit, { duplicateNodeIds: 0, duplicateEdgeTuples: 0, invalidRanges: 0 });
    } finally { await h.dispose(); }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
