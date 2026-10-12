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
json.dump({'repos':{v:k for k,v in REPO2PF.items()},'cands':cands},open(B+'/out/cands.json','w'),ensure_ascii=False,separators=(',',':'))
print(n,'thumbs',withk,'with serial keys',os.path.getsize(B+'/out/cands.json')//1024,'KB')
