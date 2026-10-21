// 22.10 ARC-2 S3b: a PortraitRenderer wired to the page's canvas bridge the way the client wires it.
//
// The renderer takes plain inputs and queues canvas operations; PortraitCanvasBridge turns the canvas map into
// inputs and applies the operations as each is queued (WorldRenderer3D's output listener, ui/Portraits.ts). The
// loop pushes the targets every frame before the portrait pass, so `render` here pushes the last map first —
// what the canvases say now (size, marks, ready flag) — as `syncPortraitTargets` does; `clear` forgets the map
// until the next `setTargets`, as the world-exit paths clear the page's map with the renderer.
import { PortraitRenderer } from "../../dist/code/browser/PortraitRenderer.js";
import { PortraitCanvasBridge } from "../../dist/code/browser/PortraitCanvasBridge.js";

export function portraitView(renderer, source, options = {}) {
  const { stockTargets, ...rest } = options;
  const bridge = new PortraitCanvasBridge(stockTargets);
  const outputs = [];
  const view = new PortraitRenderer(renderer, source, { ...rest, outputs, onOutputs: () => bridge.drain(outputs) });
  let targets;
  const push = () => { if (targets) view.setTargets(bridge.inputs(targets)); };
  return new Proxy(view, {
    get(target, key) {
      if (key === "setTargets") return (map) => { targets = map; push(); };
      if (key === "render") return (now) => { push(); return view.render(now); };
      if (key === "clear") return () => { targets = undefined; view.clear(); };
      if (key === "bridge") return bridge;
      if (key === "outputs") return outputs;
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(view) : value;
    },
  });
}
