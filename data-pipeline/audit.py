#!/usr/bin/env python3
"""Deterministic correlation audit over the built identity groups.
Surfaces candidate OVER-merges (one node spanning an impossible career, mixed
goalie/skater, or a disambiguation-looking link) and UNDER-merges (near-duplicate
names left as separate nodes). Emits audit.json for the adjudication workflow."""
import json, re, os, unicodedata
from collections import defaultdict, Counter

HERE=os.path.dirname(os.path.abspath(__file__))
S=json.load(open(os.path.join(HERE,"_stage_rosters.json")))
R={int(y):v for y,v in S["rosters"].items()}
cache=json.load(open(os.path.join(HERE,"redirects.json")))
def canon(l): return cache.get(l,l)

SUFFIX={"sr","jr","ii","iii","iv"}
def toks(s):
    s=unicodedata.normalize('NFD',s or ''); s=''.join(c for c in s if unicodedata.category(c)!='Mn')
    s=re.sub(r'[^a-z0-9 ]',' ',s.lower()); return [t for t in s.split() if t not in SUFFIX]
def norm(s): return ''.join(toks(s))
def strip_qual(t): return re.sub(r'\s*\([^)]*\)\s*$','',t or '').strip()

# regroup with diagnostics (mirror resolve_build keying)
norm_to_key={}
for y in sorted(R):
    for e in R[y]:
        if e["link"]:
            k=("L",canon(e["link"])); norm_to_key.setdefault(norm(strip_qual(canon(e["link"]))),k)
def keyof(e):
    if e["link"]: return ("L",canon(e["link"]))
    return norm_to_key.get(norm(e["display"]), ("N",norm(e["display"])))

groups=defaultdict(lambda:{"years":[],"disp":Counter(),"pos":Counter(),"links":set(),"yearpos":[]})
for y in sorted(R):
    for e in R[y]:
        k=keyof(e); g=groups[k]
        g["years"].append(y); g["disp"][(strip_qual(canon(e["link"])) if e["link"] else e["display"])]+=1
        g["pos"][e["position"]]+=1; g["yearpos"].append((y,e["position"]))
        if e["link"]: g["links"].add(canon(e["link"]))

def dname(g): return g["disp"].most_common(1)[0][0]
print(f"groups (players): {len(groups)}")

# ---- OVER-merge candidates ----
print("\n=== OVER-MERGE candidates ===")
print("-- career span > 24 years (one node, implausibly long) --")
span_flags=[]
for k,g in groups.items():
    ys=sorted(set(g["years"])); span=ys[-1]-ys[0]
    if span>24:
        span_flags.append((dname(g),ys[0],ys[-1],span,sorted(g["links"])))
for f in sorted(span_flags,key=lambda x:-x[3]):
    print(f"   {f[0]:26} {f[1]}-{f[2]} span={f[3]:2}  link={f[4]}")

print("-- mixed goalie & skater in one node --")
mix=[]
for k,g in groups.items():
    P=set(g["pos"])
    if 'G' in P and (P-{'G'}): mix.append((dname(g),dict(g["pos"]),sorted(set(g["years"]))))
for m in mix: print(f"   {m[0]:26} pos={m[1]} years={m[2]}")

print("-- link target looks like a disambiguation / >2 distinct first names on one link --")
disamb=[]
for k,g in groups.items():
    if k[0]!="L": continue
    firsts={toks(d)[0] for d in g["disp"] if toks(d)}
    if len(firsts)>2 or "(disambiguation)" in k[1].lower():
        disamb.append((k[1],list(g["disp"]),sorted(set(g["years"]))))
for d in disamb: print(f"   {d[0]:30} names={d[1]} years={d[2]}")

# ---- UNDER-merge candidates: near-duplicate names, separate nodes ----
print("\n=== UNDER-MERGE candidates (near-duplicate names, separate nodes) ===")
def first_last(d):
    t=toks(d); return (t[0],t[-1]) if len(t)>=2 else (t[0] if t else "", t[-1] if t else "")
by_surname=defaultdict(list)
for k,g in groups.items():
    d=dname(g); fl=first_last(d)
    by_surname[fl[1]].append((d,k,fl[0],sorted(set(g["years"])),sorted(g["links"])))
def compatible(f1,f2):
    if not f1 or not f2: return False
    if f1==f2: return False  # same first name but different node already (norm collision) -> separate check
    return f1.startswith(f2) or f2.startswith(f1) or (f1[0]==f2[0] and (f1 in f2 or f2 in f1))
cands=[]
for sur,lst in by_surname.items():
    for i in range(len(lst)):
        for j in range(i+1,len(lst)):
            a,b=lst[i],lst[j]
            if a[1]==b[1]: continue
            # year overlap or adjacency makes "same person" plausible
            ay,by=set(a[3]),set(b[3])
            yspan=min(max(ay),max(by))-max(min(ay),min(by))
            if compatible(a[2],b[2]):
                cands.append((sur,a[0],a[3],b[0],b[3],a[4],b[4]))
for c in sorted(cands):
    print(f"   {c[1]:22}{c[2]}  <?>  {c[3]:22}{c[4]}")
print(f"\n   under-merge name-pair candidates: {len(cands)}")

# ---- unlinked entries ----
unlinked=[(dname(g),sorted(set(g['years']))) for k,g in groups.items() if k[0]=='N']
print(f"\n=== UNLINKED groups: {len(unlinked)} ===")
for u in unlinked: print(f"   {u[0]:26} {u[1]}")

json.dump({"span":span_flags,"mixed":mix,"disamb":disamb,
           "undermerge":cands,"unlinked":unlinked}, open(os.path.join(HERE,"audit.json"),"w"), default=list)
print("\nwrote audit.json")
