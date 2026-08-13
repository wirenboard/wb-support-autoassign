// now.mjs — простой ответ: незназначенные темы СЕЙЧАС и кому бы упали (правила).
// Читает live-feed.json (query 53) и live-presence.json (query 54), оба в форме {columns, rows}.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { CAT_SLUG, detectLang, classify, pick, detectSpam } from './lib/matcher.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const cfg = YAML.parse(fs.readFileSync(path.join(ROOT, 'routing.yaml'), 'utf8'));
const obj = res => res.rows.map(r => Object.fromEntries(res.columns.map((c, i) => [c, r[i]])));

const presence = {};
for (const r of obj(JSON.parse(fs.readFileSync(path.join(ROOT, 'live-presence.json'), 'utf8'))))
  presence[r.username] = { minutes_since_seen: Number(r.minutes_since_seen), load: Number(r.recent_load ?? 0) };

const feed = obj(JSON.parse(fs.readFileSync(path.join(ROOT, 'live-feed.json'), 'utf8')));

const nameOf = u => cfg.engineers?.[u]?.name ?? u;
const rows = [];
const tally = {};
for (const row of feed) {
  const pm = row.archetype === 'private_message';
  const topic = {
    id: row.id, title: row.title ?? '',
    tags: (row.tags ?? '').split(',').filter(Boolean),
    catSlug: CAT_SLUG[row.category_id] ?? (pm ? 'ЛС' : String(row.category_id)),
    excerpt: row.first_post ?? '',
  };
  const spam = detectSpam(topic);
  const cls = classify(cfg, topic);
  const lang = detectLang(topic.title, topic.excerpt);
  const res = spam.isSpam ? { pick: null } : pick(cfg, presence, cls?.domain ?? null, lang === 'en');
  const flag = (pm ? 'ЛС' : '') + (lang === 'en' ? ' EN' : '');
  let who, basis;
  if (spam.isSpam) {
    who = '⚠ СПАМ → на проверку';
    basis = `score ${spam.score}: ${spam.signals.join(', ')}`;
  } else {
    who = res.pick ? nameOf(res.pick.u) : 'дежурный';
    basis = res.pick
      ? (res.pick.skill ? `${cls?.domain ?? '—'} · навык ${res.pick.skill}` : `по загрузке (${cls?.domain ?? 'домен не определён'})`)
      : 'никого в сети';
  }
  rows.push({ id: topic.id, title: (row.title ?? '').replace(/\|/g, '/'), url: row.topic_url, flag: flag.trim(), who, basis });
  tally[who] = (tally[who] ?? 0) + 1;
  if (res.pick) presence[res.pick.u].load++;
}

console.log(`Незназначенных тем сейчас: ${rows.length}\n`);
console.log('| # | Тема | Флаг | Кому назначить | Основание |');
console.log('|---|------|------|----------------|-----------|');
for (const r of rows)
  console.log(`| ${r.id} | [${r.title}](${r.url}) | ${r.flag} | **${r.who}** | ${r.basis} |`);
console.log('\n| Инженер | Тем |');
console.log('|---------|:---:|');
for (const [u, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`| ${u} | ${n} |`);
