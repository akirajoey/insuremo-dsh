import type { ReactNode, RefObject } from "react";

/** One Picker-owned surface, shared with the root overlay slot by its apply. */
export interface PickerOverlayPanel {
  readonly owner: object;
  readonly anchorRef: RefObject<HTMLButtonElement | null>;
  readonly label: string;
  readonly content: ReactNode;
  /** Close and cancel the owning Picker's work; focus only for user dismissal. */
  readonly onDismiss: (restoreFocus: boolean) => void;
}

type Listener = () => void;

/**
 * Per-client-apply bridge. Registration alone is not availability: the actual
 * overlay component must commit for the current declaration generation.
 * Snapshots have stable identity between changes for useSyncExternalStore.
 */
export class PickerOverlayController {
  private readonly panelListeners = new Set<Listener>();
  private readonly availabilityListeners = new Set<Listener>();
  private panel: PickerOverlayPanel | null = null;
  private generation = 0;
  private declared = false;
  private readonly mounted = new Map<object, number>();
  private disposed = false;

  readonly getPanel = (): PickerOverlayPanel | null => this.panel;
  readonly getAvailable = (): boolean => !this.disposed && this.declared
    && [...this.mounted.values()].some(generation => generation === this.generation);

  readonly subscribePanel = (listener: Listener): (() => void) => {
    this.panelListeners.add(listener);
    return () => { this.panelListeners.delete(listener); };
  };

  readonly subscribeAvailability = (listener: Listener): (() => void) => {
    this.availabilityListeners.add(listener);
    return () => { this.availabilityListeners.delete(listener); };
  };

  private notify(listeners: Set<Listener>): void {
    for (const listener of [...listeners]) listener();
  }

  /** Called only during the real slot's declaration lifetime. */
  declare(): () => void {
    if (this.disposed) return () => {};
    this.generation += 1;
    const generation = this.generation;
    this.declared = true;
    this.notify(this.availabilityListeners);
    let released = false;
    return () => {
      if (released || this.generation !== generation) return;
      released = true;
      this.declared = false;
      this.invalidatePanel();
      this.notify(this.availabilityListeners);
    };
  }

  /** Commit acknowledgement from the actual rendered overlay component. */
  mount(): () => void {
    if (this.disposed || !this.declared) return () => {};
    const token = {};
    const generation = this.generation;
    this.mounted.set(token, generation);
    this.notify(this.availabilityListeners);
    return () => {
      if (!this.mounted.delete(token)) return;
      if (this.generation === generation && !this.getAvailable()) this.invalidatePanel();
      this.notify(this.availabilityListeners);
    };
  }

  /** Replace only this apply's surface; a different owner is first dismissed. */
  show(panel: PickerOverlayPanel): boolean {
    if (!this.getAvailable()) return false;
    if (this.panel !== null && this.panel.owner !== panel.owner) this.invalidatePanel();
    this.panel = panel;
    this.notify(this.panelListeners);
    return true;
  }

  clear(owner: object): void {
    if (this.panel?.owner !== owner) return;
    this.panel = null;
    this.notify(this.panelListeners);
  }

  private invalidatePanel(): void {
    const panel = this.panel;
    if (panel === null) return;
    this.panel = null;
    this.notify(this.panelListeners);
    panel.onDismiss(false);
  }

  /** Plugin-fiber teardown cannot leave an active Picker or subscription. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.declared = false;
    this.invalidatePanel();
    this.notify(this.availabilityListeners);
    this.mounted.clear();
    this.panelListeners.clear();
    this.availabilityListeners.clear();
  }
}
