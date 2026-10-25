import { loadWmoRelief } from "./WmoReliefLoad.js";
import type { WmoReliefRequest, WmoReliefResponse } from "./WmoReliefWorker.js";

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<WmoReliefRequest>) => void;
  postMessage(message: WmoReliefResponse, transfer: Transferable[]): void;
};

// 22.10 (7.47 stage 2): one texture per message, fetched and derived here; the map's buffer is transferred back.
scope.onmessage = ({ data: request }) => {
  loadWmoRelief(request.url, request.neural === true).then((answer) => {
    scope.postMessage({ id: request.id, ...answer }, answer.relief ? [answer.relief.buffer] : []);
  }, (error: unknown) => {
    scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) }, []);
  });
};
