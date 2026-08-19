import z from "@deepseek-ai/schemastery";

/** Read-only + upgrade IMO CLI configuration. */
export interface Config {
  /** Bare PATH command or absolute executable path. */
  command: string;
  /** Per one-shot read deadline, including lookup and process exit. */
  timeoutMs: number;
  /** Deadline for the longer-running `imo upgrade` command. */
  upgradeTimeoutMs: number;
  /** Read-only smoke commands (argv after the executable) run after an upgrade. */
  smokeCommands: readonly (readonly string[])[];
}

/** Default read-only post-upgrade smoke battery (02 doc 3.2; none writes remote). */
export const DEFAULT_SMOKE_COMMANDS: readonly (readonly string[])[] = [
  ["--version"],
  ["auth", "--help"],
  ["auth", "prepare", "--help"],
  ["skills", "list", "--help"],
  ["skills", "list", "--json"],
  ["icomposer", "--help"],
  ["icomposer", "push", "current", "--help"],
];

/** Schemastery schema used by the Host loader. */
export const Config: z<Config> = z.object({
  command: z.string().default("imo"),
  timeoutMs: z.natural().min(1).default(15_000),
  upgradeTimeoutMs: z.natural().min(1).default(180_000),
  smokeCommands: z.array(z.array(z.string())).default(DEFAULT_SMOKE_COMMANDS),
});

/** Apply schema-mirrored defaults for a partial (loader-supplied) config. */
export function resolveConfig(config: Partial<Config> = {}): Config {
  return {
    command: config.command ?? "imo",
    timeoutMs: config.timeoutMs ?? 15_000,
    upgradeTimeoutMs: config.upgradeTimeoutMs ?? 180_000,
    smokeCommands: config.smokeCommands ?? DEFAULT_SMOKE_COMMANDS,
  };
}
