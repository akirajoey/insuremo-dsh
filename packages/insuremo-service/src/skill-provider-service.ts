import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { mountInsuremoSkillProvider } from "./skill-provider.ts";

/**
 * Persistent InsureMO skill-provider mount (TASK-044 C).
 *
 * The provider is registered from THIS Service's `[Service.init]`, NOT from a
 * transient `apply()` effect — a loader-entry `ctx.effect` was observed to be
 * swept ~25ms after mount, which left the real session catalog contributed by
 * the filesystem provider instead of the InsureMO rank-0 mask / enabled
 * candidates. A registered Service fiber stays active for the process
 * lifetime, so the mask provider survives the sweep window and controls the
 * aggregated model-facing catalog.
 */
export class InsuremoSkillProviderService extends Service {
  static inject = ["skills", "imoSkills", "imoSkillActivation"] as const;

  #disposer: (() => void) | undefined;

  constructor(ctx: Context) {
    super(ctx, "insuremoSkillProvider" as never);
    // TASK-036-2b: cordis hands callers a proxy receiver where native
    // `#private` fields are invisible — bind public methods so `this` is the
    // original instance.
    this.disposeProvider = this.disposeProvider.bind(this);
  }

  protected [Service.init](): void {
    if (this.#disposer === undefined) {
      this.#disposer = mountInsuremoSkillProvider(this.ctx);
    }
  }

  /** Explicit teardown (tests + service lifecycle): unregister + abort control. */
  disposeProvider(): void {
    if (this.#disposer !== undefined) {
      this.#disposer();
      this.#disposer = undefined;
    }
  }
}
