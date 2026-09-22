import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildGraph } from "../src/graph.ts";
import { computeGraphDigest, prepareExplain } from "../src/explain-artifacts.ts";
import { resolveQueryNodes, resolveFocusId } from "../src/query.ts";
import { resolveSingleStart } from "../src/explain.ts";
import { runPrepareTask } from "../src/explain-native.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";

/**
 * TASK-119: api/function TARGET resolution must be exact-first. The reported case is a
 * legal pair where the short name is a suffix of the long one:
 *   api:AddRiderAPI_NONILP  ⊂  api:QuoteAddRiderAPI_NONILP
 * Substring matching made the short one "ambiguous"; target resolution must instead bind
 * the exact name, and when no exact name exists it must fail with candidates — never
 * silently bind a longer name (a stale graph must not mis-bind either).
 */

const node = (id: string, name: string, kind = "api"): any => ({ id, kind, name, path: "", evidence: "", directCalls: [], pathFromApi: [], cycle: false, repeated: false });
const pair = () => [node("api:AddRiderAPI_NONILP", "AddRiderAPI_NONILP"), node("api:QuoteAddRiderAPI_NONILP", "QuoteAddRiderAPI_NONILP"), node("api:OtherAPI", "OtherAPI")];

test("TASK-119 (a) an exact name that is a suffix of another name resolves to itself", () => {
  const result = resolveSingleStart(pair(), "AddRiderAPI_NONILP");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.ok && result.node.id, "api:AddRiderAPI_NONILP");
  const long = resolveSingleStart(pair(), "QuoteAddRiderAPI_NONILP");
  assert.equal(long.ok && long.node.id, "api:QuoteAddRiderAPI_NONILP");
});

test("TASK-119 (b) a substring guess never resolves, it only produces candidates", () => {
  for (const guess of ["AddRider", "RiderAPI", "NONILP"]) {
    const result = resolveSingleStart(pair(), guess);
    assert.equal(result.ok, false, `${guess} must not resolve`);
    assert.equal(!result.ok && result.reason, "ambiguous");
    assert.ok(!result.ok && result.candidates.length >= 2, JSON.stringify(result));
  }
  // A single substring candidate is still not an exact name: it must fail with that candidate.
  const single = resolveSingleStart(pair(), "OtherAP");
  assert.equal(single.ok, false, "a unique substring must not be bound silently");
  assert.ok(!single.ok && single.candidates.includes("api:OtherAPI"));
  // Nothing matches at all -> not-found with no candidates.
  const none = resolveSingleStart(pair(), "NoSuchApiAtAll");
  assert.equal(none.ok, false);
  assert.equal(!none.ok && none.reason, "not-found");
  assert.deepEqual(!none.ok ? none.candidates : [], []);
});

test("TASK-119 (c) case-insensitive exact is the fallback; several case variants stay ambiguous", () => {
  const lower = resolveSingleStart(pair(), "otherapi");
  assert.equal(lower.ok, true, JSON.stringify(lower));
  assert.equal(lower.ok && lower.node.id, "api:OtherAPI");
  const ambiguous = resolveSingleStart([node("api:CaseAPI", "CaseAPI"), node("api:caseapi", "caseapi")], "CASEAPI");
  assert.equal(ambiguous.ok, false);
  assert.equal(!ambiguous.ok && ambiguous.reason, "ambiguous");
  assert.equal(!ambiguous.ok && ambiguous.candidates.length, 2);
});

test("TASK-119 (d) focus resolution is exact-first as well", () => {
  const functions = [node("function:AddRiderFn", "AddRiderFn", "function"), node("function:QuoteAddRiderFn", "QuoteAddRiderFn", "function")];
  const exact = resolveFocusId(functions, "AddRiderFn");
  assert.equal(exact.ok, true, JSON.stringify(exact));
  assert.equal(exact.ok && exact.focusId, "function:AddRiderFn");
  const guess = resolveFocusId(functions, "AddRider");
  assert.equal(guess.ok, false, "a substring focus must not resolve");
  assert.ok(!guess.ok && guess.candidates.length === 2);
});

test("TASK-119 (e) the ici_query search surface keeps its substring/comma semantics", () => {
  // The search surface is deliberately fuzzy and multi-part: it must stay unchanged.
  assert.deepEqual(resolveQueryNodes(pair(), "AddRider", "api").map(entry => entry.id), ["api:AddRiderAPI_NONILP", "api:QuoteAddRiderAPI_NONILP"]);
  // A comma list is an OR over substrings on the search surface: the short part matches BOTH names.
  assert.deepEqual(resolveQueryNodes(pair(), "OtherAPI,AddRiderAPI_NONILP", "api").map(entry => entry.id).sort(), ["api:AddRiderAPI_NONILP", "api:OtherAPI", "api:QuoteAddRiderAPI_NONILP"]);
});

test("TASK-119 (f) a comma inside a target name is one name, never an OR list", () => {
  const comma = [node("api:A,B", "A,B"), node("api:A", "A"), node("api:B", "B")];
  const result = resolveSingleStart(comma, "A,B");
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.ok && result.node.id, "api:A,B");
  const guess = resolveSingleStart(comma, "A, B");
  assert.equal(guess.ok, false, "a comma-separated guess must not resolve to A or B");
});

async function workspace(names: readonly string[]) {
  const root = await mkdtemp(join(tmpdir(), "task119-exact-"));
  await mkdir(join(root, "src"), { recursive: true });
  const entries: Array<{ name: string; type: "api"; sourcePath: string }> = [];
  for (const name of names) {
    const file = join(root, "src", `${name}.groovy`);
    await writeFile(file, `class ${name.replace(/[^A-Za-z0-9_]/g, "_")} { def run() { 1 } }\n`);
    entries.push({ name, type: "api", sourcePath: file });
  }
  const raw = await buildGraph(root, entries);
  const graph: any = { nodes: new Map(raw.nodes.map(item => [item.id, item])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64), engineVersion: ICI_ENGINE_VERSION } };
  await mkdir(join(root, ".metadata/icomposer/ici/graph/current"), { recursive: true });
  await writeFile(join(root, ".metadata/icomposer/ici/graph/current/manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const starts = new Map(entries.map(entry => [entry.name, graph.nodes.get(`api:${entry.name}`)]));
  const deps: any = {
    disposed: () => false,
    loadBase: async (_workspaceId: string, query: string) => { const start = starts.get(query); return start ? { ok: true, value: { graph, canonicalPath: root, start } } : { ok: false, error: { code: "no-match", message: `no api matched: ${query}` } }; },
    current: async () => ({ ok: true, value: { canonicalPath: root, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph), engineVersion: ICI_ENGINE_VERSION } }),
    refs: async () => [],
    catalog: async () => ({ ok: true, value: { entries: entries.map(entry => ({ name: entry.name, type: "api", tenant: "acme", group: "G", sourcePath: `src/dev/acme/G/api/${entry.name}/${entry.name}.groovy` })), duplicateNames: [] } }),
  };
  return { root, graph, deps, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("TASK-119 (g) selector names and engine resolution agree: one task covers both APIs", async () => {
  const fx = await workspace(["AddRiderAPI_NONILP", "QuoteAddRiderAPI_NONILP"]);
  try {
    const task = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "all" } });
    assert.equal(task.ok, true, JSON.stringify(task));
    if (!task.ok) return;
    assert.equal(task.value.jobs.length, 2, "both APIs become members of ONE task");
    assert.deepEqual(task.value.jobs.map(job => job.apiName).sort(), ["AddRiderAPI_NONILP", "QuoteAddRiderAPI_NONILP"]);
  } finally { await fx.cleanup(); }
});

test("TASK-119 (h) a stale graph without the exact name never mis-binds a longer name", async () => {
  const fx = await workspace(["QuoteAddRiderAPI_NONILP"]);
  try {
    // The requested API is absent (e.g. the graph predates it): the resolution must fail
    // with candidates instead of binding the longer name, and nothing may be written.
    const task = await runPrepareTask(fx.deps, { workspaceId: "ws", selector: { kind: "api", query: "AddRiderAPI_NONILP" } });
    assert.equal(task.ok, false, "no silent binding to a longer name");
    assert.equal(!task.ok && task.error.code, "no-match");
    const jobs = await readdir(join(fx.root, ".metadata/icomposer/ici/explain/jobs")).catch(() => [] as string[]);
    assert.deepEqual(jobs, [], "a failed resolution writes no job record");
    const batches = await readdir(join(fx.root, ".metadata/icomposer/ici/explain/batches")).catch(() => [] as string[]);
    assert.deepEqual(batches, [], "a failed resolution writes no task record");
  } finally { await fx.cleanup(); }
});
