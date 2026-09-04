<div align="center">
  <img src="public/favicon.svg" width="96" height="96" alt="TSWoW WebClient logo">
  <h1>TSWoW WebClient</h1>
  <p>An educational browser-client and interoperability research project for TSWoW/TrinityCore World of Warcraft 3.3.5a.</p>
  <p><strong>TypeScript · Three.js · WebGL · Node.js · WebSocket</strong></p>
</div>

[![CI](https://github.com/MrGreenCheezz/tswow-web-client/actions/workflows/ci.yml/badge.svg)](https://github.com/MrGreenCheezz/tswow-web-client/actions/workflows/ci.yml)

> [!IMPORTANT]
> This is an experimental educational project, not a drop-in replacement for the official client.
> It targets WoW 3.3.5a build 12340 and reads only the TSWoW data and legally obtained original
> client files supplied by each user on their own machine. The repository does not distribute MPQ,
> DBC, FrameXML, generated localized-string tables, extracted assets or other World of Warcraft files.
> Share only the tracked source tree. A locally generated `dist/` can embed client-derived data and
> is explicitly **not** a redistributable or publicly hostable artifact of this release.

[Русская версия](README.ru.md)

## What works

- SRP6 authentication, realm and character selection, character creation and world entry.
- Live object updates, movement, collision, gravity, swimming, transport, taxi and mounts.
- Targeting, auto-attack, spells, auras, combat log, loot, inventory and item tooltips.
- Quests, gossip, vendors, trainers, groups, guilds, mail, auction house and social windows.
- Three.js world rendering with ADT terrain, M2/WMO models, doodads, animation and particles.
- Server-derived lighting, weather, water, indoor WMO fog, sound and environmental effects.
- On-demand asset extraction from local MPQ archives with disk caches and source stamps.
- TSWoW module-defined windows, custom packets and diagnostics.

The project is actively developed. See [Known limitations](#known-limitations) before planning a
deployment.

## Architecture

```text
Browser / Vite :5173
  ├─ WebSocket /auth and /world ──> Node gateway :8090 ──> authserver :3724
  │                                                     └─> worldserver :8085
  └─ HTTP metadata and assets ────> Node gateway
                                      ├─> TSWoW dbc/maps/vmaps
                                      ├─> local WoW 3.3.5a Data/MPQ
                                      └─> ignored data/ and public/ caches
```

The browser never connects directly to TrinityCore TCP sockets. The Node gateway translates those
connections to WebSocket and serves metadata, collision, models, textures and generated assets.

## Requirements

| Task | Required |
| --- | --- |
| Compile or test the repository | Node.js 22+, npm 10+ and the matching TSWoW TrinityCore source tree |
| Start the gateway | Built TSWoW `dbc`, `maps` and `vmaps` directories |
| Log in and play | Running compatible TSWoW/TrinityCore authserver and worldserver |
| Render/extract all assets | A legally obtained WoW 3.3.5a build 12340 client |
| Generate gameplay client tables | The matching TSWoW dataset, TrinityCore source and original client |
| Pre-generate DB metadata | World database access, `worldserver.conf` and a MySQL CLI |

Windows 10/11 is the currently tested runtime. Much of the TypeScript toolchain is cross-platform,
but the complete TSWoW asset workflow and case-sensitive filesystem behavior are not yet verified
on Linux or macOS.

TSWoW can keep using its legacy Node runtime: its `start.bat` invokes the bundled
`bin/node/node.exe`, not the Node executable from the system `PATH`. For a side-by-side setup,
extract portable Node.js 22 x64 to `.runtime/node/` or set `WEBCLIENT_NODE_DIR`.
`start-gateway.bat` and `start-web.bat` prefer that runtime and change `PATH` only inside their own
processes; `.runtime/` is Git-ignored and must never be published.

## Quick start

1. Clone the repository and install exactly the locked dependencies:

   ```powershell
   git clone https://github.com/MrGreenCheezz/tswow-web-client.git
   cd tswow-web-client
   npm ci
   ```

2. Create your local configuration:

   ```powershell
   Copy-Item .env.example .env
   ```

   On Bash, use `cp .env.example .env`. Edit `.env` and set `CLIENT_DIR`, `TRINITYCORE_DIR`, plus
   either `TSWOW_INSTALL` or `TSWOW_DATASET`. Paths may use forward slashes on Windows.

3. Generate the local-only protocol and client tables, validate the runtime paths, then compile:

   ```powershell
   npm run client-data:generate
   npm run doctor
   npm run build
   ```

   Protocol metadata is generated from the configured TSWoW TrinityCore source into the ignored
   `src/generated/protocol-data/` directory. When client-derived tables are absent, build commands
   create neutral client-data stubs for source review and CI. Those stubs contain no client values
   and cannot be used for gameplay; the gateway requires the real local implementations created by
   `npm run client-data:generate`.

   A gameplay build is local-only because its browser bundle can contain those generated tables.
   Do not publish or upload `dist/`; publish the source repository instead.

4. Start your compatible authserver and worldserver. Then open two terminals in this repository:

   ```powershell
   # Terminal 1
   npm run gateway

   # Terminal 2
   npm run dev
   ```

5. Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Gateway liveness is available at
   [http://127.0.0.1:8090/health](http://127.0.0.1:8090/health).

The gateway generates most visual assets on first request. To reduce first-visit delays on Windows,
you may run `build-assets.bat` after the database-related settings in `.env` are correct. This
optional warm-up can take time and creates ignored local caches.

On every normal gateway launch (when `VISUAL_DBC_DIR` is not explicitly set), the nine client-media
DBCs are automatically extracted as one set from the active `CLIENT_DIR` chain into an immutable,
content-addressed generation under `data/visual-dbc`; the gateway only selects it after every table,
stamp, and profile file is complete. Classic, HD, and arbitrary patch letters are therefore handled alike: the winning
resource matters, not the archive name. The `.src` stamps prevent a model generation from being
paired with another generation's tables. An explicitly set `VISUAL_DBC_DIR` remains a trusted
operator override and must be synchronized manually with `npm run assets:visual-dbc`.

Apply a new patch set like the original client does: publish the complete related set, then restart
the gateway and reload the page. For example, the current `W/X/Y/Z` HD set cannot be enabled or
disabled one archive at a time—without `W`, creature models from `X/Y` and baked textures from `Z`
still win and do not form a classic profile.

The in-world addon host follows the same winning chain on ordinary login and keeps complete generated
`tsaddon-begin-lib` / `tsaddon-begin:<module>` blocks from the active `FrameXML.toc` in their
authored order, and exposes TSWoW's `_CLIENT_NETWORK` custom-packet ABI to them. A patched standard
toggle (for example the talent window on `N`) owns that route when its rendered root is valid; the
native browser panel remains the fallback when the patch is absent or cannot mount. A patch publish
during a running session also closes `/client/file` until restart so late-loaded UI cannot mix two
generations. TSWoW widgets appear over the native UI; `?framexml=1` additionally selects the diagnostic stock FrameXML HUD.

Compatibility targets this project's own TSWoW modules. `npm run tswow-addons:check` checks their
generated Lua, command/menu entrypoints and packet/UI scenarios. Reading a TOC is not proof that
an addon works. See the [TSWoW addon contract and current gaps](TSWOW_ADDON_COMPATIBILITY.ru.md).

### Autonomous client pack

Each user can build a local snapshot from their own installed client:

```powershell
npm run client-pack:dry-run
npm run build:autonomous
$env:CLIENT_PACK_DIR = (Resolve-Path dist/client-pack)
npm run client-pack:verify
npm run gateway
```

Before copying, `build:autonomous` runs the project's TSWoW addon behavior scenarios;
failed scenarios or modules without a scenario stop the build with a reason. The pack preserves
`Data` with its original MPQs and loose `.MPQ` directories, plus `Interface/AddOns` and `Fonts`.
Its manifest records every path, size and SHA-256. Once selected,
the gateway and every asset generator read `CLIENT_PACK_DIR`, so the source `CLIENT_DIR` is no
longer required. Rebuild the complete pack after installing a new patch set. An existing pack is
replaced only after the new snapshot is complete and the source client remained unchanged while it
was copied.

## Configuration

`.env` is loaded by gateway and tool scripts but is never committed. Vite also reads the same file
for browser settings whose names begin with `VITE_`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CLIENT_DIR` | portable sibling search | WoW directory containing `Data/` |
| `CLIENT_PACK_DIR` | unset | Autonomous local client snapshot; takes priority over `CLIENT_DIR` |
| `VISUAL_DBC_DIR` | stamped `data/visual-dbc` auto-detection | Explicit visual DBC overlay override; trusted as-is |
| `TSWOW_INSTALL` | `../tswow-install` | TSWoW installation containing `modules/` |
| `TSWOW_DATASET` | derived from install | Direct dataset override |
| `TRINITYCORE_DIR` | `../tswow/cores/TrinityCore` | Local protocol/client-table generation and verification |
| `CLIENT_LOCALE` | `ruRU` | Gateway and generator DBC locale |
| `VITE_CLIENT_LOCALE` | `ruRU` | Locale sent by browser authentication; keep it in sync |
| `GATEWAY_HOST` / `GATEWAY_PORT` | `127.0.0.1` / `8090` | Gateway listener |
| `ALLOWED_ORIGINS` | local Vite origins | Comma-separated browser origins |
| `AUTH_HOST` / `AUTH_PORT` | `127.0.0.1` / `3724` | TrinityCore authserver |
| `WORLD_HOST` / `WORLD_PORT` | `127.0.0.1` / `8085` | TrinityCore worldserver |
| `WEB_HOST` / `WEB_PORT` | `127.0.0.1` / `5173` | Vite development server |
| `WEB_ALLOWED_HOSTS` | Vite safe defaults | Comma-separated DNS hostnames allowed for LAN development |
| `VITE_GATEWAY_ORIGIN` | derived page host on `:8090` | Public HTTP(S) gateway/reverse-proxy origin |
| `MODULE_DIRS` | local drafts + TSWoW modules | Optional module source roots |
| `MODULE_UI_WRITE` | `0` | Enables loopback-only module UI writes when set to `1` |

See [.env.example](.env.example) for dataset path overrides, cache directories and database tooling.

## Commands

| Command | Description |
| --- | --- |
| `npm run doctor` | Validate runtime paths and print optional missing capabilities |
| `npm run dev` | Start the Vite development server |
| `npm run gateway` | Rebuild, validate local data and start the gateway |
| `npm run gateway:dev` | Alias for the rebuild-and-start gateway workflow |
| `npm run build` | TypeScript and Vite build; requires the configured core for local protocol generation |
| `npm test` | Build plus the Node test suite; client-data cases skip when local files are unavailable |
| `npm run protocol:generate` | Generate ignored protocol tables from the configured TSWoW TrinityCore source |
| `npm run protocol:check` | Compare ignored protocol tables with that configured source |
| `npm run client-data:prepare` | Create ignored neutral stubs when local generated tables are absent |
| `npm run client-data:generate` | Generate all ignored protocol and gameplay tables from user-supplied inputs |
| `npm run client-data:check` | Compare ignored runtime tables with their local configured inputs |
| `npm run check:generated` | Verify tracked DBC layouts and ignored local generated data |
| `npm run modules:check` | Validate module UI and custom-message definitions |
| `npm run patches:check` | Compare the TSWoW dataset, active MPQ chain, generated TSAddons and native updater manifest; exits non-zero on an incomplete patch contract |
| `npm run client-pack:dry-run` | Measure an autonomous pack without copying client files |
| `npm run client-pack:build` | Build local `dist/client-pack` from `CLIENT_DIR`, preserving MPQs and loose `.MPQ` directories |
| `npm run client-pack:verify` | Verify every autonomous-pack file against its SHA-256 manifest |
| `npm run client-addons:check` | Execute every root-level AddOn, including load-on-demand modules, from the selected client/pack |
| `npm run tswow-addons:check` | Check the project's generated TSWoW modules from the active FrameXML.toc; `-- --json` returns a report |
| `npm run build:autonomous` | Build the web bundle, check TSWoW addon scenarios, then build the autonomous client pack |
| `npm run build:full` | Full configured-workspace verification followed by the build |
| `npm run assets:visual-dbc` | Re-extract visual DBC files and stamp them against the current client pack |
| `npm run assets:restamp` | Add/update source stamps without rerendering asset caches |

Additional `assets:*` and `*:generate` commands are listed in [package.json](package.json).
Data-free facades, generators and redistributable DBC layouts are committed. Protocol tables,
client-derived implementations and generated assets remain local and ignored.

## Security and deployment

The gateway is an unauthenticated bridge to authserver/worldserver and exposes expensive local
asset routes. `Origin` filtering is useful browser policy, not authentication.

- Keep port 8090 on loopback by default and never publish it directly to the Internet.
- For LAN use, explicitly set `GATEWAY_HOST`, `WEB_HOST`, exact `ALLOWED_ORIGINS`, and
  `WEB_ALLOWED_HOSTS` when the page is opened through a DNS name.
- If `GATEWAY_PORT` differs from 8090, set `VITE_GATEWAY_ORIGIN` with the same explicit port.
- Public hosting of `dist/web` or the gateway is not supported by this educational release.
  Data-equipped build output is local-only and may contain generated client tables.
- Leave `MODULE_UI_WRITE=0` unless actively authoring modules on the same machine.
- Never commit `.env`, `.npmrc`, database dumps, credentials, certificates or generated client data.

See [SECURITY.md](SECURITY.md) for reporting and hardening guidance.

## Generated data and legal files

The repository intentionally excludes MPQs, DBC/SQL dumps, FrameXML, generated localized-string tables,
extracted textures/models/sounds and runtime caches. Client-derived TypeScript implementations are
generated only into the ignored `src/generated/client-data/` directory from files supplied by the
user. Protocol tables are likewise generated from the user's matching TSWoW TrinityCore checkout
into ignored `src/generated/protocol-data/`. Tracked facades contain none of those table values.

The local browser bundle produced after client-data generation may contain those generated tables.
For that reason `dist/` is ignored, stamped with a local-only warning and must not be redistributed
or publicly hosted. Only the tracked source tree is the intended public artifact.

The tracked DBC definitions/layouts come from an open upstream specification project under its own
terms; they are not silently relicensed as original MIT code.

The project's original source is MIT-licensed. WoWDBDefs definitions and derived layouts are CC BY-SA
4.0, while identified Wowee-influenced portions retain the included upstream notice and its
non-commercial-game restriction. TrinityCore protocol output and client-derived data are generated
locally and are not distributed. This is therefore a mixed-license educational source tree, not a
blanket MIT package. See [tools/dbd/README.md](tools/dbd/README.md), [NOTICE.md](NOTICE.md),
[LICENSES/WOWEE.txt](LICENSES/WOWEE.txt) and [LICENSE](LICENSE) before redistribution.

World of Warcraft and Blizzard Entertainment are trademarks of Blizzard Entertainment, Inc. This
project is not affiliated with or endorsed by Blizzard Entertainment, TrinityCore or TSWoW.

## Project layout

```text
src/browser/    Browser UI, renderer, input and game presentation
src/auth/       3.3.5a authentication protocol
src/world/      World protocol, packets and session state
src/gateway/    Node HTTP/WebSocket gateway and metadata services
src/generated/  Data-free facades plus redistributable DBC layouts
                  (client-data/ and protocol-data/ are ignored and generated locally)
tools/          Generators, MPQ/BLP/ADT/M2/WMO readers and diagnostics
tests/          Node test suite
data/           Small tracked definitions plus ignored runtime caches
examples/       Example module definitions for custom client windows and packets
```

## Known limitations

- Experimental compatibility target: TSWoW/TrinityCore 3.3.5a build 12340 only.
- The interface is Russian-first; other locales require matching client, realm and Vite settings.
- PIN/matrix authentication, Warden and several niche protocol/UI paths are not implemented.
- One gateway targets one configured auth/world backend; realm addresses are not dynamic routes.
- First-time asset generation may pause while MPQ archives are opened and caches are built.
- Public/production hosting is unsupported; data-equipped build outputs are local-only.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), run `npm test`, and do not add client-derived files,
generated locale tables, extracted assets or machine-specific paths. A complete custom-window
and packet example lives under [`examples/module-example/`](examples/module-example/).
