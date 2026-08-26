import "./style.css";
import { SimpleScene } from "./SimpleScene.js";
import { WorldRenderer3D } from "./WorldRenderer3D.js";
import { game } from "./game/Context.js";
import { startRenderLoop } from "./game/Loop.js";
import { wireControls } from "./input/Controls.js";
import { gameWindows, resetLayout, world3dCanvas, worldCanvas } from "./ui/Dom.js";
import { usePanelHost } from "./ui/Widgets.js";
import { wirePanelButtons } from "./ui/Windows.js";
import { wireLoginForms } from "./app/Login.js";

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

wireControls();
wirePanelButtons();
wireLoginForms();
startRenderLoop();
