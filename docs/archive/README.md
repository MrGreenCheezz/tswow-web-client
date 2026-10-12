# Архив документов

История работы до 12.10.2026. Для текущей работы эти файлы не нужны: актуальны [план](../WORK_PLAN.ru.md) и [проверки в игре](../LIVE_CHECKS.ru.md). Здесь лежат подробности, на которые ссылаются старые записи.

## План и решения

- [WORK_PLAN-history-2026-10-12](WORK_PLAN-history-2026-10-12.ru.md) — полный план до пересмотра 12.10: по каждому пункту что сделано, файлы, тесты, адреса Wow.exe, ваши отметки.
- [IMPLEMENTATION_PLAN](IMPLEMENTATION_PLAN.ru.md) — план реализации 29.09: вехи, порядок, окна перезапуска gateway. Спецификации пунктов остались в `docs/implementation/`.
- [owner-questions](owner-questions.ru.md) — вопросы владельцу 29.09. Открытые перенесены в раздел «Решения владельца» плана.

## Сопоставление с оригиналом (`parity/`)

- [audit-2026-09-28](parity/audit-2026-09-28.ru.md) — аудит клиента 28.09, из которого составлен план: доказательства, код, эталон ядра и стокового Lua.
- Матрицы [P0](parity/parity-p0-matrix.ru.md) и [P1](parity/parity-p1-matrix.ru.md), [эталон](parity/parity-reference-baseline.ru.md), [блокеры](parity/parity-blockers.ru.md), [журнал срезов](parity/parity-execution.ru.md) до 10.10.
- Передачи между сессиями: [28.09](parity/handoff-2026-09-28.ru.md), [28.09, ночь](parity/handoff-2026-09-28-night.ru.md), [29.09](parity/handoff-2026-09-29.ru.md), [30.09](parity/handoff-2026-09-30.ru.md), [03–05.10](parity/handoff-2026-10-03.ru.md).
- Чек-листы с вашими отметками: [05.10](parity/live-checklist-2026-10-05.ru.md), [08.10](parity/live-checklist-2026-10-08.ru.md). Неотмеченное из них перенесено в LIVE_CHECKS.
- Разборы встроенного интерфейса: [ремонт](parity/native-repair-analysis.ru.md), [слежение](parity/native-tracking-analysis.ru.md).

## Производительность

Ранние отчёты; текущий журнал замеров — [PERF_STATUS](../PERF_STATUS.md), каталог — [OPTIMIZATION_CATALOG](../OPTIMIZATION_CATALOG.ru.md).

- [PERFORMANCE_AUDIT](PERFORMANCE_AUDIT.md), [PERFORMANCE_120FPS](PERFORMANCE_120FPS.ru.md), [PERFORMANCE_ROOT_CAUSE](PERFORMANCE_ROOT_CAUSE.ru.md).
- [STREAMING_OPTIMIZATION](STREAMING_OPTIMIZATION.ru.md), [CLIENT_RENDER_OPTIMIZATIONS](CLIENT_RENDER_OPTIMIZATIONS.ru.md), [WOWEE_OPTIMIZATION_REVIEW](WOWEE_OPTIMIZATION_REVIEW.ru.md).
- [UNIT_STREAMING_FIXES](UNIT_STREAMING_FIXES.ru.md), [TSWOW_ADDON_LOADING_FIXES](TSWOW_ADDON_LOADING_FIXES.ru.md).
