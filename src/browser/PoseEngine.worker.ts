import { runPoseWorker } from "./PoseEngineCore.js";

// The project includes DOM rather than WebWorker globals. One message starts the loop, which then
// lives on the shared arena alone (`PoseEngine.ts`) and never returns to the event loop.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ sab: SharedArrayBuffer; index: number }>) => void) | null;
};
scope.onmessage = ({ data }) => {
  scope.onmessage = null;
  runPoseWorker(data.sab, data.index);
};
