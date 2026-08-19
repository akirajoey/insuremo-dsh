/** Copy for the static InsureMO sidebar status placeholder. */
export const zh = {
  label: "InsureMO · 未配置",
} as const satisfies Record<string, string>;

export type InsuremoStatusLocaleKey = keyof typeof zh;

export const en = {
  label: "InsureMO · Not configured",
} as const satisfies Record<InsuremoStatusLocaleKey, string>;
