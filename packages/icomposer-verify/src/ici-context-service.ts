import { createHash } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "./msg-shim.ts";

export const ICI_CONTEXT_PLUGIN = "icomposer-code-intelligence-context" as const;
export const ICI_CONTEXT_SECTION = "icomposer-code-intelligence" as const;
export const ICI_CONTEXT_DIGEST_SECTION = "icomposer-code-intelligence-digest" as const;
export const ICI_CONTEXT_POLICY_VERSION = "5" as const;
const COMPACT_PLUGIN = "compact";

interface BindingEntry {
  readonly workspaceId: string;
  readonly canonicalPath: string;
  readonly detectedIcomposer?: boolean;
  readonly binding?: unknown | null;
}
interface WorkspaceBindingLike {
  list(signal?: AbortSignal): Promise<{ ok: boolean; value?: readonly BindingEntry[] }>;
}
interface AgentLike {
  readonly session?: { readonly header?: { readonly cwd?: string }; readonly events?: readonly unknown[] };
}
interface PreStepPayload { readonly agent?: AgentLike; readonly step?: number; readonly signal?: AbortSignal }
interface Decision { readonly kind: string; readonly messages?: readonly unknown[] }

type ContextState = "bound" | "detected-pending";

/** Independent, durable session context for real iComposer Code Intelligence. */
export class IciContextService extends Service {
  static inject = ["agents", "workspaceBinding"] as const;
  #off: (() => boolean) | undefined;
  #disposed = false;

  constructor(ctx: Context) {
    super(ctx, "iciContext" as never);
    this.decide = this.decide.bind(this);
    this.#off = undefined;
  }

  protected [Service.init](): void {
    if (this.#off !== undefined) return;
    const on = (this.ctx as unknown as {
      on(event: "agent/pre-step", listener: (payload: unknown, next: unknown) => Promise<unknown>, options?: { prepend?: boolean }): () => boolean;
    }).on;
    this.#off = on.call(this.ctx, "agent/pre-step", (payload: unknown, next: unknown) => this.decide(payload, next as unknown as () => Promise<Decision>) as unknown as Promise<unknown>, { prepend: true });
    this.ctx.effect(() => () => {
      this.#disposed = true;
      this.#off?.();
      this.#off = undefined;
    }, "iciContext.dispose");
  }

  async decide(payload: unknown, next: () => Promise<Decision>): Promise<Decision> {
    const decision = await (next as unknown as () => Promise<Decision>)();
    const input = payload as PreStepPayload;
    if (decision.kind === "reject" || this.#disposed || input.signal?.aborted === true || input.step !== 1) return decision;
    const cwd = input.agent?.session?.header?.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) return decision;
    const workspace = await this.matchWorkspace(cwd, input.signal).catch(() => undefined);
    if (this.#disposed || input.signal?.aborted || workspace === undefined || !isSafeWorkspaceId(workspace.workspaceId)) return decision;
    const state: ContextState = workspace.binding !== null && workspace.binding !== undefined ? "bound" : "detected-pending";
    const digest = contextDigest(workspace.workspaceId, state, workspace.detectedIcomposer === true, ICI_CONTEXT_POLICY_VERSION);
    const events = input.agent?.session?.events ?? [];
    if (!shouldInject(events, digest)) return decision;
    const text = renderContext(workspace.workspaceId, state);
    const message = createUserMessage({
      content: [{ type: "text", text }],
      source: {
        kind: "plugin",
        plugin: ICI_CONTEXT_PLUGIN,
        form: "snapshot",
        policyVersion: ICI_CONTEXT_POLICY_VERSION,
        workspaceId: workspace.workspaceId,
        state,
        digest,
        sections: [
          { name: ICI_CONTEXT_SECTION, text },
          { name: ICI_CONTEXT_DIGEST_SECTION, text: `{d=${digest}}` },
        ],
      },
    });
    return { kind: "enter", messages: [...(decision.messages ?? []), message] };
  }

  private async matchWorkspace(cwd: string, signal?: AbortSignal): Promise<BindingEntry | undefined> {
    if (signal?.aborted || this.#disposed) return undefined;
    const binding = this.ctx.get("workspaceBinding" as never) as unknown as WorkspaceBindingLike | undefined;
    if (binding === undefined) return undefined;
    const result = await binding.list(signal);
    if (signal?.aborted || this.#disposed || !result.ok || result.value === undefined) return undefined;
    return result.value.find(entry => entry.canonicalPath === cwd && (entry.detectedIcomposer === true || (entry.binding !== null && entry.binding !== undefined)));
  }
}

function isSafeWorkspaceId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function contextDigest(workspaceId: string, state: ContextState, detected: boolean, policyVersion: string): string {
  return createHash("sha256").update(`${policyVersion}|${workspaceId}|${state}|${detected ? "1" : "0"}`).digest("hex").slice(0, 16);
}

function shouldInject(events: readonly unknown[], digest: string, policyVersion = ICI_CONTEXT_POLICY_VERSION): boolean {
  let last = -1;
  let previous: string | undefined;
  let previousVersion: string | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const source = ((events[i] as { type?: unknown; data?: { source?: unknown } }).data?.source) as { kind?: unknown; plugin?: unknown; policyVersion?: unknown; sections?: readonly { name?: unknown; text?: unknown }[] } | undefined;
    if ((events[i] as { type?: unknown }).type !== "user/message" || source?.kind !== "plugin" || source.plugin !== ICI_CONTEXT_PLUGIN) continue;
    last = i;
    previousVersion = typeof source.policyVersion === "string" ? source.policyVersion : undefined;
    const digestText = source.sections?.find(section => section.name === ICI_CONTEXT_DIGEST_SECTION)?.text;
    previous = typeof digestText === "string" ? digestText.match(/d=([0-9a-f]{16})/)?.[1] : undefined;
    break;
  }
  if (last < 0 || previousVersion !== policyVersion || previous !== digest) return true;
  for (let i = last + 1; i < events.length; i += 1) {
    const source = ((events[i] as { data?: { source?: unknown } }).data?.source) as { kind?: unknown; plugin?: unknown } | undefined;
    if ((events[i] as { type?: unknown }).type === "user/message" && source?.kind === "plugin" && source.plugin === COMPACT_PLUGIN) return true;
  }
  return false;
}

function renderContext(workspaceId: string, _state: ContextState): string {
  return `[iComposer workspace]
workspace_id: ${workspaceId}
tools:
  graph: [ici_build, ici_status]
  inspect: [ici_query, ici_search]
  explain: [ici_explain]
  assets: [icomposer_catalog_list]
  sdk: [icomposer_sdk_query]
  verify: [icomposer_verify_utils]
auth:
  none: graph, query, explain, assets, sdk, non-semantic search
  active_profile: semantic embedding/search, verify
rules:
- Use workspace_id exactly; tool schemas are authoritative.
- If the graph is stale, run ici_build before ici_explain.
- ici_explain only prepares work. In the current DSH card, model is required; reference and earliest start are optional.
- Use only artifact paths returned by tools.
- active_profile ops: Workbench Active Profile; never CLI defaults.`;
}
