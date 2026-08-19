declare module "@deepseek-ai/cordis" {
  export class Service {
    protected readonly ctx: Context;
    constructor(ctx: Context, name: string);
  }

  export class Context {
    subprocess: import("@deepseek-ai/dsh-subprocess").SubprocessRuntime;
    get<T = unknown>(name: string): T | undefined;
  }
}

declare module "@deepseek-ai/schemastery" {
  class z<T = unknown> {
    default(value: T): z<T>;
    min(value: number): z<T>;
    static object<T extends object>(shape: Record<string, unknown>): z<T>;
    static string(): z<string>;
    static natural(): z<number>;
  }

  export default z;
}

declare module "@deepseek-ai/dsh-subprocess" {
  export interface CollectedOutput {
    text: string;
    truncated: boolean;
    spillPath?: string;
  }

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
    resolveExecutable(
      command: string,
      env?: Readonly<Record<string, string>>,
      signal?: AbortSignal,
    ): Promise<string>;
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
