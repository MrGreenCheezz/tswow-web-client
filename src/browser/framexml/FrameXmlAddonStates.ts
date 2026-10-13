/**
 * 3.46 (13.10): why an installed add-on can or cannot load, as Wow.exe 3.3.5a 12340 answers it in GetAddOnInfo's
 * fifth and sixth values and LoadAddOn's reason (read-only Ghidra, .runtime/re-2026-10-11/glue-1110/a347-3.txt,
 * 1013-q1.txt):
 *
 * - The world's GetAddOnInfo (0x00511240): name, title, notes, then «enabled» (0x005f7d70 for the character: 1 or nil),
 *   then — for an add-on already loaded (0x005f7650, +0x19) 1 and nil; otherwise 0x005f7e90(addon, allowLoD 1) — 1 or
 *   nil and the reason, then the security («INSECURE» for an add-on of the AddOns folder).
 * - 0x005f7e90's order: not in the list — MISSING (reason 1 of the table at 0x00ad17b4: LOADABLE, MISSING, DISABLED,
 *   BANNED, CORRUPT, INSECURE, DEMAND_LOADED, INTERFACE_VERSION, INCOMPATIBLE); already being checked (+0x2d, a
 *   dependency cycle) — loadable; not enabled — DISABLED; banned (+0x24 = 2) — BANNED; corrupt (+0x2a) — CORRUPT;
 *   `## Interface` below 20000 (+0x1c) — INCOMPATIBLE; not 30300 (0x765c) while the `checkAddonVersion` CVar is on
 *   (DAT_00b2f978 +0x30; «Load out of date AddOns» unticked) — INTERFACE_VERSION; then each dependency not loaded
 *   yet must be loadable the same way, and the first that is not makes the answer «DEP_» and its reason
 *   (0x005f4c40's "DEP_%s", the innermost dependency's); with allowLoD a load-on-demand add-on is loadable.
 *
 * Not modelled: BANNED and CORRUPT (nothing here is either), a TOC's `## DefaultState` for an add-on no profile
 * names, per-character states (the gateway's profile is one for all characters).
 */

/** 0x765c: the interface version Wow.exe 3.3.5a accepts without the out-of-date switch. */
export const FRAMEXML_CURRENT_INTERFACE = 30300;
/** Below this an add-on is INCOMPATIBLE whatever the switch says. */
const OLDEST_INTERFACE = 20000;

/** What the reason reads, by lower-case add-on name. */
export interface FrameXmlAddonStateSource {
  installed(lower: string): boolean;
  /** Disabled by the profile (AddOns.txt) or by DisableAllAddOns this session. */
  disabled(lower: string): boolean;
  loaded(lower: string): boolean;
  /** The add-on's TOC text; undefined while it is not known (its version and dependencies are not judged). */
  toc(lower: string): string | undefined;
  /** The `checkAddonVersion` CVar (Wow.exe default "1"). */
  readonly checkAddonVersion: boolean;
}

function tocValues(source: string, wanted: (key: string) => boolean): string[] {
  const values: string[] = [];
  for (const raw of source.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("##") || line.startsWith("###")) continue;
    const separator = line.indexOf(":", 2);
    if (separator < 0) continue;
    if (wanted(line.slice(2, separator).trim().toLowerCase())) values.push(line.slice(separator + 1).trim());
  }
  return values;
}

/** `## Interface:` as a number (atoi: leading digits, else 0). */
export function frameXmlAddonInterface(toc: string): number {
  const value = tocValues(toc, (key) => key === "interface")[0] ?? "";
  const digits = /^\d+/.exec(value);
  return digits ? Number(digits[0]) : 0;
}

/** `## Dependencies`, `## RequiredDeps` and any `## Dep…` tag: the names, in order, once each. */
export function frameXmlAddonDependencies(toc: string): string[] {
  const names: string[] = [];
  for (const value of tocValues(toc, (key) => key === "requireddeps" || key.startsWith("dep"))) {
    for (const raw of value.split(/[,\s]+/)) {
      const name = raw.trim();
      if (name !== "" && !names.some((known) => known.toLowerCase() === name.toLowerCase())) names.push(name);
    }
  }
  return names;
}

/** 0x005f7e90 with allowLoD 1: the reason `name` cannot load, or undefined when it can. */
export function frameXmlAddonLoadReason(source: FrameXmlAddonStateSource, name: string): string | undefined {
  const checking = new Set<string>();
  const walk = (lower: string): string | undefined => {
    if (!source.installed(lower)) return "MISSING";
    if (checking.has(lower)) return undefined;
    if (source.disabled(lower)) return "DISABLED";
    const toc = source.toc(lower);
    if (toc === undefined) return undefined;
    const version = frameXmlAddonInterface(toc);
    if (version < OLDEST_INTERFACE) return "INCOMPATIBLE";
    if (version !== FRAMEXML_CURRENT_INTERFACE && source.checkAddonVersion) return "INTERFACE_VERSION";
    checking.add(lower);
    try {
      for (const dependency of frameXmlAddonDependencies(toc)) {
        const dependencyLower = dependency.toLowerCase();
        if (source.loaded(dependencyLower)) continue;
        const reason = walk(dependencyLower);
        if (reason !== undefined) return reason.startsWith("DEP_") ? reason : `DEP_${reason}`;
      }
    } finally {
      checking.delete(lower);
    }
    return undefined;
  };
  return walk(name.toLowerCase());
}
