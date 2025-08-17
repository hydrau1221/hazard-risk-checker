import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deux sources fiables : AGOL (prioritaire) puis USFS (RPS). */
const SOURCES: Array<{ url: string; mode: "raw" | "rps" }> = [
  { url: "https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/Risk_to_Homes/ImageServer", mode: "raw" },
  { url: "https://apps.fs.usda.gov/fsgisx01/rest/services/RDW_Wildfire/RMRS_WRC_RiskToPotentialStructures/ImageServer", mode: "rps" },
];

type Five = "Very Low" | "Low" | "Moderate" | "High" | "Very High" | "Undetermined" | "Not Applicable";

/** Binning simple sur l’échelle ~0–1020 (RPS). */
function levelFromValue(v: number | null): Five {
  if (v == null || !Number.isFinite(v)) return "Not Applicable";
  if (v < 160) return "Very Low";
  if (v < 350) return "Low";
  if (v < 600) return "Moderate";
  if (v < 850) return "High";
  return "Very High";
}

/** convertit du 0–1 éventuel vers 0–1020. */
function normalizeRPS(x: number | null): number | null {
  if (x == null || !Number.isFinite(x)) return null;
  // Beaucoup de miroirs renvoient 0–1 : on détecte et on étire.
  return x <= 1.5 ? x * 1020 : x;
}

function degPerMeterLat() { return 1 / 111_320; }
function degPerMeterLon(latDeg: number) {
  const k = Math.cos((latDeg * Math.PI) / 180);
  return 1 / (111_320 * (k || 1e-6));
}

async function getSampleAt(src: {url:string; mode:"raw"|"rps"}, lat: number, lon: number) {
  const params = new URLSearchParams({
    f: "json",
    geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    sr: "4326",
    returnFirstValueOnly: "true",
    interpolation: "RSP_NearestNeighbor",
  });
  if (src.mode === "rps") {
    params.set("renderingRule", JSON.stringify({ rasterFunction: "RPS" }));
  }
  const url = `${src.url}/getSamples?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  const t = await r.text();
  let j: any = null; try { j = JSON.parse(t); } catch {}
  if (!r.ok) return { ok: false as const, status: r.status, url, body: t, value: null as number | null };

  // AGOL peut renvoyer string, nombre, ou "NaN"
  let raw: any = Array.isArray(j?.samples) && j.samples.length ? j.samples[0]?.value : null;
  if (typeof raw === "string") raw = raw.split(",")[0]; // sécurité si string multi-bandes
  const val = Number.isFinite(Number(raw)) ? Number(raw) : null;

  return { ok: true as const, url, value: normalizeRPS(val) };
}

/** Cherche un pixel coloré (valeur ≠ null) le plus proche, jusqu’à 300 m. */
async function sampleNearest(lat: number, lon: number) {
  const attempts: any[] = [];

  // on parcourt les sources en priorité AGOL
  for (const src of SOURCES) {
    // test au point
    const first = await getSampleAt(src, lat, lon);
    attempts.push({ src: src.url, url: first.url, ok: first.ok, hasValue: first.value != null, radius: 0 });
    if (first.ok && first.value != null) return { value: first.value, meters: 0, attempts, provider: src.url };

    // anneaux 30 → 300 m
    const step = 30;
    for (let radius = step; radius <= 300; radius += step) {
      const n = Math.max(8, Math.round((2 * Math.PI * radius) / step));
      const dLat = degPerMeterLat() * radius;
      const dLon = degPerMeterLon(lat) * radius;
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * 2 * Math.PI;
        const lt = lat + dLat * Math.sin(ang);
        const ln = lon + dLon * Math.cos(ang);
        const s = await getSampleAt(src, lt, ln);
        attempts.push({ src: src.url, url: s.url, ok: s.ok, hasValue: s.value != null, radius });
        if (s.ok && s.value != null) return { value: s.value, meters: radius, attempts, provider: src.url };
      }
    }
  }

  // rien trouvé
  return { value: null as number | null, meters: null as number | null, attempts, provider: null as string | null };
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

  const near = await sampleNearest(latNum, lonNum);
  const v = near.value;
  const level = levelFromValue(v);

  const body: any = {
    level,
    value: v,
    adminUnit: "pixel",
    provider: "USFS / Wildfire Risk to Communities (Risk to Homes, RPS)",
  };

  if (near.provider) body.provider = near.provider.includes("services3.arcgis.com") ? "AGOL Risk_to_Homes (pixel)" : "USFS RPS (pixel)";
  if (near.meters && near.meters > 0) {
    body.note = `Nearest colored pixel used (~${near.meters} m).`;
    body.nearestMeters = near.meters;
  } else if (v == null) {
    body.note = "No pixel value at this location (water / non-burnable / no structures).";
  }

  if (debug) body.debug = { geocode: geocodeInfo, attempts: near.attempts.slice(0, 40) };

  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
