/**
 * Secure attributes: how the client spells a name, and in what order it looks one up.
 *
 * Slice F1 recorded `SetAttribute`/`GetAttribute` as the largest single hole in the in-world
 * surface — **1,672 calls across four widget types**, all of them recording no-ops. This module is
 * the semantics half of closing it; the storage half is one `Map` per frame
 * (`FrameXmlFrame.secureAttributes`) and the Lua half is in `src/browser/framexml/`.
 *
 * Two rules, and both are measured against this client's own corpus rather than taken from a wiki.
 *
 * **Names are case-insensitive.** That is the client's rule, and it is the reason a key is
 * normalised at all. Measured over the 335 files: 152 literal `SetAttribute("…")` sites naming 74
 * distinct attributes and 128 literal `GetAttribute("…")` sites naming 69 — and **zero** names that
 * differ only by case between the two sets. So this normalisation is free on this corpus: it
 * changes no lookup that the corpus performs today, and it is here because the API is what it is
 * and an add-on writing `chattype` for `chatType` must find it.
 *
 * **The three-argument form is a wildcard cascade.** `Frame:GetAttribute(prefix, name, suffix)` is
 * not a convenience for concatenating; it is a five-step fallback, and the whole secure action
 * button rests on it. `SecureTemplates.lua:160` is the single call site that matters —
 * `local value = frame:GetAttribute(prefix, name, suffix)` inside
 * `SecureButton_GetModifiedAttribute` — where `prefix` is the modifier string
 * (`""`, `"shift-"`, `"ctrl-alt-"`) and `suffix` is the mouse button (`"1"`, `"2"`). The
 * wildcard spellings only mean anything under this cascade, and the corpus writes them: measured
 * outside comments, `SecureUnitButton_OnLoad` sets `*type1` and `*type2`
 * (`SecureTemplates.lua:556-557`) and `SecureButton_GetModifiedAttribute` reads `useparent*`
 * (`:162`). Every other `*`-spelling in the corpus is inside the long comment block at
 * `SecureTemplates.lua:239-279` that documents this very cascade.
 *
 * There is **no taint system here, and that is deliberate**: this client *is* the host. In 3.3.5
 * the point of a secure attribute is that Blizzard code can write one and add-on code cannot, and
 * `issecure()` is what tells them apart. `GlueLua.ts` answers `issecure()` honestly (this VM runs
 * no untrusted add-on: every chunk it executes came out of the client's own MPQ chain through the
 * gateway), so `ActionButton_ShowGrid`'s `if ( issecure() ) then` branch is taken and the attribute
 * is written, which is the behaviour the real client has for its own code. What is *not* modelled
 * is an add-on being refused — and nothing in this repository loads one.
 */

/**
 * The storage key for an attribute name, or `undefined` for a name that is not one.
 *
 * Lower-cased, and nothing else: the client does not trim, and `SetAttribute(" type", …)` is a
 * different attribute from `SetAttribute("type", …)` in the real client too.
 */
export function frameXmlAttributeKey(name: unknown): string | undefined {
  return typeof name === "string" ? name.toLowerCase() : undefined;
}

/**
 * The five candidate keys of `GetAttribute(prefix, name, suffix)`, in the client's own order.
 *
 * 1. `prefix..name..suffix` — the exact spelling the caller asked for.
 * 2. `prefix..name.."*"` — this modifier, any button.
 * 3. `"*"..name..suffix` — any modifier, this button.
 * 4. `"*"..name.."*"` — any modifier, any button.
 * 5. `name` — the unqualified attribute.
 *
 * Worked through the vertical: `ActionButton_CalculateAction` asks for `actionpage` with prefix
 * `""` and suffix `"1"`, so the candidates are `actionpage1`, `actionpage*`, `*actionpage1`,
 * `*actionpage*`, `actionpage` — and `MultiBarBottomLeft`'s XML
 * `<Attribute name="actionpage" type="number" value="6"/>` is found by the fifth, through the
 * `useparent-actionpage` hop onto the parent.
 *
 * Duplicates are not filtered: with an empty prefix and suffix the first and last candidates are
 * the same string, and a lookup that finds nothing under the first finds nothing under the last.
 */
export function frameXmlAttributeCandidates(
  prefix: unknown,
  name: unknown,
  suffix: unknown,
): readonly string[] {
  const base = frameXmlAttributeKey(name);
  if (base === undefined) return [];
  const head = frameXmlAttributeKey(prefix) ?? "";
  const tail = frameXmlAttributeKey(suffix) ?? "";
  return [
    `${head}${base}${tail}`,
    `${head}${base}*`,
    `*${base}${tail}`,
    `*${base}*`,
    base,
  ];
}

/**
 * The value an XML `<Attribute name= type= value=/>` declares.
 *
 * `type` is one of `string`, `number`, `boolean` in this corpus' fourteen declarations
 * (`MultiActionBars.xml` four `number`s, `SecureTemplates.xml` four `boolean`s, `UIParent.xml`
 * six `number`s), and an absent `type` means `string` — which is the schema's own default in
 * `UI.xsd`. A `number` that will not parse stays a string rather than becoming `NaN`, because a
 * NaN in `(page - 1) * NUM_ACTIONBAR_BUTTONS` is silently wrong where a string raises.
 */
export function frameXmlAttributeValue(
  type: string | undefined,
  value: string | undefined,
): string | number | boolean {
  const text = value ?? "";
  const kind = (type ?? "string").trim().toLowerCase();
  if (kind === "number") {
    const number = Number(text);
    return Number.isFinite(number) ? number : text;
  }
  if (kind === "boolean") return /^(?:1|true|yes)$/i.test(text.trim());
  return text;
}
