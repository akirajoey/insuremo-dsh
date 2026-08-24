import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { InsuremoAgentSkillMaskService } from "../src/skill-agent-mask-service.ts";

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
