#!/usr/bin/env python3
"""Box art candidates for Tana: every box-art file name in libretro-thumbnails, by Tana platform,
with serial keys from the libretro-database DATs. Writes cands.json, which the database loads with covers_load().
Run weekly by .github/workflows/covers-data.yml. Usage: python3 scripts/covers-cands.py WORKDIR"""
import re, json, os, glob, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
B = sys.argv[1] if len(sys.argv) > 1 else 'covers-work'
os.makedirs(B + '/lists', exist_ok=True); os.makedirs(B + '/out', exist_ok=True)
M = B + '/ldb/metadat'
REPO2PF={'Nintendo_-_Nintendo_Entertainment_System':'fc','Nintendo_-_Family_Computer_Disk_System':'fds','Nintendo_-_Super_Nintendo_Entertainment_System':'sfc','Nintendo_-_Nintendo_64':'n64','Nintendo_-_Nintendo_64DD':'n64dd','Nintendo_-_Game_Boy':'gb','Nintendo_-_Game_Boy_Color':'gbc','Nintendo_-_Game_Boy_Advance':'gba','Nintendo_-_Nintendo_DS':'nds','Nintendo_-_Nintendo_3DS':'n3ds','Nintendo_-_GameCube':'gc','Nintendo_-_Wii':'wii','Nintendo_-_Wii_U':'wiiu','Nintendo_-_Virtual_Boy':'vb','Nintendo_-_Pokemon_Mini':'pokemini','Nintendo_-_Sufami_Turbo':'strom','Sony_-_PlayStation':'ps1','Sony_-_PlayStation_2':'ps2','Sony_-_PlayStation_Portable':'psp','Sony_-_PlayStation_3':'ps3','Sony_-_PlayStation_Vita':'vita','Sony_-_PlayStation_4':'ps4','Sega_-_Mega_Drive_-_Genesis':'md','Sega_-_Mega-CD_-_Sega_CD':'mcd','Sega_-_32X':'s32x','Sega_-_Saturn':'ss','Sega_-_Dreamcast':'dc','Sega_-_Game_Gear':'gg','Sega_-_Master_System_-_Mark_III':'mk3','Sega_-_SG-1000':'sg1000','Sega_-_PICO':'pico','NEC_-_PC_Engine_-_TurboGrafx_16':'pce','NEC_-_PC_Engine_CD_-_TurboGrafx-CD':'pcecd','NEC_-_PC_Engine_SuperGrafx':'sgx','NEC_-_PC-FX':'pcfx','NEC_-_PC-98':'pc98','NEC_-_PC-8001_-_PC-8801':'pc88','SNK_-_Neo_Geo':'neogeo','SNK_-_Neo_Geo_CD':'neocd','SNK_-_Neo_Geo_Pocket':'ngp','SNK_-_Neo_Geo_Pocket_Color':'ngpc','Bandai_-_WonderSwan':'ws','Bandai_-_WonderSwan_Color':'wsc','Microsoft_-_MSX':'msx','Microsoft_-_MSX2':'msx2','Sharp_-_X68000':'x68k','The_3DO_Company_-_3DO':'3do','Microsoft_-_Xbox':'xbox','Microsoft_-_Xbox_360':'x360','Casio_-_Loopy':'loopy','Casio_-_PV-1000':'pv1000','Epoch_-_Super_Cassette_Vision':'scv'}
def run(*a): subprocess.run(a, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def listing(repo):
  d = f'{B}/tmp_{repo}'
  subprocess.run(['rm', '-rf', d])
  run('git', 'clone', '-q', '--filter=blob:none', '--no-checkout', '--depth', '1', f'https://github.com/libretro-thumbnails/{repo}', d)
  out = subprocess.run(['git', '-C', d, 'ls-tree', '-r', '--name-only', 'HEAD'], check=True, capture_output=True, text=True).stdout
  open(f'{B}/lists/{repo}.txt', 'w', encoding='utf-8').write('\n'.join(l for l in out.splitlines() if l.startswith('Named_Boxarts/')))
  subprocess.run(['rm', '-rf', d])
if not os.path.exists(M):
  run('git', 'clone', '-q', '--filter=blob:none', '--no-checkout', '--depth', '1', 'https://github.com/libretro/libretro-database', B + '/ldb')
  run('git', '-C', B + '/ldb', 'sparse-checkout', 'set', '--no-cone', 'metadat/redump/*', 'metadat/no-intro/*', 'metadat/serial/*')
  run('git', '-C', B + '/ldb', 'checkout', '-q')
with ThreadPoolExecutor(8) as ex: list(ex.map(listing, REPO2PF.keys()))
NIN={'gb','gbc','gba','nds','n3ds','n64','n64dd','gc','wii','wiiu','sfc','vb','fc'}
def tn(n): return re.sub(r'[&*/:`<>?\\|"]','_',n)
def keys(code, pf):
  out=set()
  for c in re.split(r'[,;]\s*', code.upper()):
    c=c.strip()
    if not c: continue
    full=re.sub(r'[^A-Z0-9]','',c)
    if len(full)>=3: out.add('S:'+full)
    m=re.match(r'^([A-Z0-9]+)-([A-Z0-9]+)',c)
    if m and re.search('[0-9]',m.group(1)+m.group(2)): out.add('S:'+m.group(1)+m.group(2))
    if pf in NIN:
      seg=[s for s in c.split('-') if s]
      cand=[s for s in (seg[1:] if len(seg)>1 else seg) if len(s)==4 and re.search('[A-Z]',s) and s not in('SHVC','SNSP')]
      if cand: out.add('G:'+cand[0])
  return out
ser={}  # (pf, thumbname) -> keys
for f in glob.glob(M+'/redump/*.dat')+glob.glob(M+'/serial/*.dat')+glob.glob(M+'/no-intro/*.dat'):
  sysname=os.path.basename(f)[:-4].replace(' ','_')
  pf=REPO2PF.get(sysname)
  if not pf:
    # tolerate naming differences
    alt={'Microsoft_-_MSX_2':'msx2'}; pf=alt.get(sysname)
  if not pf: continue
  txt=open(f,encoding='utf-8',errors='replace').read()
  for blk in re.split(r'\ngame \(',txt):
    nm=re.search(r'\n\t(?:name|comment) "([^"]+)"',blk)
    if not nm: continue
    ss=set(re.findall(r'serial "([^"]+)"',blk))
    if not ss: continue
    k=ser.setdefault((pf,tn(nm.group(1))),set())
    for s in ss: k|=keys(s,pf)
cands={}; n=0; withk=0
for r,pf in REPO2PF.items():
  p=f'{B}/lists/{r}.txt'
  if not os.path.exists(p): continue
  for line in open(p,encoding='utf-8'):
    line=line.strip()
    if not line.endswith('.png'): continue
    stem=line[len('Named_Boxarts/'):-4]
    k=sorted(ser.get((pf,stem),()))
    if k: withk+=1
    cands.setdefault(pf,[]).append([stem]+k); n+=1
# ---------- GameTDB (the database behind the Wii/DS USB loaders): PS3, Switch, Wii, GameCube, Wii U, DS, 3DS ----------
# Game lists come from gametdb.com/<db>.txt ("ID = Title"); every cover URL is checked with a HEAD request before it is listed.
import urllib.request, unicodedata
UA = {'User-Agent': 'TanaCovers/1.0 (+https://tana.gamingjapanese.com)'}
def get(url, tries=3):
  for k in range(tries):
    try: return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read().decode('utf-8', 'replace')
    except Exception as e: err = e
  print('skip', url, err); return ''
import time
T0 = time.time(); BUDGET = float(os.environ.get('GAMETDB_BUDGET_MIN', '45')) * 60
def head(url):
  # a one-byte GET: works whether or not the server answers HEAD
  if time.time() - T0 > BUDGET: return None
  try:
    req = urllib.request.Request(url, headers={**UA, 'Range': 'bytes=0-0'})
    with urllib.request.urlopen(req, timeout=8) as r: return r.status in (200, 206)
  except urllib.error.HTTPError as e: return False
  except Exception: return False
def tdb(db, lang):
  out = {}
  for line in get(f'https://www.gametdb.com/{db}.txt?LANG={lang}').splitlines():
    if ' = ' not in line or line.startswith('TITLES'): continue
    i, t = line.split(' = ', 1); out[i.strip()] = t.strip()
  return out
LETTER = {'E': ['NA'], 'J': ['JP'], 'K': ['KR'], 'W': ['AS'], 'A': ['NA', 'EU', 'JP']}
FOLDERS = {'NA': ['US'], 'JP': ['JA'], 'KR': ['KO'], 'AS': ['ZH', 'EN'], 'EU': ['EN', 'FR', 'DE']}
def letter_regs(c): return LETTER.get(c, ['EU'])
PS3P = {'BLUS': 'NA', 'BCUS': 'NA', 'BLES': 'EU', 'BCES': 'EU', 'BLJM': 'JP', 'BLJS': 'JP', 'BCJS': 'JP', 'BCJM': 'JP', 'BLJB': 'JP', 'BCJB': 'JP', 'BLAS': 'AS', 'BCAS': 'AS', 'BLKS': 'KR', 'BCKS': 'KR'}
DBS = [  # db, art dir, extension, how to read the region, Tana platform for an id
  ('ps3tdb', 'ps3', 'jpg', lambda i: [PS3P[i[:4]]] if i[:4] in PS3P else [], lambda i: 'ps3'),
  ('wiitdb', 'wii', 'png', lambda i: letter_regs(i[3]) if len(i) == 6 else [], lambda i: 'gc' if i[0] in 'GD' else 'wii'),
  ('wiiutdb', 'wiiu', 'jpg', lambda i: letter_regs(i[3]) if len(i) == 6 else [], lambda i: 'wiiu'),
  ('dstdb', 'ds', 'jpg', lambda i: letter_regs(i[3]) if len(i) == 4 else [], lambda i: 'nds'),
  ('3dstdb', '3ds', 'jpg', lambda i: letter_regs(i[3]) if len(i) == 4 else [], lambda i: 'n3ds'),
  ('switchtdb', 'switch', 'jpg', lambda i: ['NA', 'JP', 'EU'], lambda i: 'switch'),
]
gt = {}; checks = []
for db, art, ext, regs_of, pf_of in DBS:
  en, ja = tdb(db, 'EN'), tdb(db, 'JA')
  print(db, len(en), 'titles')
  for i, t in en.items():
    if not re.fullmatch(r'[A-Z0-9]{4,10}', i): continue
    for reg in regs_of(i):
      checks.append((db, art, ext, i, reg, t, ja.get(i, ''), pf_of(i)))
# the games most likely to be on Tana first: retail PS3, then Switch, Wii, DS, 3DS, Wii U; eShop/WiiWare-style ids last
order = {'ps3tdb': 0, 'switchtdb': 1, 'wiitdb': 2, 'dstdb': 3, '3dstdb': 4, 'wiiutdb': 5}
checks.sort(key=lambda c: (order[c[0]], {'NA': 0, 'JP': 1, 'EU': 2}.get(c[4], 3)))
done = [0]
def probe(c):
  db, art, ext, i, reg, t, tj, pf = c
  done[0] += 1
  if done[0] % 5000 == 0: print(done[0], 'checked', int(time.time() - T0), 's', flush=True)
  for f in FOLDERS[reg]:
    ok = head(f'https://art.gametdb.com/{art}/cover/{f}/{i}.{ext}')
    if ok is None: return None
    if ok: return (c, f)
  return None
with ThreadPoolExecutor(64) as ex: found = [x for x in ex.map(probe, checks) if x]
for (db, art, ext, i, reg, t, tj, pf), f in found:
  keys = {'S:' + i}
  if pf in ('wii', 'gc', 'wiiu'): keys.add('G:' + i[:4])
  if pf in ('nds', 'n3ds'): keys.add('G:' + i)
  if pf == 'switch': keys.add('G:' + i[:5])
  gt.setdefault(pf, []).append([f'{art}/cover/{f}/{i}.{ext}', t, tj, reg] + sorted(keys))
print('gametdb', len(checks), 'checked,', len(found), 'covers')
json.dump({'repos':{v:k for k,v in REPO2PF.items()},'cands':cands,'gametdb':gt},open(B+'/out/cands.json','w'),ensure_ascii=False,separators=(',',':'))
print(n,'thumbs',withk,'with serial keys',os.path.getsize(B+'/out/cands.json')//1024,'KB')
