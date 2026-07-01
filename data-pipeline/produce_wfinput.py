#!/usr/bin/env python3
"""Prepare compact inputs for the identity-audit workflow: groups of players sharing a surname
(where one person split into two nodes could hide) and unusually large merges (one node claiming
many Cups or a very long career), for a human or LLM reviewer to adjudicate. Emits wf_corr_input.json."""
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
abbr_of={int(y):a for (y,a) in S["champs"]}

norm_to_key={}
for y in sorted(R):
    for e in R[y]:
        if e["link"]:
            k=("L",canon(e["link"])); norm_to_key.setdefault(norm(strip_qual(canon(e["link"]))),k)
def keyof(e):
    if e["link"]: return ("L",canon(e["link"]))
    return norm_to_key.get(norm(e["display"]), ("N",norm(e["display"])))

G=defaultdict(lambda:{"disp":Counter(),"pos":Counter(),"peryear":[]})
for y in sorted(R):
    for e in R[y]:
        k=keyof(e); g=G[k]
        d=strip_qual(canon(e["link"])) if e["link"] else e["display"]
        g["disp"][d]+=1; g["pos"][e["position"]]+=1
        g["peryear"].append({"year":y,"abbr":abbr_of[y],"link":canon(e["link"]) if e["link"] else None,"display":d})
def dname(g): return g["disp"].most_common(1)[0][0]

players=[]
for k,g in G.items():
    ys=sorted({p["year"] for p in g["peryear"]})
    players.append({"id":norm(dname(g)),"name":dname(g),"key":list(k),
                    "years":ys,"abbrs":[abbr_of[y] for y in ys],
                    "pos":g["pos"].most_common(1)[0][0],
                    "links":sorted({p["link"] for p in g["peryear"] if p["link"]}),
                    "peryear":g["peryear"]})

# clusters of shared surname (>=2 players) - the only place same-person splits can hide
bysur=defaultdict(list)
for p in players:
    t=toks(p["name"]); bysur[t[-1] if t else p["name"]].append(p)
clusters=[]
for sur,mem in bysur.items():
    if len(mem)>=2:
        clusters.append({"surname":sur,"members":[
            {"name":m["name"],"years":m["years"],"abbrs":m["abbrs"],"pos":m["pos"],
             "links":m["links"]} for m in sorted(mem,key=lambda m:m["years"][0])]})
clusters.sort(key=lambda c:-len(c["members"]))

# big merges to guard against OVER-merge (one node = supposedly one person, many Cups / long span)
big=[]
for p in players:
    span=p["years"][-1]-p["years"][0]
    if len(p["years"])>=5 or span>=14:
        big.append({"name":p["name"],"cups":len(p["years"]),"span":span,"pos":p["pos"],
                    "links":p["links"],"peryear":[{ "y":x["year"],"t":x["abbr"],"link":x["link"],"as":x["display"]} for x in p["peryear"]]})
big.sort(key=lambda b:(-b["cups"],-b["span"]))

json.dump({"clusters":clusters,"big":big,"nplayers":len(players)},
          open(os.path.join(HERE,"wf_corr_input.json"),"w"))
print("players:",len(players))
print("surname clusters (>=2):",len(clusters),"  total members:",sum(len(c['members']) for c in clusters))
print("biggest clusters:",[(c['surname'],len(c['members'])) for c in clusters[:8]])
print("big-merge guards (cups>=5 or span>=14):",len(big))
print("sample big:",[(b['name'],b['cups'],b['span']) for b in big[:8]])
