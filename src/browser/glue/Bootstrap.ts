import "./glue.css";
import { clientLocale, gatewayOrigin as defaultGatewayOrigin } from "../Environment.js";
import { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import { FrameXmlFontLoader } from "../ui/framexml_compat/FrameXmlFonts.js";
import { FrameXmlTextureCache } from "../ui/framexml_compat/FrameXmlTextures.js";
import { WebSocketByteStream } from "../../transport/WebSocketByteStream.js";
import { GlueRuntime, glueStageMapping, glueNeedsHorizontalScroll, gluePinnedSize, GLUE_LOGICAL_HEIGHT } from "./GlueRuntime.js";
import { createHttpFileProvider } from "./GlueLoader.js";
import { GlueBrowserAudio } from "./GlueAudio.js";
import { GlueModelStage } from "./GlueModelStage.js";
import { glueLoginSceneModelIsVisible } from "./GlueLoginScenePolicy.js";
import { GlueCharacterScene, characterLook } from "./GlueCharacterScene.js";
import { GlueGatewayNames } from "./GlueNames.js";
import { fakeGlueSession, isFakeGlueSessionName } from "./GlueFakeSession.js";
import { WorldClient } from "../../world/WorldClient.js";
import { gatewaySocketUrl } from "./FrontDoor.js";
import type { GlueSession, GlueWorldConnector } from "./GlueSession.js";
import type { GlueEnterWorldRequest } from "./GlueCharacterApi.js";

/**
 * The original glue screens, running their own Lua and XML, brought up inside a host element.
 *
 * This was `main.ts` until G6. It became a function the moment `index.html` started opening with
 * these screens: two pages now build the same stage — `glue.html` as the standalone dev entry, and
 * the client's own page as its front door — and the only way they cannot drift is to be the same
 * code. `main.ts` is now four lines that call this.
 *
 * Everything that reaches the gateway is assembled here rather than inside the renderer, which
 * keeps the capability boundary where G2 put it: `framexml_compat` binds widget state to DOM and is
 * handed pictures, fonts and 3D by the host.
 */

export interface StartGlueOptions {
  /** The box the stage lives in; `#glue-host` on both pages. Sized by CSS, measured for layout. */
  readonly host: HTMLElement;
  /** The 768-unit logical screen the widgets are mounted into. */
  readonly stage: HTMLElement;
  /** One line of status under the screen, when the page has one. */
  readonly status?: HTMLElement | null;
  /** http(s) origin of the gateway. Defaults to the compiled one for this location. */
  readonly gatewayOrigin?: string;
  /** `?screen=` — which of the corpus' own screens to open first. */
  readonly screen?: string | null;
  /** `?fake=` — a canned session through the real connector seam. */
  readonly fake?: string | null;
  /**
   * How the realm list opens a world connection.
   *
   * Supplied by `index.html`, which needs to keep hold of the concrete `WorldClient` so it can hand
   * that same live connection to the world half of the client. Defaults to the same thing built
   * here, for the standalone page.
   */
  readonly connect?: GlueWorldConnector;
  /**
   * «Вход в игровой мир».
   *
   * Without it the screen says so in a dialog rather than pretending: `glue.html` is a dev entry
   * with no world renderer behind it, and a button that silently did nothing would be worse.
   */
  readonly onEnterWorld?: (request: GlueEnterWorldRequest) => void;
}

/** The running glue screens, as the page that started them can steer them. */
export interface GlueHandle {
  readonly runtime: GlueRuntime;
  readonly session: GlueSession;
  /**
   * Go dormant: music and ambience stopped, the 3D stage and both character scenes disposed, the
   * frame clock stopped, every window listener removed, the host hidden.
   *
   * Called when the world takes the screen. The corpus' own DOM and its Lua state stay exactly as
   * they are — rebuilding 3,361 widgets and re-running every OnLoad would be the expensive half —
   * so what is freed is the GL context, the decoded models and the audio, which are the things the
   * world is about to want.
   */
  suspend(): void;
  /** Come back: rebuild the stage, restart the clock, show `screen` (default: whatever was up). */
  resume(screen?: string): void;
  setScreen(name: string): void;
  /** Whether the loop is running — i.e. whether these screens are the ones on the display. */
  readonly active: boolean;
  dispose(): void;
}

/** How long the corpus waits for the page to have a size before it lays itself out anyway. */
const SIZE_WAIT_MS = 2000;

/** How long the first screen waits for the DBC tables the creation screen enumerates once. */
const TABLE_WAIT_MS = 2000;

export async function startGlue(options: StartGlueOptions): Promise<GlueHandle> {
  const { host, stage } = options;
  const status = options.status ?? null;

  function report(message: string): void {
    if (status) status.textContent = message;
  }

  /**
   * The stage's size right now.
   *
   * Read on every use rather than captured once: `GetScreenWidth()` is what `GlueParent_OnLoad`
   * pillarboxes itself from and what the module's `lgzg.lua` divides to get its aspect, and a window
   * that has been resized since start-up would otherwise be answered with the size it opened at.
   *
   * The host's border box first, the window second. Scroll mode is decided from that stable box;
   * when it is active, the usable height is the content box above the horizontal scrollbar. Keeping
   * that mode fixed while measuring avoids a scrollbar appearing/disappearing near the threshold.
   * A hidden pane can answer zero for both host and window, so `glueStageMapping` has a safe default;
   * the `ResizeObserver` below notices when the host gets a real box without a window resize event.
   */
  function currentMetrics(): { scaleX: number; scaleY: number; virtualWidth: number } {
    const box = host.getBoundingClientRect();
    const width = box.width || window.innerWidth;
    const fullHeight = box.height || window.innerHeight;
    const height = host.hasAttribute("data-glue-scroll") && host.clientHeight > 0
      ? host.clientHeight : fullHeight;
    return glueStageMapping(width, height);
  }

  /** Physical aspect of the model canvas, including the scrollable part of a narrow stage. */
  function stageAspect(): number {
    const metrics = currentMetrics();
    return metrics.virtualWidth * metrics.scaleX / (GLUE_LOGICAL_HEIGHT * metrics.scaleY);
  }

  /**
   * Fit the glue screen to the window.
   *
   * The stage is laid out in UI units — 768 tall, as wide as the display mode the corpus would have
   * chosen — and then stretched to the viewport on both axes independently. `glueStageMapping`
   * keeps at least 1024 UI units for the character creation panels. When the viewport is narrower,
   * the stage extends past the host's right edge and the host scrolls horizontally. Past 16:9 the
   * mode is capped where `GlueParent_OnLoad` caps it and the panel does the stretching.
   */
  function fit(): void {
    const box = host.getBoundingClientRect();
    const width = box.width || window.innerWidth;
    const height = box.height || window.innerHeight;
    host.toggleAttribute("data-glue-scroll", glueNeedsHorizontalScroll(width, height));
    const metrics = currentMetrics();
    stage.style.width = `${metrics.virtualWidth}px`;
    stage.style.height = `${GLUE_LOGICAL_HEIGHT}px`;
    stage.style.transform = `scale(${metrics.scaleX}, ${metrics.scaleY})`;
    stage.style.transformOrigin = "top left";
    runtime.resizeLoginScene(metrics.virtualWidth);
  }

  /**
   * Hold the corpus back until the page has a real size.
   *
   * The glue screens lay themselves out **once**, inside OnLoad: `GlueParent_OnLoad` pillarboxes
   * from `GetScreenWidth()` and the owner's `lgzg.lua` sizes its whole login scene from the
   * resolution string. A page that runs that while its window measures 0x0 — a background tab, a
   * hidden pane, a detached window — is laid out for the fallback size for the rest of its life, and
   * no later resize can re-run a corpus OnLoad. The login scene's explicit sizes are reflowed by
   * `fit`; waiting still prevents every other one-time OnLoad decision from using fallback metrics.
   * Measured in this browser's pane: `innerWidth` and
   * `#glue-host`'s own `clientWidth` both answer 0 while the pane is hidden, and the login scene
   * comes up 1024 wide in a 1280-wide window.
   *
   * Bounded, because a host that genuinely has no size must still get a screen rather than a blank
   * page: after `SIZE_WAIT_MS` the load proceeds on the fallback.
   */
  async function waitForSize(element: HTMLElement): Promise<void> {
    if (element.clientWidth > 0 && element.clientHeight > 0) return;
    if (typeof ResizeObserver !== "function") return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, SIZE_WAIT_MS);
      const observer = new ResizeObserver(() => {
        if (element.clientWidth > 0 && element.clientHeight > 0) finish();
      });
      function finish(): void {
        clearTimeout(timer);
        observer.disconnect();
        resolve();
      }
      observer.observe(element);
    });
    fit();
  }

  const origin = options.gatewayOrigin ?? defaultGatewayOrigin(window.location);
  // Read before the runtime is built, because the canned session replaces the *connector* — the one
  // seam the whole realm and character path goes through — rather than being poked in afterwards.
  const fakeName = options.fake ?? null;
  const canned = isFakeGlueSessionName(fakeName) ? fakeGlueSession(fakeName) : undefined;
  const stubs = { method: [] as string[], global: [] as string[] };
  const luaErrors: string[] = [];
  const audio = new GlueBrowserAudio({
    gatewayOrigin: origin,
    onDiagnostic: (message) => console.warn("[glue audio]", message),
  });
  const names = new GlueGatewayNames(origin);
  const namesReady = names.load();

  /**
   * The pointer in `GetCursorPosition`'s own frame: UI units, y measured from the bottom.
   *
   * `CharacterSelectFrame_OnUpdate` turns the character by the difference between two readings of
   * this, so the constant `0, 0` it used to get was a screen whose drag did nothing. Divided by the
   * stage's scale because the stage is laid out in UI units and only *visually* scaled — the same
   * distinction `FrameXmlDomRenderer.measure` makes. Scroll offset is included so dragging a model
   * after panning a narrow screen still reports its logical position. One divisor per axis, because
   * past 16:9 the two differ and a single one would turn a character by the wrong angle.
   */
  let pointer: readonly [number, number] = [0, 0];
  const trackPointer = (event: PointerEvent): void => {
    const metrics = currentMetrics();
    const box = host.getBoundingClientRect();
    pointer = [
      (event.clientX - box.left + host.scrollLeft) / metrics.scaleX,
      GLUE_LOGICAL_HEIGHT - (event.clientY - box.top + host.scrollTop) / metrics.scaleY,
    ];
  };

  // Assigned right after the runtime is built: the C API needs the view and the view needs the
  // bridge the runtime owns, so one of the two has to arrive late.
  let characterScene: GlueCharacterScene | undefined;
  let creationScene: GlueCharacterScene | undefined;
  const liveConnect: GlueWorldConnector = options.connect ?? (async (realm, auth, progress, signal) => {
    const stream = await WebSocketByteStream.connect(gatewaySocketUrl(origin, "/world"));
    // The connecting dialog's Cancel closes the socket, which ends a wait in the realm's queue.
    const abort = (): void => stream.close();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      progress?.({ stage: "authenticating" });
      return await WorldClient.connect(stream, {
        username: auth.username, sessionKey: auth.sessionKey, realmId: realm.id, realmName: realm.name,
      }, { onQueue: (position) => progress?.({ stage: "queued", position }) });
    } catch (error) {
      stream.close();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  });
  const runtime = new GlueRuntime({
    provider: createHttpFileProvider({ gatewayOrigin: origin }),
    lua: {
      onError: (message) => {
        // Kept as well as logged: a corpus script that raises aborts the rest of *its* handler and
        // nothing else, so the screen comes up half-built with no other trace. The browser smoke
        // reads this list rather than scraping the console.
        luaErrors.push(message);
        console.error("[glue lua]", message);
      },
      onPrint: (message) => console.info("[glue print]", message),
    },
    api: {
      audio,
      locale: clientLocale(),
      screen: () => ({ width: Math.round(currentMetrics().virtualWidth), height: GLUE_LOGICAL_HEIGHT }),
      authUrl: gatewaySocketUrl(origin, "/auth"),
      connect: (url) => WebSocketByteStream.connect(url),
      onAuthDiagnostic: (code) => console.warn("[glue auth] rejected with code", code),
      // A URL out of a patch archive is untrusted input; surface it instead of
      // navigating on the corpus' say-so.
      onLaunchUrl: (url) => report(`Ссылка из интерфейса: ${url}`),
      cursor: () => pointer,
      characterView: {
        update: () => characterScene?.update(),
        setModelFrame: (name) => characterScene?.setModelFrame(name),
      },
      creationView: {
        update: () => creationScene?.update(),
        setModelFrame: (name) => creationScene?.setModelFrame(name),
      },
      // The creation screen's two lists and its per-profile answers come off the same gateway
      // client the character list uses, so one object holds every DBC route these screens read.
      creation: { source: names, tables: () => names.tables() },
      // «Вход в игровой мир». The glue side does no world work of its own here: it hands the
      // character it is showing to whoever started it, and that host owns the connection from then
      // on. See `main.ts`, where the handover is three calls long.
      ...(options.onEnterWorld ? { enterWorld: options.onEnterWorld } : {}),
      session: {
        names,
        onDiagnostic: (message) => console.warn("[glue session]", message),
        // The glue runtime's own world connection: its own socket, its own `WorldClient`. It is
        // *lent* to the world half of the client on enter-world and taken back on the way out —
        // the session stays its owner, so leaving the world does not have to re-authenticate.
        connect: canned ? async () => await canned.connect() : liveConnect,
      },
    },
    onStub: (kind, name) => stubs[kind].push(name),
  });

  // Both resolvers hand a WoW path to the gateway verbatim; nothing the XML says can name a host,
  // because the origin is fixed here.
  const clientFileUrl = (path: string): string => {
    const url = new URL("/client/file", origin);
    url.searchParams.set("path", path.replaceAll("/", "\\"));
    return url.href;
  };
  const textureUrl = (path: string): string => {
    const url = new URL("/texture", origin);
    url.searchParams.set("path", path.replaceAll("/", "\\"));
    return url.href;
  };

  // A newly arrived picture has to reach the element that asked for it: the renderer draws it on
  // the frames holding that path (`pictureArrived`) rather than re-applying every drawn frame.
  let pictures: FrameXmlDomRenderer | undefined;
  const textures = new FrameXmlTextureCache({
    resolve: textureUrl,
    onChange: (path, kind) => { if (pictures) pictures.pictureArrived(path, kind); else runtime.bridge.touch(); },
  });
  const fonts = new FrameXmlFontLoader({ resolve: clientFileUrl });

  const renderer = new FrameXmlDomRenderer(stage, {
    bridge: runtime.bridge,
    textures,
    textureResolver: textureUrl,
    fontResolver: clientFileUrl,
    // CharacterCreate.lua keeps these localized captions in its Lua button.name fields. The
    // drawable XML buttons have no text, so supply the same names to the accessibility tree.
    accessibilityName: (frame) => {
      const race = /^CharacterCreateRaceButton([1-9]\d*)$/.exec(frame.name);
      if (race) return runtime.api.creation.availableRaces()[Number(race[1]) - 1]?.name;
      const characterClass = /^CharacterCreateClassButton([1-9]\d*)$/.exec(frame.name);
      if (characterClass) return runtime.api.creation.availableClasses()[Number(characterClass[1]) - 1]?.name;
      return undefined;
    },
    // `GlueParent` is the glue screens' root — every screen frame declares `parent="GlueParent"` —
    // so a frame Lua created with no parent belongs inside it and not beside it. See the option.
    createdRootParent: "GlueParent",
    // The client's TrueType files need a two-byte `cmap` repair before Chrome's sanitiser accepts
    // them, so the bytes go through JavaScript rather than through an `@font-face` URL.
    fontLoader: (file, family) => {
      void fonts.load(file, family).then((outcome) => {
        if (outcome.status !== "loaded") {
          console.info(`[glue font] ${outcome.file} → ${outcome.status}`
            + (outcome.repairedSegments ? ` (cmap-сегментов исправлено: ${outcome.repairedSegments})` : "")
            + (outcome.substituted ? ` → ${outcome.substituted}` : "")
            + (outcome.message ? `: ${outcome.message}` : ""));
        }
        if (pictures) pictures.fontArrived();
        else runtime.bridge.touch();
      });
    },
  });
  pictures = renderer;

  // The document is the only thing that knows how big a `setAllPoints` frame came out, and the
  // corpus asks: `LoginScreen_OnLoad` sizes the whole login scene from `GlueParent:GetSize()`.
  //
  // That particular question arrives *before* there is a document to ask — OnLoad runs while the
  // TOC is still being walked, and the roots are mounted after it — so a frame that fills its
  // parent and has not been laid out yet answers with the screen box instead. The chain of
  // `setAllPoints` frames ends at the screen by construction, which is what makes that the right
  // answer rather than a guess; everything with a size of its own keeps reporting it.
  runtime.bridge.setMeasure((frame) => {
    const measured = renderer.measure(frame);
    if (measured && measured.width > 0 && measured.height > 0) return measured;
    // Not "the stage" any more. By the time `LoginScreen_OnLoad` asks, `GlueParent` has already run
    // its own pillarbox and is narrower than the stage at every aspect past 16:9 — see
    // `gluePinnedSize`, which resolves the two anchors that pillarbox writes.
    const stage = { width: Math.round(currentMetrics().virtualWidth), height: GLUE_LOGICAL_HEIGHT };
    const pinned = gluePinnedSize(frame, stage);
    if (pinned && pinned.width > 0 && pinned.height > 0) return pinned;
    return measured;
  });

  const models = new GlueModelStage({
    gatewayOrigin: origin,
    models: () => runtime.bridge.modelFrames,
    elementFor: (frame) => renderer.elementFor(frame),
    isVisible: (frame) => glueLoginSceneModelIsVisible(frame, runtime.bridge.isVisible(frame)),
    onDiagnostic: (message) => console.warn("[glue model]", message),
  });

  characterScene = new GlueCharacterScene({
    gatewayOrigin: origin,
    bridge: runtime.bridge,
    stage: models,
    modelFrame: "CharacterSelect",
    look: () => {
      const character = runtime.session.selected;
      if (!character) return undefined;
      const displayId = runtime.session.displayIdFor(character);
      return displayId === undefined ? undefined : characterLook(character, displayId);
    },
    facing: () => runtime.session.facing,
    aspect: stageAspect,
    onDiagnostic: (message) => console.warn("[glue character]", message),
  });
  // The same class, the same route, a different source for the look: the creation screen's figure
  // is the five customisation axes plus `CharStartOutfit`, and it is rebuilt on every change.
  creationScene = new GlueCharacterScene({
    gatewayOrigin: origin,
    bridge: runtime.bridge,
    stage: models,
    modelFrame: "CharacterCreate",
    look: () => runtime.api.creation.sceneLook(),
    facing: () => runtime.api.creation.facing,
    aspect: stageAspect,
    onDiagnostic: (message) => console.warn("[glue creation]", message),
  });
  // A class name or a zone that arrived after the list was drawn is a list that has to be drawn
  // again; the corpus redraws itself on its own event.
  names.onLoaded = () => {
    runtime.api.fireEvent("CHARACTER_LIST_UPDATE");
    // The creation screen builds both its lists inside `CharacterCreate_OnShow` and there is no
    // event that re-runs it, so a screen already up when the tables land has to be shown again —
    // and `Show()` on a visible frame dispatches nothing, which is why this hides it first. One
    // turn of the event loop, no paint in between.
    void runtime.api.creation.refreshProfile(true).then(() => {
      const frame = runtime.bridge.getFrame("CharacterCreate");
      if (frame && runtime.api.currentScreen === "charcreate") {
        runtime.bridge.Hide(frame);
        runtime.bridge.Show(frame);
      }
      creationScene?.update();
    });
  };

  report("Загрузка интерфейса...");
  try {
    // Before the corpus, not after: its screens size themselves once, in OnLoad.
    await waitForSize(host);
    const result = await runtime.load();
    renderer.registerFonts(runtime.bridge.fontStyles);
    renderer.mount(result.roots);
    // Before the first screen is shown, with a bound: `CharacterCreate_OnShow` enumerates the races
    // and classes once and nothing re-runs it, so a creation screen opened while
    // `/dbc/character-creation` is still in flight comes up with no races at all. The wait is
    // capped for the same reason `waitForSize` is — a gateway that is down must still give a
    // screen — and the late-arrival path above covers whatever lands after it.
    await Promise.race([namesReady, new Promise((resolve) => setTimeout(resolve, TABLE_WAIT_MS))]);
    await runtime.api.creation.refreshProfile(true);
    // `?screen=` brings up one of the corpus' own screens directly. The page exists to run the
    // glue screens; reaching `charselect` by logging in is not always possible while the screen
    // after it is still being built, and this is how G4 opens the one it is working on.
    runtime.api.setGlueScreen(options.screen || "login");
    report("");
    // `?fake=charselect` fills the session from `GlueFakeSession` through the same connector seam
    // the live path uses, so the character screen can be looked at with no auth or world server
    // running. It does nothing at all when the parameter is absent.
    if (canned) {
      runtime.session.beginSession(canned.auth);
      await runtime.session.connect(canned.realm);
      runtime.api.setGlueScreen(canned.screen);
    }
    console.info(
      `[glue] ${result.loaded.length} файлов, ${result.templates.length} шаблонов, `
      + `${runtime.bridge.frames.length} виджетов, ${result.missing.length} пропущено`,
    );
    if (stubs.global.length > 0) console.info("[glue] stub C-API:", stubs.global.join(", "));
    if (stubs.method.length > 0) console.info("[glue] stub methods:", stubs.method.join(", "));
    for (const diagnostic of result.diagnostics) {
      console.warn(`[glue ${diagnostic.scope}] ${diagnostic.file}: ${diagnostic.message}`);
    }
  } catch (error) {
    report(`Не удалось загрузить интерфейс: ${String(error)}`);
    // Rethrown as well as reported: on `index.html` the caller answers a failed glue load by
    // putting the DOM forms back, and it cannot do that if the failure is swallowed here.
    throw error;
  }

  // Published for the browser smoke: the acceptance checks read the texture, font, model and audio
  // counters out of the live page rather than being told what they should be.
  Object.defineProperty(window, "glueDiagnostics", {
    configurable: true,
    value: () => ({
      textures: textures.stats,
      fonts: fonts.outcomes,
      models: models.stats,
      audio: audio.report,
      widgets: runtime.bridge.frames.length,
      // `vm.errors` and not only the `onError` list: the corpus installs its own error handler
      // (`seterrorhandler`), and once it accepts a message the host callback is never reached — so
      // an error inside a screen's OnShow left no trace anywhere except here. Measured: that is how
      // `CharacterCreateEnumerateClasses` failing on a float-named global went unnoticed.
      luaErrors: [...new Set([...luaErrors, ...runtime.vm.errors])],
      screen: runtime.api.currentScreen,
      active: running,
      // Every `Model`/`ModelFFX` widget and the three things that decide whether the stage draws
      // in it. Without this a backdrop that never appears is indistinguishable from one whose file
      // was never set, and both look like a black screen.
      modelFrames: [...runtime.bridge.modelFrames].map((frame) => ({
        name: frame.name,
        file: frame.model.file,
        visible: runtime.bridge.isVisible(frame),
        element: Boolean(renderer.elementFor(frame)),
      })),
      session: {
        realms: runtime.session.realms.length,
        connected: runtime.session.connected,
        characters: runtime.session.characters.length,
        selected: runtime.session.selectedIndex,
        facing: runtime.session.facing,
        backdrop: runtime.session.backgroundModel(runtime.session.selectedIndex),
      },
      character: characterScene?.report,
      creation: {
        scene: creationScene?.report,
        raceIndex: runtime.api.creation.raceIndex,
        classIndex: runtime.api.creation.classIndex,
        race: runtime.api.creation.selectedRace()?.name ?? "",
        class: runtime.api.creation.selectedClass()?.name ?? "",
        sex: runtime.api.creation.sex,
        facing: runtime.api.creation.facing,
        look: runtime.api.creation.look,
        backdrop: runtime.api.creation.backgroundModel(),
        offered: {
          skins: runtime.api.creation.offered(1).length,
          faces: runtime.api.creation.offered(2).length,
          hairStyles: runtime.api.creation.offered(3).length,
          hairColors: runtime.api.creation.offered(4).length,
          facialHairs: runtime.api.creation.offered(5).length,
        },
      },
    }),
  });

  /*
   * The frame clock, and the listeners that only make sense while these screens are on the display.
   *
   * All of it lives behind one `AbortController` per activation, so `suspend()` is a single `abort`
   * rather than five paired `removeEventListener` calls that can drift apart. A suspended screen
   * costs a hidden subtree and nothing else: no rAF, no timer, no pointer handler, no GL context.
   */
  let running = false;
  let listeners: AbortController | undefined;
  let previous = performance.now();
  let animationHandle = 0;
  let timerHandle: ReturnType<typeof setTimeout> | undefined;

  const frame = (now: number): void => {
    if (!running) return;
    // 3.3.5 delivers OnUpdate in seconds; the corpus multiplies `elapsed` straight into its fade
    // alphas, so a milliseconds value here would make every glue fade a thousand times too fast.
    const elapsed = Math.min(0.25, (now - previous) / 1000);
    previous = now;
    runtime.tick(elapsed);
    // After the tick, because a Model widget created or re-pointed inside an OnUpdate should be
    // drawn on the frame that made it rather than on the next one.
    models.reconcile();
    // Between the reconcile and the draw: the character has to reach the backdrop's view in the
    // frame the view is created, and its facing has to be the one the drag just wrote.
    characterScene?.frame();
    creationScene?.frame();
    models.frame(elapsed, now);
    schedule();
  };

  /**
   * Keep the clock running when the window is not being looked at.
   *
   * `requestAnimationFrame` does not fire at all in a hidden tab, and the glue screen has state
   * that must not stop with it: the corpus builds its login scene on the *second* OnUpdate it
   * receives, its fades are integrated frame by frame, and a login handshake reports through a
   * status dialog that would freeze mid-attempt if the person switched windows while it ran. The
   * browser throttles a background timer to about one tick a second, which is the right price —
   * the screen keeps moving and nothing spins a core.
   */
  const schedule = (): void => {
    stopClock();
    if (!running) return;
    if (document.hidden) {
      timerHandle = setTimeout(() => frame(performance.now()), 50);
      return;
    }
    // Both, not either: `document.hidden` stays false for a window that is merely occluded or
    // minimized on some platforms, and Chrome still freezes its rAF — measured in the embedded
    // preview pane, where the login scene starved at ~5 frames a minute while `hidden` read false.
    // The corpus builds its scene on the second OnUpdate and integrates fades per tick, so a
    // starved clock is a black screen, not a paused one. Whichever source fires first cancels the
    // other through `stopClock`, so a visible tab still runs at rAF cadence and pays one armed
    // timer per frame, nothing more.
    animationHandle = window.requestAnimationFrame(frame);
    timerHandle = setTimeout(() => frame(performance.now()), 250);
  };

  function stopClock(): void {
    if (animationHandle) window.cancelAnimationFrame(animationHandle);
    if (timerHandle !== undefined) clearTimeout(timerHandle);
    animationHandle = 0;
    timerHandle = undefined;
  }

  function start(): void {
    if (running) return;
    running = true;
    const controller = new AbortController();
    listeners = controller;
    const { signal } = controller;
    window.addEventListener("resize", fit, { signal });
    // A `resize` event is not the only way the stage changes size — a window that was zero-sized
    // while it was hidden gets its real box back without one — so the box itself is watched too.
    if (typeof ResizeObserver === "function") {
      const observer = new ResizeObserver(fit);
      observer.observe(host);
      signal.addEventListener("abort", () => observer.disconnect());
    }
    window.addEventListener("pointermove", trackPointer, { signal });
    // Also on the press, because the drag reads this the instant the button goes down: without it
    // the first frame of a drag measures against wherever the pointer was last *moved*, which on a
    // fresh page is the origin. Measured: one 205-unit drag turned the character 430° instead of 123°.
    window.addEventListener("pointerdown", trackPointer, { capture: true, signal });
    document.addEventListener("visibilitychange", schedule, { signal });
    previous = performance.now();
    fit();
    schedule();
  }

  function stop(): void {
    running = false;
    stopClock();
    listeners?.abort();
    listeners = undefined;
  }

  host.hidden = false;
  start();

  return {
    runtime,
    session: runtime.session,
    get active(): boolean {
      return running;
    },
    setScreen(name: string): void {
      runtime.api.setGlueScreen(name);
    },
    suspend(): void {
      if (!running) return;
      stop();
      // Music and ambience first: an `<audio>` element left playing under a loading screen is the
      // one part of a dormant glue screen a player would actually notice.
      audio.stopMusic();
      audio.stopAllSfx();
      // Then the 3D. Both scenes before the stage, because a scene's actor lives inside a stage
      // view and `GlueModelStage.dispose` would take it down under them.
      characterScene?.dispose();
      creationScene?.dispose();
      models.dispose();
      // And the renderer's own window listener, which `stop` does not own: left armed, every
      // pointer move over the world read this hidden stage's rectangle and offset box — a forced
      // layout in the middle of the world's frame for each frame of mouse movement.
      renderer.setPointerTracking(false);
      host.hidden = true;
    },
    resume(screen?: string): void {
      host.hidden = false;
      if (!running) start();
      renderer.setPointerTracking(true);
      if (screen) runtime.api.setGlueScreen(screen);
      // The stage was disposed, so both figures have to be asked for again. `update()` is a no-op
      // when the look has not changed — which after a dispose it always has, because the scene
      // forgets what it was drawing.
      characterScene?.update();
      creationScene?.update();
    },
    dispose(): void {
      stop();
      characterScene?.dispose();
      creationScene?.dispose();
      models.dispose();
      audio.dispose();
      renderer.destroy();
      runtime.close();
      host.hidden = true;
    },
  };
}
