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

// Base publique/stable NFHL (overridable par NFHL_BASE si besoin)
const BASE = (process.env.NFHL_BASE ||
  "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL"
).replace(/\/+$/, "");

async function getJson(url: string) {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": UA }, cache: "no-store" });
  let data: any;
  try { data = await r.json(); } catch { data = { __nonjson: true, text: await r.text() }; }
  return { ok: r.ok, data };
}

async function getLayerId(): Promise<number> {
  // Découvre l’ID du layer "S_FLD_HAZ_AR" si jamais il change
  const meta = await getJson(`${BASE}/MapServer?f=pjson`);
  const layers: any[] = meta.data?.layers ?? [];
  const found = layers.find(l =>
    String(l?.name || "").toUpperCase().includes("S_FLD_HAZ_AR") ||
    String(l?.name || "").toUpperCase().includes("FLOOD HAZARD ZONES")
  );
  // fallback: 28 (valeur classique)
  return Number.isFinite(found?.id) ? found.id : 28;
}

function envelopeAround(lon: number, lat: number, eps = 0.01) {
  return { xmin: lon - eps, ymin: lat - eps, xmax: lon + eps, ymax: lat + eps, spatialReference: { wkid: 4326 } };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const forcedLayerId = url.searchParams.get("layerId");
  const debug = url.searchParams.get("debug") === "1";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return new Response(JSON.stringify({ error: "lat, lon are required" }), { status: 400, headers: json() });
  }

  const layerId = Number.isFinite(Number(forcedLayerId)) ? Number(forcedLayerId) : await getLayerId();

  const tries: any[] = [];
  const mkQuery = (p: Record<string, string>) => `${BASE}/MapServer/${layerId}/query?${new URLSearchParams(p)}`;
  const mkIdentify = (p: Record<string, string>) => `${BASE}/MapServer/identify?${new URLSearchParams(p)}`;

  const common = {
    f: "json",
    where: "1=1",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnGeometry: "false",
    outFields: "FLD_ZONE,ZONE_SUBTY,SFHA_TF,BFE,STATIC_BFE,DEPTH,ZONE,ZONE_SUBTYPE",
  };

  const point = { x: lon, y: lat, spatialReference: { wkid: 4326 } };
  let data: any = null;

  // 1) /query par point avec buffer progressif (0, 5, 15, 40 m)
  for (const dist of [0, 5, 15, 40]) {
    const q = mkQuery({
      ...common,
      geometryType: "esriGeometryPoint",
      geometry: JSON.stringify(point),
      ...(dist > 0 ? { distance: String(dist), units: "esriSRUnit_Meter" } : {}),
    });
    const r = await getJson(q);
    tries.push({ step: `query-point-${dist}m`, url: q, err: r.data?.error, count: r.data?.features?.length ?? 0 });
    if (!r.data?.error && r.data?.features?.length) { data = r.data; break; }
  }

  // 2) /query par enveloppe si rien trouvé
  if (!data) {
    const env = { xmin: lon - 0.004, ymin: lat - 0.004, xmax: lon + 0.004, ymax: lat + 0.004, spatialReference: { wkid: 4326 } };
    const q2 = mkQuery({ ...common, geometryType: "esriGeometryEnvelope", geometry: JSON.stringify(env) });
    const r2 = await getJson(q2);
    tries.push({ step: "query-envelope", url: q2, err: r2.data?.error, count: r2.data?.features?.length ?? 0 });
    if (!r2.data?.error && r2.data?.features?.length) data = { ...r2.data, __fallbackEnvelope: env };
  }

  // 3) /identify (tolerance) si toujours rien
  if (!data) {
    const env = envelopeAround(lon, lat, 0.01);
    const p = {
      f: "json",
      sr: "4326",
      geometryType: "esriGeometryPoint",
      geometry: JSON.stringify(point),
      mapExtent: JSON.stringify(env),
      imageDisplay: "800,600,96",
      tolerance: "6",
      layers: `all:${layerId}`,
      returnGeometry: "false",
    };
    const q3 = mkIdentify(p);
    const r3 = await getJson(q3);
    tries.push({ step: "identify", url: q3, err: r3.data?.error, count: r3.data?.results?.length ?? 0 });

    if (!r3.data?.error && r3.data?.results?.length) {
      data = {
        features: r3.data.results.filter((x: any) => x?.attributes).map((x: any) => ({ attributes: x.attributes })),
        __fromIdentify: true,
      };
    } else if (r3.data?.error) {
      const body = debug ? { error: r3.data.error?.message || "NFHL error", details: r3.data, __debug: tries } : { error: r3.data.error?.message || "NFHL error" };
      return new Response(JSON.stringify(body), { status: 502, headers: json() });
    }
  }

  // 4) si malgré tout rien trouvé → features vides (le client décidera)
  if (!data) data = { features: [] };

  const body = debug ? { ...data, __layerId: layerId, __debug: tries } : data;
  return new Response(JSON.stringify(body), { headers: json() });
}
