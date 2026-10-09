import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.27 (05.10-3.27b): `SetFormattedText` formats with Wow.exe's widget formatter
// 0x00818070, not with str_format. Its two callers are FontString:SetFormattedText 0x0048d800
// (registration 0x00ac11b0) and Button:SetFormattedText 0x009779b0 (0x00b2d488); both pass the format
// at stack index 2 and a 4096-byte buffer (notes .runtime/re-2026-10-05/l327b/g1.txt and
// .runtime/re-2026-09-30/a1-de-review/r8.c). Differences from string.format: one position digit
// (`%10$` is an invalid option), the item may be up to 125 characters with any number of width and
// precision digits, `%c` writes the raw byte (no width), no `%q`, no 100-byte `%s` path, `%s`
// converts a number argument in place, and the output stops at 4095 bytes (later items are never
// read). `%x` chops (FNSTCW | 0xC00 before FISTP at 0x0081823e), as str_format does.
// SetEuropeanNumbers (0x00510de0 → 0x00817da0 → 0x0084f010) sets the flag `%F` reads.
const { FrameXmlBoot } = await import("../dist/code/browser/framexml/FrameXmlBoot.js");
const { createFixtureProvider } = await import("../dist/code/browser/glue/GlueLoader.js");

const FIXTURE = String.raw`
local frame = CreateFrame("Frame", "ProbeFrame", UIParent)
local text = frame:CreateFontString("ProbeText")
text:SetText("old")
local button = CreateFrame("Button", "ProbeButton", UIParent)
button:SetText("old")
`;

const instance = new FrameXmlBoot({
  provider: createFixtureProvider({
    "interface/framexml/framexml.toc": "Probe.lua",
    "interface/framexml/probe.lua": FIXTURE,
  }),
  exercise: false,
});
await instance.load();
test.after(() => instance.close());

function run(source) {
  const result = instance.vm.execute(source, "@probe");
  assert.equal(result.ok, true, `${source}: ${result.error}`);
}

/** The FontString's text after `ProbeText:SetFormattedText(args)`. */
function shown(args) {
  run('ProbeText:SetText("old")');
  run(`ProbeText:SetFormattedText(${args})`);
  return instance.bridge.getFrame("ProbeText")?.text;
}

/** The error the formatter reports for `args`; the text stays "old". */
function refused(args) {
  run('ProbeText:SetText("old")');
  const before = instance.vm.errors.length;
  run(`ProbeText:SetFormattedText(${args})`);
  assert.equal(instance.bridge.getFrame("ProbeText")?.text, "old", `${args}: the text is kept`);
  const fresh = instance.vm.errors.slice(before);
  assert.equal(fresh.length, 1, `${args}: one error is reported`);
  return fresh[0];
}

function lua(source) {
  instance.vm.setGlobal("__r", undefined);
  run(`__r = ${source}`);
  return instance.vm.getGlobal("__r");
}

test("positions: one digit, counted from the format; `%10$` is an invalid option", () => {
  assert.equal(shown('"%2$s %1$s", "a", "b"'), "b a");
  assert.equal(shown('"%2$s %s", "a", "b", "c"'), "b c", "a plain item after %2$ takes the third");
  assert.equal(shown('"%0$s"'), "%0$s", "%0$ names the format itself");
  assert.match(refused('"%10$s", 1, 2, 3, 4, 5, 6, 7, 8, 9, "ten"'), /invalid option in `format'/);
  assert.equal(lua('format("%10$s", 1, 2, 3, 4, 5, 6, 7, 8, 9, "ten")'), "ten", "string.format keeps two digits");
});

test("the item may be 125 characters long; width and precision take any number of digits", () => {
  assert.equal(shown('"[%100s]", "x"'), `[${" ".repeat(99)}x]`);
  assert.equal(shown('"%.12f", 1'), "1.000000000000");
  assert.equal(shown(`"%${"-".repeat(125)}d", 5`), "5");
  assert.match(refused(`"%${"-".repeat(126)}d", 5`), /invalid format \(width or precision too long\)/);
  assert.match(refused('"%q", "a"'), /invalid option in `format'/, "no %q");
  assert.match(refused('"100%"'), /invalid option in `format'/, "a lone trailing %");
});

test("conversions: %c raw, %x chopped, %s up to its NUL, a number under %s converted in place", () => {
  assert.equal(shown('"[%5c]", 65'), "[A]", "%c ignores the width");
  assert.equal(lua('format("[%5c]", 65)'), "[    A]");
  assert.equal(shown('"a%cb", 0'), "a", "a zero byte ends the text");
  assert.equal(shown('"%.2x%.2X", 127.9, 255.5'), "7fFF");
  assert.equal(shown('"%d|%i", -7.9, 7.9'), "-7|7");
  assert.equal(shown('"%s|", string.rep("a", 120) .. "\\0b"'), `${"a".repeat(120)}|`, "no 100-byte path");
  assert.equal(shown('"%1$s %1$.16f", 1/3'), "0.33333333333333 0.3333333333333300");
  assert.equal(shown('"%s %5.1f%%", 3, 2.25'), "3   2.3%");
});

test("the output stops at 4095 bytes and later items are never read", () => {
  assert.equal(shown('"%s", string.rep("x", 5000)')?.length, 4095);
  assert.equal(shown('string.rep("z", 5000)')?.length, 4095, "a literal run stops there too");
  assert.equal(shown('string.rep("y", 4095) .. "%s", nil')?.length, 4095);
  assert.equal(shown('string.rep("y", 4094) .. "%s%s", "abc", nil'), "y".repeat(4094) + "a");
});

test("argument errors name SetFormattedText and keep the text", () => {
  assert.match(refused('"%d", nil'), /bad argument #2 to 'SetFormattedText' \(number expected, got nil\)/);
  assert.match(refused('"%d %d", 1'), /bad argument #3 to 'SetFormattedText' \(number expected, got no value\)/);
  assert.match(refused('"%s", {}'), /bad argument #2 to 'SetFormattedText' \(string expected, got table\)/);
});

test("Button:SetFormattedText formats the same way", () => {
  run('ProbeButton:SetFormattedText("[%5c] %10$s", 66)');
  // `%10$` raises: the button keeps "old".
  assert.equal(lua("ProbeButton:GetText()"), "old");
  run('ProbeButton:SetFormattedText("[%5c]", 66)');
  assert.equal(lua("ProbeButton:GetText()"), "[B]");
});

test("SetEuropeanNumbers sets the flag %F reads, in format and SetFormattedText alike", () => {
  try {
    assert.equal(lua('select("#", SetEuropeanNumbers(true))'), 0);
    assert.equal(shown('"%.2F|%.2f|%d", 1.5, 1.5, 3'), "1,50|1.50|3");
    assert.equal(lua('format("%.2F %.1f", 1234.5, 2.5)'), "1234,50 2.5");
    run("SetEuropeanNumbers(false)");
    assert.equal(shown('"%.2F", 1.5'), "1.50");
    run("SetEuropeanNumbers()");
    assert.equal(shown('"%.2F", 1.5'), "1,50", "no argument is the default: on");
    run("SetEuropeanNumbers(nil)");
    assert.equal(shown('"%.2F", 1.5'), "1.50");
    run('SetEuropeanNumbers("yes")');
    assert.equal(lua('format("%F", 0.5)'), "0,500000");
    run('SetEuropeanNumbers("0")');
    assert.equal(lua('format("%F", 0.5)'), "0.500000");
  } finally {
    run("SetEuropeanNumbers(false)");
  }
});
