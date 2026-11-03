import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { registerIcomposerTools } from "./tools.ts";

/**
 * Persistent root-owned registration for all iComposer/ICI tools.
 *
 * Ownership uses the public `ctx.effect` lifecycle: the registrar hands back
 * one disposer per tool/prompt, this service keeps them individually and
 * releases them newest-first when the effect tears down. `registerIcomposerTools`
 * is transactional, so a registration that throws midway releases everything
 * it already acquired and rethrows the original error — no leaked tool, no
 * swallowed duplicate-name conflict, and never another owner's registration.
 *
 * The `internal/plugin` listener is retained deliberately (TASK-164, D2): the
 * public effect disposers only run after the fiber's unload turn yields, while
 * the listener releases the same handles synchronously inside `dispose()`.
 * That same-turn release is the behaviour the tool registry has observed;
 * removing the listener would regress it to await-only release. Every handle
 * is single-shot, so the later effect teardown is a no-op, and the listener
 * only touches this service's own registrations.
 */
export class IcomposerVerifyToolService extends Service {
  static inject = ["tools", "systemPrompt"] as const;

  #releases: Array<() => void> = [];

  constructor(ctx: Context) {
    super(ctx, "icomposerVerifyTools");
    this.disposeTools = this.disposeTools.bind(this);
  }

  protected [Service.init](): void {
    const ctx = this.ctx;
    ctx.effect(() => {
      // A reload (dependency loss → restore) re-runs this effect; the previous
      // generation's handles were already released, so drop the dead closures
      // instead of accumulating them across reloads.
      this.#releases = [];
      const disposers = registerIcomposerTools(ctx);
      for (const dispose of disposers) {
        let live = true;
        this.#releases.push(() => {
          if (!live) return;
          live = false;
          dispose();
        });
      }
      return () => this.disposeTools();
    }, "icomposerVerifyTools.registration");
    const ownerFiber = (this.ctx as unknown as { readonly fiber?: unknown }).fiber;
    this.ctx.on("internal/plugin", (fiber: unknown) => {
      if (fiber === ownerFiber) this.disposeTools();
    });
  }

  /** Release this service's own handles now; safe to call more than once. */
  disposeTools(): void {
    const releases = this.#releases.splice(0).reverse();
    const failures: unknown[] = [];
    for (const release of releases) {
      try { release(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "failed to release iComposer tool registrations");
    }
  }
}
