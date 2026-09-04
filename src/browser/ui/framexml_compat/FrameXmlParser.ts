import {
  FRAME_XML_FONT_ELEMENT,
  FRAME_XML_WIDGET_TYPES,
  type FrameXmlElement,
  type FrameXmlParseResult,
  type FrameXmlResolvedTemplate,
  type FrameXmlTemplate,
} from "./FrameXmlTypes.js";

/**
 * Read one attribute, tolerating the case the author actually typed.
 *
 * Blizzard's own parser folds attribute names, and the corpus relies on it: the
 * server's `AccountLogin.xml` writes `relativeto=` three times and `Hidden=`
 * once, and those frames anchor and hide correctly in the real client. An
 * exact-match-only lookup would silently drop an anchor and leave a button
 * stacked at the origin, so the exact spelling wins and a case-folded match is
 * the documented fallback.
 */
export function frameXmlAttribute(
  element: FrameXmlElement,
  name: string,
): string | undefined {
  const exact = element.attributes[name];
  if (exact !== undefined) return exact;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(element.attributes)) {
    if (key.toLowerCase() === wanted) return element.attributes[key];
  }
  return undefined;
}

/** Numeric attribute with the same case tolerance; non-numeric spellings are dropped. */
export function frameXmlNumber(
  element: FrameXmlElement,
  name: string,
): number | undefined {
  const raw = frameXmlAttribute(element, name);
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** `1`/`true`/`yes` in any case, matching the schema's boolean lexical space. */
export function frameXmlBoolean(
  element: FrameXmlElement,
  name: string,
): boolean | undefined {
  const raw = frameXmlAttribute(element, name);
  if (raw === undefined) return undefined;
  return /^(?:1|true|yes)$/i.test(raw.trim());
}

/** First direct child with this element name (element names are not case-folded). */
export function frameXmlChild(
  element: FrameXmlElement,
  name: string,
): FrameXmlElement | undefined {
  return element.children.find((child) => child.name === name);
}

/**
 * Last direct child with this element name — the one an override declared.
 *
 * `mergeFrameXmlElements` keeps the base's children and appends the derived
 * ones, so for a singleton property element the *last* copy is the override.
 * `GlueFontHighlight inherits="GlueFontNormal"` restating `<Color>` is exactly
 * this case, and taking the first would paint the highlight font in the base
 * font's colour.
 */
export function frameXmlLastChild(
  element: FrameXmlElement,
  name: string,
): FrameXmlElement | undefined {
  for (let index = element.children.length - 1; index >= 0; index -= 1) {
    const child = element.children[index];
    if (child?.name === name) return child;
  }
  return undefined;
}

const XML_ENTITY = /^&(?:amp|lt|gt|quot|apos|#(?:x[0-9a-f]+|[0-9]+));$/i;
const KNOWN_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function isXmlCodePoint(code: number): boolean {
  return code === 0x9 || code === 0xa || code === 0xd
    || (code >= 0x20 && code <= 0xd7ff)
    || (code >= 0xe000 && code <= 0xfffd)
    || (code >= 0x10000 && code <= 0x10ffff);
}

function isSupportedEntity(entity: string): boolean {
  if (!XML_ENTITY.test(entity)) return false;
  const body = entity.slice(1, -1);
  if (KNOWN_ENTITIES[body.toLowerCase()] !== undefined) return true;
  const code = body.toLowerCase().startsWith("#x")
    ? Number.parseInt(body.slice(2), 16)
    : Number.parseInt(body.slice(1), 10);
  return Number.isFinite(code) && isXmlCodePoint(code);
}

function hasInvalidEntity(value: string): boolean {
  let offset = value.indexOf("&");
  while (offset >= 0) {
    const end = value.indexOf(";", offset + 1);
    if (end < 0 || !isSupportedEntity(value.slice(offset, end + 1))) return true;
    offset = value.indexOf("&", end + 1);
  }
  return false;
}

function decodeXml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#(?:x[0-9a-f]+|[0-9]+));/gi, (entity) => {
    const body = entity.slice(1, -1);
    const named = KNOWN_ENTITIES[body.toLowerCase()];
    if (named !== undefined) return named;
    if (body.toLowerCase().startsWith("#x")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && isXmlCodePoint(code)
        ? String.fromCodePoint(code)
        : entity;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && isXmlCodePoint(code)
        ? String.fromCodePoint(code)
        : entity;
    }
    return entity;
  });
}

function isNameStart(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z_]/.test(char);
}

function isNameChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_.:-]/.test(char);
}

function skipWhitespace(source: string, offset: number): number {
  while (offset < source.length && /\s/.test(source[offset] ?? "")) offset += 1;
  return offset;
}

function readName(source: string, offset: number): { readonly name: string; readonly next: number } | undefined {
  if (!isNameStart(source[offset])) return undefined;
  let next = offset + 1;
  while (isNameChar(source[next])) next += 1;
  return { name: source.slice(offset, next), next };
}

function findTagEnd(source: string, offset: number): number {
  let quote = "";
  for (let i = offset; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i;
    }
  }
  return -1;
}

function parseOpeningTag(raw: string): {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly selfClosing: boolean;
} | { readonly error: string } {
  let offset = 0;
  const first = readName(raw, offset);
  if (!first) return { error: "opening tag has no element name" };
  offset = first.next;
  const attributes: Record<string, string> = {};

  while (offset < raw.length) {
    offset = skipWhitespace(raw, offset);
    if (offset >= raw.length) break;
    if (raw[offset] === "/") {
      offset = skipWhitespace(raw, offset + 1);
      if (offset !== raw.length) return { error: `unexpected characters after <${first.name}/>` };
      return { name: first.name, attributes, selfClosing: true };
    }
    const attr = readName(raw, offset);
    if (!attr) return { error: `invalid attribute near "${raw.slice(offset)}"` };
    offset = skipWhitespace(raw, attr.next);
    if (raw[offset] !== "=") return { error: `attribute "${attr.name}" has no value` };
    offset = skipWhitespace(raw, offset + 1);
    const quote = raw[offset];
    if (quote !== '"' && quote !== "'") return { error: `attribute "${attr.name}" is not quoted` };
    const end = raw.indexOf(quote, offset + 1);
    if (end < 0) return { error: `attribute "${attr.name}" has no closing quote` };
    if (Object.prototype.hasOwnProperty.call(attributes, attr.name)) {
      return { error: `attribute "${attr.name}" is repeated` };
    }
    const value = raw.slice(offset + 1, end);
    if (hasInvalidEntity(value)) return { error: `attribute "${attr.name}" contains an unsupported XML entity` };
    attributes[attr.name] = decodeXml(value);
    offset = end + 1;
  }
  return { name: first.name, attributes, selfClosing: false };
}

interface MutableElement {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly children: MutableElement[];
  text: string;
}

function freezeElement(element: MutableElement): FrameXmlElement {
  return {
    name: element.name,
    attributes: Object.freeze({ ...element.attributes }),
    children: Object.freeze(element.children.map(freezeElement)),
    text: element.text,
  };
}

export interface FrameXmlParserOptions {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_DEPTH = 64;
const DEFAULT_MAX_NODES = 20_000;

function isVirtualAttribute(value: string | undefined): boolean {
  return value !== undefined && /^(?:1|true|yes)$/i.test(value.trim());
}

/**
 * Deterministic FrameXML parser. Browsers may use DOMParser, but keeping this
 * small parser as the canonical path makes server-side tests and malformed
 * addon isolation behave identically in Node and the browser.
 */
export function parseFrameXml(source: string, options: FrameXmlParserOptions = {}): FrameXmlParseResult {
  const diagnostics: string[] = [];
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  if (typeof source !== "string") return { ok: false, diagnostics: ["FrameXML source must be a string"] };
  const sourceBytes = new TextEncoder().encode(source).byteLength;
  if (sourceBytes > maxBytes) return { ok: false, diagnostics: [`FrameXML exceeds ${maxBytes} byte limit`] };

  const roots: MutableElement[] = [];
  const stack: MutableElement[] = [];
  let nodes = 0;
  let offset = source.charCodeAt(0) === 0xfeff ? 1 : 0;

  const addText = (text: string, decodeEntities = true): void => {
    if (decodeEntities && hasInvalidEntity(text)) {
      diagnostics.push("text contains an unsupported XML entity");
    }
    const decoded = decodeEntities ? decodeXml(text) : text;
    if (stack.length > 0) {
      const current = stack[stack.length - 1];
      if (current) current.text += decoded;
    } else if (decoded.trim()) {
      diagnostics.push("text exists outside the XML root");
    }
  };

  while (offset < source.length) {
    const open = source.indexOf("<", offset);
    if (open < 0) {
      addText(source.slice(offset));
      break;
    }
    if (open > offset) addText(source.slice(offset, open));

    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open + 4);
      if (end < 0) return { ok: false, diagnostics: [...diagnostics, "unterminated XML comment"] };
      offset = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", open)) {
      const end = source.indexOf("]]>", open + 9);
      if (end < 0) return { ok: false, diagnostics: [...diagnostics, "unterminated CDATA section"] };
      // CDATA is literal text; entity references inside it are not decoded.
      addText(source.slice(open + 9, end), false);
      offset = end + 3;
      continue;
    }
    // FrameXML does not need a DTD, and this bounded parser deliberately has
    // no entity resolver.  Rejecting DOCTYPE instead of silently skipping it
    // keeps the entity policy explicit and prevents a future adapter from
    // accidentally treating external/internal declarations as executable
    // input.  Processing instructions remain harmless metadata and are still
    // ignored below.
    if (source.slice(open + 2, open + 9).toUpperCase() === "DOCTYPE") {
      return { ok: false, diagnostics: [...diagnostics, "DOCTYPE declarations are not supported"] };
    }
    if (source.startsWith("<?", open)) {
      const end = source.indexOf("?>", open + 2);
      if (end < 0) return { ok: false, diagnostics: [...diagnostics, "unterminated XML processing instruction"] };
      offset = end + 2;
      continue;
    }
    if (source.startsWith("<!", open)) {
      return { ok: false, diagnostics: [...diagnostics, "XML declarations other than CDATA are not supported"] };
    }

    const close = source[open + 1] === "/";
    const end = findTagEnd(source, open + (close ? 2 : 1));
    if (end < 0) return { ok: false, diagnostics: [...diagnostics, "unterminated XML tag"] };
    if (close) {
      const closing = readName(source, open + 2);
      if (!closing || source.slice(closing.next, end).trim()) {
        return { ok: false, diagnostics: [...diagnostics, "invalid closing tag"] };
      }
      const current = stack.pop();
      if (!current || current.name !== closing.name) {
        return { ok: false, diagnostics: [...diagnostics, `closing tag </${closing.name}> does not match its parent`] };
      }
      offset = end + 1;
      continue;
    }

    const parsed = parseOpeningTag(source.slice(open + 1, end));
    if ("error" in parsed) return { ok: false, diagnostics: [...diagnostics, parsed.error] };
    nodes += 1;
    if (nodes > maxNodes) return { ok: false, diagnostics: [...diagnostics, `FrameXML exceeds ${maxNodes} element limit`] };
    if (stack.length >= maxDepth) return { ok: false, diagnostics: [...diagnostics, `FrameXML exceeds ${maxDepth} nesting limit`] };
    const element: MutableElement = { name: parsed.name, attributes: { ...parsed.attributes }, children: [], text: "" };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else roots.push(element);
    if (!parsed.selfClosing) stack.push(element);
    offset = end + 1;
  }

  if (stack.length > 0) return { ok: false, diagnostics: [...diagnostics, `unclosed <${stack[stack.length - 1]?.name}> element`] };
  if (roots.length !== 1) return { ok: false, diagnostics: [...diagnostics, "FrameXML must contain exactly one root element"] };
  return { ok: diagnostics.length === 0, root: freezeElement(roots[0]!), diagnostics };
}

function cloneElement(element: FrameXmlElement): FrameXmlElement {
  return {
    name: element.name,
    attributes: Object.freeze({ ...element.attributes }),
    children: Object.freeze(element.children.map(cloneElement)),
    text: element.text,
  };
}

export function mergeFrameXmlElements(base: FrameXmlElement, derived: FrameXmlElement): FrameXmlElement {
  // Inherits is a deterministic left-to-right cascade: later templates and
  // the concrete element override attributes, while child declarations retain
  // source order so layers/anchors remain predictable.
  return {
    name: derived.name,
    attributes: Object.freeze({ ...base.attributes, ...derived.attributes }),
    children: Object.freeze([
      ...base.children.map(cloneElement),
      ...derived.children.map(cloneElement),
    ]),
    text: derived.text || base.text,
  };
}

function inheritsOf(element: FrameXmlElement): readonly string[] {
  return (frameXmlAttribute(element, "inherits") ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

export interface RegisterFrameXmlResult {
  readonly ok: boolean;
  readonly templates: readonly FrameXmlTemplate[];
  readonly diagnostics: readonly string[];
}

/** A per-addon/template registry; no global `_G` or native HUD state is touched. */
export class FrameXmlTemplateRegistry {
  readonly #templates = new Map<string, FrameXmlTemplate>();

  registerTemplate(name: string, element: FrameXmlElement, source?: string): boolean {
    const key = name.trim();
    // `<Font>` joins the widget set here on purpose. A font object is declared
    // and inherited with exactly the same grammar as a widget template
    // (`GlueFontNormalLeft inherits="GlueFontNormal"`), so it resolves through
    // the same cascade instead of a parallel half-copy of it.
    if (!key || (!FRAME_XML_WIDGET_TYPES.has(element.name) && element.name !== FRAME_XML_FONT_ELEMENT)) {
      return false;
    }
    this.#templates.set(key, { name: key, element: cloneElement(element), ...(source === undefined ? {} : { source }) });
    return true;
  }

  registerDocument(source: string): RegisterFrameXmlResult {
    const parsed = parseFrameXml(source);
    if (!parsed.root || !parsed.ok) return { ok: false, templates: [], diagnostics: [...parsed.diagnostics] };
    const templates: FrameXmlTemplate[] = [];
    const walk = (element: FrameXmlElement): void => {
      const name = frameXmlAttribute(element, "name") ?? "";
      // A named `<Font>` is global whether or not it says virtual; the corpus
      // marks them virtual, but the object is what other files name later.
      const virtual = isVirtualAttribute(frameXmlAttribute(element, "virtual"))
        || element.name === FRAME_XML_FONT_ELEMENT;
      if (virtual && name && this.registerTemplate(name, element, source)) {
        const template = this.#templates.get(name);
        if (template) templates.push(template);
      }
      for (const child of element.children) walk(child);
    };
    walk(parsed.root);
    return { ok: parsed.ok, templates, diagnostics: [...parsed.diagnostics] };
  }

  /** Template names in registration order; used to report corpus coverage. */
  get names(): readonly string[] {
    return [...this.#templates.keys()];
  }

  get(name: string): FrameXmlTemplate | undefined {
    return this.#templates.get(name.trim());
  }

  resolve(inherits: string): FrameXmlResolvedTemplate {
    const names = inherits.split(",").map((name) => name.trim()).filter(Boolean);
    if (names.length === 0) return { ok: false, diagnostics: ["template name is empty"] };
    const diagnostics: string[] = [];
    const resolving: string[] = [];
    const resolveName = (name: string): FrameXmlElement | undefined => {
      const template = this.#templates.get(name);
      if (!template) {
        diagnostics.push(`template "${name}" is not registered`);
        return undefined;
      }
      const cycleAt = resolving.indexOf(name);
      if (cycleAt >= 0) {
        diagnostics.push(`template inheritance cycle: ${[...resolving.slice(cycleAt), name].join(" -> ")}`);
        return undefined;
      }
      resolving.push(name);
      let result: FrameXmlElement | undefined;
      for (const parentName of inheritsOf(template.element)) {
        const parent = resolveName(parentName);
        if (parent) result = result ? mergeFrameXmlElements(result, parent) : parent;
      }
      const own = { ...template.element, attributes: Object.fromEntries(
        Object.entries(template.element.attributes).filter(([key]) => key !== "inherits"),
      ) } as FrameXmlElement;
      result = result ? mergeFrameXmlElements(result, own) : own;
      resolving.pop();
      return result;
    };

    let result: FrameXmlElement | undefined;
    for (const name of names) {
      const template = resolveName(name);
      if (template) result = result ? mergeFrameXmlElements(result, template) : template;
    }
    return result && diagnostics.length === 0
      ? { ok: true, element: result, diagnostics: [] }
      : { ok: false, ...(result ? { element: result } : {}), diagnostics };
  }
}
