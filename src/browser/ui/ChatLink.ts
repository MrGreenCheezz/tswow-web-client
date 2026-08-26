/**
 * The markup the server writes into chat, and the markup this client writes back.
 *
 * Everything the world sends arrives with the original client's escapes in it — `|cff1eff00` for
 * a colour, `|Hitem:19019:…|h[Thunderfury]|h|r` for a link — and both chat render paths were
 * dropping the whole string into `textContent`. A player looting an item saw the escape codes and
 * not the name. Splitting it into segments is also what makes a link clickable: the id is in the
 * text, it was simply never read.
 *
 * Kept free of the DOM so it can be tested; the node building lives in `ChatDock.ts`.
 */

export type ChatSegmentKind = "text" | "colored" | "item" | "spell" | "quest" | "achievement" | "url";

export interface ChatSegment {
  readonly kind: ChatSegmentKind;
  /** What the player reads: for a link, the display name with its brackets removed. */
  readonly text: string;
  /** `aarrggbb` as the server wrote it, when it wrote one. */
  readonly color?: string | undefined;
  /** The item entry, spell, quest or achievement id. Zero for anything that is not a link. */
  readonly id: number;
  /**
   * The original substring, kept because shift-clicking a link pastes it back verbatim: rebuilding
   * it from the id would drop the enchant and the random property the sender had on the item.
   */
  readonly rawLink?: string | undefined;
}

/** Item quality to the colour the client writes in front of a link. */
/**
 * The colour a linked item is written in, by quality.
 *
 * Rare and epic are lightened from the client's own `0070dd` and `a335ee`: those two are the only
 * ones of the seven that fail against this interface's backgrounds — measured, 3.99:1 and 3.93:1 in
 * a tooltip and 2.66:1 and 2.63:1 in the chat where the brightest sky shows through — and a link is
 * text before it is a colour. Lightened along their own hue, so rare is still blue and epic purple.
 * The stylesheet carries the same pair for tooltips; the two have to agree.
 */
export const QUALITY_LINK_COLORS: readonly string[] = [
  "ff9d9d9d", "ffffffff", "ff1eff00", "ff3d9fff", "ffc07bff", "ffff8000", "ffe6cc80", "ffe6cc80",
];

/** The one colour the client uses for a spell link, whatever the spell is. */
export const SPELL_LINK_COLOR = "ff71d5ff";

const LINK_TYPES: ReadonlyArray<readonly [string, ChatSegmentKind]> = [
  ["item", "item"], ["spell", "spell"], ["quest", "quest"], ["achievement", "achievement"],
];

const COLOR_ESCAPE = /^\|c([0-9a-fA-F]{8})/;

/** A parsed link, and where in the source it ended. */
interface ParsedLink {
  readonly kind: ChatSegmentKind;
  readonly id: number;
  readonly text: string;
  readonly end: number;
}

/**
 * One `|H…|h[…]|h` starting at `at`, or undefined.
 *
 * The id runs to the first colon — and there may be no colon at all: the server writes
 * `|Hitem:3299|h[…]|h|r` for loot, with the eight trailing fields left off entirely.
 */
function readLink(text: string, at: number): ParsedLink | undefined {
  if (!text.startsWith("|H", at)) return undefined;
  const typeEnd = text.indexOf(":", at + 2);
  if (typeEnd < 0) return undefined;
  const type = text.slice(at + 2, typeEnd);
  const kind = LINK_TYPES.find(([name]) => name === type)?.[1];
  if (!kind) return undefined;

  let digits = typeEnd + 1;
  while (digits < text.length && text[digits] !== undefined && text[digits]! >= "0" && text[digits]! <= "9") digits++;
  if (digits === typeEnd + 1) return undefined;
  const id = Number(text.slice(typeEnd + 1, digits));

  const open = text.indexOf("|h[", digits);
  if (open < 0) return undefined;
  const close = text.indexOf("]|h", open + 3);
  if (close < 0) return undefined;

  let end = close + 3;
  // A trailing `|r` belongs to the link only when it sits right after the closing `]|h`; further
  // along it is closing some colour that opened before the link did.
  if (text.startsWith("|r", end)) end += 2;
  return { kind, id, text: text.slice(open + 3, close), end };
}

/** Everything between `|c` and its `|r`, with any escapes that survived inside it removed. */
function stripEscapes(text: string): string {
  return text.replace(/\|[Hh][^|]*/g, "").replace(/\|[cr]/g, "");
}

const URL_START = /^https?:\/\//;

/**
 * Chat text split into the pieces a renderer can build nodes from.
 *
 * Never throws and never drops characters: text the scan does not recognise comes back as a
 * `text` segment, so a malformed escape shows as itself rather than swallowing the line.
 */
export function parseChatMarkup(text: string): ChatSegment[] {
  const segments: ChatSegment[] = [];
  let plain = "";
  const flush = () => {
    if (plain) segments.push({ kind: "text", text: plain, id: 0 });
    plain = "";
  };

  let at = 0;
  while (at < text.length) {
    const character = text[at];
    if (character !== "|" && !(character === "h" && URL_START.test(text.slice(at)))) {
      plain += character;
      at++;
      continue;
    }

    if (character === "h") {
      const end = /\s/.exec(text.slice(at))?.index ?? text.length - at;
      flush();
      segments.push({ kind: "url", text: text.slice(at, at + end), id: 0 });
      at += end;
      continue;
    }

    const colored = COLOR_ESCAPE.exec(text.slice(at));
    if (colored) {
      const color = colored[1]!.toLowerCase();
      const bodyAt = at + colored[0].length;
      const link = readLink(text, bodyAt);
      if (link) {
        flush();
        segments.push({ kind: link.kind, text: link.text, color, id: link.id, rawLink: text.slice(at, link.end) });
        at = link.end;
        continue;
      }
      // A colour with no link: it runs to its own `|r`, or to the end of the line when the sender
      // forgot one.
      const reset = text.indexOf("|r", bodyAt);
      const bodyEnd = reset < 0 ? text.length : reset;
      flush();
      segments.push({ kind: "colored", text: stripEscapes(text.slice(bodyAt, bodyEnd)), color, id: 0 });
      at = reset < 0 ? text.length : reset + 2;
      continue;
    }

    const bare = readLink(text, at);
    if (bare) {
      flush();
      segments.push({ kind: bare.kind, text: bare.text, id: bare.id, rawLink: text.slice(at, bare.end) });
      at = bare.end;
      continue;
    }

    // A reset with nothing open is meaningless and is dropped. A link marker that did not parse
    // is kept as it was written: it means the sender sent something this build cannot read, and
    // quietly deleting half of it would turn a broken link into a broken sentence.
    if (text.startsWith("|r", at)) {
      at += 2;
      continue;
    }
    plain += character;
    at++;
  }
  flush();
  return segments;
}

/** The same text with every escape gone — what a speech bubble over a head shows. */
export function plainChatText(text: string): string {
  return parseChatMarkup(text).map((segment) => segment.text).join("");
}

/**
 * An item link in the form the server and every other client expect.
 *
 * Nine fields follow `item:` — entry, enchant, four gems, the random property, a unique id and a
 * level. Writing eight is the usual mistake and it silently shifts the random property into the
 * unique id slot, so the receiver's tooltip names a suffix the item does not have.
 */
export function itemChatLink(
  entry: number, quality: number, name: string, enchantId = 0, randomPropertyId = 0,
): string {
  const color = QUALITY_LINK_COLORS[quality] ?? QUALITY_LINK_COLORS[1]!;
  return `|c${color}|Hitem:${entry}:${enchantId}:0:0:0:0:${randomPropertyId}:0:0|h[${name}]|h|r`;
}

export function spellChatLink(spellId: number, name: string): string {
  return `|c${SPELL_LINK_COLOR}|Hspell:${spellId}|h[${name}]|h|r`;
}

/**
 * How many bytes the server will count for this message.
 *
 * `HandleMessagechatOpcode` drops anything over 255 **bytes** without a word of complaint, and the
 * input's `maxlength` counts characters. In a Russian interface that is a factor of two: a line the
 * player could type and see accepted simply never arrived.
 */
export function chatByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export const CHAT_MAX_BYTES = 255;

/** The longest prefix the server will accept, cut on a character rather than mid-sequence. */
export function truncateChat(text: string, limit = CHAT_MAX_BYTES): string {
  if (chatByteLength(text) <= limit) return text;
  let bytes = 0;
  let kept = "";
  for (const character of text) {
    const size = chatByteLength(character);
    if (bytes + size > limit) break;
    bytes += size;
    kept += character;
  }
  return kept;
}
