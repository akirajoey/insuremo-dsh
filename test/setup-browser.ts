// jsdom has no layout observer; current upstream Tooltip waits for its first measurement.
globalThis.ResizeObserver ??= class ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.callback([{ target, borderBoxSize: [{ inlineSize: 100, blockSize: 20 }] } as unknown as ResizeObserverEntry], this);
  }
  unobserve(): void {}
  disconnect(): void {}
};
