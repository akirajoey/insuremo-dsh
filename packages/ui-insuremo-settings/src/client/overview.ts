/** Narrow client-side overview projection. Only allowlisted fields survive; a
 * server payload carrying a token or path is dropped during projection. */

export interface OverviewProfileView {
  readonly name: string;
  readonly env?: string;
  readonly tenantCode?: string;
  readonly isDefault: boolean;
  readonly valid?: boolean;
}

export interface OverviewOperationView {
  readonly id: string;
  readonly kind: string;
  readonly decision: string;
  readonly recorded: boolean;
  readonly createdAt?: string;
}

export interface OverviewDiagnosticView {
  readonly id: string;
  readonly severity: string;
  readonly messageKey: string;
}

export interface ImoOverviewView {
  readonly schemaVersion: string;
  readonly generatedAt: string;
  readonly imo: {
    readonly status: string;
    readonly code?: string;
    readonly available: boolean;
    readonly current?: string;
    readonly target?: string;
    readonly updateAvailable: boolean;
  };
  readonly auth: {
    readonly status: string;
    readonly code?: string;
    readonly profiles: readonly OverviewProfileView[];
    readonly count: number;
    readonly defaultProfile?: string;
  };
  readonly skills: {
    readonly status: string;
    readonly code?: string;
    readonly installed: number;
    readonly valid: number;
    readonly enabled: number;
    readonly disabled: number;
    readonly names: readonly string[];
  };
  readonly operations: {
    readonly status: string;
    readonly code?: string;
    readonly pending: number;
    readonly approved: number;
    readonly rejected: number;
    readonly recorded: number;
    readonly recent: readonly OverviewOperationView[];
  };
  readonly diagnostics: {
    readonly status: string;
    readonly diagnostics: readonly OverviewDiagnosticView[];
  };
}

export const OVERVIEW_URL = "/api/icomposer-workbench/insuremo/overview" as const;

/** Rebuild a fresh view from only the allowlisted fields; `null` on garbage. */
export function parseOverview(value: unknown): ImoOverviewView | null {
  const root = obj(value);
  if (root === null) return null;
  const imo = obj(root.imo);
  const auth = obj(root.auth);
  const skills = obj(root.skills);
  const operations = obj(root.operations);
  const diagnostics = obj(root.diagnostics);
  if (imo === null || auth === null || skills === null || operations === null || diagnostics === null) return null;
  return {
    schemaVersion: str(root.schemaVersion, "0"),
    generatedAt: str(root.generatedAt, ""),
    imo: {
      status: str(imo.status, "error"),
      ...optStr("code", imo.code),
      available: bool(imo.available),
      ...optStr("current", imo.current),
      ...optStr("target", imo.target),
      updateAvailable: bool(imo.updateAvailable),
    },
    auth: {
      status: str(auth.status, "error"),
      ...optStr("code", auth.code),
      profiles: arr(auth.profiles).slice(0, 100).map(profile => {
        const p = obj(profile);
        return {
          name: str(p?.name, ""),
          ...optStr("env", p?.env),
          ...optStr("tenantCode", p?.tenantCode),
          isDefault: bool(p?.isDefault),
          ...optBool("valid", p?.valid),
        };
      }),
      count: num(auth.count),
      ...optStr("defaultProfile", auth.defaultProfile),
    },
    skills: {
      status: str(skills.status, "error"),
      ...optStr("code", skills.code),
      installed: num(skills.installed),
      valid: num(skills.valid),
      enabled: num(skills.enabled),
      disabled: num(skills.disabled),
      names: arr(skills.names).filter((name): name is string => typeof name === "string").slice(0, 512),
    },
    operations: {
      status: str(operations.status, "error"),
      ...optStr("code", operations.code),
      pending: num(operations.pending),
      approved: num(operations.approved),
      rejected: num(operations.rejected),
      recorded: num(operations.recorded),
      recent: arr(operations.recent).slice(0, 20).map(entry => {
        const e = obj(entry);
        return {
          id: str(e?.id, ""),
          kind: str(e?.kind, ""),
          decision: str(e?.decision, ""),
          recorded: bool(e?.recorded),
          ...optStr("createdAt", e?.createdAt),
        };
      }),
    },
    diagnostics: {
      status: str(diagnostics.status, "error"),
      diagnostics: arr(diagnostics.diagnostics).slice(0, 50).map(item => {
        const d = obj(item);
        return { id: str(d?.id, ""), severity: str(d?.severity, "info"), messageKey: str(d?.messageKey, "") };
      }),
    },
  };
}

function obj(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function bool(value: unknown): boolean {
  return typeof value === "boolean" && value;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optStr(key: string, value: unknown): Record<string, string> {
  return typeof value === "string" ? { [key]: value } : {};
}

function optBool(key: string, value: unknown): Record<string, boolean> {
  return typeof value === "boolean" ? { [key]: value } : {};
}
