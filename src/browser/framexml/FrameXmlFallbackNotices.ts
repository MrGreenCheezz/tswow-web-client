/**
 * A stock window that did not come up, told to the player (plan item 3.24).
 *
 * The world mount publishes each stock window behind a structural gate. A window whose gate refuses
 * does not open (WORK_PLAN 4.17: no HTML window stands in for it), so the player has to be told why:
 * one notice per kind of window per mount says it, once, and the list is kept for
 * `frameXmlWorld().fallbacks`.
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
  scoreboard: "Таблица боя", // 3.24 (12.10)
  battlemaster: "Распорядитель боя", // 3.24 (12.10)
  queueEye: "Очередь на поле боя", // 3.24 (12.10)
  help: "Помощь", // 3.24 (12.10)
  quest: "Журнал заданий",
  bags: "Сумки",
  spellbook: "Книга заклинаний",
  talent: "Таланты",
  pvp: "PvP",
  gameMenu: "Меню игры",
  merchant: "Торговец",
  macros: "Макросы",
  keybindings: "Назначение клавиш",
  calendar: "Календарь",
  options: "Настройки",
});

export function frameXmlFallbackText(kind: string, reason: string): string {
  const label = FRAMEXML_FALLBACK_LABELS[kind] ?? kind;
  return `Штатное окно «${label}» не собралось: ${reason}. Оно не откроется.`;
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
      warn(`[FrameXML ${kind}] ${reason}; the window will not open`);
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
