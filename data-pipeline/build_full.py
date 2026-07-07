#!/usr/bin/env python3
"""Fetch/parse (EXTRACT) stage of the Stanley Cup data pipeline - 1915 through present.

This script only downloads and parses; it writes the intermediate _stage_rosters.json.
The transform/load stages live in resolve_build.py (redirect resolution, wikilink-keyed
identity grouping - so name variants pointing at the same person merge: Pat/Patrick
Maroon, Red/Leonard Kelly, Gump/Lorne Worsley - and dataset assembly) and
communities.mjs (dynasty community detection, the only writer of src/data/dataset.json).

Source of truth: each '<year> Stanley Cup Final' Wikipedia article:
  * {{Stanley Cup champion}} engraving template -> roster (position + captaincy)
  * {{Infobox Stanley Cup Final}} -> champion (bolded team) + runner-up
Every value is parsed from source, nothing generated; fully cache-backed.

Challenge era (1893-1914) is intentionally excluded: those years have no standard
'Stanley Cup Final' article / engraving template (multiple challenges per season,
defunct leagues). 1919 (cancelled, Spanish flu) and 2005 (lockout) have no champion.
"""
import urllib.request, urllib.parse, json, re, os, sys, unicodedata, time
from collections import defaultdict, Counter

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "wiki_cache"); os.makedirs(CACHE, exist_ok=True)
REDIR_CACHE = os.path.join(HERE, "redirects.json")
EXISTING = os.path.join(os.path.dirname(HERE), "src", "data", "dataset.json")
OUT = os.path.join(HERE, "dataset.full.json")
UA = {"User-Agent": "StanleyCupETL/2.0 (personal hockey data viz)"}

# (year, abbr, full name). Omitted: 1919 (cancelled), 2005 (lockout).
CHAMPS = [
 (1915,"VML"),(1916,"MTL"),(1917,"SEA"),(1918,"TOA"),(1920,"OTS"),(1921,"OTS"),(1922,"TSP"),
 (1923,"OTS"),(1924,"MTL"),(1925,"VIC"),(1926,"MMR"),(1927,"OTS"),(1928,"NYR"),(1929,"BOS"),
 (1930,"MTL"),(1931,"MTL"),(1932,"TOR"),(1933,"NYR"),(1934,"CHI"),(1935,"MMR"),(1936,"DET"),
 (1937,"DET"),(1938,"CHI"),(1939,"BOS"),(1940,"NYR"),(1941,"BOS"),(1942,"TOR"),(1943,"DET"),
 (1944,"MTL"),(1945,"TOR"),(1946,"MTL"),(1947,"TOR"),(1948,"TOR"),(1949,"TOR"),(1950,"DET"),
 (1951,"TOR"),(1952,"DET"),(1953,"MTL"),(1954,"DET"),(1955,"DET"),(1956,"MTL"),(1957,"MTL"),
 (1958,"MTL"),(1959,"MTL"),(1960,"MTL"),(1961,"CHI"),(1962,"TOR"),(1963,"TOR"),(1964,"TOR"),
 (1965,"MTL"),(1966,"MTL"),(1967,"TOR"),
 (1968,"MTL"),(1969,"MTL"),(1970,"BOS"),(1971,"MTL"),(1972,"BOS"),(1973,"MTL"),(1974,"PHI"),
 (1975,"PHI"),(1976,"MTL"),(1977,"MTL"),(1978,"MTL"),(1979,"MTL"),(1980,"NYI"),(1981,"NYI"),
 (1982,"NYI"),(1983,"NYI"),(1984,"EDM"),(1985,"EDM"),(1986,"MTL"),(1987,"EDM"),(1988,"EDM"),
 (1989,"CGY"),(1990,"EDM"),(1991,"PIT"),(1992,"PIT"),(1993,"MTL"),(1994,"NYR"),(1995,"NJD"),
 (1996,"COL"),(1997,"DET"),(1998,"DET"),(1999,"DAL"),(2000,"NJD"),(2001,"COL"),(2002,"DET"),
 (2003,"NJD"),(2004,"TBL"),(2006,"CAR"),(2007,"ANA"),(2008,"DET"),(2009,"PIT"),(2010,"CHI"),
 (2011,"BOS"),(2012,"LAK"),(2013,"CHI"),(2014,"LAK"),(2015,"CHI"),(2016,"PIT"),(2017,"PIT"),
 (2018,"WSH"),(2019,"STL"),(2020,"TBL"),(2021,"TBL"),(2022,"COL"),(2023,"VGK"),(2024,"FLA"),
 (2025,"FLA"),(2026,"CAR"),
]
TEAMNAME = {
 "MTL":"Montreal Canadiens","BOS":"Boston Bruins","PHI":"Philadelphia Flyers","NYI":"New York Islanders",
 "EDM":"Edmonton Oilers","CGY":"Calgary Flames","PIT":"Pittsburgh Penguins","NYR":"New York Rangers",
 "NJD":"New Jersey Devils","COL":"Colorado Avalanche","DET":"Detroit Red Wings","DAL":"Dallas Stars",
 "TBL":"Tampa Bay Lightning","CAR":"Carolina Hurricanes","ANA":"Anaheim Ducks","CHI":"Chicago Blackhawks",
 "LAK":"Los Angeles Kings","WSH":"Washington Capitals","STL":"St. Louis Blues","VGK":"Vegas Golden Knights",
 "FLA":"Florida Panthers","TOR":"Toronto Maple Leafs",
 # historical / defunct
 "VML":"Vancouver Millionaires","SEA":"Seattle Metropolitans","TOA":"Toronto Arenas",
 "OTS":"Ottawa Senators","TSP":"Toronto St. Patricks","VIC":"Victoria Cougars","MMR":"Montreal Maroons",
}
# Conn Smythe before the verified 1968+ set begins (award started 1965).
CS_EARLY = {1965:"Jean Béliveau", 1966:"Roger Crozier", 1967:"Dave Keon"}

# ---------------- fetch + cache ----------------
def api_get(params, tries=5):
    url="https://en.wikipedia.org/w/api.php?"+urllib.parse.urlencode(params)
    for k in range(tries):
        try:
            return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=45))
        except urllib.error.HTTPError as e:
            if e.code==429 and k<tries-1: time.sleep(8*(k+1)); continue
            raise
        except Exception:
            if k<tries-1: time.sleep(4*(k+1)); continue
            raise
def cache_path(y): return os.path.join(CACHE, f"{y}.txt")
def ensure_cached(years):
    need=[y for y in years if not (os.path.exists(cache_path(y)) and os.path.getsize(cache_path(y))>200)]
    if not need: return
    print(f"fetching {len(need)} years: {need}")
    for i in range(0,len(need),10):
        chunk=need[i:i+10]
        titles="|".join(f"{y} Stanley Cup Final" for y in chunk)
        d=api_get({"action":"query","format":"json","prop":"revisions","rvprop":"content","rvslots":"main",
                   "titles":titles,"formatversion":"2","redirects":"1"})
        got={}
        for pg in d["query"]["pages"]:
            m=re.match(r'(\d{4})\s+Stanley Cup', pg.get("title",""))
            if m and "revisions" in pg:
                got[int(m.group(1))]=pg["revisions"][0]["slots"]["main"]["content"]
        for y in chunk:
            open(cache_path(y),"w",encoding="utf-8").write(got.get(y,""))
        time.sleep(1.2)
def cached(y):
    p=cache_path(y); return open(p,encoding="utf-8").read() if os.path.exists(p) else ""

# ---------------- template / infobox parsing ----------------
def find_braces(wt, head):
    i=wt.lower().find(head.lower())
    if i<0: return None
    depth=0; j=i
    while j<len(wt)-1:
        two=wt[j:j+2]
        if two=="{{": depth+=1; j+=2; continue
        if two=="}}":
            depth-=1; j+=2
            if depth==0: return wt[i:j]
            continue
        j+=1
    return None
def split_params(body):
    # Strip citations up-front (both self-closing <ref .../> and paired <ref>...</ref>) so a
    # ref's internal "|" never splits a param and a self-closing ref can't wedge the parser.
    body=re.sub(r'<ref\b[^>]*?/>','',body,flags=re.I)
    body=re.sub(r'<ref\b[^>]*?>.*?</ref>','',body,flags=re.S|re.I)
    parts=[]; cur=""; i=0; brack=0; cd=0
    while i<len(body):
        two=body[i:i+2]
        if two=="[[": brack+=1; cur+=two; i+=2; continue
        if two=="]]": brack-=1; cur+=two; i+=2; continue
        if two=="{{": cd+=1; cur+=two; i+=2; continue
        if two=="}}": cd-=1; cur+=two; i+=2; continue
        if body[i]=="|" and brack==0 and cd==0: parts.append(cur); cur=""; i+=1; continue
        cur+=body[i]; i+=1
    parts.append(cur); return parts

POS=[("centre","C"),("center","C"),("left wing","LW"),("leftwing","LW"),("right wing","RW"),("rightwing","RW"),
     ("winger","F"),("wing","F"),("defen","D"),("goal","G"),("forward","F"),("rover","F"),("player","F")]
def map_pos(p):
    p=p.lower().replace("_"," ").strip()
    for k,v in POS:
        if k in p: return v
    return None
LINK=re.compile(r'\[\[([^\]|]+)(?:\|([^\]]+))?\]\]')
CAP=re.compile(r'\((?:\s*c\s*|captain)\)', re.I)   # (C)/(c)/(Captain) - NOT (A) alternate
def strip_qual(t):  # display: drop "(ice hockey)" style disambiguation
    return re.sub(r'\s*\([^)]*\)\s*$','',t).strip()
def parse_entry(raw):
    """One '* ...' roster line -> (display, link_target|None, captain) or None."""
    cap=bool(CAP.search(raw))
    line=re.sub(r'<ref.*?</ref>','',raw,flags=re.S|re.I); line=re.sub(r'<ref[^>]*/>','',line,flags=re.I)
    line=re.sub(r'\{\{[^}]*\}\}','',line)
    m=LINK.search(line)
    if m:
        # a stray third '[' from malformed '[[[Name]]' wikitext gets absorbed into group(1);
        # strip leading/trailing brackets so the link target and display name come out clean.
        target=m.group(1).strip().strip('[]').strip()
        disp=strip_qual((m.group(2) or m.group(1)).strip().strip('[]').strip())
    else:
        t=re.sub(r'^\*+\s*','',line); t=re.sub(r'^\d+\s*','',t)
        t=re.split(r'[†‡*§^#~@!]',t)[0]; t=re.sub(r'\([^)]*\)','',t)
        disp=re.sub(r'\s+',' ',t).strip(" ,'\""); target=None
    disp=re.sub(r'\s+',' ',disp).strip(" ,'\"@*†‡§^#~[]")
    if not disp or len(disp)<2 or disp.lower() in ("a","c"): return None
    return disp, target, cap

def parse_roster(wt):
    tpl=find_braces(wt, "{{Stanley Cup champion")
    if not tpl: return None
    body=tpl[len("{{Stanley Cup champion"):-2]
    out=[]
    for part in split_params(body):
        if "=" not in part: continue
        pname,_,val=part.partition("=")
        low=pname.lower()
        if any(x in low for x in ("non-player","nonplayer","note","coach","staff","manage","trainer",
                                  "owner","president","caption","image","team","year","season","gm")):
            continue
        pos=map_pos(pname)
        if pos is None: continue
        for ln in val.split("\n"):
            ln=ln.strip()
            if not ln.startswith("*"): continue
            e=parse_entry(ln)
            if e: out.append({"display":e[0],"link":e[1],"position":pos,"captain":e[2]})
    return out

def parse_infobox(wt):
    """-> (champion_display, runnerup_display, champion_captain_display, series) from the finals
    infobox. `series` is the game tally 'champWins–runnerWins' (en dash) - with a trailing
    '–ties' third field for the early Finals that ended games tied (1927 -> "2–0–2") - emitted ONLY when
    team1_tot/team2_tot are two clean integers that look like game totals (winner 2-4 games,
    loser strictly fewer, best-of-7 max) - pre-1939 best-of-5/3 series qualify, but anything
    resembling total-goals or malformed values is omitted rather than guessed."""
    ib=find_braces(wt,"{{Infobox Stanley Cup Final")
    if not ib: ib=find_braces(wt,"{{Infobox Stanley Cup")
    # 1992 alone titles its finals infobox '{{Infobox ice hockey series}}' - same team1/team2/
    # *_tot/*_captain fields, so parse it identically (only reached when the heads above miss).
    if not ib: ib=find_braces(wt,"{{Infobox ice hockey series")
    if not ib: return (None,None,None,None)
    params={}
    for part in split_params(ib[2:-2]):
        if "=" in part:
            kk,_,vv=part.partition("="); params[kk.strip().lower()]=vv.strip()
    def teamname(v):
        if not v: return None
        m=LINK.search(v)
        nm=(m.group(2) or m.group(1)) if m else v
        nm=re.sub(r"'''|''",'',nm)
        nm=re.sub(r'^\d{4}[–-]\d{2,4}\s+','',nm)        # strip "1954–55 " season prefix
        nm=re.sub(r'\s+season$','',nm, flags=re.I)
        return strip_qual(nm).strip()
    t1,t2=params.get("team1",""),params.get("team2","")
    bold1="'''" in t1; bold2="'''" in t2
    champ=runner=None
    if bold1 and not bold2: champ,runner=teamname(t1),teamname(t2)
    elif bold2 and not bold1: champ,runner=teamname(t2),teamname(t1)
    else:  # fall back on total goals
        try:
            tot1=int(re.sub(r'\D','',params.get("team1_tot","")) or -1)
            tot2=int(re.sub(r'\D','',params.get("team2_tot","")) or -1)
            if tot1>tot2: champ,runner=teamname(t1),teamname(t2)
            elif tot2>tot1: champ,runner=teamname(t2),teamname(t1)
        except: pass
    cap=None
    if champ and teamname(t1)==champ: cap=params.get("team1_captain")
    elif champ and teamname(t2)==champ: cap=params.get("team2_captain")
    if cap:
        m=LINK.search(cap); cap=strip_qual((m.group(2) or m.group(1)) if m else cap).strip()
    # series result: champion's games won vs runner-up's, strictly from the infobox tot fields
    def clean_int(v):
        v=(v or "").strip()
        # strip wiki bold and footnote asterisks the per-game columns carry ('''3''', 1**)
        v=re.sub(r"'''|''|\*+",'',v).strip()
        return int(v) if re.fullmatch(r'\d{1,2}',v) else None
    series=None
    tot1,tot2=clean_int(params.get("team1_tot")),clean_int(params.get("team2_tot"))
    if champ and tot1 is not None and tot2 is not None:
        if   champ==teamname(t1): cw,rw=tot1,tot2
        elif champ==teamname(t2): cw,rw=tot2,tot1
        else: cw=rw=None
        # game totals only: winner takes 2/3/4 (best-of-3/5/7), loser strictly fewer, ≤7 games
        # decided; total-goals or split-format tallies fail this and are omitted (never guessed).
        if cw is not None and 2<=cw<=4 and 0<=rw<cw and cw+rw<=7:
            # early Finals could END games tied ("teams played to two wins, ignoring ties" -
            # 1927 went 2 wins, 0 losses, 2 ties). Count ties from the per-game columns: a game
            # both teams closed with the SAME integer score. Impossible in the OT-decided modern
            # era, so this only ever fires where the source really shows ties.
            ties=0
            for gi in range(1,9):
                g1,g2=clean_int(params.get(f"team1_{gi}")),clean_int(params.get(f"team2_{gi}"))
                if g1 is not None and g2 is not None and g1==g2: ties+=1
            series=f"{cw}–{rw}–{ties}" if ties else f"{cw}–{rw}"
    return champ, runner, cap, series

# ---------------- run ----------------
years=[y for (y,_) in CHAMPS]
ensure_cached(years)
abbr_of={y:a for (y,a) in CHAMPS}

rosters={}; infobox={}; problems=[]
for (y,ab) in CHAMPS:
    wt=cached(y)
    r=parse_roster(wt); rosters[y]=r or []
    infobox[y]=parse_infobox(wt)
    if not r or len(r)<13: problems.append((y,ab,len(r) if r else 0))

# champion cross-check vs infobox bolded winner
print("=== champion cross-check (CHAMPS abbr vs infobox bolded winner) ===")
def keyn(s): return re.sub(r'[^a-z]','',(s or '').lower())
mismatch=[]
for (y,ab) in CHAMPS:
    champ_ib=infobox[y][0]
    want=TEAMNAME[ab]; ci,wi=keyn(champ_ib),keyn(want)
    ok = ci and (ci==wi or wi in ci or ci in wi)
    if champ_ib and not ok: mismatch.append((y,ab,want,champ_ib))
for m in mismatch: print("  MISMATCH", m)
print("  mismatches:", len(mismatch))
print("\n=== years with sparse/empty engraving roster (<13) ===")
for p in problems: print("  ", p)

json.dump({"rosters":rosters,"infobox":infobox,"champs":CHAMPS,"teamname":TEAMNAME},
          open(os.path.join(HERE,"_stage_rosters.json"),"w"))
print("\nwrote _stage_rosters.json  (years:",len(rosters),")")
