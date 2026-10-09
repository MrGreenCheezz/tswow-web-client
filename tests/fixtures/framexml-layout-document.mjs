// P1-15: the inline-pixel DOM stub of tests/framexml-dirty-sync.test.mjs (`layoutDocument`) with
// what the layout budget needs on top of it:
// - every layout read is counted (`layoutReads`), and a read made after a write since the last read
//   is counted again as a forced layout (`forcedReads`) — what a browser would have to lay out for;
// - a text width model: a FontString with no width of its own (declared or spanned) is as wide as
//   `textContent.length × 7` and, with text, 14 high — so a new text moves what is measured from it;
// - `snapshot(host)`: tag, inline styles, text and attributes of every drawn element, for the
//   «auto» against «always» differential.

export const TEXT_ADVANCE = 7;
export const TEXT_LINE = 14;

export function layoutDocument() {
  const doc = {
    createElement: (tag) => make(tag),
    createElementNS: (_namespace, tag) => make(tag),
    getElementById: () => null,
    activeElement: null,
    layoutReads: 0,
    forcedReads: 0,
    dirty: false,
  };
  const pixels = (value) => {
    const match = /^(-?\d+(?:\.\d+)?)px$/.exec(String(value ?? ""));
    return match ? Number(match[1]) : undefined;
  };
  const hiddenUp = (node) => {
    for (let current = node; current; current = current.parentElement) if (current.hidden) return true;
    return false;
  };
  const read = () => {
    doc.layoutReads++;
    if (doc.dirty) {
      doc.forcedReads++;
      doc.dirty = false;
    }
  };
  const write = () => { doc.dirty = true; };
  function make(tag) {
    const attributes = new Map();
    const styleTarget = {
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) {
        delete this[name];
        delete this[name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())];
      },
    };
    const style = new Proxy(styleTarget, {
      set(target, key, value) {
        if (target[key] !== value) write();
        target[key] = value;
        return true;
      },
      deleteProperty(target, key) {
        if (key in target) write();
        delete target[key];
        return true;
      },
    });
    let text = "";
    let hidden = false;
    const node = {
      ownerDocument: doc, tagName: String(tag).toUpperCase(), children: [], parentElement: null,
      dataset: {}, className: "", container: false, style,
      get textContent() { return text; },
      set textContent(value) {
        const next = String(value ?? "");
        if (next !== text) write();
        text = next;
        if (node.children.length > 0) {
          for (const child of node.children) child.parentElement = null;
          node.children.length = 0;
        }
      },
      get hidden() { return hidden; },
      set hidden(value) {
        if (Boolean(value) !== hidden) write();
        hidden = Boolean(value);
      },
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      addEventListener() {},
      removeEventListener() {},
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      hasAttribute(name) { return attributes.has(name); },
      removeAttribute(name) { attributes.delete(name); },
      get attributeEntries() { return [...attributes.entries()]; },
      append(...children) {
        for (const child of children) {
          if (typeof child !== "object" || child === null) continue;
          child.remove();
          child.parentElement = node;
          node.children.push(child);
        }
        write();
      },
      appendChild(child) { node.append(child); return child; },
      insertBefore(child, before) {
        child.remove();
        child.parentElement = node;
        const index = node.children.indexOf(before);
        node.children.splice(index < 0 ? node.children.length : index, 0, child);
        write();
        return child;
      },
      remove() {
        const parent = node.parentElement;
        if (!parent) return;
        parent.children.splice(parent.children.indexOf(node), 1);
        node.parentElement = null;
        write();
      },
      get offsetParent() { read(); return node.container || hiddenUp(node) ? null : node.parentElement; },
      get offsetLeft() { read(); return hiddenUp(node) ? 0 : box(node, "left", "right", "width") ?? 0; },
      get offsetTop() { read(); return hiddenUp(node) ? 0 : box(node, "top", "bottom", "height") ?? 0; },
      get offsetWidth() { read(); return hiddenUp(node) ? 0 : size(node, "left", "right", "width") ?? 0; },
      get offsetHeight() { read(); return hiddenUp(node) ? 0 : size(node, "top", "bottom", "height") ?? 0; },
      getBoundingClientRect() {
        read();
        let left = 0;
        let top = 0;
        for (let current = node; current && !current.container; current = current.parentElement) {
          left += hiddenUp(current) ? 0 : box(current, "left", "right", "width") ?? 0;
          top += hiddenUp(current) ? 0 : box(current, "top", "bottom", "height") ?? 0;
        }
        const width = hiddenUp(node) ? 0 : size(node, "left", "right", "width") ?? 0;
        const height = hiddenUp(node) ? 0 : size(node, "top", "bottom", "height") ?? 0;
        return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
      },
    };
    return node;
  }
  function allText(node) {
    return node.textContent + node.children.map(allText).join("");
  }
  function length(value, base) {
    const text = String(value ?? "").trim();
    if (!text) return undefined;
    const direct = pixels(text);
    if (direct !== undefined) return direct;
    const percent = /^(-?\d+(?:\.\d+)?)%$/.exec(text);
    if (percent) return base === undefined ? undefined : Number(percent[1]) * base / 100;
    const calc = /^calc\((-?\d+(?:\.\d+)?)% ([+-]) (-?\d+(?:\.\d+)?)px\)$/.exec(text);
    if (calc && base !== undefined) return Number(calc[1]) * base / 100 + (calc[2] === "+" ? 1 : -1) * Number(calc[3]);
    return undefined;
  }
  function parentSize(node, axis) {
    const parent = node.parentElement;
    if (!parent) return undefined;
    const declared = pixels(parent.style[axis]);
    return declared ?? size(parent, axis === "width" ? "left" : "top", axis === "width" ? "right" : "bottom", axis);
  }
  function size(node, start, end, axis) {
    const declared = pixels(node.style[axis]);
    if (declared !== undefined) return declared;
    const base = parentSize(node, axis);
    const from = length(node.style[start], base);
    const to = length(node.style[end], base);
    if (from !== undefined && to !== undefined && base !== undefined) return base - from - to;
    if (node.getAttribute("data-framexml-type") === "FontString") {
      const text = allText(node);
      if (!text) return 0;
      return axis === "width" ? Math.max(...text.split("\n").map((line) => line.length)) * TEXT_ADVANCE
        : text.split("\n").length * TEXT_LINE;
    }
    return undefined;
  }
  function box(node, start, end, axis) {
    const base = parentSize(node, axis);
    const from = length(node.style[start], base);
    if (from !== undefined) return from;
    const to = length(node.style[end], base);
    const own = size(node, start, end, axis) ?? 0;
    return to !== undefined && base !== undefined ? base - to - own : undefined;
  }
  doc.head = make("head");
  doc.body = make("body");
  return doc;
}

/** A mounted host element for `layoutDocument`. */
export function layoutHost(doc, width, height) {
  const host = doc.createElement("section");
  host.container = true;
  Object.assign(host.style, { width: `${width}px`, height: `${height}px` });
  doc.dirty = false;
  return host;
}

/**
 * Every element under `host`, depth first: tag, inline styles, own text and attributes, sorted, so
 * two renderers that drew the same page give the same list. `id` is left out: the accessibility
 * layer numbers the ids it hands out per instance.
 */
export function snapshot(host) {
  const out = [];
  const visit = (node, path) => {
    const styles = Object.entries(node.style)
      .filter(([key, value]) => typeof value !== "function" && value !== undefined && value !== "")
      .map(([key, value]) => `${key}=${value}`).sort();
    const attributes = node.attributeEntries.filter(([key]) => key !== "id" && key !== "aria-labelledby")
      .map(([key, value]) => `${key}=${value}`).sort();
    out.push(`${path} ${node.tagName}${node.hidden ? " hidden" : ""} [${styles.join(";")}] {${attributes.join(";")}} "${node.textContent}"`);
    node.children.forEach((child, index) => visit(child, `${path}/${index}`));
  };
  visit(host, "");
  return out;
}
