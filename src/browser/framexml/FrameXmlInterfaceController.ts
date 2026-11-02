export interface FrameXmlInterfaceRuntime {
  mount(): Promise<{ ok: boolean; message: string }>;
  unmount(): void;
}

/**
 * One world's stock interface, including a world that ends while its code or corpus is still loading.
 *
 * Nothing else can play the game, so a failure is said once through `onFailure` and not retried here:
 * a half-mounted VM is not reusable, and the way back is a fresh page.
 */
export class FrameXmlInterfaceController {
  #disposed = false;
  #started = false;
  #runtime: FrameXmlInterfaceRuntime | undefined;

  constructor(
    private readonly load: () => Promise<FrameXmlInterfaceRuntime>,
    private readonly report: (message: string) => void,
    private readonly onFailure: (message: string) => void,
  ) {}

  async start(): Promise<void> {
    if (this.#disposed || this.#started) return;
    this.#started = true;
    this.report("Загрузка интерфейса…");
    try {
      const runtime = await this.load();
      if (this.#disposed) return;
      this.#runtime = runtime;
      const result = await runtime.mount();
      if (this.#disposed) return;
      if (result.ok) {
        this.report(result.message);
        return;
      }
      runtime.unmount();
      this.onFailure(result.message);
    } catch (error) {
      if (this.#disposed) return;
      this.#runtime?.unmount();
      this.onFailure(error instanceof Error ? error.message : String(error));
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#runtime?.unmount();
  }
}
