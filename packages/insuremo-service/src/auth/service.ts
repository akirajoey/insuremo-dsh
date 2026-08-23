import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { Config, resolveConfig, type Config as ImoConfig } from "../config.ts";
import { runCapture, type RunFailure } from "../run.ts";
import { AuthLease, type AuthCacheEntry } from "./lease.ts";
import {
  authStatusFromText,
  isRecord,
  parseDefaultProfile,
  profileView,
  rawBoolean,
  rawString,
  safeAuthString,
  safeEndpoint,
  safeReason,
  safeStatus,
  safeTenantDomain,
} from "./sanitize.ts";
import {
  AUTH_CACHE_INVALIDATED_EVENT,
  AUTH_LEASE_REVOKED_CODE,
  AUTH_PREPARE_INVALIDATED_CODE,
  AUTH_SERVICE_DISPOSED_CODE,
  type ImoAuth,
  type ImoAuthCacheStatus,
  type ImoAuthDefaultProfile,
  type ImoAuthError,
  type ImoAuthInvalidation,
  type ImoAuthInvalidateRequest,
  type ImoAuthLease,
  type ImoAuthPrepareRequest,
  type ImoAuthProfileList,
  type ImoAuthProfilesFast,
  type ImoAuthProfileView,
  type ImoAuthResult,
  type ImoAuthSecret,
  type ImoAuthValidation,
} from "./types.ts";
import { LIST_CACHE_TTL_MS, readProfileStore, authCancelled } from "./profile-store.ts";

interface PendingAuthPrepare {
  readonly profile: string | null;
  readonly env: string | null;
  readonly epoch: number;
  readonly generation: number;
  invalidated: boolean;
  promise: Promise<ImoAuthResult<AuthCacheEntry>>;
}

function authParseError(command: string, phase: string, stdoutDigest: string, stderrDigest: string): ImoAuthResult<never> {
  return {
    ok: false,
    error: {
      code: "parse-error",
      message: `IMO auth ${phase} output could not be parsed`,
      command,
      stdoutDigest,
      stderrDigest,
    },
  };
}

function authRunError(
  error: RunFailure,
  command: string,
  phase: string,
  classifyStatus = false,
): ImoAuthError {
  const status = classifyStatus
    ? error.httpStatus === 401
      ? "invalid-auth"
      : error.httpStatus === 403
        ? "forbidden"
        : undefined
    : undefined;
  const code = status ?? error.code;
  return {
    code,
    message: `IMO auth ${phase} failed: ${code}`,
    command,
    ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
    ...(error.signal === undefined ? {} : { signal: error.signal }),
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(error.stdoutDigest === undefined ? {} : { stdoutDigest: error.stdoutDigest }),
    ...(error.stderrDigest === undefined ? {} : { stderrDigest: error.stderrDigest }),
  };
}

function authStatusError(
  code: "invalid-auth" | "forbidden",
  command: string,
  phase: string,
  stdoutDigest: string,
  stderrDigest: string,
): ImoAuthResult<never> {
  return {
    ok: false,
    error: {
      code,
      message: `IMO auth ${phase} failed: ${code}`,
      command,
      httpStatus: code === "invalid-auth" ? 401 : 403,
      stdoutDigest,
      stderrDigest,
    },
  };
}

function authLifecycleError(
  code: typeof AUTH_PREPARE_INVALIDATED_CODE | typeof AUTH_SERVICE_DISPOSED_CODE,
  command: string,
): ImoAuthResult<never> {
  return {
    ok: false,
    error: { code, message: `IMO auth prepare failed: ${code}`, command },
  };
}

function authCacheKey(profile: string | null, env: string | null): string {
  return JSON.stringify([profile, env]);
}

function authCacheMatches(
  entry: { readonly profile: string | null; readonly env: string | null },
  request: ImoAuthInvalidateRequest,
): boolean {
  return (request.profile === undefined || entry.profile === request.profile)
    && (request.env === undefined || entry.env === request.env);
}

/** Host-only auth service. Prepare tokens never leave the closure-backed lease. */
export class ImoAuthService extends Service implements ImoAuth {
  static inject = ["subprocess"];
  static Config = Config;

  private readonly config: ImoConfig;
  #cache = new Map<string, AuthCacheEntry>();
  #listCache: { readonly at: number; readonly value: ImoAuthResult<ImoAuthProfileList> } | undefined;
  #listInflight: Promise<ImoAuthResult<ImoAuthProfileList>> | undefined;
  #inflight = new Map<string, PendingAuthPrepare>();
  #pendingMeta = new Map<string, { profile: string | null; env: string | null }>();
  #generations = new Map<string, number>();
  #disposed = false;
  #epoch = 0;

  constructor(ctx: Context, config: Partial<ImoConfig> = {}) {
    super(ctx, "imoAuth");
    this.config = resolveConfig(config);
    // Cordis exposes service methods through a shadow proxy; bind methods that
    // access ECMAScript private slots back to the owning service instance.
    this.listProfiles = this.listProfiles.bind(this);
    this.listProfilesCached = this.listProfilesCached.bind(this);
    this.profilesFast = this.profilesFast.bind(this);
    this.defaultProfile = this.defaultProfile.bind(this);
    this.validate = this.validate.bind(this);
    this.prepare = this.prepare.bind(this);
    this.invalidate = this.invalidate.bind(this);
    this.cacheStatus = this.cacheStatus.bind(this);
    this.ctx.effect(() => () => this.clearCache(), "imoAuth.cache");
  }

  async listProfiles(signal?: AbortSignal): Promise<ImoAuthResult<ImoAuthProfileList>> {
    const args = ["auth", "profile", "list", "--format", "json"] as const;
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
    });
    if (!run.ok) return { ok: false, error: authRunError(run.error, this.config.command, "profile list") };
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.value.stdout.text);
    } catch {
      return authParseError(this.config.command, "profile list", run.value.stdoutDigest, run.value.stderrDigest);
    }
    if (!Array.isArray(parsed)) {
      return authParseError(this.config.command, "profile list", run.value.stdoutDigest, run.value.stderrDigest);
    }
    const profiles = parsed.map(profileView).filter((profile): profile is ImoAuthProfileView => profile !== null);
    return { ok: true, value: { profiles, stdoutDigest: run.value.stdoutDigest } };
  }

  async defaultProfile(signal?: AbortSignal): Promise<ImoAuthResult<ImoAuthDefaultProfile>> {
    const args = ["auth", "default-profile", "get"] as const;
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
    });
    if (!run.ok) return { ok: false, error: authRunError(run.error, this.config.command, "default profile") };
    const profileName = parseDefaultProfile(run.value.stdout.text);
    if (profileName === undefined) {
      return authParseError(this.config.command, "default profile", run.value.stdoutDigest, run.value.stderrDigest);
    }
    return { ok: true, value: { profileName, stdoutDigest: run.value.stdoutDigest } };
  }

  /**
   * Cached profile list (TASK-041): 60s TTL in-memory; a CLI failure serves
   * the last good result instead of an empty list so the UI never renders a
   * misleading "None". `profilesFast` prefers this as its fallback.
   */
  async listProfilesCached(signal?: AbortSignal): Promise<ImoAuthResult<ImoAuthProfileList>> {
    const now = Date.now();
    if (this.#listCache !== undefined && now - this.#listCache.at <= LIST_CACHE_TTL_MS) {
      return this.#listCache.value;
    }
    if (this.#listInflight !== undefined) return this.#listInflight;
    const inflight = this.listProfiles(signal).then((result) => {
      this.#listInflight = undefined;
      if (result.ok) this.#listCache = { at: Date.now(), value: result };
      return result;
    }, (error) => {
      this.#listInflight = undefined;
      throw error;
    });
    this.#listInflight = inflight;
    return inflight;
  }

  /**
   * Millisecond profile snapshot straight from the imo CLI's plaintext store
   * (TASK-041). Only descriptive fields are read — access tokens are never
   * loaded. Falls back to the cached CLI list (stale=true) when the file is
   * absent, unreadable, or malformed; a read failure with no cache at all
   * degrades to the cached CLI path.
   */
  async profilesFast(signal?: AbortSignal): Promise<ImoAuthResult<ImoAuthProfilesFast>> {
    const read = await readProfileStore();
    if (read !== undefined) {
      return { ok: true, value: { profiles: read.profiles, defaultProfile: read.defaultProfile, stale: false } };
    }
    if (signal?.aborted) return authCancelled(this.config.command);
    const cached = await this.listProfilesCached(signal);
    if (cached.ok) {
      const def = await this.defaultProfile(signal);
      const profiles = cached.value.profiles.map((profile) => {
        const isDefault = def.ok ? def.value.profileName === profile.profileName : profile.isDefault === true;
        return isDefault === (profile.isDefault === true) ? profile : { ...profile, isDefault };
      });
      return { ok: true, value: { profiles, defaultProfile: def.ok ? def.value.profileName : null, stale: true } };
    }
    return cached;
  }

  async validate(profile?: string, signal?: AbortSignal): Promise<ImoAuthResult<ImoAuthValidation>> {
    const args = ["auth", "profile", "validate", ...(profile === undefined ? [] : ["--profile", profile]), "--json"] as const;
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
    });
    if (!run.ok) {
      const error = authRunError(run.error, this.config.command, "profile validate", true);
      if (error.code === "invalid-auth") this.invalidate({ profile: profile ?? null, reason: "unauthorized" });
      return { ok: false, error };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.value.stdout.text);
    } catch {
      return authParseError(this.config.command, "profile validate", run.value.stdoutDigest, run.value.stderrDigest);
    }
    if (!isRecord(parsed)) {
      return authParseError(this.config.command, "profile validate", run.value.stdoutDigest, run.value.stderrDigest);
    }
    const status = safeStatus(parsed.status);
    const reason = safeReason(parsed.reason);
    const statusCode = authStatusFromText(
      typeof parsed.status === "string" || typeof parsed.status === "number" ? String(parsed.status) : undefined,
      typeof parsed.reason === "string" ? parsed.reason : undefined,
      typeof parsed.code === "string" || typeof parsed.code === "number" ? String(parsed.code) : undefined,
    );
    if (statusCode !== undefined) {
      if (statusCode === "invalid-auth") this.invalidate({ profile: profile ?? null, reason: "unauthorized" });
      return authStatusError(statusCode, this.config.command, "profile validate", run.value.stdoutDigest, run.value.stderrDigest);
    }
    const profileName = rawString(parsed, "profile_name", "name") ?? safeAuthString(profile) ?? null;
    const valid = typeof parsed.valid === "boolean"
      ? parsed.valid
      : status === "valid" || status === "ok";
    return {
      ok: true,
      value: {
        profileName,
        valid,
        ...(status === undefined ? {} : { status }),
        ...(reason === undefined ? {} : { reason }),
        checkedAt: new Date().toISOString(),
        stdoutDigest: run.value.stdoutDigest,
      },
    };
  }

  async prepare(
    request: ImoAuthPrepareRequest = {},
    signal?: AbortSignal,
  ): Promise<ImoAuthResult<ImoAuthLease>> {
    if (this.#disposed) return authLifecycleError(AUTH_SERVICE_DISPOSED_CODE, this.config.command);
    const profile = request.profile ?? null;
    const env = request.env ?? null;
    const key = authCacheKey(profile, env);
    const cached = this.#cache.get(key);
    if (cached !== undefined) return { ok: true, value: new AuthLease(cached, true) };
    const existing = this.#inflight.get(key);
    if (existing !== undefined) {
      const result = await existing.promise;
      if (this.#disposed) return authLifecycleError(AUTH_SERVICE_DISPOSED_CODE, this.config.command);
      return result.ok ? { ok: true, value: new AuthLease(result.value, true) } : result;
    }
    const pending: PendingAuthPrepare = {
      profile,
      env,
      epoch: this.#epoch,
      generation: this.#generations.get(key) ?? 0,
      invalidated: false,
      promise: Promise.resolve(authLifecycleError(AUTH_PREPARE_INVALIDATED_CODE, this.config.command)),
    };
    const raw = this.executePrepare(profile, env, signal);
    pending.promise = raw.then((result) => this.finalizePrepare(key, pending, result)).finally(() => {
      if (this.#inflight.get(key) === pending) this.#inflight.delete(key);
      this.#pendingMeta.delete(key);
    });
    this.#inflight.set(key, pending);
    this.#pendingMeta.set(key, { profile, env });
    const result = await pending.promise;
    if (this.#disposed) return authLifecycleError(AUTH_SERVICE_DISPOSED_CODE, this.config.command);
    return result.ok ? { ok: true, value: new AuthLease(result.value, false) } : result;
  }

  invalidate(request: ImoAuthInvalidateRequest): ImoAuthInvalidation {
    if (this.#disposed) return { invalidated: 0, reason: request.reason };
    const keys = new Set<string>();
    let invalidated = 0;
    for (const [key, entry] of this.#cache) {
      if (!authCacheMatches(entry, request)) continue;
      keys.add(key);
      entry.cell.revoked = true;
      this.#cache.delete(key);
      invalidated += 1;
    }
    for (const [key, entry] of this.#pendingMeta) {
      if (!authCacheMatches(entry, request)) continue;
      keys.add(key);
      const pending = this.#inflight.get(key);
      if (pending !== undefined) pending.invalidated = true;
    }
    for (const key of keys) this.#generations.set(key, (this.#generations.get(key) ?? 0) + 1);
    this.ctx.emit(AUTH_CACHE_INVALIDATED_EVENT, {
      ...(request.profile === undefined ? {} : { profile: request.profile }),
      ...(request.env === undefined ? {} : { env: request.env }),
      reason: request.reason,
      invalidated,
    });
    return { invalidated, reason: request.reason };
  }

  cacheStatus(): ImoAuthCacheStatus {
    return { size: this.#cache.size };
  }

  private clearCache(): void {
    this.#disposed = true;
    this.#epoch += 1;
    for (const entry of this.#cache.values()) entry.cell.revoked = true;
    for (const pending of this.#inflight.values()) pending.invalidated = true;
    this.#cache.clear();
    this.#inflight.clear();
    this.#pendingMeta.clear();
    this.#generations.clear();
  }

  private finalizePrepare(
    key: string,
    pending: PendingAuthPrepare,
    result: ImoAuthResult<AuthCacheEntry>,
  ): ImoAuthResult<AuthCacheEntry> {
    if (this.#disposed || pending.epoch !== this.#epoch) {
      return authLifecycleError(AUTH_SERVICE_DISPOSED_CODE, this.config.command);
    }
    if (pending.invalidated || (this.#generations.get(key) ?? 0) !== pending.generation) {
      return authLifecycleError(AUTH_PREPARE_INVALIDATED_CODE, this.config.command);
    }
    if (result.ok) this.replaceCache(key, result.value);
    return result;
  }

  private replaceCache(key: string, entry: AuthCacheEntry): void {
    const previous = this.#cache.get(key);
    if (previous !== undefined) previous.cell.revoked = true;
    this.#cache.set(key, entry);
  }

  private async executePrepare(profile: string | null, env: string | null, signal?: AbortSignal): Promise<ImoAuthResult<AuthCacheEntry>> {
    const args = [
      "auth",
      "prepare",
      ...(profile === null ? [] : ["--profile", profile]),
      ...(env === null ? [] : ["--env", env]),
      "--json",
    ] as const;
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
    });
    if (!run.ok) return { ok: false, error: authRunError(run.error, this.config.command, "prepare") };
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.value.stdout.text);
    } catch {
      return authParseError(this.config.command, "prepare", run.value.stdoutDigest, run.value.stderrDigest);
    }
    if (!isRecord(parsed)) {
      return authParseError(this.config.command, "prepare", run.value.stdoutDigest, run.value.stderrDigest);
    }
    const accessToken = rawString(parsed, "access_token");
    if (accessToken === undefined) {
      return authParseError(this.config.command, "prepare", run.value.stdoutDigest, run.value.stderrDigest);
    }
    const profileName = rawString(parsed, "profile_name", "name") ?? profile ?? undefined;
    const envName = rawString(parsed, "env") ?? env ?? undefined;
    const envId = rawString(parsed, "env_id");
    const tenantCode = rawString(parsed, "tenant_code");
    const accountName = rawString(parsed, "account_name");
    const domain = rawString(parsed, "domain");
    const gateway = rawString(parsed, "gateway");
    const tenantDomain = rawString(parsed, "tenant_domain");
    const source = rawString(parsed, "source");
    const scope = rawString(parsed, "scope");
    const userSourceId = rawString(parsed, "user_source_id");
    const secret = Object.freeze({
      accessToken,
      ...(profileName === undefined ? {} : { profileName }),
      ...(envName === undefined ? {} : { env: envName }),
      ...(envId === undefined ? {} : { envId }),
      ...(tenantCode === undefined ? {} : { tenantCode }),
      ...(accountName === undefined ? {} : { accountName }),
      ...(domain === undefined ? {} : { domain }),
      ...(gateway === undefined ? {} : { gateway }),
      ...(tenantDomain === undefined ? {} : { tenantDomain }),
      ...(source === undefined ? {} : { source }),
      ...(scope === undefined ? {} : { scope }),
      ...(userSourceId === undefined ? {} : { userSourceId }),
    }) as ImoAuthSecret;
    const view = Object.freeze({
      profileName: profileName ?? null,
      env: envName ?? null,
      envId: envId ?? null,
      tenantCode: tenantCode ?? null,
      accountName: accountName ?? null,
      domain: safeEndpoint(domain) ?? null,
      gateway: safeEndpoint(gateway) ?? null,
      tenantDomain: safeTenantDomain(tenantDomain) ?? null,
      source: source ?? null,
      scope: scope ?? null,
      userSourceId: userSourceId ?? null,
    });
    return {
      ok: true,
      value: {
        key: authCacheKey(profile, env),
        profile,
        env,
        secret,
        view,
        createdAt: new Date().toISOString(),
        cell: { revoked: false },
      },
    };
  }
}
