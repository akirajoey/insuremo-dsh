import type { Context } from "@deepseek-ai/cordis";
import type { ImoSkillActivation, SkillActivationController } from "../skill-activation.ts";
import type { ImoSkills } from "../skills.ts";
import { invalidateInsuremoSkillCatalog } from "../skill-provider.ts";
import { snapshotInventory } from "./diff.ts";
import {
  SKILL_INSTALL_KIND,
  SKILL_REMOVE_KIND,
  type SkillActionKind,
  type SkillInventorySnapshot,
} from "./types.ts";

export interface RecoveryReport {
  readonly after?: SkillInventorySnapshot;
  readonly activationRevision?: number;
  readonly catalogInvalidated: boolean;
}

export const EMPTY_RECOVERY: RecoveryReport = Object.freeze({ catalogInvalidated: false });

/**
 * Best-effort partial-write recovery after an external attempt has begun,
 * regardless of its outcome. Always contained: an after-snapshot, reconcile,
 * or invalidation failure never throws and never reruns the attempt. For
 * install/remove the controller only clears stale names (never enables new
 * ones), so a partially installed skill stays disabled.
 */
export async function recoverInventory(options: {
  readonly ctx: Context;
  readonly skills: ImoSkills;
  readonly controller: SkillActivationController | undefined;
  readonly face: ImoSkillActivation;
  readonly kind: SkillActionKind;
  readonly beforeNames: readonly string[];
  readonly expectedRevision?: number;
}): Promise<RecoveryReport> {
  let after: SkillInventorySnapshot | undefined;
  let activationRevision: number | undefined;
  try {
    const snapshot = await snapshotInventory(options.skills);
    after = snapshot.ok ? snapshot.value : undefined;
  } catch {
    after = undefined;
  }
  if (after !== undefined) {
    try {
      if (options.kind === SKILL_INSTALL_KIND || options.kind === SKILL_REMOVE_KIND) {
        if (options.controller !== undefined) {
          const reconciled = await options.controller.reconcile(after.names, options.expectedRevision);
          activationRevision = reconciled.revision;
        }
      } else {
        const current = await options.face.snapshot(after.names);
        activationRevision = current.revision;
      }
    } catch {
      // Reconcile/snapshot is best-effort; the one-shot receipt still stands.
    }
  }
  let catalogInvalidated = false;
  try {
    invalidateInsuremoSkillCatalog(options.ctx);
    catalogInvalidated = true;
  } catch {
    catalogInvalidated = false;
  }
  return {
    ...(after === undefined ? {} : { after }),
    ...(activationRevision === undefined ? {} : { activationRevision }),
    catalogInvalidated,
  };
}
