#!/usr/bin/env node
// Tana 棚 — static page generator.
// Builds one page per game (game/<slug>/), one page per platform (platform/<id>/),
// sitemaps and robots.txt from the catalogue, via the pages_platforms() and
// pages_export() functions in Supabase. Runs nightly in GitHub Actions.
//
// Env: SUPABASE_URL, SUPABASE_ANON_KEY, SITE_URL (default https://tana.gamingjapanese.com),
//      OUT_DIR (default .), SAMPLE_DIR (offline test: reads platforms.json + games.json)

import zlib from 'node:zlib';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const SITE = (process.env.SITE_URL || 'https://tana.gamingjapanese.com').replace(/\/$/, '');
const OUT = process.env.OUT_DIR || '.';
const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON = process.env.SUPABASE_ANON_KEY;
const SAMPLE = process.env.SAMPLE_DIR;
const PAGE = 1000;

// ---------- data ----------
// A call that times out (the public role allows 3 seconds; a cold cache can be slow) is retried twice
async function rpc(name, args, attempt = 1) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args || {}),
  });
  if (!res.ok) {
    const text = await res.text();
    if (attempt < 3 && (res.status >= 500 || /57014|statement timeout/.test(text))) {
      console.warn(`${name}: ${res.status} on attempt ${attempt}, retrying`);
      await new Promise(r => setTimeout(r, 4000 * attempt));
      return rpc(name, args, attempt + 1);
    }
    throw new Error(`${name} failed: HTTP ${res.status} ${text}`);
  }
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
    const rows = await rpc('pages_export', { p_platform: platformId, p_limit: PAGE, p_offset: offset, p_include_west: true, p_regions: ['JP', 'NA', 'EU', 'AS', 'KR', 'BR', 'OTHER'] });
    for (const g of rows) yield g;
    if (rows.length < PAGE) break;
  }
}

// ---------- helpers ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isLatin = s => !!s && /^[\x20-\x7E\u00A0-\u024F\u2010-\u2027\u2030-\u205E]+$/.test(s);
const hasJa = s => !!s && /[぀-ヿ一-鿿]/.test(s);
const REGION = { JP: 'Japan', NA: 'North America', EU: 'Europe', AS: 'Asia', KR: 'Korea', BR: 'Brazil', OTHER: 'Other regions' };
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
// A game released only outside Japan: its earliest release stands in for the Japanese one
function firstRelease(g) { return [...g.releases].filter(r => r.date).sort((a, b) => String(a.date).localeCompare(String(b.date)))[0] || g.releases[0] || null; }

function description(g, platform) {
  const { primary, ja } = names(g);
  const jp = jpRelease(g);
  const bits = [`${primary}${ja ? ` (${ja})` : ''} for the ${platform.name_en}`];
  if (jp?.date) bits[0] += `, released in Japan on ${fmtDate(jp.date, jp.precision)}${jp.publisher ? ` by ${jp.publisher}` : ''}`;
  else if (g.is_west_only) { const f = firstRelease(g); if (f?.date) bits[0] += `, released in ${REGION[f.region] || f.region} on ${fmtDate(f.date, f.precision)}${f.publisher ? ` by ${f.publisher}` : ''}`; }
  bits[0] += '.';
  const west = westRegions(g);
  if (g.is_jp_only) bits.push('Never released outside Japan.');
  else if (g.is_west_only) bits.push('Never released in Japan.');
  else if (g.is_west_physical_only) bits.push('Japan received it as a download only; the physical release is Western.');
  else if (west.length) bits.push(`Also released in ${west.map(r => REGION[r]).join(' and ')}.`);
  const code = g.variants.find(v => v.region === 'JP' && v.product_code)?.product_code;
  if (code) bits.push(`Product code ${code}.`);
  return bits.join(' ');
}

// ---------- page template ----------
function layout({ title, desc, canonical, body, jsonld, platformColor, ogImage, noindex, ogPortrait }) {
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
<meta property="og:image" content="${esc(ogImage || `${SITE}/static/og.png`)}">${noindex ? '\n<meta name="robots" content="noindex">' : ''}
${ogPortrait ? '' : `<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
`}<meta name="twitter:card" content="${ogPortrait ? 'summary' : 'summary_large_image'}">
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
  <nav class="top-links"><a class="top-link" href="${SITE}/help/">Help</a><a class="top-link" href="${SITE}/platform/">All platforms</a></nav>
</header>
<main class="page">
${body}
</main>
<footer class="foot">
  <p>Tana catalogues physical game releases by region and edition, kept by collectors. Catalogue data is available under <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>, built on Wikipedia, Wikidata, Redump and MAME among other sources.</p>
  <p>© NLKB Consulting Co., Ltd. · <a href="${SITE}/#/privacy">Privacy</a> · <a href="https://discord.gg/MXWmYAhxUs" rel="noopener">Discord</a> · <a href="https://www.reddit.com/r/tanashelf/" rel="noopener">r/tanashelf</a></p>
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
  const coverRel = (jp && jp.cover && jp.format !== 'digital' ? jp : null) || g.releases.find(r => r.cover && r.format !== 'digital') || g.releases.find(r => r.cover);
  const cover = coverRel ? coverRel.cover : null;

  const facts = [
    ['Platform', plats.map(p => `<a href="${SITE}/platform/${p.id}/">${esc(p.name_en)}</a>`).join(', '), true],
    ...(g.is_west_only
      ? [['Released', west.map(r => `${REGION[r.region] || r.region}, ${fmtDate(r.date, r.precision) || 'date not recorded'}`).join('; ')],
         ['Released in Japan', 'Never'],
         ['Publisher', [...new Set(west.map(r => r.publisher).filter(Boolean))].join(', ')]]
      : [['Released in Japan', jp ? (fmtDate(jp.date, jp.precision) || 'date not recorded') + (jp.format === 'digital' ? ', download only' : '') : 'not recorded'],
         ['Publisher', jp?.publisher]]),
    ['Developer', g.developer],
    ['Genre', g.genre],
    ['Players', g.players],
    ['CERO rating', g.cero],
    ['Series', g.series],
    ['Launch price', fmtYen(g.retail_price_jpy)],
    ['Product code', codes.length ? codes.map(esc).join(', ') : null, true],
    ['JAN', jans.length ? jans.map(esc).join(', ') : null, true],
    ['Media', (jp || firstRelease(g))?.format ? fmtFormat((jp || firstRelease(g)).format) + ((jp || firstRelease(g)).format_basis === 'assumed' ? ' (assumed)' : '') : null],
  ].filter(([, v]) => v);

  let status;
  if (g.is_jp_only) status = `<p class="status jp-only"><span class="dot"></span>Japan only. This game was never released outside Japan on the ${esc(platform.name_en)}.</p>`;
  else if (g.is_west_only) status = `<p class="status west-only"><span class="dot"></span>Western only. This game was never released in Japan on the ${esc(platform.name_en)}.</p>`;
  else if (g.is_west_physical_only) status = `<p class="status west-phys"><span class="dot"></span>Physical in the West only. In Japan it was released on the ${esc(platform.name_en)} as a download.</p>`;
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
    ${cover ? `<figure class="boxart"><img src="${esc(coverUrl(cover, 360))}" alt="Box art${cover.a && cover.a !== coverRel.region ? ` (${esc(REGION[cover.a] || cover.a)} release)` : ''}" loading="eager" decoding="async"><span class="reg" data-r="${esc(coverRel.region)}">${esc(coverRel.region)}</span></figure>`
      : `<div class="spine" aria-hidden="true"><span class="spine-title" lang="${hasJa(spineText) ? 'ja' : 'en'}">${esc(spineText)}</span><span class="spine-plat">${esc(platform.short_name)}</span></div>`}
    <div class="game-head">
      <p class="crumb"><a href="${SITE}/platform/${platform.id}/">${esc(platform.name_en)}</a>${(jp || firstRelease(g))?.date ? `, ${esc(String((jp || firstRelease(g)).date).slice(0, 4))}` : ''}</p>
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

  ${west.length ? `<section><h2>${g.is_west_only ? 'Releases' : 'Other regions'}</h2>${westRows}</section>` : ''}
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
    ...(cover ? { image: coverUrl(cover, 600, 'jpg') } : {}),
    ...(jans.length ? { gtin13: jans[0] } : {}),
    inLanguage: 'ja',
  };

  return layout({ title: `${primary}${ja ? ` (${ja})` : ''}, ${platform.short_name} | Tana 棚`, desc, canonical, body, jsonld, platformColor: platform.color,
    ...(cover ? { ogImage: coverUrl(cover, 600, 'jpg'), ogPortrait: true } : {}) });
}

function platformPage(p, games) {
  const canonical = `${SITE}/platform/${p.id}/`;
  const jpOnly = games.filter(g => g.is_jp_only).length;
  const westOnly = games.filter(g => g.is_west_only).length;
  const desc = `${games.length.toLocaleString('en-US')} ${p.name_en} games in the catalogue${p.first_year ? `, from ${p.first_year} to ${p.last_year || 'today'}` : ''}, filed by region. ${jpOnly.toLocaleString('en-US')} never left Japan${westOnly ? `, and ${westOnly.toLocaleString('en-US')} never came out there` : ''}.`;
  const rows = games.map(g => {
    const { primary, ja } = names(g);
    const jp = jpRelease(g) || firstRelease(g);
    return `<li><a href="${SITE}/game/${g.slug}/"${hasJa(primary) ? ' lang="ja"' : ''}>${esc(primary)}</a>${ja ? ` <span class="ja" lang="ja">${esc(ja)}</span>` : ''}${jp?.date ? ` <span class="yr">${esc(String(jp.date).slice(0, 4))}</span>` : ''}${g.is_jp_only ? ' <span class="tag">Japan only</span>' : ''}${g.is_west_only ? ' <span class="tag west">Western only</span>' : ''}</li>`;
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
  const helpUrls = await buildHelp();
  if (helpUrls.length) {
    await writeIfChanged(join(OUT, 'sitemaps', 'help.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${helpUrls.map(u => `<url><loc>${esc(u.loc)}</loc><lastmod>${u.lastmod}</lastmod></url>`).join('\n')}\n</urlset>\n`);
    sitemapIndex.push({ loc: `${SITE}/sitemaps/help.xml`, lastmod: helpUrls.reduce((m, u) => u.lastmod > m ? u.lastmod : m, '') });
  }
  await writeIfChanged(join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapIndex.map(s => `<sitemap><loc>${esc(s.loc)}</loc>${s.lastmod ? `<lastmod>${s.lastmod.slice(0, 10)}</lastmod>` : ''}</sitemap>`).join('\n')}\n</sitemapindex>\n`);
  await writeIfChanged(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
  await writeIfChanged(join(OUT, '.nojekyll'), '');
  await buildProfiles();
  await buildMy9(platforms);
  await buildBox();

  console.log(`${works.size} games, ${platformsRaw.length} platforms, ${written} game pages changed, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

async function writeIfChanged(path, content) {
  try { if (await readFile(path, 'utf8') === content) return false; } catch {}
  await writeFile(path, content);
  return true;
}

// ---------- Member share pages ----------
// /u/<username>/            page with the member's shelf, preview tags and a shelf image
// /u/<username>/shelf.png   1200x630 preview image drawn from their collection
// /u/<username>/embed/      a one-shelf widget for blogs and forums (iframe)
// Only public collections; adult titles never appear. Pages of collections made private are deleted.
const BOX = { dvd: [150, 22], jewel: [100, 19], umd: [114, 20], handheld: [98, 20], switchcase: [132, 18],
  cartbox: [112, 30], famicom: [104, 24], smallbox: [90, 24], hucard: [96, 18], aes: [160, 38], bigbox: [150, 36] };
const BOX_OF = { ps2: 'dvd', ps3: 'dvd', ps4: 'dvd', ps5: 'dvd', xbox: 'dvd', x360: 'dvd', xone: 'dvd', xsx: 'dvd', gc: 'dvd', wii: 'dvd', wiiu: 'dvd',
  ps1: 'jewel', ss: 'jewel', dc: 'jewel', mcd: 'jewel', pcecd: 'jewel', pcfx: 'jewel', neocd: 'jewel', '3do': 'jewel', playdia: 'jewel', pippin: 'jewel', towns: 'jewel',
  psp: 'umd', vita: 'handheld', nds: 'handheld', n3ds: 'handheld', switch: 'switchcase', switch2: 'switchcase',
  fc: 'famicom', fds: 'famicom', gb: 'smallbox', gbc: 'smallbox', gba: 'smallbox', gg: 'smallbox', ws: 'smallbox', wsc: 'smallbox',
  ngp: 'smallbox', ngpc: 'smallbox', pokemini: 'smallbox', pce: 'hucard', sgx: 'hucard', neogeo: 'aes', pc88: 'bigbox', pc98: 'bigbox', x68k: 'bigbox' };
const boxOf = b => BOX[BOX_OF[b.pf] || (b.m === 'disc' ? 'jewel' : b.m === 'floppy' ? 'bigbox' : 'cartbox')];
const isJa = t => /[\u3040-\u30ff\u3400-\u9fff]/.test(t || '');
const plural = (n, one, many = one + 's') => `${Number(n).toLocaleString('en-US')} ${n === 1 ? one : many}`;
function statsLine(p) {
  return [plural(p.games, 'game'), p.jp_only ? `${Number(p.jp_only).toLocaleString('en-US')} Japan only` : null,
          plural(p.platforms, 'platform'), p.verified ? `${Number(p.verified).toLocaleString('en-US')} verified` : null].filter(Boolean).join(' · ');
}
function clip(t, max) { const a = [...String(t || '')]; return a.length > max ? a.slice(0, Math.max(1, max - 1)).join('') + '…' : a.join(''); }

// The preview image: title, counts, and a bookcase of their boxes in platform colours
// Region sticker on each box (cream label, region ink), as in the app
const REG_TAG = { JP: 'JP', NA: 'NA', EU: 'EU', KR: 'KR', AS: 'AS', BR: 'BR' };
const REG_INK = { JP: '#B4452A', NA: '#2C4A7E', EU: '#2E6A4E', KR: '#7A3E6E', AS: '#8C6A14', BR: '#2E6A4E' };
// A member's shelf style (same codes and colours as the app): wood:<species>, metal:<finish>, paint:#rrggbb, lacquer:#rrggbb.
const SHELF_FINISHES = {
  wood: { oak: ['#A8764A', '#C39162', '#75492A', '#3D2B1E'], walnut: ['#6E4A33', '#8A6249', '#4B3021', '#24170F'], cherry: ['#9E5434', '#BC7050', '#6F3720', '#38190F'],
    teak: ['#9A6A3A', '#B58454', '#6E4824', '#3A2614'], keyaki: ['#B27A44', '#CC965F', '#83552B', '#43291A'], mahogany: ['#7C3526', '#97493A', '#56221A', '#2A100C'],
    maple: ['#D6B784', '#E8CFA3', '#B39265', '#6E583C'], hinoki: ['#E2CB9C', '#EFDDB7', '#C2A877', '#86734F'], whitewash: ['#D9D0C3', '#EAE3D8', '#B6AB9B', '#978C7D'],
    ebony: ['#2F2723', '#4A3E36', '#1C1714', '#110D0B'] },
  metal: { steel: ['#9BA2A9', '#CDD2D7', '#6B7279', '#363B40'], chrome: ['#C4C9CE', '#F4F6F8', '#888F96', '#43494F'], iron: ['#3B3D40', '#5E6165', '#232527', '#151618'],
    gunmetal: ['#50565D', '#767D85', '#33383D', '#1C1F23'], brass: ['#B8913F', '#E0C474', '#86672A', '#352C20'], bronze: ['#8C6239', '#B08458', '#5F4024', '#2B2018'],
    copper: ['#B26C47', '#D9946D', '#7C462A', '#33221B'] },
};
const hexRgb = h => { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
const rgbHex = a => '#' + a.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();
const mixHex = (a, b, t) => { const x = hexRgb(a), y = hexRgb(b); return rgbHex(x.map((v, k) => v + (y[k] - v) * t)); };
const lumHex = h => { const [r, g, b] = hexRgb(h).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; };
function shelfPalette(code) {
  let m = /^(wood|metal):([a-z]+)$/.exec(code || '') || /^(paint|lacquer):(#[0-9a-f]{6})$/i.exec(code || '');
  if (!m || (SHELF_FINISHES[m[1]] && !SHELF_FINISHES[m[1]][m[2]])) m = [null, 'wood', 'oak'];
  const mat = m[1]; let frame, hi, lo, back;
  if (SHELF_FINISHES[mat]) [frame, hi, lo, back] = SHELF_FINISHES[mat][m[2]];
  else {
    frame = m[2].toUpperCase(); const L = lumHex(frame);
    hi = mixHex(frame, '#FFFFFF', mat === 'lacquer' ? .26 : .18); lo = mixHex(frame, '#000000', .26);
    back = mat === 'lacquer' ? mixHex(frame, '#000000', .55) : mixHex(frame, '#000000', L > .55 ? .16 : L > .25 ? .3 : .48);
  }
  return { mat, frame, hi, lo, back, styled: !!code && m[0] !== null, ink: lumHex(back) > .3 ? '#2A2622' : '#E9DFD2' };
}
// Inline colours for an HTML case; no style keeps the stylesheet's oak (which dims in dark mode).
function caseStyle(code) {
  const p = shelfPalette(code);
  return p.styled ? ` m-${p.mat}" style="--oak:${p.frame};--oak-hi:${p.hi};--oak-lo:${p.lo};--walnut:${p.back};--shelf-ink:${p.ink}` : '';
}
function shelfSvg(p) {
  const pal = shelfPalette(p.style);
  const W = 1200, H = 630, S = 1.6, left = 64, right = 1136, top = 262, floor = 566, inner = right - left - 28 - 20;
  const books = []; let used = 0, prev = null, more = 0;
  const all = p.books || [], total = Math.max(p.editions || 0, all.length);
  const fitsAll = all.reduce((sum, b, k) => sum + Math.round(boxOf(b)[1] * S) + (k && all[k - 1].pf !== b.pf ? 12 : 1), 0) <= inner && total <= all.length;
  const room = fitsAll ? inner : inner - 160;   // keep a clear stretch of shelf for the "+ N more" label
  for (const b of all) {
    const [h, w] = boxOf(b); const bw = Math.round(w * S), gap = prev && prev !== b.pf ? 12 : 1;
    if (used + gap + bw > room) { more++; continue; }
    books.push({ ...b, bh: Math.round(h * S), bw, x: used + gap }); used += gap + bw; prev = b.pf;
  }
  more += Math.max(0, (p.editions || 0) - (p.books || []).length);
  let x0 = left + 14 + 10;
  const spines = books.map(b => {
    const x = x0 + b.x, y = floor - b.bh, ja = isJa(b.t);
    const fs = Math.max(11, Math.min(ja ? 17 : 15, b.bw * (ja ? 0.5 : 0.44)));
    const room = b.bh - 26 - 18 - (REG_TAG[b.reg] ? 16 : 0), cap = Math.max(2, Math.floor(room / (fs * (ja ? 1.04 : 0.6))));
    const cx = x + b.bw / 2;
    return `<g><rect x="${x}" y="${y}" width="${b.bw}" height="${b.bh}" rx="2" fill="${esc(b.c)}"/>
<rect x="${x}" y="${y}" width="${b.bw}" height="${b.bh}" rx="2" fill="url(#gloss)"/>
<rect x="${x + 4}" y="${y + 6}" width="${b.bw - 8}" height="1.5" fill="#FFFFFF" fill-opacity=".45"/>
${REG_TAG[b.reg] ? `<rect x="${cx - 12}" y="${y + 11}" width="24" height="14" rx="1.5" fill="#F4EFE4"/><text x="${cx}" y="${y + 22}" text-anchor="middle" font-family="Inter" font-weight="800" font-size="10" fill="${REG_INK[b.reg]}">${REG_TAG[b.reg]}</text>` : ''}
<text x="${cx}" y="${y + (REG_TAG[b.reg] ? 32 : 16)}" writing-mode="tb" font-family="${ja ? 'Shippori Mincho B1' : 'Inter'}" font-weight="${ja ? 700 : 600}" font-size="${fs.toFixed(1)}" fill="#FFFFFF">${esc(clip(b.t, cap))}</text>
<text x="${cx}" y="${floor - 6}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="9" fill="#FFFFFF" fill-opacity=".85">${esc(clip(b.s, Math.max(2, Math.floor(b.bw / 6))))}</text></g>`;
  }).join('\n');
  const name = clip(p.display_name, 28);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="gloss" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".24"/><stop offset=".26" stop-color="#FFFFFF" stop-opacity=".05"/><stop offset=".56" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity=".3"/></linearGradient>
<linearGradient id="plank" x1="0" y1="0" x2="0" y2="1">${pal.mat === 'metal'
  ? `<stop offset="0" stop-color="${pal.hi}"/><stop offset=".28" stop-color="${pal.frame}"/><stop offset=".5" stop-color="${pal.lo}"/><stop offset=".76" stop-color="${pal.frame}"/><stop offset="1" stop-color="${pal.hi}"/>`
  : `<stop offset="0" stop-color="${pal.hi}"/><stop offset=".2" stop-color="${pal.frame}"/><stop offset=".7" stop-color="${pal.frame}"/><stop offset="1" stop-color="${pal.lo}"/>`}</linearGradient>
<pattern id="peg" width="16" height="16" patternUnits="userSpaceOnUse"><circle cx="8" cy="8" r="2" fill="#000000" fill-opacity=".45"/></pattern>
<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000000" stop-opacity=".4"/><stop offset="1" stop-color="#000000" stop-opacity="0"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="#ECEBE6"/>
<rect x="${left}" y="54" width="7" height="30" rx="1" fill="#B4452A"/><rect x="${left + 10}" y="48" width="7" height="36" rx="1" fill="#2C4A7E"/><rect x="${left + 20}" y="58" width="7" height="26" rx="1" fill="#2E6A4E"/>
<text x="${left + 38}" y="82" font-family="Libre Caslon Text" font-weight="700" font-size="30" fill="#1D1B17">Tana</text>
<text x="${right}" y="82" text-anchor="end" font-family="Inter" font-weight="400" font-size="20" fill="#6B675E">tana.gamingjapanese.com</text>
<text x="${left}" y="170" font-family="Libre Caslon Text" font-weight="700" font-size="58" fill="#1D1B17">${esc(name)}’s shelf</text>
<text x="${left}" y="218" font-family="Inter" font-weight="400" font-size="26" fill="#5D5A52">${esc(statsLine(p))}</text>
<rect x="${left}" y="${top - 12}" width="${right - left}" height="12" fill="${pal.lo}"/>
<rect x="${left}" y="${top}" width="${right - left}" height="${floor - top}" fill="${pal.back}"/>
${pal.mat === 'metal' ? `<rect x="${left}" y="${top}" width="${right - left}" height="${floor - top}" fill="url(#peg)"/>` : ''}
<rect x="${left + 14}" y="${top}" width="${right - left - 28}" height="34" fill="url(#shade)"/>
<rect x="${left}" y="${top}" width="14" height="${floor - top + 22}" fill="${pal.lo}"/><rect x="${right - 14}" y="${top}" width="14" height="${floor - top + 22}" fill="${pal.lo}"/>
${spines}
<rect x="${left}" y="${floor}" width="${right - left}" height="22" fill="url(#plank)"/>
${more ? `<text x="${right - 24}" y="${floor - 14}" text-anchor="end" font-family="Inter" font-weight="600" font-size="18" fill="${pal.ink}">+ ${Number(more).toLocaleString('en-US')} more</text>` : ''}
</svg>`;
}

// Static shelf for the HTML pages: shelves of up to 20 boxes
function shelfHtml(books, perShelf = 20, maxW = 640) {
  const shelves = []; let cur = [], used = 0, prev = null;
  for (const b of books) {
    const [h, w] = boxOf(b); const gap = prev && prev !== b.pf ? 11 : 1;
    if (cur.length >= perShelf || used + gap + w > maxW) { shelves.push(cur); cur = []; used = 0; prev = null; }
    cur.push({ ...b, h, w, startGroup: !!(cur.length && prev !== b.pf) }); used += (cur.length > 1 ? gap : 0) + w; prev = b.pf;
  }
  if (cur.length) shelves.push(cur);
  return shelves.map(list => `<div class="prow">${list.map(b => {
    const fs = w => (w >= 30 ? 12 : w >= 22 ? 10.5 : 9.5);
    return `<span class="pbook${b.startGroup ? ' pgap' : ''}" style="--obi:${esc(b.c)};--h:${b.h}px;--w:${b.w}px;--fs:${fs(b.w)}px" title="${esc(b.t)}">${REG_TAG[b.reg] ? `<span class="pbook-r" data-r="${b.reg}">${b.reg}</span>` : ''}<span class="pbook-t"${isJa(b.t) ? ' lang="ja"' : ''}>${esc(b.t)}</span><span class="pbook-p">${esc(b.s)}</span></span>`;
  }).join('')}</div>`).join('');
}

function profilePage(p) {
  const url = `${SITE}/u/${encodeURIComponent(p.username)}/`;
  const title = `${p.display_name}’s shelf on Tana`;
  const desc = `${statsLine(p)}. A physical game collection by region and edition.`;
  const body = `<section class="profile">
  <p class="crumb"><a href="${SITE}/">Tana</a>, member collection</p>
  <h1>${esc(p.display_name)}’s shelf</h1>
  <p class="lede">${esc(statsLine(p))}</p>
  ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}
  <div class="pcase${caseStyle(p.style)}">${shelfHtml(p.books || []) || '<p class="pcase-empty">The shelf is empty for now.</p>'}</div>
  ${(p.editions || 0) > (p.books || []).length ? `<p class="muted">Showing ${(p.books || []).length} of ${Number(p.editions).toLocaleString('en-US')} editions.</p>` : ''}
  ${(p.subs || []).filter(x => (x.books || []).length).map(x => `<h2 class="psub-h"><a href="${SITE}/#/u/${encodeURIComponent(p.username)}?shelf=${encodeURIComponent(x.id)}">${esc(x.name)}</a> <span>${Number(x.n).toLocaleString('en-US')}</span></h2>
  <div class="pcase psub${caseStyle(x.style || p.style)}">${shelfHtml(x.books || [])}</div>`).join('\n  ')}
  <p class="actions"><a class="btn primary" href="${SITE}/#/u/${encodeURIComponent(p.username)}">Open the full collection</a> <a class="btn" href="${SITE}/">Start your own shelf</a></p>
</section>`;
  return layout({ title, desc, canonical: url, body, ogImage: `${SITE}/u/${encodeURIComponent(p.username)}/shelf.png`, noindex: true });
}

function embedPage(p) {
  const books = (p.books || []).slice(0, 40);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(p.display_name)}’s shelf on Tana</title><meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Libre+Caslon+Text:wght@700&family=Shippori+Mincho+B1:wght@700&family=Zen+Kaku+Gothic+New:wght@500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${SITE}/static/pages.css"></head>
<body class="embed"><a class="embed-card" href="${SITE}/u/${encodeURIComponent(p.username)}/" target="_blank" rel="noopener">
<span class="embed-head"><strong>${esc(p.display_name)}’s shelf</strong> <span>${esc(statsLine(p))}</span></span>
<span class="pcase one${caseStyle(p.style)}">${shelfHtml(books, 40, 4000)}</span>
<span class="embed-foot">View on Tana</span></a></body></html>
`;
}

const NOT_FOUND = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Tana</title><meta name="robots" content="noindex">
<script>
// Share links for members whose page has not been built yet (pages are built nightly) open the app instead
var m = location.pathname.match(/^\\/u\\/([^\\/]+)/), n = location.pathname.match(/^\\/my9\\/([^\\/]+)\\/(\\d)/);
location.replace(n ? '/#/my9/u/' + n[1] + '/' + n[2] : m ? '/#/u/' + m[1] : '/');
</script></head><body><p><a href="/">Tana</a></p></body></html>
`;

// ---------- My 9 (私を構成する9本) ----------
// /my9/                       the invitation: what it is, a sample grid, straight on to the maker in the app
// /my9/<username>/<slot>/     a member's grid: its own preview picture (grid.png), then on to the app
const MY9_PROMPTS = { made: ['The 9 games that made me', '私を構成する9本'], childhood: ['9 games from my childhood', '子どもの頃の9本'], jponly: ['9 Japan-only gems', '日本でしか出なかった9本'],
  fire: ['9 games I’d save from a fire', '火事でも持ち出す9本'], year: ['My 9 of the year', '今年の9本'], comfort: ['9 comfort games', '心が落ち着く9本'] };
// Box art: the same sources and proxy as the app (libretro-thumbnails, Wikipedia, members' photos through wsrv.nl)
const SUPA_PUBLIC = `${process.env.SUPABASE_URL || ''}/storage/v1/object/public/photos/`;
function coverUrl(cov, w = 320, fmt = 'webp') {
  if (!cov || !cov.p || cov.s === 'none') return '';
  let origin;
  if (cov.s === 'libretro') { const i = cov.p.indexOf('/'); origin = `https://raw.githubusercontent.com/libretro-thumbnails/${cov.p.slice(0, i)}/master/Named_Boxarts/${encodeURIComponent(cov.p.slice(i + 1))}.png`; }
  else if (cov.s === 'member') origin = SUPA_PUBLIC + cov.p;
  else if (cov.s === 'gametdb') origin = `https://art.gametdb.com/${cov.p}`;
  else origin = cov.p;
  return `https://wsrv.nl/?url=${encodeURIComponent(origin)}&w=${w}&output=${fmt}&q=82&we`;
}
// Fetched once per build for the share pictures: { href, w, h } with the PNG inlined
const COVER_CACHE = new Map();
async function coverData(cov) {
  let url = coverUrl(cov, 480, 'png'); if (!url) return null;
  if (process.env.COVERS_DIRECT) url = decodeURIComponent(url.slice(url.indexOf('url=') + 4, url.indexOf('&w=')));   // offline tests: skip the proxy
  if (COVER_CACHE.has(url)) return COVER_CACHE.get(url);
  let out = null;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'TanaPages/1.0 (+https://tana.gamingjapanese.com)' } });
    if (res.ok) { const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > 24 && buf.readUInt32BE(12) === 0x49484452) out = { href: `data:image/png;base64,${buf.toString('base64')}`, w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }
  } catch { out = null; }
  COVER_CACHE.set(url, out); return out;
}
const PRINT_FACE = { smallbox: [0.8, 0.62, 'card'], famicom: [0.8, 0.66, 'card'], cartbox: [0.72, 0.84, 'card'], hucard: [0.76, 0.64, 'card'], aes: [0.72, 0.9, 'card'],
  bigbox: [0.74, 0.9, 'card'], jewel: [0.88, 0.72, 'jewel'], dvd: [0.7, 0.9, 'dvd'], switchcase: [0.62, 0.84, 'dvd'], umd: [0.6, 0.78, 'dvd'], handheld: [0.82, 0.7, 'dvd'] };
const faceOf = c => PRINT_FACE[BOX_OF[c.pf] || (c.m === 'disc' ? 'jewel' : c.m === 'floppy' ? 'bigbox' : 'cartbox')] || PRINT_FACE.cartbox;
const mixTo = (a, b, t) => { const x = hexRgb(a), y = hexRgb(b); return rgbHex(x.map((v, k) => v + (y[k] - v) * t)); };
function wrapWords(t, perLine, lines) {
  const words = isJa(t) ? [...t] : String(t).split(/\s+/), out = []; let cur = '';
  for (const w of words) { const n = cur ? cur + (isJa(t) ? '' : ' ') + w : w; if ([...n].length <= perLine || !cur) cur = n; else { out.push(cur); cur = w; } }
  if (cur) out.push(cur);
  if (out.length > lines) { const k = out.slice(0, lines); k[lines - 1] = clip(k[lines - 1], perLine - 1) + '…'; return k; }
  return out;
}
function regTag(c, x, y, s) {
  return REG_TAG[c.reg] ? `<rect x="${x - 21 * s}" y="${y}" width="${16 * s}" height="${11 * s}" fill="#F4EFE4" stroke="#000" stroke-opacity=".3" stroke-width=".6"/><text x="${x - 13 * s}" y="${y + 8.5 * s}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="${(7.5 * s).toFixed(1)}" fill="${REG_INK[c.reg]}">${c.reg}</text>` : '';
}
function printSvg(c, x, y, cw, lang) {
  const [asp, size, kind] = faceOf(c), fh = Math.round(cw * Math.min(0.9, size * 1.04)), fw = Math.round(fh * asp), s = fw / 100;
  const art = c.covData;
  if (art) {
    // Real box art, in its own proportions, bottom-centred where the face would sit
    const r = art.w / art.h; let h = fh, w = h * r; if (w > cw * 0.92) { w = cw * 0.92; h = w / r; }
    const ax = x + (cw - w) / 2, ay = y + cw - cw * 0.05 - h, ts = Math.min(w, h * 0.75) / 100;
    return `<g><rect x="${ax + 3 * s}" y="${ay + 6 * s}" width="${w}" height="${h}" fill="#000" fill-opacity=".35"/>
<image x="${ax}" y="${ay}" width="${w}" height="${h}" preserveAspectRatio="none" href="${art.href}"/>
${regTag(c, ax + w, ay + 5 * ts, ts)}
<rect x="${ax + 0.5}" y="${ay + 0.5}" width="${w - 1}" height="${h - 1}" fill="none" stroke="#000" stroke-opacity=".18"/></g>`;
  }
  const fx = x + (cw - fw) / 2, fy = y + cw - cw * 0.05 - fh, col = c.c || '#5E6675';
  const obi = kind === 'jewel' && c.reg === 'JP' ? fw * 0.12 : 0, x0 = fx + obi, w0 = fw - obi, bandH = 18 * s;
  const main = lang === 'ja' && c.ja ? c.ja : c.t, sub = lang === 'ja' && c.ja ? c.t : c.ja, ja = isJa(main);
  const lines = wrapWords(main || '', Math.max(4, Math.floor((w0 - 16 * s) / (14 * s * (ja ? 1.0 : 0.55)))), 4), lh = 15.5 * s;
  const subLine = sub && sub !== main ? sub : '', subH = subLine ? 13 * s : 0, ty = fy + fh - 12 * s - subH - (lines.length - 1) * lh;
  return `<g><rect x="${fx + 3 * s}" y="${fy + 6 * s}" width="${fw}" height="${fh}" fill="#000" fill-opacity=".35"/>
<rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="#F4EFE4"/>
<rect x="${x0}" y="${fy}" width="${w0}" height="${bandH}" fill="${esc(col)}"/>
<text x="${x0 + 7 * s}" y="${fy + bandH / 2 + 3 * s}" font-family="Inter" font-weight="600" font-size="${(8 * s).toFixed(1)}" letter-spacing="${(1 * s).toFixed(1)}" fill="#FFFFFF">${esc(clip(c.pn || '', Math.floor(w0 / (6 * s))))}</text>
<rect x="${x0}" y="${fy + bandH}" width="${w0}" height="${fh - bandH}" fill="${mixTo(col, '#F4EFE4', 0.9)}"/>
<rect x="${x0}" y="${fy + fh - 5 * s}" width="${w0}" height="${5 * s}" fill="${esc(col)}"/>
${lines.map((l, k) => `<text x="${x0 + 8 * s}" y="${ty + k * lh}" font-family="${ja ? 'Shippori Mincho B1' : 'Libre Caslon Text'}" font-weight="700" font-size="${(14 * s).toFixed(1)}" fill="#1D1B17">${esc(l)}</text>`).join('')}
${subLine ? `<text x="${x0 + 8 * s}" y="${fy + fh - 12 * s}" font-family="${isJa(subLine) ? 'Shippori Mincho B1' : 'Inter'}" font-size="${(8 * s).toFixed(1)}" fill="#6B675E">${esc(clip(subLine, Math.floor((w0 - 16 * s) / ((isJa(subLine) ? 8.4 : 4.4) * s))))}</text>` : ''}
${regTag(c, fx + fw, fy + bandH + 4 * s, s)}
${obi ? `<rect x="${fx}" y="${fy}" width="${obi}" height="${fh}" fill="#FBF8F2"/><rect x="${fx}" y="${fy + fh * 0.58}" width="${obi}" height="${fh * 0.16}" fill="#B4452A"/>` : ''}
<rect x="${fx + 0.5}" y="${fy + 0.5}" width="${fw - 1}" height="${fh - 1}" fill="none" stroke="#000" stroke-opacity=".18"/></g>`;
}
function cubbySvg(g, X, Y, cw) {
  const pal = shelfPalette(g.style), gap = cw * 0.075, pad = cw * 0.085, W = cw * 3 + gap * 2 + pad * 2;
  const cells = (g.cells || []).map((c, k) => {
    const cx = X + pad + (k % 3) * (cw + gap), cy = Y + pad + Math.floor(k / 3) * (cw + gap);
    const plate = c && g.plates !== 'none' ? (g.plates === 'year' ? (c.year || c.y || '') : (c.age ? `Age ${c.age}` : '')) : '';
    return `<rect x="${cx}" y="${cy}" width="${cw}" height="${cw}" fill="${pal.back}"/><rect x="${cx}" y="${cy}" width="${cw}" height="${cw * 0.3}" fill="url(#n9shade)"/>
${k === 4 ? `<rect x="${cx + 1.5}" y="${cy + 1.5}" width="${cw - 3}" height="${cw - 3}" fill="url(#n9glow)" stroke="#C9A13B" stroke-width="3"/>` : ''}
${c ? printSvg(c, cx, cy, cw, g.lang) : `<rect x="${cx + cw * 0.18}" y="${cy + cw * 0.15}" width="${cw * 0.64}" height="${cw * 0.7}" fill="none" stroke="#FFFFFF" stroke-opacity=".25" stroke-width="2" stroke-dasharray="6 5"/>`}
${plate ? `<rect x="${cx + cw / 2 - cw * 0.17}" y="${cy + cw + gap / 2 - cw * 0.037}" width="${cw * 0.34}" height="${cw * 0.075}" fill="#E4CF9C"/><text x="${cx + cw / 2}" y="${cy + cw + gap / 2 + cw * 0.022}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="${(cw * 0.05).toFixed(1)}" fill="#3A2716">${esc(`${k + 1} · ${plate}`)}</text>` : ''}`;
  }).join('\n');
  return `<defs><linearGradient id="n9frame" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pal.hi}"/><stop offset=".3" stop-color="${pal.frame}"/><stop offset="1" stop-color="${pal.lo}"/></linearGradient>
<linearGradient id="n9shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".55"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
<radialGradient id="n9glow" cx=".5" cy=".3" r=".6"><stop offset="0" stop-color="#FFD682" stop-opacity=".3"/><stop offset="1" stop-color="#FFD682" stop-opacity="0"/></radialGradient></defs>
<rect x="${X + 6}" y="${Y + 18}" width="${W}" height="${W}" fill="#000" fill-opacity=".25"/><rect x="${X}" y="${Y}" width="${W}" height="${W}" rx="4" fill="url(#n9frame)"/>
${cells}`;
}
function my9Svg(g, invite) {
  const W = 1200, H = 630, cw = 165, title = (MY9_PROMPTS[g.prompt] || MY9_PROMPTS.made)[g.lang === 'ja' ? 1 : 0], ja = isJa(title);
  const tl = wrapWords(title, ja ? 11 : 20, 3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#ECEBE6"/>
${cubbySvg(g, 50, 40, cw)}
<text x="660" y="96" font-family="Inter" font-weight="600" font-size="18" letter-spacing="2" fill="#6B675E">MY 9 · 私を構成する9本</text>
${tl.map((l, k) => `<text x="660" y="${158 + k * 60}" font-family="${ja ? 'Shippori Mincho B1' : 'Libre Caslon Text'}" font-weight="700" font-size="50" fill="#1D1B17">${esc(l)}</text>`).join('')}
<text x="660" y="${158 + tl.length * 60 + 4}" font-family="Inter" font-weight="400" font-size="26" fill="#5D5A52">${esc(invite ? 'Make yours on Tana. No account needed.' : clip(g.name, 30))}</text>
<text x="660" y="540" font-family="Inter" font-weight="400" font-size="19" fill="#6B675E">#私を構成する9本 #My9Games</text>
<rect x="660" y="562" width="7" height="26" rx="1" fill="#B4452A"/><rect x="670" y="556" width="7" height="32" rx="1" fill="#2C4A7E"/><rect x="680" y="566" width="7" height="22" rx="1" fill="#2E6A4E"/>
<text x="698" y="586" font-family="Libre Caslon Text" font-weight="700" font-size="26" fill="#1D1B17">Tana</text>
<text x="1150" y="586" text-anchor="end" font-family="Inter" font-weight="400" font-size="19" fill="#6B675E">tana.gamingjapanese.com/my9</text>
</svg>`;
}
// The page behind a shared link: real content for previews and search, then straight on to the app.
function my9Page(g) {
  const url = `${SITE}/my9/${encodeURIComponent(g.username)}/${g.slot}/`, app = `${SITE}/#/my9/u/${encodeURIComponent(g.username)}/${g.slot}`;
  const [en, ja] = MY9_PROMPTS[g.prompt] || MY9_PROMPTS.made;
  const list = (g.cells || []).filter(Boolean);
  return layout({ title: `${g.name}: ${en} | My 9 on Tana`, desc: `${list.map(c => c.t).join(', ')}. ${ja}.`, canonical: url, noindex: true,
    ogImage: `${SITE}/my9/${encodeURIComponent(g.username)}/${g.slot}/grid.png`,
    body: `<script>location.replace(${JSON.stringify(app)});</script>
<section class="profile"><p class="crumb">My 9 · <span lang="ja">私を構成する9本</span></p><h1>${esc(g.name)}: ${esc(en)}</h1>
<ol>${list.map(c => `<li>${esc(c.t)}${c.ja && c.ja !== c.t ? ` <span lang="ja">${esc(c.ja)}</span>` : ''}${c.note ? `: ${esc(c.note)}` : ''}</li>`).join('')}</ol>
<p class="actions"><a class="btn primary" href="${esc(app)}">Open it on Tana</a> <a class="btn" href="${SITE}/#/my9">Make your own</a></p></section>` });
}
function my9Landing() {
  return layout({ title: 'My 9 · 私を構成する9本 | Tana', desc: 'The nine games that made you, on one shelf. Pick the exact version you played, when it got you and why, and get a picture ready to post. Free, no account needed.',
    canonical: `${SITE}/my9/`, ogImage: `${SITE}/my9/card.png`,
    body: `<script>location.replace('/#/my9' + location.search);</script>
<section class="profile"><p class="crumb">New on Tana</p><h1>My 9 <span lang="ja">私を構成する9本</span></h1>
<p class="lede">The nine games that made you, on one shelf. Pick the exact version you played, when it got you and why, and get a picture ready to post. Free, no account needed.</p>
<p class="actions"><a class="btn primary" href="${SITE}/#/my9">Make your My 9</a> <a class="btn" href="${SITE}/#/my9/census">See the census</a></p></section>` });
}
// A sample for the invitation card when nobody has a public grid yet
const MY9_SAMPLE = [['sfc', 'JP', 'Chrono Trigger', 'クロノ・トリガー', 7, 'Nintendo_-_Super_Nintendo_Entertainment_System/Chrono Trigger (Japan)'],
  ['n64', 'JP', 'Super Mario 64', 'スーパーマリオ64', 8, 'Nintendo_-_Nintendo_64/Super Mario 64 (Japan)'],
  ['gb', 'JP', 'Pokémon Red', 'ポケットモンスター赤', 8, 'Nintendo_-_Game_Boy/Pocket Monsters - Aka (Japan) (Rev 1) (SGB Enhanced)'],
  ['ps1', 'JP', 'Final Fantasy VII', 'ファイナルファンタジーVII', 9, 'Sony_-_PlayStation/Final Fantasy VII (Japan)'],
  ['sfc', 'JP', 'EarthBound', 'MOTHER2 ギーグの逆襲', 6, 'Nintendo_-_Super_Nintendo_Entertainment_System/Mother 2 - Gyiyg no Gyakushuu (Japan)'],
  ['ss', 'JP', 'Radiant Silvergun', 'レイディアント シルバーガン', 10, 'Sega_-_Saturn/Radiant Silvergun (Japan)'],
  ['ps1', 'JP', 'Metal Gear Solid', 'メタルギアソリッド', 10, 'Sony_-_PlayStation/Metal Gear Solid (Japan)'],
  ['dc', 'JP', 'Ikaruga', '斑鳩', 14, 'Sega_-_Dreamcast/Ikaruga (Japan)'],
  ['ps2', 'JP', 'Katamari Damacy', '塊魂', 16, 'Sony_-_PlayStation_2/Katamari Damacy (Japan) (v2.00)']];
async function buildMy9(platforms) {
  const grids = SAMPLE ? JSON.parse(await readFile(join(SAMPLE, 'my9.json'), 'utf8').catch(() => '[]')) : await rpc('pages_my9', {}).catch(e => { console.warn('My 9 pages skipped:', e.message); return null; });
  if (!grids) return;
  let Resvg = null, fontFiles = [];
  try {
    ({ Resvg } = await import('@resvg/resvg-js'));
    const req = createRequire(import.meta.url);
    fontFiles = ['@expo-google-fonts/libre-caslon-text/700Bold/LibreCaslonText_700Bold.ttf', '@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf',
                 '@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf', '@expo-google-fonts/shippori-mincho-b1/700Bold/ShipporiMinchoB1_700Bold.ttf'].map(f => req.resolve(f));
  } catch { Resvg = null; }
  const png = svg => new Resvg(svg, { fitTo: { mode: 'width', value: 1200 }, font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();
  await mkdir(join(OUT, 'my9'), { recursive: true });
  await writeIfChanged(join(OUT, 'my9', 'index.html'), my9Landing());
  if (Resvg) for (const g of grids) for (const c of g.cells || []) if (c && c.cov) c.covData = await coverData(c.cov);
  const best = grids.slice().sort((a, b) => (b.cells || []).filter(Boolean).length - (a.cells || []).filter(Boolean).length)[0];
  const sample = best && (best.cells || []).filter(Boolean).length >= 9 ? best : { prompt: 'made', lang: 'en', plates: 'age', style: 'wood:walnut',
    cells: MY9_SAMPLE.map(([pf, reg, t, ja, age, path], k) => { const p = platforms.get(pf) || {}; return { id: `sample-${k}-${t}`, pf, c: p.color, pn: p.name_en, m: p.media, reg, t, ja, age, cov: { s: 'libretro', p: path, a: reg } }; }) };
  if (Resvg) { for (const c of sample.cells) if (c && c.cov && !c.covData) c.covData = await coverData(c.cov); await writeBinIfChanged(join(OUT, 'my9', 'card.png'), png(my9Svg(sample, true))); }
  const keep = new Set(['index.html', 'card.png']);
  let pages = 0;
  for (const g of grids) {
    if (!/^[a-z0-9_.-]{1,40}$/i.test(g.username) || !(g.slot >= 1 && g.slot <= 9)) continue;
    const u = g.username.toLowerCase(), dir = join(OUT, 'my9', u, String(g.slot));
    keep.add(u);
    await mkdir(dir, { recursive: true });
    if (await writeIfChanged(join(dir, 'index.html'), my9Page(g))) pages++;
    if (Resvg) await writeBinIfChanged(join(dir, 'grid.png'), png(my9Svg(g, false)));
  }
  // Grids deleted, emptied or made private lose their pages
  for (const d of await readdir(join(OUT, 'my9')).catch(() => [])) {
    if (keep.has(d)) { if (d !== 'index.html' && d !== 'card.png') for (const s of await readdir(join(OUT, 'my9', d)).catch(() => [])) { if (!grids.some(g => g.username.toLowerCase() === d && String(g.slot) === s)) await rm(join(OUT, 'my9', d, s), { recursive: true, force: true }); } }
    else await rm(join(OUT, 'my9', d), { recursive: true, force: true });
  }
  console.log(`${grids.length} public My 9 grids, ${pages} pages changed`);
}

// ---------- Today's Box (/box/): the share link, with today's opening mosaic as its preview picture ----------
function boxLanding(t) {
  const title = t ? `今日の一箱 No. ${t.no} · Today's Box | Tana` : `今日の一箱 · Today's Box | Tana`;
  const desc = `Guess today's game from its box, revealed one 8-bit mosaic at a time. One box a day for everyone, free.`;
  return layout({ title, desc, canonical: `${SITE}/box/`, ogImage: `${SITE}/box/card.png`, noindex: false,
    body: `<script>location.replace('/#/box' + location.search);</script>
<section class="profile"><p class="crumb">A daily game on Tana</p><h1><span lang="ja">今日の一箱</span> Today's Box</h1>
<p class="lede">${esc(desc)}</p>
<p class="actions"><a class="btn primary" href="${SITE}/#/box">Play today's box</a></p></section>` });
}
// A tiny PNG (8-bit RGB, RGBA or palette, not interlaced) into rows of pixels, so the mosaic can be drawn as crisp squares
function decodePng(buf) {
  let p = 8, w = 0, h = 0, type = 0, depth = 0, pal = null; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString('ascii', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (kind === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; if (d[12]) return null; }
    else if (kind === 'PLTE') pal = d; else if (kind === 'IDAT') idat.push(d); else if (kind === 'IEND') break;
    p += 12 + len;
  }
  if (depth !== 8 || ![2, 3, 6].includes(type)) return null;
  const bpp = type === 6 ? 4 : type === 2 ? 3 : 1, raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * bpp, out = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  const px = (x, y) => { const i = y * stride + x * bpp; return type === 3 ? [pal[out[i] * 3], pal[out[i] * 3 + 1], pal[out[i] * 3 + 2]] : [out[i], out[i + 1], out[i + 2]]; };
  return { w, h, px };
}
function boxCardSvg(t, img) {
  const W = 1200, H = 630, S = 470, X = 70, Y = 80;
  let art = '';
  const m = img && img.buf ? decodePng(img.buf) : null;
  if (m) {
    const r = m.w / m.h; let h = S - 70, w = h * r; if (w > S - 70) { w = S - 70; h = w / r; }
    const x0 = X + (S - w) / 2, y0 = Y + (S - h) / 2, cw = w / m.w, ch = h / m.h, cells = [];
    for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) { const [R, G, B] = m.px(x, y); cells.push(`<rect x="${(x0 + x * cw).toFixed(2)}" y="${(y0 + y * ch).toFixed(2)}" width="${(cw + .6).toFixed(2)}" height="${(ch + .6).toFixed(2)}" fill="rgb(${R},${G},${B})"/>`); }
    art = `<rect x="${x0 + 5}" y="${y0 + 9}" width="${w}" height="${h}" fill="#000" fill-opacity=".45"/>${cells.join('')}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#ECEBE6"/>
<defs><linearGradient id="fr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8B5E3C"/><stop offset=".4" stop-color="#6E4529"/><stop offset="1" stop-color="#4E3020"/></linearGradient>
<linearGradient id="sh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".55"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient></defs>
<rect x="${X - 18 + 6}" y="${Y - 18 + 16}" width="${S + 36}" height="${S + 36}" fill="#000" fill-opacity=".22"/>
<rect x="${X - 18}" y="${Y - 18}" width="${S + 36}" height="${S + 36}" rx="4" fill="url(#fr)"/>
<rect x="${X}" y="${Y}" width="${S}" height="${S}" fill="#2A1C12"/><rect x="${X}" y="${Y}" width="${S}" height="${S * 0.3}" fill="url(#sh)"/>
${art}
<text x="640" y="150" font-family="Inter" font-weight="600" font-size="18" letter-spacing="3" fill="#6B675E">TODAY'S BOX${t ? ` · No. ${t.no}` : ''}</text>
<text x="640" y="232" font-family="Shippori Mincho B1" font-weight="700" font-size="72" fill="#1D1B17">今日の一箱</text>
<text x="640" y="300" font-family="Libre Caslon Text" font-weight="700" font-size="34" fill="#1D1B17">What game is this box?</text>
<text x="640" y="350" font-family="Inter" font-size="23" fill="#5D5A52">Six tries. Each miss sharpens the box.</text>
<text x="640" y="384" font-family="Inter" font-size="23" fill="#5D5A52">A new box every day at midnight in Japan.</text>
${t && t.pn ? `<rect x="640" y="418" width="${18 + t.pn.length * 11.5}" height="38" rx="4" fill="#F7F6F2" stroke="#1D1B17" stroke-width="1.5"/><rect x="654" y="432" width="10" height="10" rx="2" fill="${esc(t.color || '#5E6675')}"/><text x="672" y="443" font-family="Inter" font-weight="600" font-size="17" fill="#1D1B17">${esc(t.pn)}</text>` : ''}
<rect x="640" y="548" width="7" height="26" rx="1" fill="#B4452A"/><rect x="650" y="542" width="7" height="32" rx="1" fill="#2C4A7E"/><rect x="660" y="552" width="7" height="22" rx="1" fill="#2E6A4E"/>
<text x="678" y="572" font-family="Libre Caslon Text" font-weight="700" font-size="26" fill="#1D1B17">Tana</text>
<text x="1130" y="572" text-anchor="end" font-family="Inter" font-size="19" fill="#6B675E">tana.gamingjapanese.com/box</text>
</svg>`;
}
async function buildBox() {
  let t = null, img = null;
  if (!SAMPLE) {
    t = await rpc('daily_box_today', {}).catch(e => { console.warn('Today\'s Box skipped:', e.message); return null; });
    if (t) {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/daily-box?d=${t.day}&s=1`);
        if (res.ok) { const buf = Buffer.from(await res.arrayBuffer()); if (buf.readUInt32BE(12) === 0x49484452) img = { buf }; }
      } catch { img = null; }
    }
  } else {
    t = { no: 1, pn: 'Super Famicom', color: '#6E5BA8' };
    try { img = { buf: await readFile(join(SAMPLE, 'box.png')) }; } catch { img = null; }
  }
  await mkdir(join(OUT, 'box'), { recursive: true });
  await writeIfChanged(join(OUT, 'box', 'index.html'), boxLanding(t));
  let Resvg = null, fontFiles = [];
  try {
    ({ Resvg } = await import('@resvg/resvg-js'));
    const req = createRequire(import.meta.url);
    fontFiles = ['@expo-google-fonts/libre-caslon-text/700Bold/LibreCaslonText_700Bold.ttf', '@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf',
                 '@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf', '@expo-google-fonts/shippori-mincho-b1/700Bold/ShipporiMinchoB1_700Bold.ttf'].map(f => req.resolve(f));
  } catch { Resvg = null; }
  if (Resvg) await writeBinIfChanged(join(OUT, 'box', 'card.png'), new Resvg(boxCardSvg(t, img), { fitTo: { mode: 'width', value: 1200 }, font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng());
  console.log(`Today's Box page${t ? ` (No. ${t.no})` : ''}${img ? ' with its mosaic' : ''}`);
}

async function writeBinIfChanged(path, buf) {
  try { const old = await readFile(path); if (Buffer.compare(old, buf) === 0) return false; } catch {}
  await writeFile(path, buf); return true;
}

async function buildProfiles() {
  const profiles = SAMPLE ? JSON.parse(await readFile(join(SAMPLE, 'profiles.json'), 'utf8')) : await rpc('pages_profiles', {});
  await mkdir(join(OUT, 'u'), { recursive: true });
  let Resvg = null, fontFiles = [];
  try {
    ({ Resvg } = await import('@resvg/resvg-js'));
    const req = createRequire(import.meta.url);
    fontFiles = ['@expo-google-fonts/libre-caslon-text/700Bold/LibreCaslonText_700Bold.ttf', '@expo-google-fonts/inter/400Regular/Inter_400Regular.ttf',
                 '@expo-google-fonts/inter/600SemiBold/Inter_600SemiBold.ttf', '@expo-google-fonts/shippori-mincho-b1/700Bold/ShipporiMinchoB1_700Bold.ttf'].map(f => req.resolve(f));
  } catch (e) { console.warn('Shelf images skipped (renderer or fonts not installed):', e.message); Resvg = null; }
  const keep = new Set();
  let pages = 0, images = 0;
  for (const p of profiles) {
    if (!/^[a-z0-9_.-]{1,40}$/i.test(p.username)) continue;
    const dir = join(OUT, 'u', p.username.toLowerCase());
    keep.add(p.username.toLowerCase());
    await mkdir(join(dir, 'embed'), { recursive: true });
    if (await writeIfChanged(join(dir, 'index.html'), profilePage(p))) pages++;
    await writeIfChanged(join(dir, 'embed', 'index.html'), embedPage(p));
    if (Resvg) {
      const png = new Resvg(shelfSvg(p), { fitTo: { mode: 'width', value: 1200 }, font: { fontFiles, loadSystemFonts: false, defaultFontFamily: 'Inter' } }).render().asPng();
      if (await writeBinIfChanged(join(dir, 'shelf.png'), png)) images++;
    }
  }
  // Collections made private (or renamed) lose their pages
  for (const d of await readdir(join(OUT, 'u')).catch(() => [])) {
    if (!keep.has(d)) await rm(join(OUT, 'u', d), { recursive: true, force: true });
  }
  await writeIfChanged(join(OUT, '404.html'), NOT_FOUND);
  console.log(`${profiles.length} public collections, ${pages} member pages changed, ${images} shelf images changed`);
}

// ---------- Help pages ----------
// Source: help-src/*.md (written by hand). Pages with "status: ready" are published under /help/<slug>/.
// The Markdown used is deliberately small: headings, paragraphs, "- " lists and [links](...).
function parseHelp(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) { const i = line.indexOf(':'); if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return { meta, body: m ? m[2] : text };
}
const COMMUNITY = [['discord.gg/MXWmYAhxUs', 'https://discord.gg/MXWmYAhxUs'], ['r/tanashelf', 'https://www.reddit.com/r/tanashelf/']];
function inline(t, linkFor) {
  let h = esc(t);
  h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a href="${esc(linkFor(href))}">${label}</a>`);
  for (const [text, href] of COMMUNITY) h = h.split(esc(text)).join(`<a href="${href}" rel="noopener">${esc(text)}</a>`);
  return h;
}
function helpHtml(body, linkFor) {
  const out = []; let para = [], list = null;
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '), linkFor)}</p>`); para = []; }
    if (list) { out.push(`<ul>${list.map(li => `<li>${inline(li, linkFor)}</li>`).join('')}</ul>`); list = null; }
  };
  for (const raw of body.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { flush(); const lvl = Math.min(3, h[1].length + 1); out.push(`<h${lvl}>${inline(h[2], linkFor)}</h${lvl}>`); continue; }
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li) { if (para.length) { out.push(`<p>${inline(para.join(' '), linkFor)}</p>`); para = []; } (list = list || []).push(li[1]); continue; }
    if (list) { list[list.length - 1] += ' ' + line.trim(); continue; }
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}
async function buildHelp() {
  const dir = SAMPLE ? join(SAMPLE, 'help-src') : 'help-src';
  let files = [];
  try { files = (await readdir(dir)).filter(f => f.endsWith('.md') && !f.startsWith('_')); } catch { return []; }
  const pages = [];
  for (const f of files) {
    const { meta, body } = parseHelp(await readFile(join(dir, f), 'utf8'));
    if (meta.status !== 'ready') continue;
    pages.push({ file: f, slug: meta.slug || f.replace(/\.md$/, ''), title: meta.title || f, section: meta.section || '', order: meta.order || '', updated: (meta.updated || '').slice(0, 10), body });
  }
  if (!pages.length) return [];
  const key = o => String(o).split('.').map(x => (/^\d+$/.test(x) ? x.padStart(3, '0') : x)).join('.');
  pages.sort((a, b) => key(a.order).localeCompare(key(b.order)));
  const bySlug = new Map(pages.map(p => [p.file, p]));
  const linkFor = href => {
    if (/^https?:/.test(href)) return href;
    const p = bySlug.get(href.replace(/^\.\//, ''));
    return p ? (p.slug === 'index' ? `${SITE}/help/` : `${SITE}/help/${p.slug}/`) : href;
  };
  const index = pages.find(p => p.slug === 'index');
  const topics = pages.filter(p => p.slug !== 'index');
  await rm(join(OUT, 'help'), { recursive: true, force: true });
  await mkdir(join(OUT, 'help'), { recursive: true });
  const urls = [];
  // The contents page
  const indexBody = index ? index.body.replace(/^#\s+.*\n/m, '') : '';
  await writeIfChanged(join(OUT, 'help', 'index.html'), layout({
    title: 'Help · Tana', desc: 'How to use Tana: searching, editions and regions, your collection, photos, sharing and contributing.',
    canonical: `${SITE}/help/`,
    body: `<article class="help">\n<p class="crumb"><a href="${SITE}/">Tana</a></p>\n<h1>Tana help</h1>\n<div class="help-toc">${helpHtml(indexBody, linkFor)}</div>\n</article>`,
  }));
  urls.push({ loc: `${SITE}/help/`, lastmod: (index && index.updated) || topics[0].updated });
  // One page per topic, with previous / next
  for (let i = 0; i < topics.length; i++) {
    const p = topics[i], prev = topics[i - 1], next = topics[i + 1];
    const content = helpHtml(p.body.replace(/^#\s+.*\n/m, ''), linkFor);
    const plain = p.body.replace(/^#\s+.*\n/m, '').replace(/[#\[\]()*-]/g, ' ').replace(/\s+/g, ' ').trim();
    await mkdir(join(OUT, 'help', p.slug), { recursive: true });
    await writeIfChanged(join(OUT, 'help', p.slug, 'index.html'), layout({
      title: `${p.title} · Tana help`, desc: plain.slice(0, 155), canonical: `${SITE}/help/${p.slug}/`,
      body: `<article class="help">
<p class="crumb"><a href="${SITE}/help/">Help</a>${p.section ? `, ${esc(p.section)}` : ''}</p>
<h1>${esc(p.title)}</h1>
${content}
<nav class="help-nav" aria-label="More help">
  ${prev ? `<a class="help-prev" href="${SITE}/help/${prev.slug}/"><span>Previous</span>${esc(prev.title)}</a>` : '<span></span>'}
  ${next ? `<a class="help-next" href="${SITE}/help/${next.slug}/"><span>Next</span>${esc(next.title)}</a>` : '<span></span>'}
</nav>
<p class="help-all"><a href="${SITE}/help/">All help topics</a> · <a href="${SITE}/">Open Tana</a></p>
</article>`,
    }));
    urls.push({ loc: `${SITE}/help/${p.slug}/`, lastmod: p.updated });
  }
  console.log(`${topics.length} help pages`);
  return urls;
}

main().catch(e => { console.error(e); process.exit(1); });
