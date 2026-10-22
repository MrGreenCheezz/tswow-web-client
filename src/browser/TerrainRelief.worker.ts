import { deriveTerrainRelief } from "./TerrainReliefDerive.js";
import type { TerrainReliefRequest, TerrainReliefResponse } from "./TerrainReliefWorker.js";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<TerrainReliefRequest>) => void;
  postMessage(message: TerrainReliefResponse, transfer: Transferable[]): void;
};

// 22.10 (7.47): one layer per message; the answer's buffer is transferred back.
scope.onmessage = ({ data: request }) => {
  try {
    const relief = deriveTerrainRelief({ pixels: request.pixels, size: request.size, mask: request.mask });
    scope.postMessage({ id: request.id, relief }, [relief.buffer]);
  } catch (error) {
    scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }, []);
  }
};
