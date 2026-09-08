/** Narrow client-side overview projection. Only allowlisted fields survive; a
 * server payload carrying a token or path is dropped during projection. */

export interface OverviewProfileView {
  readonly name: string;
  readonly env?: string;
  readonly tenantCode?: string;
  readonly isDefault: boolean;
  readonly isActive?: boolean;
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

export type OverviewSkillContextImpact = "source-unavailable" | "source-may-be-unavailable" | "disabled";

export interface OverviewSkillDiagnosticView {
  readonly code: string;
  readonly skill: string;
  readonly source: string;
  readonly reason: string;
  readonly line?: number;
  readonly contextImpact: OverviewSkillContextImpact;
}

export interface OverviewSkillEntryView {
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly diagnostic?: OverviewSkillDiagnosticView;
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
    readonly busy?: boolean;
  };
  readonly auth: {
    readonly status: string;
    readonly code?: string;
    readonly profiles: readonly OverviewProfileView[];
    readonly count: number;
    readonly defaultProfile?: string;
    readonly activeProfileName?: string | null;
    readonly activeProfileRevision?: number;
    readonly activeProfileStatus?: string;
  };
  readonly skills: {
    readonly status: string;
    readonly code?: string;
    readonly installed: number;
    readonly valid: number;
    readonly enabled: number;
    readonly disabled: number;
    readonly names: readonly string[];
    readonly entries?: readonly OverviewSkillEntryView[];
    readonly activationRevision?: number;
    readonly formatInvalidCount: number;
    readonly pathIssueCount: number;
    readonly diagnosticCount: number;
    readonly diagnostics: readonly OverviewSkillDiagnosticView[];
    readonly diagnosticsTruncated: boolean;
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
  readonly ici?: {
    readonly status: string;
    readonly embeddingUrl: string;
    readonly graphWorkspaces: number;
    readonly explainWorkspaces: number;
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
  const iciRaw = obj(root.ici);
  const ici = iciRaw === null ? undefined : {
    status: str(iciRaw.status, "warning"),
    embeddingUrl: str(iciRaw.embeddingUrl, ""),
    graphWorkspaces: num(iciRaw.graphWorkspaces),
    explainWorkspaces: num(iciRaw.explainWorkspaces),
  };
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
      ...(bool(imo.busy) ? { busy: true } : {}),
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
          ...(bool(p?.isActive) ? { isActive: true } : {}),
          ...optBool("valid", p?.valid),
        };
      }),
      count: num(auth.count),
      ...optStr("defaultProfile", auth.defaultProfile),
      ...(auth.activeProfileName === null ? { activeProfileName: null } : optStr("activeProfileName", auth.activeProfileName)),
      ...(typeof auth.activeProfileRevision === "number" && Number.isFinite(auth.activeProfileRevision) ? { activeProfileRevision: Math.trunc(auth.activeProfileRevision) } : {}),
      ...optStr("activeProfileStatus", auth.activeProfileStatus),
    },
    skills: {
      status: str(skills.status, "error"),
      ...optStr("code", skills.code),
      installed: num(skills.installed),
      valid: num(skills.valid),
      enabled: num(skills.enabled),
      disabled: num(skills.disabled),
      names: arr(skills.names).filter((name): name is string => typeof name === "string").slice(0, 512),
      ...(arr(skills.entries).length > 0 ? { entries: arr(skills.entries).slice(0, 100).map(item => {
        const e = obj(item);
        const diagnostic = parseSkillDiagnostic(e?.diagnostic);
        return {
          name: boundedSkillName(e?.name),
          description: boundedText(e?.description, 200),
          enabled: bool(e?.enabled),
          ...(diagnostic === undefined ? {} : { diagnostic }),
        };
      }).filter(e => e.name.length > 0) } : {}),
      formatInvalidCount: boundedCount(skills.formatInvalidCount),
      pathIssueCount: boundedCount(skills.pathIssueCount),
      diagnosticCount: boundedCount(skills.diagnosticCount),
      diagnostics: arr(skills.diagnostics).slice(0, 100)
        .map(parseSkillDiagnostic)
        .filter((item): item is OverviewSkillDiagnosticView => item !== undefined),
      diagnosticsTruncated: bool(skills.diagnosticsTruncated),
      ...(typeof skills.activationRevision === "number" && Number.isFinite(skills.activationRevision) ? { activationRevision: Math.trunc(skills.activationRevision) } : {}),
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
    ...(ici === undefined ? {} : { ici }),
  };
}

function parseSkillDiagnostic(value: unknown): OverviewSkillDiagnosticView | undefined {
  const diagnostic = obj(value);
  const code = safeDiagnosticToken(diagnostic?.code);
  const skill = boundedSkillName(diagnostic?.skill);
  const source = safeSource(diagnostic?.source);
  const reason = safeDiagnosticToken(diagnostic?.reason);
  const contextImpact = diagnostic?.contextImpact;
  if (code === undefined || skill.length === 0 || source === undefined || reason === undefined
    || (contextImpact !== "source-unavailable" && contextImpact !== "source-may-be-unavailable" && contextImpact !== "disabled")) return undefined;
  const line = safeLine(diagnostic?.line);
  return {
    code,
    skill,
    source,
    reason,
    ...(line === undefined ? {} : { line }),
    contextImpact,
  };
}

function boundedSkillName(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text.length > 0 && text.length <= 128 && !text.includes("/") && !text.includes("\\") ? text : "";
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function safeSource(value: unknown): string | undefined {
  const text = boundedText(value, 32);
  return text.length > 0 && !text.includes("/") && !text.includes("\\") && !text.startsWith("~") ? text : undefined;
}

function safeDiagnosticToken(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 96 || !/^[a-z0-9][a-z0-9-]*$/.test(value)) return undefined;
  return value;
}

function safeLine(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100_000 ? value : undefined;
}

function boundedCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.trunc(value), 1_000_000) : 0;
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
