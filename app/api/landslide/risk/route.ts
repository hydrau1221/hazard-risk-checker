// app/api/landslide/risk/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * NRI FEMA – on interroge d'abord la couche "Tracts",
 * puis fallback "Counties" si pas de rating.
 *
 * Pas besoin d'ENV : les URL par défaut sont ci-dessous.
 * (Si un jour tu veux surcharger : NRI_TRACTS_URL / NRI_COUNTIES_URL)
 */
const NRI_TRACTS =
  process.env.NRI_TRACTS_URL ??
  "https://hazards.geoplatform.gov/server/rest/services/Hosted/NRI_Tracts_%28October_2020%29/FeatureServer/0";

const NRI_COUNTIES =
  process.env.NRI_COUNTIES_URL ??
  "https://hazards.geoplatform.gov/server/rest/services/Hosted/NRI_Counties_%28October_2020%29/FeatureServer/0";

// --------- helpers ---------

// lit la valeur de "Landslide – Individual Hazard Risk Rating" quel que soit le nom exact du champ
function readNriLandslide(attrs: Record<string, any>): string | null {
  return (
    attrs?.LNDS_RISKR ??
    attrs?.lnds_riskr ??
    attrs?.["Landslide - Individual Hazard Risk Rating"] ??
    attrs?.["LANDSLIDE - INDIVIDUAL HAZARD RISK RATING"] ??
    null
  );
}

// mappe le libellé FEMA vers tes 5 niveaux + undetermined
function mapToFive(raw: string | null | undefined) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return { level: "Undetermined" as const, label: "No Rating" };

  if (s.includes("very high"))        return { level: "Very High" as const, label: "Very High" };
  if (s.includes("relatively high"))  return { level: "High" as const,      label: "Relatively High" };
  if (s.includes("relatively moderate")) return { level: "Moderate" as const,  label: "Relatively Moderate" };
  if (s.includes("relatively low"))   return { level: "Low" as const,       label: "Relatively Low" };
  if (s.includes("very low"))         return { level: "Very Low" as const,  label: "Very Low" };

  if (s.includes("no rating") || s.includes("insufficient") || s.includes("not applicable")) {
    return { level: "Undetermined" as const, label: raw as string };
  }
  // inconnu → undetermined mais on conserve le libellé brut
  return { level: "Undetermined" as const, label: raw as string };
}

// requête ArcGIS FeatureServer au point
async function queryAtPoint(
  feature0Url: string, // …/FeatureServer/0
  lon: number,
  lat: number
): Promise<{ ok: true; attrs: Record<string, any> | null; url: string } | { ok: false; status: number; url: string }> {
  const params = new URLSearchParams({
    f: "json",
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "false",
  });
  const url = `${feature0Url}/query?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return { ok: false, status: r.status, url };
  const j = await r.json();
  const feat = Array.isArray(j.features) && j.features.length ? j.features[0] : null;
  return { ok: true, attrs: feat?.attributes ?? null, url };
}

// --------- handler ---------

export async function GET(req: NextRequest) {
  try {
    const u = new URL(req.url);
    const lat = Number(u.searchParams.get("lat"));
    const lon = Number(u.searchParams.get("lon"));
    const debug = u.searchParams.get("debug") === "1";

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return Response.json({ error: "Missing lat/lon" }, { status: 400 });
    }

    // 1) TRAC T d'abord
    const tract = await queryAtPoint(NRI_TRACTS, lon, lat);
    if (tract.ok && tract.attrs) {
      const raw = readNriLandslide(tract.attrs);
      const mapped = mapToFive(raw);
      // si rating exploitable, on s'arrête là
      if (mapped.level !== "Undetermined") {
        const county = tract.attrs.COUNTY ?? tract.attrs.COUNTY_NAME ?? tract.attrs.NAME ?? null;
        const state  = tract.attrs.STATE ?? tract.attrs.STATE_NAME ?? tract.attrs.ST_ABBR ?? null;

        const body: any = {
          level: mapped.level,               // "Very Low"…"Very High"/"Undetermined"
          label: mapped.label,               // libellé original FEMA
          adminUnit: "tract",
          county, state,
          provider: "FEMA National Risk Index (tract)",
        };
        if (debug) body.debug = { url: tract.url, attrs: tract.attrs, raw };
        return Response.json(body, { headers: { "cache-control": "no-store" } });
      }
    }

    // 2) FALLBACK county
    const countyQ = await queryAtPoint(NRI_COUNTIES, lon, lat);
    if (countyQ.ok && countyQ.attrs) {
      const raw = readNriLandslide(countyQ.attrs);
      const mapped = mapToFive(raw);

      const county = countyQ.attrs.COUNTY ?? countyQ.attrs.COUNTY_NAME ?? countyQ.attrs.NAME ?? null;
      const state  = countyQ.attrs.STATE ?? countyQ.attrs.STATE_NAME ?? countyQ.attrs.ST_ABBR ?? null;

      const body: any = {
        level: mapped.level,
        label: mapped.label,
        adminUnit: "county",
        county, state,
        provider: "FEMA National Risk Index (county)",
      };
      if (debug) body.debug = { url: countyQ.url, attrs: countyQ.attrs, raw };
      return Response.json(body, { headers: { "cache-control": "no-store" } });
    }

    // 3) Rien trouvé → undetermined
    return Response.json(
      { level: "Undetermined", label: "No Rating", provider: "FEMA NRI" },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e: any) {
    return Response.json({ error: e?.message || "Landslide service error" }, { status: 500 });
  }
}
