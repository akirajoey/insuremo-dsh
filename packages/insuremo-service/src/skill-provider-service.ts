import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { resolveSkillOverlayConfig, type SkillOverlayConfig } from "./skill-overlay.ts";
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

  /** Overlay settings (TASK-100); raw/optional — validated fail-loud in the constructor. */
  readonly skillOverlay: SkillOverlayConfig;

  #disposer: (() => void) | undefined;

  constructor(
    ctx: Context,
    config: { skillOverlayEnabled?: boolean; skillOverlayNames?: readonly string[] } = {},
  ) {
    super(ctx, "insuremoSkillProvider" as never);
    // Validation (Harness kebab grammar, duplicates, count, byte bound) fails
    // service construction on a misconfigured allowlist instead of silently
    // degrading the overlay.
    this.skillOverlay = resolveSkillOverlayConfig({
      enabled: config.skillOverlayEnabled,
      names: config.skillOverlayNames,
    });
    // TASK-036-2b: cordis hands callers a proxy receiver where native
    // `#private` fields are invisible — bind public methods so `this` is the
    // original instance.
    this.disposeProvider = this.disposeProvider.bind(this);
  }

  protected [Service.init](): void {
    if (this.#disposer === undefined) {
      this.#disposer = mountInsuremoSkillProvider(this.ctx, "global", this.skillOverlay);
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
