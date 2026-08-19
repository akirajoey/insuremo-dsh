import { Service } from "@deepseek-ai/cordis";
import type { Context } from "@deepseek-ai/cordis";
import { Config, resolveConfig, type Config as ImoConfig } from "./config.ts";
import {
  mapRunFailure,
  resolveWithDeadline,
  runCapture,
  type ImoCliError,
  type ImoCliErrorCode,
  type ImoResult,
} from "./run.ts";

/** Stable read-only probe result. */
export interface ImoProbe {
  readonly command: string;
  readonly executablePath: string;
}

/** Parsed `imo --version` result with a digest instead of raw output. */
export interface ImoVersion {
  readonly executablePath: string;
  readonly currentVersion: string;
  readonly stdoutDigest: string;
}

/** Parsed `imo upgrade --check` result with a digest instead of raw output. */
export interface ImoUpgradeCheck {
  readonly executablePath: string;
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly updateAvailable: boolean;
  readonly stdoutDigest: string;
}

/** Public read-only face provided as `ctx.imoCli`. */
export interface ImoCli {
  probe(signal?: AbortSignal): Promise<ImoResult<ImoProbe>>;
  version(signal?: AbortSignal): Promise<ImoResult<ImoVersion>>;
  upgradeCheck(signal?: AbortSignal): Promise<ImoResult<ImoUpgradeCheck>>;
}

/**
 * Read-only IMO CLI service. Every process operation routes through
 * `ctx.subprocess` (via the shared runner); no environment is passed, and raw
 * output never leaves the package.
 */
export class ImoCliService extends Service implements ImoCli {
  static inject = ["subprocess"];
  static Config = Config;

  private readonly config: ImoConfig;

  constructor(ctx: Context, config: Partial<ImoConfig> = {}) {
    super(ctx, "imoCli");
    this.config = resolveConfig(config);
  }

  async probe(signal?: AbortSignal): Promise<ImoResult<ImoProbe>> {
    const run = await resolveWithDeadline(
      this.ctx.subprocess,
      this.config.command,
      this.config.timeoutMs,
      signal,
    );
    if (!run.ok) return { ok: false, error: mapRunFailure(run.error, this.config.command, []) };
    return { ok: true, value: { command: this.config.command, executablePath: run.value.executablePath } };
  }

  async version(signal?: AbortSignal): Promise<ImoResult<ImoVersion>> {
    const args = ["--version"] as const;
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
    });
    if (!run.ok) return { ok: false, error: mapRunFailure(run.error, this.config.command, args) };
    const currentVersion = firstVersion(run.value.stdout.text);
    if (currentVersion === undefined) {
      return {
        ok: false,
        error: {
          code: "parse-error",
          message: "version output did not contain a semantic version",
          command: this.config.command,
          args,
          stdoutDigest: run.value.stdoutDigest,
          stderrDigest: run.value.stderrDigest,
        },
      };
    }
    return {
      ok: true,
      value: {
        executablePath: run.value.executablePath,
        currentVersion,
        stdoutDigest: run.value.stdoutDigest,
      },
    };
  }

  async upgradeCheck(signal?: AbortSignal): Promise<ImoResult<ImoUpgradeCheck>> {
    const args = ["upgrade", "--check"] as const;
    const run = await runCapture(this.ctx.subprocess, {
      command: this.config.command,
      args,
      timeoutMs: this.config.timeoutMs,
      signal,
    });
    if (!run.ok) return { ok: false, error: mapRunFailure(run.error, this.config.command, args) };
    const parsed = parseUpgradeOutput(run.value.stdout.text);
    if (parsed === undefined) {
      return {
        ok: false,
        error: {
          code: "parse-error",
          message: "upgrade-check output could not be parsed",
          command: this.config.command,
          args,
          stdoutDigest: run.value.stdoutDigest,
          stderrDigest: run.value.stderrDigest,
        },
      };
    }
    return {
      ok: true,
      value: {
        executablePath: run.value.executablePath,
        ...parsed,
        stdoutDigest: run.value.stdoutDigest,
      },
    };
  }
}

function firstVersion(output: string): string | undefined {
  const VERSION_PATTERN = /(?:^|[^\d])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![\d.])/g;
  return [...output.matchAll(VERSION_PATTERN)][0]?.[1];
}

interface ParsedUpgrade {
  readonly currentVersion: string;
  readonly targetVersion: string;
  readonly updateAvailable: boolean;
}

function parseUpgradeOutput(output: string): ParsedUpgrade | undefined {
  const VERSION_PATTERN = /(?:^|[^\d])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?![\d.])/g;
  const current = output.match(/current(?:\s+version)?\s*[:=]\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i)?.[1]
    ?? [...output.matchAll(VERSION_PATTERN)][0]?.[1];
  if (current === undefined) return undefined;
  const target = output.match(/(?:new|latest|target|available)\s+version\s*[:=]\s*v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i)?.[1]
    ?? [...output.matchAll(VERSION_PATTERN)][1]?.[1]
    ?? current;
  const noUpdate = /(?:up[ -]?to[ -]?date|no\s+(?:new\s+)?version|already\s+(?:on|at)\s+latest)/i.test(output);
  const updateAvailable = !noUpdate && (
    (/(?:new|latest|target|available)\s+version/i.test(output) && target !== current)
      || /(?:update|upgrade)\s+available/i.test(output)
  );
  return { currentVersion: current, targetVersion: target, updateAvailable };
}
