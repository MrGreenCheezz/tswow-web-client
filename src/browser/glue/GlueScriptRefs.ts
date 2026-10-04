/**
 * 3.27 (03.10, L5): the Lua functions behind `SetScript`/`HookScript`, kept the way Wow.exe 3.3.5a
 * (12340) keeps them (notes .runtime/re-2026-10-03/l5-runtime/g1.c, g4.c):
 *
 * - A frame has one slot per script holding one registry reference. `SetScript` (0x0049ec80) unrefs
 *   the slot's function and refs the new one (nil empties the slot). The widget layer used to retain
 *   every function it was given and free none: the stock UIFrameFade sets OnUpdate again on every
 *   hover of the chat, so each hover pinned another function.
 * - `HookScript` (0x0049edb0) on an empty slot stores the hook as the handler; otherwise it puts a
 *   closure (0x00817050) in the slot that calls the old function, then the hook under pcall, and
 *   answers the old one's results. A later `SetScript` — nil included — therefore replaces the hooks
 *   along with the handler, `OnUpdate` as any other script.
 *
 * Here a bridge handler is a JS wrapper around a retained reference (GlueWidgets.wrapHandler). The
 * bridge counts the slots and hook lists holding each wrapper and says when none does, after the
 * outermost script dispatch (FrameXmlRuntime `onScriptHandlerReleased`), so a handler that clears
 * its own script still has its hooks called in that call, as the client's running closure does;
 * this then frees the reference. Hooks Lua added are dropped by Lua's SetScript; the host's own
 * hooks (portraits, gossip; L5b, 04.10: and WebClient's glue on stock frames, FrameXmlHostHooks.ts)
 * are not Lua's and stay.
 *
 * L5-review (04.10): while Lua hooks are on a script, `GetScript` answers a closure like the client's
 * (`scriptValue`) — the slot's function, then each hook under pcall, the function's results — the
 * same one until the slot or the hooks change. An add-on that wraps that answer and sets the wrapper
 * (Blizzard_CombatLog.lua:3337, SecureHandlers.lua:264 and the old way of hooking before HookScript)
 * keeps the hooks running, as in Wow.exe; with the original function answered, its SetScript dropped
 * them. Not reproduced: an error in the handler does not stop the hooks of a dispatch, as `lua_call`
 * would in the closure.
 */
import type { GlueLuaRef, GlueLuaVm } from "./GlueLua.js";
import type { FrameXmlUiBridge } from "../ui/framexml_compat/FrameXmlRuntime.js";
import type { FrameXmlFrame, FrameXmlScriptHandler } from "../ui/framexml_compat/FrameXmlTypes.js";

/**
 * L5-review: Wow.exe 0x00817050 as Lua — the old function by a plain call (an error goes on up), then
 * each hook under pcall with the error handler, then the old function's results, nils included. The
 * chunk name keeps the legacy globals (this, argN) set for it: the functions inside may read them.
 */
const CLOSURE_MAKER = `
local select, pcall, unpack, geterrorhandler = select, pcall, table.unpack, geterrorhandler
local hooks, count = { ... }, select("#", ...)
local function pack(...) return { n = select("#", ...), ... } end
return function(...)
  local results = pack(old(...))
  for index = 1, count do
    local ok, message = pcall(hooks[index], ...)
    if not ok then
      local handler = geterrorhandler()
      if handler then handler(message) end
    end
  end
  return unpack(results, 1, results.n)
end
`;

export class GlueScriptRefs {
  readonly #vm: GlueLuaVm;
  readonly #bridge: FrameXmlUiBridge;
  readonly #forget: (handler: FrameXmlScriptHandler) => void;
  /** Wrappers made for SetScript/HookScript and the reference each holds. */
  readonly #owned = new WeakMap<FrameXmlScriptHandler, GlueLuaRef>();
  /** The hooks Lua added, per frame and script. */
  readonly #hooks = new WeakMap<FrameXmlFrame, Map<string, FrameXmlScriptHandler[]>>();
  /** L5-review: GetScript's closure per frame and script, and the slot handler it was made for. */
  readonly #closures = new WeakMap<FrameXmlFrame, Map<string, { readonly handler: FrameXmlScriptHandler; readonly ref: GlueLuaRef }>>();
  /** L5-review: `(old, hook…) → closure`, compiled on first use. */
  #closureMaker: GlueLuaRef | undefined;

  constructor(vm: GlueLuaVm, bridge: FrameXmlUiBridge, forget: (handler: FrameXmlScriptHandler) => void) {
    this.#vm = vm;
    this.#bridge = bridge;
    this.#forget = forget;
    bridge.onScriptHandlerReleased((handler) => this.release(handler));
  }

  /** `frame:SetScript(script, fn)`: `handler` wraps `ref`, which this now owns; null empties the slot. */
  setScript(frame: FrameXmlFrame, script: string, handler: FrameXmlScriptHandler | null, ref?: GlueLuaRef): void {
    if (handler && ref) this.#owned.set(handler, ref);
    const name = script.trim();
    if (!this.#bridge.SetScript(frame, name, handler) && handler) this.release(handler);
    this.dropHooks(frame, name);
    this.forgetClosure(frame, name); // L5-review
  }

  /** `frame:HookScript(script, fn)`: the handler of an empty slot, else one more hook. */
  hookScript(frame: FrameXmlFrame, script: string, handler: FrameXmlScriptHandler, ref: GlueLuaRef): void {
    const name = script.trim();
    if (this.#bridge.GetScript(frame, name) === undefined) {
      this.setScript(frame, name, handler, ref);
      return;
    }
    this.#owned.set(handler, ref);
    if (!this.#bridge.HookScript(frame, name, handler)) {
      this.release(handler);
      return;
    }
    let scripts = this.#hooks.get(frame);
    if (!scripts) {
      scripts = new Map();
      this.#hooks.set(frame, scripts);
    }
    const hooks = scripts.get(name);
    if (hooks) hooks.push(handler);
    else scripts.set(name, [handler]);
    this.forgetClosure(frame, name); // L5-review
  }

  /**
   * L5-review: what Lua's `GetScript` answers for the slot's `handler` (whose function is `ref`): with
   * Lua hooks on the script, the client's hook closure (0x00817050) — the function, then each hook
   * under pcall with the error handler, answering the function's results; otherwise `ref`.
   */
  scriptValue(frame: FrameXmlFrame, script: string, handler: FrameXmlScriptHandler, ref: GlueLuaRef): GlueLuaRef {
    const name = script.trim();
    const hooks = this.#hooks.get(frame)?.get(name);
    if (!hooks || hooks.length === 0 || this.#vm.closed) return ref;
    const cached = this.#closures.get(frame)?.get(name);
    if (cached?.handler === handler) return cached.ref;
    const hookRefs = hooks.map((hook) => this.#owned.get(hook));
    if (hookRefs.some((hookRef) => hookRef === undefined)) return ref;
    this.#closureMaker ??= this.#vm.compileFunction(CLOSURE_MAKER, "interface/webclient/hook-closure", ["old"]);
    if (!this.#closureMaker) return ref;
    const made = this.#vm.call(this.#closureMaker, [ref, ...hookRefs], 1)[0];
    if (!made || typeof made !== "object" || (made as GlueLuaRef).type !== "function") return ref;
    this.forgetClosure(frame, name);
    let closures = this.#closures.get(frame);
    if (!closures) this.#closures.set(frame, (closures = new Map()));
    closures.set(name, { handler, ref: made as GlueLuaRef });
    return made as GlueLuaRef;
  }

  private forgetClosure(frame: FrameXmlFrame, name: string): void {
    const closures = this.#closures.get(frame);
    const cached = closures?.get(name);
    if (!closures || !cached) return;
    closures.delete(name);
    if (!this.#vm.closed) this.#vm.release(cached.ref);
  }

  private dropHooks(frame: FrameXmlFrame, name: string): void {
    const scripts = this.#hooks.get(frame);
    const hooks = scripts?.get(name);
    if (!scripts || !hooks) return;
    scripts.delete(name);
    for (const hook of hooks) this.#bridge.unhookScript(frame, name, hook);
  }

  private release(handler: FrameXmlScriptHandler): void {
    const ref = this.#owned.get(handler);
    if (!ref) return;
    this.#owned.delete(handler);
    this.#forget(handler);
    if (!this.#vm.closed) this.#vm.release(ref);
  }
}
