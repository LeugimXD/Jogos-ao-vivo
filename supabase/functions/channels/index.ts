// Preenche o "onde assistir" de cada jogo com a programação de TV do Brasil publicada no futnatv.net.
// Roda a cada 3 horas (pg_cron). Nunca sobrescreve canal marcado como manual (channels_source = 'manual').
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SITE = "https://futnatv.net/";
const OFFSETS = ["", "amanha", "d2", "d3", "d4", "d5", "d6"];
const SECTIONS: { prefix: string; pick: (c: string) => string | null }[] = [
  {
    prefix: "",
    pick: (c) => c === "Brasileirão - Série A" ? "bra1"
      : /^Champions League$/i.test(c) ? "ucl"
      : /^(Campeonato Inglês|Premier League)$/i.test(c) ? "epl"
      : /^(Campeonato Espanhol|La Liga)$/i.test(c) ? "esp1"
      : /^(Campeonato Italiano|Serie A)$/i.test(c) ? "ita1"
      : /^(Campeonato Alemão|Bundesliga)$/i.test(c) ? "ger1"
      : /^(Campeonato Francês|Ligue 1)$/i.test(c) ? "fra1" : null,
  },
  { prefix: "nfl/", pick: (c) => /^NFL$/i.test(c) ? "nfl" : null },
  { prefix: "basquete/", pick: (c) => /^NBA$/i.test(c) ? "nba" : null },
];
// Quando a programação do dia não lista um jogo, ele passa só no pacote oficial da liga.
const FALLBACK: Record<string, string> = { nfl: "NFL Game Pass (DAZN)", nba: "NBA League Pass" };

// deno-lint-ignore no-explicit-any
type Any = any;
type Row = { league: string; date: string; time: string; a: string; b: string; tv: string };

const STOP = new Set(["fc", "cf", "sc", "ac", "fk", "de", "da", "do", "del", "la", "le", "the", "club", "clube", "cd", "ud", "sv", "afc", "sk", "city"]);
const ALIAS: Record<string, string> = {
  munique: "munich", milao: "milan", praga: "prague", lisboa: "lisbon", inter: "internazionale", turim: "turin",
  colonia: "cologne", koln: "cologne", gladbach: "monchengladbach", "m gladbach": "monchengladbach", sevilha: "sevilla",
  napoles: "napoli", florenca: "fiorentina", genova: "genoa", marselha: "marseille", lyon: "lyon", estrasburgo: "strasbourg",
};
const norm = (s: string) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
function toks(s: string) {
  return norm(s).replace(/[^a-z0-9 ]/g, " ").split(/\s+/)
    .map((t) => ALIAS[t] ?? t)
    .filter((t) => t.length >= 3 && !STOP.has(t));
}
function sim(a: string, variants: (string | null)[]) {
  const ta = toks(a);
  let best = 0;
  for (const v of variants) {
    if (!v) continue;
    const tv = toks(v);
    let c = 0;
    for (const x of ta) if (tv.some((y) => y === x || (x.length >= 4 && y.length >= 4 && (y.startsWith(x) || x.startsWith(y))) || (x.length >= 6 && y.length >= 6 && (y.includes(x) || x.includes(y))))) c++;
    best = Math.max(best, c);
  }
  return best;
}
function cleanTv(s: string) {
  // protege "e" e vírgulas dentro de parênteses, ex.: "Globo (RS e MG)"
  const parts = s.replace(/\b(?:YT|YouTube)\s*\(([^)]+)\)/g, "$1 (YouTube)").replace(/HBO MAX/gi, "HBO Max")
    .replace(/\(([^)]*)\)/g, (m) => m.replace(/ e /g, " \u0001 ").replace(/,/g, "\u0002"))
    .split(/,\s*|\s+e\s+/)
    .map((x) => x.replace(/<[^>]*>/g, "").replace(/\u0001/g, "e").replace(/\u0002/g, ",").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (!parts.length) return "";
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}

async function readPage(url: string): Promise<{ date: string; games: Any[] }[]> {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (JogosAoVivo; uso pessoal)" } });
  if (!r.ok) return [];
  const html = await r.text();
  const m = /window\.__FUTNATV_INITIAL_SCHEDULE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/.exec(html);
  if (!m) return [];
  const data = JSON.parse(m[1]);
  return (data?.payload?.schedule ?? []).map((d: Any) => ({ date: d.key, games: d.games ?? [] }));
}

Deno.serve(async () => {
  const rows: Row[] = [];
  const daysSeen: Record<string, Set<string>> = { nfl: new Set(), nba: new Set() };
  const errors: string[] = [];

  await Promise.all(SECTIONS.flatMap((sec) => OFFSETS.map(async (off) => {
    try {
      for (const day of await readPage(SITE + sec.prefix + off)) {
        if (sec.prefix === "nfl/") daysSeen.nfl.add(day.date);
        if (sec.prefix === "basquete/") daysSeen.nba.add(day.date);
        for (const g of day.games) {
          const league = sec.pick(String(g.competition ?? ""));
          const tv = cleanTv(String(g.broadcast ?? ""));
          if (!league || !tv) continue;
          rows.push({ league, date: day.date, time: String(g.time ?? ""), a: g.home ?? "", b: g.away ?? "", tv });
        }
      }
    } catch (e) {
      errors.push(`${sec.prefix}${off}: ${e instanceof Error ? e.message : e}`);
    }
  })));

  const from = new Date(Date.now() - 12 * 3600e3).toISOString();
  const to = new Date(Date.now() + 8 * 86400e3).toISOString();
  const { data: games, error } = await sb.from("games")
    .select("id, league_id, starts_at, home_name, home_short, away_name, away_short, channels_override, channels_source")
    .gte("starts_at", from).lt("starts_at", to);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const updates = new Map<string, { tv: string; src: string }>();
  for (const r of rows) {
    const m = /(\d{1,2})h(\d{2})/.exec(r.time);
    if (!m) continue;
    // Horário de Brasília (UTC-3, sem horário de verão).
    const t = Date.parse(`${r.date}T${m[1].padStart(2, "0")}:${m[2]}:00-03:00`);
    const cands = (games ?? []).filter((g) => g.league_id === r.league && Math.abs(Date.parse(g.starts_at) - t) <= 20 * 60e3);
    let best: Any = null, bestScore = 0;
    for (const g of cands) {
      const H = [g.home_name, g.home_short], A = [g.away_name, g.away_short];
      const s1a = sim(r.a, H), s1b = sim(r.b, A), s2a = sim(r.a, A), s2b = sim(r.b, H);
      const ok1 = s1a > 0 && s1b > 0, ok2 = s2a > 0 && s2b > 0;
      let score = Math.max(ok1 ? s1a + s1b + 10 : s1a + s1b, ok2 ? s2a + s2b + 10 : s2a + s2b);
      if (cands.length > 1 && score < 10) score = 0; // com vários jogos no mesmo horário, exige os dois times batendo
      if (score > bestScore) { best = g; bestScore = score; }
    }
    if (best && bestScore > 0) updates.set(best.id, { tv: r.tv, src: "futnatv" });
  }

  // NFL e NBA: jogo que não aparece na programação do dia passa só no pacote da liga.
  for (const g of games ?? []) {
    const fb = FALLBACK[g.league_id];
    if (!fb || updates.has(g.id)) continue;
    const dayBR = new Date(Date.parse(g.starts_at) - 3 * 3600e3).toISOString().slice(0, 10);
    if (daysSeen[g.league_id]?.has(dayBR)) updates.set(g.id, { tv: fb, src: "padrao" });
  }

  let changed = 0;
  for (const g of games ?? []) {
    const u = updates.get(g.id);
    if (!u || g.channels_source === "manual") continue;
    if (g.channels_override === u.tv && g.channels_source === u.src) continue;
    const { error: ue } = await sb.from("games")
      .update({ channels_override: u.tv, channels_source: u.src, channels_checked_at: new Date().toISOString() })
      .eq("id", g.id);
    if (ue) errors.push(`${g.id}: ${ue.message}`); else changed++;
  }

  await sb.from("sync_log").insert({ mode: "channels", leagues: `${rows.length} linhas`, games: changed, error: errors.length ? errors.slice(0, 8).join(" | ") : null });
  return Response.json({ rows: rows.length, matched: updates.size, changed, errors });
});
