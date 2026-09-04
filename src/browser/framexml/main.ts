import "../glue/glue.css";
import { gatewayOrigin as defaultGatewayOrigin, clientLocale } from "../Environment.js";
import { createHttpFileProvider } from "../glue/GlueLoader.js";
import { GLUE_LOGICAL_HEIGHT, glueViewportMetrics } from "../glue/GlueRuntime.js";
import { FrameXmlDomRenderer } from "../ui/framexml_compat/FrameXmlDomRenderer.js";
import { FrameXmlFontLoader } from "../ui/framexml_compat/FrameXmlFonts.js";
import { FrameXmlTextureCache } from "../ui/framexml_compat/FrameXmlTextures.js";
import { frontDoorGatewayOrigin } from "../glue/FrontDoor.js";
import { FrameXmlBoot, FRAMEXML_VERTICAL_EXERCISE_EVENTS } from "./FrameXmlBoot.js";
import { FRAMEXML_VERTICAL_TOC } from "./FrameXmlCorpus.js";
import { CannedWorldSeam } from "./CannedWorldSeam.js";
import { formatFrameXmlInventory } from "./FrameXmlInventory.js";

/**
 * `framexml.html` — the dev entry for the in-world interface.
 *
 * A fourth page beside `glue.html`, and deliberately *only* a dev entry: nothing in the client
 * imports it, nothing links to it, and it does not touch the game app. F1's deliverable was the
 * inventory it prints; Wave 13's bounded vertical is the thing underneath it — a measured
 * PlayerFrame, cast bar and MainMenuBar/MultiBar set with a real player seam, plus the twelve
 * action buttons, counts and cooldown sweeps from a canned world.
 *
 * It reuses the glue stage verbatim — the same `#glue-host`/`#glue-stage` box, the same stylesheet,
 * the same 768-unit coordinate system — because that system is a measurement about this client
 * (`GlueRuntime.ts`), not a property of the glue screens, and UIParent is anchored the same way.
 *
 * Query parameters:
 *   `?toc=vertical`       load the bounded vertical — 41 files, 1,272 KiB, 890 widgets, 26 Lua chunks
 *   `?seam=none`          F2's neutral world instead of the canned one
 *   `?file=UIParent.lua`  load one file (and what it includes) instead of the whole TOC
 *   `?gateway=…`          the gateway, in any of the spellings `FrontDoor.ts` accepts
 *   `?render=0`           skip the DOM mount; measure only
 *   `?textures=0`         do not fetch the pictures (see below)
 *   `?exercise=0`         stop after the TOC walk, without session events
 *   `?trainer=1`          open the real load-on-demand Blizzard_TrainerUI against the canned seam
 *
 * **Pictures follow the TOC.** Pictures are on by default for the bounded vertical and off for the
 * whole corpus, whose unbounded texture load previously saturated the page; `?textures=` overrides
 * either way. The renderer batches screen/tick mutations (10–12→1 on a screen switch, 3–4→1 on a
 * steady tick) and skips hidden subtrees, so the measured `applyFrame` count is 3,298→42 (login),
 * 3,298→41 (charselect) and 3,298→256 (charcreate), with fake-corpus wall time ~13–37 ms→~7–17 ms.
 */

const host = document.getElementById("glue-host");
const stage = document.getElementById("glue-stage");
const report = document.getElementById("framexml-report");

function say(text: string): void {
  if (report) report.textContent = text;
}

function flag(parameters: URLSearchParams, name: string, fallback: boolean): boolean {
  const value = parameters.get(name);
  if (value === null) return fallback;
  return !/^(?:0|false|no|off)$/i.test(value.trim());
}

async function main(): Promise<void> {
  if (!host || !stage) return;
  const parameters = new URL(window.location.href).searchParams;
  const origin = frontDoorGatewayOrigin(window.location.search) ?? defaultGatewayOrigin(window.location);
  const vertical = (parameters.get("toc") ?? "").trim().toLowerCase() === "vertical";
  const wantSeam = (parameters.get("seam") ?? "canned").trim().toLowerCase() !== "none";
  const trainerRequested = flag(parameters, "trainer", false);

  // The stage is laid out in UI units and scaled uniformly, exactly as `Bootstrap.ts` does it.
  const fit = (): void => {
    const metrics = glueViewportMetrics(
      host.clientWidth || window.innerWidth,
      host.clientHeight || window.innerHeight,
    );
    stage.style.width = `${metrics.virtualWidth}px`;
    stage.style.height = `${GLUE_LOGICAL_HEIGHT}px`;
    stage.style.transform = `scale(${metrics.scale})`;
    stage.style.transformOrigin = "top left";
  };
  fit();
  window.addEventListener("resize", fit);

  const seam = wantSeam ? new CannedWorldSeam() : undefined;
  const boot = new FrameXmlBoot({
    provider: createHttpFileProvider({ gatewayOrigin: origin }),
    locale: clientLocale(),
    only: parameters.get("file"),
    exercise: flag(parameters, "exercise", true),
    ...(vertical ? { subset: FRAMEXML_VERTICAL_TOC } : {}),
    ...(vertical ? { exerciseEvents: FRAMEXML_VERTICAL_EXERCISE_EVENTS } : {}),
    ...(seam ? { seam } : {}),
    screen: () => ({
      width: Math.round(glueViewportMetrics(
        host.clientWidth || window.innerWidth,
        host.clientHeight || window.innerHeight,
      ).virtualWidth),
      height: GLUE_LOGICAL_HEIGHT,
    }),
    lua: {
      // Not console-only: the browser run has to be comparable with the node one, and the node one
      // reads this list rather than scraping a console.
      onError: (message) => console.error("[framexml lua]", message),
      onPrint: (message) => console.info("[framexml print]", message),
    },
  });

  say("Чтение корпуса...");
  const inventory = await boot.load();
  say(formatFrameXmlInventory(inventory, 30));
  console.info(formatFrameXmlInventory(inventory, 40));

  let renderer: FrameXmlDomRenderer | undefined;
  if (flag(parameters, "render", true)) {
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
    const textures = flag(parameters, "textures", vertical)
      ? new FrameXmlTextureCache({ resolve: textureUrl, onChange: () => boot.bridge.touch() })
      : undefined;
    const fonts = new FrameXmlFontLoader({ resolve: clientFileUrl });
    renderer = new FrameXmlDomRenderer(stage, {
      bridge: boot.bridge,
      ...(textures ? { textures, textureResolver: textureUrl } : {}),
      fontResolver: clientFileUrl,
      // The renderer's sweep and the corpus' `GetTime()` have to be the same clock, or a cooldown
      // that started «now» would be drawn as finished.
      clock: boot.pump.now,
      // The in-world root, as `UIParent.xml` declares it; a frame Lua created with no parent
      // belongs inside it, the same way `GlueParent` works on the glue page.
      createdRootParent: "UIParent",
      fontLoader: (file, family) => {
        void fonts.load(file, family).then(() => boot.bridge.touch());
      },
    });
    renderer.registerFonts(boot.bridge.fontStyles);
    renderer.mount(boot.roots);
  }

  let trainerPreview = "disabled";
  if (trainerRequested) {
    if (!seam || !renderer) {
      trainerPreview = "unavailable";
    } else {
      seam.openTrainer();
      const addon = await boot.loadAddon("Blizzard_TrainerUI");
      if (!addon.ok) throw new Error(addon.message);
      renderer.addRoots(addon.roots);
      // The stock root is parented into UIParent, so the LoD delta can legitimately have no roots.
      renderer.sync();
      const root = boot.bridge.getFrame("ClassTrainerFrame");
      const show = boot.vm.globalFunction("ClassTrainerFrame_Show");
      if (!root || !show) {
        if (show) boot.vm.release(show);
        throw new Error("Blizzard_TrainerUI preview gate is incomplete");
      }
      const before = boot.errorCount;
      const diagnosticsBefore = boot.bridge.diagnostics.length;
      try {
        boot.bridge.Show(root);
        if (boot.errorCount > before || boot.bridge.diagnostics.length > diagnosticsBefore) {
          throw new Error("Blizzard_TrainerUI preview OnShow reported an error");
        }
        boot.vm.call(show, [], 0);
        if (boot.errorCount > before || boot.bridge.diagnostics.length > diagnosticsBefore) {
          // GlueLua records handled Lua failures instead of throwing them. A preview must not report
          // a visible trainer after such a failed stock call, so undo the probe before propagating.
          throw new Error("Blizzard_TrainerUI preview raised a Lua error");
        }
      } catch (error) {
        try { boot.bridge.Hide(root); } catch { /* preserve the original preview failure */ }
        throw error;
      } finally {
        boot.vm.release(show);
      }
      renderer.sync();
      if (!boot.bridge.isVisible(root)) throw new Error("Blizzard_TrainerUI preview did not open");
      trainerPreview = addon.status;
    }
  }
  const publishTrainerPreview = (): void => {
    if (!trainerRequested) return;
    stage.dataset.trainerPreview = trainerPreview;
    stage.dataset.trainerVisible = String(boot.bridge.getFrame("ClassTrainerFrame")?.visible === true);
    stage.dataset.trainerBuyRequests = seam ? seam.trainerBuyRequests.join(",") : "";
  };
  publishTrainerPreview();

  /**
   * The frame loop, and the two things it is for.
   *
   * `bridge.tick` is what `ActionButton_OnUpdate` needs — the range indicator and the attack flash
   * — and it costs nothing on a frame where nothing mutated, because the bridge only notifies its
   * listeners when a dispatch actually changed something. `renderer.tickCooldowns` is the sweep,
   * and it walks only the Cooldown widgets rather than the whole tree.
   *
   * Deliberately *not* started when there is no seam: with F2's neutral world nothing moves, and a
   * census page should not be spending a frame budget on proving it.
   */
  let frames = 0;
  if (seam) {
    let previous = boot.pump.now();
    const step = (): void => {
      const now = boot.pump.now();
      const elapsed = Math.min(0.25, Math.max(0, now - previous));
      previous = now;
      frames += 1;
      seam.tick(now);
      boot.bridge.tick(elapsed);
      renderer?.tickCooldowns(now);
      publishTrainerPreview();
      window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  }

  // Published for the browser smoke, the same contract `glueDiagnostics` has: the acceptance checks
  // read the numbers out of the live page instead of being told what they should be.
  Object.defineProperty(window, "frameXmlDiagnostics", {
    configurable: true,
    value: () => ({
      ...inventory,
      live: {
        frames,
        now: boot.pump.now(),
        cooldownWidgets: renderer?.cooldownCount ?? 0,
        cooldownsRunning: renderer?.tickCooldowns() ?? 0,
        trainerPreview,
        trainerVisible: boot.bridge.getFrame("ClassTrainerFrame")?.visible === true,
        trainerBuyRequests: seam ? [...seam.trainerBuyRequests] : [],
      },
    }),
  });
  // A named handle on the bar for the acceptance check: clicking a button is how the whole
  // secure-attribute chain is proved, and a screenshot cannot press one.
  Object.defineProperty(window, "frameXmlClick", {
    configurable: true,
    value: (name: string) => {
      const frame = boot.bridge.getFrame(name);
      return frame ? boot.bridge.Click(frame, "LeftButton", false) : false;
    },
  });
}

void main().catch((error: unknown) => {
  console.error("[framexml] корпус не загрузился", error);
  say(`Не удалось загрузить интерфейс: ${String(error)}`);
});
