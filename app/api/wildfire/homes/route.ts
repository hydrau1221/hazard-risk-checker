// app/api/wildfire/homes/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Backends: AGOL prioritaire → USFS fallback */
const SOURCES: Array<{ url: string; name: string }> = [
  { url: "https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/Risk_to_Homes/ImageServer", name: "AGOL Risk_to_Homes" },
  { url: "https://apps.fs.usda.gov/fsgisx01/rest/services/RDW_Wildfire/RMRS_WRC_RiskToPotentialStructures/ImageServer", name: "USFS RPS" },
];

/** Fonctions "classées" possibles suivant les serveurs */
const CLASS_FUNCS = ["RPS_Class", "ClassifiedRPS", "ClassRPS"] as const;

/** Taille de pixel supposée (~270m) + demi-pixel pour micro-sampling */
const PIXEL_M = Number(process.env.WFR_PIXEL_M || 270);
const HALF_PIXEL_M = PIXEL_M / 2;

type Five = "Very Low" | "Low" | "Moderate" | "High" | "Very High" | "Undetermined" | "Not Applicable";
const LEVEL_SCORE: Record<Five, number> = {
  "Not Applicable": 0, Undetermined: 0, "Very Low": 1, Low: 2, Moderate: 3, High: 4, "Very High": 5,
};
function higher(a: Five, b: Five): Five {
  return LEVEL_SCORE[a] >= LEVEL_SCORE[b] ? a : b;
}

/** RPS ~0–1020 → niveaux (approximation – utilisé seulement si pas de classe dispo) */
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
  return "Very High";
}
/** 0–255 (byte de palette) → classe 1..5 */
function byteToClass(vByte: number): number {
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
  } finally { clearTimeout(to); }
}

/** getSamples helper */
async function getSamples(baseUrl: string, params: Record<string,string>, timeoutMs: number) {
  const u = new URLSearchParams({
    f: "json",
    sr: "4326",
    geometryType: "esriGeometryPoint",
    returnFirstValueOnly: "true",
    interpolation: "RSP_NearestNeighbor",
    // pixelSize ~270m pour coller au produit (évite une pyramide trop lissée)
    pixelSize: JSON.stringify({ x: 0.0025, y: 0.0025, spatialReference: { wkid: 4326 } }),
    ...params,
  });
  const url = `${baseUrl}/getSamples?${u.toString()}`;
  try {
    const r = await fetchWithTimeout(url, timeoutMs);
    const txt = await r.text();
    const j: any = txt ? JSON.parse(txt) : null;
    const raw = Array.isArray(j?.samples) && j.samples.length ? j.samples[0]?.value : null;
    return { ok: r.ok, url, raw };
  } catch {
    return { ok: false, url, raw: null as any };
  }
}

/** Lit une "classe" si possible (1..5 ou byte 0..255) */
async function readClass(baseUrl: string, lat: number, lon: number, timeoutMs: number) {
  for (const fn of CLASS_FUNCS) {
    const q = await getSamples(baseUrl, {
      geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
      renderingRule: JSON.stringify({ rasterFunction: fn }),
    }, timeoutMs);

    if (!q.ok) continue;

    let v: any = q.raw;
    if (typeof v === "string") {
      if (/nan/i.test(v)) v = null; else v = v.split(",")[0];
    }
    const num = Number(v);
    if (!Number.isFinite(num) || num === 0 || num === -9999 || Math.abs(num) > 1e20) continue;

    // 1..5 (déjà classé)
    if (Math.abs(num - Math.round(num)) < 1e-6 && num >= 1 && num <= 5) {
      const level = levelFromClassCode(num);
      return { ok: true, level, value: num, raw: num, rule: fn };
    }
    // 0..255 (byte colorisé) → converti en classe 1..5
    if (num >= 0 && num <= 255) {
      const cls = byteToClass(num);
      const level = levelFromClassCode(cls);
      return { ok: true, level, value: cls, raw: num, rule: fn };
    }
  }
  return { ok: false, level: "Not Applicable" as Five, value: null as number | null, raw: null as any, rule: null as any };
}

/** Lit RPS (continu) et normalise → 0..1020 */
async function readRps(baseUrl: string, lat: number, lon: number, timeoutMs: number) {
  const q = await getSamples(baseUrl, {
    geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
    renderingRule: JSON.stringify({ rasterFunction: "RPS" }),
  }, timeoutMs);

  if (!q.ok) return { ok: false, level: "Not Applicable" as Five, value: null as number | null, raw: null as any };

  let v: any = q.raw;
  if (typeof v === "string") {
    if (/nan/i.test(v)) v = null; else v = v.split(",")[0];
  }
  const num = Number(v);
  if (!Number.isFinite(num) || num === 0 || num === -9999 || Math.abs(num) > 1e20) {
    return { ok: true, level: "Not Applicable" as Five, value: null, raw: v };
  }

  // normalisation (ordre important)
  let rps = num;
  if (num <= 1.5) rps = num * 1020;                  // 0..1
  else if (num > 0 && num <= 100) rps = num * 10.2;  // 0..100
  else if (num > 0 && num <= 255) rps = (num / 255) * 1020; // 0..255 (certains serveurs)
  else if (num > 1020 && num <= 2000) rps = (num / 2000) * 1020;

  const level = levelFromRps(rps);
  return { ok: true, level, value: rps, raw: num };
}

/** Au point: lit classe + RPS et renvoie la sévérité la plus élevée */
async function readBestAtPoint(baseUrl: string, lat: number, lon: number, timeoutMs: number) {
  const cls = await readClass(baseUrl, lat, lon, timeoutMs);
  const rps = await readRps(baseUrl, lat, lon, timeoutMs);

  let level: Five = "Not Applicable";
  let value: number | null = null;
  let variant: any = null;

  if (cls.ok && cls.value != null) {
    level = cls.level; value = cls.value; variant = { rule: cls.rule, raw: cls.raw, type: "class" };
  }
  if (rps.ok && rps.value != null) {
    const lv = rps.level;
    if (LEVEL_SCORE[lv] > LEVEL_SCORE[level]) {
      level = lv; value = rps.value; variant = { rule: "RPS", raw: rps.raw, type: "rps" };
    }
  }

  return { level, value, variant, hasAny: (cls.ok && cls.value != null) || (rps.ok && rps.value != null) };
}

/** Micro-échantillonnage 3×3 à ±½ pixel : renvoie la SEVERITE MAX */
async function readBestMicrogrid(baseUrl: string, lat: number, lon: number, timeoutMs: number) {
  const dLat = degPerMeterLat() * HALF_PIXEL_M;
  const dLon = degPerMeterLon(lat) * HALF_PIXEL_M;
  let best: { level: Five; value: number|null; variant: any } | null = null;

  for (const dy of [-1, 0, 1]) {
    for (const dx of [-1, 0, 1]) {
      const lt = lat + dy * dLat;
      const ln = lon + dx * dLon;
      const res = await readBestAtPoint(baseUrl, lt, ln, timeoutMs);
      if (!res.hasAny) continue;
      const cand = { level: res.level, value: res.value, variant: res.variant };
      if (!best || LEVEL_SCORE[cand.level] > LEVEL_SCORE[best.level]) best = cand;
      if (best.level === "Very High") return best;
    }
  }
  return best; // peut être null si tout est no-data
}

/** Balaye voisinage (anneaux) et garde la SEVERITE MAX */
async function sampleNearest(lat: number, lon: number, mode: "fast"|"deep") {
  const STEP_M = Number(process.env.WFR_STEP || (mode === "deep" ? 30 : 60));
  const MAX_RADIUS_M = Number(process.env.WFR_MAX_RADIUS || (mode === "deep" ? 300 : 180));
  const TIMEOUT_MS = Number(process.env.WFR_TIMEOUT_MS || (mode === "deep" ? 2000 : 1500));

  let best: { level: Five; value: number|null; variant: any; meters: number; provider: string } | null = null;

  for (const src of SOURCES) {
    // 1) micro-grille à ±½ pixel (pour coller à l'affichage au "pixel près")
    const micro = await readBestMicrogrid(src.url, lat, lon, TIMEOUT_MS);
    if (micro) {
      const cand = { level: micro.level, value: micro.value, variant: micro.variant, meters: 0, provider: src.name };
      if (!best || LEVEL_SCORE[cand.level] > LEVEL_SCORE[best.level]) best = cand;
      if (best.level === "Very High") return best;
    }

    // 2) anneaux (si besoin)
    for (let radius = STEP_M; radius <= MAX_RADIUS_M; radius += STEP_M) {
      const n = Math.max(8, Math.round((2 * Math.PI * radius) / STEP_M));
      const dLat = degPerMeterLat() * radius;
      const dLon = degPerMeterLon(lat) * radius;

      for (let i = 0; i < n; i++) {
        const ang = (i / n) * 2 * Math.PI;
        const lt = lat + dLat * Math.sin(ang);
        const ln = lon + dLon * Math.cos(ang);

        const res = await readBestAtPoint(src.url, lt, ln, TIMEOUT_MS);
        if (!res.hasAny) continue;

        const cand = { level: res.level, value: res.value, variant: res.variant, meters: radius, provider: src.name };
        if (!best || LEVEL_SCORE[cand.level] > LEVEL_SCORE[best.level]) {
          best = cand;
          if (best.level === "Very High") return best;
        }
      }
    }
  }

  if (best) return best;
  return { level: "Not Applicable" as Five, value: null, variant: null, meters: null as any, provider: null as any };
}

/** Géocode interne (option address=) */
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
  const mode: "fast"|"deep" = forceDeep ? "deep" : ((process.env.WFR_MODE || "fast").toLowerCase() === "deep" ? "deep" : "fast");

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

  const body: any = {
    level: res.level,
    value: res.value,
    adminUnit: "pixel",
    provider: res.provider || "Wildfire Risk to Communities (ImageServer)",
    mode,
  };
  if (res.meters && res.meters > 0) body.note = `Nearest colored pixel used (~${res.meters} m).`;
  if (res.value == null && !res.meters) body.note = "No pixel value at this location (water / non-burnable / no structures).";

  if (debug) body.debug = { variant: res.variant || null, geocode: geocodeInfo || null, microgrid: { pixel_m: PIXEL_M } };

  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
