import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import LlmRuntime, { LlmAdapter } from "@deepseek-ai/dsh-llm";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import AgentRegistry from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import { buildGraph } from "../src/graph.ts";
import { computeGraphDigest, createJobRecord, loadPrepare, prepareExplain, readJobRecord, updateJobRecord } from "../src/explain-artifacts.ts";
import { ICI_ENGINE_VERSION } from "../src/engine-version.ts";
import { defaultExplainInstruction, processConfirmedJob } from "../src/explain-scheduler.ts";
import { EXPLAIN_INSTRUCTION_FILE, EXPLAIN_INSTRUCTION_SUBMIT_BOUNDARY, EXPLAIN_SYSTEM_CONTRACT, EXPLAIN_SYSTEM_PROMPT_FILE, MAX_EXPLAIN_INSTRUCTION_BYTES, MAX_EXPLAIN_SYSTEM_PROMPT_BYTES, explainPromptOverridePath, renderExplainPromptTemplate } from "../src/explain-prompt.ts";

/**
 * TASK-131: user-customizable child prompts, cached under the ici explain tree.
 *
 * The regression anchor is byte-identity: with no override files the initial message and the system
 * section must equal the built-in text exactly, verified through the exported default and a frozen
 * digest of it. Overrides only ever EXTEND the contract (the engine appends the iron rules and the
 * submit boundary), and a broken file falls back to the built-in text without failing the job.
 */

const workspaceId = "task131";
const BATCH = "1310ace1310ace13";
const jobIds = ["1310000000000001", "1310000000000002", "1310000000000003", "1310000000000004", "1310000000000005"] as const;
const API = "ReduceSAAPI";
const EVIDENCE = ["src/dev/Tenant/STD_BS_PA_BUSINESS/api/ReduceSAAPI/ReduceSAAPI.groovy#1"];

/** Frozen digest of the built-in instruction block (deliberate lock: changing the default must be intentional). */
const DEFAULT_INSTRUCTION_SHA256 = "b401b16a7b8590aa86b2d96b2c0e37ba046cfc980bbebb2059660d260148d7ea";

class RecordAdapter extends LlmAdapter {
  calls = 0; readonly requests: any[] = []; readonly systems: string[] = [];
  override resolveModel(provider: string, model: string): Promise<any> { return Promise.resolve({ provider, id: model, name: model }); }
  override listModels(provider: string): Promise<any[]> { return Promise.resolve([{ provider, id: "mvp-model", name: "MVP model" }]); }
  async *stream(options: any): AsyncIterable<any> {
    this.requests.push(options); this.systems.push(String(options?.system ?? ""));
    const text = JSON.stringify({ technical: "t", business: "b", flow: ["API returns a value"], evidence: EVIDENCE });
    this.calls++;
    yield { type: "block-start", index: 0, blockType: "tool-call" };
    yield { type: "tool-call-delta", index: 0, id: "submit", name: "ici_explain_submit", argumentsDelta: text };
    yield { type: "block-end", index: 0, block: { type: "tool-call", id: "submit", name: "ici_explain_submit", arguments: text } };
    yield { type: "finish", reason: { kind: "tool-calls" } };
  }
}

async function harness(adapter: LlmAdapter): Promise<any> {
  const ctx: any = new Context();
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] });
  ctx.llm.registerAdapter(["mvp"], adapter); return ctx;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "task131-prompt-"));
  const dir = join(root, "src/dev/Tenant/STD_BS_PA_BUSINESS/api/ReduceSAAPI");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "ReduceSAAPI.groovy"), "class ReduceSAAPI {\n  def execute() { return String.valueOf(1) }\n}\n");
  const raw = await buildGraph(root, [{ name: API, type: "api", sourcePath: join(dir, "ReduceSAAPI.groovy") }]);
  const graph: any = { nodes: new Map(raw.nodes.map((node: any) => [node.id, node])), edges: raw.edges, manifest: { sourceFingerprint: "f".repeat(64) } };
  const graphDir = join(root, ".metadata/icomposer/ici/graph/current"); await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, "manifest.json"), JSON.stringify({ engineVersion: ICI_ENGINE_VERSION, sourceFingerprint: graph.manifest.sourceFingerprint, graphDigest: computeGraphDigest(graph) }));
  const prepared = await prepareExplain(root, workspaceId, graph, raw.nodes.find((node: any) => node.id === `api:${API}`)!, []);
  return { root, prepared, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function scheduleJob(fx: { root: string; prepared: any }, jobId: string): Promise<void> {
  const artifact = fx.prepared.artifact;
  const job = await createJobRecord(fx.root, { jobId, workspaceId, apiId: `api:${API}`, apiName: API, prepareArtifactPath: fx.prepared.artifactPath, prepareId: artifact.prepareId, contextHash: artifact.contextHash, sourceFingerprint: artifact.manifest.sourceFingerprint, graphDigest: artifact.manifest.graphDigest, provider: null, model: null, docs: [], referenceTarget: { path: "", kind: "none" }, batchId: BATCH });
  await updateJobRecord(fx.root, jobId, job.revision, { provider: "mvp", model: "mvp-model", status: "scheduled", notBefore: new Date(Date.now() - 1000).toISOString() });
}

async function run(fx: { root: string; prepared: any }, jobId: string): Promise<{ adapter: RecordAdapter; status?: string; error?: string }> {
  await scheduleJob(fx, jobId);
  const adapter = new RecordAdapter();
  const ctx = await harness(adapter);
  const parent = ctx.agentLoop.create(SessionId(`task131-${jobId}`), { provider: "mvp", model: "mvp-model" }, { cwd: fx.root });
  try {
    await processConfirmedJob(ctx.llm, fx.root, jobId, new AbortController().signal, ctx, parent);
    const record = await readJobRecord(fx.root, jobId);
    return { adapter, status: record?.status, error: record?.error };
  } finally { parent.cancel("cancelled"); await parent.whenIdle(); }
}

async function writeOverride(root: string, file: string, content: string | Buffer): Promise<void> {
  await mkdir(join(explainPromptOverridePath(root, file), ".."), { recursive: true });
  await writeFile(explainPromptOverridePath(root, file), content);
}

test("TASK-131 (1) without override files the instruction block is the built-in text (regression anchor)", async () => {
  const fx = await fixture();
  try {
    const digest = createHash("sha256").update(defaultExplainInstruction().join("\n")).digest("hex");
    assert.equal(digest, DEFAULT_INSTRUCTION_SHA256, "the built-in instruction block changed: update this anchor deliberately");
    const { adapter, status } = await run(fx, jobIds[0]);
    assert.equal(status, "final");
    const first = adapter.requests[0].messages[0].content[0].text as string;
    assert.equal(first.startsWith(`${defaultExplainInstruction().join("\n")}\nAPI: ${API} (api:${API}) in workspace ${workspaceId}.`), true, "the initial message uses the built-in block byte-for-byte");
    assert.equal(first.includes("Non-negotiable contract"), false, "no contract block is appended without an override");
    assert.equal(adapter.systems[0].includes("Non-negotiable contract"), false);
  } finally { await fx.cleanup(); }
});

test("TASK-131 (2) a system-prompt.md extends the system section (contract appended, framing kept)", async () => {
  const fx = await fixture();
  try {
    await writeOverride(fx.root, EXPLAIN_SYSTEM_PROMPT_FILE, "Team rule for {{apiName}}: prefer concise flow steps about {{apiId}} in {{workspaceId}} (ref {{referenceTarget}}).");
    const { adapter, status } = await run(fx, jobIds[1]);
    assert.equal(status, "final");
    const system = adapter.systems[0];
    assert.equal(system.includes(`Team rule for ${API}: prefer concise flow steps about api:${API} in ${workspaceId} (ref {"path":"","kind":"none"}).`), true, "placeholders resolved, including the JSON reference target");
    assert.equal(system.includes(EXPLAIN_SYSTEM_CONTRACT), true, "the contract block is appended after the user text");
    assert.ok(system.indexOf("Team rule") < system.indexOf("Non-negotiable contract"), "the contract comes after the user text");
    assert.equal(system.includes("This is a dedicated read-only ICI explanation child."), true, "the engine framing is preserved");
    // The instruction block is untouched: the two overrides are independent.
    const first = adapter.requests[0].messages[0].content[0].text as string;
    assert.equal(first.startsWith(`${defaultExplainInstruction().join("\n")}\nAPI:`), true);
  } finally { await fx.cleanup(); }
});

test("TASK-131 (3) an instruction.md replaces the first block and always keeps the submit boundary", async () => {
  const fx = await fixture();
  try {
    await writeOverride(fx.root, EXPLAIN_INSTRUCTION_FILE, "Custom brief for {{apiName}} (prepare {{prepareId}}): summarise the value flow only.");
    const { adapter, status } = await run(fx, jobIds[2]);
    assert.equal(status, "final");
    const first = adapter.requests[0].messages[0].content[0].text as string;
    assert.equal(first.startsWith(`Custom brief for ${API} (prepare ${fx.prepared.artifact.prepareId}): summarise the value flow only.\n${EXPLAIN_INSTRUCTION_SUBMIT_BOUNDARY}`), true, "user text then the mandatory submit boundary");
    assert.equal(first.includes("How to work:"), false, "the built-in block is replaced, not appended");
    assert.equal(first.includes(EXPLAIN_INSTRUCTION_SUBMIT_BOUNDARY), true, "the submit boundary sentence is present");
    assert.equal(first.includes("ici_explain_submit"), true);
    assert.equal(adapter.systems[0].includes("Non-negotiable contract"), false, "the system side stays untouched");
  } finally { await fx.cleanup(); }
});

test("TASK-131 (4) empty, oversized and non-UTF-8 overrides fall back to the built-in text without failing the job", async () => {
  const fx = await fixture();
  try {
    const cases: Array<[string, string, string | Buffer]> = [
      ["empty", EXPLAIN_INSTRUCTION_FILE, "   \n\t "],
      ["oversize", EXPLAIN_SYSTEM_PROMPT_FILE, "x".repeat(MAX_EXPLAIN_SYSTEM_PROMPT_BYTES + 1)],
      ["oversize-instruction", EXPLAIN_INSTRUCTION_FILE, "y".repeat(MAX_EXPLAIN_INSTRUCTION_BYTES + 1)],
      ["non-utf8", EXPLAIN_INSTRUCTION_FILE, Buffer.from([0xff, 0xfe, 0xfd, 0x00])],
    ];
    for (const [index, [label, file, content]] of cases.entries()) {
      // Every case runs on its own job: an override file is (re)written before that child is created.
      await writeOverride(fx.root, file, content);
      const { adapter, status, error } = await run(fx, jobIds[index]!);
      assert.equal(status, "final", `${label} must not fail the job (error=${error})`);
      const first = adapter.requests[0].messages[0].content[0].text as string;
      assert.equal(first.startsWith(defaultExplainInstruction().join("\n")), true, `${label}: the built-in block is used`);
      // A sibling override file must not be affected by the broken one.
      if (file === EXPLAIN_INSTRUCTION_FILE) assert.equal(adapter.systems[0].includes("Non-negotiable contract"), false);
    }
    // A broken system file must not disturb a valid instruction file either.
    await writeOverride(fx.root, EXPLAIN_SYSTEM_PROMPT_FILE, "x".repeat(MAX_EXPLAIN_SYSTEM_PROMPT_BYTES + 1));
    await writeOverride(fx.root, EXPLAIN_INSTRUCTION_FILE, "Valid brief for {{apiName}}.");
    const mixed = await run(fx, jobIds[4]!);
    assert.equal(mixed.status, "final", `mixed case must not fail (error=${mixed.error})`);
    assert.equal(mixed.adapter.systems[0].includes("Non-negotiable contract"), false, "the broken system file falls back");
    assert.equal((mixed.adapter.requests[0].messages[0].content[0].text as string).startsWith(`Valid brief for ${API}.\n${EXPLAIN_INSTRUCTION_SUBMIT_BOUNDARY}`), true);
  } finally { await fx.cleanup(); }
});

test("TASK-131 (5) placeholders resolve for every supported name and unknown ones are left as-is", () => {
  const vars = { apiName: "A", apiId: "api:A", workspaceId: "ws", referenceTarget: "{\"path\":\"ref_doc\",\"kind\":\"directory\"}", prepareId: "0123456789abcdef" };
  assert.equal(renderExplainPromptTemplate("{{apiName}}|{{apiId}}|{{workspaceId}}|{{referenceTarget}}|{{prepareId}}", vars), `A|api:A|ws|{"path":"ref_doc","kind":"directory"}|0123456789abcdef`);
  assert.equal(renderExplainPromptTemplate("{{unknown}} stays", vars), "{{unknown}} stays");
});

test("TASK-131 (6) an override read after the first job takes effect on the next job without restart", async () => {
  const fx = await fixture();
  try {
    const first = await run(fx, jobIds[0]);
    assert.equal(first.status, "final");
    assert.equal(first.adapter.systems[0].includes("Team rule"), false);
    await writeOverride(fx.root, EXPLAIN_SYSTEM_PROMPT_FILE, "Team rule: {{apiName}}.");
    const second = await run(fx, jobIds[1]);
    assert.equal(second.status, "final");
    assert.equal(second.adapter.systems[0].includes("Team rule: ReduceSAAPI."), true, "the next child picks the file up");
  } finally { await fx.cleanup(); }
});
