export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["iad1", "cle1", "pdx1"];

function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 RiskChecker/1.0";

const CANDIDATE_BASES = [
  process.env.NFHL_BASE,
  "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL",
  "https://gis.fema.gov/arcgis/rest/services/NFHL",
].filter(Boolean) as string[];

async function pickBase() {
  for (const base of CANDIDATE_BASES) {
    try {
      const r = await fetch(`${base}/MapServer?f=json`, {
        headers: { accept: "application/json", "user-agent": UA },
        cache: "no-store",
      });
      if (r.ok) return base;
    } catch {}
  }
  throw new Error("All NFHL endpoints unreachable");
}

function envelopeAround(lon: number, lat: number, eps = 0.001) {
  return { xmin: lon - eps, ymin: lat - eps, xmax: lon + eps, ymax: lat + eps, spatialReference: { wkid: 4326 } };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const lat = Number(searchParams.get("lat"));
  const lon = Number(searchParams.get("lon"));
  const layerId = searchParams.get("layerId");

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !layerId) {
    return new Response(JSON.stringify({ error: "lat, lon, layerId are required" }), {
      status: 400, headers: json(),
    });
  }

  try {
    const base = await pickBase();
    const point = { x: lon, y: lat, spatialReference: { wkid: 4326 } };
    const mkQuery = (p: Record<string, string>) =>
      `${base}/MapServer/${layerId}/query?${new URLSearchParams(p)}`;

    const baseParams = {
      f: "json",
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      returnGeometry: "false",
      outFields: "*",
      geometry: JSON.stringify(point),
    };

    let res = await fetch(mkQuery(baseParams), {
      headers: { accept: "application/json", "user-agent": UA },
      cache: "no-store",
    });
    let data = await res.json();

    if (!data?.features?.length) {
      const env = envelopeAround(lon, lat, 0.001);
      const envParams = { ...baseParams, geometryType: "esriGeometryEnvelope", geometry: JSON.stringify(env) };
      res = await fetch(mkQuery(envParams), {
        headers: { accept: "application/json", "user-agent": UA },
        cache: "no-store",
      });
      data = await res.json();
      data.__fallbackEnvelope = env;
    }

    return new Response(JSON.stringify(data), { headers: json() });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: json() });
  }
}
