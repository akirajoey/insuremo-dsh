/** Public read-only InsureMO Overview view (strict allowlist, never raw host state). */

export type OverviewSectionStatus = "ok" | "warning" | "error";

export interface OverviewSectionBase {
  readonly status: OverviewSectionStatus;
  /** Fixed machine code when the section is not `ok` (no raw error text). */
  readonly code?: string;
}

export interface OverviewImoSection extends OverviewSectionBase {
  readonly available: boolean;
  readonly current?: string;
  readonly target?: string;
  readonly updateAvailable: boolean;
  /** True while an upgrade action is executing (single in-memory lock). */
  readonly busy?: boolean;
}

/** Sanitized auth profile: exactly the browser needs, nothing sensitive. */
export interface OverviewAuthProfile {
  readonly name: string;
  readonly env?: string;
  readonly tenantCode?: string;
  readonly isDefault: boolean;
  readonly valid?: boolean;
}

export interface OverviewAuthSection extends OverviewSectionBase {
  readonly profiles: readonly OverviewAuthProfile[];
  readonly count: number;
  readonly defaultProfile?: string;
  /** Same value as defaultProfile under the UI-facing field name. */
  readonly defaultProfileName?: string;
}

/** Per-skill row for the Settings skills panel (allowlist, ≤100 entries). */
export interface OverviewSkillEntry {
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly sourceDigest?: string;
}

export interface OverviewSkillsSection extends OverviewSectionBase {
  readonly installed: number;
  readonly valid: number;
  readonly enabled: number;
  readonly disabled: number;
  readonly names: readonly string[];
  /** Bounded per-skill rows for the UI panel (≤100, truncated flag). */
  readonly entries: readonly OverviewSkillEntry[];
  readonly entriesTruncated: boolean;
}

export interface OverviewOperationEntry {
  readonly id: string;
  readonly kind: string;
  readonly decision: string;
  readonly recorded: boolean;
  readonly createdAt?: string;
}

export interface OverviewOperationsSection extends OverviewSectionBase {
  readonly pending: number;
  readonly approved: number;
  readonly rejected: number;
  readonly recorded: number;
  /** Latest bounded status rows; never carries params or artifact references. */
  readonly recent: readonly OverviewOperationEntry[];
}

export interface OverviewDiagnostic {
  readonly id: string;
  readonly severity: "info" | "warning" | "error";
  readonly messageKey: string;
}

export interface OverviewDiagnosticsSection extends OverviewSectionBase {
  readonly diagnostics: readonly OverviewDiagnostic[];
}

/** The full read-only overview snapshot returned by `ctx.imoOverview.snapshot`. */
/** Code Intelligence summary (TASK-038): endpoint + adoption counts. */
export interface OverviewIciSection {
  readonly status: "ok" | "warning";
  /** Effective embedding endpoint (config may override the default). */
  readonly embeddingUrl: string;
  /** Workspaces with a graph snapshot. */
  readonly graphWorkspaces: number;
  /** Workspaces with explain output recorded. */
  readonly explainWorkspaces: number;
}

export interface ImoOverviewView {
  readonly schemaVersion: "0";
  readonly generatedAt: string;
  readonly imo: OverviewImoSection;
  readonly auth: OverviewAuthSection;
  readonly skills: OverviewSkillsSection;
  readonly operations: OverviewOperationsSection;
  readonly diagnostics: OverviewDiagnosticsSection;
  readonly ici: OverviewIciSection;
}
