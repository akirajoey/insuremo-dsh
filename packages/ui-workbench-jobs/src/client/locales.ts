/** Copy for the Workbench job conversation node. */
export const zh = {
  "status.queued": "排队中",
  "status.running": "运行中",
  "status.done": "已完成",
  "status.failed": "失败",
} as const satisfies Record<string, string>;

export type WorkbenchJobLocaleKey = keyof typeof zh;

export const en = {
  "status.queued": "Queued",
  "status.running": "Running",
  "status.done": "Done",
  "status.failed": "Failed",
} as const satisfies Record<WorkbenchJobLocaleKey, string>;
