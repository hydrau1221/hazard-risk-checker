// app/api/wildfire/homes/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sources: AGOL prioritaire → USFS fallback */
const SOURCES: Array<{ url: string; name: string }> = [
  { url: "https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/Risk_to_Homes/ImageServer", name: "AGOL Risk_to_Homes" },
  { url: "https://apps.fs.usda.gov/fsgisx01/rest/services/RDW_Wildfire/RMRS_WRC_RiskToPotentialStructures/ImageServer", name: "USFS RPS" },
];

/** Mode perf : fast (par défaut) ; tu peux forcer deep avec ?deep=1 */
const DEFAULT_MODE = (process.env.WFR_MODE || "fast").toLowerCase(); // "fast" | "deep"

type Five = "Very Low" | "Low" | "Moderate" | "High" | "Very High" | "Undetermined" | "Not Applicable";

/** RPS ~0–1020 → niveaux */
function levelFromRps(v: number | null): Five {
  if (v == null || !Number.isFinite(v)) return "Not Applicable";
  if (v < 160) return "Very Low";
  if (v < 350) return "Low";
  if (v < 600) return "Moderate";
  if (v < 850) return "High";
  return "Very High";
}
/** classes 1..5 → niveaux */
function levelFromClassCode(v: number | null): Five {
  if (v == null || !Number.isFinite(v)) return "Not Applicable";
  const n = Math.round(v);
  if (n <= 0) return "Not Applicable";
  if (n === 1) return "Very Low";
  if (n === 2) return "Low";
  if (n === 3) return "Moderate";
  if (n === 4) return "High";
  return "Very High"; // 5+
}

/** mappe une valeur 0–255 en classe 1..5 (bucket égal) */
function byteToClass(vByte: number): number {
  // 0..255 -> 1..5 (5 buckets égaux). 255 => 5.
  const cls = 1 + Math.floor((vByte * 5) / 256);
  return Math.min(Math.max(cls, 1), 5);
}

function degPerMeterLat() { return 1 / 111_320; }
function degPerMeterLon(latDeg: number) {
  const k = Math.cos((latDeg * Math.PI) / 180);
  return 1 / (111_320 * (k || 1e-6));
}

/** fetch avec timeout */
async function fetchWithTimeout(url: string, ms: number) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { cache: "no-store", signal: ctrl.signal });
  } finally {
    clearTimeout(to);
  }
}

/** Essaie (rule, band) sur une source et renvoie la 1re valeur exploitable (class ou rps) */
async function tryVariants(baseUrl: string, lat: number, lon: number, mode: "fast"|"deep") {
  const TIMEOUT_MS = Number(process.env.WFR_TIMEOUT_MS || (mode === "deep" ? "2000" : "1500"));

const RULES = mode === "deep"
  ? [
      { label: "RPS",       rule: { rasterFunction: "RPS"       }, bands: [undefined, 0, 1, 2, 3] },
      { label: "RPS_Class", rule: { rasterFunction: "RPS_Class" }, bands: [undefined, 0, 1, 2, 3] },
      { label: "ClassRPS",  rule: { rasterFunction: "ClassRPS"  }, bands: [undefined, 0, 1, 2, 3] },
      { label: "ClassifiedRPS", rule: { rasterFunction: "ClassifiedRPS" }, bands: [undefined, 0, 1, 2, 3] },
      { label: "none",      rule: undefined,                     bands: [undefined, 0, 1, 2, 3] },
    ]
  : [
      { label: "RPS",       rule: { rasterFunction: "RPS"       }, bands: [undefined] },
      { label: "RPS_Class", rule: { rasterFunction: "RPS_Class" }, bands: [undefined] },
    ];

  for (const rr of RULES) {
    for (const band of (rr.bands || [undefined])) {
      const params = new URLSearchParams({
        f: "json",
        geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
        geometryType: "esriGeometryPoint",
        sr: "4326",
        returnFirstValueOnly: "true",
        interpolation: "RSP_NearestNeighbor",
        // pixelSize ~270m (évite une pyramide trop lissée)
        pixelSize: JSON.stringify({ x: 0.0025, y: 0.0025, spatialReference: { wkid: 4326 } }),
      });
      if (rr.rule) params.set("renderingRule", JSON.stringify(rr.rule));
      if (band !== undefined) params.set("bandIds", String(band));
      const url = `${baseUrl}/getSamples?${params.toString()}`;

      let ok = false, raw: any = null;
      try {
        const r = await fetchWithTimeout(url, TIMEOUT_MS);
        const txt = await r.text();
        const j: any = txt ? JSON.parse(txt) : null;
        ok = r.ok;
        raw = Array.isArray(j?.samples) && j.samples.length ? j.samples[0]?.value : null;
      } catch { /* timeout/parse → next variant */ }

      // normalisation brute
      if (typeof raw === "string") {
        if (/nan/i.test(raw)) raw = null;
        else raw = raw.split(",")[0];
      }
      const num = Number(raw);
      const isNum = Number.isFinite(num);

      // no-data usuels
      if (!ok || !isNum || num === 0 || num === -9999 || Math.abs(num) > 1e20) continue;

      // 1) Vraies classes 1..5 ?
      if (Math.abs(num - Math.round(num)) < 1e-6 && num >= 1 && num <= 5) {
        return { value: num, valueType: "class" as const, variant: { rule: rr.label, band, raw: num } };
      }

      // 2) ⚠️ Raster "Class" renvoyant un byte 0–255 → convertir en 1..5
      if (/class/i.test(rr.label) && num >= 0 && num <= 255) {
        const cls = byteToClass(num);
        return { value: cls, valueType: "class" as const, variant: { rule: rr.label, band, raw: num } };
      }

      // 3) Continu : remettre sur ~0–1020
      let rps = num;
      if (num <= 1.5) {
        rps = num * 1020;           // 0–1 → 0–1020
      } else if (num > 0 && num <= 100) {
        rps = num * 10.2;           // 0–100 → 0–1020
      } else if (num > 1020 && num <= 2000) {
        rps = (num / 2000) * 1020;  // 0–2000 → 0–1020
      }
      return { value: rps, valueType: "rps" as const, variant: { rule: rr.label, band, raw: num } };
    }
  }
  return { value: null as number | null, valueType: "unknown" as const, variant: null as any };
}

/** Cherche un pixel non-no-data au plus près (anneaux) */
async function sampleNearest(lat: number, lon: number, mode: "fast"|"deep") {
  const STEP_M = Number(process.env.WFR_STEP || (mode === "deep" ? "30" : "60"));
  const MAX_RADIUS_M = Number(process.env.WFR_MAX_RADIUS || (mode === "deep" ? "300" : "180"));
  const MAX_ATTEMPTS = Number(process.env.WFR_MAX_ATTEMPTS || (mode === "deep" ? "120" : "60"));

  let attempts = 0;

  for (const src of SOURCES) {
    // point direct
    let res = await tryVariants(src.url, lat, lon, mode);
    if (res.value != null) return { ...res, meters: 0, provider: src.name };

    // anneaux
    for (let radius = STEP_M; radius <= MAX_RADIUS_M; radius += STEP_M) {
      const n = Math.max(8, Math.round((2 * Math.PI * radius) / STEP_M));
      const dLat = degPerMeterLat() * radius;
      const dLon = degPerMeterLon(lat) * radius;

      for (let i = 0; i < n; i++) {
        if (++attempts >= MAX_ATTEMPTS) return { value: null, valueType: "unknown" as const, meters: null, provider: src.name, variant: null };
        const ang = (i / n) * 2 * Math.PI;
        const lt = lat + dLat * Math.sin(ang);
        const ln = lon + dLon * Math.cos(ang);
        res = await tryVariants(src.url, lt, ln, mode);
        if (res.value != null) return { ...res, meters: radius, provider: src.name };
      }
    }
  }

  return { value: null as number | null, valueType: "unknown" as const, meters: null as number | null, provider: null as string | null, variant: null as any };
}

/** géocode interne (option address=) */
async function geocodeFromAddress(req: NextRequest, address: string) {
  const origin = new URL(req.url).origin;
  const u = `${origin}/api/geocode?address=${encodeURIComponent(address)}`;
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error(`geocode failed: ${r.status}`);
  const j = await r.json();
  if (typeof j.lat !== "number" || typeof j.lon !== "number") throw new Error("geocode returned invalid lat/lon");
  return { lat: j.lat as number, lon: j.lon as number, geocode: j };
}

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const address = u.searchParams.get("address");
  const lat = u.searchParams.get("lat");
  const lon = u.searchParams.get("lon");
  const debug = u.searchParams.get("debug") === "1";
  const forceDeep = u.searchParams.get("deep") === "1";
  const mode = forceDeep ? "deep" : (DEFAULT_MODE === "deep" ? "deep" : "fast");

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

  const res = await sampleNearest(latNum, lonNum, mode);

  let level: Five = "Not Applicable";
  if (res.valueType === "class") level = levelFromClassCode(res.value);
  else if (res.valueType === "rps") level = levelFromRps(res.value);

  const body: any = {
    level,
    value: res.value,
    adminUnit: "pixel",
    provider: res.provider || "Wildfire Risk to Communities (ImageServer)",
    mode,
  };
  if (res.meters && res.meters > 0) body.note = `Nearest colored pixel used (~${res.meters} m).`;
  if (res.value == null && !res.meters) body.note = "No pixel value at this location (water / non-burnable / no structures).";

  if (debug) {
    body.debug = {
      variant: res.variant || null, // { rule, band, raw }
      geocode: geocodeInfo || null,
    };
  }

  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
