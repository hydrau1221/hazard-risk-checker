import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deux backends : AGOL prioritaire → USFS fallback */
const SOURCES: Array<{ url: string; name: string }> = [
  { url: "https://services3.arcgis.com/T4QMspbfLg3qTGWY/ArcGIS/rest/services/Risk_to_Homes/ImageServer", name: "AGOL Risk_to_Homes" },
  { url: "https://apps.fs.usda.gov/fsgisx01/rest/services/RDW_Wildfire/RMRS_WRC_RiskToPotentialStructures/ImageServer", name: "USFS RPS" },
];

/** Perf : mode "fast" par défaut, "deep" si ?deep=1 */
const DEFAULT_MODE = (process.env.WFR_MODE || "fast").toLowerCase(); // "fast" | "deep"

type Five = "Very Low" | "Low" | "Moderate" | "High" | "Very High" | "Undetermined" | "Not Applicable";

/** Ordre de sévérité pour choisir le plus risqué */
const LEVEL_SCORE: Record<Five, number> = {
  "Not Applicable": 0,
  Undetermined: 0,
  "Very Low": 1,
  Low: 2,
  Moderate: 3,
  High: 4,
  "Very High": 5,
};
function higher(a: Five, b: Five): Five {
  return LEVEL_SCORE[a] >= LEVEL_SCORE[b] ? a : b;
}

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

/** 0–255 (byte de palette) → classe 1..5 (buckets égaux) */
function byteToClass(vByte: number): number {
  const cls = 1 + Math.floor((vByte * 5) / 256);
  return Math.min(Math.max(cls, 1), 5);
}

function degPerMeterLat() { return 1 / 111_320; }
function degPerMeterLon(latDeg: number) {
  const k = Math.cos((latDeg * Math.PI) / 180);
  return 1 / (111_320 * (k || 1e-6));
}

/** fetch avec timeout (évite les pendings longues) */
async function fetchWithTimeout(url: string, ms: number) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { cache: "no-store", signal: ctrl.signal });
  } finally {
    clearTimeout(to);
  }
}

/** Lecture d’un variant donné ("RPS" continu OU "RPS_Class" classé) au point */
async function getVariantValue(baseUrl: string, lat: number, lon: number, label: "RPS" | "RPS_Class", timeoutMs: number) {
  const params = new URLSearchParams({
    f: "json",
    geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    sr: "4326",
    returnFirstValueOnly: "true",
    interpolation: "RSP_NearestNeighbor",
    // pixelSize ~270 m (WGS84) pour éviter les pyramides trop lissées
    pixelSize: JSON.stringify({ x: 0.0025, y: 0.0025, spatialReference: { wkid: 4326 } }),
    renderingRule: JSON.stringify({ rasterFunction: label }),
  });
  const url = `${baseUrl}/getSamples?${params.toString()}`;
  try {
    const r = await fetchWithTimeout(url, timeoutMs);
    const txt = await r.text();
    const j: any = txt ? JSON.parse(txt) : null;
    if (!r.ok) return { ok: false, url, value: null as number | null, type: "unknown" as const, raw: null as any };

    let raw: any = Array.isArray(j?.samples) && j.samples.length ? j.samples[0]?.value : null;
    if (typeof raw === "string") {
      if (/nan/i.test(raw)) raw = null;
      else raw = raw.split(",")[0];
    }
    const num = Number(raw);
    const isNum = Number.isFinite(num);
    // no-data usuels
    if (!isNum || num === 0 || num === -9999 || Math.abs(num) > 1e20) {
      return { ok: true, url, value: null, type: "unknown" as const, raw };
    }

    if (label === "RPS_Class") {
      // cas 1..5 (déjà classes)
      if (Math.abs(num - Math.round(num)) < 1e-6 && num >= 1 && num <= 5) {
        return { ok: true, url, value: num, type: "class" as const, raw: num };
      }
      // cas 0..255 → convertir en 1..5
      if (num >= 0 && num <= 255) {
        const cls = byteToClass(num);
        return { ok: true, url, value: cls, type: "class" as const, raw: num };
      }
      // Autres cas improbables → fallback continu
      const rpsFromClass = num <= 1.5 ? num * 1020 : (num > 0 && num <= 100 ? num * 10.2 : (num > 1020 && num <= 2000 ? (num / 2000) * 1020 : num));
      return { ok: true, url, value: rpsFromClass, type: "rps" as const, raw: num };
    } else {
      // label === "RPS" : normaliser à ~0–1020
      let rps = num;
      if (num <= 1.5) rps = num * 1020;           // 0–1
      else if (num > 0 && num <= 100) rps = num * 10.2; // 0–100
      else if (num > 1020 && num <= 2000) rps = (num / 2000) * 1020; // 0–2000
      // certains serveurs renvoient un byte 0–255 avec "RPS" ⇒ on traite comme 0–255
      else if (num > 0 && num <= 255) rps = (num / 255) * 1020; // 0–255 → 0–1020
      return { ok: true, url, value: rps, type: "rps" as const, raw: num };
    }
  } catch {
    return { ok: false, url, value: null as number | null, type: "unknown" as const, raw: null as any };
  }
}

/** Lit au point : RPS et RPS_Class, puis renvoie le niveau le plus sévère des deux. */
async function readBothAndChoose(baseUrl: string, lat: number, lon: number, timeoutMs: number) {
  const rps = await getVariantValue(baseUrl, lat, lon, "RPS", timeoutMs);
  const cls = await getVariantValue(baseUrl, lat, lon, "RPS_Class", timeoutMs);

  let bestLevel: Five = "Not Applicable";
  let bestVariant: any = null;
  let bestValue: number | null = null;

  if (rps.ok && rps.value != null) {
    const lv = levelFromRps(rps.value);
    bestLevel = lv; bestVariant = { rule: "RPS", raw: rps.raw }; bestValue = rps.value;
  }
  if (cls.ok && cls.value != null) {
    const lv = cls.type === "class" ? levelFromClassCode(cls.value) : levelFromRps(cls.value);
    if (LEVEL_SCORE[lv] > LEVEL_SCORE[bestLevel]) {
      bestLevel = lv; bestVariant = { rule: "RPS_Class", raw: cls.raw }; bestValue = cls.value;
    }
  }

  return {
    level: bestLevel,
    value: bestValue,
    variant: bestVariant,
    hasAny: (rps.ok && rps.value != null) || (cls.ok && cls.value != null),
  };
}

/** Cherche un pixel non no-data (max rayon selon mode), en prenant le plus sévère entre RPS et Class */
async function sampleNearest(lat: number, lon: number, mode: "fast"|"deep") {
  const STEP_M = Number(process.env.WFR_STEP || (mode === "deep" ? "30" : "60"));
  const MAX_RADIUS_M = Number(process.env.WFR_MAX_RADIUS || (mode === "deep" ? "300" : "180"));
  const TIMEOUT_MS = Number(process.env.WFR_TIMEOUT_MS || (mode === "deep" ? "2000" : "1500"));

  for (const src of SOURCES) {
    // 1) au point
    let best = await readBothAndChoose(src.url, lat, lon, TIMEOUT_MS);
    if (best.hasAny && best.level !== "Not Applicable") {
      return { ...best, meters: 0, provider: src.name };
    }

    // 2) anneaux
    for (let radius = STEP_M; radius <= MAX_RADIUS_M; radius += STEP_M) {
      const n = Math.max(8, Math.round((2 * Math.PI * radius) / STEP_M));
      const dLat = degPerMeterLat() * radius;
      const dLon = degPerMeterLon(lat) * radius;

      let bestAtRadius: { level: Five; value: number | null; variant: any } | null = null;

      for (let i = 0; i < n; i++) {
        const ang = (i / n) * 2 * Math.PI;
        const lt = lat + dLat * Math.sin(ang);
        const ln = lon + dLon * Math.cos(ang);
        const res = await readBothAndChoose(src.url, lt, ln, TIMEOUT_MS);
        if (!res.hasAny) continue;

        if (!bestAtRadius || LEVEL_SCORE[res.level] > LEVEL_SCORE[bestAtRadius.level]) {
          bestAtRadius = { level: res.level, value: res.value, variant: res.variant };
          if (res.level === "Very High") break; // on ne fera pas mieux
        }
      }

      if (bestAtRadius) {
        return { ...bestAtRadius, meters: radius, provider: src.name };
      }
    }
  }

  return { level: "Not Applicable" as Five, value: null as number | null, variant: null as any, meters: null as number | null, provider: null as string | null };
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
  const mode: "fast"|"deep" = forceDeep ? "deep" : (DEFAULT_MODE === "deep" ? "deep" : "fast");

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

  if (debug) body.debug = { variant: res.variant || null, geocode: geocodeInfo || null };

  return Response.json(body, { headers: { "cache-control": "no-store" } });
}
