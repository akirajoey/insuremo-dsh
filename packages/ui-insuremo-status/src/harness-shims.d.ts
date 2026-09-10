declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {}

  type ProfileSessionState = { current?: string };
  type ProfileWorkspaceState = {
    items: ReadonlyArray<{ workspaceId: string; path: string; sessionIds: ReadonlyArray<string> }>;
    phase: string;
    /** rc.7 client-runtime field: absent in 0.1.5, where readiness is implied. */
    baselinesReady?: boolean;
  };
  type ProfileSelector<S> = <T>(selector: (state: S) => T) => T;
  type PropsRuntime<K extends string> = K extends "sidebar.footer.action"
    ? { wide: boolean; useSessions: ProfileSelector<ProfileSessionState>; useWorkspaces: ProfileSelector<ProfileWorkspaceState> }
    : { close: () => void };

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
declare module "@deepseek-ai/dsh-client-ui-sidebar/client" {}
declare module "@deepseek-ai/dsh-client-ui-primitives" {
  import type { ReactElement } from "react";
  export function Tooltip(props: {
    label: string | (() => string);
    side?: "right" | "bottom" | "top";
    delayMs?: number;
    disabled?: boolean;
    maxWidth?: number;
    children: ReactElement;
  }): ReactElement;
}
declare module "*.png" {
  const url: string;
  export default url;
}
