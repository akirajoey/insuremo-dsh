import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { ImoSkillsService, SKILL_ACTIVATION_CHANGED_EVENT, type ImoSkills } from "../src/index.ts";
import {
  ImoSkillActivationService,
  skillActivationDomain,
  type SkillActivationController,
} from "../src/skill-activation.ts";
import { InsuremoSkillProvider } from "../src/skill-provider.ts";
import { fakeSubprocess, makeFakeIo } from "./support/fake-subprocess.ts";

interface CatalogRegistry {
  snapshot(): Promise<{ readonly skills: readonly { readonly name: string }[]; readonly complete: boolean }>;
  get(name: string): Promise<{ readonly name: string; readonly content: string } | undefined>;
  registerProvider(factory: (control: { readonly signal: AbortSignal; invalidate(): void }) => InsuremoSkillProvider): () => void;
}
interface Fixture {
  readonly root: string;
  readonly storageRoot: string;
  readonly ctx: Context;
  readonly io: ReturnType<typeof makeFakeIo>;
  readonly activation: SkillActivationController;
  readonly skills: ImoSkills;
  readonly registry: CatalogRegistry;
  dispose(): Promise<void>;
}

const inventory = (...rows: readonly unknown[]): string => JSON.stringify(rows);
const rowsFor = (root: string, names: readonly string[]) => names.map(name => ({ name, path: join(root, name) }));

async function roots(): Promise<{ root: string; storageRoot: string }> {
  return {
    root: await mkdtemp(join(tmpdir(), "imo-activation-skills-")),
    storageRoot: await mkdtemp(join(tmpdir(), "imo-activation-storage-")),
  };
}

async function openFixture(
  root: string,
  storageRoot: string,
  rows: readonly { readonly name: string; readonly path: string }[],
): Promise<Fixture> {
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  for (const row of rows) {
    await mkdir(row.path, { recursive: true });
    await writeFile(join(row.path, "SKILL.md"), `# ${row.name}\n`);
  }
  const io = makeFakeIo({ skillsListJson: inventory(...rows) });
  const ctx = new Context();
  ctx.provide("subprocess", fakeSubprocess(io) as never);
  const storageFiber = ctx.plugin(Storage);
  await storageFiber.await();
  const backend = new JsonStorageBackend(storageRoot);
  const unregisterBackend = ctx.storage.backend.register("json", backend);
  ctx.provide("storageDomain", new DomainFacility(ctx, { backend: "json" }));
  const skillsFiber = ctx.plugin(ImoSkillsService, { command: "imo", timeoutMs: 5_000 });
  await skillsFiber.await();
  let activationController: SkillActivationController | undefined;
  const activationFiber = ctx.plugin(ImoSkillActivationService, {
    onController: (controller: SkillActivationController) => { activationController = controller; },
  });
  await activationFiber.await();
  const registryFiber = ctx.plugin(SkillRegistry, {});
  await registryFiber.await();
  const skills = ctx.get<ImoSkills>("imoSkills");
  const registry = ctx.get<CatalogRegistry>("skills");
  if (skills === undefined || activationController === undefined || registry === undefined) throw new Error("activation fixture unavailable");
  let provider: InsuremoSkillProvider | undefined;
  const unregisterProvider = registry.registerProvider((control) => {
    provider = new InsuremoSkillProvider(ctx, control, skills, "global", activationController);
    return provider;
  });
  if (provider === undefined) throw new Error("provider fixture unavailable");
  return {
    root, storageRoot, ctx, io, activation: activationController, skills, registry,
    dispose: async () => {
      unregisterProvider();
      await registryFiber.dispose();
      await activationFiber.dispose();
      await skillsFiber.dispose();
      await storageFiber.dispose();
      unregisterBackend();
      await backend.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    },
  };
}

async function withFixture(
  names: readonly string[],
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const { root, storageRoot } = await roots();
  const fixture = await openFixture(root, storageRoot, rowsFor(root, names));
  try {
    await run(fixture);
  } finally {
    await fixture.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
}

test("fresh activation adopts every legal installed skill and real catalog lists them", async () => {
  await withFixture(["alpha", "beta"], async (fx) => {
    const catalog = await fx.registry.snapshot();
    assert.equal(catalog.complete, true);
    assert.deepEqual(catalog.skills.map(skill => skill.name), ["alpha", "beta"]);
    assert.deepEqual(await fx.activation.snapshot(["alpha", "beta"]), {
      initialized: true, installed: ["alpha", "beta"], enabled: ["alpha", "beta"], disabled: [], stale: [], revision: 0,
    });
  });
});

test("new installed names default disabled without making a healthy catalog incomplete", async () => {
  await withFixture(["alpha"], async (fx) => {
    const beta = join(fx.root, "beta");
    await mkdir(beta, { recursive: true });
    await writeFile(join(beta, "SKILL.md"), "# beta\n");
    await fx.registry.snapshot();
    fx.io.skillsListJson = inventory({ name: "alpha", path: join(fx.root, "alpha") }, { name: "beta", path: beta });
    const catalog = await fx.registry.snapshot();
    const state = await fx.activation.snapshot(["alpha", "beta"]);
    assert.equal(catalog.complete, true);
    assert.deepEqual(catalog.skills.map(skill => skill.name), ["alpha"]);
    assert.deepEqual(state.disabled, ["beta"]);
  });
});

test("activation persists across restart and still requires explicit enable", async () => {
  const { root, storageRoot } = await roots();
  const alpha = join(root, "alpha");
  const beta = join(root, "beta");
  await mkdir(beta, { recursive: true });
  await writeFile(join(beta, "SKILL.md"), "# beta\n");
  const first = await openFixture(root, storageRoot, [{ name: "alpha", path: alpha }]);
  await first.registry.snapshot();
  first.io.skillsListJson = inventory({ name: "alpha", path: alpha }, { name: "beta", path: beta });
  await first.registry.snapshot();
  await first.dispose();
  const second = await openFixture(root, storageRoot, [{ name: "alpha", path: alpha }, { name: "beta", path: beta }]);
  try {
    const state = await second.activation.snapshot(["alpha", "beta"]);
    assert.deepEqual(state.enabled, ["alpha"]);
    assert.deepEqual(state.disabled, ["beta"]);
    // TASK-043 (B): the disabled name stays in the catalog as an insuremo
    // non-invocable mask (shadowing any same-name filesystem entry).
    const persisted = (await second.registry.snapshot()).skills;
    assert.deepEqual(persisted.map(skill => skill.name).sort(), ["alpha", "beta"]);
    const betaEntry = persisted.find(skill => skill.name === "beta");
    assert.equal(betaEntry?.invocation?.modelInvocable, false);
    await second.activation.setEnabled("beta", true, ["alpha", "beta"], state.revision);
    assert.deepEqual((await second.registry.snapshot()).skills.map(skill => skill.name), ["alpha", "beta"]);
  } finally {
    await second.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("disable revokes an old candidate and enable restores get", async () => {
  await withFixture(["alpha"], async (fx) => {
    assert.equal((await fx.registry.snapshot()).skills.length, 1);
    const state = await fx.activation.snapshot(["alpha"]);
    await fx.activation.setEnabled("alpha", false, ["alpha"], state.revision);
    assert.equal(await fx.registry.get("alpha"), undefined);
    const disabled = await fx.activation.snapshot(["alpha"]);
    await fx.activation.setEnabled("alpha", true, ["alpha"], disabled.revision);
    assert.equal((await fx.registry.get("alpha"))?.name, "alpha");
  });
});

test("removed skills become stale and reconcile clears only stale names", async () => {
  await withFixture(["alpha", "beta"], async (fx) => {
    await fx.registry.snapshot();
    const stale = await fx.activation.snapshot(["alpha"]);
    assert.deepEqual(stale.stale, ["beta"]);
    const reconciled = await fx.activation.reconcile(["alpha"], stale.revision);
    assert.deepEqual(reconciled, { initialized: true, installed: ["alpha"], enabled: ["alpha"], disabled: [], stale: [], revision: 1 });
  });
});

test("concurrent first initialization is exactly-once and sorted", async () => {
  await withFixture([], async (fx) => {
    const results = await Promise.all([
      fx.activation.ensureInitialized(["beta", "alpha", "alpha"]),
      fx.activation.ensureInitialized(["alpha", "beta"]),
      fx.activation.ensureInitialized(["beta"]),
    ]);
    assert.equal(new Set(results.map(result => result.revision)).size, 1);
    assert.deepEqual((await fx.activation.snapshot(["alpha", "beta"])).enabled, ["alpha", "beta"]);
  });
});

test("expected revisions prevent concurrent activation updates from losing an update", async () => {
  await withFixture(["alpha", "beta"], async (fx) => {
    await fx.registry.snapshot();
    const revision = (await fx.activation.snapshot(["alpha", "beta"])).revision;
    const results = await Promise.allSettled([
      fx.activation.setEnabled("alpha", false, ["alpha", "beta"], revision),
      fx.activation.setEnabled("beta", false, ["alpha", "beta"], revision),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason.code, "revision-conflict");
    assert.equal((await fx.activation.snapshot(["alpha", "beta"])).enabled.length, 1);
  });
});

test("activation events change once and expose counts only", async () => {
  await withFixture(["alpha"], async (fx) => {
    const events: unknown[] = [];
    const catalogChanges: unknown[] = [];
    const remove = fx.ctx.on(SKILL_ACTIVATION_CHANGED_EVENT, payload => events.push(payload));
    const removeCatalog = fx.ctx.on("skills/change", payload => catalogChanges.push(payload));
    try {
      await fx.registry.snapshot();
      const state = await fx.activation.snapshot(["alpha"]);
      await fx.activation.setEnabled("alpha", false, ["alpha"], state.revision);
      await fx.activation.setEnabled("alpha", false, ["alpha"], state.revision + 1);
      assert.equal(events.length, 1);
      assert.equal(catalogChanges.length, 1);
      assert.deepEqual(Object.keys(events[0] as object).sort(), ["disabledCount", "enabledCount", "revision", "staleCount"]);
    } finally { remove(); removeCatalog(); }
  });
});

test("activation storage has no path, body, or token fields", async () => {
  await withFixture(["alpha"], async (fx) => {
    await fx.registry.snapshot();
    const text = await readFile(join(fx.storageRoot, "workbench_imo_skill_activation.json"), "utf8");
    const state = (JSON.parse(text) as { tables: { states: { global: Record<string, unknown> } } }).tables.states.global;
    assert.deepEqual(Object.keys(state).sort(), ["enabledNames", "initialized", "revision", "scope", "updatedAt"]);
    assert.equal(text.includes(join(fx.root, "alpha")), false);
    assert.equal(text.includes("SKILL.md"), false);
    assert.equal(text.includes("content"), false);
  });
});

test("provider fails closed when activation storage is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-activation-failclosed-"));
  const ctx = new Context();
  const provider = new InsuremoSkillProvider(ctx, { signal: new AbortController().signal, invalidate() {} }, {
    skillsAllowedRoot: root,
    validate: async () => ({ ok: true, value: { scope: "global", inventoryComplete: true, checkedAt: "now", items: [{ name: "alpha", description: "Alpha", path: join(root, "alpha"), valid: true, reasons: [] }] } }),
  } as unknown as ImoSkills, "global", {
    ensureInitialized: async () => { throw new Error("storage unavailable"); },
    snapshot: async () => { throw new Error("storage unavailable"); },
  });
  try {
    const result = await provider.list({});
    assert.equal(Array.isArray(result), false);
    if (!Array.isArray(result)) assert.deepEqual(result, { candidates: [], complete: false });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("isolated real inventory of sixteen skills is adopted", async () => {
  await withFixture(Array.from({ length: 16 }, (_, index) => `skill-${String(index + 1).padStart(2, "0")}`), async (fx) => {
    const catalog = await fx.registry.snapshot();
    assert.equal(catalog.complete, true);
    assert.equal(catalog.skills.length, 16);
    const state = await fx.activation.snapshot(catalog.skills.map(skill => skill.name));
    assert.equal(state.enabled.length, 16);
    assert.equal(state.disabled.length, 0);
  });
});

test("nonboolean activation input is rejected before any read, write, event, or revision", async () => {
  await withFixture(["alpha"], async (fx) => {
    await fx.registry.snapshot();
    const path = join(fx.storageRoot, "workbench_imo_skill_activation.json");
    const before = await readFile(path, "utf8");
    const state = await fx.activation.snapshot(["alpha"]);
    const events: unknown[] = [];
    const remove = fx.ctx.on(SKILL_ACTIVATION_CHANGED_EVENT, payload => events.push(payload));
    try {
      await assert.rejects(
        fx.activation.setEnabled("alpha", "true" as unknown as boolean, ["alpha"], state.revision),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "invalid-input",
      );
      assert.deepEqual(await fx.activation.snapshot(["alpha"]), state);
      assert.equal(await readFile(path, "utf8"), before);
      assert.deepEqual(events, []);
    } finally {
      remove();
    }
  });
});

test("activation mutators reject malformed name, inventory, and revision inputs", async () => {
  await withFixture(["alpha"], async (fx) => {
    await fx.registry.snapshot();
    const state = await fx.activation.snapshot(["alpha"]);
    const cases = [
      fx.activation.setEnabled("not a skill", false, ["alpha"], state.revision),
      fx.activation.setEnabled("alpha", false, ["alpha", 7] as unknown as readonly string[], state.revision),
      fx.activation.setEnabled("alpha", false, ["alpha"], "0" as unknown as number),
      fx.activation.reconcile(["alpha", null] as unknown as readonly string[], state.revision),
    ];
    for (const pending of cases) {
      await assert.rejects(pending, (error: unknown) => typeof error === "object" && error !== null && "code" in error);
    }
    assert.deepEqual(await fx.activation.snapshot(["alpha"]), state);
  });
});

test("corrupt activation records fail at the storage boundary", async () => {
  const { root, storageRoot } = await roots();
  const path = join(storageRoot, "workbench_imo_skill_activation.json");
  await writeFile(path, JSON.stringify({
    unit: { name: "workbench_imo_skill_activation", version: 1 },
    global: null,
    tables: { states: { global: {
      scope: "global", initialized: true, enabledNames: ["Not valid"], revision: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    } } },
  }));
  const ctx = new Context();
  const storageFiber = ctx.plugin(Storage);
  await storageFiber.await();
  const backend = new JsonStorageBackend(storageRoot);
  const unregister = ctx.storage.backend.register("json", backend);
  const domain = new DomainFacility(ctx, { backend: "json" });
  try {
    await assert.rejects(domain.open(skillActivationDomain), (error: unknown) => (
      typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "invalid-record"
    ));
  } finally {
    unregister();
    await storageFiber.dispose();
    await backend.close();
    await rm(root, { recursive: true, force: true });
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("root activation face exposes reads while controller stays internal", async () => {
  await withFixture([], async (fx) => {
    const face = fx.ctx.get<Record<string, unknown>>("imoSkillActivation");
    assert.equal(typeof face?.ensureInitialized, "function");
    assert.equal(typeof face?.snapshot, "function");
    assert.equal(Object.isFrozen(face), true);
    assert.deepEqual(Reflect.ownKeys(face ?? {}).map(String).sort(), ["ensureInitialized", "snapshot"]);
    assert.equal("setEnabled" in (face ?? {}), false);
    assert.equal("reconcile" in (face ?? {}), false);
    assert.equal(fx.ctx.get("_imoSkillActivationController"), undefined);
    const api = await import("../src/index.ts") as Record<string, unknown>;
    assert.equal("SkillActivationController" in api, false);
    assert.equal("ImoSkillActivationService" in api, false);
    assert.equal("SKILL_ACTIVATION_CONTROLLER_KEY" in api, false);
  });
});
