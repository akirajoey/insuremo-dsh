declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {}

  type ProfileSessionState = { byId: Readonly<Record<string, { id: string; retainedBy: { mainView?: number } }>> };
  type ProfileWorkspaceState = {
    items: ReadonlyArray<{ workspaceId: string; path: string; sessionIds: ReadonlyArray<string> }>;
    phase: string;
  };
  type ProfileSelector<S> = <T>(selector: (state: S) => T) => T;
  type PropsRuntime<K extends string> = K extends "sidebar.footer.action"
    ? { wide: boolean; useSessions: ProfileSelector<ProfileSessionState>; useWorkspaces: ProfileSelector<ProfileWorkspaceState> }
    : { close: () => void };

  type PropsLocale<N extends keyof LocaleNamespaceMap & string> = {
    t: (key: LocaleNamespaceMap[N]) => string;
  };
}

declare module "@deepseek-ai/cordis" {
  interface Context {
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
  import type { ButtonHTMLAttributes, ReactElement, ReactNode, Ref } from "react";
  export function Tooltip(props: {
    label: string | (() => string);
    side?: "right" | "bottom" | "top";
    delayMs?: number;
    disabled?: boolean;
    maxWidth?: number;
    children: ReactElement;
  }): ReactElement;
  export type ButtonVariant = "primary" | "ghost" | "outline" | "toolbar";
  export function Button(props: {
    variant?: ButtonVariant;
    size?: "md" | "sm";
    icon?: ReactNode;
    className?: string;
    children?: ReactNode;
    ref?: Ref<HTMLButtonElement>;
  } & ButtonHTMLAttributes<HTMLButtonElement>): ReactElement;
  export function MenuSurface(props: {
    compact?: boolean;
    className?: string;
    style?: Record<string, unknown>;
    role?: string;
    tabIndex?: number;
    "aria-label"?: string;
    ref?: Ref<HTMLDivElement>;
    children?: ReactNode;
  } & Record<string, unknown>): ReactElement;
  export function useAnchoredPosition(options: {
    open: boolean;
    anchorRef: { readonly current: HTMLElement | null };
    panelRef: { readonly current: HTMLElement | null };
    side?: "top" | "bottom";
    align?: "start" | "end";
    gap: number;
    margin: number;
  }): Record<string, unknown> | null;
  export function useDismissOnOutsidePointer(
    root: { readonly current: HTMLElement | null },
    open: boolean,
    setOpen: (open: boolean) => void,
    portal?: { readonly current: HTMLElement | null },
  ): void;
}
declare module "*.png" {
  const url: string;
  export default url;
}

declare module "@deepseek-ai/dsh-client-ui-session/client" {}
