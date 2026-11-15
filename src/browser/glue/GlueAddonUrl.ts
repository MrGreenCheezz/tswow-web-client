/**
 * 3.46 (follow-up, 15.11): GetAddOnInfo's url as Wow.exe 3.3.5a 12340 has it on the glue screens (read-only Ghidra,
 * .runtime/re-2026-11-15/misc8 d3.c, d4.c, l1.txt, l4.txt):
 *
 * - While reading an add-on's TOC (0x5f86a0), a `## Secure:` line sets the record's secure flag through 0x8154e0; after
 *   the TOC, a secure add-on reads its `.pub` key (0x5f4ec0) and `Interface\AddOns\<n>\<n>.url` (0x5f4fb0 → 0x5f4b00):
 *   the text after the file's first `=`, trailing CR, LF and spaces cut, kept at the record's +0x30.
 * - GetAddOnInfo's fourth value (0x5f74b0) is that text, nil when it is empty or the record's status (+0x24) is 2 — a
 *   status only SMSG_ADDON_INFO sets (0x5f79a0: BANNED), which the glue screens have not seen yet. SMSG_ADDON_INFO may
 *   also bring a URL and write the file as "[InternetShortcut]\r\nURL=%s\r\n" (0x5f4b80); TrinityCore never sends one
 *   (WorldSession.cpp:1263).
 */

/** 0x8154e0's reading of a TOC flag, as the twin 0x815400 reads one: a leading 1–9, T or Y (any case) is on. */
export function glueTocFlag(value: string): boolean {
  const first = value.trimStart()[0] ?? "";
  if (/^[1-9TtYy]$/.test(first)) return true;
  return value.trim().toLowerCase() === "enabled";
}

/** Whether the TOC says `## Secure:` with a true value (the last such line wins, as the parser overwrites). */
export function glueTocSecure(toc: string): boolean {
  let secure = false;
  for (const raw of toc.split("\n")) {
    const match = /^##\s*Secure:(.*)$/i.exec(raw.replace(/\r$/, ""));
    if (match) secure = glueTocFlag(match[1]!.replace(/^[: ]+/, ""));
  }
  return secure;
}

/** 0x5f4b00: the text after the first `=`, trailing CR/LF/spaces cut; undefined when there is no `=` or nothing left. */
export function glueAddonUrlFromFile(text: string): string | undefined {
  const at = text.indexOf("=");
  if (at < 0) return undefined;
  const url = text.slice(at + 1).replace(/[\r\n ]+$/, "");
  return url.length > 0 ? url : undefined;
}
