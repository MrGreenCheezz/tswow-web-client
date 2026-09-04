# GlueXML runtime (slices G2–G6)

The engine that runs the **client's own** login/realm/charselect/charcreate interface —
`Interface\GlueXML` — instead of a hand-written DOM copy of it. It executes the original Lua,
instantiates the original XML, renders the result into a DOM host, draws the 3D of every
`Model`/`ModelFFX` widget, plays the screen's music, signs in over SRP6, lists and creates
characters over a real world connection, and since G6 puts the player into the world.

**Entry points.** `index.html` → `main.ts` → `glue/FrontDoorHost.ts` is the real one: the client
opens on these screens. `glue.html` → `glue/main.ts` is the standalone dev entry, with no renderer,
no HUD and no `game` context behind it. Both call the same `startGlue` in `Bootstrap.ts`, so the
two pages cannot drift.

## The front door

| Switch | Effect |
| --- | --- |
| *(nothing)* | The GlueXML screens. This is the default. |
| `?legacy-login=1` | The old DOM forms in `index.html`; the glue runtime is never even fetched. |
| `?legacy-login=0` | The GlueXML screens, overriding a remembered choice. |
| `localStorage["webclient.frontDoor"] = "legacy"` | Same as `?legacy-login=1`, remembered. Set it from the browser console; `removeItem` or `"glue"` undoes it. The query flag wins over it in both directions, so a link can always override what a browser remembers. |
| `?gateway=…` | Where the gateway is. Accepts `host:port`, `http(s)://origin` or the `ws(s)://…/auth` URL the DOM form was pre-filled with. |
| `?screen=charselect` | Open one of the corpus' own screens directly. |
| `?fake=charselect` / `?fake=charcreate` | A canned session through the real connector seam — no auth or world server needed. |

`?gateway=` exists because the corpus' `AccountLogin` has no address field: it knows about an
account and a password and nothing else. The DOM form had one, and losing it would strand anyone
pointing at a non-default gateway. The value is written back into the DOM field as well as used by
the glue runtime, because that field is not just the login form's — `app/EnterWorld.ts` builds all
twenty-odd asset clients out of `gatewayInput.value`, so a world entered through these screens has
to agree with it about where the gateway is.

A glue runtime that fails to load falls back to the DOM forms with the reason in `#status`, rather
than to a blank page.

## Entering and leaving the world

**One session, lent — not two.** `GlueSession` owns the socket for the whole time. `EnterWorld()`
hands the host the *character* and nothing else (`GlueEnterWorldRequest`); the host already has the
concrete `WorldClient`, because it supplied the connector that built it. The crossing is three
calls in `FrontDoorHost.ts`:

1. `handle.suspend()` — music and ambience stopped, both character scenes and the whole
   `GlueModelStage` disposed (GL context included), the frame clock stopped, every window listener
   dropped through one `AbortController`, the host hidden. The corpus' 3,298 widgets and its Lua
   state stay exactly as they are: rebuilding those is the expensive half, and hiding costs nothing.
2. `adoptWorld(connection)` — the shared tail of `app/Login.ts`'s `connectRealm`, so both front
   doors reach `game.world` / `game.store` / `bindPlayerHud` / `bindDeathScreenEffect` through the
   same five lines (`app/WorldAdoption.ts`).
3. `enterWorld(character)` — the DOM app's own function, unchanged.

The way back is `frontDoorHost().returnFromWorld(exit)`, called from the three places a world can
end (`app/EnterWorld.ts`): `SMSG_LOGOUT_COMPLETE`, the world read loop dying, and a failed enter.
`frontDoorReturn` maps each to a screen:

| Exit | Screen | Connection |
| --- | --- | --- |
| `logout` | `charselect` | reconnect |
| `enter-failed` | `charselect` | reconnect |
| `connection-lost` | `login` | closed |
| `relogin` | `login` | closed |
| any of them with no realm chosen | `login` | closed |

**Why reconnect rather than reuse.** `WorldClient.characters()` reads the socket through
`#waitFor`, and `loginCharacter` leaves `#readWorld` reading the same socket — a character list
asked for over a used-world connection is two readers on one stream. `GlueSession.connect` closes
and reopens, which the session key still allows, and refreshes the list on the way; that is
`GetCharacterListUpdate` semantics with the one thing a used connection cannot give.

Measured on this machine, `?fake=charselect`, four suspend/resume cycles: **suspend 1.5–2.7 ms**;
the synchronous return (`SetGlueScreen("charselect")` plus the reconnect kickoff) **818–1002 ms**,
of which **416–436 ms** is the corpus' own `CharacterSelect_OnShow` chain, measured by calling
`returnFromWorld` with nothing torn down; **381–539 ms** more to the first drawn 3D frame; and
**55–658 ms** after that for the character to stand in the backdrop again. Un-hiding the 3,298
widgets is **0.4 ms** — the cost is the corpus and the rebuild, not the layout. Total, world to
figure-on-screen: **1.26–2.01 s**, with three characters listed over a fresh connection and zero
Lua errors on every cycle.

## Layout

| File | Role |
| --- | --- |
| `GlueLua.ts` | The fengari VM: state, the measured Lua 5.1 compatibility preamble, `seterrorhandler` semantics, JS↔Lua marshalling. |
| `GlueWidgets.ts` | Frames as Lua tables with per-widget-type method tables; the `LuaAddonRuntime` adapter that compiles XML script bodies and sets the legacy implicit environment. |
| `GlueApi.ts` | The C-API globals: real bindings where a real answer exists, a recording seam for audio, constant stubs elsewhere. |
| `GlueLoader.ts` | File providers (fixture, HTTP) and the TOC walk with `Include`/`Script` expansion. |
| `GlueRuntime.ts` | Wires VM → bridge → binder → C-API → loader in the one order that works, plus the viewport metrics. |
| `GlueModelStage.ts` | The 3D behind a `Model`/`ModelFFX` widget: one GL context, one canvas per widget box. |
| `GlueAudio.ts` | `PlaySound`/`PlayGlueMusic`/`PlayGlueAmbience` over `GET /sound`, with the autoplay rule and the `SoundEntries.Name` resolver (`/dbc/sounds?names=`). |
| `GlueSession.ts` | The account, the realm list, the world connection and the character list the screens read. |
| `GlueCharacterApi.ts` | The realm-list and character-select half of the C API. |
| `GlueCharacterScene.ts` | The figure standing in a backdrop, for both screens: appearance, atlas, model, rig, attachments. |
| `GlueCreation.ts` | What the creation screen has chosen and the rules that keep it choosable; five axes, the start outfit, `CreateCharacter`. |
| `GlueCreateApi.ts` | The character-create half of the C API, every signature read off its only caller in `CharacterCreate.lua`. |
| `GlueNames.ts` | The DBC routes both screens read: creation tables, appearance options, start outfit, area names. |
| `GlueFakeSession.ts` | `?fake=charselect` / `?fake=charcreate` — a canned session through the real connector seam. |
| `Bootstrap.ts` | `startGlue()`: HTTP provider, texture cache, font loader, DOM renderer, model stage, resize, OnUpdate loop — and `suspend`/`resume`, which is what lets the world take the screen. |
| `FrontDoor.ts` | Pure: which interface the page opens with, the `?gateway=` override, and where each exit from the world lands. Imports nothing, so `app/Login.ts` can ask it without dragging the Lua VM into `index.html`'s main chunk. |
| `FrontDoorHost.ts` | The two crossings: enter-world (suspend → adopt → `enterWorld`) and return-from-world. Loaded on demand. |
| `glue.css` | The stage's frame of reference, shared by both pages. |
| `main.ts` | `glue.html`'s entry: three elements, three query parameters, `startGlue`. |

The XML grammar, the widget state model, the DOM rendering, the picture cache and the font repair
live one directory up in `../ui/framexml_compat/`, which these slices grew rather than duplicated.

## What "measured" means here

Every number below was taken from this client's own corpus — the 70 `Interface\GlueXML` paths the
locale patch chain resolves (`patch-ruRU-A` for the stock screens, the server's own `patch-ruRU-F`
for `GlueXML.toc`, `AccountLogin.{lua,xml}`, `GlueButtons.*`, `LibDeflate.lua`, `AceSerializer.lua`,
`lgzg.lua`, `XlIlHI.lua`) — not from a wiki page.

Current state of the real corpus through this runtime, from `tests/glue-corpus.test.mjs`:

- **65 files** loaded from the 34 active TOC entries, in order, with `Include`/`Script` expansion.
- **3,298 widgets**, **161 templates**, **76 font objects**. (2,919 in G2: the extra 379 are the
  owner's own login scene, which G2 never got to build — see «Three VM divergences» below.)
- **0 unhandled Lua errors**, **0 XML/provider diagnostics**, **0 recorded widget methods**.
- `AccountLogin` exists, its `OnLoad` ran, and `SetGlueScreen("login")` fires its `OnShow` once.

## Three VM divergences the corpus depends on

G2's smoke was clean and the browser still showed the corpus' own error dialog over a black screen.
Each of these is a place where fengari is a *valid* Lua and PUC-Lua 5.1 — the one the corpus was
written against — is a different one, and each took the login screen down on its own.

1. **Traversal order.** `next`/`pairs` walk PUC's array part first, ascending; fengari's order for
   `lgzg.lua`'s `ModelList` came out hash-first with the array part *descending*
   (`loaded, blend_start_duration, max_scenes, sceneData, 3, 2, 1`). `lgzg.lua:187` inserts each
   model at the key `pairs` handed it, so the very first one raised «position out of bounds».
2. **`table.insert` bounds.** 5.1's C body was `if (pos > e) e = pos` — no check. `GetModelData`
   and `GetModel` rebuild genuinely sparse lists that way, so even a correctly ordered traversal
   lands past `#t + 1`.
3. **`securecall` results.** It returned only the first. `OptionsFrameTemplates.lua` wraps `next` in
   it (`local function SecureNext(elements, key) return securecall(next, elements, key) end`), so
   every options list indexed a nil value on its first iteration.

Two more were the bridge's rather than the VM's: `CreateFrame("BUTTON", …)` — the corpus' spelling
in `GlueDropDownMenu.lua:159` — needed the case-insensitive type match the real client does, and
`GetBackdrop()` had to return the *whole* table, because `AccountLogin.lua:90` immediately does
`backdrop.insets.left = backdrop.insets.left - 2`.

## The Lua 5.1 shims that are load-bearing

fengari is Lua **5.3**; the corpus is 5.1 plus Blizzard's flattened "C globals". Three gaps:

1. **5.1 aliases as globals** — `strlen` (51 call sites), `format` (25), `strupper` (11), `tinsert`
   (10), `getglobal` (9), `strsub` (8), `gsub` (8), `strbyte` (3), `strchar` (2), `gmatch` (2),
   `unpack` (2), `strfind`, `tremove`, `tconcat`, `getn`, `sort`, `strreplace`.
2. **`math`/`os` members as globals** — `max` (32), `time` (27), `mod` (21), `min` (16), `floor`
   (14), `date` (4), `random` (3), `ceil` (3), `abs` (1); plus `math.frexp`, which 5.3 removed and
   `AceSerializer.lua` calls.
3. **Blizzard's error/secure vocabulary** — `seterrorhandler` (installed by
   `GlueBasicControls.xml`), `securecall` (10), `issecure`, `debuginfo`, `print`.

Two 5.3-vs-5.1 divergences cannot be aliased and are handled explicitly:

- `string.format("%d", 3.7)` is a hard error in 5.3 and truncated in 5.1. `format` is wrapped and
  truncates the arguments that reach an integer specifier, stepping over `%%`.
- `tostring(6/2)` is `"3.0"` in 5.3 and `"3"` in 5.1. `tostring` is wrapped.
- **Unknown escapes.** 5.1's lexer dropped the backslash of `\X`; 5.2+ rejects the chunk.
  `Interface\SharedXML\SharedGlueStrings.lua` contains `"… пароль? \Небезопасно …"` (and the same
  bug in its deDE line). `relaxLua51Escapes` applies the old rule, but **only** to a chunk that
  fails to lex with that exact error, and only inside short string literals. Which chunks needed it
  is recorded in `GlueLuaVm.relaxedChunks`; today that is exactly one file.

**Deliberately not implemented, because the corpus does not use them:** `setfenv` and `getfenv` have
**zero** call sites across all 70 files (`.lua` bodies and inline XML script bodies alike), so the
`_ENV`-upvalue surgery they would need under 5.3 is not written. `loadstring`, `wipe`, `strsplit`,
`strjoin`, `strtrim` and `strconcat` are also unused; the one-line aliases exist anyway because a
custom login screen is the kind of file that grows one.

**Known remaining divergence:** `"x"..(6/2)` still concatenates as `x3.0`. Lua 5.3 coerces a number
to a string inside the VM, where no metamethod can intercept it, so only a fengari patch could fix
it. No corpus site was found that concatenates a division result into displayed text.

## The implicit environment

Handlers receive `(self, …)` with the measured 3.3.5 parameter names for each script
(`FRAME_XML_SCRIPT_PARAMETERS`), **and** the legacy globals are set around dispatch:

- `this` — used by three inline handlers in `GlueLocalizationPost.xml`
  (`this:HighlightText()`, `this:GetParent()`), which are dead without it.
- `arg1..arg9` — `TrialConvert_OnKeyDown()` is declared with no parameters at all and reads `arg1`.
- `event` — published because 3.3.5 published it, though every corpus `OnEvent` body happens to take
  it as a named parameter.

`__glueInvoke` (Lua, in `GlueWidgets.ts`) saves and restores them around every dispatch, so an
`OnClick` that calls `Show()` — which runs an `OnShow` inside it — does not lose its own `arg1`.

## Widget method tables

Frames are Lua **tables** with a per-widget-type metatable, not userdata proxies. That is the
faithful shape twice over: the corpus assigns its own fields and methods onto frames
(`self.SetOwner = function(…)` in `GlueTooltip.xml`, `control.SetDisplayValue` in
`OptionsPanelTemplates.lua`), and it *tests* for methods by truthiness
(`elseif ( checkButton.GetValue )`). A per-type table answers that test the way the real client
answers it. There is deliberately **no** `__index` fallback that manufactures a method for any
unknown name: it would make every such test take the wrong branch.

A method that cannot be honest yet is a recorded no-op **in** the table (so it stays truthy) and
warns once. A genuinely unknown method call raises a Lua error, which the dispatch pcall routes to
the corpus' own error handler — the screen survives it.

A real corpus run now reaches **no** recorded method at all: G2's two — `SetRotation` (the login
logo turns on it once a frame) and `RegisterForClicks` (the character-select rotation arrows arm
the press *and* the release so they can spin while held) — are implemented.

## C-API stubs the real corpus reaches

This list is the work queue for G4/G5. Everything else the corpus calls is bound to a real answer.

```
GetNumCharacters          GetClientExpansionLevel   SetCharSelectModelFrame
SetCharCustomizeFrame     IsMacClient               IsStreamingTrial
GetRefreshRates           GetCurrentMultisampleFormat  GetMultisampleFormats
IsStereoVideoAvailable    Sound_GameSystem_GetNumOutputDrivers
IsScanDLLFinished         GetServerName             IsTrialAccount
IsSystemSupported         ShowChangedOptionWarnings
```

`EULAAccepted` and `ShowEULANotice` have left that list, and the reason is worth writing down:
`AccountLogin_ShowUserAgreements` runs `if ( not EULAAccepted() ) then AccountLoginUI:Hide(); …
TOSFrame:Show() end` and walks five agreements in turn, so a stub returning *nothing* read as «not
accepted» and the screen came up on the EULA panel with the login form hidden behind it. They are
bound to an accepted-by-default set (`installLegalNotices`) because this build has no agreement flow
to run at all — `eula.html`, `tos.html` and the rest are absent from the patch chain, so the gate
could never be passed by reading anything.

Bound for real in this slice: `GetBuildInfo` (`"3.3.5"`, `"12340"`, `"Jun 24 2010"`, `30300`),
`GetLocale`, `GetScreenWidth/Height`, `GetScreenResolutions`/`GetCurrentResolution`, `GetTime`,
`MinutesToTime`, `LaunchURL` (surfaced to the host, never navigated), the CVar map with the glue
defaults, `GetSavedAccountName`/`SetSavedAccountName` and the account-list pair, `CreateFrame`,
`SetCurrentScreen`/`SetCurrentGlueScreenName`, the audio family (`PlaySound`, `PlaySoundFile`,
`PlayGlueMusic`, `PlayGlueAmbience`, `StopGlueAmbience`, `StopGlueMusic`, `StopAllSFX`,
`PlayMusic`) against an injectable sink, and `DefaultServerLogin`/`CancelLogin`/`StatusDialogClick`.

`GetScreenResolutions` is a *real* answer rather than a stub because the server's `lgzg.lua` does
`({GetScreenResolutions()})[GetCurrentResolution()]` at load time and divides the two numbers it
parses out of the string; an empty list was a nil arithmetic error before the screen had drawn.

## Login

`DefaultServerLogin(account, password)` runs the same SRP6 handshake the DOM login uses —
`loginToRealmList` over a `WebSocketByteStream` to the gateway's `/auth` route — and reports back
through the events the corpus already listens for, so `GlueDialog.lua` shows the status dialog it
has always shown: `OPEN_STATUS_DIALOG("CANCEL", …)` → `UPDATE_STATUS_DIALOG` →
`CLOSE_STATUS_DIALOG`, then either the `charselect` transition attempt or
`OPEN_STATUS_DIALOG("OKAY", message)`. `CancelLogin` and `StatusDialogClick` close the socket and
invalidate the attempt, so a late reply from a cancelled login cannot reopen a dialog.

## The coordinate system

Measured from the corpus, not assumed: `GlueParent.xml` is `setAllPoints="true"` with **no size at
all**, and `GlueParent_OnLoad` reads `GetScreenWidth()/GetScreenHeight()` and pillarboxes *itself*
only when the ratio exceeds 16:9. So the original is not a 1024×768 letterbox — **height is the
fixed axis at 768 UI units** and width follows the viewport aspect (1024 at 4:3, 1365.33 at 16:9).

`Bootstrap.ts` therefore lays the stage out in UI units and scales it uniformly by
`viewportHeight / 768`; no bars of our own, no stretch, and GlueParent keeps its own 16:9
pillarbox. Stretching a fixed 1024×768 box to the window would distort every glue texture on any
modern display. `#glue-host` is `position: fixed; inset: 0; z-index: 90` on both pages — below
`#world-panel`'s 100, so entering the world covers these screens rather than fighting them.

## Pictures

Every picture on the screen is fetched and handed to the element as a blob URL
(`../ui/framexml_compat/FrameXmlTextures.ts`). Not a preference: the gateway refuses a request with
no `Origin` header, and a browser sends none for an `<img>` or a CSS `url()` — measured, the whole
interface was a flood of 403s with nothing in the console but «Failed to load resource». The corpus
also does not spell texture names the way `/texture` wants; `frameXmlTexturePath` completes them
(`…\Parchment8` → `.blp`, `…-Drugs.tga` → `.blp`). Measured on the live login screen afterwards:
**208 gateway requests, 0 × 403**, one 404 for `Glues-WoW-WotLKLogo_lg.blp` (genuinely absent from
this patch chain, on a widget the corpus declares `hidden="true"`), and two 400s from a corrupt
texture string inside the owner's own `8fx_generic_shadow_debuff.m2`.

A `Backdrop`'s border is drawn as **nine background layers**, not `border-image`: a WoW edge file is
eight square tiles in a row (measured: `UI-DialogBox-Border.blp` 256×32, `UI-Tooltip-Border.blp`
128×16) and two of the eight — the top and bottom edges — are stored lying on their side, so the
texture source cuts and rotates them. CSS's nine-patch slicing of a square source is a different
construction entirely, which is why the login dialog used to come up as a flat yellow rectangle.

`SetTexCoord` rides on `object-view-box`, because the operation is a crop **and** a stretch: the old
`clip-path` hid the rest of the atlas and left the kept part at its original size, which is wrong for
every button state the corpus reads out of one. `glue.html` keeps the `clip-path` rule as the floor
under an `@supports` guard.

## Fonts

The client's own TrueType files go through JavaScript rather than an `@font-face` URL, because
Chrome's OTS refuses the one face the whole screen is written in. Measured: `Fonts\FRIZQT__.TTF` has
242 glyphs and its `cmap` format 4 subtable has **exactly one** out-of-range segment — the mandatory
`U+FFFF` sentinel with `idDelta = 0`, which maps U+FFFF to glyph 65535 where the specification wants
glyph 0. Two bytes. `repairFontSentinelSegment` writes them and the real Friz Quadrata loads.

| file | bytes | glyphs | Latin | Cyrillic | OTS |
| --- | --- | --- | --- | --- | --- |
| `Fonts\FRIZQT__.TTF` | 63,208 | 242 | 62/62 | 66/66 | refused → **passes repaired** |
| `Fonts\ARIALN.TTF` | 134,188 | 658 | 62/62 | 66/66 | passes |
| `Fonts\MORPHEUS.TTF` | 104,716 | 359 | 62/62 | 66/66 | passes |
| `Fonts\SKURRI.TTF` | 169,028 | 266 | 62/62 | 66/66 | passes |
| `Fonts\NIM_____.ttf` | 143,708 | 661 | 62/62 | 66/66 | passes |
| `Fonts\OptimusPrinceps.ttf` | 41,416 | 162 | 62/62 | 0/66 | passes |
| `Fonts\OptimusPrincepsSemiBold.ttf` | 57,296 | 193 | 62/62 | 0/66 | passes |
| `Fonts\varsity_regular.ttf` | 26,572 | 245 | 62/62 | 0/66 | passes |

`FRIZQT___CYR`, `MORPHEUS_CYR` and `SKURRI_CYR` are **404** in this chain: the ruRU build ships the
Cyrillic glyphs inside the plain names, which the coverage column confirms. So there is no CYR
sibling to map onto and no substitution is needed; `NIM_____` stands by as the fallback for a face
that fails some other way, because it is the one shipped font with both scripts and the largest
glyph set. The corpus names three of these — `FRIZQT__` ×13, `ARIALN` ×4, `MORPHEUS` ×1.

## 3D model widgets

`GlueModelStage.ts` draws every `Model`/`ModelFFX` widget through the shipping renderer: `Wvm`
decodes, `ModelBuild` builds, `AnimatedModel` rigs and plays sequence 0 looped, `ParticleRender`
emits, `PortraitCamera` reads the authored camera out of the WVM9 `sceneCamera` field G1 put on the
wire. A glue model that draws wrong here draws wrong in the world.

- **One GL context.** The corpus declares 85 Model widgets and the owner's scene adds 32 live ones;
  a renderer each would exhaust the browser's context limit. One renderer draws into an offscreen
  canvas and each widget owns a 2D canvas that the frame is blitted into, so the 3D obeys the
  widget's own place in the DOM.
- **The budget is measured.** A view renders at most 512 px on its long side and the model pass runs
  at 30 Hz: **32 live views cost 3.8–5.8 ms a pass** on this machine.
- **`.mdx` is not a file.** GlueXML and `lgzg.lua` write the Warcraft III extension; every one of the
  corpus' sixteen distinct model paths answers 400 as written and 200 as `.m2`.
- **`SetLight` is read, not recorded.** Thirteen numbers are one ambient light and one directional
  light, and `lgzg.lua` drives all thirty of its models through them.
- The stock path is real too: `SetBackgroundModel` in `GlueParent.lua` hands its path to
  `SetCharSelectBackground`, a C function — the model never passes through `model:SetModel`. Bound,
  `glue.html?screen=charselect` draws `UI_Human.m2` through its authored 80° camera.

**Known gap.** A widget the corpus *composes* by hand — `SetPosition` + `SetModelScale`, which is how
the owner's login scene places its thirty models — is framed against a fixed camera whose distance
and angle this slice could not measure from any data in the repo (`Model:SetCamera(1)` selects a
camera index none of those doodads has). The shape is right — the authored depths run from +1.5 to
−24.5, so the camera stands still and the models move in front of it — but the two constants in
`GlueModelStage.ts` are set by eye and the composition does not match the original yet.

## Audio

`GlueAudio.ts` plays over `GET /sound?path=`, with `crossOrigin = "anonymous"` set before `src` —
a media element sends no `Origin` otherwise and hits the same 403 the textures did. Browsers refuse
to start audio before a user gesture, so a rejected `play()` is not treated as an error: the track
is remembered and started on the first `pointerdown`/`keydown`. Sound *kits* (`PlaySound("gsLogin…")`)
are `SoundEntries.dbc` rows rather than paths; they are counted and reported rather than guessed at.

## Capability boundary

The corpus includes third-party libraries shipped inside patch archives (`LibDeflate.lua`,
`AceSerializer.lua`). They run behind the same boundary the rest of `framexml_compat` maintains:

- fengari-interop's `js` library is **never opened**, so no chunk can reach `window`, `document`,
  `fetch` or `WebSocket`. Only `push`/`tojs` are used, for scalars.
- The shim preamble removes `io`, `package`, `require`, `dofile` and `loadfile`, and reduces `os` to
  `date`/`time`/`clock` and `debug` to `traceback` — the members the corpus actually calls.
- Texture and font URLs are built by the host from a fixed origin; nothing the XML says can name a
  host. `LaunchURL` is surfaced to the host rather than navigated.
- The file provider refuses any path that would climb out of `interface/`.

## Bundle cost

The Lua VM and the whole glue runtime land in one chunk, `assets/Bootstrap-*.js` — **407 kB
(136 kB gzipped)** as of G6, with `assets/Bootstrap-*.css` at 1.83 kB beside it. `glue.html`
preloads it; **`index.html` does not**, because `main.ts` reaches it through a dynamic
`import("./glue/FrontDoorHost.js")`. Measured in the live page: `?legacy-login=1` fetches **zero**
fengari modules and never touches `Bootstrap`, so the parity switch costs nothing at all. What
`index.html` does carry statically is `FrontDoor.ts`, which is pure functions and imports nothing.

fengari's `io`/`os` libraries drag in the Node-only `tmp` and `readline-sync` packages, which Vite
reports as externalized — harmless here: rollup's CommonJS interop initialises those modules
lazily, so their top-level code never runs unless `os.tmpname`/`io` is called, and the shim
preamble removes both.

## Tests

| File | Covers |
| --- | --- |
| `tests/glue-lua.test.mjs` | The measured shims, the `seterrorhandler` protocol, compiled handler signatures, JS bindings, the 5.1 escape rule. |
| `tests/glue-loader.test.mjs` | TOC order and 404 skip, path resolution, templates/`$parent`/anchors/fonts/backdrops/model recording, the implicit environment, the C API, the HTTP provider's 404-vs-error split, viewport metrics. |
| `tests/glue-corpus.test.mjs` | The real corpus out of the MPQ chain (skips cleanly without a client). |
| `tests/glue-model-stage.test.mjs` | The `.mdx`→`.m2` rule and `SetLight`'s thirteen numbers. |
| `tests/glue-front-door.test.mjs` | Which interface opens (query flag, storage, default), the `?gateway=` spellings, the exit→screen map, the world-adoption tail against a fake connection, the `EnterWorld` handover, and source pins on the wiring that lives behind `ui/Dom.ts`. |
| `tests/framexml-dom.test.mjs` | The grown grammar, the two-anchor layout rule, the picture source and its reference counting, the nine-layer backdrop, frame strata, state-texture sizing, `SetRotation`/`RegisterForClicks`. |
| `tests/framexml-textures.test.mjs` | Texture path completion, the blob cache, the edge-piece order, and the `cmap` sentinel repair (against a synthetic font and against the client's real one). |
