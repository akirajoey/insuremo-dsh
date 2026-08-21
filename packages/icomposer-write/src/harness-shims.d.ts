declare module "@deepseek-ai/cordis" {
  export class Service { static readonly init: unique symbol; protected readonly ctx: Context; constructor(ctx: Context, name: string); }
  export class Context {
    subprocess: import("@deepseek-ai/dsh-subprocess").SubprocessRuntime;
    get<T = unknown>(name: string): T | undefined;
    set(name: string, value: unknown): void;
    provide(name: string, value: unknown): () => void;
    effect(execute: () => () => void | Promise<void>, label?: string): () => Promise<void>;
    plugin(plugin: unknown, config?: unknown): { await(): Promise<unknown>; dispose(): Promise<void> };
  }
}
declare module "@deepseek-ai/dsh-subprocess" {
  export interface SubprocessOutputRead { text: string; nextOffset: number; lossy: boolean; spillPath?: string }
  export interface SubprocessOutputReader { readFrom(fromByte: number): SubprocessOutputRead }
  export interface SubprocessOutcome { exitCode: number | null; signal: string | null }
  export interface SubprocessHandle {
    readonly collected: { readonly stdout?: SubprocessOutputReader; readonly stderr?: SubprocessOutputReader };
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
