import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
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

/** Services used by the client-side contribution. The card wrapper reads the
 * `sessions`/`workspaces` faces directly off ctx at render time (slot owner
 * props supply no runtime), so both must be declared here — cordis property
 * guards throw on an undeclared service access. */
export const inject = ["slots", "locale", "sessions", "workspaces"];

/**
 * Register the InsureMO Plugins-tab card and the diagnosis prefill entry
 * (TASK-088). Both close over the client runtime because slot owner props
 * supply no runtime: the card's hand-off reaches the official
 * `ctx.workspaces`/`ctx.sessions` faces, and the prefill entry rides the
 * official session-scope standard kit (`inputActions.setDraft`). A missing
 * or unusable face degrades to the clipboard fallback — no DSH seam outside
 * the unmodified rc.7 contracts is ever touched.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-insuremo-settings: dictionaries");

  registerDiagnosisPrefillSlot(ctx);

  // Plugins tab card (TASK-039): keyed by the Host-served "insuremo" settings
  // namespace so ConfigurablePluginsTab dispatches it without a custom tab.
  ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
    name: "settings.plugin.item",
    // keyed dispatch by the Host-served "insuremo" namespace in production;
    // id keeps the same entry registrable under a list-kind test frame.
    key: "insuremo",
    id: "insuremo",
    locale: NS,
  }, function InsuremoCardWithRuntime(props: InsuremoCardProps) {
    const source = ctx as { sessions?: unknown; workspaces?: unknown };
    const diagnosisFaces: DiagnosisFaces = {
      workspaces: source.workspaces as DiagnosisFaces["workspaces"],
      sessions: source.sessions as DiagnosisFaces["sessions"],
    };
    return createElement(
      InsuremoCard,
      { ...props, diagnosisFaces },
    );
  }));
}
