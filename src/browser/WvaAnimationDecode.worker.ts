import { decodeWvaAnimationRequest } from "./WvaAnimationDecode.js";
import type { WvaAnimationDecodeRequest, WvaAnimationDecodeResponse } from "./WvaAnimationDecodeProtocol.js";

// The project includes DOM rather than WebWorker globals. Keep this entry's surface explicit;
// importing the decoder elsewhere must not install a global message handler.
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<WvaAnimationDecodeRequest>) => void;
  postMessage(message: WvaAnimationDecodeResponse, transfer: ArrayBuffer[]): void;
};
scope.onmessage = ({ data }) => {
  const { response, transfer } = decodeWvaAnimationRequest(data);
  scope.postMessage(response, transfer);
};
