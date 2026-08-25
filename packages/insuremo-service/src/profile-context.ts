import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "./msg-shim.ts";

/** Provider identity for the independent runtime-context row (TASK-044 B). */
export const PROFILE_CONTEXT_PLUGIN = "icomposer-current-profile";
/** The human-readable snapshot section rendered to the model. */
export const PROFILE_SECTION = "insuremo-active-profile";
/** A NON-DISPLAY metadata section carrying only the profile digest token. */
export const PROFILE_DIGEST_SECTION = "insuremo-profile-digest";
/** Metadata version for the authoritative policy text (Task045 migration). */
export const PROFILE_POLICY_VERSION = "2";
/** Compact checkpoint plugin marker (Harness compaction checkpoint source). */
const COMPACT_PLUGIN = "compact";

export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function profilePolicyText(profile: InsuremoProfile, changed = false): string {
  if (profile.name === null) {
    return `${changed ? "InsureMO authoritative profile changed: none. " : "InsureMO authoritative profile for this session: none. "}Select or log in to a profile first; do not execute remote/auth commands until one is selected.`;
  }
  const env = profile.env === undefined ? "" : ` (env ${profile.env})`;
  const quoted = shellQuote(profile.name);
  return `${changed ? "InsureMO authoritative profile changed: " : "InsureMO authoritative profile for this session: "}${profile.name}${env}. This value overrides cwd workspace/global default resolution. Every remote/auth imo command must pass --profile ${quoted}; never rely on an implicit default. Examples: imo auth prepare --profile ${quoted} --json; imo devops --profile ${quoted} cicd list. If a command or script does not support explicit --profile, stop and report; do not silently fall back to the cwd default.`;
}

/** Per-session current profile fact. */
export interface InsuremoProfile {
  readonly name: string | null;
  readonly env?: string;
  /** Short non-secret identity for stable cross-session comparison. */
  readonly digest: string;
}

export type ProfileResolver = () => Promise<InsuremoProfile | undefined>;

/** The event-handler surface we depend on (harness-shimmed). */
export interface PreStepListeners {
  on(event: "agent/pre-step", listener: (payload: unknown, next: unknown) => Promise<unknown>, options?: { prepend?: boolean }): () => boolean;
}
export interface ProfilePreStepPayload {
  agent: { session: { events: readonly unknown[] } };
  turn: number;
  step: number;
  signal?: { aborted: boolean };
}
export type ProfilePreStepNext = () => Promise<ProfilePreStepDecision>;
export interface ProfilePreStepDecision {
  readonly kind: string;
  readonly messages?: readonly unknown[];
}

/** Resolver reads only the Workbench-owned Active Profile face. */
function defaultResolver(ctx: Context): ProfileResolver {
  return async () => {
    const active = (ctx as unknown as { get(name: string): unknown }).get("imoActiveProfile") as {
      get?: () => Promise<{ ok: boolean; value?: { activeProfileName: string | null; profile?: { env?: string } } }>;
    } | undefined;
    if (active?.get === undefined) return undefined;
    const result = await active.get();
    if (result.ok !== true || result.value === undefined) return undefined;
    const name = result.value.activeProfileName;
    return { name, ...(result.value.profile?.env === undefined ? {} : { env: result.value.profile.env }), digest: shortDigest(name ?? "<none>") };
  };
}

/** Compact 8-hex digest of a profile name — logged/compared, never the raw name. */
export function shortDigest(name: string): string {
  let h = 2166136261;
  for (let i = 0; i < name.length; i += 1) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Extract the profile digest purely from SOURCE METADATA (the dedicated
 * `insuremo-profile-digest` section) — never from prose, never from message
 * content. The content carries only the human-readable sentence.
 */
export function eventPolicyVersion(event: unknown): string | undefined {
  const data = (event as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const source = (data as { source?: { kind?: unknown; plugin?: unknown; policyVersion?: unknown } }).source;
  return source?.kind === "plugin" && source.plugin === PROFILE_CONTEXT_PLUGIN && typeof source.policyVersion === "string"
    ? source.policyVersion : undefined;
}

export function eventDigest(event: unknown): string | undefined {
  const data = (event as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const source = (data as { source?: { kind?: unknown; plugin?: unknown; sections?: readonly { name?: unknown; text?: unknown }[] } }).source;
  if (source?.kind !== "plugin" || source.plugin !== PROFILE_CONTEXT_PLUGIN) return undefined;
  if (!Array.isArray(source.sections)) return undefined;
  for (const section of source.sections) {
    if (section?.name === PROFILE_DIGEST_SECTION && typeof section.text === "string") {
      const match = section.text.match(/d=([0-9a-f]{8})/);
      if (match !== null) return match[1];
    }
  }
  return undefined;
}

/** True when a compact checkpoint landed after the given event index. */
function compactAfter(events: readonly unknown[], fromIndex: number): boolean {
  for (let i = fromIndex; i < events.length; i += 1) {
    const event = events[i] as { type?: unknown; data?: unknown };
    if (event?.type !== "user/message") continue;
    const src = (event.data as { source?: unknown } | undefined)?.source as { kind?: unknown; plugin?: unknown } | undefined;
    if (src?.kind === "plugin" && src.plugin === COMPACT_PLUGIN) return true;
  }
  return false;
}

/** The compact-checkpoint source shape used by the real compaction system. */
export interface CompactCheckpointSource {
  readonly kind: "plugin";
  readonly plugin: typeof COMPACT_PLUGIN;
}
/** Build the exact real compaction checkpoint source (parity with command-compact). */
export function compactCheckpointSource(): CompactCheckpointSource {
  return { kind: "plugin", plugin: COMPACT_PLUGIN };
}

/**
 * Pure lifecycle decision (TASK-044 B): read the durable event log and the
 * current profile, decide whether step-1 should inject an independent profile
 * context message. State is derived per-session from the event log — no
 * process-global. Same-profile ordinary turns dedup; tool steps are guarded by
 * the caller (step===1 only).
 */
export interface ProfilePlan {
  readonly inject: boolean;
  readonly text?: string;
  readonly changed?: boolean;
}
export function decideProfileContext(events: readonly unknown[], profile: InsuremoProfile): ProfilePlan {
  let lastIndex = -1;
  let lastDigest: string | undefined;
  let lastPolicyVersion: string | undefined;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i] as { type?: unknown; data?: { source?: { kind?: unknown; plugin?: unknown } } } | undefined;
    if (ev?.type === "user/message"
      && ev.data?.source?.kind === "plugin"
      && ev.data.source.plugin === PROFILE_CONTEXT_PLUGIN) {
      lastIndex = i;
      lastDigest = eventDigest(events[i]);
      lastPolicyVersion = eventPolicyVersion(events[i]);
      break;
    }
  }
  const currentDigest = profile.digest;
  if (lastIndex === -1) {
    // ① first user input
    return { inject: true, text: profilePolicyText(profile) };
  }
  if (compactAfter(events, lastIndex)) {
    // ② compaction dropped the prior row — re-assert current policy
    return { inject: true, text: profilePolicyText(profile) };
  }
  if (lastPolicyVersion !== PROFILE_POLICY_VERSION) {
    // ③ Task044 events have the same digest but no policy metadata. Upgrade
    // the durable session once without changing the plugin identity.
    return { inject: true, text: profilePolicyText(profile) };
  }
  if (lastDigest !== currentDigest) {
    // ③ profile switched; the new authoritative policy supersedes the old one
    return { inject: true, text: profilePolicyText(profile, true), changed: true };
  }
  return { inject: false };
}

/**
 * Independent per-lifecycle profile runtime-context (TASK-044 B).
 *
 * Replaces the aggregate `systemPrompt.context` with a dedicated
 * `agent/pre-step` plugin message (a separate context row, not spliced into
 * "Current runtime context"). Injects ONLY on step 1 per `decideProfileContext`.
 * The listener is registered in `[Service.init]` (persistent active fiber —
 * NOT the constructor, and NOT a transient `apply()` effect, so it survives
 * the loader sweep window). The disposer is retained and released on teardown.
 */
export class ImoProfileContextService extends Service {
  static inject = ["agents", "imoAuth", "imoActiveProfile"] as const;

  private readonly resolver: ProfileResolver;
  #disposers: (() => void)[] = [];
  #attached = false;

  constructor(ctx: Context, config: { resolveProfile?: ProfileResolver } = {}) {
    super(ctx, "imoProfileContext");
    this.resolver = config.resolveProfile ?? defaultResolver(ctx);
    this.decide = this.decide.bind(this); // proxy-safe (#private access)
    this.disposeProfileContext = this.disposeProfileContext.bind(this); // proxy-safe (#private access)
  }

  protected [Service.init](): void {
    if (this.#attached) return;
    this.#attached = true;
    const ctx = this.ctx as unknown as PreStepListeners;
    const register = ctx.on("agent/pre-step", (payload: unknown, next: unknown) => this.decide(payload, next), { prepend: true });
    this.#disposers.push(register); // () => boolean is assignable to () => void
  }

  /** Trigger points; the registered pre-step listener forwards here. */
  decide(payload: unknown, next: unknown): Promise<ProfilePreStepDecision> {
    const p = payload as ProfilePreStepPayload;
    return (async () => {
      const decision = await (next as ProfilePreStepNext)();
      if (decision.kind === "reject" || p.signal?.aborted === true) return decision;
      // only inject on the first step of a turn
      if (p.step !== 1) return decision;
      const events = p.agent.session.events ?? [];
      const profile = await this.resolver().catch(() => undefined);
      if (profile === undefined) return decision;
      const plan = decideProfileContext(events, profile);
      if (!plan.inject) return decision;
      const text = plan.text ?? "";
      const digestText = `{d=${profile.digest}}`;
      // content carries ONLY the human sentence — the digest rides the
      // dedicated non-display metadata section.
      const message = createUserMessage({
        content: [{ type: "text", text }],
        source: {
          kind: "plugin",
          plugin: PROFILE_CONTEXT_PLUGIN,
          form: "snapshot",
          policyVersion: PROFILE_POLICY_VERSION,
          sections: [
            { name: PROFILE_SECTION, text },
            { name: PROFILE_DIGEST_SECTION, text: digestText },
          ],
        },
      });
      return {
        kind: "enter",
        messages: [...(decision.messages ?? []), message],
      };
    })();
  }

  /** Explicit teardown (tests + service lifecycle): unregister listeners. */
  disposeProfileContext(): void {
    for (const disposer of this.#disposers) { try { disposer(); } catch { /* already detached */ } }
    this.#disposers = [];
    this.#attached = false;
  }
}
