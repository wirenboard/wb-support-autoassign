# wb-support-autoassign — контейнер для Portainer.
# Гоняет autoassign.mjs по расписанию внутри контейнера (см. CMD).
FROM node:22-alpine

WORKDIR /app

# Зависимости отдельным слоем — только рантайм (yaml)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Код и конфиг (секретов тут нет; ключи приходят через env во время запуска)
COPY lib ./lib
COPY autoassign.mjs routing.yaml ./

# Рантайм-состояние (state.json, spam-review.jsonl) — на volume
RUN mkdir -p /app/data
ENV NODE_ENV=production

# Один проход каждые INTERVAL_SECONDS (по умолчанию 15 мин).
# autoassign сам проверяет рабочее время и быстро выходит вне 10–18 МСК.
CMD ["sh", "-c", "while true; do node autoassign.mjs || true; sleep \"${INTERVAL_SECONDS:-900}\"; done"]
