/**
 * Shared dist payload materialization (TASK-075): the single implementation
 * behind both distributable forms of the prebuilt workbench plugin.
 *
 * - `scripts/pack-dist.mjs` materializes the staging copy and npm-packs the
 *   release tarball (unchanged contract).
 * - `scripts/pack-git-dist.mjs` materializes the tracked prebuilt directory
 *   `git-dist/icomposer-workbench/` that GitHub `#path:` installs consume.
 * - `scripts/check-git-dist.mjs` re-materializes into a temp directory and
 *   compares byte-for-byte against the tracked directory.
 *
 * This module must stay free of top-level side effects: importing it never
 * writes or removes anything.
 *
 * Payload contract: `lib/` (built, source-map free, host-path sanitized),
 * `lib/assets/`, `cordis.patch.yml`, `README.md`, and a package.json with no
 * lifecycle scripts, no devDependencies, and no file:/workspace: references.
 */
import {
	cp,
	mkdir,
	readFile,
	readdir,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const distPackageDir = join(
	repoRoot,
	"packages",
	"icomposer-workbench-dist",
);

const retiredWord = "inter" + "com";
const retiredService = "INTER" + "COM_SERVICE";
const retiredMarker = new RegExp(
	`workbench-${retiredWord}|${retiredService}|${retiredWord}/`,
	"i",
);
const textExtensions = new Set([".js", ".map", ".json", ".md", ".yml"]);

/** Build the prebuilt lib/ inside the dist package workspace.
 *
 * Release pack commands are single-writer: tsdown removes and rewrites this
 * shared source `lib/` directory before the caller copies it. The destination
 * swap is atomic-ish, but concurrent pack commands must not overlap this
 * source-build phase.
 */
export async function buildDistLib() {
	await rm(join(distPackageDir, "lib"), { recursive: true, force: true });
	// Windows: pnpm resolves through a .cmd shim that Node cannot spawn directly
	// (EINVAL/ENOENT without a shell); route through %COMSPEC% like the service
	// seam does for .cmd-resolved CLIs.
	const command =
		process.platform === "win32"
			? [process.env.comspec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm run build"]]
			: ["pnpm", ["run", "build"]];
	execFileSync(command[0], command[1], {
		cwd: distPackageDir,
		stdio: "inherit",
	});
}

async function assertNoRetiredText(root, label) {
	async function walkText(dir) {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walkText(full);
				continue;
			}
			if (!textExtensions.has(full.slice(full.lastIndexOf(".")))) continue;
			const info = await stat(full);
			if (info.size > 20_000_000)
				throw new Error(`refusing oversized text scan: ${full}`);
			const text = await readFile(full, "utf8");
			if (retiredMarker.test(text))
				throw new Error(
					`retired communication marker in ${label}/${relative(root, full)}`,
				);
		}
	}
	await walkText(root);
}

async function removeSourceMaps(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) await removeSourceMaps(full);
		else if (entry.name.endsWith(".map")) await rm(full, { force: true });
	}
}

/** Rollup/tsdown region comments can retain the local checkout prefix. */
async function sanitizeStagedJs(dir) {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) await sanitizeStagedJs(full);
		else if (entry.name.endsWith(".js")) {
			const text = await readFile(full, "utf8");
			const sanitized = text
				.replaceAll(`${repoRoot}/`, "<repo>/")
				.replaceAll("/private/var", "private-var")
				.replaceAll("/var/folders", "var-folders")
				.replaceAll("/tmp/", "tmp/");
			if (sanitized !== text) await writeFile(full, sanitized, "utf8");
		}
	}
}

async function canonicalizeStagedCss(dir) {
	const file = join(dir, "client.js");
	const source = await readFile(file);
	const canonical = canonicalizeCssModuleClasses(source);
	if (!canonical.equals(source)) await writeFile(file, canonical, "utf8");
}

/**
 * lightningcss's `[hash]` includes its absolute filename, so a CSS module
 * otherwise gets different class names in every checkout. Replace each
 * generated module token in both the CSS selectors and its exported map with
 * a stable hash of the module symbol and local names. This is packaging-only:
 * source builds may retain their native names, while every shipped payload is
 * path-independent and keeps the map/CSS pair consistent.
 */
export function canonicalizeCssModuleClasses(bytes) {
	const text = bytes.toString("utf8");
	const mapPattern =
		/(?:var|const|let) ([A-Za-z0-9_$]+)_module_css_default = \{\n([\s\S]*?)\n\};/gu;
	const replacements = new Map();
	let map;
	while ((map = mapPattern.exec(text)) !== null) {
		const members = [...map[2].matchAll(/"([^"]+)": "([^"]+)"/gu)];
		const classes = members
			.map((member) => {
				const local = member[1];
				return member[2].endsWith(`_${local}`)
					? { old: member[2], local }
					: null;
			})
			.filter((value) => value !== null);
		if (classes.length === 0 || classes.length !== members.length) continue;
		const signature = `${map[1]}\n${classes
			.map((value) => value.local)
			.sort()
			.join("\n")}`;
		const prefix = `wb${createHash("sha256").update(signature).digest("hex").slice(0, 8)}`;
		for (const value of classes)
			replacements.set(value.old, `${prefix}_${value.local}`);
	}
	let canonical = text;
	for (const [oldValue, newValue] of [...replacements.entries()].sort(
		([left], [right]) => right.length - left.length,
	)) {
		const escaped = oldValue.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		canonical = canonical.replace(
			new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "gu"),
			newValue,
		);
	}
	return canonical === text ? bytes : Buffer.from(canonical, "utf8");
}

/**
 * The shipped package.json. The tarball keeps a no-op `prepare` (npm never
 * runs it on tarball installs, but it guards source-directory installs);
 * the git-dist form strips every script: GitHub `#path:` installs run the
 * checkout directory directly and must never trigger a build.
 */
export function deriveShippedManifest(manifest, { stripScripts = false } = {}) {
	const shipped = { ...manifest };
	if (stripScripts) {
		delete shipped.scripts;
		delete shipped.private;
	} else {
		shipped.scripts = {
			...manifest.scripts,
			prepare:
				"node -e \"console.log('@icomposer/workbench: prebuilt lib/ shipped; skipping build')\"",
		};
	}
	delete shipped.devDependencies;
	return shipped;
}

/**
 * Materialize the prebuilt payload into `targetDir` (created, must not
 * already exist). `stripScripts` selects the git-dist package.json form.
 */
export async function materializePayload(
	targetDir,
	{ stripScripts = false } = {},
) {
	let manifest;
	try {
		manifest = JSON.parse(
			await readFile(join(distPackageDir, "package.json"), "utf8"),
		);
	} catch (cause) {
		throw new Error(
			`dist package manifest is not valid JSON: ${String(cause)}`,
			{ cause },
		);
	}
	await buildDistLib();
	await mkdir(targetDir, { recursive: true });
	for (const entry of ["lib", "cordis.patch.yml", "README.md"]) {
		await cp(join(distPackageDir, entry), join(targetDir, entry), {
			recursive: true,
		});
	}
	await removeSourceMaps(join(targetDir, "lib"));
	await sanitizeStagedJs(join(targetDir, "lib"));
	await canonicalizeStagedCss(join(targetDir, "lib"));
	await assertNoRetiredText(targetDir, relative(repoRoot, targetDir));
	await writeFile(
		join(targetDir, "package.json"),
		`${JSON.stringify(deriveShippedManifest(manifest, { stripScripts }), null, 2)}\n`,
		"utf8",
	);
	let shipped;
	try {
		shipped = JSON.parse(
			await readFile(join(targetDir, "package.json"), "utf8"),
		);
	} catch (cause) {
		throw new Error(
			`staged payload manifest is not valid JSON: ${String(cause)}`,
			{ cause },
		);
	}
	return shipped;
}

/** Recursive byte-for-byte comparison used by the drift check and tests. */
export async function directoriesDiffer(
	left,
	right,
	normalize,
	{ skip = [] } = {},
) {
	const leftNames = (await readdir(left)).sort();
	const rightNames = (await readdir(right)).sort();
	if (leftNames.join("\n") !== rightNames.join("\n"))
		return `entry sets differ: [${leftNames}] vs [${rightNames}]`;
	for (const name of leftNames) {
		if (skip.includes(name)) continue;
		const a = join(left, name);
		const b = join(right, name);
		const sa = await stat(a);
		const sb = await stat(b);
		if (sa.isDirectory() !== sb.isDirectory())
			return `type mismatch at ${name}`;
		if (sa.isDirectory()) {
			const nested = await directoriesDiffer(a, b, normalize);
			if (nested !== null) return nested;
			continue;
		}
		if (sa.size !== sb.size && normalize === undefined)
			return `size mismatch at ${name}`;
		let [ba, bb] = [await readFile(a), await readFile(b)];
		if (normalize !== undefined) {
			ba = normalize(name, ba);
			bb = normalize(name, bb);
			if (ba.length !== bb.length) return `normalized size mismatch at ${name}`;
		} else if (sa.size !== sb.size) {
			return `size mismatch at ${name}`;
		}
		if (!ba.equals(bb)) return `content mismatch at ${name}`;
	}
	return null;
}

/**
 * Compare-time normalization for the drift check. rolldown emits the
 * CSS-module default-export object with a nondeterministic key ORDER (the
 * class hashes themselves are stable), so two builds of identical source
 * differ only by property order inside `*_module_css_default = { … }`.
 * Normalizing sorts the members of those machine-generated blocks on BOTH
 * sides of the comparison; the shipped payload bytes are never rewritten,
 * which keeps the release tarball payload (and its pinned SHA) unchanged.
 */
export function normalizeForCompare(fileName, bytes) {
	if (!fileName.endsWith(".js")) return bytes;
	const canonicalBytes = canonicalizeCssModuleClasses(bytes);
	const text = canonicalBytes.toString("utf8");
	const blockPattern =
		/var [A-Za-z0-9_$]+_module_css_default = \{\n[\t ][^\n]*\n(?:[\t ][^\n]*\n)*[\t ]?\};/gu;
	const normalized = text.replace(blockPattern, (block) => {
		const lines = block.split("\n");
		const opener = lines[0];
		const closer = lines[lines.length - 1];
		const members = lines.slice(1, -1);
		if (members.some((line) => !/^[\t ]"[^"]+": "[^"]*",?$/.test(line)))
			return block;
		// Strip the trailing comma (its placement depends on which key happened
		// to sort last in the emitting build) so both sides compare equal.
		const uniform = members.map((line) => line.replace(/,?$/, ""));
		return [opener, ...uniform.slice().sort(), closer].join("\n");
	});
	if (normalized === text) return canonicalBytes;
	return Buffer.from(normalized, "utf8");
}
