/**
 * The chat colours: `ChatTypeInfo[type].r/g/b`, which every stock chat line is drawn in.
 *
 * Stock ChatFrame.lua sets all of them to white at load (ChatFrame.lua:2269-2274) and never sets
 * them again itself: the client fills them from its chat cache with one `UPDATE_CHAT_COLOR(type, r,
 * g, b)` per type, which `ChatFrame_ConfigEventHandler` writes into ChatTypeInfo (ChatFrame.lua:
 * 2516-2533, WHISPER also colouring REPLY), and `ChangeChatColor` writes the cache and raises the
 * same event (the chat tab's colour menu, FloatingChatFrame.lua:880, :911). Nothing raised it here,
 * so every system line, whisper and party line was drawn white. The seam raises the whole table at
 * attach, before any line reaches the frames, and again after each change.
 *
 * The client's cache is per character. Overrides are kept per character scope for the page's life
 * (the live seam scopes them by realm and character GUID): the live `/reload` builds a new seam
 * (FrameXmlWorldMount's ReloadUI remount), and it raises them again, as the client re-reads its
 * cache; so does logging the same character in again. A seam with no scope (the canned one) keeps
 * them itself. Nothing is written between page sessions — the seam stores no other chat setting
 * either (`setChatWindowShown` is per attach) — so a new page session starts from the defaults.
 */

type ChatColorRow = readonly [type: string, red: number, green: number, blue: number];
type ChatColor = readonly [red: number, green: number, blue: number];

/** `UPDATE_CHAT_COLOR`, the event stock takes the colours from. */
export const FRAMEXML_CHAT_COLOR_EVENT = "UPDATE_CHAT_COLOR";

/**
 * The 3.3.5 client's default chat colours, as bytes and in the client's own order: the COLORS
 * section of `chat-cache.txt`. Measured: that section is byte-identical in all 20 caches the ruRU
 * 12340 client wrote on this machine (F:/Circle/WTF, 17 characters; F:/CircleClean/WTF, 3), every
 * row flagged `N` (no class-coloured names), so none of them was ever changed from the default.
 * WHISPER_FOREIGN, BATTLENET and ARENA_POINTS have no ChatTypeInfo row; stock ignores them.
 */
export const FRAMEXML_CHAT_DEFAULT_COLORS: readonly ChatColorRow[] =
  Object.freeze<readonly ChatColorRow[]>([
    ["SYSTEM", 255, 255, 0],
    ["SAY", 255, 255, 255],
    ["PARTY", 170, 170, 255],
    ["RAID", 255, 127, 0],
    ["GUILD", 64, 255, 64],
    ["OFFICER", 64, 192, 64],
    ["YELL", 255, 64, 64],
    ["WHISPER", 255, 128, 255],
    ["WHISPER_FOREIGN", 255, 128, 255],
    ["WHISPER_INFORM", 255, 128, 255],
    ["EMOTE", 255, 128, 64],
    ["TEXT_EMOTE", 255, 128, 64],
    ["MONSTER_SAY", 255, 255, 159],
    ["MONSTER_PARTY", 170, 170, 255],
    ["MONSTER_YELL", 255, 64, 64],
    ["MONSTER_WHISPER", 255, 181, 235],
    ["MONSTER_EMOTE", 255, 128, 64],
    ["CHANNEL", 255, 192, 192],
    ["CHANNEL_JOIN", 192, 128, 128],
    ["CHANNEL_LEAVE", 192, 128, 128],
    ["CHANNEL_LIST", 192, 128, 128],
    ["CHANNEL_NOTICE", 192, 192, 192],
    ["CHANNEL_NOTICE_USER", 192, 192, 192],
    ["AFK", 255, 128, 255],
    ["DND", 255, 128, 255],
    ["IGNORED", 255, 0, 0],
    ["SKILL", 85, 85, 255],
    ["LOOT", 0, 170, 0],
    ["MONEY", 255, 255, 0],
    ["OPENING", 128, 128, 255],
    ["TRADESKILLS", 255, 255, 255],
    ["PET_INFO", 128, 128, 255],
    ["COMBAT_MISC_INFO", 128, 128, 255],
    ["COMBAT_XP_GAIN", 111, 111, 255],
    ["COMBAT_HONOR_GAIN", 224, 202, 10],
    ["COMBAT_FACTION_CHANGE", 128, 128, 255],
    ["BG_SYSTEM_NEUTRAL", 255, 120, 10],
    ["BG_SYSTEM_ALLIANCE", 0, 174, 239],
    ["BG_SYSTEM_HORDE", 255, 0, 0],
    ["RAID_LEADER", 255, 72, 9],
    ["RAID_WARNING", 255, 72, 0],
    ["RAID_BOSS_EMOTE", 255, 221, 0],
    ["RAID_BOSS_WHISPER", 255, 221, 0],
    ["FILTERED", 255, 0, 0],
    ["BATTLEGROUND", 255, 127, 0],
    ["BATTLEGROUND_LEADER", 255, 219, 183],
    ["RESTRICTED", 255, 0, 0],
    ["BATTLENET", 255, 255, 255],
    ["ACHIEVEMENT", 255, 255, 0],
    ["GUILD_ACHIEVEMENT", 64, 255, 64],
    ["ARENA_POINTS", 255, 255, 255],
    ["PARTY_LEADER", 118, 200, 255],
    ["TARGETICONS", 255, 255, 0],
    ["BN_WHISPER", 0, 255, 246],
    ["BN_WHISPER_INFORM", 0, 255, 246],
    ["BN_CONVERSATION", 0, 177, 240],
    ["BN_CONVERSATION_NOTICE", 0, 177, 240],
    ["BN_CONVERSATION_LIST", 0, 177, 240],
    ["BN_INLINE_TOAST_ALERT", 130, 197, 255],
    ["BN_INLINE_TOAST_BROADCAST", 130, 197, 255],
    ["BN_INLINE_TOAST_BROADCAST_INFORM", 130, 197, 255],
    ["BN_INLINE_TOAST_CONVERSATION", 130, 197, 255],
    ["CHANNEL1", 255, 192, 192],
    ["CHANNEL2", 255, 192, 192],
    ["CHANNEL3", 255, 192, 192],
    ["CHANNEL4", 255, 192, 192],
    ["CHANNEL5", 255, 192, 192],
    ["CHANNEL6", 255, 192, 192],
    ["CHANNEL7", 255, 192, 192],
    ["CHANNEL8", 255, 192, 192],
    ["CHANNEL9", 255, 192, 192],
    ["CHANNEL10", 255, 192, 192],
  ]);

interface ChatColorPump {
  fire(event: string, ...args: readonly unknown[]): number;
}

/** A 0..1 channel as stock passes it (ColorPickerFrame:GetColorRGB), or undefined for a non-number. */
function channel(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

/** `ChangeChatColor` overrides by character scope, for the page's life (see the module doc). */
const SCOPED_OVERRIDES = new Map<string, Map<string, ChatColor>>();

/** The chat cache's colours for one seam: the defaults, and what `ChangeChatColor` changed. */
export class FrameXmlChatColors {
  readonly #scope: (() => string | undefined) | undefined;
  readonly #unscoped = new Map<string, ChatColor>();
  #pump: ChatColorPump | undefined;

  /** `scope` names the character whose cache this is; undefined (or no answer) keeps it per seam. */
  constructor(scope?: () => string | undefined) {
    this.#scope = scope;
  }

  get #overrides(): Map<string, ChatColor> {
    const key = this.#scope?.();
    if (key === undefined) return this.#unscoped;
    let overrides = SCOPED_OVERRIDES.get(key);
    if (!overrides) SCOPED_OVERRIDES.set(key, overrides = new Map());
    return overrides;
  }

  /** Raise every type's colour, as the client does when it reads its chat cache. */
  attach(pump: ChatColorPump): void {
    this.#pump = pump;
    const overrides = this.#overrides;
    for (const [type, red, green, blue] of FRAMEXML_CHAT_DEFAULT_COLORS) {
      const [r, g, b] = overrides.get(type) ?? [red / 255, green / 255, blue / 255];
      pump.fire(FRAMEXML_CHAT_COLOR_EVENT, type, r, g, b);
    }
  }

  detach(): void {
    this.#pump = undefined;
  }

  /** The colour a type is drawn in (0..1), or undefined for a type the chat cache has no row for. */
  color(type: string): ChatColor | undefined {
    const override = this.#overrides.get(type);
    if (override) return override;
    const row = FRAMEXML_CHAT_DEFAULT_COLORS.find(([name]) => name === type);
    return row ? [row[1] / 255, row[2] / 255, row[3] / 255] : undefined;
  }

  /**
   * `ChangeChatColor(type, r, g, b)`: a type the cache has a row for takes the colour and the event
   * is raised; anything else (an unknown type, a colour that is not three numbers) changes nothing.
   */
  change(type: unknown, red: unknown, green: unknown, blue: unknown): boolean {
    const name = typeof type === "string" ? type.toUpperCase() : "";
    const r = channel(red);
    const g = channel(green);
    const b = channel(blue);
    if (r === undefined || g === undefined || b === undefined
      || !FRAMEXML_CHAT_DEFAULT_COLORS.some(([row]) => row === name)) return false;
    this.#overrides.set(name, Object.freeze([r, g, b]));
    this.#pump?.fire(FRAMEXML_CHAT_COLOR_EVENT, name, r, g, b);
    return true;
  }
}

/** The part of the world seam the binding reads. */
export interface FrameXmlChatColorHost {
  readonly chatColors?: FrameXmlChatColors | undefined;
}

const NOTHING: readonly [] = Object.freeze([]);

export const FRAMEXML_CHAT_COLOR_BINDINGS: Readonly<Record<string,
  (host: FrameXmlChatColorHost, args: readonly unknown[]) => readonly unknown[]>> = Object.freeze({
  ChangeChatColor: (host, args) => {
    host.chatColors?.change(args[0], args[1], args[2], args[3]);
    return NOTHING;
  },
});
