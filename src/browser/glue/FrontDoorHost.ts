import { startGlue, type GlueHandle } from "./Bootstrap.js";
import { frontDoorReturn, gatewaySocketUrl, useFrontDoor, type FrontDoorHost } from "./FrontDoor.js";
import { WebSocketByteStream } from "../../transport/WebSocketByteStream.js";
import { WorldClient } from "../../world/WorldClient.js";
import { gatewayOrigin as defaultGatewayOrigin } from "../Environment.js";
import { game } from "../game/Context.js";
import { adoptWorld } from "../app/Login.js";
import { enterWorld } from "../app/EnterWorld.js";

/**
 * The GlueXML screens as `index.html`'s front door, and the handover in both directions.
 *
 * This is the whole of what G6 added on top of G1–G5: the screens themselves were already real, and
 * what was missing was the two crossings. In: «Вход в игровой мир» stops the glue screens, gives
 * the world half of the client the connection the glue session already has, and calls the same
 * `enterWorld` the DOM character card called. Out: every way a world ends comes back through
 * `returnFromWorld` and lands on the screen `frontDoorReturn` names.
 *
 * **One session, lent — not two.** The socket stays owned by `GlueSession` for the whole time. The
 * world half only *adopts* it (`game.world`, a store, the HUD and the death layer), and leaving the
 * world drops that adoption without closing anything. That is what makes the way back a screen
 * change and not a second SRP6 login.
 *
 * Loaded on demand by `main.ts`, so a client started with `?legacy-login=1` never fetches the Lua
 * VM at all.
 */

export interface GlueFrontDoorElements {
  readonly host: HTMLElement;
  readonly stage: HTMLElement;
  readonly status?: HTMLElement | null;
}

export interface OpenGlueFrontDoorOptions {
  /** `?gateway=` — the glue screens' replacement for the DOM form's address field. */
  readonly gatewayOrigin?: string;
  /** `?screen=` — open one of the corpus' own screens directly. */
  readonly screen?: string | null;
  /** `?fake=` — the canned session, which has no live world to enter. */
  readonly fake?: string | null;
}

/** Body class while the glue screens are the thing on the display; see `glue.css`. */
export const GLUE_FRONT_DOOR_CLASS = "glue-front-door";

export async function openGlueFrontDoor(
  elements: GlueFrontDoorElements,
  options: OpenGlueFrontDoorOptions = {},
): Promise<GlueHandle> {
  const origin = options.gatewayOrigin ?? defaultGatewayOrigin(window.location);
  /**
   * The connection the glue session is holding, as the concrete client.
   *
   * `GlueSession` only knows the four methods of `GlueWorldConnection`, and the world half of the
   * client needs the whole `WorldClient` — its state, its events, its movement. Rather than widen
   * the session's type (which exists so a node test can drive it with a three-line fake), the
   * connector remembers what it built. `session.connected` is what says whether this is still the
   * live one: the session closes and replaces connections on its own, and a reference alone cannot
   * tell a live socket from a closed one.
   */
  let live: WorldClient | undefined;
  let handle: GlueHandle | undefined;

  const front: FrontDoorHost = {
    enteringWorld(): void {
      // The glue screens go dormant before the world panel is shown, not after: the GL context, the
      // decoded backdrop models and the music are exactly what the world is about to want.
      handle?.suspend();
      document.body.classList.remove(GLUE_FRONT_DOOR_CLASS);
    },
    returnFromWorld(exit, message): void {
      const session = handle?.session;
      const plan = frontDoorReturn(exit, session?.selectedRealm !== undefined);
      // Dropped first, whatever happens next: the connection this reference names has either just
      // been finished with, died, or is about to be replaced by `connect`.
      live = undefined;
      document.body.classList.add(GLUE_FRONT_DOOR_CLASS);
      handle?.resume(plan.screen);
      if (plan.closeWorld) session?.closeWorld();
      else if (plan.reconnect && session?.selectedRealm) {
        // `connect` closes the previous connection, opens a new one and refreshes the list — which
        // is `GetCharacterListUpdate` semantics with the one thing added that a used connection
        // cannot give: a socket with a single reader. See `frontDoorReturn`.
        void session.connect(session.selectedRealm);
      }
      // After the screen, so the corpus' own status dialog is drawn over the screen it belongs to.
      if (message) handle?.runtime.api.fireEvent("OPEN_STATUS_DIALOG", "OKAY", message);
    },
  };

  handle = await startGlue({
    host: elements.host,
    stage: elements.stage,
    status: elements.status ?? null,
    gatewayOrigin: origin,
    screen: options.screen ?? null,
    fake: options.fake ?? null,
    connect: async (realm, auth) => {
      const stream = await WebSocketByteStream.connect(gatewaySocketUrl(origin, "/world"));
      try {
        const client = await WorldClient.connect(stream, {
          username: auth.username, sessionKey: auth.sessionKey, realmId: realm.id, realmName: realm.name,
        });
        // The account, for the half of the client that asks who is signed in. The DOM flow writes
        // this in its login form; on this road the answer is only known here.
        game.session = auth;
        live = client;
        return client;
      } catch (error) {
        stream.close();
        throw error;
      }
    },
    onEnterWorld: ({ character }) => {
      const world = live;
      if (!world || !handle?.session.connected) {
        // `?fake=charselect` lands here by design: a canned session has no socket behind it, and
        // saying so is better than a button that appears to do nothing.
        handle?.runtime.api.fireEvent("OPEN_STATUS_DIALOG", "OKAY",
          "Нет живого соединения с миром — войдите в игру заново.");
        return;
      }
      front.enteringWorld();
      // Exactly where `connectRealm` would have been: the same five lines, out of the same
      // function, so the two front doors cannot disagree about what a world session is.
      adoptWorld(world);
      void enterWorld(character);
    },
  });

  // Registered only once the screens are actually up. Until then `frontDoorHost()` answers
  // `undefined` and every exit keeps its DOM behaviour, which is what a failed glue load needs.
  useFrontDoor(front);
  // Published beside `glueDiagnostics` for the same reason it is: the two crossings are the part of
  // this slice a browser check has to drive, and the owner's auth/world servers are down. Driving
  // *these* two functions is driving the real ones — nothing else in the page calls anything else.
  Object.defineProperty(window, "glueFrontDoor", { configurable: true, value: front });
  document.body.classList.add(GLUE_FRONT_DOOR_CLASS);
  return handle;
}
