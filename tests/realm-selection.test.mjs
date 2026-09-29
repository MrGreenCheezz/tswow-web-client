import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { canSelectRealm, REALM_FLAG_OFFLINE } from "../dist/code/auth/AuthProtocol.js";

// Login.ts imports the whole HUD at module load. Compile only its actual realm renderer so the
// button state can be checked with a small DOM fixture and no account or running worldserver.
const source = await readFile(new URL("../src/browser/app/Login.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("Login.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const renderer = file.statements.find((statement) =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === "showRealms");
assert.ok(renderer, "Login.ts exports showRealms");
const output = ts.transpileModule(renderer.getText(file), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function element(tag) {
  return {
    tag,
    children: [],
    textContent: "",
    disabled: false,
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {},
  };
}

test("legacy realm list labels unavailable realms and disables their connect buttons", () => {
  const realms = element("div");
  const document = { createElement: element };
  const showRealms = new Function(
    "exports", "realms", "document", "canSelectRealm", "REALM_FLAG_OFFLINE", "connectRealm",
    `${output}\nreturn exports.showRealms;`,
  )({}, realms, document, canSelectRealm, REALM_FLAG_OFFLINE, () => {});
  const base = { name: "Realm", address: "127.0.0.1", characters: 1, locked: false, flags: 0 };
  showRealms({ realms: [
    { ...base, flags: REALM_FLAG_OFFLINE },
    { ...base, locked: true },
    base,
  ] });

  const [offline, locked, online] = realms.children;
  assert.equal(offline.children[1].textContent.endsWith(" · недоступен"), true);
  assert.equal(offline.children[2].disabled, true);
  assert.equal(locked.children[1].textContent.endsWith(" · закрыт"), true);
  assert.equal(locked.children[2].disabled, true);
  assert.equal(online.children[2].disabled, false);
});
