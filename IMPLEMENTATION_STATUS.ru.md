# Фактический статус работ WebClient

Снимок состояния на 2026-08-28. Этот файл отделяет уже реализованное и проверенное от открытых
исследований и будущего roadmap. Детальные технические критерии остаются в
[VISUAL_MODERNIZATION_PLAN.ru.md](VISUAL_MODERNIZATION_PLAN.ru.md), а ручной formal workflow — в
[FORMAL_BENCHMARK_GUIDE.ru.md](FORMAL_BENCHMARK_GUIDE.ru.md).

## Обозначения

- **Реализовано** — код и автоматические проверки присутствуют.
- **Live подтверждено** — результат отдельно проверен владельцем в игровом клиенте.
- **Owner waiver** — владелец разрешил продолжить без недоступной ручной проверки; это не означает
  успешное прохождение соответствующего gate.
- **Запланировано** — код ещё не реализован.

## Проведённый аудит и выбранное направление

- Сопоставлены возможности оригинального клиента WoW 3.3.5a и текущего WebClient: отображение мира,
  terrain/WMO/M2, освещение и туман, вода и погода, дальность, gameplay UI, сущности, заклинания,
  маунты, streaming, resource lifecycle и производительность.
- Зафиксировано направление **faithful-plus**: сохранять авторские материалы, цвета, прозрачность,
  туман и силуэты, а современные возможности 64-битного окружения и WebGL использовать для
  дальности, стабильности и измеряемых visual upgrades.
- Отдельно зафиксировано, что снятие 32-битного лимита адресного пространства не снимает ограничения
  VRAM, fill-rate, draw calls, main thread, сети и времени декодирования. Поэтому увеличение
  дальности строится через bounded residency, admission и LOD, а не через рост всех бюджетов.
- Активный roadmap ограничен R0–R5; R6/R7 по решению владельца оставлены архивными и out of scope,
  не входят в acceptance/Definition of Done R5.
  Также зафиксирован список намеренно отложенных дорогих/неверных первых шагов:
  глобальный PBR rewrite, 5x5 full-resolution terrain, массовый upscale, безусловный postprocessing
  и простое повышение unit/object/effect budgets.

## Gameplay: маунты

**Реализовано и live подтверждено.**

- Mounted state определяется по `UNIT_FLAG_MOUNT` с fallback на `MOUNTDISPLAYID`.
- Перед обычным заклинанием отправляется `CMSG_CANCEL_MOUNT_AURA`, затем обычный cast; состояние не
  предсказывается локально и остаётся server-authoritative.
- Повторное применение активного mount spell отправляет только cancel и не создаёт лишний cast.
- Применение другого mount делает последовательность cancel -> cast.
- Собственные cooldown/GCD активного mount не блокируют toggle-off; единый guard используется
  spellbook/action bar и связанными окнами.
- `openLock`, неизвестные spells, не-mount aura и асинхронная DBC metadata покрыты отдельными
  regression tests.
- Владелец подтвердил обычного и летающего маунта: повторное применение и применение заклинания
  корректно спешивают, сломанное зависшее состояние не воспроизводится.

## R0: корректность streaming footprint

**Реализовано.**

- Tile footprint теперь зависит от фактической дальности окружения и покрывает 300 ярдов независимо
  от положения игрока внутри ADT.
- Зафиксированы центр, границы, углы карты, соседние tiles, реальные URL и отсутствие повторных либо
  out-of-map запросов.

## R1: измеримость и formal benchmark infrastructure

**Инструменты реализованы; formal gate остаётся открытым.**

- Добавлена immutable renderer telemetry: full-frame CPU, cadence, p50/p95/p99, long frames,
  draw calls, triangles и admission counters.
- Добавлен неблокирующий WebGL2 GPU timer на `EXT_disjoint_timer_query_webgl2` с bounded query ring,
  обработкой disjoint/context loss и явным `unavailable`, когда метрика недоступна.
- Добавлен identity-led resource accounting для известных CPU/GPU buffers, textures, mip chains,
  render targets, depth/stencil, shadow maps, atlases и renderer-owned caches. Неизвестные
  browser/driver allocations остаются `unknown`, а не выдаются за реальную VRAM.
- Реализованы deterministic world snapshot/replay, фиксированные camera/time/weather/RNG, ровно
  5 400 кадров по 60 Hz и reset renderer temporal state между прогонами.
- Реализованы 90-секундный accumulator, diagnostic console workflow, alternating paired runner
  `ABBAABBAAB`, run-level bootstrap и fail-closed invalidation пропущенных submission slots.
- Реализован exclusive live formal host: renderer readback, barriers, canvas/DPR/context checks,
  context epoch, изоляция transient FX/portraits, immutable hashes, Abort/status и cleanup.
- Live result сохраняет canvas dimensions, DPR, render scale, lighting/settings, безопасные
  WebGL capability strings и best-effort browser name/version без raw UA и без hardware
  fingerprinting/vendor/renderer запросов.
- `characterAtlasAnisotropy` добавлен как account experiment и остаётся opt-in/OFF до A/B решения.
- Formal frame preparation правильно открывает/закрывает resource frame только для submit-прохода;
  reset-only preparation не уничтожает prewarm pins. Terminal animation failures считаются только
  в текущем committed footprint и входят в fail-closed benchmark counters.

Открытый gate R1:

- Goldshire/Stormwind fixture hashes не закреплены. Владелец 2026-08-27 дал **owner waiver** и
  разрешил продолжить без capture; это не formal pass и не доказательство отсутствия CPU/GPU
  регрессии.
- Не подготовлены утверждённые interior, underwater и rain 0.7 fixtures.
- Не выполнены десять live warm runs для A/B atlas anisotropy и не принято решение о default.

## R2: bounded residency

**R2.2, R2.3 и R2.4 реализованы.**

### Terrain и splat

- CPU terrain cache ограничен LRU на 64 terminal payloads с exact footprint pins, корректным
  eviction revision state и безопасным late response/re-entry.
- GPU splat residency ограничен активным 3x3; texture/material/geometry освобождаются exactly once.
- Shared decoded layers удерживаются lease/refcount; epoch/request identity блокирует stale
  completion после world teardown.
- Покрыты shared layer, partial failure, rejected retry, late response, idempotent dispose и
  renderer -> splat teardown ordering.

### Environment, models и animations

- Environment tiles, decoded models и animation caches имеют bounded LRU, раздельные queue lanes,
  active pins, hard response limits и soft byte/element budgets.
- Model/group work использует четыре lane, animation work — две; critical demand сохраняет
  приоритет, backlog ограничен.
- Transient failures используют demand-driven backoff; terminal outcomes не создают request storm.
- WMO group readiness привязана к exact decoded-parent identity; active I/O остаётся видимым formal
  readiness до settlement.
- WVM9/WVA1 проходят structural preflight до count-driven allocations. Corpus audit успешно
  обработал 970/970 WVM9 и 708/708 WVA1 и проверил 770 285 channels.

### Renderer/GPU lifecycle

- Введён ordered renderer lifecycle и exactly-once disposal для instances, world/session caches,
  listeners и late asynchronous completions.
- Built models, unit appearances, WMO group geometry и legacy geometry ограничены true LRU по count
  и известным direct-buffer bytes; active borrowers формируют exact pins.
- Dormant WMO wrappers отвязывают rooms без освобождения чужих shared resources; re-entry строит
  свежие wrappers без use-after-dispose.
- Реализованы bounded leases/caches для spell textures, CharacterAtlas, weather, liquid,
  WMO/legacy world materials и canonical texture bases.
- Shared identity предотвращает двойной учёт и двойное освобождение; model/unit template namespaces
  разделены, monotonic session identity блокирует reuse ресурсов старой сессии.

## R3: правильный admission

### R3.0: stable bounded top-K

**Реализовано.**

- Полная сортировка environment candidates заменена exact stable bounded max-heap:
  `O(N log K)` времени и `O(K)` дополнительной памяти.
- Equal-distance ties сохраняют исходный ordinal; randomized и adversarial tests подтверждают
  output equivalence старому stable `sort + slice`.

### R3.1: visibility-aware unit admission

**Реализовано, проверено автоматикой, отдельным критиком и live владельцем.**

- Frustum строится до unit budget; невидимые за камерой units не отнимают budget у видимых.
- Self, target, focus и portrait targets получают pinned priority и fail-open поведение.
- Culling использует только актуальные trusted WVM bounds. Mount/equipment attachments, authored
  attachments, emitters, stand-ins, legacy/stale/malformed data fail-open.
- In-range culled/over-budget nodes остаются warm residents и скрываются без disposal/reload;
  действительно вышедшие за дальность освобождаются.
- Admission не вызывает model/image/resource lookup до применения бюджета.
- `unitsDropped` считает только visible/pinned budget rejects, а не frustum-culled residents.
- Горячие radius/frustum helpers не создают временные arrays/callback iterators и fail-open при
  повреждённых plane/bounds данных.
- Владелец 2026-08-28 подтвердил crowded-scene 360-degree проверку без пустых секторов/pop-in и без
  пропажи self/target/focus, mount/equipment/emote silhouettes.

### R3.2: game-object admission

**Реализовано, проверено автоматикой, критическим аудитом и независимым post-fix review.**

- Frustum строится до `GAMEOBJECT_BUDGET`; visibility-filtered candidates проходят общий exact
  stable bounded top-K. Target/focus получают pinned priority только внутри прежней
  `GAMEOBJECT_RANGE`.
- Candidate loop читает только wire fields и retained renderer measurements. Metadata/model/image,
  transport `path()` и другие resource-triggering вызовы остаются после admission; редкая смена
  metadata revision до loop делает только cache-only переаттестацию уже stamped mappings.
- Culling разрешён лишь для current trusted static WVM: точные display/scale/entry и metadata
  revision stamps, authored bounds и built geometry sphere. Scalar hot path не создаёт временных
  center/sphere objects на каждого resident.
- WMO, legacy, empty/loading, emitters, rigged animation, moving transport, stale или malformed
  wire/model data fail-open. Runtime remap одного display id очищает старый trust до candidate pass.
- Frustum-culled и over-budget in-range objects остаются warm, скрываются каждый кадр и сохраняют
  rig/state/custom animation queue; WMO rooms освобождаются отдельно. Только truly out-of-range
  objects полностью dispose-ятся.
- `gameObjectsDropped` считает только visible/pinned budget rejects, `gameObjectsDrawn` равен
  admitted count, а culled residents не выдаются за budget drops.
- Same-frame re-entry сначала применяет entry/scale/placement и свежий `matrixWorld`, затем pose;
  hidden residents также исключены из отдельного emitter admission.
- Scheduler priority моделей остаётся `normal`; R3.2 не расширяет asset-priority scope.

### R3.3a: spatial foundation для static environment

**Реализовано, проверено автоматикой, критическим аудитом и независимым post-fix review.**

- `EnvironmentSpatialIndex` строится один раз на immutable identity/generation snapshot от
  `EnvironmentClient`; при неизменном наборе resident tiles повторной индексации нет.
- Ячейка 128 и direct `Map` lookup сокращают штатный запрос range 300 до максимум 36 grid cells.
  Дальние populated bins не обходятся; exact круговой/AABB range по-прежнему применяет прежний
  `selectEnvironment` после conservative square query.
- Spanning AABB индексируются во все пересечённые cells и дедуплицируются с восстановлением исходного
  ordinal. Malformed, non-finite, inverted и oversized placements идут в fail-open fallback.
- Replication ограничена 256 cells на один placement и 262 144 entries на snapshot; finite query
  ограничен 4096 cells. Переполнение переводит целый placement в ordered fallback без false-negative.
- Прежние ranges 300/60, независимые quotas 320/120, stable ties, model priority `background`,
  disposal/residency и resource fan-out не изменены. Сравнение полного и spatial-prefiltered selector
  прошло 250/250 дополнительных детерминированных смешанных сцен.
- Существующие model/animation/group queues уже имеют hard caps по 256 entries и сохраняют
  `critical > normal > background`; новый индекс не вызывает model/path/metadata/transport lookup.
- Это spatial foundation для реализованного ниже R3.3b; сам индекс остаётся conservative candidate
  source и не подменяет visibility predicate.

### R3.3b: environment visibility admission и warm lifecycle

**Реализовано, проверено автоматикой, критическим аудитом и независимым post-fix review.**

- После spatial/range prefilter каждый кадр применяется environment frustum, а затем прежние
  независимые exterior/interior quotas 320/120 со стабильным исходным ordinal. Строгие ranges
  `<300`/`<60` и порядок exterior -> interior сохранены.
- Finite ordered wire AABB проверяются до бюджета без resource lookup с точным world-to-scene
  преобразованием `(x, y, z)` -> `(x, z, -y)`. Missing, inverted, malformed либо overflow bounds
  fail-open. Для уже построенного безопасного static M2 без emitters/rig/legacy/composite сохраняется
  измеренная scene sphere; WMO portal culling остаётся group-level refinement после admission parent.
- Frustum-culled и over-budget in-range placements остаются скрытыми warm residents. Отдельные hidden
  LRU caps равны 960 exterior и 360 interior, то есть вместе с current draw quotas resident ceiling
  составляет 1280/480. Current draw set не может быть вытеснен warm pruning.
- Hidden environment исключён из instance batches, effects, doodad posing и WMO group demand. WMO
  rooms очищаются, liquids скрываются, но outer placement/liquid mesh не пересоздаются при повороте.
  Teardown происходит только при выходе из range, замене exact source/model identity либо overflow LRU.
- Retained sphere хранится в `WeakMap` по exact `EnvironmentObject`: она переживает warm-node eviction
  и временный `model() === undefined`, не удерживая tile object/model/node/GPU resource. Смена
  `model.wvm` явно вызывает replacement/rebuild.
- До admission нет model/image/path lookup; автоматические source contracts фиксируют этот порядок и
  admitted-only downstream paths.

### R4.0a–R4.0c: authored skins, static simplifier и ADT corpus gate

**Offline-исследование реализовано и независимо перепроверено; runtime-включение отклонено.**

- Read-only inventory проверил 22 207 M2, включая 1171 модель с заявленными `01.skin`/`02.skin`.
  Валидно сопоставлены 1155 профилей `01` и 359 профилей `02`; unreadable parent M2 не обнаружено.
- Для каждой валидной пары совпадает не только raw index count, но и global oriented triangle set
  после lookup mapping, сумма submesh indices и текущий batch-drawn triangle count. Итоговая
  экономия: `0 / 3 613 665` drawn triangles для `01` и `0 / 1 573 057` для `02`.
- `01/02` меняют lookup и partition batches/submeshes, но не геометрию; суммарный lookup vertex
  count вырос на 9280/4188, около 0,40%. Поэтому они не считаются low geometry, не публикуются как
  mid-ring variant и не меняют текущий `00.skin` generator/runtime path.
- Настоящий offline static-M2 simplifier реализован отдельно от generator/runtime. Он упрощает
  authored submeshes независимо, сохраняет batch/geoset/material boundaries, vertex streams и
  conservative bounds, выдаёт deterministic source/options-bound WVM9 bytes и fail-closed возвращает
  полный `00.skin` path для skinned/animated/effectful/неоднозначного контента.
- Direct-ADT scanner перечислил 5774 tiles, 2578 tiles с direct M2, 1 023 338 MDDF placements и 6182
  distinct exterior models. Все 6182 имеют перечисленные M2 и `00.skin`; population digest:
  `5ec8ff525f1bb27687d75744d400d8faee9afc71`.
- На всех 264 direct Stormwind models static gate дал 0 eligible. На детерминированной world-выборке
  512 с seed `r4.0c-world-v1` и selection digest
  `e124c21cacf6801026b5ac873ebcdffb7c200106` результат также 0 eligible: 511 skinned geometry,
  511 unsupported material semantics, 441 unknown animation state, 66 global sequences, 59 events,
  49 particle emitters и один count overflow. Runtime decision остаётся `insufficient-data`.

### R4.1 discovery: почему rigid bake отклонён

- В той же выборке 512 моделей bone-weight profile распределился так: 1 all-zero, 436 rigid с одной
  общей костью, 50 rigid с несколькими костями и 25 с multi-influence vertices.
- 431 из 436 внешне promising same-bone моделей имеют missing/undecodable referenced-bone channels,
  а не доказанную constant pose. С учётом emitters/events/global loops/attachments и material tracks
  строго доказанный broadened static subset равен 0.
- Следующий безопасный slice — только offline full-skeleton/material-preserving HLOD artifact:
  index simplification внутри authored submesh, exact bone/material streams, source + sidecar identity,
  trusted animated bounds и WVM9 encode/decode proof. Rigid bind-pose bake и runtime selection до этих
  доказательств запрещены; текущий full `00.skin` fallback не меняется.

### R4.1a: offline full-skeleton HLOD proof

- `simplifySkinnedM2` реализован как pure/resource-free offline API. Он упрощает только index ranges
  внутри authored submesh, оставляет vertex, bone, UV, skeleton, clips, attachments, batch/material и
  track streams отдельными свежими копиями и кодирует новый source/sidecar/options-bound WVM9 artifact.
- Exact bone-index/weight boundaries блокируются в mesh simplifier; weight tuples, hierarchy, clips,
  material/global tracks, table limits, animation sidecars и conservative animated bounds проходят
  строгий preflight. Любая неполнота возвращает `undefined`, не урезанный artifact.
- Synthetic behavioral/round-trip/resource-guard suite и все R4.0 audit contracts вместе проходят
  45/45. Runtime/generator imports и 3×3 near terrain ring не менялись.
- Усиленный real-corpus classifier повторил selection digest
  `e124c21cacf6801026b5ac873ebcdffb7c200106`: `missing=19`, `mixed=51`, `undecodable=441`,
  `not-applicable=1`, строго допустимых rigid-bake моделей — 0. Поэтому R4 runtime gate остаётся
  закрытым и текущий полный `00.skin` остаётся единственным production path.

## R5: faithful-plus и shader experiments

### R5.1: authored WMO MONR → WWM2

**Реализовано и проверено; reference visual proof отдельно не заявляется.**

- Read-only corpus `World\wmo\`: 9355 listed/read group files; 9346 geometry-valid и strict-valid;
  29 384 952 vertices и 94 948 479 indices.
- 9346 групп имеют exact finite `MONR`; missing/malformed/nonfinite — 0; 9 `parse-error` вынесены
  отдельно и не считаются MONR-ошибками.
- Normals: 29 384 952 normalized, non-unit — 0; duplicate-position groups — 9313,
  divergent-normal groups — 7587.
- Deterministic digest: `1250a6ffd07a7dc8d518f99a0f81369bc7a65c91`.
- WWM2 сохраняет authored normals, WWM1 остаётся backward-compatible fallback; root combined focused
  proof (wmo + terrain + gateway + shader-profile) — 121/121.

### R5.2: far-material simplification

**Gate-rejected; runtime не подключён.** Offline simplifier и full-skeleton proof готовы, но runtime
low artifact/variant identity отсутствуют. Authored `01/02.skin` не дали triangle reduction, поэтому
они не являются far/mid geometry LOD и текущий полный `00.skin` остаётся production path.

### R5.3: dithered LOD transitions

**Blocked.** Нет реальной near/far runtime-пары; transition нельзя подключать до отдельного
transition/residency proof и подтверждённой identity-схемы для обоих вариантов.

### R5.4: reversible faithful-plus water shaders

- Fresnel, micro-waves и sun sparkle реализованы для `water`/`ocean` и class-aware fallback. По
  решению владельца от 2026-08-28 три water-настройки теперь default-ON, но остаются независимыми
  rollback switches; выключенный mask сохраняет прежние shader source/cache key.
- Профиль v2 строит одну bounded micro-wave normal, которую используют Fresnel и солнечный блик;
  отражённые эффекты подавляются под водой. Реальный WebGL2 smoke с mask 0/1/2/4/7, fog и rollback
  прошёл без GL/shader errors, но authenticated reference/golden visual proof и formal A/B пока не
  заявляются.
- Post-review P2 закрыты: загруженные, но ещё не привязанные liquid strips входят в resource ledger
  без двойного учёта GPU allocation; non-finite или hostile injected WMO MLIQ отбрасывается до
  `BufferGeometry`, сохраняя solid collision.
- Aerial/height-fog flag остаётся state-only/no-op. Full exterior aerial fog **blocked**: текущая
  interior/shared-material identity не позволяет безопасно отделить exterior, не меняя Light.dbc,
  MFOG, indoor или underwater semantics.

### R5.5: стабильные directional shadows

- Центр shadow camera квантуется только в плоскости света по текущему texel 512/1024 карты. Это
  убирает sub-texel swimming при движении камеры, не добавляя draw calls, textures или passes.
- Координата вдоль направления света продолжает точно следовать игроку; quality 0 возвращает центр
  без изменения. CPU proof и WebGL2 caster/receiver compile-smoke для 512/1024 и OFF пройдены.

### R5.6: reversible terrain micro-normal lighting

- Уже смешанный splat albedo даёт небольшой screen-space height gradient; стандартная derivative
  basis Three переводит его в view-space normal до авторского `WorldLighting`. Новых textures,
  geometry, draw calls или render passes нет.
- Эффект затухает на 50–125 ярдах и у каждой границы чанка, где меняются layer indices. MCCV не
  участвует в height, а `Light.dbc`, shadow lookup, fog, tone mapping и Lambert no-specular contract
  остаются прежними.
- По решению владельца от 2026-08-28 настройка default-ON. Отдельный OFF-путь возвращает точные
  прежние shader source/cache key; formal anisotropy suite принудительно держит этот независимый
  leaf выключенным в обоих вариантах. Authenticated golden visual proof и performance A/B ещё не
  заявляются.

## Последняя подтверждённая проверка

Состояние после итоговой критической проверки R5.6:

- `npm run build`: успешно; TypeScript emit и Vite production build завершены. Formal benchmark
  console/runner вынесены из login-критического chunk и загружаются только по первому
  `await webclientBenchmarksReady`; остался только обычный warning о размере основного chunk.
- `npm run typecheck`: успешно, включая source-data preparation и `tsc --noEmit`.
- R5 close focused suite (collision/liquid resource accounting/water shader/formal profile и
  lifecycle) — 131/131.
- R5.6 focused matrix (terrain shader/profile, world lighting, formal host/console/run, render и
  terrain seams) — 103/103.
- Полный `node --test`: 2277 tests, 2260 pass, 0 fail, 17 dataset-dependent skip.
- `git diff --check`: ошибок нет; только известные предупреждения LF -> CRLF для `start-*.bat`.
- Финальный correctness/contract critic и отдельный Luna xhigh adversarial/post-fix review — CLEAN.
- Чистый локальный cold-start probe после исправления watcher/optimizer: `/` — 200/32 ms TTFB,
  renderer source — 200/57 ms, оптимизированный `three` — 200/8 ms; процесс Vite — около 108 MB и
  971 handles вместо прежних ~763 MB и 77 695 handles. Это единичное диагностическое измерение, не
  formal benchmark. После продолжительной QA-сессии watcher остаётся стабильным: 968 handles.
- Browser smoke на desktop и 375x812 показал форму login с доступной кнопкой без console errors;
  authenticated world-flow не запускался без тестовых учётных данных.
- Chrome WebGL2 compile-smoke с фактическими Three.js variants: 22 programs, water masks
  0/1/2/4/7 и shadows 512/1024/OFF; `glError=0`, shader errors — 0, console errors — 0. Точный
  water ON→OFF cache-key rollback подтверждён. Временный QA harness удалён.
- Отдельный terrain WebGL2 smoke с шестью plain/painted, ON/OFF и shadow 512/1024 variants также
  прошёл без GL/shader/console errors. На синтетическом tile-scale кадре ON изменил 15 907 bytes,
  при этом `programCount=6`, `textureDeltaOnToggle=0`, обычный проход остался одним draw call, а
  shadow-вариант — двумя; точный ON→OFF cache-key rollback подтверждён. Временный harness удалён.
  Это доказывает компиляцию shader variants, но не заменяет authenticated live-world A/B или
  утверждённый reference/golden visual baseline.

## Что остаётся после R5

1. Закрыть live exit R3: выполнить dense game-object/environment pass и два одинаковых
   длинных маршрута с residency plateau, поворотом 360° и пересечением ADT.
2. R4 runtime gate остаётся закрытым: authored low/HLOD mid ring не подключается до low artifact/
   variant identity и bounded residency proof; `01/02.skin` не являются geometry LOD.
3. R5.2 gate-rejected, R5.3 blocked; R5.4 water включён решением владельца с rollback switches, но
   authenticated reference/golden visual proof и formal A/B ещё не выполнены; full exterior aerial
   fog blocked.
4. Вернуться к открытому formal R1 gate, когда станут доступны утверждённые fixtures и live A/B.

## Состояние рабочего дерева

- Commit/PR в рамках этой серии работ не создавался.
- Рабочее дерево содержит совокупные изменения пользователя и выполненных этапов; их нельзя
  откатывать общим reset/clean.
- `VISUAL_MODERNIZATION_PLAN.ru.md` и этот status-файл служат точкой продолжения работ.
