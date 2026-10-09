import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.35 (03.10, L5): what expat — the parser behind SimpleHTML:SetText (XMLTree.cpp
// 0x00814d90: XML_ParserCreate(NULL), element and character-data handlers only) — makes of an XML
// declaration, processing instructions and a DOCTYPE. A page expat refuses is drawn as one plain
// paragraph, exactly as given.
const { parseFrameXmlSimpleHtml } = await import("../dist/code/browser/ui/framexml_compat/FrameXmlSimpleHtml.js");

const PAGE = "<HTML><BODY><P>a</P></BODY></HTML>";

function html(source) {
  const blocks = parseFrameXmlSimpleHtml(source);
  return blocks.length === 1 && blocks[0].kind === "text" && blocks[0].text === source ? "plain" : blocks.map((block) => block.text).join("|");
}

test("the XML declaration: only at the very start, well-formed, in an encoding expat knows", () => {
  assert.equal(html(`<?xml version="1.0"?>${PAGE}`), "a");
  assert.equal(html(`<?xml version='1.0' encoding="UTF-8" standalone="yes" ?>\n${PAGE}`), "a");
  assert.equal(html(`<?xml version="1.0" encoding="iso-8859-1"?>${PAGE}`), "a");
  assert.equal(html(`<?xml version="1.0" encoding="US-ASCII"?>${PAGE}`), "a");
  for (const source of [
    ` <?xml version="1.0"?>${PAGE}`, // not at the start: "XML or text declaration not at start of entity"
    `<!-- c --><?xml version="1.0"?>${PAGE}`,
    `<HTML><BODY><P>a<?xml version="1.0"?></P></BODY></HTML>`,
    `${PAGE}<?xml version="1.0"?>`,
    `<?xml?>${PAGE}`, // no version: "XML declaration not well-formed"
    `<?xml encoding="UTF-8" version="1.0"?>${PAGE}`,
    `<?xml version="1.0" standalone="maybe"?>${PAGE}`,
    `<?xml version="1 0"?>${PAGE}`,
    `<?xml version="1.0"encoding="UTF-8"?>${PAGE}`,
    `<?xml version="1.0" encoding="KOI8-R"?>${PAGE}`, // "unknown encoding": no handler is set
    `<?xml version="1.0" encoding="UTF-16"?>${PAGE}`, // "encoding specified in XML declaration is incorrect"
    `<?XML version="1.0"?>${PAGE}`, // a target spelt XML in another case is an invalid token
    `<?xml version="1.0" encoding="US-ASCII"?><HTML><BODY><P>щит</P></BODY></HTML>`, // a byte above 0x7f
    `<?xml version="1.0"${PAGE}`,
  ]) {
    assert.equal(html(source), "plain", source);
  }
});

test("processing instructions are passed over anywhere, unless their target is a reserved xml", () => {
  assert.equal(html(`<?game ui="1"?>${PAGE}<?end?>`), "a");
  assert.equal(html("<HTML><BODY><P>a<?php echo 1 ?>b</P><?x?></BODY></HTML>"), "ab");
  assert.equal(html(`<?xml-stylesheet href="a"?>${PAGE}`), "a");
  for (const source of [
    "<HTML><BODY><P>a<?Xml x?>b</P></BODY></HTML>",
    "<HTML><BODY><P>a<?1x?>b</P></BODY></HTML>", // the target must be a name
    "<HTML><BODY><P>a<?x\"y?>b</P></BODY></HTML>", // no space after the target
    `<?game${PAGE}`,
  ]) {
    assert.equal(html(source), "plain", source);
  }
});

test("a DOCTYPE: once, before the root, with an optional external id and a simple internal subset", () => {
  assert.equal(html(`<!DOCTYPE html>${PAGE}`), "a");
  assert.equal(html(`<?xml version="1.0"?>\n<!-- page -->\n<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">\n${PAGE}`), "a");
  assert.equal(html(`<!DOCTYPE html SYSTEM 'about:legacy-compat'>${PAGE}`), "a");
  assert.equal(html(`<!DOCTYPE html [ <!-- c --> <?pi x?> <!ELEMENT p ANY> <!NOTATION n SYSTEM "x"> ]>${PAGE}`), "a");
  for (const source of [
    `${PAGE}<!DOCTYPE html>`, // after the root: "junk after document element"
    `<!DOCTYPE html><!DOCTYPE html>${PAGE}`,
    `<!DOCTYPE html><?xml version="1.0"?>${PAGE}`,
    `<HTML><!DOCTYPE html><BODY><P>a</P></BODY></HTML>`,
    `<!DOCTYPE>${PAGE}`,
    `<!DOCTYPE html PUBLIC "a{b" "x">${PAGE}`, // "{" is no public id character
    `<!DOCTYPE html SYSTEM>${PAGE}`,
    `<!DOCTYPE html [ <!-- c -->${PAGE}`,
    `<!doctype html>${PAGE}`, // the keyword is case-sensitive
    "<HTML><BODY><P align=\"center\">a</P></BODY></HTML>", // XML's white space is space, tab, CR, LF only
    `<!DOCTYPE html>${PAGE}`,
  ]) {
    assert.equal(html(source), "plain", source);
  }
});

test("an entity the page does not declare: an error, unless an external DTD may declare it", () => {
  // Expat (doContent, XML_TOK_ENTITY_REF): with an external subset and no standalone="yes" an unknown
  // entity is skipped — nothing is drawn for it — instead of failing the page.
  assert.equal(html("<HTML><BODY><P>a&nbsp;b</P></BODY></HTML>"), "plain");
  assert.equal(html(`<!DOCTYPE html SYSTEM "x.dtd"><HTML><BODY><P>a&nbsp;b&amp;c</P></BODY></HTML>`), "ab&c");
  assert.equal(html(`<!DOCTYPE html PUBLIC "p" "x.dtd"><HTML><BODY><P align="x&y;z">a</P></BODY></HTML>`), "a");
  assert.equal(html(`<?xml version="1.0" standalone="yes"?><!DOCTYPE html SYSTEM "x.dtd"><HTML><BODY><P>a&nbsp;b</P></BODY></HTML>`), "plain");
  // Declarations of entities and attribute defaults are not modelled: such a page is left plain, where
  // expat would expand them [deviation, FrameXmlSimpleHtml.ts].
  assert.equal(html(`<!DOCTYPE html [ <!ENTITY nb "x"> ]><HTML><BODY><P>a&nb;b</P></BODY></HTML>`), "plain");
});
