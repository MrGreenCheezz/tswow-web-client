import "./style.css";
import { SimpleScene } from "./SimpleScene.js";
import { WorldRenderer3D } from "./WorldRenderer3D.js";
import { game } from "./game/Context.js";
import { captureRenderTelemetry, startRenderLoop } from "./game/Loop.js";
import {
  benchmarkBrowserFromUserAgent, captureBenchmarkEnvironment, captureBenchmarkWebGl,
  type BenchmarkJsonObject,
} from "./BenchmarkManifest.js";
import type { FormalRenderBenchmarkConsoleApi } from "./FormalRenderBenchmarkConsole.js";
import type { LiveFormalRenderGraphicsConfiguration } from "./LiveFormalRenderBenchmarkHost.js";
import {
  renderBenchmarkRuntime, type LiveRenderBenchmarkSummary, type RenderBenchmarkRuntimeStatus,
} from "./RenderBenchmarkRuntime.js";
import { wireControls } from "./input/Controls.js";
import {
  characterPanel, gameWindows, gatewayInput, glueHost, glueStage, glueStatus, loginPanel,
  resetLayout, status, world3dCanvas, worldCanvas,
} from "./ui/Dom.js";
import { usePanelHost } from "./ui/Widgets.js";
import { wirePanelButtons } from "./ui/Windows.js";
import { wireLoginForms } from "./app/Login.js";
import {
  frontDoorGatewayOrigin, frontDoorMode, gatewaySocketUrl, storedFrontDoorMode,
} from "./glue/FrontDoor.js";
import { settings } from "./ui/Settings.js";
import { settingNumber } from "./ui/SettingsModel.js";

/**
 * Assembly. Everything this file used to do itself now lives in a module it can be found in:
 * panels under `ui/`, the connection and the character list under `app/`, keyboard and mouse under
 * `input/`, and whatever the world currently is under `game/`.
 */

// Panels built at runtime join the same layout as the ones in the page markup.
usePanelHost(gameWindows);
resetLayout.addEventListener("click", () => gameWindows.resetLayout());

try {
  game.renderer = new WorldRenderer3D(world3dCanvas);
} catch (error) {
  world3dCanvas.hidden = true;
  console.warn("WebGL renderer unavailable", error);
}
game.scene = new SimpleScene(worldCanvas, game.renderer === undefined);

// Console hook: dumps the opcodes the world loop dropped, with payload samples and the slice of
// the plan that owes each one a handler.
(globalThis as unknown as { webclientUnhandledOpcodes: () => unknown }).webclientUnhandledOpcodes = () =>
  game.world?.unhandledOpcodes.summary() ?? [];

async function installRenderBenchmarkConsoles(): Promise<void> {
  const [
    { createFormalRenderBenchmarkConsole },
    { FormalRenderBenchmarkRunner },
    { createLiveFormalRenderBenchmarkHost },
  ] = await Promise.all([
    import("./FormalRenderBenchmarkConsole.js"),
    import("./FormalRenderBenchmarkRunner.js"),
    import("./LiveFormalRenderBenchmarkHost.js"),
  ]);

function captureLiveBenchmarkEnvironment(
  configuration?: Readonly<LiveFormalRenderGraphicsConfiguration>,
): ReturnType<typeof captureBenchmarkEnvironment> {
  const values = settings();
  const requestedSettings: BenchmarkJsonObject = configuration?.settings ?? values;
  const applied = game.renderer?.benchmarkGraphicsConfiguration;
  const metadataSettings: BenchmarkJsonObject = applied === undefined
    ? requestedSettings
    : {
        ...requestedSettings,
        lightingQuality: applied.lightingQuality,
        renderScale: applied.renderScalePercent,
        wmoOcclusion: applied.wmoOcclusion,
        characterAtlasAnisotropy: applied.characterAtlasAnisotropy,
        grassRadius: applied.grassRadius,
        grassDense: applied.grassDense,
        experimentalAerialHeightFog: applied.experimentalShaderProfile?.aerialHeightFog === true,
        experimentalTerrainMicroNormals: applied.experimentalShaderProfile?.terrainMicroNormals === true,
        experimentalWaterFresnel: applied.experimentalShaderProfile?.waterFresnel === true,
        experimentalWaterMicroWaves: applied.experimentalShaderProfile?.waterMicroWaves === true,
        experimentalWaterSunSparkle: applied.experimentalShaderProfile?.waterSunSparkle === true,
        experimentalWaterFoam: applied.experimentalShaderProfile?.waterFoam === true,
        experimentalVegetationWind: applied.experimentalShaderProfile?.vegetationWind === true,
        experimentalFantasyGlow: applied.experimentalShaderProfile?.fantasyGlow === true,
        // P3's applied override; the requested value already rides the settings blob spread above.
        underwaterOverlay: applied.underwaterOverlay,
        // And both independent post-process leaves: record what the renderer is actually doing.
        fullscreenGlow: applied.fullscreenGlow,
        godRays: applied.godRays,
      };
  const metadataNumber = (key: string, fallback: number): number => {
    const value = metadataSettings[key];
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  };
  const systemDpr = Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
    ? window.devicePixelRatio
    : 1;
  const renderScalePercent = metadataNumber("renderScale", settingNumber(values, "renderScale"));
  const canvas = {
    cssWidth: world3dCanvas.clientWidth,
    cssHeight: world3dCanvas.clientHeight,
    backingWidth: world3dCanvas.width,
    backingHeight: world3dCanvas.height,
    systemDpr,
    effectivePixelRatio: game.renderer?.pixelRatio ?? ("unsupported" as const),
    renderScalePercent,
  };
  let context: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  if (game.renderer) {
    try {
      // The renderer already owns this canvas; getContext returns that existing context and does
      // not ask for any vendor/renderer extension. A failed/lost context remains explicit below.
      context = world3dCanvas.getContext("webgl2") ?? world3dCanvas.getContext("webgl");
    } catch {
      context = null;
    }
  }
  const webgl = captureBenchmarkWebGl(context ?? undefined);
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return captureBenchmarkEnvironment({
    canvas,
    // The host calls this after asserting that the requested setters took effect. Before a lease,
    // the optional configuration is only desired metadata; canvas/backing/DPR remain live reads.
    lighting: applied?.lightingQuality
      ?? configuration?.lighting
      ?? settingNumber(values, "lightingQuality"),
    browser: benchmarkBrowserFromUserAgent(userAgent),
    webgl,
    settings: metadataSettings,
  });
}

/** Live diagnostics only: deterministic replay remains a separate R1 gate. */
const renderBenchmarkConsole = Object.freeze({
  start(scenario: string, variant: string, runIndex: number): Readonly<RenderBenchmarkRuntimeStatus> {
    if (renderBenchmarkRuntime.active) throw new Error("a render benchmark run is already active");
    const startedAt = performance.now();
    // The first accepted cadence interval begins after activation instead of crossing idle/pre-run
    // time. This reset, like the GPU epoch reset below, happens while the runtime is inactive.
    game.renderer?.resetFrameCadence();
    // Old diagnostic queries are discarded while the runtime is still inactive, so they cannot be
    // attributed to the new run. Unsupported/lost state is then recorded explicitly at start.
    const initialGpuReason = game.renderer ? game.renderer.resetGpuTimingEpoch() : "unsupported";
    const environment = captureLiveBenchmarkEnvironment();
    const telemetry = captureRenderTelemetry(startedAt);
    return renderBenchmarkRuntime.start(
      { scenario, variant, runIndex, startedAt }, telemetry, initialGpuReason, environment);
  },
  finish(): LiveRenderBenchmarkSummary {
    if (!renderBenchmarkRuntime.active) throw new Error("no render benchmark run is active");
    const endedAt = performance.now();
    // Poll completed queries before the final checkpoint, then report every unresolved handle as a
    // dropped/incomplete sample while the accumulator is still active.
    const telemetry = captureRenderTelemetry(endedAt);
    game.renderer?.resetGpuTimingEpoch();
    const environment = captureLiveBenchmarkEnvironment();
    return renderBenchmarkRuntime.finish(endedAt, telemetry, environment);
  },
  status(): Readonly<RenderBenchmarkRuntimeStatus> {
    return renderBenchmarkRuntime.status();
  },
});

(globalThis as unknown as { webclientRenderBenchmark: typeof renderBenchmarkConsole })
  .webclientRenderBenchmark = renderBenchmarkConsole;

const formalRenderBenchmarkConsole = createFormalRenderBenchmarkConsole({
  captureLiveState: () => ({
    world: game.world?.state,
    mapId: game.world?.mapId,
    camera: { ...game.camera },
    targetGuid: game.world?.targetGuid ?? null,
    focusGuid: game.focusGuid ?? null,
  }),
  captureEnvironment: captureLiveBenchmarkEnvironment,
  captureSettings: () => settings() as BenchmarkJsonObject,
  createLiveHost: (captureEnvironment) => createLiveFormalRenderBenchmarkHost(captureEnvironment),
  runner: {
    create: (definition) => FormalRenderBenchmarkRunner.create(definition),
    createDiagnosticCandidate: (definition) => FormalRenderBenchmarkRunner.createDiagnosticCandidate(definition),
  },
});

(globalThis as unknown as { webclientFormalRenderBenchmark: FormalRenderBenchmarkConsoleApi })
  .webclientFormalRenderBenchmark = formalRenderBenchmarkConsole;
}

wireControls();
wirePanelButtons();
// Wired in both modes. The forms exist in the page either way; in glue mode their panels are
// hidden and their handlers simply never fire, which is what makes `?legacy-login` a visibility
// decision and not a second code path.
wireLoginForms();
startRenderLoop();

/**
 * Which interface this page opens with.
 *
 * The client's own GlueXML screens by default since G6 — that is the point of the whole T1 track —
 * with the DOM forms one query parameter away. The decision is made once, at start-up: everything
 * downstream asks `frontDoorHost()`, which answers `undefined` until and unless the glue runtime is
 * actually standing.
 */
const frontDoorSearch = window.location.search;
const frontDoorGateway = frontDoorGatewayOrigin(frontDoorSearch);
if (frontDoorGateway) {
  // The GlueXML login screen has no address field — the corpus' `AccountLogin` knows about an
  // account and a password and nothing else — so `?gateway=` is where a player pointing at a
  // non-default gateway says so. It is written back into the DOM field because that field is not
  // just the login form's: `EnterWorld` builds all twenty-odd asset clients out of its value, so a
  // world entered through the glue screens has to agree with it about where the gateway is.
  gatewayInput.value = gatewaySocketUrl(frontDoorGateway, "/auth");
}

if (frontDoorMode(frontDoorSearch, storedFrontDoorMode(globalThis.localStorage)) === "glue") {
  const parameters = new URLSearchParams(frontDoorSearch);
  loginPanel.hidden = true;
  characterPanel.hidden = true;
  // Loaded on demand: the Lua VM is 338 kB, and a client started in legacy mode must not pay for
  // a runtime it will never build.
  void import("./glue/FrontDoorHost.js")
    .then(async ({ openGlueFrontDoor, GLUE_FRONT_DOOR_CLASS }) => {
      document.body.classList.add(GLUE_FRONT_DOOR_CLASS);
      await openGlueFrontDoor({ host: glueHost, stage: glueStage, status: glueStatus }, {
        ...(frontDoorGateway ? { gatewayOrigin: frontDoorGateway } : {}),
        screen: parameters.get("screen"),
        fake: parameters.get("fake"),
      });
    })
    .catch((error: unknown) => {
      // A glue runtime that will not start must not leave a blank page: the DOM forms are still in
      // the document and are exactly the fallback the plan keeps them for.
      console.error("[glue] экран входа не загрузился, открыт запасной DOM-вход", error);
      document.body.classList.remove("glue-front-door");
      glueHost.hidden = true;
      loginPanel.hidden = false;
      status.className = "error";
      status.textContent = "Экран GlueXML не загрузился — открыт запасной вход. "
        + `Подробности в консоли: ${error instanceof Error ? error.message : String(error)}`;
    });
}

let renderBenchmarksReady: Promise<void> | undefined;
function ensureRenderBenchmarkConsoles(): Promise<void> {
  if (renderBenchmarksReady === undefined) {
    renderBenchmarksReady = installRenderBenchmarkConsoles();
    void renderBenchmarksReady.catch((error) =>
      console.warn("Render benchmark consoles unavailable", error));
  }
  return renderBenchmarksReady;
}

// Reading/awaiting the public promise is the explicit demand signal. Normal login and gameplay do
// not fetch or parse the formal benchmark chunks; the console API appears after this promise lands.
Object.defineProperty(globalThis, "webclientBenchmarksReady", {
  configurable: true,
  enumerable: true,
  get: ensureRenderBenchmarkConsoles,
});
