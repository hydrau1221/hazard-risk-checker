export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(headers: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...headers };
}

const NFHL_BASE = process.env.NFHL_BASE ?? "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL";

function envelopeAround(lon: number, lat: number, eps = 0.001) {
  return { xmin: lon - eps, ymin: lat - eps, xmax: lon + eps, ymax: lat + eps, spatialReference: { wkid: 4326 } };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  const layerId = searchParams.get("layerId");

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !layerId) {
    return new Response(JSON.stringify({ error: "lat, lon, layerId are required" }), { status: 400, headers: json() });
  }

  const point = { x: lon, y: lat, spatialReference: { wkid: 4326 } };
  const mkQuery = (p: Record<string, string>) => `${NFHL_BASE}/MapServer/${layerId}/query?${new URLSearchParams(p)}`;
  const baseParams = {
    f: "json",
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnGeometry: "false",
    outFields: "*",
    geometry: JSON.stringify(point),
  };

  let res = await fetch(mkQuery(baseParams));
  let data = await res.json();

  if (!data?.features?.length) {
    const env = envelopeAround(lon, lat, 0.001);
    const envParams = { ...baseParams, geometryType: "esriGeometryEnvelope", geometry: JSON.stringify(env) };
    res = await fetch(mkQuery(envParams));
    data = await res.json();
    data.__fallbackEnvelope = env;
  }

  return new Response(JSON.stringify(data), { headers: json() });
}
