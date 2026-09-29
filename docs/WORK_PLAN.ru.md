# Единый план работ WebClient

> **Как реализовывать** — [план реализации](IMPLEMENTATION_PLAN.ru.md): спецификации всех пунктов (подход, сверка с кодом и ядром, файлы, тесты с мутациями, приёмка), вехи, порядок, окна перезапуска gateway, вопросы владельцу.

Составлен 28.09.2026. Сюда сведены все открытые пункты, чтобы работать по одному списку:
- [аудит 28.09](parity/audit-2026-09-28.ru.md) — в нём доказательства: код, эталон TrinityCore и стокового Lua, замеры;
- остаток [handoff 28.09 §5](parity/handoff-2026-09-28.ru.md);
- [блокеры](parity/parity-blockers.ru.md);
- матрицы [P0](parity/parity-p0-matrix.ru.md) и [P1](parity/parity-p1-matrix.ru.md);
- [каталог оптимизаций 28.09](OPTIMIZATION_CATALOG.ru.md): 142 пункта; здесь — вехи этапа 12 с его ID;
- перф-бэклог из `PERF_STATUS.md` и соседних отчётов.

Методика и критерии приёмки остаются в [CLIENT_PARITY_PLAN.ru.md](CLIENT_PARITY_PLAN.ru.md). Каждый пункт здесь встречается один раз; повторы заменены ссылками на номер.

## Как читать и вести

- **Номер** `N.MM` — этап и пункт. **Тяжесть** — по плану сопоставления:
  - **S0** — действие невозможно или неверный серверный итог;
  - **S1** — видимый обязательный элемент отсутствует или сценарий регулярно ломается;
  - **S2** — локальное расхождение;
  - **Долг** — техдолг и риск;
  - **Безоп.** — безопасность.
- **Размер:**
  - **S** — одна функция или таблица и один тест;
  - **M** — срез в нескольких файлах с тестами;
  - **L** — система: протокол, UI или рендер, данные gateway;
  - **XL** — подсистема на несколько срезов.
- **Отметки:**
  - ⚑ — пересекается с работой параллельной сессии (подземелья, освещение, анимации, окклюзия WMO); начинать после согласования;
  - ☐ — нужно решение владельца или действие вне WebClient.
- **Статус:** `[ ]` не начато, `[~]` в работе, `[x]` сделано. Отметку `[x]` ставить с датой и названием теста; запись о срезе — в [журнал](parity/parity-execution.ru.md).
- **Готово, когда:**
  - есть узкий тест, который падал до правки (мутационная проверка);
  - `tsc --noEmit` без ошибок, соседние тесты зелёные;
  - UI-пункты проверены на офлайн-фикстуре (`framexml.html?toc=vertical`, `.runtime/ui-audit/native.html`);
  - живой проверке назначен пункт этапа 14.
- **Правила исполнения** (обязательны, из handoff §4):
  - перед правкой перечитать указанные строки: номера сдвигаются, другие сессии правят те же файлы;
  - тесты запускать по файлам: `--test-concurrency=1`, `--test-timeout=240000`, `NODE_OPTIONS=--max-old-space-size=4096`;
  - полный прогон — один раз в конце этапа, под сторожем 6 ГБ;
  - фреймы моста не передавать в `assert`;
  - сгенерированные таблицы не править руками;
  - работать только в WebClient (правило 25.09), остальное — заметки владельцу (0.5);
  - auth/world-серверы владельца не запускать; живые проверки делает владелец или по его разрешению.

## Сводка

| Этап | Пунктов | S0 | S1 | Смысл |
|---|---|---|---|---|
| 0. Подготовка и решения | 6 | — | — | Перезапуск gateway, git, правила тестов, решения владельца |
| 1. Быстрые исправления | 29 | 8 | 4 | Малые правки с большим эффектом; можно вести параллельными линиями |
| 2. Недостающие механизмы | 10 | 7 | 2 | Area triggers, ремонт, трактирщик, предмет как цель, сброс талантов, шкуры, переименование |
| 3. Штатный интерфейс | 30 | 3 (1 латентный) | 7 | Журнал боя, события, руны, макросы, клавиши, подсказки, журнал заданий |
| 4. Native-интерфейс | 15 | — | — | Подсказки, перетаскивание, окна |
| 5. Движение, протокол, мир | 29 | — | 8 | Отбрасывание, сплайны, чужие игроки, физика, камера, цели |
| 6. Модели и анимации ⚑ | 21 | — | 5 | Снаряжение NPC, emote-состояния, стойка, труп, эффекты |
| 7. Рендер мира ⚑ | 23 | — | 4 | WMO-подземелья, доодады, небо, лимиты, жидкости |
| 8. Поддержка | 1 | — | — | Отчёты об ошибках и жалобы (звук и чат вне плана) |
| 9. TSWoW и аддоны | 7 | 1 | 2 | Попапы в режиме аддонов, сообщения при входе, класс 13 |
| 10. Вход, gateway, раздача, безопасность | 22 | 1 (латентный) | 1 | Glue, кеш, сборка, раздача, 127.0.0.1 |
| 11. Транспорт и техника | 2 | 2 | — | Крупные подсистемы |
| 12. Производительность | 19 | — | — | Вехи каталога оптимизаций: MEM-1 и быстрые правки, тени, окружение, планировщик, прототипы переписок |
| 13. Документация и репозиторий | 7 | — | — | Устаревшее, битые ссылки, удалённые файлы |
| 14. Живая приёмка | 26 | — | — | P0/P1, проверки сделанного, эталон, FPS gate |

**Порядок.**
- Этапы 0 и 1 — первыми.
- Этап 2 — сразу за ними, по одному механизму за срез.
- Этапы 3, 5 и 10 можно вести параллельно, если линии не делят файлы.
- Этапы 6, 7 и 12 — после согласования с параллельной сессией.
- Этап 11 — отдельным длинным треком.
- Этапы 13 и 14 — непрерывно: живая приёмка после каждого закрытого этапа.

---

## Этап 0. Подготовка и решения владельца

- [x] **0.1** ☐ — **Перезапуск gateway владельцем** (`restart-gateway.bat`). Сейчас работает сборка от 11:23, `gateway-build-stale` → stale, `/dbc/char-titles` → 404. После перезапуска заработают титулы и глобальные WMO подземелий (работа параллельной сессии). Проверка: GET `/dbc/char-titles` → 200. **Сделано владельцем 29.09 в 00:30** (`start-dev`: `gateway:dev`, `gateway`, `dev`; `dist/code` и `dist/web` пересобраны). Проверено 29.09: `GET /dbc/char-titles?v=1` → 200 (15 659 Б, есть женские формы; без `v` маршрут отвечает 400), `/environment/43/31/30` → 200 (глобальный WMO Пещер Стенаний).
- [ ] **0.2** ☐ — **Зафиксировать работу в git (по просьбе владельца).**
  - `docs/` целиком не отслеживается; последний коммит `3b09070` от 20.09; изменено 400 файлов, неотслеживаемых 741.
  - Удалённый `NOTICE.md`: либо восстановить, либо поправить ссылки из `package.json:5` («SEE LICENSE IN NOTICE.md»), `LICENSE:4`, `vite.config.mjs:79`.
  - Удалённый `tools/dbd/README.md` содержит атрибуцию CC BY-SA для `.dbd`, которые остались в git. На него ссылаются `src/generated/dbcLayouts.ts:2`, `tools/generate-dbc-layouts.mjs:28`, `tools/dbd-tables.mjs`, `tests/dbc.test.mjs:112`, `src/gateway/SoundMetadata.ts:142` — это лицензионный риск.
- [ ] **0.3** ☐ — **Закрепить правила тестов** (с согласия владельца). В `package.json` для `test` и `test:source`: `--test-concurrency=4`, `--test-timeout=240000`, `NODE_OPTIONS=--max-old-space-size=4096`; короткое правило в `AGENTS.md`. Сейчас `npm test` идёт с ≈19 воркерами без лимита кучи; это повторение условий инцидента 28.09 (101/131 ГБ).
- [ ] **0.4** ☐ — **Решения владельца** (от них зависят пункты в скобках):
  - a) штатный FrameXML HUD по умолчанию для всех игроков: сейчас по умолчанию native, `originalFrameXml=false`, `ui/SettingsModel.ts:269` (3.24, 4.x);
  - b) Lua-аддоны TSWoW включены по умолчанию, как в клиенте TSWoW: сейчас `false`, `SettingsModel.ts:273` (9.02);
  - c) лимиты допуска — дальность вместо количества: сейчас 64 юнита, GO 120 ярдов/96, частицы 90 ярдов/32 эмиттера, анимации доодадов 90/48 (7.05);
  - d) AutoQuality включён по умолчанию, но снижает только чёткость (12.15);
  - e) качество освещения по умолчанию (сейчас 1) и калибровка контрольного профиля (7.20);
  - f) публичная раздача: TLS или обратный прокси; до пункта 1.03 наружу не открывать (10.02);
  - g) раскладка клавиш по умолчанию — как в стоковом `Bindings.xml` или текущая (4.11);
  - h) native HUD как полноценная альтернатива или только запасной (4.09);
  - i) решения из [каталога оптимизаций §5](OPTIMIZATION_CATALOG.ru.md) (этап 12):
    - MEM-1: базовый браузер ES2022;
    - MEM-4: флаги V8;
    - MEM-5: темп кадров (`--uncapped` или 72 Гц);
    - MEM-6: потеря контекста WebGL;
    - MEM-8: бэкенд ANGLE;
    - UI-22: патч или вендоринг fengari;
    - ENV-6: трава по секторам;
    - ENV-16/ARC-6: сжатые текстуры, только отдельным профилем;
    - RND-4б: база Lambert в контрольном профиле (связано с 7.07);
    - RND-11: средний каскад через кадр;
    - NET-5: ручки AutoQuality;
    - NET-21: heartbeat 500 мс;
    - ARC-2: DOM-оверлеи с задержкой в кадр.
- [ ] **0.5** ☐ — **Вне WebClient** (заметки владельцу; по правилу 25.09 WebClient их не делает):
  - публикация патчей: `patches:check` — 5 ошибок: не опубликован 441 файл, включая patch-W…Z; 47 файлов отличаются; 428 устарели; 2 файла payload отсутствуют; `realmlist.wtf` и `d3d9.dll` не совпадают с манифестом; 1277 URL по HTTP — доставка Lua/DLL без проверки подлинности;
  - сборка и публикация `minimap-hub` (решение 25.09 об общей кнопке);
  - установка правки `bot_ai.cpp` (`UNIT_STREAMING_FIXES.ru.md:69-75`);
  - доказать, что `worldserver.exe` собран из текущих исходников.
- [x] **0.6** — **Согласование с параллельной сессией** (подземелья, освещение, анимации, производительность). Пункты ⚑ начинать после её коммита или передачи. Её текущая работа:
  - глобальные WMO подземелий: `VMapProtocol.ts`, `CollisionSource.ts`, `Gateway.ts`;
  - окклюзия и порталы WMO: `WmoOcclusion.ts`, `WmoModel.ts`;
  - `UnitActionArbiter.ts` (слои state, cast, melee, reaction, emote);
  - `SpellVisuals.ts` и `SpellVisualLifecycle.ts`;
  - `CMSG_RESET_INSTANCES`.
  - **Передано 29.09:** [handoff ночи 29.09](parity/handoff-2026-09-28-night.ru.md) — всё перечисленное сделано и проверено тестами (файлы — в §3 передачи). Остаются коммит (0.2) и живая проверка (14.24). Пункты ⚑ можно начинать; пересечения — только с тем, что перечислено в §3 передачи.
  - Кроме перечисленного, той же сессией по отчёту владельца от вечера 28.09 сделано: постоянные сборщики текстур и моделей gateway, очередь с приоритетами, переподпись кеша (иконки и текстуры — доказательством по пикселям), ранний показ тела персонажа, скрытые портреты и один пересчёт характеристик за опрос, вода WMO в физике, «Левитация», выход из группы, опрос позиций поля боя раз в секунду, подтверждения движения.

## Этап 1. Быстрые исправления

Предлагаемые линии с непересекающимися файлами:
- **A**, FrameXML-шов: 1.05–1.10, 1.12–1.15;
- **B**, WorldClient и EnterWorld: 1.17, 1.18, 1.20, 1.21, 1.25–1.27, 1.30, 1.32;
- **C**, ввод, настройки, native: 1.04, 1.28, 1.31;
- **D**, glue, gateway, crypto, Electron: 1.02, 1.03, 1.19, 1.29;
- **E**, рендер ⚑: 1.22–1.24.

- [ ] **1.02** · S0 · S — **Вход в мир по http из браузера.** `world/WorldCrypt.ts:40-49`: HMAC-SHA1 без `crypto.subtle` на основе `auth/Sha1.ts`, как уже сделано для SRP6 (`auth/Srp6.ts:35-40`). Тест: векторы RFC 2202 и `WorldCrypt.create` без `subtle`.
- [ ] **1.03** · Безоп. · S — **Gateway падает от одного запроса.** `gateway/Gateway.ts:3436-3455` (`on("upgrade")`): `new URL` обернуть в try; на ветках 403/404/503 повесить `socket.on("error")`; добавить защиту уровня процесса. Тест: модель обработчика с RST и `GET //[::1`.
- [ ] **1.04** · S0 · S — **Клавиши 1–= и бонус-панель.** `input/Actions.ts:53-56` → `ui/ActionBar.ts:321` `useSlot(column, page)` не учитывает `GetBonusBarOffset` (`LiveWorldSeam.bonusBarOffset`). Нужно для стоек, форм и незаметности, в native и при штатном HUD. Клик мышью в стоке уже верен (`FrameXmlWorldMount.ts:3286`). Тест: стойка воина → слот 73+.
- [ ] **1.05** · S0 · S — **`HasFullControl`.** Сейчас не привязан, nil. Отвечать по флагам потери контроля (страх, контроль, оглушение, подчинение). Снимает серость «Обмен» и «Дуэль» в меню портрета (`UnitPopup.lua:1048, 1092`).
- [ ] **1.06** · S0 · S — **`LeaveBattlefield`** → `WorldClient.leaveBattleground` (`:3510`). Кнопки в меню значка (`BattlefieldFrame.lua:688`) и в таблице (`WorldStateFrame.xml:1480`).
- [ ] **1.07** · S0 · S — **`SetActiveTalentGroup`** → касты 63645/63644, как в native (`ui/Talents.ts:45`), плюс `ACTIVE_TALENT_GROUP_CHANGED` (`Blizzard_TalentUI.lua:527`).
- [ ] **1.08** · S0 · S — **Сложность подземелья и рейда.** `Get/SetDungeonDifficulty` и `Get/SetRaidDifficulty` → `WorldClient.setDifficulty` (`:5004`). `IsInInstance` отвечать из `GetInstanceInfo`: сейчас вне арены `false, "none"` (`FrameXmlArenaApi.ts:30`).
- [ ] **1.09** · S0 · S — **PvP-флаг.** `TogglePVP`/`SetPVP` → `WorldClient.togglePvp` (`:3552`); `IsPVPTimerRunning` — таймер флага.
- [ ] **1.10** · S0 · S — **Команды меню портрета и SecureTemplates, для которых пакеты уже есть:**
  - `FocusUnit`/`ClearFocus`, `AssistUnit`;
  - `PromoteToAssistant`/`DemoteAssistant` → `:2795`; `Set/ClearPartyAssignment` → `:2825`;
  - «Сообщить AFK»;
  - `TargetNearest*`/`TargetLast*`, `Dismount`, `CancelShapeshiftForm`, `SpellTargetUnit`, `DropItemOnUnit`.
- [ ] **1.12** · S1 · S — **«Поделиться» заданием.** `GetQuestLogPushable`/`QuestLogPushQuest` → `WorldClient.shareQuest` (`:5984`); `MSG_QUEST_PUSH_RESULT` → сообщение отправителю (сейчас пустой обработчик).
- [ ] **1.13** · S1 · S — **Глобальный `GetText(token, gender)`** — метки отношения в окне репутации (`ReputationFrame.lua:167`). Дополнить тест `framexml-reputation-vertical`.
- [ ] **1.14** · S2 · S — **Кнопки действий:**
  - `isAutoRepeatAction` по живому автоповтору (`LiveWorldSeam.ts:5860`): сейчас «Автоматическая стрельба» и «Выстрел» всегда горят и мигают;
  - `IsAttackAction`;
  - события `START/STOP_AUTOREPEAT_SPELL` и `ACTIONBAR_UPDATE_STATE`;
  - `IsActionInRange` по дальности заклинания (сейчас nil, `:5865`).
- [ ] **1.15** · S2 · S — **`UnitHasRelicSlot("player")` по классу:** паладин, шаман, друид, DK; сейчас вместо реликвии AmmoSlot (`PaperDollFrame.lua:1094-1098`). **`SetBagPortraitTexture`:** портреты сумок и банка (`ContainerFrame.lua:493, 507`).
- [ ] **1.17** · S1 · S — **Ближний телепорт** (та же карта: Скачок, Шаг сквозь тень, Демонический круг) не через `onWorldChanged` (`EnterWorld.ts:374-411`; `WorldClient ~1545`). Без экрана загрузки, `collision.reset()`, сброса зажатых клавиш и автобега, остановки музыки и `forgetEncounters`.
- [ ] **1.18** · S2 · S — **Тексты промахов `MISS_REASONS`** (`WorldClient.ts:638-641`) по `SharedDefines.h:1545-1556`: 8 IMMUNE2 → иммунитет, 9 DEFLECT → отклонено, 10 ABSORB → поглощено, 11 REFLECT → отражено; кода 12 нет.
- [ ] **1.19** · S2 · S — **Glue: коды отказов.**
  - Отказы по имени `CHAR_NAME_*` 87–103 и `CHAR_CREATE_*` 62–69 (`glue/GlueCreation.ts:60-76`; сейчас 42–44, игрок видит «Неизвестная ошибка»).
  - `WOW_FAIL_UNLOCKABLE_LOCK` (0x19).
  - Проверка имени на клиенте по правилам ядра, а не только «длина < 2» (`:539`).
- [ ] **1.20** · S2 · S — **`CMSG_MOVE_NOT_ACTIVE_MOVER` с packed guid** (`WorldClient.ts:1610`; ядро читает packed — `MovementHandler.cpp:586-588`).
- [ ] **1.21** · S2 · S — **Аукцион: «выиграно» или «перебили».** Сравнивать с guid персонажа, а не с `controlledGuid` (`WorldClient.ts:7511`).
- [ ] **1.22** · S2 · S ⚑ — **Убранные ружья и арбалеты** (inventoryType 26) не рисуются (`Attachment.ts:54` ждёт 15). Исправить и тест `attachment-sheath.test.mjs:35-36`, который закрепляет неверный тип.
- [ ] **1.23** · S2 · S ⚑ — **Регулярное выражение стенд-ина деревьев** `/tree|oak|pine|willow|bush|shrub/` (`WorldRenderer3D ~1382`) ловит `streetlamp` (×200+) и `spine` (×336): фонари «вырастают», на их месте зелёная крона. Сверить со списком из кеша тайлов.
- [ ] **1.24** · S2 · S ⚑ — **Повторы запросов после сбоя** с нарастающей паузой, как у террейна: сплат (`TerrainSplat.ts:141, 312`), `LightClient` (`:310, :344`: иначе до конца сессии «полдень»), горизонт (`Horizon.ts:285-290`).
- [ ] **1.25** · Долг · S — **`WorldClient`:**
  - `#waitFor` → `#handleUtilityPacket` в try/catch (`:4486-4489`; ошибка парсера на экране персонажей обрывает вход);
  - `ITEM_ENCHANT_TIME_UPDATE` и `SOCKET_GEMS_RESULT` через `WorldStore` (`:6376, 6385`), чтобы подписчики получали изменения.
- [ ] **1.26** · S2 · S — **Кулдаун «на удержании»** из `INITIAL_SPELLS` (1/0x80000000) не превращать в ≈24,8 суток; `COOLDOWN_EVENT` снимает удержание (`WorldClient.ts:5700-5779`). Пример: заклинание после входа в Незаметности.
- [ ] **1.27** · S2 · S — **`CAST_FAILED`:** читать хвост (custom error, totems, area) и показывать конкретный текст (`world/SpellProtocol.ts:289-292`).
- [ ] **1.28** · S1 · S — **Native: таланты и символы.**
  - Кнопка «Сбросить» — через подтверждение с ценой (`ui/Talents.ts:222-236`, связано с 2.04).
  - Символы: подтверждение снятия; вставка через `useGlyphItem(…, glyphIndex)` в выбранную ячейку, а не первого предмета со словом «символ» (`:376-406`).
- [ ] **1.29** · S2 · S — **Electron:** `render-process-gone` → экран ошибки с перезагрузкой вместо пустого окна; `JSON.parse(stdout)` в try (`electron/main.cjs:155`).
- [ ] **1.30** · S2 · S — **`GetNetStats`:** счётчики байт сокета в `WorldConnection` → трафик вместо 0/0 (`FrameXmlWorldSeam.ts:2149-2152`).
- [ ] **1.31** · S2 · S — **Мелкие ошибки native:** подписи качества в фильтре аукциона сдвинуты на одну (`index.html:286`); лимит золота ранга 4294967295 → «без ограничений» (`ui/Guild.ts:228`).
- [ ] **1.32** · S2 · S — **Сырые ID в сообщениях → имена из кэшей и DBC:** «Задание N» и «отклонено, код N» (`WorldClient.ts:5155-5158`), «Зона N атакована» (`:4732`), «Подземелье N», «предмет N», «Изучено заклинание N», «Гильдия · событие N», «заклинание N» в журнале боя (`:5889-5891`).

## Этап 2. Недостающие механизмы

- [ ] **2.01** · S0 · L — **Area triggers.**
  - Маршрут gateway для `AreaTrigger.dbc` (сферы и коробки с поворотом).
  - Проверка входа в объём на каждом шаге движения и после телепорта, с учётом карты; `CMSG_AREATRIGGER` один раз на вход.
  - Реакции: телепорт в подземелье (`NEW_WORLD`), отдых (флаг resting), исследование, сдача флага WSG/EotS, призрак к телу в подземелье, скрипты модулей.
  - TC: `MiscHandler.cpp:725-887`, `BattlegroundWS.cpp:695-703`.
  - Тест: попадание в объём на реальном DBC. Живая проверка — 14.22. Зависит от 0.1.
- [ ] **2.02** · S0 · M — **Ремонт.**
  - Сборщик `CMSG_REPAIR_ITEM` (npc, item или 0, гильдейский банк).
  - `CanMerchantRepair` по `UNIT_NPC_FLAG_REPAIR`; `GetRepairAllCost` по прочности с `DurabilityCosts.dbc` и `DurabilityQuality.dbc`.
  - `ShowRepairCursor`/`HideRepairCursor`/`InRepairMode`/`RepairAllItems`/`CanGuildBankRepair`; кнопки MerchantFrame; ремонт в native-окне торговца.
  - Сейчас `LiveWorldSeam.ts:3104-3107` отвечает false. DurabilityFrame — 3.06.
- [ ] **2.03** · S0 · S — **Трактирщик.**
  - `SMSG_BINDER_CONFIRM` (сейчас выбрасывается, `WorldClient.ts:6196`) → событие `CONFIRM_BINDER` и диалог в native → `ConfirmBinder` → `CMSG_BINDER_ACTIVATE` (TC `NPCHandler.cpp:287-306`).
  - `SMSG_PLAYER_BOUND` → сообщение и `bindPoint`; `GetBindLocation`.
- [ ] **2.04** · S0 · M — **Сброс талантов у тренера.** `MSG_TALENT_WIPE_CONFIRM(guid, cost)` (сейчас → только `TALENTS_CHANGED`, `WorldClient.ts:6328`) → `CONFIRM_TALENT_WIPE` с ценой → `ConfirmTalentWipe` → ответ серверу; отказ без запроса. Native — в 1.28.
- [ ] **2.05** · S0 · L — **Предмет как цель.**
  - Режим курсора `SpellIsTargeting` для заклинаний и предметов с целью-предметом; `TARGET_FLAG_ITEM`/`TRADE_ITEM` в `CMSG_USE_ITEM` и `CMSG_CAST_SPELL` (`world/ItemProtocol.ts:141-165` сейчас шлёт без цели).
  - `SpellTargetItem`, `SpellCanTargetItem`; клик по слоту сумки, экипировки и обмена — в стоке и native.
  - Покрывает: яды, точила, масла, приманки, распыление, просеивание, измельчение, взлом сейфов, кормление питомца, чары через слот обмена 7, подарочную упаковку (`CMSG_WRAP_ITEM`).
  - Тесты на реальных строках Spell.dbc.
- [ ] **2.06** · S0 · S — **Снятие шкур и сбор с существ.** ПКМ по трупу с `UNIT_FLAG_SKINNABLE` (а также травы и руда по флагам существ) после добычи → каст навыка сбора (сейчас только `CMSG_LOOT`, `ui/Npc.ts:150`); курсор сбора.
- [ ] **2.07** · S0 · M — **Переименование.**
  - Флаг `CHARACTER_FLAG_RENAME` (`AT_LOGIN_RENAME`) → диалог `FORCE_RENAME_CHARACTER` → `RenameCharacter` → `CMSG_CHAR_RENAME` → ответ.
  - Не входить без диалога: сейчас ядро кикает, цикл «разрыв → выбор» (`glue/GlueApi.ts:195`, `GlueCharacterApi.ts:160-181`; TC `CharacterHandler.cpp:753-756`).
- [ ] **2.08** · S1 · M — **Смена внешности, фракции и расы.** `CustomizeExistingCharacter` и `PaidChange_*` → `CMSG_CHAR_CUSTOMIZE`/`FACTION_CHANGE`/`RACE_CHANGE`; экраны glue (`GlueApi.ts:199-200`). TC сам ставит `AT_LOGIN_CUSTOMIZE` при недопустимой внешности (`Player.cpp:1502-1516`).
- [ ] **2.09** · S1 · S — **Привязка к подземелью.** `SMSG_INSTANCE_LOCK_WARNING_QUERY` → попап `INSTANCE_LOCK_*` → `RespondInstanceLock` → `CMSG_INSTANCE_LOCK_RESPONSE` (TC `MiscHandler.cpp:1558-1562`).
- [ ] **2.10** · S2 · M — **Возврат покупок.** `CMSG_ITEM_REFUND_INFO`/`CMSG_ITEM_REFUND`, `SMSG_ITEM_REFUND_*` (сейчас пустые), попап `END_REFUND`, строка подсказки со сроком.

## Этап 3. Штатный интерфейс (FrameXML)

- [ ] **3.01** · S1 · L — **Журнал боя.**
  - `COMBAT_LOG_EVENT(_UNFILTERED)` из пакетов урона, лечения, аур и заклинаний с аргументами 3.3.5; сюда же `SPELLLOGEXECUTE` и `ENCHANTMENTLOG` (сейчас пустые).
  - `PLAYER_LOGIN` при входе и после `/reload` плюс `IsLoggedIn`, чтобы `UIParent.lua:480-483` загрузил `Blizzard_CombatLog`.
  - Фильтры журнала боя.
  - Проверка: вертикаль CombatLog и `MSBTParser.lua` на фикстуре — MSBT оживает.
- [ ] **3.02** · S1 · M — **`UNIT_SPELLCAST_SENT/SUCCEEDED/FAILED_QUIET/(NOT_)INTERRUPTIBLE`.** `/castsequence` переходит к следующему шагу (`ChatFrame.lua:723-801`); `MSBTCooldowns.lua:242`.
- [ ] **3.03** · S1 · M — **Рыцарь смерти.**
  - `RuneFrame` в TOC, `GetRuneCooldown`/`GetRuneType` из `world.runes` (`WorldClient.ts:6702-6720`), `RUNE_POWER_UPDATE`/`RUNE_TYPE_UPDATE`.
  - Убрать nil-вызов `RuneFrame:SetScale` (`UnitFrame.lua:67-75`): он прерывает `PlayerFrame_ToPlayerArt`, и PetFrame, Buff и сброс раскладки не выполняются.
- [ ] **3.05** · S2 · S — **`ZoneText` и `FadingFrame`:** название зоны и подзоны, PvP-статус территории, «следование за».
- [ ] **3.06** · S2 · S — **`DurabilityFrame`** плюс `UPDATE_INVENTORY_DURABILITY` и `UPDATE_INVENTORY_ALERTS` (вместе с 2.02).
- [ ] **3.07** · S2 · M — **Панель «Зов стихий»** (`MultiCastActionBar`): `HasMultiCastActionBar`, заклинания тотемов по слотам.
- [ ] **3.09** · S2 · S — **Мелкие стоковые файлы.**
  - `CoinPickupFrame` с `OpenCoinPickupFrame`/`DropCursorMoney`/`PickupPlayerMoney`.
  - `EasyMenu.lua`.
  - `Localization`/`LocalizationPost` для ruRU: `SetEuropeanNumbers(true)`, PlayerHitIndicator, окно склонений имени питомца.
- [ ] **3.10** · S1 · M — **Макросы.**
  - `SecureCmdOptionParse` — все клаузы и условия (`mod`, `combat`, `harm`, `help`, `dead`, `target`/`@`, `stance`, `form`, `nomod`…); сейчас только первая клауза и `[@unit]`.
  - `RunMacro`, `RunMacroText`, `StopMacro`, `/click` (`GetClickFrame`); условия state-драйверов.
  - Native `runMacro` перевести на общий парсер (`ui/Macros.ts:99-112`).
- [ ] **3.11** · S1 · M — **Клавиши.**
  - Действия: `SHAPESHIFTBUTTON1-10`, `BONUSACTIONBUTTON1-10` (панель питомца), окна O/U/Y, `TOGGLEBAG1-4`, `TOGGLESHEATH`, `SCREENSHOT`, `TOGGLEUI` (Alt+Z), `TARGETPARTYMEMBER1-4`/`TARGETPET`/`TARGETSELF`, `ASSISTTARGET`, клавиши камеры.
  - API: `SetBindingSpell/Item/Macro`, `SetOverrideBinding*`.
  - Где: `framexml/FrameXmlBinding.ts:25-27, 80-110`, `input/Bindings.ts:14-126`. В браузере Ctrl+1…8 перехватит Chrome — полностью решаемо только в Electron.
- [ ] **3.12** · S1 · M — **Подсказки.**
  - `GameTooltip:SetTalent` — подсказки талантов в штатном окне пустые.
  - `SetHyperlinkCompareItem` — Shift-сравнение (`GameTooltip.lua:232-325`); native-блок «Сейчас надето» для стока отключён (`ui/ItemTooltip.ts:252-256`).
  - `SetBuybackItem`, `SetMerchantCostItem`, `SetQuest(Log)RewardSpell`, `SetTotem`, `SetEquipmentSet`, `SetLFGDungeonReward`.
  - `SetHyperlink` для quest, talent и glyph.
  - Тип существа и «<подпись>» в подсказке NPC (`glue/GlueWidgets.ts:1208-1226`).
- [ ] **3.13** · S1 · M — **Журнал заданий, трекер, карта.**
  - Заголовки зон, `Expand/CollapseQuestHeader`, метки (группа, подземелье, рейд, ежедневное) — сейчас пустые (`LiveWorldSeam.ts:4576-4578`).
  - `GetQuestLink`; `GetQuestLogSpecialItemInfo`/`UseQuestLogSpecialItem` (кнопки предметов в WatchFrame).
  - `GetDailyQuestsCompleted`, `GetQuestsCompleted` (`completedQuests`).
  - QuestPOI на карте мира: `DrawQuestBlob`, `SetFill*`, `SetBorder*`, `QuestPOIUpdateIcons`, `GetQuestPOILeaderBoard` — сейчас заглушки.
  - Метки стражников (`gossipPoi`).
- [ ] **3.14** · S0 · M — **Поле боя.**
  - `GetNumBattlefieldScores`/`GetBattlefieldScore`/`RequestBattlefieldScoreData`/`SetBattlefieldScoreFaction`, `UPDATE_BATTLEFIELD_SCORE`, `WORLD_STATE_UI_TIMER_UPDATE`, таймер духа-хранителя (уже есть в состоянии).
  - Одна таблица: native — только при native HUD (`EnterWorld.ts:649`).
  - `Blizzard_BattlefieldMinimap` (LoD) — либо поддержать, либо отказывать без ошибки загрузки при каждом входе (`WorldStateFrame.lua:103-105, 368-372`).
  - Сообщения о входе и выходе игроков.
- [ ] **3.15** · S0 · M — **Команды арены в PVPFrame.** `ArenaTeamRoster`, `GetArenaTeamRosterInfo`, `ArenaTeamInviteByName`, `ArenaTeamLeave`, `ArenaTeamDisband`, `ArenaTeamSetLeaderByName`, `ArenaTeamUninviteByName` и попапы → `WorldClient` `:3574-3602`.
- [ ] **3.16** · S2 · M — **Рамки боссов и арены.**
  - `ENCOUNTER_FRAME` → `INSTANCE_ENCOUNTER_ENGAGE_UNIT` (юниты boss1..4); при штатном HUD скрывать native `#boss-frames` (сейчас под миникартой, наложение на WatchFrame).
  - Скрывать native `#arena-frames` при `ArenaEnemyFrames` — сейчас дубль.
- [ ] **3.18** · S2 · M — **Жизненный цикл аддонов.**
  - `LoadAddOn` загружает известные LoD, а не отвечает `NOT_READY` (`FrameXmlAddonRuntime.ts:192-204`); `/msbt`.
  - `InterfaceOptions_AddCategory` — панели настроек аддонов; `GetAddOnMetadata`, `GetAutoCompleteResults`. `PLAYER_LOGIN` — в 3.01.
- [ ] **3.19** · S2 · M — **CVar.**
  - Сохранять все зарегистрированные CVar, как `Config.wtf`; сейчас только 29 (`FrameXmlSettingsCVar.ts:72-102`).
  - `SetCVar` с аргументом event → `CVAR_UPDATE`: «статус-текст» и «полоса заклинаний цели» применяются сразу (`TextStatusBar.lua:13-27`, `TargetFrame.lua:222, 861`).
  - `SetModifiedClick` сохраняется.
- [ ] **3.20** · S2 · M — **`issecure()` всегда false** (`glue/GlueLua.ts:323`), поэтому пункты «Выбрать целью», RAID_MAINTANK и MAINASSIST скрыты (`UnitPopup.lua:593, 752, 758`). Определить семантику защищённого вызова для кнопок меню, не отдавая глобально true.
- [ ] **3.21** · S2 · S — **Заглушки методов виджетов** (найдены переписью):
  - `ColorSelect:SetColorRGB/GetColorRGB` (ColorPickerFrame);
  - `ScrollingMessageFrame:UpdateColorByID` (700 вызовов; смена цвета канала не перекрашивает строки);
  - `PlayerModel:SetUnit` (модель в PetPaperDoll);
  - `Frame:Play` (AnimationGroup/AnimTimerFrame).
- [ ] **3.22** · S2 · M — **События, которых сток не получает** (каждое со своим источником данных):
  - попапы: `BIND_ENCHANT`, `REPLACE_ENCHANT`, `TRADE_REPLACE_ENCHANT`, `END_BOUND_TRADEABLE`, `INSTANCE_BOOT_START/STOP`, `QUEST_ACCEPT_CONFIRM`;
  - контроль и бой: `PLAYER_CONTROL_LOST/GAINED`, `PET_ATTACK_START/STOP`;
  - персонаж и группа: `UNIT_PET_EXPERIENCE`, `PARTY_LOOT_METHOD_CHANGED`, `COMBAT_RATING_UPDATE`, `CHARACTER_POINTS_CHANGED`;
  - мир: `MINIMAP_PING` (+ `InitWorldMapPing`), `ZONE_UNDER_ATTACK`, `NEW_TITLE_EARNED`, `MIRROR_TIMER_PAUSE`, `HONOR_AWARDED` (`SMSG_PVP_CREDIT`).
- [ ] **3.23** · S2 · M — **Константы там, где данные есть.**
  - `petHappiness` (`LiveWorldSeam.ts:6558`); шанс крита от ловкости, реген от духа, пробивание брони (`:5059-5096`); `UnitIsPVPFreeForAll`; `UnitCreatureType`; `PickupMerchantItem`.
  - Требования у тренера: `NumAbilityReq`, линия навыка по строке тренера (`:7191-7194`).
- [ ] **3.24** · S2 · M — **Смешанный интерфейс.**
  - Первое открытие тренера, профессии, аукциона и банка гильдии показывает native-окно (`FrameXmlWorldMount.ts:1519-1520`).
  - Слой стока с z-index 3 лежит ниже native-окон (21–22), поэтому штатные окна и тултипы под ними (`:251-253, 2455-2458`).
  - Откат при непройденном гейте виден только в `console.warn`.
  - Native-остатки перевести или оставить осознанно (решение 0.4a): тренер профессий, награда LFD, общий квест (`InteractionPrompts.ts:153`), GM-тикеты, рейд-сетка.
- [ ] **3.25** · S2 · S — **LFR и награда LFD в стоке.** `LFRParentFrame` загружен, но не подключён (`FrameXmlLfd.ts:825-828`); `CMSG_SET_LFG_COMMENT`, `SEARCH_LFG_JOIN/LEAVE`, `LFG_GET_STATUS`.
- [ ] **3.26** · S2 · S — **Модуль retail-talents заменяет штатное окно талантов, и вкладка символов пропадает** (`FrameXmlWorldMount.ts:3867-3877`).
- [ ] **3.27** · Долг · M — **Lua VM** (fengari 5.3 + шимы 5.1):
  - освобождать ссылку при замене `SetScript`/`HookScript` (`FrameXmlRuntime.ts:2379-2392`);
  - `SetScript("OnUpdate", nil)` не должен снимать хуки;
  - `next` без O(n²) (`GlueLua.ts:264`);
  - `strsplit` — набор разделителей (`:210`);
  - монотонный `GetTime` (`FrameXmlBoot.ts:1389`);
  - `setfenv`/`newproxy` — по потребности аддонов.
- [ ] **3.28** · Долг · S — **Гейт сумок.** Прокси `InterfaceOptionsFrame` не должен обнулять настоящий фрейм при снятии владельца (`FrameXmlWorldMount.ts:878-957`).
- [ ] **3.29** · S2 · M — **Тренер.** Заголовки групп и `Collapse/ExpandTrainerSkillLine` (сейчас только перерисовка) — нужен источник: наблюдение оригинала (`parity-blockers.ru.md` §Trainer). Вернуть тест штатного тренера с живым `WorldClient` по новой схеме (прежний зависал и был удалён).
- [ ] **3.30** · S0 (латентно) · S — **`UnitCharacterPoints` отвечает cp2 = 0** (`LiveWorldSeam.ts:7263`). Нужно число свободных слотов профессий (`PLAYER_CHARACTER_POINTS2`) до перевода тренеров профессий на сток: там 1-й ранг основной профессии стоит `PointCost[1] = 1` (`Trainer.cpp:100`).
- [ ] **3.31** · S2 · S — **Оставшиеся неотвеченные имена переписи.**
  - `LocalizeFrames`.
  - `RaidGroupFrame_Update` (вызов до загрузки `Blizzard_RaidUI`).
  - `CombatText_UpdateDisplayedMessages` — мост к браузерному FCT или `Blizzard_CombatText`.
  - `ArenaEnemyBackground_SetOpacity`, `BNToastFrame_OnUpdate`.
- [ ] **3.32** · S2 · S — **`CMSG_SET_ACTIONBAR_TOGGLES`:** видимость дополнительных панелей хранится на сервере, как в оригинале.
- [ ] **3.33** · S2 · M — **Предпросмотр талантов** (`CMSG_LEARN_PREVIEW_TALENTS`, опция помечена неподдерживаемой, `FrameXmlOptions.ts`).

## Этап 4. Native-интерфейс

Объём этапа зависит от решения 0.4h.

- [ ] **4.01** · S2 · M — **Всплывающие подсказки браузера `title`** (64 места в `src/browser/ui`, 12 в `index.html`) → собственный тултип.
- [ ] **4.02** · S2 · S — **Полупрозрачная копия при HTML5-перетаскивании** → `setDragImage` (`ActionBar.ts:90, 184`; `ItemSlots.ts:544`; `PetBar.ts:84`; `Spellbook.ts:789`). Предмет на курсоре в native-окнах.
- [ ] **4.03** · S2 · M — **Окно персонажа.** Характеристики заклинаний и защиты, сила атаки с модификаторами, звания, валюты, шлем и плащ (`ui/CharacterSheet.ts:290-310`); вкладка питомца в книге.
- [ ] **4.04** · S2 · S — **Подсказка при наведении на юнит** (сейчас только имя GO, `Controls.ts:595`); **Escape прерывает каст** (`Controls.ts:159-183`).
- [ ] **4.05** · S2 · S — **Макрос на панель:** `macroDragPayload` нигде не вызывается (`ui/Macros.ts:302`).
- [ ] **4.06** · S2 · S — **Члены группы вне видимости** на карте и миникарте (`WorldMap.ts:701-704`, `Minimap.ts:742-748`); метка на миникарте обычным кликом, а не только Ctrl+клик (`Minimap.ts:177-181`).
- [ ] **4.07** · S2 · S — **Торговец:** покупка количеством (`Npc.ts:806`). **Аукцион:** подтверждение ставки и выкупа (`Social.ts:961-967`).
- [ ] **4.08** · S2 · S — **Рейд-сетка** по подгруппам, пустые ячейки не кликабельны (`UnitFrames.ts:185`); комплекты — «игнорировать ячейку» (`EquipmentSets.ts:106`); хартию предложить на подпись из native.
- [ ] **4.09** · S2 · L ☐ — **Достижения и управление рейдом в native** — только если native остаётся полноценным HUD (0.4h).
- [ ] **4.10** · S2 · S — **Строки.** GlobalStrings вместо зашитого текста (читают только 5 файлов); подписи клавиш у микрокнопок из текущих привязок (`index.html`).
- [ ] **4.11** · S2 · S ☐ — **Раскладка по умолчанию** по стоковому `Bindings.xml` (0.4g). Сейчас O — «Диагностика», K — привязки, F — фокус, G — взаимодействие, Ctrl+Shift+F — FPS. Диагностику с редактором окон убрать за флаг разработчика.
- [ ] **4.12** · S2 · S — **Привязки клавиш и положение окон** хранить в данных аккаунта (`AccountStore`), а не только в localStorage (`input/Bindings.ts:365, 501`; `GameWindows.ts:1, 356`).
- [ ] **4.13** · S2 · S — **Счётчик 20-секундного выхода** в native-панели (`ui/GameMenu.ts:93-101`).
- [ ] **4.14** · S2 · S — **LFG:** предложение спрашивается дважды (`Social.ts:1068` и `InteractionPrompts.ts:262-268`); ожидание всегда «0 мин» (`Social.ts:833`); сырые ID подземелий и полей боя в подсказках (`InteractionPrompts.ts:158, 265`).
- [ ] **4.15** · S2 · S — **Ожидание NPC и дальность GO.** «Ожидание ответа NPC…» без тайм-аута (`Npc.ts:204-218`); клик по GO вне дальности без отклика (`game/Interaction.ts:36`).

## Этап 5. Движение, протокол, состояние мира

- [ ] **5.01** · S1 · M — **Отбрасывание.**
  - `onKnockBack` сейчас не назначен (`WorldClient.ts:780, 1586`).
  - Физика: вертикальная и горизонтальная скорость, FALLING; ACK с блоком прыжка (`MovementAckProtocol.ts:281-285`).
  - Наблюдатели должны видеть дугу (TC `MovementHandler.cpp:651-662`).
- [ ] **5.02** · S1 · M — **Сплайн create-блока.**
  - Применять путь из CREATE (`WorldState.ts:740, 774-792`); неверный комментарий `:611-614` поправить.
  - `FLIGHT_SPLINE_SYNC` без активного движения (`:544-549`).
  - Сейчас NPC, вошедшие в видимость на ходу, всадники такси и циклические летуны стоят или прыгают.
- [ ] **5.03** · S1 · M — **MONSTER_MOVE:** parabolic (прыжки, Хватка смерти), facing target/spot/angle по прибытии, walk-флаг, ярус анимации (`MonsterMoveProtocol.ts:44-66`).
- [ ] **5.04** · S1 · M — **Чужие игроки:** экстраполяция между heartbeat, pitch, дуга прыжка, fallTime (`WorldState.ts:301-335`).
- [ ] **5.05** · S1 · S — **Автоатака.**
  - ПКМ по враждебному юниту начинает автоатаку (`input/Controls.ts:687-696` → `ui/Npc.ts:150-191`).
  - Смена цели переносит атаку; повторный выбор той же цели её не останавливает (`selectTarget ~1702`).
  - То же для автовыстрела.
- [ ] **5.06** · S1 · S — **Плавание у поверхности.** Ступни ниже поверхности, как в wowee (−1,45 ярда), а не на её уровне (`game/Physics.ts:562-563`). Тест `physics.test.mjs:174` сейчас закрепляет ошибку. Ядро считает нулевую глубину «хождением по воде» (`Map.cpp:2538-2545`).
- [ ] **5.07** · S2 · M — **Пороги:** шаг ≈0,6 ярда вместо 1,6, склон ≈50° вместо 58°, стены ниже порога отталкивают (`Physics.ts:55, 329`; `Collision.ts:1044`; wowee `movement_limits.hpp:9-12`).
- [ ] **5.08** · S2 · S — **Скорости назад:** runBack, swimBack, flightBack (`game/Movement.ts:170-175`, `Physics.ts:381-397`).
- [ ] **5.09** · S2 · M — **Полёт.**
  - Наклон по обзору; скорость полёта только в воздухе (`Physics.ts:383`); пересчёт при смене ауры (`:382`).
  - `PITCHUP`/`PITCHDOWN`; отправка `MSG_MOVE_START_PITCH_UP/DOWN` и `STOP_PITCH`.
- [ ] **5.10** · S2 · S — **Плавание:** глубину задаёт наклон персонажа (ПКМ, клавиши), а не наклон камеры по умолчанию −23,7° (`Movement.ts:317`, `Physics.ts:558`).
- [ ] **5.11** · S2 · S — **Контроль:** под root нельзя прыгать; `UNIT_FLAG_STUNNED` блокирует повороты и прыжки (`Physics.ts:476-480`).
- [ ] **5.12** · S2 · M — **Потолки:** проверять геометрию сверху при движении вверх (`Collision.ts:1038`).
- [ ] **5.13** · S2 · S — **Шаг физики.**
  - Подшаги вместо обрезки кадра до 0,1 с (`game/Loop.ts:288`).
  - Потеря движения после копии позиции внутри подшага (`WorldState.ts:318-326`, `Movement.ts:342-346`).
  - Незагруженная земля (`Physics.ts:399-405, 472-475`).
- [ ] **5.14** · S2 · M — **Мышь и камера.**
  - Pointer Lock при обзоре; ПКМ разворачивает персонажа; A/D при зажатой ПКМ — стрейф (`Controls.ts:185-194, 257, 737-760`).
  - Автоследование камеры, следование за рельефом, «умный» поворот.
  - Стоковые панели «Камера» и «Мышь» → CVar (`FrameXmlSettingsCVar.ts:57-102`).
  - Дистанция по умолчанию и максимум как в оригинале (`SettingsModel.ts:258-267`).
- [ ] **5.15** · S2 · S — **Ввод:** W работает с зажатым Ctrl или Alt (`Controls.ts:72-78`); клавиша, нажатая при `movementReady=false`, применяется после снятия (`:256`).
- [ ] **5.16** · S2 · M — **Tab.**
  - Цели в поле зрения камеры, трупы и фракции — как в оригинале (`world/TargetSearch.ts`).
  - `forcedReactions` (`WorldClient ~904`) учитывать в цвете и атакуемости.
  - Повтор запросов таблиц фракций и талантов после сбоя (`FactionClient.ts:41-44`, `TalentClient.ts:55-59`).
- [ ] **5.17** · S2 · S — **Курсоры по контексту** — стоковые изображения: атака, речь, шестерня, сбор, торговля, ремонт, почта (`Controls.ts:385-510`).
- [ ] **5.18** · S2 · S — **Следование** (`FollowUnit`, сейчас заглушка — `FrameXmlInspect.ts:25`): клиентское автоследование, `AUTOFOLLOW_BEGIN/END`.
- [ ] **5.19** · S1 · M — **Репутация на сервере.** `CMSG_SET_WATCHED_FACTION`, `CMSG_SET_FACTION_INACTIVE`; сейчас выбор только локальный и теряется после перезахода (`LiveWorldSeam.ts:4912-4960`, `ui/Reputation.ts:103`).
- [ ] **5.20** · S1 · M — **Типы рассеивания.** Gateway отдаёт `Dispel` (SpellDispelType); `debuffType` и `isStealable` в `UnitAura`/`UnitDebuff` (`LiveWorldSeam.ts:6609-6645`); окраска рамок дебаффов.
- [ ] **5.21** · S2 · S — **Состояние только по ответу сервера.** Наборы экипировки (`WorldClient.ts:6098-6123`), `attacking` до `ATTACK_START` (`:1741`), `leaveBattlefieldQueue` (`:3656`), `leaveLfg` (`:4104`), `voteToRemove` (`:3208`).
- [ ] **5.22** · S2 · S — **Пустые обработчики с реакцией оригинала.**
  - `SET_PROFICIENCY` — красная подсветка неподходящей брони.
  - `INVALIDATE_PLAYER` — сброс кэша имени после переименования.
  - `STANDSTATE_UPDATE`.
  - `DURABILITY_DAMAGE_DEATH` — сообщение.
  - `SERVER_FIRST_ACHIEVEMENT`, `ITEM_TIME_UPDATE`.
- [ ] **5.23** · S2 · S — **Статус квестодателей** через `CMSG_QUESTGIVER_STATUS_QUERY` при появлении NPC вместо опроса каждые 5 с (`game/Loop.ts:226, 326-328`).
- [ ] **5.24** · S2 · S — **Питомцы:** запрос имён (`requestPetName` `:3360` без вызовов), `CMSG_STABLE_REVIVE_PET`. Кормление — в 2.05; `PET_CAST_SPELL` — в 11.02.
- [ ] **5.25** · S2 · S — **Прочие исходящие.**
  - Опция «Блокировать обмен»: `CMSG_BUSY_TRADE`/`IGNORE_TRADE`.
  - Фоновая вкладка: `CMSG_MOVE_TIME_SKIPPED`.
  - `QUESTLOG_SWAP_QUEST`, `GROUP_UNINVITE` по имени, `CANCEL_CHANNELLING`, `CANCEL_GROWTH_AURA`.
  - Методы без вызовов из UI: `queueForSpiritHealer` (`:4991`), `requestPartyMemberStats`, `requestCorpseMapPosition`, `requestTaxiNodeStatus`, `setTutorialSeen`.
- [ ] **5.26** · Долг · S — **Ошибка разбора update:** сейчас применяется частично, объект объявлен без позиции, остальные блоки потеряны (`WorldState.ts:217-244`). Откатить блок или пометить объект.
- [ ] **5.27** · S2 · S — **Поворот игровых объектов:** `UPDATEFLAG_ROTATION` и `GAMEOBJECT_PARENTROTATION` — сейчас наклонённые GO получают только yaw (`WorldState.ts:761`).
- [ ] **5.28** · S2 · M — **Разобранное, но непрочитанное состояние** — довести до потребителей:
  - `instanceDifficulty` → `GetInstanceInfo` (`LiveWorldSeam.ts:7771`);
  - `taxiNodeStatus` → карта;
  - `lootOwners` (`SMSG_LOOT_LIST`);
  - `itemTexts` → ItemTextFrame (копии писем);
  - `projectiles`;
  - `tutorialFlags`;
  - вход и выход игроков поля боя.
  Остальное — по пунктам 2.03, 3.03, 3.13, 3.14, 3.22, 5.16, 5.24.
- [ ] **5.29** · S2 · S — **Учёт намеренно игнорируемых опкодов.** Документы и `OpcodeBacklog.ts` утверждают, что «514 обработаны», хотя ≈56 опкодов без эффекта. Завести счётчик намеренно игнорируемых с причиной, как требует `CLIENT_PARITY_PLAN.ru.md` §5.

## Этап 6. Модели, анимации, эффекты ⚑

- [ ] **6.01** · S1 · M — **Шлем и наплечники NPC** из `NPCItemDisplay`: сейчас отброшены (`CharacterAppearance.ts:1023-1026`); шлем есть у 5440 из 15 477 строк Extra, наплечники у 6870.
- [ ] **6.02** · S1 · M — **Оружие NPC в руках** по `UNIT_VIRTUAL_ITEM_SLOT_ID` (`Frames.ts:135`; сейчас его читают только звуки, `CombatSounds.ts:75`); `weaponPose` по оружию.
- [ ] **6.03** · S1 · M — **`UNIT_NPC_EMOTESTATE`** → зацикленная анимация состояния (кузнец, шахтёр, танец, «мёртвый»); ядро ставит его через `SetEmoteState` (`Creature.cpp:2869`).
- [ ] **6.04** · S1 · M ⚑ — **Боевая стойка** Ready1H/2H/Unarmed/Bow между ударами (`readyAnimation` без вызовов, `AnimatedModel.ts:2946`); вместе с `UnitActionArbiter`.
- [ ] **6.05** · S1 · M — **Труп и область заклинания.** Труп игрока (тип 7) — тело или кости по `CORPSE_FIELD_*`, вместо 2D-маркера (`SimpleScene.ts:433-437`). DynamicObject (тип 6) — визуал области заклинания (`WorldRenderer3D ~10990, 11486`).
- [ ] **6.06** · S2 · M ⚑ — **Бой.** Удар левой (`HITINFO_OFFHAND` → `attackOff`); реакции жертвы (Parry, Dodge, ShieldBlock, Wound, Critical по VictimState); варианты удара по оружию (Attack2HL/Ready2HL, Attack1HPierce/AttackOffPierce) (`AnimatedModel.ts:2885-2905`).
- [ ] **6.07** · S2 · S ⚑ — **Состояния.** STUNNED и LOOTING (флаги не читаются); KneelStart/End, SleepUp, JumpLandRun; падение с высоты — Fall, а не Jump (`AnimatedModel.ts:2005-2007, 2833-2836`).
- [ ] **6.08** · S2 · M — **Убранное оружие.** Ориентация на спине и бёдрах, точки 26–33, два двуручника (Titan's Grip); анимации Sheath/HipSheath; клавиша `TOGGLESHEATH` — в 3.11 (`Attachment.ts:103-125`). Ружья — в 1.22.
- [ ] **6.09** · S2 · M — **Показ шлема и плаща.** `CMSG_SHOWING_HELM/CLOAK`, опции стока (сейчас NOT_SUPPORTED, `FrameXmlOptions.ts:174`), флаги скрытия у других игроков.
- [ ] **6.10** · S2 · S — **Уши и глаза.** При скрытых шлемом ушах оставлять заглушку 701 (`CharacterAppearance.ts:1275`); свечение глаз DK (геосет 1703, класс в запросе облика, `CreatureModelClient.ts:93-105`).
- [ ] **6.11** · S2 · M — **Поля облика NPC.** CreatureModelAlpha (1271 облик; призраки сейчас непрозрачные), CreatureGeosetData, ParticleColorID (`CreatureModelMetadata.ts:99-136`). Облик мага на копиях: `CMSG_GET_MIRRORIMAGE_DATA` → `SMSG_MIRRORIMAGE_DATA`.
- [ ] **6.12** · S2 · M ⚑ — **Снаряды.**
  - Полёт из точки-руки в грудь цели с самонаведением.
  - Читать SpellMissile, MissileMotion, MissileFollowGround, Impact/CastOffset.
  - Убрать выдуманную дугу `MISSILE_ARC` (`SpellVisuals.ts:99, 503`; `WorldRenderer3D.ts:6722-6734`; `SpellVisualLifecycle.ts:718`).
- [ ] **6.13** · S2 · M ⚑ — **Цепные лучи и тряска.** SpellChainEffects (Drain Life, Mind Flay, Chain Lightning), тряска камеры (SpellEffectCameraShakes), CharProc/CharParam кита (`SpellVisual.ts:287-289`; таблиц нет в `dbcLayouts`).
- [ ] **6.14** · S2 · M — **Свечение зачарований** из ItemVisuals/ItemVisualEffects и `ItemDisplayInfo.ItemVisual` вместо тинта по имени файла (`ItemEnchantments.ts:59-120`); эффекты оружия на клинке, а не на кисти (`SpellVisual.ts:202-205`).
- [ ] **6.15** · S2 · M — **Частицы и ленты.**
  - Частицы у навесных предметов и маунтов (`WorldRenderer3D.ts:8075-8088`).
  - Twinkle, tailCell, textureTileRotation, windTime, модельные частицы; треки по играемой последовательности; лимит 256 на эмиттер (`Particles.ts:139-148, 790`).
  - Ленты: textureRows/Cols/Slot, transform, цвет, затухание (`Particles.ts:1227-1237`).
- [ ] **6.16** · S2 · M — **M2.**
  - Цвет и альфа батча по играемой анимации, без синхронного мигания (`ModelBuild.ts:406-429`).
  - UV-анимация всех юнитов и осей (`:543`).
  - Вариации и idle-фиджеты (`tools/m2.mjs:696`).
  - Интерполяция каналов (`Wvm.ts:127`).
  - Alpha без записи глубины [вер.] (`ModelBuild.ts:1111, 1372-1376`).
  - ARMORREFLECT (env-map, `:1285-1289`).
- [ ] **6.17** · S2 · M — **Свет M2** вместо эвристики по имени (`LocalLighting.ts`).
- [ ] **6.18** · S2 · S — **Модели в окнах и лабораториях.** Живая модель в окне персонажа с idle-анимацией и поворотом (`ui/Portraits.ts:283-329`). Glue и лаборатория — через `worldCharacterGeosets` (`CharacterLab.ts:214`, `GlueCharacterScene.ts:297`, `GlueModelStage.ts:1508`), чтобы сапоги patch-W совпадали.
- [ ] **6.19** · Долг · S — **Sidecar анимаций** (HumanMale 9,8 МБ): первые эмоции и касты удалённых игроков теряются через 3 с (`ACTION_SIDECAR_WAIT`). Нужна предзагрузка или ожидание.
- [ ] **6.20** · S2 · S — **Маунты и пассажиры.** `CMSG_MOUNTSPECIAL_ANIM`; поза пассажира по VehicleSeat — в 11.02.
- [ ] **6.21** · S2 · M ⚑ — **Анимации способностей: сверка решений 29.09 с нативным клиентом.** Принято без парного кадра: бит 0x8 AnimationData = «можно на верхнюю часть тела»; id 0 в SpellVisualKit = нет позы; запас 400 мс на SPELL_GO; приоритеты state > cast > melee > reaction > emote; канал без ChannelKit держит позу CastKit (212 строк, из них 85 зацикливают выпуск). Снять A/B в `F:\Circle`. Мёртвая `shouldPromoteActionToLocomotionOverlay` и её тест удалены 29.09 по разрешению владельца (`tsc` 0 ошибок; `animation` 52/52, `unit-action-arbiter` 15/15); покрытие тех же случаев — в `unit-action-arbiter.test.mjs`.

## Этап 7. Рендер мира ⚑

- [~] **7.01** · S1 · M ⚑ — **Подземелья из одного WMO** (39 карт: ПС, Тюрьма, Гномреган, Мародон, Нексус…).
  - Довести работу параллельной сессии и проверить вживую после 0.1.
  - Затем имя зоны (`Minimap.ts:937`, `areaAt`), миникарта, небо: у 62 карт нет строк Light, сейчас небо Элвинна.
  - **29.09 сделано (офлайн):** коллизия — из `<map>.vmtree` (`parseVMapGlobalSpawn`, маршрут `/environment`), отрисовка — WMO из WDT (MPHD 0x1) со всей мебелью (`generate-visual-tile.mjs`, `adt-placements.mjs`); положение по правилу vmap-экстрактора (`x = z = 0` → центр карты); сверено с сервером для 43/230/409/576 (позиция, повороты, габариты). Тесты: `global-wmo-maps` 4/4. На живом gateway `/environment/43/31/30` → 200.
  - Осталось: имя зоны, миникарта, небо; живая проверка (14.24). Свет в подземелье принят владельцем (владелец 29.09 в игре: «свет все отлично»); вход в подземелья из одного WMO вживую не подтверждён.
- [ ] **7.02** · S1 · M — **Набор доодадов 0 вместе с набором размещения** (`tools/wmo-visual.mjs:541-549`, `generate-visual-tile.mjs:89-90`; wowee `terrain_manager.cpp:736-740`). Пересборка кеша тайлов. Проверка: таверна Темнолесья получает +80 объектов.
- [~] **7.03** · S1 · M ⚑ — **Доодады WMO и комнаты дальше 60 ярдов.** Порталы работают снаружи, дальность доодадов — как в оригинале. Сейчас все доодады WMO `interior: true` (`generate-visual-tile.mjs:204`; `WorldRenderer3D ~694-696, 871, 1318-1322`). Вместе с `WmoOcclusion.ts`.
  - **29.09 сделано для зданий только из комнат** (Гундрак): комнаты — обходом порталов без 60-ярдового поводка, мебель привязана к комнатам (MODR), небо не рисуется внутри; здания с наружными группами (Штормград) — без изменений, снимки совпадают до пикселя. Цена в Гундраке: 1,1–2,0 → 1,3–4,5 мс CPU на кадр (P-ядра; в живом Electron ×1,7–2,2), 149–251 → 154–588 вызовов отрисовки. Тесты: `wmo-render-path` 9/9, `wmo-occlusion` 9/9.
- [ ] **7.04** · S1 · L — **Небо.**
  - Солнце, луны, звёзды, облака.
  - LightIntBand 8–13, LightFloatBand 2–5, `CloudTypeID`, `HighlightSky`.
  - `LightSkybox.Flags`: скайбоксы не синхронно игровым суткам (`LightMetadata.ts:64-80, 235`; `LightClient.ts:19-30`; `buildSky ~13699`).
- [ ] **7.05** · S2 · M ☐ — **Лимиты допуска** (0.4c). Транспорт вне лимита GO 120 ярдов/96; частицы и анимации доодадов — по дальности; юниты — дальность вместо 64 (`WorldRenderer3D ~3006-3094`).
- [ ] **7.06** · S2 · M — **MCSH** (запечённые тени рельефа): генератор и шейдер. Флаг стоит на 256 из 256 чанков в Azeroth и Kalimdor.
- [ ] **7.07** · S2 · S — **Освещение рельефа:** Ламберт `max(N·L, 0)` плюс ambient по Light вместо `max(abs(N·L), 0.2)` (`WorldLighting.ts:100-101, 243`). Сверить парным кадром; связано с RND-4б каталога (решение 0.4i).
- [ ] **7.08** · S2 · M — **Дальний рельеф.** WDL с цветом и освещением зоны вместо плоского зелёного 0x4a6b4f; окно детального рельефа по farclip вместо фиксированных 3×3 (`TerrainStreaming.ts:54-59`).
- [ ] **7.09** · S2 · M — **Жидкости.**
  - Все строки LiquidType (MaterialID, Texture[1..5], параметры) вместо класса по подстроке пути (`generate-liquid-texture.mjs:49-63`, `LiquidMetadata.ts:20-27`).
  - UV течения лавы; глубина. Сейчас `.map` дают только первый слой MH2O без UV и глубины — рассмотреть чтение MH2O из ADT клиента.
- [ ] **7.10** · S2 · S — **Подводный вид в магме и слизи;** из LiquidType: MaxDarkenDepth, Fog/Amb/DirDarkenIntensity, LightID (`WorldRenderer3D ~303-358`).
- [ ] **7.11** · S2 · M — **Материалы WMO (MOMT):** shader (env/metal, двухслойный), F_UNLIT, F_UNFOGGED, F_SIDN (ночные окна), clamp; разбор MOSB (`wmo-visual.mjs:646-657`).
- [ ] **7.12** · S2 · S — **MFOG** для доодадов, юнитов, частиц и воды в помещении; подводная половина записи (`WorldRenderer3D ~10667`).
- [ ] **7.13** · S2 · M — **WMOAreaTable.** Имена помещений; indoor по флагам, как `IsOutdoorWMO` (`Terrain.ts:418-424`, `Collision.ts:995-998`); имя зоны в подземельях.
- [ ] **7.14** · S2 · M — **WMO-миникарты** (md5translate) в подземельях, Стальгорне и Подгороде (`tools/minimap-index.mjs:16-17`, `MinimapTiles.ts:15-17`).
- [ ] **7.15** · S2 · S — **Слот Light 4 («смерть»)** для призрака (`LightMetadata.ts:302`).
- [ ] **7.16** · S2 · M — **Земля.**
  - Слои в исходном разрешении (512² в Нордсколе) с фильтрацией.
  - Повтор текстур как в оригинале (сейчас 8 на чанк, в wowee 4; `generate-terrain-splat.mjs:22, 180-191`; `TerrainSplat.ts:13`).
  - Швы на границах чанков (`TerrainSplat.ts:268-283`) [вер.]; блики.
- [x] **7.17** · Гип. · S — **MOLT поверх MOCV** — возможен двойной свет (`WmoModel.ts:604-691`); сверить парным кадром.
  - **29.09:** двойной свет подтверждён и исправлен. 92 % WMO клиента идут «классическим» путём (MOHD без 0x2), у них ambient уже запечён в MOCV; формула теперь MOCV·(1+a/64) без повторного ambient и без MOLT (единый путь — как было). Тест `wmo-render-path` 9/9. **Принято владельцем:** владелец 29.09 в игре: «свет все отлично»; парный кадр с настоящим клиентом не снимали. Побочный эффект по средней яркости (Lookdev): Гундрак 46→24, Подгород 75→63, трактир Златоземья 57→50, **корабль Мёртвых копей 34→14**. Парного кадра с настоящим клиентом нет — снять.
- [ ] **7.18** · Долг · M — **Стенд-ины окружения** в `StandInLedger`, иначе критерий «0 стенд-инов» не измерить; отсутствующая модель → явный маркер (`StandIn.ts:37`, `Terrain.ts:1174-1177`).
- [ ] **7.19** · Долг · S — **Проверка тайла.** Сейчас «всё или ничего» (`EnvironmentTileDecode.ts:46`) и молчаливый предел 10 000 доодадов (`generate-visual-tile.mjs:91`). Удалить или задокументировать мёртвый маршрут `/terrain-texture`.
- [ ] **7.20** · S2 · M ☐ — **Калибровка контрольного профиля** по `Config.wtf` владельца: objectDistance 150, grassRadius 140, weatherDensity 3, farclip 1277, тени (`extShadowQuality=5`), простое пятно тени в режиме 0 (`ComparisonProfile.ts:8-44`).
- [ ] **7.21** · S2 · S — **Кинематографичный режим: живая проверка правок 28.09** (лучи, тени, дождь, брызги); ночь и луна — после 7.04.
- [ ] **7.22** · Долг · S — **Лимит 320/48 в документах и генераторе.** Относится к наружным WMO, а не к M2 (`generate-visual-tile.mjs:99-100`; документы — в 13.01).
- [ ] **7.23** · S2 · S — **Тайлы-заглушки под подземельем.** `/terrain-splat/604/{27..30}/{29..31}` → 500 «Invalid ADT map chunk header»: плоские ADT Гундрака без текстур. Отвечать 404 или пустым сплатом, чтобы клиент не повторял и не грузил лишнее (`generate-terrain-splat.mjs:234`).

## Этап 8. Поддержка

Звук и чат вне плана по решению владельца (29.09.2026). Сняты пункты 1.01, 1.11, 1.16, 3.04, 3.08, 3.17, 8.01–8.16, 8.18, 9.04; находки по звуку и чату остаются в аудите 28.09 как справка. Номера остальных пунктов не менялись.

- [ ] **8.17** · S2 · S — **Поддержка:** `CMSG_GMSURVEY_SUBMIT`, `BUG`, `COMPLAIN`, `GM_REPORT_LAG` (стоковый HelpFrame или native).

## Этап 9. TSWoW и аддоны

- [ ] **9.01** · S0 · M — **Режим «интерфейс WebClient + аддоны TSWoW»:** StaticPopup и UIErrorsFrame должны рисоваться. Сейчас фильтр `FrameXmlTsAddonPresentation.ts:45-64`, а ветка `addonsOnly` (`FrameXmlWorldMount.ts:3757-3830`) выходит раньше `installFrameXmlPopupsAdapters` (`:3933`). Из-за этого нельзя подтвердить покупку в магазине, сброс талантов retail-talents, не видно предупреждений survival.
- [ ] **9.02** · S1 · S ☐ — **Аддоны TSWoW по умолчанию** (0.4b; `SettingsModel.ts:273`, `EnterWorld.ts:213-215`).
- [ ] **9.03** · S1 · M — **Сообщения модулей при входе.** Буферизовать 0x102 до `#worldEntered` и доставлять после регистрации схем (`WorldClient.ts:4570-4582`, `EnterWorld.ts:1207-1228`); повтор для поздно заявленных опкодов.
- [ ] **9.05** · Долг · S — **Класс 13+.**
  - Перебирать все классы из ChrClasses, а не 1..11 (`FrameXmlMechanics.ts:243`, `TalentClient.ts:67`).
  - `LOCALIZED_CLASS_NAMES_*` с женскими формами.
  - Цвет HERO из датасета (`Constants.lua:56`) вместо `hsl` (`UnitSnapshot.ts:66-77`).
- [ ] **9.06** · Долг · S — **SavedVariables.** Ключ без origin gateway или с миграцией (`EnterWorld.ts:207-212`); сохранение по `PLAYER_LOGOUT`/beforeunload (`FrameXmlBoot.ts:1303-1322`); переменные с метатаблицей, как умолчания AceDB (`FrameXmlSavedVariables.ts:49-52`).
- [ ] **9.07** · S2 · S — **Проверить загрузку WCollections** (`!WCollectionsLoader`, `WCollections`, `WCollectionsDressUp`): `patches:check` видит 6 корневых каталогов, `client-addons:check` — 3 пути. Добавить сценарий `minimap-hub` в `tools/check-tswow-addons.mjs`, когда модуль соберут (0.5).
- [ ] **9.08** · Долг · S — **Окна content-studio:** защита от дубля JSON-окна и Lua студии на один опкод (`ui/ModuleLoader.ts`).

## Этап 10. Вход, gateway, раздача, безопасность

- [ ] **10.01** · Безоп. · M ☐ — **Все игроки для TrinityCore — 127.0.0.1.** Бан по IP банит всех, привязка учётки к IP не работает, перебор паролей не ограничен (`WrongPass.MaxCount = 0`). Ограничить попытки входа в gateway по IP игрока и описать ограничение; варианты с отдельным IP — решение владельца.
- [ ] **10.02** · Безоп. · M ☐ — **TLS или обратный прокси** для публичной раздачи (0.4f). Выводить предупреждение при публичном запуске: `Gateway.ts:326, 1685` ссылаются на несуществующее в `main.ts`. Согласовать с `dist/web/LOCAL_ONLY-NOT-FOR-REDISTRIBUTION.txt` (`vite.config.mjs:74-80`).
- [ ] **10.03** · Безоп. · S — **`?gateway=`** — список разрешённых адресов (`FrontDoor.ts:69-81`).
- [ ] **10.04** · Безоп. · S — **`ALLOWED_ORIGINS=*` вместе с `MODULE_UI_WRITE=1`** — запрет или явное предупреждение (`Gateway.ts:383-385, 1736`).
- [ ] **10.05** · S1 · S — **Статус подключения к миру и очередь** `AUTH_WAIT_QUEUE`: позиция и отмена (`GlueSession.ts:303-332`, `WorldClient.ts:1404-1409`).
- [ ] **10.06** · S2 · S — **Локализованные ошибки мира, транспорта и удаления** (`AUTH_*`, `CHAR_DELETE_FAILED_*`, `LOGIN_SERVER_DOWN`) вместо сырого текста (`WorldClient.ts:1408`, `GlueSession.ts:415`, `EnterWorld.ts:362`).
- [ ] **10.07** · S2 · M — **Glue CVar.** Сохранять `accountName`, `realmName`, `lastCharacterIndex` — **без пароля**; автоподключение к прошлому миру (`GlueApi.ts:256, 437-466`).
- [ ] **10.08** · S2 · S — **Список миров:** обновлять население и статус; категории из `Cfg_Categories.dbc` вместо чисел (`GlueApi.ts:615`, `GlueSession.ts:252, 284`).
- [ ] **10.09** · S2 · S — **Выбор персонажа.** Женские названия классов (`CharacterCreation.ts:140, 173`); список модификаций из `/client/addons` (`GlueApi.ts:219-221`); «Выход» закрывает окно Electron; склонения (`DeclineCharacter` — при `DeclinedNames = 1`).
- [ ] **10.10** · S0 (латентно) · S — **TOTP/2FA в GlueXML:** `GetUsesToken`/`TokenEntered`, передача token (`GlueApi.ts:216-217, 608-612`).
- [ ] **10.11** · Долг · M — **Сборка gateway.**
  - `npm run gateway` не должен собирать всю страницу и стирать `dist/web` (`package.json` pregateway).
  - `generate-protocol.mjs` пишет файлы только при изменении (`:273-285`).
  - `electron/gateway.cjs` проверяет свежесть `dist/code` (`:34-37, 60`).
  - `start-dev.bat` проверяет, что на 8090 действительно gateway.
- [ ] **10.12** · S2 · M — **HTTP-кеш.** Поколение в URL долгоживущих маршрутов (29 с `max-age=3600`, 8 с `86400`) или revalidation; баннер патча — перезагрузка в обход кеша (`PatchChainChanged.ts:297`).
- [ ] **10.13** · S2 · S — **Сервер страницы.** ETag и сжатие; не отдавать dev-страницы наружу; `ALLOWED_ORIGINS` для других имён хоста (`electron/static-server.cjs:78-86`).
- [ ] **10.14** · Риск · S — **`bufferedAmount > 4 МБ`** — пауза чтения TCP вместо разрыва сессии (`Gateway.ts:627-633`) [гип.].
- [ ] **10.15** · Долг · S — **Сторож gateway** (перезапуск при падении); ответ 409 после сборки TSWoW при подключённых игроках.
- [ ] **10.16** · S2 · S — **`GlueLoader`:** повтор при 5xx; экран «сервер недоступен» вместо запасной DOM-формы (`GlueLoader.ts:71-76`, `main.ts:254-264`).
- [ ] **10.17** · S2 · M — **Приложение игрока:** подпись exe, обновление оболочки, адрес и порт из конфигурации, а не зашитые (`electron/main.cjs:65, 111`).
- [ ] **10.18** · Риск · S — **Игроки по http без `crossOriginIsolated`** не получают воркер поз (`PoseEngine.ts:573-574`): −17…21 % FPS на стенде. Заголовки COOP/COEP или запасной путь.
- [ ] **10.19** · Долг · S — **Мелочи.**
  - Glue stub C-API экрана видео: `GetRefreshRates`, мультисэмплинг — честные ответы браузера.
  - `npm run doctor` проверяет доступность auth/world.
  - В `.env.example` описать `ASSET_WORKERS`, `CLIENT_FILE_DIR`, `WORLD_MAP_ZONE_MAP_DIR`, `WEB_CROSS_ORIGIN_ISOLATION`, `WEB_JS_PROFILING`, `WEBCLIENT_NODE_DIR`.
- [ ] **10.20** · S1 · M — **Остальные генераторы — на постоянные сборщики.** Текстуры и модели уже идут через `AssetWorker` (холодная текстура 48 мс против 330–410 мс, модель 55 против ~450). Остались процессом на промах: тайлы рельефа (0,7–1,3 с), визуальные тайлы (0,65 с), иконки предметов и заклинаний, карта мира, звуки; текстуры WMO кодируются заново для каждого WMO (580 из 853 мс у Гундрака) — вынести общий кеш.
- [ ] **10.21** · S2 · M — **Ответы gateway.** ETag из размера, mtime и штампа вместо SHA-1 всего файла (304 на 9,4 МБ анимаций — 8,8 мс); скан датасета не на пути запроса (75–110 мс до первого байта после 2 с простоя, `Gateway.ts` `observeDataset`, интервал `DatasetFingerprint.ts:415`); загрузчик моделей — не более 4 холодных запросов одновременно (сейчас до 10 высокого приоритета, `Terrain.ts:27,174-175`), чтобы горячие текстуры не ждали сокет; HTTP/2 над TLS снимает предел шести соединений (связано с 10.02).
- [ ] **10.22** · S2 · M — **Предзагрузка ресурсов.** После `/visual/environment/<карта>/<x>/<y>` ставить в фон сборку моделей этого и соседних тайлов; `tools/pregenerate.mjs --map N` после смены патчей. Вместе с 6.19 (sidecar анимаций 9,8 МБ у HumanMale).

## Этап 11. Транспорт и техника (крупные подсистемы)

- [ ] **11.01** · S0 · XL — **Транспорт.**
  1. Движение с ONTRANSPORT: guid, смещение, время. Сейчас `Movement.ts:127-167` флаг не ставит, а `WorldState.ts:308` стирает transport.
  2. Посадка и сход, `CMSG_MOVE_CHNG_TRANSPORT`.
  3. Динамическая коллизия GO: корабли, цеппелины, лифты, двери.
  4. Движение транспорта по TransportAnimation.
  5. Межконтинентальный переход с загрузкой.
  6. GO-пассажиры: transport guid в `UPDATEFLAG_POSITION` (`WorldState.ts:741-746`).
  7. Проверка наблюдателем.

  TC: `MovementHandler.cpp:306-351`, `Transport.cpp:628-641`.
- [ ] **11.02** · S0 · XL — **Техника и подчинение.**
  1. Активный движитель: `controlledGuid` в `sendMovement` и в ACK скоростей (`WorldClient ~1449, 1682-1690`); ядро отбрасывает чужие пакеты (`WorldSession.cpp:1784-1794`).
  2. `CMSG_SPELLCLICK` — посадка кликом.
  3. `UnitHasVehicleUI`, `UNIT_ENTERED/EXITED_VEHICLE`; VehicleMenuBar и VehicleSeatIndicator в TOC.
  4. `CMSG_CHANGE_SEATS_ON_CONTROLLED_VEHICLE`, `DISMISS_CONTROLLED_VEHICLE`.
  5. `PET_CAST_SPELL` и `UPDATE_MISSILE_TRAJECTORY`/`UPDATE_PROJECTILE_POSITION` — прицеливание осадных орудий.
  6. VehicleSeat.dbc — позы; id Vehicle.dbc (`WorldState.ts:757-760`).
  7. Камера техники; панель подчинения и Око зверя; `CMSG_FAR_SIGHT`.

  Native `#pet-bar` для техники и подчинения — переходное решение.

## Этап 12. Производительность

Подробности, оценки и критерии отказа — в [каталоге оптимизаций](OPTIMIZATION_CATALOG.ru.md): 142 пункта с префиксами RND, UNT, ENV, UI, NET, MEM и ARC, порядок в §3.4. Пункты этого этапа — вехи; внутренние шаги берутся по ID каталога. Сделанное и отклонённое ранее — в `PERF_STATUS.md`, заново не предлагать. Главное условие измерений: сначала MEM-1 (12.03), иначе стенд и игра выполняют код разной формы (каталог §2). **Детальные срезы волн P1 и P2** (12.01–12.07, 12.14, 12.16, 12.18) — [implementation/line-P.ru.md](implementation/line-P.ru.md): обзор, цель кадра (по записи 27.09 в 2 периода развёртки укладываются 9 % кадров; цель «95 %» к концу P2 недостижима), расписание, решения владельца; спецификации — [P1](implementation/line-P-P1.ru.md), [P2](implementation/line-P-P2.ru.md). Поправки к оценкам каталога — его §8.

- [ ] **12.01** — **Новый живой baseline.**
  - P0-сцены, 3 × 60 с, 1920×1080, видимое окно; живая запись v2 и DevTools Performance.
  - Свести цели кадра в одну. Сейчас в документах пять разных: 16,7 мс, 8,33 мс, p95/p99 при 1920×1080, «≥60 FPS при 200 персонажах», 13,9 мс при 144 Гц.
  - Последний живой замер (27.09 17:23) FPS-gate не проходит: p95 41,7 мс, p99 55,6 мс, максимум 125 мс.
- [ ] **12.02** — **Живое подтверждение шагов 20–21:** ProgramWarmup «юниты первыми», воркер поз против `?poseworker=0`, портреты, стриминг, отложенная раскладка FrameXML, кастеры теней lookdev (+0,1–0,3 мс на каскад на стенде).
- [ ] **12.03** · M — **Пакет быстрых правок каталога §3.1**, 13 пунктов, картинка не меняется.
  - Первым MEM-1: `build.target: "es2022"` в `vite.config.mjs`.
  - Затем UNT-5; UI-5, UI-6, UI-7, UI-11, UI-12; UI-4; NET-1 и UI-24; UNT-3; RND-5; RND-4a; MEM-2, ENV-2, ENV-7, ENV-21; ENV-11; NET-6, NET-7, NET-9; NET-22.
  - После пакета — живая запись v2.
- [ ] **12.04** · M — **Теневой проход** (RND-1, RND-6, RND-7): 3,7 → 1,8–2,2 мс живьём. Качество освещения 2 не снижать (правило владельца).
- [ ] **12.05** · M — **Управление окружением** (ENV-1 … ENV-5, ENV-10): рывки прибытия тайла, `render.env` и `render.evict`, пересборки каждые 4 ярда (ранжирование до 31 мс). Трава по секторам — ENV-6, по решению 0.4i (сейчас до 55 мс).
- [ ] **12.06** · M — **Один планировщик кадра** (ARC-5): независимые бюджеты сейчас складываются до 15–17 мс, FrameXML идёт мимо часов кадра. Сюда же удержание программ до 30 кадров, после которого линковка возвращается в кадр (`WorldRenderer3D.ts:710-725`; RND-18).
- [ ] **12.07** · M — **Вызовы тел юнитов** (UNT-1, UNT-12, UNT-8): −1,2–1,8 мс на кадр толпы.
- [ ] **12.08** · M — **Эффекты и частицы** (UNT-2, UNT-4, UNT-13): `render.visuals` в среднем 3,4 мс, в худшем 14,1.
- [ ] **12.09** · M — **Раскладка FrameXML без чтения DOM** (UI-2): часть ≈7 мс вне колбэка (DOM HUD ≈15,5 тыс. элементов).
- [ ] **12.10** · M — **Вызовы окружения.** Комнаты WMO одним multi-draw (RND-3), затем массивы текстур и пакетная статика (RND-16): 371 → ~165 → ~40 вызовов.
- [ ] **12.11** · M — **Конвейер ресурсов** (ENV-8, ENV-14, ENV-15, ENV-18, UNT-9, MEM-6).
  - Загрузки текстур вне submit (`texSubImage2D` 32 мс в окнах фризов).
  - Атлас персонажа не на главном потоке (`CharacterAtlas.ts:770-800`).
  - Первая сборка видимого тайла асинхронно.
  - JSON vmap в воркере (`game/CollisionSource.ts:607`, 12–14 мс на тайл), если этого нет в ENV-пунктах.
- [ ] **12.12** · M — **Пакеты и события** (NET-2, NET-4, UI-14, UI-8): всплески в бою и при появлении толпы.
- [ ] **12.13** · M — **Всадники, стрейф и анимированные доодады на воркере** (UNT-6, ENV-12): −1–1,4 мс при 20 всадниках.
- [ ] **12.14** · L — **Проверочные прототипы переписок** (каталог §3.3), каждый с заранее записанным критерием отказа:
  - ARC-1 — тонкий путь WebGL2, начиная с теней сырым GL;
  - ARC-2 — рендер в воркере с OffscreenCanvas;
  - ARC-4 — PUC Lua 5.1 в WASM вместо fengari (≈320 МБ кучи);
  - ARC-3 — плоские массивы и юниты на GPU;
  - ARC-6 — ресурсы, готовые для GPU;
  - ARC-7 — FrameXML в одном слое WebGL.
  WebGPU (ARC-8) отложен. Порядок веток A/B/C — каталог §3.4.
- [ ] **12.15** · S ☐ — **AutoQuality** (NET-5, решение 0.4d). Сейчас смотрит только на CPU p95 > 26 мс и опускает масштаб до 40 % при потолке рендера 50 % (`AutoQuality.ts:27`, `WorldRenderer3D.ts:7885`): мыло без ускорения.
- [ ] **12.16** · S ☐ — **GC:** найти триггер полных сборок, затем A/B флагов V8 (MEM-4: `--max-semi-space-size`, `--trace-gc`); остаток мусора ≈0,8 МБ на кадр.
- [ ] **12.17** · S — **Формальный контур:** утвердить replay-фикстуры (`BenchmarkManifest.ts:119-154`, все `pending`); A/B анизотропии атласа R1 (`WorldRenderer3D.ts:3465, 7803-7806`); обновить `bench/baseline*.json` от 20.09; телеметрия из каталога §6.
- [ ] **12.18** — **Разрыв GPU:** вживую 9–14 мс при 1045×900 против 4,8–5,3 мс на стенде при 1920×919. Выяснить, что попадает в таймер: ожидания CPU или захват Parsec.
- [ ] **12.19** — **Монтаж FrameXML:** перемерить (24.09 — 49,2 с холодный и 11,3 с тёплый; фикстура 28.09 — 20 с) и простой HUD после новых файлов TOC.

## Этап 13. Документация и репозиторий

- [ ] **13.01** — **Устаревшие утверждения:**
  - «мировой FrameXML только через `?framexml=1`» — `CLIENT_PARITY_PLAN.ru.md:25, 88`, `parity-execution.ru.md:23, 57`, `parity-blockers.ru.md:5`;
  - «лимит наружных M2 320» — `parity-blockers.ru.md:11-16`;
  - блокер Chrome `0xC0000022` и «оптимизации ждут профиля» — `parity-execution.ru.md:25-26, 35`, `parity-blockers.ru.md:15`;
  - `WOWEE_OPTIMIZATION_REVIEW.ru.md:51, 65, 76-79`;
  - `native-tracking-analysis.ru.md:29`;
  - противоречия `PERF_STATUS.md` (`:588-591`, `:117-133` и `:173-181`, `:1782-1805`);
  - `TSWOW_ADDON_LOADING_FIXES.ru.md` — проверка магазина.
- [ ] **13.02** — **Битые ссылки:**
  - 14 ссылок `.runtime/...` из `docs/`: `PERFORMANCE_120FPS.ru.md:229, 252`, `PERFORMANCE_ROOT_CAUSE.ru.md:24, 73-75, 165-166, 227-230`, `WOWEE_OPTIMIZATION_REVIEW.ru.md:185, 203`;
  - путь `parity/parity-external-resources.json` (`parity-external-resources.ru.md:4, 9`, `tools/parity-external-resources.mjs:5`);
  - номера строк в `DISTRIBUTION_PLAN.ru.md`.
- [ ] **13.03** — **Удалённые файлы** (решение в 0.2): `NOTICE.md`, `tools/dbd/README.md`, `src/browser/glue/README.md` (ссылка `GlueLua.ts:44`), `src/browser/framexml/README.md`, `FORMAL_BENCHMARK_GUIDE.ru.md` (у формальной консоли не осталось руководства).
- [ ] **13.04** — **`research/`:** удалить или пометить устаревшие дубликаты `parity-*.ru.md` (12,7 КБ против 87 КБ в `docs/parity/`).
- [ ] **13.05** — **Записать в docs три архитектурные идеи и порог пересмотра** (PUC Lua в WASM, OffscreenCanvas-воркер, multi-draw — сейчас только в памяти агента); `bench/README.md` — одна база (`baseline.json` или `baseline-pcores.json`).
- [ ] **13.06** — **Устаревшие комментарии в коде:**
  - `ui/Windows.ts:189-191`, `input/Actions.ts:108-115`, `PerformanceCapture.ts:52`, `ui/ActionBar.ts:409-413`, `ui/Totems.ts:10`, `ui/ArenaWindow.ts:5-7`, `ui/GuildBank.ts:134`;
  - `FrameXmlChatApi.ts:266-268` (`/dismount`), `LiveWorldSeam.ts:6054, 7357`, `FrameXmlWorldSeam.ts:1023, 1042`, `FrameXmlCorpus.ts:416-421, 591-593, 614-616`, `FrameXmlNeutralApi.ts:655-657`, `FrameXmlWorldMount.ts:328` (TimerTracker), `FrameXmlSettingsCVar.ts:60`;
  - `SpellProtocol.ts:154-171`, `CustomPacket.ts:73`, `WorldState.ts:611-614`, `ItemEnchantments.ts` («no MDX particle path»);
  - `GlueApi.ts` (`GetRandomName`, `DeclineCharacter`), `README.md:84`.
- [ ] **13.07** — **Обновлять этот план:** закрытые пункты `[x]` с датой; новые находки получают номер в своём этапе. Аудит 28.09 — неизменный снимок; актуален этот файл.

## Этап 14. Живая приёмка

Выполняет владелец или агент с разрешения владельца, на тестовом realm или согласованном снимке. После каждой сессии: `webclientUnhandledOpcodes()`, `webclientPacketErrors()`, `copy(frameXmlWorld().errors)`, `frameXmlWorld().api.filter(r => !r.neutral)` после открытия основных окон.

**P0** — [матрица](parity/parity-p0-matrix.ru.md):
- [ ] **14.01** P0-01 Вход → realm → персонажи → мир (плюс offline/locked realm, отрицательные ветки)
- [ ] **14.02** P0-02 Ходьба, поворот, прыжок, плавание (плюс 5.01–5.13)
- [ ] **14.03** P0-03 Смена зоны, телепорт, транспорт, такси (плюс 1.17, 11.01)
- [ ] **14.04** P0-04 Цель → бой → заклинание, ауры, кулдауны (плюс 1.04, 5.05, 3.01)
- [ ] **14.05** P0-05 Смерть → дух → воскрешение (плюс 6.05, 2.01 — призрак в подземелье)
- [ ] **14.06** P0-06 NPC → квест → сдача → награда (платная сдача, награда, портрет questnpc)
- [ ] **14.07** P0-07 Добыча → сумка → экипировка (контейнер, подарок, чужой push)
- [ ] **14.08** P0-08 Выход, отмена, разрыв, повторный вход (20-секундный таймер на учётке без Instant logout)

**P1** — [матрица](parity/parity-p1-matrix.ru.md):
- [ ] **14.09** P1-01 Торговец: золото, ItemExtendedCost (списание сервером), выкуп, ремонт (2.02)
- [ ] **14.10** P1-02 Тренер: список, фильтр, обучение (повторное открытие, класс и профессия)
- [ ] **14.11** P1-03 Таланты и книга (сброс 2.04, вторая специализация 1.07, подсказки 3.12)
- [ ] **14.12** P1-04 Банк и сумки
- [ ] **14.13** P1-05 Почта (COD, возврат, аукционное письмо, лимит золота)
- [ ] **14.14** P1-06 Аукцион (выигрыш — 1.21)
- [ ] **14.15** P1-07 Группа и обмен (два игрока, броски, ReadyCheck, меню портрета — 1.05, 1.10)
- [ ] **14.16** P1-08 Социальное: друзья, добавление и снятие игнора, /who (без чата — вне плана)
- [ ] **14.17** P1-09 Гильдия
- [ ] **14.18** P1-10 Питомец, транспорт, ездовые
- [ ] **14.19** P1-11 LFG и PvP (поле боя 3.14, арена 3.15)
- [ ] **14.20** P1-12 Ошибки и повторное открытие окон

**Проверки сделанного:**
- [ ] **14.21** Список handoff §5.2 (работа 28.09):
  - правый клик по 2652 с диалогом привязки; подсказка рецепта 6328;
  - книга без «QA Test…» и затемнений; лицо на кнопке «Персонаж»;
  - тотемы; числа урона; титулы, включая женские формы; менеджер экипировки;
  - угроза; ползунок god rays; боевое состояние портрета;
  - «Пригласить»; задержка; строка уровня;
  - панель и книга питомца у охотника или чернокнижника; стрелы в слот боеприпасов.
- [ ] **14.22** Area triggers: портал Мёртвых копей, таверна вне столицы, цель «исследовать», флаг WSG.
- [ ] **14.23** Ремонт, трактирщик, сброс талантов, стойка/форма и клавиша «1», яд или точило, распыление, снятие шкуры, отбрасывание, Скачок в бою с боссом, рыцарь смерти (руны, ошибка Lua при входе).
- [ ] **14.24** Мир и модели: подземелья из одного WMO после 0.1; стражники Штормграда (шлем, меч, стойка); кузнец с emote-состоянием; таверна Темнолесья против оригинала; Штормград с 70–150 ярдов; ночь в Элвинне; пловец у поверхности глазами второго игрока.
- [ ] **14.25** Парный эталон оригинала: кадры и видео от владельца, калибровка по 7.20; установить поведение пустого клика по AmmoSlot в оригинале.
- [ ] **14.26** FPS gate (12.01) и выпускной проход по `CLIENT_PARITY_PLAN.ru.md` §7.7: все P0/P1 зелёные, 0 открытых S0/S1, остаток S2 с воспроизведением.
