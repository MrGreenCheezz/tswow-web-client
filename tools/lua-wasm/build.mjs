// ARC-4: builds src/browser/lua/lua51.wasm — PUC Lua 5.1.5 (third_party/lua-5.1.5) plus the C side of
// the Lua API facade (tools/lua-wasm/*.c) — with wasi-sdk 34.0, and writes tools/lua-wasm/BUILD.json.
//
//   .runtime/node/node.exe tools/lua-wasm/build.mjs [--exnref] [--out <path>] [--check]
//
// The toolchain is local only (.runtime/tools/wasi-sdk-34.0-x86_64-windows, 1.45 GB, not in git); the
// artifact and its manifest are committed, and tests/lua-wasm-artifact.test.mjs checks them without
// rebuilding. `--check` builds into a temporary file and fails unless it is byte-identical to the
// committed artifact (the build is deterministic).
//
// The Lua sources are copied into a scratch directory and patched there; every patch is a literal
// replacement that must match exactly once, so the list below is the complete set of changes to Lua.
// Line endings are normalised to LF before patching and before hashing.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const args = process.argv.slice(2);
const exnref = args.includes("--exnref");
const check = args.includes("--check");
const outArg = args.indexOf("--out");
const artifact = join(root, "src/browser/lua/lua51.wasm");
const luaSource = join(root, "third_party/lua-5.1.5/src");
const sdk = join(root, ".runtime/tools/wasi-sdk-34.0-x86_64-windows");
const clang = join(sdk, "bin/clang.exe");

/** The 26 files of the core and the libraries the VM opens (no lua.c/luac.c, io, package, linit). */
export const LUA_CORE = Object.freeze(["lapi", "lauxlib", "lbaselib", "lcode", "ldblib", "ldebug", "ldo", "ldump",
  "lfunc", "lgc", "llex", "lmathlib", "lmem", "lobject", "lopcodes", "loslib", "lparser", "lstate", "lstring",
  "lstrlib", "ltable", "ltablib", "ltm", "lundump", "lvm", "lzio"]);
export const WOW_SOURCES = Object.freeze(["wow_lua.c", "wowbit.c"]);

/** [file, find, replace, why] */
export const LUA_PATCHES = Object.freeze([
  ["luaconf.h",
    "#define lua_number2str(s,n)\tsprintf((s), LUA_NUMBER_FMT, (n))",
    "int wl_number2str(char *s, double n);\n#define lua_number2str(s,n)\twl_number2str((s),(n))",
    "Wow.exe converts numbers with MSVC's \"%.14g\": 1e+015, 1.#INF, -1.#IND (wow_lua.c)"],
  ["luaconf.h",
    "#define lua_number2int(i,d)\t((i)=(int)(d))\n#define lua_number2integer(i,d)\t((i)=(lua_Integer)(d))",
    "int wl_number2int(double d);\n#define lua_number2int(i,d)\t((i)=wl_number2int(d))\n#define lua_number2integer(i,d)\t((i)=(lua_Integer)wl_number2int(d))",
    "Wow.exe's lua_number2int is fld/fistp: round to nearest even, 0x80000000 out of range (no wasm trap)"],
  ["loslib.c",
    "#include \"lualib.h\"\n",
    "#include \"lualib.h\"\n\nstruct tm *wl_localtime(const time_t *t);\ntime_t wl_mktime(struct tm *tm);\n",
    "declarations of the host-time-zone helpers"],
  ["loslib.c", "static int os_execute (lua_State *L) {", "#if 0 /* arc4: not built */\nstatic int os_execute (lua_State *L) {",
    "os.execute/remove/rename/tmpname/getenv are not built (tmpnam does not exist on WASI)"],
  ["loslib.c", "static int os_clock (lua_State *L) {", "#endif\nstatic int os_clock (lua_State *L) {", "end of the block above"],
  ["loslib.c", "stm = localtime(&t);", "stm = wl_localtime(&t);",
    "wasi-libc has no time zones: local time = UTC + the host's offset (JS Date), as fengari's os.date"],
  ["loslib.c", "t = mktime(&ts);", "t = wl_mktime(&ts);", "same for os.time{...}"],
  ["loslib.c",
    "  {\"execute\",   os_execute},\n  {\"exit\",      os_exit},\n  {\"getenv\",    os_getenv},\n  {\"remove\",    os_remove},\n  {\"rename\",    os_rename},\n",
    "",
    "the glue preamble keeps only os.date/time/clock; dropping the rest keeps path_open & co. out of the imports"],
  ["loslib.c", "  {\"tmpname\",   os_tmpname},\n", "", "same"],
]);

export const BUILD_FLAGS = Object.freeze([
  "--target=wasm32-wasip1", "-O2", "-w", "-mexec-model=reactor", "-mnontrapping-fptoint", "-mbulk-memory",
  "-D_WASI_EMULATED_PROCESS_CLOCKS", "-mllvm", "-wasm-enable-sjlj",
  "-Wl,--no-entry", "-Wl,--stack-first", "-Wl,-z,stack-size=2097152",
]);

const lf = (path) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The vendored and the glue sources with the SHA-256 of their LF text, as the manifest records them. */
export function sourceHashes() {
  const entries = [];
  for (const name of readdirSync(luaSource).sort()) {
    if (name.endsWith(".c") || name.endsWith(".h")) entries.push([`third_party/lua-5.1.5/src/${name}`, sha(lf(join(luaSource, name)))]);
  }
  for (const name of WOW_SOURCES) entries.push([`tools/lua-wasm/${name}`, sha(lf(join(here, name)))]);
  return Object.fromEntries(entries);
}

function build(out) {
  const scratch = mkdtempSync(join(tmpdir(), "webclient-lua-wasm-"));
  try {
    for (const name of readdirSync(luaSource)) {
      if (name.endsWith(".h") || name.endsWith(".c")) writeFileSync(join(scratch, name), lf(join(luaSource, name)));
    }
    for (const [file, find, replace] of LUA_PATCHES) {
      const path = join(scratch, file);
      const text = readFileSync(path, "utf8");
      const count = text.split(find).length - 1;
      if (count !== 1) throw new Error(`patch for ${file} matched ${count} times: ${JSON.stringify(find).slice(0, 80)}`);
      writeFileSync(path, text.replace(find, replace));
    }
    for (const name of WOW_SOURCES) writeFileSync(join(scratch, name), lf(join(here, name)));
    const flags = [...BUILD_FLAGS, ...(exnref ? ["-mllvm", "-wasm-use-legacy-eh=false"] : []), `-I${scratch}`];
    // Relative source names, run from the scratch directory: the paths do not reach the output.
    const sources = [...LUA_CORE.map((name) => `${name}.c`), ...WOW_SOURCES];
    mkdirSync(dirname(out), { recursive: true });
    const result = spawnSync(clang, [...flags, ...sources, "-lsetjmp", "-lwasi-emulated-process-clocks", "-o", out],
      { cwd: scratch, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`clang failed with ${result.status}`);
    return flags.filter((flag) => !flag.startsWith("-I"));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = check ? join(mkdtempSync(join(tmpdir(), "webclient-lua-wasm-check-")), "lua51.wasm")
    : outArg >= 0 ? resolve(args[outArg + 1]) : artifact;
  const started = performance.now();
  const flags = build(out);
  const wasm = readFileSync(out);
  if (check) {
    const same = sha(wasm) === sha(readFileSync(artifact));
    console.log(same ? `lua51.wasm is reproducible (${sha(wasm)})` : `lua51.wasm differs: built ${sha(wasm)}, committed ${sha(readFileSync(artifact))}`);
    process.exitCode = same ? 0 : 1;
  } else if (out === artifact) {
    const module = new WebAssembly.Module(wasm);
    const clangVersion = spawnSync(clang, ["--version"], { encoding: "utf8" }).stdout.split("\n")[0].trim();
    const manifest = {
      artifact: "src/browser/lua/lua51.wasm",
      bytes: wasm.length,
      sha256: sha(wasm),
      toolchain: { sdk: "wasi-sdk 34.0 (x86_64-windows)", clang: clangVersion },
      exceptions: exnref ? "exnref (-wasm-use-legacy-eh=false)" : "legacy",
      flags: [...flags, "-lsetjmp", "-lwasi-emulated-process-clocks"],
      core: LUA_CORE,
      patches: LUA_PATCHES.map(([file, , , why]) => ({ file, why })),
      sources: sourceHashes(),
      imports: WebAssembly.Module.imports(module).map((entry) => `${entry.module}.${entry.name}`),
      exports: WebAssembly.Module.exports(module).map((entry) => entry.name),
    };
    writeFileSync(join(here, "BUILD.json"), JSON.stringify(manifest, null, 2) + "\n");
    console.log(`${relative(root, out)}: ${wasm.length} bytes, ${manifest.sha256}, ${Math.round(performance.now() - started)} ms`);
  } else {
    console.log(`${out}: ${wasm.length} bytes, ${sha(wasm)}`);
  }
}
