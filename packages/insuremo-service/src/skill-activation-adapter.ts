import type { Context } from "@deepseek-ai/cordis";
import { isSkillName } from "@deepseek-ai/dsh-skill";
import type { ImoSkillActivation, ImoSkillActivationSnapshot } from "./skill-activation.ts";
import { raceSkillAbort, throwIfSkillAborted } from "./skill-cancellation.ts";

export type SkillActivationInput = ImoSkillActivation | (() => ImoSkillActivation | undefined);

type ActivationItem = { readonly name: string; readonly valid: boolean };

/** Provider-local adapter: activation storage stays outside the catalog provider contract. */
export class SkillActivationGate {
  private readonly resolver: () => ImoSkillActivation | undefined;
  private revision: number | undefined;

  constructor(
    ctx: Context,
    private readonly control: { readonly signal: AbortSignal; invalidate(): void },
    activation?: SkillActivationInput,
  ) {
    this.resolver = activation === undefined
      ? () => ctx.get<ImoSkillActivation>("imoSkillActivation")
      : typeof activation === "function" ? activation : () => activation;
  }

  async ensure(items: readonly ActivationItem[], signal: AbortSignal): Promise<ImoSkillActivationSnapshot | undefined> {
    const activation = this.resolver();
    if (activation === undefined) return undefined;
    const snapshot = await raceSkillAbort(activation.ensureInitialized(eligibleNames(items)), signal);
    this.revision = snapshot.revision;
    return snapshot;
  }

  async snapshot(items: readonly ActivationItem[], signal: AbortSignal): Promise<ImoSkillActivationSnapshot | undefined> {
    const activation = this.resolver();
    if (activation === undefined) return undefined;
    const snapshot = await raceSkillAbort(activation.snapshot(eligibleNames(items)), signal);
    this.revision = snapshot.revision;
    return snapshot;
  }

  async stableList<T>(
    items: readonly ActivationItem[],
    signal: AbortSignal,
    build: (enabledNames: ReadonlySet<string>) => Promise<T>,
    fail: () => T,
  ): Promise<T> {
    let initial = await this.ensure(items, signal);
    if (initial === undefined || !initial.initialized) return fail();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      throwIfSkillAborted(signal);
      const result = await build(new Set(initial.enabled));
      throwIfSkillAborted(signal);
      const final = await this.snapshot(items, signal);
      throwIfSkillAborted(signal);
      if (final === undefined || !final.initialized) return fail();
      if (sameActivation(initial, final)) return result;
      if (attempt === 1) return fail();
      initial = final;
    }
    return fail();
  }

  onChanged(payload: unknown): void {
    if (this.control.signal.aborted) return;
    const revision = activationRevision(payload);
    if (revision === undefined || (this.revision !== undefined && revision <= this.revision)) return;
    this.revision = revision;
    this.control.invalidate();
  }
}

export function sameActivation(
  left: ImoSkillActivationSnapshot,
  right: ImoSkillActivationSnapshot,
): boolean {
  return left.revision === right.revision
    && left.enabled.length === right.enabled.length
    && left.enabled.every((name, index) => name === right.enabled[index]);
}

function eligibleNames(items: readonly ActivationItem[]): string[] {
  return items.filter((item) => item.valid && typeof item.name === "string" && isSkillName(item.name)).map((item) => item.name);
}

function activationRevision(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const revision = (value as { revision?: unknown }).revision;
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined;
}
