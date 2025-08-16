// app/api/landslide/risk/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** NRI FEMA sur ArcGIS Online (miroirs publics) */
const NRI_TRACTS =
  process.env.NRI_TRACTS_URL ??
  "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0";

const NRI_COUNTIES =
  process.env.NRI_COUNTIES_URL ??
  "https://services5.arcgis.com/W1uyphp8h2tna3qJ/ArcGIS/rest/services/NRI_GDB_Counties_%282%29/FeatureServer/0";

/** Lis la valeur Landslide Risk Rating quel que soit le nom exact du champ */
function readNriLandslide(attrs: Record<string, any>): string | null {
  return (
    attrs?.LNDS_RISKR ??
    attrs?.lnds_riskr ??
    attrs?.["Landslide - Individual Hazard Risk Rating"] ??
    attrs?.["LANDSLIDE - INDIVIDUAL HAZARD RISK RATING"] ??
    null
  );
}

/** Map FEMA → tes 5 niveaux + undetermined */
function mapToFive(raw: string | null | undefined) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return { level: "Undetermined" as const, label: "No Rating" };
  if (s.includes("very high"))        return { level: "Very High" as const, label: "Very High" };
  if (s.includes("relatively high"))  return { level: "High" as const,      label: "Relatively High" };
  if (s.includes("relatively moderate")) return { level: "Moderate" as const,  label: "Relatively Moderate" };
  if (s.includes("relatively low"))   return { level: "Low" as const,       label: "Relatively Low" };
  if (s.includes("very low"))         return { level: "Very Low" as const,  label: "Very Low" };
  if (s.includes("no rating") || s.includes("insufficient") || s.includes("not applicable"))
    return { level: "Undetermined" as const, label: raw as string };
  return { level: "Undetermined" as const, label: raw as string };
}

/** enveloppe ~70 m autour du point (en degrés) */
function tinyEnvelope(lon: number, lat: number, meters = 70) {
  const degLat = meters / 111_320;
  const degLon = meters / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
  return {
    xmin: lon - degLon,
    ymin: lat - degLat,
    xmax: lon + degLon,
    ymax: lat + degLat,
  };
}

/** Query au POINT (priorité) : spatialRel=Within pour récupérer le polygone qui contient le point */
async function queryPoint(feature0Url: string, lon: number, lat: number) {
  const params = new URLSearchParams({
    f: "json",
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelWithin",
    outFields: "*",
    returnGeometry: "false",
  });
  const url = `${feature0Url}/query?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!r.ok) return { ok: false as const, status: r.status, url, body: j ?? text };

  const feat = j?.features?.[0];
  if (!feat?.attributes) return { ok: true as const, attrs: null, url };
  return { ok: true as const, attrs: feat.attributes as Record<string, any>, url };
}

/** Query ENVELOPPE (fallback quand le point strict ne renvoie rien) */
async function queryEnvelope(feature0Url: string, lon: number, lat: number, meters = 70) {
  const env = tinyEnvelope(lon, lat, meters);
  const params = new URLSearchParams({
    f: "json",
    geometry: JSON.stringify({
      xmin: env.xmin, ymin: env.ymin, xmax: env.xmax, ymax: env.ymax, spatialReference: { wkid: 4326 }
    }),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "false",
  });
  const url = `${feature0Url}/query?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!r.ok) return { ok: false as const, status: r.status, url, body: j ?? text };

  const feat = j?.features?.[0];
  if (!feat?.attributes) return { ok: true as const, attrs: null, url };
  return { ok: true as const, attrs: feat.attributes as Record<string, any>, url };
}

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));
  const debug = u.searchParams.get("debug") === "1";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return Response.json({ error: "Missing lat/lon" }, { status: 400 });
  }

  const attempts: any[] = [];

  // 1) TRACT — point “within” d’abord
  const tractPt = await queryPoint(NRI_TRACTS, lon, lat);
  attempts.push({ source: "tract:point", ...tractPt });
  let tract = tractPt;
  if (tractPt.ok && !tractPt.attrs) {
    const tractEnv = await queryEnvelope(NRI_TRACTS, lon, lat, 70);
    attempts.push({ source: "tract:envelope", ...tractEnv });
    tract = tractEnv;
  }
  if (tract.ok && tract.attrs) {
    const raw = readNriLandslide(tract.attrs);
    const mapped = mapToFive(raw);
    const county = tract.attrs.COUNTY ?? tract.attrs.COUNTY_NAME ?? tract.attrs.NAME ?? null;
    const state  = tract.attrs.STATE ?? tract.attrs.STATE_NAME ?? tract.attrs.ST_ABBR ?? null;

    // Toujours renvoyer le TRACT s’il existe (même “No Rating”) pour coller à la Tract View
    const body: any = {
      level: mapped.level, label: mapped.label,
      adminUnit: "tract", county, state,
      provider: "FEMA National Risk Index (tract)"
    };
    if (debug) body.debug = { attempts, raw };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  // 2) COUNTY — point “within” puis enveloppe (fallback)
  const countyPt = await queryPoint(NRI_COUNTIES, lon, lat);
  attempts.push({ source: "county:point", ...countyPt });
  let county = countyPt;
  if (countyPt.ok && !countyPt.attrs) {
    const countyEnv = await queryEnvelope(NRI_COUNTIES, lon, lat, 70);
    attempts.push({ source: "county:envelope", ...countyEnv });
    county = countyEnv;
  }
  if (county.ok && county.attrs) {
    const raw = readNriLandslide(county.attrs);
    const mapped = mapToFive(raw);
    const countyName = county.attrs.COUNTY ?? county.attrs.COUNTY_NAME ?? county.attrs.NAME ?? null;
    const state      = county.attrs.STATE ?? county.attrs.STATE_NAME ?? county.attrs.ST_ABBR ?? null;
    const body: any = {
      level: mapped.level, label: mapped.label,
      adminUnit: "county", county: countyName, state,
      provider: "FEMA National Risk Index (county)"
    };
    if (debug) body.debug = { attempts, raw };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  // 3) Rien trouvé
  if (debug) return Response.json({ error: "NRI landslide not available", attempts }, { status: 502 });
  return Response.json({ level: "Undetermined", label: "No Rating", provider: "FEMA NRI" });
}
