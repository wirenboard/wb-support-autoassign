// debug-one.mjs — классификация одной темы с разбором очков: node debug-one.mjs <topic_id>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const cfg = YAML.parse(fs.readFileSync(path.join(ROOT, 'routing.yaml'), 'utf8'));
const id = process.argv[2] ?? '40544';

const r = await fetch(`https://support.wirenboard.com/t/${id}.json`, { headers: { Accept: 'application/json' } });
console.log('HTTP', r.status);
if (!r.ok) process.exit(0);
const d = await r.json();
const strip = s => s.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const title = d.title;
const excerpt = strip(d.post_stream?.posts?.[0]?.cooked ?? '').slice(0, 1500);
console.log('title:', JSON.stringify(title));
console.log('excerpt head:', JSON.stringify(excerpt.slice(0, 120)));

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const kt = (k, t) => new RegExp('(?<![\\p{L}\\p{N}])' + esc(k), 'iu').test(t);

for (const [dom, dd] of Object.entries(cfg.domains)) {
  let score = 0;
  const why = [];
  for (const k of dd.keywords ?? []) {
    const p = kt(k, title) ? 4 : kt(k, excerpt) ? 2 : 0;
    if (p) { score += p; why.push(`${k}:${p}`); }
  }
  if (score) console.log(dom.padEnd(16), score, why.join(','));
}
console.log('min_domain_score:', cfg.thresholds.min_domain_score);
