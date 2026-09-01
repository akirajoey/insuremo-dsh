import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import globeUrl from "../../assets/insuremo-globe.png";
import wordmarkDarkUrl from "../../assets/insuremo-wordmark-dark.png";
import wordmarkLightUrl from "../../assets/insuremo-wordmark-light.png";
import css from "./BrandChrome.module.css";

/** Same-origin brand assets served by the host-side brand-assets-server. */
const BRAND_ASSET_URL = "/api/icomposer-workbench/ui/assets";

/**
 * The mark slot feeds two hosts with identical props: the wide identity row
 * (mark + name lockup — the wordmark already carries the brand, so the mark
 * must stay empty there, matching the pre-slot overlay look) and the
 * collapsed rail toggle (mark only). The rail host is the button that also
 * holds the panel icon; detect it after mount and render only there.
 */
export function InsuremoBrandMark({ size = 24 }: { size?: number }): ReactNode {
	const hostRef = useRef<HTMLSpanElement | null>(null);
	const [inRail, setInRail] = useState(false);
	useLayoutEffect(() => {
		const button = hostRef.current?.closest("button");
		setInRail(button?.querySelector("svg") !== null);
	}, []);
	return (
		<span ref={hostRef}>
			{inRail ? (
				<img
					src={`${BRAND_ASSET_URL}/insuremo-globe.png`}
					alt=""
					width={size}
					height={Math.round((size * 62) / 65)}
					decoding="async"
					data-emitted-brand-asset={globeUrl}
				/>
			) : null}
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
