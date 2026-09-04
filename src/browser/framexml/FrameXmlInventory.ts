/**
 * The shape of slice F1's deliverable: what the in-world corpus costs, in numbers.
 *
 * Kept as data rather than as console text, because three consumers read it — the dev page, the
 * dataset-dependent smoke that pins the ceilings, and the report a later slice compares against.
 * A number that only ever appeared in a `console.log` cannot be pinned, and a ceiling that is not
 * pinned does not come down.
 */

import type { FrameXmlTsAddonStatus } from "./FrameXmlTsAddonStatus.js";

export interface FrameXmlStubRecord {
  /** The global's name, or `Type:Method` for a widget method. */
  readonly name: string;
  /** How many times the stub was actually called during the load. */
  readonly calls: number;
  /** `file:line` where the corpus first reached for it, from a Lua traceback taken once. */
  readonly firstTouch: string;
  /** Static call sites in the corpus text, from the stub plan; 0 when only reached dynamically. */
  readonly sites: number;
  /** What the stub answers: `""` for nil, otherwise the promoted values. */
  readonly neutral: string;
}

/** A global the corpus read that the plan did *not* stub, so it stayed nil. */
export interface FrameXmlMissRecord {
  readonly name: string;
  readonly reads: number;
}

export interface FrameXmlLuaFailure {
  /** The chunk the loader was running, i.e. the file path or `Frame:OnLoad`. */
  readonly file: string;
  /** Line inside that chunk, when the message carries one. */
  readonly line: number;
  readonly message: string;
  /** How many times this exact failure was raised; a handler in a loop raises the same one. */
  readonly count: number;
  /**
   * Whether the corpus' own `_ERRORMESSAGE` took it.
   *
   * This distinction is the difference between an error census that is right and one that is off by
   * a factor of twenty-five. `BasicControls.xml` installs `seterrorhandler(_ERRORMESSAGE)` before
   * any screen loads, and from then on every error raised *inside a script handler* is delivered
   * there and never reaches the VM's own sink — measured, that is 385 of them against 15 that the
   * VM saw. Only a file-level failure is unhandled.
   */
  readonly handled: boolean;
}

export interface FrameXmlFileTiming {
  readonly chunk: string;
  readonly ms: number;
  readonly ok: boolean;
}

/** A stub that had to answer with something; each entry records the failure that forced it. */
export interface FrameXmlPromotion {
  readonly name: string;
  readonly values: readonly unknown[];
  readonly reason: string;
}

/** One neutral answer F2 installed, with how often the corpus actually took it. */
export interface FrameXmlNeutralRecord {
  readonly name: string;
  readonly group: string;
  /** What it answers, in one line. */
  readonly answer: string;
  /** Why that and not nil. */
  readonly reason: string;
  /** Calls during this load; 0 means the corpus never reached it. */
  readonly calls: number;
}

/** What the font-object surface cost and what it answered. */
export interface FrameXmlFontObjectCensus {
  /** `<Font>` plus virtual `<FontString>` names the corpus declares. */
  readonly declared: number;
  /** Of those, the ones the corpus actually read as a global. */
  readonly reached: number;
  /** Font-API method calls, by name. */
  readonly methodCalls: readonly { readonly name: string; readonly calls: number }[];
  /** Widget methods rewritten so a font *object* can be passed where a name is stored. */
  readonly interopWraps: number;
  /** The objects the corpus read, with what `GetFont()` answers for each. */
  readonly resolved: readonly {
    readonly name: string;
    readonly file: string;
    readonly height: number;
    readonly flags: string;
  }[];
}

export interface FrameXmlInventory {
  readonly tsAddons: readonly FrameXmlTsAddonStatus[];
  readonly toc: string;
  readonly tocEntries: number;
  readonly files: {
    readonly total: number;
    readonly lua: number;
    readonly xml: number;
    readonly blizzard: number;
    readonly addon: number;
    readonly bytes: number;
    readonly addonBytes: number;
    readonly missing: readonly string[];
  };
  readonly xml: {
    readonly parsed: number;
    readonly failed: readonly { readonly file: string; readonly reason: string }[];
    /** Top-level declarations dropped because the element name is not a known widget type. */
    readonly unknownDeclarations: readonly { readonly name: string; readonly count: number }[];
  };
  readonly lua: {
    readonly executed: number;
    readonly failed: number;
    /** Every error raised anywhere during the load, handled or not. */
    readonly errorsRaised: number;
    /** Chunks that only lexed under Lua 5.1's unknown-escape rule. */
    readonly relaxed: readonly string[];
  };
  readonly widgets: {
    readonly total: number;
    readonly roots: number;
    readonly named: number;
    readonly templates: number;
    readonly fonts: number;
    readonly models: number;
    readonly byType: readonly { readonly type: string; readonly count: number }[];
  };
  readonly errors: readonly FrameXmlLuaFailure[];
  /** The gold list: every stubbed C-API global the corpus called, by call count. */
  readonly api: readonly FrameXmlStubRecord[];
  /** Every widget method the corpus called that the widget layer does not implement. */
  readonly methods: readonly FrameXmlStubRecord[];
  /** Globals read but never stubbed — the corpus' own probes, and its ordering mistakes. */
  readonly misses: readonly FrameXmlMissRecord[];
  /**
   * Reads of `this`/`event`/`arg1..9`, which the invoke helper makes and the corpus does not.
   *
   * Kept out of `misses` because they would otherwise be its ten largest entries and mean nothing.
   * Divided by eleven, this is roughly the number of handler dispatches the load performed.
   */
  readonly handlerEnvironmentReads: number;
  readonly plan: {
    readonly apiNames: number;
    readonly apiCallSites: number;
    readonly methodNames: number;
    readonly methodCallSites: number;
    readonly definedGlobals: number;
    readonly attachedMethods: number;
    readonly chunks: number;
  };
  readonly promotions: readonly FrameXmlPromotion[];
  /**
   * Slice F2's neutral API, and how much of it the corpus reached.
   *
   * An entry with 0 calls is not dead weight to be deleted quietly — it is the
   * measurement that the name was worth declaring and the corpus did not get
   * there, which is what the next slice's exercise has to change.
   */
  readonly neutral: readonly FrameXmlNeutralRecord[];
  readonly fonts: FrameXmlFontObjectCensus;
  /**
   * Slice F3's own census: what the secure-attribute store and the world seam did.
   *
   * Separate from `neutral` because these are not answers to a name — they are a mechanism that
   * either ran or did not, and «1,672 calls landed in a store» is a different fact from «a global
   * answered 0».
   */
  readonly secure: {
    /** Method-table entries F3 wrote (`SetAttribute`/`GetAttribute` per type, `SetCooldown`). */
    readonly installs: number;
    readonly setAttributeCalls: number;
    readonly getAttributeCalls: number;
    readonly setCooldownCalls: number;
    /** `OnAttributeChanged` handlers that ran because an attribute was written. */
    readonly attributeDispatches: number;
    /** Frames carrying at least one attribute when the load finished. */
    readonly framesWithAttributes: number;
    /** Attributes declared in XML `<Attributes>` blocks, which F1 and F2 dropped entirely. */
    readonly declaredInXml: number;
    /** Which seam answered, or "" when the boot ran with F2's neutral world. */
    readonly seam: string;
    /** Seam-backed globals the corpus actually called, and how often. */
    readonly seamCalls: readonly { readonly name: string; readonly calls: number }[];
  };
  /**
   * What the first four frames of a live client add to the census.
   *
   * A TOC walk only runs `OnLoad`. The client then shows `UIParent` and delivers
   * `VARIABLES_LOADED`, `ADDON_LOADED`, `PLAYER_LOGIN` and `PLAYER_ENTERING_WORLD`, and that is
   * where most of the in-world API is actually reached — so the two are counted separately rather
   * than blurred into one number.
   */
  readonly exercise: {
    readonly events: readonly string[];
    /** Handlers the events reached, summed. */
    readonly dispatched: number;
    readonly apiBefore: number;
    readonly apiAfter: number;
    readonly methodsBefore: number;
    readonly methodsAfter: number;
    readonly errorsBefore: number;
    readonly errorsAfter: number;
  };
  /**
   * What the corpus needs from the VM itself, as opposed to from the C API.
   *
   * `setfenv`/`getfenv` decide whether the glue VM's Lua 5.3 core can carry FrameXML at all, so
   * they are counted here rather than being left to the gold list.
   */
  readonly vm: {
    readonly setfenvSites: readonly string[];
    readonly getfenvSites: readonly string[];
    readonly loadstringSites: readonly string[];
    readonly newproxySites: readonly string[];
    readonly addedShims: readonly string[];
  };
  readonly timings: {
    readonly scanMs: number;
    readonly planMs: number;
    readonly loadMs: number;
    readonly totalMs: number;
    readonly slowest: readonly FrameXmlFileTiming[];
  };
}

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

/** One screen of the inventory, for the dev page and the smoke's console line. */
export function formatFrameXmlInventory(inventory: FrameXmlInventory, top = 30): string {
  const lines: string[] = [];
  const f = inventory.files;
  lines.push(`TOC ${inventory.toc} — ${inventory.tocEntries} записей`);
  for (const addon of inventory.tsAddons) {
    lines.push(`TSWoW ${addon.module}: ${addon.ok ? "файлы выполнены" : addon.errors.join("; ")}`);
  }
  lines.push(`файлы: ${f.total} (lua ${f.lua}, xml ${f.xml}); Blizzard ${f.blizzard}, `
    + `модули сервера ${f.addon}; ${(f.bytes / 1024).toFixed(0)} КиБ `
    + `(из них модули ${(f.addonBytes / 1024).toFixed(0)} КиБ); отсутствуют ${f.missing.length}`);
  lines.push(`XML: разобрано ${inventory.xml.parsed}, отвергнуто ${inventory.xml.failed.length}; `
    + `Lua: выполнено ${inventory.lua.executed}, с ошибкой ${inventory.lua.failed}, `
    + `всего исключений ${inventory.lua.errorsRaised} (различных ${inventory.errors.length})`);
  lines.push(`виджеты ${inventory.widgets.total} (корней ${inventory.widgets.roots}, `
    + `именованных ${inventory.widgets.named}), шаблоны ${inventory.widgets.templates}, `
    + `шрифты ${inventory.widgets.fonts}, модели ${inventory.widgets.models}`);
  lines.push(`план заглушек: ${inventory.plan.apiNames} глобалов / `
    + `${inventory.plan.apiCallSites} мест вызова, ${inventory.plan.methodNames} методов / `
    + `${inventory.plan.methodCallSites} мест`);
  lines.push(`время: скан ${inventory.timings.scanMs.toFixed(0)} мс, план `
    + `${inventory.timings.planMs.toFixed(0)} мс, загрузка ${inventory.timings.loadMs.toFixed(0)} мс`);
  lines.push(`прогон (${inventory.exercise.events.join(", ")}): хендлеров `
    + `${inventory.exercise.dispatched}; C-API ${inventory.exercise.apiBefore} → `
    + `${inventory.exercise.apiAfter}, методы ${inventory.exercise.methodsBefore} → `
    + `${inventory.exercise.methodsAfter}, ошибки ${inventory.exercise.errorsBefore} → `
    + `${inventory.exercise.errorsAfter}`);
  const answered = inventory.neutral.filter((entry) => entry.calls > 0);
  const answeredCalls = answered.reduce((sum, entry) => sum + entry.calls, 0);
  lines.push(`шрифтовые объекты: объявлено ${inventory.fonts.declared}, прочитано `
    + `${inventory.fonts.reached}, обёрнуто методов виджетов ${inventory.fonts.interopWraps}; `
    + `вызовы Font-API ${inventory.fonts.methodCalls.map((entry) => `${entry.name}×${entry.calls}`)
      .join(", ") || "нет"}`);
  lines.push(`нейтральный API: объявлено ${inventory.neutral.length} имён, достигнуто `
    + `${answered.length}, отвечено на ${answeredCalls} вызовов`);
  const secure = inventory.secure;
  lines.push(`защищённые атрибуты: методов установлено ${secure.installs}, `
    + `Set ${secure.setAttributeCalls} / Get ${secure.getAttributeCalls}, `
    + `OnAttributeChanged ${secure.attributeDispatches}, фреймов с атрибутами `
    + `${secure.framesWithAttributes} (из XML ${secure.declaredInXml}); `
    + `SetCooldown ${secure.setCooldownCalls}`);
  lines.push(`мировой шов: ${secure.seam || "нет (нейтральный мир F2)"}`
    + (secure.seamCalls.length > 0
      ? `; отвечено ${secure.seamCalls.reduce((sum, entry) => sum + entry.calls, 0)} вызовов на `
        + `${secure.seamCalls.length} именах`
      : ""));
  lines.push("");
  const unanswered = inventory.api.filter((entry) => entry.neutral === "");
  lines.push(`ЗОЛОТОЙ СПИСОК — C-API (${inventory.api.length} достигнуто, из них отвечено `
    + `${inventory.api.length - unanswered.length}, БЕЗ ОТВЕТА ${unanswered.length}; топ ${top}):`);
  for (const entry of inventory.api.slice(0, top)) {
    lines.push(`  ${pad(entry.calls, 6)}  ${entry.name}${entry.neutral ? ` → ${entry.neutral}` : ""}`
      + `   ${entry.firstTouch}`);
  }
  lines.push("");
  lines.push(`МЕТОДЫ ВИДЖЕТОВ (${inventory.methods.length} вызванных заглушек, топ ${top}):`);
  for (const entry of inventory.methods.slice(0, top)) {
    lines.push(`  ${pad(entry.calls, 6)}  ${entry.name}   ${entry.firstTouch}`);
  }
  lines.push("");
  lines.push(`ОШИБКИ LUA (${inventory.errors.length} различных, `
    + `${inventory.lua.errorsRaised} срабатываний):`);
  for (const error of inventory.errors.slice(0, 60)) {
    lines.push(`  ${pad(error.count, 5)}${error.handled ? " H" : " ·"}  `
      + `${error.file}:${error.line}: ${error.message}`);
  }
  lines.push("");
  lines.push(`НЕЙТРАЛЬНЫЙ API F2 (${answered.length} из ${inventory.neutral.length} достигнуто):`);
  for (const entry of [...answered].sort((left, right) => right.calls - left.calls)) {
    lines.push(`  ${pad(entry.calls, 6)}  ${entry.name} → ${entry.answer}   [${entry.group}]`);
  }
  const untouched = inventory.neutral.filter((entry) => entry.calls === 0).map((entry) => entry.name);
  if (untouched.length > 0) {
    lines.push(`  не достигнуто за этот прогон (${untouched.length}): ${untouched.join(", ")}`);
  }
  if (inventory.xml.unknownDeclarations.length > 0) {
    lines.push("");
    lines.push("НЕИЗВЕСТНАЯ ГРАММАТИКА (объявления верхнего уровня):");
    for (const entry of inventory.xml.unknownDeclarations) {
      lines.push(`  ${pad(entry.count, 6)}  ${entry.name}`);
    }
  }
  return lines.join("\n");
}
