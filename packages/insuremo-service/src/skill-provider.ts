import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isSkillName } from "@deepseek-ai/dsh-skill";
import type { Context } from "@deepseek-ai/cordis";
import { digest } from "./run.ts";
import {
  isSkillAbortError,
  mergeSkillSignals,
  SkillAbortError,
  raceSkillAbort,
  throwIfSkillAborted,
} from "./skill-cancellation.ts";
import {
  SKILLS_INVENTORY_UPDATED_EVENT,
  type ImoSkillScope,
  type ImoSkills,
} from "./skills.ts";
import { resolveAllowedSkillRoot, resolveSkillPath } from "./skill-path.ts";
import { readFrontmatterPrefix, readSkillDocument } from "./skill-document.ts";

/** IMO entries sit above generic user-agent skills, but below project/custom roots. */
export const INSUREMO_SKILL_RANK = 450;
export const INSUREMO_SKILL_PROVIDER = "insuremo" as const;
export const INSUREMO_SKILL_SOURCE = "insuremo" as const;
/** Host-internal refresh signal for successful store mutations (no raw control exposed). */
export const INSUREMO_SKILL_CATALOG_INVALIDATE_EVENT = "skills/catalog-invalidate" as const;

interface SkillInvocationPolicy {
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
}

interface SkillResourceBase {
  readonly kind: "directory";
  readonly path: string;
}

interface SkillLookupOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

interface SkillCandidate {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly invocation: SkillInvocationPolicy;
  readonly source: string;
  readonly provider: string;
  readonly resourceBase?: SkillResourceBase;
  readonly rank: number;
  readonly locator: unknown;
  readonly path?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface SkillDefinition extends Omit<SkillCandidate, "rank" | "locator"> {
  readonly content: string;
}

interface SkillProviderObservation {
  readonly candidates: readonly SkillCandidate[];
  readonly complete: boolean;
}

interface SkillProvider {
  readonly name: string;
  list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation>;
  get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined>;
}

interface SkillProviderControl {
  readonly signal: AbortSignal;
  invalidate(): void;
}

interface SkillRegistry {
  registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void;
}

interface IssuedLocator {
  readonly directory: string;
  readonly manifestPath: string;
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly invocation: SkillInvocationPolicy;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface InventoryEvent {
  readonly scope?: unknown;
  readonly skills?: unknown;
}

/**
 * Real provider implementation for the Harness `ctx.skills` registry. The
 * structural faces above intentionally mirror `@deepseek-ai/dsh-skill` so this
 * package can typecheck without importing Harness implementation internals;
 * `mountInsuremoSkillProvider()` registers the same provider contract into the
 * real registry at runtime.
 */
export class InsuremoSkillProvider implements SkillProvider {
  readonly name = INSUREMO_SKILL_PROVIDER;
  #control: SkillProviderControl;
  #disposed = false;
  #fingerprint: string | undefined;
  #listenerDispose: (() => void) | undefined;
  readonly #issued = new WeakSet<object>();

  private readonly inventoryResolver: () => ImoSkills | undefined;

  constructor(
    private readonly ctx: Context,
    control: SkillProviderControl,
    inventory: ImoSkills | (() => ImoSkills | undefined),
    private readonly scope: ImoSkillScope = "global",
  ) {
    this.#control = control;
    this.inventoryResolver = typeof inventory === "function" ? inventory : () => inventory;
    const disposeInventoryListener = this.ctx.on(
      SKILLS_INVENTORY_UPDATED_EVENT,
      (payload: unknown) => this.onInventoryUpdated(payload),
    );
    const disposeMutationListener = this.ctx.on(
      INSUREMO_SKILL_CATALOG_INVALIDATE_EVENT,
      (payload: unknown) => this.onCatalogInvalidated(payload),
    );
    this.#listenerDispose = () => {
      disposeInventoryListener();
      disposeMutationListener();
    };
    control.signal.addEventListener("abort", () => {
      this.#disposed = true;
      this.#listenerDispose?.();
      this.#listenerDispose = undefined;
    }, { once: true });
  }

  async list(options: SkillLookupOptions = {}): Promise<readonly SkillCandidate[] | SkillProviderObservation> {
    const cancellation = mergeSkillSignals(options.signal, this.#control.signal);
    try {
      this.throwIfCancelled(cancellation.signal);
      if (this.#disposed) return { candidates: [], complete: false };
      const inventory = this.inventoryResolver();
      if (inventory === undefined) return { candidates: [], complete: false };
      let validation;
      try {
        validation = await raceSkillAbort(
          inventory.validate(this.scope, cancellation.signal),
          cancellation.signal,
        );
      } catch (error) {
        if (isSkillAbortError(error)) throw new SkillAbortError();
        return { candidates: [], complete: false };
      }
      this.throwIfCancelled(cancellation.signal);
      if (this.#disposed || this.#control.signal.aborted) return { candidates: [], complete: false };
      if (!validation.ok) return { candidates: [], complete: false };

      const allowedRootPath = skillRootOf(inventory);
      const allowedRoot = await resolveAllowedSkillRoot(allowedRootPath);
      this.throwIfCancelled(cancellation.signal);
      const candidates: SkillCandidate[] = [];
      let complete = validation.value.inventoryComplete;
      for (const item of validation.value.items) {
        this.throwIfCancelled(cancellation.signal);
        if (!item.valid || !isSkillName(item.name)) {
          complete = false;
          continue;
        }
        const manifest = await resolveManifest(item.path, allowedRootPath, allowedRoot);
        this.throwIfCancelled(cancellation.signal);
        if (manifest === undefined) {
          complete = false;
          continue;
        }
        const frontmatter = await readFrontmatterPrefix(manifest, cancellation.signal);
        this.throwIfCancelled(cancellation.signal);
        if (this.#disposed || this.#control.signal.aborted) return { candidates, complete: false };
        if (frontmatter.invalid) complete = false;
        const description = item.description.trim().length > 0
          ? item.description
          : `InsureMO skill ${item.name}`;
        const invocation = Object.freeze(frontmatter.invocation ?? defaultInvocation());
        const resourceBase = Object.freeze({ kind: "directory" as const, path: item.path });
        const locator: IssuedLocator = Object.freeze({
          directory: item.path,
          manifestPath: manifest,
          name: item.name,
          description,
          ...(frontmatter.whenToUse === undefined ? {} : { whenToUse: frontmatter.whenToUse }),
          invocation,
          ...(frontmatter.metadata === undefined ? {} : { metadata: frontmatter.metadata }),
        });
        this.#issued.add(locator);
        candidates.push(Object.freeze({
          name: item.name,
          description,
          ...(frontmatter.whenToUse === undefined ? {} : { whenToUse: frontmatter.whenToUse }),
          invocation,
          source: INSUREMO_SKILL_SOURCE,
          provider: INSUREMO_SKILL_PROVIDER,
          resourceBase,
          rank: INSUREMO_SKILL_RANK,
          locator,
          path: manifest,
          ...(frontmatter.metadata === undefined ? {} : { metadata: frontmatter.metadata }),
        }));
      }
      return complete ? candidates : { candidates, complete: false };
    } catch (error) {
      if (isSkillAbortError(error)) throw new SkillAbortError();
      return { candidates: [], complete: false };
    } finally {
      cancellation.dispose();
    }
  }

  async get(candidate: SkillCandidate, options: SkillLookupOptions = {}): Promise<SkillDefinition | undefined> {
    if (this.#disposed || this.#control.signal.aborted) return undefined;
    const cancellation = mergeSkillSignals(options.signal, this.#control.signal);
    try {
      return await raceSkillAbort(this.getWithSignal(candidate, cancellation.signal), cancellation.signal);
    } catch {
      return undefined;
    } finally {
      cancellation.dispose();
    }
  }

  private async getWithSignal(candidate: SkillCandidate, signal: AbortSignal): Promise<SkillDefinition | undefined> {
    throwIfSkillAborted(signal);
    const locator = candidate.locator;
    if (!isIssuedLocator(locator) || !this.#issued.has(locator)) return undefined;
    if (!candidateMatchesLocator(candidate, locator)) return undefined;
    const inventory = this.inventoryResolver();
    if (inventory === undefined) return undefined;
    const allowedRootPath = skillRootOf(inventory);
    const allowedRoot = await resolveAllowedSkillRoot(allowedRootPath);
    throwIfSkillAborted(signal);
    if (allowedRoot === null) return undefined;
    const resolved = await resolveSkillPath(locator.manifestPath, allowedRootPath, allowedRoot);
    throwIfSkillAborted(signal);
    if (resolved.canonical === undefined || resolved.canonical !== locator.manifestPath) return undefined;
    try {
      if (!(await stat(resolved.canonical)).isFile()) return undefined;
      throwIfSkillAborted(signal);
    } catch {
      return undefined;
    }
    const parsed = await readSkillDocument(resolved.canonical, signal);
    if (parsed === undefined) return undefined;
    throwIfSkillAborted(signal);
    if (this.#disposed || this.#control.signal.aborted) return undefined;
    return {
      name: candidate.name,
      description: candidate.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      invocation: parsed.invocation ?? defaultInvocation(),
      source: INSUREMO_SKILL_SOURCE,
      provider: INSUREMO_SKILL_PROVIDER,
      resourceBase: { kind: "directory", path: locator.directory },
      path: locator.manifestPath,
      ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
      content: parsed.content,
    };
  }

  private onInventoryUpdated(payload: unknown): void {
    if (this.#disposed || this.#control.signal.aborted) return;
    if (!isInventoryEvent(payload) || payload.scope !== this.scope) return;
    const fingerprint = inventoryFingerprint(payload.skills);
    if (fingerprint === undefined) return;
    if (this.#fingerprint === undefined) {
      this.#fingerprint = fingerprint;
      return;
    }
    if (this.#fingerprint === fingerprint) return;
    this.#fingerprint = fingerprint;
    this.#control.invalidate();
  }

  private onCatalogInvalidated(payload: unknown): void {
    if (this.#disposed || this.#control.signal.aborted) return;
    if (!isInventoryEvent(payload) || payload.scope !== this.scope) return;
    // Explicit mutation invalidation handles same-name/path content changes;
    // the next inventory event establishes a fresh structural baseline.
    this.#fingerprint = undefined;
    this.#control.invalidate();
  }

  private throwIfCancelled(signal?: AbortSignal): void {
    throwIfSkillAborted(signal);
  }
}

/**
 * Register synchronously during plugin apply. The provider resolves the
 * `imoSkills` service lazily in the registry callback's captured instance, so
 * service activation order cannot expose an empty catalog at registration.
 */
/** Emit a bounded host-internal refresh request after a successful store mutation. */
export function invalidateInsuremoSkillCatalog(ctx: Context, scope: ImoSkillScope = "global"): void {
  ctx.emit(INSUREMO_SKILL_CATALOG_INVALIDATE_EVENT, { scope });
}

export function mountInsuremoSkillProvider(
  ctx: Context,
  scope: ImoSkillScope = "global",
): () => void {
  const registry = ctx.get<SkillRegistry>("skills");
  if (registry === undefined || typeof registry.registerProvider !== "function") return () => {};
  return registry.registerProvider((control) => new InsuremoSkillProvider(
    ctx,
    control,
    () => ctx.get<ImoSkills>("imoSkills"),
    scope,
  ));
}

async function resolveManifest(
  directory: string,
  allowedRootPath: string,
  allowedRoot: Awaited<ReturnType<typeof resolveAllowedSkillRoot>>,
): Promise<string | undefined> {
  if (allowedRoot === null) return undefined;
  const resolved = await resolveSkillPath(join(directory, "SKILL.md"), allowedRootPath, allowedRoot);
  if (resolved.canonical === undefined) return undefined;
  try {
    return (await stat(resolved.canonical)).isFile() ? resolved.canonical : undefined;
  } catch {
    return undefined;
  }
}

function skillRootOf(skills: ImoSkills): string {
  return (skills as ImoSkills & { readonly skillsAllowedRoot?: string }).skillsAllowedRoot ?? homedir();
}

function defaultInvocation(): SkillInvocationPolicy {
  return Object.freeze({ modelInvocable: true, userInvocable: true });
}

function isIssuedLocator(value: unknown): value is IssuedLocator {
  return typeof value === "object" && value !== null;
}

function candidateMatchesLocator(candidate: SkillCandidate, locator: IssuedLocator): boolean {
  if (candidate.name !== locator.name || candidate.description !== locator.description) return false;
  if (candidate.source !== INSUREMO_SKILL_SOURCE || candidate.provider !== INSUREMO_SKILL_PROVIDER) return false;
  if (candidate.rank !== INSUREMO_SKILL_RANK || candidate.path !== locator.manifestPath) return false;
  if (candidate.resourceBase?.kind !== "directory" || candidate.resourceBase.path !== locator.directory) return false;
  if (candidate.invocation !== locator.invocation) return false;
  if (candidate.whenToUse !== locator.whenToUse) return false;
  if (candidate.metadata !== locator.metadata) return false;
  return true;
}

function isInventoryEvent(value: unknown): value is InventoryEvent {
  return typeof value === "object" && value !== null;
}

function inventoryFingerprint(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.map((item) => {
    if (typeof item !== "object" || item === null) return null;
    const row = item as Record<string, unknown>;
    return {
      name: typeof row.name === "string" ? row.name : "",
      description: typeof row.description === "string" ? row.description : "",
      path: typeof row.path === "string" ? row.path : "",
    };
  });
  if (rows.some((row) => row === null)) return undefined;
  rows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return digest(JSON.stringify(rows));
}

