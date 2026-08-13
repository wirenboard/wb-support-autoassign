// lib/matcher.mjs — классификация темы и выбор инженера.
// Общий код dry-run.mjs (прогоны) и autoassign.mjs (бот).

// id категории → slug (снимок categories.json; сабкатегории свёрнуты в родителя)
export const CAT_SLUG = {
  1: 'uncategorized', 3: 'site-feedback', 5: 'software', 7: 'home-automation',
  8: 'featurerequests', 10: 'wb-modbus-peripherals', 13: 'devices',
  17: 'wiren-board', 19: 'service', 28: 'right-hardware',
  20: 'wiren-board', 18: 'wiren-board', 16: 'wiren-board', 14: 'wiren-board', 15: 'wiren-board',
  27: 'wb-modbus-peripherals', 25: 'wb-modbus-peripherals', 24: 'wb-modbus-peripherals',
  22: 'wb-modbus-peripherals', 30: 'wb-modbus-peripherals', 26: 'wb-modbus-peripherals',
  21: 'wb-modbus-peripherals', 23: 'wb-modbus-peripherals',
  11: 'software', 12: 'software', 29: 'featurerequests', 38: 'site-feedback',
};

export const stripHtml = s =>
  s.replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();

// Язык — в первую очередь по заголовку (в теле часто латинские логи),
// тело поста решает, только если заголовок неинформативен (RE:, имя модели).
export function detectLang(title, excerpt) {
  const cyrT = (title.match(/[а-яё]/gi) || []).length;
  const latT = (title.match(/[a-z]/gi) || []).length;
  if (cyrT >= 4) return 'ru';
  if (latT >= 12 && cyrT === 0) return 'en';
  const cyr = (excerpt.match(/[а-яё]/gi) || []).length;
  const lat = (excerpt.match(/[a-z]/gi) || []).length;
  return cyr < lat * 0.15 && lat > 40 ? 'en' : 'ru';
}

// Ключевик матчится только от границы слова (иначе «вопрос» ловит «опрос»),
// хвост свободный — «протечк» находит «протечка». \b для кириллицы не работает.
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const kwCache = new Map();
export function kwTest(kw, text) {
  let re = kwCache.get(kw);
  if (!re) { re = new RegExp('(?<![\\p{L}\\p{N}])' + escapeRe(kw), 'iu'); kwCache.set(kw, re); }
  return re.test(text);
}

// Тема {title, excerpt, tags[], catSlug} → {domain, score, why[]} | null.
// Веса: тег 10, слово в заголовке 4, слово в тексте 2, категория 5;
// суммарно меньше thresholds.min_domain_score — «не уверен» (null).
export function classify(cfg, topic) {
  let best = null;
  for (const [dom, d] of Object.entries(cfg.domains)) {
    let score = 0;
    const why = [];
    for (const t of d.tags || []) if (topic.tags.includes(t)) { score += 10; why.push('tag:' + t); }
    for (const k of d.keywords || []) {
      const pts = kwTest(k, topic.title) ? 4 : kwTest(k, topic.excerpt) ? 2 : 0;
      if (pts) { score += pts; why.push('kw:' + k); }
    }
    if ((d.categories || []).includes(topic.catSlug)) { score += 5; why.push('cat:' + topic.catSlug); }
    if (score > 0 && (!best || score > best.score)) best = { domain: dom, score, why };
  }
  const minScore = cfg.thresholds.min_domain_score ?? 0;
  return best && best.score >= minScore ? best : null;
}

// --- Детектор спама (поставщики компонентов/кабеля, партнёрства, рассылки-трекеры) ---
// Консервативный: срабатывает только при нескольких признаках сразу (score >= min).
// Ложный флаг на живом клиенте хуже пропущенного спама, поэтому пороги высокие.
const SPAM_RU = [
  'снизить расход', 'поставляем', 'номера деталей', 'снятых с производства',
  'электронных компонент', 'складские остатк', 'спецификаци bom', 'спецификацию bom',
];
const SPAM_EN = [
  'best price', 'discount', 'quantities', 'partnership', 'we supply', 'we can supply',
  'manufacturer', 'quotation', 'introductory email', 'wholesale', 'competitive price',
  'bom list', ' moq', 'lead time', 'obsolete parts',
];
const SPAM_BRANDS = ['nxp', 'xilinx', 'murata', 'altera', 'infineon', 'microchip', 'onsemi', 'vishay'];
const SAFE_HOST = /(^|\.)wirenboard\.(com|cloud|ru)$|(^|\.)ya\.ru$|(^|\.)yandex\.|(^|\.)github\.com$|(^|\.)t\.me$/i;

export function detectSpam(topic) {
  const text = ((topic.title || '') + '\n' + (topic.excerpt || '')).toLowerCase();
  let score = 0;
  const signals = [];

  const ru = SPAM_RU.filter(k => text.includes(k)).length;
  if (ru) { score += Math.min(ru, 3) * 2; signals.push(`sales-ru×${ru}`); }
  const en = SPAM_EN.filter(k => text.includes(k)).length;
  if (en) { score += Math.min(en, 3) * 2; signals.push(`sales-en×${en}`); }
  const brands = SPAM_BRANDS.filter(b => text.includes(b));
  if (brands.length >= 2) { score += 2; signals.push('brands:' + brands.join('/')); }

  for (const u of (topic.excerpt || '').match(/https?:\/\/[^\s)\]]+/gi) || []) {
    let host = '';
    try { host = new URL(u).host.toLowerCase(); } catch { continue; }
    if (SAFE_HOST.test(host)) continue;
    score += 1; signals.push('extlink:' + host);
    if (/\/api\/|[?&]e=|track|click|ntesrv|mailchi|sendgrid|\.(top|xyz|click|link)(\/|$)/i.test(u)) {
      score += 2; signals.push('tracker');
    }
  }
  const reCount = (topic.title.match(/re:/gi) || []).length;
  if (reCount >= 3) { score += 1; signals.push(`re-chain×${reCount}`); }

  return { isSpam: score >= 4, score, signals };
}

// Онлайн-кандидаты для темы после жёстких гейтов: EN-тройка, auto/away, «в сети».
// Это рамки и для ИИ-оператора, и для правил.
export function poolFor(cfg, presence, isEn) {
  const limit = cfg.presence.online_within_minutes;
  const pool = isEn
    ? cfg.gates.english.engineers
    : Object.entries(cfg.engineers).filter(([, e]) => e.auto && !e.away).map(([u]) => u);
  return pool
    .map(u => ({ u, ...(presence[u] ?? { minutes_since_seen: 1e9, load: 0 }) }))
    .filter(c => c.minutes_since_seen <= limit);
}

// Выбор инженера. presence: {username: {minutes_since_seen, load, ...}}.
// Возвращает {pick, tier, cand}: pick=null → фолбэк (дежурный/ручной разбор).
export function pick(cfg, presence, domain, isEn) {
  const limit = cfg.presence.online_within_minutes;
  const pool = isEn
    ? cfg.gates.english.engineers
    : Object.entries(cfg.engineers).filter(([, e]) => e.auto && !e.away).map(([u]) => u);

  const info = u => ({
    u,
    skill: domain ? (cfg.skills[domain]?.[u] ?? null) : null,
    ...(presence[u] ?? { minutes_since_seen: 1e9, load: 0 }),
  });
  const online = pool.map(info).filter(c => c.minutes_since_seen <= limit);
  const rank = l => [...l].sort((a, b) =>
    (a.load - b.load) || (a.minutes_since_seen - b.minutes_since_seen));

  if (domain) {
    const pri = online.filter(c => (c.skill ?? 0) >= cfg.thresholds.primary);
    if (pri.length) return { pick: rank(pri)[0], tier: 'осн. пул (3)', cand: rank(pri) };
    const res = online.filter(c => c.skill === cfg.thresholds.reserve);
    if (res.length) return { pick: rank(res)[0], tier: 'резерв (2)', cand: rank(res) };
    if (isEn && online.length) return { pick: rank(online)[0], tier: 'EN-гейт, без навыка', cand: rank(online) };
    return { pick: null, tier: 'компетентных в сети нет', cand: rank(online) };
  }
  if (online.length) return { pick: rank(online)[0], tier: 'домен не определён — по загрузке', cand: rank(online) };
  return { pick: null, tier: 'никого в сети', cand: [] };
}
