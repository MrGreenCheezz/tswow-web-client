import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

/**
 * The window editor's model (М8) and the module checker (М9).
 *
 * No document anywhere in this file, and that is the point of the split: everything the editor does
 * to a definition is a pure function over the JSON, so the tree edits, the reference repairs, the
 * refusals and the export can all be asserted here, and `WindowBuilder.ts` is left holding only the
 * part that genuinely needs a page — pointer events, a panel and the clipboard.
 */

const { repositoryRoot } = await import("../tools/paths.mjs");
const { checkModules } = await import("../tools/check-modules.mjs");
const {
  ACTION_FORMS, ACTION_LIST_KEY, MIN_WIDGET_SIZE, SKELETON_MAX_ROWS, WIDGET_FIELDS,
  WIDGET_FIELDS_OMITTED,
  actionForm, actionListKey, addWidget, addWidgetAction, addWidgetCondition, applyDefinitionText,
  builderTree, colorFieldText, colorFieldValue, conditionFields, copyWindowDefinition,
  definitionText, deleteWidget, draggedAnchor, draggedSize, duplicateWidget, emptyWindowDefinition,
  exportWindowDefinition, fieldWrite, fieldsFor, movableWidgets, moveWidget, newWidgetJson,
  removeListEntry, renameWidget,
  reparentTargets, reparentWidget, resizeWidget, screenOf, setListEntryField, setWidgetField,
  skeletonFromMessage, uniqueWidgetId, widgetBox, widgetList,
} = await import("../dist/code/browser/ui/WindowBuilderModel.js");
const { WIDGET_TYPES, WINDOW_CONDITIONS, parseWindowDefinition, walkWindowWidgets, widgetActions } =
  await import("../dist/code/browser/ui/WindowSchema.js");

const context = { module: "shop" };

/* ---------------------------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------------------------- */

const anchor = (point = "TOPLEFT", relativeTo = "parent", x = 0, y = 0) =>
  ({ point, relativeTo, relativePoint: point, x, y });

/** A window with the children the caller wants, straight into the shape the editor edits. */
function windowWith(children) {
  const definition = emptyWindowDefinition({ id: "shop", title: "Лавка" });
  const screen = screenOf(definition);
  screen.children = children;
  return definition;
}

/** Every widget the parser actually drew, by id. */
function drawn(definition, module = "shop") {
  const parsed = parseWindowDefinition(definition, { module });
  assert.ok(parsed.window, `the fixture has to parse: ${parsed.problems.join("; ")}`);
  return walkWindowWidgets(parsed.window.screen);
}

function ids(definition) {
  return drawn(definition).map((widget) => widget.id);
}

/** One widget's raw JSON, by id, out of the definition the editor holds. */
function raw(definition, id) {
  const look = (widget) => {
    if (widget.id === id) return widget;
    for (const child of widget.children ?? []) {
      const found = look(child);
      if (found) return found;
    }
    return undefined;
  };
  const found = look(screenOf(definition));
  assert.ok(found, `no widget "${id}" in the definition`);
  return found;
}

/* ---------------------------------------------------------------------------------------------
 * М8: the tree edits
 * ------------------------------------------------------------------------------------------- */

test("every one of the twelve types can be added, and each one still draws", () => {
  let definition = emptyWindowDefinition({ id: "shop", title: "Лавка" });
  const added = [];
  for (const type of WIDGET_TYPES) {
    const result = addWidget(definition, { parent: "root", type }, context);
    assert.ok(result.changed, `${type} was refused: ${result.problems.join("; ")}`);
    // The defaults are checked by the parser, not by this file: a type whose default widget the
    // schema drops would be a widget an author adds and never sees.
    assert.deepEqual(result.problems, [], `${type} was added with a complaint: ${result.problems.join("; ")}`);
    definition = result.definition;
    added.push(result.selected);
  }
  assert.equal(added.length, 12);
  const live = new Set(ids(definition));
  for (const id of added) assert.ok(live.has(id), `${id} did not survive the parse`);
  // The id is the type in lower case, and a second one of the same type is numbered rather than
  // colliding — a duplicate id is fatal to the whole window.
  const twice = addWidget(definition, { parent: "root", type: "Text" }, context);
  assert.ok(twice.changed);
  assert.equal(twice.selected, "text-2");
});

test("a widget can only be added inside something that holds children", () => {
  const definition = windowWith([{ id: "label", type: "Text", width: 60, height: 16, anchor: anchor() }]);
  const refused = addWidget(definition, { parent: "label", type: "Button" }, context);
  assert.equal(refused.changed, false);
  assert.match(refused.problems.join(" "), /Text не держит детей/);
  assert.equal(refused.definition, definition, "a refusal hands back exactly what went in");

  const missing = addWidget(definition, { parent: "nobody", type: "Button" }, context);
  assert.equal(missing.changed, false);
  assert.match(missing.problems.join(" "), /виджета "nobody" в окне нет/);

  // A ScrollFrame is the other container, and it is the one a table of rows goes in.
  const scrolled = addWidget(
    addWidget(definition, { parent: "root", type: "ScrollFrame" }, context).definition,
    { parent: "scrollframe", type: "Text" }, context,
  );
  assert.ok(scrolled.changed, scrolled.problems.join("; "));
});

test("duplicating a widget renames its whole subtree and keeps the copy's own references inside it", () => {
  const definition = windowWith([
    {
      id: "card", type: "Frame", width: 120, height: 60, anchor: anchor("TOPLEFT", "parent", 8, -8),
      children: [
        { id: "name", type: "Text", width: 100, height: 16, text: "Имя", anchor: anchor() },
        {
          id: "buy", type: "Button", width: 60, height: 20, text: "Купить",
          anchor: anchor("TOPLEFT", "name", 0, -18),
          actions: [{ do: "hide", widget: "name" }],
        },
      ],
    },
  ]);
  const result = duplicateWidget(definition, "card", context);
  assert.ok(result.changed, result.problems.join("; "));
  assert.equal(result.selected, "card-2");
  assert.deepEqual(ids(result.definition), ["root", "card", "name", "buy", "card-2", "name-2", "buy-2"]);

  // The copy's inner anchor and its button's `hide` both point at the *copy's* widgets. Left
  // alone, the anchor would be a forward reference into a different parent — which the schema
  // refuses outright — and the button would hide the original's label.
  assert.equal(raw(result.definition, "buy-2").anchor.relativeTo, "name-2");
  assert.equal(raw(result.definition, "buy-2").actions[0].widget, "name-2");
  // And the original is untouched.
  assert.equal(raw(result.definition, "buy").anchor.relativeTo, "name");
  assert.equal(raw(result.definition, "buy").actions[0].widget, "name");
  // Offset rather than laid exactly on top, or «дублировать» reads as having done nothing.
  assert.deepEqual(
    [raw(result.definition, "card-2").anchor.x, raw(result.definition, "card-2").anchor.y],
    [16, -16],
  );

  const root = duplicateWidget(result.definition, "root", context);
  assert.equal(root.changed, false);
  assert.match(root.problems.join(" "), /корневую рамку не дублируют/);
});

test("deleting a widget puts back the anchors that pointed at it", () => {
  const definition = windowWith([
    { id: "first", type: "Text", width: 100, height: 16, text: "Раз", anchor: anchor() },
    { id: "second", type: "Text", width: 100, height: 16, text: "Два", anchor: anchor("TOPLEFT", "first", 0, -18) },
    { id: "third", type: "Text", width: 100, height: 16, text: "Три", anchor: anchor("TOPLEFT", "second", 0, -18) },
  ]);
  const result = deleteWidget(definition, "first", context);
  assert.ok(result.changed, result.problems.join("; "));
  assert.deepEqual(ids(result.definition), ["root", "second", "third"]);
  // Without the repair this definition is not a window at all: `parseAnchor` is *fatal* on an
  // anchor naming something that is neither the parent nor an earlier sibling, so the whole file
  // would be refused and the editor would be the thing that wrote it.
  assert.equal(raw(result.definition, "second").anchor.relativeTo, "parent");
  // And the one that was still legal is left exactly as the author wrote it.
  assert.equal(raw(result.definition, "third").anchor.relativeTo, "second");
  assert.match(result.problems.join(" "), /перевешен на родителя/);
  assert.equal(result.selected, "root", "the selection falls back to the parent, not to nothing");

  const root = deleteWidget(definition, "root", context);
  assert.equal(root.changed, false);
  assert.match(root.problems.join(" "), /корневую рамку не удаляют/);
});

test("a widget moves under a different container, and never into its own subtree", () => {
  const definition = windowWith([
    { id: "box", type: "Frame", width: 120, height: 60, anchor: anchor(), children: [] },
    { id: "label", type: "Text", width: 80, height: 16, text: "Раз", anchor: anchor("TOPLEFT", "parent", 0, -70) },
    { id: "under", type: "Text", width: 80, height: 16, text: "Два", anchor: anchor("TOPLEFT", "label", 0, -18) },
  ]);
  const moved = reparentWidget(definition, "label", "box", context);
  assert.ok(moved.changed, moved.problems.join("; "));
  assert.deepEqual(builderTree(moved.definition).map((row) => `${row.parent}/${row.id}`),
    ["/root", "root/box", "box/label", "root/under"]);
  // `under` used to be anchored to a sibling that has just left the family.
  assert.equal(raw(moved.definition, "under").anchor.relativeTo, "parent");
  assert.match(moved.problems.join(" "), /потерял свою цель при переносе/);

  const inward = reparentWidget(moved.definition, "box", "label", context);
  assert.equal(inward.changed, false);
  assert.match(inward.problems.join(" "), /нельзя вложить в самого себя/);

  const flat = reparentWidget(moved.definition, "under", "label", context);
  assert.equal(flat.changed, false);
  assert.match(flat.problems.join(" "), /Text не держит детей/);
});

test("a drag writes the anchor and an edge drag writes the size, with WoW's y", () => {
  const definition = windowWith([
    { id: "label", type: "Text", width: 80, height: 16, text: "Раз", anchor: anchor("TOPLEFT", "parent", 10, -10) },
  ]);
  assert.deepEqual(widgetBox(definition, "label"), { x: 10, y: -10, width: 80, height: 16 });

  // Dragged 24 px right and 12 px *down* the screen: x grows, y shrinks, because the file's y is
  // WoW's and grows upward. The renderer flips it once; this is the mirror of that flip, and the
  // pointer handler in the overlay writes exactly what these two functions answer.
  const box = widgetBox(definition, "label");
  assert.deepEqual(draggedAnchor(box, 24, 12), { x: 34, y: -22 });
  assert.deepEqual(draggedAnchor(box, -24, -12), { x: -14, y: 2 }, "and dragging up raises y");
  assert.deepEqual(draggedSize(box, 24, 12), { width: 104, height: 28 });

  const dragged = moveWidget(definition, "label", box.x + 24, box.y - 12, context);
  assert.ok(dragged.changed, dragged.problems.join("; "));
  assert.deepEqual(
    [raw(dragged.definition, "label").anchor.x, raw(dragged.definition, "label").anchor.y],
    [34, -22],
  );
  // Rounded, because a pointer on a scaled page produces fractions and a definition full of
  // 34.000000000000004 is a definition nobody can read.
  assert.equal(raw(moveWidget(definition, "label", 3.4, -7.6, context).definition, "label").anchor.x, 3);

  const sized = resizeWidget(dragged.definition, "label", 200, 40, context);
  assert.deepEqual([raw(sized.definition, "label").width, raw(sized.definition, "label").height], [200, 40]);
  // A drag past the top-left corner would otherwise leave a widget with no edge to grab again.
  const squashed = resizeWidget(sized.definition, "label", -50, 0, context);
  assert.deepEqual(
    [raw(squashed.definition, "label").width, raw(squashed.definition, "label").height],
    [MIN_WIDGET_SIZE, MIN_WIDGET_SIZE],
  );
});

test("a field that would stop the widget drawing is refused, and the old value stays", () => {
  const definition = windowWith([
    { id: "label", type: "Text", width: 80, height: 16, text: "Здоровье: {player.health}", anchor: anchor() },
  ]);
  const broken = setWidgetField(definition, "label", "text", "Здоровье: {player.health", context);
  assert.equal(broken.changed, false);
  assert.match(broken.problems.join(" "), /после правки не рисуется/);
  // The half-written expression never lands: a refusal hands back the definition that went in, so
  // the preview goes on showing the last thing that worked rather than going blank while the author
  // is halfway through typing.
  assert.equal(raw(broken.definition, "label").text, "Здоровье: {player.health}");
  assert.equal(raw(definition, "label").text, "Здоровье: {player.health}", "and the model handed in is not mutated");

  const good = setWidgetField(definition, "label", "text", "Мана: {player.power}", context);
  assert.ok(good.changed, good.problems.join("; "));
  assert.equal(raw(good.definition, "label").text, "Мана: {player.power}");

  // `undefined` takes the key out, which is how a choice goes back to the studio's own default.
  const cleared = setWidgetField(good.definition, "label", "font", undefined, context);
  assert.ok(cleared.changed);
  assert.equal("font" in raw(cleared.definition, "label"), false);

  // An anchor field reaches one level in.
  const anchored = setWidgetField(good.definition, "label", "anchor.point", "BOTTOMRIGHT", context);
  assert.equal(raw(anchored.definition, "label").anchor.point, "BOTTOMRIGHT");
  // And an anchor naming a widget that is not an earlier sibling is fatal, so the edit is refused
  // rather than leaving a file the loader would throw away whole.
  const dangling = setWidgetField(good.definition, "label", "anchor.relativeTo", "nobody", context);
  assert.equal(dangling.changed, false);
  assert.match(dangling.problems.join(" "), /отменено/);

  for (const key of ["id", "type", "children"]) {
    assert.equal(setWidgetField(definition, "label", key, "x", context).changed, false, `${key} is not a field`);
  }

  // The root frame's own fields are the level above «выбросить виджет»: there is nothing smaller
  // than the root to drop, so the schema refuses the whole window — and the editor has to hand back
  // the definition that went in rather than the one that is no longer a window at all.
  const rootless = setWidgetField(definition, "root", "title", "Лавка {player.name", context);
  assert.equal(rootless.changed, false);
  assert.equal(rootless.definition, definition);
  assert.match(rootless.problems.join(" "), /отменено/);
  assert.ok(parseWindowDefinition(rootless.definition, context).window, "and what it handed back is still a window");
});

test("renaming a widget rewrites every mention of the old name", () => {
  const definition = windowWith([
    { id: "name", type: "Text", width: 80, height: 16, text: "Имя", anchor: anchor() },
    {
      id: "buy", type: "Button", width: 60, height: 20, text: "Купить",
      anchor: anchor("TOPLEFT", "name", 0, -20),
      action: { type: "toggleWidget", target: "name" },
      actions: [{ do: "hide", widget: "name" }],
    },
    {
      id: "qty", type: "EditBox", width: 40, height: 18, numeric: true,
      anchor: anchor("TOPLEFT", "buy", 0, -22),
    },
    {
      id: "send", type: "Button", width: 60, height: 20, text: "Слать",
      anchor: anchor("TOPLEFT", "qty", 0, -22),
      action: { type: "sendPacket", opcode: 4001, valueFrom: "qty" },
    },
  ]);
  const result = renameWidget(definition, "name", "title", context);
  assert.ok(result.changed, result.problems.join("; "));
  assert.equal(raw(result.definition, "buy").anchor.relativeTo, "title");
  assert.equal(raw(result.definition, "buy").actions[0].widget, "title");
  assert.equal(raw(result.definition, "buy").action.target, "title");

  // The studio's «отправить пакет» names an *input* rather than a widget to show, and it is the
  // one of the four that is easy to forget: a rename that missed it leaves a button that encodes
  // `undefined` the first time somebody presses it.
  const input = renameWidget(result.definition, "qty", "amount", context);
  assert.ok(input.changed, input.problems.join("; "));
  assert.equal(raw(input.definition, "send").action.valueFrom, "amount");

  assert.equal(renameWidget(definition, "name", "buy", context).changed, false, "a name in use is refused");
  assert.match(renameWidget(definition, "name", "buy", context).problems.join(" "), /уже занято/);
  assert.equal(renameWidget(definition, "name", "имя окна", context).changed, false, "and so is a name a selector cannot carry");
  assert.equal(renameWidget(definition, "name", "name", context).changed, false, "and a rename to the same name");
});

test("the JSON pane replaces the definition, and only when what it holds is a window", () => {
  const definition = windowWith([{ id: "label", type: "Text", width: 80, height: 16, text: "Раз", anchor: anchor() }]);
  const text = definitionText(definition);
  assert.equal(text.endsWith("\n"), true, "a file ends in a newline");
  assert.deepEqual(JSON.parse(text), definition);

  const broken = applyDefinitionText(definition, "{ not json", context);
  assert.equal(broken.changed, false);
  assert.match(broken.problems.join(" "), /JSON не читается/);
  assert.equal(broken.definition, definition);

  const notAWindow = applyDefinitionText(definition, JSON.stringify({ kind: "addon", id: "x" }), context);
  assert.equal(notAWindow.changed, false);
  assert.match(notAWindow.problems.join(" "), /params/);
  // A refusal hands back the definition that went in — the preview is drawn from whatever this
  // returns, so handing back the unparseable one would blank the window the author is looking at.
  assert.equal(notAWindow.definition, definition);

  const swapped = applyDefinitionText(definition, JSON.stringify(windowWith([])), context);
  assert.ok(swapped.changed, swapped.problems.join("; "));
  assert.deepEqual(ids(swapped.definition), ["root"]);
  assert.equal(swapped.selected, "root");
});

test("every edit leaves a definition the parser still accepts, over a hundred of them", () => {
  // The invariant, driven rather than asserted one edit at a time: a run of ordinary editing has to
  // leave a file the loader would take. Deterministic — no clock, no random — so a failure is a
  // failure somebody can reproduce from the seed printed in the message.
  let definition = emptyWindowDefinition({ id: "shop", title: "Лавка" });
  let seed = 7;
  const next = (bound) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % bound;
  };
  let applied = 0;
  for (let step = 0; step < 120; step++) {
    const rows = builderTree(definition);
    const row = rows[next(rows.length)];
    const containers = rows.filter((entry) => entry.container);
    const host = containers[next(containers.length)] ?? rows[0];
    const result = [
      () => addWidget(definition, { parent: host.id, type: WIDGET_TYPES[next(WIDGET_TYPES.length)] }, context),
      () => duplicateWidget(definition, row.id, context),
      () => deleteWidget(definition, row.id, context),
      () => reparentWidget(definition, row.id, host.id, context),
      () => moveWidget(definition, row.id, next(400) - 200, next(400) - 200, context),
      () => resizeWidget(definition, row.id, next(300), next(300), context),
      () => renameWidget(definition, row.id, `w${step}`, context),
    ][next(7)]();
    definition = result.definition;
    if (result.changed) applied++;
    const parsed = parseWindowDefinition(definition, context);
    assert.ok(parsed.window, `step ${step} left a definition with no window: ${parsed.problems.join("; ")}`);
  }
  assert.ok(applied > 40, `only ${applied} of 120 edits landed — the walk is not exercising much`);
});

/* ---------------------------------------------------------------------------------------------
 * М8: the field table and the three ways to start a window
 * ------------------------------------------------------------------------------------------- */

test("every field the inspector offers is one the parser actually reads", () => {
  // The claim is not «the edit was accepted» — an unknown key is accepted by every parser, quietly.
  // It is that writing the field *changes the parsed window*, so a key that names nothing shows up
  // here rather than as a control an author moves and nothing happens.
  //
  // A field is tried against a list of candidates and has to move the parse with at least one of
  // them: `wrap` already defaults to true, `font` on an EditBox already defaults to the last name in
  // its menu, and a candidate equal to what is already there proves nothing either way.
  const candidates = (spec) => {
    if (spec.kind === "choice") return spec.choices;
    if (spec.kind === "boolean") return [true, false];
    if (spec.kind === "number") return [7, 13];
    // A colour is four `0..1` channels in the file and `#rrggbb` in the control, so the candidate is
    // exactly what the control would have written — through the same pair of pure functions.
    if (spec.kind === "color") return [colorFieldValue("#3fa9f5", undefined)];
    // An anchor may name `parent` or an earlier sibling, so the sibling every fixture below carries
    // is what proves this one reaches the parser.
    if (spec.key === "anchor.relativeTo") return ["sibling"];
    return [spec.kind === "expression" ? "{player.name}" : "Проверка"];
  };
  const parsedWidget = (definition, id) => {
    const parsed = parseWindowDefinition(definition, context);
    if (!parsed.window) return undefined;
    const found = walkWindowWidgets(parsed.window.screen).find((widget) => widget.id === id);
    // The parsed tree is inert data by `WindowExpression`'s own guarantee, so it round-trips
    // through JSON — which is what makes «did this field change anything» a comparison at all.
    return found === undefined ? undefined : JSON.stringify(found);
  };

  for (const type of WIDGET_TYPES) {
    const base = addWidget(
      addWidget(emptyWindowDefinition({ id: "shop", title: "Лавка" }), { parent: "root", type: "Text" }, context)
        .definition,
      { parent: "root", type }, context,
    );
    assert.ok(base.changed, `${type}: ${base.problems.join("; ")}`);
    const renamed = renameWidget(base.definition, "text", "sibling", context);
    assert.ok(renamed.changed, renamed.problems.join("; "));
    const id = base.selected;
    const before = parsedWidget(renamed.definition, id);
    assert.ok(before, `${type} did not draw with its own defaults`);

    for (const spec of fieldsFor(type, false)) {
      let moved = false;
      for (const value of candidates(spec)) {
        const result = setWidgetField(renamed.definition, id, spec.key, value, context);
        if (!result.changed) continue;
        assert.deepEqual(result.problems, [],
          `${type}.${spec.key} = ${String(value)} loaded with a complaint: ${result.problems.join("; ")}`);
        if (parsedWidget(result.definition, id) !== before) moved = true;
      }
      assert.ok(moved, `${type}.${spec.key} is a field the parser never reads: nothing it can be set to changes the window`);
    }
    assert.ok(WIDGET_FIELDS[type].length > 0, `${type} has no fields of its own`);
  }

  // And the window's own six, which only the root frame carries.
  const rootFields = fieldsFor("Frame", true).map((spec) => spec.key);
  assert.ok(rootFields.includes("strata") && rootFields.includes("escClose"));
  assert.equal(fieldsFor("Frame", false).includes("strata"), false);
  const empty = emptyWindowDefinition({ id: "shop", title: "Лавка" });
  const window = (definition) => JSON.stringify(parseWindowDefinition(definition, context).window);
  const asIs = window(empty);
  for (const spec of fieldsFor("Frame", true)) {
    if (fieldsFor("Frame", false).some((common) => common.key === spec.key)) continue;
    const moved = candidates(spec).some((value) => {
      const result = setWidgetField(empty, "root", spec.key, value, context);
      return result.changed && window(result.definition) !== asIs;
    });
    assert.ok(moved, `the window's own "${spec.key}" is read by nothing`);
  }
});

test("an empty frame, a copy of a window and a skeleton from a schema are all whole windows", () => {
  const empty = emptyWindowDefinition({ id: "fresh", title: "Новое окно", updated: "2026-08-24T00:00:00.000Z" });
  assert.equal(empty.updated, "2026-08-24T00:00:00.000Z");
  assert.deepEqual(ids(empty), ["root"]);
  // No clock is read inside the function: the studio's own timestamp is an argument, and a call
  // that does not pass one leaves the key out rather than stamping «now». Two calls with the same
  // arguments are therefore the same bytes, which is what makes every edit above testable.
  assert.equal("updated" in emptyWindowDefinition({ id: "fresh", title: "Новое окно" }), false);
  assert.deepEqual(emptyWindowDefinition({ id: "fresh", title: "Новое окно" }),
    emptyWindowDefinition({ id: "fresh", title: "Новое окно" }));

  const source = windowWith([{ id: "label", type: "Text", width: 80, height: 16, text: "Раз", anchor: anchor() }]);
  source.params.slash = "shop";
  source.params.binding = "shop";
  source.params.messages = [
    { name: "shop.Buy", opcode: 4001, direction: "out", fields: [{ name: "entry", type: "u32" }] },
  ];
  const copy = copyWindowDefinition(source, { id: "shop-2", title: "Лавка (копия)" });
  assert.equal(copy.id, "shop-2");
  assert.deepEqual(ids(copy), ["root", "label"]);
  // Three things a copy may not take with it, and all three for one reason: the original still
  // holds them. The `/команда` and the key are refused by the chat and binding tables; the inline
  // message schema is refused by `CustomPacketRegistry` — «a custom opcode may only be claimed
  // once» — which М9 turns into a failed build whose sentence names the file the author did *not*
  // touch. Asserted on the parse rather than on the keys, so that a copy which kept an empty
  // `messages: []` would still pass and one which kept the schema could not.
  const parsed = parseWindowDefinition(copy, { module: "shop" });
  assert.equal(parsed.window.slash, "");
  assert.equal(parsed.window.binding, "");
  assert.deepEqual(parsed.window.messages, []);
  assert.equal(source.params.slash, "shop", "the window it was copied from is untouched");
  assert.equal(source.params.messages.length, 1, "and keeps its own schema");
});

test("a skeleton lays one row per field of a message and binds each to msg.<имя>.<поле>", () => {
  const message = {
    name: "shop.State",
    opcode: 4002,
    direction: "in",
    fields: [
      { name: "gold", type: { kind: "u32" } },
      { name: "guid", type: { kind: "u64" } },
      { name: "prices", type: { kind: "array", capacity: 8, of: { kind: "u32" } } },
      { name: "guids", type: { kind: "array", capacity: 4, of: { kind: "u64" } } },
      { name: "seller", type: { kind: "nested", fields: [{ name: "entry", type: { kind: "u32" } }] } },
      {
        name: "rows",
        type: { kind: "array", capacity: 4, of: { kind: "nested", fields: [{ name: "owner", type: { kind: "i64" } }] } },
      },
    ],
  };
  const definition = skeletonFromMessage(message, { id: "shop-state" });
  const widgets = drawn(definition, "shop");
  const texts = widgets.filter((widget) => widget.type === "Text");
  // Six leaves — the nested one is flattened because the codec writes it inline, an array is shown
  // at its first slot, and an array *of* records is both at once — and two widgets each: the label
  // and the value.
  assert.equal(texts.length, 12);

  const sources = definitionText(definition);
  assert.match(sources, /\{msg\.shop\.State\.gold\}/);
  // A `u64` decodes to a `bigint`, which `formatExpressionValue` has no words for — so the one row
  // an author most wants to see would be the one that reads blank. `decodeField` reads *each
  // element* of an array of `u64` with `reader.u64()`, so a slot of one is the same bigint and
  // needs the same `fmt`; it did not get it at first, and an array of guids read blank.
  assert.match(sources, /\{fmt\(msg\.shop\.State\.guid\)\}/);
  assert.match(sources, /\{fmt\(msg\.shop\.State\.guids\[0\]\)\}/);
  assert.match(sources, /\{fmt\(msg\.shop\.State\.rows\[0\]\.owner\)\}/);
  assert.match(sources, /\{msg\.shop\.State\.prices\[0\]\}/);
  assert.match(sources, /\{msg\.shop\.State\.seller\.entry\}/);
  // And nothing reads a whole record or a whole array: `formatExpressionValue` has no words for
  // either, so a row spelling one would be a blank line rather than a value.
  assert.equal(sources.includes("{msg.shop.State.rows[0]}"), false);
  assert.equal(sources.includes("{msg.shop.State.seller}"), false);

  // A message with more fields than a screen can hold stops — and says so in the window, because a
  // skeleton that quietly ended at the thirty-second of forty fields is one whose author goes
  // looking for the other eight in the schema.
  const wide = {
    name: "shop.Wide", opcode: 4003, direction: "in",
    fields: Array.from({ length: SKELETON_MAX_ROWS + 20 }, (_unused, index) => ({ name: `f${index}`, type: { kind: "u32" } })),
  };
  const cut = skeletonFromMessage(wide, { id: "wide" });
  assert.equal(drawn(cut, "shop").filter((widget) => widget.type === "Text").length, SKELETON_MAX_ROWS * 2 + 1);
  assert.match(definitionText(cut), /…и ещё 20 пол/);
  // The window with nothing cut carries no such line: a notice that is always there says nothing.
  assert.equal(definitionText(definition).includes("и ещё"), false);
});

test("«в…» offers exactly the containers a move is allowed into, and nothing else", async () => {
  // The menu used to be «every container that is not this widget», which offers the frame a widget
  // is already in and every frame inside it — so on the file the editor actually opens on it was a
  // menu of refusals. The claim asserted here is the strong one: for every widget of a window, the
  // set offered *equals* the set `reparentWidget` accepts.
  const agree = (definition, where) => {
    for (const row of builderTree(definition)) {
      const offered = reparentTargets(definition, row.id).map((target) => target.id);
      const accepted = builderTree(definition)
        .filter((target) => reparentWidget(definition, row.id, target.id, context).changed)
        .map((target) => target.id);
      assert.deepEqual(offered, accepted, `${where}: «в…» on "${row.id}" offers ${offered} but the model takes ${accepted}`);
    }
  };

  const nested = windowWith([
    { id: "left", type: "Frame", width: 60, height: 60, anchor: anchor(), children: [
      { id: "deep", type: "Frame", width: 20, height: 20, anchor: anchor(), children: [] },
    ] },
    { id: "right", type: "Frame", width: 60, height: 60, anchor: anchor("TOPRIGHT"), children: [] },
    { id: "label", type: "Text", width: 40, height: 16, text: "Раз", anchor: anchor("BOTTOMLEFT") },
  ]);
  agree(nested, "a window of two frames");
  // Named, so that a filter which merely returns nothing would not pass this test by agreeing with
  // a model that also refuses everything.
  assert.deepEqual(reparentTargets(nested, "label").map((row) => row.id), ["left", "deep", "right"]);
  assert.deepEqual(reparentTargets(nested, "left").map((row) => row.id), ["right"]);
  assert.deepEqual(reparentTargets(nested, "deep").map((row) => row.id), ["root", "right"]);
  assert.deepEqual(reparentTargets(nested, "root"), [], "the root frame goes nowhere");

  // And the file the editor opens on by default: a root with seven leaves in it, where the old
  // filter offered `root` — the parent they are all already in — to every one of them.
  const example = JSON.parse(await readFile(join(repositoryRoot, "examples/module-example/ui/example.json"), "utf8"));
  agree(example, "examples/module-example/ui/example.json");
  for (const row of builderTree(example).slice(1)) {
    assert.deepEqual(reparentTargets(example, row.id), [], `"${row.id}" has nowhere to go in a flat window`);
  }

  // And the set the tree pane hangs the button on is the same answer, worked out in one walk
  // instead of one per row — which is the whole reason it exists, so it may not disagree.
  for (const definition of [nested, example]) {
    const movable = movableWidgets(definition);
    for (const row of builderTree(definition)) {
      assert.equal(movable.has(row.id), reparentTargets(definition, row.id).length > 0,
        `"${row.id}": the button and the menu disagree about whether there is anywhere to go`);
    }
  }
  assert.deepEqual([...movableWidgets(example)], [], "a flat window offers the button on no row at all");
  assert.deepEqual([...movableWidgets(nested)].sort(), ["deep", "label", "left", "right"]);
});

test("a widget may not be called «parent»: the anchors already mean the frame by it", () => {
  const definition = windowWith([
    { id: "a", type: "Text", width: 40, height: 16, text: "Раз", anchor: anchor() },
    { id: "b", type: "Text", width: 40, height: 16, text: "Два", anchor: anchor("TOPLEFT", "a", 0, -20) },
  ]);
  const refused = renameWidget(definition, "a", "parent", context);
  assert.equal(refused.changed, false);
  assert.match(refused.problems.join(" "), /"parent"/);
  // The whole reason it has to be refused rather than left to the parser: the rename *parses*.
  // `b` was placed against `a`; renaming `a` to `parent` rewrites that anchor into the frame and
  // the file still loads, so nothing anywhere would have said that `b` had moved.
  assert.equal(raw(refused.definition, "b").anchor.relativeTo, "a");
  // And no added widget can be given the name either — `parent` is never in `definitionIds`, so the
  // taken-name refusal cannot be what catches it.
  assert.equal(uniqueWidgetId(new Set(), "parent"), "parent-widget");
  assert.equal(uniqueWidgetId(new Set(["parent-widget"]), "parent"), "parent-widget-2");
  const ok = renameWidget(definition, "a", "first", context);
  assert.equal(ok.changed, true, ok.problems.join("; "));
  assert.equal(raw(ok.definition, "b").anchor.relativeTo, "first");
});

/* ---------------------------------------------------------------------------------------------
 * М8: the two lists a widget carries — what it does, and when it is shown
 * ------------------------------------------------------------------------------------------- */

/** The parsed action list of one widget, whatever key its own type is read from. */
function parsedActions(definition, id) {
  const parsed = parseWindowDefinition(definition, context);
  assert.ok(parsed.window, parsed.problems.join("; "));
  const widget = walkWindowWidgets(parsed.window.screen).find((entry) => entry.id === id);
  assert.ok(widget, `no widget "${id}" after the parse`);
  return widgetActions(widget);
}

const actionDefaults = { windowId: "shop", widget: "root", message: "shop.Buy", soundKit: "windowOpen" };

test("every action the editor offers reaches the parser, in the key its own type is read from", () => {
  // The acceptance step the editor had no road to: «дать кнопке действие-пакет». What is asserted
  // is not that the file still parses — an unknown key parses — but that the action comes back out
  // of `widgetActions`, which is the list `runWindowAction` and `checkWindowActions` both walk.
  for (const type of Object.keys(ACTION_LIST_KEY)) {
    let definition = addWidget(windowWith([]), { parent: "root", type }, context);
    assert.ok(definition.changed, definition.problems.join("; "));
    const id = definition.selected;
    for (const form of ACTION_FORMS) {
      const result = addWidgetAction(definition.definition, id, form.verb, actionDefaults, context);
      assert.ok(result.changed, `${type} · ${form.verb}: ${result.problems.join("; ")}`);
      definition = result;
    }
    const verbs = parsedActions(definition.definition, id).map((action) => action.do);
    // `sendCustom` needs a schema this fixture has not declared, so it is the one form whose action
    // survives the parse only as far as its own note — every other verb comes back by name.
    for (const form of ACTION_FORMS) {
      if (form.verb === "sendCustom") continue;
      assert.ok(verbs.includes(form.verb), `${type}: «${form.verb}» did not reach the parse (got ${verbs.join(", ")})`);
    }
    // And it went into the key the *parser* reads for this type, not into whichever key reads best.
    assert.ok(Array.isArray(raw(definition.definition, id)[ACTION_LIST_KEY[type]]));
  }

  // A type that runs nothing refuses instead of writing a list nothing will ever run.
  const text = addWidget(windowWith([]), { parent: "root", type: "Text" }, context);
  const refused = addWidgetAction(text.definition, text.selected, "chat", actionDefaults, context);
  assert.equal(refused.changed, false);
  assert.match(refused.problems.join(" "), /ничего не запускает/);
  assert.equal(addWidgetAction(text.definition, text.selected, "explode", actionDefaults, context).changed, false);

  // And the table names the key the *parser* reads, type by type. Asked by putting a distinguishable
  // action under all three keys at once and seeing which one comes back out of `widgetActions`: a
  // `DropDown` given an `actions` list is a widget with a list nothing ever runs, and that is a
  // mistake nothing else in this file could catch.
  const readsFrom = (type) => {
    const probe = newWidgetJson(type, "probe");
    for (const key of ["actions", "onChange", "onEnter"]) probe[key] = [{ do: "setState", key, value: 1 }];
    const parsed = parseWindowDefinition(windowWith([probe]), context);
    assert.ok(parsed.window, `${type}: ${parsed.problems.join("; ")}`);
    const widget = walkWindowWidgets(parsed.window.screen).find((entry) => entry.id === "probe");
    return (widgetActions(widget) ?? []).map((action) => action.key);
  };
  for (const type of WIDGET_TYPES) {
    const key = actionListKey(type);
    assert.deepEqual(readsFrom(type), key ? [key] : [], `${type}: the table and the parser disagree`);
  }
});

test("a packet action carries one value per declared field, and a command's arguments keep their order", () => {
  const messages = [{ name: "shop.Buy", opcode: 4001, direction: "out", fields: [{ name: "entry", type: "u32" }] }];
  const withSchema = (definition) => {
    const copy = JSON.parse(JSON.stringify(definition));
    copy.params.messages = messages;
    return copy;
  };
  const added = addWidget(windowWith([]), { parent: "root", type: "Button" }, context);
  const id = added.selected;
  const packet = addWidgetAction(withSchema(added.definition), id, "sendCustom", actionDefaults, context);
  assert.ok(packet.changed, packet.problems.join("; "));
  // The schema names one field and the action sets none of them, so the client says which one is
  // missing — the same sentence `modules:check` fails the build with. That is the note the editor
  // shows, and it is why the value rows are drawn from the schema and not from a table.
  assert.equal(parsedActions(packet.definition, id).length, 1);

  const filled = setListEntryField(packet.definition, id, "actions", 0, "value.entry", "{state.qty}", context);
  assert.ok(filled.changed, filled.problems.join("; "));
  const sent = parsedActions(filled.definition, id)[0];
  assert.equal(sent.do, "sendCustom");
  assert.equal(sent.message, "shop.Buy");
  assert.ok(sent.value.entry, "the field the schema declares has to be in the action's value map");
  assert.equal(raw(filled.definition, id).actions[0].value.entry, "{state.qty}");

  // What the control writes for what was typed, which is three different things and not one.
  // `WidgetReader.raw` reads a bare `5` as the number five and `"5"` as the *string* «5», and a
  // `u32` field handed the string encodes nothing — so a plain number typed into an action's row
  // has to land as a number. A widget's own fields do not get that (`numbers` is off there),
  // because `localised` is the mirror: an EditBox whose `text` is a number reads as empty.
  assert.equal(fieldWrite("5", undefined, true), 5);
  assert.equal(fieldWrite("5", undefined, false), "5");
  assert.equal(fieldWrite("{player.guid}", undefined, true), "{player.guid}");
  assert.equal(fieldWrite(" ", undefined, true), " ");
  // And a pair the studio wrote keeps its shape whichever way the flag is set, so English typed in
  // the studio survives a drag in the game.
  assert.deepEqual(fieldWrite("Купить", { ru: "Раз", en: "Buy" }, true), { ru: "Купить", en: "Buy" });
  assert.deepEqual(fieldWrite("7", { ru: "Раз", en: "Buy" }, true), { ru: "7", en: "Buy" });

  // A command's arguments are read by position, so clearing one truncates rather than leaving a
  // hole: `[1, undefined, 3]` would send the third value as the second.
  let command = addWidgetAction(added.definition, id, "command", actionDefaults, context);
  for (const [index, value] of ["{player.guid}", 2, 3].entries()) {
    command = setListEntryField(command.definition, id, "actions", index === 0 ? 0 : 0, `args.${index}`, value, context);
    assert.ok(command.changed, command.problems.join("; "));
  }
  assert.deepEqual(raw(command.definition, id).actions[0].args, ["{player.guid}", 2, 3]);
  const cleared = setListEntryField(command.definition, id, "actions", 0, "args.1", undefined, context);
  assert.deepEqual(raw(cleared.definition, id).actions[0].args, ["{player.guid}"]);
  assert.equal(parsedActions(cleared.definition, id)[0].args.length, 1);

  // Neither the род of an action nor a key outside the two lists is written through here. The
  // second one is not a formality: `children` is an array of records on every Frame, so without the
  // refusal this pair of functions is a way to rename — or delete — a widget through a path that
  // repairs no anchor and renames no reference.
  assert.equal(setListEntryField(cleared.definition, id, "actions", 0, "do", "chat", context).changed, false);
  assert.equal(setListEntryField(cleared.definition, "root", "children", 0, "id", "hijacked", context).changed, false);
  assert.equal(removeListEntry(cleared.definition, "root", "children", 0, context).changed, false);
  assert.deepEqual(ids(cleared.definition), ["root", id]);
  assert.equal(setListEntryField(cleared.definition, id, "actions", 7, "window", "shop", context).changed, false);

  // Taking the last entry out takes the key with it: the studio writes no `actions` at all for a
  // widget that does nothing, and a file that came from the studio has to go back looking like one.
  const empty = removeListEntry(cleared.definition, id, "actions", 0, context);
  assert.ok(empty.changed, empty.problems.join("; "));
  assert.equal("actions" in raw(empty.definition, id), false);
  assert.equal(removeListEntry(empty.definition, id, "actions", 0, context).changed, false);
});

test("a condition is offered the fields its own kind has, and every one of them reaches the parse", () => {
  const added = addWidget(windowWith([]), { parent: "root", type: "Text" }, context);
  const id = added.selected;
  let definition = added.definition;
  for (const option of WINDOW_CONDITIONS) {
    const result = addWidgetCondition(definition, id, option.name, context);
    assert.ok(result.changed, `${option.name}: ${result.problems.join("; ")}`);
    definition = result.definition;
  }
  assert.equal(widgetList(definition, id, "conditions").length, WINDOW_CONDITIONS.length);
  const parsed = parseWindowDefinition(definition, context);
  const widget = walkWindowWidgets(parsed.window.screen).find((entry) => entry.id === id);
  assert.equal(widget.conditions.length, WINDOW_CONDITIONS.length,
    "a condition the editor writes has to be one the parser keeps");
  assert.equal(addWidgetCondition(definition, id, "whenTheMoonIsFull", context).changed, false);

  // `value` is a **number** for the seventeen parametrised conditions and an **expression** for
  // `expr`: one row for both would write a string where a number was wanted, and the condition
  // would silently fall back to the studio's own default instead of saying anything.
  const rowKinds = (when, then) => Object.fromEntries(conditionFields(when, then).map((spec) => [spec.key, spec.kind]));
  assert.equal(rowKinds("healthBelow", "hide").value, "number");
  assert.equal(rowKinds("expr", "hide").value, "expression");
  assert.equal(rowKinds("inCombat", "hide").value, undefined, "a condition with no threshold offers no threshold");
  assert.equal(rowKinds("hasBuff", "hide").text, "text");
  // And the effect's own value appears with the effect and not before it.
  assert.equal(rowKinds("inCombat", "color").color, "color");
  assert.equal(rowKinds("inCombat", "alpha").alpha, "number");
  assert.equal(rowKinds("inCombat", "show").color, undefined);

  // The rows a kind offers are rows the parser reads: a threshold written through one changes it.
  const one = addWidgetCondition(added.definition, id, "healthBelow", context);
  const moved = setListEntryField(one.definition, id, "conditions", 0, "value", 12, context);
  assert.ok(moved.changed, moved.problems.join("; "));
  const before = JSON.stringify(parseWindowDefinition(one.definition, context).window);
  assert.notEqual(JSON.stringify(parseWindowDefinition(moved.definition, context).window), before);
});

test("a colour goes to #rrggbb and back, and keeps the transparency the file already had", () => {
  assert.equal(colorFieldText([1, 0.5, 0, 1]), "#ff8000");
  assert.equal(colorFieldText([0, 0, 0, 0.5]), "#000000");
  assert.equal(colorFieldText("зелёный"), "", "a colour that is not four channels has no hex form");
  assert.deepEqual(colorFieldValue("#ff8000", undefined), [1, 128 / 255, 0, 1]);
  // The fourth channel never appears in the control, so it has to survive being written through it
  // — otherwise the first touch of a colour row would throw the file's own transparency away.
  assert.deepEqual(colorFieldValue("#000000", [1, 1, 1, 0.25]), [0, 0, 0, 0.25]);
  assert.equal(colorFieldValue("not a colour", undefined), undefined);
  // And the round trip is exact for anything the control can produce.
  for (const hex of ["#000000", "#ffffff", "#3fa9f5", "#1a2b3c"]) {
    assert.equal(colorFieldText(colorFieldValue(hex, undefined)), hex);
  }
});

test("every field the parser reads is either offered by the inspector or written down as left out", () => {
  // The other direction of test 11, and the one that was missing: that test walks the table and
  // asks the parser «do you read this?», which cannot notice a key the parser reads and the table
  // has no row for. This walks the *parser* — by handing it a widget whose JSON is a `Proxy` that
  // records every key asked for — and requires each one to be in the table or in the list of the
  // ones deliberately left out. It is what would have caught the inspector shipping with no row for
  // `actions`, `conditions` or a colour while its own comment claimed one row per thing read.
  for (const type of WIDGET_TYPES) {
    const definition = emptyWindowDefinition({ id: "shop", title: "Лавка" });
    const asked = new Set();
    const spy = new Proxy(newWidgetJson(type, "probe"), {
      get(target, key) {
        if (typeof key === "string") asked.add(key);
        return Reflect.get(target, key);
      },
    });
    screenOf(definition).children = [spy];
    assert.ok(parseWindowDefinition(definition, context).window, `${type} did not draw`);

    const offered = new Set(fieldsFor(type, false).map((spec) => spec.key.split(".")[0]));
    for (const key of asked) {
      assert.ok(offered.has(key) || key in WIDGET_FIELDS_OMITTED,
        `${type}: the parser reads "${key}" and the inspector neither offers it nor says why not`);
    }
    assert.ok(asked.size > 0, `${type}: the proxy recorded nothing, so this type proved nothing`);
  }

  // And the list of exclusions is not allowed to hold entries nothing reads: every name on it has
  // to be a key some type actually asks for, or it is a comment about a field that no longer exists.
  const everyKeyAsked = new Set();
  for (const type of WIDGET_TYPES) {
    const definition = emptyWindowDefinition({ id: "shop", title: "Лавка" });
    screenOf(definition).children = [new Proxy(newWidgetJson(type, "probe"), {
      get(target, key) {
        if (typeof key === "string") everyKeyAsked.add(key);
        return Reflect.get(target, key);
      },
    })];
    parseWindowDefinition(definition, context);
  }
  for (const key of Object.keys(WIDGET_FIELDS_OMITTED)) {
    assert.ok(everyKeyAsked.has(key), `"${key}" is written down as left out, and no widget type reads it`);
  }
});

/* ---------------------------------------------------------------------------------------------
 * М8: export
 * ------------------------------------------------------------------------------------------- */

test("export always offers the clipboard and only writes when the gateway lets it", async () => {
  const definition = windowWith([]);
  const target = { module: "shop", file: "shop.json", baseUrl: "http://127.0.0.1:8090" };
  const copies = [];
  const copy = (text) => { copies.push(text); };

  const asked = [];
  const answer = (status) => (url, init) => {
    asked.push({ url, method: init.method, body: init.body });
    return Promise.resolve({ status, ok: status >= 200 && status < 300 });
  };

  const written = await exportWindowDefinition(definition, target, { copy, fetch: answer(204) });
  assert.equal(written.kind, "written");
  assert.equal(written.copied, true);
  assert.equal(written.written, true);
  assert.equal(asked[0].url, "http://127.0.0.1:8090/modules/ui/shop/shop.json");
  assert.equal(asked[0].method, "PUT");
  assert.deepEqual(JSON.parse(asked[0].body), definition);
  assert.equal(copies[0], definitionText(definition));

  // The М6 route answers 405 with `allow: GET` when `MODULE_UI_WRITE` is unset or the request is
  // not from this machine. That is a switch rather than a fault, so it is reported in the words
  // that name the switch — and the clipboard still worked, which is the road that needs nothing.
  const refused = await exportWindowDefinition(definition, target, { copy, fetch: answer(405) });
  assert.equal(refused.kind, "refused");
  assert.equal(refused.copied, true);
  assert.equal(refused.written, false);
  assert.match(refused.message, /MODULE_UI_WRITE=1/);
  assert.match(refused.message, /буфере обмена/);

  const failed = await exportWindowDefinition(definition, target, { copy, fetch: answer(500) });
  assert.equal(failed.kind, "error");
  assert.match(failed.message, /500/);

  const offline = await exportWindowDefinition(definition, target, {
    copy, fetch: () => Promise.reject(new Error("шлюз не отвечает")),
  });
  assert.equal(offline.kind, "error");
  assert.match(offline.message, /шлюз недоступен: шлюз не отвечает/);

  // No gateway at all — the page before login, or a client served from a file — is the clipboard
  // and nothing else, and it is a success rather than a failure.
  const clipboardOnly = await exportWindowDefinition(definition, { ...target, baseUrl: "" }, { copy });
  assert.equal(clipboardOnly.kind, "clipboard");
  assert.equal(clipboardOnly.written, false);

  // And a clipboard that refuses is reported rather than swallowed: the author would otherwise
  // paste the previous window into their module.
  const noClipboard = await exportWindowDefinition(definition, { ...target, baseUrl: "" }, {
    copy: () => { throw new Error("нет разрешения"); },
  });
  assert.equal(noClipboard.copied, false);
  assert.match(noClipboard.message, /буфер обмена недоступен \(нет разрешения\)/);
});

/* ---------------------------------------------------------------------------------------------
 * М9: the module checker
 * ------------------------------------------------------------------------------------------- */

const screen = (children = [], extra = {}) => ({
  id: "root",
  type: "Frame",
  width: 200,
  height: 100,
  anchor: { point: "CENTER", relativeTo: "parent", relativePoint: "CENTER", x: 0, y: 0 },
  children,
  ...extra,
});

const goodWindow = (id) => ({ kind: "addon", id, format: 1, params: { screen: screen([]) } });

/** Writes a tree of `<module>/<kind>/<file>` under a fresh directory and hands back its root. */
async function tree(files) {
  const root = await mkdtemp(join(tmpdir(), "webclient-modcheck-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  }
  return root;
}

const check = async (root) => checkModules([{ root, inner: "", source: "override" }]);

test("a good module tree passes, and so does a machine with no modules at all", async () => {
  const empty = await mkdtemp(join(tmpdir(), "webclient-modcheck-"));
  try {
    const nothing = await check(empty);
    assert.deepEqual(nothing.problems, []);
    assert.equal(nothing.modules, 0);
    // The ordinary case on a machine that ships no modules, and it has to be exit 0 rather than a
    // build that fails because a directory is missing.
    assert.deepEqual(await checkModules([{ root: join(empty, "nothing-here"), inner: "", source: "override" }]),
      { problems: [], modules: 0, windows: 0, patches: 0, messages: 0, disabled: 0 });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }

  const root = await tree({
    "shop/messages/shop.json": {
      messages: [{ name: "shop.Buy", opcode: 4001, direction: "out", fields: [{ name: "entry", type: "u32" }] }],
    },
    "shop/ui/shop.json": {
      kind: "addon", id: "shop", format: 1,
      params: {
        slash: "shop",
        screen: screen([{
          id: "buy", type: "Button", width: 60, height: 20, text: "Купить",
          anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 4, y: -4 },
          actions: [{ do: "sendCustom", message: "shop.Buy", value: { entry: 1 } }],
        }]),
      },
    },
    "shop/ui/extras.json": {
      kind: "patch", id: "shop-extras", format: 1, target: "target-frame",
      hide: ["target-frame/details"],
      add: [{
        slot: "target-frame/actions",
        widget: {
          id: "shop-open", type: "Button", width: 40, height: 18, text: "Лавка",
          anchor: { point: "LEFT", relativeTo: "parent", relativePoint: "LEFT", x: 0, y: 0 },
          actions: [{ do: "open", window: "shop" }],
        },
      }],
      class: { "target-frame": "shop-skin" },
    },
  });
  try {
    const report = await check(root);
    assert.deepEqual(report.problems, []);
    assert.deepEqual(
      [report.modules, report.windows, report.patches, report.messages],
      [1, 1, 1, 1],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every category of half-working module file fails the check, naming the file", async () => {
  const cases = [
    {
      what: "a binding the client does not implement",
      files: {
        "shop/ui/shop.json": {
          kind: "addon", id: "shop", format: 1,
          params: { screen: screen([{
            id: "gold", type: "Text", width: 80, height: 16, bind: "playerGold",
            anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 0, y: 0 },
          }]) },
        },
      },
      file: "shop/ui/shop.json",
      says: /"bind" is "playerGold"/,
    },
    {
      what: "a widget type the client does not draw",
      files: {
        "shop/ui/shop.json": {
          kind: "addon", id: "shop", format: 1,
          params: { screen: screen([{
            id: "chart", type: "Chart", width: 80, height: 16,
            anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 0, y: 0 },
          }]) },
        },
      },
      file: "shop/ui/shop.json",
      says: /the type "Chart" is not one this client draws/,
    },
    {
      what: "a command no window may call",
      files: {
        "shop/ui/shop.json": {
          kind: "addon", id: "shop", format: 1,
          params: { screen: screen([{
            id: "go", type: "Button", width: 60, height: 20, text: "Жать",
            anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 0, y: 0 },
            actions: [{ do: "command", name: "deleteCharacter", args: [] }],
          }]) },
        },
      },
      file: "shop/ui/shop.json",
      says: /"deleteCharacter" is not one of the commands/,
    },
    {
      what: "a message field the button never sets",
      files: {
        "shop/messages/shop.json": {
          messages: [{ name: "shop.Buy", opcode: 4001, direction: "out", fields: [{ name: "entry", type: "u32" }] }],
        },
        "shop/ui/shop.json": {
          kind: "addon", id: "shop", format: 1,
          params: { screen: screen([{
            id: "buy", type: "Button", width: 60, height: 20, text: "Купить",
            anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 0, y: 0 },
            actions: [{ do: "sendCustom", message: "shop.Buy", value: {} }],
          }]) },
        },
      },
      file: "shop/ui/shop.json",
      says: /не задаёт поле "entry"/,
    },
    {
      what: "a slot no built-in window offers",
      files: {
        "shop/ui/extras.json": {
          kind: "patch", id: "extras", format: 1, target: "target-frame",
          hide: ["target-frame/portrait"],
        },
      },
      file: "shop/ui/extras.json",
      says: /слота "target-frame\/portrait" в этом клиенте нет/,
    },
    {
      what: "a window nobody defines",
      files: {
        "shop/ui/shop.json": {
          kind: "addon", id: "shop", format: 1,
          params: { screen: screen([{
            id: "go", type: "Button", width: 60, height: 20, text: "Жать",
            anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 0, y: 0 },
            actions: [{ do: "open", window: "bank" }],
          }]) },
        },
      },
      file: "shop/ui/shop.json",
      says: /открывает окно "bank", которого ни один загруженный модуль не объявил/,
    },
    {
      what: "two modules claiming one custom opcode",
      files: {
        "shop/messages/shop.json": {
          messages: [{ name: "shop.Buy", opcode: 4001, direction: "out", fields: [{ name: "entry", type: "u32" }] }],
        },
        "bank/messages/bank.json": {
          messages: [{ name: "bank.Open", opcode: 4001, direction: "out", fields: [{ name: "entry", type: "u32" }] }],
        },
      },
      file: "shop/messages/shop.json",
      says: /a custom opcode may only be claimed once/,
    },
    {
      what: "two modules calling their window by one id",
      files: { "shop/ui/shop.json": goodWindow("shop"), "bank/ui/bank.json": goodWindow("shop") },
      file: "shop/ui/shop.json",
      says: /окно "shop" уже объявлено/,
    },
    {
      what: "two windows answering one slash command",
      files: {
        // Named so that the walk's own order — files sorted by name — is unambiguous: `a.json`
        // takes the command and `b.json` is the one that would silently have none.
        "shop/ui/a.json": { kind: "addon", id: "first", format: 1, params: { slash: "buy", screen: screen([]) } },
        "shop/ui/b.json": { kind: "addon", id: "second", format: 1, params: { slash: "buy", screen: screen([]) } },
      },
      file: "shop/ui/b.json",
      says: /команда \/buy уже занята окном из shop\/ui\/a\.json/,
    },
    {
      what: "a file that is not JSON at all",
      files: { "shop/ui/shop.json": "{ half a file" },
      file: "shop/ui/shop.json",
      says: /JSON не читается/,
    },
    {
      what: "a definition of a kind this client does not read",
      files: { "shop/ui/shop.json": { kind: "screen", id: "shop", params: { screen: screen([]) } } },
      file: "shop/ui/shop.json",
      says: /"kind" is "screen"/,
    },
  ];

  for (const entry of cases) {
    const root = await tree(entry.files);
    try {
      const report = await check(root);
      assert.ok(report.problems.length > 0, `${entry.what}: nothing was reported`);
      const named = report.problems.filter((text) => text.startsWith(`${entry.file}:`));
      assert.ok(named.length > 0,
        `${entry.what}: no problem named ${entry.file}; got ${report.problems.join(" | ")}`);
      assert.ok(named.some((text) => entry.says.test(text)),
        `${entry.what}: ${entry.says} matched nothing in ${named.join(" | ")}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("«enabled»: false is a file the check does not read, in either direction", async () => {
  // The studio's own switch, and `ModuleLoader` returns on it before registering anything — so a
  // switched-off draft claims no id, no `/команда` and no opcode, and is not a place a button may
  // open. Judging one anyway was wrong twice over at once, and both halves are asserted here.
  const shipped = {
    kind: "addon", id: "shop", format: 1,
    params: { slash: "shop", screen: screen([]) },
  };

  // (1) The switched-off draft of a screen that ships: same id, same command, and a broken binding
  // besides. Nothing about it is a collision, because nothing about it is loaded.
  const beside = await tree({
    "shop/ui/shop.json": shipped,
    "shop/ui/shop-next.json": {
      kind: "addon", id: "shop", format: 1, enabled: false,
      params: { slash: "shop", screen: screen([{
        id: "gold", type: "Text", width: 80, height: 16, bind: "playerGold",
        anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 0, y: 0 },
      }]) },
    },
  });
  try {
    const report = await check(beside);
    assert.deepEqual(report.problems, []);
    // Counted and said out loud, so «проверка ничего не нашла» never quietly means «не смотрела».
    assert.equal(report.disabled, 1);
    assert.equal(report.windows, 1);
  } finally {
    await rm(beside, { recursive: true, force: true });
  }

  // (2) A switched-off patch naming a slot this client has not got: the same silence, for the same
  // reason — `#loadPatch` returns on `!patch.enabled` before it looks at a slot.
  const patch = await tree({
    "shop/ui/extras.json": {
      kind: "patch", id: "extras", format: 1, enabled: false, target: "target-frame",
      hide: ["target-frame/nowhere"],
    },
  });
  try {
    assert.deepEqual((await check(patch)).problems, []);
  } finally {
    await rm(patch, { recursive: true, force: true });
  }

  // (3) The other direction, and the one that mattered more: a live button opening a window that is
  // switched off. It passed while `enabled` was ignored — the id was in the set — and at run time
  // `windows.toggle("bank")` finds nothing and the button does nothing at all.
  const dangling = await tree({
    "shop/ui/shop.json": {
      kind: "addon", id: "shop", format: 1,
      params: { screen: screen([{
        id: "go", type: "Button", width: 60, height: 20, text: "В банк",
        anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 0, y: 0 },
        actions: [{ do: "open", window: "bank" }],
      }]) },
    },
    "bank/ui/bank.json": { kind: "addon", id: "bank", format: 1, enabled: false, params: { screen: screen([]) } },
  });
  try {
    const report = await check(dangling);
    assert.equal(report.problems.length, 1, report.problems.join(" | "));
    assert.match(report.problems[0], /shop\/ui\/shop\.json: .*открывает окно "bank"/);
  } finally {
    await rm(dangling, { recursive: true, force: true });
  }
});

test("a window and a patch may share a name; two patches may not", async () => {
  // The client holds them in two maps — `WindowRegistry.#windows` and `PatchRegistry.#patches` —
  // and a module calling its screen and the patch that edits it by one name is the ordinary case.
  // Reported as a collision for a while, which failed the build on a module that loads in silence.
  const shared = await tree({
    "shop/ui/shop.json": goodWindow("shop"),
    "shop/ui/skin.json": { kind: "patch", id: "shop", format: 1, target: "target-frame", class: { "target-frame": "s" } },
  });
  try {
    const report = await check(shared);
    assert.deepEqual(report.problems, []);
    assert.equal(report.windows, 1);
    assert.equal(report.patches, 1);
  } finally {
    await rm(shared, { recursive: true, force: true });
  }

  // Patch against patch is a real refusal, and the third of the checker's own three: `register`
  // answers «правка "skin" уже зарегистрирована модулем …» and the second edit never happens.
  const twice = await tree({
    "shop/ui/a.json": { kind: "patch", id: "skin", format: 1, target: "target-frame", class: { "target-frame": "a" } },
    "shop/ui/b.json": { kind: "patch", id: "skin", format: 1, target: "target-frame", class: { "target-frame": "b" } },
  });
  try {
    const report = await check(twice);
    assert.equal(report.problems.length, 1, report.problems.join(" | "));
    assert.match(report.problems[0], /shop\/ui\/b\.json: правка "skin" уже объявлена в shop\/ui\/a\.json/);
  } finally {
    await rm(twice, { recursive: true, force: true });
  }
});

test("npm run modules:check fails the build when a shipped window would half-work", async () => {
  // The acceptance, driven through the command line rather than through the function, because
  // «npm run build fails» is a fact about the exit code and about nothing else.
  const run = (root) => promisify(execFile)(
    process.execPath,
    [resolve(repositoryRoot, "tools/check-modules.mjs")],
    { cwd: repositoryRoot, env: { ...process.env, MODULE_DIRS: root } },
  );

  const good = await tree({ "shop/ui/shop.json": goodWindow("shop") });
  try {
    const { stdout } = await run(good);
    assert.match(stdout, /1 module\(s\): 1 window\(s\)/);
    assert.match(stdout, /No problems/);
  } finally {
    await rm(good, { recursive: true, force: true });
  }

  const bad = await tree({
    "shop/ui/shop.json": {
      kind: "addon", id: "shop", format: 1,
      params: { screen: screen([{
        id: "gold", type: "Text", width: 80, height: 16, bind: "playerGold",
        anchor: { point: "TOPLEFT", relativeTo: "parent", relativePoint: "TOPLEFT", x: 0, y: 0 },
      }]) },
    },
  });
  try {
    const failure = await run(bad).then(() => undefined, (error) => error);
    assert.ok(failure, "the check has to leave a non-zero exit code, or the build would not stop");
    assert.equal(failure.code, 1);
    assert.match(failure.stderr, /shop\/ui\/shop\.json: .*playerGold/);
    assert.match(failure.stderr, /found 1 problem\(s\)/);
  } finally {
    await rm(bad, { recursive: true, force: true });
  }

  // And the env override is real: with it unset the same command reads this machine's own modules,
  // which is what `npm run build` does.
  const { moduleDirectories } = await import("../tools/paths.mjs");
  assert.deepEqual(
    moduleDirectories().map((entry) => entry.source),
    ["draft", "module"],
    "no override means the two roots the gateway serves",
  );
});
