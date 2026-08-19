/** Copy for the empty InsureMO Settings section. */
export const zh = {
  nav: "InsureMO",
  title: "InsureMO",
  placeholder: "占位：后续接入 IMO/Skills/认证/工作区",
  status: "状态：尚未配置",
} as const satisfies Record<string, string>;

export type InsuremoLocaleKey = keyof typeof zh;

export const en = {
  nav: "InsureMO",
  title: "InsureMO",
  placeholder: "Placeholder: IMO, Skills, authentication, and workspace will be connected here.",
  status: "Status: not configured",
} as const satisfies Record<InsuremoLocaleKey, string>;
