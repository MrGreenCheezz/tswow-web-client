import { decodeEnvironmentTile, environmentTileChunks,
  type EnvironmentTileDecodeRequest, type EnvironmentTileDecodeResponse,
} from "./EnvironmentTileDecode.js";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<EnvironmentTileDecodeRequest>) => void;
  postMessage(message: EnvironmentTileDecodeResponse): void;
};

scope.onmessage = ({ data: request }) => {
  try {
    const objects = decodeEnvironmentTile(request.data);
    let offset = 0;
    for (const chunk of environmentTileChunks(objects)) {
      scope.postMessage({ id: request.id, offset, objects: chunk });
      offset += chunk.length;
    }
    scope.postMessage({ id: request.id, done: true, total: objects.length });
  } catch (error) {
    scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
};
