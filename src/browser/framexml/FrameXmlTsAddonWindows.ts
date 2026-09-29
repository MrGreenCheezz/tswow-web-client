import type { FrameXmlBoot } from "./FrameXmlBoot.js";
import type { FrameXmlFrame } from "../ui/framexml_compat/FrameXmlTypes.js";

/** UISpecialFrames is the module's opt-in to Escape, including lazily-created windows. */
export function createFrameXmlTsAddonWindows(boot: FrameXmlBoot): {
  isOpen(): boolean; close(): void; dispose(): void;
} {
  const list = boot.vm.compileFunction(`
    local frames = {}
    for _, name in ipairs(UISpecialFrames or {}) do
      local frame = _G[name]
      if type(name) == "string" and type(frame) == "table" then frames[#frames + 1] = name end
    end
    return unpack(frames)
  `, "framexml-addon-windows", []);
  let disposed = false;
  const visible = (): FrameXmlFrame[] => {
    if (disposed || !list) return [];
    return boot.vm.call(list, [], -1).map((value) =>
      typeof value === "string" ? boot.bridge.getFrame(value) : undefined)
      .filter((frame): frame is FrameXmlFrame => {
      if (!frame) return false;
      const owner = boot.tsAddonOwner(frame);
      return (frame.name === "ItemSocketingFrame" || !!owner && boot.isAddonLoaded(owner))
        && boot.bridge.isVisible(frame);
    });
  };
  return {
    isOpen: () => visible().length > 0,
    close: () => boot.bridge.runInMutationBatch(() => {
      for (const frame of visible()) boot.bridge.Hide(frame);
    }),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (list) boot.vm.release(list);
    },
  };
}
