import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { createElement } from "react";
import { InsuremoCard, type InsuremoCardProps } from "./InsuremoCard.tsx";
import { en, zh, type InsuremoLocaleKey } from "./locales.ts";
import type { DiagnosisSessions } from "./diagnosis.ts";

export type { InsuremoCardProps } from "./InsuremoCard.tsx";
export type { InsuremoLocaleKey } from "./locales.ts";
export type { DiagnosisSessions } from "./diagnosis.ts";

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
  // The registration closes over the client runtime so the card's diagnosis
  // hand-off can reach ctx.sessions (slot owner props supply no runtime); a
  // missing/unusable sessions face degrades to the clipboard fallback.
  ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
    name: "settings.plugin.item",
    // keyed dispatch by the Host-served "insuremo" namespace in production;
    // id keeps the same entry registrable under a list-kind test frame.
    key: "insuremo",
    id: "insuremo",
    locale: NS,
  }, function InsuremoCardWithRuntime(props: InsuremoCardProps) {
    const sessions = (ctx as { sessions?: unknown }).sessions;
    return createElement(
      InsuremoCard,
      { ...props, diagnosisSessions: sessions as DiagnosisSessions | undefined },
    );
  }));
}
