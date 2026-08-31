import { createHash } from "node:crypto";

//#region ../icomposer-write/src/capture.ts
/** In-memory cap for one collected output stream (tail kept on overflow). */
const OUTPUT_LIMIT_BYTES = 64 * 1024;
/** Bounded JSON parse window for `--json` stdout. */
const JSON_LIMIT_BYTES$1 = 1024 * 1024;
/** SIGTERM → SIGKILL escalation grace for the managed process tree. */
const GRACE_MS = 1e3;
/** SHA-256 hex digest with a stable `sha256:` prefix. */
function digest(value) {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
function readCollected(handle, stream) {
	return handle.collected[stream]?.readFrom(0)?.text ?? "";
}
/**

* Run one fully-specified command to completion through `ctx.subprocess`

* (collect mode). Unlike a strict success-only capture this returns the

* outcome even for non-zero exits: `imo icomposer verify utils` reports an

* invalid Groovy file through exit code 1 while still printing the full JSON

* report on stdout. Raw output never crosses this seam — callers receive the

* stdout text plus digests only.

*/
async function capture(rt, options) {
	const { signal: deadlineSignal, cleanup, timedOut, cancelled } = deadline(options.timeoutMs, options.signal);
	let executablePath;
	try {
		executablePath = await rt.resolveExecutable(options.command, void 0, deadlineSignal);
	} catch {
		cleanup();
		return {
			ok: false,
			error: {
				code: timedOut() ? "timeout" : cancelled() ? "cancelled" : "not-found",
				message: timedOut() ? "IMO CLI operation timed out" : cancelled() ? "IMO CLI operation was cancelled" : `IMO CLI executable "${options.command}" was not found`
			}
		};
	}
	let handle;
	try {
		handle = rt.spawn({
			argv: [executablePath, ...options.args],
			cwd: options.cwd,
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: OUTPUT_LIMIT_BYTES },
				stderr: { maxBytes: OUTPUT_LIMIT_BYTES }
			},
			graceMs: GRACE_MS,
			signal: deadlineSignal
		});
	} catch {
		cleanup();
		return {
			ok: false,
			error: {
				code: "spawn-failed",
				message: "IMO CLI process could not be started"
			}
		};
	}
	try {
		const outcome = await handle.done;
		const stdout = readCollected(handle, "stdout");
		const stderr = readCollected(handle, "stderr");
		if (timedOut() || cancelled()) return {
			ok: false,
			error: {
				code: timedOut() ? "timeout" : "cancelled",
				message: timedOut() ? "IMO CLI operation timed out" : "IMO CLI operation was cancelled"
			}
		};
		return {
			ok: true,
			value: {
				exitCode: outcome.exitCode,
				signal: outcome.signal,
				stdout,
				stdoutDigest: digest(stdout),
				stderr,
				stderrDigest: digest(stderr)
			}
		};
	} catch {
		if (timedOut() || cancelled()) return {
			ok: false,
			error: {
				code: timedOut() ? "timeout" : "cancelled",
				message: timedOut() ? "IMO CLI operation timed out" : "IMO CLI operation was cancelled"
			}
		};
		return {
			ok: false,
			error: {
				code: "spawn-failed",
				message: "IMO CLI process failed"
			}
		};
	} finally {
		cleanup();
	}
}
function deadline(timeoutMs, parent) {
	const controller = new AbortController();
	let settled = false;
	let timedOut = false;
	let cancelled = false;
	const timer = setTimeout(() => {
		if (settled) return;
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const onAbort = () => {
		if (settled) return;
		cancelled = true;
		controller.abort();
	};
	parent?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		cancelled: () => cancelled,
		cleanup: () => {
			settled = true;
			clearTimeout(timer);
			parent?.removeEventListener("abort", onAbort);
		}
	};
}

//#endregion
//#region ../icomposer-write/src/parse.ts
/** JSON parse window for push stdout. */
const JSON_LIMIT_BYTES = 1024 * 1024;
const RESULTS_MAX = 200;
const WARNINGS_MAX = 20;
const FIELD_TEXT_MAX = 200;
/** Fixed conflict markers looked for on stdout/stderr (allowlist, not content). */
const CONFLICT_MARKERS = [
	"conflict-needs-strategy",
	"Conflict Files:",
	"conflict-skipped",
	"\"conflict\""
];
function stdoutHasConflict(text) {
	const lower = text.toLowerCase();
	return CONFLICT_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}
function clip(value, max) {
	return value.length > max ? value.slice(0, max - 1) + "…" : value;
}
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function boundedString(value) {
	if (typeof value !== "string") return void 0;
	const v = value.trim();
	if (!v) return void 0;
	return clip(v, FIELD_TEXT_MAX);
}
function boundedStringList(value, max) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value.slice(0, max)) {
		const v = boundedString(item);
		if (v !== void 0) out.push(v);
	}
	return out;
}
function int(value) {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : void 0;
}
function pickString(record, keys) {
	for (const key of keys) {
		const v = boundedString(record[key]);
		if (v !== void 0) return v;
	}
	return void 0;
}
function entryConflict(entry) {
	if (entry.conflict === true) return true;
	const action = pickString(entry, [
		"action",
		"status",
		"result_type",
		"conflict_strategy"
	]);
	if (action !== void 0 && action.toLowerCase().includes("conflict")) return true;
	return false;
}
function entryCompileChecks(entry) {
	const compile = entry.compile === true || entry.compiled === true || entry.would_compile === true || (typeof entry.compile === "boolean" ? entry.compile : false) || (typeof entry.compiled === "boolean" ? entry.compiled : false);
	const callersFound = int(entry.callers_found) ?? int(entry.callersFound) ?? 0;
	const callersCompiled = int(entry.callers_compiled) ?? int(entry.callersCompiled) ?? 0;
	const callerFailures = int(entry.caller_failures) ?? int(entry.callerFailures) ?? 0;
	if (callersFound === 0 && callersCompiled === 0 && callerFailures === 0 && !compile) return void 0;
	return {
		compile,
		callersFound,
		callersCompiled,
		callerFailures
	};
}
/** Ordered file list semantics: entry.path falls back to the requested path. */
function projectEntry(entry, requestedPath, index) {
	const path = boundedString(entry.file) ?? requestedPath;
	const target = pickString(entry, [
		"requestpath",
		"request_path",
		"target",
		"name",
		"remote_name"
	]) ?? path;
	const version = pickString(entry, [
		"remote_version",
		"remoteVersion",
		"version",
		"server_version"
	]) ?? "";
	const warnings = boundedStringList(entry.warnings, WARNINGS_MAX);
	const compileChecks = entryCompileChecks(entry);
	const conflict = entryConflict(entry);
	return {
		file: clip(path, FIELD_TEXT_MAX) ?? requestedPath,
		target: clip(target, FIELD_TEXT_MAX),
		localVersion: "",
		serverVersion: version,
		conflict,
		...compileChecks === void 0 ? {} : { compileChecks },
		warnings
	};
}
function topLevelConflict(parsed) {
	if (parsed.conflict === true) return true;
	const action = pickString(parsed, [
		"action",
		"status",
		"result_type",
		"conflict_strategy"
	]);
	if (action !== void 0 && action.toLowerCase().includes("conflict")) return true;
	if (Array.isArray(parsed.conflicts) && parsed.conflicts.length > 0) return true;
	if (Array.isArray(parsed.conflict_files) && parsed.conflict_files.length > 0) return true;
	const candidates = [
		parsed.files,
		parsed.results,
		parsed.items,
		parsed.ops
	].find((candidate) => Array.isArray(candidate));
	if (candidates !== void 0) return candidates.some((item) => isRecord(item) && entryConflict(item));
	return false;
}
/**

* Strict allowlist projection of `imo icomposer push … --json` stdout.

* Only named fields are read with bounded lengths; requested file paths are

* always preferred so a hostile CLI cannot rewrite the caller's own file list.

* `localVersion` is filled by the service from the local file content —

* the transport payload never contains file contents, only digests.

*/
function parsePushOutput(text, requestedPaths, fallbackPath) {
	if (Buffer.byteLength(text) > JSON_LIMIT_BYTES) return {
		ok: false,
		error: "parse-error"
	};
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			ok: false,
			error: "not-json"
		};
	}
	if (!isRecord(parsed)) return {
		ok: false,
		error: "parse-error"
	};
	const result = isRecord(parsed.result) ? parsed.result : parsed;
	const entryArray = [
		"files",
		"results",
		"items",
		"ops"
	].map((key) => Array.isArray(result[key]) ? result[key] : void 0).find((candidate) => candidate !== void 0);
	if (entryArray !== void 0) {
		const files$1 = [];
		const conflictFiles = [];
		entryArray.slice(0, RESULTS_MAX).forEach((item, index) => {
			if (!isRecord(item)) return;
			const requested = requestedPaths[index] ?? fallbackPath;
			const projected = projectEntry(item, requested, index);
			files$1.push({
				...projected,
				localVersion: ""
			});
			if (projected.conflict) conflictFiles.push(projected.file);
		});
		for (let i = files$1.length; i < requestedPaths.length && i < RESULTS_MAX; i++) files$1.push({
			file: requestedPaths[i],
			target: requestedPaths[i],
			localVersion: "",
			serverVersion: "",
			conflict: false,
			warnings: []
		});
		return {
			ok: true,
			value: {
				files: files$1,
				conflictFiles,
				conflict: conflictFiles.length > 0 || topLevelConflict(result)
			}
		};
	}
	const fileObjKey = [
		"files",
		"results",
		"by_file",
		"results_by_file"
	].find((key) => isRecord(result[key]));
	if (fileObjKey !== void 0) {
		const fileObj = result[fileObjKey];
		const files$1 = [];
		const conflictFiles = [];
		for (const key of Object.keys(fileObj)) {
			const item = fileObj[key];
			if (!isRecord(item)) {
				if (Array.isArray(item) && item.length > 0 && isRecord(item[0])) {
					const sub = item[0];
					const projected$1 = projectEntry(sub, key, files$1.length);
					files$1.push({
						...projected$1,
						file: boundedString(sub.file) ?? key,
						localVersion: ""
					});
					if (projected$1.conflict) conflictFiles.push(projected$1.file);
				}
				continue;
			}
			const projected = projectEntry(item, key, files$1.length);
			const usePath = key.endsWith(".groovy") ? key : projected.file;
			files$1.push({
				...projected,
				file: usePath,
				localVersion: ""
			});
			if (projected.conflict) conflictFiles.push(projected.file);
		}
		const ordered = requestedPaths.map((path, index) => {
			const existing = files$1.find((f) => f.file === path) ?? files$1[index];
			if (existing !== void 0) return {
				...existing,
				localVersion: ""
			};
			return {
				file: path,
				target: path,
				localVersion: "",
				serverVersion: "",
				conflict: false,
				warnings: []
			};
		});
		return {
			ok: true,
			value: {
				files: ordered,
				conflictFiles: [...new Set(conflictFiles)],
				conflict: conflictFiles.length > 0 || topLevelConflict(result)
			}
		};
	}
	const file = pickString(result, ["file", "path"]) ?? requestedPaths[0];
	const target = pickString(result, [
		"requestpath",
		"request_path",
		"target",
		"name",
		"remote_name"
	]) ?? file;
	const version = pickString(result, [
		"remote_version",
		"remoteVersion",
		"server_version"
	]) ?? "";
	const compileChecks = entryCompileChecks(result);
	const conflict = entryConflict(result) || topLevelConflict(result);
	const files = [{
		file: boundedString(file) ?? requestedPaths[0],
		target: clip(target, FIELD_TEXT_MAX),
		localVersion: "",
		serverVersion: version,
		conflict,
		...compileChecks === void 0 ? {} : { compileChecks },
		warnings: boundedStringList(result.warnings, WARNINGS_MAX)
	}];
	return {
		ok: true,
		value: {
			files,
			conflictFiles: conflict ? files.map((f) => f.file) : [],
			conflict
		}
	};
}
/** Receipt digest for a completed/failed/conflict push (digest-only evidence). */
function pushResultDigest(receipt) {
	return digest(JSON.stringify({
		operationId: receipt.operationId,
		status: receipt.status,
		stdoutDigest: receipt.stdoutDigest,
		stderrDigest: receipt.stderrDigest,
		conflictFiles: receipt.conflictFiles,
		finishedAt: receipt.finishedAt
	}));
}
function sha256Text(value) {
	return digest(value);
}
function toMillis(value) {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value);
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Math.max(0, Math.trunc(Number(value)));
	return 0;
}
function nestedRecord(parsed, keys) {
	for (const key of keys) {
		const value = parsed[key];
		if (isRecord(value)) return value;
	}
	return null;
}
/**

* Allowlist projection of `imo icomposer test api|function … --json` stdout.

* Raw request/response bodies are digested immediately (sha256) — payloads

* never survive as text. Bounded identifiers only.

*/
function parseTestOutput(text) {
	if (Buffer.byteLength(text) > JSON_LIMIT_BYTES) return {
		ok: false,
		error: "parse-error"
	};
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			ok: false,
			error: "not-json"
		};
	}
	if (!isRecord(parsed)) return {
		ok: false,
		error: "parse-error"
	};
	const result = isRecord(parsed.result) ? parsed.result : parsed;
	const inner = nestedRecord(result, [
		"test",
		"sample",
		"data"
	]) ?? result;
	const elapsedMs = toMillis(inner.elapsed_ms ?? inner.elapsedMs ?? result.elapsed_ms ?? result.elapsedMs);
	const rawStatus = inner.http_status ?? inner.httpStatus ?? inner.status_code ?? result.status_code ?? result.http_status;
	const httpStatus = typeof rawStatus === "number" && Number.isFinite(rawStatus) ? Math.trunc(rawStatus) : null;
	const requestRaw = JSON.stringify(inner.request ?? inner.payload ?? result.payload ?? result.request ?? null);
	const responseRaw = JSON.stringify(inner.response ?? inner.body ?? result.response ?? null);
	return {
		ok: true,
		value: {
			elapsedMs,
			httpStatus,
			requestDigest: requestRaw === "null" ? "" : sha256Text(requestRaw),
			responseDigest: responseRaw === "null" ? "" : sha256Text(responseRaw),
			traceId: boundedString(inner.trace_id ?? inner.traceId ?? result.trace_id ?? result.traceId) ?? "",
			testUrl: boundedString(inner.test_url ?? inner.testUrl ?? result.test_url) ?? "",
			savedAt: boundedString(inner.saved_at ?? inner.savedAt ?? result.saved_at) ?? ""
		}
	};
}
function stringListFrom(value, max) {
	if (isRecord(value) && !Array.isArray(value)) {
		const items$1 = [];
		for (const entryValue of Object.values(value)) {
			if (items$1.length >= max) break;
			if (typeof entryValue === "string") {
				const v = boundedString(entryValue);
				if (v !== void 0) items$1.push(v);
			} else if (isRecord(entryValue)) {
				const v = pickString(entryValue, [
					"repository_url",
					"repo_url",
					"url"
				]);
				if (v !== void 0) items$1.push(v);
			}
		}
		return {
			items: items$1,
			truncated: Object.keys(value).length > max
		};
	}
	const raw = Array.isArray(value) ? value : [];
	const items = [];
	for (const entry of raw.slice(0, max)) {
		if (typeof entry === "string") {
			const v = boundedString(entry);
			if (v !== void 0) items.push(v);
			continue;
		}
		if (isRecord(entry)) {
			const v = pickString(entry, [
				"repository_url",
				"repo_url",
				"url",
				"name",
				"repo"
			]);
			if (v !== void 0) items.push(v);
			else {
				const b = pickString(entry, [
					"branch",
					"branch_name",
					"name"
				]);
				if (b !== void 0) items.push(b);
			}
		}
	}
	return {
		items,
		truncated: raw.length > max
	};
}
function parseReleaseRepos(text) {
	if (Buffer.byteLength(text) > JSON_LIMIT_BYTES) return {
		ok: false,
		error: "parse-error"
	};
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			ok: false,
			error: "not-json"
		};
	}
	if (!isRecord(parsed)) return {
		ok: false,
		error: "parse-error"
	};
	const result = isRecord(parsed.result) ? parsed.result : parsed;
	const raw = result.repos ?? result.repositories ?? result.items ?? result.data ?? result;
	const { items, truncated } = stringListFrom(raw, RESULTS_MAX);
	return {
		ok: true,
		value: {
			repos: items,
			truncated
		}
	};
}
function parseReleaseBranches(text) {
	if (Buffer.byteLength(text) > JSON_LIMIT_BYTES) return {
		ok: false,
		error: "parse-error"
	};
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			ok: false,
			error: "not-json"
		};
	}
	if (!isRecord(parsed)) return {
		ok: false,
		error: "parse-error"
	};
	const result = isRecord(parsed.result) ? parsed.result : parsed;
	const raw = result.branches ?? result.items ?? result.data ?? result;
	const { items, truncated } = stringListFrom(raw, RESULTS_MAX);
	return {
		ok: true,
		value: {
			branches: items,
			truncated
		}
	};
}
function parseReleaseApply(text, exitCode) {
	if (Buffer.byteLength(text) > JSON_LIMIT_BYTES) return {
		ok: false,
		error: "parse-error"
	};
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			ok: false,
			error: "not-json"
		};
	}
	if (!isRecord(parsed)) return {
		ok: false,
		error: "parse-error"
	};
	const result = isRecord(parsed.result) ? parsed.result : parsed;
	const warnings = [...boundedStringList(result.warnings, WARNINGS_MAX), ...boundedStringList(result.metadata_warnings, WARNINGS_MAX)].slice(0, WARNINGS_MAX);
	const invalid = result.valid === false || result.error !== void 0;
	return {
		ok: true,
		value: {
			valid: exitCode === 0 && !invalid,
			warnings
		}
	};
}
const OPTIONS_MAX = 50;
function projectOption(entry) {
	const canonical = boundedString(entry.canonical_input ?? entry.canonicalInput);
	if (canonical === void 0) return null;
	const code = typeof entry.code === "number" && Number.isFinite(entry.code) ? Math.trunc(entry.code) : 0;
	const label = boundedString(entry.label) ?? canonical;
	const allowed = Array.isArray(entry.allowed_methods) ? boundedStringList(entry.allowed_methods, 16) : void 0;
	return {
		code,
		label,
		canonicalInput: canonical,
		...allowed === void 0 || allowed.length === 0 ? {} : { allowedMethods: allowed }
	};
}
function optionList(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const entry of value.slice(0, OPTIONS_MAX)) {
		if (!isRecord(entry)) continue;
		const projected = projectOption(entry);
		if (projected !== null) out.push(projected);
	}
	return out;
}
/**

* Allowlist projection of `imo icomposer create options api|function --json`.

* Each vocabulary is capped at 50 entries; unknown groups are dropped.

*/
function parseCreateOptions(text) {
	if (Buffer.byteLength(text) > JSON_LIMIT_BYTES) return {
		ok: false,
		error: "parse-error"
	};
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {
			ok: false,
			error: "not-json"
		};
	}
	if (!isRecord(parsed)) return {
		ok: false,
		error: "parse-error"
	};
	const result = isRecord(parsed.result) ? parsed.result : parsed;
	const kind = result.kind === "function" || parsed.kind === "function" ? "function" : "api";
	return {
		ok: true,
		value: {
			kind,
			status: optionList(result.status),
			funcScope: optionList(result.func_scope),
			requestMethod: optionList(result.request_method),
			requestType: optionList(result.request_type),
			responseType: optionList(result.response_type)
		}
	};
}

//#endregion
export { FIELD_TEXT_MAX, JSON_LIMIT_BYTES, OPTIONS_MAX, RESULTS_MAX, WARNINGS_MAX, capture, digest, parseCreateOptions, parsePushOutput, parseReleaseApply, parseReleaseBranches, parseReleaseRepos, parseTestOutput, pushResultDigest, stdoutHasConflict };