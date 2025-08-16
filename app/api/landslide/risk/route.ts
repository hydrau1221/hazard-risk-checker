// app/api/landslide/risk/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** NRI – services publics (AGOL) */
const NRI_TRACTS =
  process.env.NRI_TRACTS_URL ??
  "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0";
const NRI_COUNTIES =
  process.env.NRI_COUNTIES_URL ??
  "https://services5.arcgis.com/W1uyphp8h2tna3qJ/ArcGIS/rest/services/NRI_GDB_Counties_%282%29/FeatureServer/0";

type Five = "Very Low" | "Low" | "Moderate" | "High" | "Very High" | "Undetermined";

/** 1) Tes seuils custom (score en 0–100) */
function mapScoreCustom(scoreRaw: number): Five {
  // Clamp 0–100 et normalise si on reçoit 0–1
  const s = (() => {
    if (!Number.isFinite(scoreRaw)) return NaN;
    if (scoreRaw <= 1.5) return Math.max(0, Math.min(100, scoreRaw * 100)); // 0–1 -> 0–100
    return Math.max(0, Math.min(100, scoreRaw));
  })();
  if (!Number.isFinite(s)) return "Undetermined";

  if (s < 40) return "Very Low";
  if (s < 75) return "Low";
  if (s < 90) return "Moderate";
  if (s <= 99) return "High";
  return "Very High"; // > 99
}

/** 2) Mapping "au cas où" depuis le libellé texte */
function mapLabelFallback(raw: unknown): Five {
  if (raw == null) return "Undetermined";
  const s = String(raw).toLowerCase().replace(/[\s_\-()/]+/g, "");
  if (s.includes("veryhigh")) return "Very High";
  if (s.includes("relativelyhigh") || s === "high" || s === "h") return "High";
  if (s.includes("relativelymoderate") || s === "moderate" || s === "m") return "Moderate";
  if (s.includes("relativelylow") || s === "low" || s === "l") return "Low";
  if (s.includes("verylow") || s === "vl") return "Very Low";
  if (s.includes("insufficient") || s.includes("norating") || s.includes("notapplicable")) return "Undetermined";
  return "Undetermined";
}

/** util: trouve une clé d’attribut par motif (gère les préfixes NRI_...) */
function findAttr(attrs: Record<string, any>, patterns: RegExp[]) {
  for (const k of Object.keys(attrs)) {
    const up = k.toUpperCase();
    if (patterns.some(rx => rx.test(up))) return { key: k, value: attrs[k] };
  }
  return null;
}

/** 3) Extraction — priorité au SCORE (tes seuils), fallback libellé si score manquant */
function extractLandslide(attrs: Record<string, any>) {
  const score = findAttr(attrs, [/(_|^)LNDS.*_RISKS$/i, /RISK(_|)SCORE$/i]);
  const label = findAttr(attrs, [/(_|^)LNDS.*_RISKR$/i, /LANDSLIDE.*RISK.*RATING/i]);

  let level: Five = "Undetermined";
  let normScore: number | null = null;

  if (typeof score?.value === "number" && Number.isFinite(score.value)) {
    level = mapScoreCustom(score.value);
    normScore = score.value <= 1.5 ? score.value * 100 : score.value;
  } else {
    level = mapLabelFallback(label?.value);
  }

  return {
    level,
    label: label?.value == null ? null : String(label.value),
    score: normScore,
    usedFields: {
      scoreField: score?.key ?? null,
      labelField: label?.key ?? null,
      decidedBy: typeof score?.value === "number" ? "score" : "label"
    }
  };
}

/** 4) Sélection spatiale robuste */
function tinyEnvelope(lon: number, lat: number, meters = 50) {
  const degLat = meters / 111_320;
  const degLon = meters / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
  return { xmin: lon - degLon, ymin: lat - degLat, xmax: lon + degLon, ymax: lat + degLat };
}
async function queryGeneric(feature0Url: string, paramsObj: Record<string, any>) {
  const params = new URLSearchParams({
    f: "json",
    outFields: "*",
    returnGeometry: "false",
    resultRecordCount: "1",
    ...paramsObj
  } as any);
  const url = `${feature0Url}/query?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  let j: any = null; try { j = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) return { ok: false as const, status: r.status, url, body: text };
  const feat = j?.features?.[0];
  return { ok: true as const, url, attrs: feat?.attributes ?? null };
}
async function bestEffortPick(feature0Url: string, lon: number, lat: number) {
  // 1) Point WITHIN
  const pWithin = await queryGeneric(feature0Url, {
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelWithin",
  });
  if (pWithin.ok && pWithin.attrs) return { pick: pWithin, attempts: [{ step: "point:within", url: pWithin.url }] };

  // 2) Point INTERSECTS
  const pInter = await queryGeneric(feature0Url, {
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  });
  if (pInter.ok && pInter.attrs) return { pick: pInter, attempts: [
    { step: "point:within", url: pWithin.url },
    { step: "point:intersects", url: pInter.url }
  ] };

  // 3) Envelope INTERSECTS (~50 m)
  const env = tinyEnvelope(lon, lat, 50);
  const eInter = await queryGeneric(feature0Url, {
    geometry: JSON.stringify({ xmin: env.xmin, ymin: env.ymin, xmax: env.xmax, ymax: env.ymax, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
  });
  return {
    pick: eInter.ok && eInter.attrs ? eInter : null,
    attempts: [
      { step: "point:within", url: pWithin.url },
      { step: "point:intersects", url: pInter.url },
      { step: "envelope:intersects", url: eInter.url }
    ]
  };
}

/** 5) Handler */
export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));
  const debug = u.searchParams.get("debug") === "1";
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return Response.json({ error: "Missing lat/lon" }, { status: 400 });
  }

  const steps: any[] = [];

  // --- Tract (priorité) ---
  const tractTry = await bestEffortPick(NRI_TRACTS, lon, lat);
  steps.push({ unit: "tract", attempts: tractTry.attempts });
  if (tractTry.pick && tractTry.pick.ok && tractTry.pick.attrs) {
    const attrs = tractTry.pick.attrs as Record<string, any>;
    const out = extractLandslide(attrs);
    const county = attrs.COUNTY ?? attrs.COUNTY_NAME ?? attrs.NAME ?? null;
    const state  = attrs.STATE ?? attrs.STATE_NAME ?? attrs.ST_ABBR ?? null;

    const body: any = {
      level: out.level,                // calculé via score (tes seuils) si dispo
      label: out.label,                // libellé NRI (info)
      score: out.score,                // 0–100 si dispo
      adminUnit: "tract",
      county, state,
      provider: "FEMA National Risk Index (tract)"
    };
    if (debug) body.debug = { steps, usedFields: out.usedFields };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  // --- County (fallback) ---
  const countyTry = await bestEffortPick(NRI_COUNTIES, lon, lat);
  steps.push({ unit: "county", attempts: countyTry.attempts });
  if (countyTry.pick && countyTry.pick.ok && countyTry.pick.attrs) {
    const attrs = countyTry.pick.attrs as Record<string, any>;
    const out = extractLandslide(attrs);
    const countyName = attrs.COUNTY ?? attrs.COUNTY_NAME ?? attrs.NAME ?? null;
    const state      = attrs.STATE ?? attrs.STATE_NAME ?? attrs.ST_ABBR ?? null;

    const body: any = {
      level: out.level,
      label: out.label,
      score: out.score,
      adminUnit: "county",
      county: countyName, state,
      provider: "FEMA National Risk Index (county)"
    };
    if (debug) body.debug = { steps, usedFields: out.usedFields };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  if (debug) return Response.json({ error: "NRI landslide not available", steps }, { status: 502 });
  return Response.json({ level: "Undetermined", label: "No Rating", provider: "FEMA NRI" });
}
