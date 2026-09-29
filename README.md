# TSWoW WebClient

Клиент WoW 3.3.5a (build 12340) для TSWoW/TrinityCore. Игра одна, способов запустить её несколько:

- **веб-версия** — страница в браузере;
- **Electron-версия** — та же страница в отдельном окне, чьи процессы закреплены за
  производительными ядрами и не притормаживаются в фоне;
- **для других игроков** — ваш компьютер раздаёт игру по сети, а игроки открывают ссылку или
  запускают присланное приложение.

Код игры у всех вариантов общий (`src/`).

## Что запускать

| Задача | Что нажать | Что получится |
| --- | --- | --- |
| Разработка в браузере | `web\start-dev.bat` | поднимет шлюз и Vite, откроет http://127.0.0.1:5173/ |
| Разработка в Electron | `electron\start-dev.bat` | поднимет шлюз и Vite, откроет окно Electron |
| Играть на этой машине | `electron\build.bat`, затем `electron\start-built.bat` | `dist\electron\WoWWebClient.exe`, шлюз запускает сам |
| Проверить собранную веб-версию | `web\build.bat`, затем `web\start-built.bat` | `dist\web` на http://127.0.0.1:5173/ |
| Приложение для игроков | `online\build-player.bat` | `dist\player\WoWWebClient.zip` — его и отправлять |
| Проверить связку для игроков у себя | `online\test-local.bat` | тот же сервер только на `127.0.0.1` и то же приложение против него |
| Пустить других игроков | `online\start-server.bat` | ссылка `http://<PUBLIC_HOST>:8091/` |

Лаунчеры разработки запускают только то, чего не хватает, каждое в своём окне. Уже работающие
шлюз и Vite используются как есть.

## Папки

| Папка | Что там |
| --- | --- |
| [`web/`](web/) | веб-версия: разработка, сборка, запуск собранной |
| [`electron/`](electron/) | Electron-версия: код оболочки, разработка, сборка, запуск собранной |
| [`online/`](online/) | для других игроков: раздача с этой машины и сборка приложения для них |
| корень | общее для всех: `start-gateway.bat`, `restart-gateway.bat`, `build-assets.bat` |

## Шлюз

Без шлюза страница остаётся чёрной: экран входа берёт файлы клиента через него. Шлюз соединяет
страницу с authserver/worldserver и отдаёт ресурсы из клиента и dataset.

- `start-gateway.bat` — собрать и запустить шлюз. Лаунчеры разработки делают это сами.
- `restart-gateway.bat` — перезапустить шлюз после сборки TSWoW. Пересоберёт, если менялся `src/`.
- Собранный `WoWWebClient.exe` запускает шлюз сам и останавливает его при закрытии окна.
- `online\start-server.bat` запускает шлюз, открытый для других игроков. Через него же работает
  и разработка на этой машине.

## Как это устроено

```text
Браузер или окно Electron
   │  страница: Vite :5173 (разработка), dist/web :5173 (собранная), dist/web :8091 (для игроков)
   │  WebSocket /auth и /world, HTTP-ресурсы
   ▼
Шлюз :8090 (src/gateway → dist/code) ──> authserver :3724, worldserver :8085
   └─> DBC/карты TSWoW, MPQ клиента, локальные кеши data/
```

Страницу на `127.0.0.1:5173` одновременно раздаёт что-то одно: Vite, собранная веб-версия или
собранная Electron-версия. Шлюз принимает страницу только с адресов из `ALLOWED_ORIGINS`;
`online\start-server.bat` добавляет туда адрес для игроков сам.

## Где что лежит

| Путь | Что там |
| --- | --- |
| `src/browser/` | страница: рендер мира, интерфейс, ввод |
| `src/gateway/`, `src/auth/`, `src/transport/`, `src/protocol/`, `src/world/` | шлюз, авторизация, протокол, состояние мира |
| `src/generated/` | сгенерированные таблицы (протокол, DBC, строки) |
| `index.html`, `glue.html`, `framexml.html`, `character-lab.html` | страницы — точки входа Vite (`vite.config.mjs`) |
| `tools/` | генераторы, извлечение ресурсов, запуск шлюза (`start-gateway.mjs`) и раздачи (`start-server.mjs`), проверки |
| `tests/` | Node-тесты |
| `bench/` | бенчмарк производительности |
| `docs/` | планы и отчёты: паритет, производительность, раздача другим игрокам |
| `public/`, `data/` | статика страницы и локальные кеши ресурсов из клиента (не в git) |
| `dist/` | сборки: `web/`, `code/` (шлюз), `electron/`, `player/` (не в git) |

## Первый запуск

1. Node.js 22+ — системный или встроенный `.runtime\node` (bat-файлы находят его сами).
2. `npm install` в корне; для Electron-версии и приложения игроков — ещё `npm install` в `electron/`.
3. Скопировать `.env.example` в `.env` и указать пути к клиенту, TSWoW и TrinityCore;
   `npm run doctor` проверит настройки. Для раздачи другим игрокам — ещё `PUBLIC_HOST`.
4. Один раз `build-assets.bat` — извлечь иконки и метаданные из клиента.

`dist\web` и `dist\electron` содержат данные из вашего клиента — это локальные сборки. Игрокам
отправляется только `dist\player\WoWWebClient.zip`: в нём нет ничего из клиента WoW.

## Команды npm

| Команда | То же, что |
| --- | --- |
| `npm run dev` | Vite из `web\start-dev.bat` (без запуска шлюза) |
| `npm run build` | `web\build.bat` |
| `npm run preview` | `web\start-built.bat` |
| `npm run electron` | окно из `electron\start-dev.bat` (без запуска шлюза и Vite) |
| `npm run electron:build` | `electron\build.bat` |
| `npm run gateway` | `start-gateway.bat` |
| `npm run server` | `online\start-server.bat` (без остановки локального шлюза и пересборки) |
| `npm run player:build` | `online\build-player.bat` |
| `npm run test:source` | все Node-тесты по текущим исходникам |
| `npm run bench` | бенчмарк, см. `bench/README.md` |
