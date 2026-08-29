# Ручная проверка formal render benchmark

Это инструкция для захвата кандидата и диагностического прогона в DevTools. Текущие fixture-хэши
ещё не закреплены, поэтому результат нельзя выдавать за formal benchmark или использовать как
formal-решение.

## Перед началом

- Откройте запущенный WebClient, войдите в мир и работайте в одном сеансе браузера.
- Подготовьте canvas с CSS-размером **1920×1080**, системным DPR **1**. Профиль также требует
  drawing buffer 1920×1080, effective pixel ratio 1, render scale 100% и lighting 1.
- Выберите одну из двух координатных сцен. В обеих `mapId: 0`, погода fine, время фиксировано
  (`halfMinute: 1440`), сцена внешняя:

  | Сцена | `scenarioId` | Координаты персонажа (допуск ±0,01 ярда) |
  | --- | --- | --- |
  | Goldshire | `goldshire-exterior` | `x=-9461.82, y=63.31, z=56.23` |
  | Stormwind | `stormwind` | `x=-8913.25, y=554.50, z=93.75` |

- Убедитесь, что персонаж и мир готовы, а данные фракций загружены: host требует
  `factions.ready === true` уже при получении exclusive lease и не выдаёт lease при false.
  После lease host программно прогревает фиксированный путь и ждёт готовности renderer/client
  resource owners и assets (очереди idle, без terminal errors, стабильное окно 2 с и минимум 3
  наблюдения). Визуально проверьте terrain, модели и текстуры как предварительную проверку, но она
  не заменяет readiness barriers. Не меняйте вручную сцену, камеру или настройки после захвата;
  assets host прогревает сам.

## Команды DevTools

Benchmark-модули загружаются после подключения формы логина, чтобы диагностический граф не
задерживал вход. Перед первой командой один раз дождитесь их готовности:

```js
await webclientBenchmarksReady
```

Первое чтение/ожидание этого promise по требованию загружает benchmark chunks; обычный login и
gameplay их не скачивают. После завершения публичный объект — `webclientFormalRenderBenchmark`.

1. Захватите кандидата для выбранной сцены:

   ```js
   await webclientFormalRenderBenchmark.captureCandidate("goldshire-exterior")
   // или: await webclientFormalRenderBenchmark.captureCandidate("stormwind")
   ```

   `captureCandidate()` возвращает полный candidate с полями `snapshot`, `snapshotHash`,
   `frameOrderHash`, `scenario`, `issues` и `formalGateEligible: false`; в `snapshot.frames`
   ровно 5400 кадров. Проверьте `issues`: кроме ожидаемого `fixture pending approval`, любая
   проблема делает candidate неприменимым для `runCandidate()`. После захвата можно повторно
   посмотреть состояние:

   ```js
   webclientFormalRenderBenchmark.status()
   ```

   `status()` возвращает объект со `state` (`idle`, `capturing`, `running`, `complete`, `error` или
   `aborted`) и, когда есть, `mode`, `stage`, `error`. Успешный захват заканчивается `idle`; во
   время `runCandidate()` будет `running` с `mode: "candidate"`, после завершения — `complete`.

2. Запустите только диагностический прогон:

   ```js
   await webclientFormalRenderBenchmark.runCandidate()
   ```

   Возвращаемый diagnostic suite содержит `formalGateEligible: false`, `identity`, 10 `records` и
   `report`; он не может выдать formal evidence. Это **10 прогонов по 90 секунд** в точном порядке
   **A B B A A B B A A B** (то есть `ABBAABBAAB`). Чистое измерительное время — 15 минут, но
   фактическое время дольше из-за prewarm и readiness barriers между прогонами. A и B — варианты
   одного сравнения: только `settings.characterAtlasAnisotropy` равен соответственно `false` и
   `true`; остальные условия фиксированы. Во время прогона `status()` показывает `running`; не
   перезагружайте страницу и
   не трогайте настройки. При необходимости остановите активный прогон:

   ```js
   webclientFormalRenderBenchmark.abort()
   ```

3. Получите сохранённые в памяти объекты:

   ```js
   webclientFormalRenderBenchmark.lastCandidate()
   webclientFormalRenderBenchmark.lastResult()
   ```

   `lastCandidate()` возвращает последний сохранённый в памяти candidate или `undefined`.
   `lastResult()` возвращает последний успешно завершённый diagnostic/approved result или
   `undefined`; перед новым захватом/запуском результат очищается.

## Статус и передача root

Оба coordinate-сценария сейчас имеют `fixtureStatus: "pending"`. Поэтому `runCandidate()` — это
только diagnostic: даже наличие `snapshotHash` и `frameOrderHash` не означает pinning. Не вызывайте
`runApproved()` и не называйте этот результат formal, пока fixture-хэши не будут проверены и
закреплены.

Для pinning пришлите root-агенту **весь объект**, который возвращает:

```js
webclientFormalRenderBenchmark.lastCandidate()
```

Передайте все поля (`snapshot`, оба hash, `scenario`, `issues`, `formalGateEligible`), а не только
хэши. Сделайте это через консоль DevTools; не придумывайте и не используйте auto-download,
localStorage, файлы или иную persistence.
