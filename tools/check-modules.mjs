import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { moduleDirectories, repositoryRoot } from "./paths.mjs";

/**
 * Reads every module definition on this machine the way the client will, and fails the build when
 * one of them would only half-work.
 *
 * A module ships JSON, and JSON is checked by whoever reads it. Until this existed, a window naming
 * a binding this client does not implement, a patch naming a slot no built-in offers, a `sendCustom`
 * with a field missing or a message schema whose opcode another module already claimed all did the
 * same thing: they loaded, they drew *something*, and the sentence saying what was wrong went into a
 * pane of the diagnostics window that nobody opens until the thing is already broken in front of a
 * player. Half of a window is worse than none, because nothing about it looks like a failure.
 *
 * ## What it checks, and why it is not a second implementation of anything
 *
 * Nothing here decides what is wrong. The walk is the gateway's own — `readModuleIndex` and
 * `readModuleFile` out of `dist/code`, so the files inspected are exactly the files the browser will
 * be handed, first-root-wins and all — and every judgement is made by the same functions the client
 * makes it with: `parseWindowDefinition`, `parseWindowPatch`, `parseCustomMessages`,
 * `CustomPacketRegistry.define`, `checkWindowActions`, `checkWindowPatch` and `patchTargetProblems`,
 * against `Slots.ts`'s own tables and `GameSounds.ts`'s own kits. The rule is one line: **any problem
 * any of them records is a build failure.** `WindowSchema`'s three levels — fatal, widget dropped,
 * noted — are levels of what the *player* gets; here they are all the same thing, because the author
 * is standing right here.
 *
 * Three checks are this file's own, and all three are about a collision between two files rather
 * than about one file: two windows that answer the same `/команда`, two windows with the same id,
 * and two *patches* with the same id. The client refuses the second of each at load — the chat
 * table by name, `WindowRegistry.register` by id, `PatchRegistry.register` by id — so a module that
 * ships any of them would be running with something silently missing.
 *
 * A window and a patch may share one name, and that is **not** a collision: the client holds them
 * in two separate maps, and a module that calls its screen and the patch which edits it by the same
 * name is the ordinary case — `ModuleLoader.ts` says so where it names a patch's inline stylesheet.
 * Reported as one for a while, which failed the build on a module the client loads without a word.
 *
 * ## `"enabled": false` is a file this check does not read
 *
 * The studio's own switch, and `ModuleLoader.ts:737` returns on it before registering anything:
 * «выключенный там экран не должен появляться здесь — иначе выключатель ничего не значит вне
 * студии». So a switched-off draft claims no id, no `/команда` and no opcode, defines no message,
 * and is not a place a `{"do": "open"}` may land. Judging one anyway was wrong in both directions at
 * once: it failed the build over a screen nobody loads, *and* it let a live button that opens a
 * switched-off window pass as though the window were there. What is switched off is counted and
 * said out loud in the summary, so «проверка ничего не нашла» never quietly means «не смотрела».
 *
 * ## Why a missing `dist/` is not a failure
 *
 * Because of where this sits in `npm run build`: after `tsc` and before `vite build`, so that the
 * parsers it imports are the ones just compiled. Run on its own in a tree that has never been built
 * it has nothing to read, and answering «the modules are broken» because the *client* has not been
 * compiled would be a lie about somebody else's files. It says what it did not do and exits 0.
 */

const distRoot = join(repositoryRoot, "dist", "code");

/** One problem, with the file it belongs to. */
function problem(where, text) {
  return `${where}: ${text}`;
}

/**
 * The studio's own switch, read off the raw JSON rather than off the parse.
 *
 * Both parsers spell it the same way — `enabled: raw["enabled"] !== false` — and reading it here
 * means a switched-off file is skipped even when it is *also* too broken to parse into anything.
 * A draft that does not load yet is exactly the file somebody switches off.
 */
function switchedOff(raw) {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) && raw["enabled"] === false;
}

async function loadClient() {
  const at = (path) => pathToFileURL(join(distRoot, path)).href;
  const [index, schema, actions, slots, codec, registry, sounds] = await Promise.all([
    import(at("gateway/ModuleIndex.js")),
    import(at("browser/ui/WindowSchema.js")),
    import(at("browser/ui/WindowActions.js")),
    import(at("browser/ui/Slots.js")),
    import(at("world/CustomCodec.js")),
    import(at("world/CustomPacketRegistry.js")),
    import(at("browser/game/GameSounds.js")),
  ]);
  return { index, schema, actions, slots, codec, registry, sounds };
}

export function moduleCheckReady() {
  return existsSync(join(distRoot, "browser", "ui", "WindowSchema.js"));
}

/**
 * Walks the roots and answers with everything wrong, plus what was counted on the way.
 *
 * Exported so the tests can drive it in-process: spawning a child per category of bad file is six
 * node start-ups for six assertions, and the acceptance — «the build fails» — is the one case that
 * genuinely has to go through the command line.
 */
export async function checkModules(roots) {
  const client = await loadClient();
  const { readModuleFile, readModuleIndex } = client.index;
  const { moduleUiKind, parseWindowDefinition, parseWindowPatch } = client.schema;
  const { checkWindowActions, checkWindowPatch } = client.actions;
  const { FILLABLE_SLOTS, SKINNABLE_WINDOWS, SLOT_NAMES } = client.slots;
  const { parseCustomMessages } = client.codec;
  const { CustomPacketRegistry } = client.registry;
  const { UI_SOUNDS } = client.sounds;

  const problems = [];
  const packets = new CustomPacketRegistry();
  const windows = [];
  const patches = [];
  let messageCount = 0;
  let disabledCount = 0;

  const index = await readModuleIndex(roots);

  const readJson = async (kind, module, file, where) => {
    const result = await readModuleFile(roots, kind, module, file);
    if (result.kind === "too-large") {
      problems.push(problem(where, `файл ${result.bytes} Б — больше того, что шлюз отдаёт модулю`));
      return undefined;
    }
    if (result.kind === "missing") {
      problems.push(problem(where, "файл перечислен в индексе и не читается"));
      return undefined;
    }
    try {
      return JSON.parse(result.data.toString("utf8"));
    } catch (error) {
      problems.push(problem(where, `JSON не читается: ${error instanceof Error ? error.message : String(error)}`));
      return undefined;
    }
  };

  // Message schemas before windows, exactly as the loader does it: a window may declare schemas
  // inline, an opcode may be claimed once, and whichever is registered first wins — so a module's
  // own `content/messages/*.json` has to beat a copy of the same message written into a screen.
  for (const entry of index.modules) {
    for (const file of entry.messages ?? []) {
      const where = `${entry.module}/messages/${file.file}`;
      const raw = await readJson("messages", entry.module, file.file, where);
      if (raw === undefined) continue;
      const parsed = parseCustomMessages(raw);
      for (const text of parsed.problems) problems.push(problem(where, text));
      const result = packets.define(parsed.messages, entry.module);
      for (const text of result.problems) problems.push(problem(where, text));
      messageCount += result.defined.length;
    }
  }

  for (const entry of index.modules) {
    for (const file of entry.windows ?? []) {
      const where = `${entry.module}/ui/${file.file}`;
      const raw = await readJson("ui", entry.module, file.file, where);
      if (raw === undefined) continue;
      if (switchedOff(raw)) {
        disabledCount++;
        continue;
      }
      if (moduleUiKind(raw) === "patch") {
        const parsed = parseWindowPatch(raw, { module: entry.module });
        for (const text of parsed.problems) problems.push(problem(where, text));
        if (parsed.patch) patches.push({ where, patch: parsed.patch });
        continue;
      }
      const parsed = parseWindowDefinition(raw, { module: entry.module });
      for (const text of parsed.problems) problems.push(problem(where, text));
      if (!parsed.window) continue;
      windows.push({ where, window: parsed.window });
      if (parsed.window.messages.length > 0) {
        const result = packets.define(parsed.window.messages, `${entry.module}/${parsed.window.id}`);
        for (const text of result.problems) problems.push(problem(where, text));
        messageCount += result.defined.length;
      }
    }
  }

  // The three collisions between files. Each is a refusal the client makes at load — the window
  // registry by id, the chat table by name, the patch registry by id — so a module shipping one
  // would be running with a window, a command or an edit silently missing. Windows and patches
  // count in **separate** maps, because the client holds them in separate maps: a screen and the
  // patch that edits it may share a name, and calling that a collision failed the build on a module
  // that loads without a word.
  const byId = new Map();
  const bySlash = new Map();
  const byPatchId = new Map();
  for (const { where, window } of windows) {
    const heldId = byId.get(window.id);
    if (heldId) problems.push(problem(where, `окно "${window.id}" уже объявлено в ${heldId}`));
    else byId.set(window.id, where);
    if (!window.slash) continue;
    const heldSlash = bySlash.get(window.slash);
    if (heldSlash) problems.push(problem(where, `команда /${window.slash} уже занята окном из ${heldSlash}`));
    else bySlash.set(window.slash, where);
  }
  for (const { where, patch } of patches) {
    const held = byPatchId.get(patch.id);
    if (held) problems.push(problem(where, `правка "${patch.id}" уже объявлена в ${held}`));
    else byPatchId.set(patch.id, where);
  }

  // And the checks that need every file to have been read: «this button opens a screen nobody
  // defines» has no answer until the last module has had its turn.
  const context = {
    windowIds: new Set(windows.map((entry) => entry.window.id)),
    message: (name) => packets.message(name),
    soundKits: new Set(Object.keys(UI_SOUNDS)),
    slotNames: new Set(SLOT_NAMES),
    fillableSlots: new Set(FILLABLE_SLOTS),
    skinnableWindows: new Set(SKINNABLE_WINDOWS),
  };
  for (const { where, window } of windows) {
    for (const text of checkWindowActions(window, context)) problems.push(problem(where, text));
  }
  for (const { where, patch } of patches) {
    for (const text of checkWindowPatch(patch, context)) problems.push(problem(where, text));
  }

  return {
    problems,
    modules: index.modules.length,
    windows: windows.length,
    patches: patches.length,
    messages: messageCount,
    disabled: disabledCount,
  };
}

async function main() {
  if (!moduleCheckReady()) {
    console.log("modules:check skipped: dist/code has not been built yet, so there are no parsers to check against.");
    return;
  }
  let roots;
  try {
    roots = moduleDirectories();
  } catch (error) {
    // `moduleDirectories()` throws when it cannot find the tswow install, and that is a fact about
    // this machine rather than about anybody's module files — the same reason a missing `dist/` is
    // not a failure here. Said out loud and skipped, because «модули сломаны» would be a lie.
    console.log(`modules:check skipped: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const report = await checkModules(roots);
  const counted = `${report.modules} module(s): ${report.windows} window(s),`
    + ` ${report.patches} patch(es), ${report.messages} message(s)`
    // Named rather than left out, so that a green check over a directory of switched-off drafts
    // cannot be mistaken for a green check over the files somebody meant to ship.
    + (report.disabled > 0 ? `, ${report.disabled} switched off and not read` : "");
  if (report.problems.length === 0) {
    console.log(`Checked ${counted}. No problems.`);
    return;
  }
  for (const text of report.problems) console.error(`  ${text}`);
  console.error(`Checked ${counted} and found ${report.problems.length} problem(s).`);
  console.error("A module window that half-works is worse than none: fix the files above or take them out.");
  process.exitCode = 1;
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry === import.meta.url) await main();
