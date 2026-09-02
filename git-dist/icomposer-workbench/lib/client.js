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
				return {
					name: str(e?.name, ""),
					description: str(e?.description, ""),
					enabled: bool(e?.enabled)
				};
			}).filter((e) => e.name.length > 0) } : {},
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
//#region \0dsh-css:asset
const css$5 = ".wbf3683280_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:12px;flex-direction:column;font-size:13px;transition:border-color .16s,background .16s;display:flex}.wbf3683280_card:hover{border-color:var(--dsw-alias-label-dimmed)}.wbf3683280_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}.wbf3683280_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}.wbf3683280_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}.wbf3683280_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}.wbf3683280_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}.wbf3683280_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}.wbf3683280_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}.wbf3683280_chevronOpen{transform:rotate(180deg)}.wbf3683280_pending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}.wbf3683280_body{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:14px;margin:0 16px;padding:14px 0 8px;display:flex}.wbf3683280_footer{justify-content:flex-end;align-items:center;gap:8px;padding:4px 0;display:flex}.wbf3683280_refresh,.wbf3683280_action{appearance:none;border:1px solid var(--dsw-alias-border-l2);font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}.wbf3683280_refresh:hover,.wbf3683280_action:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}.wbf3683280_refresh:focus-visible,.wbf3683280_action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}.wbf3683280_action:disabled{cursor:not-allowed;opacity:.55}.wbf3683280_controls{flex-wrap:wrap;align-items:center;gap:8px;margin:0;display:flex}.wbf3683280_select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);min-width:220px;height:32px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 10px;font-size:13px}.wbf3683280_select:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.wbf3683280_select:disabled{cursor:not-allowed;opacity:.55}.wbf3683280_region{flex-direction:column;gap:6px;display:flex}.wbf3683280_region h4{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;font-weight:600}.wbf3683280_list{flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;display:flex}.wbf3683280_list li{flex-wrap:wrap;align-items:center;gap:8px;display:flex}.wbf3683280_toggle{appearance:none;color:inherit;cursor:pointer;background:0 0;border:0;border-radius:999px;flex:none;align-items:center;padding:2px 0;display:inline-flex}.wbf3683280_toggle:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.wbf3683280_toggle:disabled{cursor:not-allowed;opacity:.55}.wbf3683280_controlTrack{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);width:30px;height:18px;transition:background .12s var(--ds-ease-in-out), border-color .12s var(--ds-ease-in-out);border-radius:999px;align-items:center;display:inline-flex}.wbf3683280_toggle[aria-checked=true] .wbf3683280_controlTrack{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary)}.wbf3683280_controlThumb{background:var(--dsw-alias-bg-layer-1);width:14px;height:14px;transition:transform .12s var(--ds-ease-in-out);border-radius:50%;margin-left:1px;transform:translate(0)}.wbf3683280_toggle[aria-checked=true] .wbf3683280_controlThumb{transform:translate(12px)}.wbf3683280_meta{color:var(--dsw-alias-label-tertiary);font-size:12px}.wbf3683280_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px}.wbf3683280_error{color:var(--dsw-alias-state-error-primary);font-size:12px}.wbf3683280_small{color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:0;padding:0 2px;font-size:13px}.wbf3683280_small:hover{color:var(--dsw-alias-state-error-primary)}";
const tagId$5 = "@icomposer/workbench/InsuremoCard.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$5) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "@icomposer/workbench";
	tag.dataset.pluginCss = tagId$5;
	tag.textContent = css$5;
	document.head.appendChild(tag);
}
var InsuremoCard_module_css_default = {
	"footer": "wbf3683280_footer",
	"header": "wbf3683280_header",
	"refresh": "wbf3683280_refresh",
	"description": "wbf3683280_description",
	"headText": "wbf3683280_headText",
	"region": "wbf3683280_region",
	"meta": "wbf3683280_meta",
	"error": "wbf3683280_error",
	"small": "wbf3683280_small",
	"controls": "wbf3683280_controls",
	"toggle": "wbf3683280_toggle",
	"controlThumb": "wbf3683280_controlThumb",
	"hint": "wbf3683280_hint",
	"chevron": "wbf3683280_chevron",
	"select": "wbf3683280_select",
	"card": "wbf3683280_card",
	"cardOpen": "wbf3683280_cardOpen",
	"list": "wbf3683280_list",
	"chevronOpen": "wbf3683280_chevronOpen",
	"pending": "wbf3683280_pending",
	"controlTrack": "wbf3683280_controlTrack",
	"action": "wbf3683280_action",
	"body": "wbf3683280_body",
	"name": "wbf3683280_name"
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
							onChanged: () => void this.silentReload()
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SkillsRegion, {
							t,
							skills: state.view.skills,
							onChanged: () => void this.silentReload()
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
				onChanged: props.onChanged
			}) : null,
			missing ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(InstallButton, {
				t,
				onChanged: props.onChanged
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
		] }), this.state.install.phase === "failed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			className: InsuremoCard_module_css_default.hint,
			"data-install-retry": "1",
			children: t("cliInstallRetryHint")
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			className: InsuremoCard_module_css_default.hint,
			children: t("cliInstallHint")
		})] });
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
					this.state.upgrade.message
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
var SkillsRegion = class extends react.Component {
	state = {
		rows: {},
		updatingAll: false,
		scenario: SKILL_SCENARIOS[0],
		scenarioRun: { phase: "idle" }
	};
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
		return this.state.updatingAll || this.state.scenarioRun.phase === "busy";
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
	/** Explicit install/sync of the selected allowlisted scenario. */
	async syncScenario() {
		if (this.#busy) return;
		this.setState({ scenarioRun: { phase: "busy" } });
		const outcome = await postAction$1("skill-install", { scenario: this.state.scenario });
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
			const message = outcome.error.code === "network" ? this.props.t("errorNetwork") : `${outcome.error.code}: ${outcome.error.message}`;
			this.setState({ scenarioRun: {
				phase: "failed",
				message
			} });
		}
	}
	render() {
		const { t, skills } = this.props;
		const entries = skills.entries ?? [];
		const cold = skills.code === "fast-uncached";
		const busy = this.#busy;
		const run = this.state.scenarioRun;
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: InsuremoCard_module_css_default.region,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h4", { children: t("skillsTitle") }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: InsuremoCard_module_css_default.controls,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [
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
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: InsuremoCard_module_css_default.action,
							disabled: busy,
							"aria-busy": run.phase === "busy" || void 0,
							onClick: () => void this.syncScenario(),
							"aria-label": `${t("skillsScenarioInstall")}: ${this.state.scenario}`,
							children: run.phase === "busy" ? t("skillsScenarioInstalling") : t("skillsScenarioInstall")
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: InsuremoCard_module_css_default.action,
							disabled: busy,
							"aria-busy": this.state.updatingAll || void 0,
							onClick: () => void this.updateAll(),
							"aria-label": `${t("skillsUpdateAll")} · ${t("skillsScopeHint")}`,
							children: this.state.updatingAll ? t("skillsUpdatingAll") : t("skillsUpdateAll")
						})
					]
				}),
				run.phase === "done" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					role: "status",
					"data-scenario": "done",
					children: [t("skillsScenarioDone"), run.diff === void 0 ? "" : `: ${diffText(run.diff, t)}`]
				}) : null,
				run.phase === "failed" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					role: "alert",
					"data-scenario": "failed",
					className: InsuremoCard_module_css_default.error,
					children: [
						t("skillsScenarioFailed"),
						": ",
						run.message,
						run.diff === void 0 ? "" : ` · ${diffText(run.diff, t)}`,
						" · ",
						t("skillsRetryHint")
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
						t("skillsRetryHint")
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
	errorNetwork: "无法连接"
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
	errorNetwork: "Cannot connect"
};

//#endregion
//#region ../ui-insuremo-settings/src/client/index.ts
/** Locale namespace contributed by the InsureMO settings card. */
const NS$2 = "settings.insuremo";
/** Register the localized InsureMO Plugins-tab card. */
function apply$1(ctx) {
	ctx.effect(() => ctx.locale.register(NS$2, {
		zh: zh$2,
		en: en$2
	}), "ui-insuremo-settings: dictionaries");
	ctx.slots.inject("settings.plugin.item", () => ctx.slots.register({
		name: "settings.plugin.item",
		key: "insuremo",
		id: "insuremo",
		locale: NS$2
	}, InsuremoCard));
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
	"wordmarkDark": "wb06155adc_wordmarkDark",
	"heroMark": "wb06155adc_heroMark",
	"dsh": "wb06155adc_dsh",
	"wordmarkLight": "wb06155adc_wordmarkLight",
	"railHost": "wb06155adc_railHost",
	"wordmark": "wb06155adc_wordmark",
	"driver": "wb06155adc_driver",
	"wordmarkInner": "wb06155adc_wordmarkInner",
	"railMark": "wb06155adc_railMark",
	"wordmarkHost": "wb06155adc_wordmarkHost"
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
	"icon": "wb8730382c_icon",
	"rowIcons": "wb8730382c_rowIcons",
	"driver": "wb8730382c_driver"
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
const css$2 = ".wba94a6eca_trigger{box-sizing:border-box;width:100%;min-height:28px;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:7px;padding:4px 9px;font-size:12px;line-height:18px;display:inline-flex;overflow:hidden}.wba94a6eca_trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.wba94a6eca_dot{background:var(--dsw-alias-state-warn-primary);border-radius:50%;flex:none;width:7px;height:7px}.wba94a6eca_label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.wba94a6eca_picker{flex-direction:column;gap:2px;padding:2px 0;display:flex}.wba94a6eca_pickerHeader{box-sizing:border-box;width:100%;min-height:28px;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:7px;padding:4px 9px;font-size:12px;line-height:18px;display:inline-flex;overflow:hidden}.wba94a6eca_closeMark{color:var(--dsw-alias-label-tertiary);margin-left:auto}.wba94a6eca_list{flex-direction:column;gap:1px;margin:0;padding:0;list-style:none;display:flex}.wba94a6eca_row{box-sizing:border-box;width:100%;min-height:26px;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;background:0 0;border:0;border-radius:6px;align-items:center;gap:6px;padding:3px 9px 3px 22px;font-size:12px;line-height:17px;display:inline-flex;overflow:hidden}.wba94a6eca_row:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.wba94a6eca_row[data-default=\"1\"]{color:var(--dsw-alias-label-primary)}.wba94a6eca_rowName{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.wba94a6eca_rowMark{color:var(--dsw-alias-state-success-primary);flex:none}.wba94a6eca_hint{color:var(--dsw-alias-label-tertiary);margin:0;padding:2px 9px;font-size:11px}.wba94a6eca_error{color:var(--dsw-alias-state-error-primary);padding:2px 9px;font-size:11px}";
const tagId$2 = "@icomposer/workbench/ProfilePicker.module.css";
if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$2) + "]") === null) {
	const tag = document.createElement("style");
	tag.dataset.plugin = "@icomposer/workbench";
	tag.dataset.pluginCss = tagId$2;
	tag.textContent = css$2;
	document.head.appendChild(tag);
}
var ProfilePicker_module_css_default = {
	"picker": "wba94a6eca_picker",
	"rowName": "wba94a6eca_rowName",
	"row": "wba94a6eca_row",
	"rowMark": "wba94a6eca_rowMark",
	"pickerHeader": "wba94a6eca_pickerHeader",
	"list": "wba94a6eca_list",
	"label": "wba94a6eca_label",
	"error": "wba94a6eca_error",
	"dot": "wba94a6eca_dot",
	"closeMark": "wba94a6eca_closeMark",
	"trigger": "wba94a6eca_trigger",
	"hint": "wba94a6eca_hint"
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
* Sidebar Active Profile selector (TASK-047): rendered as plain text rows
* matching the session rows — collapsed shows the current active profile
* name; expanded lists profile names with env/account/tenant on hover.
* Data comes from the fast overview channel (sanitized overview read, no CLI
* subprocess); the switch still goes through the write bridge.
*/
var ProfilePicker = class extends react.Component {
	state = { phase: "collapsed" };
	/** Fetch the current Active Profile once on mount so the collapsed row
	* shows the selected profile name, not a placeholder. */
	componentDidMount() {
		this.warmActive();
	}
	async warmActive() {
		if (this.state.phase !== "collapsed" || this.state.activeName !== void 0) return;
		try {
			const response = await fetch(`${OVERVIEW_URL}?fast=1`, { headers: { Accept: "application/json" } });
			if (!response.ok) return;
			const parsed = this.parseProfiles(await response.json());
			if (this.state.phase === "collapsed" && this.state.activeName === void 0) this.setState({
				phase: "collapsed",
				profiles: parsed.profiles,
				activeName: parsed.activeName
			});
		} catch {}
	}
	/** One retry after a short delay: a Host restart / plugin reinstall window
	* answers transiently and should not immediately show "cannot connect". */
	async fetchFastRetry() {
		const url = `${OVERVIEW_URL}?fast=1`;
		const first = await fetch(url, { headers: { Accept: "application/json" } }).catch(() => void 0);
		if (first !== void 0 && first.ok) return first;
		await new Promise((resolve) => setTimeout(resolve, 300));
		const second = await fetch(url, { headers: { Accept: "application/json" } }).catch(() => void 0);
		if (second !== void 0) return second;
		if (first !== void 0) return first;
		throw new Error("overview");
	}
	parseProfiles(payload) {
		if (typeof payload !== "object" || payload === null) throw new Error("shape");
		const auth = payload.auth;
		if (typeof auth !== "object" || auth === null) throw new Error("shape");
		const raw = auth.profiles;
		if (!Array.isArray(raw)) throw new Error("shape");
		const profiles = raw.map((item) => typeof item === "object" && item !== null ? item : null).filter((item) => item !== null && typeof item.name === "string").slice(0, 100).map((item) => ({
			name: String(item.name),
			env: typeof item.env === "string" ? item.env : void 0,
			tenantCode: typeof item.tenantCode === "string" ? item.tenantCode : void 0,
			account: typeof item.account === "string" ? item.account : void 0,
			isActive: item.isActive === true
		}));
		const authRecord = auth;
		const activeName = typeof authRecord.activeProfileName === "string" ? authRecord.activeProfileName : void 0;
		return {
			profiles,
			activeName
		};
	}
	async open() {
		if (this.state.phase === "open") return;
		const previous = "activeName" in this.state ? this.state.activeName : void 0;
		this.setState({
			phase: "open",
			profiles: [],
			activeName: previous,
			busy: true
		});
		try {
			const response = await this.fetchFastRetry();
			if (!response.ok) throw new Error("overview");
			const parsed = this.parseProfiles(await response.json());
			this.setState({
				phase: "open",
				profiles: parsed.profiles,
				activeName: parsed.activeName,
				busy: false
			});
		} catch {
			this.setState((prev) => prev.phase === "open" ? {
				...prev,
				busy: false,
				error: "network"
			} : prev);
		}
	}
	async pick(name) {
		if (this.state.phase !== "open" || this.state.busy) return;
		this.setState((prev) => prev.phase === "open" ? {
			...prev,
			busy: true
		} : prev);
		const outcome = await postAction("active-profile", { profile: name });
		if (outcome.ok) {
			const refreshed = await fetch(`${OVERVIEW_URL}?fast=1`, { headers: { Accept: "application/json" } }).then((r) => r.ok ? r.json() : null).catch(() => null);
			let nextActive = name;
			let nextProfiles;
			try {
				const parsed = this.parseProfiles(refreshed);
				nextActive = parsed.activeName ?? name;
				nextProfiles = parsed.profiles;
			} catch {}
			this.setState((prev) => prev.phase === "open" ? {
				phase: "collapsed",
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
	}
	render() {
		const { t } = this.props;
		const state = this.state;
		if (state.phase === "collapsed") {
			const current = "activeName" in state && state.activeName !== void 0 ? state.activeName : "";
			const currentRow = "profiles" in state ? state.profiles?.find((profile) => profile.name === current) : void 0;
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
		return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: ProfilePicker_module_css_default.picker,
			role: "group",
			"aria-label": t("picker.label"),
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
					type: "button",
					className: ProfilePicker_module_css_default.pickerHeader,
					onClick: () => this.setState({ phase: "collapsed" }),
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
				state.profiles.length === 0 && !state.busy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					className: ProfilePicker_module_css_default.hint,
					children: t("picker.empty")
				}) : null,
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", {
					className: ProfilePicker_module_css_default.list,
					role: "listbox",
					"aria-label": t("picker.label"),
					children: state.profiles.map((profile) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						role: "option",
						"aria-selected": profile.isActive === true,
						disabled: state.busy,
						title: tooltipOf(profile, profile.name),
						"data-active": profile.isActive === true ? "1" : void 0,
						onClick: () => void this.pick(profile.name),
						className: ProfilePicker_module_css_default.row,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ProfilePicker_module_css_default.rowName,
							children: profile.name
						}), profile.isActive === true ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: ProfilePicker_module_css_default.rowMark,
							"aria-hidden": "true",
							children: "✓"
						}) : null]
					}) }, profile.name))
				}),
				"error" in state && state.error !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					role: "alert",
					className: ProfilePicker_module_css_default.error,
					children: t("picker.error")
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
	"picker.error": "无法连接"
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
	"picker.error": "Cannot connect"
};

//#endregion
//#region ../ui-insuremo-status/src/client/index.ts
/** Locale namespace contributed by the InsureMO sidebar status. */
const NS$1 = "sidebar.insuremo";
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
	}, ProfilePicker));
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
	"row": "wb6cd975b4_row",
	"icon": "wb6cd975b4_icon",
	"status": "wb6cd975b4_status",
	"kind": "wb6cd975b4_kind",
	"digest": "wb6cd975b4_digest"
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
	"actions": "wb13b81332_actions",
	"hint": "wb13b81332_hint",
	"header": "wb13b81332_header",
	"session": "wb13b81332_session",
	"consent": "wb13b81332_consent",
	"fieldset": "wb13b81332_fieldset",
	"selectedReference": "wb13b81332_selectedReference",
	"referenceActions": "wb13b81332_referenceActions",
	"summary": "wb13b81332_summary",
	"error": "wb13b81332_error",
	"card": "wb13b81332_card",
	"status": "wb13b81332_status",
	"runMeta": "wb13b81332_runMeta",
	"errorText": "wb13b81332_errorText",
	"batchJobRow": "wb13b81332_batchJobRow",
	"field": "wb13b81332_field",
	"progress": "wb13b81332_progress",
	"done": "wb13b81332_done"
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
/** Union of the three sub-plugins' client injects. */
const inject = [
	"slots",
	"locale",
	"sessions"
];
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