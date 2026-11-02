# Удаление HTML-интерфейса: список перед удалением

02.11.2026. Пункт плана 4.17. Ничего из этого ещё не удалено. Решения владельца: в игре остаётся только оригинальный интерфейс WoW, окна модулей удаляются вместе с HTML-интерфейсом.

Как получен список: граф импортов `src/` и разбор символов, которые оригинальный интерфейс берёт из `src/browser/ui/`. Это статический разбор, в игре он не проверялся. Границы групп уточняются при разрезе.

## Главное

Сейчас оригинальный интерфейс работает по схеме «сначала свой фрейм, иначе HTML»: `if (!toggleFrameXmlBags()) toggleAllBags()`. HTML-окно появляется, когда оригинальный фрейм не прошёл проверку или не загрузился. Так было с окнами, которые вы видели 01.11 рядом с оригинальными (коммит b1f65b1).

После удаления этого запасного варианта не будет: сбой оригинального фрейма значит, что окно не откроется. Поэтому первый этап — измерить, как часто запасной вариант срабатывает в обычной игре, и закрыть найденные случаи.

## Сколько кода

`src/browser/ui/` без `framexml_compat`: 166 файлов, 50 858 строк.

| Группа | Файлов | Строк | Что делаем |
| --- | --- | --- | --- |
| Логика без DOM, нужна оригинальному интерфейсу | 42 | 8 830 | остаётся |
| Оверлеи движка | 12 | 1 718 | остаётся |
| Инструменты | 11 | 2 133 | остаётся |
| Смешанные файлы | 19 | 10 428 | вынести нужное, остальное удалить |
| Логика, которую зовёт только связка | 5 | 589 | решить при разрезе |
| Окна и HUD | 65 | 16 219 | удалить |
| Окна модулей | 12 | 10 941 | удалить |

`ui/framexml_compat/` (23 файла, около 15 тыс. строк) — это рендерер самого оригинального интерфейса, он остаётся. Папка `framexml/` тоже не меняется, кроме мест, где она вызывает HTML-окна.

## Удалить: окна и HUD (65 файлов)

- **Персонаж и HUD:** CharacterSheet, CharacterSheetModel, UnitFrame, UnitFrames, Auras, CastBar, MirrorTimers, PetBar, Totems, VehicleBarGates, ActionBarAccountSync, EquipmentSets, EquipmentSetModel, DragGhost, Slots, ItemSlots, ItemTargetClick, Widgets, Tooltip, Actions.
- **НПЦ и торговля:** Npc, NpcWait, VendorRepair, VendorRefund, VendorRefundRows, VendorQuantity, Bags, Bank, GuildBank, GuildBankModel, BarberShop, Petition, StableControls, NativeGiftWrap.
- **Общение и группы:** Social, SocialPanel, ContactsModel, ChannelRoster, GroupMenu, GroupModel, LootRolls, LootRollModel, ReadyCheck, InteractionPrompts, LfgWait, LfgQueueClock, GmTickets.
- **Прочие окна:** WorldMap, WorldMapQuestPlacement, Calendar, CalendarModel, CalendarEditor, Talents, TalentTree, GlyphSockets, PetSpellbook, Reputation, Scoreboard, ScoreboardModel, ArenaWindow, ArenaModel, CombatLog, WorldView.
- **Оформление:** NativeUiSkin, SettingsNavigation.

## Разделить: смешанные файлы (19)

Оригинальный интерфейс берёт из них логику, а остальное в них — HTML.

| Файл | Что нужно сохранить |
| --- | --- |
| Spellbook | `castSpell`, загрузка данных заклинаний |
| ActionBar | `useSlot`, `getActionBarPage` |
| Professions | `craftProfessionRecipe`, `castProfessionRecipeOnItem`, `castProfessionRecipeOnTradeSlot`, `professionCraftRemaining`, `stopProfessionCraftRepeat` |
| Minimap | `currentAreaId`, `minimapWidgetAdapter`, холст, который заимствует MinimapCluster |
| Portraits | холсты портретов, которые заимствуют оригинальные рамки, `setQuestGiverPortrait` |
| Frames | `visibleEquipmentFor`, модели юнитов |
| Settings | хранилище и применение настроек: `settingOn`, `setSetting`, `watchSettingsApplied` |
| ChatDock | `combatHistory`, `onCombatEntry` |
| GameMenu | `cancelLogoutRequest`, `logoutPending`, `requestQuitToLogin`, `registerGameMenuAddonButton` |
| Windows | `registerEscapable` |
| Mail | `mailDraftAttachments` |
| Socketing | `newSocketInfoFromLua` |
| Macros | `frameXmlMacroStore` |
| Tracking | `isTracking`, `trackingSpellsOf`, `trackingFieldsSignature` |
| QuestLog | данные журнала, которые читает оригинальный интерфейс |
| Dom | останутся только элементы, которые ещё нужны |
| Guild, KeyBindings, NativeHudReplacement | вероятно, не нужны: проверки «открыто ли HTML-окно» уходят вместе с окнами |

## Остаётся

- **Оверлеи движка:** HeadOverlay (пузыри, числа урона), OverlayModel, NamePlates, LoadingScreen с Art и Worker, DeathScreenEffect, Notices, NoticeModel, Strings, Format, DebuffType.
- **Инструменты:** GmConsole, GmCommands, Diagnostics, DebugTab, PacketsModel, PacketsTab, PacketDiagnosticsReport, PerformanceCapture, PoseWorkerStatus, FpsCounter, FpsCounterText.
- **Логика:** ItemTooltip, Chat, ChatFormat, ChatLink, ChatInputOwner, CombatLogModel, SettingsModel, SettingsSections, EnhancedGraphics, EnhancedPresetRevision, ComparisonProfile, UnitSnapshot, Skills, SpellText и его модули, SpellNames, SpellRanks, SpellbookTabs, MacroModel, GuildModel, ProfessionRules, CharacterCreation, CombatCommands, NativeTargetCommands, PossessActionBar, ActionBarStockLayout, ActionDrag, IconImage, NpcText, QuestObjectiveMarkers, QuestTimer, WorldMapHierarchy, MinimapGossipPoi, NativeItemLocks, ItemDurationText, ItemTooltipExtensions, LogoutCountdown.
- **Решить при разрезе:** UnitTooltip, ActionBarAccountWiring, HudKeys, WelcomeHints, UnitFrameRefresh.
- **Настройки графики:** категория «WebClient» в оригинальных настройках строится из той же модели (`FrameXmlOptions.ts` обходит `SETTING_GROUPS`), поэтому наши улучшения графики останутся доступны. В игре это ещё нужно проверить.

## Окна модулей: удалить

Решение владельца 02.11. WindowSchema, WindowBuilderModel, WindowRender, ModuleLoader, WindowBuilder, WindowExpression, WindowBindings, WindowActions, WindowRegistry, WindowsTab, ModuleClient, WindowPatch — окна из `content/ui/*.json`, формат tswow-content-studio.

- В `tswow-install/modules`, `TsWowModules`, `tswow-ai-made-modules` и `tswow-content-studio` таких файлов нет. Есть только два тестовых экрана в модуле `test` на CleanTswow.
- Интерфейс модулей на Lua (аддоны) работает через оригинальный интерфейс и от этих файлов не зависит.
- `WindowSchema` импортируют 33 файла `ui/`, а 6 импортов идут из файлов, которые остаются. Убрать их можно только вместе с разрезом остальных окон.
- После удаления окна из content-studio перестанут показываться в клиенте. Код останется в истории Git.
- Вместе с ними уходит вкладка «Окна» в окне диагностики и редактор окон.

## Что исчезнет для игрока и разработчика

- Настройка «Оригинальный интерфейс WoW», `?framexml=0`, режим «интерфейс WebClient + аддоны» (пункт плана 9.01).
- `?legacy-login` и старые формы входа в `index.html` (`login-panel`, `character-panel`).
- Запасные HTML-окна. Сбой всего интерфейса, который сейчас заканчивается словами «используется WebClient», должен показывать понятный экран с причиной.

## Что ещё может зависеть от HTML

Комментарии в коде говорят, что эти случаи остаются за HTML. Этап 1 должен подтвердить каждый. Комментарии бывают устаревшими: у рамок боссов и банка оригинальные владельцы уже есть, хотя `FrameXmlWorldMount.ts:680` и `:695` говорят обратное.

| Случай | Где сказано |
| --- | --- |
| «Войти в бой», пока BattlefieldFrame не слушает | `FrameXmlPopupsController.ts:22` |
| Строки стойл поверх окна персонажа | `FrameXmlWorldMount.ts:773` |
| Ряд транспорта без таблиц транспорта | `FrameXmlWorldMount.ts:718` |
| Вопрос сервера, когда имя ещё неизвестно | `FrameXmlServerPrompts.ts:26`, `FrameXmlPopups.ts:813` |
| Действия у рамки цели | `FrameXmlWorldMount.ts:310` |
| Награда поиска подземелий без AlertFrames.xml | `FrameXmlLfd.ts:1031` |
| Приглашения, дуэли, воскрешение | `FrameXmlPopupsNative.ts` |
| Тикеты ГМ | `FrameXmlWorldMount.ts`, вызов `toggleGmTickets` |

## Порядок работ

Каждый этап — отдельный локальный коммит с проверкой типов и тестами. Перед проверками в игре ничего не удаляется безвозвратно: код остаётся в истории Git.

1. **Измерить.** Временно записывать в консоль каждое срабатывание HTML-окна при оригинальном интерфейсе. Пройти обычную игру, закрыть найденные случаи.
2. **Убрать старый вход.** Сделано 02.11: убраны `?legacy-login`, формы в `index.html`, 480 из 630 строк `app/Login.ts`. Если экран входа не загрузился, вместо старых форм теперь сообщение и кнопка «Повторить».
3. **Убрать переключатель.** Сделано 02.11: убраны настройка, `?framexml=0` и режим только с аддонами. Если интерфейс не загрузился, мир закрыт экраном с причиной и кнопкой «Повторить».
4. **Снять запасные пути.** Сделано 02.11: клавиши, команды чата, микрокнопки, меню игры и `EnterWorld.ts` обращаются только к оригинальным окнам; `/barber` и действие `toggleKeyBindings` убраны; HTML-меню игры удалено. HTML-окна ещё рисуются, но не видны: их скрывает одно правило в `style.css`, а вернуть их можно, убрав его. Если проверка оригинального окна не прошла, появляется сообщение с причиной, окно не открывается. Вопрос о сохранении подземелья без таблицы боссов теперь задаёт оригинальный диалог, а не HTML. Остались только запасные пути ввода в чат (`chatInput.focus()`): их снимет этап 6 вместе с HTML-чатом.
5. **Разделить смешанные файлы** и перевести `FrameXmlWorldMount.ts` на выделенную логику (он берёт из `ui/` 110 символов).
6. **Удалить окна и HUD** партиями и снять их вызовы из связки: `app/EnterWorld.ts` 149 символов, `app/Login.ts` 70, `input/Actions.ts` 46, `game/Loop.ts` 45, `input/Controls.ts` 24, `main.ts` 17. Самая частая зависимость — `Widgets`: её импортируют 20 файлов.
7. **Подчистить.** `style.css` (3 992 строки), `index.html`, `Dom.ts`, тесты.

## Этап 1: результат офлайн (02.11)

Стенд: оригинальный интерфейс поверх поддельного `WorldClient`, окна открываются через настоящую таблицу клавиш (`input/Actions.ts`), временный счётчик `ui/HtmlFallbackWatch.ts` смотрит на страницу.

- **Окна по клавишам:** 14 из 14 открылись оригинальным фреймом, HTML не появился, ошибок Lua 0. Проверены персонаж, сумки, кольцо ключей, рюкзак, книга заклинаний, PvP, поиск подземелий, таланты, навыки, журнал заданий, карта мира, репутация, друзья, назначение клавиш.
- **В покое** виден только пустой `#raid-frames`, 8 пикселей высотой. Это HTML-рейд-сетка, в оригинальном клиенте её нет.
- **Найдена и исправлена ошибка.** Оригинальный код выключает кнопки сумок, пока открыто меню игры (`Disable_BagButtons`). Клавиша сумки в это время давала отказ `Click`, наш код принимал его за поломку и до конца сессии молча отдавал сумки HTML. Теперь такое нажатие ничего не делает, как в оригинальном клиенте.
- **Карта мира** без данных зон открывает HTML: проверка оригинальной карты ждёт `/dbc/areas` и позицию игрока. После удаления до загрузки зон карта просто не откроется.
- **Осталось мелкое:** действие `toggleKeyBindings` (по умолчанию без клавиши) закрывает окно клавиш в обход меню, и кнопки сумок остаются выключенными до следующего открытия меню. В оригинальном клиенте такого действия нет, оно уходит на этапе 4.
- **Не покрыто стендом:** окна НПЦ, вопросы сервера, группа, поле боя, транспорт. Им нужен настоящий сервер, это проверит живой замер (LIVE_CHECKS, раздел 1в).

## Замер в игре (02.11)

Два входа в игру, в последнем не меньше 12 минут. Счётчик записывает только то, что появилось на экране, поэтому какие окна открывались за это время, он не знает.

- **HTML-окна:** не появилось ни одного. Запасной путь ни разу не сработал, список отказавших проверок пуст (он хранится только для текущего входа).
- **`#head-overlay`** (пузыри, числа урона) и **`#notices`** (отказы и подсказки, 4 раза, 25 секунд): оба в списке «Остаётся», запасными окнами не считаются. Что именно показывал `#notices`, журнал не хранит; вызовов `notice()` в коде 82, часть из них при оригинальном интерфейсе могла бы идти в `UIErrorsFrame`. Посмотреть при разрезе, на этапе 5.
- **Оригинальный интерфейс поднимается в среднем за 19 секунд на вход** (37 секунд на два входа). Заставка загрузки его не ждёт: она снимается по готовности ландшафта и коллизии. Пока HTML-панели существуют, разрыв закрыт ими; на этапе 6 проверить, не остаётся ли игрок в мире совсем без интерфейса, и если да, держать заставку до его появления.
- **Не подтверждено:** окна НПЦ, вопросы сервера, группа, поле боя и транспорт на настоящем сервере, если они не встретились за эту игру. Отказ в них после этапа 4 будет означать, что окно не открылось.

## Тесты

Оценка по именам файлов в тестах: 18 тестовых файлов уйдут вместе с окнами, 116 придётся править. Всего тестовых файлов 1 309, из них 1 018 не называют файлы `ui/`. Тесты, которые привязаны к исходному коду косвенно, скрипт мог не увидеть.
