// app/api/wildfire/homes/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ImageServer officiel USFS – Risk to Potential Structures (Risk to Homes)
const RPS_IMG =
  process.env.WFR_RPS_URL ||
  "https://apps.fs.usda.gov/fsgisx01/rest/services/RDW_Wildfire/RMRS_WRC_RiskToPotentialStructures/ImageServer";

type Five =
  | "Very Low" | "Low" | "Moderate" | "High" | "Very High"
  | "Undetermined" | "Not Applicable";

// Bins simples (valeurs RPS ~0–1020). Ajustables plus tard si besoin.
function levelFromValue(v: number | null): Five {
  if (v == null || !Number.isFinite(v)) return "Not Applicable"; // eau / non-brûlable / pas de structures
  if (v < 160)  return "Very Low";
  if (v < 350)  return "Low";
  if (v < 600)  return "Moderate";
  if (v < 850)  return "High";
  return "Very High";
}

function degPerMeterLat() { return 1 / 111_320; }
function degPerMeterLon(latDeg: number) {
  const k = Math.cos((latDeg * Math.PI) / 180);
  return 1 / (111_320 * (k || 1e-6));
}

async function getSample(lat: number, lon: number) {
  const params = new URLSearchParams({
    f: "json",
    geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    sr: "4326",
    returnFirstValueOnly: "true",
    interpolation: "RSP_NearestNeighbor",
    renderingRule: JSON.stringify({ rasterFunction: "RPS" }),
  });
  const url = `${RPS_IMG}/getSamples?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  const t = await r.text();
  let j: any = null; try { j = JSON.parse(t); } catch {}
  if (!r.ok) return { ok: false as const, status: r.status, url, body: t };

  const raw = Array.isArray(j?.samples) && j.samples.length ? j.samples[0]?.value : null;
  const val = Number.isFinite(Number(raw)) ? Number(raw) : null;
  return { ok: true as const, url, value: val };
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

/**
 * Cherche un pixel coloré autour du point si la valeur est nulle (no-data)
 * Rayon max ≈ 300 m ; pas angulaire adapté à la circonférence (≈ 30 m d’arc).
 */
async function sampleNearestColored(lat: number, lon: number) {
  const attempts: Array<{ url: string; ok: boolean; hasValue: boolean; radius?: number }> = [];

  // 0) sur le point
  const first = await getSample(lat, lon);
  attempts.push({ url: (first as any).url, ok: first.ok, hasValue: first.ok && first.value != null });
  if (first.ok && first.value != null) {
    return { value: first.value, meters: 0, attempts };
  }

  // 1) anneaux de 30 → 300 m
  const step = 30; // ~taille pixel
  for (let radius = step; radius <= 300; radius += step) {
    // nombre d'échantillons ~ 2πR / 30 m (min 8)
    const n = Math.max(8, Math.round((2 * Math.PI * radius) / step));
    const dLat = degPerMeterLat() * radius;
    const dLon = degPerMeterLon(lat) * radius;

    for (let i = 0; i < n; i++) {
      const ang = (i / n) * 2 * Math.PI;
      const lt = lat + dLat * Math.sin(ang);
      const ln = lon + dLon * Math.cos(ang);
      const s = await getSample(lt, ln);
      attempts.push({ url: (s as any).url, ok: s.ok, hasValue: s.ok && s.value != null, radius });
      if (s.ok && s.value != null) {
        return { value: s.value, meters: radius, attempts };
      }
    }
  }

  return { value: null as number | null, meters: null as number | null, attempts };
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

  const near = await sampleNearestColored(latNum, lonNum);
  const v = near.value;
  const level = levelFromValue(v);

  const body: any = {
    level,
    value: v,
    adminUnit: "pixel",
    provider: "USFS / Wildfire Risk to Communities (Risk to Homes, RPS)",
  };

  if (near.meters && near.meters > 0) {
    body.note = `Nearest colored pixel used (~${near.meters} m).`;
    body.nearestMeters = near.meters;
  } else if (v == null) {
    body.note = "No pixel value at this location (likely water / non-burnable / no structures).";
  }

  if (debug) body.debug = { geocode: geocodeInfo, attempts: near.attempts };

  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
