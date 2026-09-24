#!/usr/bin/env node
// Tana 棚 — static page generator.
// Builds one page per game (game/<slug>/), one page per platform (platform/<id>/),
// sitemaps and robots.txt from the catalogue, via the pages_platforms() and
// pages_export() functions in Supabase. Runs nightly in GitHub Actions.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SITE_URL (default https://tana.gamingjapanese.com),
//      OUT_DIR (default .), SAMPLE_DIR (offline test: reads platforms.json + games.json)

import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const SITE = (process.env.SITE_URL || 'https://tana.gamingjapanese.com').replace(/\/$/, '');
const OUT = process.env.OUT_DIR || '.';
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SAMPLE = process.env.SAMPLE_DIR;
const PAGE = 1000;

// ---------- data ----------
async function rpc(name, args) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
  });
  if (!res.ok) throw new Error(`${name} failed: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function loadPlatforms() {
  if (SAMPLE) return JSON.parse(await readFile(join(SAMPLE, 'platforms.json'), 'utf8'));
  return rpc('pages_platforms');
}

async function* loadGames(platformId) {
  if (SAMPLE) {
    const all = JSON.parse(await readFile(join(SAMPLE, 'games.json'), 'utf8'));
    for (const g of all) if (g.platform_ids.includes(platformId)) yield g;
    return;
  }
  for (let offset = 0; ; offset += PAGE) {
    const rows = await rpc('pages_export', { p_platform: platformId, p_limit: PAGE, p_offset: offset });
    for (const g of rows) yield g;
    if (rows.length < PAGE) break;
  }
}

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isLatin = s => !!s && /^[\x20-\x7E\u00A0-\u024F\u2010-\u2027\u2030-\u205E]+$/.test(s);
const hasJa = s => !!s && /[぀-ヿ一-鿿]/.test(s);
const REGION = { JP: 'Japan', NA: 'North America', EU: 'Europe' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function fmtDate(iso, precision) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  if (precision === 'year') return String(y);
  if (precision === 'month') return `${MONTHS[m - 1]} ${y}`;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}
const fmtYen = n => n == null ? null : `¥${Number(n).toLocaleString('en-US')}`;
const fmtFormat = f => ({ physical: 'physical', game_key: 'Game-Key Card', digital: 'download' }[f] || f);

// Display names follow the app: English name if there is one, else romaji, else the Japanese title.
function names(g) {
  const en = isLatin(g.title_en) ? g.title_en.trim() : null;
  const primary = en || (isLatin(g.title_romaji) ? g.title_romaji.trim() : null) || g.title_ja || g.title_en;
  const ja = g.title_ja && g.title_ja !== primary ? g.title_ja : null;
  return { primary, ja, en };
}

function jpRelease(g) { return g.releases.find(r => r.region === 'JP') || null; }
function westRegions(g) { return ['NA', 'EU'].filter(r => g.releases.some(x => x.region === r)); }

function description(g, platform) {
  const { primary, ja } = names(g);
  const jp = jpRelease(g);
  const bits = [`${primary}${ja ? ` (${ja})` : ''} for the ${platform.name_en}`];
  if (jp?.date) bits[0] += `, released in Japan on ${fmtDate(jp.date, jp.precision)}${jp.publisher ? ` by ${jp.publisher}` : ''}`;
  bits[0] += '.';
  const west = westRegions(g);
  if (g.is_jp_only) bits.push('Never released outside Japan.');
  else if (west.length) bits.push(`Also released in ${west.map(r => REGION[r]).join(' and ')}.`);
  const code = g.variants.find(v => v.region === 'JP' && v.product_code)?.product_code;
  if (code) bits.push(`Product code ${code}.`);
  return bits.join(' ');
}

// ---------- page template ----------
function layout({ title, desc, canonical, body, jsonld, platformColor }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Tana 棚">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${SITE}/static/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#ECEBE6">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Libre+Caslon+Text:wght@400;700&family=Shippori+Mincho+B1:wght@700&family=Zen+Kaku+Gothic+New:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${SITE}/static/pages.css">
${jsonld ? `<script type="application/ld+json">${JSON.stringify(jsonld).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body${platformColor ? ` style="--obi:${esc(platformColor)}"` : ''}>
<header class="top">
  <a class="brand" href="${SITE}/"><svg class="brand-mark" viewBox="0 0 22 24" aria-hidden="true"><rect class="s1" x="1" y="5" width="5" height="19" rx="1"/><rect class="s2" x="8.5" y="1" width="5" height="23" rx="1"/><rect class="s3" x="16" y="8" width="5" height="16" rx="1"/></svg><span class="brand-ja" lang="ja">棚</span> Tana</a>
  <a class="top-link" href="${SITE}/platform/">All platforms</a>
</header>
<main class="page">
${body}
</main>
<footer class="foot">
  <p>Tana catalogues physical game releases by region and edition, kept by collectors. Catalogue data is available under <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>, built on Wikipedia, Wikidata, Redump and MAME among other sources.</p>
  <p>© NLKB Consulting Co., Ltd. · <a href="${SITE}/#/privacy">Privacy</a></p>
</footer>
</body>
</html>
`;
}

function gamePage(g, platforms) {
  const { primary, ja, en } = names(g);
  const plats = g.platform_ids.map(id => platforms.get(id)).filter(Boolean);
  const platform = plats[0];
  const jp = jpRelease(g);
  const canonical = `${SITE}/game/${g.slug}/`;
  const appUrl = `${SITE}/#/game/${g.slug}`;
  const desc = description(g, platform);
  const west = g.releases.filter(r => r.region !== 'JP');
  const codes = g.variants.filter(v => v.region === 'JP' && v.product_code).map(v => v.product_code);
  const jans = g.variants.filter(v => v.region === 'JP' && v.jan).map(v => v.jan);
  const editions = g.variants.filter(v => v.label);
  const spineText = g.title_ja || primary;

  const facts = [
    ['Platform', plats.map(p => `<a href="${SITE}/platform/${p.id}/">${esc(p.name_en)}</a>`).join(', '), true],
    ['Released in Japan', jp ? (fmtDate(jp.date, jp.precision) || 'date not recorded') : 'not recorded'],
    ['Publisher', jp?.publisher],
    ['Developer', g.developer],
    ['Genre', g.genre],
    ['Players', g.players],
    ['CERO rating', g.cero],
    ['Series', g.series],
    ['Launch price', fmtYen(g.retail_price_jpy)],
    ['Product code', codes.length ? codes.map(esc).join(', ') : null, true],
    ['JAN', jans.length ? jans.map(esc).join(', ') : null, true],
    ['Media', jp?.format ? fmtFormat(jp.format) + (jp.format_basis === 'assumed' ? ' (assumed)' : '') : null],
  ].filter(([, v]) => v);

  let status;
  if (g.is_jp_only) status = `<p class="status jp-only"><span class="dot"></span>Japan only. This game was never released outside Japan on the ${esc(platform.name_en)}.</p>`;
  else if (west.length) status = `<p class="status west"><span class="dot"></span>Also released in ${west.map(r => REGION[r.region]).filter((v, i, a) => a.indexOf(v) === i).join(' and ')}.</p>`;
  else status = `<p class="status unknown"><span class="dot"></span>Western release not yet confirmed.</p>`;

  const westRows = west.map(r => `
    <div class="rel" data-region="${esc(r.region)}">
      <div class="rel-region">${esc(REGION[r.region] || r.region)}</div>
      <div class="rel-body">
        <div class="rel-title"${hasJa(r.title) ? ' lang="ja"' : ''}>${esc(r.title || primary)}</div>
        <div class="rel-meta">${[fmtDate(r.date, r.precision), r.publisher, r.format ? fmtFormat(r.format) + (r.format_basis === 'assumed' ? ' (assumed)' : '') : null].filter(Boolean).map(esc).join(', ')}</div>
      </div>
    </div>`).join('');

  const editionRows = editions.map(v => `<li>${esc(v.label)}${v.product_code ? ` <span class="code">${esc(v.product_code)}</span>` : ''}${v.region !== 'JP' ? ` <span class="muted">(${esc(REGION[v.region] || v.region)})</span>` : ''}</li>`).join('');

  const diffRows = g.differences.map(d => `
    <li class="diff">
      <div class="diff-head">${esc((d.category || 'difference').charAt(0).toUpperCase() + (d.category || 'difference').slice(1))}, ${esc(REGION[d.region] || d.region)}</div>
      <div class="diff-summary">${esc(d.summary)}</div>
      ${d.jp_side || d.other_side ? `<dl class="diff-sides"><dt>Japan</dt><dd>${esc(d.jp_side || 'Not recorded')}</dd><dt>${esc(REGION[d.region] || d.region)}</dt><dd>${esc(d.other_side || 'Not recorded')}</dd></dl>` : ''}
    </li>`).join('');

  const aliases = (g.aliases || []).filter(a => a && a !== g.title_ja && a !== primary);

  const body = `
<article class="game">
  <div class="shelf">
    <div class="spine" aria-hidden="true"><span class="spine-title" lang="${hasJa(spineText) ? 'ja' : 'en'}">${esc(spineText)}</span><span class="spine-plat">${esc(platform.short_name)}</span></div>
    <div class="game-head">
      <p class="crumb"><a href="${SITE}/platform/${platform.id}/">${esc(platform.name_en)}</a>${jp?.date ? `, ${esc(String(jp.date).slice(0, 4))}` : ''}</p>
      <h1${hasJa(primary) ? ' lang="ja"' : ''}>${esc(primary)}</h1>
      ${ja ? `<p class="title-alt" lang="ja">${esc(ja)}</p>` : ''}
      ${g.title_kana ? `<p class="reading" lang="ja">${esc(g.title_kana)}</p>` : ''}
      ${en && ja && g.title_romaji && g.title_romaji !== en ? `<p class="reading">${esc(g.title_romaji)}</p>` : ''}
      ${status}
    </div>
  </div>

  <dl class="facts">
    ${facts.map(([k, v, raw]) => `<dt>${k}</dt><dd>${raw ? v : esc(v)}</dd>`).join('\n    ')}
  </dl>

  ${west.length ? `<section><h2>Other regions</h2>${westRows}</section>` : ''}
  ${editions.length ? `<section><h2>Editions and reissues</h2><ul class="editions">${editionRows}</ul></section>` : ''}
  ${g.differences.length ? `<section><h2>Regional differences</h2><ul class="diffs">${diffRows}</ul></section>` : ''}
  ${aliases.length ? `<p class="aliases">Also listed as: ${aliases.map(a => `<span${hasJa(a) ? ' lang="ja"' : ''}>${esc(a)}</span>`).join(', ')}</p>` : ''}

  <div class="cta">
    <a class="btn" href="${appUrl}">Add to my collection</a>
    <a class="btn ghost" href="${appUrl}">Open in Tana</a>
  </div>
</article>`;

  const jsonld = {
    '@context': 'https://schema.org', '@type': 'VideoGame', name: primary, url: canonical,
    ...(ja ? { alternateName: [ja, ...aliases].filter(Boolean) } : (aliases.length ? { alternateName: aliases } : {})),
    gamePlatform: plats.map(p => p.name_en),
    ...(jp?.date ? { datePublished: jp.date } : {}),
    ...(jp?.publisher ? { publisher: { '@type': 'Organization', name: jp.publisher } } : {}),
    ...(g.developer ? { author: { '@type': 'Organization', name: g.developer } } : {}),
    ...(g.genre ? { genre: g.genre } : {}),
    ...(codes.length ? { productID: codes[0] } : {}),
    ...(jans.length ? { gtin13: jans[0] } : {}),
    inLanguage: 'ja',
  };

  return layout({ title: `${primary}${ja ? ` (${ja})` : ''}, ${platform.short_name} | Tana 棚`, desc, canonical, body, jsonld, platformColor: platform.color });
}

function platformPage(p, games) {
  const canonical = `${SITE}/platform/${p.id}/`;
  const jpOnly = games.filter(g => g.is_jp_only).length;
  const desc = `${games.length.toLocaleString('en-US')} ${p.name_en} games in the catalogue${p.first_year ? `, from ${p.first_year} to ${p.last_year || 'today'}` : ''}, filed by region. ${jpOnly.toLocaleString('en-US')} never left Japan.`;
  const rows = games.map(g => {
    const { primary, ja } = names(g);
    const jp = jpRelease(g);
    return `<li><a href="${SITE}/game/${g.slug}/"${hasJa(primary) ? ' lang="ja"' : ''}>${esc(primary)}</a>${ja ? ` <span class="ja" lang="ja">${esc(ja)}</span>` : ''}${jp?.date ? ` <span class="yr">${esc(String(jp.date).slice(0, 4))}</span>` : ''}${g.is_jp_only ? ' <span class="tag">Japan only</span>' : ''}</li>`;
  }).join('\n');
  const body = `
<div class="plat-head">
  <p class="crumb"><a href="${SITE}/platform/">All platforms</a></p>
  <h1>${esc(p.name_en)}${p.name_intl && p.name_intl !== p.name_en ? ` <span class="intl">${esc(p.name_intl)} elsewhere</span>` : ''}</h1>
  <p class="title-alt" lang="ja">${esc(p.name_ja)}</p>
  <p class="lede">${esc(desc)}${p.complete ? '' : ' Western releases for this platform are still being checked.'}</p>
</div>
<ol class="index">
${rows}
</ol>`;
  return layout({ title: `${p.name_en} games by region and edition | Tana 棚`, desc, canonical, body, platformColor: p.color,
    jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: `${p.name_en} games by region and edition`, url: canonical, numberOfItems: games.length } });
}

function platformsIndex(platforms) {
  const canonical = `${SITE}/platform/`;
  const total = platforms.reduce((n, p) => n + p.games, 0);
  const groups = new Map();
  for (const p of platforms) { const k = p.maker; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(p); }
  const body = `
<div class="plat-head">
  <h1>Every platform</h1>
  <p class="lede">${total.toLocaleString('en-US')} games across ${platforms.length} platforms, filed by region and edition.</p>
</div>
${[...groups].map(([maker, ps]) => `<section><h2>${esc(maker)}</h2><ul class="plats">${ps.map(p => `<li><a href="${SITE}/platform/${p.id}/">${esc(p.name_en)}</a> <span class="ja" lang="ja">${esc(p.name_ja)}</span> <span class="yr">${p.games.toLocaleString('en-US')} games</span></li>`).join('')}</ul></section>`).join('\n')}`;
  return layout({ title: 'Every platform | Tana 棚', desc: `${total.toLocaleString('en-US')} games across ${platforms.length} platforms, filed by region and edition.`, canonical, body });
}

// ---------- build ----------
async function main() {
  const t0 = Date.now();
  const platformsRaw = await loadPlatforms();
  const platforms = new Map(platformsRaw.map(p => [p.id, p]));
  const works = new Map();              // slug -> merged game
  const perPlatform = new Map();        // platform id -> [games]

  for (const p of platformsRaw) {
    const list = [];
    for await (const g of loadGames(p.id)) {
      const prev = works.get(g.slug);
      if (prev) {                       // same work on several platforms: merge platform-specific lists
        prev.releases.push(...g.releases); prev.variants.push(...g.variants); prev.differences.push(...g.differences);
        prev.is_jp_only = prev.is_jp_only && g.is_jp_only; prev.went_west = prev.went_west || g.went_west;
      } else works.set(g.slug, g);
      list.push(works.get(g.slug));
    }
    perPlatform.set(p.id, list);
    process.stdout.write(`${p.id}: ${list.length} games\n`);
  }

  await mkdir(join(OUT, 'game'), { recursive: true });
  await mkdir(join(OUT, 'platform'), { recursive: true });
  await mkdir(join(OUT, 'sitemaps'), { recursive: true });

  // remove pages for games that no longer exist (renamed slugs, merged duplicates)
  for (const dir of await readdir(join(OUT, 'game'))) if (!works.has(dir)) await rm(join(OUT, 'game', dir), { recursive: true, force: true });

  let written = 0;
  for (const g of works.values()) {
    const dir = join(OUT, 'game', g.slug);
    await mkdir(dir, { recursive: true });
    await writeIfChanged(join(dir, 'index.html'), gamePage(g, platforms)) && written++;
  }

  const sitemapIndex = [];
  for (const p of platformsRaw) {
    const games = perPlatform.get(p.id) || [];
    await mkdir(join(OUT, 'platform', p.id), { recursive: true });
    await writeIfChanged(join(OUT, 'platform', p.id, 'index.html'), platformPage(p, games));
    const urls = [{ loc: `${SITE}/platform/${p.id}/`, lastmod: games.reduce((m, g) => g.updated_at > m ? g.updated_at : m, '') },
      ...games.map(g => ({ loc: `${SITE}/game/${g.slug}/`, lastmod: g.updated_at }))];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `<url><loc>${esc(u.loc)}</loc>${u.lastmod ? `<lastmod>${u.lastmod.slice(0, 10)}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`;
    await writeIfChanged(join(OUT, 'sitemaps', `${p.id}.xml`), xml);
    sitemapIndex.push({ loc: `${SITE}/sitemaps/${p.id}.xml`, lastmod: urls[0].lastmod });
  }
  await writeIfChanged(join(OUT, 'platform', 'index.html'), platformsIndex(platformsRaw));
  await writeIfChanged(join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapIndex.map(s => `<sitemap><loc>${esc(s.loc)}</loc>${s.lastmod ? `<lastmod>${s.lastmod.slice(0, 10)}</lastmod>` : ''}</sitemap>`).join('\n')}\n</sitemapindex>\n`);
  await writeIfChanged(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
  await writeIfChanged(join(OUT, '.nojekyll'), '');

  console.log(`${works.size} games, ${platformsRaw.length} platforms, ${written} game pages changed, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function writeIfChanged(path, content) {
  try { if (await readFile(path, 'utf8') === content) return false; } catch {}
  await writeFile(path, content);
  return true;
}

main().catch(e => { console.error(e); process.exit(1); });
