import { environmentTileDecodeMessages,
  type EnvironmentTileDecodeRequest, type EnvironmentTileDecodeResponse,
} from "./EnvironmentTileDecode.js";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<EnvironmentTileDecodeRequest>) => void;
  postMessage(message: EnvironmentTileDecodeResponse): void;
};

// 05.10-A7b-1 (7.19): the messages come from one place shared with the tests — the readable objects
// in bounded slices, then `done` with what the per-object check left out, or one `error`.
scope.onmessage = ({ data: request }) => {
  for (const message of environmentTileDecodeMessages(request)) scope.postMessage(message);
};
