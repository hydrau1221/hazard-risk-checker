// app/api/tornado/risk/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** NRI – mêmes couches publiques que les autres risques */
const NRI_TRACTS =
  process.env.NRI_TRACTS_URL ??
  "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0";
const NRI_COUNTIES =
  process.env.NRI_COUNTIES_URL ??
  "https://services5.arcgis.com/W1uyphp8h2tna3qJ/ArcGIS/rest/services/NRI_GDB_Counties_%282%29/FeatureServer/0";

type Level =
  | "Very Low" | "Low" | "Moderate" | "High" | "Very High"
  | "Undetermined" | "Not Applicable";

/** Utils communs */
function findAttr(attrs: Record<string, any>, patterns: RegExp[]) {
  for (const k of Object.keys(attrs)) {
    const up = k.toUpperCase();
    if (patterns.some(rx => rx.test(up))) return { key: k, value: attrs[k] };
  }
  return null;
}

/** Mappe le libellé NRI (TRND_RISKR) → nos niveaux (+ Not Applicable) */
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

/** Optionnel: classification par score (si ?mode=score) — TRND_RISKS (0–100) */
function mapScoreToLevel(scoreRaw: unknown): Level {
  if (scoreRaw == null) return "Undetermined";
  let s = typeof scoreRaw === "number" ? scoreRaw : Number(scoreRaw);
  if (!Number.isFinite(s)) return "Undetermined";
  if (s <= 1.5) s = s * 100; // normalise 0–1 → 0–100
  if (s <= 0) return "Not Applicable";
  if (s > 99) return "Very High";
  if (s > 93) return "High";
  if (s > 85) return "Moderate";
  if (s > 71) return "Low";
  return "Very Low";
}

/** Extraction stricte Tornado : TRND_RISKR / TRND_RISKS */
function extract(attrs: Record<string, any>) {
  const rate = findAttr(attrs, [/(^|_)TRND_RISKR$/i, /(^|_)TRND.*_RISKR$/i]);

  let score = findAttr(attrs, [/(^|_)TRND_RISKS$/i]);
  if (!score) {
    // fallback prudent : ...TRND...RISKS (sans RANK/PCTL/INDEX/RISKR)
    const k = Object.keys(attrs).find(k => {
      const up = k.toUpperCase();
      return up.includes("TRND") && up.endsWith("RISKS")
        && !up.includes("RISKR") && !up.includes("RANK")
        && !up.includes("PCTL") && !up.includes("INDEX");
    });
    if (k) score = { key: k, value: attrs[k] };
  }

  let score100: number | null = null;
  if (score && typeof score.value === "number" && Number.isFinite(score.value)) {
    score100 = score.value <= 1.5 ? score.value * 100 : score.value;
  }

  return {
    label: rate?.value == null ? null : String(rate.value),
    score: score100,
    usedFields: { labelField: rate?.key ?? null, scoreField: score?.key ?? null },
  };
}

/** Petit buffer géodésique (~50m) */
function tinyEnvelope(lon: number, lat: number, meters = 50) {
  const degLat = meters / 111_320;
  const degLon = meters / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
  return { xmin: lon - degLon, ymin: lat - degLat, xmax: lon + degLon, ymax: lat + degLat };
}

/** Query générique */
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
  let j: any = null; try { j = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) return { ok: false as const, status: r.status, url, body: text };
  const feat = j?.features?.[0];
  return { ok: true as const, url, attrs: feat?.attributes ?? null };
}

/** WITHIN → INTERSECTS tolérance → ENVELOPE */
async function pickFeature(feature0Url: string, lon: number, lat: number) {
  const attempts: Array<{ step: string; url: string }> = [];

  const pWithin = await query(feature0Url, {
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelWithin",
  });
  attempts.push({ step: "point:within", url: (pWithin as any).url });
  if (pWithin.ok && pWithin.attrs) return { pick: pWithin, attempts };

  for (const d of [3, 7, 15, 30]) {
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

  const env = tinyEnvelope(lon, lat, 50);
  const eInter = await query(feature0Url, {
    geometry: JSON.stringify({
      xmin: env.xmin, ymin: env.ymin, xmax: env.xmax, ymax: env.ymax, spatialReference: { wkid: 4326 }
    }),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  });
  attempts.push({ step: "envelope:intersects:50m", url: (eInter as any).url });
  if (eInter.ok && eInter.attrs) return { pick: eInter, attempts };

  return { pick: null as any, attempts };
}

/** Géocode interne via /api/geocode (permet ?address=) */
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

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const debug = u.searchParams.get("debug") === "1";
  const mode = (u.searchParams.get("mode") || "label").toLowerCase(); // "label" (défaut) ou "score"
  const tractOnly = u.searchParams.get("tractOnly") === "1" || u.searchParams.get("noCounty") === "1";

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
    return Response.json({ error: e?.message || "geocode error" }, { status: 400 });
  }

  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
    return Response.json({ error: "Missing lat/lon" }, { status: 400 });
  }

  const steps: any[] = [];

  // 1) TRACT prioritaire
  const tractTry = await pickFeature(NRI_TRACTS, lonNum, latNum);
  steps.push({ unit: "tract", attempts: tractTry.attempts });
  if (tractTry.pick && tractTry.pick.ok && tractTry.pick.attrs) {
    const attrs = tractTry.pick.attrs as Record<string, any>;
    const ext = extract(attrs);

    const county = attrs.COUNTY ?? attrs.COUNTY_NAME ?? attrs.NAME ?? null;
    const state  = attrs.STATE ?? attrs.STATE_NAME ?? attrs.ST_ABBR ?? null;

    const level: Level = mode === "score"
      ? mapScoreToLevel(ext.score)
      : mapLabelToLevel(ext.label);

    const body: any = {
      level,
      label: ext.label,
      score: ext.score,
      adminUnit: "tract",
      county, state,
      provider: "FEMA National Risk Index (tract)",
      classification: mode,
    };
    if (debug) body.debug = {
      geocode: geocodeInfo ?? null,
      steps,
      usedFields: ext.usedFields,
      attrKeys: Object.keys(attrs).sort(),
    };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  // 2) COUNTY en fallback (si tractOnly != true)
  if (!tractOnly) {
    const countyTry = await pickFeature(NRI_COUNTIES, lonNum, latNum);
    steps.push({ unit: "county", attempts: countyTry.attempts });
    if (countyTry.pick && countyTry.pick.ok && countyTry.pick.attrs) {
      const attrs = countyTry.pick.attrs as Record<string, any>;
      const ext = extract(attrs);
      const countyName = attrs.COUNTY ?? attrs.COUNTY_NAME ?? attrs.NAME ?? null;
      const state      = attrs.STATE ?? attrs.STATE_NAME ?? attrs.ST_ABBR ?? null;

      const level: Level = mode === "score"
        ? mapScoreToLevel(ext.score)
        : mapLabelToLevel(ext.label);

      const body: any = {
        level,
        label: ext.label,
        score: ext.score,
        adminUnit: "county",
        county: countyName, state,
        provider: "FEMA National Risk Index (county)",
        classification: mode,
      };
      if (debug) body.debug = {
        geocode: geocodeInfo ?? null,
        steps,
        usedFields: ext.usedFields,
        attrKeys: Object.keys(attrs).sort(),
      };
      return Response.json(body, { headers: { "cache-control": "no-store" } });
    }
  }

  // 3) Rien
  const res: any = {
    level: "Undetermined",
    label: "No Rating",
    provider: "FEMA NRI",
    adminUnit: tractOnly ? "tract" : null,
    note: tractOnly ? "No tract polygon found at this location." : "No tract/county polygon found.",
    classification: mode,
  };
  if (debug) res.debug = { geocode: geocodeInfo ?? null, steps };
  return Response.json(res);
}
