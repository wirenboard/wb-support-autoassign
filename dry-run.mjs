#!/usr/bin/env node
// dry-run.mjs — прогон матчера-ПРАВИЛ по темам портала без каких-либо действий.
// Логика — общая с ботом (lib/matcher.mjs). Для прогона с ИИ-мозгом:
//   node autoassign.mjs --dry [--feed ...] [--presence ...]
//
//   node dry-run.mjs [N]                — последние N публичных тем (по умолчанию 15)
//   node dry-run.mjs --feed feed.json   — {ids: [...], private: [{id, title, excerpt}]}:
//                                         публичные тянутся по id анонимно, ЛС из private[].

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { CAT_SLUG, stripHtml, detectLang, classify, pick } from './lib/matcher.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://support.wirenboard.com';

const cfg = YAML.parse(fs.readFileSync(path.join(ROOT, 'routing.yaml'), 'utf8'));
const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'presence.json'), 'utf8'));
// снапшот query 24: загрузкой считаем open_assigned (окна за 7 дней в нём нет)
const presence = {};
for (const [u, v] of Object.entries(snap)) {
  if (u.startsWith('_')) continue;
  presence[u] = { minutes_since_seen: v.minutes_since_seen, load: v.open_assigned };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  return r.ok ? r.json() : null;
}

// --- сбор списка тем ---
const items = [];
const feedIdx = process.argv.indexOf('--feed');

if (feedIdx !== -1) {
  const feed = JSON.parse(fs.readFileSync(path.resolve(process.argv[feedIdx + 1]), 'utf8'));
  const priv = new Map((feed.private ?? []).map(p => [p.id, p]));
  console.log(`DRY-RUN (правила): ${feed.ids.length} тем из фида`);
  for (const id of feed.ids) {
    const d = await getJson(`${BASE}/t/${id}.json`).catch(() => null);
    if (d) {
      items.push({
        id, title: d.title, tags: d.tags ?? [],
        catSlug: CAT_SLUG[d.category_id] ?? String(d.category_id),
        excerpt: stripHtml(d.post_stream?.posts?.[0]?.cooked ?? '').slice(0, 1500),
        pm: d.archetype === 'private_message',
      });
    } else if (priv.has(id)) {
      const p = priv.get(id);
      items.push({ id, title: p.title, tags: [], catSlug: 'ЛС', excerpt: p.excerpt ?? '', pm: true });
    } else {
      console.log(`#${id} — анонимно не достать и нет в private[], пропуск`);
    }
    await sleep(250);
  }
} else {
  const N = parseInt(process.argv[2] || '15', 10);
  console.log(`DRY-RUN (правила): ${N} последних публичных тем ${BASE}`);
  const latest = await getJson(`${BASE}/latest.json?no_definitions=true`);
  for (const t of latest.topic_list.topics.filter(t => !t.pinned).slice(0, N)) {
    const d = await getJson(`${BASE}/t/${t.id}.json`).catch(() => null);
    items.push({
      id: t.id, title: t.title, tags: t.tags ?? [],
      catSlug: CAT_SLUG[t.category_id] ?? String(t.category_id),
      excerpt: d ? stripHtml(d.post_stream?.posts?.[0]?.cooked ?? '').slice(0, 1500) : '',
      pm: false,
    });
    await sleep(250);
  }
}

console.log(`presence: снапшот ${snap._snapshot.split(' — ')[0]}, онлайн = last_seen ≤ ${cfg.presence.online_within_minutes} мин`);
console.log(`загрузка: open_assigned из снапшота + инкремент за прогон\n`);

// --- матчинг ---
const tally = {};
for (const topic of items) {
  const cls = classify(cfg, topic);
  const lang = detectLang(topic.title, topic.excerpt);
  const res = pick(cfg, presence, cls?.domain ?? null, lang === 'en');

  const head = `#${topic.id}${topic.pm ? ' [ЛС]' : ''} «${topic.title.slice(0, 60)}»`;
  const domStr = cls ? `${cls.domain} [${cls.why.slice(0, 3).join(', ')}]` : '— не классифицирована —';
  const who = res.pick
    ? `${res.pick.u} (навык ${res.pick.skill ?? '—'}, онлайн ${res.pick.minutes_since_seen}м, загрузка ${res.pick.load})`
    : 'ДЕЖУРНЫЙ';
  const others = res.cand.slice(1, 4).map(c => `${c.u}(${c.skill ?? '—'}/${c.load})`).join(' ');

  console.log(head);
  console.log(`   ${lang.toUpperCase()} | ${domStr}`);
  console.log(`   → ${who}   [${res.tier}]${others ? '   ещё: ' + others : ''}\n`);
  tally[res.pick?.u ?? 'дежурный'] = (tally[res.pick?.u ?? 'дежурный'] ?? 0) + 1;
  if (res.pick && presence[res.pick.u]) presence[res.pick.u].load++;
}

console.log('Итог распределения:');
for (const [u, n] of Object.entries(tally).sort((a, b) => b[1] - a[1]))
  console.log(`  ${String(n).padStart(2)}  ${u}`);
