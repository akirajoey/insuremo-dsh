import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type {
	CollectedOutput,
	SubprocessHandle,
	SubprocessRuntime,
} from "@deepseek-ai/dsh-subprocess";

/** In-memory cap for one collected output stream (tail kept on overflow). */
export const OUTPUT_LIMIT_BYTES = 64 * 1024;
/** SIGTERM → SIGKILL escalation grace for the managed process tree. */
export const GRACE_MS = 1_000;

/** Structured failure vocabulary shared by read-only and side-effect launches. */
export type RunFailureCode =
	| "not-found"
	| "spawn-failed"
	| "non-zero-exit"
	| "timeout"
	| "cancelled";

export type RunHttpStatus = 401 | 403;

export interface RunFailure {
	readonly code: RunFailureCode;
	readonly message: string;
	readonly exitCode?: number | null;
	readonly signal?: string | null;
	readonly stdoutDigest?: string;
	readonly stderrDigest?: string;
	/** Classification made while raw streams are still local to runCapture. */
	readonly httpStatus?: RunHttpStatus;
}

export interface RunSuccess {
	readonly executablePath: string;
	readonly stdout: CollectedOutput;
	readonly stderr: CollectedOutput;
	readonly stdoutDigest: string;
	readonly stderrDigest: string;
	readonly exitCode: number;
}

export type RunResult =
	| { readonly ok: true; readonly value: RunSuccess }
	| { readonly ok: false; readonly error: RunFailure };

/** Structured failures exposed by read-only CLI/domain seams. */
export type ImoCliErrorCode = RunFailureCode | "parse-error";

/**
 * Raw streams of one failed run, captured beside (never inside) the
 * digest-only {@link RunFailure}. Only {@link runCaptureDetailed} returns
 * them; the default {@link runCapture} strips the field so every existing
 * path keeps its digest-only contract.
 */
export interface CaptureDetail {
	readonly stdout: string;
	readonly stderr: string;
	/** The 64KB collection cap dropped bytes from this stream. */
	readonly stdoutLossy: boolean;
	readonly stderrLossy: boolean;
}

export type DetailedRunResult = RunResult & { readonly detail?: CaptureDetail };

export interface ImoCliError {
	readonly code: ImoCliErrorCode;
	readonly message: string;
	readonly command: string;
	readonly args?: readonly string[];
	readonly exitCode?: number | null;
	readonly signal?: string | null;
	readonly stdoutDigest?: string;
	readonly stderrDigest?: string;
}

export type ImoResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: ImoCliError };

export function mapRunFailure(
	error: RunFailure,
	command: string,
	args: readonly string[],
): ImoCliError {
	return {
		code: error.code,
		message: error.message,
		command,
		args,
		...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
		...(error.signal === undefined ? {} : { signal: error.signal }),
		...(error.stdoutDigest === undefined
			? {}
			: { stdoutDigest: error.stdoutDigest }),
		...(error.stderrDigest === undefined
			? {}
			: { stderrDigest: error.stderrDigest }),
	};
}

export interface ResolveSuccess {
	readonly executablePath: string;
}

export type ResolveResult =
	| { readonly ok: true; readonly value: ResolveSuccess }
	| { readonly ok: false; readonly error: RunFailure };

export interface RunOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
	readonly signal?: AbortSignal;
	/** Explicit child environment overrides for deterministic read-only probes. */
	readonly env?: NodeJS.ProcessEnv;
	/** Child working directory; omitted callers retain the process cwd. */
	readonly cwd?: string;
}

/** SHA-256 hex digest with a stable `sha256:` prefix. */
export function digest(value: string): string {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function digestOf(collected: CollectedOutput): string {
	return digest(collected.text);
}

function readCollected(
	handle: SubprocessHandle,
	stream: "stdout" | "stderr",
): CollectedOutput {
	const read = handle.collected[stream]?.readFrom(0);
	if (read === undefined) return { text: "", truncated: false };
	return {
		text: read.text,
		truncated: read.lossy,
		...(read.spillPath === undefined ? {} : { spillPath: read.spillPath }),
	};
}

/**
 * Resolve one configured executable inside a deadline. This is the read-only
 * probe: it never starts a process, only resolves + verifies the executable.
 */
export async function resolveWithDeadline(
	rt: SubprocessRuntime,
	command: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ResolveResult> {
	const {
		signal: deadlineSignal,
		cleanup,
		timedOut,
		cancelled,
	} = deadline(timeoutMs, signal);
	try {
		const executablePath = await rt.resolveExecutable(
			command,
			undefined,
			deadlineSignal,
		);
		return { ok: true, value: { executablePath } };
	} catch {
		return {
			ok: false,
			error: {
				code: timedOut() ? "timeout" : cancelled() ? "cancelled" : "not-found",
				message: timedOut()
					? "IMO CLI probe timed out"
					: cancelled()
						? "IMO CLI probe was cancelled"
						: `IMO CLI executable "${command}" was not found`,
			},
		};
	} finally {
		cleanup();
	}
}

/** Maximum bytes read from an npm Windows shim during the safe adapter probe. */
export const WINDOWS_NPX_SHIM_MAX_BYTES = 16 * 1024;

/**
 * The npm CLI tools whose Windows batch shim must never reach cmd.exe: the
 * shell splits the spaced install path (`C:\Program Files\nodejs\npm.cmd`)
 * before npm ever starts. Both tools ship the same npm-generated shim shape.
 */
export type NpmTool = "npm" | "npx";

/**
 * Fixed npm-relative CLI entry per tool. Both entries are derived from the
 * canonical shim directory (or the verified global-prefix directory); a
 * path-looking token is never captured from the batch text.
 */
const NPM_TOOL_CLI_PARTS: Readonly<Record<NpmTool, readonly string[]>> = {
	npm: ["node_modules", "npm", "bin", "npm-cli.js"],
	npx: ["node_modules", "npm", "bin", "npx-cli.js"],
};

const WINDOWS_NPM_PREFIX_PARTS = ["node_modules", "npm", "bin", "npm-prefix.js"] as const;

/** Only these two npm-generated batch shapes are accepted by the adapter. */
export type NpmShimFormat = "modern" | "legacy";

export interface ParsedNpmShim {
	readonly format: NpmShimFormat;
	/** Both accepted npm shapes prefer a sibling node.exe and fall back to PATH. */
	readonly nodePolicy: "sibling-or-path";
	/** The CLI path is the fixed npm package path under the shim directory. */
	readonly cliPolicy: "sibling-npm-cli";
}

/** Original npx-scoped names, kept so existing npx callers still typecheck. */
export type NpxShimFormat = NpmShimFormat;
export type ParsedNpxShim = ParsedNpmShim;

/** `node_modules\npm\bin\<tool>-cli.js`, as spelled inside an npm batch shim. */
const SHIM_CLI_REL: Readonly<Record<NpmTool, string>> = {
	npm: "node_modules\\npm\\bin\\npm-cli.js",
	npx: "node_modules\\npm\\bin\\npx-cli.js",
};

/**
 * The modern npm shim template, parameterized by tool. Verified against
 * `bin/npm.cmd` and `bin/npx.cmd` of npm 11.6.2 and of the published npm
 * 11.9.0 tarball: within a release the two files are byte-identical apart from
 * NPM_CLI_JS/NPX_CLI_JS, NPM_PREFIX_*_CLI_JS and the CLI filename, and across
 * those releases the shims are unchanged. No other version is claimed.
 */
function modernShimLines(tool: NpmTool): readonly string[] {
	const cliVar = tool === "npm" ? "npm_cli_js" : "npx_cli_js";
	const prefixCliVar = tool === "npm" ? "npm_prefix_npm_cli_js" : "npm_prefix_npx_cli_js";
	const cliRel = SHIM_CLI_REL[tool];
	return [
		":: created by npm, please don't edit manually.",
		"@echo off",
		"setlocal",
		'set "node_exe=%~dp0\\node.exe"',
		'if not exist "%node_exe%" (',
		'set "node_exe=node"',
		")",
		'set "npm_prefix_js=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
		`set "${cliVar}=%~dp0\\${cliRel}"`,
		'for /f "delims=" %%f in (\'call "%node_exe%" "%npm_prefix_js%"\') do (',
		`set "${prefixCliVar}=%%f\\${cliRel}"`,
		")",
		`if exist "%${prefixCliVar}%" (`,
		`set "${cliVar}=%${prefixCliVar}%"`,
		")",
		`"%node_exe%" "%${cliVar}%" %*`,
	];
}

/** The known legacy cmd-shim batch template, parameterized by tool. */
function legacyShimLines(tool: NpmTool): readonly string[] {
	const cliRel = SHIM_CLI_REL[tool];
	return [
		"@echo off",
		"goto start",
		":find_dp0",
		"set dp0=%~dp0",
		"exit /b",
		":start",
		"setlocal",
		"call :find_dp0",
		'if exist "%dp0%\\node.exe" (',
		'set "_prog=%dp0%\\node.exe"',
		") else (",
		'set "_prog=node"',
		"set pathext=%pathext:;.js;=;%",
		")",
		`endlocal & goto #_undefined_# 2>nul || title %comspec% & "%_prog%" "%dp0%\\${cliRel}" %*`,
	];
}

const MODERN_NPM_SHIM_LINES = modernShimLines("npm");
const LEGACY_NPM_SHIM_LINES = legacyShimLines("npm");
const MODERN_NPX_SHIM_LINES = modernShimLines("npx");
const LEGACY_NPX_SHIM_LINES = legacyShimLines("npx");

/**
 * Which npm tool, if any, this Windows executable path is the batch shim of.
 * Everything else (pnpm.cmd, imo.cmd, POSIX shims, plain binaries) returns
 * undefined and keeps the historical launch boundary.
 */
function windowsNpmTool(executablePath: string, platform: string): NpmTool | undefined {
	if (platform !== "win32") return undefined;
	const api = pathApiFor(platform, executablePath);
	switch (api.basename(executablePath).toLowerCase()) {
		case "npm.cmd":
		case "npm.bat":
			return "npm";
		case "npx.cmd":
		case "npx.bat":
			return "npx";
		default:
			// Explicit matches only: no prototype key (e.g. "constructor") can
			// ever select a tool.
			return undefined;
	}
}

/**
 * Parse only the exact npm-generated npm/npx shim forms known to this adapter.
 *
 * This parser intentionally returns policies, not paths. A path-looking token
 * captured from a batch file is never trusted as an executable or CLI entry;
 * callers derive the two fixed npm-relative paths from the canonical shim
 * directory and verify them as real files before spawning. Content is matched
 * against the accepted shape for THIS tool only, so an npm.cmd carrying the
 * npx template (or the reverse) is rejected instead of silently launching the
 * other CLI.
 */
export function parseNpmShim(content: string, tool: NpmTool): ParsedNpmShim | undefined {
	if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > WINDOWS_NPX_SHIM_MAX_BYTES) return undefined;
	const lines = content
		.replace(/^\uFEFF/u, "")
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.map(normalizeBatchLine)
		.filter(line => line.length > 0);
	const [modern, legacy] = tool === "npm"
		? [MODERN_NPM_SHIM_LINES, LEGACY_NPM_SHIM_LINES]
		: [MODERN_NPX_SHIM_LINES, LEGACY_NPX_SHIM_LINES];
	if (sameLines(lines, modern)) {
		return { format: "modern", nodePolicy: "sibling-or-path", cliPolicy: "sibling-npm-cli" };
	}
	if (sameLines(lines, legacy)) {
		return { format: "legacy", nodePolicy: "sibling-or-path", cliPolicy: "sibling-npm-cli" };
	}
	return undefined;
}

/**
 * npx-only view of {@link parseNpmShim}, retained for the TASK-096 probe
 * mirror and existing callers that address the npx shim specifically.
 */
export function parseNpmNpxShim(content: string): ParsedNpmShim | undefined {
	return parseNpmShim(content, "npx");
}

function normalizeBatchLine(line: string): string {
	return line.trim().replace(/[ \t]+/gu, " ").toLowerCase();
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((line, index) => line === right[index]);
}

interface PathApi {
	readonly basename: (path: string) => string;
	readonly dirname: (path: string) => string;
	readonly join: (...paths: string[]) => string;
	readonly relative: (from: string, to: string) => string;
	readonly isAbsolute: (path: string) => boolean;
	readonly sep: string;
}

/**
 * Tests may pass POSIX fixture paths while exercising the Windows policy. Real
 * Windows resolver paths contain a drive or backslash and therefore use the
 * case-insensitive win32 path implementation.
 */
function pathApiFor(platform: string, path: string): PathApi {
	if (platform === "win32" && (path.includes("\\") || /^[A-Za-z]:[\\/]/u.test(path))) return win32;
	return posix;
}

function containedPath(root: string, candidate: string, api: PathApi, caseInsensitive: boolean): boolean {
	const normalizedRoot = caseInsensitive ? root.toLowerCase() : root;
	const normalizedCandidate = caseInsensitive ? candidate.toLowerCase() : candidate;
	const relativePath = api.relative(normalizedRoot, normalizedCandidate);
	return relativePath.length > 0
		&& relativePath !== ".."
		&& !relativePath.startsWith(`..${api.sep}`)
		&& !api.isAbsolute(relativePath);
}

function missingPath(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/** Canonicalize and verify one readable file without widening the subprocess fs model. */
async function canonicalFile(
	candidate: string,
	root: string | undefined,
	api: PathApi,
	signal: AbortSignal | undefined,
	executable: boolean,
): Promise<string> {
	signal?.throwIfAborted();
	const canonical = await realpath(candidate);
	signal?.throwIfAborted();
	if (root !== undefined && !containedPath(root, canonical, api, true)) throw new Error("path outside shim directory");
	const info = await stat(canonical);
	if (!info.isFile()) throw new Error("path is not a file");
	await access(canonical, constants.R_OK);
	if (executable) await access(canonical, constants.X_OK);
	return canonical;
}

async function optionalCanonicalFile(
	candidate: string,
	root: string,
	api: PathApi,
	signal: AbortSignal | undefined,
	executable: boolean,
): Promise<string | undefined> {
	try {
		return await canonicalFile(candidate, root, api, signal, executable);
	} catch (error: unknown) {
		if (missingPath(error)) return undefined;
		throw error;
	}
}

/** Read a shim with a hard byte bound; no batch contents are executed. */
async function readBoundedShim(path: string, signal: AbortSignal | undefined): Promise<string> {
	const file = await open(path, "r");
	try {
		const bytes = Buffer.alloc(WINDOWS_NPX_SHIM_MAX_BYTES + 1);
		let offset = 0;
		while (offset < bytes.length) {
			signal?.throwIfAborted();
			const result = await file.read(bytes, offset, bytes.length - offset, offset);
			if (result.bytesRead === 0) break;
			offset += result.bytesRead;
		}
		if (offset > WINDOWS_NPX_SHIM_MAX_BYTES) throw new Error("npm shim is too large");
		return bytes.subarray(0, offset).toString("utf8");
	} finally {
		try {
			await file.close();
		} catch {
			// The adapter fails closed; a close error is not exposed to callers.
		}
	}
}

/** Canonicalize an npm prefix directory returned by the read-only helper. */
async function canonicalDirectory(
	candidate: string,
	signal: AbortSignal | undefined,
): Promise<string | undefined> {
	try {
		signal?.throwIfAborted();
		const canonical = await realpath(candidate);
		signal?.throwIfAborted();
		const info = await stat(canonical);
		return info.isDirectory() ? canonical : undefined;
	} catch (error: unknown) {
		if (missingPath(error)) return undefined;
		throw error;
	}
}

/** Parse exactly one absolute prefix line; never capture an arbitrary path token from logs. */
function parsePrefixOutput(output: string, platform: string): string | undefined {
	const lines = output
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.filter(line => line.length > 0);
	if (lines.length !== 1) return undefined;
	const raw = lines[0]!;
	const value = raw.trim();
	if (value.length === 0 || raw !== value || /[\u0000-\u001F\u007F"]/u.test(value)) return undefined;
	const api = pathApiFor(platform, value);
	return api.isAbsolute(value) ? value : undefined;
}

/**
 * Run npm's standard prefix helper through the same managed subprocess seam.
 * The helper is not the shim: it is an npm-owned read-only script whose only
 * stdout contract is the configured global prefix. Any failure falls back to
 * the shim-relative CLI, exactly as the standard batch shim does.
 */
async function readNpmPrefix(
	rt: SubprocessRuntime,
	node: string,
	prefixScript: string,
	options: SpawnArgvOptions,
): Promise<string | undefined> {
	let handle: SubprocessHandle;
	try {
		handle = rt.spawn({
			argv: [node, prefixScript],
			cwd: options.cwd ?? process.cwd(),
			stdio: {
				stdin: "ignore" as const,
				stdout: { maxBytes: OUTPUT_LIMIT_BYTES } as const,
				stderr: { maxBytes: OUTPUT_LIMIT_BYTES } as const,
			},
			graceMs: GRACE_MS,
			signal: options.signal,
			...(options.env === undefined ? {} : { env: options.env }),
		});
	} catch {
		return undefined;
	}
	try {
		const outcome = await handle.done;
		options.signal?.throwIfAborted();
		if (outcome.exitCode !== 0 || outcome.signal !== null) return undefined;
		const stdout = readCollected(handle, "stdout");
		return stdout.truncated ? undefined : stdout.text;
	} catch (error: unknown) {
		if (options.signal?.aborted) throw error;
		return undefined;
	}
}

/**
 * Resolve the optional global-prefix CLI candidate emitted by the modern npm
 * shim, for the same tool the invoked shim belongs to.
 */
async function resolvePrefixedCli(
	rt: SubprocessRuntime,
	node: string,
	prefixScript: string | undefined,
	platform: string,
	options: SpawnArgvOptions,
	cliParts: readonly string[],
): Promise<string | undefined> {
	if (prefixScript === undefined) return undefined;
	const prefixOutput = await readNpmPrefix(rt, node, prefixScript, options);
	if (prefixOutput === undefined) return undefined;
	const prefixText = parsePrefixOutput(prefixOutput, platform);
	if (prefixText === undefined) return undefined;
	const prefixApi = pathApiFor(platform, prefixText);
	const prefixDir = await canonicalDirectory(prefixText, options.signal);
	if (prefixDir === undefined) return undefined;
	return optionalCanonicalFile(
		prefixApi.join(prefixDir, ...cliParts),
		prefixDir,
		prefixApi,
		options.signal,
		false,
	);
}

function nativeNodeExecutable(path: string, api: PathApi): boolean {
	return api.basename(path).toLowerCase() === "node.exe";
}

function resolveEnvironment(env: NodeJS.ProcessEnv | undefined): Readonly<Record<string, string>> | undefined {
	if (env === undefined) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) resolved[key] = value ?? "";
	return resolved;
}

/**
 * Options for resolving a managed argv, with platform/comspec injectable in
 * tests. `signal` is the caller-owned total deadline/cancellation signal;
 * this resolver creates no stage-local timeout.
 */
export interface SpawnArgvOptions {
	readonly platform?: string;
	readonly comspec?: string;
	readonly env?: NodeJS.ProcessEnv;
	readonly cwd?: string;
	readonly signal?: AbortSignal;
}

/**
 * Resolve a managed spawn argv. The npm and npx batch shims are the Windows
 * commands whose command line must not be handed to cmd: the standard shim is
 * inspected read-only and replaced by native node.exe + the verified
 * `npm-cli.js`/`npx-cli.js` of the same tool. This runs the one-shot IMO
 * install (`npm config set`, `npm install -g`) without a shell, so a spaced
 * install path such as `C:\Program Files\nodejs\npm.cmd` can never be split.
 * Other `.cmd`/`.bat` commands retain the historical cmd fallback and its
 * existing quoting boundary; they are intentionally outside this fix.
 */
export async function resolveSpawnArgv(
	rt: SubprocessRuntime,
	executablePath: string,
	args: readonly string[],
	options: SpawnArgvOptions = {},
): Promise<readonly string[]> {
	const platform = options.platform ?? process.platform;
	const tool = windowsNpmTool(executablePath, platform);
	if (tool === undefined) return toSpawnArgv(executablePath, args, platform, options.comspec);
	const cliParts = NPM_TOOL_CLI_PARTS[tool];

	const api = pathApiFor(platform, executablePath);
	const shim = await canonicalFile(executablePath, undefined, api, options.signal, true);
	const shimDir = api.dirname(shim);
	const parsed = parseNpmShim(await readBoundedShim(shim, options.signal), tool);
	if (parsed === undefined) throw new Error(`unsupported ${tool} shim`);

	// The parser permits only the fixed npm-relative entry for this tool.
	// Modern npm also probes a global prefix; the prefix helper is itself a
	// contained npm file, so its read-only managed result is validated before
	// it can replace the contained fallback. No batch path capture is ever
	// trusted as-is.
	if (parsed.cliPolicy !== "sibling-npm-cli") throw new Error(`unsupported ${tool} cli policy`);
	const siblingCli = await optionalCanonicalFile(
		api.join(shimDir, ...cliParts),
		shimDir,
		api,
		options.signal,
		false,
	);
	const prefixScript = parsed.format === "modern"
		? await optionalCanonicalFile(
			api.join(shimDir, ...WINDOWS_NPM_PREFIX_PARTS),
			shimDir,
			api,
			options.signal,
			false,
		)
		: undefined;

	const siblingNode = await optionalCanonicalFile(
		api.join(shimDir, "node.exe"),
		shimDir,
		api,
		options.signal,
		true,
	);
	let node = siblingNode;
	if (node === undefined) {
		const resolvedNode = await rt.resolveExecutable("node", resolveEnvironment(options.env), options.signal);
		const resolvedApi = pathApiFor(platform, resolvedNode);
		if (!nativeNodeExecutable(resolvedNode, resolvedApi)) throw new Error("resolved node is not node.exe");
		node = await canonicalFile(resolvedNode, undefined, resolvedApi, options.signal, true);
	}
	if (node === undefined) throw new Error("node executable is unavailable");

	const prefixedCli = await resolvePrefixedCli(rt, node, prefixScript, platform, options, cliParts);
	const cli = prefixedCli ?? siblingCli;
	if (cli === undefined) throw new Error(`${tool} cli is unavailable`);
	return [node, cli, ...args];
}

/**
 * Legacy fallback for Windows shims outside the npm/npx adapter. It remains
 * intentionally unchanged: callers with paths such as `imo.cmd` or `pnpm.cmd`
 * still use the cmd boundary (including its unquoted join) and would need a
 * separate compatibility decision.
 */
export function toSpawnArgv(
	executablePath: string,
	args: readonly string[],
	platform: string,
	comspec?: string,
): readonly string[] {
	if (platform !== "win32") return [executablePath, ...args];
	const lowered = executablePath.toLowerCase();
	if (!lowered.endsWith(".cmd") && !lowered.endsWith(".bat"))
		return [executablePath, ...args];
	return [
		comspec ?? process.env.comspec ?? "cmd.exe",
		"/d",
		"/s",
		"/c",
		[executablePath, ...args].join(" "),
	];
}

/**
 * Run one fully-specified command to completion through `ctx.subprocess`
 * (collect mode), classify the outcome, and return digests — never raw
 * output. Executable resolution, an explicit collection spec, a grace period,
 * and an internal timeout AbortSignal are all supplied by this seam.
 */
export async function runCapture(
	rt: SubprocessRuntime,
	options: RunOptions,
): Promise<RunResult> {
	const outcome = await captureCore(rt, options);
	// Strip the sibling detail so the shared return shape stays digest-only.
	return outcome.ok ? { ok: true, value: outcome.value } : { ok: false, error: outcome.error };
}

/**
 * {@link runCapture} plus the failed run's raw streams (see
 * {@link CaptureDetail}). Diagnosis-only: the install/update kernels use it
 * to record the last failure's full output in memory; nothing else may
 * consume it, and success runs carry no detail at all.
 */
export async function runCaptureDetailed(
	rt: SubprocessRuntime,
	options: RunOptions,
): Promise<DetailedRunResult> {
	return captureCore(rt, options);
}

async function captureCore(
	rt: SubprocessRuntime,
	options: RunOptions,
): Promise<RunResult & { readonly detail?: CaptureDetail }> {
	const {
		signal: deadlineSignal,
		cleanup,
		timedOut,
		cancelled,
	} = deadline(options.timeoutMs, options.signal);

	let executablePath: string;
	try {
		executablePath = await rt.resolveExecutable(
			options.command,
			resolveEnvironment(options.env),
			deadlineSignal,
		);
	} catch (cause: unknown) {
		cleanup();
		return {
			ok: false,
			error: {
				code: timedOut() ? "timeout" : cancelled() ? "cancelled" : "not-found",
				message: timedOut()
					? "IMO CLI operation timed out"
					: cancelled()
						? "IMO CLI operation was cancelled"
						: `IMO CLI executable "${options.command}" was not found`,
			},
		};
	}

	let argv: readonly string[];
	try {
		argv = await resolveSpawnArgv(rt, executablePath, options.args, {
			env: options.env,
			cwd: options.cwd,
			signal: deadlineSignal,
			platform: process.platform,
		});
	} catch {
		cleanup();
		return {
			ok: false,
			error: {
				code: timedOut() ? "timeout" : cancelled() ? "cancelled" : "spawn-failed",
				message: timedOut()
					? "IMO CLI operation timed out"
					: cancelled()
						? "IMO CLI operation was cancelled"
						: windowsNpmTool(executablePath, process.platform) !== undefined
							? "the resolved npm/npx shim is unsupported or incomplete; use a standard npm Node installation"
							: "IMO CLI executable could not be safely launched",
			},
		};
	}

	let handle: SubprocessHandle;
	try {
		const spawnSpec = {
			argv,
			cwd: options.cwd ?? process.cwd(),
			stdio: {
				stdin: "ignore" as const,
				stdout: { maxBytes: OUTPUT_LIMIT_BYTES } as const,
				stderr: { maxBytes: OUTPUT_LIMIT_BYTES } as const,
			},
			graceMs: GRACE_MS,
			signal: deadlineSignal,
			...(options.env === undefined ? {} : { env: options.env }),
		};
		handle = rt.spawn(spawnSpec);
	} catch {
		cleanup();
		return {
			ok: false,
			error: {
				code: "spawn-failed",
				message: "IMO CLI process could not be started",
			},
		};
	}

	try {
		const outcome = await handle.done;
		const stdout = readCollected(handle, "stdout");
		const stderr = readCollected(handle, "stderr");
		if (timedOut() || cancelled()) {
			const httpStatus = classifyHttpStatus(stdout.text, stderr.text);
			const error: RunFailure = {
				code: timedOut() ? "timeout" : "cancelled",
				message: timedOut()
					? "IMO CLI operation timed out"
					: "IMO CLI operation was cancelled",
				exitCode: outcome.exitCode,
				signal: outcome.signal,
				stdoutDigest: digestOf(stdout),
				stderrDigest: digestOf(stderr),
				...(httpStatus === undefined ? {} : { httpStatus }),
			};
			return {
				ok: false,
				error,
				detail: { stdout: stdout.text, stderr: stderr.text, stdoutLossy: stdout.truncated, stderrLossy: stderr.truncated },
			};
		}
		if (outcome.exitCode !== 0 || outcome.signal !== null) {
			const httpStatus = classifyHttpStatus(stdout.text, stderr.text);
			const error: RunFailure = {
				code: "non-zero-exit",
				message: `IMO CLI exited with code ${outcome.exitCode ?? "signal"}`,
				exitCode: outcome.exitCode,
				signal: outcome.signal,
				stdoutDigest: digestOf(stdout),
				stderrDigest: digestOf(stderr),
				...(httpStatus === undefined ? {} : { httpStatus }),
			};
			return {
				ok: false,
				error,
				detail: { stdout: stdout.text, stderr: stderr.text, stdoutLossy: stdout.truncated, stderrLossy: stderr.truncated },
			};
		}
		return {
			ok: true,
			value: {
				executablePath,
				stdout,
				stderr,
				stdoutDigest: digestOf(stdout),
				stderrDigest: digestOf(stderr),
				exitCode: 0,
			},
		};
	} catch {
		if (timedOut() || cancelled()) {
			return {
				ok: false,
				error: {
					code: timedOut() ? "timeout" : "cancelled",
					message: timedOut()
						? "IMO CLI operation timed out"
						: "IMO CLI operation was cancelled",
				},
			};
		}
		return {
			ok: false,
			error: { code: "spawn-failed", message: "IMO CLI process failed" },
		};
	} finally {
		cleanup();
	}
}

function classifyHttpStatus(
	stdout: string,
	stderr: string,
): RunHttpStatus | undefined {
	const text = `${stdout} ${stderr}`;
	if (
		/\b401\b|unauthori[sz]ed|invalid(?:\s+|-)auth|token(?:\s+|-)expired/i.test(
			text,
		)
	)
		return 401;
	if (/\b403\b|forbidden|permission\s+denied/i.test(text)) return 403;
	return undefined;
}

function deadline(
	timeoutMs: number,
	parent?: AbortSignal,
): {
	signal: AbortSignal;
	timedOut: () => boolean;
	cancelled: () => boolean;
	cleanup: () => void;
} {
	const controller = new AbortController();
	let timedOut = false;
	let cancelled = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new Error("operation timed out"));
	}, timeoutMs);
	const onAbort = (): void => {
		cancelled = true;
		controller.abort(parent?.reason);
	};
	if (parent?.aborted) onAbort();
	else parent?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		cancelled: () => cancelled,
		cleanup: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		},
	};
}
