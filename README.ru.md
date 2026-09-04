<div align="center">
  <img src="public/favicon.svg" width="96" height="96" alt="Логотип TSWoW WebClient">
  <h1>TSWoW WebClient</h1>
  <p>Учебный браузерный клиент и исследование совместимости с TSWoW/TrinityCore World of Warcraft 3.3.5a.</p>
  <p><strong>TypeScript · Three.js · WebGL · Node.js · WebSocket</strong></p>
</div>

[![CI](https://github.com/MrGreenCheezz/tswow-web-client/actions/workflows/ci.yml/badge.svg)](https://github.com/MrGreenCheezz/tswow-web-client/actions/workflows/ci.yml)

> [!IMPORTANT]
> Это экспериментальный учебный проект, а не готовая замена официальному клиенту. Он рассчитан на
> WoW 3.3.5a build 12340 и читает только данные TSWoW и легально полученные файлы оригинального
> клиента, которые каждый пользователь указывает на своей машине. Репозиторий не распространяет
> MPQ, DBC, FrameXML, generated-таблицы локализованных строк, извлечённые ассеты или другие файлы
> World of Warcraft.
> Распространяйте только tracked source tree. Локальный `dist/` может включать client-derived
> данные и **не** является разрешённым к распространению или публичному хостингу артефактом.

[English version](README.md)

## Что уже работает

- SRP6-авторизация, список реалмов и персонажей, создание персонажа и вход в мир.
- Обновления объектов, движение, коллизии, физика, плавание, транспорт, такси и маунты.
- Выбор цели, автоатака, заклинания, ауры, combat log, лут, инвентарь и подсказки предметов.
- Квесты, gossip, торговцы, тренеры, группы, гильдии, почта, аукцион и социальные окна.
- Мир на Three.js: ADT-ландшафт, M2/WMO, doodad-объекты, анимации и частицы.
- Серверное освещение, погода, вода, туман MFOG внутри зданий, звуки и эффекты окружения.
- Извлечение ассетов из локальных MPQ по запросу с дисковым кешем и source stamps.
- Окна из модулей TSWoW, custom packets и диагностическая панель.

Проект активно развивается. Перед развёртыванием прочитайте [ограничения](#ограничения).

## Архитектура

```text
Браузер / Vite :5173
  ├─ WebSocket /auth и /world ──> Node gateway :8090 ──> authserver :3724
  │                                                   └─> worldserver :8085
  └─ HTTP metadata и assets ────> Node gateway
                                    ├─> TSWoW dbc/maps/vmaps
                                    ├─> локальные WoW 3.3.5a Data/MPQ
                                    └─> игнорируемые кеши data/ и public/
```

Браузер не подключается напрямую к TCP-сокетам TrinityCore. Node gateway переводит их в WebSocket
и отдаёт метаданные, коллизии, модели, текстуры и сгенерированные ассеты.

## Требования

| Задача | Что требуется |
| --- | --- |
| Собрать или протестировать исходники | Node.js 22+, npm 10+ и исходники соответствующего TSWoW TrinityCore |
| Запустить gateway | Собранные каталоги TSWoW `dbc`, `maps`, `vmaps` |
| Войти в игру | Совместимые запущенные authserver и worldserver |
| Отрисовывать/извлекать все ассеты | Легально полученный клиент WoW 3.3.5a build 12340 |
| Создать gameplay client-таблицы | Соответствующие dataset, исходники TrinityCore и оригинальный клиент |
| Заранее построить DB metadata | World DB, `worldserver.conf` и MySQL CLI |

Сейчас полностью проверяется Windows 10/11. Значительная часть инструментов кроссплатформенная, но
полный TSWoW asset workflow и работа на регистрозависимой файловой системе пока не подтверждены для
Linux/macOS.

TSWoW может продолжать работать на своём старом Node: его `start.bat` запускает встроенный
`bin/node/node.exe`, а не Node из системного `PATH`. Для параллельной установки распакуйте portable
Node.js 22 x64 в `.runtime/node/` или задайте `WEBCLIENT_NODE_DIR`. `start-gateway.bat` и
`start-web.bat` сначала ищут этот runtime и меняют `PATH` только внутри своих процессов; каталог
`.runtime/` игнорируется Git и никогда не должен публиковаться.

## Быстрый запуск

1. Клонируйте репозиторий и установите зафиксированные зависимости:

   ```powershell
   git clone https://github.com/MrGreenCheezz/tswow-web-client.git
   cd tswow-web-client
   npm ci
   ```

2. Создайте локальный конфиг:

   ```powershell
   Copy-Item .env.example .env
   ```

   Откройте `.env` и укажите `CLIENT_DIR`, `TRINITYCORE_DIR`, а также `TSWOW_INSTALL` или
   `TSWOW_DATASET`. В Windows можно использовать прямые слеши.

3. Создайте локальные protocol/client-таблицы, проверьте пути и соберите проект:

   ```powershell
   npm run client-data:generate
   npm run doctor
   npm run build
   ```

   Protocol metadata создаётся из настроенных исходников TSWoW TrinityCore в ignored-каталоге
   `src/generated/protocol-data/`. Если client-derived таблиц нет, build-команды создают для CI и
   изучения исходников нейтральные заглушки без значений клиента. Для входа в игру они намеренно
   непригодны — gateway требует локальные реализации, созданные `npm run client-data:generate` из
   файлов пользователя.

   Gameplay-сборка остаётся локальной, потому что browser bundle может включать эти generated
   таблицы. Не публикуйте и не загружайте `dist/`; публиковать следует только source repository.

4. Запустите совместимые authserver и worldserver. Затем откройте два терминала в репозитории:

   ```powershell
   # Терминал 1
   npm run gateway

   # Терминал 2
   npm run dev
   ```

5. Откройте [http://127.0.0.1:5173](http://127.0.0.1:5173). Проверка процесса gateway доступна по
   адресу [http://127.0.0.1:8090/health](http://127.0.0.1:8090/health).

Большинство визуальных ассетов gateway создаёт при первом запросе. Чтобы уменьшить задержки первого
входа, после настройки доступа к БД можно один раз запустить `build-assets.bat`. Это необязательный
долгий прогрев; его результаты остаются в игнорируемых локальных кешах.

При каждом обычном запуске gateway (когда `VISUAL_DBC_DIR` не задан явно) девять client-media DBC
автоматически извлекаются из активной цепочки `CLIENT_DIR` в неизменяемое content-addressed поколение
внутри `data/visual-dbc`; gateway выбирает его только после полной записи всех таблиц, меток и профиля.
Поэтому одинаково поддерживаются classic, HD и патчи с любыми буквами: значение имеет победивший
ресурс, а не имя архива. `.src`-метки не позволяют соединить модель одного поколения с таблицами
другого. DBC-файлы из явно заданного `VISUAL_DBC_DIR` считаются доверенными, поэтому такой каталог
по-прежнему нужно синхронизировать вручную командой `npm run assets:visual-dbc`.

Новый набор патчей применяйте как оригинальный клиент: публикуйте весь связанный комплект, затем
перезапускайте gateway и перезагружайте страницу. Например, текущий HD-комплект `W/X/Y/Z` нельзя
включать или отключать по одному архиву — без `W` модели существ из `X/Y` и baked-текстуры из `Z`
всё ещё остаются активными и уже не образуют classic-профиль.

Аддонный runtime использует ту же победившую цепочку при обычном входе. Сохраняются и
в авторском порядке исполняются generated-блоки `tsaddon-begin-lib` /
`tsaddon-begin:<module>` из активного `FrameXML.toc`; для них доступен совместимый с TSWoW ABI
custom-пакетов `_CLIENT_NETWORK`. Если патч заменил стандартный toggle (например окно талантов на
`N`) и его root корректно отрисовался, маршрут принадлежит этому окну; при отсутствии или ошибке
патча остаётся native fallback браузерного клиента. Публикация патча во время сессии также закрывает
`/client/file` до перезапуска, поэтому поздно загружаемый UI не смешивает два поколения.
Виджеты TSWoW показываются поверх нативного интерфейса; `?framexml=1` дополнительно включает диагностический stock FrameXML HUD.

Цель совместимости — собственные модули TSWoW. `npm run tswow-addons:check` проверяет их
сгенерированный Lua, команды, окна и сценарии custom-пакетов. Прочитанный TOC не считается
доказательством работы аддона. Текущий статус и правила проверки новых модулей:
[совместимость TSWoW-аддонов](TSWOW_ADDON_COMPATIBILITY.ru.md).

### Автономный client pack

Каждый пользователь может один раз собрать локальный снимок из собственной установленной копии:

```powershell
npm run client-pack:dry-run
npm run build:autonomous
$env:CLIENT_PACK_DIR = (Resolve-Path dist/client-pack)
npm run client-pack:verify
npm run gateway
```

Перед копированием `build:autonomous` выполняет сценарии собственных TSWoW-аддонов;
ошибка или модуль без сценария останавливают сборку с причиной. Pack сохраняет `Data`
с исходными MPQ и каталогами `.MPQ`, а также `Interface/AddOns` и `Fonts`. Манифест фиксирует каждый
путь, размер и SHA-256. После сборки gateway и все asset-генераторы
читают `CLIENT_PACK_DIR`, поэтому исходный `CLIENT_DIR` больше не нужен. После установки нового
набора патчей pack нужно собрать заново целиком; существующий pack заменяется только после того,
как новый снимок полностью записан и исходный клиент не изменился во время копирования.

## Настройка

`.env` автоматически читают gateway и инструменты, но Git его не отслеживает. Vite из этого же
файла берёт браузерные переменные с префиксом `VITE_`.

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `CLIENT_DIR` | переносимый поиск рядом с repo | Каталог WoW, содержащий `Data/` |
| `CLIENT_PACK_DIR` | не задан | Автономный локальный снимок клиента; при наличии имеет приоритет над `CLIENT_DIR` |
| `VISUAL_DBC_DIR` | автоопределение stamped `data/visual-dbc` | Явный override visual DBC overlay; считается доверенным |
| `TSWOW_INSTALL` | `../tswow-install` | Инсталляция TSWoW с `modules/` |
| `TSWOW_DATASET` | из TSWoW install | Прямой путь к dataset |
| `TRINITYCORE_DIR` | `../tswow/cores/TrinityCore` | Локальная генерация и проверка protocol/client-таблиц |
| `CLIENT_LOCALE` | `ruRU` | Locale для DBC gateway и генераторов |
| `VITE_CLIENT_LOCALE` | `ruRU` | Locale браузерной авторизации; должен совпадать |
| `GATEWAY_HOST` / `GATEWAY_PORT` | `127.0.0.1` / `8090` | Адрес gateway |
| `ALLOWED_ORIGINS` | локальные адреса Vite | Разрешённые browser origins через запятую |
| `AUTH_HOST` / `AUTH_PORT` | `127.0.0.1` / `3724` | TrinityCore authserver |
| `WORLD_HOST` / `WORLD_PORT` | `127.0.0.1` / `8085` | TrinityCore worldserver |
| `WEB_HOST` / `WEB_PORT` | `127.0.0.1` / `5173` | Dev-сервер Vite |
| `WEB_ALLOWED_HOSTS` | безопасные defaults Vite | DNS-hostnames для LAN-разработки через запятую |
| `VITE_GATEWAY_ORIGIN` | текущий hostname на `:8090` | Публичный HTTP(S) origin/reverse proxy |
| `MODULE_DIRS` | drafts + модули TSWoW | Дополнительные корни module UI |
| `MODULE_UI_WRITE` | `0` | Включает запись module UI только с loopback при `1` |

Остальные override-пути и кеши описаны в [.env.example](.env.example).

## Команды

| Команда | Назначение |
| --- | --- |
| `npm run doctor` | Проверить runtime-пути и вывести недоступные необязательные возможности |
| `npm run dev` | Запустить dev-сервер Vite |
| `npm run gateway` | Пересобрать, проверить локальные данные и запустить gateway |
| `npm run gateway:dev` | Alias для того же rebuild-and-start workflow |
| `npm run build` | Сборка TypeScript + Vite; для protocol generation нужны настроенные core sources |
| `npm test` | Сборка и Node tests; client-data тесты пропускаются без локальных файлов |
| `npm run protocol:generate` | Создать ignored protocol-таблицы из настроенных TSWoW TrinityCore sources |
| `npm run protocol:check` | Сверить ignored protocol-таблицы с настроенными core sources |
| `npm run client-data:prepare` | Создать ignored нейтральные заглушки, если локальных таблиц ещё нет |
| `npm run client-data:generate` | Создать все ignored protocol/gameplay-таблицы из локальных inputs пользователя |
| `npm run client-data:check` | Сверить локальные runtime-таблицы с их настроенными входными файлами |
| `npm run check:generated` | Сверить tracked DBC layouts и ignored local generated data |
| `npm run modules:check` | Проверить module UI и custom message definitions |
| `npm run patches:check` | Сверить dataset TSWoW, активную MPQ-цепочку, сгенерированные TSAddons и манифест нативного updater; завершиться с ошибкой при неполном patch-контракте |
| `npm run client-pack:dry-run` | Посчитать размер автономного pack без копирования файлов |
| `npm run client-pack:build` | Локально собрать `dist/client-pack` из `CLIENT_DIR` без изменения MPQ и loose `.MPQ` |
| `npm run client-pack:verify` | Побайтово проверить автономный pack по SHA-256-манифесту |
| `npm run client-addons:check` | Выполнить все корневые AddOns (включая LoadOnDemand) из выбранного клиента/pack |
| `npm run tswow-addons:check` | Проверить поведение собственных TSWoW-модулей из активного FrameXML.toc; `-- --json` выдаёт отчёт |
| `npm run build:autonomous` | Собрать web bundle, проверить TSWoW-аддоны и затем собрать автономный client pack |
| `npm run build:full` | Полная проверка настроенного workspace и сборка |
| `npm run assets:visual-dbc` | Заново извлечь visual DBC и привязать `.src`-метки к текущему client pack |
| `npm run assets:restamp` | Обновить source stamps без перегенерации кешей |

Дополнительные команды `assets:*` и `*:generate` перечислены в [package.json](package.json).
Data-free facades, генераторы и redistributable DBC layouts отслеживаются Git. Protocol-таблицы,
client-derived реализации и generated assets остаются локальными и ignored.

Инструкция для ручной проверки formal render benchmark: [FORMAL_BENCHMARK_GUIDE.ru.md](FORMAL_BENCHMARK_GUIDE.ru.md).

## Безопасность и публикация

Gateway — неаутентифицированный мост к authserver/worldserver и к тяжёлым локальным asset routes.
Проверка `Origin` — политика браузера, а не полноценная авторизация.

- Оставляйте порт 8090 на loopback и не открывайте его напрямую в Интернет.
- Для LAN явно задайте `GATEWAY_HOST`, `WEB_HOST`, точный `ALLOWED_ORIGINS`, а при DNS-имени страницы
  ещё и `WEB_ALLOWED_HOSTS`.
- Если `GATEWAY_PORT` отличается от 8090, укажите тот же порт в `VITE_GATEWAY_ORIGIN`.
- Публичный хостинг `dist/web` или gateway этим учебным релизом не поддерживается. Data-equipped
  build output остаётся локальным и может содержать generated client-таблицы.
- Не включайте `MODULE_UI_WRITE`, если не редактируете модуль с этой же машины.
- Не коммитьте `.env`, `.npmrc`, дампы БД, ключи, сертификаты и игровые данные.
- `dist/client-pack` создаётся только локально из файлов самого пользователя. Не публикуйте и не
  передавайте этот каталог; наличие оригинального клиента у другого пользователя само по себе не
  превращает копирование игровых файлов в разрешённое распространение.

Порядок сообщения об уязвимостях описан в [SECURITY.md](SECURITY.md).

## Игровые данные и лицензии

MPQ, DBC/SQL-дампы, FrameXML, generated-таблицы локализованных строк, извлечённые
текстуры/модели/звуки и runtime-кеши намеренно исключены. Client-derived TypeScript-реализации
создаются только в ignored-каталоге `src/generated/client-data/` из локальных файлов пользователя.
Protocol-таблицы аналогично создаются из соответствующего локального checkout TSWoW TrinityCore в
ignored `src/generated/protocol-data/`. Tracked facade-файлы не содержат значений этих таблиц.

Локальный browser bundle после client-data generation может включать эти generated-таблицы.
Поэтому `dist/` игнорируется Git, получает local-only предупреждение при сборке и не должен
распространяться или размещаться публично. Публичным артефактом является только tracked source tree.

Оставшиеся tracked DBC definitions/layouts получены из открытого upstream-проекта на его собственных
условиях; они не выдаются за оригинальный MIT-код проекта.

Оригинальный код проекта доступен по MIT. Определения WoWDBDefs и производные layouts остаются под
CC BY-SA 4.0, а перечисленные Wowee-influenced участки — под upstream notice с запретом использования
в коммерческом игровом продукте. TrinityCore protocol output и client-derived data создаются только
локально и не распространяются. Поэтому это учебный mixed-license source tree, а не пакет под одной
MIT-лицензией. Подробности: [tools/dbd/README.md](tools/dbd/README.md), [NOTICE.md](NOTICE.md),
[LICENSES/WOWEE.txt](LICENSES/WOWEE.txt) и [LICENSE](LICENSE).

World of Warcraft и Blizzard Entertainment — товарные знаки Blizzard Entertainment, Inc. Проект
не связан с Blizzard Entertainment, TrinityCore или TSWoW и не одобрен ими.

## Ограничения

- Поддерживается только экспериментальная связка TSWoW/TrinityCore 3.3.5a build 12340.
- Интерфейс ориентирован на русский; для других locale нужны согласованные client/realm/Vite settings.
- PIN/matrix authentication, Warden и ряд редких protocol/UI paths ещё не реализованы.
- Один gateway работает с одной настроенной парой auth/world backend.
- Первый запрос нового ассета может быть медленным из-за открытия MPQ и построения кеша.
- Публичный/production hosting не поддерживается; data-equipped build output остаётся локальным.

## Участие в разработке

Прочитайте [CONTRIBUTING.md](CONTRIBUTING.md), запускайте `npm test` и не добавляйте client-derived
файлы, generated locale-таблицы, извлечённые ассеты или машинно-зависимые пути. Полный пример
кастомного окна и пакетов находится в
[`examples/module-example/`](examples/module-example/).
