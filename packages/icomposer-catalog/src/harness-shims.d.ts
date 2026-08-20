declare module "@deepseek-ai/cordis" {
  export class Service { static readonly init: unique symbol; protected readonly ctx: Context; constructor(ctx: Context, name: string); }
  export class Context {
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
