#!/usr/bin/env python3
"""Stage 2: resolve wikilink redirects, group engravings by canonical article (identity),
attach captaincy / Conn Smythe / runner-up metadata, emit dataset.full.json (1915-2026).

After this stage, run `node communities.mjs` - it bakes the dynasty communities into
dataset.full.json and writes the app copy (src/data/dataset.json). This script alone does
NOT produce the app data."""
import urllib.request, urllib.parse, json, re, os, unicodedata, time
from collections import defaultdict, Counter

HERE=os.path.dirname(os.path.abspath(__file__))
S=json.load(open(os.path.join(HERE,"_stage_rosters.json")))
R={int(y):v for y,v in S["rosters"].items()}
IB={int(y):v for y,v in S["infobox"].items()}
CHAMPS=[(int(y),a) for (y,a) in S["champs"]]; TEAMNAME=S["teamname"]; abbr_of=dict(CHAMPS)
# Verified metadata (runner-up adjudications + Conn Smythe 1968+) lives in a committed source
# file, NOT in this script's own prior output - so a from-scratch rebuild is reproducible.
OV=json.load(open(os.path.join(HERE,"verified_overrides.json")))
# Engraving corrections, verified against sources INDEPENDENT of the Finals articles (band
# photos, player biographies, the engraving chronology): Wikipedia's engraving template
# occasionally lists a championship-roster player who was never actually engraved (Ken Mallen
# 1915 - left off by mistake; Al Smith 1967 - omitted for not playing in the playoffs), and
# expands one name no source supports ('W. Teale, first name unknown' -> 'William').
EXCL={int(y):set(v) for y,v in OV.get("excludeEngravings",{}).items()}
RENAME=OV.get("renamePlayers",{})
for y in list(R):
    if y in EXCL: R[y]=[e for e in R[y] if e["display"] not in EXCL[y]]
    for e in R[y]:
        if e["display"] in RENAME: e["display"]=RENAME[e["display"]]
REDIR_CACHE=os.path.join(HERE,"redirects.json")
UA={"User-Agent":"StanleyCupETL/2.0 (hockey viz; redirect resolve)"}
CS_EARLY={1965:"Jean Béliveau",1966:"Roger Crozier",1967:"Dave Keon"}
# Conn Smythe winners who played for the LOSING finalist - not on the champion's engraved
# roster, so there's no player node to flag; the name shows on the champion's cup only.
CS_LOSERS={1966:"Roger Crozier",1968:"Glenn Hall",1976:"Reggie Leach",
           1987:"Ron Hextall",2003:"Jean-Sébastien Giguère",2024:"Connor McDavid"}

API="https://en.wikipedia.org/w/api.php"
def api_post(params,tries=8):
    params={**params,"format":"json","formatversion":"2"}
    data=urllib.parse.urlencode(params).encode()
    for k in range(tries):
        try:
            req=urllib.request.Request(API,data=data,headers={**UA,"Content-Type":"application/x-www-form-urlencoded"})
            return json.load(urllib.request.urlopen(req,timeout=60))
        except urllib.error.HTTPError as e:
            if e.code==429 and k<tries-1: time.sleep(min(90,15*(k+1))); continue
            if k<tries-1: time.sleep(6*(k+1)); continue
            raise
        except Exception:
            if k<tries-1: time.sleep(6*(k+1)); continue
            raise

# ---- redirect resolution for every unique wikilink target ----
targets=sorted({e["link"] for y in R for e in R[y] if e["link"]})
cache=json.load(open(REDIR_CACHE)) if os.path.exists(REDIR_CACHE) else {}
todo=[t for t in targets if t not in cache]
print(f"{len(targets)} unique link targets; resolving {len(todo)} uncached…")
if todo: time.sleep(20)   # cool down after the article fetch
for i in range(0,len(todo),40):
    chunk=todo[i:i+40]
    d=api_post({"action":"query","titles":"|".join(chunk),"redirects":"1"})
    q=d["query"]
    nmap={r["from"]:r["to"] for r in q.get("normalized",[])}
    rmap={r["from"]:r["to"] for r in q.get("redirects",[])}
    for t in chunk:
        cur=t; seen=set()
        while cur in nmap and cur not in seen: seen.add(cur); cur=nmap[cur]
        for _ in range(6):
            if cur in rmap and cur not in seen: seen.add(cur); cur=rmap[cur]
            else: break
        cache[t]=cur
    json.dump(cache,open(REDIR_CACHE,"w"))   # checkpoint each batch
    print(f"  resolved {min(i+40,len(todo))}/{len(todo)}")
    time.sleep(2.5)
def canon(link): return cache.get(link, link)

SUFFIX={"sr","jr","ii","iii","iv"}
def _toks(s):
    s=unicodedata.normalize('NFD',s or ''); s=''.join(c for c in s if unicodedata.category(c)!='Mn')
    s=re.sub(r'[^a-z0-9 ]',' ',s.lower()); return [t for t in s.split() if t not in SUFFIX]
def norm(s): return ''.join(_toks(s))
def strip_qual(t): return re.sub(r'\s*\([^)]*\)\s*$','',t or '').strip()
def name_match(a,b):
    """True if display names a,b plausibly denote one person - handles a short first name
    ('Alex' vs the article title 'Alexander') and accent/spelling variants (via _toks)."""
    ta,tb=_toks(strip_qual(a)),_toks(strip_qual(b))
    if not ta or not tb: return False
    if ''.join(ta)==''.join(tb): return True
    if ta[-1]!=tb[-1]: return False                 # surnames must match
    fa,fb=ta[0],tb[0]
    return fa==fb or fa.startswith(fb) or fb.startswith(fa)
POSRANK={'C':5,'LW':4,'RW':4,'D':3,'G':6,'F':1}

# ---- metadata maps ----
runnerUp={}; connName={}
for (y,ab) in CHAMPS:
    runnerUp[y]=IB[y][1] or ""
for y,v in OV["runnerUp"].items():   runnerUp[int(y)]=v      # verified overrides beat the infobox parse
for y,v in OV["connSmythe"].items(): connName[int(y)]=v
connName.update(CS_EARLY)
connName.update(CS_LOSERS)   # ensure every losing-team Conn Smythe year is populated, not just 1966

# ---- group engravings into players keyed by canonical article (link) or name ----
players={}   # key -> rec
def keyfor(e):
    return ("L",canon(e["link"])) if e["link"] else ("N",norm(e["display"]))
# first pass: register linked players so unlinked can attach by name
norm_to_key={}
for y in sorted(R):
    for e in R[y]:
        k=keyfor(e)
        if k[0]=="L": norm_to_key.setdefault(norm(strip_qual(k[1])), k)
def resolved_key(e):
    if e["link"]: return ("L",canon(e["link"]))
    nk=norm(e["display"])
    return norm_to_key.get(nk, ("N",nk))   # attach unlinked entry to a linked player of same name

# Period-correct franchise names: Chicago wrote "Black Hawks" (two words) from 1926 until the
# summer of 1986, so its 1934/1938/1961 championships are engraved that way; runner-up strings
# (parsed from period Wikipedia infoboxes) already use the two-word form for those years.
def team_name(ab,y):
    if ab=="CHI" and y<=1986: return "Chicago Black Hawks"
    return TEAMNAME[ab]

spellings=defaultdict(Counter); champions=[]
for (y,ab) in CHAMPS:
    team=team_name(ab,y)
    cs=connName.get(y)
    rec={"year":y,"team":team,"abbr":ab,"runnerUp":runnerUp.get(y,""),
         "connSmythe":cs if cs else None,"playerCount":len(R[y])}
    series=IB[y][3] if len(IB[y])>3 else None   # "4–2" champion-first, from build_full's infobox parse
    if series: rec["series"]=series             # omitted entirely when the infobox gave no clean game tally
    champions.append(rec)
    # infobox champion captain identity (norm)
    cap_ib=norm(IB[y][2]) if IB[y][2] else None
    for e in R[y]:
        k=resolved_key(e)
        disp=strip_qual(canon(e["link"])) if e["link"] else e["display"]
        spellings[k][disp]+=1
        rec=players.get(k)
        if not rec: rec=players[k]={"key":k,"position":e["position"],"cups":[],"_y":{}}
        if POSRANK.get(e["position"],0)>POSRANK.get(rec["position"],0): rec["position"]=e["position"]
        is_cap = e["captain"] or (cap_ib is not None and norm(disp)==cap_ib)
        # tolerant match so a short award-name form ('Alex Ovechkin') still binds to the
        # canonical roster node ('Alexander Ovechkin'); exact norm-equality missed those.
        is_cs  = (cs is not None and name_match(disp, cs))
        if y in rec["_y"]:
            c=rec["_y"][y]
            c["captain"]=c["captain"] or is_cap; c["connSmythe"]=c["connSmythe"] or is_cs
            continue
        c={"year":y,"abbr":ab,"team":team,"captain":is_cap,"connSmythe":is_cs}
        rec["_y"][y]=c; rec["cups"].append(c)

# Manual merges confirmed by the correlation-audit workflow (same person, two nodes).
# Each pair is [displayNameA, displayNameB]; their cups are unioned into one player.
MANUAL_MERGE=[
]
def apply_merges(recs_by_key):
    by_name={}
    for rec in recs_by_key.values():
        by_name.setdefault(rec.get("name") or rec["_disp"], rec)
    for a,b in MANUAL_MERGE:
        ra,rb=by_name.get(a),by_name.get(b)
        if not ra or rb is None or ra is rb:
            print("  MERGE SKIP (not found / same):",a,"+",b); continue
        ya={c["year"] for c in ra["cups"]}
        for c in rb["cups"]:
            if c["year"] not in ya: ra["cups"].append(c); ya.add(c["year"])
        if POSRANK.get(rb["position"],0)>POSRANK.get(ra["position"],0): ra["position"]=rb["position"]
        rb["_merged_into"]=ra
        print("  MERGED:",b,"->",a)

playerList=[]
for k,rec in players.items():
    rec["_disp"]=sorted(spellings[k].items(), key=lambda kv:(-kv[1],-len(kv[0])))[0][0]
apply_merges(players)
for k,rec in players.items():
    if rec.get("_merged_into"): continue
    best=sorted(spellings[k].items(), key=lambda kv:(-kv[1],-len(kv[0])))[0][0]
    pid = norm(best) or norm(k[1])
    rec["name"]=best; rec["id"]=pid; rec.pop("_y",None); rec.pop("_disp",None)
    rec["cups"].sort(key=lambda c:c["year"]); rec["cupCount"]=len(rec["cups"]); rec.pop("key",None)
    playerList.append(rec)
# guarantee unique ids (norm collisions of genuinely different people keep distinct keys)
seen_id={}
for p in playerList:
    base=p["id"]; i=2
    while p["id"] in seen_id: p["id"]=f"{base}-{i}"; i+=1
    seen_id[p["id"]]=1
playerList.sort(key=lambda p:(-p["cupCount"],p["name"]))
champions.sort(key=lambda c:c["year"])
# Canonicalize each champion's Conn Smythe name to the matched on-roster player's node name so
# the cup tooltip and that player's node/tooltip agree (e.g. 'Alex'->'Alexander Ovechkin',
# 'Nicklas Lidstrom'->'Nicklas Lidström'); losing-team winners keep their free-text name.
cs_by_year={}
for p in playerList:
    for c in p["cups"]:
        if c.get("connSmythe"): cs_by_year[c["year"]]=p["name"]
for ch in champions:
    nm=cs_by_year.get(ch["year"])
    if nm: ch["connSmythe"]=nm
years=[c["year"] for c in champions]
dataset={"window":{"startYear":min(years),"endYear":max(years),
  "note":f"Engraved players for every Stanley Cup champion {min(years)}-{max(years)} "
         f"(no Cup 1919 - cancelled; 2005 - lockout). Rosters parsed deterministically from each "
         f"year's Wikipedia 'Stanley Cup champion' engraving template; player identity keyed on the "
         f"engraving's wikilink target (redirect-resolved), so name variants merge."},
  "champions":champions,"players":playerList,
  "stats":{"seasons":len(champions),"totalPlayers":len(playerList),
           "multiCupPlayers":sum(1 for p in playerList if p["cupCount"]>=2),
           "totalEngravings":sum(p["cupCount"] for p in playerList)}}
json.dump(dataset,open(os.path.join(HERE,"dataset.full.json"),"w"))

# ---- report ----
sp=sum(c["playerCount"] for c in champions); se=sum(p["cupCount"] for p in playerList)
print("DATASET",dataset["window"]["startYear"],"-",dataset["window"]["endYear"],dataset["stats"])
print("sum playerCount",sp,"== sum cupCount",se,":","OK" if sp==se else "MISMATCH")
print("\nMost Cups (all-time):")
for p in playerList[:14]:
    print(f"  {p['cupCount']:2}x {p['name']:24} {p['position']:2} "+"/".join(f"{c['year']}{c['abbr']}" for c in p['cups']))
print("\nMaroon check:", [f"{p['name']} {p['cupCount']} {[c['year'] for c in p['cups']]}" for p in playerList if 'maroon' in p['name'].lower()])
print("Beliveau check:", [f"{p['name']} {p['cupCount']} {[str(c['year'])+c['abbr'] for c in p['cups']]}" for p in playerList if 'liveau' in p['name'].lower()])
print("Kelly (Red):", [f"{p['name']} {[str(c['year'])+c['abbr'] for c in p['cups']]}" for p in playerList if p['name'].lower()=='red kelly'])
print("wrote dataset.full.json")
