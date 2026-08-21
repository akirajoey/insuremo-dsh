declare module "@deepseek-ai/cordis" {
  export class Service { static readonly init: unique symbol; protected readonly ctx: Context; constructor(ctx: Context, name: string); }
  export class Context {
    subprocess: import("@deepseek-ai/dsh-subprocess").SubprocessRuntime;
    readonly jobs: { start(spec: import("@deepseek-ai/dsh-jobs").JobStart): string };
    readonly tools: { register(definition: unknown): () => void };
    readonly systemPrompt: { section(section: { readonly name: string; readonly order: number; readonly text: string }): () => void };
    get<T = unknown>(name: string): T | undefined;
    set(name: string, value: unknown): void;
    provide(name: string, value: unknown): () => void;
    effect(execute: () => () => void | Promise<void>, label?: string): () => Promise<void>;
    plugin(plugin: unknown, config?: unknown): { await(): Promise<unknown>; dispose(): Promise<void> };
  }
}
declare module "@deepseek-ai/dsh-workspace" {
  export interface Workspace { readonly id: string; readonly path: string; readonly title: string; status(): Promise<"ok" | "missing-dir">; }
  export class WorkspaceRegistry { list(): Workspace[]; get(id: string): Workspace | undefined; }
}
declare module "@deepseek-ai/dsh-jobs" {
  export interface JobKindMap {
    bash: "bash";
    subagent: "subagent";
    "ici-build": "ici-build";
    "ici-index": "ici-index";
  }
  export type JobKind = JobKindMap[keyof JobKindMap];
  export interface JobOutcome {
    status: "completed" | "killed" | "failed";
    detail?: string;
    output?: string;
  }
  export interface JobHooks {
    cancel(reason?: string): void;
    done: Promise<JobOutcome>;
    readOutput?(): string;
  }
  export interface JobStart {
    kind: JobKind;
    label: string;
    outputLimitBytes?: number;
    owner?: unknown;
    run(): JobHooks;
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
    readonly output: {
      readonly schema: unknown;
      render?(args: unknown, value: unknown): readonly ToolTextBlock[];
      presentationMeta?(args: unknown, value: unknown): unknown;
    };
    readonly isConcurrencySafe?: (args: unknown) => boolean;
    execute(args: Record<string, unknown>, exec: ToolExecContext): Promise<unknown>;
  }): ToolDefinition;
}
declare module "@deepseek-ai/dsh-subprocess" {
  export interface SubprocessOutputRead {
    text: string;
    nextOffset: number;
    lossy: boolean;
    spillPath?: string;
  }
  export interface SubprocessOutputReader {
    readFrom(fromByte: number): SubprocessOutputRead;
  }
  export interface SubprocessOutcome {
    exitCode: number | null;
    signal: string | null;
  }
  export interface SubprocessHandle {
    readonly collected: {
      readonly stdout?: SubprocessOutputReader;
      readonly stderr?: SubprocessOutputReader;
    };
    readonly done: Promise<{ exitCode: number | null; signal: string | null }>;
  }
  export interface SubprocessRuntime {
    resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
    spawn(spec: {
      argv: readonly string[];
      cwd: string;
      stdio: {
        stdin: "ignore" | "pipe" | { readonly data: string };
        stdout: "pipe" | "inherit" | { maxBytes: number };
        stderr: "pipe" | "inherit" | { maxBytes: number };
      };
      graceMs: number;
      signal?: AbortSignal;
      env?: NodeJS.ProcessEnv;
    }): SubprocessHandle;
  }
}
