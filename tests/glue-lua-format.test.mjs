import assert from "node:assert/strict";
import test from "node:test";

// Plan item 3.27 (05.10): `string.format` as Wow.exe 3.3.5a (12340) has it — str_format 0x00853c50
// (registration `format` 0x00a47900; notes .runtime/re-2026-10-05/l327/f1.c, f2.txt and
// .runtime/re-2026-10-04/l5b/h1.c). The client's own variant of 5.1's: `%N$`/`%NN$` positions that
// also move the running argument counter; each item scanned with the pattern
// "[-+ #0]*(%d*)%.?(%d*)" (more than two width or precision digits, or more than 16 characters, is
// «invalid format (width or precision too long)»); any other conversion — `%a`, a lone trailing
// `%` — is «invalid option in `format'»; `%s` is luaL_checklstring (nil and booleans raise, a
// number prints as tostring does) and a string of 100 bytes or more without precision digits goes
// in whole; `%F` is `%f` with the decimal comma of SetEuropeanNumbers; the MSVC printf it links
// writes three exponent digits and 1.#INF, and rounds 17 digits first.
const { GlueLuaVm } = await import("../dist/code/browser/glue/GlueLua.js");
const { setLuaFormatEuropeanNumbers } = await import("../dist/code/browser/glue/GlueLuaFormat.js");

function withVm(body) {
  const vm = new GlueLuaVm();
  try {
    body(vm);
  } finally {
    vm.close();
  }
}

/** `format(args)` through `format`, `string.format` and the method form; all three must agree. */
function formatted(vm, args) {
  const answers = [];
  for (const call of [`format(${args})`, `string.format(${args})`]) {
    vm.setGlobal("__r", undefined);
    const result = vm.execute(`__r = ${call}`, "@format");
    assert.equal(result.ok, true, `${call}: ${result.error}`);
    answers.push(vm.getGlobal("__r"));
  }
  assert.equal(answers[1], answers[0], `format(${args}): string.format differs`);
  return answers[0];
}

/** The error `format(args)` raises, without a "chunk:line:" prefix ("ok" when it does not raise). */
function failure(vm, args) {
  vm.setGlobal("__r", undefined);
  // Called by name, as the corpus calls it: under pcall(format, …) the function has no name.
  const result = vm.execute(`local ok, message = pcall(function() return format(${args}) end) __r = ok and "ok" or tostring(message)`, "@format");
  assert.equal(result.ok, true, result.error);
  return String(vm.getGlobal("__r")).replace(/^[^:]*:\d+: /, "");
}

test("positional arguments: one or two digits, and the running counter continues after them", () => {
  withVm((vm) => {
    const cases = [
      // GlobalStrings.lua (ruRU): CHARACTER_SELECT_INFO and ACTION_SPELL_LEECH_RESULT's %10$s.
      ['"%2$s %1$d-го уровня", 7.9, "Воин"', "Воин 7-го уровня"],
      ['"%10$s|%1$s", 1, 2, 3, 4, 5, 6, 7, 8, 9, "ten"', "ten|1"],
      ['"%1$s and %1$s", "x"', "x and x"],
      ['"%2$s %s", "a", "b", "c"', "b c"],
      ['"%s %3$d %s", "a", "b", 4.5, "d"', "a 4 d"],
      ['"%1$5d|%2$-3s|", 42, "r"', "   42|r  |"],
      ['"%10d|%05d", 5, -3', "         5|-0003"],
      // %0$ names the format string itself (argument index 1).
      ['"%0$s"', "%0$s"],
    ];
    for (const [args, expected] of cases) assert.equal(formatted(vm, args), expected, `format(${args})`);
  });
});

test("%s takes strings and numbers only; numbers print as tostring; NULs and long strings as the client", () => {
  withVm((vm) => {
    assert.equal(failure(vm, '"%s", nil'), "bad argument #2 to 'format' (string expected, got nil)");
    assert.equal(failure(vm, '"%s", true'), "bad argument #2 to 'format' (string expected, got boolean)");
    assert.equal(failure(vm, '"%s %s", "only"'), "bad argument #3 to 'format' (string expected, got no value)");
    assert.equal(failure(vm, '"%2$s", "a", {}'), "bad argument #3 to 'format' (string expected, got table)");
    const cases = [
      ['"%s", 3.0', "3"], ['"%s", 6 / 2', "3"], ['"%s", 0.1', "0.1"], ['"%s", 1e15', "1e+015"], ['"%s", 2^31', "2147483648"],
      ['"%s|%s", -0.5, 1/0', "-0.5|1.#INF"],
      ['"%.3s|%10s|%-4s|", "abcdef", "r", "ab"', "abc|         r|ab  |"], ['"[%05s]", "ab"', "[000ab]"], ['"[%.s]", "ab"', "[]"],
      // Shorter than 100 bytes: sprintf's %s, which stops at the first NUL.
      ['"[%s]", "a\\0b"', "[a]"],
    ];
    for (const [args, expected] of cases) assert.equal(formatted(vm, args), expected, `format(${args})`);
    // 100 bytes or more, no precision digits: the value goes in whole, NULs included, width ignored.
    assert.equal(formatted(vm, '"%s", string.rep("x", 100) .. "\\0y"'), `${"x".repeat(100)}\0y`);
    assert.equal(formatted(vm, '"%-99s|", string.rep("x", 100)'), `${"x".repeat(100)}|`);
    assert.equal(formatted(vm, '"%.99s|", string.rep("x", 100) .. "\\0y"'), `${"x".repeat(99)}|`);
    assert.equal(formatted(vm, '"%.0s|", string.rep("x", 100)'), "|");
    // A point without digits is no precision digit: the long value still goes in whole.
    assert.equal(formatted(vm, '"%.s|", string.rep("x", 100)'), `${"x".repeat(100)}|`);
    // Exactly 100 bytes is long; 99 is sprintf's.
    assert.equal(formatted(vm, '"%s|", string.rep("x", 50) .. string.char(0) .. string.rep("y", 49)'), `${"x".repeat(50)}${String.fromCharCode(0)}${"y".repeat(49)}|`);
    assert.equal(formatted(vm, '"%s|", string.rep("x", 50) .. string.char(0) .. string.rep("y", 48)'), `${"x".repeat(50)}|`);
    // A number format string is read as its tostring text.
    assert.equal(formatted(vm, "12"), "12");
    assert.equal(formatted(vm, "1.5"), "1.5");
  });
});

test("the item scanner and the conversion switch raise as the client's", () => {
  withVm((vm) => {
    const option = "invalid option in `format'";
    const tooLong = "invalid format (width or precision too long)";
    assert.equal(failure(vm, '"100%"'), option);
    assert.equal(failure(vm, '"%y", 1'), option);
    assert.equal(failure(vm, '"%a", 1'), option);
    assert.equal(failure(vm, '"%1$"'), option);
    assert.equal(failure(vm, '"%123d", 1'), tooLong);
    assert.equal(failure(vm, '"%.123f", 1'), tooLong);
    assert.equal(failure(vm, '"%-+ #0-+ #0-+ #0-+5d", 1'), tooLong);
    // Sixteen characters between '%' (or its position) and the conversion pass, seventeen do not.
    assert.equal(formatted(vm, '"%-+ #0-+ #0-+ 12.d|", 5'), "+5          |");
    assert.equal(formatted(vm, '"%1$-+ #0-+ #0-+ 12.d|", 5'), "+5          |");
    assert.equal(failure(vm, '"%-+ #0-+ #0-+ 12.3d", 5'), tooLong);
    // Repeated flags are no error here (5.1 said «repeated flags»): only the 16-character limit.
    assert.equal(formatted(vm, '"%--5d|", 1'), "1    |");
    assert.equal(formatted(vm, '"%%|%d%%", 9.9'), "%|9%");
    assert.equal(formatted(vm, '"%%"'), "%");
    assert.equal(failure(vm, '"%d", "x"'), "bad argument #2 to 'format' (number expected, got string)");
    assert.equal(failure(vm, '"%f"'), "bad argument #2 to 'format' (number expected, got no value)");
    assert.equal(failure(vm, "nil"), "bad argument #1 to 'format' (string expected, got nil)");
    assert.equal(formatted(vm, '"%d %x", "12", "0x10"'), "12 10");
  });
});

test("%q quotes as 5.1's addquoted", () => {
  withVm((vm) => {
    assert.equal(formatted(vm, '"%q", "a\\nb\\"c\\\\\\r\\0z"'), '"a\\\nb\\"c\\\\\\r\\000z"');
    assert.equal(formatted(vm, '"%5q", 12'), '"12"');
  });
});

test("floating conversions print as the client's MSVC printf", () => {
  withVm((vm) => {
    const cases = [
      ['"%f", 1.5', "1.500000"], ['"%.2f", 2.675', "2.67"], ['"%.2f", 1.005', "1.00"], ['"%.2f", 0.125', "0.13"],
      ['"%.1f", 2.25', "2.3"], ['"%5.1f|%-6.2f|%+.1f|% .1f", 2.25, 3, 4, 5', "  2.3|3.00  |+4.0| 5.0"],
      ['"%.0f|%#.0f", 2.5, 3', "3|3."], ['"%.1f", -0.04', "-0.0"], ['"%06.2f", -1.5', "-01.50"],
      ['"%.3f", 1234567.0005', "1234567.001"] /* 1234567.00049999996… → 17 digits …0005000000 */, ['"%.2f", 2^40 + 0.25', "1099511627776.25"],
      // Seventeen digits first, then the precision: 100000000000000.046875 → …0.05 → 0.1.
      ['"%.1f", 1e14 + 0.046875', "100000000000000.1"],
      ['"%.20f", 0.1', "0.10000000000000001000"], ['"%.10f|%.10f", 6e-11, 4e-11', "0.0000000001|0.0000000000"],
      ['"%e", 12345.678', "1.234568e+004"], ['"%.2E", -0.000123', "-1.23E-004"], ['"%.0e", 5', "5e+000"],
      ['"%e", 0', "0.000000e+000"],
      ['"%g", 100000', "100000"], ['"%g", 1e6', "1e+006"], ['"%g", 0.0001', "0.0001"], ['"%g", 0.00001', "1e-005"],
      ['"%.3g", 1234', "1.23e+003"], ['"%.3g", 1.5', "1.5"], ['"%.3g", 99.95', "100"], ['"%#g", 1.5', "1.50000"],
      ['"%G", 1e-10', "1E-010"], ['"%g", 0', "0"], ['"%.0g", 25', "3e+001"],
      ['"%f|%f|%f", 1/0, -1/0, 0/0', "1.#INF00|-1.#INF00|-1.#IND00"],
      ['"%.2f|%.0f|%.3f", 1/0, 1/0, 1/0', "1.#J|1|1.#IO"],
      ['"%e|%g|%8.1g|", 1/0, 1/0, 1/0', "1.#INF00e+000|1.#INF|       1|"],
      ['"%F", 1.5', "1.500000"],
    ];
    for (const [args, expected] of cases) assert.equal(formatted(vm, args), expected, `format(${args})`);
  });
});

test("%F swaps the decimal point for a comma under SetEuropeanNumbers, %f never", () => {
  withVm((vm) => {
    setLuaFormatEuropeanNumbers(vm.state, true);
    assert.equal(formatted(vm, '"%F|%f|%.2F|%F", 1.5, 1.5, -1234.5, 1/0'), "1,500000|1.500000|-1234,50|1.#INF00");
    setLuaFormatEuropeanNumbers(vm.state, false);
    assert.equal(formatted(vm, '"%F", 1.5'), "1.500000");
  });
});

test("integer conversions keep the client's casts and C's flags", () => {
  withVm((vm) => {
    const cases = [
      ['"%d|%i", 3.7, -3.7', "3|-3"], ['"%d", 2^31', "-2147483648"], ['"%x", -1', "ffffffff"], ['"%x", 2^40', "0"],
      ['"%.3d|%.0d|%5.3d|%-+4d|% d", 7, 0, -7, 5, 5', "007|| -007|+5  | 5"], ['"%05.2d", 3', "   03"],
      ['"%#x|%#X|%#o|%#x", 255, 255, 8, 0', "0xff|0XFF|010|0"], ['"%+u", 5', "5"],
      ['"[%3c]", 65', "[  A]"], ['"[%3c]", 0', "[  ]"], ['"[%-3c]", 0', "[]"], ['"%c%c", 72.4, 105', "Hi"],
    ];
    for (const [args, expected] of cases) assert.equal(formatted(vm, args), expected, `format(${args})`);
    assert.equal(failure(vm, '"%c", "x"'), "bad argument #2 to 'format' (number expected, got string)");
  });
});

test("string.format and format are one host function, and the method form reaches it", () => {
  withVm((vm) => {
    vm.setGlobal("__r", undefined);
    const result = vm.execute('__r = tostring(format == string.format) .. ("%d-%s"):format(5, "x")', "@same");
    assert.equal(result.ok, true, result.error);
    assert.equal(vm.getGlobal("__r"), "true5-x");
  });
});
