import { notice } from "./Notices.js";

/**
 * First-session hints: movement, targeting, bags, spellbook and where the commands live.
 *
 * Shown once ever (localStorage, beside the window layout), the first time a world is entered
 * in this browser — a veteran's alt sees them exactly once and never again. They ride the
 * notice overlay as `info` rather than opening windows: a new player is looking at the world,
 * not at a manual. If notices are switched off in settings, the hints stay silent with them.
 */

const STORAGE_KEY = "webclient.welcome-hints-seen";

export const WELCOME_HINTS = [
  "Движение: WASD + мышь. Камера — зажатая правая кнопка.",
  "Tab — ближайший противник, T — атака. Цельтесь и читайте фрейм слева.",
  "B — сумки, P — книга заклинаний, L — журнал, M — карта. /help — все команды чата.",
] as const;

interface WelcomeDeps {
  shown(): boolean;
  markShown(): void;
  say(text: string): void;
}

function storageDeps(): WelcomeDeps {
  const storage = (() => {
    try {
      return window.localStorage ?? undefined;
    } catch {
      return undefined;
    }
  })();
  return {
    shown: () => {
      try {
        return storage?.getItem(STORAGE_KEY) === "1";
      } catch {
        return true;
      }
    },
    markShown: () => {
      try {
        storage?.setItem(STORAGE_KEY, "1");
      } catch {
        // A blocked localStorage only costs the hints repeating, never the session.
      }
    },
    say: (text) => notice(text, "info"),
  };
}

/** Shows the hints once ever; injectable for tests. */
export function maybeShowWelcomeHints(deps: WelcomeDeps = storageDeps()): void {
  if (deps.shown()) return;
  deps.markShown();
  for (const hint of WELCOME_HINTS) deps.say(hint);
}
