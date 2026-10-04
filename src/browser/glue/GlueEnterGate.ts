/**
 * What stops a character from entering the world before anything is sent — the checks at the top of
 * the client's EnterWorld (FUN_004d9bd0 in Wow.exe 12340), in its order:
 *
 * 1. `CHARACTER_LOCKED_FOR_TRANSFER` (0x4): OKAY with code 84's text, `CHAR_LOGIN_LOCKED_FOR_TRANSFER`.
 * 2. `CHARACTER_FLAG_LOCKED_BY_BILLING` (0x01000000): OKAY with code 85's, `CHAR_LOGIN_LOCKED_BY_BILLING`.
 * 3. `CHARACTER_FLAG_RENAME` (0x4000): FORCE_RENAME_CHARACTER with `CHAR_RENAME_DESCRIPTION`.
 * 4. No `CHARACTER_FLAG_DECLINED` (0x02000000), a ruRU client (locale index 8, FUN_0076dd20) and a
 *    name the client takes for Russian (FUN_0076e270; here: a Cyrillic first letter, the core's own
 *    `isCyrillicCharacter(wname[0])` test): FORCE_DECLINE_CHARACTER with no argument, which shows the
 *    declension frame. Only when the caller names the character and the locale (the glue screens).
 *
 * The flag values are the core's (`Player.cpp` `CharacterFlags`). Both front doors ask this one
 * function: the glue screens' `EnterWorld()` and the DOM character card's «Войти в мир», which has
 * no rename dialog of its own and says so instead. A character the core would refuse is never sent:
 * it would load it only to kick it, and the screen would loop «disconnected → character select».
 *
 * Pure and import-free, so `app/EnterWorld.ts` can use it without pulling in the glue runtime.
 */

export const CHARACTER_LOCKED_FOR_TRANSFER = 0x00000004;
export const CHARACTER_FLAG_RENAME = 0x00004000;
export const CHARACTER_FLAG_LOCKED_BY_BILLING = 0x01000000;
export const CHARACTER_FLAG_DECLINED = 0x02000000;

export type EnterWorldRefusal =
  /** A locked character: the client's OKAY dialog with the text for `code`. */
  | { readonly kind: "locked"; readonly code: 84 | 85; readonly key: string; readonly text: string }
  /** A character that needs a new name first. */
  | { readonly kind: "rename"; readonly key: "CHAR_RENAME_DESCRIPTION"; readonly text: string }
  /** A Russian name with no declension yet: the declension frame first. */
  | { readonly kind: "decline"; readonly text: string };

/** What the declension step needs to know; without it the step is skipped (the DOM card). */
export interface EnterWorldDeclension {
  readonly name: string;
  readonly locale: string;
}

/** The first letter of a name the client would decline: Cyrillic, as the core checks it. */
export function declinableName(name: string): boolean {
  const first = name.codePointAt(0) ?? 0;
  return first >= 0x0400 && first <= 0x04ff;
}

export function enterWorldRefusal(flags: number, declension?: EnterWorldDeclension): EnterWorldRefusal | undefined {
  if ((flags & CHARACTER_LOCKED_FOR_TRANSFER) !== 0) {
    return {
      kind: "locked", code: 84, key: "CHAR_LOGIN_LOCKED_FOR_TRANSFER",
      text: "Вход этим персонажем невозможен, пока не завершится его перенос.",
    };
  }
  if ((flags & CHARACTER_FLAG_LOCKED_BY_BILLING) !== 0) {
    return {
      kind: "locked", code: 85, key: "CHAR_LOGIN_LOCKED_BY_BILLING",
      text: "Персонаж заблокирован из-за оплаты учётной записи.",
    };
  }
  if ((flags & CHARACTER_FLAG_RENAME) !== 0) {
    return {
      kind: "rename", key: "CHAR_RENAME_DESCRIPTION",
      text: "Этому персонажу нужно новое имя. Смените его на экране выбора персонажа.",
    };
  }
  if (declension && (flags & CHARACTER_FLAG_DECLINED) === 0 && declension.locale === "ruRU"
    && declinableName(declension.name)) {
    return { kind: "decline", text: "Сначала укажите падежи имени персонажа." };
  }
  return undefined;
}
