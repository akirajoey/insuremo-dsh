import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import {
  ImoSkillsService,
  invalidateInsuremoSkillCatalog,
  type ImoSkills,
} from "../src/index.ts";
import { InsuremoSkillProvider } from "../src/skill-provider.ts";
import { fakeHandle, fakeSubprocess, makeFakeIo, skillsFixture } from "./support/fake-subprocess.ts";

interface Summary {
  readonly name: string;
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean };
}

interface Definition extends Summary {
  readonly content: string;
}

interface RegistryLike {
  list(): Promise<readonly Summary[]>;
  snapshot(): Promise<{ readonly skills: readonly Summary[]; readonly complete: boolean }>;
  get(name: string): Promise<Definition | undefined>;
  registerProvider(factory: (control: ProviderControl) => InsuremoSkillProvider): () => void;
}

interface ProviderControl {
  readonly signal: AbortSignal;
  invalidate(): void;
}

interface CatalogFixture {
  readonly ctx: Context;
  readonly skills: ImoSkills;
  readonly registry: RegistryLike;
  readonly provider: InsuremoSkillProvider;
  dispose(): Promise<void>;
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

async function catalogFixture(io: ReturnType<typeof makeFakeIo>, root: string): Promise<CatalogFixture> {
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const ctx = new Context();
  ctx.provide("subprocess", fakeSubprocess(io) as never);
  const skillsFiber = ctx.plugin(ImoSkillsService, { command: "imo", timeoutMs: 5_000 });
  await skillsFiber.await();
  const registryFiber = ctx.plugin(SkillRegistry, {});
  await registryFiber.await();
  const skills = ctx.get<ImoSkills>("imoSkills");
  const registry = ctx.get<RegistryLike>("skills");
  if (skills === undefined || registry === undefined) throw new Error("catalog services unavailable");
  let provider: InsuremoSkillProvider | undefined;
  const unregister = registry.registerProvider((control) => {
    provider = new InsuremoSkillProvider(ctx, control, skills, "global");
    return provider;
  });
  if (provider === undefined) throw new Error("provider unavailable");
  let stopped = false;
  const stop = (): void => {
    if (!stopped) {
      stopped = true;
      unregister();
    }
  };
  return {
    ctx,
    skills,
    registry,
    provider,
    dispose: async () => {
      stop();
      await registryFiber.dispose();
      await skillsFiber.dispose();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    },
  };
}

test("provider complete stays false for invalid rows even when validation claims complete", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-defensive-complete-"));
  const healthy = await skillRoot(root, "healthy", "# Healthy\n");
  const ctx = new Context();
  const lifecycle = new AbortController();
  const provider = new InsuremoSkillProvider(ctx, { signal: lifecycle.signal, invalidate() {} }, {
    skillsAllowedRoot: root,
    validate: async () => ({ ok: true, value: {
      scope: "global", inventoryComplete: true, checkedAt: "now",
      items: [
        { name: "healthy", description: "Healthy", path: healthy, valid: true, reasons: [] },
        { name: "broken", description: "Broken", path: join(root, "missing"), valid: false, reasons: ["missing-directory"] },
      ],
    } }),
  } as unknown as ImoSkills, "global");
  try {
    const listed = await provider.list({});
    assert.equal(Array.isArray(listed), false);
    if (!Array.isArray(listed)) {
      assert.equal(listed.complete, false);
      assert.deepEqual(listed.candidates.map((candidate) => candidate.name), ["healthy"]);
    }
  } finally {
    lifecycle.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("provider option abort races an uncooperative validate and ignores its late result", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-abort-option-"));
  let resolveValidation!: (value: unknown) => void;
  const validation = new Promise<unknown>((resolve) => { resolveValidation = resolve; });
  const ctx = new Context();
  const caller = new AbortController();
  let invalidations = 0;
  const provider = new InsuremoSkillProvider(ctx, { signal: new AbortController().signal, invalidate: () => { invalidations += 1; } }, {
    skillsAllowedRoot: root, validate: () => validation,
  } as unknown as ImoSkills, "global");
  try {
    const started = Date.now();
    const pending = provider.list({ signal: caller.signal });
    setTimeout(() => caller.abort(new Error("abort-reason-canary")), 5);
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError" && !error.message.includes("canary"));
    assert.ok(Date.now() - started < 100);
    resolveValidation({ ok: true, value: { scope: "global", inventoryComplete: true, items: [], checkedAt: "late" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(invalidations, 0);
  } finally {
    caller.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("provider control abort also races validate and leaves no late invalidation", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-abort-control-"));
  let resolveValidation!: (value: unknown) => void;
  const validation = new Promise<unknown>((resolve) => { resolveValidation = resolve; });
  const ctx = new Context();
  const lifecycle = new AbortController();
  let invalidations = 0;
  const provider = new InsuremoSkillProvider(ctx, { signal: lifecycle.signal, invalidate: () => { invalidations += 1; } }, {
    skillsAllowedRoot: root, validate: () => validation,
  } as unknown as ImoSkills, "global");
  try {
    const started = Date.now();
    const pending = provider.list({});
    setTimeout(() => lifecycle.abort(new Error("control-reason-canary")), 5);
    await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError" && !error.message.includes("canary"));
    assert.ok(Date.now() - started < 100);
    resolveValidation({ ok: true, value: { scope: "global", inventoryComplete: true, items: [], checkedAt: "late" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(invalidations, 0);
  } finally {
    lifecycle.abort();
    await rm(root, { recursive: true, force: true });
  }
});

test("ImoSkills list and validate propagate cancellation to subprocess signals", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-signal-"));
  const observed: AbortSignal[] = [];
  const runtime = {
    resolveExecutable: async () => "/opt/homebrew/bin/imo",
    spawn: (spec: { readonly signal?: AbortSignal }) => {
      if (spec.signal !== undefined) observed.push(spec.signal);
      return fakeHandle({ stdout: "[]\n", stderr: "", exitCode: 0, pending: true }, spec.signal);
    },
  };
  const fx = await skillsFixture(makeFakeIo(), {}, root, runtime as never);
  try {
    for (const operation of [
      (signal: AbortSignal) => fx.skills.list("global", signal),
      (signal: AbortSignal) => fx.skills.validate("global", signal),
    ]) {
      const controller = new AbortController();
      const pending = operation(controller.signal);
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort(new Error("subprocess-reason-canary"));
      const result = await pending;
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.error.code, "cancelled");
        assert.equal(result.error.message, "IMO Skills operation was cancelled");
      }
      assert.equal(observed.at(-1)?.aborted, true);
    }
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit string invocation flags make the manifest unloadable", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-invocation-string-"));
  const directory = await skillRoot(root, "alpha", "---\nmodelInvocable: \"false\"\n---\n# Alpha\n");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory({ name: "alpha", description: "Alpha", path: directory }) }), root);
  try {
    const snapshot = await fx.registry.snapshot();
    assert.equal(snapshot.complete, false);
    assert.equal(await fx.registry.get("alpha"), undefined);
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit number invocation flags make the manifest unloadable", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-invocation-number-"));
  const directory = await skillRoot(root, "alpha", "---\nuserInvocable: 0\n---\n# Alpha\n");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory({ name: "alpha", description: "Alpha", path: directory }) }), root);
  try {
    assert.equal(await fx.registry.get("alpha"), undefined);
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("null, object, and array invocation flags are not silently defaulted", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-invocation-shapes-"));
  const directory = await skillRoot(root, "alpha", "# Alpha\n");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory({ name: "alpha", description: "Alpha", path: directory }) }), root);
  try {
    for (const value of ["null", "{}", "[]"]) {
      await writeFile(join(directory, "SKILL.md"), `---\nmodelInvocable: ${value}\n---\n# Alpha\n`);
      const listed = await fx.provider.list({});
      assert.equal(Array.isArray(listed), false);
      if (!Array.isArray(listed)) assert.equal(await fx.provider.get(listed.candidates[0]!, {}), undefined);
    }
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing invocation fields default true and explicit booleans combine", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-invocation-bool-"));
  const directory = await skillRoot(root, "alpha", "# Alpha\n");
  const fx = await catalogFixture(makeFakeIo({ skillsListJson: inventory({ name: "alpha", description: "Alpha", path: directory }) }), root);
  try {
    const defaults = await fx.registry.snapshot();
    assert.equal(defaults.skills[0]?.invocation.modelInvocable, true);
    assert.equal(defaults.skills[0]?.invocation.userInvocable, true);
    await writeFile(join(directory, "SKILL.md"), "---\nmodelInvocable: false\nuserInvocable: false\n---\n# Alpha\n");
    invalidateInsuremoSkillCatalog(fx.ctx);
    const definition = await fx.registry.get("alpha");
    assert.equal(definition?.invocation.modelInvocable, false);
    assert.equal(definition?.invocation.userInvocable, false);
  } finally {
    await fx.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("root API exposes only the safe catalog hook, not provider lifecycle objects", async () => {
  const api = await import("../src/index.ts") as Record<string, unknown>;
  assert.equal("InsuremoSkillProvider" in api, false);
  assert.equal("mountInsuremoSkillProvider" in api, false);
  assert.equal(typeof api.invalidateInsuremoSkillCatalog, "function");
  assert.equal("SkillProviderControl" in api, false);
});
