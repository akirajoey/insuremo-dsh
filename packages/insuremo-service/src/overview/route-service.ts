import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { mountOverviewRoute } from "./route.ts";
import { mountSkillCatalogRoute } from "./skill-catalog-route.ts";
import { mountWriteRoutes } from "./write-routes.ts";
import { mountWorkspacesStatusRoute } from "./workspaces-status.ts";

export type ActivationControllerLike = { setEnabled(name: string, enabled: boolean, installedNames: readonly string[], expectedRevision?: number): Promise<unknown> };

/** Composition seam: index.ts stores the live controller here for the routes. */
export function setActivationControllerOnContext(ctx: Context, controller: ActivationControllerLike | undefined): void {
  (ctx as unknown as { __insuremoActivationController?: ActivationControllerLike }).__insuremoActivationController = controller;
}

type RouteDisposer = () => void;

/** Route/section host for the InsureMO UI bridges. */
export class InsuremoRoutesService extends Service {
  static inject = ["webServer"] as const;

  #activationController: ActivationControllerLike | undefined;

  /** Capture point for the activation controller (composition wiring). */
  setActivationController(controller: ActivationControllerLike | undefined): void {
    this.#activationController = controller;
  }

  protected [Service.init](): void {
    const ctx = this.ctx;
    // Own the registrations on this service fiber, not the transient loader
    // entry. Each successful acquisition is captured immediately, and a later
    // registration error cannot leave the earlier routes behind.
    ctx.effect(() => {
      const disposers: RouteDisposer[] = [];
      const dispose = (): void => {
        const errors: unknown[] = [];
        for (const release of disposers.splice(0).reverse()) {
          try { release(); } catch (error) { errors.push(error); }
        }
        if (errors.length > 0) throw new AggregateError(errors, "failed to release InsureMO routes");
      };
      try {
        disposers.push(mountOverviewRoute(ctx));
        disposers.push(mountSkillCatalogRoute(ctx));
        disposers.push(mountWriteRoutes(ctx));
        disposers.push(mountWorkspacesStatusRoute(ctx));
      } catch (error) {
        try { dispose(); } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "route registration and rollback failed", { cause: error });
        }
        throw error;
      }
      return dispose;
    }, "insuremo routes");
  }
}
