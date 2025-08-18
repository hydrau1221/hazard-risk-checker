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

// ✅ base publique/stable NFHL (surchargable par NFHL_BASE)
const BASE = (process.env.NFHL_BASE ||
  "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL"
).replace(/\/+$/, "");

function envelopeAround(lon: number, lat: number, eps = 0.001) {
  return {
    xmin: lon - eps, ymin: lat - eps, xmax: lon + eps, ymax: lat + eps,
    spatialReference: { wkid: 4326 },
  };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  const layerId = Number(searchParams.get("layerId"));

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(layerId)) {
    return new Response(JSON.stringify({ error: "lat, lon, layerId are required" }), { status: 400, headers: json() });
  }

  const mkQuery = (p: Record<string, string>) =>
    `${BASE}/MapServer/${layerId}/query?${new URLSearchParams(p)}`;

  // ⚠️ ArcGIS Query: always provide a WHERE (1=1 is OK)
  const baseParams = {
    f: "json",
    where: "1=1",
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnGeometry: "false",
    outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF,BFE,STATIC_BFE,DEPTH,ZONE,ZONE_SUBTYPE",
    resultRecordCount: "1",
  };

  // 1) point query
  const point = { x: lon, y: lat, spatialReference: { wkid: 4326 } };
  let r = await fetch(
    mkQuery({ ...baseParams, geometry: JSON.stringify(point) }),
    { headers: { accept: "application/json", "user-agent": UA }, cache: "no-store" }
  );
  let j = await r.json();

  // 👉 si l’API renvoie une erreur JSON, on la propage avec un code HTTP ≠ 200
  if ((j as any)?.error) {
    return new Response(JSON.stringify({ error: (j as any).error?.message || "NFHL error", details: j }),
      { status: 502, headers: json() });
  }

  // 2) fallback par enveloppe si rien trouvé
  if (!j?.features?.length) {
    const env = envelopeAround(lon, lat, 0.002); // un peu plus large
    r = await fetch(
      mkQuery({
        ...baseParams,
        geometryType: "esriGeometryEnvelope",
        geometry: JSON.stringify(env),
      }),
      { headers: { accept: "application/json", "user-agent": UA }, cache: "no-store" }
    );
    const j2 = await r.json();

    if ((j2 as any)?.error) {
      return new Response(JSON.stringify({ error: (j2 as any).error?.message || "NFHL error", details: j2 }),
        { status: 502, headers: json() });
    }

    j = { ...j2, __fallbackEnvelope: env };
  }

  return new Response(JSON.stringify(j), { headers: json() });
}
