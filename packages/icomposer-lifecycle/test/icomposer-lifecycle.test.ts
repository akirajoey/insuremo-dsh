import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import type { SubprocessHandle, SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import { IcomposerLifecycleService } from "../src/service.ts";

const validEnv = "env1";

function reader(text: string): { readFrom(from: number): { text: string; nextOffset: number; lossy: boolean } } {
  return { readFrom() { return { text, nextOffset: 0, lossy: false }; } };
}

function handleFor(stdout: string, exitCode: number, signal?: AbortSignal): SubprocessHandle {
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
  if (signal?.aborted) handle.terminate();
  else signal?.addEventListener("abort", () => handle.terminate(), { once: true });
  return handle;
}

interface SpawnFacts {
  argv: readonly string[];
  cwd: string;
}

function fakeSubprocess(over: {
  stdoutForKey?: Map<string, string>;
  exitForKey?: Map<string, number>;
  spawns?: SpawnFacts[];
  pendingKey?: string | null;
} = {}): SubprocessRuntime & { spawns: SpawnFacts[]; stdoutForKey: Map<string, string> } {
  const io = {
    stdoutForKey: over.stdoutForKey ?? new Map(),
    exitForKey: over.exitForKey ?? new Map(),
    spawns: over.spawns ?? [],
    pendingKey: over.pendingKey ?? null,
  };
  const runtime = {
    spawns: io.spawns,
    stdoutForKey: io.stdoutForKey,
    async resolveExecutable() { return "/opt/homebrew/bin/imo"; },
    spawn(spec: { argv: readonly string[]; cwd: string; signal?: AbortSignal }) {
      io.spawns.push({ argv: spec.argv, cwd: spec.cwd });
      const key = spec.argv.slice(1).join(" ");
      const stdout = io.stdoutForKey.get(key) ?? "{}";
      const exit = io.exitForKey.get(key) ?? 0;
      return handleFor(stdout, exit, spec.signal);
    },
  } as unknown as SubprocessRuntime & { spawns: SpawnFacts[]; stdoutForKey: Map<string, string> };
  return runtime;
}

type AuthMode = "ok" | "invalid-auth" | "forbidden" | "prepare-invalidated" | "lease-revoked";

function stubAuth(mode: AuthMode) {
  return {
    prepare: async () => {
      if (mode === "invalid-auth") return { ok: false, error: { code: "invalid-auth" } };
      if (mode === "forbidden") return { ok: false, error: { code: "forbidden" } };
      if (mode === "prepare-invalidated") return { ok: false, error: { code: "prepare-invalidated" } };
      return {
        ok: true,
        value: {
          use: async (cb: (s: { accessToken: string }) => unknown) => {
            if (mode === "lease-revoked") throw new Error("revoked");
            return cb({ accessToken: "sekret-token" });
          },
        },
      };
    },
  };
}

interface BindingView {
  binding: { authProfile: string; environmentId: string } | null;
  canonicalPath: string;
}

function fakeBinding(mode: "bound" | "unbound" | "not-found", canonicalPath: string) {
  return {
    get: async (id: string) => {
      if (mode === "not-found") return { ok: false, error: { code: "workspace-not-found" } };
      if (mode === "unbound") return { ok: true, value: { binding: null, canonicalPath } };
      return { ok: true, value: { binding: { authProfile: "portal:demo", environmentId: validEnv }, canonicalPath } };
    },
  };
}

type Lifecycle = {
  initPreview(input: unknown, signal?: AbortSignal): Promise<unknown>;
  reloadPreview(input: unknown, signal?: AbortSignal): Promise<unknown>;
};

async function harness(opts: {
  io?: ReturnType<typeof fakeSubprocess>;
  auth?: AuthMode;
  binding?: { mode: "bound" | "unbound" | "not-found"; root: string };
  config?: Record<string, unknown>;
  dispose?: boolean;
} = {}) {
  const ctx = new Context();
  const io = opts.io ?? fakeSubprocess();
  const root = opts.binding?.root ?? (await mkdtemp(join(tmpdir(), "lc-root-")));
  ctx.provide("subprocess", io as never);
  ctx.provide("imoAuth" as never, stubAuth(opts.auth ?? "ok") as never);
  ctx.provide("workspaceBinding", fakeBinding(opts.binding?.mode ?? "bound", root) as never);
  const fiber = await ctx.plugin(IcomposerLifecycleService, { command: "imo", timeoutMs: 5000, ...(opts.config ?? {}) });
  await fiber.await();
  const lifecycle = ctx.get("icomposerLifecycle") as unknown as Lifecycle;
  return {
    ctx,
    io: io as unknown as { spawns: SpawnFacts[] },
    root,
    lifecycle,
    fiber,
    dispose: async () => { await fiber.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}

const groupsJson = JSON.stringify({
  type: "groups",
  groups: [
    { GroupId: 1, Name: "BCP API", Path: "BCP_API", Code: "BCP_API", ResourceTypeCode: "RESTAPI", Module: { Name: "secret-module" }, access_token: "LEAKED_TOKEN" },
    { GroupId: 2, Name: "Policy API", Path: "Policy_API", Code: "Policy_API" },
  ],
});

const planJson = JSON.stringify({
  type: "plan",
  group_id: 572064923,
  steps: ["reload code for group 572064923", "download SDK clients", "write utility reference docs"],
});

test("initPreview list-groups: exact argv (profile from binding), cwd=canonicalPath, allowlist projection hides hostiles", async () => {
  const io = fakeSubprocess({ stdoutForKey: new Map([["icomposer init --dry-run --json --profile portal:demo --list-groups", groupsJson]]) });
  const h = await harness({ io });
  try {
    const res: any = await h.lifecycle.initPreview({ workspaceId: "ws1", listGroups: true });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.mode, "groups");
      assert.equal(res.value.count, 2);
      assert.equal(res.value.truncated, false);
      assert.deepEqual(res.value.groups, [
        { id: "1", name: "BCP API", path: "BCP_API", code: "BCP_API" },
        { id: "2", name: "Policy API", path: "Policy_API", code: "Policy_API" },
      ]);
      const serialized = JSON.stringify(res.value);
      assert.equal(serialized.includes("LEAKED_TOKEN"), false);
      assert.equal(serialized.includes("secret-module"), false);
      assert.match(res.value.stdoutDigest, /^sha256:[0-9a-f]{64}$/);
    }
    assert.deepEqual(h.io.spawns[0].argv.slice(1), ["icomposer", "init", "--dry-run", "--json", "--profile", "portal:demo", "--list-groups"]);
    assert.equal(h.io.spawns[0].argv[0], "/opt/homebrew/bin/imo");
    assert.equal(h.io.spawns[0].cwd, h.root);
  } finally {
    await h.dispose();
  }
});

test("initPreview plan: group-id argv, steps bounded to <=200 and <=1000 with truncated flag", async () => {
  const io = fakeSubprocess({ stdoutForKey: new Map([[
    "icomposer init --dry-run --json --profile portal:demo --group-id 572064923",
    JSON.stringify({ type: "plan", group_id: 572064923, steps: ["x".repeat(300), "normal step"] }),
  ]]) });
  const h = await harness({ io });
  try {
    const res: any = await h.lifecycle.initPreview({ workspaceId: "ws1", groupId: "572064923" });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.mode, "plan");
      assert.equal(res.value.groupId, "572064923");
      assert.equal(res.value.steps.length, 2);
      assert.equal(res.value.steps[0].length, 200);
      assert.equal(res.value.steps[0].endsWith("…"), true);
      assert.equal(res.value.count, 2);
    }
    assert.deepEqual(h.io.spawns[0].argv.slice(1), ["icomposer", "init", "--dry-run", "--json", "--profile", "portal:demo", "--group-id", "572064923"]);
  } finally {
    await h.dispose();
  }
});

test("hostile truncated group list is capped at 1000 and fields bounded", async () => {
  const many: unknown[] = [];
  for (let i = 0; i < 1200; i++) many.push({ GroupId: i, Name: "g".repeat(200), Path: "p".repeat(160), Code: "c".repeat(140) });
  const io = fakeSubprocess({ stdoutForKey: new Map([[
    "icomposer init --dry-run --json --profile portal:demo --list-groups",
    JSON.stringify({ type: "groups", groups: many }),
  ]]) });
  const h = await harness({ io });
  try {
    const res: any = await h.lifecycle.initPreview({ workspaceId: "ws1", listGroups: true });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.value.groups.length, 1000);
      assert.equal(res.value.truncated, true);
      assert.ok(res.value.groups.every((g: any) => g.name.length <= 128 && g.path.length <= 128 && g.code.length <= 128));
    }
  } finally {
    await h.dispose();
  }
});

test("initPreview cli failure and parse failure map to command-failed / parse-error", async () => {
  const io = fakeSubprocess({
    stdoutForKey: new Map([["icomposer init --dry-run --json --profile portal:demo --list-groups", "{ not json"]]),
    exitForKey: new Map([["icomposer init --dry-run --json --profile portal:demo --group-id 5", 7]]),
  });
  const h = await harness({ io });
  try {
    const parseFail: any = await h.lifecycle.initPreview({ workspaceId: "ws1", listGroups: true });
    assert.equal(parseFail.ok, false);
    if (!parseFail.ok) assert.equal(parseFail.error.code, "parse-error");
    const cliFail: any = await h.lifecycle.initPreview({ workspaceId: "ws1", groupId: "5" });
    assert.equal(cliFail.ok, false);
    if (!cliFail.ok) assert.equal(cliFail.error.code, "command-failed");
  } finally {
    await h.dispose();
  }
});

test("initPreview auth/passthrough: invalid-auth, forbidden, prepare-invalidated, lease-revoked", async () => {
  for (const mode of ["invalid-auth", "forbidden", "prepare-invalidated", "lease-revoked"] as AuthMode[]) {
    const io = fakeSubprocess();
    const h = await harness({ io, auth: mode });
    try {
      const res: any = await h.lifecycle.initPreview({ workspaceId: "ws1", listGroups: true });
      assert.equal(res.ok, false, `expected ${mode} to fail`);
      if (!res.ok) assert.equal(res.error.code, mode);
    } finally {
      await h.dispose();
    }
  }
});

test("initPreview gates: invalid group id, unbound, not-found, invalid workspace id, dispose, cancels", async () => {
  // invalid group
  const h1 = await harness({});
  try {
    const bad: any = await h1.lifecycle.initPreview({ workspaceId: "ws1", groupId: "abc;rm -rf" });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.error.code, "invalid-group-id");
    const badWs: any = await h1.lifecycle.initPreview({ workspaceId: "" });
    assert.equal(badWs.ok, false);
    if (!badWs.ok) assert.equal(badWs.error.code, "invalid-workspace-id");
  } finally {
    await h1.dispose();
  }
  const h2 = await harness({ binding: { mode: "unbound", root: await mkdtemp(join(tmpdir(), "lc-u-")) } });
  try {
    const unbound: any = await h2.lifecycle.initPreview({ workspaceId: "ws1" });
    assert.equal(unbound.ok, false);
    if (!unbound.ok) assert.equal(unbound.error.code, "workspace-not-bound");
  } finally {
    await h2.dispose();
  }
  const h3 = await harness({ binding: { mode: "not-found", root: await mkdtemp(join(tmpdir(), "lc-n-")) } });
  try {
    const missing: any = await h3.lifecycle.initPreview({ workspaceId: "ghost" });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "workspace-not-found");
  } finally {
    await h3.dispose();
  }
  // cancel + dispose
  const h4 = await harness({});
  try {
    const aborted: any = await h4.lifecycle.initPreview({ workspaceId: "ws1" }, AbortSignal.abort());
    assert.equal(aborted.ok, false);
    if (!aborted.ok) assert.equal(aborted.error.code, "cancelled");
    const captured = h4.ctx.get("icomposerLifecycle");
    await h4.fiber.dispose();
    const after: any = await (captured as unknown as Lifecycle).initPreview({ workspaceId: "ws1" });
    assert.equal(after.ok, false);
    if (!after.ok) assert.equal(after.error.code, "service-disposed");
    const pr: any = await (captured as unknown as Lifecycle).reloadPreview({ workspaceId: "ws1" });
    assert.equal(pr.ok, false);
    if (!pr.ok) assert.equal(pr.error.code, "service-disposed");
  } finally {
    await rm(h4.root, { recursive: true, force: true });
  }
});

async function writeMeta(root: string, type: string, name: string, meta: Record<string, unknown>) {
  await mkdir(join(root, ".metadata", type), { recursive: true });
  await writeFile(join(root, ".metadata", type, `${name}.metadata.json`), JSON.stringify({ [type]: meta }));
}

async function writeGroovy(root: string, tenant: string, group: string, type: string, name: string, content: string) {
  const p = join(root, "src", "dev", tenant, group, type, name);
  await mkdir(p, { recursive: true });
  await writeFile(join(p, `${name}.groovy`), content);
}

async function buildReloadFixture(root: string) {
  const cleanContent = "def clean = 1\n";
  const cleanMd5 = createHash("md5").update(cleanContent).digest("hex");
  await writeMeta(root, "api", "CleanAPI", { Name: "CleanAPI", Md5Value: cleanMd5 });
  await writeGroovy(root, "T", "G", "api", "CleanAPI", cleanContent);
  await writeMeta(root, "api", "DirtyAPI", { Name: "DirtyAPI", Md5Value: "deadbeef".repeat(4) });
  await writeGroovy(root, "T", "G", "api", "DirtyAPI", "changed!\n");
  await writeMeta(root, "api", "NoMd5API", { Name: "NoMd5API" });
  await writeGroovy(root, "T", "G", "api", "NoMd5API", "x\n");
  await writeMeta(root, "function", "Orphan", { Name: "Orphan" });
  await writeGroovy(root, "T", "G", "function", "SourceOnly", "y\n");
  return { cleanContent, cleanMd5 };
}

test("reloadPreview reports local join distribution with bounded top names", async () => {
  const h = await harness({});
  try {
    await buildReloadFixture(h.root);
    const res: any = await h.lifecycle.reloadPreview({ workspaceId: "ws1" });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.value.distribution, { clean: 1, localModified: 1, noServerMd5: 1, sourceMissing: 1, metadataMissing: 1 });
      assert.equal(res.value.total, 5);
      assert.ok(res.value.top.length <= 50);
      assert.ok(res.value.top.every((t: any) => t.name && t.type));
    }
  } finally {
    await h.dispose();
  }
});

test("real project smoke (read-only): reloadPreview distribution matches known catalog counts, tree unchanged", async () => {
  const projectRoot = "/Users/junjie.zhang/skills/ssapocpa";
  async function snapshot(dir: string): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    async function walk(p: string) {
      const entries = await readdir(p, { withFileTypes: true });
      for (const e of entries) {
        const full = join(p, e.name);
        if (e.isDirectory()) await walk(full);
        else {
          const st = await stat(full);
          map.set(full, st.mtimeMs);
        }
      }
    }
    await walk(dir);
    return map;
  }
  const before = await snapshot(projectRoot);
  const h = await harness({ binding: { mode: "bound", root: projectRoot } });
  // do not rm real project root
  try {
    const res: any = await h.lifecycle.reloadPreview({ workspaceId: "ws1" });
    assert.equal(res.ok, true);
    if (res.ok) {
      const d = res.value.distribution;
      assert.equal(d.clean, 434);
      assert.equal(d.localModified, 3);
      assert.equal(d.noServerMd5, 17);
      assert.equal(d.sourceMissing, 5);
      assert.equal(d.metadataMissing, 0);
      assert.equal(res.value.total, 459);
      assert.ok(res.value.top.length <= 50);
    }
  } finally {
    await h.fiber.dispose();
  }
  const after = await snapshot(projectRoot);
  assert.equal(before.size, after.size);
  for (const [k, v] of before) assert.equal(after.get(k), v);
});

async function stat(p: string) {
  const { stat } = await import("node:fs/promises");
  return stat(p);
}
