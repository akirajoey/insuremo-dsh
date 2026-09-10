window.__ModuleLoader__.load({ id: "@icomposer/workbench", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
const react = __toESM(require("react"));
const react_jsx_runtime = __toESM(require("react/jsx-runtime"));
const react_dom_client = __toESM(require("react-dom/client"));
const __deepseek_ai_dsh_client_ui_primitives = __toESM(require("@deepseek-ai/dsh-client-ui-primitives"));

//#region ../ui-insuremo-settings/src/client/ChevronIcon.tsx
/**
* Down-chevron disclosure icon mirroring the platform's
* `IconChevronDownOutline14` (14px outline chevron). Inlined so the card
* bundle keeps zero non-platform dependencies; the CSS rotation animates
* the open state exactly like the official PluginCard.
*/
function ChevronIcon(props) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
		className: props.className,
		width: "14",
		height: "14",
		viewBox: "0 0 14 14",
		fill: "none",
		"aria-hidden": "true",
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", {
			d: "M3.5 5.25 7 8.75l3.5-3.5",
			stroke: "currentColor",
			strokeWidth: "1.4",
			strokeLinecap: "round",
			strokeLinejoin: "round"
		})
	});
}

//#endregion
//#region ../ui-insuremo-settings/src/client/overview.ts
const OVERVIEW_URL$1 = "/api/icomposer-workbench/insuremo/overview";
const SKILL_CATALOG_URL = `${OVERVIEW_URL$1}/skill-catalog`;
const MAX_CATALOG_ENTRIES = 133;
/** Rebuild a fresh view from only the allowlisted fields; `null` on garbage. */
function parseOverview(value) {
	const root = obj(value);
	if (root === null) return null;
	const imo = obj(root.imo);
	const auth = obj(root.auth);
	const skills = obj(root.skills);
	const operations = obj(root.operations);
	const diagnostics = obj(root.diagnostics);
	if (imo === null || auth === null || skills === null || operations === null || diagnostics === null) return null;
	const iciRaw = obj(root.ici);
	const ici = iciRaw === null ? void 0 : {
		status: str(iciRaw.status, "warning"),
		embeddingUrl: str(iciRaw.embeddingUrl, ""),
		graphWorkspaces: num(iciRaw.graphWorkspaces),
		explainWorkspaces: num(iciRaw.explainWorkspaces)
	};
	return {
		schemaVersion: str(root.schemaVersion, "0"),
		generatedAt: str(root.generatedAt, ""),
		imo: {
			status: str(imo.status, "error"),
			...optStr("code", imo.code),
			available: bool(imo.available),
			...optStr("current", imo.current),
			...optStr("target", imo.target),
			updateAvailable: bool(imo.updateAvailable),
			...bool(imo.busy) ? { busy: true } : {}
		},
		auth: {
			status: str(auth.status, "error"),
			...optStr("code", auth.code),
			profiles: arr(auth.profiles).slice(0, 100).map((profile) => {
				const p = obj(profile);
				return {
					name: str(p?.name, ""),
					...optStr("env", p?.env),
					...optStr("tenantCode", p?.tenantCode),
					isDefault: bool(p?.isDefault),
					...bool(p?.isActive) ? { isActive: true } : {},
					...optBool("valid", p?.valid)
				};
			}),
			count: num(auth.count),
			...optStr("defaultProfile", auth.defaultProfile),
			...auth.activeProfileName === null ? { activeProfileName: null } : optStr("activeProfileName", auth.activeProfileName),
			...typeof auth.activeProfileRevision === "number" && Number.isFinite(auth.activeProfileRevision) ? { activeProfileRevision: Math.trunc(auth.activeProfileRevision) } : {},
			...optStr("activeProfileStatus", auth.activeProfileStatus)
		},
		skills: {
			status: str(skills.status, "error"),
			...optStr("code", skills.code),
			installed: num(skills.installed),
			valid: num(skills.valid),
			enabled: num(skills.enabled),
			disabled: num(skills.disabled),
			names: arr(skills.names).filter((name) => typeof name === "string").slice(0, 512),
			...arr(skills.entries).length > 0 ? { entries: arr(skills.entries).slice(0, 100).map((item) => {
				const e = obj(item);
				const diagnostic = parseSkillDiagnostic(e?.diagnostic);
				return {
					name: boundedSkillName(e?.name),
					description: boundedText(e?.description, 200),
					enabled: bool(e?.enabled),
					...diagnostic === void 0 ? {} : { diagnostic }
				};
			}).filter((e) => e.name.length > 0) } : {},
			formatInvalidCount: boundedCount(skills.formatInvalidCount),
			pathIssueCount: boundedCount(skills.pathIssueCount),
			diagnosticCount: boundedCount(skills.diagnosticCount),
			diagnostics: arr(skills.diagnostics).slice(0, 100).map(parseSkillDiagnostic).filter((item) => item !== void 0),
			diagnosticsTruncated: bool(skills.diagnosticsTruncated),
			...typeof skills.activationRevision === "number" && Number.isFinite(skills.activationRevision) ? { activationRevision: Math.trunc(skills.activationRevision) } : {}
		},
		operations: {
			status: str(operations.status, "error"),
			...optStr("code", operations.code),
			pending: num(operations.pending),
			approved: num(operations.approved),
			rejected: num(operations.rejected),
			recorded: num(operations.recorded),
			recent: arr(operations.recent).slice(0, 20).map((entry) => {
				const e = obj(entry);
				return {
					id: str(e?.id, ""),
					kind: str(e?.kind, ""),
					decision: str(e?.decision, ""),
					recorded: bool(e?.recorded),
					...optStr("createdAt", e?.createdAt)
				};
			})
		},
		diagnostics: {
			status: str(diagnostics.status, "error"),
			diagnostics: arr(diagnostics.diagnostics).slice(0, 50).map((item) => {
				const d = obj(item);
				return {
					id: str(d?.id, ""),
					severity: str(d?.severity, "info"),
					messageKey: str(d?.messageKey, "")
				};
			})
		},
		...ici === void 0 ? {} : { ici }
	};
}
/** Parse the explicit catalog-refresh response; unknown rows fail closed. */
function parseSkillCatalog(value) {
	const root = obj(value);
	if (root === null) return null;
	const candidate = obj(root.result) ?? root;
	if (candidate.status !== "ready" && candidate.status !== "empty" || candidate.schemaVersion !== "1" || candidate.source !== "insuremo-skills") return null;
	const status = candidate.status === "empty" ? "empty" : "ready";
	const fetchedAt = candidate.fetchedAt;
	const expiresAt = candidate.expiresAt;
	if (typeof fetchedAt !== "string" || fetchedAt.length > 64 || typeof expiresAt !== "string" || expiresAt.length > 64) return null;
	const expiresAtMs = Date.parse(expiresAt);
	if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
	const rawEntries = arr(candidate.entries);
	if (rawEntries.length === 0 || rawEntries.length > MAX_CATALOG_ENTRIES) return null;
	const entries = [];
	const seen = /* @__PURE__ */ new Set();
	for (const raw of rawEntries) {
		const item = obj(raw);
		if (item === null || item.type !== "skill" && item.type !== "scenario") return null;
		const name = catalogName(item.name, item.type === "scenario");
		const description = catalogDescription(item.description);
		if (name === void 0 || description === void 0) return null;
		const key = `${item.type}:${name}`;
		if (seen.has(key)) return null;
		seen.add(key);
		const group = item.group === void 0 ? void 0 : boundedGroup(item.group);
		if (item.group !== void 0 && group === void 0) return null;
		entries.push({
			type: item.type,
			name,
			description,
			...group === void 0 ? {} : { group }
		});
	}
	const skillCount = entries.filter((entry) => entry.type === "skill").length;
	if (status === "empty" !== (skillCount === 0)) return null;
	return {
		schemaVersion: "1",
		status,
		source: "insuremo-skills",
		fetchedAt,
		expiresAt,
		entries
	};
}
function catalogDescription(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 500 && !/[\u0000-\u001F\u007F]/u.test(value) ? value : void 0;
}
function catalogName(value, scenario) {
	if (typeof value !== "string" || value.length === 0 || value.length > 128) return void 0;
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) return void 0;
	if (scenario && ![
		"icomposer-full-stack",
		"icomposer-coding-lite",
		"icomposer-api-design",
		"uic-developer",
		"ask-insuremo"
	].includes(value)) return void 0;
	return value;
}
function boundedGroup(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9 ._&'()\\-]*$/u.test(value)) return void 0;
	return value;
}
function parseSkillDiagnostic(value) {
	const diagnostic = obj(value);
	const code = safeDiagnosticToken(diagnostic?.code);
	const skill = boundedSkillName(diagnostic?.skill);
	const source = safeSource(diagnostic?.source);
	const reason = safeDiagnosticToken(diagnostic?.reason);
	const contextImpact = diagnostic?.contextImpact;
	if (code === void 0 || skill.length === 0 || source === void 0 || reason === void 0 || contextImpact !== "source-unavailable" && contextImpact !== "source-may-be-unavailable" && contextImpact !== "disabled") return void 0;
	const line = safeLine(diagnostic?.line);
	return {
		code,
		skill,
		source,
		reason,
		...line === void 0 ? {} : { line },
		contextImpact
	};
}
function boundedSkillName(value) {
	if (typeof value !== "string") return "";
	const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return text.length > 0 && text.length <= 128 && !text.includes("/") && !text.includes("\\") ? text : "";
}
function boundedText(value, max) {
	if (typeof value !== "string") return "";
	const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
function safeSource(value) {
	const text = boundedText(value, 32);
	return text.length > 0 && !text.includes("/") && !text.includes("\\") && !text.startsWith("~") ? text : void 0;
}
function safeDiagnosticToken(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > 96 || !/^[a-z0-9][a-z0-9-]*$/.test(value)) return void 0;
	return value;
}
function safeLine(value) {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1e5 ? value : void 0;
}
function boundedCount(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.trunc(value), 1e6) : 0;
}
function obj(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function arr(value) {
	return Array.isArray(value) ? value : [];
}
function str(value, fallback) {
	return typeof value === "string" ? value : fallback;
}
function bool(value) {
	return typeof value === "boolean" && value;
}
function num(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function optStr(key, value) {
	return typeof value === "string" ? { [key]: value } : {};
}
function optBool(key, value) {
	return typeof value === "boolean" ? { [key]: value } : {};
}

//#endregion
//#region ../ui-insuremo-settings/src/client/actions.ts
const ACTIONS_PREFIX$1 = "/api/icomposer-workbench/insuremo/overview/actions";
async function postAction$1(action, body, signal) {
	try {
		const response = await fetch(`${ACTIONS_PREFIX$1}/${action}`, {
			method: "POST",
			credentials: "same-origin",
			headers: {
				"Content-Type": "application/json",
				"X-Workbench-Action": "1",
				Accept: "application/json"
			},
			body: JSON.stringify(body ?? {}),
			signal
		});
		if (!response.ok) {
			const payload$1 = await response.json().catch(() => null);
			if (payload$1 !== null && payload$1.error !== void 0 && typeof payload$1.error.code === "string") return {
				ok: false,
				error: payload$1.error
			};
			return {
				ok: false,
				error: {
					code: "http-error",
					message: `HTTP ${response.status}`
				}
			};
		}
		const payload = await response.json();
		if (payload === null || typeof payload !== "object") return {
			ok: false,
			error: {
				code: "parse-error",
				message: "unexpected response shape"
			}
		};
		if (payload.ok === true && payload.result !== void 0) return {
			ok: true,
			result: payload.result
		};
		if (payload.ok === false && payload.error !== void 0) return {
			ok: false,
			error: payload.error
		};
		return {
			ok: false,
			error: {
				code: "parse-error",
				message: "unexpected response shape"
			}
		};
	} catch {
		return {
			ok: false,
			error: {
				code: "network",
				message: "network-unavailable"
			}
		};
	}
}

//#endregion
//#region ../ui-insuremo-settings/src/client/diagnosis.ts
/** Assemble the localized diagnosis text the user reviews and sends. */
function buildDiagnosisText(diagnosis, t) {
	const scene = operationLabel(diagnosis.operation, t);
	const environment = [
		`node: ${diagnosis.nodeVersion}`,
		`os: ${diagnosis.platform} ${diagnosis.arch}`,
		...diagnosis.packageManager === void 0 ? [] : [`packageManager: ${diagnosis.packageManager}`],
		...diagnosis.registry === void 0 ? [] : [`registry: ${diagnosis.registry}`]
	].join("\n");
	return [
		diagnosis.kind === "imo-cli" ? t("diagTitleImo") : t("diagTitleSkill"),
		`${t("diagSceneLabel")}${scene}${t("diagParenOpen")}${diagnosis.operation}${t("diagParenClose")}`,
		`${t("diagOccurredAtLabel")}${diagnosis.occurredAt}`,
		"",
		t("diagCommandsLabel"),
		commandLines(diagnosis.commands, t),
		"",
		`exitCode: ${diagnosis.exitCode ?? t("diagNotRun")}`,
		...diagnosis.error === void 0 ? [] : [`${t("diagErrorLabel")}${diagnosis.error.code}: ${diagnosis.error.message}`],
		"",
		"stdout：",
		"```",
		diagnosis.stdout === "" ? t("diagEmpty") : diagnosis.stdout,
		"```",
		...diagnosis.stdoutTruncated ? [t("diagStdoutTruncated")] : [],
		"",
		"stderr：",
		"```",
		diagnosis.stderr === "" ? t("diagEmpty") : diagnosis.stderr,
		"```",
		...diagnosis.stderrTruncated ? [t("diagStderrTruncated")] : [],
		"",
		t("diagEnvironmentLabel"),
		environment,
		"",
		t("diagClosing")
	].join("\n");
}
/** Human label for an operation; scenario/source installs carry a suffix. */
function operationLabel(operation, t) {
	if (operation === "imo-install") return t("diagOpImoInstall");
	if (operation === "imo-upgrade") return t("diagOpImoUpgrade");
	if (operation === "skill-update") return t("diagOpSkillUpdate");
	if (operation === "skill-install") return t("diagOpSkillInstall");
	if (operation.startsWith("skill-install:")) return t("diagOpSkillInstallSource");
	return operation;
}
/** One rendered command line with its step number. */
function commandLines(commands, t) {
	if (commands.length === 0) return t("diagNoCommands");
	return commands.map((command, index) => `${index + 1}. ${command}`).join("\n");
}
const pendingPrefills = /* @__PURE__ */ new Map();
const settledPrefills = /* @__PURE__ */ new Map();
const prefillListeners = /* @__PURE__ */ new Set();
function notifyPrefillListeners() {
	for (const listener of [...prefillListeners]) listener();
}
/** Subscribe to queue/settle changes; returns the disposer. */
function subscribeDiagnosisPrefill(listener) {
	prefillListeners.add(listener);
	return () => {
		prefillListeners.delete(listener);
	};
}
/** Queue the first-send diagnosis text for one session (overwrites a prior queue for the same id) and wake subscribers. */
function queueDiagnosisPrefill(sessionId, text) {
	pendingPrefills.set(sessionId, text);
	notifyPrefillListeners();
}
/**
* Consume one session's queued diagnosis text. The text returns only when
* the composer draft is empty; a non-empty draft (user typed first) consumes
* and drops the queue entry so the user's own text is never overwritten, and
* settles the outcome as "dropped" immediately.
*/
function takeDiagnosisPrefill(sessionId, draftIsEmpty) {
	const text = pendingPrefills.get(sessionId);
	if (text === void 0) return void 0;
	pendingPrefills.delete(sessionId);
	if (!draftIsEmpty) settledPrefills.set(sessionId, "dropped");
	notifyPrefillListeners();
	return draftIsEmpty ? text : void 0;
}
/** The entry records a successful `setDraft` write so the card can report the real outcome. */
function settleDiagnosisPrefill(sessionId, outcome) {
	settledPrefills.set(sessionId, outcome);
	notifyPrefillListeners();
}
/**
* Wait for one session's prefill outcome (or timeout). Never throws: a
* timeout means the outcome is unknown — the caller falls back to the copy
* hint instead of claiming a prefill that may not have landed.
*/
function waitForDiagnosisPrefill(sessionId, timeoutMs) {
	const settled = settledPrefills.get(sessionId);
	if (settled !== void 0) return Promise.resolve(settled);
	return new Promise((resolve) => {
		let done = false;
		let dispose;
		const finish = (outcome) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			dispose?.();
			resolve(outcome);
		};
		const timer = setTimeout(() => finish("timeout"), timeoutMs);
		dispose = subscribeDiagnosisPrefill(() => {
			const outcome = settledPrefills.get(sessionId);
			if (outcome !== void 0) finish(outcome);
		});
	});
}
/** In-flight workspace creation keyed by cwd, so concurrent clicks coalesce into one create. */
const ensuringWorkspaces = /* @__PURE__ */ new Map();
function findDiagnosisWorkspace(workspaces, cwd) {
	const items = workspaces.list.getSnapshot().items;
	return items.find((item) => item.path === cwd)?.workspaceId;
}
/**
* Resolve the dedicated install-diagnostics Workspace: reuse the workspace
* already registered for `cwd` (restart reuse), else register it once.
* Concurrent callers share one in-flight attempt; the Host's own create is
* idempotent by path, so even a list-lag race cannot produce a duplicate.
* The friendly title is applied once, best-effort, right after creation —
* a reuse never renames, so a user's own title edit survives.
*/
async function ensureDiagnosisWorkspace(workspaces, cwd, title) {
	const existing = findDiagnosisWorkspace(workspaces, cwd);
	if (existing !== void 0) return existing;
	const inflight = ensuringWorkspaces.get(cwd);
	if (inflight !== void 0) return inflight;
	const attempt = (async () => {
		const created = await workspaces.create({ path: cwd });
		try {
			await workspaces.rename?.(created.workspaceId, title);
		} catch {}
		return created.workspaceId;
	})().finally(() => {
		ensuringWorkspaces.delete(cwd);
	});
	ensuringWorkspaces.set(cwd, attempt);
	return attempt;
}
/** Best-effort clipboard write; `false` means the user must rely on the visible copy button. */
async function copyToClipboard(text) {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
/**
* Open the dedicated diagnosis Workspace's session and queue the prefill.
* Every step rides an unmodified official rc.7 seam; any failure falls back
* to the clipboard WITHOUT creating or opening any session, so the user can
* never be left in an inert Workspace-less composer. The target session id
* is the value `connectWorkspace` RESOLVES (reuse or fresh — never guessed
* from the current view). Never sends anything: the user reviews the
* prefilled text, picks a model, and presses Enter.
*/
async function handOffDiagnosis(text, diagnosisCwd, faces, workspaceTitle) {
	const workspaces = faces?.workspaces;
	const sessions = faces?.sessions;
	if (workspaces === void 0 || sessions === void 0) return {
		kind: "clipboard-only",
		copied: await copyToClipboard(text),
		reason: "faces-unavailable"
	};
	let workspaceId;
	try {
		workspaceId = await ensureDiagnosisWorkspace(workspaces, diagnosisCwd, workspaceTitle);
	} catch {
		return {
			kind: "clipboard-only",
			copied: await copyToClipboard(text),
			reason: "workspace-failed"
		};
	}
	let sessionId;
	try {
		sessionId = await workspaces.connectWorkspace(workspaceId);
	} catch {
		return {
			kind: "clipboard-only",
			copied: await copyToClipboard(text),
			reason: "connect-failed"
		};
	}
	queueDiagnosisPrefill(sessionId, text);
	sessions.open(sessionId);
	return {
		kind: "opened",
		sessionId
	};
}

//#endregion
//#region \0dsh-css:asset
const css$5 = ".wba9e5d119_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:12px;flex-direction:column;font-size:13px;transition:border-color .16s,background .16s;display:flex}.wba9e5d119_card:hover{border-color:var(--dsw-alias-label-dimmed)}.wba9e5d119_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}.wba9e5d119_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.wba9e5d119_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.wba9e5d119_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.wba9e5d119_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.wba9e5d119_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.wba9e5d119_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.wba9e5d119_chevronOpen{transform:rotate(180deg)}.wba9e5d119_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.wba9e5d119_body{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:14px;margin:0 16px;padding:14px 0 8px;display:flex}.wba9e5d119_footer{justify-content:flex-end;align-items:center;gap:8px;padding:4px 0;display:flex}.wba9e5d119_refresh,.wba9e5d119_action{appearance:none;border:1px solid var(--dsw-alias-border-l2);font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.wba9e5d119_refresh:hover,.wba9e5d119_action:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}.wba9e5d119_refresh:focus-visible,.wba9e5d119_action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.wba9e5d119_action:disabled{cursor:not-allowed;opacity:.55}.wba9e5d119_controls{flex-wrap:wrap;align-items:center;gap:8px;margin:0;display:flex}.wba9e5d119_catalog{flex-direction:column;gap:6px;display:flex}.wba9e5d119_catalogTools{flex-wrap:wrap;align-items:center;gap:8px;display:flex}.wba9e5d119_catalogSearch{align-items:center;gap:4px;min-width:min(100%,340px);display:inline-flex}.wba9e5d119_catalogInput{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);min-width:150px;height:32px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;flex:220px;padding:0 10px;font-size:13px}.wba9e5d119_catalogInput:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.wba9e5d119_catalogList{flex-direction:column;gap:4px;max-height:300px;margin:0;padding:0;display:flex;overflow-y:auto}.wba9e5d119_catalogOption{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);width:100%;font:inherit;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;border-radius:8px;flex-direction:column;align-items:stretch;gap:2px;padding:7px 10px;display:flex}.wba9e5d119_catalogOption:hover,.wba9e5d119_catalogOptionSelected{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}.wba9e5d119_catalogOption:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.wba9e5d119_catalogOption:disabled{cursor:not-allowed;opacity:.55}.wba9e5d119_catalogOptionTop{align-items:baseline;gap:8px;display:flex}.wba9e5d119_catalogDescription{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;font-size:12px;line-height:1.45}.wba9e5d119_select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);min-width:220px;height:32px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:13px}.wba9e5d119_select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.wba9e5d119_select:disabled{cursor:not-allowed;opacity:.55}.wba9e5d119_region{flex-direction:column;gap:6px;display:flex}.wba9e5d119_region h4{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;font-weight:600}.wba9e5d119_list{flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;display:flex}.wba9e5d119_list li{flex-wrap:wrap;align-items:center;gap:8px;display:flex}.wba9e5d119_toggle{appearance:none;color:inherit;cursor:pointer;background:0 0;border:0;border-radius:999px;flex:none;align-items:center;padding:2px 0;display:inline-flex}.wba9e5d119_toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.wba9e5d119_toggle:disabled{cursor:not-allowed;opacity:.55}.wba9e5d119_controlTrack{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);width:30px;height:18px;transition:background .12s var(--ds-ease-in-out), border-color .12s var(--ds-ease-in-out);border-radius:999px;align-items:center;display:inline-flex}.wba9e5d119_toggle[aria-checked=true] .wba9e5d119_controlTrack{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary)}.wba9e5d119_controlThumb{background:var(--dsw-alias-bg-layer-1);width:14px;height:14px;transition:transform .12s var(--ds-ease-in-out);border-radius:50%;margin-left:1px;transform:translate(0)}.wba9e5d119_toggle[aria-checked=true] .wba9e5d119_controlThumb{transform:translate(12px)}.wba9e5d119_meta{color:var(--dsw-alias-label-tertiary);font-size:12px}.wba9e5d119_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px}.wba9e5d119_error{color:var(--dsw-alias-state-error-primary);font-size:12px}.wba9e5d119_diagnostic{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;flex:100%;font-size:12px;line-height:1.45}.wba9e5d119_small{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;padding:0 2px;font-size:13px}.wba9e5d119_small:hover{color:var(--dsw-alias-state-error-primary)}";
const tagId$5 = "@icomposer/workbench/InsuremoCard.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$5) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "@icomposer/workbench";
	tag.dataset.pluginCss = tagId$5;
	tag.textContent = css$5;
	document.head.appendChild(tag);
}
var InsuremoCard_module_css_default = {
	"meta": "wba9e5d119_meta",
	"select": "wba9e5d119_select",
	"cardOpen": "wba9e5d119_cardOpen",
	"catalogInput": "wba9e5d119_catalogInput",
	"region": "wba9e5d119_region",
	"chevronOpen": "wba9e5d119_chevronOpen",
	"controlThumb": "wba9e5d119_controlThumb",
	"footer": "wba9e5d119_footer",
	"small": "wba9e5d119_small",
	"controls": "wba9e5d119_controls",
	"header": "wba9e5d119_header",
	"list": "wba9e5d119_list",
	"catalogSearch": "wba9e5d119_catalogSearch",
	"headText": "wba9e5d119_headText",
	"refresh": "wba9e5d119_refresh",
	"body": "wba9e5d119_body",
	"catalogOptionTop": "wba9e5d119_catalogOptionTop",
	"catalogDescription": "wba9e5d119_catalogDescription",
	"catalogOptionSelected": "wba9e5d119_catalogOptionSelected",
	"pending": "wba9e5d119_pending",
	"toggle": "wba9e5d119_toggle",
	"name": "wba9e5d119_name",
	"catalogTools": "wba9e5d119_catalogTools",
	"action": "wba9e5d119_action",
	"chevron": "wba9e5d119_chevron",
	"catalogOption": "wba9e5d119_catalogOption",
	"catalog": "wba9e5d119_catalog",
	"card": "wba9e5d119_card",
	"controlTrack": "wba9e5d119_controlTrack",
	"hint": "wba9e5d119_hint",
	"diagnostic": "wba9e5d119_diagnostic",
	"description": "wba9e5d119_description",
	"error": "wba9e5d119_error",
	"catalogList": "wba9e5d119_catalogList"
};

//#endregion
//#region ../ui-insuremo-settings/src/client/InsuremoCard.tsx
/**
* The InsureMO card inside the Plugins settings tab (TASK-041): collapsed by
* default to a one-line summary (CLI version · default profile · skills
* count); expanding reveals the IMO CLI / Skills / Code Intelligence regions.
* The Auth region was removed — the sidebar ProfilePicker owns profile
* switching. Data loads through the fast channel (`?fast=1`); the Refresh
* button builds the full CLI-backed view.
*/
var InsuremoCard = class extends react.Component {
	state = {
		status: "loading",
		expanded: false
	};
	#controller;
	#autoUpgraded = false;
	componentDidMount() {
		this.load("fast");
	}
	componentWillUnmount() {
		this.#controller?.abort();
	}
	/** Silent refresh for post-action reloads: keeps regions mounted so child state is preserved. */
	async silentReload() {
		try {
			const response = await fetch(`${OVERVIEW_URL$1}?fast=0`, { headers: { Accept: "application/json" } });
			if (!response.ok) return;
			const view = parseOverview(await response.json());
			if (view !== null) this.setState((prev) => ({
				...prev,
				status: "ready",
				view
			}));
		} catch {}
	}
	async load(channel) {
		this.#controller?.abort();
		const controller = new AbortController();
		this.#controller = controller;
		if (channel === "full") this.setState({ status: "loading" });
		try {
			const response = await fetch(`${OVERVIEW_URL$1}?fast=${channel === "fast" ? "1" : "0"}`, {
				signal: controller.signal,
				headers: { Accept: "application/json" }
			});
			if (!response.ok) throw new Error(`overview fetch failed: ${response.status}`);
			const view = parseOverview(await response.json());
			if (view === null) throw new Error("overview payload was not recognized");
			if (!controller.signal.aborted) {
				this.setState((prev) => ({
					...prev,
					status: "ready",
					view
				}));
				if (channel === "fast" && !this.#autoUpgraded && [
					view.imo.code,
					view.skills.code,
					view.auth.code
				].includes("fast-uncached")) {
					this.#autoUpgraded = true;
					this.silentReload();
				}
			}
		} catch {
			if (!controller.signal.aborted && this.state.status !== "ready") this.setState({ status: "error" });
		}
	}
	t(key) {
		return this.props.t(key);
	}
	render() {
		const state = this.state;
		const t = this.t.bind(this);
		const imoCold = state.status === "ready" && state.view.imo.code === "fast-uncached";
		const skillsCold = state.status === "ready" && state.view.skills.code === "fast-uncached";
		const summary = state.status === "ready" ? `${state.view.imo.available ? state.view.imo.current ?? "—" : imoCold ? t("imoLoading") : state.view.imo.code === "not-found" ? t("imoUnavailable") : t("imoDetectFailed")} · ${state.view.auth.activeProfileName ?? "—"} · ${t("skillsTitle")} ${skillsCold ? "…" : `${state.view.skills.enabled}/${state.view.skills.installed}`}` : state.status === "loading" ? t("loading") : t("error");
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
			className: `${InsuremoCard_module_css_default.card}${state.expanded ? ` ${InsuremoCard_module_css_default.cardOpen}` : ""}`,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: InsuremoCard_module_css_default.header,
				"aria-expanded": state.expanded,
				"aria-label": `${t(state.expanded ? "collapse" : "expand")}: ${t("title")}`,
				onClick: () => this.setState((prev) => ({
					...prev,
					expanded: !prev.expanded
				})),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
						className: InsuremoCard_module_css_default.headText,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: InsuremoCard_module_css_default.name,
							children: t("title")
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: InsuremoCard_module_css_default.description,
							"data-summary": "1",
							children: summary
						})]
					}),
					state.status === "ready" && state.view.imo.updateAvailable ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: InsuremoCard_module_css_default.pending,
						children: t("imoUpdateAvailable")
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ChevronIcon, { className: `${InsuremoCard_module_css_default.chevron}${state.expanded ? ` ${InsuremoCard_module_css_default.chevronOpen}` : ""}` })
				]
			}), state.expanded ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: InsuremoCard_module_css_default.body,
				children: [
					state.status === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: InsuremoCard_module_css_default.hint,
						"data-skeleton": "1",
						"aria-busy": "true",
						children: t("loading")
					}) : null,
					state.status === "error" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: InsuremoCard_module_css_default.error,
						children: t("error")
					}) : null,
					state.status === "ready" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ImoRegion, {
							t,
							imo: state.view.imo,
							onChanged: () => void this.silentReload(),
							faces: this.props.diagnosisFaces
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SkillsRegion, {
							t,
							skills: state.view.skills,
							onChanged: () => void this.silentReload(),
							faces: this.props.diagnosisFaces
						}),
						state.view.ici !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IciRegion, {
							t,
							ici: state.view.ici
						}) : null
					] }) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: InsuremoCard_module_css_default.footer,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: InsuremoCard_module_css_default.refresh,
							onClick: () => void this.load("full"),
							"aria-label": t("refresh"),
							children: t("refresh")
						})
					})
				]
			}) : null]
		});
	}
};
function ImoRegion(props) {
	const { t, imo } = props;
	if (imo.code === "fast-uncached") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: InsuremoCard_module_css_default.region,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("imoTitle") }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			className: InsuremoCard_module_css_default.hint,
			"data-skeleton": "1",
			"aria-busy": "true",
			children: t("imoLoading")
		})]
	});
	const missing = !imo.available && imo.code === "not-found";
	const failed = !imo.available && !missing;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: InsuremoCard_module_css_default.region,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("imoTitle") }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
				t("imoCurrent"),
				": ",
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
					"data-imo-state": imo.available ? "ok" : missing ? "missing" : "error",
					children: imo.available ? imo.current ?? "—" : missing ? t("imoUnavailable") : t("imoDetectFailed")
				}),
				imo.updateAvailable && imo.target !== void 0 ? ` → ${imo.target}` : ""
			] }),
			failed ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				role: "alert",
				"data-imo-state": "error",
				className: InsuremoCard_module_css_default.error,
				children: [
					t("imoDetectFailed"),
					": ",
					imo.code
				]
			}) : null,
			imo.available ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(UpgradeButton, {
				t,
				imo,
				onChanged: props.onChanged,
				faces: props.faces
			}) : null,
			missing ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InstallButton, {
				t,
				onChanged: props.onChanged,
				faces: props.faces
			}) : null
		]
	});
}
/**
* One-shot IMO CLI installer (TASK-076): rendered only while the overview
* reports the CLI unavailable. The visible hint names both side effects —
* the user-level @insuremo registry write and the global package install —
* and the failure line explains why retrying without rollback is safe.
*/
var InstallButton = class extends react.Component {
	state = { install: { phase: "idle" } };
	async run() {
		this.setState({ install: { phase: "busy" } });
		const outcome = await postAction$1("imo-install", {});
		if (outcome.ok && outcome.result.status === "completed") {
			this.setState({ install: {
				phase: "done",
				message: outcome.result.currentVersion ?? "?"
			} });
			this.props.onChanged();
		} else if (outcome.ok) this.setState({ install: {
			phase: "failed",
			message: "post-install probe failed"
		} });
		else {
			const message = outcome.error.code === "network" ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
			this.setState({ install: {
				phase: "failed",
				message
			} });
		}
	}
	render() {
		const { t } = this.props;
		const busy = this.state.install.phase === "busy";
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				disabled: busy,
				"aria-busy": busy,
				onClick: () => void this.run(),
				"aria-label": busy ? t("cliInstalling") : t("cliInstall"),
				children: busy ? t("cliInstalling") : t("cliInstall")
			}),
			this.state.install.phase === "done" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				role: "status",
				"data-install": "done",
				children: [
					t("cliInstalled"),
					": ",
					this.state.install.message
				]
			}) : null,
			this.state.install.phase === "failed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				role: "alert",
				"data-install": "failed",
				className: InsuremoCard_module_css_default.error,
				children: [
					t("cliInstallFailed"),
					": ",
					this.state.install.message
				]
			}) : null
		] }), this.state.install.phase === "failed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
			className: InsuremoCard_module_css_default.hint,
			"data-install-retry": "1",
			children: [
				t("cliInstallRetryHint"),
				" ",
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiagnoseButton, {
					t,
					kind: "imo-cli",
					faces: this.props.faces
				})
			]
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			className: InsuremoCard_module_css_default.hint,
			children: t("cliInstallHint")
		})] });
	}
};
/**
* One failure state's 诊断 affordance (TASK-083/088): rendered only while
* that install/update operation is failed. Clicking fetches the last
* failure's full capture from the `imo-diagnosis` action, then hands off
* through the dedicated persistent "install diagnostics" Workspace on
* official rc.7 seams only (TASK-088): the target session id is what
* `connectWorkspace` resolves, the prefill lands via the session-scope
* `inputActions.setDraft` kit, and the status reflects the REAL outcome —
* a dropped (user-first) or unconfirmed prefill never reports "prefilled".
* A visible copy button is the always-available fallback. Never rendered on
* success or without a captured failure; never auto-sends.
*/
var DiagnoseButton = class extends react.Component {
	state = {
		phase: "idle",
		lastText: null,
		copyFlash: false
	};
	async run() {
		this.setState({ phase: "busy" });
		const outcome = await postAction$1("imo-diagnosis", { kind: this.props.kind });
		if (!outcome.ok) {
			this.setState({ phase: "failed" });
			return;
		}
		if (!outcome.result.available || outcome.result.diagnosis === void 0 || outcome.result.diagnosisCwd === void 0) {
			this.setState({ phase: "no-data" });
			return;
		}
		try {
			const text = buildDiagnosisText(outcome.result.diagnosis, this.props.t);
			const handoff = await handOffDiagnosis(text, outcome.result.diagnosisCwd, this.props.faces, this.props.t("diagWorkspaceTitle"));
			if (handoff.kind === "clipboard-only") {
				this.setState({
					phase: "clipboard-only",
					lastText: text
				});
				return;
			}
			const prefill = await waitForDiagnosisPrefill(handoff.sessionId, 1500);
			if (prefill === "written") {
				this.setState({
					phase: "prefilled",
					lastText: text
				});
				document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
				return;
			}
			this.setState({
				phase: prefill === "dropped" ? "draft-occupied" : "copied",
				lastText: text
			});
		} catch {
			this.setState({ phase: "failed" });
		}
	}
	copyText() {
		const { lastText } = this.state;
		if (lastText === null) return;
		navigator.clipboard.writeText(lastText).then(() => {
			this.setState({ copyFlash: true });
			setTimeout(() => {
				this.setState({ copyFlash: false });
			}, 1500);
		}).catch(() => {});
	}
	render() {
		const { t } = this.props;
		const busy = this.state.phase === "busy";
		const showCopy = this.state.lastText !== null && (this.state.phase === "prefilled" || this.state.phase === "draft-occupied" || this.state.phase === "copied" || this.state.phase === "clipboard-only");
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
			"data-diagnosis": "1",
			children: [
				" ",
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: InsuremoCard_module_css_default.action,
					disabled: busy,
					"aria-busy": busy || void 0,
					onClick: () => void this.run(),
					"aria-label": busy ? t("diagBusy") : t("diagButton"),
					children: busy ? t("diagBusy") : t("diagButton")
				}),
				this.state.phase === "prefilled" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					role: "status",
					"data-diagnosis-state": "prefilled",
					className: InsuremoCard_module_css_default.hint,
					children: t("diagPrefilled")
				}) : null,
				this.state.phase === "draft-occupied" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					role: "status",
					"data-diagnosis-state": "draft-occupied",
					className: InsuremoCard_module_css_default.hint,
					children: t("diagDraftOccupied")
				}) : null,
				this.state.phase === "copied" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					role: "status",
					"data-diagnosis-state": "copied",
					className: InsuremoCard_module_css_default.hint,
					children: t("diagCopied")
				}) : null,
				this.state.phase === "clipboard-only" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					role: "status",
					"data-diagnosis-state": "clipboard-only",
					className: InsuremoCard_module_css_default.hint,
					children: t("diagClipboardOnly")
				}) : null,
				showCopy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					className: InsuremoCard_module_css_default.action,
					"data-diagnosis-copy": "1",
					onClick: () => this.copyText(),
					"aria-label": t("diagCopy"),
					children: this.state.copyFlash ? t("diagCopyFlash") : t("diagCopy")
				}) : null,
				this.state.phase === "no-data" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					role: "alert",
					"data-diagnosis-state": "no-data",
					className: InsuremoCard_module_css_default.error,
					children: t("diagNoData")
				}) : null,
				this.state.phase === "failed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					role: "alert",
					"data-diagnosis-state": "failed",
					className: InsuremoCard_module_css_default.error,
					children: t("diagActionFailed")
				}) : null
			]
		});
	}
};
var UpgradeButton = class extends react.Component {
	state = { upgrade: { phase: "idle" } };
	async run() {
		this.setState({ upgrade: { phase: "busy" } });
		const outcome = await postAction$1("imo-upgrade", {});
		if (outcome.ok) {
			this.setState({ upgrade: {
				phase: "done",
				message: `${this.props.imo.current ?? "?"} → ${outcome.result.currentVersion ?? "?"}`
			} });
			this.props.onChanged();
		} else {
			const message = outcome.error.code === "network" ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
			this.setState({ upgrade: {
				phase: "failed",
				message
			} });
		}
	}
	render() {
		const { t, imo } = this.props;
		const busy = imo.busy === true || this.state.upgrade.phase === "busy";
		if (!imo.available || !imo.updateAvailable) return null;
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
				type: "button",
				disabled: busy,
				onClick: () => void this.run(),
				"aria-label": busy ? t("cliUpdating") : t("cliUpdate"),
				children: busy ? t("cliUpdating") : t("cliUpdate")
			}),
			this.state.upgrade.phase === "done" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				role: "status",
				"data-upgrade": "done",
				children: [
					t("cliUpdated"),
					": ",
					this.state.upgrade.message
				]
			}) : null,
			this.state.upgrade.phase === "failed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				role: "alert",
				"data-upgrade": "failed",
				className: InsuremoCard_module_css_default.error,
				children: [
					t("cliUpdateFailed"),
					": ",
					this.state.upgrade.message,
					" ",
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiagnoseButton, {
						t,
						kind: "imo-cli",
						faces: this.props.faces
					})
				]
			}) : null
		] });
	}
};
/** Allowlisted server scenario ids (TASK-079): no arbitrary agent/source argv. */
const SKILL_SCENARIOS = [
	"icomposer-full-stack",
	"icomposer-coding-lite",
	"icomposer-api-design",
	"uic-developer",
	"ask-insuremo"
];
const SCENARIO_DESCRIPTION_KEYS = {
	"icomposer-full-stack": "skillsCatalogDescriptionFullStack",
	"icomposer-coding-lite": "skillsCatalogDescriptionCodingLite",
	"icomposer-api-design": "skillsCatalogDescriptionApiDesign",
	"uic-developer": "skillsCatalogDescriptionUic",
	"ask-insuremo": "skillsCatalogDescriptionAsk"
};
function diffOf(result) {
	return {
		added: result.added ?? [],
		updated: result.updated ?? [],
		removed: result.removed ?? []
	};
}
function diffText(diff, t) {
	const parts = [];
	if (diff.added.length > 0) parts.push(`${t("skillsAdded")} ${diff.added.length}: ${diff.added.join(", ")}`);
	if (diff.updated.length > 0) parts.push(`${t("skillsUpdated")} ${diff.updated.length}: ${diff.updated.join(", ")}`);
	if (diff.removed.length > 0) parts.push(`${t("skillsRemoved")} ${diff.removed.length}: ${diff.removed.join(", ")}`);
	return parts.join(" · ");
}
function catalogKey(entry) {
	return `${entry.type}:${entry.name}`;
}
var SkillsRegion = class extends react.Component {
	state = {
		rows: {},
		updatingAll: false,
		scenario: SKILL_SCENARIOS[0],
		scenarioRun: { phase: "idle" },
		catalog: { phase: "idle" },
		catalogQuery: ""
	};
	#catalogController;
	#catalogRequest = 0;
	componentDidMount() {
		this.loadCatalog(false);
	}
	componentWillUnmount() {
		this.#catalogController?.abort();
	}
	commitCatalog(view, controller, request) {
		if (controller.signal.aborted || request !== this.#catalogRequest) return;
		const currentChoice = this.state.catalogChoice;
		const choice = currentChoice !== void 0 && view.entries.some((entry) => catalogKey(entry) === currentChoice) ? currentChoice : catalogKey(view.entries[0]);
		this.setState((prev) => ({
			...prev,
			catalog: {
				phase: "ready",
				view
			},
			catalogChoice: choice
		}));
	}
	async loadCatalog(force) {
		this.#catalogController?.abort();
		const controller = new AbortController();
		const request = ++this.#catalogRequest;
		this.#catalogController = controller;
		this.setState((prev) => ({
			...prev,
			catalog: { phase: "loading" }
		}));
		if (!force) {
			try {
				const response = await fetch(SKILL_CATALOG_URL, {
					signal: controller.signal,
					headers: { Accept: "application/json" }
				});
				if (response.ok) {
					const view$1 = parseSkillCatalog(await response.json());
					if (view$1 !== null) {
						this.commitCatalog(view$1, controller, request);
						return;
					}
				}
			} catch {}
			if (controller.signal.aborted || request !== this.#catalogRequest) return;
		}
		const outcome = await postAction$1("skill-catalog-refresh", { force }, controller.signal);
		if (controller.signal.aborted || request !== this.#catalogRequest) return;
		if (!outcome.ok) {
			this.setState((prev) => ({
				...prev,
				catalog: {
					phase: "unavailable",
					message: `${outcome.error.code}: ${outcome.error.message}`
				}
			}));
			return;
		}
		const view = parseSkillCatalog(outcome.result);
		if (view === null) {
			this.setState((prev) => ({
				...prev,
				catalog: {
					phase: "unavailable",
					message: this.props.t("skillsCatalogUnavailable")
				}
			}));
			return;
		}
		this.commitCatalog(view, controller, request);
	}
	catalogDescription(entry, t) {
		if (entry.type !== "scenario") return entry.description;
		const key = SCENARIO_DESCRIPTION_KEYS[entry.name];
		return key === void 0 ? entry.description : t(key);
	}
	filteredCatalog(view, t) {
		const query = this.state.catalogQuery.trim().toLocaleLowerCase();
		if (query.length === 0) return view.entries;
		return view.entries.filter((entry) => {
			const typeLabel = entry.type === "scenario" ? t("skillsCatalogScenario") : t("skillsCatalogSkill");
			return `${entry.name} ${this.catalogDescription(entry, t)} ${entry.type} ${typeLabel} ${entry.group ?? ""}`.toLocaleLowerCase().includes(query);
		});
	}
	selectedCatalog(view, visible = view.entries) {
		const selected = view.entries.find((entry) => catalogKey(entry) === this.state.catalogChoice);
		return selected !== void 0 && visible.some((entry) => catalogKey(entry) === catalogKey(selected)) ? selected : visible[0];
	}
	componentDidUpdate() {
		const confirmed = new Set((this.props.skills.entries ?? []).filter((entry) => {
			const row = this.state.rows[entry.name];
			return row?.enabled !== void 0 && row.enabled === entry.enabled;
		}).map((entry) => entry.name));
		if (confirmed.size === 0) return;
		this.setState((prev) => {
			const rows = { ...prev.rows };
			for (const name of confirmed) {
				const row = rows[name];
				if (row === void 0 || row.enabled === void 0) continue;
				const { enabled: _enabled,...rest } = row;
				rows[name] = rest;
			}
			return {
				...prev,
				rows
			};
		});
	}
	get #busy() {
		return this.state.updatingAll || this.state.scenarioRun.phase === "busy" || this.state.catalog.phase === "loading";
	}
	/** Last-write-wins (TASK-041): server commits on its own revision; no CAS storms. */
	async toggle(name, next, previous) {
		this.setState((prev) => ({ rows: {
			...prev.rows,
			[name]: {
				enabled: next,
				busy: true
			}
		} }));
		const outcome = await postAction$1("skill-activation", {
			name,
			enabled: next
		});
		if (outcome.ok) {
			this.setState((prev) => ({ rows: {
				...prev.rows,
				[name]: {
					enabled: next,
					busy: false
				}
			} }));
			this.props.onChanged();
		} else {
			const conflict = outcome.error.code === "revision-conflict";
			const network = outcome.error.code === "network";
			const message = network ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
			this.setState((prev) => ({ rows: {
				...prev.rows,
				[name]: {
					enabled: previous,
					error: message,
					...conflict ? { retry: true } : {}
				}
			} }));
			if (conflict) this.props.onChanged();
		}
	}
	/** `imo skills update --all` equivalent: only already-installed sources. */
	async updateAll() {
		if (this.#busy) return;
		this.setState({
			updatingAll: true,
			updateError: void 0,
			updateResult: void 0
		});
		const outcome = await postAction$1("skill-update", {});
		if (outcome.ok) {
			const result = outcome.result;
			this.setState({
				updatingAll: false,
				updateResult: result,
				updateError: result.status === "completed" ? void 0 : `${result.status}`
			});
			this.props.onChanged();
		} else {
			const message = outcome.error.code === "network" ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
			this.setState({
				updatingAll: false,
				updateError: message
			});
		}
	}
	/** Explicit install/sync of the selected scenario or exact catalog Skill. */
	async syncSelected() {
		if (this.#busy) return;
		const catalog = this.state.catalog;
		const selected = catalog.phase === "ready" ? this.selectedCatalog(catalog.view, this.filteredCatalog(catalog.view, (key) => this.props.t(key))) : void 0;
		const payload = selected === void 0 ? { scenario: this.state.scenario } : selected.type === "scenario" ? { scenario: selected.name } : { skill: selected.name };
		this.setState({ scenarioRun: { phase: "busy" } });
		const outcome = await postAction$1("skill-install", payload);
		if (outcome.ok) {
			const result = outcome.result;
			const diff = diffOf(result);
			this.setState({ scenarioRun: result.status === "completed" ? {
				phase: "done",
				diff
			} : {
				phase: "failed",
				message: result.status,
				diff
			} });
			this.props.onChanged();
		} else {
			const catalogFailure = outcome.error.code === "catalog-unavailable" || outcome.error.code === "catalog-selection-invalid";
			const message = outcome.error.code === "network" ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
			this.setState((prev) => ({
				...prev,
				...catalogFailure ? { catalog: {
					phase: "unavailable",
					message: this.props.t("skillsCatalogUnavailable")
				} } : {},
				scenarioRun: {
					phase: "failed",
					message
				}
			}));
		}
	}
	renderCatalogPicker(t, busy) {
		const catalog = this.state.catalog;
		if (catalog.phase === "ready") {
			const filtered = this.filteredCatalog(catalog.view, t);
			const selected = this.selectedCatalog(catalog.view, filtered);
			const selectedKey = selected === void 0 ? void 0 : catalogKey(selected);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: InsuremoCard_module_css_default.catalog,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: InsuremoCard_module_css_default.catalogTools,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: InsuremoCard_module_css_default.catalogSearch,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: InsuremoCard_module_css_default.meta,
									children: t("skillsCatalogSearch")
								}),
								" ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "search",
									className: InsuremoCard_module_css_default.catalogInput,
									value: this.state.catalogQuery,
									placeholder: t("skillsCatalogSearchPlaceholder"),
									"aria-label": t("skillsCatalogSearch"),
									onChange: (event) => this.setState({ catalogQuery: event.target.value.slice(0, 256) })
								})
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: InsuremoCard_module_css_default.action,
							disabled: busy,
							onClick: () => void this.loadCatalog(true),
							"aria-label": t("skillsCatalogRefresh"),
							children: t("skillsCatalogRefresh")
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: InsuremoCard_module_css_default.catalogList,
						role: "listbox",
						"aria-label": t("skillsCatalogTitle"),
						"aria-multiselectable": "false",
						children: filtered.map((entry, index) => {
							const key = catalogKey(entry);
							const isSelected = key === selectedKey;
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
								type: "button",
								role: "option",
								className: `${InsuremoCard_module_css_default.catalogOption}${isSelected ? ` ${InsuremoCard_module_css_default.catalogOptionSelected}` : ""}`,
								"aria-selected": isSelected,
								"aria-label": `${entry.type === "scenario" ? t("skillsCatalogScenario") : t("skillsCatalogSkill")}: ${entry.name}`,
								"data-catalog-entry": key,
								disabled: busy,
								onClick: () => this.setState({
									catalogChoice: key,
									scenarioRun: { phase: "idle" }
								}),
								onKeyDown: (event) => {
									if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
									event.preventDefault();
									const nextIndex = event.key === "ArrowDown" ? Math.min(filtered.length - 1, index + 1) : Math.max(0, index - 1);
									const next = filtered[nextIndex];
									if (next !== void 0) this.setState({ catalogChoice: catalogKey(next) });
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: InsuremoCard_module_css_default.catalogOptionTop,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: InsuremoCard_module_css_default.meta,
										children: entry.type === "scenario" ? t("skillsCatalogScenario") : t("skillsCatalogSkill")
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: entry.name })]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: InsuremoCard_module_css_default.catalogDescription,
									children: this.catalogDescription(entry, t)
								})]
							}, key);
						})
					}),
					catalog.view.status === "empty" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: InsuremoCard_module_css_default.hint,
						"data-catalog-state": "empty",
						children: t("skillsCatalogEmpty")
					}) : null,
					filtered.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: InsuremoCard_module_css_default.hint,
						children: t("skillsCatalogNoMatch")
					}) : null
				]
			});
		}
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: InsuremoCard_module_css_default.catalog,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: InsuremoCard_module_css_default.catalogTools,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: InsuremoCard_module_css_default.meta,
							children: t("skillsScenarioLabel")
						}),
						" ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
							className: InsuremoCard_module_css_default.select,
							value: this.state.scenario,
							disabled: busy,
							"aria-label": t("skillsScenarioLabel"),
							onChange: (event) => this.setState({
								scenario: event.target.value,
								scenarioRun: { phase: "idle" }
							}),
							children: SKILL_SCENARIOS.map((id) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: id,
								children: id
							}, id))
						})
					] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: InsuremoCard_module_css_default.action,
						disabled: catalog.phase === "loading" || busy,
						"aria-busy": catalog.phase === "loading" || void 0,
						onClick: () => void this.loadCatalog(true),
						"aria-label": catalog.phase === "loading" ? t("skillsCatalogLoading") : t("skillsCatalogRefresh"),
						children: catalog.phase === "loading" ? t("skillsCatalogLoading") : t("skillsCatalogRefresh")
					})]
				}),
				catalog.phase === "loading" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: InsuremoCard_module_css_default.hint,
					role: "status",
					"aria-busy": "true",
					children: t("skillsCatalogLoading")
				}) : null,
				catalog.phase === "unavailable" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: InsuremoCard_module_css_default.error,
					role: "alert",
					"data-catalog-state": "unavailable",
					children: [t("skillsCatalogUnavailable"), catalog.message === void 0 ? "" : ` · ${catalog.message}`]
				}) : null
			]
		});
	}
	render() {
		const { t, skills } = this.props;
		const entries = skills.entries ?? [];
		const cold = skills.code === "fast-uncached";
		const busy = this.#busy;
		const run = this.state.scenarioRun;
		const catalogView = this.state.catalog.phase === "ready" ? this.state.catalog.view : void 0;
		const visibleCatalog = catalogView === void 0 ? [] : this.filteredCatalog(catalogView, t);
		const selected = catalogView === void 0 ? void 0 : this.selectedCatalog(catalogView, visibleCatalog);
		const noCatalogMatch = catalogView !== void 0 && visibleCatalog.length === 0;
		const isSingleSelection = selected?.type === "skill";
		const installingLabel = selected === void 0 ? t("skillsScenarioInstall") : t("skillsCatalogInstall");
		const installingBusyLabel = selected === void 0 ? t("skillsScenarioInstalling") : t("skillsCatalogInstalling");
		const installingDoneLabel = isSingleSelection ? t("skillsCatalogDone") : t("skillsScenarioDone");
		const installingFailedLabel = isSingleSelection ? t("skillsCatalogFailed") : t("skillsScenarioFailed");
		const installingName = selected?.name ?? this.state.scenario;
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: InsuremoCard_module_css_default.region,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("skillsTitle") }),
				skills.code === "scan-failed" || skills.code === "unavailable" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					role: "alert",
					"data-skills-scan": "failed",
					className: InsuremoCard_module_css_default.error,
					children: t("skillsScanFailed")
				}) : null,
				skills.diagnosticCount > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					role: "alert",
					"data-skills-diagnostics": "summary",
					className: InsuremoCard_module_css_default.error,
					children: [
						t("skillsDiagnosticsSummary"),
						": ",
						t("skillsFormatInvalidCount"),
						" ",
						skills.formatInvalidCount,
						" · ",
						t("skillsPathIssueCount"),
						" ",
						skills.pathIssueCount,
						skills.diagnosticsTruncated ? ` · ${t("skillsDiagnosticsVisible")} ${skills.diagnosticCount}` : ""
					]
				}) : null,
				this.renderCatalogPicker(t, busy),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: InsuremoCard_module_css_default.controls,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: InsuremoCard_module_css_default.action,
						disabled: busy || noCatalogMatch,
						"aria-busy": run.phase === "busy" || void 0,
						onClick: () => void this.syncSelected(),
						"aria-label": `${installingLabel}: ${installingName}`,
						children: run.phase === "busy" ? installingBusyLabel : installingLabel
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						className: InsuremoCard_module_css_default.action,
						disabled: busy,
						"aria-busy": this.state.updatingAll || void 0,
						onClick: () => void this.updateAll(),
						"aria-label": `${t("skillsUpdateAll")} · ${t("skillsScopeHint")}`,
						children: this.state.updatingAll ? t("skillsUpdatingAll") : t("skillsUpdateAll")
					})]
				}),
				run.phase === "done" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					role: "status",
					"data-scenario": "done",
					children: [installingDoneLabel, run.diff === void 0 ? "" : `: ${diffText(run.diff, t)}`]
				}) : null,
				run.phase === "failed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					role: "alert",
					"data-scenario": "failed",
					className: InsuremoCard_module_css_default.error,
					children: [
						installingFailedLabel,
						": ",
						run.message,
						run.diff === void 0 ? "" : ` · ${diffText(run.diff, t)}`,
						" · ",
						t("skillsRetryHint"),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiagnoseButton, {
							t,
							kind: "skill",
							faces: this.props.faces
						})
					]
				}) : null,
				this.state.updateResult !== void 0 && this.state.updateResult.status === "completed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					role: "status",
					"data-update": "done",
					children: [
						t("skillsUpdateDone"),
						": ",
						diffText(diffOf(this.state.updateResult), t) || "0"
					]
				}) : null,
				this.state.updateError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					role: "alert",
					"data-update": "failed",
					className: InsuremoCard_module_css_default.error,
					children: [
						t("skillsUpdateFailed"),
						": ",
						this.state.updateError,
						this.state.updateResult !== void 0 && this.state.updateResult.status !== "completed" ? ` · ${diffText(diffOf(this.state.updateResult), t)}` : "",
						" · ",
						t("skillsRetryHint"),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DiagnoseButton, {
							t,
							kind: "skill",
							faces: this.props.faces
						})
					]
				}) : null,
				cold ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: InsuremoCard_module_css_default.hint,
					"data-skeleton": "1",
					"aria-busy": "true",
					children: t("skillsLoadingSlow")
				}) : entries.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
					t("skillsNone"),
					" · ",
					t("skillsInstallFirstHint")
				] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: InsuremoCard_module_css_default.list,
					children: entries.map((entry) => {
						const row = this.state.rows[entry.name] ?? {};
						const enabled = row.enabled ?? entry.enabled;
						const rowBusy = row.busy === true || busy;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								role: "switch",
								className: InsuremoCard_module_css_default.toggle,
								"aria-checked": enabled,
								"aria-busy": row.busy === true || void 0,
								"aria-label": `${t("skillsToggle")}: ${entry.name}`,
								disabled: rowBusy,
								onClick: () => void this.toggle(entry.name, !enabled, entry.enabled),
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: InsuremoCard_module_css_default.controlTrack,
									"aria-hidden": "true",
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: InsuremoCard_module_css_default.controlThumb })
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: entry.name }),
							!enabled ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: InsuremoCard_module_css_default.meta,
								"data-skill-state": "disabled",
								children: t("skillsDisabledState")
							}) : null,
							entry.diagnostic !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(SkillDiagnosticView, {
								t,
								diagnostic: entry.diagnostic
							}) : null,
							row.error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								role: "alert",
								className: InsuremoCard_module_css_default.error,
								children: [row.error, row.retry === true ? ` · ${t("skillsRetryHint")}` : ""]
							}) : null
						] }, entry.name);
					})
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: InsuremoCard_module_css_default.hint,
					children: t("skillsScopeHint")
				})
			]
		});
	}
};
function SkillDiagnosticView(props) {
	const { t, diagnostic } = props;
	const format = isFormatDiagnostic(diagnostic.reason);
	const reason = skillReasonLabel(diagnostic.reason, t);
	const impact = diagnostic.contextImpact === "disabled" ? t("skillsDiagnosticImpactDisabled") : diagnostic.contextImpact === "source-unavailable" ? t("skillsDiagnosticImpactUnavailable") : t("skillsDiagnosticImpactMaybe");
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		role: "alert",
		className: InsuremoCard_module_css_default.diagnostic,
		"data-skill-diagnostic": diagnostic.skill,
		"data-skill-diagnostic-code": diagnostic.code,
		children: [
			format ? t("skillsDiagnosticFormat") : t("skillsDiagnosticPath"),
			" · ",
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: diagnostic.code }),
			" · ",
			t("skillsDiagnosticSource"),
			": ",
			diagnostic.source,
			" · ",
			t("skillsDiagnosticReason"),
			": ",
			reason,
			diagnostic.line === void 0 ? "" : ` · ${t("skillsDiagnosticLine")} ${diagnostic.line}`,
			" · ",
			impact
		]
	});
}
function isFormatDiagnostic(reason) {
	return reason.startsWith("frontmatter-") || reason === "skill-file-too-large";
}
function skillReasonLabel(reason, t) {
	const labels = {
		"frontmatter-unclosed": "skillsReasonFrontmatterUnclosed",
		"frontmatter-too-large": "skillsReasonFrontmatterTooLarge",
		"frontmatter-yaml-invalid": "skillsReasonFrontmatterYaml",
		"frontmatter-root-invalid": "skillsReasonFrontmatterRoot",
		"frontmatter-field-type-invalid": "skillsReasonFieldType",
		"frontmatter-field-too-large": "skillsReasonFieldTooLarge",
		"skill-file-too-large": "skillsReasonFileTooLarge",
		"outside-allowed-root": "skillsReasonPathOutside",
		"missing-directory": "skillsReasonMissingDirectory",
		"path-unreadable": "skillsReasonPathUnreadable",
		"not-directory": "skillsReasonNotDirectory",
		"missing-skill-md": "skillsReasonManifestMissing",
		"skill-md-unreadable": "skillsReasonManifestUnreadable"
	};
	return t(labels[reason] ?? "skillsReasonUnknown");
}
function IciRegion(props) {
	const { t, ici } = props;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: InsuremoCard_module_css_default.region,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("iciTitle") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
			t("iciGraphWorkspaces"),
			": ",
			ici.graphWorkspaces,
			" · ",
			t("iciExplainWorkspaces"),
			": ",
			ici.explainWorkspaces
		] })]
	});
}

//#endregion
//#region ../ui-insuremo-settings/src/client/prefill-slot.tsx
/**
* Consume the queued diagnosis prefill for the current session. Two triggers
* make consumption independent of mount timing: the effect after EVERY
* render (the map lookup is the guard, so an empty map is a cheap no-op),
* and a subscription to the registry that re-renders the entry when a queue
* or settle lands — an ALREADY-MOUNTED entry consumes without waiting for
* any unrelated render. Delivery rules: write only while the composer draft
* is empty (user-first), consume at most once, settle the real outcome so
* the card never claims a prefill that did not land.
*/
function DiagnosisPrefillEntry({ sessionId, useInput, inputActions }) {
	const draft = useInput((state) => state.draft);
	const [, bump] = (0, react.useReducer)((count) => count + 1, 0);
	(0, react.useEffect)(() => subscribeDiagnosisPrefill(bump), [bump]);
	(0, react.useEffect)(() => {
		if (inputActions === void 0) return;
		const text = takeDiagnosisPrefill(sessionId, draft === "");
		if (text === void 0) return;
		try {
			inputActions.setDraft(text);
			settleDiagnosisPrefill(sessionId, "written");
		} catch {}
	});
	return null;
}
/**
* Register the silent prefill entry once per client apply. The inject/register
* pair mirrors the official ui-agent-preset header-actions registration. The
* slot is `conversation.input.dock` (NOT `conversation.session.header.actions`):
* rc.7 hides the whole session header (`ConversationSessionHeader`
* `hideChrome`) while a fresh session is blank, so a header-actions entry can
* never mount to prefill a NEW diagnosis session — while `input.dock` renders
* for every current session, blank/HERO included.
*/
function registerDiagnosisPrefillSlot(ctx) {
	ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
		name: "conversation.input.dock",
		id: "insuremo-diagnosis-prefill",
		order: 900
	}, DiagnosisPrefillEntry));
}

//#endregion
//#region ../ui-insuremo-settings/src/client/locales.ts
/** Copy for the InsureMO Settings section (read-only overview). */
const zh$2 = {
	nav: "InsureMO",
	title: "InsureMO 概览",
	loading: "正在读取 InsureMO 概览…",
	expand: "展开",
	collapse: "收起",
	error: "无法读取 InsureMO 概览",
	errorHint: "请检查 IMO CLI 配置或稍后重试。",
	refresh: "刷新",
	yes: "是",
	no: "否",
	status: "InsureMO 概览状态",
	imoTitle: "IMO CLI",
	imoLoading: "正在检测 IMO CLI…",
	imoDetectFailed: "IMO CLI 检测失败",
	imoUnavailable: "未检测到 IMO CLI",
	imoCurrent: "当前版本",
	imoTarget: "可用版本",
	imoUpToDate: "已是最新版本",
	imoUpdateAvailable: "有可用更新",
	authTitle: "认证",
	authColumn: "配置",
	envColumn: "环境",
	tenantColumn: "租户",
	validColumn: "有效性",
	authProfiles: "配置数",
	authDefault: "默认配置",
	authNone: "无",
	authValid: "有效",
	authInvalid: "无效",
	skillsTitle: "Skills",
	skillsInstalled: "已安装",
	skillsValid: "有效",
	skillsEnabled: "已启用",
	skillsDisabled: "已禁用",
	skillsNames: "列表",
	skillsNone: "未安装",
	skillsLoadingSlow: "正在扫描 Skills 清单…",
	skillsDiagnosticsSummary: "Skills 异常",
	skillsFormatInvalidCount: "格式异常",
	skillsPathIssueCount: "路径异常",
	skillsDiagnosticsVisible: "仅显示当前可见诊断；总数",
	skillsScanFailed: "Skills 扫描失败，无法判断单个 Skill 状态",
	skillsDiagnosticFormat: "格式问题：此来源的 Skill 无法加载，无法提供上下文",
	skillsDiagnosticPath: "路径问题：此来源的 Skill 无法加载，无法提供上下文",
	skillsDiagnosticSource: "来源",
	skillsDiagnosticReason: "原因",
	skillsDiagnosticLine: "行",
	skillsDiagnosticImpactUnavailable: "上下文影响：此来源的 Skill 无法加载/无法提供上下文",
	skillsDiagnosticImpactMaybe: "上下文影响：此来源的 Skill 可能无法加载/提供上下文",
	skillsDiagnosticImpactDisabled: "上下文影响：当前已禁用，未进入新的上下文",
	skillsDisabledState: "已禁用",
	skillsReasonFrontmatterUnclosed: "frontmatter 未闭合",
	skillsReasonFrontmatterTooLarge: "frontmatter 超出大小限制",
	skillsReasonFrontmatterYaml: "frontmatter YAML 无效",
	skillsReasonFrontmatterRoot: "frontmatter 顶层类型无效",
	skillsReasonFieldType: "canonical 字段类型无效",
	skillsReasonFieldTooLarge: "canonical 字段超出大小限制",
	skillsReasonFileTooLarge: "SKILL.md 超出大小限制",
	skillsReasonPathOutside: "路径不在允许范围内",
	skillsReasonMissingDirectory: "Skill 目录不存在",
	skillsReasonPathUnreadable: "Skill 路径不可读",
	skillsReasonNotDirectory: "Skill 路径不是目录",
	skillsReasonManifestMissing: "SKILL.md 不存在",
	skillsReasonManifestUnreadable: "SKILL.md 不可读",
	skillsReasonUnknown: "无法分类的加载问题",
	operationsTitle: "操作记录",
	operationsPending: "待审批",
	operationsApproved: "已批准",
	operationsRejected: "已拒绝",
	operationsRecorded: "已记录结果",
	operationsNone: "暂无",
	diagnosticsTitle: "诊断",
	diagnosticsNone: "无诊断项",
	roleSummary: "InsureMO 健康概览",
	"overview.diagnostic.cancelled": "概览读取已取消",
	"overview.diagnostic.imoUnavailable": "IMO CLI 不可用",
	"overview.diagnostic.imoUpdateAvailable": "IMO CLI 有可用更新，可前往升级",
	"overview.diagnostic.authUnavailable": "认证信息不可用",
	"overview.diagnostic.authNoDefault": "尚无默认认证配置",
	"overview.diagnostic.skillsUnavailable": "Skills 信息不可用",
	"overview.diagnostic.skillsScanFailed": "Skills 扫描失败",
	"overview.diagnostic.skillsIncomplete": "Skills 清单不完整",
	"overview.diagnostic.operationsPending": "存在待审批操作",
	"overview.diagnostic.unknown": "诊断信息",
	iciTitle: "代码智能",
	iciEmbeddingEndpoint: "Embedding 端点",
	iciEmbeddingHint: "经认证 Profile 调用，无需单独 key；修改请在 profile 的 cordis.patch.yml 或安装包 config 中配置 embeddingUrl。",
	iciGraphWorkspaces: "已构建图谱的工作区",
	iciExplainWorkspaces: "已生成业务解释的工作区",
	cliUpdate: "更新",
	cliUpdating: "进行中…",
	cliUpdated: "已更新",
	cliUpdateFailed: "更新失败",
	cliInstall: "一键安装 IMO CLI",
	cliInstalling: "安装中…",
	cliInstalled: "已安装",
	cliInstallFailed: "安装失败",
	cliInstallHint: "将配置 @insuremo registry（写入用户级 .npmrc）并全局安装 @insuremo/imo；全局安装可能需要数分钟。",
	cliInstallRetryHint: "@insuremo registry 配置可能已写入用户级 .npmrc；直接重试即可（幂等），无需先回退。",
	authSetDefault: "设为默认",
	authCliHint: "新增或登录 profile 请使用 imo auth login CLI",
	skillsToggle: "启用/停用",
	skillsCatalogTitle: "可安装 Skills",
	skillsCatalogSearch: "搜索",
	skillsCatalogSearchPlaceholder: "按名称、说明或类型筛选",
	skillsCatalogRefresh: "可用 Skills：刷新",
	skillsCatalogLoading: "正在读取可用 Skills…",
	skillsCatalogUnavailable: "单个 Skill 清单暂不可用；请点击“可用 Skills：刷新”后重试。",
	skillsCatalogEmpty: "当前没有可安装的单个 Skill；仍可选择场景。",
	skillsCatalogDescriptionFullStack: "完整 iComposer 开发工具包（设计、编码、部署、搜索与配置）",
	skillsCatalogDescriptionCodingLite: "轻量 iComposer 开发工具包（编码与部署）",
	skillsCatalogDescriptionApiDesign: "API 设计与研究工具包",
	skillsCatalogDescriptionUic: "UI Connector 开发工具包",
	skillsCatalogDescriptionAsk: "InsureMO 知识搜索工具包",
	skillsCatalogNoMatch: "没有匹配的 Skill 或场景。",
	skillsCatalogScenario: "场景",
	skillsCatalogSkill: "单个 Skill",
	skillsCatalogInstall: "安装",
	skillsCatalogInstalling: "安装中…",
	skillsCatalogDone: "Skill 已安装",
	skillsCatalogFailed: "Skill 安装失败",
	skillsScenarioLabel: "场景",
	skillsScenarioInstall: "Install",
	skillsScenarioInstalling: "Installing…",
	skillsScenarioDone: "场景已同步",
	skillsScenarioFailed: "场景同步失败",
	skillsInstallFirstHint: "选择场景并同步即可完成首次安装。",
	skillsUpdateAll: "Update",
	skillsUpdatingAll: "Updating…",
	skillsUpdateDone: "已更新",
	skillsUpdateFailed: "更新失败",
	skillsScopeHint: "更新仅拉取已安装的 Skill 来源；场景同步可安装或补齐场景成员。",
	skillsAdded: "新增",
	skillsUpdated: "更新",
	skillsRemoved: "移除",
	skillsRetryHint: "状态已变化，已刷新，请重试",
	errorNetwork: "无法连接",
	diagButton: "诊断",
	diagBusy: "正在生成诊断…",
	diagNoData: "暂无诊断数据：请先复现一次失败，再点击诊断。",
	diagPrefilled: "已打开安装诊断会话并预填：请选择模型后手动发送。",
	diagDraftOccupied: "诊断会话输入框已有内容，未覆盖；请用「复制诊断文本」后粘贴发送。",
	diagCopied: "诊断文本已复制：如输入框未预填，请粘贴后发送。",
	diagClipboardOnly: "未能打开诊断会话；诊断文本已复制，可粘贴到任意会话发送。",
	diagCopy: "复制诊断文本",
	diagCopyFlash: "已复制",
	diagActionFailed: "诊断生成失败",
	diagTitleImo: "IMO CLI安装/更新失败诊断",
	diagTitleSkill: "Skills安装/更新失败诊断",
	diagSceneLabel: "场景：",
	diagParenOpen: "（",
	diagParenClose: "）",
	diagOccurredAtLabel: "发生时间：",
	diagCommandsLabel: "执行的命令：",
	diagNoCommands: "（无已执行命令记录）",
	diagNotRun: "（未运行）",
	diagEmpty: "（空）",
	diagStdoutTruncated: "（stdout 已截断）",
	diagStderrTruncated: "（stderr 已截断）",
	diagErrorLabel: "错误：",
	diagEnvironmentLabel: "环境信息：",
	diagWorkspaceTitle: "安装诊断",
	diagClosing: "请分析失败原因并给出修复步骤。",
	diagOpImoInstall: "IMO CLI 一键安装",
	diagOpImoUpgrade: "IMO CLI 更新",
	diagOpSkillUpdate: "Skills 全量更新",
	diagOpSkillInstall: "Skills 安装",
	diagOpSkillInstallSource: "Skills 场景/来源安装"
};
const en$2 = {
	nav: "InsureMO",
	title: "InsureMO Overview",
	loading: "Loading InsureMO overview…",
	expand: "Expand",
	collapse: "Collapse",
	error: "Could not load the InsureMO overview",
	errorHint: "Check the IMO CLI configuration or try again.",
	refresh: "Refresh",
	yes: "Yes",
	no: "No",
	status: "InsureMO overview status",
	imoTitle: "IMO CLI",
	imoLoading: "Detecting the IMO CLI…",
	imoDetectFailed: "IMO CLI detection failed",
	imoUnavailable: "IMO CLI not detected",
	imoCurrent: "Current version",
	imoTarget: "Available version",
	imoUpToDate: "Up to date",
	imoUpdateAvailable: "Update available",
	authTitle: "Authentication",
	authColumn: "Profile",
	envColumn: "Environment",
	tenantColumn: "Tenant",
	validColumn: "Validity",
	authProfiles: "Profiles",
	authDefault: "Default profile",
	authNone: "None",
	authValid: "Valid",
	authInvalid: "Invalid",
	skillsTitle: "Skills",
	skillsInstalled: "Installed",
	skillsValid: "Valid",
	skillsEnabled: "Enabled",
	skillsDisabled: "Disabled",
	skillsNames: "Names",
	skillsNone: "None installed",
	skillsLoadingSlow: "Scanning skills inventory…",
	skillsDiagnosticsSummary: "Skills issues",
	skillsFormatInvalidCount: "Format issues",
	skillsPathIssueCount: "Path issues",
	skillsDiagnosticsVisible: "Only visible diagnostics are shown; total",
	skillsScanFailed: "Skills scan failed; individual Skill status is unavailable",
	skillsDiagnosticFormat: "Format issue: this source's Skill cannot load or provide context",
	skillsDiagnosticPath: "Path issue: this source's Skill cannot load or provide context",
	skillsDiagnosticSource: "Source",
	skillsDiagnosticReason: "Reason",
	skillsDiagnosticLine: "Line",
	skillsDiagnosticImpactUnavailable: "Context impact: this source's Skill cannot load or provide context",
	skillsDiagnosticImpactMaybe: "Context impact: this source's Skill may not load or provide context",
	skillsDiagnosticImpactDisabled: "Context impact: disabled; it is not entering a new context",
	skillsDisabledState: "Disabled",
	skillsReasonFrontmatterUnclosed: "Frontmatter is not closed",
	skillsReasonFrontmatterTooLarge: "Frontmatter exceeds the size limit",
	skillsReasonFrontmatterYaml: "Frontmatter YAML is invalid",
	skillsReasonFrontmatterRoot: "Frontmatter root type is invalid",
	skillsReasonFieldType: "A canonical field has an invalid type",
	skillsReasonFieldTooLarge: "A canonical field exceeds the size limit",
	skillsReasonFileTooLarge: "SKILL.md exceeds the size limit",
	skillsReasonPathOutside: "The path is outside the allowed root",
	skillsReasonMissingDirectory: "The Skill directory is missing",
	skillsReasonPathUnreadable: "The Skill path is unreadable",
	skillsReasonNotDirectory: "The Skill path is not a directory",
	skillsReasonManifestMissing: "SKILL.md is missing",
	skillsReasonManifestUnreadable: "SKILL.md is unreadable",
	skillsReasonUnknown: "An unclassified loading issue",
	operationsTitle: "Operations",
	operationsPending: "Pending approval",
	operationsApproved: "Approved",
	operationsRejected: "Rejected",
	operationsRecorded: "Recorded",
	operationsNone: "None",
	diagnosticsTitle: "Diagnostics",
	diagnosticsNone: "No diagnostics",
	roleSummary: "InsureMO health overview",
	"overview.diagnostic.cancelled": "Overview read was cancelled",
	"overview.diagnostic.imoUnavailable": "IMO CLI is unavailable",
	"overview.diagnostic.imoUpdateAvailable": "An IMO CLI update is available; upgrade on the CLI page",
	"overview.diagnostic.authUnavailable": "Authentication information is unavailable",
	"overview.diagnostic.authNoDefault": "No default authentication profile",
	"overview.diagnostic.skillsUnavailable": "Skills information is unavailable",
	"overview.diagnostic.skillsScanFailed": "Skills scan failed",
	"overview.diagnostic.skillsIncomplete": "The Skills inventory is incomplete",
	"overview.diagnostic.operationsPending": "Operations are pending approval",
	"overview.diagnostic.unknown": "Diagnostic information",
	iciTitle: "Code Intelligence",
	iciEmbeddingEndpoint: "Embedding endpoint",
	iciEmbeddingHint: "Called through the authenticated profile — no separate key. To change it, set embeddingUrl in the profile's cordis.patch.yml or the installed bundle config.",
	iciGraphWorkspaces: "Workspaces with a built graph",
	iciExplainWorkspaces: "Workspaces with generated explanations",
	cliUpdate: "Update",
	cliUpdating: "In progress…",
	cliUpdated: "Updated",
	cliUpdateFailed: "Update failed",
	cliInstall: "Install IMO CLI",
	cliInstalling: "Installing…",
	cliInstalled: "Installed",
	cliInstallFailed: "Install failed",
	cliInstallHint: "Configures the @insuremo registry (writes the user-level .npmrc) and installs @insuremo/imo globally; the global install may take a few minutes.",
	cliInstallRetryHint: "The @insuremo registry entry may already be in the user-level .npmrc; retrying is safe and idempotent — no rollback needed.",
	authSetDefault: "Set default",
	authCliHint: "Add or log in to profiles via the imo auth login CLI",
	skillsToggle: "Enable/disable",
	skillsCatalogTitle: "Available Skills",
	skillsCatalogSearch: "Search",
	skillsCatalogSearchPlaceholder: "Filter by name, description, or type",
	skillsCatalogRefresh: "Available Skills: refresh",
	skillsCatalogLoading: "Loading available Skills…",
	skillsCatalogUnavailable: "Individual Skill catalog unavailable; click “Available Skills: refresh” to retry.",
	skillsCatalogEmpty: "No individual Skills are currently available; scenarios remain selectable.",
	skillsCatalogDescriptionFullStack: "Complete iComposer toolkit for design, coding, deployment, search, and configuration",
	skillsCatalogDescriptionCodingLite: "Lightweight iComposer toolkit for coding and deployment",
	skillsCatalogDescriptionApiDesign: "API design and research toolkit",
	skillsCatalogDescriptionUic: "UI Connector development toolkit",
	skillsCatalogDescriptionAsk: "InsureMO knowledge-search toolkit",
	skillsCatalogNoMatch: "No matching Skill or scenario.",
	skillsCatalogScenario: "Scenario",
	skillsCatalogSkill: "Single Skill",
	skillsCatalogInstall: "Install",
	skillsCatalogInstalling: "Installing…",
	skillsCatalogDone: "Skill installed",
	skillsCatalogFailed: "Skill install failed",
	skillsScenarioLabel: "Scenario",
	skillsScenarioInstall: "Install",
	skillsScenarioInstalling: "Installing…",
	skillsScenarioDone: "Scenario synced",
	skillsScenarioFailed: "Scenario sync failed",
	skillsInstallFirstHint: "Pick a scenario and sync to install your first skills.",
	skillsUpdateAll: "Update",
	skillsUpdatingAll: "Updating…",
	skillsUpdateDone: "Updated",
	skillsUpdateFailed: "Update failed",
	skillsScopeHint: "Update only pulls already-installed sources; scenario sync can install or reconcile members.",
	skillsAdded: "Added",
	skillsUpdated: "Updated",
	skillsRemoved: "Removed",
	skillsRetryHint: "State changed; refreshed — please retry",
	errorNetwork: "Cannot connect",
	diagButton: "Diagnose",
	diagBusy: "Preparing diagnosis…",
	diagNoData: "No diagnosis captured yet: reproduce a failure first, then click Diagnose.",
	diagPrefilled: "Diagnosis session opened and prefilled: pick a model, then send manually.",
	diagDraftOccupied: "The diagnosis composer already had content — nothing was overwritten. Use “Copy diagnosis text” to copy and paste it.",
	diagCopied: "Diagnosis text copied: if the composer was not prefilled, paste and send.",
	diagClipboardOnly: "Could not open a diagnosis session; the text was copied — paste it into any session.",
	diagCopy: "Copy diagnosis text",
	diagCopyFlash: "Copied",
	diagActionFailed: "Could not prepare the diagnosis",
	diagTitleImo: "IMO CLI install/update failure diagnosis",
	diagTitleSkill: "Skills install/update failure diagnosis",
	diagSceneLabel: "Scenario: ",
	diagParenOpen: " (",
	diagParenClose: ")",
	diagOccurredAtLabel: "Occurred at: ",
	diagCommandsLabel: "Executed commands:",
	diagNoCommands: "(no executed commands recorded)",
	diagNotRun: "(not run)",
	diagEmpty: "(empty)",
	diagStdoutTruncated: "(stdout truncated)",
	diagStderrTruncated: "(stderr truncated)",
	diagErrorLabel: "Error: ",
	diagEnvironmentLabel: "Environment:",
	diagWorkspaceTitle: "Install Diagnostics",
	diagClosing: "Please analyze the cause of the failure and provide fix steps.",
	diagOpImoInstall: "IMO CLI one-click install",
	diagOpImoUpgrade: "IMO CLI update",
	diagOpSkillUpdate: "Skills full update",
	diagOpSkillInstall: "Skills install",
	diagOpSkillInstallSource: "Skills scenario/source install"
};

//#endregion
//#region ../ui-insuremo-settings/src/client/index.ts
/** Locale namespace contributed by the InsureMO settings card. */
const NS$2 = "settings.insuremo";
/** Services used by the client-side contribution. The card wrapper reads the
* `sessions`/`workspaces` faces directly off ctx at render time (slot owner
* props supply no runtime), so both must be declared here — cordis property
* guards throw on an undeclared service access. */
const inject$1 = [
	"slots",
	"locale",
	"sessions",
	"workspaces"
];
/**
* Register the InsureMO Plugins-tab card and the diagnosis prefill entry
* (TASK-088). Both close over the client runtime because slot owner props
* supply no runtime: the card's hand-off reaches the official
* `ctx.workspaces`/`ctx.sessions` faces, and the prefill entry rides the
* official session-scope standard kit (`inputActions.setDraft`). A missing
* or unusable face degrades to the clipboard fallback — no DSH seam outside
* the unmodified rc.7 contracts is ever touched.
*/
function apply$1(ctx) {
	ctx.effect(() => ctx.locale.register(NS$2, {
		zh: zh$2,
		en: en$2
	}), "ui-insuremo-settings: dictionaries");
	registerDiagnosisPrefillSlot(ctx);
	ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
		name: "settings.plugin.item",
		key: "insuremo",
		id: "insuremo",
		locale: NS$2
	}, function InsuremoCardWithRuntime(props) {
		const source = ctx;
		const diagnosisFaces = {
			workspaces: source.workspaces,
			sessions: source.sessions
		};
		return (0, react.createElement)(InsuremoCard, {
			...props,
			diagnosisFaces
		});
	}));
}

//#endregion
//#region ../ui-insuremo-status/assets/insuremo-wordmark-dark.png
var insuremo_wordmark_dark_default = undefined;

//#endregion
//#region ../ui-insuremo-status/assets/insuremo-wordmark-light.png
var insuremo_wordmark_light_default = undefined;

//#endregion
//#region ../ui-insuremo-status/assets/insuremo-globe.png
var insuremo_globe_default = undefined;

//#endregion
//#region \0dsh-css:asset
const css$4 = ".wb06155adc_driver{display:none}.wb06155adc_wordmarkHost,.wb06155adc_railHost{pointer-events:none;z-index:1;position:absolute;inset:0}.wb06155adc_wordmarkHost{justify-content:flex-start;align-items:center;display:flex;overflow:hidden}.wb06155adc_wordmarkInner{white-space:nowrap;align-items:center;gap:8px;height:24px;line-height:1;display:inline-flex}.wb06155adc_wordmark{flex:none;width:99px;height:24px;display:block}.wb06155adc_wordmark img{object-fit:contain;image-rendering:auto;width:99px;height:24px;display:block}.wb06155adc_wordmarkDark{display:none!important}body[data-ds-dark-theme] .wb06155adc_wordmarkLight{display:none!important}body[data-ds-dark-theme] .wb06155adc_wordmarkDark{display:block!important}.wb06155adc_dsh{color:currentColor;font-family:var(--ds-font-family,Inter, system-ui, sans-serif);letter-spacing:-.045em;font-size:22px;font-weight:650;line-height:24px;display:inline-block}.wb06155adc_railHost{justify-content:center;align-items:center;display:flex}.wb06155adc_railMark{width:24px;height:24px;color:var(--dsw-alias-label-primary);flex:none;display:block}.wb06155adc_railMark img{object-fit:contain;image-rendering:auto;width:24px;height:24px;display:block}.wb06155adc_heroHost{justify-content:center;align-items:center;display:flex}.wb06155adc_heroMark{flex:none;width:34px;height:32px;display:block}.wb06155adc_heroMark img{object-fit:contain;image-rendering:auto;width:34px;height:32px;display:block}button:hover .wb06155adc_railHost{visibility:hidden}";
const tagId$4 = "@icomposer/workbench/BrandChrome.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$4) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "@icomposer/workbench";
	tag.dataset.pluginCss = tagId$4;
	tag.textContent = css$4;
	document.head.appendChild(tag);
}
var BrandChrome_module_css_default = {
	"heroHost": "wb06155adc_heroHost",
	"heroMark": "wb06155adc_heroMark",
	"wordmarkDark": "wb06155adc_wordmarkDark",
	"wordmarkHost": "wb06155adc_wordmarkHost",
	"driver": "wb06155adc_driver",
	"wordmark": "wb06155adc_wordmark",
	"wordmarkLight": "wb06155adc_wordmarkLight",
	"railHost": "wb06155adc_railHost",
	"wordmarkInner": "wb06155adc_wordmarkInner",
	"dsh": "wb06155adc_dsh",
	"railMark": "wb06155adc_railMark"
};

//#endregion
//#region ../ui-insuremo-status/src/client/BrandChrome.tsx
/** Stable DOM signatures owned by the Harness sidebar shell. */
const WORDMARK_VIEWBOX = "0 0 182 24";
const FISH_VIEWBOX = "0 0 23.16 17.04";
const PANEL_VIEWBOX = "0 0 16 16";
const BRAND_ASSET_URL$1 = "/api/icomposer-workbench/ui/assets";
const BRAND_HOST_ATTRIBUTE = "data-icomposer-brand-host";
/**
* Resolves the overlay anchor for one kind. wordmark/rail ride the Harness
* button shell; the hero fish lives inside a plain span (New Session empty
* state), so its span becomes the relative overlay host instead.
*/
function svgAnchor(svg, kind) {
	if (kind === "hero") {
		if (svg.getAttribute("viewBox") !== FISH_VIEWBOX) return null;
		const parent = svg.parentElement;
		if (parent === null || parent.tagName === "BUTTON") return null;
		return parent;
	}
	if (svg.getAttribute("viewBox") !== (kind === "wordmark" ? WORDMARK_VIEWBOX : FISH_VIEWBOX)) return null;
	const button = svg.parentElement;
	if (button === null || button.tagName !== "BUTTON") return null;
	const nativeButton = button;
	const hasPanel = button.querySelector(`svg[viewBox="${PANEL_VIEWBOX}"]`) !== null;
	if (kind === "rail") return hasPanel ? nativeButton : null;
	const row = button.parentElement;
	if (row === null) return null;
	const siblingPanel = Array.from(row.children).some((child) => child !== button && child.tagName === "BUTTON" && child.querySelector(`svg[viewBox="${PANEL_VIEWBOX}"]`) !== null);
	return siblingPanel ? nativeButton : null;
}
function Asset({ kind }) {
	if (kind === "wordmark") return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		className: BrandChrome_module_css_default.wordmarkInner,
		"aria-hidden": "true",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
			className: BrandChrome_module_css_default.wordmark,
			"data-icomposer-brand-asset": kind,
			"data-emitted-brand-assets": `${insuremo_wordmark_light_default}|${insuremo_wordmark_dark_default}`,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
				className: BrandChrome_module_css_default.wordmarkLight,
				src: `${BRAND_ASSET_URL$1}/insuremo-wordmark-light.png`,
				alt: "",
				width: 312,
				height: 76,
				decoding: "async"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
				className: BrandChrome_module_css_default.wordmarkDark,
				src: `${BRAND_ASSET_URL$1}/insuremo-wordmark-dark.png`,
				alt: "",
				width: 312,
				height: 76,
				decoding: "async"
			})]
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			className: BrandChrome_module_css_default.dsh,
			children: "dsh"
		})]
	});
	if (kind === "hero") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		className: BrandChrome_module_css_default.heroMark,
		"data-icomposer-brand-asset": kind,
		"data-emitted-brand-asset": insuremo_globe_default,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
			src: `${BRAND_ASSET_URL$1}/insuremo-globe.png`,
			alt: "",
			width: 34,
			height: 32,
			decoding: "async"
		})
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		className: BrandChrome_module_css_default.railMark,
		"data-icomposer-brand-asset": kind,
		"data-emitted-brand-asset": insuremo_globe_default,
		children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
			src: `${BRAND_ASSET_URL$1}/insuremo-globe.png`,
			alt: "",
			width: 65,
			height: 62,
			decoding: "async"
		})
	});
}
/**
* Hidden client driver that overlays only the Harness-owned brand SVGs.
* The source buttons remain the click/focus/tooltip owners; each original SVG
* is merely visibility-hidden and restored, while every portal host is removed
* on unmount or when the shell replaces a button. On rc.2+ runtimes the brand
* slots replace the native SVGs, so the driver simply finds nothing to own.
*/
var BrandChrome = class extends react.Component {
	#driverRef = null;
	#observer;
	#ports = /* @__PURE__ */ new Map();
	#mounted = false;
	componentDidMount() {
		this.#mounted = true;
		const doc = this.#driverRef?.ownerDocument;
		if (doc === void 0) return;
		const Observer = doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
		if (Observer !== void 0) {
			this.#observer = new Observer(() => {
				this.sync(doc);
			});
			this.#observer.observe(doc.body, {
				childList: true,
				subtree: true
			});
		}
		this.sync(doc);
	}
	componentWillUnmount() {
		this.#mounted = false;
		this.#observer?.disconnect();
		this.#observer = void 0;
		for (const original of [...this.#ports.keys()]) this.drop(original);
	}
	ensure(doc, original, anchor, kind) {
		if (this.#ports.has(original)) return;
		const originalStyle = original.getAttribute("style");
		const anchorStyle = anchor.getAttribute("style");
		const host = doc.createElement("span");
		host.setAttribute(BRAND_HOST_ATTRIBUTE, kind);
		host.setAttribute("aria-hidden", "true");
		host.className = kind === "wordmark" ? BrandChrome_module_css_default.wordmarkHost : kind === "rail" ? BrandChrome_module_css_default.railHost : BrandChrome_module_css_default.heroHost;
		anchor.style.position = "relative";
		original.style.visibility = "hidden";
		anchor.appendChild(host);
		const root = (0, react_dom_client.createRoot)(host);
		root.render(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Asset, { kind }));
		this.#ports.set(original, {
			original,
			anchor,
			host,
			root,
			originalStyle,
			anchorStyle
		});
	}
	drop(original) {
		const port = this.#ports.get(original);
		if (port === void 0) return;
		port.root.unmount();
		port.host.remove();
		if (port.originalStyle === null) port.original.removeAttribute("style");
		else port.original.setAttribute("style", port.originalStyle);
		if (port.anchorStyle === null) port.anchor.removeAttribute("style");
		else port.anchor.setAttribute("style", port.anchorStyle);
		this.#ports.delete(original);
	}
	sync(doc) {
		if (!this.#mounted) return;
		const matched = /* @__PURE__ */ new Set();
		for (const kind of [
			"wordmark",
			"rail",
			"hero"
		]) {
			const selector = `svg[viewBox="${kind === "wordmark" ? WORDMARK_VIEWBOX : FISH_VIEWBOX}"]`;
			for (const original of Array.from(doc.querySelectorAll(selector))) {
				const anchor = svgAnchor(original, kind);
				if (anchor === null) continue;
				matched.add(original);
				this.ensure(doc, original, anchor, kind);
			}
		}
		for (const [original, port] of this.#ports) if (!matched.has(original) || !original.isConnected || !port.host.isConnected) this.drop(original);
	}
	render() {
		return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			ref: (element) => {
				this.#driverRef = element;
			},
			className: BrandChrome_module_css_default.driver,
			"data-icomposer-brand-driver": ""
		});
	}
};

//#endregion
//#region ../ui-insuremo-status/src/client/HealthGlyphs.tsx
/**
* Consistent 16×16 inline health glyphs (TASK-044 A). All three share the
* same viewBox and stroke style, use `currentColor` so the CSS state tokens
* (`--dsw-alias-state-*` / `--dsw-alias-label-*`) color them, and are never
* opaque squares/dots.
*/
function baseProps() {
	return {
		width: "16",
		height: "16",
		viewBox: "0 0 16 16",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: "1.3",
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": "true"
	};
}
/** iComposer: rounded hexagonal ring with a lowercase "i" code mark. */
function IcomposerGlyph(props) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
		...baseProps(),
		className: props.className,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 1.7l5.3 3.05c.35.2.56.57.56.96v4.58c0 .4-.21.77-.56.96L8 14.3l-5.3-3.05C2.35 11.05 2.14 10.68 2.14 10.3V5.7c0-.4.21-.77.56-.96L8 1.7z" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 5.4v5" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 4.4h.01" })
		]
	});
}
/** Graph: three nodes with two connecting edges. */
function GraphGlyph(props) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
		...baseProps(),
		className: props.className,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "4",
				cy: "4",
				r: "1.5"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "12",
				cy: "4",
				r: "1.5"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "9.5",
				cy: "11.5",
				r: "1.5"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5.2 4.9l1.5.8" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M10.6 5.2l1 .6" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M9 6.6 8.4 9.9" })
		]
	});
}
/** Intelligence: spark/orbit, not a plain dot. */
function IntelligenceGlyph(props) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
		...baseProps(),
		className: props.className,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ellipse", {
				cx: "8",
				cy: "8",
				rx: "5.6",
				ry: "3.4",
				transform: "rotate(-20 8 8)"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 1.2l1 2.2 2.2.9-2.2 1-1 2.2-1-2.2-2.2-1 2.2-.9z" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "4.4",
				cy: "10.8",
				r: "1"
			})
		]
	});
}

//#endregion
//#region \0dsh-css:asset
const css$3 = ".wb8730382c_driver{display:none}.wb8730382c_rowIcons{flex:none;align-items:center;gap:4px;margin-left:auto;display:inline-flex}.wb8730382c_rowIcons .wb8730382c_icon{width:16px;height:16px;color:var(--dsw-alias-label-tertiary);border-radius:4px;flex:none;justify-content:center;align-items:center;display:inline-flex;position:relative}.wb8730382c_rowIcons .wb8730382c_icon svg{display:block}.wb8730382c_rowIcons .wb8730382c_icon:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.wb8730382c_rowIcons .wb8730382c_icon[data-state=detected]{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)}.wb8730382c_rowIcons .wb8730382c_icon[data-state=on]{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)}.wb8730382c_rowIcons .wb8730382c_icon[data-state=off]{color:var(--dsw-alias-label-tertiary);opacity:.32}";
const tagId$3 = "@icomposer/workbench/WorkspaceHealth.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$3) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "@icomposer/workbench";
	tag.dataset.pluginCss = tagId$3;
	tag.textContent = css$3;
	document.head.appendChild(tag);
}
var WorkspaceHealth_module_css_default = {
	"driver": "wb8730382c_driver",
	"rowIcons": "wb8730382c_rowIcons",
	"icon": "wb8730382c_icon"
};

//#endregion
//#region ../ui-insuremo-status/src/client/WorkspaceHealth.tsx
const WORKSPACES_STATUS_URL = "/api/icomposer-workbench/insuremo/overview/workspaces/status";
function parseWorkspaceHealthRows(value) {
	if (typeof value !== "object" || value === null) return null;
	const list = value.workspaces;
	if (!Array.isArray(list)) return null;
	const rows = [];
	for (const item of list.slice(0, 100)) {
		if (typeof item !== "object" || item === null) continue;
		const row = item;
		if (typeof row.workspaceId !== "string") continue;
		const state = row.autoBindState === "bound" || row.autoBindState === "pending" ? row.autoBindState : "none";
		rows.push({
			workspaceId: row.workspaceId,
			displayName: typeof row.displayName === "string" && row.displayName.length > 0 ? row.displayName : row.workspaceId,
			detected: row.detected === true,
			autoBindState: state,
			graphReady: row.graphReady === true,
			explainReady: row.explainReady === true
		});
	}
	return rows;
}
/** The plugin-owned marker attribute on an injected inline host. */
const HOST_ATTR = "data-icomposer-workspace-health";
function Glyphs(props) {
	if (!props.row.detected) return null;
	const iComposerLabel = props.t("health.iComposer");
	const graphLabel = props.row.graphReady ? props.t("health.graphReady") : props.t("health.graphNotReady");
	const explainLabel = props.row.explainReady ? props.t("health.explainReady") : props.t("health.explainNotReady");
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		className: WorkspaceHealth_module_css_default.rowIcons,
		"data-icomposer-workspace-health-icons": "",
		onClick: (event) => event.stopPropagation(),
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: iComposerLabel,
				side: "top",
				delayMs: 400,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: WorkspaceHealth_module_css_default.icon,
					"data-state": "detected",
					role: "img",
					tabIndex: 0,
					"aria-label": iComposerLabel,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IcomposerGlyph, {})
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: graphLabel,
				side: "top",
				delayMs: 400,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: WorkspaceHealth_module_css_default.icon,
					"data-state": props.row.graphReady ? "on" : "off",
					role: "img",
					tabIndex: 0,
					"aria-label": graphLabel,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GraphGlyph, {})
				})
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: explainLabel,
				side: "top",
				delayMs: 400,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: WorkspaceHealth_module_css_default.icon,
					"data-state": props.row.explainReady ? "on" : "off",
					role: "img",
					tabIndex: 0,
					"aria-label": explainLabel,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(IntelligenceGlyph, {})
				})
			})
		]
	});
}
/**
* TASK-043 (A): the health strip rides the footer slot only as a hidden,
* zero-size driver; the visible glyphs are injected INLINE into each native
* Workspaces tree row (between the title text and the row actions) via a
* MutationObserver + React portals. Cleanup is total: rows that disappear,
* re-render, or rename lose their hosts; unmount removes every host.
*/
var WorkspaceHealth = class extends react.Component {
	state = { rows: [] };
	#controller;
	#timer;
	#observer;
	/** workspaceId → portal root mounted into that row's host element. */
	#ports = /* @__PURE__ */ new Map();
	#occurrenceCounter = /* @__PURE__ */ new Map();
	/** DOM row → workspace identity, retained across duplicate-title filters/reorders. */
	#rowIds = /* @__PURE__ */ new WeakMap();
	#driverRef = null;
	#mounted = false;
	componentDidMount() {
		this.#mounted = true;
		this.load();
		this.#timer = setInterval(() => void this.load(), 6e4);
		this.#observer = new MutationObserver(() => this.syncRows());
		if (this.#driverRef?.ownerDocument !== void 0) this.#observer.observe(this.#driverRef.ownerDocument.body, {
			childList: true,
			subtree: true
		});
		this.syncRows();
	}
	componentWillUnmount() {
		this.#mounted = false;
		this.#controller?.abort();
		if (this.#timer !== void 0) clearInterval(this.#timer);
		this.#observer?.disconnect();
		for (const id of [...this.#ports.keys()]) this.dropPort(id);
	}
	dropPort(id) {
		const port = this.#ports.get(id);
		if (port === void 0) return;
		port.root.unmount();
		port.host.remove();
		this.#ports.delete(id);
	}
	async load() {
		this.#controller?.abort();
		const controller = new AbortController();
		this.#controller = controller;
		try {
			const response = await fetch(WORKSPACES_STATUS_URL, {
				signal: controller.signal,
				headers: { Accept: "application/json" }
			});
			if (!response.ok) return;
			const rows = parseWorkspaceHealthRows(await response.json());
			if (rows !== null && !controller.signal.aborted) this.setState({ rows }, () => this.syncRows());
		} catch {}
	}
	syncRows() {
		if (!this.#mounted) return;
		const driver = this.#driverRef;
		if (driver === null) return;
		const doc = driver.ownerDocument;
		if (doc === void 0) return;
		const matched = /* @__PURE__ */ new Map();
		const rowsInOrder = this.state.rows;
		const seenIds = /* @__PURE__ */ new Set();
		const treeitems = Array.from(doc.querySelectorAll("[role=\"treeitem\"][aria-expanded]"));
		for (const treeitem of treeitems) {
			const titleText = treeitem.querySelector("[class*=\"projectText\"]");
			const label = (titleText?.textContent ?? "").trim();
			if (label.length === 0) continue;
			const candidates = rowsInOrder.filter((candidate) => candidate.displayName === label);
			if (candidates.length === 0) continue;
			const occurrence = this.#occurrenceCounter.get(label) ?? 0;
			this.#occurrenceCounter.set(label, occurrence + 1);
			const existingHost = treeitem.querySelector(`[${HOST_ATTR}]`);
			const existingId = this.#rowIds.get(treeitem) ?? existingHost?.getAttribute("data-icomposer-workspace-id");
			const preserved = existingId === void 0 || existingId === null ? void 0 : candidates.find((candidate) => candidate.workspaceId === existingId);
			const available = candidates.filter((candidate) => !seenIds.has(candidate.workspaceId));
			const row = preserved !== void 0 && !seenIds.has(preserved.workspaceId) ? preserved : available[occurrence % Math.max(available.length, 1)];
			if (row === void 0) continue;
			const id = row.workspaceId;
			this.#rowIds.set(treeitem, id);
			if (!row.detected) {
				const staleId = existingHost?.getAttribute("data-icomposer-workspace-id");
				const stalePort = staleId === void 0 || staleId === null ? void 0 : this.#ports.get(staleId);
				if (staleId !== void 0 && staleId !== null && stalePort?.host === existingHost) this.dropPort(staleId);
				else existingHost?.remove();
				continue;
			}
			seenIds.add(id);
			const hostId = existingHost?.getAttribute("data-icomposer-workspace-id");
			if (hostId !== void 0 && hostId !== null && hostId !== id) if (this.#ports.has(hostId)) this.dropPort(hostId);
			else existingHost?.remove();
			let port = this.#ports.get(id);
			if (port !== void 0 && !port.host.isConnected) {
				this.dropPort(id);
				port = void 0;
			}
			if (port !== void 0 && port.host.parentElement !== treeitem) treeitem.appendChild(port.host);
			if (port === void 0 && treeitem.querySelector(`[${HOST_ATTR}]`) === null) {
				const host = doc.createElement("span");
				host.setAttribute(HOST_ATTR, "");
				host.setAttribute("data-icomposer-workspace-id", id);
				for (const type of [
					"click",
					"mousedown",
					"keydown"
				]) host.addEventListener(type, (event) => event.stopPropagation());
				const anchor = treeitem.querySelector("[class*=\"rowActions\"]") ?? treeitem.lastElementChild;
				if (anchor !== null && anchor.parentElement === treeitem) treeitem.insertBefore(host, anchor);
				else treeitem.appendChild(host);
				port = {
					host,
					root: (0, react_dom_client.createRoot)(host)
				};
				this.#ports.set(id, port);
			}
			if (port !== void 0) port.root.render(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Glyphs, {
				t: this.props.t,
				row
			}));
		}
		this.#occurrenceCounter.clear();
		for (const [id, port] of this.#ports.entries()) if (!seenIds.has(id) || !port.host.isConnected) this.dropPort(id);
	}
	render() {
		const { t } = this.props;
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(BrandChrome, {}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			ref: (element) => {
				this.#driverRef = element;
			},
			className: WorkspaceHealth_module_css_default.driver,
			role: "status",
			"aria-label": t("health.strip"),
			"data-icomposer-workspace-health-driver": ""
		})] });
	}
};

//#endregion
//#region ../ui-insuremo-status/src/client/actions.ts
const ACTIONS_PREFIX = "/api/icomposer-workbench/insuremo/overview/actions";
const OVERVIEW_URL = "/api/icomposer-workbench/insuremo/overview";
async function postAction(action, body, signal) {
	try {
		const response = await fetch(`${ACTIONS_PREFIX}/${action}`, {
			method: "POST",
			credentials: "same-origin",
			headers: {
				"Content-Type": "application/json",
				"X-Workbench-Action": "1",
				Accept: "application/json"
			},
			body: JSON.stringify(body ?? {}),
			signal
		});
		if (!response.ok) {
			const payload$1 = await response.json().catch(() => null);
			if (payload$1?.error !== void 0 && typeof payload$1.error.code === "string") return {
				ok: false,
				error: payload$1.error
			};
			return {
				ok: false,
				error: {
					code: "http-error",
					message: `HTTP ${response.status}`
				}
			};
		}
		const payload = await response.json();
		if (payload?.ok === true && payload.result !== void 0) return {
			ok: true,
			result: payload.result
		};
		if (payload?.ok === false && payload.error !== void 0) return {
			ok: false,
			error: payload.error
		};
		return {
			ok: false,
			error: {
				code: "parse-error",
				message: "unexpected response"
			}
		};
	} catch {
		return {
			ok: false,
			error: {
				code: "network",
				message: "network-unavailable"
			}
		};
	}
}

//#endregion
//#region \0dsh-css:asset
const css$2 = ".wb972d6c20_trigger{box-sizing:border-box;width:100%;min-height:28px;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:7px;padding:4px 9px;font-size:12px;line-height:18px;display:inline-flex;overflow:hidden}.wb972d6c20_trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.wb972d6c20_dot{background:var(--dsw-alias-state-warn-primary);border-radius:50%;flex:none;width:7px;height:7px}.wb972d6c20_label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.wb972d6c20_picker{flex-direction:column;gap:2px;padding:2px 0;display:flex}.wb972d6c20_pickerHeader{box-sizing:border-box;width:100%;min-height:28px;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:7px;padding:4px 9px;font-size:12px;line-height:18px;display:inline-flex;overflow:hidden}.wb972d6c20_closeMark{color:var(--dsw-alias-label-tertiary);margin-left:auto}.wb972d6c20_list{flex-direction:column;gap:1px;margin:0;padding:0;list-style:none;display:flex}.wb972d6c20_groupLabel{color:var(--dsw-alias-label-tertiary);text-transform:uppercase;padding:4px 9px 1px;font-size:10px;line-height:14px;display:block}.wb972d6c20_row{box-sizing:border-box;width:100%;min-height:26px;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:6px;padding:3px 9px 3px 22px;font-size:12px;line-height:17px;display:inline-flex;overflow:hidden}.wb972d6c20_row:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.wb972d6c20_row[data-default=\"1\"]{color:var(--dsw-alias-label-primary)}.wb972d6c20_rowName{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.wb972d6c20_rowMark{color:var(--dsw-alias-state-success-primary);flex:none}.wb972d6c20_hint{color:var(--dsw-alias-label-tertiary);margin:0;padding:2px 9px;font-size:11px}.wb972d6c20_error{color:var(--dsw-alias-state-error-primary);padding:2px 9px;font-size:11px}";
const tagId$2 = "@icomposer/workbench/ProfilePicker.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "@icomposer/workbench";
	tag.dataset.pluginCss = tagId$2;
	tag.textContent = css$2;
	document.head.appendChild(tag);
}
var ProfilePicker_module_css_default = {
	"closeMark": "wb972d6c20_closeMark",
	"groupLabel": "wb972d6c20_groupLabel",
	"error": "wb972d6c20_error",
	"list": "wb972d6c20_list",
	"rowName": "wb972d6c20_rowName",
	"trigger": "wb972d6c20_trigger",
	"pickerHeader": "wb972d6c20_pickerHeader",
	"rowMark": "wb972d6c20_rowMark",
	"picker": "wb972d6c20_picker",
	"dot": "wb972d6c20_dot",
	"label": "wb972d6c20_label",
	"hint": "wb972d6c20_hint",
	"row": "wb972d6c20_row"
};

//#endregion
//#region ../ui-insuremo-status/src/client/ProfilePicker.tsx
function tooltipOf(profile, fallback) {
	const parts = [
		profile.env,
		profile.tenantCode,
		profile.account
	].filter((part) => typeof part === "string" && part.length > 0);
	return parts.length > 0 ? parts.join(" · ") : fallback;
}
/**
* Derive the current auth target from the renderer's authoritative session and
* workspace feeds. Workspace path is retained only to invalidate a stale
* response if a registry row is replaced; the browser sends the id only.
*/
function resolveProfileTarget(sessions, workspaces) {
	if (sessions.current === void 0) return { kind: "global" };
	if (workspaces.phase !== "ready" || workspaces.baselinesReady !== true) return { kind: "unavailable" };
	const workspace = workspaces.items.find((item) => item.sessionIds.includes(sessions.current));
	if (workspace === void 0) return { kind: "global" };
	return {
		kind: "workspace",
		workspaceId: String(workspace.workspaceId),
		canonicalPath: workspace.path
	};
}
function targetKey(target) {
	if (target.kind === "workspace") return `workspace:${target.workspaceId ?? ""}:${target.canonicalPath ?? ""}`;
	return target.kind;
}
function targetQuery(target) {
	if (target.kind !== "workspace" || target.workspaceId === void 0) return "";
	return `&workspaceId=${encodeURIComponent(target.workspaceId)}`;
}
function sourceRank(scope) {
	return scope === "workspace" ? 0 : scope === "global" ? 1 : 2;
}
function sourceScopeOf(item) {
	if (item.sourceScope === "workspace" || item.sourceScope === "global") return item.sourceScope;
	if (item.scope === "workspace" || item.scope === "global") return item.scope;
	return void 0;
}
function mergeProfileRows(rows) {
	const byName = /* @__PURE__ */ new Map();
	for (const row of rows) {
		const previous = byName.get(row.name);
		if (previous === void 0 || sourceRank(row.sourceScope) < sourceRank(previous.sourceScope)) byName.set(row.name, row);
	}
	return [...byName.values()].sort((left, right) => sourceRank(left.sourceScope) - sourceRank(right.sourceScope) || left.name.localeCompare(right.name));
}
/**
* Global slot wrapper: hooks are consumed here, while the stateful panel below
* remains a class so the existing picker interaction and DOM stay stable.
*/
function WorkspaceAwareProfilePicker(props) {
	const sessions = props.useSessions((state) => state);
	const workspaces = props.useWorkspaces((state) => state);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(ProfilePicker, {
		...props,
		target: resolveProfileTarget(sessions, workspaces)
	});
}
/** Sidebar Active Profile selector with workspace-scoped reads and selection. */
var ProfilePicker = class extends react.Component {
	state = {
		phase: "collapsed",
		targetKey: targetKey(this.props.target ?? { kind: "global" })
	};
	#generation = 0;
	#controller;
	currentTarget() {
		return this.props.target ?? { kind: "global" };
	}
	componentDidMount() {
		this.warmActive(this.currentTarget());
	}
	componentDidUpdate(previousProps) {
		const previousKey = targetKey(previousProps.target ?? { kind: "global" });
		const nextKey = targetKey(this.currentTarget());
		if (previousKey === nextKey) return;
		this.cancelRequest();
		this.setState({
			phase: "collapsed",
			targetKey: nextKey
		});
		this.warmActive(this.currentTarget());
	}
	componentWillUnmount() {
		this.cancelRequest();
	}
	cancelRequest() {
		this.#generation += 1;
		this.#controller?.abort();
		this.#controller = void 0;
	}
	beginRequest() {
		this.cancelRequest();
		const controller = new AbortController();
		this.#controller = controller;
		return {
			generation: this.#generation,
			signal: controller.signal,
			targetKey: targetKey(this.currentTarget())
		};
	}
	isCurrent(generation, key, signal) {
		return !signal.aborted && generation === this.#generation && key === targetKey(this.currentTarget()) && this.#controller?.signal === signal;
	}
	overviewUrl(target) {
		return `${OVERVIEW_URL}?fast=1${targetQuery(target)}`;
	}
	async waitBeforeRetry(signal) {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				signal.removeEventListener("abort", abort);
				resolve();
			}, 300);
			const abort = () => {
				clearTimeout(timer);
				reject(new Error("cancelled"));
			};
			signal.addEventListener("abort", abort, { once: true });
		});
	}
	/** One retry after a short delay; aborts cleanly when target changes. */
	async fetchFastRetry(target, signal) {
		const first = await fetch(this.overviewUrl(target), {
			headers: { Accept: "application/json" },
			signal
		}).catch((error) => {
			if (signal.aborted) throw error;
			return void 0;
		});
		if (first !== void 0 && first.ok) return first;
		await this.waitBeforeRetry(signal);
		const second = await fetch(this.overviewUrl(target), {
			headers: { Accept: "application/json" },
			signal
		}).catch((error) => {
			if (signal.aborted) throw error;
			return void 0;
		});
		if (second !== void 0) return second;
		if (first !== void 0) return first;
		throw new Error("overview");
	}
	async warmActive(target) {
		if (target.kind === "unavailable") return;
		const request = this.beginRequest();
		try {
			const response = await this.fetchFastRetry(target, request.signal);
			if (!response.ok) return;
			const parsed = this.parseProfiles(await response.json());
			if (!this.isCurrent(request.generation, request.targetKey, request.signal)) return;
			if (this.state.phase === "collapsed" && this.state.targetKey === request.targetKey) this.setState({
				phase: "collapsed",
				targetKey: request.targetKey,
				profiles: parsed.profiles,
				activeName: parsed.activeName
			});
		} catch {} finally {
			if (this.#controller?.signal === request.signal) this.#controller = void 0;
		}
	}
	parseProfiles(payload) {
		if (typeof payload !== "object" || payload === null) throw new Error("shape");
		const auth = payload.auth;
		if (typeof auth !== "object" || auth === null) throw new Error("shape");
		const raw = auth.profiles;
		if (!Array.isArray(raw)) throw new Error("shape");
		const profiles = mergeProfileRows(raw.map((item) => typeof item === "object" && item !== null ? item : null).filter((item) => item !== null && typeof item.name === "string").slice(0, 100).map((item) => ({
			name: String(item.name),
			env: typeof item.env === "string" ? item.env : void 0,
			tenantCode: typeof item.tenantCode === "string" ? item.tenantCode : void 0,
			account: typeof item.account === "string" ? item.account : void 0,
			sourceScope: sourceScopeOf(item),
			isActive: item.isActive === true
		})));
		const authRecord = auth;
		const activeName = typeof authRecord.activeProfileName === "string" ? authRecord.activeProfileName : void 0;
		return {
			profiles,
			activeName
		};
	}
	async open() {
		if (this.state.phase === "open") return;
		const target = this.currentTarget();
		const key = targetKey(target);
		const previous = this.state.activeName;
		if (target.kind === "unavailable") {
			this.setState({
				phase: "open",
				targetKey: key,
				profiles: [],
				activeName: previous,
				busy: false,
				error: "workspace"
			});
			return;
		}
		const request = this.beginRequest();
		this.setState({
			phase: "open",
			targetKey: key,
			profiles: [],
			activeName: previous,
			busy: true
		});
		try {
			const response = await this.fetchFastRetry(target, request.signal);
			if (!response.ok) throw new Error("overview");
			const parsed = this.parseProfiles(await response.json());
			if (!this.isCurrent(request.generation, request.targetKey, request.signal)) return;
			this.setState({
				phase: "open",
				targetKey: request.targetKey,
				profiles: parsed.profiles,
				activeName: parsed.activeName,
				busy: false
			});
		} catch {
			if (!this.isCurrent(request.generation, request.targetKey, request.signal)) return;
			this.setState((prev) => prev.phase === "open" ? {
				...prev,
				busy: false,
				error: "network"
			} : prev);
		} finally {
			if (this.#controller?.signal === request.signal) this.#controller = void 0;
		}
	}
	async pick(name) {
		if (this.state.phase !== "open" || this.state.busy) return;
		const target = this.currentTarget();
		const key = targetKey(target);
		if (this.state.targetKey !== key || target.kind === "unavailable") return;
		const request = this.beginRequest();
		this.setState((prev) => prev.phase === "open" ? {
			...prev,
			busy: true,
			error: void 0
		} : prev);
		const body = target.kind === "workspace" && target.workspaceId !== void 0 ? {
			profile: name,
			workspaceId: target.workspaceId
		} : { profile: name };
		try {
			const outcome = await postAction("active-profile", body, request.signal);
			if (!this.isCurrent(request.generation, request.targetKey, request.signal)) return;
			if (outcome.ok) {
				let nextActive = name;
				let nextProfiles;
				try {
					const refreshed = await this.fetchFastRetry(target, request.signal);
					if (refreshed.ok) {
						const parsed = this.parseProfiles(await refreshed.json());
						if (!this.isCurrent(request.generation, request.targetKey, request.signal)) return;
						nextActive = parsed.activeName ?? name;
						nextProfiles = parsed.profiles;
					}
				} catch {}
				if (!this.isCurrent(request.generation, request.targetKey, request.signal)) return;
				this.setState((prev) => prev.phase === "open" ? {
					phase: "collapsed",
					targetKey: request.targetKey,
					profiles: nextProfiles ?? prev.profiles,
					activeName: nextActive
				} : prev);
			} else {
				const error = outcome.error.code === "network" ? "network" : outcome.error.code;
				this.setState((prev) => prev.phase === "open" ? {
					...prev,
					busy: false,
					error
				} : prev);
			}
		} catch {
			if (!this.isCurrent(request.generation, request.targetKey, request.signal)) return;
			this.setState((prev) => prev.phase === "open" ? {
				...prev,
				busy: false,
				error: "network"
			} : prev);
		} finally {
			if (this.#controller?.signal === request.signal) this.#controller = void 0;
		}
	}
	errorText(error) {
		return error === "workspace" ? this.props.t("picker.workspaceUnavailable") : this.props.t("picker.error");
	}
	render() {
		const { t } = this.props;
		const state = this.state;
		if (state.phase === "collapsed") {
			const current = state.activeName ?? "";
			const currentRow = state.profiles?.find((profile) => profile.name === current);
			const title = currentRow !== void 0 ? tooltipOf(currentRow, current) : current.length > 0 ? current : t("label");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: ProfilePicker_module_css_default.trigger,
				"data-wide": "true",
				"aria-haspopup": "listbox",
				"aria-expanded": false,
				title,
				"aria-label": current.length > 0 ? `${t("label")} · ${current}` : t("label"),
				onClick: () => void this.open(),
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ProfilePicker_module_css_default.dot,
					"aria-hidden": "true"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: ProfilePicker_module_css_default.label,
					children: current.length > 0 ? current : t("label")
				})]
			});
		}
		let lastScope;
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: ProfilePicker_module_css_default.picker,
			role: "group",
			"aria-label": t("picker.label"),
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: ProfilePicker_module_css_default.pickerHeader,
					onClick: () => {
						this.cancelRequest();
						this.setState({
							phase: "collapsed",
							targetKey: targetKey(this.currentTarget()),
							profiles: state.profiles,
							activeName: state.activeName
						});
					},
					"aria-label": t("picker.close"),
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ProfilePicker_module_css_default.dot,
							"aria-hidden": "true"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ProfilePicker_module_css_default.label,
							children: t("picker.label")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ProfilePicker_module_css_default.closeMark,
							"aria-hidden": "true",
							children: "×"
						})
					]
				}),
				state.busy && state.profiles.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: ProfilePicker_module_css_default.hint,
					children: t("picker.loading")
				}) : null,
				state.profiles.length === 0 && !state.busy && state.error === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: ProfilePicker_module_css_default.hint,
					children: t("picker.empty")
				}) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: ProfilePicker_module_css_default.list,
					role: "listbox",
					"aria-label": t("picker.label"),
					children: state.profiles.map((profile) => {
						const heading = profile.sourceScope !== void 0 && profile.sourceScope !== lastScope;
						lastScope = profile.sourceScope;
						const selected = profile.name === state.activeName || state.activeName === void 0 && profile.isActive === true;
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", { children: [heading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							role: "presentation",
							className: ProfilePicker_module_css_default.groupLabel,
							children: profile.sourceScope === "workspace" ? t("picker.project") : t("picker.global")
						}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
							type: "button",
							role: "option",
							"aria-selected": selected,
							disabled: state.busy,
							title: tooltipOf(profile, profile.name),
							"data-active": selected ? "1" : void 0,
							"data-source-scope": profile.sourceScope,
							onClick: () => void this.pick(profile.name),
							className: ProfilePicker_module_css_default.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ProfilePicker_module_css_default.rowName,
								children: profile.name
							}), selected ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: ProfilePicker_module_css_default.rowMark,
								"aria-hidden": "true",
								children: "✓"
							}) : null]
						})] }, profile.name);
					})
				}),
				state.error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					role: "alert",
					className: ProfilePicker_module_css_default.error,
					children: this.errorText(state.error)
				}) : null
			]
		});
	}
};

//#endregion
//#region ../ui-insuremo-status/src/client/InsuremoBrand.tsx
/** Same-origin brand assets served by the host-side brand-assets-server. */
const BRAND_ASSET_URL = "/api/icomposer-workbench/ui/assets";
/**
* The mark slot feeds two hosts with identical props: the wide identity row
* (mark + name lockup — the wordmark already carries the brand, so the mark
* must stay empty there, matching the pre-slot overlay look) and the
* collapsed rail toggle (mark only). The rail host is the button that also
* holds the panel icon; detect it after mount and render only there.
*/
function InsuremoBrandMark({ size = 24 }) {
	const hostRef = (0, react.useRef)(null);
	const [inRail, setInRail] = (0, react.useState)(false);
	(0, react.useLayoutEffect)(() => {
		const button = hostRef.current?.closest("button");
		setInRail(button?.querySelector("svg") !== null);
	}, []);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
		ref: hostRef,
		children: inRail ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
			src: `${BRAND_ASSET_URL}/insuremo-globe.png`,
			alt: "",
			width: size,
			height: Math.round(size * 62 / 65),
			decoding: "async",
			"data-emitted-brand-asset": insuremo_globe_default
		}) : null
	});
}
/** The wordmark rendered into `sidebar.brand.name` (99×24, theme-switched
* through the same CSS the overlay used). */
function InsuremoBrandName() {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
		className: BrandChrome_module_css_default.wordmark,
		"data-icomposer-brand-asset": "wordmark",
		"data-emitted-brand-assets": `${insuremo_wordmark_light_default}|${insuremo_wordmark_dark_default}`,
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
			className: BrandChrome_module_css_default.wordmarkLight,
			src: `${BRAND_ASSET_URL}/insuremo-wordmark-light.png`,
			alt: "",
			width: 312,
			height: 76,
			decoding: "async"
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
			className: BrandChrome_module_css_default.wordmarkDark,
			src: `${BRAND_ASSET_URL}/insuremo-wordmark-dark.png`,
			alt: "",
			width: 312,
			height: 76,
			decoding: "async"
		})]
	});
}

//#endregion
//#region ../ui-insuremo-status/src/client/locales.ts
/** Copy for the InsureMO sidebar status + workspace health strip. */
const zh$1 = {
	label: "InsureMO · 未配置",
	"health.strip": "工作区健康状态",
	"health.iComposer": "iComposer",
	"health.iComposerBound": "iComposer · 已关联",
	"health.iComposerPending": "iComposer · 待关联",
	"health.iComposerPendingHint": "已检测 iComposer 项目；本地 ICI 已可用，binding 仅用于远程写操作",
	"health.graphReady": "ICI Graph · 就绪",
	"health.graphNotReady": "ICI Graph · 未就绪",
	"health.explainReady": "ICI Explain · 就绪",
	"health.explainNotReady": "ICI Explain · 未就绪",
	"picker.label": "选择 Active Profile",
	"picker.close": "收起",
	"picker.loading": "加载中…",
	"picker.empty": "无可用 Profile",
	"picker.error": "无法连接",
	"picker.workspaceUnavailable": "当前工作区不可用",
	"picker.project": "项目 Profile",
	"picker.global": "全局 Profile"
};
const en$1 = {
	label: "InsureMO · Not configured",
	"health.strip": "Workspace health",
	"health.iComposer": "iComposer",
	"health.iComposerBound": "iComposer · Bound",
	"health.iComposerPending": "iComposer · Pending",
	"health.iComposerPendingHint": "iComposer project detected; local ICI is ready. Binding is only required for remote write operations",
	"health.graphReady": "ICI Graph · Ready",
	"health.graphNotReady": "ICI Graph · Not ready",
	"health.explainReady": "ICI Explain · Ready",
	"health.explainNotReady": "ICI Explain · Not ready",
	"picker.label": "Select Active Profile",
	"picker.close": "Collapse",
	"picker.loading": "Loading…",
	"picker.empty": "No profiles available",
	"picker.error": "Cannot connect",
	"picker.workspaceUnavailable": "Workspace unavailable",
	"picker.project": "Project Profiles",
	"picker.global": "Global Profiles"
};

//#endregion
//#region ../ui-insuremo-status/src/client/index.ts
/** Locale namespace contributed by the InsureMO sidebar status. */
const NS$1 = "sidebar.insuremo";
/** Services used by the client-side sidebar contribution. */
const inject$2 = ["slots", "locale"];
/** Register the static localized status badge in the sidebar footer. */
function apply$2(ctx) {
	ctx.effect(() => ctx.locale.register(NS$1, {
		zh: zh$1,
		en: en$1
	}), "ui-insuremo-status: dictionaries");
	ctx.slots.inject("sidebar.brand.name", () => ctx.slots.inject("conversation.hero.brand.mark", function* () {
		yield ctx.slots.register({
			name: "sidebar.brand.mark",
			priority: -1
		}, InsuremoBrandMark);
		yield ctx.slots.register({
			name: "sidebar.brand.name",
			priority: -1
		}, InsuremoBrandName);
		yield ctx.slots.register({
			name: "conversation.hero.brand.mark",
			priority: -1
		}, InsuremoBrandMark);
	}));
	const t = ctx.locale.bind(NS$1);
	ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
		name: "sidebar.footer.action",
		id: "insuremo-status",
		order: 10,
		locale: NS$1,
		label: () => t("label")
	}, WorkspaceAwareProfilePicker));
	ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
		name: "sidebar.footer.action",
		id: "insuremo-workspace-health",
		order: 11,
		locale: NS$1,
		label: () => t("health.strip")
	}, WorkspaceHealth));
}

//#endregion
//#region \0dsh-css:asset
const css$1 = ".wb6cd975b4_row{box-sizing:border-box;width:100%;min-height:36px;color:var(--dsw-alias-label-primary);border-radius:8px;align-items:center;gap:8px;padding:7px 12px;font-size:13px;line-height:20px;display:flex}.wb6cd975b4_row:hover{background:var(--dsw-alias-interactive-bg-hover)}.wb6cd975b4_icon{color:var(--dsw-alias-label-secondary);flex:none}.wb6cd975b4_kind{min-width:0;color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.wb6cd975b4_status{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap;border-radius:999px;flex:none;margin-left:auto;padding:1px 6px;font-size:11px;line-height:16px}.wb6cd975b4_digest{max-width:180px;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:none;overflow:hidden}";
const tagId$1 = "@icomposer/workbench/JobNode.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "@icomposer/workbench";
	tag.dataset.pluginCss = tagId$1;
	tag.textContent = css$1;
	document.head.appendChild(tag);
}
var JobNode_module_css_default = {
	"icon": "wb6cd975b4_icon",
	"status": "wb6cd975b4_status",
	"row": "wb6cd975b4_row",
	"digest": "wb6cd975b4_digest",
	"kind": "wb6cd975b4_kind"
};

//#endregion
//#region ../ui-workbench-jobs/src/client/JobNode.tsx
function dotState(status) {
	switch (status) {
		case "queued": return "warning";
		case "running": return "ongoing";
		case "done": return "done";
		case "failed": return "error";
	}
}
/** Render one read-only Workbench job row in the conversation flow. */
function JobNode({ node, t }) {
	const data = node.data;
	const status = t(`status.${data.status}`);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: JobNode_module_css_default.row,
		"data-job-id": data.jobId,
		"data-job-status": data.status,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.IconApiOutline14, {
				className: JobNode_module_css_default.icon,
				size: 14,
				"aria-hidden": "true"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: JobNode_module_css_default.kind,
				children: data.kindLabel
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: JobNode_module_css_default.status,
				role: "status",
				"aria-label": status,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(__deepseek_ai_dsh_client_ui_primitives.StateDot, { state: dotState(data.status) }), status]
			}),
			data.progressDigest !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: JobNode_module_css_default.digest,
				children: data.progressDigest
			})
		]
	});
}

//#endregion
//#region \0dsh-css:asset
const css = ".wb13b81332_card{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);width:100%;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border-radius:10px;padding:12px;font-size:13px}.wb13b81332_header{align-items:center;gap:8px;min-height:24px;display:flex}.wb13b81332_status{color:var(--dsw-alias-label-secondary);margin-left:auto;font-size:12px}.wb13b81332_summary,.wb13b81332_hint,.wb13b81332_consent,.wb13b81332_progress,.wb13b81332_done,.wb13b81332_error{margin:8px 0}.wb13b81332_hint{color:var(--dsw-alias-label-tertiary)}.wb13b81332_consent{color:var(--dsw-alias-label-secondary)}.wb13b81332_fieldset{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;gap:6px;margin:8px 0;padding:8px;display:grid}.wb13b81332_fieldset legend{color:var(--dsw-alias-label-secondary)}.wb13b81332_selectedReference{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;margin:0}.wb13b81332_referenceActions{flex-wrap:wrap;gap:8px;display:flex}.wb13b81332_field{align-items:center;gap:8px;margin:8px 0;display:flex}.wb13b81332_field span{min-width:76px;color:var(--dsw-alias-label-secondary)}.wb13b81332_field select{min-width:150px;max-width:100%}.wb13b81332_actions{gap:8px;margin-top:10px;display:flex}.wb13b81332_actions button,.wb13b81332_referenceActions button,.wb13b81332_card>button{border:1px solid var(--dsw-alias-border-l2);min-height:28px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);cursor:pointer;border-radius:6px;padding:4px 12px}.wb13b81332_actions button:first-child{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active)}button:disabled,select:disabled,input:disabled{cursor:not-allowed;opacity:.55}.wb13b81332_error,.wb13b81332_errorText{color:var(--dsw-alias-state-error-primary)}.wb13b81332_done{color:var(--dsw-alias-state-success-primary);overflow-wrap:anywhere}.wb13b81332_runMeta{color:var(--dsw-alias-label-tertiary);margin:4px 0;font-size:12px}.wb13b81332_session{cursor:pointer;user-select:all}.wb13b81332_batchJobRow{overflow-wrap:anywhere;margin:4px 0}";
const tagId = "@icomposer/workbench/IciExplainToolview.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "@icomposer/workbench";
	tag.dataset.pluginCss = tagId;
	tag.textContent = css;
	document.head.appendChild(tag);
}
var IciExplainToolview_module_css_default = {
	"progress": "wb13b81332_progress",
	"status": "wb13b81332_status",
	"fieldset": "wb13b81332_fieldset",
	"errorText": "wb13b81332_errorText",
	"selectedReference": "wb13b81332_selectedReference",
	"hint": "wb13b81332_hint",
	"field": "wb13b81332_field",
	"card": "wb13b81332_card",
	"batchJobRow": "wb13b81332_batchJobRow",
	"done": "wb13b81332_done",
	"summary": "wb13b81332_summary",
	"header": "wb13b81332_header",
	"error": "wb13b81332_error",
	"actions": "wb13b81332_actions",
	"referenceActions": "wb13b81332_referenceActions",
	"runMeta": "wb13b81332_runMeta",
	"session": "wb13b81332_session",
	"consent": "wb13b81332_consent"
};

//#endregion
//#region ../ui-workbench-jobs/src/client/IciExplainToolview.tsx
const PREFIX = "/api/icomposer-workbench/ici/explain";
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIVE = new Set([
	"awaiting-input",
	"scheduled",
	"confirmed",
	"running"
]);
const RUNNING = new Set([
	"scheduled",
	"confirmed",
	"running"
]);
const RETRYABLE = new Set([
	"failed",
	"cancelled",
	"interrupted"
]);
const MAX_PROMPT_BYTES = 256 * 1024;
const TEXT_EXTENSIONS = new Set([
	".md",
	".txt",
	".json",
	".yaml",
	".yml",
	".csv",
	".log"
]);
function resultText(block) {
	return "kind" in block ? block.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("") : "";
}
function jobIdOf(block) {
	return resultText(block).match(/\bjob=([a-f0-9]{16})\b/)?.[1];
}
function batchIdOf(block) {
	return resultText(block).match(/\bbatch=([a-f0-9]{16})\b/)?.[1];
}
function defaultModelOf(block) {
	const match = resultText(block).match(/\bdefault=([^/\s]+)\/([^\s]+?)(?=(?:\.\s|[\s,;]|$))/);
	return match ? {
		provider: match[1],
		model: match[2]
	} : {};
}
function statusLabel(status, t) {
	return typeof t === "function" ? t(`status.${status}`) : status;
}
function sessionShort(sessionId) {
	return typeof sessionId === "string" && SESSION_RE.test(sessionId) ? sessionId.slice(0, 8) : "";
}
function formatTime(value) {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return "";
	try {
		return new Date(value).toLocaleString(void 0, {
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit"
		});
	} catch {
		return "";
	}
}
function copySession(sessionId) {
	if (!sessionId) return;
	try {
		navigator.clipboard?.writeText(sessionId);
	} catch {}
}
function byteSize(value) {
	return `${(value / 1024).toFixed(value >= 1024 ? 1 : 0)} KiB`;
}
function validRelativePath(path) {
	return typeof path === "string" && path.length <= 512 && !path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && !path.split("/").some((part) => part === ".." || part === ".") && !path.startsWith(".metadata/");
}
function validReferenceTarget(value) {
	if (typeof value !== "object" || value === null) return false;
	const target = value;
	if (Object.keys(target).length !== 2) return false;
	if (target.kind === "none") return target.path === "";
	if (!validRelativePath(target.path)) return false;
	if (target.kind === "directory") return true;
	if (target.kind !== "file") return false;
	const dot = target.path.lastIndexOf(".");
	return dot > 0 && TEXT_EXTENSIONS.has(target.path.slice(dot).toLowerCase());
}
function targetLabel(target, t) {
	return target.kind === "none" ? t("explain.noReference") : target.kind === "file" ? t("explain.referenceFile") : t("explain.referenceDirectory");
}
const NONE_REFERENCE = {
	path: "",
	kind: "none"
};
function targetPath(target, t) {
	return target.kind === "none" ? "—" : target.path || t("explain.workspaceRoot");
}
function errorLabel(code, t) {
	switch (code) {
		case "picker-cancelled": return t("explain.pickerCancel");
		case "picker-unavailable": return t("explain.pickerUnavailable");
		case "picker-failed": return t("explain.pickerFailed");
		case "picker-aborted": return t("explain.pickerAborted");
		case "reference-outside-workspace": return t("explain.referenceOutsideWorkspace");
		case "reference-symlink": return t("explain.referenceSymlink");
		case "reference-unsupported": return t("explain.referenceUnsupported");
		default: return t("explain.pickerFailed");
	}
}
async function getStatus(jobId, signal) {
	try {
		const response = await fetch(`${PREFIX}/jobs/${jobId}/status`, {
			signal,
			headers: { Accept: "application/json" }
		});
		const body = await response.json();
		return response.ok && body.ok === true && body.result !== void 0 ? body.result : null;
	} catch {
		return null;
	}
}
async function getBatchStatus(batchId, signal) {
	try {
		const response = await fetch(`${PREFIX}/batches/${batchId}/status`, {
			signal,
			headers: { Accept: "application/json" }
		});
		const body = await response.json();
		return response.ok && body.ok === true && body.result !== void 0 ? body.result : null;
	} catch {
		return null;
	}
}
async function postPath(path, body) {
	try {
		const response = await fetch(path, {
			method: "POST",
			credentials: "same-origin",
			headers: {
				"Content-Type": "application/json",
				"X-Workbench-Action": "1",
				Accept: "application/json"
			},
			body: JSON.stringify(body)
		});
		const value = await response.json().catch(() => null);
		return value?.ok === true ? {
			ok: true,
			result: value.result
		} : {
			ok: false,
			code: value?.error?.code ?? "network"
		};
	} catch {
		return {
			ok: false,
			code: "network"
		};
	}
}
var IciExplainToolview = class extends react.Component {
	state;
	#controller;
	#poll;
	#pollKey;
	#initializedJob;
	#initializedBatch;
	#defaults;
	constructor(props) {
		super(props);
		const jobId = jobIdOf(props.block);
		const batchId = batchIdOf(props.block);
		const defaults = defaultModelOf(props.block);
		this.#defaults = defaults;
		this.state = {
			jobId,
			batchId,
			referenceTarget: NONE_REFERENCE,
			provider: defaults.provider ?? "",
			model: defaults.model ?? "",
			notBefore: "",
			busy: false
		};
	}
	componentDidMount() {
		this.syncPolling();
	}
	componentDidUpdate(previousProps) {
		const previousJobId = jobIdOf(previousProps.block);
		const previousBatchId = batchIdOf(previousProps.block);
		const nextJobId = jobIdOf(this.props.block);
		const nextBatchId = batchIdOf(this.props.block);
		if (nextJobId !== previousJobId || nextBatchId !== previousBatchId) {
			this.#defaults = defaultModelOf(this.props.block);
			this.#initializedJob = void 0;
			this.#initializedBatch = void 0;
			this.setState({
				jobId: nextJobId,
				batchId: nextBatchId,
				snapshot: void 0,
				batchSnapshot: void 0,
				referenceTarget: NONE_REFERENCE,
				provider: this.#defaults.provider ?? "",
				model: this.#defaults.model ?? "",
				notBefore: "",
				busy: false,
				localError: void 0
			}, this.syncPolling);
			return;
		}
		this.syncPolling();
	}
	componentWillUnmount() {
		this.stopPolling();
	}
	text(key) {
		return typeof this.props.t === "function" ? this.props.t(key) : key;
	}
	isActive() {
		if (this.state.batchId) return this.state.batchSnapshot?.jobs.some((job) => ACTIVE.has(job.status)) ?? true;
		return this.state.snapshot ? ACTIVE.has(this.state.snapshot.job.status) : true;
	}
	pollingKey() {
		return this.state.batchId ? `batch:${this.state.batchId}` : this.state.jobId ? `job:${this.state.jobId}` : void 0;
	}
	syncPolling = () => {
		const key = this.pollingKey();
		if (!key || !this.isActive()) {
			this.stopPolling();
			return;
		}
		if (this.#pollKey !== key) {
			this.stopPolling();
			this.#pollKey = key;
			this.refresh();
		}
		this.startPolling();
	};
	startPolling() {
		if (this.#poll !== void 0) return;
		this.#poll = setInterval(() => {
			if (this.isActive()) this.refresh();
		}, 1e3);
	}
	stopPolling() {
		if (this.#poll !== void 0) {
			clearInterval(this.#poll);
			this.#poll = void 0;
		}
		this.#pollKey = void 0;
		this.#controller?.abort();
		this.#controller = void 0;
	}
	beginRefresh(force = false) {
		if (this.#controller !== void 0 && !this.#controller.signal.aborted) {
			if (!force) return void 0;
			this.#controller.abort();
		}
		const controller = new AbortController();
		this.#controller = controller;
		return controller;
	}
	async refresh(force = false) {
		if (this.state.batchId) return this.refreshBatchStatus(force);
		return this.refreshJobStatus(force);
	}
	async refreshJobStatus(force = false) {
		const jobId = this.state.jobId;
		if (!jobId) return;
		const controller = this.beginRefresh(force);
		if (!controller) return;
		try {
			const next = await getStatus(jobId, controller.signal);
			if (!next || controller.signal.aborted || this.state.jobId !== jobId) return;
			const first = this.#initializedJob !== jobId;
			this.#initializedJob = jobId;
			this.setState((previous) => {
				const candidate = next.job.referenceTarget ?? next.referenceTarget;
				const selectedTarget = validReferenceTarget(candidate) ? candidate : typeof next.job.folderPath === "string" && next.job.folderPath !== "" && validReferenceTarget({
					path: next.job.folderPath,
					kind: "directory"
				}) ? {
					path: next.job.folderPath,
					kind: "directory"
				} : NONE_REFERENCE;
				const initialProvider = next.job.provider ?? (previous.provider || next.providers[0]?.id || "");
				const catalog = next.providers.find((item) => item.id === initialProvider)?.models ?? [];
				const initialModel = next.job.model ?? (catalog.some((item) => item.id === previous.model) ? previous.model : catalog[0]?.id ?? previous.model ?? "");
				return {
					...previous,
					snapshot: next,
					...first ? {
						referenceTarget: selectedTarget,
						provider: initialProvider,
						model: initialModel,
						notBefore: next.job.notBefore ? new Date(next.job.notBefore).toISOString().slice(0, 16) : ""
					} : {}
				};
			});
		} finally {
			if (this.#controller === controller) this.#controller = void 0;
		}
	}
	async refreshBatchStatus(force = false) {
		const batchId = this.state.batchId;
		if (!batchId) return;
		const controller = this.beginRefresh(force);
		if (!controller) return;
		try {
			const next = await getBatchStatus(batchId, controller.signal);
			if (!next || controller.signal.aborted || this.state.batchId !== batchId) return;
			const first = this.#initializedBatch !== batchId;
			this.#initializedBatch = batchId;
			this.setState((previous) => {
				const initialProvider = previous.provider || next.providers[0]?.id || "";
				const catalog = next.providers.find((item) => item.id === initialProvider)?.models ?? [];
				const initialModel = catalog.some((item) => item.id === previous.model) ? previous.model : catalog[0]?.id ?? previous.model ?? "";
				return {
					...previous,
					batchSnapshot: next,
					...first ? {
						provider: initialProvider,
						model: initialModel
					} : {}
				};
			});
		} finally {
			if (this.#controller === controller) this.#controller = void 0;
		}
	}
	chooseProvider(provider) {
		const selected = (this.state.snapshot?.providers ?? this.state.batchSnapshot?.providers ?? []).find((item) => item.id === provider);
		const model = selected?.models[0]?.id ?? (provider === this.#defaults.provider ? this.#defaults.model ?? "" : "");
		this.setState({
			provider,
			model
		});
	}
	async pickReference(kind) {
		const id = this.state.jobId ?? this.state.batchId;
		const scope = this.state.batchId ? "batches" : "jobs";
		if (!id || this.state.busy) return;
		this.setState({
			busy: true,
			localError: void 0
		});
		const outcome = await postPath(`${PREFIX}/${scope}/${id}/native-pick`, { kind });
		if (!outcome.ok) {
			this.setState({
				busy: false,
				...outcome.code === "picker-cancelled" ? { localError: void 0 } : { localError: outcome.code ?? "picker-failed" }
			});
			return;
		}
		const target = validReferenceTarget(outcome.result) ? outcome.result : void 0;
		if (!target) {
			this.setState({
				busy: false,
				localError: "picker-failed"
			});
			return;
		}
		this.setState({
			busy: false,
			referenceTarget: target,
			localError: void 0
		});
	}
	async confirm() {
		const { jobId, batchId, provider, model, referenceTarget, notBefore, snapshot, batchSnapshot } = this.state;
		const batchAwaiting = batchSnapshot?.jobs.filter((job) => job.status === "awaiting-input") ?? [];
		const promptTooLarge = batchId ? batchAwaiting.some((job) => (job.promptBaseBytes ?? 0) > MAX_PROMPT_BYTES) : (snapshot?.summary.promptBaseBytes ?? snapshot?.summary.sourceBytes ?? 0) > MAX_PROMPT_BYTES;
		const id = jobId ?? batchId;
		if (!id || !provider || !model || promptTooLarge || (batchId ? !batchSnapshot : !snapshot)) return;
		this.setState({
			busy: true,
			localError: void 0
		});
		let when;
		try {
			when = notBefore ? new Date(notBefore).toISOString() : (/* @__PURE__ */ new Date()).toISOString();
		} catch {
			this.setState({
				busy: false,
				localError: "confirmation-invalid"
			});
			return;
		}
		const scope = batchId ? "batches" : "jobs";
		const outcome = await postPath(`${PREFIX}/${scope}/${id}/confirm`, {
			provider,
			model,
			referenceTarget,
			docs: [],
			notBefore: when,
			consent: true
		});
		if (!outcome.ok) {
			this.setState({
				busy: false,
				localError: outcome.code
			});
			return;
		}
		if (batchId) this.setState((previous) => ({
			...previous,
			busy: false,
			batchSnapshot: previous.batchSnapshot ? {
				...previous.batchSnapshot,
				jobs: previous.batchSnapshot.jobs.map((job) => job.status === "awaiting-input" ? {
					...job,
					status: "scheduled"
				} : job)
			} : void 0
		}));
		else this.setState((previous) => ({
			...previous,
			busy: false,
			snapshot: previous.snapshot ? {
				...previous.snapshot,
				job: {
					...previous.snapshot.job,
					status: "scheduled",
					folderPath: referenceTarget.path,
					referenceTarget,
					notBefore: outcome.result.notBefore
				}
			} : void 0
		}));
	}
	async cancel() {
		const id = this.state.jobId ?? this.state.batchId;
		if (!id || this.state.busy) return;
		this.setState({ busy: true });
		const scope = this.state.batchId ? "batches" : "jobs";
		const outcome = await postPath(`${PREFIX}/${scope}/${id}/cancel`, {});
		if (!outcome.ok) {
			this.setState({
				busy: false,
				localError: outcome.code
			});
			return;
		}
		if (this.state.batchId) this.setState((previous) => ({
			...previous,
			busy: false,
			batchSnapshot: previous.batchSnapshot ? {
				...previous.batchSnapshot,
				jobs: previous.batchSnapshot.jobs.map((job) => ACTIVE.has(job.status) ? {
					...job,
					status: "cancelled"
				} : job)
			} : void 0
		}));
		else this.setState((previous) => ({
			...previous,
			busy: false,
			snapshot: previous.snapshot ? {
				...previous.snapshot,
				job: {
					...previous.snapshot.job,
					status: "cancelled"
				}
			} : void 0
		}));
	}
	async retry() {
		const id = this.state.jobId ?? this.state.batchId;
		if (!id || this.state.busy) return;
		this.setState({
			busy: true,
			localError: void 0
		});
		const scope = this.state.batchId ? "batches" : "jobs";
		const outcome = await postPath(`${PREFIX}/${scope}/${id}/retry`, {});
		if (!outcome.ok) {
			this.setState({
				busy: false,
				localError: outcome.code ?? "network"
			});
			return;
		}
		if (this.state.batchId) {
			this.setState({ busy: false }, () => {
				this.refresh(true);
			});
			return;
		}
		if (typeof outcome.result?.jobId !== "string") {
			this.setState({
				busy: false,
				localError: "network"
			});
			return;
		}
		this.#initializedJob = void 0;
		this.setState({
			busy: false,
			jobId: outcome.result.jobId,
			snapshot: void 0,
			referenceTarget: NONE_REFERENCE,
			provider: "",
			model: "",
			notBefore: "",
			localError: void 0
		}, this.syncPolling);
	}
	providers() {
		return this.state.snapshot?.providers ?? this.state.batchSnapshot?.providers ?? [];
	}
	renderRunMeta(t, meta) {
		const parts = [];
		if (meta.provider && meta.model) parts.push(`${meta.provider}/${meta.model}`);
		const started = formatTime(meta.startedAt);
		const finished = formatTime(meta.finishedAt);
		if (started) parts.push(`${t("explain.startedAt")} ${started}`);
		if (finished) parts.push(`${t("explain.finishedAt")} ${finished}`);
		const short = sessionShort(meta.childSessionId);
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
			className: IciExplainToolview_module_css_default.runMeta,
			children: [parts.join(" · "), short ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · ", /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", {
				className: IciExplainToolview_module_css_default.session,
				title: meta.childSessionId,
				onClick: () => copySession(meta.childSessionId),
				children: [
					t("explain.session"),
					" ",
					short
				]
			})] }) : null]
		});
	}
	renderBatchJobRow(t, job) {
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
			className: IciExplainToolview_module_css_default.batchJobRow,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: job.apiName }),
				" · ",
				statusLabel(job.status, t),
				job.provider && job.model ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					" · ",
					job.provider,
					"/",
					job.model
				] }) : null,
				job.artifactPath ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: job.artifactPath })] }) : null,
				job.error ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [" · ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: IciExplainToolview_module_css_default.errorText,
					children: job.error
				})] }) : null,
				this.renderRunMeta(t, job)
			]
		}, job.jobId);
	}
	clearReference() {
		if (this.state.busy) return;
		this.setState({
			referenceTarget: NONE_REFERENCE,
			localError: void 0
		});
	}
	renderConfirmation(t, batch) {
		const { referenceTarget, provider, model, notBefore, busy, localError, snapshot, batchSnapshot } = this.state;
		const providers = this.providers();
		const models = providers.find((item) => item.id === provider)?.models ?? [];
		const promptBytes = batch ? batchSnapshot?.summary.promptBaseBytes ?? 0 : snapshot?.summary.promptBaseBytes ?? snapshot?.summary.sourceBytes ?? 0;
		const awaiting = batchSnapshot?.jobs.filter((job) => job.status === "awaiting-input") ?? [];
		const promptTooLarge = batch ? awaiting.some((job) => (job.promptBaseBytes ?? 0) > MAX_PROMPT_BYTES) : promptBytes > MAX_PROMPT_BYTES;
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: IciExplainToolview_module_css_default.consent,
				children: t("explain.consent")
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
				className: IciExplainToolview_module_css_default.fieldset,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("legend", { children: t("explain.referenceTarget") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
						className: IciExplainToolview_module_css_default.selectedReference,
						children: [
							t("explain.selectedReference"),
							": ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: targetPath(referenceTarget, t) }),
							" · ",
							targetLabel(referenceTarget, t)
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
						className: IciExplainToolview_module_css_default.hint,
						children: t("explain.workspaceOnlyHint")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: IciExplainToolview_module_css_default.referenceActions,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: busy || referenceTarget.kind === "none",
								onClick: () => this.clearReference(),
								children: t("explain.noReference")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: busy,
								onClick: () => void this.pickReference("file"),
								children: t("explain.chooseFile")
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: busy,
								onClick: () => void this.pickReference("directory"),
								children: t("explain.chooseDirectory")
							})
						]
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				className: IciExplainToolview_module_css_default.field,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("explain.provider") }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
					value: provider,
					disabled: busy,
					onChange: (event) => this.chooseProvider(event.target.value),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: "",
						children: t("explain.choose")
					}), providers.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: item.id,
						children: item.id
					}, item.id))]
				})]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				className: IciExplainToolview_module_css_default.field,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("explain.model") }), models.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
					value: model,
					disabled: busy,
					onChange: (event) => this.setState({ model: event.target.value }),
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
						value: "",
						children: t("explain.choose")
					}), models.map((item) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
						value: item.id,
						children: [
							item.name,
							" · ",
							item.id
						]
					}, item.id))]
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					value: model,
					disabled: busy,
					onChange: (event) => this.setState({ model: event.target.value })
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: IciExplainToolview_module_css_default.hint,
					children: t("explain.customModelHint")
				})] })]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
				className: IciExplainToolview_module_css_default.field,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: t("explain.earliest") }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "datetime-local",
						value: notBefore,
						disabled: busy,
						onChange: (event) => this.setState({ notBefore: event.target.value })
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						disabled: busy,
						onClick: () => this.setState({ notBefore: "" }),
						children: t("explain.now")
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				className: IciExplainToolview_module_css_default.hint,
				children: [
					t("explain.notBeforeHint"),
					" · ",
					Intl.DateTimeFormat().resolvedOptions().timeZone
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
				className: IciExplainToolview_module_css_default.usage,
				children: [
					t(batch ? "explain.batchUsage" : "explain.usage"),
					": ",
					byteSize(promptBytes),
					" / 256 KiB",
					batch ? ` · ${t("explain.batchPerJobLimit")}` : "",
					promptTooLarge ? ` · ${t("explain.inputTooLarge")}` : ""
				]
			}),
			promptTooLarge ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: IciExplainToolview_module_css_default.error,
				role: "alert",
				children: t(batch ? "explain.batchTooLarge" : "explain.promptTooLarge")
			}) : null,
			localError ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: IciExplainToolview_module_css_default.error,
				role: "alert",
				children: errorLabel(localError, t)
			}) : null,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: IciExplainToolview_module_css_default.actions,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					title: promptTooLarge ? t(batch ? "explain.batchTooLarge" : "explain.promptTooLarge") : void 0,
					disabled: busy || !provider || !model || promptTooLarge,
					onClick: () => void this.confirm(),
					children: snapshot?.job.status === "scheduled" && !batch ? t("explain.update") : t("explain.start")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					disabled: busy,
					onClick: () => void this.cancel(),
					children: t(batch ? "explain.batchCancelAll" : "explain.cancel")
				})]
			})
		] });
	}
	renderBatch(t) {
		const batch = this.state.batchSnapshot;
		const jobs = batch?.jobs ?? [];
		const status = batch ? batchStatus(jobs) : "awaiting-input";
		const awaiting = jobs.filter((job) => job.status === "awaiting-input");
		const confirmable = awaiting.length > 0 && jobs.every((job) => job.status === "awaiting-input" || job.status === "final");
		const retryable = jobs.some((job) => RETRYABLE.has(job.status)) && !jobs.some((job) => RUNNING.has(job.status));
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
			title: `${t("explain.batchTitle")} · ${jobs.length} ${t("explain.batchApis")}`,
			status,
			t,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: IciExplainToolview_module_css_default.summary,
					children: [
						t("explain.batchList"),
						": ",
						jobs.length,
						" ",
						t("explain.batchApis")
					]
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: IciExplainToolview_module_css_default.hint,
					"data-testid": "ici-explain-batch-jobs",
					children: jobs.map((job) => this.renderBatchJobRow(t, job))
				}),
				batch && confirmable ? this.renderConfirmation(t, true) : null,
				batch && !confirmable && !retryable && RUNNING.has(status) ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: IciExplainToolview_module_css_default.progress,
					role: "status",
					children: [
						statusLabel(status, t),
						" · ",
						t("explain.waitingIdle")
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					disabled: this.state.busy,
					onClick: () => void this.cancel(),
					children: t("explain.batchCancelAll")
				})] }) : null,
				batch && status === "final" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: IciExplainToolview_module_css_default.done,
					role: "status",
					children: t("explain.complete")
				}) : null,
				batch && retryable ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: IciExplainToolview_module_css_default.error,
					role: "alert",
					children: t("explain.batchFailed")
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					disabled: this.state.busy,
					onClick: () => void this.retry(),
					children: t("explain.batchRetryFailed")
				})] }) : null,
				!batch ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: IciExplainToolview_module_css_default.progress,
					children: t("explain.prepareWaiting")
				}) : null
			]
		});
	}
	render() {
		const t = this.text.bind(this);
		if (this.state.batchId) return this.renderBatch(t);
		const { snapshot, jobId } = this.state;
		if (!jobId) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Card, {
			title: t("explain.title"),
			status: "awaiting-input",
			t,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
				className: IciExplainToolview_module_css_default.progress,
				children: t("explain.prepareWaiting")
			})
		});
		const status = snapshot?.job.status ?? "awaiting-input";
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Card, {
			title: snapshot?.job.apiName ?? t("explain.title"),
			status,
			t,
			children: [
				snapshot ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: IciExplainToolview_module_css_default.summary,
					children: [
						snapshot.summary.nodes,
						" ",
						t("explain.nodes"),
						" · ",
						snapshot.summary.sourceFiles,
						" ",
						t("explain.sources"),
						" · ",
						snapshot.summary.readableSources,
						" ",
						t("explain.readable")
					]
				}) : null,
				snapshot ? this.renderRunMeta(t, snapshot.job) : null,
				snapshot?.summary.truncated ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: IciExplainToolview_module_css_default.hint,
					children: t("explain.truncated")
				}) : null,
				status === "awaiting-input" || status === "scheduled" ? this.renderConfirmation(t, false) : null,
				status === "confirmed" || status === "running" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: IciExplainToolview_module_css_default.progress,
					role: "status",
					children: [
						statusLabel(status, t),
						" · ",
						t("explain.waitingIdle")
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					disabled: this.state.busy,
					onClick: () => void this.cancel(),
					children: t("explain.cancel")
				})] }) : null,
				status === "final" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					className: IciExplainToolview_module_css_default.done,
					role: "status",
					children: [
						t("explain.complete"),
						": ",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: snapshot?.job.artifactPath ?? "—" })
					]
				}) : null,
				status === "failed" || status === "cancelled" || status === "interrupted" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: IciExplainToolview_module_css_default.error,
					role: "alert",
					children: this.state.localError ?? snapshot?.job.error ?? statusLabel(status, t)
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					disabled: this.state.busy,
					onClick: () => void this.retry(),
					children: t("explain.retry")
				})] }) : null
			]
		});
	}
};
function batchStatus(jobs) {
	if (jobs.some((job) => job.status === "running")) return "running";
	if (jobs.some((job) => job.status === "scheduled" || job.status === "confirmed")) return "scheduled";
	if (jobs.some((job) => job.status === "failed")) return "failed";
	if (jobs.some((job) => job.status === "interrupted")) return "interrupted";
	if (jobs.some((job) => job.status === "awaiting-input")) return "awaiting-input";
	if (jobs.some((job) => job.status === "cancelled")) return "cancelled";
	return "final";
}
function Card({ title, status, t, children }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
		className: IciExplainToolview_module_css_default.card,
		"data-job-status": status,
		"data-testid": "ici-explain-card",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
			className: IciExplainToolview_module_css_default.header,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: title }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: IciExplainToolview_module_css_default.status,
				children: statusLabel(status, t)
			})]
		}), children]
	});
}

//#endregion
//#region ../ui-workbench-jobs/src/client/locales.ts
/** Copy for the Workbench job conversation node. */
const zh = {
	"status.queued": "排队中",
	"status.running": "运行中",
	"status.done": "已完成",
	"status.failed": "失败",
	"status.awaiting-input": "等待确认",
	"status.scheduled": "已计划",
	"status.confirmed": "已确认",
	"status.final": "已完成",
	"status.cancelled": "已取消",
	"status.interrupted": "已中断",
	"explain.title": "ICI 业务解释",
	"explain.nodes": "个节点",
	"explain.sources": "个源码文件",
	"explain.truncated": "调用链已截断",
	"explain.consent": "开始后，所选模型将收到列出的源码片段和选中的参考文档。",
	"explain.provider": "Provider",
	"explain.model": "模型",
	"explain.choose": "请选择",
	"explain.noModels": "没有可用模型",
	"explain.customModelHint": "该 Provider 可直接输入可路由的 model ID",
	"explain.chooseReference": "选择 Workspace 文件或文件夹",
	"explain.referenceTarget": "参考资料范围",
	"explain.chooseFile": "选择 Workspace 文件…",
	"explain.chooseDirectory": "选择 Workspace 文件夹…",
	"explain.workspaceOnlyHint": "只能选择当前 Workspace 内的文件或文件夹",
	"explain.selectedReference": "已选择",
	"explain.referenceDirectory": "文件夹",
	"explain.referenceFile": "文件",
	"explain.selectCurrentDirectory": "选择当前文件夹",
	"explain.select": "选择",
	"explain.pickerSelection": "当前选择",
	"explain.pickerCancel": "取消",
	"explain.pickerConfirm": "确认选择",
	"explain.promptTooLarge": "输入超出预算，请重新构建 ICI 图谱或缩小范围",
	"explain.start": "开始",
	"explain.update": "更新计划",
	"explain.cancel": "取消",
	"explain.retry": "重试",
	"explain.complete": "完成，产物",
	"explain.prepareFailed": "准备失败",
	"explain.prepareWaiting": "正在准备解释卡片…",
	"explain.readable": "可读",
	"explain.folder": "参考资料目录",
	"explain.useFolder": "选择此目录",
	"explain.folderUnavailable": "目录不存在、不可读或不在工作区内",
	"explain.pickerUnavailable": "当前宿主没有可用的原生文件选择器",
	"explain.pickerFailed": "原生文件选择器打开失败",
	"explain.pickerAborted": "原生文件选择已中止",
	"explain.referenceOutsideWorkspace": "所选路径不在当前 Workspace 内",
	"explain.referenceSymlink": "不允许选择符号链接路径",
	"explain.referenceUnsupported": "只能选择支持的文本文件或常规文件夹",
	"explain.workspaceRoot": "工作区根目录",
	"explain.folderHint": "仅允许工作区内目录；后台 AI 只读浏览该目录并自主选择文本资料",
	"explain.unsupportedFiles": "已隐藏不支持的文件：",
	"explain.earliest": "最早开始时间",
	"explain.now": "立即",
	"explain.notBeforeHint": "这是 not-before，不保证准点；到时后将在所属 Agent 下一次 idle 运行",
	"explain.scheduledAt": "计划最早开始",
	"explain.waitingIdle": "等待 Agent idle",
	"explain.usage": "预计输入",
	"explain.inputTooLarge": "超出输入预算",
	"explain.batchTitle": "批量业务解释",
	"explain.batchApis": "个 API",
	"explain.batchList": "任务列表",
	"explain.batchUsage": "批内预计输入",
	"explain.batchPerJobLimit": "每个任务不超过 256 KiB",
	"explain.batchTooLarge": "批内有任务超出输入预算",
	"explain.batchCancelAll": "取消整批",
	"explain.batchRetryFailed": "重试失败任务",
	"explain.batchFailed": "批内部分任务失败",
	"explain.session": "会话",
	"explain.startedAt": "开始",
	"explain.finishedAt": "结束",
	"explain.noReference": "不使用参考资料"
};
const en = {
	"status.queued": "Queued",
	"status.running": "Running",
	"status.done": "Done",
	"status.failed": "Failed",
	"status.awaiting-input": "Waiting for confirmation",
	"status.scheduled": "Scheduled",
	"status.confirmed": "Confirmed",
	"status.final": "Complete",
	"status.cancelled": "Cancelled",
	"status.interrupted": "Interrupted",
	"explain.title": "ICI explanation",
	"explain.nodes": "nodes",
	"explain.sources": "source files",
	"explain.truncated": "Call chain truncated",
	"explain.consent": "The selected model will receive the listed source excerpts and selected reference documents.",
	"explain.provider": "Provider",
	"explain.model": "Model",
	"explain.choose": "Choose",
	"explain.noModels": "No models available",
	"explain.customModelHint": "This provider accepts a routable model ID directly",
	"explain.chooseReference": "Select Workspace file or folder",
	"explain.referenceTarget": "Reference scope",
	"explain.chooseFile": "Select Workspace file…",
	"explain.chooseDirectory": "Select Workspace folder…",
	"explain.workspaceOnlyHint": "Only files or folders inside the current Workspace may be selected",
	"explain.selectedReference": "Selected",
	"explain.referenceDirectory": "Folder",
	"explain.referenceFile": "File",
	"explain.selectCurrentDirectory": "Select current folder",
	"explain.select": "Select",
	"explain.pickerSelection": "Current selection",
	"explain.pickerCancel": "Cancel",
	"explain.pickerConfirm": "Confirm selection",
	"explain.promptTooLarge": "Input exceeds the budget; rebuild the ICI graph or narrow the scope",
	"explain.start": "Start",
	"explain.update": "Update schedule",
	"explain.cancel": "Cancel",
	"explain.retry": "Retry",
	"explain.complete": "Complete, artifact",
	"explain.prepareFailed": "Preparation failed",
	"explain.prepareWaiting": "Preparing the explanation card…",
	"explain.readable": "readable",
	"explain.folder": "Reference directory",
	"explain.useFolder": "Use this directory",
	"explain.folderUnavailable": "Directory is missing, unreadable, or outside the workspace",
	"explain.pickerUnavailable": "No native file picker is available on this host",
	"explain.pickerFailed": "The native file picker failed to open",
	"explain.pickerAborted": "The native file selection was aborted",
	"explain.referenceOutsideWorkspace": "The selected path is outside this Workspace",
	"explain.referenceSymlink": "Symbolic-link paths cannot be selected",
	"explain.referenceUnsupported": "Select a supported text file or regular folder",
	"explain.workspaceRoot": "Workspace root",
	"explain.folderHint": "Only workspace-relative directories are allowed; the background AI reads text material from this directory only",
	"explain.unsupportedFiles": "Unsupported files hidden:",
	"explain.earliest": "Earliest start",
	"explain.now": "Now",
	"explain.notBeforeHint": "This is not-before, not an exact appointment; it runs on the owning Agent's next idle after the time",
	"explain.scheduledAt": "Earliest scheduled start",
	"explain.waitingIdle": "Waiting for Agent idle",
	"explain.usage": "Estimated input",
	"explain.inputTooLarge": "Input budget exceeded",
	"explain.batchTitle": "Batch explanation",
	"explain.batchApis": "APIs",
	"explain.batchList": "Jobs",
	"explain.batchUsage": "Estimated batch input",
	"explain.batchPerJobLimit": "each job must stay within 256 KiB",
	"explain.batchTooLarge": "One or more batch jobs exceed the input budget",
	"explain.batchCancelAll": "Cancel batch",
	"explain.batchRetryFailed": "Retry failed jobs",
	"explain.batchFailed": "Some batch jobs failed",
	"explain.session": "Session",
	"explain.startedAt": "started",
	"explain.finishedAt": "finished",
	"explain.noReference": "No reference"
};

//#endregion
//#region ../ui-workbench-jobs/src/client/index.ts
/** Locale namespace contributed by the Workbench job conversation node. */
const NS = "conversation.workbenchJob";
/**
* Runtime services required by the keyed render contribution. The current
* phase consumes future node data through props; sessions remains an explicit
* dependency so the jobs mirror is available when host node assembly lands.
*/
const inject$3 = [
	"slots",
	"locale",
	"sessions"
];
/** Register dictionaries plus the generic Job node and interactive ICI toolview. */
function apply$3(ctx) {
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "ui-workbench-jobs: dictionaries");
	ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
		name: "conversation.chat.node",
		key: "workbench-job",
		locale: NS
	}, JobNode));
	ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
		name: "tool.call.toolview",
		key: "ici_explain",
		locale: NS
	}, IciExplainToolview));
}

//#endregion
//#region src/client/index.ts
/**
* Union of the three sub-plugins' client injects, derived from each
* sub-plugin's own declaration so a new service requirement never drifts:
* the loader provides every listed service up front and cordis guards any
* undeclared ctx property access at runtime.
*/
const inject = [...new Set([
	...inject$1,
	...inject$2,
	...inject$3
])];
/** Register dictionaries + slot contributions for all three UI blocks. */
function apply(ctx) {
	apply$1(ctx);
	apply$2(ctx);
	apply$3(ctx);
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=client.js.map