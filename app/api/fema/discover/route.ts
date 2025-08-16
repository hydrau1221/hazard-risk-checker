export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["iad1", "cle1", "pdx1"]; // US regions (Vercel)

function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}

const UA = "RiskChecker/1.0 (+vercel)";

const CANDIDATE_BASES = [
  process.env.NFHL_BASE, // ta variable d'env, si définie
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

  // Score par “signatures” des couches NFHL d’aléas d’inondation
  let s = 0;
  if (has("FLD_ZONE")) s += 5;                   // cœur NFHL
  if (has("SFHA_TF")) s += 3;                    // Special Flood Hazard Area flag
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

  for (const base of CANDIDATE_BASES) {
    try {
      // Liste des layers (on ne garde que les "leaf" sans subLayerIds)
      const top = await fetchJSON(`${base}/MapServer?f=json`);
      const leaves = (top?.layers ?? []).filter((L: any) => !L.subLayerIds || L.subLayerIds.length === 0);

      const candidates: Array<{ id: number; name: string; score: number }> = [];

      // Inspecte chaque sous-layer
      for (const L of leaves) {
        try {
          const info = await fetchJSON(`${base}/MapServer/${L.id}?f=json`);
          const score = scoreLayer(info);
          candidates.push({ id: L.id, name: info?.name ?? L.name, score });
        } catch {
          // ignore ce sous-layer si non lisible
        }
      }

      // Trie par score décroissant
      candidates.sort((a, b) => b.score - a.score);

      // Prend le meilleur suffisamment “typique”
      const best = candidates.find((c) => c.score >= 5);
      if (best) {
        const payload: any = {
          base,
          layerId: best.id,
          name: best.name,
          serviceUrl: `${base}/MapServer/${best.id}`,
        };
        if (debug) payload._candidates = candidates.slice(0, 10);
        return new Response(JSON.stringify(payload), { headers: json() });
      }

      // si rien de bon sur cette base, on essaie la suivante
      if (debug) {
        return new Response(
          JSON.stringify({
            error: "No suitable flood polygon layer on this base",
            base,
            topCandidates: candidates.slice(0, 10),
          }),
          { status: 404, headers: json() }
        );
      }
    } catch {
      // essaie la base suivante
    }
  }

  return new Response(JSON.stringify({ error: "Could not locate NFHL flood layer on any base." }), {
    status: 404,
    headers: json(),
  });
}
