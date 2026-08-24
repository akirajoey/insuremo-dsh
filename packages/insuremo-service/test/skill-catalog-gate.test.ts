import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { SkillRegistry } from "../../../../deepseek-harness/packages/skill/skill/src/index.ts";
import { ImoSkillsService } from "../src/skills.ts";
import { ImoSkillActivationService, type SkillActivationController } from "../src/skill-activation.ts";
import { mountInsuremoSkillProvider } from "../src/skill-provider.ts";

/**
 * TASK-042 ③: disabling a skill in the activation domain must remove it
 * from the real harness skill catalog on the next list() (the provider's
 * stableList gate + revision-driven invalidate chain), and re-enabling must
 * restore it. Full-chain integration: real SkillRegistry, real activation
 * domain, fake imo CLI subprocess with SKILL.md fixtures under a fake HOME.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-gate-"));
  const fakeHome = join(root, "home");
  const skillRoot = join(fakeHome, ".agents", "skills");
  await mkdir(join(skillRoot, "imo-audit-helper"), { recursive: true });
  await mkdir(join(skillRoot, "imo-batch"), { recursive: true });
  await writeFile(join(skillRoot, "imo-audit-helper", "SKILL.md"), "---\ndescription: Audit\n---\n# audit\n");
  await writeFile(join(skillRoot, "imo-batch", "SKILL.md"), "---\ndescription: Batch\n---\n# batch\n");
  const inventoryJson = JSON.stringify([
    { name: "imo-audit-helper", description: "Audit", path: join(skillRoot, "imo-audit-helper"), valid: true },
    { name: "imo-batch", description: "Batch", path: join(skillRoot, "imo-batch"), valid: true },
  ]);

  const ctx = new Context();
  const realHome = homedir();
  process.env.HOME = fakeHome;
  try {
    const storageFiber = ctx.plugin(Storage as never);
    await storageFiber.await();
    const backend = new JsonStorageBackend(join(root, "storage"));
    ctx.storage.backend.register("json", backend);
    const facility = new DomainFacility(ctx as never, { backend: "json" });
    ctx.provide("storageDomain", facility);

    // fake subprocess: resolve + spawn with reader-shaped collected output
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
        const argv = spec.argv.join(" ");
        return makeHandle(argv.includes("skills list") ? inventoryJson : "{}");
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
    const unmountProvider = mountInsuremoSkillProvider(ctx as never);
    const skills = ctx.get("skills") as unknown as { list(): Promise<Array<{ name: string }>> };
    return {
      ctx, skills, controller: controller as SkillActivationController, root,
      async dispose() {
        process.env.HOME = realHome;
        unmountProvider();
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

test("activation disable removes the skill from the real catalog; re-enable restores it", async () => {
  const fx = await fixture();
  try {
    const names = ["imo-audit-helper", "imo-batch"];
    const before = (await fx.skills.list()).map(s => s.name).sort();
    assert.deepEqual(before, ["imo-audit-helper", "imo-batch"]);

    await fx.controller.setEnabled("imo-audit-helper", false, names);
    // TASK-043 (B): the disabled name remains as a non-invocable insuremo mask
    // rather than vanishing — it shadows any same-name filesystem entry.
    const afterDisable = await fx.skills.list();
    const auditAfterDisable = afterDisable.find(s => s.name === "imo-audit-helper");
    assert.ok(auditAfterDisable, "mask entry present");
    assert.equal(auditAfterDisable.invocation?.modelInvocable, false, "mask must be non-invocable");
    assert.deepEqual(afterDisable.filter(s => s.name !== "imo-audit-helper").map(s => s.name).sort(), ["imo-batch"]);

    await fx.controller.setEnabled("imo-audit-helper", true, names);
    const afterEnable = (await fx.skills.list()).map(s => s.name).sort();
    assert.deepEqual(afterEnable, ["imo-audit-helper", "imo-batch"], "re-enable must restore it");
  } finally {
    await fx.dispose();
  }
});
