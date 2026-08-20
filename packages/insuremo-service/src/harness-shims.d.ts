declare module "@deepseek-ai/cordis" {
  export class Service {
    static readonly init: unique symbol;
    protected readonly ctx: Context;
    constructor(ctx: Context, name: string);
  }

  export class Context {
    subprocess: import("@deepseek-ai/dsh-subprocess").SubprocessRuntime;
    storageDomain: import("@deepseek-ai/dsh-storage-domain").DomainFacility;
    operationLog: import("./operation-log-face.ts").OperationLogLike;
    get<T = unknown>(name: string): T | undefined;
    set(name: string, value: unknown): void;
    provide(name: string, value: unknown): () => void;
    on(name: string, listener: (payload: unknown) => void): () => void;
    emit(name: string, payload: unknown): void;
    effect(execute: () => () => void | Promise<void>, label?: string): () => Promise<void>;
    plugin(
      plugin: unknown,
      config?: unknown,
    ): { await(): Promise<unknown>; dispose(): Promise<void> };
  }
}

declare module "@deepseek-ai/schemastery" {
  class z<T = unknown> {
    default(value: T): z<T>;
    min(value: number): z<T>;
    static object<T extends object>(shape: Record<string, unknown>): z<T>;
    static string(): z<string>;
    static natural(): z<number>;
    static array<T = unknown>(item: z<T>): z<readonly T[]>;
  }

  export default z;
}

declare module "@deepseek-ai/dsh-skill" {
  export function isSkillName(name: string): boolean;
}

declare module "@deepseek-ai/dsh-storage-domain" {
  interface DomainGlobalSpec<G> {
    readonly schema: import("zod").ZodType<G>;
    readonly initial: G;
  }
  interface DomainTableSpec<K extends string = string, V = unknown> {
    readonly valueSchema: import("zod").ZodType<V>;
    readonly __key?: K;
  }
  interface DomainSpec {
    readonly name: string;
    readonly version: number;
    readonly global?: DomainGlobalSpec<unknown>;
    readonly tables: Record<string, DomainTableSpec>;
  }
  type TableKeyOf<S extends DomainSpec, N extends keyof S["tables"]> =
    S["tables"][N] extends DomainTableSpec<infer K> ? K : never;
  type TableValueOf<S extends DomainSpec, N extends keyof S["tables"]> =
    S["tables"][N] extends DomainTableSpec<string, infer V> ? V : never;
  type DomainGlobalHandleOf<S extends DomainSpec> =
    S["global"] extends DomainGlobalSpec<infer G> ? DomainGlobal<G> : never;
  interface DomainGlobal<G> { get(): G; set(value: G): Promise<void>; }
  interface KvTable<K extends string, V> {
    get(key: K): V | undefined;
    entries(): IterableIterator<[K, V]>;
    keys(): IterableIterator<K>;
    readonly size: number;
    put(key: K, value: V): Promise<void>;
    delete(key: K): Promise<boolean>;
    update(key: K, fn: (current: V) => V): Promise<V>;
  }
  interface Domain<S extends DomainSpec> {
    readonly name: string;
    readonly global: DomainGlobalHandleOf<S>;
    table<N extends keyof S["tables"] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>;
    close(): Promise<void>;
  }
  interface DomainFacility {
    open<S extends DomainSpec>(spec: S): Promise<Domain<S>>;
  }
  function defineDomain<S extends DomainSpec>(spec: S): S;
  function domainTable<K extends string, V>(schema: import("zod").ZodType<V>): DomainTableSpec<K, V>;
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
