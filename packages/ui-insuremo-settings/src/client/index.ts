import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { InsuremoSection, type InsuremoSectionProps } from "./InsuremoSection.tsx";
import { en, zh, type InsuremoLocaleKey } from "./locales.ts";

export type { InsuremoSectionProps } from "./InsuremoSection.tsx";
export type { InsuremoLocaleKey } from "./locales.ts";

/** Locale namespace contributed by the InsureMO settings section. */
export const NS = "settings.insuremo";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "settings.insuremo": InsuremoLocaleKey;
  }
}

/** Services used by the client-side settings contribution. */
export const inject = ["slots", "locale"];

/** Register the localized InsureMO section lazily on the Settings slot. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-insuremo-settings: dictionaries");

  const t = ctx.locale.bind(NS);
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "insuremo",
    order: 50,
    label: () => t("nav"),
    locale: NS,
  }, InsuremoSection));
}
