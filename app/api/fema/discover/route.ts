export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["iad1", "cle1", "pdx1"];

function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 RiskChecker/1.0";

const CANDIDATE_BASES = [
  process.env.NFHL_BASE, // ta variable d'env (si présente)
  "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL",
  "https://gis.fema.gov/arcgis/rest/services/NFHL",
].filter(Boolean) as string[];

async function tryFindLayerId(base: string) {
  // 1) Essai via /find (plus fiable)
  const findUrl =
    `${base}/MapServer/find?` +
    new URLSearchParams({ searchText: "S_FLD_HAZ_AR", searchFields: "name", f: "json" });
  let r = await fetch(findUrl, { headers: { accept: "application/json", "user-agent": UA }, cache: "no-store" });
  if (r.ok) {
    const j = await r.json();
    const hit = j?.results?.find((x: any) => String(x.layerName).toUpperCase() === "S_FLD_HAZ_AR");
    if (hit?.layerId != null) return { layerId: hit.layerId, base };
  }

  // 2) Fallback: liste des layers et match exact
  r = await fetch(`${base}/MapServer?f=json`, { headers: { accept: "application/json", "user-agent": UA }, cache: "no-store" });
  if (!r.ok) throw new Error(`MapServer ${base} non lisible (${r.status})`);
  const data = await r.json();
  const layers = data?.layers ?? [];
  const target = layers.find((l: any) => String(l.name).toUpperCase() === "S_FLD_HAZ_AR");
  if (target) return { layerId: target.id, base };

  // Info debug utile si rien trouvé
  const names = layers.map((l: any) => l.name).slice(0, 40);
  throw new Error(`S_FLD_HAZ_AR not in service. Sample layers: ${names.join(", ")}`);
}

export async function GET() {
  for (const base of CANDIDATE_BASES) {
    try {
      const found = await tryFindLayerId(base);
      return new Response(JSON.stringify({ ...found, serviceUrl: `${found.base}/MapServer/${found.layerId}` }), {
        headers: json(),
      });
    } catch (e) {
      // essaie la base suivante
    }
  }
  return new Response(JSON.stringify({ error: "S_FLD_HAZ_AR not found on any known NFHL service." }), {
    status: 404,
    headers: json(),
  });
}
