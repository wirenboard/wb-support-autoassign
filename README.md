# wb-support-autoassign

Автораспределение тем портала поддержки (support.wirenboard.com): новая тема →
ИИ-оператор читает её, видит навыки/присутствие/загрузку инженеров и решает,
кому отдать — в рамках жёстких гейтов, зашитых кодом. Пока ИИ не настроен или
ошибся — работает детерминированный мозг на ключевиках.

## Составные части

| Файл | Что это |
|---|---|
| `routing.yaml` | Вся конфигурация: инженеры, навыки (снимок таблицы), домены, пороги, режимы бота |
| `autoassign.mjs` | Бот: query 53 + query 54 → решение → whisper/assign |
| `lib/matcher.mjs` | Общая логика: язык, гейты, классификация ключевиками, выбор |
| `dry-run.mjs` | Прогоны без действий (последние N тем или фид) |
| `debug-one.mjs` | Разбор очков классификации одной темы: `node debug-one.mjs 40544` |
| `deploy/` | systemd user-юниты (таймер каждые 15 мин) |

На портале (Data Explorer): query **53** `autoassign_feed` — неразобранные темы
(публичные + ЛС группы support, без тем от сотрудников), query **54**
`autoassign_presence` — присутствие и загрузка за окно 7 дней.

## Жёсткие гейты (код, не ИИ)

- англоязычные темы — только инженерам из `gates.english` (политика «другим не отвечать»);
- назначаем только тем, кто в сети (`last_seen ≤ 45 мин`) и не `away`;
- навык по домену ≥ 2, иначе фолбэк;
- рабочее время 10–18 МСК по будням; темы моложе 15 мин не трогаем;
- одна тема обрабатывается один раз (`state.json`) — переназначили руками, бот не лезет.

## Режимы (`routing.yaml → bot:`)

- `mode: suggest` — бот пишет **скрытое сообщение** с предложением и причиной (пилот);
- `mode: assign` — реально назначает + причина скрытым сообщением;
- `brain: ai | rules` — кто решает: ИИ-оператор или ключевики.

## Запуск

```bash
# офлайн-тест без портала и ключей
node autoassign.mjs --dry --feed test-feed.json --presence test-presence.json

# боевой (нужен .env)
node autoassign.mjs
```

## Предусловие: аккаунт бота — STAFF

`DISCOURSE_API_USERNAME` (по умолчанию `support_bot`) должен быть **модератором**
на портале. Без staff-прав недоступны скрытые сообщения (whisper), назначение и
запись в служебную категорию «Для сотрудников». Сделать бота модератором —
разовая ручная настройка в админке (Users → support_bot → Grant moderator).

## Деплой в Docker / Portainer (основной путь)

Секреты **не** в git. Кладём репозиторий в Portainer как stack и задаём ключи
в Environment variables стека:

```
DISCOURSE_API_KEY=<гранулярный ключ: Data Explorer run + Assign>
DISCOURSE_API_USERNAME=support_bot
PORTAL_URL=https://support.wirenboard.com
AI_API_KEY=<OpenAI-совместимый>
AI_MODEL=gpt-5-chat-latest          # reasoning-вариант: gpt-5.2 + AI_REASONING_EFFORT
AI_BASE_URL=https://api.openai.com
```

Portainer → Stacks → Add stack → Repository (этот репо, путь `docker-compose.yml`)
→ вписать переменные → Deploy. Контейнер гоняет один проход каждые
`INTERVAL_SECONDS` (900); `data/` (state + spam-review) живёт на volume
`autoassign-data`.

Локально то же самое:

```bash
cp .env.example .env   # заполнить ключи
docker compose up -d --build
docker compose logs -f
```

## Git

Репозиторий инициализирован; `.env`, `data/`, `node_modules`, рабочие выгрузки
(`live*.json`, `*.b64`, `last-run.txt`) — в `.gitignore`, в историю не попадают.
Запушить в свою учётку:

```bash
git remote add origin <git@github.com:ORG/wb-support-autoassign.git>
git push -u origin main
```

## Депл(альтернатива: systemd user, например claude-vm)

```bash
cp .env.example .env   # заполнить ключи
mkdir -p ~/.config/systemd/user
cp deploy/wb-autoassign.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now wb-autoassign.timer
journalctl --user -u wb-autoassign -f
```

## Ключи

- **Discourse**: Admin → API → New Key; пользователь — staff-бот (`support_bot`),
  гранулярные скоупы: Data Explorer *run queries* (53, 54) + Assign *assign*.
- **ИИ**: любой OpenAI-совместимый (`AI_BASE_URL`/`AI_MODEL`/`AI_API_KEY`).

## Порядок ввода в бой

1. Неделя-две `mode: suggest` — предложения в скрытых сообщениях, команда сверяет.
2. Смотрим точность (state.json хранит, кто предлагался; сравнить с фактом).
3. `mode: assign` + `duty:` заполнять при передаче дежурства.
