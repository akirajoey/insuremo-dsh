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
}

export interface OverviewSkillsSection extends OverviewSectionBase {
  readonly installed: number;
  readonly valid: number;
  readonly enabled: number;
  readonly disabled: number;
  readonly names: readonly string[];
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
export interface ImoOverviewView {
  readonly schemaVersion: "0";
  readonly generatedAt: string;
  readonly imo: OverviewImoSection;
  readonly auth: OverviewAuthSection;
  readonly skills: OverviewSkillsSection;
  readonly operations: OverviewOperationsSection;
  readonly diagnostics: OverviewDiagnosticsSection;
}
