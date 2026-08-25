/** Copy for the InsureMO sidebar status + workspace health strip. */
export const zh = {
  label: "InsureMO · 未配置",
  "health.strip": "工作区健康状态",
  "health.iComposerBound": "iComposer 已关联",
  "health.iComposerPending": "iComposer 待关联",
  "health.iComposerPendingHint": "检测到 iComposer 项目，等待绑定（默认 Profile 缺完整 environment ID——在会话中说「绑定工作区 X」即可完成）",
  "health.graphReady": "代码图谱已构建",
  "health.graphNotReady": "代码图谱未构建",
  "health.explainReady": "业务解释已生成",
  "health.explainNotReady": "业务解释未生成",
  "picker.label": "选择 Active Profile",
  "picker.close": "收起",
  "picker.loading": "加载中…",
  "picker.empty": "无可用 Profile",
  "picker.error": "无法连接",
} as const satisfies Record<string, string>;

export type InsuremoStatusLocaleKey = keyof typeof zh;

export const en = {
  label: "InsureMO · Not configured",
  "health.strip": "Workspace health",
  "health.iComposerBound": "iComposer linked",
  "health.iComposerPending": "iComposer pending link",
  "health.iComposerPendingHint": "iComposer project detected, awaiting binding (the default profile lacks a full environment ID — say \"bind workspace X\" in the chat to finish)",
  "health.graphReady": "Code graph built",
  "health.graphNotReady": "Code graph not built",
  "health.explainReady": "Business explanation generated",
  "health.explainNotReady": "Business explanation not generated",
  "picker.label": "Select Active Profile",
  "picker.close": "Collapse",
  "picker.loading": "Loading…",
  "picker.empty": "No profiles available",
  "picker.error": "Cannot connect",
} as const satisfies Record<InsuremoStatusLocaleKey, string>;
