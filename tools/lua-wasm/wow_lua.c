/*
 * ARC-4: the C side of the Lua API facade over PUC Lua 5.1.5 in WebAssembly (src/browser/lua/LuaApi.ts;
 * built by tools/lua-wasm/build.mjs, first written as the P2-12 prototype, .runtime/perf-step23/arc4).
 *
 * Exports are the 5.1 C API calls the facade needs (lua_* are re-exported by name through
 * wl_* wrappers where 5.1 and fengari's 5.3 differ: getters answer the type, strings travel as
 * pointer + length), the shims 5.1 lacks (traceback, argerror without a throw) and the trampoline
 * that lets a JavaScript function be a Lua C function.
 *
 * Errors: a JS host function never unwinds wasm frames. It reports an error by leaving the error
 * value on the stack and answering -1; wl_tramp then calls lua_error itself, after the JS frames
 * have returned, so the longjmp (a wasm exception, -mllvm -wasm-enable-sjlj) unwinds wasm only.
 */
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "lua.h"
#include "lauxlib.h"
#include "lualib.h"
#include "lstate.h"

#define EXPORT(n) __attribute__((export_name(n)))
#define IMPORT(n) __attribute__((import_module("env"), import_name(n)))

IMPORT("wl_host_call") extern int wl_host_call(lua_State *L, int index);
IMPORT("wl_tz_offset") extern double wl_tz_offset(double t);

int luaopen_wowbit(lua_State *L);

/* ---------------------------------------------------------------- number conversions (luaconf.h) */

/* Wow.exe's lua_Number -> string is MSVC's sprintf("%.14g"): three exponent digits, 1.#INF, -1.#IND. */
int wl_number2str(char *s, double n) {
  if (n != n) { memcpy(s, "-1.#IND", 8); return 7; }
  if (n == HUGE_VAL) { memcpy(s, "1.#INF", 7); return 6; }
  if (n == -HUGE_VAL) { memcpy(s, "-1.#INF", 8); return 7; }
  if (n == 0) {
    if (signbit(n)) { memcpy(s, "-0", 3); return 2; }
    memcpy(s, "0", 2); return 1;
  }
  if (n == floor(n) && n > -1e14 && n < 1e14) return sprintf(s, "%.0f", n); /* ids and counts: the integer itself */
  /* Fourteen significant digits, a tie away from zero (as lua51NumberText / JS toExponential(13)
     answer it; musl's own %.14g rounds a tie to even: 123456789012345 -> ...34e+014, not ...35). */
  char wide[96];
  snprintf(wide, sizeof wide, "%.60e", fabs(n)); /* d.ddd...e+XX, exact digits from musl */
  char digits[16];
  digits[0] = wide[0];
  memcpy(digits + 1, wide + 2, 13);
  int exponent = atoi(strchr(wide, 'e') + 1);
  if (wide[2 + 13] >= '5') {
    int i = 13;
    while (i >= 0 && digits[i] == '9') digits[i--] = '0';
    if (i >= 0) digits[i]++;
    else { digits[0] = '1'; exponent++; } /* 9.99..9 -> 10.0 */
  }
  int count = 14;
  while (count > 1 && digits[count - 1] == '0') count--;
  char *out = s;
  if (n < 0) *out++ = '-';
  if (exponent < -4 || exponent >= 14) {
    *out++ = digits[0];
    if (count > 1) { *out++ = '.'; memcpy(out, digits + 1, (size_t)(count - 1)); out += count - 1; }
    out += sprintf(out, "e%c%03d", exponent < 0 ? '-' : '+', exponent < 0 ? -exponent : exponent);
  } else if (exponent < 0) {
    *out++ = '0'; *out++ = '.';
    for (int i = 0; i < -exponent - 1; i++) *out++ = '0';
    memcpy(out, digits, (size_t)count); out += count;
  } else {
    for (int i = 0; i <= exponent; i++) *out++ = i < count ? digits[i] : '0';
    if (count > exponent + 1) { *out++ = '.'; memcpy(out, digits + exponent + 1, (size_t)(count - exponent - 1)); out += count - exponent - 1; }
  }
  *out = '\0';
  return (int)(out - s);
}

/* Wow.exe's lua_number2int is `fld; fistp`: round to nearest even, 0x80000000 outside int32. */
int wl_number2int(double d) {
  double r = __builtin_rint(d);
  if (!(r >= -2147483648.0 && r < 2147483648.0)) return INT_MIN;
  return (int)r;
}

/* ---------------------------------------------------------------- os.date / os.time in local time */

struct tm *wl_localtime(const time_t *t) {
  time_t shifted = *t + (time_t)wl_tz_offset((double)*t);
  return gmtime(&shifted);
}

time_t wl_mktime(struct tm *tm) {
  time_t utc = timegm(tm);
  if (utc == (time_t)-1) return utc;
  return utc - (time_t)wl_tz_offset((double)utc);
}

/* ---------------------------------------------------------------- memory and scratch */

#define WL_SCRATCH_SIZE 65536
#define WL_NAME_SIZE 4096
static char wl_scratch_area[WL_SCRATCH_SIZE];
static char wl_name_area[WL_NAME_SIZE];
static size_t wl_len;

EXPORT("wl_scratch") char *wl_scratch(void) { return wl_scratch_area; }
EXPORT("wl_scratch_size") int wl_scratch_size(void) { return WL_SCRATCH_SIZE; }
EXPORT("wl_names") char *wl_names(void) { return wl_name_area; }
EXPORT("wl_names_size") int wl_names_size(void) { return WL_NAME_SIZE; }
EXPORT("wl_lenptr") size_t *wl_lenptr(void) { return &wl_len; }
EXPORT("wl_malloc") void *wl_malloc(int n) { return malloc((size_t)n); }
EXPORT("wl_free") void wl_free(void *p) { free(p); }

/* ---------------------------------------------------------------- state and libraries */

static void openlib(lua_State *L, const char *name, lua_CFunction f) {
  lua_pushcfunction(L, f);
  lua_pushstring(L, name);
  lua_call(L, 1, 0);
}

/* 5.1's own environment functions, kept aside: the glue shim removes them from _G (the glue VM had
   none under fengari) and FrameXML puts them back (FrameXmlLuaEnvironment's job under fengari). */
static const char *const WL_ENV_NAMES[] = { "setfenv", "getfenv", "newproxy", NULL };

EXPORT("wl_newstate") lua_State *wl_newstate(void) { return luaL_newstate(); }

EXPORT("wl_openlibs") void wl_openlibs(lua_State *L) {
  openlib(L, "", luaopen_base);
  openlib(L, LUA_TABLIBNAME, luaopen_table);
  openlib(L, LUA_STRLIBNAME, luaopen_string);
  openlib(L, LUA_MATHLIBNAME, luaopen_math);
  openlib(L, LUA_OSLIBNAME, luaopen_os);
  openlib(L, LUA_DBLIBNAME, luaopen_debug);
  openlib(L, "bit", luaopen_wowbit);
  for (int i = 0; WL_ENV_NAMES[i] != NULL; i++) {
    lua_getglobal(L, WL_ENV_NAMES[i]);
    lua_pushfstring(L, "wl.%s", WL_ENV_NAMES[i]);
    lua_insert(L, -2);
    lua_rawset(L, LUA_REGISTRYINDEX);
  }
}

EXPORT("wl_restore_env") void wl_restore_env(lua_State *L) {
  for (int i = 0; WL_ENV_NAMES[i] != NULL; i++) {
    lua_pushfstring(L, "wl.%s", WL_ENV_NAMES[i]);
    lua_rawget(L, LUA_REGISTRYINDEX);
    lua_setglobal(L, WL_ENV_NAMES[i]);
  }
}

EXPORT("wl_mainthread") lua_State *wl_mainthread(lua_State *L) { return G(L)->mainthread; }
EXPORT("lua_close") void wl_close(lua_State *L) { lua_close(L); }

/* ---------------------------------------------------------------- stack */

EXPORT("lua_gettop") int wl_gettop(lua_State *L) { return lua_gettop(L); }
EXPORT("lua_settop") void wl_settop(lua_State *L, int idx) { lua_settop(L, idx); }
EXPORT("lua_pushvalue") void wl_pushvalue(lua_State *L, int idx) { lua_pushvalue(L, idx); }
EXPORT("lua_remove") void wl_remove(lua_State *L, int idx) { lua_remove(L, idx); }
EXPORT("lua_insert") void wl_insert(lua_State *L, int idx) { lua_insert(L, idx); }
EXPORT("lua_replace") void wl_replace(lua_State *L, int idx) { lua_replace(L, idx); }
EXPORT("lua_checkstack") int wl_checkstack(lua_State *L, int n) { return lua_checkstack(L, n); }

EXPORT("lua_type") int wl_type(lua_State *L, int idx) { return lua_type(L, idx); }
EXPORT("lua_isnumber") int wl_isnumber(lua_State *L, int idx) { return lua_isnumber(L, idx); }
EXPORT("lua_isstring") int wl_isstring(lua_State *L, int idx) { return lua_isstring(L, idx); }
EXPORT("lua_iscfunction") int wl_iscfunction(lua_State *L, int idx) { return lua_iscfunction(L, idx); }
EXPORT("lua_equal") int wl_equal(lua_State *L, int a, int b) { return lua_equal(L, a, b); }
EXPORT("lua_rawequal") int wl_rawequal(lua_State *L, int a, int b) { return lua_rawequal(L, a, b); }
EXPORT("lua_lessthan") int wl_lessthan(lua_State *L, int a, int b) { return lua_lessthan(L, a, b); }

EXPORT("lua_tonumber") double wl_tonumber(lua_State *L, int idx) { return lua_tonumber(L, idx); }
EXPORT("lua_tointeger") int wl_tointeger(lua_State *L, int idx) { return (int)lua_tointeger(L, idx); }
EXPORT("lua_toboolean") int wl_toboolean(lua_State *L, int idx) { return lua_toboolean(L, idx); }
/* The string's bytes in place; the length goes to *wl_lenptr(). */
EXPORT("wl_tolstring") const char *wl_tolstring(lua_State *L, int idx) { return lua_tolstring(L, idx, &wl_len); }
EXPORT("lua_objlen") int wl_objlen(lua_State *L, int idx) { return (int)lua_objlen(L, idx); }
EXPORT("lua_topointer") const void *wl_topointer(lua_State *L, int idx) { return lua_topointer(L, idx); }
EXPORT("lua_tothread") lua_State *wl_tothread(lua_State *L, int idx) { return lua_tothread(L, idx); }
EXPORT("lua_touserdata") void *wl_touserdata(lua_State *L, int idx) { return lua_touserdata(L, idx); }

EXPORT("lua_pushnil") void wl_pushnil(lua_State *L) { lua_pushnil(L); }
EXPORT("lua_pushnumber") void wl_pushnumber(lua_State *L, double n) { lua_pushnumber(L, n); }
EXPORT("lua_pushinteger") void wl_pushinteger(lua_State *L, int n) { lua_pushinteger(L, n); }
EXPORT("lua_pushlstring") void wl_pushlstring(lua_State *L, const char *s, int len) { lua_pushlstring(L, s, (size_t)len); }
EXPORT("lua_pushboolean") void wl_pushboolean(lua_State *L, int b) { lua_pushboolean(L, b); }
EXPORT("lua_pushlightuserdata") void wl_pushlightuserdata(lua_State *L, void *p) { lua_pushlightuserdata(L, p); }

EXPORT("lua_createtable") void wl_createtable(lua_State *L, int narr, int nrec) { lua_createtable(L, narr, nrec); }
EXPORT("lua_newuserdata") void *wl_newuserdata(lua_State *L, int size) { return lua_newuserdata(L, (size_t)size); }
EXPORT("lua_getmetatable") int wl_getmetatable(lua_State *L, int idx) { return lua_getmetatable(L, idx); }
EXPORT("lua_setmetatable") int wl_setmetatable(lua_State *L, int idx) { return lua_setmetatable(L, idx); }

/* 5.3's getters answer the type of what they pushed; 5.1's answer nothing. */
EXPORT("wl_gettable") int wl_gettable(lua_State *L, int idx) { lua_gettable(L, idx); return lua_type(L, -1); }
EXPORT("wl_getfield") int wl_getfield(lua_State *L, int idx, const char *k) { lua_getfield(L, idx, k); return lua_type(L, -1); }
EXPORT("wl_rawget") int wl_rawget(lua_State *L, int idx) { lua_rawget(L, idx); return lua_type(L, -1); }
EXPORT("wl_rawgeti") int wl_rawgeti(lua_State *L, int idx, int n) { lua_rawgeti(L, idx, n); return lua_type(L, -1); }
EXPORT("wl_getglobal") int wl_getglobal(lua_State *L, const char *k) { lua_getfield(L, LUA_GLOBALSINDEX, k); return lua_type(L, -1); }

EXPORT("lua_settable") void wl_settable(lua_State *L, int idx) { lua_settable(L, idx); }
EXPORT("lua_setfield") void wl_setfield(lua_State *L, int idx, const char *k) { lua_setfield(L, idx, k); }
EXPORT("lua_rawset") void wl_rawset(lua_State *L, int idx) { lua_rawset(L, idx); }
EXPORT("lua_rawseti") void wl_rawseti(lua_State *L, int idx, int n) { lua_rawseti(L, idx, n); }
EXPORT("wl_setglobal") void wl_setglobal(lua_State *L, const char *k) { lua_setfield(L, LUA_GLOBALSINDEX, k); }

EXPORT("lua_next") int wl_next(lua_State *L, int idx) { return lua_next(L, idx); }
EXPORT("lua_concat") void wl_concat(lua_State *L, int n) { lua_concat(L, n); }
EXPORT("lua_getupvalue") const char *wl_getupvalue(lua_State *L, int f, int n) { return lua_getupvalue(L, f, n); }

/* ---------------------------------------------------------------- calls, chunks, references */

EXPORT("lua_call") void wl_call(lua_State *L, int nargs, int nresults) { lua_call(L, nargs, nresults); }
EXPORT("lua_pcall") int wl_pcall(lua_State *L, int nargs, int nresults, int errfunc) {
  return lua_pcall(L, nargs, nresults, errfunc);
}
EXPORT("wl_loadbuffer") int wl_loadbuffer(lua_State *L, const char *buf, int len, const char *name) {
  return luaL_loadbuffer(L, buf, (size_t)len, name);
}
EXPORT("luaL_ref") int wl_ref(lua_State *L, int t) { return luaL_ref(L, t); }
EXPORT("luaL_unref") void wl_unref(lua_State *L, int t, int ref) { luaL_unref(L, t, ref); }
EXPORT("luaL_callmeta") int wl_callmeta(lua_State *L, int obj, const char *e) { return luaL_callmeta(L, obj, e); }
EXPORT("lua_gc") int wl_gc(lua_State *L, int what, int data) { return lua_gc(L, what, data); }

/* ---------------------------------------------------------------- debug info without lua_Debug in JS */

static lua_Debug wl_ar;

/* The frame's index (lua_Debug.i_ci), or -1 when there is no such level. */
EXPORT("wl_getstack") int wl_getstack(lua_State *L, int level) {
  return lua_getstack(L, level, &wl_ar) ? wl_ar.i_ci : -1;
}
/* `ici` < 0: the '>' form (function on the stack). Fields are read with wl_ar_*. */
EXPORT("wl_getinfo") int wl_getinfo(lua_State *L, const char *what, int ici) {
  if (ici >= 0) wl_ar.i_ci = ici;
  return lua_getinfo(L, what, &wl_ar);
}
EXPORT("wl_ar_source") const char *wl_ar_source(void) { return wl_ar.source; }
EXPORT("wl_ar_short_src") const char *wl_ar_short_src(void) { return wl_ar.short_src; }
EXPORT("wl_ar_what") const char *wl_ar_what(void) { return wl_ar.what; }
EXPORT("wl_ar_name") const char *wl_ar_name(void) { return wl_ar.name; }
EXPORT("wl_ar_namewhat") const char *wl_ar_namewhat(void) { return wl_ar.namewhat; }
EXPORT("wl_ar_currentline") int wl_ar_currentline(void) { return wl_ar.currentline; }
EXPORT("wl_ar_linedefined") int wl_ar_linedefined(void) { return wl_ar.linedefined; }
EXPORT("wl_ar_nups") int wl_ar_nups(void) { return wl_ar.nups; }

/* ---------------------------------------------------------------- errors without a throw */

/* luaL_where(L, level) .. msg — what luaL_error raises, left on the stack. */
EXPORT("wl_push_error") void wl_push_error(lua_State *L, const char *msg, int len) {
  luaL_where(L, 1);
  lua_pushlstring(L, msg, (size_t)len);
  lua_concat(L, 2);
}

/* 5.1's luaL_argerror message, left on the stack. */
EXPORT("wl_push_argerror") void wl_push_argerror(lua_State *L, int narg, const char *extramsg) {
  lua_Debug ar;
  if (!lua_getstack(L, 0, &ar)) { /* no stack frame? */
    luaL_where(L, 1);
    lua_pushfstring(L, "bad argument #%d (%s)", narg, extramsg);
    lua_concat(L, 2);
    return;
  }
  lua_getinfo(L, "n", &ar);
  if (strcmp(ar.namewhat, "method") == 0) {
    narg--;
    if (narg == 0) {
      luaL_where(L, 1);
      lua_pushfstring(L, "calling " LUA_QS " on bad self (%s)", ar.name, extramsg);
      lua_concat(L, 2);
      return;
    }
  }
  if (ar.name == NULL) ar.name = "?";
  luaL_where(L, 1);
  lua_pushfstring(L, "bad argument #%d to " LUA_QS " (%s)", narg, ar.name, extramsg);
  lua_concat(L, 2);
}

/* luaL_traceback (5.2+) over 5.1's ldblib db_errorfb format: message, "stack traceback:", frames. */
#define LEVELS1 12
#define LEVELS2 10
EXPORT("wl_traceback") void wl_traceback(lua_State *L, lua_State *L1, const char *msg, int msglen, int level) {
  lua_Debug ar;
  int firstpart = 1;
  int top = lua_gettop(L);
  if (msg != NULL) {
    lua_pushlstring(L, msg, (size_t)msglen);
    lua_pushliteral(L, "\n");
  }
  lua_pushliteral(L, "stack traceback:");
  while (lua_getstack(L1, level++, &ar)) {
    if (level > LEVELS1 && firstpart) {
      if (!lua_getstack(L1, level + LEVELS2, &ar)) {
        level--;
      } else {
        lua_pushliteral(L, "\n\t...");
        while (lua_getstack(L1, level + LEVELS2, &ar)) level++;
      }
      firstpart = 0;
      continue;
    }
    lua_pushliteral(L, "\n\t");
    lua_getinfo(L1, "Snl", &ar);
    lua_pushfstring(L, "%s:", ar.short_src);
    if (ar.currentline > 0) lua_pushfstring(L, "%d:", ar.currentline);
    if (*ar.namewhat != '\0') {
      lua_pushfstring(L, " in function " LUA_QS, ar.name);
    } else if (*ar.what == 'm') {
      lua_pushliteral(L, " in main chunk");
    } else if (*ar.what == 'C' || *ar.what == 't') {
      lua_pushliteral(L, " ?");
    } else {
      lua_pushfstring(L, " in function <%s:%d>", ar.short_src, ar.linedefined);
    }
    lua_concat(L, lua_gettop(L) - top);
  }
  lua_concat(L, lua_gettop(L) - top);
}

/* A C message handler with the same text as GlueLua's JS TRACEBACK_HANDLER (v2: no JS crossing). */
static int wl_traceback_handler(lua_State *L) {
  size_t len = 0;
  const char *msg = lua_tolstring(L, -1, &len);
  if (msg == NULL) { msg = "error"; len = 5; }
  wl_traceback(L, L, msg, (int)len, 1);
  return 1;
}
EXPORT("wl_push_traceback_handler") void wl_push_traceback_handler(lua_State *L) {
  lua_pushcfunction(L, wl_traceback_handler);
}

/* ---------------------------------------------------------------- JS functions as C functions */

static int wl_tramp(lua_State *L) {
  int n = wl_host_call(L, (int)lua_tointeger(L, lua_upvalueindex(1)));
  if (n < 0) return lua_error(L); /* the JS frames are gone: the longjmp unwinds wasm only */
  return n;
}

EXPORT("wl_pushjsfunction") void wl_pushjsfunction(lua_State *L, int index) {
  lua_pushinteger(L, index);
  lua_pushcclosure(L, wl_tramp, 1);
}
