/**
 * POC end-to-end regression runner (deliberately run; not part of pnpm test).
 *
 * Orchestrates the full Workbench chain under one isolated DSH_HOME with
 * deterministic CLI fakes:
 *
 *   profile composition (dump assertions) -> workspace fixture -> catalog
 *   -> ici build/query/search/explain -> verify utils (fake imo) -> push
 *   preview dry-run (fake imo) -> ici cleanup
 *
 * Each step records {step, ok, durationMs, counts}; the summary is written to
 * <DSH_HOME>/e2e-report.json. Any failure exits non-zero.
 *
 * `--stability` additionally runs the large-fixture build (5000 assets) and
 * a kill-mid-build survival check (current snapshot preserved), mirroring
 * the TASK-026 semantics at script level.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { buildWorkspaceFixture, buildLargeWorkspaceFixture } from "./fixtures.mts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const STABILITY = process.argv.includes("--stability");

interface StepReport { readonly step: string; readonly ok: boolean; readonly durationMs: number; readonly counts: Record<string, number | string | boolean>; readonly detail?: string }
const report: StepReport[] = [];

async function timed(step: string, fn: () => Promise<Record<string, number | string | boolean>>): Promise<boolean> {
  const started = Date.now();
  try {
    const counts = await fn();
    report.push({ step, ok: true, durationMs: Date.now() - started, counts });
    console.log(`[e2e] ok   ${step} (${Date.now() - started}ms) ${JSON.stringify(counts)}`);
    return true;
  } catch (error) {
    const detail = error instanceof Error ? `${error.message}` : String(error);
    report.push({ step, ok: false, durationMs: Date.now() - started, counts: {}, detail });
    console.error(`[e2e] FAIL ${step}: ${detail}`);
    return false;
  }
}
function fail(message: string): never { throw new Error(message); }
function expect(condition: unknown, message: string): void { if (!condition) fail(message); }

// ---------- deterministic subprocess fake (imo + curl) ----------

interface SpawnSpec { argv: readonly string[]; cwd: string }

function makeFakeSubprocess() {
  const spawns: SpawnSpec[] = [];
  const imoByKey = new Map<string, { stdout: string; exitCode: number }>();
  const rt = {
    spawns,
    imoByKey,
    async resolveExecutable(command: string) {
      if (command === "imo") return "/fake/bin/imo";
      if (command === "curl") return "/fake/bin/curl";
      throw new Error(`unexpected executable ${command}`);
    },
    spawn(spec: SpawnSpec) {
      spawns.push(spec);
      const argv = spec.argv;
      if (argv[0] === "/fake/bin/curl") {
        return handleFor(curlResponse(argv), 0);
      }
      const key = argv.slice(1).join(" ");
      const scripted = imoByKey.get(key) ?? { stdout: "{}", exitCode: 0 };
      return handleFor(scripted.stdout, scripted.exitCode);
    },
  };
  return rt;
}

function handleFor(stdout: string, exitCode: number) {
  let settle!: (o: { exitCode: number | null; signal: string | null }) => void;
  const done = new Promise<{ exitCode: number | null; signal: string | null }>(r => { settle = r; });
  const finish = () => settle({ exitCode, signal: null });
  finish();
  return {
    pid: 4242,
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: 0, lossy: false }) },
      stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
    },
    done,
    terminate: finish,
    waitForExit: async () => { finish(); return true; },
  };
}

/** Deterministic embedding vectors keyed by the request text batch. */
function curlResponse(argv: readonly string[]): string {
  const dataIdx = argv.indexOf("--data-raw");
  const body = dataIdx >= 0 ? argv[dataIdx + 1] : "{}";
  let texts: string[] = [];
  try {
    const parsed = JSON.parse(body) as { text?: string[] };
    texts = Array.isArray(parsed.text) ? parsed.text : [];
  } catch { texts = []; }
  const vectors = texts.map((text) => {
    const dims: number[] = [];
    for (let i = 0; i < 8; i++) {
      const code = text.length > 0 ? text.charCodeAt(i % text.length) : 1;
      dims.push((code * (i + 1)) % 97);
    }
    return dims;
  });
  const payload = JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })) });
  return payload + "\n__ICI_HTTP_STATUS__:200";
}

// ---------- main ----------

const dshHome = await mkdtemp(join(tmpdir(), "e2e-dsh-"));
const prevHome = process.env.DSH_HOME;
process.env.DSH_HOME = dshHome;
let allOk = true;

try {
  // Step 1: profile composition — install and assert the dump.
  allOk = await timed("profile-composition", async () => {
    execFileSync("node", [join(repoRoot, "scripts", "setup-profile.mjs")], {
      cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, DSH_HOME: dshHome },
    });
    const patchPath = join(dshHome, "profiles/icomposer-web/node_modules/@icomposer/bundle-workbench/cordis.patch.yml");
    const patch = await readFile(patchPath, "utf8");
    const pluginLines = patch.split("\n").filter(line => line.trim().startsWith("name: '@icomposer"));
    expect(pluginLines.length === 13, `expected 13 plugin lines, got ${pluginLines.length}`);
    expect(patch.includes("inject: [subprocess, workspaceBinding, imoAuth, operationLog]"), "write inject line missing");
    expect(patch.includes("inject: [workspaceBinding, icomposerCatalog, imoAuth, jobs]"), "ici inject line missing");
    const nodeModules = await readdir(join(dshHome, "profiles/icomposer-web/node_modules/@icomposer"));
    expect(nodeModules.includes("icomposer-write"), "profile install missing write package");
    return { plugins: 13, packages: nodeModules.length };
  }) && allOk;

  // Shared fixture + fake runtime for the in-process chain.
  const fixture = await buildWorkspaceFixture(join(dshHome, "fixture-workspace"));
  const rt = makeFakeSubprocess();

  const verifyJson = JSON.stringify({ result: { type: "verify", report: { valid: true, classes_checked: 2, used: [], unknown_classes: [], invalid_methods: [] } } });
  const pushPreviewJson = JSON.stringify({ result: { requestpath: "/e2e/search", name: "SearchPaymentAPI", remote_version: "rv-1", warnings: [], would_compile: true } });
  rt.imoByKey.set("icomposer verify utils --json --profile portal:demo src/dev/Tenant/E2E/api/SearchPaymentAPI/SearchPaymentAPI.groovy", { stdout: verifyJson, exitCode: 0 });
  rt.imoByKey.set(`icomposer push current --json --profile portal:demo --dry-run ${join(fixture.root, "src/dev/Tenant/E2E/api/SearchPaymentAPI/SearchPaymentAPI.groovy")}`, { stdout: pushPreviewJson, exitCode: 0 });

  // Step 2: catalog scan (real service over the fixture tree).
  const ctx = new Context();
  ctx.provide("subprocess", rt as never);
  ctx.provide("workspaceBinding", { get: async () => ({ ok: true, value: { binding: { authProfile: "portal:demo", environmentId: "portal:microsite" }, canonicalPath: fixture.root } }) } as never);
  ctx.provide("imoAuth" as never, { prepare: async () => ({ ok: true, value: { use: async (cb: (s: { accessToken: string }) => unknown) => cb({ accessToken: "e2e-fake-token" }) } }) } as never);

  const { IcomposerCatalogService } = await import("../icomposer-catalog/src/service.ts");
  const catalogFiber = await ctx.plugin(IcomposerCatalogService as never);
  await catalogFiber.await();
  const catalog = ctx.get("icomposerCatalog") as unknown as { listAssets(input: unknown, signal?: AbortSignal): Promise<any> };

  allOk = await timed("catalog-scan", async () => {
    const res = await catalog.listAssets({ workspaceId: "e2e" });
    expect(res.ok === true, `catalog failed: ${JSON.stringify(res.error)}`);
    expect(res.value.entries.length === 5, `expected 5 entries, got ${res.value.entries.length}`);
    expect(res.value.counts.api === 3 && res.value.counts.function === 2, `counts mismatch: ${JSON.stringify(res.value.counts)}`);
    return { apis: res.value.counts.api, functions: res.value.counts.function, total: res.value.counts.total };
  }) && allOk;

  // Step 3-7: ICI engine (build/query/search/explain) — real service.
  const { IciEngineService } = await import("../icomposer-code-intelligence/src/service.ts");
  // The real catalog service is already registered on this context; the ICI
  // engine consumes it through its injected icomposerCatalog dependency.
  ctx.provide("jobs" as never, { start: () => fail("jobs not expected in e2e inline build") } as never);
  const iciFiber = await ctx.plugin(IciEngineService as never);
  await iciFiber.await();
  const ici = ctx.get("iciEngine") as unknown as Record<string, (input?: unknown, options?: unknown) => Promise<any>>;

  allOk = await timed("ici-build", async () => {
    const res = await ici.build({ workspaceId: "e2e" });
    expect(res.ok === true, `build failed: ${JSON.stringify(res.error)}`);
    expect(res.value.manifest.schemaVersion === 1, "manifest schemaVersion != 1");
    expect(res.value.manifest.nodeCount > 5, `nodeCount too small: ${res.value.manifest.nodeCount}`);
    return { nodes: res.value.manifest.nodeCount, edges: res.value.manifest.edgeCount };
  }) && allOk;

  allOk = await timed("ici-query", async () => {
    const api = await ici.queryApi({ workspaceId: "e2e", query: "SearchPaymentAPI" });
    expect(api.ok === true && api.value.matched.length >= 1, "queryApi found no SearchPaymentAPI");
    const impact = await ici.queryImpact({ workspaceId: "e2e", query: "PaymentQueryService" });
    expect(impact.ok === true, "queryImpact failed");
    const reachesApi = JSON.stringify(impact.value).includes("SearchPaymentAPI");
    expect(reachesApi, "impact of PaymentQueryService does not reach SearchPaymentAPI");
    return { matched: api.value.matched.length, impactPaths: impact.value.paths.length };
  }) && allOk;

  allOk = await timed("ici-search", async () => {
    const index = await ici.index({ workspaceId: "e2e" });
    expect(index.ok === true, `index failed: ${JSON.stringify(index.error)}`);
    expect(index.value.total === 3 && index.value.embedded === 3, `index counts mismatch: ${JSON.stringify(index.value)}`);
    const search = await ici.search({ workspaceId: "e2e", query: "payment", top: 3 });
    expect(search.ok === true && search.value.rows.length > 0, "search returned no rows");
    expect(search.value.rows[0].score > 0, "top score not positive");
    return { indexed: index.value.total, rows: search.value.rows.length, topScore: Number(search.value.rows[0].score.toFixed(4)) };
  }) && allOk;

  allOk = await timed("ici-explain", async () => {
    const bundle = await ici.explainContext({ workspaceId: "e2e", query: "SearchPaymentAPI" });
    expect(bundle.ok === true, `explainContext failed: ${JSON.stringify(bundle.error)}`);
    expect(bundle.value.api.id === "api:SearchPaymentAPI", "explain bundle api mismatch");
    expect(bundle.value.downstream.length > 0, "explain downstream empty");
    const det = await ici.explainDeterministic({ workspaceId: "e2e", query: "SearchPaymentAPI" });
    expect(det.ok === true && det.value.generatedBy === "deterministic-v1", "deterministic explain failed");
    expect(det.value.technical.length > 0 && det.value.business.length > 0 && det.value.method.length > 0, "deterministic sections empty");
    return { downstream: bundle.value.downstream.length, generatedBy: det.value.generatedBy };
  }) && allOk;

  // Step 8: verify utils (fake imo subprocess).
  const { IcomposerVerifyService } = await import("../icomposer-verify/src/service.ts");
  const verifyFiber = await ctx.plugin(IcomposerVerifyService as never, { command: "imo", timeoutMs: 5000 });
  await verifyFiber.await();
  const verify = ctx.get("icomposerVerify") as unknown as { verifyUtils(input: unknown, signal?: AbortSignal): Promise<any> };

  allOk = await timed("verify-utils", async () => {
    const res = await verify.verifyUtils({ workspaceId: "e2e", file: "src/dev/Tenant/E2E/api/SearchPaymentAPI/SearchPaymentAPI.groovy" });
    expect(res.ok === true, `verify failed: ${JSON.stringify(res.error)}`);
    expect(res.value.valid === true && res.value.classesChecked === 2, `verify projection mismatch: ${JSON.stringify(res.value)}`);
    expect(typeof res.value.stdoutDigest === "string" && res.value.stdoutDigest.startsWith("sha256:"), "stdoutDigest missing");
    return { valid: true, classesChecked: res.value.classesChecked };
  }) && allOk;

  // Step 9: push preview dry-run (fake imo; approval-free read path).
  const storage = new Storage(ctx);
  const backend = new JsonStorageBackend(join(dshHome, "e2e-oplog"));
  storage.backend.register("json", backend);
  const storageDomain = new DomainFacility(ctx, { backend: "json" });
  const { OperationLogProvider, operationLogDomain } = await import("../workbench-operation-log/src/index.ts");
  const oplogDomain = await storageDomain.open(operationLogDomain);
  ctx.provide("operationLog", new OperationLogProvider({ emit() {} } as never, oplogDomain));
  const { IcomposerWriteService } = await import("../icomposer-write/src/service.ts");
  const writeFiber = await ctx.plugin(IcomposerWriteService as never, { command: "imo", timeoutMs: 5000 });
  await writeFiber.await();
  const write = ctx.get("icomposerWrite") as unknown as Record<string, (input?: unknown, signal?: AbortSignal) => Promise<any>>;

  allOk = await timed("push-preview", async () => {
    const res = await write.pushPreview({ workspaceId: "e2e", files: ["src/dev/Tenant/E2E/api/SearchPaymentAPI/SearchPaymentAPI.groovy"] });
    expect(res.ok === true, `pushPreview failed: ${JSON.stringify(res.error)}`);
    expect(res.value.files.length === 1 && res.value.files[0].conflict === false, `preview projection mismatch: ${JSON.stringify(res.value.files)}`);
    expect(res.value.files[0].localVersion.startsWith("sha256:"), "localVersion digest missing");
    const argv = (rt.spawns.find(s => s.argv.includes("push") && s.argv.includes("--dry-run")) as SpawnSpec | undefined)?.argv;
    expect(argv !== undefined, "no dry-run push spawn observed");
    expect(argv!.includes("--prefer-local") === false && argv!.includes("--prefer-server") === false, "prefer flags leaked into preview argv");
    return { files: res.value.files.length, conflict: false };
  }) && allOk;

  // Step 10: ici cleanup plan/apply leaves a clean snapshot state.
  allOk = await timed("ici-cleanup", async () => {
    const plan = await ici.cleanupPlan({ workspaceId: "e2e" });
    expect(plan.ok === true, `cleanupPlan failed: ${JSON.stringify(plan.error)}`);
    expect(Array.isArray(plan.value.paths), "cleanupPlan paths not a list");
    const apply = await ici.cleanupApply({ workspaceId: "e2e", expectedPaths: plan.value.paths });
    expect(apply.ok === true, `cleanupApply failed: ${JSON.stringify(apply.error)}`);
    const diagnostics = await ici.diagnostics({ workspaceId: "e2e" });
    expect(diagnostics.ok === true && diagnostics.value.stale === false, "post-cleanup diagnostics not clean");
    return { planned: plan.value.paths.length, removed: apply.value.removed.length, stale: diagnostics.value.stale };
  }) && allOk;

  // Optional stability pass.
  if (STABILITY) {
    allOk = await timed("stability-large-build", async () => {
      const large = await buildLargeWorkspaceFixture(join(dshHome, "stability-workspace"), 5000);
      const stressCtx = new Context();
      stressCtx.provide("workspaceBinding", { get: async () => ({ ok: true, value: { binding: { authProfile: "portal:demo", environmentId: "portal:microsite" }, canonicalPath: large.root } }) } as never);
      stressCtx.provide("icomposerCatalog" as never, { listAssets: async () => ({ ok: true, value: { entries: large.entries, counts: { api: 5000, function: 1, batch: 0, model: 0, total: 5001 }, truncated: false } }) } as never);
      stressCtx.provide("imoAuth" as never, { prepare: async () => ({ ok: false, error: { code: "invalid-auth" } }) } as never);
      stressCtx.provide("jobs" as never, { start: () => fail("jobs not expected") } as never);
      const fiber = await stressCtx.plugin(IciEngineService as never);
      await fiber.await();
      const stressEngine = stressCtx.get("iciEngine") as unknown as Record<string, (input?: unknown, options?: unknown) => Promise<any>>;
      const res = await stressEngine.build({ workspaceId: "stress" });
      expect(res.ok === true, `large build failed: ${JSON.stringify(res.error)}`);
      expect(res.value.manifest.nodeCount > 5000, `expected >5000 nodes, got ${res.value.manifest.nodeCount}`);
      // the maxNodes/truncated path is exercised on the query face:
      // a multi-start query over all StressApi roots exhausts the node budget
      const truncatedQuery = await stressEngine.queryApi({ workspaceId: "stress", query: "StressApi", maxNodes: 1000 });
      expect(truncatedQuery.ok === true, `truncated query failed: ${JSON.stringify(truncatedQuery.error)}`);
      expect(truncatedQuery.value.matched.length >= 1000, `expected >=1000 matched starts, got ${truncatedQuery.value.matched.length}`);
      expect(truncatedQuery.value.truncated === true, "queryApi did not report truncated at maxNodes=1000");
      // keep the workspace alive for the kill-mid-build step (it reuses it)
      return { nodes: res.value.manifest.nodeCount, truncated: truncatedQuery.value.truncated, assets: 5001 };
    }) && allOk;

    allOk = await timed("stability-kill-mid-build", async () => {
      // Preconditions: a valid promoted snapshot for the stress workspace
      // (built by stability-large-build), then SIGKILL a second build
      // mid-flight and verify current/ survived byte-intact.
      const { spawn } = await import("node:child_process");
      const { graphBaseDir, currentDir, readManifest } = await import("../icomposer-code-intelligence/src/storage.ts");
      const base = graphBaseDir(join(dshHome, "stability-workspace"), "stress");
      const before = await readManifest(base);
      expect(before !== null, "pre-kill manifest missing (stability-large-build must run first)");
      const beforeNodes = await readFile(join(currentDir(base), "nodes.json"), "utf8");
      const child = spawn(process.execPath, ["--import", "tsx", join(here, "victim.mts")], {
        cwd: here,
        env: { ...process.env, DSH_HOME: dshHome, E2E_STRESS_ROOT: join(dshHome, "stability-workspace"), TSX_TSCONFIG_PATH: join(repoRoot, "tsconfig.base.json") },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let victimOut = "";
      child.stdout.on("data", chunk => { victimOut += String(chunk); });
      await new Promise<void>(resolve => {
        child.stdout.on("data", (chunk: Buffer) => { if (String(chunk).includes("build starting")) resolve(); });
        child.on("error", () => resolve());
        setTimeout(resolve, 10_000);
      });
      expect(victimOut.includes("build starting") === false || victimOut.includes("build finished") === false, "victim finished too fast to kill");
      child.kill("SIGKILL");
      let killSignal: string | null = null;
      await new Promise<void>(resolve => { child.on("exit", (_code, signal) => { killSignal = signal; resolve(); }); });
      expect(killSignal === "SIGKILL", `victim was not SIGKILLed (signal=${String(killSignal)})`);
      const after = await readManifest(base);
      expect(after !== null, "post-kill manifest missing — current was destroyed");
      expect(after!.sourceFingerprint === before!.sourceFingerprint, "post-kill manifest fingerprint changed");
      const afterNodes = await readFile(join(currentDir(base), "nodes.json"), "utf8");
      expect(afterNodes === beforeNodes, "post-kill nodes.json changed — current snapshot mutated");
      // no stray staging dirs survive to confuse the next promote
      const graphDirContents = await readdir(join(base, "..", "graph"));
      const staging = graphDirContents.filter(name => name.startsWith("staging-"));
      expect(staging.length === 0, `stray staging dirs after kill: ${staging.join(",")}`);
      await rm(join(dshHome, "stability-workspace"), { recursive: true, force: true });
      return { killed: true, signal: "SIGKILL", currentPreserved: true };
    }) && allOk;
  }
} catch (error) {
  const detail = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  report.push({ step: "runner-aborted", ok: false, durationMs: 0, counts: {}, detail });
  console.error(`[e2e] FAIL runner aborted: ${detail}`);
  allOk = false;
} finally {
  // Step 12: report.
  const summary = {
    ranAt: new Date().toISOString(),
    stability: STABILITY,
    steps: report,
    ok: report.length > 0 && allOk && report.every(step => step.ok),
  };
  await writeFile(join(dshHome, "e2e-report.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(`[e2e] report written to ${join(dshHome, "e2e-report.json")}`);
  console.log(`[e2e] ${summary.ok ? "ALL GREEN" : "FAILURES PRESENT"}: ${report.filter(s => s.ok).length}/${report.length} steps ok`);
  if (prevHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prevHome;
  await rm(dshHome, { recursive: true, force: true });
  process.exit(summary.ok ? 0 : 1);
}
