import type { AuthSessionResult } from "../../auth/login.js";
import type { RealmInfo } from "../../auth/AuthProtocol.js";
import { WebSocketByteStream } from "../../transport/WebSocketByteStream.js";
import { WorldClient } from "../../world/WorldClient.js";
import { gatewaySocketUrl } from "./FrontDoor.js";
import type { GlueWorldConnection, GlueWorldConnector } from "./GlueSession.js";

/**
 * The one way the glue screens open a world connection, for both pages that run them.
 *
 * `glue.html` (Bootstrap's default) and `index.html`'s front door (FrontDoorHost, which also has to
 * keep the concrete `WorldClient` to lend it to the world half) used to carry two hand-copied
 * versions of these twenty lines. What they must agree on is all here:
 *
 * - the connecting dialog's Cancel aborts `signal`, and closing the socket is what ends
 *   `WorldClient.connect`'s wait, in the realm's queue or anywhere before it;
 * - progress reports «authenticating» once the socket is open, and every queue position;
 * - a failure closes the socket it opened;
 * - a connection that completes after its Cancel is closed rather than handed back, so a host never
 *   remembers a client the session has already given up on.
 *
 * The socket and the handshake are injected so a node test can drive the seam without either.
 */

/** The byte stream `connectWorld` runs over: only its `close` is this module's business. */
export interface GlueWorldStream {
  close(): void;
}

export interface GlueWorldConnectorParts<Stream extends GlueWorldStream, Client extends GlueWorldConnection> {
  /** The `/world` WebSocket URL of the gateway. */
  readonly url: string;
  openStream(url: string): Promise<Stream>;
  connectWorld(
    stream: Stream,
    credentials: { username: string; sessionKey: Uint8Array; realmId: number; realmName: string; realmType: number },
    hooks: { onQueue(position: number): void },
  ): Promise<Client>;
  /** The connection the session is about to be handed, with the account that opened it. */
  readonly onConnected?: (client: Client, auth: AuthSessionResult, realm: RealmInfo) => void;
}

/** Error thrown for a connection that completed after the player had cancelled it. */
export class GlueConnectCancelledError extends Error {
  constructor() {
    super("world connection cancelled");
    this.name = "GlueConnectCancelledError";
  }
}

export function glueWorldConnector<Stream extends GlueWorldStream, Client extends GlueWorldConnection>(
  parts: GlueWorldConnectorParts<Stream, Client>,
): GlueWorldConnector {
  return async (realm, auth, progress, signal) => {
    const stream = await parts.openStream(parts.url);
    const abort = (): void => stream.close();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      progress?.({ stage: "authenticating" });
      const client = await parts.connectWorld(stream, {
        username: auth.username, sessionKey: auth.sessionKey, realmId: realm.id, realmName: realm.name,
        realmType: realm.type,
      }, { onQueue: (position) => progress?.({ stage: "queued", position }) });
      if (signal?.aborted) {
        client.close();
        throw new GlueConnectCancelledError();
      }
      parts.onConnected?.(client, auth, realm);
      return client;
    } catch (error) {
      stream.close();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  };
}

/** The live connector: a `WebSocketByteStream` to the gateway's `/world` and `WorldClient.connect`. */
export function liveGlueWorldConnector(
  gatewayOrigin: string,
  onConnected?: (client: WorldClient, auth: AuthSessionResult, realm: RealmInfo) => void,
): GlueWorldConnector {
  return glueWorldConnector<WebSocketByteStream, WorldClient>({
    url: gatewaySocketUrl(gatewayOrigin, "/world"),
    openStream: (url) => WebSocketByteStream.connect(url),
    connectWorld: (stream, credentials, hooks) => WorldClient.connect(stream, credentials, hooks),
    ...(onConnected ? { onConnected } : {}),
  });
}
