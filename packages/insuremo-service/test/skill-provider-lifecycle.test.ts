import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { SkillRegistry } from "../../../../deepseek-harness/packages/skill/skill/src/index.ts";
import { ImoSkillsService } from "../src/skills.ts";
import { ImoSkillActivationService, type SkillActivationController } from "../src/skill-activation.ts";
import { InsuremoSkillProviderService } from "../src/skill-provider-service.ts";

/**
 * TASK-044 C lifecycle test: the provider is mounted from a PERSISTENT SERVICE
 * (not a transient `apply()` effect), so it must survive the loader-effect
 * sweep window (well past ~25ms) and still control the aggregated catalog.
 * Disposing the service unregisters it (provider gone from the registry).
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "imo-provider-lifecycle-"));
  const fakeHome = join(root, "home");
  const skillRoot = join(fakeHome, ".agents", "skills");
  await mkdir(join(skillRoot, "imo-audit-helper"), { recursive: true });
  await writeFile(join(skillRoot, "imo-audit-helper", "SKILL.md"), "---\nname: imo-audit-helper\ndescription: Audit helper\n---\n# audit\n");
  const inventoryJson = JSON.stringify([
    { name: "imo-audit-helper", description: "Audit helper", path: join(skillRoot, "imo-audit-helper"), valid: true },
  ]);

  const ctx = new Context();
  const realHome = homedir();
  process.env.HOME = fakeHome; // allowedRoot = homedir()
  try {
    const storageFiber = ctx.plugin(Storage as never);
    await storageFiber.await();
    const backend = new JsonStorageBackend(join(root, "storage"));
    ctx.storage.backend.register("json", backend);
    const facility = new DomainFacility(ctx as never, { backend: "json" });
    ctx.provide("storageDomain", facility);

    const makeHandle = (stdoutText: string): unknown => ({
      pid: 1, stdin: undefined,
      stdout: (async function* () { yield stdoutText; })(),
      stderr: (async function* () {})(),
      collected: {
        stdout: { readFrom: (fromByte: number) => ({ text: fromByte === 0 ? stdoutText : "", nextOffset: stdoutText.length, lossy: false }) },
        stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) },
      },
      done: Promise.resolve({ exitCode: 0, signal: null }),
      waitForExit: async () => true, terminate: () => {},
    });
    ctx.provide("subprocess", {
      resolveExecutable: async () => "/opt/homebrew/bin/imo",
      spawn: (spec: { argv: readonly string[] }): unknown => {
        return makeHandle(spec.argv.join(" ").includes("skills list") ? inventoryJson : "{}");
      },
    } as never);

    const skillsFiber = ctx.plugin(ImoSkillsService as never, { command: "imo" } as never);
    let controller: SkillActivationController | undefined;
    const activationFiber = ctx.plugin(ImoSkillActivationService as never, {
      onController: (value: SkillActivationController) => { controller = value; },
    } as never);
    const registryFiber = ctx.plugin(SkillRegistry as never);
    await Promise.all([skillsFiber.await(), activationFiber.await(), registryFiber.await()]);
    if (controller === undefined) throw new Error("activation controller missing");

    const skills = ctx.get("skills") as unknown as {
      snapshot(options?: unknown): Promise<{ skills: Array<{ name: string; provider?: string; invocation?: { modelInvocable?: boolean } }> }>;
    };
    // mount the PERSISTENT SERVICE (the exact mechanism apply now uses)
    const providerFiber = ctx.plugin(InsuremoSkillProviderService as never);
    await providerFiber.await();
    const service = ctx.get("insuremoSkillProvider" as never) as unknown as InsuremoSkillProviderService;
    if (service === undefined || typeof (service as { disposeProvider?: unknown }).disposeProvider !== "function") {
      throw new Error("provider service not available by name");
    }
    return {
      ctx, skills, controller: controller as SkillActivationController, service, root, backend, providerFiber,
      async dispose() {
        process.env.HOME = realHome;
        await ctx.fiber.dispose();
        await backend.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    process.env.HOME = realHome;
    await ctx.fiber.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("TASK-044 C: service-mounted provider survives the 100ms+ sweep window and controls the catalog; dispose removes it", async () => {
  const fx = await fixture();
  try {
    const names = ["imo-audit-helper"];
    // wait well past the ~25ms loader-effect sweep window
    await new Promise(resolve => setTimeout(resolve, 250));
    // enabled → real candidate present (provider alive, not swept)
    const enabled = await fx.skills.snapshot({ cwd: fx.root });
    const audit = enabled.skills.find(s => s.name === "imo-audit-helper");
    assert.ok(audit, "provider alive after sweep: candidate present");
    assert.equal(audit.invocation?.modelInvocable, true);
    // disable → the rank-0 mask governs (provider still controlling catalog)
    await fx.controller.setEnabled("imo-audit-helper", false, names);
    const afterDisable = await fx.skills.snapshot({ cwd: fx.root });
    const mask = afterDisable.skills.find(s => s.name === "imo-audit-helper");
    assert.ok(mask, "mask still governs after sweep");
    assert.equal(mask.provider, "insuremo");
    assert.equal(mask.invocation?.modelInvocable, false);
    // explicit teardown removes the provider from the registry
    fx.service.disposeProvider();
    const afterDispose = await fx.skills.snapshot({ cwd: fx.root });
    const gone = afterDispose.skills.find(s => s.name === "imo-audit-helper");
    assert.equal(gone, undefined, "provider unregistered after dispose");
  } finally {
    await fx.dispose();
  }
});

test("TASK-044 C structural: provider registration happens in [Service.init], not the constructor", async () => {
  const { Context } = await import("@deepseek-ai/cordis");
  const { InsuremoSkillProviderService } = await import("../src/skill-provider-service.ts");
  const source = await (await import("node:fs")).promises.readFile(
    (await import("node:path")).join(process.cwd(), "src/skill-provider-service.ts"), "utf8");
  // registration lives inside [Service.init]
  const initIdx = source.lastIndexOf("[Service.init]");
  assert.ok(initIdx > -1);
  const mountIdx = source.indexOf("mountInsuremoSkillProvider", initIdx);
  assert.ok(mountIdx > -1, "mount must be inside [Service.init]");
  // constructor body does not call mount (no transient registration before activation)
  const ctorIdx = source.indexOf("constructor(");
  const ctorTail = source.indexOf("[Service.init]", ctorIdx);
  const ctorBody = source.slice(ctorIdx, ctorTail);
  assert.equal(ctorBody.includes("mountInsuremoSkillProvider"), false,
    "constructor must not register the provider");
  void Context; void InsuremoSkillProviderService;
});
