# План визуальной модернизации WebClient

Статус: рабочий roadmap, обновлён 2026-08-28. Фактическая сводка выполненных работ и точка
продолжения: [IMPLEMENTATION_STATUS.ru.md](IMPLEMENTATION_STATUS.ru.md).

## Цель и визуальное направление

Клиент развивается в направлении **faithful-plus**: сохраняет авторские цвета, туман,
прозрачность, материалы и силуэты WoW 3.3.5a, но использует современный запас памяти и GPU там,
где это повышает дальность, стабильность и читаемость изображения. Агрессивная художественная
переинтерпретация допускается только отдельным экспериментальным профилем.

Отсутствие 32-битного ограничения снимает потолок адресного пространства процесса, но не отменяет
лимиты VRAM, fill-rate, пропускной способности памяти, draw calls, main thread и сети. Поэтому
«без ущерба производительности» означает воспроизводимый результат на одном оборудовании и одном
маршруте, а не простое увеличение констант.

## Что уже есть

- Авторское освещение из `Light.dbc`, зональные небо, туман, вода и skybox.
- Собственная тональная кривая без навязывания PBR исходному арту.
- Три уровня освещения и ограниченный бюджет теней.
- Детальный terrain 3×3, четырёхслойный splat, MCCV, mipmaps и анизотропия.
- Дальний WDL-рельеф примерно до четырёх тайлов; far plane камеры — 4000 ярдов.
- WMO portal culling, потоковая загрузка групп, интерьерное освещение и MFOG.
- Instanced rendering окружения и травы, отдельные бюджеты объектов, юнитов и эффектов.
- Анимированная вода, типы жидкостей, глубинный цвет и shader-погода.
- Ручные настройки render scale, освещения, WMO occlusion, травы и камеры.
- Базовые счётчики FPS, frame time, draw calls, triangles, GPU textures/geometries.

## Главные разрывы

1. Между полными моделями на 250–300 ярдах и WDL-горизонтом нет среднего LOD/HLOD-кольца.
2. Базовый 300-yard streaming/range contract закрыт автоматикой; live-world exit R3 с длинными
   маршрутами, 360°-поворотом и пересечением ADT ещё не подтверждён.
3. Terrain, splat, environment/model/animation и renderer-кеши получили bounded lifecycle; formal
   benchmark gate всё ещё ждёт утверждённые fixtures и live A/B.
4. Environment, unit и game-object budgets проходят camera-aware admission; сохранены pinned targets
   и fail-open правила.
5. Выбор окружения использует стабильный bounded top-K с исходным ordinal tie-break.
6. GPU timer, full-frame percentiles, identity-led residency accounting и benchmark route существуют;
   пока нельзя заявлять отсутствие performance regression без formal fixtures/A-B.
7. R5.1 закрывает перенос authored WMO `MONR` в WWM2 и прошёл corpus/automatic QA; отдельный
   reference visual proof без утверждённого baseline не заявляется.
8. Нет безопасного postprocessing graph, который сохраняет sky prepass, depth и существующий
   authored tone mapping; R7 — архивный раздел вне текущего scope.
9. Нет adaptive quality controller с hysteresis и раздельной реакцией на CPU/GPU bottleneck; R6 —
   архивный раздел вне текущего scope.

## Этапы внедрения

### R0 — корректность

- [x] R0.1. Сделать tile footprint зависимым от фактической дальности окружения. Pure и integration
  тесты фиксируют центр, границу, угол и края карты, фактические URL, отсутствие повторных/out-of-map
  запросов и доступность placement из соседнего тайла внутри круга 300 ярдов.

Критерий выхода: текущие 300 ярдов действительно покрыты независимо от положения игрока внутри ADT,
а streaming не запрашивает тайлы вне карты.

### R1 — измеримость

- [x] Добавить immutable live `RenderTelemetrySnapshot`: full-frame CPU, renderer update/submit,
  cadence, p50/p95/p99, long-frame count, draw calls, triangles и admission counters по категориям.
- [x] Добавить асинхронный WebGL2 GPU timer через `EXT_disjoint_timer_query_webgl2`: bounded query
  ring, неблокирующий polling, обработка disjoint/context loss и запрет как `gl.finish`, так и
  накопления неразрешённых queries. Отсутствие extension публиковать как `unavailable`, не как
  `0 ms`.
- [x] Экспортировать queue depth и active requests, а также частичные exact owned/typed-payload
  byte counters для ресурсов, чьё владение уже известно. Это не полная оценка CPU/GPU bytes и не
  заявленная браузером реальная VRAM.
- [x] Зафиксировать первый benchmark manifest и bounded 90-секундный run accumulator: canvas
  1920×1080, DPR 1, render scale 100%, lighting 1, Goldshire exterior
  (`map 0`, `(-9461.82, 63.31, 56.23)`, fine weather, half-minute 1440), Stormwind
  (`map 0`, `(-8913.25, 554.5, 93.75)`, fine weather) и cold run как отдельный режим. Добавлен
  immutable JSON-safe контракт metadata для переданных canvas/browser/WebGL/settings; недоступные
  GPU vendor/renderer не выдумываются.
- [x] Добавить live diagnostic console runner для текущих captures и run summaries. Это
  диагностический инструмент, НЕ formal gate и не доказательство измеренной производительности.
- [x] Подключить character atlas anisotropy как account feature flag с opt-in по умолчанию OFF;
  сохраняются тот же `Texture`, sRGB, ClampToEdge и `flipY=false`. Max anisotropy остаётся
  кандидатом для A/B, а решение о default ещё не принято.
- [x] Добавить identity-led shared/ref-count CPU/GPU logical byte estimate для ресурсов с известной
  раскладкой; browser/driver-owned и специальные layout остаются отдельными наблюдаемыми `unknown`,
  а не выдуманной «полной VRAM».
  - [x] Первый slice: единый identity-ledger для exact retained CPU backing buffers и явно
    обозначенной `estimatedGpuBufferBytes`; учтены terrain/splat payloads и buffer geometry живых
    world/sky scenes, включая index, morph и instance buffers.
  - [x] Второй slice: ordinary texture allocation identity повторяет Three r185 по паре
    `Source + sampler cache key`; отдельно считаются известные/неизвестные logical GPU bytes,
    generated/manual mip chains и DataArray layers без двойного учёта typed CPU pixels. Подключены
    terrain splats, cached 512×512 character atlases, direct material maps и structured shader
    uniforms живых world/sky scenes; browser-owned Canvas/ImageBitmap storage остаётся unknown.
  - [x] Третий slice: render-target attachments, depth/stencil renderbuffers, cube/array/3D targets,
    explicit MSAA-topology unknowns, shadow maps и cache-only environment/effect/weather/liquid/
    ground-cover/horizon/portrait resources. Shared identity не удваивает один ресурс при повторном
    обходе или нескольких владельцах.
  - [x] Специальные video/external/browser-decoded textures и реально opaque browser/driver
    allocations классифицируются как явные `unknown`; coverage gaps и число таких ресурсов
    публикуются, выдуманная оценка им не присваивается.
- [x] Добавить детерминированный world snapshot/replay: фиксированные object state, camera path,
  время, погода, RNG seed и порядок кадров, без живой вариативности «массового боя». Snapshot
  канонизируется, хэшируется, материализует transport motion и исполняется ровно 5 400 логических
  кадров с шагом `1000/60`; renderer temporal state сбрасывается между прогонами.
- [ ] Добавить реальные benchmark fixtures для interior, underwater и rain 0.7 с проверяемыми
  координатами и условиями сцены.
- [x] Подключить live capture обеих точек фактического canvas/DPR/browser/WebGL/settings профиля
  рядом с каждым результатом; сырой User-Agent не сохранять, неподдерживаемые vendor/renderer и
  renderer pixel ratio оставлять явно `unsupported`.
- [x] Реализовать paired alternating runner + bootstrap: пять пар / десять 90-секундных warm runs
  в порядке `ABBAABBAAB`, одна неизменяемая snapshot/config identity и bootstrap только по пяти
  парным run-level разницам. Пропущенный 60 Hz submission slot инвалидирует прогон вместо
  ускоренного catch-up. Произвольный/test host может создать только diagnostic report;
  `formalGateEligible:true` требует live-host provenance и закреплённый hash утверждённой fixture.
- [x] Подключить ручной formal console workflow и настоящий exclusive live host: фактический
  renderer readback, синхронные атомарные barriers, абсолютный 60 Hz timer, проверка canvas/DPR и
  WebGL context epoch на каждом submit, изоляция портретов/живых transient FX, immutable candidate
  hashes, Abort/status и fail-closed cleanup. Пока fixture hashes не утверждены, console выдаёт
  только diagnostic result.
- [ ] Принять A/B решение по изменению default и формально закрыть R1 только после корректного
  GPU timer либо явно CPU-only вывода; неподдерживаемая метрика должна быть `unavailable`, а
  утверждение об отсутствии GPU-регрессии запрещено.

Критерий выхода R1 ещё не достигнут: одно изменение должно сравниваться с baseline по CPU и GPU
p95/p99, cold-load hitches и росту ресурсов через paired run-level bootstrap с 95% confidence
interval по парным относительным разницам прогонов.

#### Текущий остаток R1

1. [x] Специальные video/external/browser-decoded textures и opaque browser/driver allocations
   сохранены неизвестными, но наблюдаемыми; partial logical estimate не называется реальной VRAM.
2. В живом клиенте захватить, визуально проверить и закрепить immutable hashes утверждённых
   Goldshire/Stormwind replay fixtures по [ручной инструкции](FORMAL_BENCHMARK_GUIDE.ru.md); до
   этого их результаты остаются diagnostic/candidate.
3. Подготовить реальные fixtures interior, underwater и rain 0.7 с проверяемыми ожиданиями сцены.
4. Выполнить десять live warm runs для A/B character-atlas anisotropy на утверждённой fixture и
   только затем принять решение о default.

R1 не считается завершённым: уже доступные telemetry, diagnostic runner и частичные exact counters
являются инструментами измерения, а не заявленным результатом производительности.

Решение владельца от 2026-08-27: ручной capture Goldshire/Stormwind сейчас недоступен; разрешено
перейти к R2 без закреплённых fixture hashes и без A/B решения. Это owner waiver, а не успешный
formal gate: `characterAtlasAnisotropy` остаётся opt-in/OFF по умолчанию, и утверждения об
улучшении CPU/GPU производительности до будущего измерения запрещены.

### R2 — bounded residency

- R2.1: ввести resource accounting, ownership/ref-count contract и тесты shared resources.
- [x] R2.2: ограничить terrain/splat residency; при eviction освобождать
  textures/materials/geometry и доказать отсутствие use-after-dispose при переходе через ADT.
  - [x] CPU terrain tiles: LRU ограничен 64 завершёнными payloads, текущий clipped 5×5 dependency
    footprint закреплён независимо от WebGL/Canvas path, eviction удаляет и tile revision; late
    response не вытесняет pins, а transient null повторно загружается после re-entry.
  - [x] GPU splat tiles: residency равен активному 3×3, renderer сначала отвязывает и освобождает
    material/geometry, затем evict освобождает DataArrayTexture/alpha/index/MCCV ровно один раз.
    Shared decoded layers удерживаются lease-счётчиком; epoch/request identity блокирует stale
    completion после ADT/world teardown; partial texture failure дожидается siblings и очищает все
    handles. Pending handles входят в resource accounting, disposed handles исключаются.
  - [x] Детерминированные regression-тесты покрывают переход/возврат, shared layer, late response,
    rejected retry, partial failure, idempotent dispose и порядок renderer → splat при teardown.
- [x] R2.3: ограничить environment tile, decoded model и animation residency с pin для активной сцены.
  - [x] Первый slice: terminal cache environment tiles ограничен 64 записями с LRU, точным pin
    текущего footprint, очисткой outcome ledgers и повторной загрузкой transient failure после
    выхода из сцены; late response не вытесняет активный tile.
  - [x] Decoded models и animations имеют раздельные LRU (256/128), exact frame pins и bounded
    очереди. Четыре model/group lane и две animation lane сохраняют приоритет critical work;
    transient failures используют demand-driven backoff, terminal outcomes не создают request
    storm, а teardown отменяет I/O и игнорирует late settlement.
  - [x] Soft residency ограничен 64 MiB typed backing для models и animations плюс 8 млн обычных
    numeric array elements для models; active pins могут явно превысить soft budget. Hard entry и
    response limits применяются до декодирования, а WMO group cost обновляется только у точного
    текущего parent identity.
  - [x] WMO group queue/deferred/failed readiness привязан к exact `{decoded parent, group}` demand
    текущего кадра. Уже начатый I/O остаётся видимым в `activeGroups` до settlement, поэтому formal
    gate не принимает сцену за idle во время старой загрузки; re-entry использует сохранённый
    outcome без повторного запроса.
  - [x] WVM9/WVA1 проходят структурный preflight до count-driven allocations. Corpus-аудит
    декодировал 970/970 WVM9 и 708/708 WVA1, проверил 200 текущих пар и 770 285 channels без
    bone/kind incompatibility; queue/failure counters включены в fail-closed formal gate.
- [x] R2.4: ограничить built model/WMO/texture GPU resources; self, target/focus и текущие spell
  phases не вытесняются.
  - [x] Stage 1 lifecycle: единый exactly-once disposer освобождает mixer/root/Skeleton экземпляра,
    не трогая shared geometry/material. Realm teardown сначала удаляет всех renderer borrowers,
    затем дедуплицированно освобождает owned caches/GPU resources, сбрасывает base URL и начинает
    новый session epoch; full renderer dispose отдельно освобождает permanent shell и listeners.
  - [x] Built model/template keys включают monotonic session identity, а texture loaders имеют
    completion epoch и idempotent clear. Late result старой сессии не меняет readiness и не может
    переиспользоваться новой сессией под тем же logical key; CharacterAtlas сохраняет raw
    appearance-key contract.
  - [x] Built models (256/64 MiB), unit appearances (96/64 MiB) и WMO group geometry
    (256/64 MiB) ограничены true LRU по count и exact exposed direct-buffer bytes. Post-admission
    eviction использует exact pins всех живых borrowers; dormant WMO wrappers физически
    отвязываются, inactive geometry не удерживает decoded parent, а re-entry строит свежий ресурс
    без use-after-dispose. Unit build отдельно удерживает внешний CharacterAtlas; model/unit
    template namespaces разделены.
  - [x] Leases/shared owners для WMO/source textures, atlas и weather используют bounded texture
    residency и async generation; unknown browser allocations не заменяются выдуманной оценкой VRAM.
    - [x] Liquid lifecycle закрывает pending, retained и late loader handles exact-once, не допускает
      post-dispose resurrection и выполняется после удаления всех renderer borrowers.
    - [x] Spell texture cache использует exact-record leases и true LRU 256/128 MiB известных
      logical bytes. Pending/leased записи закреплены; mesh и emitter получают независимые private
      Texture views с общим Source, поэтому sampling flags больше не мутируют canonical texture.
      Sync/duplicate/late callbacks, reentrant clear и teardown освобождают каждый owned resource
      ровно один раз.
    - [x] CharacterAtlas использует раздельные true LRU для 96 composed atlas / 128 MiB известных
      logical texture bytes и 512 source paths / 64 млн уникальных decoded pixels. Exact leases,
      alias bitmap refcounts, 4 MiB encoded и 1024² decoded caps, active-pin overflow, scoped formal
      readiness, отмена stale no-atlas work и повторный вход покрыты behavioral regressions.
    - [x] Weather lifecycle закрывает throw/undefined/reentry/alias/dispose paths exact-once;
      material теряет `uMap` до синхронных dispose-listeners, а post-dispose API остаётся inert.
    - [x] WMO/world materials используют shared WMO+legacy exact `{decoded parent, run}` keys,
      material true LRU на 256 entries и canonical texture bases с лимитами 256/128 MiB. Exact
      leases/pins сводятся в single union commit, а eviction каскадно освобождает зависимые
      material/texture/geometry resources. Legacy geometry ограничена true LRU 256/64 MiB для
      environment/game object/unit/sky. Same-path replacement использует exact identity, включая
      units; ordered teardown удаляет borrowers до owned/shared resources, monotonic/scoped readiness
      отбрасывает stale completion. Plateau и безопасный re-entry после eviction покрыты тестами.

Каждый подэтап отдельно доказывает plateau и корректный повторный вход в уже вытесненную область.

### R3 — правильный admission

- Разделить pipeline:

  `stream set -> resident set -> frustum/portal-visible set -> budgeted draw set`.

- Применять frustum/portal visibility до draw budget, сохраняя более широкий resident/warm set для
  поворота камеры без pop-in.
- [x] R3.0: exact stable bounded max-heap выполняет выбор top-K за O(N log K) при O(K) memory;
  stable ordinal ties per quota дают output-equivalent selection текущему `sort+slice`. Изображение,
  model calls и residency не изменены; свежие focused automated tests дали 98/98.
- [x] R3.1: visibility-aware unit admission выполняет frustum до budget; pinned self/target/focus/portrait
  обходят ограничения. Используются только current trusted bounds, а composite/emitters/stale данные дают
  fail-open; culled/over-budget residents скрываются без disposal/reload; выбор — stable top-K. Автоматические
  проверки: 2168 total / 2151 pass / 17 skip / 0 fail; отдельный critic — CLEAN.
- [x] Live-проверка R3.1 (подтверждено владельцем 2026-08-28): crowded scene в режиме 360°, пересечение
  границы/поворот без пустого сектора и pop-in, сохранение target/focus/self, отсутствие пропажи
  mount/equipment/emote silhouettes. Автоматический browser smoke прошёл только login screen, gateway 8090
  unavailable; live acceptance подтверждён владельцем отдельно.
- [x] R3.2: game-object visibility применяется до budget с pinned target/focus внутри прежней range,
  stable top-K и warm residency. Culling использует только revision-stamped current static WVM bounds;
  composite/moving/stale/malformed data fail-open, а runtime metadata remap инвалидируется до candidate
  pass. Hot path allocation-free. Focused checks и два критических post-pass review завершены;
  browser login smoke прошёл, live world validation остаётся в exit-проходе R3.
- [x] R3.3a: добавлен immutable spatial foundation для static environment. Индекс с ячейкой 128
  строится только при смене identity/generation resident snapshot; запрос штатного range проверяет
  не более 36 grid cells через direct lookup вместо полного обхода дальних bins. AABB индексируются
  консервативно, spanning placements дедуплицируются, malformed/oversized/overflow data fail-open.
  Replication ограничена 256 cells на placement и 262 144 entries на snapshot. Exact
  `placementDistance`, ranges 300/60, quotas 320/120 и исходный ordinal tie-break не изменились;
  legacy-equivalence подтверждена behavioral и property-style тестами.
- [x] Background model/animation/group backlog уже ограничен hard caps по 256 entries; promotion и
  reserved lane сохраняют `critical > normal > background`. Spatial prefilter не выполняет resource
  lookup и не расширяет downstream demand.
- [x] R3.3b: static environment проходит spatial/range prefilter, затем per-frame frustum и только
  потом независимые exterior/interior quotas 320/120 со стабильным исходным ordinal. Finite ordered
  wire AABB проверяются без model lookup с преобразованием world `(x, y, z)` -> scene `(x, z, -y)`;
  missing/malformed bounds fail-open, а безопасные уже построенные static M2 могут использовать
  retained sphere. WMO portal остаётся group-level refinement после admission родительского placement.
- [x] In-range culled/over-budget environment остаётся скрытым warm resident без reload/dispose.
  Hidden warm LRU ограничен 960 exterior и 360 interior entries (вместе с текущим draw set максимум
  1280/480); current draw set не вытесняется. Hidden residents исключены из instances, effects,
  doodad pose и WMO group demand; WMO rooms освобождаются, liquid mesh сохраняется скрытым.
  Полный teardown выполняется только при выходе из range, замене exact source/model identity или
  overflow warm LRU. Retained sphere хранится в `WeakMap` по exact source identity, переживает
  warm-node eviction и временный model-cache miss, но не удерживает tile/model/node/GPU resource.
- [x] R3.3b автоматическая проверка и отдельный post-fix Luna xhigh critic завершены; итог полного
  `node --test` будет зафиксирован после независимого финального прогона production. TypeScript
  typecheck и production build успешны. Login-screen browser smoke на 375×812, 768×1024 и 1440×900
  не выявил overflow или console errors/warnings; gateway 8090 недоступен, поэтому это не live-world
  pass.

Открытый критерий выхода R3: после двух одинаковых длинных live-маршрутов residency выходит на
плато; поворот на 360° и пересечение ADT не создают пустого сектора; current gameplay budgets не
регрессируют. Автоматическая часть R3.3b закрыта, но этот live-world gate ею не подменяется.

### R4 — дальность через LOD, а не через full-detail brute force

- Сохранить near ring: текущий 3×3 full terrain/splat и полные модели примерно до 300 ярдов.
- [x] R4.0a. Исследовать authored M2 `01.skin`/`02.skin` до собственной mesh simplification.
  Полный corpus-аудит нашёл 1155 валидных сравнений `01` и 359 сравнений `02`: global oriented
  triangle sets и текущий batch-drawn triangle count совпали в 100% случаев, экономия полигонов
  равна 0%, а lookup vertex count в среднем вырос примерно на 0,40%. Эти профили не являются
  geometry LOD и не подключаются к runtime mid ring.
- [x] R4.0b. Построить детерминированный offline-профиль настоящего static M2 simplification,
  сохранить authored batch/geoset/material boundaries и conservative bounds. Реализованный
  resource-free simplifier создаёт отдельный source-bound WVM9 artifact, не меняет `00.skin`,
  сохраняет vertex/material streams и fail-closed отклоняет skinned, animated и неоднозначные
  модели. Synthetic topology/identity/round-trip contracts закрыты; runtime wiring отсутствует.
- [x] R4.0c. Связать direct ADT MDDF placements с corpus-аудитом. Read-only scanner нашёл 5774 ADT,
  1 023 338 direct placements и 6182 distinct exterior M2; все 6182 имеют M2 + `00.skin`. На
  детерминированной выборке 512 (`e124c21cacf6801026b5ac873ebcdffb7c200106`) static gate не
  допустил ни одной модели: 511 имеют skinned geometry и 511 — material semantics вне R4.0b.
  Поэтому mid-ring включение правильно осталось закрытым.
- [x] R4.1a. Доказать offline skinned/material-preserving simplification без rigid bind-pose bake:
  сохранять полный skeleton, clips/attachments, bone streams, material tracks и authored partitions,
  требовать source/sidecar identity и trusted conservative animated bounds. Corpus-классификация
  показала, что даже среди 436 rigid same-bone моделей у 431 referenced-bone channels отсутствуют
  или не декодируются; строго доказанный static-pose subset равен 0. До WVM9 round-trip, deterministic
  bytes и отдельного runtime residency gate новый профиль не подключается. Offline proof реализован:
  per-submesh index simplification сохраняет полные vertex/bone/material streams, блокирует authored
  bone-influence seams, проходит WVM9 round-trip и fail-closed preflight. Объединённый R4 focused suite
  — 45/45; реальный 512-sample повтор сохранил `0 eligible`, поэтому runtime wiring отсутствует.
- Mid ring остаётся planned, но runtime gate-rejected: reachable low artifact/variant identity ещё
  отсутствуют, а authored `01/02.skin` не дают triangle reduction. Не подключать его в runtime до
  bounded residency и source/variant identity proof.
- При будущем возвращении к mid ring сохранить ограничения: 300–600 ярдов на Balanced, до
  `min(1200, fogFar)` на High, zone fog/MFOG и indoor visibility, WMO exterior-only и без расширения
  3×3 full-resolution terrain.
- Оставить WDL дальним кольцом; исправить blending и macro-colour на переходе, не расширять 3×3
  full-resolution terrain до 5×5.
- Использовать короткий dither/fade overlap между LOD, чтобы не держать оба уровня долго.

Критерий выхода: силуэты сценографии видны до целевой дальности, near quality не меняется, а CPU/GPU
p95 не хуже baseline более чем на 5% в утверждённых профилях.

### R5 — faithful-plus и экспериментальные shader upgrades

Порядок задаётся отношением visual gain к runtime cost:

1. [x] R5.1: authored WMO `MONR` переносится в WWM2 с сохранением жёстких граней; corpus metrics
   и digest зафиксированы в status-файле, root combined focused proof — 121/121.
2. [x] R5.2: far-material simplification **gate-rejected** — runtime low artifact/variant identity
   отсутствуют, а authored `01/02.skin` не дали triangle reduction.
3. [x] R5.3: dithered LOD transitions **blocked** до реальной near/far пары и отдельного
   transition/residency proof.
4. [x] R5.4: Fresnel, micro-waves и sun sparkle реализованы для water/ocean и class-aware fallback.
   По решению владельца от 2026-08-28 три water-листа включены в новых/default settings, но каждый
   сохраняет отдельный rollback switch; профиль v2 использует одну bounded micro-wave normal для
   Fresnel и sparkle, а отражённые эффекты подавляются под водой. Reference/golden visual claim и
   formal performance A/B отдельно не заявляются. Aerial flag остаётся state-only/no-op, full
   exterior aerial/height fog **blocked** из-за interior/shared-material identity.
5. [x] R5.5: центр directional-shadow камеры стабилизирован в плоскости света по размеру texel для
   карт 512/1024. Смещение вдоль луча не квантуется, новых passes/textures нет, а quality 0 сохраняет
   точный путь без shadow map.
6. [x] R5.6: splat-terrain получил bounded albedo-derived micro-normal перед авторским lighting
   block. Эффект меняет только view-space normal, не добавляет textures/draw calls/passes, затухает
   на 50–125 ярдах и у границ чанков. По решению владельца от 2026-08-28 настройка default-ON, но
   отдельный rollback возвращает прежние shader source/cache key. `Light.dbc`, MCCV, shadows, fog и
   tone mapping не заменяются. До authenticated golden/formal A/B это implementation claim, а не
   утверждение о reference fidelity или производительности.

Каждый shader patch обязан вызывать предыдущий `onBeforeCompile`, сохранять его program cache key,
иметь rollback flag и сохранять byte/visual-equivalent baseline при выключении. Golden manifest
фиксирует world snapshot, координаты и камеру из R1, time/weather, interior/exterior/underwater,
canvas/DPR/render scale, output colour space и браузер/GPU.

### R6 — адаптивное качество (вне текущего scope)

По решению владельца от 2026-08-28 активный roadmap завершается на R5. Этот раздел сохранён только
как архив возможного продолжения, out of scope и не входит в acceptance/Definition of Done R5.

- Пользователь задаёт максимальный профиль, контроллер выбирает effective tier.
- Контроллер сначала использует измеренную на текущем GPU таблицу стоимости quality knobs; порядок
  shadows/render scale/grass/far LOD не зашивается до этих измерений.
- При CPU bottleneck допускается снижать дальние animation/effect admission и object LOD, но не
  self/target/focus.
- Снижать после примерно 2 секунд устойчивой перегрузки; повышать после 8–10 секунд запаса.
- Не допускать более двух переключений за 30 секунд; streaming/decode hitch не должен надолго
  понижать качество.

### R7 — опциональный postprocessing (архивный, out of scope; не входит в acceptance/DoD R5)

По решению владельца от 2026-08-28 этот раздел архивный и не входит в acceptance/Definition of Done
R5; перечисленные идеи не являются текущими задачами.

Только после R1–R5 и только при измеренном GPU headroom:

- offscreen color/depth pipeline, сохраняющий отдельные sky/world passes и текущий tone mapping;
- SMAA/FXAA и опциональный CAS/upscale;
- half-resolution SSAO с temporal stability;
- очень ограниченный authored bloom;
- затем, при подтверждённом бюджете, half-resolution refraction/shore foam и две каскадные тени.

SSAO, bloom, SSR, volumetric fog, DOF и motion blur по умолчанию не включаются.

## Общие критерии приёмки

- Warm A/B benchmark: верхняя граница paired run-level 95% confidence interval регрессии p95
  CPU/GPU не превышает 3% для foundation-only изменений и 5% для нового opt-in quality tier; для
  p99 — 5%/10%. GPU-gate применяется только при валидном timer query во всех сравниваемых runs.
- Второй 30-минутный маршрут не увеличивает resident estimate относительно первого более чем на
  `max(5%, 64 MiB)`; в покое нет монотонного роста texture/geometry counts.
- Critical model-start latency ухудшается не более чем на 10%; background queue имеет жёсткий cap.
- После прогрева нет новых first-visible-material long frames более 50 мс. Когда появится явная
  compile instrumentation или parallel compile status, gate уточняется до shader compilation hitch.
- На слабом WebGL контексте качество деградирует, но геометрия, цвета и управление остаются
  корректными.
- Дальность удалённых серверных юнитов ограничена тем, что сервер прислал клиенту; renderer не
  обещает сущности, отсутствующие в update visibility.

## Параллельная gameplay regression matrix

Она не блокирует создание R1-инструментов, но блокирует релиз соответствующей gameplay-функции.

- [x] Mount protocol/unit: пустой `CMSG_CANCEL_MOUNT_AURA` идёт перед обычным cast; повторное
  применение активного mount отправляет только cancel; смена mount делает cancel → cast; mounted
  state остаётся server-authoritative; покрыты flag/display fallback, `openLock`, async metadata и
  локальные guards до автодиспела.
- [x] Mount live acceptance подтверждён владельцем 2026-08-27 для обычного и летающего mount:
  повторное применение и применение заклинания корректно спешивают без зависшего состояния.
  Подробный trace с версией client data/server, display id, rig/clips, movement flags и mixers не
  архивировался; protocol/state-machine поведение остаётся закреплено unit-тестами.

## Что намеренно не делаем первым

- Глобальный PBR/normal-map rewrite исходных материалов.
- 5×5 full-resolution terrain ring.
- Простое повышение unit/object/effect budgets.
- DPR выше 2 и массовый upscale текстур.
- Глобальные SSAO/SSR/bloom/DOF/motion blur/volumetric fog.
- Cascaded shadows для всей сценографии.
- Автоматическую decimation анимированных/alpha-моделей без проверки силуэта и материалов.

Эти изменения либо меняют авторский вид, либо увеличивают passes, overdraw, VRAM и shader variants
до появления инструментов, способных доказать их стоимость.
