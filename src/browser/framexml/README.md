# FrameXML — the in-world interface, on the glue engine

Slice **F1** opened this lane. It is an *inventory*, not a working interface: it brings the client's
own `Interface\FrameXML` up on exactly the parts G2 built for `Interface\GlueXML` — the same fengari
VM with the same measured Lua 5.1 shims, the same XML parser, the same widget bridge, the same
handler environment — and answers, with numbers, what the rest of the lane has to pay for.

Slice **F2** made the corpus *load*. Nothing in this directory renders a working HUD and nothing
here knows a unit, an item or a spell; what F2 did is remove every reason the corpus had to die, and
replace the loudest nils with an **empty but well-typed world**.

Slice **F3** made one part of it *work*: `MainMenuBar` with twelve action buttons drawing the
client's own icons, a stack count and a cooldown sweep, out of a state seam with two
implementations. Its own section is at the bottom.

One file in the client imports this directory, by dynamic `import()` and behind a flag:
`app/EnterWorld.ts` mounts `FrameXmlWorldMount.ts` when the URL carries `?framexml=1`, and without
the flag nothing here is downloaded at all. `framexml.html` is still a dev entry.

## What it costs (measured 2026-08-30, `F:/Circle`, ruRU)

| | F1 | F2 |
|---|---:|---:|
| TOC entries | 210 | 210 |
| Files reached | 335 | 335 |
| Bytes | 10 085 KiB | 10 085 KiB |
| Lua chunks the plan reads | 207 | **2 256** |
| Globals the plan owes the host | 1 326 | 1 415 |
| Lua executed | 202 | **209** |
| **Files that fail to load** | **7** | **0** |
| Widgets instantiated | 24 770 | **25 308** |
| Named widgets | 17 670 | **17 781** |
| **Errors raised** | **415** | **126** |
| **Distinct failures** | **183** | **57** |
| C-API globals reached | 167 | 187 |
| …of them still unanswered | 167 | **122** |
| Unanswered widget methods reached | 29 | 32 |
| Handlers the four session events dispatch | 263 | 275 |
| Load, node, local MPQ | scan 183 · plan 832 · exec 4 764 ms | scan 157 · plan 722 · exec 5 289 ms |

`GlobalStrings.lua` is **753 418 bytes** on this ruRU dataset and takes 117 ms to run — the second
most expensive chunk after one of the server's own generated tables (3.5 MB, 158 ms).

The C-API count goes *up* while the failure count goes down, and that is the expected shape: with
nothing dying, more of the interface runs far enough to reach more of the host.

## The stub floor

The glue corpus had fourteen unanswered globals and they could be listed by hand. This one names
**1 415**, so the host is derived rather than written:

* `FrameXmlStubPlan.ts` reads every Lua chunk in the corpus and sorts names into *the host owes this*
  and *leave it nil*. The discriminator is a fact about the text: a name the corpus **calls** and
  never **defines** is a host function; a name it only reads is not — which is what lets
  `_G["ActionButton" .. index]` keep running out the way the real client does.
* "Every Lua chunk" is F2's correction. F1 fed the plan the `.lua` files and the top-level
  `<Script>` bodies — 207 chunks — and missed the `<OnLoad>`/`<OnClick>`/`<OnEvent>` bodies, which
  are **2 049 more chunks and 280 KiB of Lua**. Measured cost of the omission: six globals the
  corpus genuinely calls
  (`GetActionBarToggles`, `GetRefreshRates`, `GetGamma`, `GetTerrainMip`, `GetMultisampleFormats`,
  `SetWhoToUI`) were classified read-only, left nil — correctly, by the rule — and raised
  «attempt to call a nil value».
* `FrameXmlBoot.ts` installs one `_G` metamethod. On a miss, a name in the plan gets a recording
  stub created once and written into `_G` (so it exists from then on, as it does in the real client);
  a **font object** name is resolved into a real Font object; anything else stays nil and is counted.
  The same idea hangs off each widget type's method table, restricted to `:Name(` spellings the
  corpus never attaches to one of its own tables.
* Stubs answer **nothing** and are promoted to a typed answer only where a nil provably kills
  something. Every promotion carries the failure that forced it (`FRAMEXML_NEUTRAL_API`,
  `FRAMEXML_PROMOTED_METHODS`, `FRAMEXML_HOST_CONSTANTS`).

The line F1 held and F2 keeps: **VM-level Lua 5.1 vocabulary gets shimmed; new API or widget surface
does not.** `bit`, `newproxy`, `hooksecurefunc`, `scrub`, `forceinsecure`, `debugstack`,
`table.wipe` are shims.

## F2, item 1 — font objects are globals

Every one of F1's seven load failures was the same line: `_G.GameFontNormal:GetFont()` at file
scope, in seven of the server's own modules. The real client publishes each named font object as a
global Font object; this VM had nothing there.

* **Which names** — `<Font name=…>` *and* the virtual `<FontString name=…>` that inherits from one.
  151 on this dataset, collected by the corpus scan so the set is complete before the first chunk
  runs; the bridge only flattens its font objects at the *end* of the load, and `GameFontNormal` is
  read in the middle of it, so each object is resolved on first read
  (`FrameXmlUiBridge.fontObjectStyle`) and written into `_G`.
* **Which methods** — the static census over all 2 256 chunks finds exactly one method the corpus
  calls on a font object, and it is one name calling one method: `GameFontNormal:GetFont`, 8 sites.
  It is implemented; every other Font method falls
  through to the same per-type census as a widget method and is recorded as `Font:Name` with its
  first touch. Measured after the change: **7 `GetFont` calls, and no other Font method reached** —
  so the minimal surface was the right surface.
* **Passing one to a widget** — `SetFontObject(GameFontNormal)` used to hand the widget layer a nil;
  with globals it hands it a table, and the binder's `str(args[0])` would have turned that into
  garbage. The four font-object setters plus `GetFontObject` are wrapped in Lua on 18 method-table
  entries, so a font object goes in as its own name and comes back out as the object.

## F2, item 2 — the neutral API

`FrameXmlNeutralApi.ts` is a manifest: name, group, the answer, and **why that answer and not nil**.
Constants ride the same table F1's promotions do, so the census cannot tell an F2 answer from an F1
promotion and should not. The two families that hold state — the CVar registry and the add-on list —
are Lua, for the same reason F1's counters are Lua.

| group | names | reached this load | calls answered |
|---|---:|---:|---:|
| CVar | 7 | 6 | 851 |
| action bar | 23 | 11 | 1 564 |
| keys and bindings | 15 | 4 | 469 |
| add-ons | 12 | 2 | 255 |
| units and group | 64 | 27 | 199 |
| money and bags | 11 | 5 | 171 |
| chat, channels, voice | 16 | 10 | 165 |
| **total** | **148** | **65** | **3 674** |

Three of the answers are measurements that contradict the brief that asked for them, and they are
the interesting ones:

* **CVar defaults cannot be seeded from the corpus.** `RegisterCVar` has **zero** call sites in all
  335 files. So the registry starts genuinely empty, `GetCVarDefault` answers the registered default
  (nothing), and what the map buys is the round trip: `SetCVar` then `GetCVar`, which the option
  panels and `PaperDollFrame` both do.
* **`GetChatWindowInfo` is left nil.** 29 calls, 0 raises. Every field it returns — colour, alpha,
  docked, shown — is a saved setting this client has never had, so answering means inventing a chat
  layout. Deferred with its number.
* **`UnitName("player")` does not need synthesising.** With every unit query nil, the whole
  unit-frame layer raises exactly twice, both `UnitLevel("player")` at
  `MainMenuBarMicroButtons.lua:39`. So nil stands and the synthetic self is F3's, where real world
  state binds in and the answer stops being a guess.

## F2, item 3 — a parent exists before its children

`parentKey="check"` publishes a child on its parent as `parent.check`, and the binder does exactly
that — but only if the parent already has a Lua table, and it did not: the bridge builds a widget's
children first and binds the widget itself afterwards, so **every `parentKey` in the corpus landed
on a parent that did not exist yet** and was dropped.

Measured in isolation, with everything else in F2 already in place: **252 raises → 135**, 162
distinct → 66. The names: `.enableButton` 29, `.highlight` 23, `.check` 22, `.name` 15, `.texture`
7, and sixty more one per frame across the scroll-list templates.

The fix is `FrameXmlBoot.parentFirstRuntime` — the binder wrapped so it binds the ancestor chain
first. It is idempotent and it changes nothing else. Its proper home is the bridge/binder pair; it
lives here so the glue lane's own ordering is untouched.

## What is left (57 distinct, 126 raises)

| raises | where | what it needs |
|---:|---|---|
| 24 | `PaperDollFrame.lua:1141` | `GetInventorySlotInfo` — the client's inventory-slot enum. This repo already carries it for the wire protocol (`src/browser/Inventory.ts`, `EQUIPMENT_SLOT_NAMES` in Player.h order); nothing in the corpus names the slots, so wiring the two together is F3's, not a guess. |
| 16 | `TextStatusBar.lua:73` | `lockShow`, set by `TextStatusBar_Initialize`, which runs from `UnitFrame_Initialize`, which needs a unit. World state. |
| 9 | `FloatingChatFrame.lua:1281` | `Frame:GetLeft`/`GetRight` — real screen geometry the bridge does not expose yet. |
| 8 | `UnitFrame.lua:86` | `self.name` on frames whose `UnitFrame_Initialize` never ran. World state. |
| 6 | `UnitPopup.lua:484` | `UIDROPDOWNMENU_INIT_MENU` — no menu is open; an artefact of running the popup code at load. |
| 8 | `HelpFrame*Cancel:OnLoad` | `Button:GetTextHeight` — a measurement, not an API answer. |
| 55 | 44 more, one or two each | mostly video/audio option panels asking the C client for hardware. |

Also honest: `newproxy` is still a table (18 `type(x) == "userdata"` checks in the secure layer
answer wrongly), 514 globals are read and stay nil (1,527 reads), and the run is still four events
and one tick. `SetAttribute`/`GetAttribute` were on this list until F3 replaced them with a real
store — see below.

## F3 — the first working vertical

Three mechanisms, and the numbers each one moved.

**1. Secure attributes are a real store.** F1 promoted `SetAttribute`/`GetAttribute` from raising to
recording nothing; F2 measured 1,672 calls landing in that no-op. F3 gives every frame a
`secureAttributes` map, implements both forms of `GetAttribute` (the plain one and the five-step
wildcard cascade `SecureButton_GetModifiedAttribute` depends on), parses the XML
`<Attributes>` element F1 counted as unparsed grammar, and dispatches `OnAttributeChanged`.
Measured on the whole corpus: **1,042 writes, 3,393 reads, 1,022 handler dispatches, 10 attributes
out of XML**, against F2's zero of each. The semantics and the measurements behind them are in
`ui/framexml_compat/FrameXmlAttributes.ts`; there is no taint model, and the header there says why
that is faithful rather than convenient.

**2. The state seam.** `FrameXmlWorldSeam.ts` is a typed provider of exactly the names
`ActionButton.lua`, `MainMenuBar.lua` and `SecureTemplates.lua` call, plus the event pump — the
seam owns the firing, because `ActionButton_Update` registers its dozen events only once a slot
answers `HasAction`. `CannedWorldSeam` is twelve real rows of this dataset (read from
`/dbc/spells`, with their ruRU names, `SpellIcon` ids and `Interface\Icons\…` paths);
`LiveWorldSeam` is the same interface over `game.world.actionButtons`, `world.cooldownState` and
the player's update fields, citing the read `ui/ActionBar.ts` already performs for each.

*A measurement that removed a job:* the brief expected spell icons to need `/spell-icon/<iconId>`,
a URL-shaped texture answer and an extension to the renderer's path handling. Against the live
gateway, `/texture?path=Interface\Icons\Spell_Fire_FlameBolt.blp` answers 200 with **5,412 bytes**
and `/spell-icon/185` answers 200 with **the same 5,412 bytes** — one picture, two routes — and the
icon path is what the real `GetActionTexture` returns anyway. So the seam answers the client's own
texture name and nothing was re-plumbed.

**3. The TOC can be cut.** `FRAMEXML_VERTICAL_TOC` is nineteen of the real TOC's 210 entries, in the
real TOC's order:

| | full TOC | vertical subset |
|---|---:|---:|
| files reached | 335 | **35** |
| bytes | 10,085 KiB | **1,205 KiB** |
| Lua chunks executed | 209 | 23 |
| files that fail to load | 0 | **0** |
| widgets | 25,352 | **846** |
| errors raised / distinct | 124 / 54 | **2 / 2** |
| load, node | 6,142 ms | **784 ms** |
| whole page, browser, warm gateway | 7,968 ms at `?render=0` | **658 ms**, rendered |

The two raises left are corpus globals belonging to files the subset omits — `GMChatFrame`
(`UIParent.lua:473`) and `NUM_CONTAINER_FRAMES` (`UIParent.lua:2173`). Three entries are left out
deliberately and the constant's doc comment gives the reason for each; the sharpest is
`WorldFrame.xml`, whose `OnUpdate` would have raised once **per rendered frame**.

### What the census did

| | F2 | F3, no seam | F3 + canned seam |
|---|---:|---:|---:|
| errors raised | 126 | 128 | **124** |
| distinct failures | 57 | 58 | **54** |
| widgets | 25,308 | 25,352 | 25,352 |
| C-API reached | 187 | 191 | **202** |
| unanswered widget methods | 32 | **28** | **28** |

The seamless column is deliberately the one the corpus test pins, because that is the boot it
builds. It is two raises worse than F2 and that is F1's own predicted shape — more of the interface
runs far enough to reach the host. With a world attached, the same corpus is better than F2 on both
counts, and `tests/framexml-seam.test.mjs` pins that too.

### The cooldown sweep

`Cooldown:SetCooldown(start, duration)` is one call site in the whole corpus (`Cooldown.lua`, eight
lines) and the only part of an action button that cannot be faked by drawing. The state lives on the
widget in `GetTime()` seconds; the DOM renderer paints it as a `conic-gradient` whose single hard
stop sweeps clockwise from twelve o'clock, and advances it through `tickCooldowns`, which walks the
61 `Cooldown` widgets rather than the 846 rendered ones. Measured in the live page: 0.998 remaining
at the click, 0.292 seven seconds later on a ten-second cooldown, the angle going 0.8° to 254.8°.

### In the world

`?framexml=1` on `index.html` mounts the vertical over the world after the world is up:
`FrameXmlWorldMount.ts` builds its own overlay host inside `#world-viewport` at `z-index: 3` — over
both world canvases, under the chat (20), the windows (21/22) and the menus (210) — with its own
copy of the renderer's four browser rules, because `glue.css`'s are scoped to an id `index.html`
already uses for the login screens. The DOM HUD is untouched and stays the default; where the
FrameXML bar and the DOM `#action-bar` (z-index 6) overlap, the DOM one draws on top.

## Running it

```
http://127.0.0.1:5173/framexml.html?toc=vertical
```

| parameter | |
|---|---|
| `?toc=vertical` | the action bar's dependency subset — 35 files instead of 335 |
| `?seam=none` | F2's neutral world instead of the canned one (the canned seam is the default) |
| `?file=UIParent.lua` | load one file (and what it includes); the plan is still built from the whole corpus |
| `?gateway=…` | `host:port`, `http(s)://origin` or `ws(s)://…` — the spellings `FrontDoor.ts` accepts |
| `?render=0` | measure only, no DOM mount |
| `?textures=0/1` | override the pictures: on for `?toc=vertical` (472 textures naming **38 distinct files**), off for the whole corpus (13,852 `Texture` widgets is 13,852 BLP conversions and it saturates the page) |
| `?exercise=0` | stop after the TOC walk, without the four session events |

`window.frameXmlClick("ActionButton1")` presses a button from the console, which is how the whole
secure-attribute chain is proved: a screenshot cannot press one.

The page publishes `window.frameXmlDiagnostics()` — the whole inventory object — the same way
`glueDiagnostics()` works, so a browser check reads the numbers instead of being told them.

`node --test tests/framexml-corpus.test.mjs` pins the same numbers: floors on what must keep
working, **ceilings** on what is still broken. A later slice's progress is a ceiling coming down.
