/**
 * TASK-167a positive contract: compiles against the PUBLISHED declarations of
 * the target DSH version (rc.2 or rc.5) — never against a repo shim. The
 * runner installs the tarballs into a temp `node_modules`, copies this file
 * next to it, and compiles with `strict`; `--listFiles`/`--traceResolution`
 * must show the temp package paths.
 *
 * Coverage follows the 13 harness shims: cordis services/effects, subprocess,
 * storage-domain, workspace registry, jobs (root + `/view`), tools, system
 * prompt, skill, llm, native command, schemastery, and the client UI surfaces
 * (slots, renderer, locale, settings, sidebar, session, chat, primitives).
 */
import { Context, Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { SlotRegistry } from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type { UseSessions } from "@deepseek-ai/dsh-client-ui-session/client";
import type { ChatNodeDataMap } from "@deepseek-ai/dsh-client-ui-chat/client";
import type { JobRegistry, JobSpec } from "@deepseek-ai/dsh-jobs";
import type { JobView } from "@deepseek-ai/dsh-jobs/view";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import type { PromptSection } from "@deepseek-ai/dsh-system-prompt";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
import type { DomainFacility } from "@deepseek-ai/dsh-storage-domain";
import type { WorkspaceRegistry } from "@deepseek-ai/dsh-workspace";
import type { SkillDefinition } from "@deepseek-ai/dsh-skill";
import type { LlmRuntime } from "@deepseek-ai/dsh-llm";
import type { WorkspaceController } from "@deepseek-ai/dsh-api-workspace-controller";
import type { NativeCommandRunner } from "@deepseek-ai/dsh-native-command";
import type { Storage } from "@deepseek-ai/dsh-storage";
import { StateDot } from "@deepseek-ai/dsh-client-ui-primitives";

// The plugin owns this locale namespace; declaring it here mirrors the real
// registration and proves PropsLocale resolves through the public table.
declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "sidebar.insuremo": "label" | "health.strip";
  }
}

export type FooterProps = PropsRuntime<"sidebar.footer.action"> & PropsLocale<"sidebar.insuremo">;

/** Typed locale seat from the owner-declared slot contract. */
export function footerLabel(props: FooterProps): string {
  return props.t("health.strip");
}

/** Client services arrive through declaration merging, not a local shim. */
export function clientFaces(ctx: Context): {
  slots: SlotRegistry;
  locale: LocaleRuntime;
} {
  return { slots: ctx.slots, locale: ctx.locale };
}

/** Host faces the Workbench services inject. */
export function hostFaces(ctx: Context): {
  subprocess: SubprocessRuntime;
  domains: DomainFacility;
  workspaces: WorkspaceRegistry;
  jobs: JobRegistry;
  llm: LlmRuntime;
} {
  return {
    subprocess: ctx.subprocess,
    domains: ctx.storageDomain,
    workspaces: ctx.workspaceRegistry,
    jobs: ctx.jobs,
    llm: ctx.llm,
  };
}

/** A real Service subclass with a static inject list. */
export class ContractService extends Service {
  static inject = ["subprocess"] as const;

  constructor(ctx: Context) {
    super(ctx, "contract");
  }

  section(): PromptSection {
    return { name: "tool:contract", order: 150, text: "contract" };
  }

  register(ctx: Context): () => void {
    return ctx.effect(() => () => undefined, "contract.effect");
  }
}

/** Schemastery schema shape used by the aggregate config. */
export const contractSchema = z.object({
  command: z.string().default("imo"),
  timeoutMs: z.natural().min(1).default(30_000),
});

export type ContractSchema = ReturnType<typeof contractSchema>;

/** Type-level surfaces consumed by the plugin. */
export type ContractSurfaces = {
  tool: ToolDefinition;
  jobSpec: JobSpec;
  jobView: JobView;
  skill: SkillDefinition;
  sessions: UseSessions;
  chat: ChatNodeDataMap;
  workspaceController: WorkspaceController;
  nativeCommand: NativeCommandRunner;
  storage: Storage;
  primitive: typeof StateDot;
};
