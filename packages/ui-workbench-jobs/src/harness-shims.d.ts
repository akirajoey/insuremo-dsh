declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {}

  type PropsRuntime<K extends string, E extends string = string> = K extends "conversation.chat.node"
    ? { node: { data: unknown } }
    : { close: () => void };

  type PropsLocale<N extends keyof LocaleNamespaceMap & string> = {
    t: (key: LocaleNamespaceMap[N]) => string;
  };
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    sessions: object;
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
declare module "@deepseek-ai/dsh-client-ui-chat/client" {
  interface ChatNodeDataMap {}
}
declare module "@deepseek-ai/dsh-client-ui-primitives" {
  type ReactNode = import("react").ReactNode;
  export type StateDotState = "done" | "warning" | "ongoing" | "error";
  export function StateDot(props: {
    state: StateDotState;
    size?: number;
    className?: string;
  }): ReactNode;
  export function IconApiOutlineRegular(props: {
    size?: number;
    className?: string;
    "aria-hidden"?: string;
  }): ReactNode;
}

declare module "@deepseek-ai/dsh-jobs/view" {
  interface JobView {
    id: string;
    kind: string;
    label: string;
    status: "running" | "stopping" | "completed" | "killed" | "failed";
  }
}
