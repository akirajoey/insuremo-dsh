declare module "@deepseek-ai/dsh-storage-domain" {
  /** Global singleton declaration: schema plus the value before first write. */
  interface DomainGlobalSpec<G> {
    readonly schema: import("zod").ZodType<G>;
    readonly initial: G;
  }

  /** Table declaration with a phantom key type, matching the Harness domain spec. */
  interface DomainTableSpec<K extends string = string, V = unknown> {
    readonly valueSchema: import("zod").ZodType<V>;
    readonly __key?: K;
  }

  /** Static declaration of one domain. */
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

  type GlobalValueOf<S extends DomainSpec> =
    S["global"] extends DomainGlobalSpec<infer G> ? G : never;

  function defineDomain<S extends DomainSpec>(spec: S): S;
  function domainTable<K extends string, V>(schema: import("zod").ZodType<V>): DomainTableSpec<K, V>;

  interface DomainGlobal<G> {
    get(): G;
    set(value: G): Promise<void>;
  }

  interface KvTable<K extends string, V> {
    get(key: K): V | undefined;
    entries(): IterableIterator<[K, V]>;
    keys(): IterableIterator<K>;
    readonly size: number;
    put(key: K, value: V): Promise<void>;
    delete(key: K): Promise<boolean>;
    update(key: K, fn: (current: V) => V): Promise<V>;
  }

  type DomainGlobalHandleOf<S extends DomainSpec> =
    S extends { readonly global: DomainGlobalSpec<infer G> } ? DomainGlobal<G> : never;

  interface Domain<S extends DomainSpec> {
    readonly name: string;
    readonly global: DomainGlobalHandleOf<S>;
    table<N extends keyof S["tables"] & string>(name: N): KvTable<TableKeyOf<S, N>, TableValueOf<S, N>>;
    close(): Promise<void>;
  }

  interface DomainImpl {
    readonly name: string;
    close(): Promise<void>;
  }

  interface DomainFacility {
    open<S extends DomainSpec>(spec: S): Promise<Domain<S>>;
    get(name: string): DomainImpl | undefined;
    closeAll(): Promise<void>;
  }
}
