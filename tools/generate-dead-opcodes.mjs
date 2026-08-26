import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Writes an ignored local protocol report: every inbound opcode this core declares and never
 * builds, with the reason its family exists at all.
 *
 * The plan's slice P9 asks for this list explicitly, and asks for it to be *justified* rather than
 * merely enumerated. The justification has two halves and only one of them is a judgement call.
 *
 * The mechanical half is the same sentence for all of them, and it is what `tools/generate-
 * protocol.mjs` measured: the opcode is declared in `Opcodes.h`, dispatched in `Opcodes.cpp`, and
 * named by no other file in the 1400-odd sources of this core. Nothing in this build can construct
 * it, so no client of this build can receive it. That is a fact about the source, re-derived on
 * every run, and it is why this file is generated rather than written.
 *
 * The judgement half is the grouping: which feature each opcode belonged to, and why that feature
 * is absent. Those are the `FAMILIES` below, and every dead opcode must match exactly one of them
 * — an opcode that matches none fails the run rather than landing in a silent "other" bucket.
 * That is the whole point of doing it this way: a core upgrade that adds a dead opcode nobody has
 * thought about stops the build instead of quietly enlarging a list nobody reads.
 */

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const protocolDataDir = join(projectRoot, "src", "generated", "protocol-data");
const coveragePath = join(protocolDataDir, "opcodeCoverage.ts");
const outputPath = join(protocolDataDir, "dead-opcodes.md");
const checkOnly = process.argv.includes("--check");

/**
 * Ordered: the first family that matches an opcode claims it, so the narrow patterns come before
 * the broad ones. Each `why` is one paragraph and is the reason the *family* is dead, not a
 * restatement of the mechanical fact above.
 */
const SILENT = new Set([
  "SMSG_AUCTION_REMOVED_NOTIFICATION",
  "SMSG_CAMERA_SHAKE",
  "SMSG_DYNAMIC_DROP_ROLL_RESULT",
  "SMSG_GAMEOBJECT_RESET_STATE",
  "SMSG_GHOSTEE_GONE",
  "SMSG_LOOT_ITEM_NOTIFY",
  "SMSG_LOOT_SLOT_CHANGED",
  "SMSG_OPEN_CONTAINER",
  "SMSG_PLAYER_SKINNED",
  "SMSG_QUERY_OBJECT_POSITION",
  "SMSG_QUERY_OBJECT_ROTATION",
  "SMSG_ZONE_MAP",
]);

const FAMILIES = [
  {
    title: "Голосовой чат",
    match: (name) => /VOICE|COMSAT|ECHO_PARTY_SQUELCH/.test(name),
    why: "Встроенный голосовой чат Blizzard: клиент 3.3.5 умеет его целиком, сервер — ни в одной "
      + "строке. TrinityCore никогда не реализовывал ни голосовой сервер (comsat), ни сессии, ни "
      + "заглушение участника. Опкоды объявлены, чтобы номера совпадали с клиентскими, и только.",
  },
  {
    title: "Наблюдение за ареной",
    match: (name) => name.includes("COMMENTATOR"),
    why: "Режим комментатора: отдельный клиент, который смотрит арену со стороны и получает "
      + "позиции и здоровье обеих команд. Он существовал только в турнирных сборках Blizzard, и "
      + "серверная половина в открытые исходники не попадала.",
  },
  {
    title: "Танцевальная студия",
    match: (name) => name.includes("DANCE"),
    why: "Dance Studio из 3.x: игрок сочинял танец из движений и сохранял его. Функция была "
      + "показана, отложена и вырезана; в клиенте от неё остались опкоды и пустые окна, в ядре — "
      + "ничего.",
  },
  {
    title: "Мини-игры",
    match: (name) => name.includes("MINIGAME"),
    why: "Каркас мини-игр (шахматы в Каражане — единственное, что до него добралось). Ядро водит "
      + "фигуры обычными юнитами и заклинаниями, так что протокол мини-игры ему не нужен.",
  },
  {
    title: "Объявлено устаревшим самим клиентом",
    match: (name) => name.includes("OBSOLETE") || name === "SMSG_GOGOGO_OBSOLETE" || name === "SMSG_LOTTERY_RESULT_OBSOLETE",
    why: "Имя опкода само говорит, что он мёртв: Blizzard оставила номер занятым, чтобы не "
      + "сдвинуть таблицу, и перестала его отправлять. Ядро следует за клиентом.",
  },
  {
    title: "Отладка, читы и инструменты ГМ",
    match: (name) => /CHEAT|DEBUG|GODMODE|DBLOOKUP|DUMP_OBJECTS|FORCEACTIONSHOW|FORCE_DISPLAY_UPDATE|FORCE_SEND_QUEUED_PACKETS|GAMESPEED_SET|GAMETIME|CHECK_FOR_BOTS|AFK_MONITOR|EXPECTED_SPAM_RECORDS|SERVER_BUCK_DATA|TEST_DROP_RATE|DAMAGE_CALC_LOG|SEND_ALL_COMBAT_LOG|DEBUGAURAPROC|SCRIPT_MESSAGE|PROFILEDATA|CHARACTER_PROFILE|SERVER_INFO_RESPONSE|SERVERINFO|GM_PLAYER_INFO|CHEAT_PLAYER_LOOKUP|FORCE_ANIM|SUSPEND_COMMS|SERVERTIME/.test(name),
    why: "Инструменты разработчика и ГМ: сдвинуть время, выключить откаты, выгрузить объекты, "
      + "посмотреть чужой профиль. Ядро делает то же самое чат-командами через `.` — они не "
      + "требуют ни одного опкода, потому что ответ приходит обычным системным сообщением.",
  },
  {
    title: "Отброшено ядром в пользу полей обновления",
    match: (name) => /HEALTH_UPDATE|SET_FACTION_ATWAR|PET_MODE|PET_RENAMEABLE|FORCE_SET_VEHICLE_REC_ID|INSPECT_RESULTS_UPDATE|RESET_RANGED_COMBAT_TIMER|SPELL_UPDATE_CHAIN_TARGETS/.test(name),
    why: "То же самое ядро сообщает полями обновления объекта, а не отдельным пакетом. Клиент "
      + "принял бы и то и другое; ядро выбрало одно, и второе осталось объявленным.",
  },
  {
    title: "Пакетные и сжатые формы, которые ядро не собирает",
    match: (name) => /MULTIPLE_PACKETS|COMPRESSED_MOVES|ITEM_QUERY_MULTIPLE_RESPONSE|FORCE_SEND|SERVER_BUCK/.test(name),
    why: "Оптимизации трафика: несколько пакетов в одном, сжатая пачка движений, ответ сразу на "
      + "несколько предметов. Ядро всегда шлёт по одному — заметно проще и заметно медленнее, но "
      + "это его выбор, а не отсутствие возможности.",
  },
  {
    title: "Battle.net и учётные записи",
    match: (name) => /AUTH_SRP6|REDIRECT_CLIENT|INVALID_PROMOTION_CODE|REFER_A_FRIEND|KICK_REASON|CHARACTER_LOGIN_FAILED|PLAY_TIME_WARNING|TOGGLE_XP_GAIN|RWHOIS/.test(name),
    why: "Плумбинг учётной записи: переадресация на другой мир, промокоды, «пригласи друга», "
      + "родительский контроль игрового времени. Часть этого в 3.3.5 живёт на сервере "
      + "аутентификации, часть не жила нигде.",
  },
  {
    title: "Звук, который ядро не проигрывает",
    match: (name) => name === "SMSG_PET_DISMISS_SOUND",
    why: "Звук отпускаемого питомца. Соседний `SMSG_PET_ACTION_SOUND` ядро шлёт — примерно раз на "
      + "десять команд призванному питомцу, — а этот не шлёт никогда: роспуск озвучивается "
      + "визуальным эффектом самого заклинания.",
  },
  {
    title: "Боевой лог, которого клиент не показывает",
    match: (name) => /AURACASTLOG|RESISTLOG|SPELLBREAKLOG|SPELL_CHANCE|COMBAT_EVENT_FAILED|NOTIFY_DEST_LOC_SPELL_CAST|RESUME_CAST_BAR/.test(name),
    why: "Подробный боевой лог времён ванильной версии: отдельные пакеты на сопротивление, на "
      + "срабатывание эффекта, на прерывание. К 3.3.5 всё это уехало в `SMSG_SPELLLOGEXECUTE` и "
      + "`SMSG_SPELLNONMELEEDAMAGELOG`, которые ядро шлёт и которые закрыты срезом П1.",
  },
  {
    title: "Очереди PvP: ядро ведёт их одним опкодом",
    match: (name) => /JOINED_BATTLEGROUND_QUEUE|REMOVED_FROM_PVP_QUEUE|BATTLEGROUND_INFO_THROTTLED|BATTLEFIELD_PORT_DENIED|PVP_QUEUE_STATS|REPORT_PVP_AFK_RESULT|BATTLEFIELD_MGR_EJECT_PENDING|BATTLEFIELD_MGR_STATE_CHANGE|ARENA_TEAM_CHANGE_FAILED/.test(name),
    why: "Специализированные уведомления очереди — «вы встали», «вас убрали», «слишком часто "
      + "спрашиваете». Ядро ведёт всю очередь одним `SMSG_BATTLEFIELD_STATUS` (срез П7), включая "
      + "выход из неё, и ни одного из этих вариантов не строит.",
  },
  {
    title: "Поиск группы до 3.3",
    match: (name) => /UPDATE_LFG_LIST|OPEN_LFG_DUNGEON_FINDER/.test(name),
    why: "Ручной список «ищу группу» из более ранних версий. Его заменил подземный искатель, "
      + "закрытый срезом П5, и старый список ядро не поддерживает.",
  },
  {
    title: "Тикеты ГМ: ветки, которых у ядра нет",
    match: (name) => /GMRESPONSE_CREATE_TICKET|GMRESPONSE_DB_ERROR|GM_TICKET_STATUS_UPDATE|GMTICKETSYSTEM_TOGGLE/.test(name),
    why: "Оставшиеся ветки системы тикетов: создание от лица ГМ, ошибка базы, смена состояния "
      + "чужого тикета. Ядро отвечает игроку пятью опкодами (срез П8) и остальными не пользуется. "
      + "`CMSG_GMTICKETSYSTEM_TOGGLE` — при этом единственный опкод во всём протоколе, объявленный "
      + "серверным под именем `CMSG_`: имя ошибочно, направление настоящее.",
  },
  {
    title: "Отказы, которые ядро заменяет строкой в чат",
    match: (name) => /_ERROR|_FAILED|_DENIED|_THROTTLED|NOT_IN_PARTY|NPC_WONT_TALK|PLAYERBINDERROR|BINDZONEREPLY|DISMOUNTRESULT|GROUP_CANCEL|GUILD_DECLINE|SUMMON_CANCEL|PET_BROKEN|PET_UNLEARN_CONFIRM|QUEST_FORCE_REMOVE|QUESTUPDATE_FAILED|CHANGEPLAYER_DIFFICULTY_RESULT|CHARACTER_PROFILE_REALM_CONNECTED/.test(name),
    why: "Отказы, у которых в клиенте есть своё окно или своя строка: «вы не в группе», «этот NPC "
      + "с вами не говорит», «привязка не удалась». Ядро почти везде отвечает системным "
      + "сообщением в чат — оно короче в написании и одинаково для всех отказов сразу.",
  },
  {
    // Named one by one on purpose. A `() => true` here would make this the bucket every future
    // dead opcode silently falls into, and the whole value of this file is that it cannot happen.
    title: "Уточнения, о которых ядро молчит",
    match: (name) => SILENT.has(name),
    why: "Последняя группа, и признак у неё отрицательный: ядро просто не сообщает об этом ничего "
      + "и полагается на то, что клиент увидит результат в полях обновления или в следующем "
      + "пакете. Тряска камеры, открытие контейнера, «с трупа сняли шкуру», поворот объекта по "
      + "запросу, карта зоны — всё это клиент 3.3.5 умеет и ни разу не получает.",
  },
];

function parseCoverage(source) {
  const inbound = new Map();
  const body = source.slice(source.indexOf("INBOUND_OPCODES"));
  for (const match of body.matchAll(/\["([A-Z_0-9]+)",\s*"(live|dead)"\]/g)) {
    if (!inbound.has(match[1])) inbound.set(match[1], match[2]);
  }
  if (inbound.size < 600) throw new Error(`Only ${inbound.size} inbound opcodes parsed from opcodeCoverage.ts`);
  return inbound;
}

function classify(dead) {
  const grouped = FAMILIES.map((family) => ({ ...family, opcodes: [] }));
  const unmatched = [];
  for (const name of dead) {
    const family = grouped.find((candidate) => candidate.match(name));
    if (family) family.opcodes.push(name);
    else unmatched.push(name);
  }
  if (unmatched.length > 0) {
    throw new Error(
      `${unmatched.length} dead opcodes belong to no family in tools/generate-dead-opcodes.mjs:\n  ${unmatched.join("\n  ")}`,
    );
  }
  return grouped.filter((family) => family.opcodes.length > 0);
}

function render(grouped, total, liveCount) {
  const sections = grouped.map((family) => {
    const list = family.opcodes.map((name) => `* \`${name}\``).join("\n");
    return `## ${family.title} (${family.opcodes.length})\n\n${family.why}\n\n${list}\n`;
  }).join("\n");

  return `# Мёртвые входящие опкоды

Создаётся `+ "`tools/generate-dead-opcodes.mjs`" + `. Не редактировать руками — правьте таблицу семейств в самом генераторе.

Это явный список того, чего клиент **не** обрабатывает, и почему это не работа, а факт об этой
сборке ядра.

Всего объявлено входящих: **${total + liveCount}**. Живых: **${liveCount}** — все обработаны.
Мёртвых: **${total}**.

Обоснование у всех мёртвых одно и то же, и оно измеряется заново на каждом запуске
\`npm run protocol:generate\`: опкод объявлен в \`Opcodes.h\`, диспетчеризован в \`Opcodes.cpp\` и
**не назван больше нигде** — ни в одном из примерно 1400 исходников ядра вне этих двух файлов.
Значит, эта сборка не может его собрать, а клиент этой сборки — получить.

Обратное неверно и стоило нам целого семейства: «сервер не принимает опкод от клиента» не значит
«сервер его не отправляет». Двадцать два \`MSG_\` объявлены \`Handle_NULL\` и всё равно строятся
ядром; отчёт читал отказ как отсутствие и не видел их. Поэтому признак смерти здесь — отсутствие
ссылки, а не статус обработчика.

Ловушка ровно одна, и она в другую сторону: скан ищет имя по \`.cpp\` и \`.h\` и **не отличает
комментарий от кода**. Закомментированное упоминание делает опкод «живым». Так вышло с
\`SMSG_PET_GUIDS\` и с четырьмя из семейства \`MSG_MOVE_*\` — они названы в клиенте и не разбираются,
потому что разбирать нечего. Смещение сознательное: ложное «живо» стоит одной строки реестра,
ложное «мертво» — игрока, застывшего на месте у соседей на экране.

Ниже — разбивка по семействам. Каждое семейство объясняет, зачем опкод вообще существует и почему
его здесь нет. Опкод, не попавший ни в одно семейство, роняет генератор: список, в который можно
что-то тихо добавить, никто не читает.

${sections}`;
}

const coverage = parseCoverage(await readFile(coveragePath, "utf8"));
const dead = [...coverage].filter(([, kind]) => kind === "dead").map(([name]) => name).sort();
const liveCount = coverage.size - dead.length;
const document = render(classify(dead), dead.length, liveCount);

if (checkOnly) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== document) {
    throw new Error("The ignored protocol-data/dead-opcodes.md report is stale; run npm run deadopcodes:generate");
  }
  console.log(`Checked ${dead.length} dead opcodes across ${FAMILIES.length} families.`);
} else {
  await writeFile(outputPath, document, "utf8");
  console.log(`Wrote ${dead.length} dead opcodes across ${FAMILIES.length} families to ignored protocol-data/dead-opcodes.md.`);
}
