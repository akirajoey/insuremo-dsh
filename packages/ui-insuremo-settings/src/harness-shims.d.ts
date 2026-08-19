declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {}

  type PropsRuntime<K extends string> = {
    close: () => void;
  };

  type PropsLocale<N extends keyof LocaleNamespaceMap & string> = {
    t: (key: LocaleNamespaceMap[N]) => string;
  };
}

declare module "@deepseek-ai/dsh-client-runtime/client" {
  interface ClientContext {
    locale: {
      register(
        namespace: string,
        dictionaries: { zh: Record<string, string>; en: Record<string, string> },
      ): () => void;
      bind(namespace: string): (key: string) => string;
    };
    slots: {
      inject(name: string, callback: () => unknown): unknown;
      register(options: Record<string, unknown>, component: unknown): () => void;
    };
    effect(setup: () => void | (() => void), label?: string): unknown;
  }
}

declare module "@deepseek-ai/dsh-client-locale/client" {}
declare module "@deepseek-ai/dsh-client-ui-settings/client" {}
