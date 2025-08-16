export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["iad1", "cle1", "pdx1"];

function json(h: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
    ...h,
  };
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 RiskChecker/1.0";

// ✅ on fige la base fiable
const BASE = (process.env.NFHL_BASE || "https://gis.fema.gov/arcgis/rest/services/NFHL").replace(/\/+$/, "");

function envelopeAround(lon: number, lat: number, eps = 0.001) {
  return { xmin: lon - eps, ymin: lat - eps, xmax: lon + eps, ymax: lat + eps, spatialReference: { wkid: 4326 } };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  const layerId = Number(searchParams.get("layerId"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(layerId)) {
    return new Response(JSON.stringify({ error: "lat, lon, layerId are required" }), { status: 400, headers: json() });
  }

  const mkQuery = (p: Record<string, string>) => `${BASE}/MapServer/${layerId}/query?${new URLSearchParams(p)}`;

  const point = { x: lon, y: lat, spatialReference: { wkid: 4326 } };
  const baseParams = {
    f: "json",
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnGeometry: "false",
    outFields: "*",
    geometry: JSON.stringify(point),
  };

  // 1) par point
  let r = await fetch(mkQuery(baseParams), { headers: { accept: "application/json", "user-agent": UA }, cache: "no-store" });
  let j = await r.json();

  // 2) fallback par enveloppe
  if (!j?.features?.length) {
    const env = envelopeAround(lon, lat, 0.001);
    const envParams = { ...baseParams, geometryType: "esriGeometryEnvelope", geometry: JSON.stringify(env) };
    r = await fetch(mkQuery(envParams), { headers: { accept: "application/json", "user-agent": UA }, cache: "no-store" });
    j = await r.json();
    j.__fallbackEnvelope = env;
  }

  return new Response(JSON.stringify(j), { headers: json() });
}
