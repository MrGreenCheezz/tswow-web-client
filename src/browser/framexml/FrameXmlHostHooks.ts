/**
 * 3.27 (04.10, L5b): WebClient's own script hooks as host hooks.
 *
 * In Wow.exe a Lua `HookScript` lives in the script's slot — the hooking closure 0x00817050 that
 * 0x0049edb0 stores there — so any later `SetScript` on that script, an add-on's included, replaces
 * it along with the handler (GlueScriptRefs.ts reproduces that). What the client itself does around
 * a frame is C++, and no add-on can take it off. Our glue around stock frames — the StaticPopup
 * text measure and the popup counter, the dialog layer over the native windows (StaticPopup1-4,
 * ReadyCheckFrame), DressUpFrame's model wake, the auction «Максимум» buttons' revalidation, the
 * reason tooltips of the options the client cannot offer — was Lua hooks, so an add-on's
 * `StaticPopup1:SetScript("OnShow", f)` silently dropped it. It is held by the host now
 * (FrameXmlRuntime `HookScript`'s list, which Lua's `SetScript` leaves alone, as the portraits and
 * gossip hooks always were): run after the handler, in the order hooked, and not part of what
 * `GetScript` answers — as the client's own code is not.
 *
 * The installing chunk calls `__webclientHostHook(frame, script, fn)` instead of
 * `frame:HookScript(script, fn)` while `withFrameXmlHostHooks` runs it (FrameXmlAddonsOnlyMessages,
 * FrameXmlPopupsOwner, FrameXmlDressUp, FrameXmlAuctionOwner, FrameXmlOptions/-Owner); the same Lua
 * function is called through the widget layer's own invoker (`__glueInvoke`, GlueWidgets.ts), as
 * its Lua hook was: the legacy globals set, an error to the error handler. Unlike Lua's HookScript
 * on an empty slot, it never becomes the frame's handler.
 */
import { GlueLuaRef } from "../glue/GlueLua.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";
import type { FrameXmlBoot } from "./FrameXmlBoot.js";

/** The binding a chunk run by `withFrameXmlHostHooks` calls for `frame:HookScript(script, fn)`. */
export const FRAMEXML_HOST_HOOK_GLOBAL = "__webclientHostHook";

/**
 * Run `install` (which runs Lua) while `__webclientHostHook(frame, script, fn)` hooks `fn` on the
 * host; the binding answers whether it hooked, and is nil again afterwards.
 */
export function withFrameXmlHostHooks<T>(boot: Pick<FrameXmlBoot, "vm" | "bridge">, install: () => T): T {
  const { vm, bridge } = boot;
  let invoke: GlueLuaRef | undefined;
  vm.registerGlobal(FRAMEXML_HOST_HOOK_GLOBAL, (args) => {
    const [frame, script, fn] = args;
    if (!frame || typeof frame !== "object" || frame instanceof GlueLuaRef || typeof script !== "string"
      || !(fn instanceof GlueLuaRef) || fn.type !== "function") return [false];
    // One retained invoker for every hook this install makes; it lives as long as they do (the VM).
    invoke ??= vm.globalFunction("__glueInvoke");
    const ref = vm.retain(fn);
    const caller = invoke;
    const isEvent = script === "OnEvent";
    const hooked = bridge.HookScript(frame as FrameXmlFrame, script, (self, ...rest) => {
      if (vm.closed) return;
      if (caller) vm.call(caller, [ref, self, isEvent, ...rest], 0);
      else vm.call(ref, [self, ...rest], 0);
    });
    if (!hooked) vm.release(ref);
    return [hooked];
  });
  try {
    return install();
  } finally {
    vm.setGlobal(FRAMEXML_HOST_HOOK_GLOBAL, undefined);
  }
}
