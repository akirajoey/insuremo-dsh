import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar/client";
import type {} from "@deepseek-ai/dsh-client-ui-layout/client";
import type {} from "@deepseek-ai/dsh-client-ui-slots";
import { WorkspaceHealth } from "./WorkspaceHealth.tsx";
import { WorkspaceAwareProfilePicker } from "./ProfilePicker.tsx";
import { PickerOverlayController } from "./PickerOverlayController.ts";
import { PickerOverlay } from "./PickerOverlay.tsx";
import { BrandSignal, InsuremoBrandMark, InsuremoBrandName, InsuremoHeroBrandMark } from "./InsuremoBrand.tsx";
import { en, zh, type InsuremoStatusLocaleKey } from "./locales.ts";

export type { StatusBadgeProps } from "./StatusBadge.tsx";
export type {
	WorkspaceHealthProps,
	WorkspaceHealthRow,
} from "./WorkspaceHealth.tsx";
export {
	WorkspaceHealth,
	WORKSPACES_STATUS_URL,
	parseWorkspaceHealthRows,
} from "./WorkspaceHealth.tsx";
export { ProfilePicker, ProfilePickerPanel, WorkspaceAwareProfilePicker, resolveProfileTarget } from "./ProfilePicker.tsx";
export type { ProfilePickerTarget } from "./ProfilePicker.tsx";
export type { InsuremoStatusLocaleKey } from "./locales.ts";

/** Locale namespace contributed by the InsureMO sidebar status. */
export const NS = "sidebar.insuremo";

declare module "@deepseek-ai/dsh-client-ui-slots" {
	interface LocaleNamespaceMap {
		"sidebar.insuremo": InsuremoStatusLocaleKey;
	}
}

/** Services used by the client-side sidebar contribution. */
export const inject = ["slots", "locale"];

/** Register the static localized status badge in the sidebar footer. */
export function apply(ctx: Context): void {
	// One controller per plugin fiber, delivered through the actual slot inject
	// faces. No global singleton or dynamically recreated Component identity.
	const pickerOverlay = new PickerOverlayController();
	const pickerFace = () => ({ pickerOverlay });
	ctx.effect(() => () => { pickerOverlay.dispose(); }, "ui-insuremo-status: picker controller");
	// One brand signal per apply, shared by the two real brand-slot inject
	// faces. The name occupant suppresses the mark only within this apply.
	const brandSignal = new BrandSignal();
	const brandFace = () => ({ brandSignal });
	ctx.effect(() => () => { brandSignal.dispose(); }, "ui-insuremo-status: brand signal");
	ctx.effect(
		() => ctx.locale.register(NS, { zh, en }),
		"ui-insuremo-status: dictionaries",
	);

	// Brand slots (rc.2+): the sidebar renders its identity through the
	// single-slot names `sidebar.brand.mark` / `sidebar.brand.name`, so the
	// plugin layer registers the InsureMO artwork over the in-box official
	// brand. The official bundle holds priority 0; a single slot rejects a
	// duplicate priority, and the lowest priority renders — so shadow it at
	// a strictly lower one.
	ctx.slots.inject("sidebar.brand.name", () =>
		ctx.slots.inject("conversation.hero.brand.mark", function* () {
			yield ctx.slots.register(
				{ name: "sidebar.brand.mark", priority: -1, inject: brandFace },
				InsuremoBrandMark,
			);
			yield ctx.slots.register(
				{ name: "sidebar.brand.name", priority: -1, inject: brandFace },
				InsuremoBrandName,
			);
			// The hero is a different surface: it never shares a row with the
			// wordmark, so it keeps its own occupant instead of the sidebar mark's
			// identity-row detection.
			yield ctx.slots.register(
				{ name: "conversation.hero.brand.mark", priority: -1 },
				InsuremoHeroBrandMark,
			);
		}),
	);

	const t = ctx.locale.bind(NS);
	ctx.slots.inject("sidebar.footer.action", () =>
		ctx.slots.register(
			{
				name: "sidebar.footer.action",
				id: "insuremo-status",
				order: 10,
				locale: NS,
				label: () => t("label"),
				inject: pickerFace,
			},
			WorkspaceAwareProfilePicker,
		),
	);

	// Follow the declaration, not an assumed plugin load order. Availability
	// requires the rendered overlay's mount acknowledgement as well.
	ctx.slots.inject("shell.overlay", () => {
		const releaseDeclaration = pickerOverlay.declare();
		try {
			const unregister = ctx.slots.register(
				{ name: "shell.overlay", id: "insuremo-profile-picker", inject: pickerFace },
				PickerOverlay,
			);
			return () => { releaseDeclaration(); unregister(); };
		} catch (error) {
			releaseDeclaration();
			throw error;
		}
	});

	// Workspace health strip: three 16px glyphs per workspace (i / graph /
	// brain), fed by the read-only host status route (60s TTL).
	ctx.slots.inject("sidebar.footer.action", () =>
		ctx.slots.register(
			{
				name: "sidebar.footer.action",
				id: "insuremo-workspace-health",
				order: 11,
				locale: NS,
				label: () => t("health.strip"),
			},
			WorkspaceHealth,
		),
	);
}
