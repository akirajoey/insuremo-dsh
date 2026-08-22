import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { mountOverviewRoute } from "./route.ts";
import { mountWriteRoutes } from "./write-routes.ts";
import { mountWorkspacesStatusRoute } from "./workspaces-status.ts";
import { mountCurrentProfileSection } from "../current-profile-section.ts";

export type ActivationControllerLike = { setEnabled(name: string, enabled: boolean, installedNames: readonly string[], expectedRevision?: number): Promise<unknown> };

/** Composition seam: index.ts stores the live controller here for the routes. */
export function setActivationControllerOnContext(ctx: Context, controller: ActivationControllerLike | undefined): void {
  (ctx as unknown as { __insuremoActivationController?: ActivationControllerLike }).__insuremoActivationController = controller;
}

type RouteDisposer = () => void;

/**
 * Route/section host for the InsureMO UI bridges.
 *
 * Registration happens DIRECTLY in `[Service.init]` — not via `ctx.effect`.
 * Effects registered by plugins mounted inside a loader entry were observed
 * to be swept ~25ms after mount (the entry fiber's pre-activation epoch
 * unloads effect runners that never reached ACTIVE), which silently removed
 * every route while the process kept serving (`overview 404` with a clean
 * boot). Direct registration with an idempotence guard keeps the routes for
 * the process lifetime; disposers are only invoked on fiber unload via the
 * service registry teardown (and double-registration is tolerated).
 */
export class InsuremoRoutesService extends Service {
  static inject = ["webServer"] as const;

  #activationController: ActivationControllerLike | undefined;
  #disposers: RouteDisposer[] = [];
  #registered = false;

  /** Capture point for the activation controller (composition wiring). */
  setActivationController(controller: ActivationControllerLike | undefined): void {
    this.#activationController = controller;
  }

  protected async [Service.init](): Promise<void> {
    if (this.#registered) return;
    this.#registered = true;
    const ctx = this.ctx;
    const safe = (register: () => RouteDisposer): void => {
      try {
        this.#disposers.push(register());
      } catch {
        // duplicate route from an earlier mount of this same process: keep the
        // existing registration alive instead of failing the whole service
      }
    };
    safe(() => mountOverviewRoute(ctx));
    safe(() => mountWriteRoutes(ctx));
    safe(() => mountWorkspacesStatusRoute(ctx));
    safe(() => mountCurrentProfileSection(ctx));
    const firstRequestGuard = (_req: IncomingMessage, res: ServerResponse): void => {
      res.writeHead(500);
      res.end();
    };
    void firstRequestGuard;
  }
}
