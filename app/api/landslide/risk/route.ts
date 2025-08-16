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

/** Mappe le libellé NRI (RISKR) → nos 5 niveaux (pas de calcul depuis le score). */
function mapLabelToFive(raw: unknown): Five {
  if (raw == null) return "Undetermined";
  const s = String(raw).toLowerCase().replace(/[\s_\-()/]+/g, "");
  if (s.includes("veryhigh")) return "Very High";
  if (s.includes("relativelyhigh") || s === "high") return "High";
  if (s.includes("relativelymoderate") || s === "moderate") return "Moderate";
  if (s.includes("relativelylow") || s === "low") return "Low";
  if (s.includes("verylow")) return "Very Low";
  if (s.includes("insufficient") || s.includes("norating") || s.includes("notapplicable"))
    return "Undetermined";
  return "Undetermined";
}

/** Cherche un attribut (gère les préfixes ex. NRI_CensusTracts_LNDS_RISKR). */
function findAttr(attrs: Record<string, any>, patterns: RegExp[]) {
  for (const k of Object.keys(attrs)) {
    const up = k.toUpperCase();
    if (patterns.some(rx => rx.test(up))) return { key: k, value: attrs[k] };
  }
  return null;
}

/** 🔒 Lis UNIQUEMENT les champs LANDSLIDE : ...LNDS_RISKR (catégorie) et ...LNDS_RISKS (score) */
function extract(attrs: Record<string, any>) {
  // Landslide rating (texte) — PRIORITAIRE
  const riskR = findAttr(attrs, [
    /(^|_)LNDS.*_RISKR$/i,                  // ex. NRI_CensusTracts_LNDS_RISKR
  ]);
  // Landslide score (info) — 0–100
  const riskS = findAttr(attrs, [
    /(^|_)LNDS.*_RISKS$/i,                  // ex. NRI_CensusTracts_LNDS_RISKS
  ]);

  const level = mapLabelToFive(riskR?.value);
  const score =
    typeof riskS?.value === "number" && Number.isFinite(riskS.value)
      ? (riskS!.value <= 1.5 ? riskS!.value * 100 : riskS!.value) // normalise 0–1 → 0–100 si besoin
      : null;

  return {
    level,
    label: riskR?.value == null ? null : String(riskR.value),
    score,
    usedFields: { labelField: riskR?.key ?? null, scoreField: riskS?.key ?? null }
  };
}

/** Buffer géodésique léger pour tests secondaires. */
function tinyEnvelope(lon: number, lat: number, meters = 50) {
  const degLat = meters / 111_320;
  const degLon = meters / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
  return { xmin: lon - degLon, ymin: lat - degLat, xmax: lon + degLon, ymax: lat + degLat };
}

/** Query générique. */
async function query(feature0Url: string, p: Record<string, string>) {
  const params = new URLSearchParams({
    f: "json",
    outFields: "*",
    returnGeometry: "false",
    resultRecordCount: "1",
    ...p
  });
  const url = `${feature0Url}/query?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  let j: any = null; try { j = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) return { ok: false as const, status: r.status, url, body: text };
  const feat = j?.features?.[0];
  return { ok: true as const, url, attrs: feat?.attributes ?? null };
}

/** Sélection robuste (point WITHIN → point INTERSECTS + tolérance → envelope). */
async function pickFeature(feature0Url: string, lon: number, lat: number) {
  const attempts: Array<{ step: string; url: string }> = [];

  // 1) Point WITHIN
  const pWithin = await query(feature0Url, {
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelWithin",
  });
  attempts.push({ step: "point:within", url: (pWithin as any).url });
  if (pWithin.ok && pWithin.attrs) return { pick: pWithin, attempts };

  // 2) Point INTERSECTS avec tolérance (3m → 7m → 15m → 30m)
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

  // 3) Envelope INTERSECTS (~50m)
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

/** Géocode interne via /api/geocode (même domaine) — permet ?address= */
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

  // lat/lon ou address=
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

  // 1) TRACT (priorité)
  const tractTry = await pickFeature(NRI_TRACTS, lonNum, latNum);
  steps.push({ unit: "tract", attempts: tractTry.attempts });
  if (tractTry.pick && tractTry.pick.ok && tractTry.pick.attrs) {
    const attrs = tractTry.pick.attrs as Record<string, any>;
    const out = extract(attrs);
    const county = attrs.COUNTY ?? attrs.COUNTY_NAME ?? attrs.NAME ?? null;
    const state  = attrs.STATE ?? attrs.STATE_NAME ?? attrs.ST_ABBR ?? null;

    const body: any = {
      level: out.level,          // EXACT NRI (RISKR Landslide)
      label: out.label,
      score: out.score,          // LNDS_RISKS (info) — ex. 77.7
      adminUnit: "tract",
      county, state,
      provider: "FEMA National Risk Index (tract)"
    };
    if (debug) body.debug = {
      geocode: geocodeInfo ?? null,
      steps,
      usedFields: out.usedFields,
      attrKeys: Object.keys(attrs).sort()
    };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  // 2) COUNTY (fallback)
  const countyTry = await pickFeature(NRI_COUNTIES, lonNum, latNum);
  steps.push({ unit: "county", attempts: countyTry.attempts });
  if (countyTry.pick && countyTry.pick.ok && countyTry.pick.attrs) {
    const attrs = countyTry.pick.attrs as Record<string, any>;
    const out = extract(attrs);
    const countyName = attrs.COUNTY ?? attrs.COUNTY_NAME ?? attrs.NAME ?? null;
    const state      = attrs.STATE ?? attrs.STATE_NAME ?? attrs.ST_ABBR ?? null;

    const body: any = {
      level: out.level,
      label: out.label,
      score: out.score,          // LNDS_RISKS (info)
      adminUnit: "county",
      county: countyName, state,
      provider: "FEMA National Risk Index (county)"
    };
    if (debug) body.debug = {
      geocode: geocodeInfo ?? null,
      steps,
      usedFields: out.usedFields,
      attrKeys: Object.keys(attrs).sort()
    };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  // 3) Rien
  const res: any = { level: "Undetermined", label: "No Rating", provider: "FEMA NRI" };
  if (debug) res.debug = { geocode: geocodeInfo ?? null, steps };
  return Response.json(res);
}
