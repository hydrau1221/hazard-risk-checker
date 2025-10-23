// app/api/tornado/risk/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// NRI – Tracts & Counties (surcharge possibles via env)
const NRI_TRACTS =
  process.env.NRI_TRACTS_URL ??
  "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0";

const NRI_COUNTIES =
  process.env.NRI_COUNTIES_URL ??
  "https://services5.arcgis.com/W1uyphp8h2tna3qJ/ArcGIS/rest/services/NRI_GDB_Counties_%282%29/FeatureServer/0";

// Niveaux (7 états dont NA/Undetermined)
type Level =
  | "Very Low" | "Low" | "Moderate" | "High" | "Very High"
  | "Undetermined" | "Not Applicable";

/** Utilitaire: trouve un attribut dont la clé matche au moins un pattern (tolérant aux préfixes) */
function findAttr(attrs: Record<string, any>, patterns: RegExp[]) {
  for (const k of Object.keys(attrs)) {
    const up = k.toUpperCase();
    if (patterns.some((rx) => rx.test(up))) return { key: k, value: attrs[k] };
  }
  return null;
}

/** Mappe le libellé NRI → Level */
function mapLabelToLevel(raw: unknown): Level {
  if (raw == null) return "Undetermined";
  const s = String(raw).toLowerCase().replace(/[\s_\-()/]+/g, "");
  if (s.includes("notapplicable")) return "Not Applicable";
  if (s.includes("insufficientdata")) return "Undetermined";
  if (s.includes("norating")) return "Not Applicable";
  if (s.includes("veryhigh")) return "Very High";
  if (s.includes("relativelyhigh") || s === "high") return "High";
  if (s.includes("relativelymoderate") || s === "moderate") return "Moderate";
  if (s.includes("relativelylow") || s === "low") return "Low";
  if (s.includes("verylow")) return "Very Low";
  return "Undetermined";
}

/** Extrait label/score pour Tornado, avec fallback niveau ← score si label manquant */
function extractTornado(attrs: Record<string, any>) {
  // Champs tolérants: TORN_RISKR / TORNADO_RISKR et TORN_RISKS / TORNADO_RISKS
  const riskR = findAttr(attrs, [/(?:^|_)TORN(?:ADO)?_RISKR$/i]);
  let  riskS = findAttr(attrs, [/(?:^|_)TORN(?:ADO)?_RISKS$/i]);

  // Couverture de variantes (évite RISKR/RANK/PCTL/INDEX)
  if (!riskS) {
    const cand = Object.keys(attrs).find((k) => {
      const up = k.toUpperCase();
      return /(TORN|TORNADO)/.test(up) &&
        up.endsWith("RISKS") &&
        !up.includes("RISKR") &&
        !up.includes("RANK") &&
        !up.includes("PCTL") &&
        !up.includes("INDEX");
    });
    if (cand) riskS = { key: cand, value: (attrs as any)[cand] };
  }

  const score: number | null =
    riskS && typeof riskS.value === "number" && Number.isFinite(riskS.value)
      ? (riskS.value as number)
      : null;

  let level: Level = mapLabelToLevel(riskR?.value);

  // 🔁 Fallback: si pas de label (ou NA/Undet), dérive un niveau depuis le score (0–100)
  if ((level === "Undetermined" || level === "Not Applicable") && typeof score === "number") {
    if      (score >= 80) level = "Very High";
    else if (score >= 60) level = "High";
    else if (score >= 40) level = "Moderate";
    else if (score >= 20) level = "Low";
    else                  level = "Very Low";
  }

  return {
    level,
    label: riskR?.value == null ? null : String(riskR.value),
    score,
    usedFields: { labelField: riskR?.key ?? null, scoreField: riskS?.key ?? null },
  };
}

/** Petite envelope autour (mètres → degrés) */
function tinyEnvelope(lon: number, lat: number, meters = 150) {
  const degLat = meters / 111_320;
  const degLon = meters / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
  return { xmin: lon - degLon, ymin: lat - degLat, xmax: lon + degLon, ymax: lat + degLat };
}

/** Query simple (1 feature max) */
async function query(feature0Url: string, p: Record<string, string>) {
  const params = new URLSearchParams({
    f: "json",
    outFields: "*",
    returnGeometry: "false",
    resultRecordCount: "1",
    ...p,
  });
  const url = `${feature0Url}/query?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) return { ok: false as const, status: r.status, url, body: text };
  const feat = j?.features?.[0];
  return { ok: true as const, url, attrs: feat?.attributes ?? null };
}

/** Sélectionne la feature (tract/county) en multipliant les essais */
async function pickFeature(feature0Url: string, lon: number, lat: number) {
  const attempts: Array<{ step: string; url: string }> = [];

  // 1) Intersects strict (within)
  const pWithin = await query(feature0Url, {
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelWithin",
  });
  attempts.push({ step: "point:within", url: (pWithin as any).url });
  if (pWithin.ok && pWithin.attrs) return { pick: pWithin, attempts };

  // 2) Intersects avec buffer 3→50m
  for (const d of [3, 7, 15, 30, 50]) {
    const pInter = await query(feature0Url, {
      geometry: JSON.stringify({ x: lon, y: lat }),
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      distance: String(d),
      units: "esriSRUnit_Meter",
    });
    attempts.push({ step: `point:intersects:${d}m`, url: (pInter as any).url });
    if (pInter.ok && pInter.attrs) return { pick: pInter, attempts };
  }

  // 3) Envelope ~150m
  const env = tinyEnvelope(lon, lat, 150);
  const eInter = await query(feature0Url, {
    geometry: JSON.stringify({
      xmin: env.xmin, ymin: env.ymin, xmax: env.xmax, ymax: env.ymax, spatialReference: { wkid: 4326 },
    }),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  });
  attempts.push({ step: "envelope:intersects:150m", url: (eInter as any).url });
  if (eInter.ok && eInter.attrs) return { pick: eInter, attempts };

  return { pick: null as any, attempts };
}

/** Géocode (via ta route interne) si 'address' fourni */
async function geocodeFromAddress(req: NextRequest, address: string) {
  const origin = new URL(req.url).origin;
  const url = `${origin}/api/geocode?address=${encodeURIComponent(address)}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`geocode failed: ${r.status}`);
  const j = await r.json();
  if (typeof j.lat !== "number" || typeof j.lon !== "number")
    throw new Error("geocode returned invalid lat/lon");
  return { lat: j.lat as number, lon: j.lon as number, geocode: j };
}

/** Handler */
export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const debug = u.searchParams.get("debug") === "1";

  let lat = u.searchParams.get("lat");
  let lon = u.searchParams.get("lon");
  const address = u.searchParams.get("address");

  let latNum: number, lonNum: number;
  let geocodeInfo: any = null;

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

  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum))
    return Response.json({ error: "Missing lat/lon" }, { status: 400 });

  const steps: any[] = [];

  // 1) Tract prioritaire
  const tractTry = await pickFeature(NRI_TRACTS, lonNum, latNum);
  steps.push({ unit: "tract", attempts: tractTry.attempts });
  if (tractTry.pick && tractTry.pick.ok && tractTry.pick.attrs) {
    const attrs = tractTry.pick.attrs as Record<string, any>;
    const out = extractTornado(attrs);
    const county = (attrs as any).COUNTY ?? (attrs as any).COUNTY_NAME ?? (attrs as any).NAME ?? null;
    const state  = (attrs as any).STATE ?? (attrs as any).STATE_NAME ?? (attrs as any).ST_ABBR ?? null;

    const body: any = {
      level: out.level,
      label: out.label,
      score: out.score,
      adminUnit: "tract",
      county,
      state,
      provider: "FEMA National Risk Index (tract)",
    };
    if (debug) body.debug = { geocode: geocodeInfo ?? null, steps, usedFields: out.usedFields, attrKeys: Object.keys(attrs).sort() };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  // 2) Fallback county
  const countyTry = await pickFeature(NRI_COUNTIES, lonNum, latNum);
  steps.push({ unit: "county", attempts: countyTry.attempts });
  if (countyTry.pick && countyTry.pick.ok && countyTry.pick.attrs) {
    const attrs = countyTry.pick.attrs as Record<string, any>;
    const out = extractTornado(attrs);
    const countyName = (attrs as any).COUNTY ?? (attrs as any).COUNTY_NAME ?? (attrs as any).NAME ?? null;
    const state      = (attrs as any).STATE ?? (attrs as any).STATE_NAME ?? (attrs as any).ST_ABBR ?? null;

    const body: any = {
      level: out.level,
      label: out.label,
      score: out.score,
      adminUnit: "county",
      county: countyName,
      state,
      provider: "FEMA National Risk Index (county)",
    };
    if (debug) body.debug = { geocode: geocodeInfo ?? null, steps, usedFields: out.usedFields, attrKeys: Object.keys(attrs).sort() };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  // 3) Rien trouvé
  const res: any = { level: "Undetermined", label: "No Rating", provider: "FEMA NRI" };
  if (debug) res.debug = { geocode: geocodeInfo ?? null, steps };
  return Response.json(res, { headers: { "cache-control": "no-store" } });
}
