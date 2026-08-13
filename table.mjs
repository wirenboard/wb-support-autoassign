// table.mjs — markdown-таблица «что кому упадёт» по неразобранному бэклогу (правила).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { CAT_SLUG, stripHtml, detectLang, classify, pick } from './lib/matcher.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://support.wirenboard.com';
const cfg = YAML.parse(fs.readFileSync(path.join(ROOT, 'routing.yaml'), 'utf8'));
const snap = JSON.parse(fs.readFileSync(path.join(ROOT, 'presence.json'), 'utf8'));
const presence = {};
for (const [u, v] of Object.entries(snap)) {
  if (u.startsWith('_')) continue;
  presence[u] = { minutes_since_seen: v.minutes_since_seen, load: v.open_assigned };
}
const feed = JSON.parse(fs.readFileSync(path.join(ROOT, 'portal-feed.json'), 'utf8'));
const priv = new Map((feed.private ?? []).map(p => [p.id, p]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const getJson = async u => { const r = await fetch(u, { headers: { Accept: 'application/json' } }); return r.ok ? r.json() : null; };
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const rows = [];
const tally = {};
for (const id of feed.ids) {
  const d = await getJson(`${BASE}/t/${id}.json`).catch(() => null);
  let topic;
  if (d) topic = { id, title: d.title, tags: d.tags ?? [], catSlug: CAT_SLUG[d.category_id] ?? String(d.category_id), excerpt: stripHtml(d.post_stream?.posts?.[0]?.cooked ?? '').slice(0, 1500), pm: d.archetype === 'private_message' };
  else if (priv.has(id)) { const p = priv.get(id); topic = { id, title: p.title, tags: [], catSlug: 'ЛС', excerpt: p.excerpt ?? '', pm: true }; }
  else continue;

  const cls = classify(cfg, topic);
  const lang = detectLang(topic.title, topic.excerpt);
  const res = pick(cfg, presence, cls?.domain ?? null, lang === 'en');
  const who = res.pick ? res.pick.u : 'дежурный';
  rows.push({ id, pm: topic.pm, en: lang === 'en', title: cut(topic.title, 46), dom: cls?.domain ?? '—', who, skill: res.pick?.skill ?? '', tier: res.tier });
  tally[who] = (tally[who] ?? 0) + 1;
  if (res.pick) presence[res.pick.u].load++;
  await sleep(200);
}

console.log('| # | Тема | Флаг | Домен | Кому | Навык | Основание |');
console.log('|---|------|------|-------|------|:-----:|-----------|');
for (const r of rows)
  console.log(`| ${r.id} | ${r.title} | ${r.pm ? 'ЛС' : ''}${r.en ? ' EN' : ''} | ${r.dom} | **${r.who}** | ${r.skill} | ${r.tier} |`);
console.log('\n| Инженер | Тем |');
console.log('|---------|:---:|');
for (const [u, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`| ${u} | ${n} |`);
