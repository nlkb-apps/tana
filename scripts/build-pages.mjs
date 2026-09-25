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
import { createRequire } from 'node:module';

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
function layout({ title, desc, canonical, body, jsonld, platformColor, ogImage, noindex }) {
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
    <div class="spine" aria-hidden="true"><span class="spine-title" lang="${hasJa(spineText) ? 'ja' : 'en'}">${esc(spineText)}</span><span class="spine-plat">${esc(platform.short_name)}</span></div>
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
    ...(jans.length ? { gtin13: jans[0] } : {}),
    inLanguage: 'ja',
  };

  return layout({ title: `${primary}${ja ? ` (${ja})` : ''}, ${platform.short_name} | Tana 棚`, desc, canonical, body, jsonld, platformColor: platform.color });
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
  await writeIfChanged(join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapIndex.map(s => `<sitemap><loc>${esc(s.loc)}</loc>${s.lastmod ? `<lastmod>${s.lastmod.slice(0, 10)}</lastmod>` : ''}</sitemap>`).join('\n')}\n</sitemapindex>\n`);
  await writeIfChanged(join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
  await writeIfChanged(join(OUT, '.nojekyll'), '');
  await buildProfiles();

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
function shelfSvg(p) {
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
    const room = b.bh - 26 - 18, cap = Math.max(2, Math.floor(room / (fs * (ja ? 1.04 : 0.6))));
    const cx = x + b.bw / 2;
    return `<g><rect x="${x}" y="${y}" width="${b.bw}" height="${b.bh}" rx="2" fill="${esc(b.c)}"/>
<rect x="${x}" y="${y}" width="${b.bw}" height="${b.bh}" rx="2" fill="url(#gloss)"/>
<rect x="${x + 4}" y="${y + 6}" width="${b.bw - 8}" height="1.5" fill="#FFFFFF" fill-opacity=".45"/>
<text x="${cx}" y="${y + 16}" writing-mode="tb" font-family="${ja ? 'Shippori Mincho B1' : 'Inter'}" font-weight="${ja ? 700 : 600}" font-size="${fs.toFixed(1)}" fill="#FFFFFF">${esc(clip(b.t, cap))}</text>
<text x="${cx}" y="${floor - 6}" text-anchor="middle" font-family="Inter" font-weight="600" font-size="9" fill="#FFFFFF" fill-opacity=".85">${esc(clip(b.s, Math.max(2, Math.floor(b.bw / 6))))}</text></g>`;
  }).join('\n');
  const name = clip(p.display_name, 28);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs><linearGradient id="gloss" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".24"/><stop offset=".26" stop-color="#FFFFFF" stop-opacity=".05"/><stop offset=".56" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity=".3"/></linearGradient>
<linearGradient id="plank" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#C39162"/><stop offset=".2" stop-color="#A8764A"/><stop offset=".7" stop-color="#A8764A"/><stop offset="1" stop-color="#75492A"/></linearGradient>
<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000000" stop-opacity=".4"/><stop offset="1" stop-color="#000000" stop-opacity="0"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="#ECEBE6"/>
<rect x="${left}" y="54" width="7" height="30" rx="1" fill="#B4452A"/><rect x="${left + 10}" y="48" width="7" height="36" rx="1" fill="#2C4A7E"/><rect x="${left + 20}" y="58" width="7" height="26" rx="1" fill="#2E6A4E"/>
<text x="${left + 38}" y="82" font-family="Libre Caslon Text" font-weight="700" font-size="30" fill="#1D1B17">Tana</text>
<text x="${right}" y="82" text-anchor="end" font-family="Inter" font-weight="400" font-size="20" fill="#6B675E">tana.gamingjapanese.com</text>
<text x="${left}" y="170" font-family="Libre Caslon Text" font-weight="700" font-size="58" fill="#1D1B17">${esc(name)}’s shelf</text>
<text x="${left}" y="218" font-family="Inter" font-weight="400" font-size="26" fill="#5D5A52">${esc(statsLine(p))}</text>
<rect x="${left}" y="${top - 12}" width="${right - left}" height="12" fill="#75492A"/>
<rect x="${left}" y="${top}" width="${right - left}" height="${floor - top}" fill="#3D2B1E"/>
<rect x="${left + 14}" y="${top}" width="${right - left - 28}" height="34" fill="url(#shade)"/>
<rect x="${left}" y="${top}" width="14" height="${floor - top + 22}" fill="#75492A"/><rect x="${right - 14}" y="${top}" width="14" height="${floor - top + 22}" fill="#75492A"/>
${spines}
<rect x="${left}" y="${floor}" width="${right - left}" height="22" fill="url(#plank)"/>
${more ? `<text x="${right - 24}" y="${floor - 14}" text-anchor="end" font-family="Inter" font-weight="600" font-size="18" fill="#E9DFD2">+ ${Number(more).toLocaleString('en-US')} more</text>` : ''}
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
    return `<span class="pbook${b.startGroup ? ' pgap' : ''}" style="--obi:${esc(b.c)};--h:${b.h}px;--w:${b.w}px;--fs:${fs(b.w)}px" title="${esc(b.t)}"><span class="pbook-t"${isJa(b.t) ? ' lang="ja"' : ''}>${esc(b.t)}</span><span class="pbook-p">${esc(b.s)}</span></span>`;
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
  <div class="pcase">${shelfHtml(p.books || []) || '<p class="pcase-empty">The shelf is empty for now.</p>'}</div>
  ${(p.editions || 0) > (p.books || []).length ? `<p class="muted">Showing ${(p.books || []).length} of ${Number(p.editions).toLocaleString('en-US')} editions.</p>` : ''}
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
<span class="pcase one">${shelfHtml(books, 40, 4000)}</span>
<span class="embed-foot">View on Tana</span></a></body></html>
`;
}

const NOT_FOUND = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Tana</title><meta name="robots" content="noindex">
<script>
// Share links for members whose page has not been built yet (pages are built nightly) open the app instead
var m = location.pathname.match(/^\\/u\\/([^\\/]+)/);
location.replace(m ? '/#/u/' + m[1] : '/');
</script></head><body><p><a href="/">Tana</a></p></body></html>
`;

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

main().catch(e => { console.error(e); process.exit(1); });
