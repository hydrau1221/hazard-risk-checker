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

// petit util pour l’enveloppe (≈ 250–300 m)
function envelopeAround(lon: number, lat: number, eps = 0.003) {
  return {
    xmin: lon - eps, ymin: lat - eps, xmax: lon + eps, ymax: lat + eps,
    spatialReference: { wkid: 4326 },
  };
}

async function fetchJson(url: string) {
  const r = await fetch(url, {
    headers: { accept: "application/json", "user-agent": UA },
    cache: "no-store",
  });
  let data: any;
  try { data = await r.json(); }
  catch { data = { __nonjson: true, text: await r.text() }; }
  return { ok: r.ok, data };
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

  const tries: any[] = [];
  const mkQuery = (p: Record<string, string>) =>
    `${BASE}/MapServer/${layerId}/query?${new URLSearchParams(p)}`;
  const mkIdentify = (p: Record<string, string>) =>
    `${BASE}/MapServer/identify?${new URLSearchParams(p)}`;

  // paramètres communs /query
  const common = {
    f: "json",
    where: "1=1",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnGeometry: "false",
    outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF,BFE,STATIC_BFE,DEPTH,ZONE,ZONE_SUBTYPE",
  };

  // 1) /query par POINT
  const point = { x: lon, y: lat, spatialReference: { wkid: 4326 } };
  let q1 = mkQuery({ ...common, geometryType: "esriGeometryPoint", geometry: JSON.stringify(point) });
  let { data } = await fetchJson(q1);
  tries.push({ step: "query-point", url: q1, err: data?.error, count: data?.features?.length ?? 0 });

  // 2) /query par ENVELOPE si 0 feature
  if (data?.error || !data?.features?.length) {
    const env = envelopeAround(lon, lat, 0.004);
    let q2 = mkQuery({
      ...common,
      geometryType: "esriGeometryEnvelope",
      geometry: JSON.stringify(env),
    });
    const r2 = await fetchJson(q2);
    data = { ...r2.data, __fallbackEnvelope: env };
    tries.push({ step: "query-envelope", url: q2, err: r2.data?.error, count: r2.data?.features?.length ?? 0 });
  }

  // 3) /identify (tolerance) si toujours rien
  if (data?.error || !data?.features?.length) {
    const env = envelopeAround(lon, lat, 0.01); // bbox carte
    const idParams = {
      f: "json",
      sr: "4326",
      geometryType: "esriGeometryPoint",
      geometry: JSON.stringify(point),
      mapExtent: JSON.stringify(env),
      imageDisplay: "800,600,96",
      tolerance: "4",
      layers: `all:${layerId}`,
      returnGeometry: "false",
    };
    const q3 = mkIdentify(idParams);
    const r3 = await fetchJson(q3);
    tries.push({ step: "identify", url: q3, err: r3.data?.error, count: r3.data?.results?.length ?? 0 });

    if (!r3.data?.error && r3.data?.results?.length) {
      // Harmonise au format /query
      data = {
        features: r3.data.results
          .filter((x: any) => x?.attributes)
          .map((x: any) => ({ attributes: x.attributes })),
        __fromIdentify: true,
      };
    } else {
      data = r3.data;
    }
  }

  // 4) s'il reste une erreur, on la propage
  if (data?.error) {
    const body = debug
      ? { error: data.error?.message || "NFHL error", details: data, __debug: tries }
      : { error: data.error?.message || "NFHL error" };
    return new Response(JSON.stringify(body), { status: 502, headers: json() });
  }

  // 5) sinon, réponse normale (avec traces si debug)
  const body = debug ? { ...data, __debug: tries } : data;
  return new Response(JSON.stringify(body), { headers: json() });
}
