import { isSkillName } from "@deepseek-ai/dsh-skill";
import type { ImoCli } from "../cli.ts";
import type { ImoAuth } from "../auth/types.ts";
import type { ImoSkills } from "../skills.ts";
import type { ImoSkillActivation } from "../skill-activation.ts";
import type { OperationLogLike } from "../operation-log-face.ts";
import type {
  ImoOverviewView,
  OverviewAuthSection,
  OverviewDiagnostic,
  OverviewDiagnosticsSection,
  OverviewImoSection,
  OverviewOperationsSection,
  OverviewSkillsSection,
} from "./types.ts";

const MAX_PROFILES = 100;
const MAX_SKILL_NAMES = 512;
const MAX_RECENT = 20;

export interface OverviewDependencies {
  readonly imoCli: ImoCli;
  readonly imoAuth: ImoAuth;
  readonly imoSkills: ImoSkills;
  readonly imoSkillActivation: ImoSkillActivation;
  readonly operationLog: OperationLogLike;
}

/** Build the read-only allowlist overview; every section is best-effort. */
export async function buildOverview(deps: OverviewDependencies, signal?: AbortSignal): Promise<ImoOverviewView> {
  const imo = await imoSection(deps, signal);
  const auth = await authSection(deps, signal);
  const skills = await skillsSection(deps, signal);
  const operations = operationsSection(deps);
  const diagnostics = diagnosticsSection(imo, auth, skills, operations);
  return Object.freeze({
    schemaVersion: "0",
    generatedAt: new Date().toISOString(),
    imo,
    auth,
    skills,
    operations,
    diagnostics,
  });
}

async function imoSection(deps: OverviewDependencies, signal?: AbortSignal): Promise<OverviewImoSection> {
  let section: OverviewImoSection = Object.freeze({ status: "error", code: "unavailable", available: false, updateAvailable: false });
  try {
    const probe = await deps.imoCli.probe(signal);
    if (!probe.ok) {
      section = Object.freeze({
        status: "error",
        code: probe.error.code === "cancelled" ? "cancelled" : probe.error.code,
        available: false,
        updateAvailable: false,
      });
      return section;
    }
    const version = await deps.imoCli.version(signal);
    const check = await deps.imoCli.upgradeCheck(signal);
    let warning = false;
    let code: string | undefined;
    let target: string | undefined;
    let updateAvailable = false;
    if (check.ok) {
      target = check.value.targetVersion;
      updateAvailable = check.value.updateAvailable;
      if (updateAvailable) warning = true;
    } else if (check.error.code !== "cancelled") {
      code = "check-unavailable";
    }
    section = Object.freeze({
      status: warning ? "warning" : "ok",
      ...(code === undefined ? {} : { code }),
      available: true,
      ...(version.ok && /^\d+\.\d+\.\d+/.test(version.value.currentVersion) ? { current: version.value.currentVersion } : {}),
      ...(target === undefined ? {} : { target }),
      updateAvailable,
    });
  } catch {
    section = Object.freeze({ status: "error", code: "unavailable", available: false, updateAvailable: false });
  }
  return section;
}

async function authSection(deps: OverviewDependencies, signal?: AbortSignal): Promise<OverviewAuthSection> {
  let section: OverviewAuthSection = Object.freeze({ status: "error", code: "unavailable", profiles: [], count: 0 });
  try {
    const list = await deps.imoAuth.listProfiles(signal);
    const def = await deps.imoAuth.defaultProfile(signal);
    if (!list.ok) {
      section = Object.freeze({
        status: "error",
        code: list.error.code === "cancelled" ? "cancelled" : "unavailable",
        profiles: [],
        count: 0,
      });
      return section;
    }
    const profiles = list.value.profiles.slice(0, MAX_PROFILES).map(profile => Object.freeze({
      name: profile.profileName,
      ...(profile.env === undefined ? {} : { env: profile.env }),
      ...(profile.tenantCode === undefined ? {} : { tenantCode: profile.tenantCode }),
      isDefault: profile.isDefault === true,
      ...(profile.valid === undefined ? {} : { valid: profile.valid }),
    }));
    const defaultProfile = def.ok ? (def.value.profileName ?? undefined) : undefined;
    const noDefault = defaultProfile === undefined && profiles.length > 0;
    section = Object.freeze({
      status: noDefault || !def.ok ? "warning" : "ok",
      profiles,
      count: list.value.profiles.length,
      ...(defaultProfile === undefined ? {} : { defaultProfile }),
    });
  } catch {
    section = Object.freeze({ status: "error", code: "unavailable", profiles: [], count: 0 });
  }
  return section;
}

async function skillsSection(deps: OverviewDependencies, signal?: AbortSignal): Promise<OverviewSkillsSection> {
  let section: OverviewSkillsSection = Object.freeze({ status: "error", code: "unavailable", installed: 0, valid: 0, enabled: 0, disabled: 0, names: [] });
  try {
    const list = await deps.imoSkills.list("global", signal);
    if (!list.ok) {
      section = Object.freeze({
        status: "error",
        code: list.error.code === "cancelled" ? "cancelled" : "unavailable",
        installed: 0, valid: 0, enabled: 0, disabled: 0, names: [],
      });
      return section;
    }
    const names = [...new Set(list.value.skills.map(skill => skill.name).filter((name): name is string => isSkillName(name)))].sort((left, right) => left.localeCompare(right));
    const validation = await deps.imoSkills.validate("global", signal);
    const validCount = validation.ok ? validation.value.items.filter(item => item.valid).length : undefined;
    let enabled = 0;
    let disabled = 0;
    let activationCode: string | undefined;
    try {
      const activation = await deps.imoSkillActivation.snapshot(names);
      enabled = activation.enabled.length;
      disabled = activation.disabled.length;
    } catch {
      activationCode = "activation-unavailable";
    }
    const incomplete = validation.ok ? !validation.value.inventoryComplete : true;
    section = Object.freeze({
      status: incomplete && validation.ok ? "warning" : validation.ok ? "ok" : "error",
      ...(activationCode === undefined ? {} : { code: activationCode }),
      installed: names.length,
      valid: validCount ?? names.length,
      enabled,
      disabled,
      names: names.slice(0, MAX_SKILL_NAMES),
    });
  } catch {
    section = Object.freeze({ status: "error", code: "unavailable", installed: 0, valid: 0, enabled: 0, disabled: 0, names: [] });
  }
  return section;
}

function operationsSection(deps: OverviewDependencies): OverviewOperationsSection {
  try {
    const records = deps.operationLog.list();
    let pending = 0;
    let approved = 0;
    let rejected = 0;
    let recorded = 0;
    for (const record of records) {
      if (record.decision === "pending") pending += 1;
      else if (record.decision === "approved") approved += 1;
      else if (record.decision === "rejected") rejected += 1;
      if (record.decision === "approved" && record.resultDigest !== undefined) recorded += 1;
    }
    const recent = [...records]
      .sort((left, right) => String((right as { createdAt?: unknown }).createdAt ?? "").localeCompare(String((left as { createdAt?: unknown }).createdAt ?? "")) || 0)
      .slice(0, MAX_RECENT)
      .map(record => Object.freeze({
        id: record.id,
        kind: record.kind,
        decision: record.decision,
        recorded: record.decision === "approved" && record.resultDigest !== undefined,
        ...(typeof (record as { createdAt?: unknown }).createdAt === "string" ? { createdAt: (record as unknown as { createdAt: string }).createdAt } : {}),
      }));
    return Object.freeze({ status: "ok", pending, approved, rejected, recorded, recent });
  } catch {
    return Object.freeze({ status: "error", code: "unavailable", pending: 0, approved: 0, rejected: 0, recorded: 0, recent: [] });
  }
}

function diagnosticsSection(
  imo: OverviewImoSection,
  auth: OverviewAuthSection,
  skills: OverviewSkillsSection,
  operations: OverviewOperationsSection,
): OverviewDiagnosticsSection {
  const diagnostics: OverviewDiagnostic[] = [];
  if (imo.code === "cancelled" || auth.code === "cancelled" || skills.code === "cancelled") {
    diagnostics.push(Object.freeze({ id: "overview-cancelled", severity: "info", messageKey: "overview.diagnostic.cancelled" }));
  }
  if (!imo.available) diagnostics.push(Object.freeze({ id: "imo-unavailable", severity: "error", messageKey: "overview.diagnostic.imoUnavailable" }));
  if (imo.updateAvailable) diagnostics.push(Object.freeze({ id: "imo-update-available", severity: "warning", messageKey: "overview.diagnostic.imoUpdateAvailable" }));
  if (auth.code === "unavailable") diagnostics.push(Object.freeze({ id: "auth-unavailable", severity: "error", messageKey: "overview.diagnostic.authUnavailable" }));
  if (auth.status === "warning" && auth.defaultProfile === undefined && auth.count > 0) {
    diagnostics.push(Object.freeze({ id: "auth-no-default", severity: "warning", messageKey: "overview.diagnostic.authNoDefault" }));
  }
  if (skills.code === "unavailable") diagnostics.push(Object.freeze({ id: "skills-unavailable", severity: "error", messageKey: "overview.diagnostic.skillsUnavailable" }));
  if (skills.status === "warning") diagnostics.push(Object.freeze({ id: "skills-incomplete", severity: "warning", messageKey: "overview.diagnostic.skillsIncomplete" }));
  if (operations.pending > 0) diagnostics.push(Object.freeze({ id: "operations-pending", severity: "info", messageKey: "overview.diagnostic.operationsPending" }));
  const severity = diagnostics.some(diagnostic => diagnostic.severity === "error")
    ? "error"
    : diagnostics.some(diagnostic => diagnostic.severity === "warning")
      ? "warning"
      : "ok";
  return Object.freeze({ status: severity, diagnostics });
}

