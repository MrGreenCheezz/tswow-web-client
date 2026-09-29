import type { GlueAudioSink } from "./GlueApi.js";
import { suspectPatchChainChange } from "../PatchChainChanged.js";

/**
 * The glue screen's sound, over the gateway's `/sound` route.
 *
 * G2 left an injectable sink with a recording implementation because there was no page to play in
 * yet. This is the real one, and it has exactly one interesting problem: **a browser will not let a
 * page make a sound before the person has touched it.** `HTMLAudioElement.play()` returns a promise
 * that rejects with `NotAllowedError` until there has been a user gesture, and the login screen's
 * music starts from `SetGlueScreen("login")`, which happens while the page is still loading.
 *
 * So a rejected play is not an error here: the track is remembered and started again on the first
 * click or key press, which is a real gesture and is also, on this screen, the first thing anybody
 * does. Nothing is queued twice — the pending track is whatever the corpus last asked for, so a
 * screen change before the first click starts the *current* music rather than a backlog.
 *
 * **Kit names.** The corpus passes `SoundEntries.Name` to all three families, not file paths:
 * `PlaySound("gsCharacterCreationLook")`, `PlayGlueMusic("GS_LichKing")` and
 * `PlayGlueAmbience(GlueAmbienceTracks["HUMAN"], 4.0)`, which is `"GlueScreenHuman"`. `/sound` takes
 * a path and answered 400 to every one of them. `/dbc/sounds?names=` already resolves a name to its
 * row — measured against the running gateway, all eleven names the glue screens use come back:
 * `GlueScreenHuman` is row 9903, `Sound\Ambience\ZoneAmbience\ForestNormalDay.wav` at volume 0.30,
 * and `GS_LichKing` is 12765, `Sound\Music\GlueScreenMusic\WotLK_main_title.mp3` at 1.0 — so the
 * resolver is wired here and no gateway change was needed. A path is still accepted directly,
 * because the owner's `AccountLogin.lua` passes one.
 */

/** Music sits under the interface rather than over it; the original's glue music is not loud. */
const MUSIC_VOLUME = 0.4;
const AMBIENCE_VOLUME = 0.35;
const EFFECT_VOLUME = 0.6;

/** How long a batch of kit names is allowed to collect before one request goes out, in ms. */
const KIT_BATCH_MS = 0;

/** Steps a fade is made of. 20 Hz is inaudibly smooth for a four-second glue fade. */
const FADE_INTERVAL_MS = 50;

/** One `SoundEntries` row, as `/dbc/sounds` publishes it. */
interface GlueSoundKit {
  readonly id: number;
  readonly name: string;
  readonly files: readonly string[];
  readonly volume: number;
}

export interface GlueAudioOptions {
  readonly gatewayOrigin: string;
  /** Where the first-gesture listener is installed. Defaults to the document. */
  readonly gestureTarget?: EventTarget;
  readonly onDiagnostic?: (message: string) => void;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface GlueAudioReport {
  readonly music: string;
  readonly ambience: string;
  /** Whether the browser has let anything play yet. */
  readonly started: boolean;
  /** Sound kit names asked for that have no row behind them, deduplicated. */
  readonly unresolvedKits: readonly string[];
  /** Kit names that did resolve, with the file each one is playing. */
  readonly resolvedKits: readonly string[];
}

const INERT_TARGET: EventTarget = {
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() { return false; },
};

/** A path is a file; a bare name is a `SoundEntries` row and needs a lookup. */
export function isSoundPath(value: string): boolean {
  return /[\\/]/.test(value) || /\.(ogg|mp3|wav)$/i.test(value);
}

export class GlueBrowserAudio implements GlueAudioSink {
  readonly #origin: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #onDiagnostic: ((message: string) => void) | undefined;
  /** Name -> row, or `null` for a name the gateway has no row for. Asked at most once each. */
  readonly #kits = new Map<string, GlueSoundKit | null>();
  readonly #pendingNames = new Set<string>();
  #pendingRequest: Promise<void> | undefined;
  #music: HTMLAudioElement | undefined;
  #ambience: HTMLAudioElement | undefined;
  #musicPath = "";
  #ambiencePath = "";
  /** What the corpus asked for, before resolution — what `PlayGlueMusic` was handed. */
  #musicRequest = "";
  #ambienceRequest = "";
  #started = false;
  #gestureBound = false;
  readonly #gestureTarget: EventTarget;
  readonly #onGesture: () => void;
  #ambienceFade: {
    readonly timer: ReturnType<typeof setInterval>;
    readonly element: HTMLAudioElement;
    readonly thenStop: boolean;
  } | undefined;

  constructor(options: GlueAudioOptions) {
    this.#origin = options.gatewayOrigin.replace(/\/+$/, "");
    this.#onDiagnostic = options.onDiagnostic;
    this.#fetch = options.fetch ?? ((...args) => globalThis.fetch(...args));
    // A document is the natural place for the first-gesture listener; the inert stand-in is only
    // for a host that has none (the node smoke), where nothing can be played anyway.
    this.#gestureTarget = options.gestureTarget
      ?? (typeof document === "undefined" ? INERT_TARGET : document);
    this.#onGesture = () => {
      this.#started = true;
      this.releaseGesture();
      if (this.#music) void this.#music.play().catch(() => {});
      if (this.#ambience) void this.#ambience.play().catch(() => {});
    };
  }

  get report(): GlueAudioReport {
    const unresolved: string[] = [];
    const resolved: string[] = [];
    for (const [name, kit] of this.#kits) {
      if (kit) resolved.push(`${name}=${kit.files[0] ?? ""}`);
      else unresolved.push(name);
    }
    return {
      music: this.#musicPath,
      ambience: this.#ambiencePath,
      started: this.#started,
      unresolvedKits: unresolved,
      resolvedKits: resolved,
    };
  }

  /** `GET /sound?path=` — the same path shape every other client route takes. */
  private url(path: string): string {
    const url = new URL("/sound", this.#origin);
    url.searchParams.set("path", path.replaceAll("/", "\\"));
    return url.href;
  }

  /**
   * Resolve a `SoundEntries.Name` to its row, asking the gateway at most once per name.
   *
   * Names asked for in the same tick go out as one request: `SetGlueScreen` plays the music and the
   * ambience back to back, and a screen full of buttons can reach for half a dozen kits in one
   * frame. The batch is keyed on the name and the answer is cached either way, so a name the
   * dataset does not carry costs one request for the whole session rather than one per click.
   */
  private async resolveKit(name: string): Promise<GlueSoundKit | undefined> {
    const known = this.#kits.get(name);
    if (known !== undefined) return known ?? undefined;
    // The route's own guard: `names` is matched against `^[A-Za-z0-9_]{1,64}$` and anything else is
    // a 400 for the whole request, so a name that could not be asked for is refused here instead.
    if (!/^[A-Za-z0-9_]{1,64}$/.test(name)) {
      this.#kits.set(name, null);
      return undefined;
    }
    this.#pendingNames.add(name);
    this.#pendingRequest ??= new Promise<void>((resolve) => {
      setTimeout(() => { void this.flushKits().finally(resolve); }, KIT_BATCH_MS);
    });
    await this.#pendingRequest;
    return this.#kits.get(name) ?? undefined;
  }

  private async flushKits(): Promise<void> {
    const names = [...this.#pendingNames];
    this.#pendingNames.clear();
    this.#pendingRequest = undefined;
    if (names.length === 0) return;
    try {
      const url = new URL("/dbc/sounds", this.#origin);
      url.searchParams.set("names", names.join(","));
      const response = await this.#fetch(url.href);
      if (!response.ok) throw new Error(`/dbc/sounds ответил ${response.status}`);
      const answer = await response.json() as {
        kits?: GlueSoundKit[]; named?: { name: string; id: number }[];
      };
      const byId = new Map((answer.kits ?? []).map((kit) => [kit.id, kit]));
      for (const entry of answer.named ?? []) {
        const kit = byId.get(entry.id);
        if (kit && kit.files.length > 0) this.#kits.set(entry.name, kit);
      }
      // Everything asked for that did not come back has no playable row; remember that too.
      for (const name of names) if (!this.#kits.has(name)) this.#kits.set(name, null);
    } catch (error) {
      // Not cached as "missing": a gateway that was down should be asked again, or the whole
      // session goes silent because of one failed request.
      this.#onDiagnostic?.(`Звуковые киты не разрешились: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private waitForGesture(): void {
    if (this.#gestureBound || this.#started) return;
    this.#gestureBound = true;
    this.#gestureTarget.addEventListener("pointerdown", this.#onGesture, { once: true });
    this.#gestureTarget.addEventListener("keydown", this.#onGesture, { once: true });
  }

  private releaseGesture(): void {
    if (!this.#gestureBound) return;
    this.#gestureBound = false;
    this.#gestureTarget.removeEventListener("pointerdown", this.#onGesture);
    this.#gestureTarget.removeEventListener("keydown", this.#onGesture);
  }

  private start(element: HTMLAudioElement): void {
    const attempt = element.play();
    if (!attempt || typeof attempt.catch !== "function") {
      this.#started = true;
      return;
    }
    void attempt.then(() => { this.#started = true; }).catch(() => {
      // Autoplay is blocked until a gesture; this is the normal first outcome, not a failure.
      this.waitForGesture();
    });
  }

  private element(path: string, loop: boolean, volume: number): HTMLAudioElement | undefined {
    if (typeof Audio === "undefined") return undefined;
    const element = new Audio();
    // The gateway refuses a request with no `Origin` header, and a media element sends none unless
    // it is told to load in CORS mode — the same 403 the textures were hitting, arriving as a bare
    // `error` event on the element. Set before `src`, or the load starts without it.
    element.crossOrigin = "anonymous";
    element.src = this.url(path);
    element.loop = loop;
    element.volume = Math.max(0, Math.min(1, volume));
    element.preload = "auto";
    element.addEventListener("error", () => {
      this.#onDiagnostic?.(`Звук недоступен: ${path}`);
      // A media element never shows the 409's body: ask the gateway whether its patch latch is why.
      suspectPatchChainChange(element.src);
    });
    return element;
  }

  /**
   * One file out of a kit, and the loudness the row asks for.
   *
   * `SoundEntries.Volume` is authored per row and the glue rows are quiet on purpose — the ambience
   * kits sit at 0.30 to 0.45 against the title music's 1.0 — so it multiplies the family's own
   * ceiling rather than replacing it. A kit with several files is a set of alternatives, so one is
   * picked at random exactly as the client picks one.
   */
  private fileOf(kit: GlueSoundKit): { path: string; volume: number } {
    const index = Math.floor(Math.random() * kit.files.length);
    return {
      path: kit.files[Math.min(index, kit.files.length - 1)] ?? "",
      volume: Number.isFinite(kit.volume) && kit.volume > 0 ? Math.min(1, kit.volume) : 1,
    };
  }

  playSound(kit: string): void {
    if (!kit) return;
    if (isSoundPath(kit)) {
      this.playSoundFile(kit);
      return;
    }
    void this.resolveKit(kit).then((row) => {
      if (!row) return;
      const { path, volume } = this.fileOf(row);
      const element = this.element(path, false, EFFECT_VOLUME * volume);
      if (element) this.start(element);
    });
  }

  playSoundFile(path: string): void {
    if (!path) return;
    const element = this.element(path, false, EFFECT_VOLUME);
    if (element) this.start(element);
  }

  playMusic(track: string): void {
    if (!track || track === this.#musicRequest) return;
    this.#musicRequest = track;
    if (isSoundPath(track)) {
      this.startMusic(track, 1);
      return;
    }
    void this.resolveKit(track).then((row) => {
      // A screen change while the name was in flight wins: only the current request may start.
      if (!row || this.#musicRequest !== track) return;
      const { path, volume } = this.fileOf(row);
      this.startMusic(path, volume);
    });
  }

  private startMusic(path: string, volume: number): void {
    if (!path || path === this.#musicPath) return;
    this.#music?.pause();
    this.#musicPath = path;
    this.#music = this.element(path, true, MUSIC_VOLUME * volume);
    if (this.#music) this.start(this.#music);
  }

  playAmbience(track: string, fadeSeconds: number): void {
    if (!track || track === this.#ambienceRequest) return;
    this.#ambienceRequest = track;
    if (isSoundPath(track)) {
      this.startAmbience(track, 1, fadeSeconds);
      return;
    }
    void this.resolveKit(track).then((row) => {
      if (!row || this.#ambienceRequest !== track) return;
      const { path, volume } = this.fileOf(row);
      this.startAmbience(path, volume, fadeSeconds);
    });
  }

  private startAmbience(path: string, volume: number, fadeSeconds: number): void {
    if (!path || path === this.#ambiencePath) return;
    this.clearFade();
    this.#ambience?.pause();
    this.#ambiencePath = path;
    const target = AMBIENCE_VOLUME * volume;
    // `PlayGlueAmbience(track, 4.0)` — the second argument is a fade in seconds and the corpus
    // always passes one (4.0 from `SetBackgroundModel`, 5.0 from the owner's login module). Coming
    // in at full volume is a wind that starts with a click.
    this.#ambience = this.element(path, true, fadeSeconds > 0 ? 0 : target);
    if (!this.#ambience) return;
    this.start(this.#ambience);
    if (fadeSeconds > 0) this.fade(this.#ambience, target, fadeSeconds);
  }

  /** Walk one element's volume to `target` over `seconds`, replacing any fade already running. */
  private fade(element: HTMLAudioElement, target: number, seconds: number, thenStop = false): void {
    this.clearFade();
    const from = element.volume;
    const started = Date.now();
    const total = Math.max(FADE_INTERVAL_MS, seconds * 1000);
    const running = {
      element,
      thenStop,
      timer: setInterval(() => {
        const progress = Math.min(1, (Date.now() - started) / total);
        element.volume = Math.max(0, Math.min(1, from + (target - from) * progress));
        if (progress < 1) return;
        this.clearFade();
      }, FADE_INTERVAL_MS),
    };
    this.#ambienceFade = running;
  }

  /**
   * End whatever fade is running.
   *
   * A fade-out owns an element the sink has already let go of — `stopAmbience` detaches it and asks
   * the fade to pause it at the end — so cutting that fade short has to pause it here, or a screen
   * change during a four-second fade leaves the previous ambience looping for the whole session.
   */
  private clearFade(): void {
    const running = this.#ambienceFade;
    if (!running) return;
    this.#ambienceFade = undefined;
    clearInterval(running.timer);
    if (running.thenStop) running.element.pause();
  }

  stopAmbience(fadeSeconds: number): void {
    const element = this.#ambience;
    this.#ambience = undefined;
    this.#ambiencePath = "";
    this.#ambienceRequest = "";
    if (!element) {
      this.clearFade();
      return;
    }
    if (fadeSeconds > 0) {
      this.fade(element, 0, fadeSeconds, true);
      return;
    }
    this.clearFade();
    element.pause();
  }

  stopMusic(): void {
    this.#music?.pause();
    this.#music = undefined;
    this.#musicPath = "";
    this.#musicRequest = "";
  }

  stopAllSfx(): void {
    this.stopAmbience(0);
  }

  dispose(): void {
    this.releaseGesture();
    this.stopMusic();
    this.stopAmbience(0);
    this.clearFade();
  }
}
