import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { InsuremoCard } from "./InsuremoCard.tsx";
import { en, zh, type InsuremoLocaleKey } from "./locales.ts";

export type { InsuremoCardProps } from "./InsuremoCard.tsx";
export type { InsuremoLocaleKey } from "./locales.ts";

/** Locale namespace contributed by the InsureMO settings card. */
export const NS = "settings.insuremo";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "settings.insuremo": InsuremoLocaleKey;
  }
}

/** Services used by the client-side contribution. */
export const inject = ["slots", "locale"];

/** Register the localized InsureMO Plugins-tab card. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-insuremo-settings: dictionaries");

  // Plugins tab card (TASK-039): keyed by the Host-served "insuremo" settings
  // namespace so ConfigurablePluginsTab dispatches it without a custom tab.
  ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
    name: "settings.plugin.item",
    // keyed dispatch by the Host-served "insuremo" namespace in production;
    // id keeps the same entry registrable under a list-kind test frame.
    key: "insuremo",
    id: "insuremo",
    locale: NS,
  }, InsuremoCard));
}
