import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { registerIcomposerTools } from "./tools.ts";

/** Persistent root-owned registration for all iComposer/ICI tools. */
export class IcomposerVerifyToolService extends Service {
  static inject = ["tools", "systemPrompt"] as const;
  #disposers: Array<() => void> = [];

  constructor(ctx: Context) {
    super(ctx, "icomposerVerifyTools");
    this.disposeTools = this.disposeTools.bind(this);
  }

  protected [Service.init](): void {
    this.#disposers = registerIcomposerTools(this.ctx);
    this.ctx.effect(() => () => this.disposeTools(), "icomposerVerifyTools.dispose");
    const ownerFiber = (this.ctx as unknown as { readonly fiber?: unknown }).fiber;
    this.ctx.on("internal/plugin", (fiber: unknown) => {
      if (fiber === ownerFiber) this.disposeTools();
    });
  }

  disposeTools(): void {
    for (const dispose of this.#disposers.splice(0).reverse()) dispose();
  }
}
