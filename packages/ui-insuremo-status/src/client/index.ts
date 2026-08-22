import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { StatusBadge, type StatusBadgeProps } from "./StatusBadge.tsx";
import { WorkspaceHealth, type WorkspaceHealthProps } from "./WorkspaceHealth.tsx";
import { ProfilePicker } from "./ProfilePicker.tsx";
import { en, zh, type InsuremoStatusLocaleKey } from "./locales.ts";

export type { StatusBadgeProps } from "./StatusBadge.tsx";
export type { WorkspaceHealthProps, WorkspaceHealthRow } from "./WorkspaceHealth.tsx";
export { WorkspaceHealth, WORKSPACES_STATUS_URL, parseWorkspaceHealthRows } from "./WorkspaceHealth.tsx";
export { ProfilePicker } from "./ProfilePicker.tsx";
export type { InsuremoStatusLocaleKey } from "./locales.ts";

/** Locale namespace contributed by the InsureMO sidebar status. */
export const NS = "sidebar.insuremo";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "sidebar.insuremo": InsuremoStatusLocaleKey;
  }
}

/** Services used by the client-side sidebar contribution. */
export const inject = ["slots", "locale"];

/** Register the static localized status badge in the sidebar footer. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-insuremo-status: dictionaries");

  const t = ctx.locale.bind(NS);
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "insuremo-status",
    order: 10,
    locale: NS,
    label: () => t("label"),
  }, ProfilePicker));

  // Workspace health strip: three 16px glyphs per workspace (i / graph /
  // brain), fed by the read-only host status route (60s TTL).
  ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
    name: "sidebar.footer.action",
    id: "insuremo-workspace-health",
    order: 11,
    locale: NS,
    label: () => t("health.strip"),
  }, WorkspaceHealth));
}
