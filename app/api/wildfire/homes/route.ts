// app/api/wildfire/homes/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ImageServer USFS (Risk to Potential Structures = "Risk to Homes")
const RPS_IMG =
  process.env.WFR_RPS_URL ||
  "https://apps.fs.usda.gov/fsgisx01/rest/services/RDW_Wildfire/RMRS_WRC_RiskToPotentialStructures/ImageServer";

type Five =
  | "Very Low" | "Low" | "Moderate" | "High" | "Very High"
  | "Undetermined" | "Not Applicable";

// simple bins (0–1020 env.) — on pourra affiner si tu veux plus tard
function levelFromValue(v: number | null): Five {
  if (v == null || !Number.isFinite(v)) return "Not Applicable"; // ex. eau / non-burnable
  if (v < 160)  return "Very Low";
  if (v < 350)  return "Low";
  if (v < 600)  return "Moderate";
  if (v < 850)  return "High";
  return "Very High";
}

async function getSample(lat: number, lon: number) {
  const params = new URLSearchParams({
    f: "json",
    geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    sr: "4326",
    returnFirstValueOnly: "true",
    interpolation: "RSP_NearestNeighbor",
    // applique la fonction raster “RPS” (Risk to Potential Structures)
    renderingRule: JSON.stringify({ rasterFunction: "RPS" }),
  });

  const url = `${RPS_IMG}/getSamples?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  const t = await r.text();
  let j: any = null; try { j = JSON.parse(t); } catch {}
  if (!r.ok) return { ok: false as const, status: r.status, url, body: t };

  const val =
    Array.isArray(j?.samples) && j.samples.length
      ? Number(j.samples[0]?.value)
      : null;

  return { ok: true as const, url, value: Number.isFinite(val) ? val : null };
}

async function geocodeFromAddress(req: NextRequest, address: string) {
  const origin = new URL(req.url).origin;
  const u = `${origin}/api/geocode?address=${encodeURIComponent(address)}`;
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error(`geocode failed: ${r.status}`);
  const j = await r.json();
  if (typeof j.lat !== "number" || typeof j.lon !== "number") {
    throw new Error("geocode returned invalid lat/lon");
  }
  return { lat: j.lat as number, lon: j.lon as number, geocode: j };
}

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const debug = u.searchParams.get("debug") === "1";
  const address = u.searchParams.get("address");
  const lat = u.searchParams.get("lat");
  const lon = u.searchParams.get("lon");

  let latNum: number, lonNum: number, geocodeInfo: any = null;
  try {
    if (address && (!lat || !lon)) {
      const g = await geocodeFromAddress(req, address);
      latNum = g.lat; lonNum = g.lon; geocodeInfo = g.geocode;
    } else {
      latNum = Number(lat); lonNum = Number(lon);
    }
  } catch (e: any) {
    return Response.json({ error: e?.message || "geocode error" }, { status: 400 });
  }
  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    return Response.json({ error: "Missing lat/lon" }, { status: 400 });
  }

  const tries: any[] = [];
  const sample = await getSample(latNum, lonNum);
  tries.push({ url: (sample as any).url, ok: sample.ok, status: (sample as any).status, hasValue: sample.ok && sample.value != null });

  if (sample.ok) {
    const v = sample.value ?? null;
    const level = levelFromValue(v);
    const body: any = {
      level,
      value: v,
      adminUnit: "pixel",
      provider: "USFS / Wildfire Risk to Communities (Risk to Homes, RPS)",
    };
    if (debug) body.debug = { geocode: geocodeInfo, attempts: tries };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  const res: any = { level: "Undetermined", value: null, provider: "USFS WRC" };
  if (debug) res.debug = { geocode: geocodeInfo, attempts: tries };
  return Response.json(res, { status: 502 });
}
