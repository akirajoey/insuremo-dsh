import { createHash } from "node:crypto";
import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "./msg-shim.ts";

export const ICI_CONTEXT_PLUGIN = "icomposer-code-intelligence-context" as const;
export const ICI_CONTEXT_SECTION = "icomposer-code-intelligence" as const;
export const ICI_CONTEXT_DIGEST_SECTION = "icomposer-code-intelligence-digest" as const;
export const ICI_CONTEXT_POLICY_VERSION = "3" as const;
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
    console.error("ICI_DEBUG_STEP", input.step, input.agent?.session?.header?.cwd);
    if (decision.kind === "reject" || this.#disposed || input.signal?.aborted === true || input.step !== 1) return decision;
    const cwd = input.agent?.session?.header?.cwd;
    if (typeof cwd !== "string" || cwd.length === 0) return decision;
    const workspace = await this.matchWorkspace(cwd, input.signal).catch(error => { console.error("ICI_DEBUG_MATCH", error); return undefined; });
    console.error("ICI_DEBUG_WS", workspace);
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
  return `This is iComposer workspace ${workspaceId}. It is detected and registered; local graph/catalog/reference operations use its canonical path without requiring an InsureMO binding. Workspace-owned ICI artifacts live under .metadata/icomposer/ici/: graph/current, graph/search/api_embeddings.jsonl, explain/<safe-api>/context.json or deterministic.json, and explain/state.json. Local tools ici_build (graph mode), ici_status, ici_query, ici_explain, icomposer_catalog_list, and icomposer_sdk_query do not require a binding. Embedding index/search and icomposer_verify_utils resolve the Workbench Active Profile explicitly for authentication and fail closed when it is missing or unavailable. Read the returned artifact_path before referring to a persisted artifact; never invent paths. Real tools are: ici_build, ici_status, ici_query, ici_search, ici_explain; supporting read-only tools are icomposer_catalog_list, icomposer_sdk_query, and icomposer_verify_utils. Use the injected workspace_id; never guess one. Read each registered tool schema and description for exact parameters, enums, and output before calling it; those schemas are the source of truth. Do not invent CLI commands. Graph build/index may schedule jobs and write workspace graph/search artifacts; ici_explain also writes workspace-local explain context/state artifacts. ici_status, ici_query, ici_search, catalog, and reference reads do not write. Authentication uses only the Workbench Active Profile and never the CLI default pointer.`;
}
