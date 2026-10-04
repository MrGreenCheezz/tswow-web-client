/**
 * SimpleHTML's content model, parsed the way Wow.exe 3.3.5a (12340) reads a `SetText` string
 * (WORK_PLAN 3.35; notes: .runtime/re-2026-10-03/l334):
 *
 * - `SetText` (0x0096d890) parses the string as XML. If it parses, its root is `<HTML>` and the root
 *   has a `<BODY>` child, the first BODY is drawn; otherwise — no markup, broken markup, another
 *   root, no BODY — the whole string is drawn as one left-aligned paragraph in the default font,
 *   exactly as given. The parser is expat (XMLTree.cpp, 0x00814d90; expat's error strings at
 *   0x00b2ec04), so "parses" means well-formed XML: an end tag spelt exactly as its start tag, only
 *   XML's five entities and character references to XML characters, every `&` starting one, no
 *   control characters, no `]]>` in text, no `--` inside a comment (review 03.10). Which element a
 *   name is — HTML, BODY, H1… — the client then asks case-insensitively.
 * - BODY's child elements are the blocks, top to bottom (0x0096d740): `<H1>`, `<H2>`, `<H3>` and
 *   `<P>` are text in the header or default font, `<BR/>` an empty line, `<IMG>` a picture; any other
 *   element is reported and skipped, and text directly inside BODY is not drawn.
 * - A text block (0x0096d170) is its element's text with `<BR/>` as `|n` and `<A href="…">text</A>`
 *   as the frame's `hyperlinkFormat` (default `|H%s|h%s|h`, filled with href then text; an A without
 *   both draws nothing); other child elements are skipped. Whitespace then collapses: leading
 *   whitespace and whitespace after a `|n` go, a run becomes one space, a space before `|n` and a
 *   trailing one go. `align` is LEFT (default), CENTER or RIGHT.
 * - An image (0x0096c9e0) takes `src`, `width`, `height` and `align`; one with an explicit LEFT or RIGHT is
 *   pinned to that side without moving the next block down, any other takes its height in the flow.
 *
 * The result is data — strings and numbers. Nothing here, nor in the renderer that draws it, hands
 * a string to the browser's HTML parser: the text becomes text nodes, so a server's or an add-on's
 * string can never become live markup.
 */

export type FrameXmlSimpleHtmlAlign = "LEFT" | "CENTER" | "RIGHT";

/** One block of a SimpleHTML page. `level` 0 is `<P>` (and the plain-text page), 1–3 `<H1>`–`<H3>`. */
export type FrameXmlSimpleHtmlBlock =
  | {
    readonly kind: "text";
    readonly level: 0 | 1 | 2 | 3;
    readonly align: FrameXmlSimpleHtmlAlign;
    /** Client text: `|n` line breaks, `|H…|h…|h` links and `|c` colours as in any FontString. */
    readonly text: string;
    /** A `<BR/>` directly inside BODY: an empty line. */
    readonly empty?: true;
  }
  | {
    readonly kind: "image";
    readonly src: string;
    readonly width: number;
    readonly height: number;
    readonly align: FrameXmlSimpleHtmlAlign;
    /** An explicit LEFT or RIGHT: pinned to that side, the next block is not moved down. */
    readonly floating: boolean;
  };

export const FRAME_XML_SIMPLE_HTML_LINK_FORMAT = "|H%s|h%s|h";

interface XmlElement {
  /** Lower-cased, for asking which element it is. */
  readonly name: string;
  /** As written, for matching its end tag. */
  readonly tag: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly parts: (string | XmlElement)[];
}

/** Elements nested deeper than this make the page plain text rather than a deep recursion. */
const MAX_DEPTH = 64;
const NAME = /[A-Za-z_:][\w.:-]*/y;
/** XML's white space: space, tab, CR, LF — nothing else (3.35, L5: `\s` took no-break spaces too). */
const SPACE = /[ \t\r\n]*/y;
/** Characters XML refuses anywhere in a document (expat: "not well-formed (invalid token)"). */
const NOT_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;
const REFERENCE = /&(?:(amp|lt|gt|quot|apos)|#([0-9]+)|#x([0-9a-fA-F]+)|([A-Za-z_:][\w.:-]*));/y;
const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
/** The encodings expat knows besides UTF-16, which an 8-bit string cannot be (XmlInitEncoding). */
const ENCODINGS: ReadonlySet<string> = new Set(["UTF-8", "ISO-8859-1", "US-ASCII"]);
/** A pseudo-attribute value of the XML declaration (expat parsePseudoAttribute). */
const DECLARATION_VALUE = /^[A-Za-z0-9._-]+$/;
/** PubidChar, but for the quote (checked apart). */
const PUBLIC_ID = /^[ \r\na-zA-Z0-9\-'()+,./:=?;!*#@$_%]*$/;

function xmlCharacter(code: number): boolean {
  return code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff)
    || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

const isSpace = (char: string | undefined): boolean => char === " " || char === "\t" || char === "\r" || char === "\n";

/**
 * Character data as expat hands it on: line ends as `\n`, XML's five entities and character
 * references decoded; in an attribute value a literal tab or line end is a space. Undefined when an
 * `&` starts no such reference or a reference names no XML character — expat's "undefined entity",
 * "not well-formed" and "reference to invalid character number", which leave the page plain text.
 * `skipUnknown`: a document with an external DTD subset and no standalone="yes", where expat skips
 * a reference to an entity nobody declared (doContent and appendAttributeValue) — nothing is drawn.
 */
function decodeCharacterData(raw: string, attribute: boolean, skipUnknown = false): string | undefined {
  const literal = (text: string): string => {
    const lines = text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
    return attribute ? lines.replace(/[\t\n]/g, " ") : lines;
  };
  if (!raw.includes("&")) return literal(raw);
  let out = "";
  let from = 0;
  for (let at = raw.indexOf("&"); at >= 0; at = raw.indexOf("&", from)) {
    REFERENCE.lastIndex = at;
    const match = REFERENCE.exec(raw);
    if (!match) return undefined;
    let value: string;
    if (match[1] !== undefined) {
      value = ENTITIES[match[1]]!;
    } else if (match[4] !== undefined) {
      if (!skipUnknown) return undefined;
      value = "";
    } else {
      const code = match[2] !== undefined ? Number.parseInt(match[2], 10) : Number.parseInt(match[3]!, 16);
      if (!xmlCharacter(code)) return undefined;
      value = String.fromCodePoint(code);
    }
    out += literal(raw.slice(from, at)) + value;
    from = REFERENCE.lastIndex;
  }
  return out + literal(raw.slice(from));
}

/** A comment's text: XML allows no `--` in it and no `-` at its end. */
function wellFormedComment(source: string, start: number, end: number): boolean {
  const text = source.slice(start + 4, end);
  return !text.includes("--") && !text.endsWith("-");
}

/**
 * A strict little XML reader: the root element, or undefined when the string is not one document
 * for expat. 3.35 (03.10, L5): the prolog as expat reads it — an XML declaration only as the very
 * first bytes (anywhere else "XML or text declaration not at start of entity"), with `version`, then
 * optionally `encoding` (one expat knows without a handler: UTF-8, ISO-8859-1, US-ASCII — the text
 * is not decoded again here) and `standalone` ("yes"/"no"); processing instructions passed over in
 * the prolog, the content and after the root, but none whose target is `xml` in any case; one
 * DOCTYPE before the root, with an external id (SYSTEM or PUBLIC) and an internal subset of
 * comments, processing instructions and element or notation declarations. Not modelled: an internal
 * subset that declares entities or attribute defaults (or refers to parameter entities) — expat would
 * expand them; such a page stays plain.
 */
function parseXml(source: string): { readonly root: XmlElement; readonly skipUnknown: boolean } | undefined {
  if (NOT_XML.test(source)) return undefined;
  let at = 0;
  const length = source.length;
  let skipUnknown = false;
  const skipSpace = (): boolean => {
    SPACE.lastIndex = at;
    SPACE.exec(source);
    const moved = SPACE.lastIndex > at;
    at = SPACE.lastIndex;
    return moved;
  };
  const readName = (): string | undefined => {
    NAME.lastIndex = at;
    const match = NAME.exec(source);
    if (!match) return undefined;
    at = NAME.lastIndex;
    return match[0];
  };
  const readQuoted = (): string | undefined => {
    const quote = source[at];
    if (quote !== "\"" && quote !== "'") return undefined;
    const end = source.indexOf(quote, at + 1);
    if (end < 0) return undefined;
    const value = source.slice(at + 1, end);
    at = end + 1;
    return value;
  };
  /** At `<?`: a processing instruction whose target is a name other than xml, passed over. */
  const skipInstruction = (): boolean => {
    at += 2;
    const target = readName();
    if (!target || target.toLowerCase() === "xml") return false;
    if (source.startsWith("?>", at)) {
      at += 2;
      return true;
    }
    if (!isSpace(source[at])) return false;
    const end = source.indexOf("?>", at);
    if (end < 0) return false;
    at = end + 2;
    return true;
  };
  const skipComment = (): boolean => {
    const end = source.indexOf("-->", at + 4);
    if (end < 0 || !wellFormedComment(source, at, end)) return false;
    at = end + 3;
    return true;
  };
  /** The XML declaration at offset 0; whether it is well-formed and `standalone="yes"`. */
  const readDeclaration = (): { standalone: boolean } | undefined => {
    at = 5;
    const values = new Map<string, string>();
    const order = ["version", "encoding", "standalone"];
    let next = 0;
    for (;;) {
      const spaced = skipSpace();
      if (source.startsWith("?>", at)) {
        at += 2;
        break;
      }
      if (!spaced) return undefined;
      const name = readName();
      const index = name === undefined ? -1 : order.indexOf(name, next);
      if (index < 0 || (next === 0 && index !== 0)) return undefined;
      next = index + 1;
      skipSpace();
      if (source[at] !== "=") return undefined;
      at += 1;
      skipSpace();
      const value = readQuoted();
      if (value === undefined || !DECLARATION_VALUE.test(value)) return undefined;
      values.set(name!, value);
    }
    if (!values.has("version")) return undefined;
    const encoding = values.get("encoding");
    if (encoding !== undefined) {
      const known = encoding.toUpperCase();
      if (!/^[A-Za-z]/.test(encoding) || !ENCODINGS.has(known)) return undefined;
      // Every byte above 0x7f is an invalid token in US-ASCII.
      if (known === "US-ASCII" && /[^\u0000-\u007f]/.test(source)) return undefined;
    }
    const standalone = values.get("standalone");
    if (standalone !== undefined && standalone !== "yes" && standalone !== "no") return undefined;
    return { standalone: standalone === "yes" };
  };
  /** At `<!DOCTYPE`: the declaration; whether it names an external subset. */
  const readDoctype = (): { external: boolean } | undefined => {
    at += 9;
    if (!skipSpace() || !readName()) return undefined;
    let spaced = skipSpace();
    let external = false;
    if (spaced && (source.startsWith("SYSTEM", at) || source.startsWith("PUBLIC", at))) {
      const publicId = source.startsWith("PUBLIC", at);
      at += 6;
      if (!skipSpace()) return undefined;
      if (publicId) {
        const quote = source[at];
        const id = readQuoted();
        if (id === undefined || !PUBLIC_ID.test(id) || (quote === "'" && id.includes("'"))) return undefined;
        if (!skipSpace()) return undefined;
      }
      if (readQuoted() === undefined) return undefined;
      external = true;
      spaced = skipSpace();
    }
    if (source[at] === "[") {
      at += 1;
      for (;;) {
        skipSpace();
        if (source[at] === "]") {
          at += 1;
          break;
        }
        if (source.startsWith("<!--", at)) {
          if (!skipComment()) return undefined;
        } else if (source.startsWith("<?", at)) {
          if (!skipInstruction()) return undefined;
        } else if (source.startsWith("<!ELEMENT", at) || source.startsWith("<!NOTATION", at)) {
          // Passed over to its end, quoted parts whole; expat's checks of a content model are not repeated.
          at += 2;
          for (;;) {
            const char = source[at];
            if (char === undefined || char === "<") return undefined;
            if (char === ">") {
              at += 1;
              break;
            }
            if (char === "\"" || char === "'") {
              if (readQuoted() === undefined) return undefined;
              continue;
            }
            at += 1;
          }
        } else {
          return undefined;
        }
      }
      skipSpace();
    }
    if (source[at] !== ">") return undefined;
    at += 1;
    return { external };
  };
  /** At a `<` that opens an element: its tag, and whether it closed itself. */
  const readOpenTag = (): { element: XmlElement; closed: boolean } | undefined => {
    at += 1;
    const name = readName();
    if (!name) return undefined;
    const attributes = new Map<string, string>();
    const written = new Set<string>();
    for (;;) {
      const before = at;
      skipSpace();
      if (source.startsWith("/>", at)) {
        at += 2;
        return { element: { name: name.toLowerCase(), tag: name, attributes, parts: [] }, closed: true };
      }
      if (source[at] === ">") {
        at += 1;
        return { element: { name: name.toLowerCase(), tag: name, attributes, parts: [] }, closed: false };
      }
      if (at === before) return undefined;
      const attribute = readName();
      if (!attribute) return undefined;
      skipSpace();
      if (source[at] !== "=") return undefined;
      at += 1;
      skipSpace();
      const raw = readQuoted();
      if (raw === undefined || raw.includes("<")) return undefined;
      // Expat refuses an attribute written twice; names differing in case are two attributes, and
      // the first is the one a case-blind lookup finds.
      if (written.has(attribute)) return undefined;
      written.add(attribute);
      const value = decodeCharacterData(raw, true, skipUnknown);
      if (value === undefined) return undefined;
      const key = attribute.toLowerCase();
      if (!attributes.has(key)) attributes.set(key, value);
    }
  };

  let standalone = false;
  if (source.startsWith("<?xml") && (isSpace(source[5]) || source.startsWith("?>", 5))) {
    const declaration = readDeclaration();
    if (!declaration) return undefined;
    standalone = declaration.standalone;
  }
  // The prolog: comments, processing instructions and at most one DOCTYPE, before the root.
  let doctype = false;
  for (;;) {
    skipSpace();
    if (source.startsWith("<!--", at)) {
      if (!skipComment()) return undefined;
    } else if (source.startsWith("<?", at)) {
      if (!skipInstruction()) return undefined;
    } else if (source.startsWith("<!DOCTYPE", at)) {
      if (doctype) return undefined;
      const declared = readDoctype();
      if (!declared) return undefined;
      doctype = true;
      skipUnknown = declared.external && !standalone;
    } else break;
  }
  if (source[at] !== "<") return undefined;
  const first = readOpenTag();
  if (!first) return undefined;
  const root = first.element;
  const stack: XmlElement[] = first.closed ? [] : [root];
  while (stack.length > 0) {
    const open = stack[stack.length - 1]!;
    const next = source.indexOf("<", at);
    if (next < 0) return undefined;
    if (next > at) {
      const raw = source.slice(at, next);
      if (raw.includes("]]>")) return undefined;
      const text = decodeCharacterData(raw, false, skipUnknown);
      if (text === undefined) return undefined;
      open.parts.push(text);
    }
    at = next;
    if (source.startsWith("</", at)) {
      at += 2;
      const name = readName();
      skipSpace();
      if (!name || name !== open.tag || source[at] !== ">") return undefined;
      at += 1;
      stack.pop();
    } else if (source.startsWith("<!--", at)) {
      if (!skipComment()) return undefined;
    } else if (source.startsWith("<![CDATA[", at)) {
      const end = source.indexOf("]]>", at + 9);
      if (end < 0) return undefined;
      open.parts.push(source.slice(at + 9, end));
      at = end + 3;
    } else if (source.startsWith("<?", at)) {
      if (!skipInstruction()) return undefined;
    } else {
      const tag = readOpenTag();
      if (!tag) return undefined;
      open.parts.push(tag.element);
      if (!tag.closed) {
        if (stack.length >= MAX_DEPTH) return undefined;
        stack.push(tag.element);
      }
    }
  }
  // After the root: white space, comments and processing instructions only ("junk after document element").
  for (;;) {
    skipSpace();
    if (source.startsWith("<!--", at)) {
      if (!skipComment()) return undefined;
    } else if (source.startsWith("<?", at)) {
      if (!skipInstruction()) return undefined;
    } else break;
  }
  return at === length ? { root, skipUnknown } : undefined;
}

function alignOf(element: XmlElement): FrameXmlSimpleHtmlAlign {
  const value = element.attributes.get("align")?.trim().toUpperCase();
  return value === "CENTER" || value === "RIGHT" ? value : "LEFT";
}

/** `hyperlinkFormat` filled the way the client's sprintf fills it: href, then the link's text. */
export function frameXmlSimpleHtmlLink(format: string, href: string, text: string): string {
  const values = [href, text];
  let next = 0;
  return format.replace(/%([%s])/g, (_match, spec: string) => (spec === "%" ? "%" : values[next++] ?? ""));
}

/** The client's whitespace pass over a text block (0x0096d170). */
function collapse(text: string): string {
  let out = "";
  let lineStart = true;
  let spaced = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      if (!lineStart && !spaced) {
        spaced = true;
        out += " ";
      }
      continue;
    }
    if (char === "|" && text[index + 1] === "n") {
      if (spaced) out = out.slice(0, -1);
      out += "|n";
      index += 1;
      spaced = false;
      lineStart = true;
      continue;
    }
    lineStart = false;
    spaced = false;
    out += char;
  }
  return spaced ? out.slice(0, -1) : out;
}

function ownText(element: XmlElement): string {
  let text = "";
  for (const part of element.parts) if (typeof part === "string") text += part;
  return text;
}

function blockText(element: XmlElement, linkFormat: string): string {
  let text = "";
  for (const part of element.parts) {
    if (typeof part === "string") {
      text += part;
    } else if (part.name === "br") {
      text += "|n";
    } else if (part.name === "a") {
      const href = part.attributes.get("href") ?? "";
      const label = ownText(part);
      if (href && label) text += frameXmlSimpleHtmlLink(linkFormat, href, label);
    }
  }
  return collapse(text);
}

function size(value: string | undefined): number {
  const number = value === undefined ? Number.NaN : Number.parseFloat(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** Whether `SetText(text)` draws HTML blocks (true) or the string as one plain paragraph. */
export function parseFrameXmlSimpleHtml(
  text: string,
  linkFormat: string = FRAME_XML_SIMPLE_HTML_LINK_FORMAT,
): readonly FrameXmlSimpleHtmlBlock[] {
  const plain: readonly FrameXmlSimpleHtmlBlock[] = [{ kind: "text", level: 0, align: "LEFT", text }];
  if (!text.includes("<")) return plain;
  const root = parseXml(text)?.root;
  if (!root || root.name !== "html") return plain;
  const body = root.parts.find((part): part is XmlElement => typeof part !== "string" && part.name === "body");
  if (!body) return plain;
  const blocks: FrameXmlSimpleHtmlBlock[] = [];
  for (const part of body.parts) {
    if (typeof part === "string") continue;
    switch (part.name) {
      case "h1":
      case "h2":
      case "h3":
      case "p":
        blocks.push({
          kind: "text",
          level: part.name === "p" ? 0 : (Number(part.name[1]) as 1 | 2 | 3),
          align: alignOf(part),
          text: blockText(part, linkFormat),
        });
        break;
      case "br":
        blocks.push({ kind: "text", level: 0, align: "LEFT", text: "", empty: true });
        break;
      case "img":
        blocks.push({
          kind: "image",
          src: part.attributes.get("src") ?? "",
          width: size(part.attributes.get("width")),
          height: size(part.attributes.get("height")),
          align: alignOf(part),
          floating: /^(?:left|right)$/i.test(part.attributes.get("align")?.trim() ?? ""),
        });
        break;
      default:
        break;
    }
  }
  return blocks;
}
