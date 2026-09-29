export interface FrameXmlModeMount {
  mount(original: boolean): Promise<{ ok: boolean; message: string }>;
  unmount(): void;
}

/** Owns one world's optional VM, including changes while its code or corpus is still loading. */
export class FrameXmlModeController {
  #revision = 0;
  #disposed = false;
  #original: boolean | undefined;
  #runtime: FrameXmlModeMount | undefined;
  #loading: Promise<FrameXmlModeMount> | undefined;

  constructor(
    private readonly addons: boolean,
    private readonly load: () => Promise<FrameXmlModeMount>,
    private readonly report: (message: string) => void,
  ) {}

  #loadRuntime(): Promise<FrameXmlModeMount> {
    if (this.#loading) return this.#loading;
    const pending = this.load();
    this.#loading = pending;
    // A rejected import must be evicted even when its selection was cancelled meanwhile.
    void pending.catch(() => { if (this.#loading === pending) this.#loading = undefined; });
    return pending;
  }

  async select(original: boolean): Promise<void> {
    if (this.#disposed || original === this.#original) return;
    this.#original = original;
    const revision = ++this.#revision;
    this.#runtime?.unmount();
    if (!original && !this.addons) {
      this.report("Включён интерфейс WebClient.");
      return;
    }
    this.report(original ? "Загрузка оригинального интерфейса…" : "Загрузка аддонов…");
    try {
      const runtime = await this.#loadRuntime();
      if (this.#disposed || revision !== this.#revision) return;
      this.#runtime = runtime;
      const result = await runtime.mount(original);
      if (this.#disposed || revision !== this.#revision) return;
      if (!result.ok) {
        runtime.unmount();
        this.report(`Оригинальный интерфейс недоступен; используется WebClient. ${result.message}`);
      } else this.report(result.message);
    } catch (error) {
      if (this.#disposed || revision !== this.#revision) return;
      this.#runtime?.unmount();
      this.report(`Интерфейс не загрузился; используется WebClient. ${String(error)}`);
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#revision++;
    this.#runtime?.unmount();
  }
}
