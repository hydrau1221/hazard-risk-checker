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

// Base publique/stable NFHL (surchargée si NFHL_BASE est défini)
const BASE = (process.env.NFHL_BASE ||
  "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL"
).replace(/\/+$/, "");

function envelopeAround(lon: number, lat: number, eps = 0.002) {
  return {
    xmin: lon - eps, ymin: lat - eps, xmax: lon + eps, ymax: lat + eps,
    spatialReference: { wkid: 4326 },
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const layerId = Number(url.searchParams.get("layerId"));
  const debug = url.searchParams.get("debug") === "1";

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(layerId)) {
    return new Response(JSON.stringify({ error: "lat, lon, layerId are required" }), { status: 400, headers: json() });
  }

  const mkQuery = (p: Record<string, string>) =>
    `${BASE}/MapServer/${layerId}/query?${new URLSearchParams(p)}`;

  const baseParams = {
    f: "json",
    where: "1=1",                                 // toujours un WHERE
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnGeometry: "false",
    outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF,BFE,STATIC_BFE,DEPTH,ZONE,ZONE_SUBTYPE",
    // ⚠️ Surtout pas resultRecordCount ici → cause “Failed to execute query.”
  };

  const tries: any[] = [];

  async function doFetch(params: Record<string, string>, label: string) {
    const qs = { ...baseParams, ...params };
    const url = mkQuery(qs);
    const r = await fetch(url, { headers: { accept: "application/json", "user-agent": UA }, cache: "no-store" });
    let data: any;
    try { data = await r.json(); } catch { data = { __nonjson: true, text: await r.text() }; }
    tries.push({ label, url, httpOk: r.ok, err: data?.error, count: data?.features?.length ?? 0 });
    return { ok: r.ok, data };
  }

  const point = { x: lon, y: lat, spatialReference: { wkid: 4326 } };
  let { data } = await doFetch(
    { geometryType: "esriGeometryPoint", geometry: JSON.stringify(point) },
    "point"
  );

  // Si erreur ou aucune feature → fallback enveloppe
  if (data?.error || !data?.features?.length) {
    const env = envelopeAround(lon, lat, 0.002);
    const res2 = await doFetch(
      { geometryType: "esriGeometryEnvelope", geometry: JSON.stringify(env) },
      "envelope"
    );
    data = { ...res2.data, __fallbackEnvelope: env };
  }

  // Si toujours erreur, on la remonte (le front l'affichera au lieu de "Very Low")
  if (data?.error) {
    const body = debug ? { error: data.error?.message || "NFHL error", details: data, __debug: tries } : { error: data.error?.message || "NFHL error" };
    return new Response(JSON.stringify(body), { status: 502, headers: json() });
  }

  // Mode debug pour inspecter les URLs tentées
  const body = debug ? { ...data, __debug: tries } : data;
  return new Response(JSON.stringify(body), { headers: json() });
}
