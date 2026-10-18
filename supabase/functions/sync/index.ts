// Mantém a tabela `games` atualizada a partir do placar público da ESPN.
// mode=schedule: agenda de 3 dias atrás até 14 dias à frente (a cada 3 h).
// mode=live: só os campeonatos com jogo rolando ou começando (a cada minuto).
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
const BASE = "https://site.api.espn.com/apis/site/v2/sports/";
const DAY = 86400000;

function ymd(d: Date) {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// deno-lint-ignore no-explicit-any
function team(c: any) {
  return c?.team ?? c?.athlete ?? {};
}
// deno-lint-ignore no-explicit-any
function score(c: any, state: string) {
  if (state === "pre" || c?.score == null) return null;
  const s = typeof c.score === "object" ? (c.score.displayValue ?? c.score.value) : c.score;
  return s == null ? null : String(s);
}

// deno-lint-ignore no-explicit-any
function mapEvent(ev: any, leagueId: string) {
  const comp = ev.competitions?.[0] ?? {};
  const cs = comp.competitors ?? [];
  // deno-lint-ignore no-explicit-any
  const home = cs.find((c: any) => c.homeAway === "home") ?? cs[0] ?? {};
  // deno-lint-ignore no-explicit-any
  const away = cs.find((c: any) => c.homeAway === "away") ?? cs[1] ?? {};
  const st = comp.status ?? ev.status ?? {};
  const t = st.type ?? {};
  const state = t.state ?? "pre";
  const bc = new Set<string>();
  for (const b of comp.broadcasts ?? []) for (const n of b.names ?? []) bc.add(n);
  for (const g of comp.geoBroadcasts ?? []) if (g?.media?.shortName) bc.add(g.media.shortName);
  const h = team(home), a = team(away);
  return {
    id: `${leagueId}:${ev.id}`,
    league_id: leagueId,
    starts_at: ev.date,
    state,
    status_detail: t.shortDetail ?? t.detail ?? t.description ?? null,
    clock: st.displayClock ?? null,
    period: st.period ?? null,
    home_name: h.displayName ?? null,
    home_short: h.shortDisplayName ?? h.abbreviation ?? null,
    home_logo: h.logo ?? h.logos?.[0]?.href ?? null,
    home_score: score(home, state),
    home_team_id: h.id != null ? String(h.id) : null,
    away_name: a.displayName ?? null,
    away_short: a.shortDisplayName ?? a.abbreviation ?? null,
    away_logo: a.logo ?? a.logos?.[0]?.href ?? null,
    away_score: score(away, state),
    away_team_id: a.id != null ? String(a.id) : null,
    venue: comp.venue?.fullName ?? null,
    espn_broadcasts: bc.size ? [...bc].join(", ") : null,
    updated_at: new Date().toISOString(),
  };
}

async function fetchDay(leagueId: string, path: string, day: string) {
  const r = await fetch(`${BASE}${path}/scoreboard?dates=${day}`, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
  });
  if (!r.ok) throw new Error(`${leagueId} ${day}: HTTP ${r.status}`);
  const j = await r.json();
  // deno-lint-ignore no-explicit-any
  return (j.events ?? []).map((e: any) => mapEvent(e, leagueId)).filter((g: any) => g.starts_at);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") === "schedule" ? "schedule" : "live";
  const now = new Date();

  const { data: last } = await sb.from("sync_log").select("run_at").eq("mode", mode)
    .order("run_at", { ascending: false }).limit(1);
  if (last?.[0] && now.getTime() - new Date(last[0].run_at).getTime() < 20000) {
    return Response.json({ skipped: true, reason: "recent" });
  }

  const { data: leagues, error: le } = await sb.from("leagues").select("id, espn_path");
  if (le) return Response.json({ error: le.message }, { status: 500 });

  let targets = leagues ?? [];
  let offsets = Array.from({ length: 18 }, (_, i) => i - 3); // -3 .. +14

  if (mode === "live") {
    const soon = new Date(now.getTime() + 10 * 60000).toISOString();
    const back = new Date(now.getTime() - 6 * 3600000).toISOString();
    const { data: active } = await sb.from("games").select("league_id")
      .or(`state.eq.in,and(state.eq.pre,starts_at.lte.${soon},starts_at.gte.${back})`);
    const ids = new Set((active ?? []).map((g) => g.league_id));
    targets = targets.filter((l) => ids.has(l.id));
    if (!targets.length) return Response.json({ mode, idle: true });
    offsets = [-1, 0];
  }

  const days = offsets.map((o) => ymd(new Date(now.getTime() + o * DAY)));
  let total = 0;
  const errors: string[] = [];

  await Promise.all(targets.map(async (l) => {
    const byId = new Map<string, unknown>();
    // dias em lotes de 6 para não martelar a ESPN
    for (let i = 0; i < days.length; i += 6) {
      const chunk = days.slice(i, i + 6);
      const results = await Promise.allSettled(chunk.map((d) => fetchDay(l.id, l.espn_path, d)));
      for (const r of results) {
        if (r.status === "fulfilled") for (const g of r.value) byId.set(g.id, g);
        else errors.push(String(r.reason instanceof Error ? r.reason.message : r.reason));
      }
    }
    const rows = [...byId.values()];
    if (rows.length) {
      const { error } = await sb.from("games").upsert(rows, { onConflict: "id" });
      if (error) errors.push(`${l.id}: ${error.message}`);
      else total += rows.length;
    }
  }));

  await sb.from("sync_log").insert({
    mode,
    leagues: targets.map((l) => l.id).join(","),
    games: total,
    error: errors.length ? errors.slice(0, 10).join(" | ") : null,
  });
  return Response.json({ mode, leagues: targets.map((l) => l.id), games: total, errors });
});
