/**
 * A stock window that did not come up, told to the player (plan item 3.24).
 *
 * The world mount publishes each stock window behind a structural gate and keeps the native window
 * when the gate refuses; the reason went only to the console, so a player saw the simplified native
 * window with no word why. One notice per kind of window per mount now says it, once — the native
 * window is still what opens — and the list is kept for `frameXmlWorld().fallbacks`.
 */

export interface FrameXmlFallbackRecord {
  readonly kind: string;
  readonly reason: string;
  /** `performance.now()`-style milliseconds. */
  readonly at: number;
}

/** The player's name of each window kind; an unknown kind is shown as it is. */
export const FRAMEXML_FALLBACK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  map: "Карта мира",
  character: "Персонаж",
  trainer: "Тренер",
  lfd: "Поиск подземелий",
  friends: "Друзья",
  popups: "Диалоги",
  loot: "Добыча",
  mail: "Почта",
  trade: "Обмен",
});

export function frameXmlFallbackText(kind: string, reason: string): string {
  const label = FRAMEXML_FALLBACK_LABELS[kind] ?? kind;
  return `Штатное окно «${label}» не собралось: ${reason}. Показано упрощённое.`;
}

export interface FrameXmlFallbackNoticesOptions {
  /** The player-facing line (ui/Notices.ts `notice`, kind "info"). */
  readonly notice: (text: string) => void;
  /** Defaults to console.warn. */
  readonly warn?: (text: string) => void;
  readonly now?: () => number;
}

export interface FrameXmlFallbackNotices {
  /** Records every fallback; tells the player only the first of each kind. */
  report(kind: string, reason: string): void;
  readonly records: readonly FrameXmlFallbackRecord[];
}

export function createFrameXmlFallbackNotices(options: FrameXmlFallbackNoticesOptions): FrameXmlFallbackNotices {
  const told = new Set<string>();
  const records: FrameXmlFallbackRecord[] = [];
  const warn = options.warn ?? ((text: string) => console.warn(text));
  const now = options.now ?? (() => (typeof performance === "object" ? performance.now() : Date.now()));
  return {
    report(kind, reason) {
      records.push(Object.freeze({ kind, reason, at: now() }));
      warn(`[FrameXML ${kind}] ${reason}; the native window stays`);
      if (told.has(kind)) return;
      told.add(kind);
      try {
        options.notice(frameXmlFallbackText(kind, reason));
      } catch { /* a notice strip that is not there must not break the mount */ }
    },
    get records() {
      return records;
    },
  };
}
