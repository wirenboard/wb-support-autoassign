#!/usr/bin/env node
// autoassign.mjs — бот автораспределения тем портала ТП. Один проход:
//   query 53 (неразобранные темы) + query 54 (присутствие/загрузка) →
//   ИИ-оператор решает, кому отдать (в рамках жёстких гейтов) →
//   suggest: скрытое сообщение (whisper) | assign: назначение + причина.
//
// Мозг (bot.brain):
//   ai    — ИИ читает тему, видит навыки/присутствие/загрузку кандидатов и выбирает,
//           как живой диспетчер. Ответ проверяется кодом: EN-гейт, навык ≥ 2, онлайн.
//           Нет ключа / ошибка / ответ не прошёл гейты → автоматический откат на правила.
//   rules — только ключевики+матрица (то, что гоняли в dry-run).
//
//   node autoassign.mjs                 — боевой проход (env-переменные обязательны)
//   node autoassign.mjs --dry           — всё посчитать, ничего не постить
//   node autoassign.mjs --dry --feed test-feed.json --presence test-presence.json
//   --brain ai|rules                    — переопределить bot.brain на один проход
//   --force-hours                       — игнорировать проверку рабочего времени
//
// env: DISCOURSE_API_KEY (гранулярный: data explorer run + assign),
//      DISCOURSE_API_USERNAME (staff-бот; от его имени идут whisper/assign),
//      PORTAL_URL (по умолчанию https://support.wirenboard.com),
//      AI_API_KEY, AI_MODEL, AI_BASE_URL (OpenAI-совместимый; DeepSeek тоже подходит)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { CAT_SLUG, detectLang, classify, pick, poolFor, detectSpam } from './lib/matcher.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const cfg = YAML.parse(fs.readFileSync(path.join(ROOT, 'routing.yaml'), 'utf8'));
const bot = cfg.bot ?? {};
if (process.env.BOT_MODE) bot.mode = process.env.BOT_MODE;   // env перебивает routing.yaml: off|suggest|assign

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const flag = n => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
const BRAIN = flag('--brain') ?? bot.brain ?? 'rules';

const PORTAL = process.env.PORTAL_URL ?? 'https://support.wirenboard.com';
const KEY = process.env.DISCOURSE_API_KEY;
const USER = process.env.DISCOURSE_API_USERNAME ?? 'system';

const log = (...a) => console.log(new Date().toISOString(), ...a);

// --- гварды ---
if ((bot.mode ?? 'off') === 'off') { log('bot.mode=off — выходим'); process.exit(0); }

function inWorkingHours() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: cfg.presence.tz }));
  const [from, to] = (cfg.presence.working_hours ?? '10:00-18:00').split('-').map(s => parseInt(s, 10));
  const wd = now.getDay();
  return wd >= 1 && wd <= 5 && now.getHours() >= from && now.getHours() < to;
}
if (bot.enforce_working_hours && !argv.includes('--force-hours') && !inWorkingHours()) {
  log(`вне рабочего времени (${cfg.presence.working_hours ?? '10-18'} ${cfg.presence.tz}) — выходим`);
  process.exit(0);
}

// Текущее время МСК в минутах от полуночи — для персональных часов инженеров (engineers.<u>.hours).
// --force-hours отключает фильтр по часам (null), чтобы офлайн-тест не был пустым вне смен.
const NOW_MIN = argv.includes('--force-hours')
  ? null
  : (() => { const d = new Date(new Date().toLocaleString('en-US', { timeZone: cfg.presence.tz })); return d.getHours() * 60 + d.getMinutes(); })();

// --- Discourse API ---
async function api(p, { method = 'GET', body, form } = {}) {
  if (!KEY) throw new Error('нет DISCOURSE_API_KEY (для офлайн-теста задайте --feed/--presence и --dry)');
  const headers = { 'Api-Key': KEY, 'Api-Username': USER, Accept: 'application/json' };
  let payload;
  if (form) { payload = new URLSearchParams(form); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  else if (body) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const r = await fetch(PORTAL + p, { method, headers, body: payload });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const toObjects = res => res.rows.map(r => Object.fromEntries(res.columns.map((c, i) => [c, r[i]])));

async function runQuery(id, params) {
  // Если запросы расшарены на группу (bot.explorer_group) — гоняем через групповой
  // эндпоинт: его может вызывать член группы БЕЗ прав админа. /admin/... требует admin.
  const grp = bot.explorer_group;
  const path = grp
    ? `/g/${grp}/reports/${id}/run`
    : `/admin/plugins/explorer/queries/${id}/run`;
  const res = await api(path, {
    method: 'POST',
    form: { params: JSON.stringify(params), limit: '100' },
  });
  if (!res?.success) throw new Error(`query ${id}: ${JSON.stringify(res).slice(0, 200)}`);
  return toObjects(res);
}

// Действия. В --dry только печатаем.
async function whisper(topicId, raw) {
  if (DRY) { log(`[dry] whisper в #${topicId}:\n${raw.split('\n').map(l => '        ' + l).join('\n')}`); return; }
  await api('/posts.json', { method: 'POST', body: { topic_id: topicId, raw, whisper: true } });
}
async function assign(topicId, username) {
  if (DRY) { log(`[dry] assign #${topicId} → ${username}`); return; }
  await api('/assign/assign.json', { method: 'PUT', body: { target_id: topicId, target_type: 'Topic', username } });
}

// Спам: помечаем на ручную проверку, НИЧЕГО не закрываем и не удаляем.
async function flagSpam(topic, verdict) {
  const s = bot.spam ?? {};
  const line = `🤖 Похоже на спам (score ${verdict.score}: ${verdict.signals.join(', ')}). ` +
    `Не назначаю и не закрываю — проверьте и, если согласны, закройте вручную (скрытое «спам» + «Ключик»).`;
  await whisper(topic.id, line);                       // 1) скрытое сообщение в теме
  if (!DRY && s.review_log) {                           // 2) строка в лог на ревью
    const rec = { id: topic.id, title: topic.title, url: topic.url, score: verdict.score, signals: verdict.signals, ts: new Date().toISOString() };
    fs.appendFileSync(path.join(ROOT, s.review_log), JSON.stringify(rec) + '\n');
  }
  if (s.review_topic_id) {                               // 3) дубль в служебную тему-накопитель
    const post = `🤖 Спам? [${topic.title}](${topic.url}) — score ${verdict.score}: ${verdict.signals.join(', ')}`;
    if (DRY) log(`[dry] review-post в #${s.review_topic_id}: ${post}`);
    else await api('/posts.json', { method: 'POST', body: { topic_id: s.review_topic_id, raw: post } });
  }
}

// --- ИИ-оператор ---
// Получает тему и УЖЕ отфильтрованных кандидатов (гейты пройдены кодом),
// возвращает {username|null, domain|null, reason} или бросает исключение.
async function decideAI(topic, lang, candidates) {
  const key = process.env.AI_API_KEY, model = process.env.AI_MODEL;
  if (!key || !model) return null; // ИИ не сконфигурирован
  const base = (process.env.AI_BASE_URL ?? 'https://api.openai.com').replace(/\/$/, '');

  const skillsOf = u => Object.entries(cfg.skills)
    .map(([d, m]) => (m[u] ?? 0) >= 2 ? `${d}:${m[u]}` : null)
    .filter(Boolean).join(', ');
  const table = candidates.map(c =>
    `- ${c.u}: в сети ${Math.round(c.minutes_since_seen)} мин назад, загрузка ${c.load} тем за ${cfg.load.window_days} дн; навыки (2=разберётся, 3=эксперт): ${skillsOf(c.u) || 'нет данных'}`
  ).join('\n');

  const sys =
    'Ты — диспетчер техподдержки Wiren Board (контроллеры и Modbus-периферия для автоматизации). ' +
    'Прочитай обращение клиента и выбери ОДНОГО инженера из списка кандидатов, как это сделал бы опытный оператор: ' +
    'пойми, о чём тема по смыслу, сопоставь с навыками, предпочитай экспертов (3) и менее загруженных. ' +
    'Не выбирай человека без подходящего навыка — если никто не подходит, верни username: null. ' +
    'domain выбери из списка доменов (или null, если тема ни к одному не относится). ' +
    'Ответ строго JSON: {"username": string|null, "domain": string|null, "reason": "одно предложение по-русски, почему"}';
  const legend = Object.entries(cfg.domains)
    .map(([d, dd]) => `- ${d}: ${(dd.keywords ?? []).slice(0, 6).join(', ')}`).join('\n');
  const usr =
    `Домены и характерные слова (сопоставь тему по смыслу):\n${legend}\n\n` +
    `Кандидаты (все уже допустимы по политике и в сети):\n${table}\n\n` +
    `Тема${lang === 'en' ? ' (на английском — пул уже сужен до англоговорящих)' : ''}: «${topic.title}»\n\n` +
    `Первое сообщение клиента:\n${topic.excerpt.slice(0, 1200)}`;

  // temperature/reasoning_effort шлём ТОЛЬКО если заданы в env: reasoning-модели
  // GPT-5 (gpt-5.x) отклоняют temperature≠default, а чат-модели не знают reasoning_effort.
  // По умолчанию не шлём ни то, ни другое — работает на любой GPT-5 и на gpt-4o.
  const payload = {
    model,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
  };
  if (process.env.AI_TEMPERATURE) payload.temperature = Number(process.env.AI_TEMPERATURE);
  if (process.env.AI_REASONING_EFFORT) payload.reasoning_effort = process.env.AI_REASONING_EFFORT;

  const r = await fetch(base + '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`AI ${r.status}: ${(await r.text()).slice(0, 150)}`);
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
}

// --- данные ---
const presenceRows = flag('--presence')
  ? JSON.parse(fs.readFileSync(path.resolve(flag('--presence')), 'utf8'))
  : await runQuery(bot.presence_query, { window_days: String(cfg.load.window_days) });
const presence = {};
for (const r of (presenceRows.rows ? toObjects(presenceRows) : presenceRows)) {
  presence[r.username] = {
    minutes_since_seen: Number(r.minutes_since_seen),
    load: Number(r.recent_load ?? 0),
    open_assigned: Number(r.open_assigned ?? 0),
    paused: r.paused === true || r.paused === 't' || String(r.paused).toLowerCase() === 'true',
  };
}

const feedRaw = flag('--feed')
  ? JSON.parse(fs.readFileSync(path.resolve(flag('--feed')), 'utf8'))
  : await runQuery(bot.feed_query, { days: String(bot.feed_days ?? 4) });
const feed = feedRaw.rows ? toObjects(feedRaw) : feedRaw;

const statePath = path.join(ROOT, bot.state_file ?? 'state.json');
fs.mkdirSync(path.dirname(statePath), { recursive: true });   // data/ на volume может не существовать
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { processed: {} };
const saveState = () => { if (!DRY) fs.writeFileSync(statePath, JSON.stringify(state, null, 1)); };

// --- проход ---
const cfgEng = Object.keys(cfg.engineers);
const pausedNow = cfgEng.filter(u => presence[u]?.paused).map(u => u);
log(`режим ${bot.mode}, мозг ${BRAIN}${DRY ? ' [DRY]' : ''}; тем в фиде: ${feed.length}; инженеров ${cfgEng.length}${pausedNow.length ? ` (на паузе: ${pausedNow.join(', ')})` : ''}; в группе support ${Object.keys(presence).length}`);
let acted = 0, skipped = 0;

for (const row of feed) {
  const id = row.id;
  if (state.processed[id]) { skipped++; continue; }

  const ageMin = (Date.now() - Date.parse(row.created_at)) / 60000;
  if (ageMin < (bot.min_topic_age_minutes ?? 0)) { log(`#${id} моложе ${bot.min_topic_age_minutes} мин — следующий проход`); continue; }

  const pm = row.archetype === 'private_message';
  const topic = {
    id,
    title: row.title ?? '',
    tags: (row.tags ?? '').split(',').filter(Boolean),
    catSlug: CAT_SLUG[row.category_id] ?? (pm ? 'ЛС' : String(row.category_id)),
    excerpt: row.first_post ?? '',
    url: row.topic_url,
  };

  // Спам-фильтр — до маршрутизации. Помечаем и пропускаем (не назначаем).
  if (bot.spam?.enabled) {
    const verdict = detectSpam(topic);
    if (verdict.isSpam) {
      try {
        await flagSpam(topic, verdict);
        state.processed[id] = { ts: new Date().toISOString(), spam: true, score: verdict.score };
        acted++; saveState();
        log(`#${id} помечен как спам (score ${verdict.score})`);
      } catch (e) { log(`#${id} спам-пометка не удалась: ${e.message}`); }
      continue;
    }
  }

  const lang = detectLang(topic.title, topic.excerpt);
  const candidates = poolFor(cfg, presence, lang === 'en', NOW_MIN); // гейты + персональные часы

  // 1) ИИ-оператор
  let decision = null;
  if (BRAIN === 'ai' && candidates.length) {
    try {
      const ai = await decideAI(topic, lang, candidates);
      if (ai === null) {
        log(`#${id} ИИ не сконфигурирован (AI_API_KEY/AI_MODEL) — правила`);
      } else if (ai.username) {
        const c = candidates.find(x => x.u === ai.username);
        const dom = ai.domain && cfg.domains[ai.domain] ? ai.domain : null;
        const skill = dom ? cfg.skills[dom]?.[ai.username] ?? null : null;
        if (c && (!dom || (skill ?? 0) >= cfg.thresholds.reserve)) {
          decision = { pick: { ...c, skill }, domain: dom, tier: 'ИИ-оператор', reason: ai.reason, cand: candidates };
        } else {
          log(`#${id} ИИ выбрал ${ai.username}/${ai.domain} — не проходит гейты (навык/пул), откат на правила`);
        }
      } else {
        decision = { pick: null, domain: ai.domain ?? null, tier: 'ИИ-оператор: подходящих нет', reason: ai.reason, cand: candidates };
      }
    } catch (e) {
      log(`#${id} ИИ недоступен: ${e.message} — откат на правила`);
    }
  }

  // 2) Правила (основной мозг при brain=rules, откат при brain=ai)
  if (!decision) {
    const cls = classify(cfg, topic);
    const res = pick(cfg, presence, cls?.domain ?? null, lang === 'en', NOW_MIN);
    decision = { ...res, domain: cls?.domain ?? null, reason: cls ? `сигналы: ${cls.why.slice(0, 3).join(', ')}` : 'домен по сигналам не определён', tier: `правила: ${res.tier}` };
  }

  const enStr = lang === 'en' ? 'тема на английском → EN-пул. ' : '';
  const domStr = decision.domain ? `\`${decision.domain}\`` : 'не определён';
  const alts = (decision.cand ?? []).filter(c => c.u !== decision.pick?.u).slice(0, 2)
    .map(c => `${c.u} (загрузка ${c.load})`).join(', ');

  try {
    if (decision.pick) {
      const p = decision.pick;
      const verb = bot.mode === 'assign' ? 'назначаю' : 'предлагаю';
      const text = `🤖 Автораспределение [${decision.tier}]: ${enStr}${verb} **@${p.u}** — домен ${domStr}, ${decision.reason}. ` +
        `В сети ${Math.round(p.minutes_since_seen)} мин назад, загрузка ${p.load} тем за ${cfg.load.window_days} дн.` +
        (alts ? `\nАльтернативы: ${alts}.` : '') +
        `\nЕсли мимо — назначьте вручную, бот эту тему больше не тронет.`;
      if (bot.mode === 'assign') {
        await assign(id, p.u);
        if (bot.explain_assign) await whisper(id, text);
      } else {
        await whisper(id, text);
      }
      state.processed[id] = { ts: new Date().toISOString(), mode: bot.mode, brain: decision.tier, user: p.u };
      presence[p.u].load++;
      log(`#${id}${pm ? ' [ЛС]' : ''} «${topic.title.slice(0, 45)}» → ${p.u} · ${bot.mode === 'assign' ? 'НАЗНАЧЕН' : 'предложен'} [${decision.tier}${decision.domain ? ' · ' + decision.domain : ''}]`);
    } else {
      const duty = cfg.duty && lang !== 'en' ? cfg.duty : null;
      const text = `🤖 Автораспределение [${decision.tier}]: ${enStr}домен ${domStr}, ${decision.reason}. ` +
        (duty ? `Отдаю дежурному @${duty}.` : 'Нужен ручной разбор.');
      if (bot.mode === 'assign' && duty) await assign(id, duty);
      await whisper(id, text);
      state.processed[id] = { ts: new Date().toISOString(), mode: bot.mode, brain: decision.tier, user: duty };
      log(`#${id}${pm ? ' [ЛС]' : ''} «${topic.title.slice(0, 45)}» → ${duty ? 'дежурный ' + duty : 'РУЧНОЙ разбор'} [${decision.tier}]`);
    }
    acted++;
    saveState();
  } catch (e) {
    log(`#${id} ошибка действия: ${e.message} — не помечаю, повторим в следующий проход`);
  }
}

log(`готово: обработано ${acted}, пропущено по state ${skipped}`);
