import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import globeUrl from "../../assets/insuremo-globe.png";
import wordmarkDarkUrl from "../../assets/insuremo-wordmark-dark.png";
import wordmarkLightUrl from "../../assets/insuremo-wordmark-light.png";
import css from "./BrandChrome.module.css";

/** Same-origin brand assets served by the host-side brand-assets-server. */
const BRAND_ASSET_URL = "/api/icomposer-workbench/ui/assets";

/** The globe raster, scaled to the caller's square edge (65:62 source). */
function Globe({ size }: { size: number }): ReactNode {
	return (
		<img
			src={`${BRAND_ASSET_URL}/insuremo-globe.png`}
			alt=""
			width={size}
			height={Math.round((size * 62) / 65)}
			decoding="async"
			data-emitted-brand-asset={globeUrl}
		/>
	);
}

/**
 * Whether the host row already renders our wordmark. The wordmark PNG carries
 * the globe itself, so a mark beside it draws a second globe. The official
 * shell nests the mark and the name three levels deep in one identity row
 * (`brandIdentity > brandMark | brandName`), and renders that row as a plain
 * window-drag span on macOS but a button elsewhere; keying off the wordmark
 * covers both and never has to read a generated class name.
 */
function sharesRowWithWordmark(host: HTMLElement): boolean {
	let node: HTMLElement | null = host.parentElement;
	// Bounded walk: the row is one or two levels up, and an unbounded one could
	// reach an unrelated wordmark elsewhere in the sidebar.
	for (let depth = 0; node !== null && depth < 4; depth += 1) {
		if (node.querySelector('[data-icomposer-brand-asset="wordmark"]') !== null) return true;
		node = node.parentElement;
	}
	return false;
}

/**
 * `sidebar.brand.mark` occupant. The slot feeds two surfaces: the wide
 * identity row (where the wordmark already carries the globe, so the mark must
 * stay empty) and the collapsed rail toggle (mark only, so the standalone
 * globe belongs there). The hero has its own surface — see
 * {@link InsuremoHeroBrandMark} — because it is never part of an identity row.
 */
export function InsuremoBrandMark({ size = 24 }: { size?: number }): ReactNode {
	const hostRef = useRef<HTMLSpanElement | null>(null);
	const [standalone, setStandalone] = useState(false);
	useLayoutEffect(() => {
		const host = hostRef.current;
		if (host === null) return;
		setStandalone(!sharesRowWithWordmark(host));
	}, []);
	return <span ref={hostRef}>{standalone ? <Globe size={size} /> : null}</span>;
}

/**
 * `conversation.hero.brand.mark` occupant: the blank-session hero fish slot is
 * a non-interactive span that never holds the wordmark, so it always keeps the
 * standalone globe.
 */
export function InsuremoHeroBrandMark({ size = 34 }: { size?: number }): ReactNode {
	return (
		<span>
			<Globe size={size} />
		</span>
	);
}

/** The wordmark rendered into `sidebar.brand.name` (99×24, theme-switched
 * through the same CSS the overlay used). */
export function InsuremoBrandName(): ReactNode {
	return (
		<span
			className={css.wordmark}
			data-icomposer-brand-asset="wordmark"
			data-emitted-brand-assets={`${wordmarkLightUrl}|${wordmarkDarkUrl}`}
		>
			<img
				className={css.wordmarkLight}
				src={`${BRAND_ASSET_URL}/insuremo-wordmark-light.png`}
				alt=""
				width={312}
				height={76}
				decoding="async"
			/>
			<img
				className={css.wordmarkDark}
				src={`${BRAND_ASSET_URL}/insuremo-wordmark-dark.png`}
				alt=""
				width={312}
				height={76}
				decoding="async"
			/>
		</span>
	);
}
