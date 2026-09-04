/**
 * Minimal ambient types for `fengari-interop`.
 *
 * Only the scalar marshalling half is declared, and that is deliberate. The
 * package's headline feature — `luaopen_js`, which installs a `js` global whose
 * `js.global` is the browser `window` — is **not** declared here and is never
 * opened by the glue runtime: the corpus it executes includes third-party
 * libraries (LibDeflate, AceSerializer) shipped inside the client's own patch
 * archives, and handing them the DOM would undo the capability boundary the
 * rest of `framexml_compat` maintains. `push`/`tojs` convert nil, booleans,
 * numbers and strings without the library loaded; anything else the glue
 * runtime marshals itself.
 */
declare module "fengari-interop" {
  import type { LuaState } from "fengari";

  /** Push a JS primitive (undefined/boolean/number/string) as a Lua value. */
  export function push(L: LuaState, value: undefined | boolean | number | string): void;
  /** Read a Lua value at `index`; tables and functions come back as proxies. */
  export function tojs(L: LuaState, index: number): unknown;
  export const FENGARI_INTEROP_VERSION: string;
}
