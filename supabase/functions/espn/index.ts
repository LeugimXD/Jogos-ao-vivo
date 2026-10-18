// Detalhes sob demanda (jogo, tabela, time, lista de times), lidos do placar público da ESPN,
// enxugados para o celular e guardados em cache no banco.
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const BASE = "https://site.api.espn.com/apis/";

type Sport = "soccer" | "football" | "basketball";
const LG: Record<string, { path: string; sport: Sport }> = {
  bra1: { path: "soccer/bra.1", sport: "soccer" },
  epl: { path: "soccer/eng.1", sport: "soccer" },
  esp1: { path: "soccer/esp.1", sport: "soccer" },
  ita1: { path: "soccer/ita.1", sport: "soccer" },
  ger1: { path: "soccer/ger.1", sport: "soccer" },
  fra1: { path: "soccer/fra.1", sport: "soccer" },
  ucl: { path: "soccer/uefa.champions", sport: "soccer" },
  nba: { path: "basketball/nba", sport: "basketball" },
  nfl: { path: "football/nfl", sport: "football" },
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// deno-lint-ignore no-explicit-any
type Any = any;

async function get(url: string): Promise<Any> {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
  if (!r.ok) throw new Error(`ESPN ${r.status}`);
  return r.json();
}

async function cached(key: string, produce: () => Promise<{ body: Any; ttl: number }>) {
  const { data } = await sb.from("espn_cache").select("body, expires_at").eq("key", key).maybeSingle();
  if (data && new Date(data.expires_at).getTime() > Date.now()) return data.body;
  try {
    const { body, ttl } = await produce();
    await sb.from("espn_cache").upsert({
      key, body, expires_at: new Date(Date.now() + ttl * 1000).toISOString(), updated_at: new Date().toISOString(),
    });
    return body;
  } catch (e) {
    if (data) return data.body; // melhor algo antigo que nada
    throw e;
  }
}

// ---------- utilidades ----------
const logoOf = (t: Any) => t?.logo ?? t?.logos?.[0]?.href ?? null;
function team(t: Any) {
  return {
    id: String(t?.id ?? ""),
    name: t?.displayName ?? t?.name ?? "",
    short: t?.shortDisplayName ?? t?.displayName ?? t?.name ?? "",
    abbr: t?.abbreviation ?? "",
    logo: logoOf(t),
    color: t?.color ? `#${t.color}` : null,
  };
}
function scoreVal(s: Any): string | null {
  if (s == null) return null;
  if (typeof s === "object") return s.displayValue ?? (s.value != null ? String(s.value) : null);
  return String(s);
}
const isTrue = (v: Any) => v === true || v === "true";

const STATS: Record<Sport, [string, string, string?][]> = {
  soccer: [
    ["possessionPct", "Posse de bola", "%"],
    ["totalShots", "Finalizações"],
    ["shotsOnTarget", "Finalizações no gol"],
    ["wonCorners", "Escanteios"],
    ["saves", "Defesas do goleiro"],
    ["foulsCommitted", "Faltas"],
    ["offsides", "Impedimentos"],
    ["yellowCards", "Cartões amarelos"],
    ["redCards", "Cartões vermelhos"],
    ["totalPasses", "Passes"],
    ["accuratePasses", "Passes certos"],
    ["totalCrosses", "Cruzamentos"],
    ["totalTackles", "Desarmes"],
    ["interceptions", "Interceptações"],
  ],
  football: [
    ["totalYards", "Jardas totais"],
    ["netPassingYards", "Jardas de passe"],
    ["rushingYards", "Jardas de corrida"],
    ["firstDowns", "First downs"],
    ["thirdDownEff", "Conversão de 3ª descida"],
    ["fourthDownEff", "Conversão de 4ª descida"],
    ["redZoneAttempts", "Red zone (TD/tentativas)"],
    ["turnovers", "Turnovers"],
    ["sacksYardsLost", "Sacks sofridos"],
    ["totalPenaltiesYards", "Penalidades (jardas)"],
    ["possessionTime", "Tempo de posse"],
  ],
  basketball: [
    ["fieldGoalsMade-fieldGoalsAttempted", "Arremessos"],
    ["fieldGoalPct", "Aproveitamento", "%"],
    ["threePointFieldGoalsMade-threePointFieldGoalsAttempted", "Bolas de 3"],
    ["threePointFieldGoalPct", "Aproveitamento de 3", "%"],
    ["freeThrowsMade-freeThrowsAttempted", "Lances livres"],
    ["totalRebounds", "Rebotes"],
    ["offensiveRebounds", "Rebotes ofensivos"],
    ["assists", "Assistências"],
    ["steals", "Roubos de bola"],
    ["blocks", "Tocos"],
    ["turnovers", "Erros (turnovers)"],
    ["fouls", "Faltas"],
    ["largestLead", "Maior vantagem"],
  ],
};

const PLAYER_GROUPS: Record<string, Record<string, { title: string; cols: string[] }>> = {
  football: {
    passing: { title: "Passes", cols: ["C/ATT", "YDS", "TD", "INT"] },
    rushing: { title: "Corridas", cols: ["CAR", "YDS", "TD", "LONG"] },
    receiving: { title: "Recepções", cols: ["REC", "YDS", "TD", "LONG"] },
    defensive: { title: "Defesa", cols: ["TOT", "SACKS", "TFL", "PD"] },
    kicking: { title: "Chutes", cols: ["FG", "XP", "PTS"] },
  },
  basketball: {
    "*": { title: "Jogadores", cols: ["MIN", "PTS", "REB", "AST", "FG", "3PT"] },
  },
};

// ---------- jogo ----------
function mapSummary(j: Any, lgId: string, eventId: string) {
  const sport = LG[lgId].sport;
  const comp = j.header?.competitions?.[0] ?? {};
  const st = comp.status ?? {};
  const t = st.type ?? {};
  const state: string = t.state ?? "pre";
  const sideOf: Record<string, string> = {};
  const teams = (comp.competitors ?? []).map((c: Any) => {
    const side = c.homeAway ?? "home";
    sideOf[String(c.team?.id ?? c.id)] = side;
    return {
      side,
      ...team(c.team),
      score: state === "pre" ? null : scoreVal(c.score),
      winner: isTrue(c.winner),
      lines: (c.linescores ?? []).map((l: Any) => l.displayValue ?? (l.value != null ? String(l.value) : "")),
      record: c.record?.[0]?.summary ?? c.record?.[0]?.displayValue ?? null,
    };
  });

  // Lances do futebol: gols, cartões, substituições.
  const events: Any[] = [];
  for (const e of j.keyEvents ?? []) {
    const ty: string = e.type?.type ?? "";
    let kind: string | null = null;
    if (isTrue(e.scoringPlay) && !isTrue(e.shootout)) kind = /own/.test(ty) ? "own" : /penalty/.test(ty) ? "pen" : "goal";
    else if (/red/.test(ty)) kind = "red";
    else if (/yellow/.test(ty)) kind = "yellow";
    else if (ty === "substitution") kind = "sub";
    else if (ty === "halftime") kind = "ht";
    else if (/penalty.*(miss|save)/.test(ty)) kind = "penmiss";
    if (!kind) continue;
    events.push({
      kind,
      clock: e.clock?.displayValue ?? "",
      period: e.period?.number ?? null,
      side: sideOf[String(e.team?.id ?? "")] ?? null,
      p: (e.participants ?? []).map((x: Any) => ({ id: String(x.athlete?.id ?? ""), n: x.athlete?.displayName ?? "" })),
    });
  }

  const lineups = (j.rosters ?? []).filter((r: Any) => r.roster?.length).map((r: Any) => {
    const pl = r.roster.map((p: Any) => ({
      id: String(p.athlete?.id ?? ""),
      n: p.athlete?.displayName ?? "",
      short: p.athlete?.shortName ?? null,
      num: p.jersey ?? "",
      pos: p.position?.abbreviation ?? "",
      fp: Number(p.formationPlace ?? 0),
      starter: isTrue(p.starter),
      subIn: isTrue(p.subbedIn),
      subOut: isTrue(p.subbedOut),
    }));
    return {
      side: r.homeAway ?? sideOf[String(r.team?.id ?? "")],
      color: r.team?.color ? `#${r.team.color}` : null,
      formation: r.formation ?? null,
      starters: pl.filter((p: Any) => p.starter),
      bench: pl.filter((p: Any) => !p.starter),
    };
  });

  // Estatísticas do time, lado a lado.
  const boxTeams = j.boxscore?.teams ?? [];
  const bySide: Record<string, Record<string, string>> = {};
  for (const bt of boxTeams) {
    const side = bt.homeAway ?? sideOf[String(bt.team?.id ?? "")];
    if (!side) continue;
    bySide[side] = {};
    for (const s of bt.statistics ?? []) bySide[side][s.name] = s.displayValue;
  }
  const stats = state === "pre" ? [] : STATS[sport]
    .filter(([k]) => bySide.home?.[k] != null && bySide.away?.[k] != null)
    .map(([k, label, unit]) => ({ label, home: bySide.home[k], away: bySide.away[k], unit: unit ?? null }));

  const groupsDef = PLAYER_GROUPS[sport];
  const players = groupsDef ? (j.boxscore?.players ?? []).map((tp: Any) => ({
    side: sideOf[String(tp.team?.id ?? "")] ?? null,
    groups: (tp.statistics ?? []).map((g: Any) => {
      const def = groupsDef[g.name] ?? groupsDef["*"];
      if (!def) return null;
      const labels: string[] = g.labels ?? [];
      const idx = def.cols.map((c) => labels.indexOf(c)).filter((i) => i >= 0);
      const rows = (g.athletes ?? [])
        .filter((a: Any) => !isTrue(a.didNotPlay) && a.stats?.length)
        .map((a: Any) => ({ n: a.athlete?.shortName ?? a.athlete?.displayName ?? "", num: a.athlete?.jersey ?? "", starter: isTrue(a.starter), s: idx.map((i) => a.stats[i]) }));
      if (!rows.length) return null;
      return { title: def.title, labels: idx.map((i) => labels[i]), rows };
    }).filter(Boolean),
  })) : [];

  const scoring = (j.scoringPlays ?? []).map((p: Any) => ({
    period: p.period?.number ?? null,
    clock: p.clock?.displayValue ?? "",
    side: sideOf[String(p.team?.id ?? "")] ?? null,
    type: p.scoringType?.abbreviation ?? p.type?.abbreviation ?? "",
    text: p.text ?? "",
    home: p.homeScore ?? null,
    away: p.awayScore ?? null,
  }));

  const leaders = sport === "soccer" ? [] : (j.leaders ?? []).map((l: Any) => ({
    side: sideOf[String(l.team?.id ?? "")] ?? null,
    cats: (l.leaders ?? []).slice(0, 3).map((c: Any) => ({
      cat: c.displayName ?? c.name ?? "",
      n: c.leaders?.[0]?.athlete?.displayName ?? "",
      v: c.leaders?.[0]?.displayValue ?? "",
    })).filter((c: Any) => c.n),
  })).filter((l: Any) => l.side && l.cats.length);

  const form = (j.lastFiveGames ?? []).map((f: Any) => ({
    side: sideOf[String(f.team?.id ?? "")] ?? null,
    games: (f.events ?? []).map((g: Any) => ({
      id: String(g.id ?? ""),
      date: g.gameDate ?? null,
      res: g.gameResult ?? null,
      score: g.score ?? "",
      atVs: g.atVs ?? "",
      opp: g.opponent?.abbreviation ?? g.opponent?.shortDisplayName ?? g.opponent?.displayName ?? "",
      oppName: g.opponent?.displayName ?? "",
      oppLogo: g.opponentLogo ?? logoOf(g.opponent),
    })),
  })).filter((f: Any) => f.side);

  const series = (j.seasonseries ?? [])[0];
  const h2h = series ? {
    title: series.type === "head-to-head" ? "Confrontos diretos" : "Confrontos na temporada",
    games: (series.events ?? []).filter((e: Any) => String(e.id) !== eventId).map((e: Any) => {
      const cs = e.competitors ?? [];
      const h = cs.find((c: Any) => c.homeAway === "home") ?? cs[0] ?? {};
      const a = cs.find((c: Any) => c.homeAway === "away") ?? cs[1] ?? {};
      return {
        id: String(e.id ?? ""), date: e.date ?? null, state: e.statusType?.state ?? e.status ?? "",
        home: { ...team(h.team), score: scoreVal(h.score) }, away: { ...team(a.team), score: scoreVal(a.score) },
      };
    }),
  } : null;

  const gi = j.gameInfo ?? {};
  const venue = gi.venue ? [gi.venue.fullName, gi.venue.address?.city].filter(Boolean).join(", ") : null;
  const referee = (gi.officials ?? [])[0]?.displayName ?? null;

  return {
    league: lgId, sport, id: eventId,
    date: comp.date ?? null,
    state,
    detail: t.shortDetail ?? t.detail ?? "",
    clock: st.displayClock ?? null,
    period: st.period ?? null,
    teams, events, lineups, stats, players, scoring, leaders, form, h2h,
    venue, attendance: gi.attendance || null, referee,
  };
}

function summaryTtl(s: Any) {
  if (s.state === "in") return 15;
  const start = s.date ? new Date(s.date).getTime() : 0;
  if (s.state === "pre") return start - Date.now() < 2 * 3600e3 ? 60 : 600;
  return Date.now() - start < 5 * 3600e3 ? 120 : 6 * 3600;
}

// ---------- tabela ----------
const COLS: Record<Sport, [string, string][]> = {
  soccer: [["gamesPlayed", "J"], ["wins", "V"], ["ties", "E"], ["losses", "D"], ["pointDifferential", "SG"], ["points", "PTS"]],
  football: [["wins", "V"], ["losses", "D"], ["ties", "E"], ["winPercent", "%"], ["streak", "SEQ"]],
  basketball: [["wins", "V"], ["losses", "D"], ["winPercent", "%"], ["gamesBehind", "DIF"], ["streak", "SEQ"]],
};
const GROUP_NAMES: Record<string, string> = {
  "American Football Conference": "AFC",
  "National Football Conference": "NFC",
  "Eastern Conference": "Conferência Leste",
  "Western Conference": "Conferência Oeste",
  "League Phase": "Fase de liga",
};
const NOTE_PT: [RegExp, string][] = [
  [/relegation play-?off/i, "Playoff de rebaixamento"],
  [/champions league qualif/i, "Fase prévia da Champions"],
  [/europa league qualif/i, "Fase prévia da Europa League"],
  [/conference league qualif/i, "Fase prévia da Conference"],
  [/round of 16/i, "Oitavas de final"],
  [/knockout round play-?off/i, "Playoff das oitavas"],
  [/champions league/i, "Champions League"],
  [/europa league/i, "Europa League"],
  [/conference league/i, "Conference League"],
  [/libertadores.*(qualif|preliminar)/i, "Pré-Libertadores"],
  [/libertadores/i, "Libertadores"],
  [/sudamericana/i, "Sul-Americana"],
  [/relegation/i, "Rebaixamento"],
  [/play-?in/i, "Play-in"],
  [/playoff|clinched/i, "Playoffs"],
  [/eliminated/i, "Eliminado"],
];
function notePt(d: string) {
  for (const [re, pt] of NOTE_PT) if (re.test(d)) return pt;
  return d;
}

function mapStandings(j: Any, lgId: string) {
  const sport = LG[lgId].sport;
  const cols = COLS[sport];
  const src = j.children?.length ? j.children : [j];
  const groups = src.map((c: Any) => {
    const rows = (c.standings?.entries ?? []).map((e: Any) => {
      const s: Record<string, string> = {};
      for (const x of e.stats ?? []) s[x.name] = x.displayValue;
      return {
        team: team(e.team),
        rank: Number(s.rank ?? s.playoffSeed ?? 0) || null,
        seed: Number(s.playoffSeed ?? 0) || null,
        pct: parseFloat(s.winPercent ?? "0") || 0,
        v: cols.map(([k]) => s[k] ?? "–"),
        note: e.note ? { color: e.note.color ?? null, desc: notePt(e.note.description ?? "") } : null,
      };
    });
    rows.sort((a: Any, b: Any) =>
      sport === "soccer" ? (a.rank ?? 99) - (b.rank ?? 99) : (a.seed ?? 99) - (b.seed ?? 99) || b.pct - a.pct);
    rows.forEach((r: Any, i: number) => (r.pos = i + 1));
    const name = GROUP_NAMES[c.name] ?? (/\d{4}/.test(c.name ?? "") ? "Classificação" : c.name ?? "Classificação");
    return { name, rows: rows.map(({ pct: _p, seed: _s, rank: _r, ...r }: Any) => r) };
  });
  return { league: lgId, sport, cols: cols.map(([, l]) => l), groups };
}

// ---------- time ----------
function mapScheduleEvent(e: Any) {
  const c = e.competitions?.[0] ?? {};
  const t = c.status?.type ?? {};
  const state = t.state ?? "pre";
  const cs = c.competitors ?? [];
  const h = cs.find((x: Any) => x.homeAway === "home") ?? cs[0] ?? {};
  const a = cs.find((x: Any) => x.homeAway === "away") ?? cs[1] ?? {};
  return {
    id: String(e.id ?? ""), date: e.date ?? c.date ?? null, state,
    detail: t.shortDetail ?? "", clock: c.status?.displayClock ?? null, period: c.status?.period ?? null,
    home: { ...team(h.team), score: state === "pre" ? null : scoreVal(h.score), winner: isTrue(h.winner) },
    away: { ...team(a.team), score: state === "pre" ? null : scoreVal(a.score), winner: isTrue(a.winner) },
    venue: c.venue?.fullName ?? null,
  };
}

async function teamPage(lgId: string, teamId: string) {
  const { path, sport } = LG[lgId];
  const base = `${BASE}site/v2/sports/${path}/teams/${teamId}/schedule`;
  const res = await Promise.all([get(base), sport === "soccer" ? get(`${base}?fixture=true`).catch(() => null) : Promise.resolve(null)]);
  const info = res[0]?.team ?? {};
  const all = new Map<string, Any>();
  for (const r of res) for (const e of r?.events ?? []) { const m = mapScheduleEvent(e); all.set(m.id, m); }
  const list = [...all.values()];
  const past = list.filter((g) => g.state === "post").sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  const next = list.filter((g) => g.state !== "post").sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  return {
    league: lgId, sport,
    team: { ...team(info), record: info.recordSummary ?? null, standing: info.standingSummary ?? null },
    past: past.slice(0, 20), next: next.slice(0, 20),
  };
}

// ---------- lista de times (busca) ----------
async function allTeams() {
  const out: Any[] = [];
  await Promise.all(Object.entries(LG).map(async ([id, { path }]) => {
    try {
      const j = await get(`${BASE}site/v2/sports/${path}/teams?limit=200`);
      for (const x of j.sports?.[0]?.leagues?.[0]?.teams ?? []) out.push({ ...team(x.team), league: id });
    } catch { /* uma liga fora do ar não derruba a busca */ }
  }));
  return out;
}

// ---------- rota ----------
function json(body: Any, status = 200, maxAge = 10) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${maxAge}` },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const u = new URL(req.url);
  const type = u.searchParams.get("type") ?? "";
  const lg = u.searchParams.get("league") ?? "";
  const id = u.searchParams.get("id") ?? "";
  try {
    if (type === "teams") {
      return json(await cached("teams:v2", async () => ({ body: await allTeams(), ttl: 86400 })), 200, 3600);
    }
    if (!LG[lg]) return json({ error: "Campeonato desconhecido" }, 400);
    if (type === "standings") {
      const body = await cached(`standings:${lg}`, async () => ({
        body: mapStandings(await get(`${BASE}v2/sports/${LG[lg].path}/standings`), lg), ttl: 900,
      }));
      return json(body, 200, 120);
    }
    if (!/^\d{1,12}$/.test(id)) return json({ error: "Identificador inválido" }, 400);
    if (type === "game") {
      const body = await cached(`game:${lg}:${id}`, async () => {
        const s = mapSummary(await get(`${BASE}site/v2/sports/${LG[lg].path}/summary?event=${id}`), lg, id);
        return { body: s, ttl: summaryTtl(s) };
      });
      return json(body, 200, body.state === "in" ? 5 : 30);
    }
    if (type === "team") {
      const body = await cached(`team:${lg}:${id}`, async () => ({ body: await teamPage(lg, id), ttl: 600 }));
      return json(body, 200, 60);
    }
    return json({ error: "Tipo desconhecido" }, 400);
  } catch (e) {
    return json({ error: "Não foi possível carregar agora", detail: String(e instanceof Error ? e.message : e) }, 502, 0);
  }
});
