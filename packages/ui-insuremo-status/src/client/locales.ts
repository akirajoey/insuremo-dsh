/** Copy for the InsureMO sidebar status + workspace health strip. */
export const zh = {
  label: "InsureMO · 未配置",
  "health.strip": "工作区健康状态",
  "health.iComposerBound": "iComposer 已关联",
  "health.iComposerPending": "iComposer 待关联",
  "health.graphReady": "代码图谱已构建",
  "health.graphNotReady": "代码图谱未构建",
  "health.explainReady": "业务解释已生成",
  "health.explainNotReady": "业务解释未生成",
} as const satisfies Record<string, string>;

export type InsuremoStatusLocaleKey = keyof typeof zh;

export const en = {
  label: "InsureMO · Not configured",
  "health.strip": "Workspace health",
  "health.iComposerBound": "iComposer linked",
  "health.iComposerPending": "iComposer pending link",
  "health.graphReady": "Code graph built",
  "health.graphNotReady": "Code graph not built",
  "health.explainReady": "Business explanation generated",
  "health.explainNotReady": "Business explanation not generated",
} as const satisfies Record<InsuremoStatusLocaleKey, string>;
