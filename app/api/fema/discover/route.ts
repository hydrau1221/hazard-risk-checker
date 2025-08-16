export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["iad1", "cle1", "pdx1"]; // régions US

function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}

const UA = "RiskChecker/1.0 (+vercel)";

const CANDIDATE_BASES = [
  process.env.NFHL_BASE?.replace(/\/+$/, ""), // ta var d'env si définie (sans / final)
  "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL",
  "https://gis.fema.gov/arcgis/rest/services/NFHL",
].filter(Boolean) as string[];

async function fetchJSON(url: string) {
  const r = await fetch(url, {
    headers: { accept: "application/json", "user-agent": UA },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

function toUpperNames(fields: any[] = []) {
  return fields.map((f: any) => String(f.name).toUpperCase());
}

function scoreLayer(info: any) {
  const geom = String(info?.geometryType || "").toLowerCase();
  if (!geom.includes("polygon")) return -1;

  const names = toUpperNames(info?.fields);
  const has = (n: string) => names.includes(n);

  let s = 0;
  if (has("FLD_ZONE")) s += 5;
  if (has("SFHA_TF")) s += 3;
  if (has("ZONE_SUBTY") || has("ZONE_SUBTYPE")) s += 2;
  if (has("BFE") || has("STATIC_BFE") || has("DEPTH") || has("VE_ZONE")) s += 1;

  const nm = String(info?.name || "").toUpperCase();
  if (nm === "S_FLD_HAZ_AR") s += 3;
  if (nm.includes("FLOOD") && nm.includes("HAZARD")) s += 2;

  return s;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const debug = url.searchParams.get("debug") === "1";
  const reports: any[] = [];

  for (const base of CANDIDATE_BASES) {
    try {
      // Liste des layers
      const top = await fetchJSON(`${base}/MapServer?f=json`);
      const layers: any[] = top?.layers ?? [];

      // 1) Essai par nom direct
      const direct = layers.find((L: any) => {
        const n = String(L.name).toUpperCase();
        return n === "S_FLD_HAZ_AR" || n.includes("FLOOD HAZARD ZONES");
      });
      if (direct) {
        const payload: any = {
          base,
          layerId: direct.id,
          name: direct.name,
          serviceUrl: `${base}/MapServer/${direct.id}`,
        };
        if (debug) payload._mode = "direct-name";
        return new Response(JSON.stringify(payload), { headers: json() });
      }

      // 2) Fallback — inspection + scoring par champs
      const leaves = layers.filter((L: any) => !L.subLayerIds || L.subLayerIds.length === 0);
      const candidates: Array<{ id: number; name: string; score: number }> = [];

      for (const L of leaves) {
        try {
          const info = await fetchJSON(`${base}/MapServer/${L.id}?f=json`);
          const score = scoreLayer(info);
          if (score >= 0) candidates.push({ id: L.id, name: info?.name ?? L.name, score });
        } catch {}
      }

      candidates.sort((a, b) => b.score - a.score);
      if (debug) reports.push({ base, topCandidates: candidates.slice(0, 10) });

      const best = candidates[0];
      if (best && best.score >= 5) {
        const payload: any = {
          base,
          layerId: best.id,
          name: best.name,
          serviceUrl: `${base}/MapServer/${best.id}`,
        };
        if (debug) payload._mode = "scored";
        return new Response(JSON.stringify(payload), { headers: json() });
      }
      // sinon on essaie la base suivante
    } catch (e: any) {
      if (debug) reports.push({ base, error: String(e?.message || e) });
      // on passe à l'hôte suivant
    }
  }

  if (debug) {
    return new Response(
      JSON.stringify({ error: "Could not locate NFHL flood layer on any base.", reports }),
      { status: 404, headers: json() }
    );
  }
  return new Response(JSON.stringify({ error: "Could not locate NFHL flood layer on any base." }), {
    status: 404,
    headers: json(),
  });
}
