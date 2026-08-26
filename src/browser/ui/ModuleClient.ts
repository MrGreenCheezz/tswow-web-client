/**
 * The module system as this client wires it: one host, one loader, one `<style>` node per module.
 *
 * `ModuleLoader`, `WindowRender` and `WindowActions` are all written against callbacks rather than
 * imports, so that each of them can be tested without a page. This is the file that supplies those
 * callbacks — the chat box, the sound player, the gateway's texture route, the bindings table —
 * and it is the only one of the four that could not run outside a browser.
 *
 * Two callers: `EnterWorld` starts the loader on entering the world, and the diagnostics window's
 * «Окна» pane borrows the same render host for its two example buttons, so that what the pane draws
 * goes through exactly the machinery a module's own file will.
 */

import type { CustomPacketRegistry } from "../../world/CustomPacketRegistry.js";
import { game } from "../game/Context.js";
import { playUiSound, UI_SOUNDS } from "../game/GameSounds.js";
import { setFocusToTarget } from "../game/Targeting.js";
import { addModuleAction, removeModuleActions } from "../input/Bindings.js";
import { addModuleCommand, removeModuleCommands, submitChat } from "./Chat.js";
import { gameWindows } from "./Dom.js";
import { interactWithTarget } from "./Npc.js";
import { settings } from "./Settings.js";
import { FILLABLE_SLOTS, SKINNABLE_WINDOWS, SLOT_NAMES } from "./Slots.js";
import { ALL_WINDOW_ROOTS, liveWindowSnapshot } from "./WindowBindings.js";
import { runWindowActions, type WindowActionHost } from "./WindowActions.js";
import { ModuleLoader } from "./ModuleLoader.js";
import { applyWindowPatch } from "./WindowPatch.js";
import { renderWindow, type WindowRenderHost } from "./WindowRender.js";
import { patchRegistry, windowRegistry } from "./WindowRegistry.js";

/** The sound kits a `sound` action may name: the fourteen `playUiSound` answers. */
const SOUND_KITS: ReadonlySet<string> = new Set(Object.keys(UI_SOUNDS));

/** Every `<style data-module>` this client has put in the head, by module. */
const styleNodes = new Map<string, HTMLStyleElement>();

/**
 * Puts one module's scoped stylesheet in the head, or takes it out again.
 *
 * One node per module rather than one per file, so that unloading is a single `remove()` and there
 * is no way to leave half a module's styling behind. The text is already prefixed with
 * `[data-module="…"]` by the loader — see `prefixModuleCss` — and this function does not check
 * that, because a second check in a second file is a second place to get it wrong.
 *
 * Exported for the diagnostics «Окна» pane, which applies the example patch with no loader behind
 * it: a patch's `css` is a third of what a patch does, and a button that applied the other two
 * would have shown a re-skin that re-skinned nothing.
 */
export function setModuleStyle(module: string, css: string): void {
  const existing = styleNodes.get(module);
  if (!css) {
    existing?.remove();
    styleNodes.delete(module);
    return;
  }
  const node = existing ?? document.createElement("style");
  node.dataset["module"] = module;
  node.textContent = css;
  if (!existing) {
    document.head.append(node);
    styleNodes.set(module, node);
  }
}

/** What an action press reaches: the world, the chat box, the sound player and the registry. */
export function moduleActionHost(): WindowActionHost {
  return {
    registry: windowRegistry,
    world: game.world,
    // Through `submitChat` and never through `world.sendChat`: this is what makes a module's `chat`
    // action inherit the client's own command whitelist and its byte-length check.
    chat: submitChat,
    sound: (kit: string) => {
      if (SOUND_KITS.has(kit)) playUiSound(kit as keyof typeof UI_SOUNDS);
    },
    // Every root, because a press is not a frame: the binding pass built only the roots the
    // *windows* read, and an action's expressions were never part of that set.
    snapshot: () => liveWindowSnapshot({ roots: ALL_WINDOW_ROOTS, settings }),
    helpers: expressionHelpers(),
    focusTarget: setFocusToTarget,
    interactWithTarget,
    onProblem: (text: string) => { game.modules?.notePressProblem(text); },
  };
}

function expressionHelpers(): { spellName: (id: number) => string | undefined; itemName: (id: number) => string | undefined } {
  return {
    spellName: (id: number) => game.spells.get(id)?.name,
    itemName: (id: number) => game.itemMetadata?.get(id)?.name,
  };
}

/**
 * What the renderer is handed in this client: the gateway for pictures, and the action runner.
 *
 * `textureUrl` points at the gateway's `/texture`, which only works because every picture goes
 * through `setIconSource`'s fetch: an `<img src>` straight at that route is a silent 403.
 */
export function moduleWindowHost(): WindowRenderHost {
  const origin = game.gatewayOrigin;
  return {
    textureUrl: origin
      ? (path: string) => `${origin}/texture?path=${encodeURIComponent(path.replaceAll("/", "\\"))}`
      : undefined,
    // Which file, which window, which path and what the gateway answered — the four things an
    // author needs in order to go and fix it, in the «Окна» pane beside that file's other refusals.
    // Until this the pane printed «No problems» about a window every picture of which was a 400.
    onTextureProblem: (problem) => {
      const answer = problem.status === 0 ? "нет ответа" : `HTTP ${problem.status}`;
      game.modules?.noteTextureProblem(
        `${problem.module}/${problem.windowId}: картинка «${problem.path}» не загрузилась (${answer}) — ${problem.url}`);
    },
    helpers: expressionHelpers(),
    viewport: { width: gameWindows.viewport.clientWidth, height: gameWindows.viewport.clientHeight },
    runActions: (actions, context) => { runWindowActions(actions, context, moduleActionHost()); },
  };
}

/**
 * The loader, wired to this client's chat, bindings, styles and window registry.
 *
 * The packet registry is an argument rather than `game.world.customPackets`, because the registry
 * belongs to *this* world client: a loader that read it off the context would, on a second login,
 * define the schemas into whichever registry happened to be current when the fetch came back.
 */
export function createModuleLoader(gatewayWebSocketUrl: string, packets: CustomPacketRegistry): ModuleLoader {
  return new ModuleLoader(gatewayWebSocketUrl, {
    packets,
    windows: windowRegistry,
    render: (definition) => renderWindow(definition, moduleWindowHost()),
    patches: patchRegistry,
    applyPatch: (patch) => applyWindowPatch(patch, moduleWindowHost()),
    // The whole table rather than what is on screen: a patch is applied on entering the world and
    // the quest log has drawn no cards yet, so checking against the slots that exist right now
    // would refuse a good file for a panel nobody has opened.
    slotNames: new Set(SLOT_NAMES),
    // And the seven of those a widget may go into: the other three are written with `textContent`
    // by the panel that owns them, which would sweep a module's widget off without a word.
    fillableSlots: new Set(FILLABLE_SLOTS),
    skinnableWindows: new Set(SKINNABLE_WINDOWS),
    addCommand: (command) => addModuleCommand(command),
    removeCommands: (module) => { removeModuleCommands(module); },
    addBinding: (binding) => { addModuleAction(binding); },
    removeBindings: (module) => { removeModuleActions(module); },
    setStyle: setModuleStyle,
    soundKits: SOUND_KITS,
    // `setInterval` rather than a frame counter: the poll is a directory scan on the other side of
    // a socket, and hanging it off the render loop would tie how often a file is noticed to how
    // fast the machine is drawing.
    schedule: (run, milliseconds) => {
      const timer = window.setInterval(run, milliseconds);
      return () => window.clearInterval(timer);
    },
  });
}
