// app/api/landslide/risk/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * FEMA National Risk Index (NRI) — ArcGIS Online mirrors (public).
 * Pas besoin d'ENV, mais tu peux surcharger via NRI_TRACTS_URL / NRI_COUNTIES_URL.
 */
const NRI_TRACTS =
  process.env.NRI_TRACTS_URL ??
  "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0";

const NRI_COUNTIES =
  process.env.NRI_COUNTIES_URL ??
  "https://services5.arcgis.com/W1uyphp8h2tna3qJ/ArcGIS/rest/services/NRI_GDB_Counties_%282%29/FeatureServer/0";

type Five = "Very Low" | "Low" | "Moderate" | "High" | "Very High" | "Undetermined";

/** Mappe les libellés NRI → nos 5 niveaux (sans rien recalculer). */
function mapLabelToFive(raw: unknown): Five {
  if (raw == null) return "Undetermined";
  const s = String(raw).toLowerCase().replace(/[\s_\-()/]+/g, "");
  if (s.includes("veryhigh"))        return "Very High";
  if (s.includes("relativelyhigh"))  return "High";
  if (s.includes("relativelymoderate")) return "Moderate";
  if (s.includes("relativelylow"))   return "Low";
  if (s.includes("verylow"))         return "Very Low";
  if (s.includes("insufficient") || s.includes("norating") || s.includes("notapplicable"))
    return "Undetermined";
  // Si autre chose/format inattendu → on considère non déterminé
  return "Undetermined";
}

/** Recherche un attribut par motif (gère les préfixes ex. NRI_CensusTracts_LNDS_RISKR). */
function findAttr(attrs: Record<string, any>, patterns: RegExp[]): { key: string; value: any } | null {
  for (const k of Object.keys(attrs)) {
    const up = k.toUpperCase();
    if (patterns.some(rx => rx.test(up))) return { key: k, value: attrs[k] };
  }
  return null;
}

/** Extrait la catégorie officielle (RISKR) + le score (RISKS) si présent. */
function extractFromAttrs(attrs: Record<string, any>) {
  // Catégorie (texte) — PRIORITAIRE
  const riskR = findAttr(attrs, [/(_|^)LNDS.*_RISKR$/i, /LANDSLIDE.*RISK.*RATING/i]);
  // Score (optionnel, pour info)
  const riskS = findAttr(attrs, [/(_|^)LNDS.*_RISKS$/i, /RISK(_|)SCORE$/i]);

  const label = riskR?.value ?? null;
  const level: Five = mapLabelToFive(label);

  const score =
    typeof riskS?.value === "number" && Number.isFinite(riskS.value)
      ? (riskS!.value as number)
      : null;

  return {
    level,
    label: label == null ? null : String(label),
    score,
    usedFields: { labelField: riskR?.key ?? null, scoreField: riskS?.key ?? null }
  };
}

/** Envelope ~50 m pour robustesse aux bords (si besoin). */
function tinyEnvelope(lon: number, lat: number, meters = 50) {
  const degLat = meters / 111_320;
  const degLon = meters / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
  return { xmin: lon - degLon, ymin: lat - degLat, xmax: lon + degLon, ymax: lat + degLat };
}

/** Query générique (point/envelope + spatialRel). */
async function queryGeneric(
  feature0Url: string,
  paramsObj: Record<string, any>
) {
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

/** Essayes dans l'ordre : point WITHIN → point INTERSECTS → envelope INTERSECTS. */
async function bestEffortPick(feature0Url: string, lon: number, lat: number) {
  // 1) Point WITHIN (le polygone qui contient le point)
  const pWithin = await queryGeneric(feature0Url, {
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelWithin",
  });
  if (pWithin.ok && pWithin.attrs) return { pick: pWithin, attempts: [ { step: "point:within", url: pWithin.url } ] };

  // 2) Point INTERSECTS (utile sur certains services)
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

  // 3) Envelope INTERSECTS (mini buffer ~50m)
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

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));
  const debug = u.searchParams.get("debug") === "1";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return Response.json({ error: "Missing lat/lon" }, { status: 400 });
  }

  const steps: any[] = [];

  // --- 1) Census Tract (priorité) ---
  const tractTry = await bestEffortPick(NRI_TRACTS, lon, lat);
  steps.push({ unit: "tract", attempts: tractTry.attempts });
  if (tractTry.pick && tractTry.pick.ok && tractTry.pick.attrs) {
    const attrs = tractTry.pick.attrs as Record<string, any>;
    const out = extractFromAttrs(attrs);
    const county = attrs.COUNTY ?? attrs.COUNTY_NAME ?? attrs.NAME ?? null;
    const state  = attrs.STATE ?? attrs.STATE_NAME ?? attrs.ST_ABBR ?? null;

    const body: any = {
      level: out.level,                     // "Very Low" … "Very High" / "Undetermined"
      label: out.label,                     // libellé original (souvent "Relatively Moderate", etc.)
      score: out.score,                     // 0–100 si présent (inform.)
      adminUnit: "tract",
      county, state,
      provider: "FEMA National Risk Index (tract)"
    };
    if (debug) body.debug = { steps, usedFields: out.usedFields };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  // --- 2) County (fallback) ---
  const countyTry = await bestEffortPick(NRI_COUNTIES, lon, lat);
  steps.push({ unit: "county", attempts: countyTry.attempts });
  if (countyTry.pick && countyTry.pick.ok && countyTry.pick.attrs) {
    const attrs = countyTry.pick.attrs as Record<string, any>;
    const out = extractFromAttrs(attrs);
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

  // --- 3) Rien trouvé ---
  if (debug) return Response.json({ error: "NRI landslide not available", steps }, { status: 502 });
  return Response.json({ level: "Undetermined", label: "No Rating", provider: "FEMA NRI" });
}
