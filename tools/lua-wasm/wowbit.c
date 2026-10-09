/*
 * ARC-4: the `bit` library Wow.exe 3.3.5a links into its Lua 5.1 (LuaBitOp's names).
 *
 * Same semantics as the Lua version the fengari path runs (FrameXmlBoot.ts, FRAMEXML_LUA51_SHIMS,
 * fixed 09.10): an argument is `floor(tonumber(v) or 0)` taken modulo 2^32 (NaN and +-inf are 0),
 * every result is normalised to a signed 32-bit number, shifts use the count's low five bits,
 * `arshift` is floor division by 2^n, `tohex` is "%08x" of the unsigned value (no second argument).
 */
#include <math.h>
#include <stdio.h>

#include "lua.h"
#include "lauxlib.h"

typedef unsigned int u32;

static u32 bit_arg(lua_State *L, int i) {
  double d = floor(lua_tonumber(L, i)); /* non-numbers and nil are 0, numeric strings convert */
  if (!isfinite(d)) return 0;
  d = fmod(d, 4294967296.0); /* exact for every finite double */
  if (d < 0) d += 4294967296.0;
  return (u32)d;
}

static int bit_push(lua_State *L, u32 r) {
  lua_pushnumber(L, (lua_Number)(int)r);
  return 1;
}

static int bit_tobit(lua_State *L) { return bit_push(L, bit_arg(L, 1)); }
static int bit_bnot(lua_State *L) { return bit_push(L, ~bit_arg(L, 1)); }

static int bit_band(lua_State *L) {
  int n = lua_gettop(L);
  u32 r = bit_arg(L, 1);
  for (int i = 2; i <= n; i++) r &= bit_arg(L, i);
  return bit_push(L, r);
}
static int bit_bor(lua_State *L) {
  int n = lua_gettop(L);
  u32 r = bit_arg(L, 1);
  for (int i = 2; i <= n; i++) r |= bit_arg(L, i);
  return bit_push(L, r);
}
static int bit_bxor(lua_State *L) {
  int n = lua_gettop(L);
  u32 r = bit_arg(L, 1);
  for (int i = 2; i <= n; i++) r ^= bit_arg(L, i);
  return bit_push(L, r);
}
static int bit_lshift(lua_State *L) { return bit_push(L, bit_arg(L, 1) << (bit_arg(L, 2) & 31)); }
static int bit_rshift(lua_State *L) { return bit_push(L, bit_arg(L, 1) >> (bit_arg(L, 2) & 31)); }
static int bit_arshift(lua_State *L) { return bit_push(L, (u32)((int)bit_arg(L, 1) >> (bit_arg(L, 2) & 31))); }

static int bit_tohex(lua_State *L) {
  char buf[16];
  snprintf(buf, sizeof buf, "%08x", bit_arg(L, 1));
  lua_pushstring(L, buf);
  return 1;
}

static const luaL_Reg bit_funcs[] = {
  { "tobit", bit_tobit }, { "bnot", bit_bnot }, { "band", bit_band }, { "bor", bit_bor },
  { "bxor", bit_bxor }, { "lshift", bit_lshift }, { "rshift", bit_rshift }, { "arshift", bit_arshift },
  { "tohex", bit_tohex }, { NULL, NULL },
};

int luaopen_wowbit(lua_State *L) {
  luaL_register(L, "bit", bit_funcs);
  return 1;
}
