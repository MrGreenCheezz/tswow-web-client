# Этап 13. Документация и репозиторий

> Часть [плана реализации](../IMPLEMENTATION_PLAN.ru.md). Пункты этапа — в [плане работ](../WORK_PLAN.ru.md).

Общее для этапа.
- Правки документов не требуют тестов: проверка — чтение текста и ссылок.
- Для ссылок заводится одна проверка (13.02).
- Правило для остальных этапов: срез, который меняет поведение, описанное в документе, правит документ в том же срезе. Этап 13 — только разовая уборка накопленного.

### 13.01 — Устаревшие утверждения
**Подход:** по каждому месту заменить утверждение на актуальное со ссылкой на код или замер. Места:
- `CLIENT_PARITY_PLAN.ru.md:25, 88` — штатный HUD включается настройкой `originalFrameXml` (`FrameXmlWorldPolicy.ts:7`), `?framexml=` лишь переопределяет её;
- `parity-execution.ru.md:23-26, 35, 57` — блокер `0xC0000022` снят прогонами 28.09; оптимизации шли шагами 14–21;
- `parity-blockers.ru.md:5, 11-16, 15` — лимит 320/48 относится к наружным WMO, M2 в квоте 1024;
- `WOWEE_OPTIMIZATION_REVIEW.ru.md:51, 65, 76-79` — PoseEngine+SAB, WVA-воркер, EnvironmentTile-воркер, LOD поз;
- `native-tracking-analysis.ru.md:29` — привязки есть (`FrameXmlWorldSeam.ts:2298-2308`, `LiveWorldSeam.ts:7648-7662`);
- `PERF_STATUS.md:117-133/173-181, 588-591, 1782-1805`;
- `TSWOW_ADDON_LOADING_FIXES.ru.md` — проверка магазина.

**Файлы:** перечисленные документы. **Размер:** S.

### 13.02 — Битые ссылки и проверка ссылок
**Подход:** исправить 14 ссылок `.runtime/...` в `PERFORMANCE_120FPS.ru.md`, `PERFORMANCE_ROOT_CAUSE.ru.md`, `WOWEE_OPTIMIZATION_REVIEW.ru.md` — путь `../.runtime/...` или пометка «локальный артефакт, не в git». Исправить путь `parity/parity-external-resources.json` в `parity-external-resources.ru.md:4, 9` и `tools/parity-external-resources.mjs:5`. Сдвинутые номера строк в `DISTRIBUTION_PLAN.ru.md` заменить на имена функций.

Новый `tools/check-doc-links.mjs` проверяет относительные ссылки `docs/**/*.md` и `README.md`: файл существует; `.runtime/` помечается как локальный.

**Тест:** `tests/check-doc-links.test.mjs` — фикстура с битой и рабочей ссылкой (мутация: считать все ссылки рабочими → тест падает). **Файлы:** `tools/check-doc-links.mjs`, документы. **Размер:** S.

### 13.03 — Удалённые файлы
**Подход:** по решению 0.2 вернуть `NOTICE.md`, `tools/dbd/README.md` (атрибуция CC BY-SA), `src/browser/glue/README.md`, `src/browser/framexml/README.md` из `HEAD` либо убрать ссылки на них. Если формальная консоль остаётся, `FORMAL_BENCHMARK_GUIDE.ru.md` вернуть в `docs/`.

**Файлы:** см. 0.2. **Размер:** S.

### 13.04 — Дубликаты в `research/`
**Подход:** у устаревших копий `research/parity-*.ru.md` поставить первой строкой «Устарело, актуально: docs/parity/…» либо удалить по решению владельца. Удаление — только с его согласия.

**Размер:** S.

### 13.05 — Архитектурные идеи и одна база стенда
**Подход:** в `docs/OPTIMIZATION_CATALOG.ru.md` (§3.3) уже есть ARC-1…ARC-8. Порог пересмотра из памяти агента («если после ARC-x живой кадр города > 13,9 мс — вернуться к вопросу о переходе на нативный клиент») дописать в каталог §3.5. В `bench/README.md` оставить одну базу (`baseline-pcores.json` или `baseline.json`) и указать, как её обновлять.

**Размер:** S.

### 13.06 — Устаревшие комментарии в коде
**Подход:** править комментарий в том же срезе, что и код рядом с ним. Оставшиеся места — одним срезом в конце вехи В2:
- `ui/Windows.ts:189-191`, `input/Actions.ts:108-115`, `PerformanceCapture.ts:52`, `ui/ActionBar.ts:409-413`, `ui/Totems.ts:10`, `ui/ArenaWindow.ts:5-7`, `ui/GuildBank.ts:134`;
- `FrameXmlChatApi.ts:266-268`, `LiveWorldSeam.ts:6054, 7357`, `FrameXmlWorldSeam.ts:1023, 1042`, `FrameXmlCorpus.ts:416-421, 591-593, 614-616`, `FrameXmlNeutralApi.ts:655-657`, `FrameXmlWorldMount.ts:328`, `FrameXmlSettingsCVar.ts:60`;
- `SpellProtocol.ts:154-171`, `CustomPacket.ts:73`, `WorldState.ts:611-614`, `ItemEnchantments.ts`;
- `GlueApi.ts` (`GetRandomName`, `DeclineCharacter`), `README.md:84`.

**Проверка:** `tsc --noEmit` (комментарии не ломают сборку), чтение. **Размер:** S.

### 13.07 — Вести план
**Подход:**
- Закрытый пункт получает `[x]`, дату, тест и строку в `docs/parity/parity-execution.ru.md`.
- Новая находка получает номер в своём этапе и спецификацию в том же формате.
- Спецификация, разошедшаяся с кодом при реализации, правится в плане в том же срезе.
- Аудит 28.09 не меняется: это снимок.

**Размер:** постоянно.
