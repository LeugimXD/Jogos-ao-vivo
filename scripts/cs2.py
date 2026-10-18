#!/usr/bin/env python3
"""Busca os jogos da FURIA no CS2 na API da Liquipedia e grava data/cs2.json.

Segue as regras da API da Liquipedia (https://liquipedia.net/api-terms-of-use):
User-Agent identificado, resposta compactada (gzip) e no máximo 1 pedido "parse" a cada 30 s.
Os dados são da Liquipedia, licença CC-BY-SA 3.0 (o app mostra o crédito).
"""
import gzip
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API = "https://liquipedia.net/counterstrike/api.php"
UA = "JogosAoVivo/1.0 (https://github.com/LeugimXD/Jogos-ao-vivo; app pessoal de placares)"
TEAM = "FURIA"
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "cs2.json")
DEBUG = os.path.join(os.path.dirname(__file__), "..", "data", "cs2-debug.txt")


def parse_page(page):
    q = urllib.parse.urlencode({"action": "parse", "page": page, "format": "json", "prop": "text"})
    req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": UA, "Accept-Encoding": "gzip"})
    with urllib.request.urlopen(req, timeout=40) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
    data = json.loads(raw.decode("utf-8"))
    return data.get("parse", {}).get("text", {}).get("*", "")


def text(s):
    return html.unescape(re.sub(r"<[^>]+>", " ", s or "")).replace("\xa0", " ").strip()


def squash(s):
    return re.sub(r"\s+", " ", s).strip()


def blocks(h):
    """Separa a página em blocos de partida (formato antigo e novo da Liquipedia)."""
    marks = [m.start() for m in re.finditer(r'class="[^"]*(?:infobox_matches_content|match-info)(?:\s|")', h)]
    out = []
    for i, st in enumerate(marks):
        end = marks[i + 1] if i + 1 < len(marks) else min(len(h), st + 12000)
        out.append(h[st:end])
    return out


def team_full_names(b):
    """Nome completo (atributo title do link), ex.: "BetBoom Team" para "BB"."""
    out = []
    for m in re.finditer(r'class="name"[^>]*>\s*<a[^>]*title="([^"]+)"', b):
        t = html.unescape(m.group(1)).strip()
        if t and (not out or out[-1] != t):
            out.append(t)
    return out[:2]


def team_names(b):
    names = []
    # formato antigo: <span class="team-template-text"><a ... title="FURIA">FURIA</a>
    for m in re.finditer(r'class="team-template-text"[^>]*>(.*?)</span>', b, re.S):
        t = squash(text(m.group(1)))
        if t:
            names.append(t)
    if len(names) < 2:
        # formato novo: <span class="name"><a ... title="FURIA">FURIA</a></span>
        names = [squash(text(m.group(1))) for m in re.finditer(r'class="name"[^>]*>(.*?)</span>', b, re.S)]
        names = [n for n in names if n]
    # mesmo time aparece duas vezes (nome curto e longo): mantém a ordem e tira repetidos vizinhos
    out = []
    for n in names:
        if not out or out[-1] != n:
            out.append(n)
    return out[:2]


def team_logos(b):
    logos = []
    for m in re.finditer(r'class="team-template-image[^"]*"[^>]*>.*?<img[^>]+src="([^"]+)"', b, re.S):  # antigo e novo
        src = m.group(1)
        logos.append(src if src.startswith("http") else "https://liquipedia.net" + src)
    out = []
    for l in logos:
        if not out or out[-1] != l:
            out.append(l)
    return out


def parse_match(b):
    names = team_names(b)
    if len(names) < 2 or not any(TEAM.lower() == n.lower() or n.lower().startswith(TEAM.lower()) for n in names):
        return None
    ts = re.search(r'data-timestamp="(\d+)"', b)
    if not ts:
        return None
    ts = int(ts.group(1))
    score = None
    vs = re.search(r'class="versus"[^>]*>(.*?)</td>', b, re.S)
    vs_text = squash(text(vs.group(1))) if vs else ""
    m = re.search(r"(\d+)\s*:\s*(\d+)", vs_text)
    if m:
        score = [int(m.group(1)), int(m.group(2))]
    else:
        sc = re.findall(r'scoreholder-score[^"]*"[^>]*>\s*(\d+)\s*<', b)
        if len(sc) >= 2:
            score = [int(sc[0]), int(sc[1])]
    bo = re.search(r"\bBo(\d)\b", b)
    tour = re.search(r'class="(?:tournament-text|match-info-tournament-name)[^"]*"[^>]*>(.*?)</(?:div|span)>', b, re.S)
    tournament = squash(text(tour.group(1))) if tour else ""
    live = bool(re.search(r"countdown-live|timer-object-live|>\s*LIVE\s*<", b, re.I))
    finished = bool(re.search(r'data-finished="finished"|timer-object-finished', b))
    # série decidida (ex.: 2 mapas numa MD3) e já começou há mais de 1 h
    if not finished and score and bo and not live and ts < time.time() - 3600 and max(score) > int(bo.group(1)) // 2:
        finished = True
    streams = []
    for p, ch in re.findall(r'data-stream-([a-z]+)="([^"]+)"', b) + re.findall(r'href="/counterstrike/Special:Stream/([a-z]+)/([^"]+)"', b):
        ch = urllib.parse.unquote(html.unescape(ch))
        if ch and (p, ch) not in streams:
            streams.append((p, ch))
    icon = re.search(r'league-icon-small-image lightmode.*?<img[^>]+src="([^"]+)"', b, re.S)
    icon = (icon.group(1) if icon.group(1).startswith("http") else "https://liquipedia.net" + icon.group(1)) if icon else None
    full = team_full_names(b)
    logos = team_logos(b)
    now = time.time()
    decided = bool(score and bo and max(score) > int(bo.group(1)) // 2)
    if live:
        state = "in"
    elif finished or (decided and ts < now - 3600):
        state = "post"
    elif ts > now - 300:
        state = "pre"
    elif ts > now - 12 * 3600:
        state = "in"  # já devia ter começado e ainda não tem vencedor: em andamento ou atrasado
    else:
        return None  # sem resultado depois de 12 h: informação incerta, melhor não mostrar
    mid = hashlib.sha1(f"{ts}|{'|'.join(sorted(names))}".encode()).hexdigest()[:10]
    return {
        "id": mid,
        "ts": ts,
        "state": state,
        "teams": [{"name": names[i], "full": full[i] if i < len(full) else names[i], "logo": logos[i] if i < len(logos) else None, "score": score[i] if score else None} for i in range(2)],
        "bestof": int(bo.group(1)) if bo else None,
        "tournament": tournament,
        "tournament_icon": icon,
        "streams": [{"platform": p, "channel": ch} for p, ch in streams][:8],
    }


def main():
    debug = []
    matches = {}
    old = {}
    if os.path.exists(OUT):
        try:
            for m in json.load(open(OUT, encoding="utf-8")).get("matches", []):
                old[m["id"]] = m
        except Exception:
            pass
    # A página de partidas traz as próximas, as ao vivo e as encerradas recentes.
    pages = ["Liquipedia:Matches"]
    for i, page in enumerate(pages):
        if i:
            time.sleep(31)  # regra da Liquipedia: 1 parse a cada 30 s
        try:
            h = parse_page(page)
        except Exception as e:
            debug.append(f"== {page}: ERRO {e}")
            continue
        bl = blocks(h)
        debug.append(f"== {page}: {len(h)} caracteres, {len(bl)} blocos, FURIA aparece {h.count(TEAM)} vezes")
        found = 0
        for b in bl:
            m = parse_match(b)
            if m:
                matches[m["id"]] = m
                found += 1
        debug.append(f"   partidas da FURIA lidas: {found}")
        k = h.find(TEAM)
        if k >= 0:
            debug.append(h[max(0, k - 3000): k + 2500])
    # mantém resultados antigos que saíram da página (histórico curto)
    for mid, m in old.items():
        if mid not in matches and m.get("state") == "post" and m["ts"] > time.time() - 60 * 86400:
            matches[mid] = m
    ordered = sorted(matches.values(), key=lambda m: m["ts"])
    payload = {"source": "Liquipedia", "license": "CC-BY-SA 3.0", "team": TEAM, "matches": ordered}
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    new_body = json.dumps(payload, ensure_ascii=False, indent=1)
    old_body = None
    if os.path.exists(OUT):
        try:
            d = json.load(open(OUT, encoding="utf-8"))
            d.pop("updated", None)
            old_body = json.dumps(d, ensure_ascii=False, indent=1)
        except Exception:
            pass
    if new_body != old_body:
        payload["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=1)
    if os.environ.get("CS2_DEBUG", "1") == "1":
        with open(DEBUG, "w", encoding="utf-8") as f:
            f.write("\n".join(debug))
    print(f"{len(ordered)} partidas da FURIA")


if __name__ == "__main__":
    sys.exit(main())
