import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import { GlueLuaRef } from "../glue/GlueLua.js";

/** Native browser controls forward to the original TSWoW Lua handlers. */
export function discoverFrameXmlAddonEntrypoints(boot: FrameXmlBoot): {
  readonly commands: readonly { module: string; name: string; run(rest: string): void }[];
  readonly menuButtons: readonly { module: string; name: string; label: string; run(): void }[];
  close(): void;
} {
  const { vm, bridge } = boot;
  let closed = false;
  const commands: { module: string; name: string; run(rest: string): void }[] = [];
  const menuButtons: { module: string; name: string; label: string; run(): void }[] = [];
  const dispatch = vm.compileFunction(
    "local fn = SlashCmdList[key]; assert(type(fn) == 'function', 'Addon command is no longer registered'); fn(rest)",
    "framexml-addon-command", ["key", "rest"],
  );
  vm.registerGlobal("__fxTsEntrypointOwner", ([fn]) => {
    const source = fn instanceof GlueLuaRef ? vm.functionSource(fn) : undefined;
    return [source?.replaceAll("\\", "/").toLowerCase().match(/\/tsaddons\/([^/]+)\//)?.[1]];
  });
  vm.registerGlobal("__fxPublishTsEntrypoint", (args) => {
    const [kind, module, name, key] = args.map(String);
    if (!module || !name || !boot.isAddonLoaded(module)) return [];
    if (kind === "command" && /^\/[^\s/]+$/.test(name) && dispatch) {
      commands.push({ module, name: name.slice(1).toLowerCase(), run(rest) {
        // Lazy addon windows often create hundreds of widgets. Publish their completed tree once;
        // repainting on each setter otherwise forces thousands of synchronous browser layouts.
        if (!closed) bridge.runInMutationBatch(() => vm.call(dispatch, [key, rest], 0));
      } });
    } else if (kind === "menu") {
      const frame = bridge.getFrame(name);
      const label = frame?.text || frame?.children.find((child) => child.type === "FontString" && child.text)?.text;
      if (frame && label) menuButtons.push({ module, name, label, run() {
        if (!closed) bridge.Click(frame);
      } });
    }
    return [];
  });
  const result = vm.execute(`
    local owner = __fxTsEntrypointOwner
    for key, fn in pairs(SlashCmdList or {}) do
      local module = owner(fn)
      if module then
        local index = 1
        while type(_G["SLASH_" .. key .. index]) == "string" do
          __fxPublishTsEntrypoint("command", module, _G["SLASH_" .. key .. index], key)
          index = index + 1
        end
      end
    end
    if GameMenuFrame then
      for _, button in ipairs({GameMenuFrame:GetChildren()}) do
        local module = owner(button:GetScript("OnClick"))
        if module and button:GetName() then
          __fxPublishTsEntrypoint("menu", module, button:GetName(), "")
        end
      end
    end
  `, "@framexml-addon-entrypoints");
  vm.setGlobal("__fxPublishTsEntrypoint", undefined);
  vm.setGlobal("__fxTsEntrypointOwner", undefined);
  if (!result.ok) {
    if (dispatch) vm.release(dispatch);
    throw new Error(result.error);
  }
  return { commands, menuButtons, close() {
    if (closed) return;
    closed = true;
    if (dispatch) vm.release(dispatch);
  } };
}
