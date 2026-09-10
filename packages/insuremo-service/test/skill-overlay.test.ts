import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { SkillRegistry } from "@deepseek-ai/dsh-skill";
import { ImoSkillsService, type ImoSkills } from "../src/index.ts";
import { InsuremoSkillProvider } from "../src/skill-provider.ts";
import { InsuremoSkillProviderService } from "../src/skill-provider-service.ts";
import {
  applySkillOverlay,
  DEFAULT_SKILL_OVERLAY_NAMES,
  resolveSkillOverlayConfig,
  SKILL_OVERLAY_MAX_BYTES,
  SKILL_OVERLAY_MAX_NAMES,
  SKILL_OVERLAY_TEXT,
  type SkillOverlayConfig,
} from "../src/skill-overlay.ts";
import { allowAllSkillActivation, fakeSubprocess, makeFakeIo } from "./support/fake-subprocess.ts";

function digestText(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

test("overlay resolver applies defaults and freezes the config", () => {
  const overlay = resolveSkillOverlayConfig();
  assert.deepEqual(overlay, { enabled: true, names: ["insuremo-auth-cli"] });
  assert.equal(Object.isFrozen(overlay), true);
  assert.equal(Object.isFrozen(overlay.names), true);
  assert.deepEqual(resolveSkillOverlayConfig({ enabled: false, names: ["a", "b"] }), { enabled: false, names: ["a", "b"] });
});

test("overlay resolver rejects invalid, duplicate, and over-long allowlists", () => {
  assert.throws(() => resolveSkillOverlayConfig({ names: ["Not A Kebab Name"] }), /invalid overlay skill name/);
  assert.throws(() => resolveSkillOverlayConfig({ names: [""] }), /invalid overlay skill name/);
  assert.throws(() => resolveSkillOverlayConfig({ names: [123 as unknown as string] }), /invalid overlay skill name/);
  assert.throws(() => resolveSkillOverlayConfig({ names: ["alpha", "alpha"] }), /duplicate overlay skill name/);
  assert.throws(
    () => resolveSkillOverlayConfig({ names: Array.from({ length: SKILL_OVERLAY_MAX_NAMES + 1 }, (_, i) => `skill-${i}`) }),
    /exceeds 16 names/,
  );
  assert.doesNotThrow(() => resolveSkillOverlayConfig({ names: [] }));
});

test("overlay template is bounded, attributed, and covers the auth guidance", () => {
  assert.ok(Buffer.byteLength(SKILL_OVERLAY_TEXT, "utf8") <= SKILL_OVERLAY_MAX_BYTES);
  assert.ok(SKILL_OVERLAY_TEXT.includes("## Workbench policy overlay"));
  assert.ok(SKILL_OVERLAY_TEXT.includes("NOT part of the upstream skill document"));
  assert.ok(SKILL_OVERLAY_TEXT.includes("imo auth login"));
  assert.ok(SKILL_OVERLAY_TEXT.includes("imo auth token set"));
  assert.ok(SKILL_OVERLAY_TEXT.includes("imo auth remote-profile create"));
  assert.ok(SKILL_OVERLAY_TEXT.includes("imo auth default-profile set"));
  assert.ok(SKILL_OVERLAY_TEXT.includes("--scope workspace"));
  assert.ok(SKILL_OVERLAY_TEXT.includes("--scope global"));
  assert.ok(SKILL_OVERLAY_TEXT.includes(".insuremo/"));
});

test("overlay application appends only allowlisted names and never mutates non-hits", () => {
  const overlay = resolveSkillOverlayConfig();
  assert.equal(applySkillOverlay("insuremo-auth-cli", "# Body\n", overlay), `# Body\n${SKILL_OVERLAY_TEXT}`);
  assert.equal(applySkillOverlay("alpha", "# Body\n", overlay), "# Body\n");
  assert.equal(applySkillOverlay("insuremo-auth-cli", "# Body\n", resolveSkillOverlayConfig({ enabled: false })), "# Body\n");
  // partial/prefix names never match: exact-name matching only
  assert.equal(applySkillOverlay("insuremo-auth-cli-extra", "# Body\n", overlay), "# Body\n");
});

interface OverlayFixture {
  readonly registry: {
    snapshot(options?: { readonly signal?: AbortSignal }): Promise<{
      readonly skills: readonly { readonly name: string }[];
      readonly complete: boolean;
    }>;
    get(name: string, options?: { readonly signal?: AbortSignal }): Promise<{ readonly content: string } | undefined>;
  };
  readonly provider: InsuremoSkillProvider;
  readonly root: string;
  dispose(): Promise<void>;
}

type OverlayRegistry = Parameters<NonNullable<Parameters<typeof overlayRegistryHelper>[0]>>[0];
function overlayRegistryHelper(
  _register: (registry: { registerProvider(factory: unknown): () => void }) => void,
): void {}

async function overlayFixture(
  files: Record<string, string>,
  overlay?: SkillOverlayConfig,
): Promise<OverlayFixture> {
  const root = await mkdtemp(join(tmpdir(), "imo-skill-overlay-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const ctx = new Context();
  try {
    const rows: Array<{ name: string; description: string; path: string }> = [];
    for (const [name, content] of Object.entries(files)) {
      const directory = join(root, name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "SKILL.md"), content);
      rows.push({ name, description: `Description for ${name}`, path: directory });
    }
    ctx.provide("subprocess", fakeSubprocess(makeFakeIo({ skillsListJson: JSON.stringify(rows) })) as never);
    ctx.provide("imoSkillActivation", allowAllSkillActivation());
    const skillsFiber = ctx.plugin(ImoSkillsService, { command: "imo", timeoutMs: 5_000 });
    await skillsFiber.await();
    const registryFiber = ctx.plugin(SkillRegistry, {});
    await registryFiber.await();
    const skills = ctx.get<ImoSkills>("imoSkills");
    const registry = ctx.get<OverlayRegistry>("skills");
    if (skills === undefined || registry === undefined) throw new Error("catalog services were not provided");
    let provider: InsuremoSkillProvider | undefined;
    (registry as unknown as {
      registerProvider(factory: (control: { readonly signal: AbortSignal; invalidate(): void }) => InsuremoSkillProvider): () => void;
    }).registerProvider((control) => {
      provider = new InsuremoSkillProvider(ctx, control, skills, "global", undefined, "full", overlay);
      return provider;
    });
    if (provider === undefined) throw new Error("provider was not registered");
    return {
      registry: registry as unknown as OverlayFixture["registry"],
      provider,
      root,
      dispose: async () => {
        await registryFiber.dispose();
        await skillsFiber.dispose();
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

const AUTH_BODY = "---\ntitle: Auth CLI\ndescription: InsureMO auth via imo auth\n---\n# InsureMO auth\n\nRun imo auth prepare --json.\n";

test("overlay: allowlisted skill body is returned with the fixed appended note; disk bytes unchanged", async () => {
  const fx = await overlayFixture({ "insuremo-auth-cli": AUTH_BODY });
  try {
    const file = join(await realpath(fx.root), "insuremo-auth-cli", "SKILL.md");
    const before = await readFile(file, "utf8");
    const snapshot = await fx.registry.snapshot();
    assert.equal(snapshot.complete, true);
    const definition = await fx.registry.get("insuremo-auth-cli");
    assert.ok(definition);
    assert.equal(definition.content.startsWith("# InsureMO auth\n"), true, "upstream body preserved as prefix");
    assert.equal(definition.content, `# InsureMO auth\n\nRun imo auth prepare --json.\n${SKILL_OVERLAY_TEXT}`);
    assert.ok(definition.content.includes("## Workbench policy overlay"));
    const after = await readFile(file, "utf8");
    assert.equal(digestText(after), digestText(before), "installed file untouched");
  } finally {
    await fx.dispose();
  }
});

test("overlay: non-listed skills stay byte-identical and never contain the marker", async () => {
  const fx = await overlayFixture({ alpha: "# Alpha body\n" });
  try {
    const definition = await fx.registry.get("alpha");
    assert.ok(definition);
    assert.equal(definition.content, "# Alpha body\n");
    assert.equal(digestText(definition.content), digestText("# Alpha body\n"));
    assert.equal(definition.content.includes("Workbench policy overlay"), false);
  } finally {
    await fx.dispose();
  }
});

test("overlay: disabling the switch restores byte-identical bodies for allowlisted names", async () => {
  const fx = await overlayFixture({ "insuremo-auth-cli": AUTH_BODY }, resolveSkillOverlayConfig({ enabled: false }));
  try {
    const definition = await fx.registry.get("insuremo-auth-cli");
    assert.ok(definition);
    assert.equal(definition.content, "# InsureMO auth\n\nRun imo auth prepare --json.\n");
  } finally {
    await fx.dispose();
  }
});

test("overlay: canonical-invalid allowlisted skill still fails closed on get", async () => {
  const fx = await overlayFixture({ "insuremo-auth-cli": "---\ntitle: Broken\n# never closes\n" });
  try {
    const snapshot = await fx.registry.snapshot();
    assert.equal(snapshot.complete, false);
    assert.equal(await fx.registry.get("insuremo-auth-cli"), undefined);
  } finally {
    await fx.dispose();
  }
});

test("overlay: forged candidates remain rejected regardless of the allowlist", async () => {
  const fx = await overlayFixture({ "insuremo-auth-cli": AUTH_BODY });
  try {
    const listed = await fx.provider.list({});
    assert.equal(Array.isArray(listed), true);
    if (!Array.isArray(listed)) return;
    const candidate = listed[0]!;
    assert.equal(await fx.provider.get({ ...candidate, name: "forged" }, {}), undefined);
    assert.equal(await fx.provider.get({ ...candidate, locator: {} }, {}), undefined);
    assert.equal(await fx.provider.get({ ...candidate, path: "/etc/hosts" }, {}), undefined);
  } finally {
    await fx.dispose();
  }
});

test("overlay: provider service rejects a misconfigured allowlist at construction", () => {
  // Each construction needs a fresh Context: the Service base registers on the
  // context before overlay validation can throw.
  assert.throws(
    () => new InsuremoSkillProviderService(new Context(), { skillOverlayNames: ["Not A Kebab Name"] }),
    /invalid overlay skill name/,
  );
  assert.throws(
    () => new InsuremoSkillProviderService(new Context(), { skillOverlayNames: ["dup", "dup"] }),
    /duplicate overlay skill name/,
  );
  const service = new InsuremoSkillProviderService(new Context(), {});
  assert.deepEqual(service.skillOverlay, { enabled: true, names: [...DEFAULT_SKILL_OVERLAY_NAMES] });
});
