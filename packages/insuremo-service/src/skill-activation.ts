import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { isSkillName } from "@deepseek-ai/dsh-skill";
import {
  defineDomain,
  domainTable,
  type Domain,
  type KvTable,
} from "@deepseek-ai/dsh-storage-domain";
import { z } from "zod";

export const SKILL_ACTIVATION_DOMAIN_NAME = "workbench_imo_skill_activation" as const;
export const SKILL_ACTIVATION_CHANGED_EVENT = "skills/activation-changed" as const;
const GLOBAL_KEY = "global" as const;
const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER;
const SERVICE_DISPOSED_MESSAGE = "IMO skill activation service is disposed" as const;
const activationControllers = new WeakMap<object, SkillActivationController>();

const activationStateSchema = z.object({
  scope: z.literal("global"),
  initialized: z.literal(true),
  enabledNames: z.array(z.string()),
  revision: z.number().int().nonnegative().max(MAX_SAFE_REVISION),
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((state, refinement) => {
  const names = state.enabledNames;
  if (new Set(names).size !== names.length) {
    refinement.addIssue({ code: "custom", path: ["enabledNames"], message: "enabledNames must be unique" });
  }
  if (names.some((name) => !isSkillName(name))) {
    refinement.addIssue({ code: "custom", path: ["enabledNames"], message: "enabledNames contains an invalid skill name" });
  }
  if (names.some((name, index) => index > 0 && names[index - 1]!.localeCompare(name) > 0)) {
    refinement.addIssue({ code: "custom", path: ["enabledNames"], message: "enabledNames must be sorted" });
  }
});

export type SkillActivationState = z.infer<typeof activationStateSchema>;

export const skillActivationDomain = defineDomain({
  name: SKILL_ACTIVATION_DOMAIN_NAME,
  version: 1,
  tables: { states: domainTable<"global", SkillActivationState>(activationStateSchema) },
});

export interface ImoSkillActivationSnapshot {
  readonly initialized: boolean;
  readonly installed: readonly string[];
  readonly enabled: readonly string[];
  readonly disabled: readonly string[];
  readonly stale: readonly string[];
  readonly revision: number;
}

export interface ImoSkillActivation {
  ensureInitialized(installedNames: readonly string[]): Promise<ImoSkillActivationSnapshot>;
  snapshot(installedNames: readonly string[]): Promise<ImoSkillActivationSnapshot>;
}

/** Internal capability passed by the composition closure to future actions. */
export interface SkillActivationController extends ImoSkillActivation {
  setEnabled(name: string, enabled: boolean, installedNames: readonly string[], expectedRevision?: number): Promise<ImoSkillActivationSnapshot>;
  reconcile(installedNames: readonly string[], expectedRevision?: number): Promise<ImoSkillActivationSnapshot>;
}

export interface SkillActivationServiceOptions {
  readonly onController?: (controller: SkillActivationController) => void;
}

export class SkillActivationError extends Error {
  constructor(
    readonly code: "invalid-input" | "invalid-name" | "not-installed" | "revision-conflict" | "revision-exhausted" | "service-disposed",
    message: string,
    readonly expectedRevision?: number,
    readonly actualRevision?: number,
  ) {
    super(message);
    this.name = "SkillActivationError";
  }
}

interface ActivationChangedPayload {
  readonly revision: number;
  readonly enabledCount: number;
  readonly disabledCount: number;
  readonly staleCount: number;
}

/** Internal lifecycle owner. Its context value is replaced with a frozen read facade in the constructor. */
export function skillActivationControllerFor(face: ImoSkillActivation | undefined): SkillActivationController | undefined {
  return face === undefined || (typeof face !== "object" && typeof face !== "function")
    ? undefined
    : activationControllers.get(face);
}

export class ImoSkillActivationService extends Service {
  static inject = ["storageDomain"];
  #runtime: ActivationRuntime;

  constructor(ctx: Context, options: SkillActivationServiceOptions = {}) {
    super(ctx, "imoSkillActivation");
    const runtime = new ActivationRuntime(ctx, options.onController);
    this.#runtime = runtime;
    const face = Object.freeze({
      ensureInitialized: (installedNames: readonly string[]) => runtime.ensureInitialized(installedNames),
      snapshot: (installedNames: readonly string[]) => runtime.snapshot(installedNames),
    } satisfies ImoSkillActivation);
    runtime.setFace(face);
    ctx.set("imoSkillActivation", face);
    ctx.effect(() => () => runtime.dispose(), "imoSkillActivation.runtime");
    const ownerFiber = (ctx as unknown as { readonly fiber: unknown }).fiber;
    ctx.on("internal/plugin", (fiber) => {
      if (fiber === ownerFiber) void runtime.dispose().catch(() => undefined);
    });
  }

  protected async [Service.init](): Promise<void> {
    await this.#runtime.init();
  }
}

class ActivationRuntime {
  #domain: Domain<typeof skillActivationDomain> | undefined;
  #openedDomain: Domain<typeof skillActivationDomain> | undefined;
  #domainClose: Promise<void> | undefined;
  #opening: Promise<Domain<typeof skillActivationDomain>> | undefined;
  #store: ActivationStore | undefined;
  #ready: Promise<void>;
  #resolveReady!: () => void;
  #rejectReady!: (reason: unknown) => void;
  #readySettled = false;
  #disposed = false;
  #disposePromise: Promise<void> | undefined;
  #face: ImoSkillActivation | undefined;

  constructor(
    private readonly ctx: Context,
    private readonly onController?: (controller: SkillActivationController) => void,
  ) {
    this.#ready = new Promise<void>((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    this.#ready.catch(() => undefined);
  }

  setFace(face: ImoSkillActivation): void {
    this.#face = face;
  }

  async init(): Promise<void> {
    this.assertOpen();
    let resolveOpening!: (domain: Domain<typeof skillActivationDomain>) => void;
    let rejectOpening!: (reason: unknown) => void;
    const opening = new Promise<Domain<typeof skillActivationDomain>>((resolve, reject) => {
      resolveOpening = resolve;
      rejectOpening = reject;
    });
    this.#opening = opening;
    try {
      Promise.resolve(this.ctx.storageDomain.open(skillActivationDomain)).then(
        (domain) => {
          this.#openedDomain = domain;
          resolveOpening(domain);
        },
        rejectOpening,
      );
    } catch (error) {
      rejectOpening(error);
    }
    try {
      const domain = await opening;
      this.assertOpen();
      const store = new ActivationStore(this.ctx, domain.table("states"), () => this.assertOpen());
      this.#domain = domain;
      this.#store = store;
      if (this.#face !== undefined) activationControllers.set(this.#face, store);
      this.onController?.(store);
      this.assertOpen();
      this.resolveReady();
    } catch (error) {
      if (this.#disposed) {
        this.resolveReady();
        throw serviceDisposedError();
      }
      this.rejectReady(error);
      throw error;
    }
  }

  async ensureInitialized(installedNames: readonly string[]): Promise<ImoSkillActivationSnapshot> {
    this.assertOpen();
    const installed = checkedInstalledNames(installedNames);
    if (installed === undefined) throw invalidInputError();
    await this.waitReady();
    this.assertOpen();
    return this.requireStore().ensureInitialized(installed);
  }

  async snapshot(installedNames: readonly string[]): Promise<ImoSkillActivationSnapshot> {
    this.assertOpen();
    const installed = checkedInstalledNames(installedNames);
    if (installed === undefined) throw invalidInputError();
    await this.waitReady();
    this.assertOpen();
    return this.requireStore().snapshot(installed);
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    this.#disposed = true;
    if (this.#face !== undefined) activationControllers.delete(this.#face);
    this.resolveReady();
    this.#disposePromise = this.finishDispose();
    return this.#disposePromise;
  }

  private async finishDispose(): Promise<void> {
    await this.#opening?.then(() => undefined, () => undefined);
    await this.#store?.drain();
    await this.closeDomain();
  }

  private async waitReady(): Promise<void> {
    try {
      await this.#ready;
    } catch (error) {
      if (this.#disposed) throw serviceDisposedError();
      throw error;
    }
  }

  private resolveReady(): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#resolveReady();
  }

  private rejectReady(error: unknown): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#rejectReady(error);
  }

  private async closeDomain(): Promise<void> {
    const domain = this.#openedDomain;
    if (domain === undefined) return;
    this.#domainClose ??= Promise.resolve().then(() => domain.close());
    await this.#domainClose;
  }

  private assertOpen(): void {
    if (this.#disposed) throw serviceDisposedError();
  }

  private requireStore(): ActivationStore {
    if (this.#store === undefined || this.#domain === undefined) throw new Error("imo skill activation storage is unavailable");
    return this.#store;
  }
}

class ActivationStore implements SkillActivationController {
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly ctx: Context,
    private readonly table: KvTable<"global", SkillActivationState>,
    private readonly assertActive: () => void,
  ) {}

  async ensureInitialized(installedNames: readonly string[]): Promise<ImoSkillActivationSnapshot> {
    this.assertActive();
    const installed = checkedInstalledNames(installedNames);
    if (installed === undefined) return Promise.reject(invalidInputError());
    return this.enqueue(async () => {
      const current = this.table.get(GLOBAL_KEY);
      if (current === undefined) {
        const initial = makeState(installed, 0);
        await this.table.put(GLOBAL_KEY, initial);
        return snapshotFromState(initial, installed);
      }
      return snapshotFromState(current, installed);
    });
  }

  async snapshot(installedNames: readonly string[]): Promise<ImoSkillActivationSnapshot> {
    this.assertActive();
    const installed = checkedInstalledNames(installedNames);
    if (installed === undefined) return Promise.reject(invalidInputError());
    return this.enqueue(async () => {
      const current = this.table.get(GLOBAL_KEY);
      return current === undefined ? emptySnapshot(installed) : snapshotFromState(current, installed);
    });
  }

  async setEnabled(name: string, enabled: boolean, installedNames: readonly string[], expectedRevision?: number): Promise<ImoSkillActivationSnapshot> {
    this.assertActive();
    if (typeof enabled !== "boolean") return Promise.reject(invalidInputError());
    if (typeof name !== "string") return Promise.reject(invalidInputError());
    if (!validSkillName(name)) return Promise.reject(new SkillActivationError("invalid-name", "skill activation name is invalid"));
    const installed = checkedInstalledNames(installedNames);
    if (installed === undefined || !validExpectedRevision(expectedRevision)) return Promise.reject(invalidInputError());
    if (!installed.includes(name)) return Promise.reject(new SkillActivationError("not-installed", "skill activation name is not installed"));
    return this.enqueue(async () => {
      const current = await this.ensureState(installed, expectedRevision);
      assertRevision(current.revision, expectedRevision);
      const names = new Set(current.enabledNames);
      if (enabled) names.add(name);
      else names.delete(name);
      const nextNames = sortedNames(names);
      if (sameNames(nextNames, current.enabledNames)) return snapshotFromState(current, installed);
      const next = makeState(nextNames, nextRevision(current.revision));
      await this.table.put(GLOBAL_KEY, next);
      this.emitChanged(next, installed);
      return snapshotFromState(next, installed);
    });
  }

  async reconcile(installedNames: readonly string[], expectedRevision?: number): Promise<ImoSkillActivationSnapshot> {
    this.assertActive();
    const installed = checkedInstalledNames(installedNames);
    if (installed === undefined || !validExpectedRevision(expectedRevision)) return Promise.reject(invalidInputError());
    return this.enqueue(async () => {
      const current = await this.ensureState(installed, expectedRevision);
      assertRevision(current.revision, expectedRevision);
      const installedSet = new Set(installed);
      const nextNames = current.enabledNames.filter((name) => installedSet.has(name));
      if (sameNames(nextNames, current.enabledNames)) return snapshotFromState(current, installed);
      const next = makeState(nextNames, nextRevision(current.revision));
      await this.table.put(GLOBAL_KEY, next);
      this.emitChanged(next, installed);
      return snapshotFromState(next, installed);
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.assertActive();
    const result = this.#tail.then(() => {
      this.assertActive();
      return operation();
    });
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async drain(): Promise<void> {
    await this.#tail;
  }

  private async ensureState(installed: readonly string[], expectedRevision?: number): Promise<SkillActivationState> {
    const current = this.table.get(GLOBAL_KEY);
    if (current !== undefined) return current;
    assertRevision(0, expectedRevision);
    const initial = makeState(installed, 0);
    await this.table.put(GLOBAL_KEY, initial);
    return initial;
  }

  private emitChanged(state: SkillActivationState, installed: readonly string[]): void {
    const snapshot = snapshotFromState(state, installed);
    const payload: ActivationChangedPayload = {
      revision: snapshot.revision,
      enabledCount: snapshot.enabled.length,
      disabledCount: snapshot.disabled.length,
      staleCount: snapshot.stale.length,
    };
    this.ctx.emit(SKILL_ACTIVATION_CHANGED_EVENT, payload);
  }
}

function serviceDisposedError(): SkillActivationError {
  return new SkillActivationError("service-disposed", SERVICE_DISPOSED_MESSAGE);
}

function invalidInputError(): SkillActivationError {
  return new SkillActivationError("invalid-input", "skill activation input is invalid");
}

function checkedInstalledNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every(validSkillName)) return undefined;
  return sortedNames(value);
}

function validExpectedRevision(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function assertRevision(actual: number, expected?: number): void {
  if (expected !== undefined && expected !== actual) {
    throw new SkillActivationError("revision-conflict", "skill activation revision does not match the requested revision", expected, actual);
  }
}

function nextRevision(current: number): number {
  if (current >= MAX_SAFE_REVISION) throw new SkillActivationError("revision-exhausted", "skill activation revision is exhausted");
  return current + 1;
}

function validSkillName(value: unknown): value is string {
  return typeof value === "string" && isSkillName(value);
}

function sortedNames(names: Iterable<string>): string[] {
  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function makeState(enabledNames: readonly string[], revision: number): SkillActivationState {
  return {
    scope: "global",
    initialized: true,
    enabledNames: [...enabledNames].sort((left, right) => left.localeCompare(right)),
    revision,
    updatedAt: new Date().toISOString(),
  };
}

function emptySnapshot(installed: readonly string[]): ImoSkillActivationSnapshot {
  return Object.freeze({
    initialized: false,
    installed: Object.freeze([...installed]),
    enabled: Object.freeze([]),
    disabled: Object.freeze([...installed]),
    stale: Object.freeze([]),
    revision: 0,
  });
}

function snapshotFromState(state: SkillActivationState, installed: readonly string[]): ImoSkillActivationSnapshot {
  const installedSet = new Set(installed);
  const enabled = state.enabledNames.filter((name) => installedSet.has(name));
  const stale = state.enabledNames.filter((name) => !installedSet.has(name));
  const enabledSet = new Set(enabled);
  const disabled = installed.filter((name) => !enabledSet.has(name));
  return Object.freeze({
    initialized: state.initialized,
    installed: Object.freeze([...installed]),
    enabled: Object.freeze(enabled),
    disabled: Object.freeze(disabled),
    stale: Object.freeze(stale),
    revision: state.revision,
  });
}
