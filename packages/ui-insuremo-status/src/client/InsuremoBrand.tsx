import type { ReactNode } from "react";
import globeUrl from "../../assets/insuremo-globe.png";
import wordmarkDarkUrl from "../../assets/insuremo-wordmark-dark.png";
import wordmarkLightUrl from "../../assets/insuremo-wordmark-light.png";
import css from "./InsuremoBrand.module.css";

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
 * `sidebar.brand.mark` occupant: always the standalone globe. The mark and the
 * name are independent public slots, so this component makes no assumption
 * about which surface (expanded row, rail, another outlet) renders it.
 */
export function InsuremoBrandMark({ size = 24 }: { size?: number }): ReactNode {
	return <span><Globe size={size} /></span>;
}

/**
 * `conversation.hero.brand.mark` occupant: the blank-session hero fish slot is
 * a non-interactive span that never holds the wordmark, so it keeps the
 * standalone globe.
 */
export function InsuremoHeroBrandMark({ size = 34 }: { size?: number }): ReactNode {
	return (
		<span>
			<Globe size={size} />
		</span>
	);
}

/**
 * `sidebar.brand.name` occupant: text-only wordmark. The owned PNG also
 * contains the globe at its left edge; the local CSS crops that fixed region so
 * the mark slot owns the globe and this slot owns only the lettering. This is a
 * deliberate minimal public-slot composition, not a pixel-identical copy of the
 * old combined artwork.
 */
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
