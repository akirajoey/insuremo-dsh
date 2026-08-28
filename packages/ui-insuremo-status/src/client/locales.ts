/** Copy for the InsureMO sidebar status + workspace health strip. */
export const zh = {
  label: "InsureMO · 未配置",
  "health.strip": "工作区健康状态",
  "health.iComposerBound": "iComposer · 已关联",
  "health.iComposerPending": "iComposer · 待关联",
  "health.iComposerPendingHint": "已检测 iComposer 项目；本地 ICI 已可用，binding 仅用于远程写操作",
  "health.graphReady": "ICI Graph · 就绪",
  "health.graphNotReady": "ICI Graph · 未就绪",
  "health.explainReady": "ICI Explain · 就绪",
  "health.explainNotReady": "ICI Explain · 未就绪",
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
  "health.iComposerBound": "iComposer · Bound",
  "health.iComposerPending": "iComposer · Pending",
  "health.iComposerPendingHint": "iComposer project detected; local ICI is ready. Binding is only required for remote write operations",
  "health.graphReady": "ICI Graph · Ready",
  "health.graphNotReady": "ICI Graph · Not ready",
  "health.explainReady": "ICI Explain · Ready",
  "health.explainNotReady": "ICI Explain · Not ready",
  "picker.label": "Select Active Profile",
  "picker.close": "Collapse",
  "picker.loading": "Loading…",
  "picker.empty": "No profiles available",
  "picker.error": "Cannot connect",
} as const satisfies Record<InsuremoStatusLocaleKey, string>;
