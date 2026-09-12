# Образ сервера приёма оплаты для Tilda.
#
# Контекст сборки — КОРЕНЬ РЕПОЗИТОРИЯ (см. docker-compose.yml, "context: .."),
# а не сам каталог tilda-server: пакет ссылается на @solanapaykz/core записью
# "file:.." в package.json, а npm разрешает такую зависимость СИМЛИНКОМ на
# соседний каталог (node_modules/@solanapaykz/core -> ../../..), а не копией.
# Поэтому оба пакета собираются в одном образе, по одному и тому же пути
# /app, и в финальный образ переносится дерево /app целиком — выборочное
# копирование одних подкаталогов без других оставило бы этот симлинк
# висящим в пустоте.
#
# node:sqlite остаётся экспериментальным в Node 22 и требует явного флага
# (см. src/db.ts) — образ должен совпадать по мажорной версии Node с тем,
# на чём разрабатывался и тестировался сервер (package.json: >=22.5.0).

FROM node:22-alpine AS build
WORKDIR /app

# --- корневой SDK (@solanapaykz/core) ---
COPY package.json package-lock.json tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm install --include=dev
RUN npm run build

# --- tilda-server ---
WORKDIR /app/tilda-server
COPY tilda-server/package.json tilda-server/package-lock.json tilda-server/tsconfig.json ./
COPY tilda-server/src ./src
COPY tilda-server/public ./public
# npm install создаёт node_modules/@solanapaykz/core -> ../../.. только
# после того, как в /app уже лежит package.json корневого пакета (см. выше) —
# порядок шагов этого файла важен.
RUN npm install --include=dev
RUN npm run build

# Урезаем dev-зависимости в обоих пакетах перед переносом в финальный образ —
# компиляторы (tsc, tsup) и vitest самому процессу в бою не нужны.
WORKDIR /app
RUN npm prune --omit=dev
WORKDIR /app/tilda-server
RUN npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app/tilda-server

# Копируем ВЕСЬ /app целиком, а не отдельные подкаталоги — см. комментарий
# в начале файла про симлинк file:.. зависимости.
COPY --from=build /app /app

# Каталог для файла SQLite — существует всегда, даже если docker-compose.yml
# не смонтирует сюда именованный том (например, при разовом запуске без
# compose): node:sqlite не создаёт отсутствующие родительские каталоги сам.
RUN mkdir -p /app/tilda-server/data

# Непривилегированный пользователь — правка финального ревью (задача 5).
# Пользователь не был задан вовсе: процесс работал от root, и любая ошибка
# исполнения (в самом Node, в зависимости, в будущем коде) давала бы
# внутри контейнера полные права ровно там, где смонтированы настройки
# (config.json) и база заказов. `node` — встроенный в официальный образ
# непривилегированный пользователь (uid/gid 1000), отдельно заводить
# своего не нужно.
#
# chown только на data/ — она единственная, куда процесс пишет (файл
# SQLite и его -wal/-shm при WAL, см. src/db.ts). Остальное дерево
# (dist, node_modules, config.json смонтированный read-only) процессу
# достаточно читать, а COPY --from=build уже оставляет файлы
# мирочитаемыми по умолчанию.
#
# Само по себе это не чинит уже существующий на хосте именованный том с
# данными — тот заведён ещё под root и по-прежнему принадлежит root на
# диске хоста; на уже развёрнутом стенде владельца тома нужно поменять
# отдельной командой ПЕРЕД перезапуском с этим образом (см. README.md,
# «Развёртывание» — миграция существующего тома под непривилегированного
# пользователя), иначе процесс не сможет писать в свою же базу.
RUN chown -R node:node /app/tilda-server/data
USER node

# Слушает только на loopback изнутри процесса (см. src/http/server.ts,
# запуститьСервер) — наружу порт открывает docker-compose.yml через
# network_mode: host, поэтому EXPOSE здесь не имеет действия, но остаётся
# как документация того, какой порт вообще слушает процесс по умолчанию.
EXPOSE 8080

CMD ["node", "--experimental-sqlite", "dist/http/server.js"]
