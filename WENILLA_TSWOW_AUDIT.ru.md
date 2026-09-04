# Wenilla и наши TSWoW-аддоны

Проверены исходники на 2026-09-04, commit
[`c3a948ecaac7b49c5f1c272f3b2601e2f58ceced`](https://github.com/Arnesen/wenilla/tree/c3a948ecaac7b49c5f1c272f3b2601e2f58ceced).
Это сопоставление кода: Wenilla и его Cargo-тесты здесь не запускались, код проекта в
WebClient не копировался. Результаты наших исправлений — в
[контракте совместимости](TSWOW_ADDON_COMPATIBILITY.ru.md).

## Практический вывод

Полезны конкретные контракты UI, диагностика и регрессии. `benilla-ui` отделяет
FrameXML/Lua от игрового движка; браузерный launcher запускает Rust/Bevy через WebAssembly.
Наш WebClient использует TypeScript, DOM и Fengari: подключение Rust crate само по себе
не добавит поддержку TSWoW.

Источники: [UI crate](https://github.com/Arnesen/wenilla/blob/c3a948ecaac7b49c5f1c272f3b2601e2f58ceced/crates/benilla-ui/Cargo.toml),
[launcher](https://github.com/Arnesen/wenilla/blob/c3a948ecaac7b49c5f1c272f3b2601e2f58ceced/crates/wenilla/src/lib.rs).

## Что можно использовать

| Механизм | Применение у нас |
| --- | --- |
| [Интерактивный harness](https://github.com/Arnesen/wenilla/blob/c3a948ecaac7b49c5f1c272f3b2601e2f58ceced/crates/benilla-app/src/addon_harness/use_probe.rs#L159): реальные painted frames аддона, hit test, hover/click/drag, отдельный результат `untouched` | Повторяемая браузерная приёмка наших модулей. Проверять получателя ввода и результат действия; ноль затронутых виджетов не считать успешной интерактивной проверкой. |
| [Покрытие API](https://github.com/Arnesen/wenilla/blob/c3a948ecaac7b49c5f1c272f3b2601e2f58ceced/crates/benilla-app/src/addon_harness/mod.rs): globals, tables, методы и методы конкретного типа считаются раздельно | В `GlueWidgets` уже есть `stubbedMethods`. Полезно добавить принадлежность вызова модулю и типу виджета. Покрытие задаёт приоритет исправления, готовность подтверждает сценарий. |
| [Геометрия](https://github.com/Arnesen/wenilla/blob/c3a948ecaac7b49c5f1c272f3b2601e2f58ceced/crates/benilla-ui/src/script/layout.rs#L704): зависимости anchors и сравнение кэшированного результата с полным пересчётом | Регрессии в `FrameXmlDomRenderer` для scale, изменения target, reparent и Hide/Show. Оптимизацию переносить после измерений и сверки результата. |
| [Мышь](https://github.com/Arnesen/wenilla/blob/c3a948ecaac7b49c5f1c272f3b2601e2f58ceced/crates/benilla-ui/src/script/pointer.rs#L493): источник нажатия отдельно от hover, захват по кнопкам, clipping/insets | Основной drag/model capture у нас уже реализован. Дополнительные полезные случаи: перекрывающиеся виджеты, обрезанные области и одновременные кнопки мыши. |
| [Tooltip](https://github.com/Arnesen/wenilla/blob/c3a948ecaac7b49c5f1c272f3b2601e2f58ceced/crates/benilla-ui/src/script/tooltip/mod.rs#L88): пул FontString-строк, измерение текста, две колонки и перенос | Развивать наши динамические строки GameTooltip: учитывать измеренный шрифт/переносы, проверять повторный hover и смену содержимого. |
| [SavedVariables](https://github.com/Arnesen/wenilla/blob/c3a948ecaac7b49c5f1c272f3b2601e2f58ceced/crates/benilla-app/src/ui_saved.rs#L50) и [localStorage](https://github.com/Arnesen/wenilla/blob/c3a948ecaac7b49c5f1c272f3b2601e2f58ceced/crates/benilla-app/src/local_state.rs#L402): defaults → сохранённые значения → событие загрузки | Путь для будущих настроек аддонов. В нашем FrameXML runtime пока нет SavedVariables/RegisterForSave. Нужны декларации, сериализация, порядок загрузки и ключи account/realm/character/module. |

Таблицы методов [object.rs](https://github.com/Arnesen/wenilla/blob/c3a948ecaac7b49c5f1c272f3b2601e2f58ceced/crates/benilla-ui/src/script/object.rs#L276)
сохраняют различие типов виджетов и возвращают nil для отсутствующего метода. Это полезный
ориентир для аудита наших заглушек: наличие функции не доказывает реализацию её поведения.

## Ограничения

- Wenilla ориентирован на WoW 1.12.1. Его Lua 5.1 VM намеренно адаптируется к Lua 5.0,
  включая удаление библиотечных функций. Этот слой нельзя переносить в TSWoW/3.3.5:
  [lua50.rs](https://github.com/Arnesen/wenilla/blob/c3a948ecaac7b49c5f1c272f3b2601e2f58ceced/crates/benilla-ui/src/script/lua50.rs).
- Произвольная model pane аддона не получает готовый renderer. Панели сопоставляются с
  известными именами штатных окон; тест ожидает, что `SomeAddonsModelPane` не рисуется:
  [renderer/test](https://github.com/Arnesen/wenilla/blob/c3a948ecaac7b49c5f1c272f3b2601e2f58ceced/crates/benilla-app/src/ui_script/extract/mod.rs#L2273).
  Наш `DressUpModel:SetCreature` продолжает требовать `FrameXmlModelPreview` и данных нашего мира.
  Для дальнейшей примерки экипировки полезен отдельный
  [ui_dressup.rs](https://github.com/Arnesen/wenilla/blob/c3a948ecaac7b49c5f1c272f3b2601e2f58ceced/crates/benilla-app/src/ui_dressup.rs),
  но он использует их игровое состояние и форматы Vanilla.
- Их harness создаёт свежую VM на аддон и ограничивает интерактивный обход восемью целями.
  Наши generated TSWoW-блоки необходимо также проверять вместе с общими библиотеками;
  восемь целей не являются проверкой всего окна.
- Их localStorage имеет область origin/виртуального пути. Для нашего клиента области
  аккаунта, сервера и персонажа должны быть явными.
- Лицензия исходников — MIT OR Apache-2.0. При переносе кода сохраняются соответствующие
  уведомления об авторстве: [LICENSE-MIT](https://github.com/Arnesen/wenilla/blob/c3a948ecaac7b49c5f1c272f3b2601e2f58ceced/LICENSE-MIT).

Ближайшее применение — повторяемые браузерные сценарии наших аддонов и отчёт о вызванных
заглушках по модулю/типу виджета. SavedVariables и более точные tooltip/layout требуют
отдельных сценариев. Замена VM или renderer оправдана только после проверки нашего
generated Lua и измерения конкретной проблемы.
