import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { createElement } from "react";
import { InsuremoCard, type InsuremoCardProps } from "./InsuremoCard.tsx";
import { registerDiagnosisPrefillSlot } from "./prefill-slot.tsx";
import { en, zh, type InsuremoLocaleKey } from "./locales.ts";
import type { DiagnosisFaces } from "./diagnosis.ts";

export type { InsuremoCardProps } from "./InsuremoCard.tsx";
export type { InsuremoLocaleKey } from "./locales.ts";
export type { DiagnosisFaces, DiagnosisHandoff, DiagnosisWorkspaces } from "./diagnosis.ts";
export { DiagnosisPrefillEntry, registerDiagnosisPrefillSlot } from "./prefill-slot.tsx";

/** Locale namespace contributed by the InsureMO settings card. */
export const NS = "settings.insuremo";

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "settings.insuremo": InsuremoLocaleKey;
  }
}

/** Settings uses the pure Workspace Controller and the UI navigation service. */
export const inject = ["slots", "locale", "workspaces", "uiWorkspace"];

/** Register the existing card as an independent Settings section and draft prefill. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-insuremo-settings: dictionaries");

  registerDiagnosisPrefillSlot(ctx);

  // Independent Settings section keeps the existing InsureMO card reachable.
  const t = ctx.locale.bind(NS);
  ctx.slots.inject("settings.section", () => ctx.slots.register({
    name: "settings.section",
    id: "insuremo",
    locale: NS,
    order: 50,
    label: () => t("nav"),
  }, function InsuremoCardWithRuntime(props: InsuremoCardProps) {
    const source = ctx as unknown as { uiWorkspace?: unknown; workspaces?: unknown };
    const diagnosisFaces: DiagnosisFaces = {
      workspaces: source.workspaces as DiagnosisFaces["workspaces"],
      uiWorkspace: source.uiWorkspace as DiagnosisFaces["uiWorkspace"],
    };
    return createElement(
      InsuremoCard,
      { ...props, diagnosisFaces },
    );
  }));
}
