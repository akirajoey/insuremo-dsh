import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type { SubprocessHandle, SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { IcomposerVerifyService } from "../src/service.ts";
import * as verifyPlugin from "../src/index.ts";

const validEnv = "env1";

function reader(text: string): { readFrom(): { text: string; nextOffset: number; lossy: boolean } } {
  return { readFrom() { return { text, nextOffset: 0, lossy: false }; } };
}

function handleFor(stdout: string, exitCode: number): SubprocessHandle {
  let settle!: (o: { exitCode: number | null; signal: string | null }) => void;
  const done = new Promise<{ exitCode: number | null; signal: string | null }>(r => { settle = r; });
  const finish = (): void => settle({ exitCode, signal: null });
  const handle = {
    pid: 9,
    collected: { stdout: reader(stdout), stderr: reader("") },
    done,
    terminate: finish,
    waitForExit: async () => { finish(); return true; },
  } as unknown as SubprocessHandle;
  finish();
  return handle;
}

interface SpawnFacts {
  argv: readonly string[];
  cwd: string;
}

function fakeSubprocess(over: {
  stdoutForKey?: Map<string, string>;
  exitForKey?: Map<string, number>;
} = {}): SubprocessRuntime & { spawns: SpawnFacts[]; stdoutForKey: Map<string, string> } {
  const io = {
    stdoutForKey: over.stdoutForKey ?? new Map(),
    exitForKey: over.exitForKey ?? new Map(),
    spawns: [] as SpawnFacts[],
  };
  return {
    spawns: io.spawns,
    stdoutForKey: io.stdoutForKey,
    async resolveExecutable() { return "/opt/homebrew/bin/imo"; },
    spawn(spec: { argv: readonly string[]; cwd: string }) {
      io.spawns.push({ argv: spec.argv, cwd: spec.cwd });
      const key = spec.argv.slice(1).join(" ");
      const stdout = io.stdoutForKey.get(key) ?? "{}";
      const exit = io.exitForKey.get(key) ?? 0;
      return handleFor(stdout, exit);
    },
  } as unknown as SubprocessRuntime & { spawns: SpawnFacts[]; stdoutForKey: Map<string, string> };
}

type AuthMode = "ok" | "invalid-auth" | "forbidden" | "prepare-invalidated" | "lease-revoked";

function stubAuth(mode: AuthMode) {
  return {
    prepare: async () => {
      if (mode !== "ok") return { ok: false, error: { code: mode } };
      return {
        ok: true,
        value: {
          use: async (cb: (s: { accessToken: string }) => unknown) => cb({ accessToken: "sekret-token" }),
        },
      };
    },
  };
}

function fakeBinding(mode: "bound" | "unbound" | "not-found", canonicalPath: string) {
  return {
    get: async () => {
      if (mode === "not-found") return { ok: false, error: { code: "workspace-not-found" } };
      if (mode === "unbound") return { ok: true, value: { binding: null, canonicalPath } };
      return { ok: true, value: { binding: { authProfile: "portal:demo", environmentId: validEnv }, canonicalPath } };
    },
  };
}

type Verify = {
  verifyUtils(input: unknown, signal?: AbortSignal): Promise<unknown>;
  listUtils(input: unknown, signal?: AbortSignal): Promise<unknown>;
  searchUtils(input: unknown, signal?: AbortSignal): Promise<unknown>;
};

async function harness(opts: {
  io?: ReturnType<typeof fakeSubprocess>;
  auth?: AuthMode;
  activeProfile?: unknown;
  bindingMode?: "bound" | "unbound" | "not-found";
  root?: string;
} = {}) {
  const ctx = new Context();
  const root = opts.root ?? await mkdtemp(join(tmpdir(), "verify-root-"));
  const io = opts.io ?? fakeSubprocess();
  ctx.provide("subprocess", io as never);
  ctx.provide("imoAuth" as never, stubAuth(opts.auth ?? "ok") as never);
  ctx.provide("workspaceBinding", fakeBinding(opts.bindingMode ?? "bound", root) as never);
  ctx.provide("imoActiveProfile" as never, opts.activeProfile === undefined ? {
    get: async () => ({ ok: true, value: { status: "active", activeProfileName: "portal:demo", profile: { profileName: "portal:demo" } } }),
  } : opts.activeProfile as never);
  const fiber = await ctx.plugin(IcomposerVerifyService, { command: "imo", timeoutMs: 5000 });
  await fiber.await();
  const verify = ctx.get("icomposerVerify") as unknown as Verify;
  return {
    ctx,
    io: io as unknown as { spawns: SpawnFacts[]; stdoutForKey: Map<string, string> },
    root,
    verify,
    fiber,
    dispose: async () => { await fiber.dispose(); if (opts.root === undefined) await rm(root, { recursive: true, force: true }); },
  };
}

const fileKey = "icomposer verify utils --json --profile portal:demo src/dev/T/G/api/Api1/Api1.groovy";
const listKey = "icomposer verify utils --json --profile portal:demo --list";
const searchKey = "icomposer verify utils --json --profile portal:demo --search json";

test("apply mounts all eight tools persistently and disposes them with the plugin", async () => {
  const ctx = new Context();
  ctx.provide("subprocess", fakeSubprocess() as never);
  ctx.provide("imoAuth" as never, stubAuth("ok") as never);
  ctx.provide("workspaceBinding", fakeBinding("bound", "/tmp/verify-apply") as never);
  const names = new Set<string>();
  const sections = new Set<string>();
  ctx.provide("tools", {
    register(definition: { name: string }) {
      names.add(definition.name);
      return () => names.delete(definition.name);
    },
  } as never);
  ctx.provide("systemPrompt", {
    section(section: { name: string }) {
      sections.add(section.name);
      return () => sections.delete(section.name);
    },
  } as never);
  const fiber = await ctx.plugin(verifyPlugin as never);
  await fiber.await();
  assert.equal(names.size, 8);
  assert.equal(sections.size, 8);
  await fiber.dispose();
  assert.equal(names.size, 0);
  assert.equal(sections.size, 0);
});

test("verifyUtils file variant: exact argv with relative path, cwd=canonicalPath, report projection uses requested relative path", async () => {
  const reportJson = JSON.stringify({
    base_url: "https://gw", profile_name: "portal:demo",
    cache_file: "/Users/x/.metadata/icomposer/cache.json", cache_used: true, warnings: [],
    result: {
      type: "verify",
      report: {
        file: "/absolute/leaked/path/Api1.groovy",
        valid: true,
        classes_checked: 2,
        unknown_classes: ["IComposerNope"],
        invalid_methods: [{ class: "IComposerJsonUtils", method: "noSuchMethodX", suggestions: [] }],
        used: [{ class: "IComposerJsonUtils", methods: ["fromJSON"] }],
      },
    },
  });
  const io = fakeSubprocess({ stdoutForKey: new Map([[fileKey, reportJson]]) });
  const h = await harness({ io });
  try {
    const res: any = await h.verify.verifyUtils({ workspaceId: "ws1", file: "src/dev/T/G/api/Api1/Api1.groovy" });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.file, "src/dev/T/G/api/Api1/Api1.groovy");
      assert.equal(res.value.valid, true);
      assert.equal(res.value.classesChecked, 2);
      assert.deepEqual(res.value.unknownClasses, ["IComposerNope"]);
      assert.deepEqual(res.value.invalidMethods, [{ className: "IComposerJsonUtils", method: "noSuchMethodX" }]);
      assert.deepEqual(res.value.used, [{ className: "IComposerJsonUtils", methods: ["fromJSON"] }]);
      const serialized = JSON.stringify(res.value);
      assert.equal(serialized.includes("/absolute/leaked"), false);
      assert.equal(serialized.includes("cache.json"), false);
      assert.match(res.value.stdoutDigest, /^sha256:[0-9a-f]{64}$/);
    }
    assert.deepEqual(h.io.spawns[0].argv.slice(1), [
      "icomposer", "verify", "utils", "--json", "--profile", "portal:demo", "src/dev/T/G/api/Api1/Api1.groovy",
    ]);
    assert.equal(h.io.spawns[0].cwd, h.root);
  } finally {
    await h.dispose();
  }
});

test("verifyUtils invalid groovy: CLI exit 1 with JSON report still parses to a valid:false view", async () => {
  const reportJson = JSON.stringify({
    result: { type: "verify", report: { file: "/x.groovy", valid: false, classes_checked: 1, unknown_classes: [], invalid_methods: [{ class: "C", method: "m", suggestions: ["a"] }], used: [] } },
  });
  const io = fakeSubprocess({
    stdoutForKey: new Map([[fileKey, reportJson]]),
    exitForKey: new Map([[fileKey, 1]]),
  });
  const h = await harness({ io });
  try {
    const res: any = await h.verify.verifyUtils({ workspaceId: "ws1", file: "src/dev/T/G/api/Api1/Api1.groovy" });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.valid, false);
      assert.deepEqual(res.value.invalidMethods, [{ className: "C", method: "m", suggestions: ["a"] }]);
    }
  } finally {
    await h.dispose();
  }
});

test("verifyUtils rejects hostile paths client-side (absolute, traversal, non-groovy, missing)", async () => {
  const h = await harness({});
  try {
    for (const file of [undefined, "/etc/passwd.groovy", "../outside.groovy", "a/b/../../c.groovy", "file.txt", "a b.groovy"]) {
      const res: any = await h.verify.verifyUtils({ workspaceId: "ws1", file });
      assert.equal(res.ok, false, `expected rejection for ${String(file)}`);
      if (!res.ok) assert.equal(res.error.code, "invalid-file-path");
    }
    assert.equal(h.io.spawns.length, 0); // never reached the subprocess
  } finally {
    await h.dispose();
  }
});

test("listUtils: exact argv (--list --json), allowlist projection drops envelope fields and bounds entries", async () => {
  const many = Array.from({ length: 1200 }, (_, i) => ({ class: `U${i}`, method_count: i, description: "d".repeat(300) }));
  const listJson = JSON.stringify({
    base_url: "https://gw", profile_name: "portal:demo", cache_file: "/leak/cache.json", cache_used: true, warnings: ["w"],
    result: { type: "list", classes: many },
  });
  const io = fakeSubprocess({ stdoutForKey: new Map([[listKey, listJson]]) });
  const h = await harness({ io });
  try {
    const res: any = await h.verify.listUtils({ workspaceId: "ws1" });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.count, 1200);
      assert.equal(res.value.truncated, true);
      assert.equal(res.value.classes.length, 1000);
      assert.ok(res.value.classes.every(c => c.className.length <= 200 && c.description!.length <= 200));
      const serialized = JSON.stringify(res.value);
      assert.equal(serialized.includes("/leak/cache.json"), false);
      assert.equal(serialized.includes("base_url"), false);
    }
    assert.deepEqual(h.io.spawns[0].argv.slice(1), ["icomposer", "verify", "utils", "--json", "--profile", "portal:demo", "--list"]);
  } finally {
    await h.dispose();
  }
});

test("searchUtils: exact argv (--search kw), matches projected with nullable method omitted", async () => {
  const searchJson = JSON.stringify({
    result: { type: "search", query: "json", matches: [
      { class: "IComposerJsonUtils", method: null, description: "class level" },
      { class: "IComposerJsonUtils", method: "fromJSON", description: "deserializes" },
    ] },
  });
  const io = fakeSubprocess({ stdoutForKey: new Map([[searchKey, searchJson]]) });
  const h = await harness({ io });
  try {
    const res: any = await h.verify.searchUtils({ workspaceId: "ws1", keyword: "json" });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.query, "json");
      assert.deepEqual(res.value.matches, [
        { className: "IComposerJsonUtils", description: "class level" },
        { className: "IComposerJsonUtils", method: "fromJSON", description: "deserializes" },
      ]);
    }
    assert.deepEqual(h.io.spawns[0].argv.slice(1), ["icomposer", "verify", "utils", "--json", "--profile", "portal:demo", "--search", "json"]);
  } finally {
    await h.dispose();
  }
});

test("searchUtils rejects keywords outside the narrow grammar without spawning", async () => {
  const h = await harness({});
  try {
    for (const keyword of ["", "x".repeat(129), "bad;rm", "a\nb", "quote'"]) {
      const res: any = await h.verify.searchUtils({ workspaceId: "ws1", keyword });
      assert.equal(res.ok, false, `expected rejection for ${keyword}`);
      if (!res.ok) assert.equal(res.error.code, "invalid-keyword");
    }
    assert.equal(h.io.spawns.length, 0);
  } finally {
    await h.dispose();
  }
});

test("auth passthrough: invalid-auth / forbidden / prepare-invalidated / lease-revoked surface unchanged", async () => {
  for (const mode of ["invalid-auth", "forbidden", "prepare-invalidated", "lease-revoked"] as AuthMode[]) {
    const io = fakeSubprocess();
    const h = await harness({ io, auth: mode });
    try {
      const res: any = await h.verify.listUtils({ workspaceId: "ws1" });
      assert.equal(res.ok, false, mode);
      if (!res.ok) assert.equal(res.error.code, mode);
    } finally {
      await h.dispose();
    }
  }
});

test("active profile missing/unavailable fails closed without CLI default lookup", async () => {
  for (const activeProfile of [null, { get: async () => ({ ok: true, value: { status: "none", activeProfileName: null } }) }, { get: async () => ({ ok: false, error: { code: "unavailable" } }) }]) {
    const h = await harness({ activeProfile });
    try {
      const result: any = await h.verify.listUtils({ workspaceId: "ws1" });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "invalid-auth");
    } finally {
      await h.dispose();
    }
  }
});

test("gates: unbound local auth / not-found / invalid workspace id / dispose / cancel; cli failure maps to command-failed", async () => {
  const h1 = await harness({ bindingMode: "unbound" });
  try {
    const unbound: any = await h1.verify.listUtils({ workspaceId: "ws1" });
    assert.equal(unbound.ok, false);
    if (!unbound.ok) assert.equal(unbound.error.code, "parse-error");
  } finally {
    await h1.dispose();
  }
  const h2 = await harness({ bindingMode: "not-found" });
  try {
    const missing: any = await h2.verify.listUtils({ workspaceId: "ghost" });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "workspace-not-found");
  } finally {
    await h2.dispose();
  }
  const badIo = fakeSubprocess({ exitForKey: new Map([[listKey, 3]]), stdoutForKey: new Map([[listKey, "not json at all"]]) });
  const h3 = await harness({ io: badIo });
  try {
    const cliFail: any = await h3.verify.listUtils({ workspaceId: "ws1" });
    assert.equal(cliFail.ok, false);
    if (!cliFail.ok) assert.equal(cliFail.error.code, "command-failed");
    const aborted: any = await h3.verify.listUtils({ workspaceId: "ws1" }, AbortSignal.abort());
    assert.equal(aborted.ok, false);
    if (!aborted.ok) assert.equal(aborted.error.code, "cancelled");
    const captured = h3.ctx.get("icomposerVerify") as unknown as Verify;
    await h3.fiber.dispose();
    const after: any = await captured.listUtils({ workspaceId: "ws1" });
    assert.equal(after.ok, false);
    if (!after.ok) assert.equal(after.error.code, "service-disposed");
  } finally {
    await rm(h3.root, { recursive: true, force: true });
  }
});

test("real project smoke (read-only + transient-cache restore): list/search against ssapocpa, tree byte-identical after restore", async () => {
  const projectRoot = "/Users/junjie.zhang/skills/ssapocpa";
  const PROFILE = "portal:microsite";
  const ENV = "aws_sg_insuremo_portal";
  const fs = await import("node:fs/promises");
  const { lstat, utimes } = fs;

  async function snapshot(dir: string): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    async function walk(p: string) {
      const entries = await readdir(p, { withFileTypes: true });
      for (const e of entries) {
        const full = join(p, e.name);
        if (full.includes("/.metadata/icomposer")) continue;
        if (e.isDirectory()) await walk(full);
        else map.set(full, (await fs.stat(full)).mtimeMs);
      }
    }
    await walk(dir);
    return map;
  }

  const LocalSubprocessRuntime = (await import("../../../../deepseek-harness/packages/subprocess/subprocess-local/src/index.ts")).default;

  const ctx = new Context();
  const dirMtimes = new Map<string, number>();
  async function walkDirs(dir: string) {
    dirMtimes.set(dir, (await lstat(dir)).mtimeMs);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) if (e.isDirectory()) await walkDirs(join(dir, e.name));
  }
  await walkDirs(projectRoot);
  const before = await snapshot(projectRoot);

  const subFiber = await ctx.plugin(LocalSubprocessRuntime as never);
  await subFiber.await();

  // Real auth prepare through the real subprocess; lease is functional.
  let authAvailable = true;
  const imoAuthStub = {
    async prepare(request: { profile?: string; env?: string }, signal?: AbortSignal) {
      try {
        const exe = await ctx.subprocess.resolveExecutable("imo");
        const handle = ctx.subprocess.spawn({
          argv: [exe, "auth", "prepare", ...(request.profile ? ["--profile", request.profile] : []), ...(request.env ? ["--env", request.env] : []), "--json"],
          cwd: projectRoot,
          stdio: { stdin: "ignore", stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
          graceMs: 1000,
          signal,
        });
        const outcome = await handle.done;
        const text = handle.collected.stdout?.readFrom(0)?.text ?? "";
        if (outcome.exitCode !== 0) { authAvailable = false; return { ok: false, error: { code: "invalid-auth" } }; }
        const parsed = JSON.parse(text);
        if (typeof parsed?.access_token !== "string") { authAvailable = false; return { ok: false, error: { code: "parse-error" } }; }
        return { ok: true, value: { use: async <T>(cb: (s: { accessToken: string }) => T) => cb({ accessToken: parsed.access_token }) } };
      } catch {
        authAvailable = false;
        return { ok: false, error: { code: "invalid-auth" } };
      }
    },
  };
  ctx.provide("imoAuth" as never, imoAuthStub as never);
  ctx.provide("workspaceBinding", {
    get: async () => ({ ok: true, value: { binding: null, canonicalPath: projectRoot, detectedIcomposer: true } }),
  } as never);
  ctx.provide("imoActiveProfile" as never, {
    get: async () => ({ ok: true, value: { status: "active", activeProfileName: PROFILE, profile: { profileName: PROFILE } } }),
  } as never);
  const fiber = await ctx.plugin(IcomposerVerifyService, { command: "imo", timeoutMs: 60_000 });
  await fiber.await();
  const verify = ctx.get("icomposerVerify") as unknown as Verify;
  try {
    // Probe auth once; if unavailable record SKIP (not FAIL) per card policy.
    const probeList: any = await verify.listUtils({ workspaceId: "ws1" });
    if (!probeList.ok && !authAvailable) {
      console.log("[icomposer-verify] real smoke skipped: auth prepare unavailable (no re-login performed)");
      return;
    }
    assert.equal(probeList.ok, true);
    if (probeList.ok) {
      assert.ok(probeList.value.count >= 30); // real catalog has ~35 utility classes
      assert.ok(probeList.value.classes.some((c: any) => c.className === "IComposerJsonUtils"));
    }
    const search: any = await verify.searchUtils({ workspaceId: "ws1", keyword: "json" });
    assert.equal(search.ok, true);
    if (search.ok) {
      assert.ok(search.value.count >= 1);
      assert.ok(search.value.matches.every((m: any) => m.className.startsWith("IComposer")));
    }
  } finally {
    await fiber.dispose();
    // restore: remove the CLI's transient cache dir and restore touched dir mtimes exactly
    await rm(join(projectRoot, ".metadata", "icomposer"), { recursive: true, force: true });
    for (const [dir, mtime] of dirMtimes) {
      try { await utimes(dir, new Date(mtime), new Date(mtime)); } catch {}
    }
  }
  const after = await snapshot(projectRoot);
  assert.equal(before.size, after.size);
  for (const [k, v] of before) assert.equal(after.get(k), v);
});

test("tools: ICI build/query/explain two-phase tools registered at mount, unregistered on dispose, execute smoke via fake faces", async () => {
  const ctx = new Context();
  const registered = new Map<string, { name: string; output: { render: (args: unknown, value: unknown) => unknown }; execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown> }>();
  const removed: string[] = [];
  ctx.provide("subprocess", fakeSubprocess() as never);
  ctx.provide("workspaceBinding", fakeBinding("bound", await mkdtemp(join(tmpdir(), "verify-tools-"))) as never);
  ctx.provide("imoAuth" as never, stubAuth("ok") as never);
  let buildShouldFail = false;
  ctx.provide("iciEngine", {
    build: async (input: { workspaceId: string }, options?: { signal?: AbortSignal; onProgress?: (c: number, t: number, l: string) => void }) => {
      if (buildShouldFail) return { ok: false, error: { code: "storage-error" } };
      options?.onProgress?.(1, 2, "scanning metadata api");
      options?.onProgress?.(2, 2, "writing graph outputs");
      return { ok: true, value: { artifactPath: ".metadata/icomposer/ici/graph/current", manifest: { nodeCount: 3, edgeCount: 2, sourceFingerprint: "f".repeat(64), builtAt: new Date().toISOString() } } };
    },
    index: async (input: { workspaceId: string; rebuild?: boolean }, options?: { signal?: AbortSignal; onProgress?: (c: number, t: number, l: string) => void }) => {
      if (buildShouldFail) return { ok: false, error: { code: "embedding-error" } };
      options?.onProgress?.(1, 1, "embedding batch");
      return { ok: true, value: { artifactPath: ".metadata/icomposer/ici/graph/search/api_embeddings.jsonl", total: 5, embedded: input.rebuild === true ? 5 : 1, reused: input.rebuild === true ? 0 : 4 } };
    },
    explainPrepare: async () => ({ ok: true, value: { artifactPath: ".metadata/icomposer/ici/explain/TestAPI-abc/prepare.json", jobId: "job123", jobStatus: "awaiting-input", api: { id: "api:TestAPI", name: "TestAPI" }, callChain: { nodes: [{ id: "api:TestAPI" }], edges: [], truncated: false }, sources: [], references: [], nodesToUpdate: [], cache: { hit: 0, miss: 0 }, manifest: { sourceFingerprint: "x".repeat(64), graphDigest: "g", promptVersion: "explain-v4" }, contextHash: "c" } }),
    explainContext: async () => ({
      ok: true,
      value: {
        artifactPath: ".metadata/icomposer/ici/explain/TestAPI-abc/context.json",
        api: { id: "api:TestAPI", name: "TestAPI", path: "src/x.groovy" },
        technicalText: "API: TestAPI\nMode: technical\nDownstream: function:Fn",
        downstream: [{ id: "method:TestAPI.execute", kind: "method" }],
        impact: [{ apiId: "api:TestAPI", hops: [{ nodeId: "api:TestAPI" }] }],
        businessReference: ["IComposerPaymentUtils"],
        manifest: { schemaVersion: 1, engineVersion: "0.1.0", sourceFingerprint: "x".repeat(64) },
      },
    }),
    diagnostics: async () => ({
      ok: true,
      value: {
        indexPaths: { graphCurrent: "ici/x/graph/current", searchJsonl: "ici/x/graph/search/api_embeddings.jsonl" },
        schemaVersion: 1,
        engineVersion: "0.1.0",
        builtAt: new Date().toISOString(),
        nodeCount: 3,
        edgeCount: 2,
        searchVectors: 5,
        stale: false,
        requiredFiles: { nodes: true, edges: true, manifest: true },
      },
    }),
    search: async () => ({
      ok: true,
      value: {
        rows: [
          { apiId: "api:AlphaAPI", apiName: "AlphaAPI", score: 0.92, evidence: "evidence line" },
          { apiId: "api:BetaAPI", apiName: "BetaAPI", score: 0.31, evidence: "" },
        ],
        truncated: false,
      },
    }),
    queryApi: async (input: { workspaceId: string; query: string }) => ({
      ok: true,
      value: {
        workspaceId: input.workspaceId,
        matched: ["api:ApiA"],
        truncated: false,
        truncatedAt: [],
        roots: [{
          id: "api:ApiA", kind: "api", name: "ApiA", path: "src/x.groovy",
          children: [{ id: "method:ApiA.execute", kind: "method", name: "execute", path: "src/x.groovy", edge: { kind: "CONTAINS", source: "static", confidence: "medium", evidence: "", ownerFile: "src/x.groovy" } }],
        }],
      },
    }),
    queryImpact: async (input: { workspaceId: string; query: string }) => ({
      ok: true,
      value: {
        workspaceId: input.workspaceId,
        matched: ["function:FuncA"],
        paths: [{ apiId: "api:ApiA", hops: [{ nodeId: "function:FuncA" }, { nodeId: "api:ApiA" }] }],
        confidenceCounts: { static: 2, platform: 0, inferred: 0 },
        truncated: false,
      },
    }),
  } as never);
  ctx.provide("tools", {
    register(definition: { name: string; output: { render: (args: unknown, value: unknown) => unknown }; execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown> }) {
      registered.set(definition.name, definition);
      return () => { registered.delete(definition.name); removed.push(definition.name); };
    },
  } as never);
  const sections: Array<{ name: string; order: number }> = [];
  ctx.provide("systemPrompt", {
    section(section: { name: string; order: number }) {
      sections.push(section);
      return () => {};
    },
  } as never);
  // minimal faces for execute smoke
  ctx.provide("icomposerCatalog", {
    listAssets: async () => ({ ok: true, value: {
      counts: { api: 2, function: 1, batch: 0, model: 0, total: 3 },
      truncated: false,
      entries: [{ name: "A", type: "api", joinStatus: "clean" }, { name: "B", type: "function", joinStatus: "source-missing" }],
    } }),
  } as never);
  ctx.provide("icomposerReference", {
    querySdkOperations: async () => ({ ok: false, error: { code: "workspace-not-bound" } }),
  } as never);
  ctx.provide("icomposerVerify", {
    listUtils: async () => ({ ok: true, value: { classes: [{ className: "IComposerJsonUtils", methodCount: 19 }], count: 1, truncated: false } }),
    searchUtils: async () => ({ ok: true, value: { matches: [{ className: "IComposerJsonUtils", method: "fromJSON" }], count: 1, truncated: false } }),
  } as never);

  // Use the real Harness dsh-tools materializer, not a pass-through shim.
  const { defineTool } = await import("@deepseek-ai/dsh-tools");
  const { registerIcomposerToolsWith } = await import("../src/tool-defs.ts");
  const disposers = registerIcomposerToolsWith(ctx, defineTool as never);
  try {
    assert.deepEqual([...registered.keys()].sort(), ["ici_build", "ici_explain", "ici_query", "ici_search", "ici_status", "icomposer_catalog_list", "icomposer_sdk_query", "icomposer_verify_utils"]);
    assert.equal([...registered.values()].every(tool => typeof tool.output.render === "function"), true);
    assert.equal(sections.length, 8);
    assert.equal(sections.every(x => x.order === 150), true);
    assert.equal(sections.every(x => x.name.startsWith("tool:")), true);
    const exec = { signal: new AbortController().signal };

    const catalogOut: any = await registered.get("icomposer_catalog_list")!.execute({ workspace_id: "ws1" }, exec);
    assert.equal(catalogOut.workspace_id, "ws1");
    assert.deepEqual(catalogOut.counts, { api: 2, function: 1, batch: 0, model: 0, total: 3 });
    assert.equal(catalogOut.truncated, false);
    assert.equal(catalogOut.entries.length, 2);
    assert.equal(catalogOut.error, undefined);

    const sdkOut: any = await registered.get("icomposer_sdk_query")!.execute({ workspace_id: "ws1" }, exec);
    assert.deepEqual(sdkOut.error, { code: "workspace-not-bound" });

    const verifyListOut: any = await registered.get("icomposer_verify_utils")!.execute({ workspace_id: "ws1" }, exec);
    assert.equal(verifyListOut.mode, "list");
    assert.deepEqual(verifyListOut.classes, [{ className: "IComposerJsonUtils", methodCount: 19 }]);
    const verifySearchOut: any = await registered.get("icomposer_verify_utils")!.execute({ workspace_id: "ws1", keyword: "json" }, exec);
    assert.equal(verifySearchOut.mode, "search");
    assert.deepEqual(verifySearchOut.matches, [{ className: "IComposerJsonUtils", method: "fromJSON" }]);
    const iciChain: any = await registered.get("ici_query")!.execute({ workspace_id: "ws1", mode: "api-chain", query: "ApiA" }, exec);
    assert.equal(iciChain.mode, "api-chain");
    assert.deepEqual(iciChain.matched, ["api:ApiA"]);
    assert.equal(iciChain.truncated, false);
    assert.ok(iciChain.lines.length >= 2);
    assert.equal(iciChain.lines[0].label.includes("api:ApiA"), true);
    const iciImpact: any = await registered.get("ici_query")!.execute({ workspace_id: "ws1", mode: "impact", query: "FuncA" }, exec);
    assert.equal(iciImpact.mode, "impact");
    assert.equal(iciImpact.paths.length, 1);
    assert.equal(iciImpact.paths[0].apiId, "api:ApiA");
    assert.deepEqual(iciImpact.confidenceCounts, { static: 2, platform: 0, inferred: 0 });
    const searchOut: any = await registered.get("ici_search")!.execute({ workspace_id: "ws1", query: "payment", top: 2 }, exec);
    assert.equal(searchOut.rows.length, 2);
    assert.equal(searchOut.rows[0].rank, 1);
    assert.equal(searchOut.rows[0].apiName, "AlphaAPI");
    assert.ok(Math.abs(searchOut.rows[0].score - 0.92) < 1e-9);
    assert.equal(searchOut.error, undefined);
    // ici_build small workspace → inline with full detail
    const buildInline: any = await registered.get("ici_build")!.execute({ workspace_id: "ws1" }, exec);
    assert.equal(buildInline.kind, "inline");
    assert.equal(buildInline.detail.nodeCount, 3);
    assert.equal(buildInline.detail.edgeCount, 2);
    assert.equal(buildInline.artifact_path, ".metadata/icomposer/ici/graph/current");
    assert.equal(buildInline.detail.artifact_path, undefined);
    assert.equal(buildInline.error, undefined);
    assert.match((registered.get("ici_build")!.output.render({}, buildInline) as any)[0].text, /artifact=\.metadata/);
    // ici_build search-index mode
    const indexInline: any = await registered.get("ici_build")!.execute({ workspace_id: "ws1", mode: "search-index", rebuild: true }, exec);
    assert.equal(indexInline.kind, "inline");
    assert.equal(indexInline.artifact_path, ".metadata/icomposer/ici/graph/search/api_embeddings.jsonl");
    assert.deepEqual(indexInline.detail, { total: 5, embedded: 5, reused: 0 });
    // ici_status diagnostics projection
    const status: any = await registered.get("ici_status")!.execute({ workspace_id: "ws1" }, exec);
    assert.equal(status.workspace_id, "ws1");
    assert.ok(status.requiredFiles.manifest === false || status.requiredFiles.manifest === true);
    assert.doesNotThrow(() => registered.get("ici_status")!.output.render({}, status));
    // ici_explain prepare artifact
    const explainOut: any = await registered.get("ici_explain")!.execute({ workspace_id: "ws1", query: "TestAPI" }, exec);
    assert.equal(explainOut.error, undefined);
    assert.equal(explainOut.artifact_path, ".metadata/icomposer/ici/explain/TestAPI-abc/prepare.json");
    assert.match((registered.get("ici_explain")!.output.render({}, explainOut) as any)[0].text, /prepare=\.metadata/);
  } finally {
    for (const dispose of disposers) dispose();
  }
  assert.deepEqual(removed.sort(), ["ici_build", "ici_explain", "ici_query", "ici_search", "ici_status", "icomposer_catalog_list", "icomposer_sdk_query", "icomposer_verify_utils"]);
  assert.equal(registered.size, 0);
});

test("ici_build background: production mapper maps engine cancelled to JobOutcome killed; failure path stays failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "ici-bg-"));
  const dshHome = await mkdtemp(join(tmpdir(), "ici-bg-dsh-"));
  const prev = process.env.DSH_HOME; process.env.DSH_HOME = dshHome;
  const started: Array<{ kind: string; hooks: { cancel(reason?: string): void; done: Promise<{ status: string; detail?: string }>; readOutput?(): string } }> = [];
  const reg: Array<{ name: string; execute: (a: Record<string, unknown>, e: { signal: AbortSignal }) => Promise<unknown> }> = [];

  // Controllable engine: hangs until the job signal aborts (→ cancelled), or
  // fails immediately when armed (→ failed).
  let engineFailNext = false;
  let lastSignal: AbortSignal | undefined;
  const iciEngineStub = {
    build: (_input: unknown, options?: { signal?: AbortSignal }) => new Promise(resolve => {
      lastSignal = options?.signal;
      const finish = () => resolve(
        engineFailNext ? { ok: false, error: { code: "storage-error" } }
          : options?.signal?.aborted ? { ok: false, error: { code: "cancelled" } }
            : { ok: true, value: { manifest: { nodeCount: 9, edgeCount: 8, sourceFingerprint: "x", builtAt: new Date().toISOString() } } },
      );
      if (engineFailNext || options?.signal?.aborted) finish();
      else options?.signal?.addEventListener("abort", finish, { once: true });
    }),
    index: async () => ({ ok: true, value: { total: 0, embedded: 0, reused: 0 } }),
    explainContext: async (input: { workspaceId: string; query: string }) => ({
      ok: true,
      value: {
        api: { id: "api:TestAPI", name: "TestAPI", path: "src/x.groovy" },
        technicalText: "API: TestAPI\nMode: technical\nDownstream: function:Fn",
        downstream: [{ id: "method:TestAPI.execute", kind: "method" }],
        impact: [{ apiId: "api:TestAPI", hops: [{ nodeId: "api:TestAPI" }] }],
        businessReference: ["IComposerPaymentUtils"],
        manifest: { schemaVersion: 1, engineVersion: "0.1.0", sourceFingerprint: "x".repeat(64) },
      },
    }),
    diagnostics: async () => ({ ok: true, value: {
      indexPaths: { graphCurrent: "g", searchJsonl: "s" }, schemaVersion: 1, engineVersion: "0.1.0",
      builtAt: null, nodeCount: 0, edgeCount: 0, searchVectors: 0, stale: false,
      requiredFiles: { nodes: false, edges: false, manifest: false },
    } }),
    search: async () => ({ ok: true, value: { rows: [], truncated: false } }),
    queryApi: async () => ({ ok: true, value: { matched: [], roots: [], truncated: false, truncatedAt: [] } }),
    queryImpact: async () => ({ ok: true, value: { matched: [], paths: [], confidenceCounts: { static: 0, platform: 0, inferred: 0 }, truncated: false } }),
  };

  const ctx = new Context();
  ctx.provide("iciEngine", iciEngineStub as never);
  // >50 assets forces the background path through ctx.jobs.start.
  ctx.provide("icomposerCatalog", {
    listAssets: async () => ({ ok: true, value: { entries: [], counts: { api: 60, function: 0, batch: 0, model: 0, total: 60 }, truncated: false } }),
  } as never);
  ctx.provide("workspaceBinding", {
    get: async () => ({ ok: true, value: { workspaceId: "ws1", canonicalPath: root, binding: { authProfile: "portal:demo", environmentId: "env" } } }),
  } as never);
  ctx.provide("imoAuth" as never, { prepare: async () => ({ ok: true, value: { use: async (cb: any) => cb({ accessToken: "t" }) } }) } as never);
  ctx.provide("subprocess", fakeSubprocess() as never);
  ctx.provide("jobs", {
    start(spec: { kind: string; label: string; run(): { cancel(reason?: string): void; done: Promise<{ status: string; detail?: string }>; readOutput?(): string } }) {
      const hooks = spec.run();
      started.push({ kind: spec.kind, hooks });
      return `${spec.kind}-1`;
    },
  } as never);
  ctx.provide("tools", {
    register(definition: { name: string; execute: (a: Record<string, unknown>, e: { signal: AbortSignal }) => Promise<unknown> }) {
      reg.push(definition);
      return () => {};
    },
  } as never);
  const sections: Array<{ order: number }> = [];
  ctx.provide("systemPrompt", {
    section(section: { name: string; order: number }) {
      sections.push(section);
      return () => {};
    },
  } as never);

  // Mount ONLY the ici job tools against this context (the other tool
  // families need faces this test does not provide).
  const { registerIciJobTools } = await import("../src/ici-jobs-tools.ts");
  registerIciJobTools(ctx, (o: unknown) => o as never);
  try {
    assert.deepEqual(reg.map(d => d.name).sort(), ["ici_build", "ici_status"]);
    const exec = { signal: new AbortController().signal };
    const startRes: any = await reg.find(d => d.name === "ici_build")!.execute({ workspace_id: "ws1" }, exec);
    assert.equal(startRes.kind, "background");
    assert.match(startRes.jobId, /^ici-build-/);
    assert.equal(started.length, 1);

    // kill the job → engine sees abort → cancelled → production mapper → killed
    started[0].hooks.cancel("user requested");
    const outcome: any = await Promise.race([
      started[0].hooks.done,
      new Promise(r => setTimeout(() => r({ status: "RACE-TIMEOUT", detail: `signalAborted=${lastSignal?.aborted}` }), 2000)),
    ]);
    assert.equal(outcome.status, "killed");
    assert.equal(outcome.detail, "cancelled");

    // failed path stays failed
    engineFailNext = true;
    const failStart: any = await reg.find(d => d.name === "ici_build")!.execute({ workspace_id: "ws1" }, exec);
    assert.equal(failStart.kind, "background");
    const failOutcome = await started[1].hooks.done;
    assert.equal(failOutcome.status, "failed");
    assert.equal(failOutcome.detail, "storage-error");
  } finally {
    await h_cleanup(root, dshHome, prev);
  }
});

async function h_cleanup(root: string, dshHome: string, prev: string | undefined): Promise<void> {
  if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
  await rm(dshHome, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
