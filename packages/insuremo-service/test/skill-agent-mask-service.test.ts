import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { InsuremoAgentSkillMaskService } from "../src/skill-agent-mask-service.ts";
import { InsuremoSkillProvider } from "../src/skill-provider.ts";
import { readFrontmatterPrefix } from "../src/skill-document.ts";

interface ProviderControl { readonly signal: AbortSignal; invalidate(): void }
interface Candidate { readonly name: string; readonly rank: number; readonly invocation: { modelInvocable?: boolean; userInvocable?: boolean } }

test("TASK-045 B exact-agent mask registers once and contributes disabled-only rank-0 candidates", async () => {
  const ctx = new Context();
  const root = homedir();
  ctx.provide("imoSkills" as never, {
    skillsAllowedRoot: root,
    validate: async () => ({ ok: true, value: {
      scope: "global", inventoryComplete: true, checkedAt: "now",
      items: [
        { name: "managed-disabled", description: "disabled", path: `${root}/missing-disabled`, valid: true, reasons: [] },
        { name: "managed-enabled", description: "enabled", path: `${root}/missing-enabled`, valid: true, reasons: [] },
      ],
    } }),
  } as never);
  ctx.provide("imoSkillActivation" as never, {
    ensureInitialized: async () => ({ initialized: true, installed: ["managed-disabled", "managed-enabled"], enabled: ["managed-enabled"], disabled: ["managed-disabled"], stale: [], revision: 1 }),
    snapshot: async () => ({ initialized: true, installed: ["managed-disabled", "managed-enabled"], enabled: ["managed-enabled"], disabled: ["managed-disabled"], stale: [], revision: 1 }),
  } as never);

  let registrations = 0;
  let factory: ((control: ProviderControl) => { list(): Promise<readonly Candidate[] | { candidates: readonly Candidate[] }> }) | undefined;
  const registry = {
    registerProvider(create: (control: ProviderControl) => unknown): () => void {
      registrations += 1;
      factory = create as typeof factory;
      return () => undefined;
    },
  };
  const agentCtx = { get: (name: string) => name === "skills" ? registry : undefined } as unknown as Context;
  const agent = { ctx: agentCtx };
  const service = new InsuremoAgentSkillMaskService(ctx);
  service.ensureAgent(agent);
  service.ensureAgent(agent);
  assert.equal(registrations, 1, "WeakSet prevents duplicate exact-agent registration");
  assert.ok(factory);
  const provider = factory!({ signal: new AbortController().signal, invalidate() {} });
  const listed = await provider.list();
  const candidates = Array.isArray(listed) ? listed : listed.candidates;
  assert.deepEqual(candidates.map(item => item.name), ["managed-disabled"]);
  assert.equal(candidates[0]?.rank, 0);
  assert.equal(candidates[0]?.invocation.modelInvocable, false);
  assert.equal(candidates[0]?.invocation.userInvocable, false);
});

test("TASK-048 canonical disable-model-invocation is overridden only in exact managed-agent scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "imo-tony-policy-"));
  try {
    const tony = join(root, "insuremo-design-with-tony");
    const ordinary = join(root, "ordinary");
    const malformed = join(root, "malformed");
    await mkdir(tony, { recursive: true });
    await mkdir(ordinary, { recursive: true });
    await mkdir(malformed, { recursive: true });
    await writeFile(join(tony, "SKILL.md"), "---\ndescription: Official Tony design workflow\ndisable-model-invocation: true\nuser-invocable: true\n---\n# Tony\n");
    await writeFile(join(ordinary, "SKILL.md"), "---\ndescription: Ordinary managed skill\n---\n# Ordinary\n");
    await writeFile(join(malformed, "SKILL.md"), "---\ndisable-model-invocation: maybe\n---\n# Malformed\n");
    assert.deepEqual(await readFrontmatterPrefix(join(malformed, "SKILL.md")), { invalid: true, canonicalInvalid: true });
    const ctx = new Context();
    const skills = { skillsAllowedRoot: root, validate: async () => ({ ok: true, value: { scope: "global", inventoryComplete: true, checkedAt: "now", items: [
      { name: "insuremo-design-with-tony", description: ">", path: tony, valid: true, reasons: [] },
      { name: "ordinary", description: "CLI description", path: ordinary, valid: true, reasons: [] },
      { name: "malformed", description: "malformed", path: malformed, valid: true, reasons: [] },
    ] } }) };
    ctx.provide("imoSkills" as never, skills as never);
    ctx.provide("imoSkillActivation" as never, { ensureInitialized: async () => ({ initialized: true, installed: ["insuremo-design-with-tony", "ordinary"], enabled: ["insuremo-design-with-tony", "ordinary"], disabled: [], stale: [], revision: 1 }), snapshot: async () => ({ initialized: true, installed: ["insuremo-design-with-tony", "ordinary"], enabled: ["insuremo-design-with-tony", "ordinary"], disabled: [], stale: [], revision: 1 }) } as never);
    const control = { signal: new AbortController().signal, invalidate() {} };
    const provider = new InsuremoSkillProvider(ctx, control, skills, "global", undefined, "disabled-mask");
    const listed = await provider.list();
    const candidates = Array.isArray(listed) ? listed : listed.candidates;
    assert.deepEqual(candidates.map(item => item.name), ["insuremo-design-with-tony", "malformed"]);
    assert.equal(candidates[0]?.description, "Official Tony design workflow");
    assert.deepEqual(candidates[0]?.invocation, { modelInvocable: true, userInvocable: true });
    assert.equal(candidates[1]?.invocation.modelInvocable, false);
    const definition = await provider.get(candidates[0]! as never);
    assert.equal(definition?.content, "# Tony\n");
    const global = new InsuremoSkillProvider(ctx, control, skills, "global");
    const globalListed = await global.list();
    const globalCandidates = Array.isArray(globalListed) ? globalListed : globalListed.candidates;
    assert.equal(globalCandidates.find(item => item.name === "malformed")?.invocation.modelInvocable, false);
    assert.equal(globalCandidates.find(item => item.name === "insuremo-design-with-tony")?.invocation.modelInvocable, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("TASK-045 B dual ownership: service reload cleans a live agent, then remounts without duplicate", async () => {
  const ctx = new Context();
  const registrations: { disposed: boolean }[] = [];
  const registry = {
    registerProvider: (_factory: unknown) => {
      const record = { disposed: false };
      registrations.push(record);
      return () => { record.disposed = true; };
    },
  };
  ctx.provide("skills" as never, registry as never);
  ctx.provide("agents" as never, {} as never);
  ctx.provide("imoSkills" as never, {} as never);
  ctx.provide("imoSkillActivation" as never, {} as never);
  const agent = { ctx: { get: (name: string) => name === "skills" ? registry : undefined } as unknown as Context };
  const payload = { agent, turn: 1, step: 1, signal: { aborted: false } };
  const waterfall = (ctx as unknown as { waterfall(name: string, ...args: unknown[]): unknown }).waterfall;
  const runStep = async () => waterfall.call(ctx, "agent/pre-step", payload, () => ({ kind: "enter", messages: [] }));

  const first = ctx.plugin(InsuremoAgentSkillMaskService as never);
  await first.await();
  await runStep();
  await new Promise(resolve => setTimeout(resolve, 250));
  await runStep();
  assert.equal(registrations.length, 1, "same agent remains mounted after sweep without duplicate");
  await first.dispose();
  assert.equal(registrations[0]?.disposed, true, "service disposal cleans exact provider while agent remains live");

  const second = ctx.plugin(InsuremoAgentSkillMaskService as never);
  await second.await();
  await runStep();
  assert.equal(registrations.length, 2, "reload registers one fresh exact provider");
  assert.equal(registrations[1]?.disposed, false);
  // Agent-first teardown is also safe; service disposal is idempotent cleanup.
  registrations[1]!.disposed = true;
  await second.dispose();
  assert.equal(registrations[1]?.disposed, true);
});
