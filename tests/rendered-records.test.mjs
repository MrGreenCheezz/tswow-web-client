import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// P1-09 (ENV-11): the renderer's retained records keep one V8 hidden class each. Every field is
// present from the creation literal on and is cleared with `= undefined`, never `delete`: deleting
// a property that was not the last one added turns the object into a slow dictionary for good.

const source = await readFile(new URL("../src/browser/WorldRenderer3D.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("WorldRenderer3D.ts", source, ts.ScriptTarget.Latest, true);

const RECORDS = ["RenderedEnvironment", "PosedModel", "RenderedUnit", "RenderedGameObject", "RenderedMount"];

function interfaces() {
  const found = new Map();
  file.forEachChild((node) => {
    if (ts.isInterfaceDeclaration(node) && RECORDS.includes(node.name.text)) found.set(node.name.text, node);
  });
  return found;
}

function fields(declarations, name) {
  const node = declarations.get(name);
  const own = node.members.filter(ts.isPropertySignature).map((member) => member.name.getText(file));
  const inherited = (node.heritageClauses ?? []).flatMap((clause) => clause.types)
    .flatMap((type) => fields(declarations, type.expression.getText(file)));
  return [...inherited, ...own];
}

/** Object literals that create a record: `const x: T = {`, or `<target> = {` inside `method`. */
function creationLiterals() {
  const found = [];
  const visit = (node, method) => {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name) method = node.name.getText(file);
    if (ts.isVariableDeclaration(node) && node.type && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      found.push({ method, target: node.type.getText(file), literal: node.initializer });
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isObjectLiteralExpression(node.right)) {
      found.push({ method, target: node.left.getText(file), literal: node.right });
    }
    ts.forEachChild(node, (child) => visit(child, method));
  };
  visit(file, "");
  return found;
}

const keys = (literal) => literal.properties.map((property) => property.name.getText(file));

test("P1-09: the five record interfaces declare no optional fields", () => {
  const declarations = interfaces();
  assert.deepEqual([...declarations.keys()].sort(), [...RECORDS].sort());
  for (const [name, node] of declarations) {
    const optional = node.members.filter((member) => member.questionToken).map((member) => member.name.getText(file));
    assert.deepEqual(optional, [], `${name}: optional fields must be \`T | undefined\``);
  }
});

test("P1-09: no record field is ever deleted", () => {
  const deleted = [];
  const visit = (node) => {
    if (ts.isDeleteExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ["unit", "rendered", "mount"].includes(node.expression.expression.getText(file))) {
      deleted.push(node.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.deepEqual(deleted, []);
});

test("P1-09: every creation literal names every field of its record", () => {
  const declarations = interfaces();
  const literals = creationLiterals();
  const expect = [
    { record: "RenderedEnvironment", pick: ({ method, target, literal }) => method === "#updateEnvironment" && target === "rendered"
      && keys(literal).includes("lastAdmittedFrame") },
    { record: "RenderedGameObject", pick: ({ method, target }) => method === "#buildGameObject" && target === "RenderedGameObject" },
    { record: "RenderedUnit", pick: ({ method, target, literal }) => method === "#drawUnit" && target === "unit"
      && keys(literal).includes("strideReady") },
    { record: "RenderedMount", pick: ({ method, target }) => method === "#attachMount" && target === "unit.mount" },
  ];
  for (const { record, pick } of expect) {
    const matches = literals.filter(pick);
    assert.equal(matches.length, 1, `${record}: exactly one creation literal`);
    assert.deepEqual(keys(matches[0].literal).sort(), [...new Set(fields(declarations, record))].sort(),
      `${record}: the literal and the interface name the same fields`);
  }
});
