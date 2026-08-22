/**
 * Merged cordis Context shim for the dist aggregate build: the union of the
 * member sets every Workbench sub-package consumes (verify's tools/jobs/
 * systemPrompt + insuremo-service's webServer/emit/on + intercom/storage).
 */
declare module "@deepseek-ai/cordis" {
  export class Service { static readonly init: unique symbol; protected readonly ctx: Context; constructor(ctx: Context, name: string); }
  export class Context {
    subprocess: import("@deepseek-ai/dsh-subprocess").SubprocessRuntime;
    storageDomain: unknown;
    operationLog: unknown;
    webServer: {
      readonly host: string;
      readonly port: number;
      register(route: {
        readonly kind: "exact" | "prefix";
        readonly path: string;
        handler(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void | Promise<void>;
      }): () => void;
    };
    readonly jobs: { start(spec: unknown): string };
    readonly tools: { register(definition: unknown): () => void };
    readonly systemPrompt: { section(section: { readonly name: string; readonly order: number; readonly text: string }): () => void };
    get<T = unknown>(name: string): T | undefined;
    set(name: string, value: unknown): void;
    provide(name: string, value: unknown): () => void;
    on(name: string, listener: (payload: unknown) => void): () => void;
    emit(name: string, payload: unknown): void;
    effect(execute: () => () => void | Promise<void>, label?: string): () => Promise<void>;
    plugin(plugin: unknown, config?: unknown): { await(): Promise<unknown>; dispose(): Promise<void> };
  }
}

declare module "@deepseek-ai/dsh-client-runtime/client" {
  export interface ClientContext {
    effect(setup: () => unknown, label?: string): unknown;
    locale: { register(ns: string, dict: unknown): unknown; bind(ns: string): (key: string) => string };
    slots: { inject(slot: string, register: () => unknown): void; register(descriptor: unknown, component: unknown): unknown };
    sessions?: unknown;
  }
}

declare module "@deepseek-ai/dsh-workspace" {
  export interface Workspace { readonly id: string; readonly path: string; readonly title: string; status(): Promise<"ok" | "missing-dir">; }
  export class WorkspaceRegistry { list(): Workspace[]; get(id: string): Workspace | undefined; }
}

declare module "@deepseek-ai/dsh-jobs" {
  export interface JobKindMap { bash: "bash"; subagent: "subagent"; "ici-build": "ici-build"; "ici-index": "ici-index" }
  export type JobKind = JobKindMap[keyof JobKindMap];
  export interface JobOutcome { status: "completed" | "killed" | "failed"; detail?: string; output?: string }
  export interface JobHooks { cancel(reason?: string): void; done: Promise<JobOutcome>; readOutput?(): string }
  export interface JobStart { kind: JobKind; label: string; outputLimitBytes?: number; owner?: unknown; run(): JobHooks }
}

declare module "@deepseek-ai/dsh-skill" {
  export interface Skill { readonly name: string; readonly description?: string }
}

declare module "@deepseek-ai/dsh-storage" {
  export class Storage {
    constructor(ctx: unknown);
    readonly backend: { register(name: string, backend: unknown): () => void };
  }
}

declare module "@deepseek-ai/dsh-tools" {
  export interface ToolTextBlock { readonly type: "text"; readonly text: string }
  export interface ToolExecContext { readonly signal: AbortSignal }
  export interface ToolDefinition { readonly name: string }
  export function defineTool(options: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
    readonly output: { readonly schema: unknown; render?(args: unknown, value: unknown): readonly ToolTextBlock[] };
    readonly isConcurrencySafe?: (args: unknown) => boolean;
    execute(args: Record<string, unknown>, exec: ToolExecContext): Promise<unknown>;
  }): ToolDefinition;
}

declare module "@deepseek-ai/schemastery" {
  class z<T = unknown> {
    constructor(value?: T);
  }
  export = z;
}

declare module "@deepseek-ai/dsh-client-ui-primitives" {
  export const StateDot: unknown;
  export const Spinner: unknown;
}
