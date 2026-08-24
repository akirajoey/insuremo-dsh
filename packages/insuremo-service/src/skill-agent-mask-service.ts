import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { mountInsuremoSkillMaskProvider } from "./skill-provider.ts";

interface AgentLike {
  readonly ctx?: Context;
}
interface PreStepPayload {
  readonly agent?: AgentLike;
}

/**
 * Installs the InsureMO disabled-skill mask in the exact live-agent scope.
 *
 * The global provider cannot mask a same-name filesystem candidate contributed
 * by an agent/preset layer: SkillRegistry merges nearer layers before looking
 * at rank. This persistent service therefore waits until the first pre-step
 * of each agent and registers a mask through that agent's own `ctx.skills`
 * registry. Registration is owned by the agent context and is automatically
 * disposed with that agent. Enabled skills are intentionally omitted by the
 * mask provider, leaving nearer project/preset overrides intact.
 */
export class InsuremoAgentSkillMaskService extends Service {
  static inject = ["agents", "skills", "imoSkills", "imoSkillActivation"] as const;

  #seen = new WeakSet<object>();
  #listenerDispose: (() => void) | undefined;

  constructor(ctx: Context) {
    super(ctx, "insuremoAgentSkillMask" as never);
    this.ensureAgent = this.ensureAgent.bind(this);
    this.disposeMasks = this.disposeMasks.bind(this);
  }

  protected [Service.init](): void {
    if (this.#listenerDispose !== undefined) return;
    const on = (this.ctx as unknown as {
      on(event: "agent/pre-step", listener: (payload: unknown, next: unknown) => unknown, options?: { prepend?: boolean }): () => boolean;
    }).on;
    this.#listenerDispose = on.call(this.ctx, "agent/pre-step", (payload: unknown, next: unknown) => {
      this.ensureAgent((payload as PreStepPayload).agent);
      return (next as () => unknown)();
    }, { prepend: true });
  }

  /** Idempotently mount one provider in this exact agent scope. */
  ensureAgent(agent: AgentLike | undefined): void {
    const agentCtx = agent?.ctx;
    if (agentCtx === undefined || typeof agent !== "object") return;
    if (this.#seen.has(agent)) return;
    let registry: unknown;
    try {
      const get = (agentCtx as unknown as { get?: (name: string) => unknown }).get;
      registry = typeof get === "function" ? get.call(agentCtx, "skills") : undefined;
      if (registry === undefined) registry = (agentCtx as unknown as { skills?: unknown }).skills;
    } catch {
      return;
    }
    // Calling through the exact agent context is important: a root `skills`
    // registry would put this provider in the global layer and recreate the
    // preset-scope leak this service exists to prevent.
    if (registry === undefined || typeof (registry as { registerProvider?: unknown }).registerProvider !== "function") return;
    // mount helper resolves agentCtx.get("skills"), preserving the scope
    // carrier and the agent-owned effect disposer.
    const disposer = mountInsuremoSkillMaskProvider(this.ctx, agentCtx);
    // Dual ownership: the exact registration is primarily owned by agent.ctx,
    // and this service fiber also owns an idempotent cleanup. This prevents a
    // service reload from leaving a stale provider in a still-live agent.
    this.ctx.effect(() => disposer, `insuremoAgentSkillMask:${String((agent as { id?: unknown }).id ?? "agent")}`);
    this.#seen.add(agent);
  }

  /** Stop listening; exact-agent registrations are owned by their agent ctx. */
  disposeMasks(): void {
    this.#listenerDispose?.();
    this.#listenerDispose = undefined;
  }
}
