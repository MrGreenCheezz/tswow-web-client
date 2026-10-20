# Аудит набора тестов (20.10.2026)

Только чтение: ни один тест не изменён и не удалён, коммитов нет. Список ниже — **предложение для владельца**; без его одобрения ничего не убирается.
Метод: статический разбор `tests/*.test.mjs` скриптами (импорты, пути, экспорты, имена и модули тестов, условия `skip`) плюс одиночные запуски `node tools/run-tests.mjs tests/<файл>` по одному (96 файлов, 474 с суммарно; полный набор не запускался).

## 0. Сводка

| Показатель | Значение |
| --- | --- |
| Файлов `*.test.mjs` | 1354 (≈16 МБ текста, 9248 вызовов `test(`/`it(`) |
| из них `framexml-*` / `glue-*` | 494 (5,6 МБ, 2581 тест) / 47 |
| Файлов с условием `skip` | 436 (из них 337 — с `skip:`-опцией по данным клиента/датасета) |
| Тесты, импортирующие `dist/code/...` (в режиме `--source` отображаются на `src/`) | 1278; прямых импортов `src/` нет |
| Малых файлов (<3 КБ и ≤2 теста) | 85 |

| № | Категория | Найдено | Рекомендация |
| --- | --- | --- | --- |
| 1 | Звук и чат | 24 файла по имени + ≈34 по содержимому | **Удалять нечего**: весь код жив (см. §1); чат-слияние −10 файлов |
| 2 | Предмет теста исчез | 0 файлов с реальной зависимостью; 1 падающий тест; 11 упоминаний fengari только в комментариях | править 1 тест, 6 комментариев |
| 3 | Дубликаты и пересечения | 80 «основ» из 201 файла → карта слияния (§3) | ≈ −120 файлов без потери проверок |
| 4 | Не выполняются на этой машине | ≈30 файлов с зависимостью от модулей/внешних данных, ≈20 тестов реально пропускаются | см. §4 |
| 5 | Медленные | `*-vertical` и `*-integration` | см. §5 |

## 1. Вне объёма: звук и чат

Решение владельца от 29.09 убрало звук и чат **из плана работ**, а не из кода. Проверка: `ChatProtocol`, `ChatDock`, `ChatFormat`, `ChatLink`, `ChatInputOwner`, `FrameXmlChatApi`, `FrameXmlChatColors`, `ChannelProtocol`, `Sound`, `SoundClient`, `WeatherSound`, `GlueAudio`, `SoundMetadata` — все файлы на месте и импортируются из 38 файлов `src/` (`EnterWorld.ts`, `Context.ts`, `WorldClient.ts`, `Gateway.ts`, `LiveWorldSeam.ts`, `CannedWorldSeam.ts`, `FrameXmlWorldMount.ts`, `GmConsole.ts` и др.). Поэтому **тестов, охраняющих только удалённое поведение, нет**; удалять их без удаления кода — значит снять охрану с живого кода. Решение для владельца: либо оставить как есть, либо сначала решить судьбу кода (вне объёма этого аудита).

**A. Охраняют общий код, который нужен стоковому UI (оставить):**
- `framexml-chat-api` (15 тестов) — привязки C-API чата; без них не поднимается `ChatFrame.lua`.
- `framexml-chat-integration`, `-stock-slash`, `-ownership`, `-dock-selection`, `-colors`, `-parentkey`, `-vertical` — реальный `ChatFrame.xml/lua` из клиента (цвета, слэш-команды, владение полем ввода).
- `framexml-chat-seam` (13 тестов) — насос чата и журнал шёпота `GetAutoCompleteResults` (общий с автодополнением).
- `framexml-seam-minimap-chat` (26 КБ) — в основном миникарта и CVar, чат лишь в имени.
- `framexml-cvar-gmchat` — GM-чат (пункт 8.17 плана «Поддержка» оставлен).
- `chat-input-owner`, `chat-key-bindings` — владелец клавиши Enter и миграция сохранённых таблиц клавиш (не только чат).
- Прочие, где чат — часть чужой подсистемы: `framexml-seam-residuals` (78 упоминаний), `framexml-message-frame` (30), `framexml-mechanics-seam`, `framexml-auction-seam`, `framexml-achievement-live-seam`, `combat-log-filters`.

**B. Охраняют самостоятельный код вне плана (оставить, при желании вынести в «редкий» прогон):**
`chat` (протокол пакета), `chat-format`, `chat-link`, `chat-whisper`, `chat-dock-coalescing`, `channel-roster`, `sound` (87 КБ, 34 теста, `SoundMetadata` gateway), `weather-sound`, `glue-audio`, `lfg-proposal-sound`, `framexml-play-sound`. Работают без клиента/датасета не все: `sound` читает DBC (в данной среде данные есть).

**Слияние (только если владелец хочет сократить число файлов):** `framexml-chat-parentkey` (1 КБ) → `framexml-chat-vertical`; `chat-whisper` → `chat-format`; `framexml-play-sound` → `framexml-chat-api` или отдельный `framexml-sound`.

## 2. Предмет теста исчез

- Недостающие файлы: проверены строки-пути, `new URL(..., import.meta.url)`, `join/resolve(...)` (47 совпадений, все — встроенные фикстуры/тексты или необязательные внешние каталоги). Реально отсутствует один: `framexml-dom.test.mjs:1815` читает `tswow-install/.../TSAddons/custom-companions/addon/addon.lua` (в установке нет модулей, кроме `default`) — тест пропускается (`skip: !existsSync`), см. §4.
- Экспорты: проверено 10 576 именованных импортов из `dist/code/*`/`src` против `export` в `src/` — **ни одного отсутствующего символа** (7 срабатываний — комментарии в фигурных скобках).
- **Падает сейчас:** `tests/gateway.test.mjs:796` «Spell DBC metadata resolves localized names, icon paths and cooldowns» — `deepEqual` по `attributes` расходится (ожидание отстало от схемы `/dbc/spells`, которая выросла до `v=20`). Это устаревшее ожидание, а не удаление: исправить, не удалять.
- fengari: в коде и тестах нет ни импорта, ни зависимости. 11 файлов упоминают его **только в комментариях** («исторически»): `framexml-bit`, `framexml-saved-variables:423`, `glue-lua-base51`, `glue-lua-large-number`, `glue-lua-natives`, `glue-lua-next-walks`, `glue-lua-strings`, `glue-lua`, `lua-shim-cost`, `lua-wasm-api`, `vite-config:15`. Сами проверки (порядок `pairs` как в PUC, `fmod`, большие числа) охраняют текущую WASM-ВМ и остаются. Рекомендация: переименовать/подчистить комментарии и имена (`glue-lua-large-number` назван «по fengari»).
- Кандидат на пересмотр: `attachment-sheath` (комментарий «superseded by Wow.exe 0x0072b7f0»), `camera-views-ordinary` (комментарий: «real CameraRig module … gone with advanceCameraFollow») — проверить, остались ли проверки реальным кодом, а не базовой копией.
- Лестницы версий (поддержка старого gateway): `visual-tile-v5`/`-v7`/`-dedupe`/`-sidecar`, `spell-metadata-v16`/`-v17`, `light-data-v5`, `terrain-splat-v2` — маршрут `/dbc/spells` уже на `v=20`, v16/v17 — подмножества; решение владельца, нужна ли обратная совместимость со старым gateway.

## 3. Дубликаты и карта слияния

Принцип: один файл на подсистему, сохраняя все `test()` (механическое объединение, без потери проверок). Суффиксы по кучам: `-vertical` 82 файла, `-seam` 72, `-controller` 20, `-metadata` 16, `-integration` 15, `-lifecycle` 13, `-model` 12, `-review` 9, `-regression` 8. «Пересечения» подтверждены общим набором импортируемых модулей: напр. 19 файлов `CannedWorldSeam+FrameXmlBoot+FrameXmlCorpus+mpq+paths`, 16 файлов `FrameXmlBoot+GlueLoader+FrameXmlDomRenderer`, 15 файлов `FrameXmlBoot+GlueLoader`.

### 3.1. Предложенное слияние (стем → файлы; в скобках тесты/КБ)

Крупные подсистемы (по одному файлу `framexml-<стем>.test.mjs` либо два: `-seam` и `-vertical`):
- **merchant** (6 файлов): controller, metadata, mount, mounted-token, seam, vertical → 1 (всего ≈10 тестов, ≈24 КБ). Плюс `framexml-merchant-bridge`, `-confirmation-contract`, `-live-merchant-seam`.
- **quest** (5): controller, integration, lifecycle, mount, seam → 1–2; плюс `quest-poi`+`quest-poi-review`, `quest-fading-review`, `quest-log-*`.
- **achievement** (4): live-seam, mount, seam, vertical → seam+live-seam / mount+vertical (2).
- **auction** (4): controller, live-seam, seam (23 теста), vertical → 2.
- **aura** (4): integration, performance, seam, vertical; **aura-dispel** (3) → 2.
- **character** (4): controller, integration, seam, vertical → 2.
- **chat** (4): api, integration, seam, vertical (+ ownership/colors/...) → см. §1.
- **friends**, **gossip**, **guildbank**, **mail**, **lfd**, **loot**, **popups**, **tradeskill**, **calendar** (3–5 файлов каждый: controller / seam / live(-seam) / vertical / model / route) → по 2 файла: «seam+controller+live» (быстрые) и «vertical» (тяжёлый, с MPQ).
- **arena**, **pvp**, **spellbook**, **talent**, **castbar**, **bag**, **bank**, **honor**, **skill**, **reputation**, **encounter**, **multicast**, **minimap**, **itemtext**, **taxi**, **trade**, **trainer**, **stable**, **petition**, **hud-mechanics/mechanics**, **combatlog**, **targetframe**, **talent-preview** (2–3 файла) → по 1 файлу на стем.
- Всего 80 стемов в 201 файле → ≈80–90 файлов: **−110…−120 файлов**.

Малые «последующие» файлы без своего предмета (85 штук <3 КБ, ≤2 теста): в `framexml-*` — `arena-controller`, `character-points-seam`, `chat-parentkey`, `faction-by-id-seam`, `fallback-notices`, `get-spell-info`, `has-pet-ui-creator`, `honor-seam`, `lfd-reward-items`, `lua-compat`, `merchant-controller`, `merchant-mounted-token`, `merchant-seam`, `model-preview`, `object-type`, `paperdoll-textures`, `parent-name`, `quest-controller`, `reputation-resolver`, `setid-unchanged`, `spell-tooltip-references`, `spellbook-controller`, `spellbook-not-ready`, `spellbook-tabs`, `stage-scale`, `stub-floor-touch`, `talent-controller`, `tooltip-spellbook-load`; вне — `battleground-client/-metadata`, `character-options-route`, `liquid-route`, `local-asset-health-nonce`, `glue-highlight-texture`, `glue-widget-anchors`, `glue-lua-large-number/-stack`, `lua-shim-cost`, `key-bindings-window`, `welcome-hints`, `parity-core-fingerprint/-external-resources/-native-profile`, `quest-failure/-giver-mark/-share-guard`, `showing-helm`, `stop-gateway`, `logout-countdown`, `unit-frame-range` и т.д. (полный список — скрипт-вывод: файлы с `size<3000 && tests<=2`). Каждый сливается в ближайший файл своей подсистемы.

### 3.2. Другие группы без префикса framexml

- Контракт маршрута «версия, путь и валидатор» повторён в 9 файлах (`area-triggers`, `combat-animations`, `creature-type-metadata`, `framexml-glyph`, `framexml-pet-food-types`, `framexml-regen-stats`, `framexml-titles`, `framexml-trainer-groups`, `wmo-area`; 4 теста с одним и тем же заголовком «the route answers through the catalog table with the Origin and version checks», ещё 3 — «version is pinned…»). Общий `gateway-catalog-routes.test.mjs` уже проверяет Origin 403 / `?v=` 400 / не кэшируется / 500 — таблично. Предложение: оставить в этих файлах только проверку **содержимого**, а общую часть заменить строкой в таблице `gateway-catalog-routes`.
- 29 файлов `*-metadata`/`*-route` (barber×2, spell-metadata×7 [`-dedupe`, `-usable`, `-v16`, `-v17`, …], battleground, dungeon-encounter, lfg-dungeon, reputation, taxi, vendor-cost, vehicle-catalog-route…) — кандидаты на таблицу «маршрут → колонки» (−10…−15 файлов).
- `-review`/`-regression` (17 файлов): `glue-rename-review` (13 тестов, рядом `glue-rename`), `light-data-v5-review` (рядом `light-data-v5`), `liquid-families-review`, `mirror-image-review`, `vehicle-trajectory-review`, `framexml-quest-poi-review`, `tooltip-l4-review`, `native-item-duration-l4-review`, `spell-visual-review-e`, `*-regression` (`world-interaction`, `tab-order`, `ui-interaction`, `native-ui`, `hud-aura-quest`, `terrain-indoor-visual`, `collision-foliage`, `framexml-live-character`, `framexml-lua-error`) → влить в файл подсистемы (−17).
- Цепочки одной подсистемы: `character-atlas-*` (5 файлов, один модуль `CharacterAtlas`) → 1; `animation-*` (clip-cache, palette, rig-performance, `rig-pose-freeze`) → 1; `terrain-request-cap/-fairness`, `terrain-probe-alloc` → 1; `environment-*` (6) + `rendered-records`, `shadow-caster-writers`, `sun`, `wmo-floor-visual-cache` (8 файлов на `WorldRenderer3D`) → 2; `spell-visual` + `spell-visual-lifecycle` (89 тестов, 100 КБ) → оставить раздельно (по размеру); `glue-lua-*` (8 файлов) → 3; `group-model`+`group`, `guild-model`+`guild`, `item-tooltip`+`item`, `mail`+`mail-ui`, `render-cost`+`render` — слить попарно; `visual-tile-v5/v7/dedupe/sidecar` → 1.
- Совпавших заголовков тестов между файлами лишь 4 — дословных копий почти нет, то есть дубли по **теме**, а не по тексту.

Итого по категории: ≈ −150 файлов при том же числе проверок.

## 4. Пропуски на этой машине

Данные на месте: клиент `F:\Circle` с `Data/`, `dbcDirectory` (247 DBC, включая `Vehicle`, `VehicleSeat`, `SpellMissile`, `Spell`, `SpellChainEffects`, `Map`), `maps`, `vmaps`, `luaxml/Interface`, `data/visual-dbc`, `data/horizon`, `src/generated/client-data/{animations,classIcons,globalStrings}.ts`. Поэтому условия `skip` по клиенту (≈163 места), по DBC (≈60) и по сгенерированным данным **выполняются** — эти тесты идут. Замер подтвердил (`# skipped 0` у `dbc`, `mpq`, `wmo`, `framexml-corpus`, `sound` и т.д.).

Реально пропускаются (запуск 20.10):

| Файл | Пропущено | Причина | Выполняется где-нибудь? |
| --- | --- | --- | --- |
| `particles` | 9 из 44 | `M2_SAMPLE_ROOT` не задан (нужны распакованные модели v264) | только если владелец распакует образцы — иначе нигде |
| `m2-particles` | 4 из 8 | то же | то же |
| `window-schema` | 2 из 27 | нет `CONTENT_STUDIO_DIR` / нет экрана студии | только при настроенной студии |
| `tswow-minimap-hub-host` | 3 из 3 | нет модулей (`modules/` содержит только `default`) и typescript-to-lua | только с установкой модулей |
| `tswow-survival-packet-routing` | 1 из 1 | нет модуля `survival` | то же |
| `framexml-socketing` | 1 из 1 | нет gem-abilities и TSWoW-библиотек | то же |
| `framexml-socket-vertical` | 1 из 5 | нет модуля gem-abilities | то же |
| `framexml-talent-addon-integration` | 2 из 4 | нет модуля retail-talents | то же |
| `framexml-tsaddon-real-entry-backlog` | 1 из 1 | нет FrameXML с TSWoW-аддонами | то же |
| `framexml-dom` | 1 из 40 | нет `custom-companions/addon.lua` | то же |
| `character-body` | 1 из 27 | «classic» требует отсутствия overlay/patch-W…Z — на живой цепочке не бывает | **нигде** на машине владельца (patch-W легитимен) |
| `local-patches` | 1 из 12 | case-collision только на регистрозависимой ФС | только на Linux/CI |

Прочие файлы с зависимостью от модулей/установки TSWoW (замер не делался, по числу упоминаний `skip`-причин): `framexml-addon-metadata`, `framexml-addon-runtime`, `framexml-addons-only-messages`, `framexml-client-network`, `framexml-corpus`, `framexml-tsaddon-{contract,entry-backlog,generated,lint,loading-screen}`, `tswow-require-preload` (идёт: 3/3), `module-loader`, `patch-status`, `settings-owner-defaults`, `spell-visual-review-e` — частично зависят от модулей; по правилу «модульные тесты пропускаются с причиной» это нормально.

Замечания:
- 38 файлов содержат жёсткий путь `F:\Circle`/`F:\tswowRoot` (напр. `animation`, `framexml-corpus`, `framexml-vehicle`) — работают только здесь; их стоит перевести на `tools/paths.mjs`.
- Рекомендация по «никогда не выполняются»: `particles`/`m2-particles` (13 тестов) — либо задокументировать `M2_SAMPLE_ROOT` и образцы, либо вынести в пометку «ручная проверка»; `character-body` №14 — решить, тест заменить на проверку с живой цепочкой.

## 5. Самые медленные (замер одиночным запуском, включая ≈0,5 с старта)

Время 96 файлов — 474 с, т. е. в среднем ≈5 с; остальные 1250+ файлов не мерялись. Сверху:

| Файл | с | тестов |
| --- | --- | --- |
| `framexml-popups-vertical` | 35,3 | 22 |
| `framexml-achievement-vertical` | 28,7 | 15 |
| `framexml-friends-vertical` | 24,9 | 12 |
| `framexml-mail-vertical` | 18,6 | 7 |
| `framexml-auction-vertical` | 18,1 | 9 |
| `framexml-lfd-vertical` | 16,1 | 8 |
| `framexml-calendar-vertical` | 15,7 | 11 |
| `framexml-tradeskill-addon-integration` | 13,7 | 4 |
| `framexml-petition-vertical` | 13,6 | 6 |
| `framexml-trainer-addon-integration` | 10,5 | 2 |
| `framexml-loot-vertical` | 10,0 | 10 |
| `framexml-socket-vertical` | 9,6 | 5 |
| `wmo` | 9,6 | 29 |

Эти 12 `*-vertical` дают ≈206 из 474 с; `*-integration` — ≈80 с. Причина — загрузка настоящих `FrameXML`/MPQ-корпуса (`FrameXmlBoot` + `FrameXmlCorpus`) в каждом файле. Вывод: слияние `-vertical` одной подсистемы в один процесс не ускорит само по себе; ускорит общий кэш корпуса между файлами (или один загруженный корпус на несколько подсистем в одном файле, `concurrency` 1). Всего 82 `*-vertical` + 15 `*-integration` + ≈30 `-addon-*` файлов (≈25 % набора по времени, оценка по выборке — не замер).

## 6. Рекомендованный список для одобрения

1. **Починить**: `gateway.test.mjs:796` (устаревшее ожидание).
2. **Слить без потери проверок** (§3): ≈150 файлов → ≈ −150; сначала `merchant`, `quest`, `achievement`, `auction`, `friends`, `mail`, `popups` (они и самые тяжёлые), потом малые файлы (<3 КБ) и `*-review`/`*-regression`.
3. **Таблица контрактов маршрутов**: убрать дублирующие проверки Origin/`?v=` из 9 файлов (§3.2).
4. **Комментарии fengari** — подчистить в 11 файлах (§2); имена `glue-lua-large-number`, `lua-shim-cost` — переименовать.
5. **Звук/чат**: удалять ничего не рекомендуется (код жив); решение — оставить или сначала решить судьбу кода.
6. **Не выполняемые нигде**: `particles`/`m2-particles` (13 тестов), `character-body` №14 — документировать данные или перевести в ручные проверки.
7. **Пути `F:\…`** в 38 файлах — на `tools/paths.mjs`.
8. **Решить по лестницам версий** (`spell-metadata-v16`, `visual-tile-v5`, `light-data-v5`): нужна ли совместимость со старым gateway.

## 7. Выполнено 20.10: слияние (п. 2, частично)

Владелец одобрил слияние. 196 файлов слиты в 67: файлов в наборе стало 1225 вместо 1354, проверки все сохранены. Имена в списках выше — прежние.
- FrameXML: 144 лёгких файла → 49 (`framexml-<подсистема>.test.mjs`; `framexml-live-*` вошли в свою подсистему; где имя уже занято тяжёлым файлом — `-core`: `framexml-calendar-core`, `framexml-dom-core`, `framexml-quest-poi-core`). Прогон до/после по группам: 881 тест, 0 падений, числа совпали.
- Вне FrameXML: 52 → 18 (`character-atlas`, `environment-{models,index,admission}`, `glue-lua`, `spell-metadata`, `visual-tile`, `terrain-requests`, `animation-runtime`, пары `group`/`guild`/`item`/`render`/`light-data-v5`/`liquid-families`/`mirror-image`/`vehicle-trajectory`/`spell-visual`). 409 тестов, числа совпали.
- Способ: импорты подняты в шапку без дублей, тело каждого прежнего файла — в своём блоке `{ … }` с меткой `// ── <прежнее имя>`, поэтому помощники и загрузки модулей не пересекаются. Ссылки на прежние имена исправлены в `docs/implementation/`, комментариях `src/`, `tools/` и тестов.
- Не сливались (по-прежнему отдельными процессами): файлы с хуками `before/after`, с записью в `globalThis`/`process.env`, и тяжёлые, которые грузят корпус FrameXML/MPQ (`*-vertical`, `*-integration`), а также `-regression` без файла-хозяина.

Ограничения: полный набор не запускался; число пропусков получено запуском 96 файлов (не всех 436 с `skip`), по остальным — статический разбор условий и проверка наличия данных.
