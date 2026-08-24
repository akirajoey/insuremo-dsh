import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Storage } from "@deepseek-ai/dsh-storage";
import { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import { JsonStorageBackend } from "@deepseek-ai/dsh-storage-json";
import { SkillRegistry } from "../../../../deepseek-harness/packages/skill/skill/src/index.ts";
import { apply as applyFileSystemProvider } from "../../../../deepseek-harness/packages/skill/skill-filesystem/src/index.ts";
import { ImoSkillsService } from "../src/skills.ts";
import { ImoSkillActivationService, type SkillActivationController } from "../src/skill-activation.ts";
import { mountInsuremoSkillProvider } from "../src/skill-provider.ts";

/**
 * TASK-043 (B): a disabled InsureMO skill must vanish from the AGGREGATED
 * model-facing catalog — not merely from the insuremo provider's own list.
 * Full cross-provider chain: real filesystem provider (~/.agents/skills via
 * DSH_AGENTS_HOME) contributing the same-name real candidate (rank 500) vs
 * the insuremo provider's rank-450 mask; the lower rank wins, so the winning
 * catalog entry becomes non-invocable while the real files stay untouched.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "imo-catalog-mask-"));
  const fakeHome = join(root, "home");
  const agentsHome = join(fakeHome, ".agents");
  const skillRoot = join(agentsHome, "skills");
  await mkdir(join(skillRoot, "imo-audit-helper"), { recursive: true });
  await mkdir(join(skillRoot, "imo-batch"), { recursive: true });
  await writeFile(join(skillRoot, "imo-audit-helper", "SKILL.md"), "---\nname: imo-audit-helper\ndescription: Audit helper\n---\n# audit\n");
  await writeFile(join(skillRoot, "imo-batch", "SKILL.md"), "---\nname: imo-batch\ndescription: Batch\n---\n# batch\n");
  // project root .dsh/skills same-name candidate (project-dsh rank 100): a
  // disabled mask (rank 0) must still win over it in the aggregated catalog.
  const projectDsh = join(root, ".dsh", "skills");
  await mkdir(join(projectDsh, "imo-audit-helper"), { recursive: true });
  await writeFile(join(projectDsh, "imo-audit-helper", "SKILL.md"), "---\nname: imo-audit-helper\ndescription: Project override audit\n---\n# project audit\n");
  const inventoryJson = JSON.stringify([
    { name: "imo-audit-helper", description: "Audit helper", path: join(skillRoot, "imo-audit-helper"), valid: true },
    { name: "imo-batch", description: "Batch", path: join(skillRoot, "imo-batch"), valid: true },
  ]);

  const ctx = new Context();
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome; // allowedRoot=homedir(): fixtures must live "inside home"
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

    process.env.DSH_AGENTS_HOME = agentsHome;
    process.env.DSH_HOME = join(root, "dsh-home");
    await mkdir(process.env.DSH_HOME, { recursive: true });

    const skillsFiber = ctx.plugin(ImoSkillsService as never, { command: "imo" } as never);
    let controller: SkillActivationController | undefined;
    const activationFiber = ctx.plugin(ImoSkillActivationService as never, {
      onController: (value: SkillActivationController) => { controller = value; },
    } as never);
    const registryFiber = ctx.plugin(SkillRegistry as never);
    await Promise.all([skillsFiber.await(), activationFiber.await(), registryFiber.await()]);
    if (controller === undefined) throw new Error("activation controller missing");
    // real filesystem provider over the fake agents home (after the registry exists)
    applyFileSystemProvider(ctx as never, { agentsHome, dshHome: join(root, "dsh-home") });

    const unmountProvider = mountInsuremoSkillProvider(ctx as never);
    const skills = ctx.get("skills") as unknown as {
      snapshot(options?: unknown): Promise<{ skills: Array<{ name: string; invocation?: { modelInvocable?: boolean }; provider?: string; description?: string }> }>;
    };

    return {
      ctx, skills, controller: controller as SkillActivationController, root,
      async dispose() {
        if (realHome !== undefined) process.env.HOME = realHome;
        delete process.env.DSH_AGENTS_HOME;
        delete process.env.DSH_HOME;
        unmountProvider();
        await ctx.fiber.dispose();
        await backend.close();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (realHome !== undefined) process.env.HOME = realHome;
    delete process.env.DSH_AGENTS_HOME;
    delete process.env.DSH_HOME;
    await ctx.fiber.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

test("cross-provider mask (rank 0) beats project-dsh (100) & user-agents (500); enabled never steals project override (TASK-043)", async () => {
  const fx = await fixture();
  try {
    const names = ["imo-audit-helper", "imo-batch"];
    // let the filesystem watcher settle so collect revisions stabilize
    await new Promise(resolve => setTimeout(resolve, 500));
    // ENABLED baseline under cwd=root: the project .dsh/skills override (rank
    // 100) wins over both user-agents (500) and the insuremo real candidate
    // (450) — a project override must NOT be stolen by an enabled InsureMO skill.
    const before = await fx.skills.snapshot({ cwd: fx.root });
    const auditBefore = before.skills.find(s => s.name === "imo-audit-helper");
    assert.ok(auditBefore, "skill present when enabled");
    assert.equal(auditBefore.invocation?.modelInvocable, true);
    assert.equal(auditBefore.provider, "filesystem"); // project override wins when enabled

    // DISABLE: the insuremo mask (rank 0) wins over project-dsh (100) too
    await fx.controller.setEnabled("imo-audit-helper", false, names);
    const after = await fx.skills.snapshot({ cwd: fx.root });
    const auditAfter = after.skills.find(s => s.name === "imo-audit-helper");
    assert.ok(auditAfter, "name still present (mask shadows every same-name entry)");
    assert.equal(auditAfter.provider, "insuremo"); // only the rank-0 mask is an insuremo non-invocable
    assert.equal(auditAfter.invocation?.modelInvocable, false, "winning entry must be non-invocable");
    assert.equal(auditAfter.invocation?.userInvocable, false);
    // sibling stays fully invocable
    const batch = after.skills.find(s => s.name === "imo-batch");
    assert.equal(batch?.invocation?.modelInvocable, true);

    // RE-ENABLE: project override returns
    await fx.controller.setEnabled("imo-audit-helper", true, names);
    const restored = await fx.skills.snapshot({ cwd: fx.root });
    const auditRestored = restored.skills.find(s => s.name === "imo-audit-helper");
    assert.equal(auditRestored?.provider, "filesystem");
    assert.equal(auditRestored?.invocation?.modelInvocable, true);
    assert.match(auditRestored?.description ?? "", /Project override audit/, "project override restored, mask gone");
  } finally {
    await fx.dispose();
  }
});
