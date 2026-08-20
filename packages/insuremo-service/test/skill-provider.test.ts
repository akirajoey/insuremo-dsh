import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import { ImoSkillsService, invalidateInsuremoSkillCatalog, type ImoSkills } from "../src/index.ts";
import { InsuremoSkillProvider } from "../src/skill-provider.ts";
import { fakeHandle, fakeSubprocess, makeFakeIo, skillsFixture } from "./support/fake-subprocess.ts";

interface CatalogFixture {
  readonly ctx: Context;
  readonly skills: ImoSkills;
  readonly registry: {
    list(options?: { readonly signal?: AbortSignal }): Promise<readonly SkillSummary[]>;
    snapshot(options?: { readonly signal?: AbortSignal }): Promise<{ readonly skills: readonly SkillSummary[]; readonly complete: boolean }>;
    get(name: string, options?: { readonly signal?: AbortSignal }): Promise<SkillDefinition | undefined>;
  };
  readonly provider: InsuremoSkillProvider;
  readonly io: ReturnType<typeof makeFakeIo>;
  unregisterProvider(): void;
  dispose(): Promise<void>;
}

interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly provider: string;
  readonly source: string;
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean };
  readonly resourceBase?: { readonly kind: string; readonly path: string };
}

interface SkillDefinition extends SkillSummary {
  readonly content: string;
  readonly path?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

async function catalogFixture(
  io: ReturnType<typeof makeFakeIo>,
  root: string,
): Promise<CatalogFixture> {
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const ctx = new Context();
  ctx.provide("subprocess", fakeSubprocess(io) as never);
  const skillsFiber = ctx.plugin(ImoSkillsService, { command: "imo", timeoutMs: 5_000 });
  await skillsFiber.await();
  const registryFiber = ctx.plugin(SkillRegistry, {});
  await registryFiber.await();
  const skills = ctx.get<ImoSkills>("imoSkills");
  const registry = ctx.get<CatalogFixture["registry"]>("skills");
  if (skills === undefined || registry === undefined) throw new Error("catalog services were not provided");
  let provider: InsuremoSkillProvider | undefined;
  const unregister = registryProvider(registry, (control) => {
    provider = new InsuremoSkillProvider(ctx, control, skills, "global");
    return provider;
  });
  if (provider === undefined) throw new Error("provider was not registered");
  let unregistered = false;
  const unregisterProvider = (): void => {
    if (unregistered) return;
    unregistered = true;
    unregister();
  };
  return {
    ctx,
    skills,
    registry,
    provider,
    io,
    unregisterProvider,
    dispose: async () => {
      unregisterProvider();
      await registryFiber.dispose();
      await skillsFiber.dispose();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    },
  };
}

function registryProvider(
  registry: CatalogFixture["registry"],
  create: (control: { readonly signal: AbortSignal; invalidate(): void }) => InsuremoSkillProvider,
): () => void {
  return (registry as unknown as {
    registerProvider(factory: (control: { readonly signal: AbortSignal; invalidate(): void }) => InsuremoSkillProvider): () => void;
  }).registerProvider(create);
}

async function skillRoot(root: string, name: string, content: string): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), content);
  return directory;
}

function inventory(...rows: readonly unknown[]): string {
  return JSON.stringify(rows);
}

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

test("real Harness registry lists InsureMO candidates and loads body on get", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-real-"));
  const directory = await skillRoot(root, "alpha", "---\ntitle: Alpha\nmodelInvocable: false\nwhenToUse: Use alpha\nsecret: do-not-export\n---\n# Alpha body\n");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory({ name: "alpha", description: "Alpha", path: directory }) }), root);
  try {
    const snapshot = await fx.registry.snapshot();
    assert.equal(snapshot.complete, true);
    assert.equal(snapshot.skills.length, 1);
    const summary = snapshot.skills[0]!;
    assert.deepEqual({ name: summary.name, provider: summary.provider, source: summary.source }, { name: "alpha", provider: "insuremo", source: "insuremo" });
    assert.equal("content" in summary, false);
    const definition = await fx.registry.get("alpha");
    assert.equal(definition?.content, "# Alpha body\n");
    assert.equal(definition?.resourceBase?.kind, "directory");
    assert.equal(definition?.resourceBase?.path, await realpath(directory));
    assert.equal(definition?.invocation.modelInvocable, false);
    assert.equal(definition?.invocation.userInvocable, true);
    assert.deepEqual(definition?.metadata, { title: "Alpha" });
    assert.equal(digestText(definition?.content ?? ""), digestText("# Alpha body\n"));
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("rank 200 project wins over IMO 450, and IMO wins over user 500", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-rank-"));
  const directory = await skillRoot(root, "shared", "# IMO\n");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory({ name: "shared", description: "IMO", path: directory }) }), root);
  let disposeUser = () => {};
  let disposeProject = () => {};
  try {
    const user = {
      name: "user",
      list: async () => [{ name: "shared", description: "User", invocation: { modelInvocable: true, userInvocable: true }, source: "user-agents", provider: "user", rank: 500, locator: "user" }],
      get: async () => ({ name: "shared", description: "User", invocation: { modelInvocable: true, userInvocable: true }, source: "user-agents", provider: "user", content: "# User" }),
    };
    disposeUser = (fx.registry as unknown as { registerProvider(factory: (control: unknown) => typeof user): () => void }).registerProvider(() => user);
    let summaries = await fx.registry.list();
    assert.equal(summaries[0]?.provider, "insuremo");
    const project = {
      name: "project",
      list: async () => [{ name: "shared", description: "Project", invocation: { modelInvocable: true, userInvocable: true }, source: "project-dsh", provider: "project", rank: 200, locator: "project" }],
      get: async () => ({ name: "shared", description: "Project", invocation: { modelInvocable: true, userInvocable: true }, source: "project-dsh", provider: "project", content: "# Project" }),
    };
    disposeProject = (fx.registry as unknown as { registerProvider(factory: (control: unknown) => typeof project): () => void }).registerProvider(() => project);
    summaries = await fx.registry.list();
    assert.equal(summaries[0]?.provider, "project");
    disposeProject();
    disposeProject = () => {};
    summaries = await fx.registry.list();
    assert.equal(summaries[0]?.provider, "insuremo");
  } finally {
    disposeProject();
    disposeUser();
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("inventory fingerprint change invalidates catalog once and refreshes candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-refresh-"));
  const alpha = await skillRoot(root, "alpha", "# Alpha\n");
  const beta = await skillRoot(root, "beta", "# Beta\n");
  const io = makeFakeIo({ skillsListJson: inventory({ name: "alpha", description: "Alpha", path: alpha }) });
  const fx = await catalogFixture(io, root);
  const changes: unknown[] = [];
  const remove = fx.ctx.on("skills/change", (payload: unknown) => changes.push(payload));
  try {
    assert.deepEqual((await fx.registry.list()).map((item) => item.name), ["alpha"]);
    io.skillsListJson = inventory({ name: "beta", description: "Beta", path: beta });
    await fx.skills.list("global");
    assert.equal(changes.length, 1);
    assert.deepEqual((await fx.registry.list()).map((item) => item.name), ["beta"]);
    assert.equal(changes.length, 1);
  } finally {
    remove();
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("same inventory fingerprint does not repeatedly emit skills/change", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-stable-"));
  const directory = await skillRoot(root, "alpha", "# Alpha\n");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory({ name: "alpha", description: "Alpha", path: directory }) }), root);
  const changes: unknown[] = [];
  const remove = fx.ctx.on("skills/change", (payload: unknown) => changes.push(payload));
  try {
    await fx.registry.list();
    await fx.skills.list("global");
    await fx.skills.list("global");
    assert.equal(changes.length, 0);
  } finally {
    remove();
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit host refresh invalidates same-name/path content mutations", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-content-refresh-"));
  const directory = await skillRoot(root, "alpha", "# Alpha v1\n");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory({ name: "alpha", description: "Alpha", path: directory }) }), root);
  const changes: unknown[] = [];
  const remove = fx.ctx.on("skills/change", (payload: unknown) => changes.push(payload));
  try {
    await fx.registry.list();
    await writeFile(join(directory, "SKILL.md"), "# Alpha v2\n");
    invalidateInsuremoSkillCatalog(fx.ctx);
    assert.equal(changes.length, 1);
    assert.equal((await fx.registry.get("alpha"))?.content, "# Alpha v2\n");
    assert.equal(changes.length, 1);
  } finally {
    remove();
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid inventory item does not block healthy candidates and marks snapshot incomplete", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-incomplete-"));
  const healthy = await skillRoot(root, "healthy", "# Healthy\n");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory(
    { name: "healthy", description: "Healthy", path: healthy },
    { name: "broken", description: "Broken", path: join(root, "missing") },
  ) }), root);
  try {
    const snapshot = await fx.registry.snapshot();
    assert.equal(snapshot.complete, false);
    assert.deepEqual(snapshot.skills.map((item) => item.name), ["healthy"]);
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("forged candidate and altered signed fields are rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-forge-"));
  const directory = await skillRoot(root, "alpha", "# Alpha\n");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory({ name: "alpha", description: "Alpha", path: directory }) }), root);
  try {
    const listed = await fx.provider.list({});
    assert.equal(Array.isArray(listed), true);
    if (!Array.isArray(listed)) return;
    const candidate = listed[0]!;
    assert.equal(Object.isFrozen(candidate), true);
    assert.equal(Object.isFrozen(candidate.locator), true);
    assert.equal(Object.isFrozen(candidate.invocation), true);
    assert.equal(Reflect.ownKeys(fx.provider).some((key) => /control|signal|invalidate/i.test(String(key))), false);
    assert.equal(await fx.provider.get({ ...candidate, path: join(root, "outside", "SKILL.md") }, {}), undefined);
    assert.equal(await fx.provider.get({ ...candidate, name: "forged" }, {}), undefined);
    assert.equal(await fx.provider.get({ ...candidate, locator: {} }, {}), undefined);
    const loaded = await fx.provider.get(candidate, {});
    assert.equal(loaded?.content, "# Alpha\n");
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("relative and absolute escapes never become catalog candidates", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-escape-"));
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory(
    { name: "relative", description: "Relative", path: "../../etc" },
    { name: "absolute", description: "Absolute", path: "/etc" },
  ) }), root);
  try {
    const snapshot = await fx.registry.snapshot();
    assert.equal(snapshot.complete, false);
    assert.deepEqual(snapshot.skills, []);
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("symlink escape is rejected again by provider get boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-link-root-"));
  const outside = await mkdtemp(join(tmpdir(), "imo-catalog-link-outside-"));
  const target = await skillRoot(outside, "alpha", "# Outside\n");
  const link = join(root, "alpha");
  await symlink(target, link, "dir");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory({ name: "alpha", description: "Alpha", path: link }) }), root);
  try {
    const snapshot = await fx.registry.snapshot();
    assert.equal(snapshot.complete, false);
    assert.deepEqual(snapshot.skills, []);
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("oversize SKILL.md is listed only as an unloadable candidate", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-oversize-"));
  const directory = await skillRoot(root, "alpha", "# Alpha\n" + "x".repeat(1024 * 1024));
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory({ name: "alpha", description: "Alpha", path: directory }) }), root);
  try {
    const listed = await fx.provider.list({});
    assert.equal(Array.isArray(listed), false);
    if (!Array.isArray(listed)) {
      assert.equal(listed.complete, false);
      assert.equal(await fx.provider.get(listed.candidates[0]!, {}), undefined);
    }
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("unclosed frontmatter is incomplete and get returns undefined", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-unclosed-"));
  const directory = await skillRoot(root, "alpha", "---\ntitle: Alpha\n# never closes\n");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory({ name: "alpha", description: "Alpha", path: directory }) }), root);
  try {
    const snapshot = await fx.registry.snapshot();
    assert.equal(snapshot.complete, false);
    assert.equal(snapshot.skills.length, 1);
    assert.equal(await fx.registry.get("alpha"), undefined);
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid YAML is contained and does not block healthy catalog rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-yaml-"));
  const broken = await skillRoot(root, "broken", "---\ntitle: [unterminated\n---\n# Broken\n");
  const healthy = await skillRoot(root, "healthy", "# Healthy\n");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory(
    { name: "broken", description: "Broken", path: broken },
    { name: "healthy", description: "Healthy", path: healthy },
  ) }), root);
  try {
    const snapshot = await fx.registry.snapshot();
    assert.equal(snapshot.complete, false);
    assert.deepEqual(snapshot.skills.map((item) => item.name), ["broken", "healthy"]);
    assert.equal(await fx.registry.get("broken"), undefined);
    assert.equal((await fx.registry.get("healthy"))?.content, "# Healthy\n");
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("provider cancellation and unregister disposal stop list/get work", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-cancel-"));
  const directory = await skillRoot(root, "alpha", "# Alpha\n");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory({ name: "alpha", description: "Alpha", path: directory }) }), root);
  try {
    const signal = new AbortController();
    signal.abort(new Error("cancelled"));
    await assert.rejects(fx.registry.list({ signal: signal.signal }));
    const listed = await fx.provider.list({});
    assert.equal(Array.isArray(listed), true);
    if (!Array.isArray(listed)) return;
    const candidate = listed[0]!;
    fx.unregisterProvider();
    assert.equal(await fx.provider.get(candidate, {}), undefined);
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Harness name grammar filters invalid names while retaining healthy rows", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-name-"));
  const healthy = await skillRoot(root, "healthy", "# Healthy\n");
  const invalid = await skillRoot(root, "invalid-name", "# Invalid\n");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory(
    { name: "healthy", description: "Healthy", path: healthy },
    { name: "Not A Kebab Name", description: "Invalid", path: invalid },
  ) }), root);
  try {
    const snapshot = await fx.registry.snapshot();
    assert.equal(snapshot.complete, false);
    assert.deepEqual(snapshot.skills.map((item) => item.name), ["healthy"]);
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("get rechecks a previously issued candidate after its manifest escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-recheck-"));
  const outside = await mkdtemp(join(tmpdir(), "imo-catalog-recheck-outside-"));
  const directory = await skillRoot(root, "alpha", "# Alpha\n");
  const outsideFile = join(outside, "SKILL.md");
  await writeFile(outsideFile, "# Outside\n");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory({ name: "alpha", description: "Alpha", path: directory }) }), root);
  try {
    const listed = await fx.provider.list({});
    assert.equal(Array.isArray(listed), true);
    if (!Array.isArray(listed)) return;
    await rm(join(directory, "SKILL.md"));
    await symlink(outsideFile, join(directory, "SKILL.md"));
    assert.equal(await fx.provider.get(listed[0]!, {}), undefined);
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

