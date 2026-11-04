import { useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import globeUrl from "../../assets/insuremo-globe.png";
import wordmarkDarkUrl from "../../assets/insuremo-wordmark-dark.png";
import wordmarkLightUrl from "../../assets/insuremo-wordmark-light.png";
import css from "./InsuremoBrand.module.css";

/** Same-origin brand assets served by the host-side brand-assets-server. */
const BRAND_ASSET_URL = "/api/icomposer-workbench/ui/assets";

const noopSubscribe = (): (() => void) => () => {};
const alwaysFalse = (): boolean => false;

/**
 * Per-apply brand signal shared by the mark and name slots through their real
 * inject faces. The name occupant (wide sidebar) marks itself mounted, so the
 * mark occupant stays empty and the wide row shows only the complete logo.
 * Without a mounted name (collapsed rail) the mark draws the standalone globe.
 *
 * Limitation: with more than one SidebarRoot at once, any mounted name hides
 * every mark from the same apply. The real App has one sidebar; this is
 * documented rather than solved with host DOM or outlet identity assumptions.
 */
export class BrandSignal {
  #names = 0;
  #listeners = new Set<() => void>();

  readonly getSnapshot = (): boolean => this.#names > 0;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  /** Called by the name occupant from a layout effect; returns its disposer. */
  mountName(): () => void {
    this.#names += 1;
    this.#emit();
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      this.#names -= 1;
      this.#emit();
    };
  }

  /** Plugin-fiber teardown: no mounted name may outlive the apply. */
  dispose(): void {
    this.#names = 0;
    this.#emit();
    this.#listeners.clear();
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

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
 * `sidebar.brand.mark` occupant. It draws the standalone globe only while the
 * name occupant is not mounted (collapsed rail); in the wide row the complete
 * wordmark owns the identity and this slot stays empty. Legacy direct callers
 * without the shared signal keep the globe.
 */
export function InsuremoBrandMark({ size = 24, brandSignal }: { size?: number; brandSignal?: BrandSignal }): ReactNode {
	const nameMounted = useSyncExternalStore(
		brandSignal?.subscribe ?? noopSubscribe,
		brandSignal?.getSnapshot ?? alwaysFalse,
		brandSignal?.getSnapshot ?? alwaysFalse,
	);
	// Default to an empty mark: the wide row must not flash a second globe while
	// the name occupant mounts. Without a mounted name (rail), one macrotask
	// later the standalone globe appears. Legacy direct callers keep the globe.
	const [settled, setSettled] = useState(false);
	useLayoutEffect(() => {
		if (brandSignal === undefined || nameMounted) {
			setSettled(false);
			return;
		}
		const timer = setTimeout(() => { setSettled(true); }, 0);
		return () => { clearTimeout(timer); };
	}, [brandSignal, nameMounted]);
	if (brandSignal === undefined || (settled && !nameMounted)) {
		return <span data-icomposer-brand-mark=""><Globe size={size} /></span>;
	}
	return null;
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
 * `sidebar.brand.name` occupant: the complete combined wordmark. It marks the
 * shared signal as mounted while it is rendered, which suppresses the mark
 * slot in the same wide row. Light/dark assets switch through local CSS.
 */
export function InsuremoBrandName({ brandSignal }: { brandSignal?: BrandSignal }): ReactNode {
	useLayoutEffect(() => brandSignal?.mountName(), [brandSignal]);
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
