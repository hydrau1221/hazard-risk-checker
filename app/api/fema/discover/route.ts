// app/api/fema/discover/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["iad1", "cle1", "pdx1"];

function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}
const UA = "RiskChecker/1.0 (+app)";

const CANDIDATE_BASES = [
  process.env.NFHL_BASE, // your env var if set
  "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL",
  "https://gis.fema.gov/arcgis/rest/services/NFHL",
].filter(Boolean) as string[];

async function fetchJSON(url: string) {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": UA }, cache: "no-store" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function tryFindLayer(base: string) {
  // 1) Name search via /find
  try {
    const findUrl = `${base}/MapServer/find?` + new URLSearchParams({
      searchText: "S_FLD_HAZ_AR",
      searchFields: "name",
      f: "json",
    });
    const j = await fetchJSON(findUrl);
    const hit = j?.results?.find((x: any) => String(x.layerName).toUpperCase() === "S_FLD_HAZ_AR");
    if (hit?.layerId != null) return { base, layerId: hit.layerId, name: "S_FLD_HAZ_AR" };
  } catch {}

  // 2) List layers, then inspect each for fields
  const top = await fetchJSON(`${base}/MapServer?f=json`);
  const layers: any[] = top?.layers ?? [];
  // Prefer layers whose name contains "FLOOD HAZARD" or equals S_FLD_HAZ_AR
  const ordered = layers.sort((a, b) => {
    const an = String(a.name).toUpperCase(), bn = String(b.name).toUpperCase();
    const aw = (an.includes("FLOOD HAZARD") ? 2 : 0) + (an === "S_FLD_HAZ_AR" ? 3 : 0);
    const bw = (bn.includes("FLOOD HAZARD") ? 2 : 0) + (bn === "S_FLD_HAZ_AR" ? 3 : 0);
    return bw - aw;
  });

  for (const L of ordered) {
    const info = await fetchJSON(`${base}/MapServer/${L.id}?f=json`);
    const geom = info?.geometryType || "";
    const fields: string[] = (info?.fields || []).map((f: any) => String(f.name).toUpperCase());
    const hasCore = fields.includes("FLD_ZONE") && fields.includes("SFHA_TF");
    if (geom.includes("Polygon") && hasCore) {
      return { base, layerId: L.id, name: info?.name ?? L.name };
    }
  }

  throw new Error("No NFHL flood polygon layer found");
}

export async function GET() {
  for (const base of CANDIDATE_BASES) {
    try {
      const found = await tryFindLayer(base);
      return new Response(JSON.stringify({
        ...found,
        serviceUrl: `${found.base}/MapServer/${found.layerId}`,
      }), { headers: json() });
    } catch {}
  }
  return new Response(JSON.stringify({ error: "Could not locate NFHL flood layer on any base." }),
    { status: 404, headers: json() });
}
