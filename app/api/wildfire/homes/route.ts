// app/api/wildfire/homes-county/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ➤ County FeatureServer (Wildfire Risk to Communities).
 * Doit pointer vers une couche polygonale "counties" qui contient un libellé
 * Risk-to-Homes (Low/Moderate/High/Very High) et/ou un score (RPS/cRPS/percentile).
 * Renseigne ceci dans Vercel: WFR_COUNTY_URL = https://.../FeatureServer/0
 */
const WFR_COUNTY = (process.env.WFR_COUNTY_URL || "").replace(/\/+$/, "");

type Level =
  | "Very Low" | "Low" | "Moderate" | "High" | "Very High"
  | "Undetermined" | "Not Applicable";

/* --------- utils communs --------- */

function okJson(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function findAttr(attrs: Record<string, any>, patterns: RegExp[]) {
  for (const k of Object.keys(attrs)) {
    const up = k.toUpperCase();
    if (patterns.some(rx => rx.test(up))) return { key: k, value: attrs[k] };
  }
  return null;
}

function mapLabelToLevel(raw: unknown): Level {
  if (raw == null) return "Undetermined";
  const s = String(raw).toLowerCase();
  if (s.includes("not applicable") || s.includes("no housing") || s.includes("no homes")) return "Not Applicable";
  if (s.includes("very high")) return "Very High";
  if (s.includes("high")) return "High";
  if (s.includes("moderate")) return "Moderate";
  if (s.includes("low")) return "Low";
  if (s.includes("very low")) return "Very Low";
  return "Undetermined";
}

/** Mappe un score (0–1 ou 0–100 ou classes 1..5) → niveaux */
function mapScoreToLevel(vRaw: unknown): Level {
  if (vRaw == null) return "Undetermined";
  let v = typeof vRaw === "number" ? vRaw : Number(vRaw);
  if (!Number.isFinite(v)) return "Undetermined";

  if (v >= 0 && v <= 1.00001) {           // 0–1
    if (v <= 0.2) return "Very Low";
    if (v <= 0.4) return "Low";
    if (v <= 0.6) return "Moderate";
    if (v <= 0.8) return "High";
    return "Very High";
  }
  if (v >= 0 && v <= 100.00001) {         // 0–100 (percentile/score)
    if (v <= 20) return "Very Low";
    if (v <= 40) return "Low";
    if (v <= 60) return "Moderate";
    if (v <= 80) return "High";
    return "Very High";
  }
  // Classes entières
  const i = Math.round(v);
  if (i <= 1) return "Very Low";
  if (i === 2) return "Low";
  if (i === 3) return "Moderate";
  if (i === 4) return "High";
  if (i >= 5) return "Very High";
  return "Undetermined";
}

function tinyEnvelope(lon: number, lat: number, meters = 50) {
  const dLat = meters / 111_320;
  const dLon = meters / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
  return { xmin: lon - dLon, ymin: lat - dLat, xmax: lon + dLon, ymax: lat + dLat };
}

/* --------- requêtes FeatureServer --------- */

async function queryFeature(url0: string, p: Record<string, string>) {
  const params = new URLSearchParams({
    f: "json",
    outFields: "*",
    returnGeometry: "false",
    resultRecordCount: "1",
    ...p,
  });
  const url = `${url0}/query?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  let j: any = null; try { j = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) return { ok: false as const, status: r.status, url, body: text };
  const feat = j?.features?.[0];
  return { ok: true as const, url, attrs: feat?.attributes ?? null };
}

async function pickCounty(url0: string, lon: number, lat: number) {
  const attempts: Array<{ step: string; url: string }> = [];

  const pWithin = await queryFeature(url0, {
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelWithin",
  });
  attempts.push({ step: "point:within", url: (pWithin as any).url });
  if (pWithin.ok && pWithin.attrs) return { pick: pWithin, attempts };

  for (const d of [3, 10, 30]) {
    const pInter = await queryFeature(url0, {
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

  const env = tinyEnvelope(lon, lat, 60);
  const eInter = await queryFeature(url0, {
    geometry: JSON.stringify({
      xmin: env.xmin, ymin: env.ymin, xmax: env.xmax, ymax: env.ymax, spatialReference: { wkid: 4326 },
    }),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  });
  attempts.push({ step: "envelope:intersects:60m", url: (eInter as any).url });
  if (eInter.ok && eInter.attrs) return { pick: eInter, attempts };

  return { pick: null as any, attempts };
}

/** Extraction souple des champs "Risk to Homes" (labels & scores) */
function extractRTH(attrs: Record<string, any>) {
  // Label texte
  const label = findAttr(attrs, [
    /(RISK|RTH|RPS).*TO.*HOMES.*(LABEL|CLASS|CAT|RATING)$/i,
    /(RISK|RTH|RPS).*HOMES.*(LABEL|CLASS|CAT|RATING)$/i,
    /(RISK.*HOMES|RISKTOHOMES|RISK_TO_HOMES)$/i,
    /(RPS|CRPS).*CLASS$/i,
  ]);

  // Score/percentile
  const score = findAttr(attrs, [
    /(RPS|CRPS)(_?(SCORE|MEAN|VALUE))$/i,
    /(RPS|CRPS).*PCTL$/i,
    /(RISK.*HOMES).*SCORE$/i,
  ]);

  // Métadonnées standards
  const county = attrs.COUNTY ?? attrs.COUNTY_NAME ?? attrs.NAME ?? null;
  const state  = attrs.STATE ?? attrs.STATE_NAME ?? attrs.ST_ABBR ?? attrs.STUSPS ?? null;

  // Mapping final
  let level: Level = "Undetermined";
  if (label) level = mapLabelToLevel(label.value);
  if (level === "Undetermined" && score) level = mapScoreToLevel(score.value);

  // Not Applicable cas explicites
  const txt = (label?.value ?? "").toString().toLowerCase();
  if (txt.includes("not applicable") || txt.includes("no housing") || txt.includes("no homes")) {
    level = "Not Applicable";
  }

  let numeric: number | null = null;
  if (score && typeof score.value === "number" && Number.isFinite(score.value)) {
    numeric = score.value;
  }

  return {
    level,
    label: label?.value == null ? null : String(label.value),
    score: numeric,
    county,
    state,
    usedFields: { labelField: label?.key ?? null, scoreField: score?.key ?? null },
  };
}

/* --------- géocode interne (adresse → lat/lon) --------- */
async function geocodeFromAddress(req: NextRequest, address: string) {
  const origin = new URL(req.url).origin;
  const url = `${origin}/api/geocode?address=${encodeURIComponent(address)}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`geocode failed: ${r.status}`);
  const j = await r.json();
  if (!j || typeof j.lat !== "number" || typeof j.lon !== "number") {
    throw new Error("geocode returned invalid lat/lon");
  }
  return { lat: j.lat as number, lon: j.lon as number, geocode: j };
}

/* --------- handler --------- */
export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const debug = u.searchParams.get("debug") === "1";

  if (!WFR_COUNTY) {
    return okJson({ error: "WFR_COUNTY_URL env var required (FeatureServer/0 for counties)" }, 500);
  }

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
      latNum = Number(lat);
      lonNum = Number(lon);
    }
  } catch (e: any) {
    return okJson({ error: e?.message || "geocode error" }, 400);
  }

  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    return okJson({ error: "Missing lat/lon" }, 400);
  }

  const steps: any[] = [];
  const picked = await pickCounty(WFR_COUNTY, lonNum, latNum);
  steps.push({ unit: "county", attempts: picked.attempts });

  if (picked.pick && picked.pick.ok && picked.pick.attrs) {
    const attrs = picked.pick.attrs as Record<string, any>;
    const ext = extractRTH(attrs);

    const body: any = {
      level: ext.level,
      label: ext.label,
      score: ext.score,
      adminUnit: "county",
      county: ext.county ?? null,
      state: ext.state ?? null,
      provider: "USFS / Wildfire Risk to Communities — Risk to Homes (county)",
    };
    if (debug) body.debug = {
      geocode: geocodeInfo ?? null,
      steps,
      usedFields: ext.usedFields,
      attrKeys: Object.keys(attrs).sort(),
    };
    return okJson(body);
  }

  const res: any = {
    level: "Undetermined",
    label: "No Rating",
    adminUnit: "county",
    provider: "USFS / Wildfire Risk to Communities — Risk to Homes (county)",
  };
  if (debug) res.debug = { geocode: geocodeInfo ?? null, steps };
  return okJson(res);
}
