// app/api/landslide/risk/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Par défaut on utilise les couches FEMA NRI (tracts puis counties).
 * Tu n'as PAS besoin d'ENV. Si un jour tu veux surcharger :
 *   NRI_TRACTS_URL, NRI_COUNTIES_URL  (mettre l'URL jusqu'à /FeatureServer/0)
 */
const NRI_TRACTS =
  process.env.NRI_TRACTS_URL ??
  "https://hazards.geoplatform.gov/server/rest/services/Hosted/NRI_Tracts_%28October_2020%29/FeatureServer/0";

const NRI_COUNTIES =
  process.env.NRI_COUNTIES_URL ??
  "https://hazards.geoplatform.gov/server/rest/services/Hosted/NRI_Counties_%28October_2020%29/FeatureServer/0";

// Lecture robuste du champ "Landslide – Individual Hazard Risk Rating"
function readNriLandslide(attrs: Record<string, any>): string | null {
  return (
    attrs?.LNDS_RISKR ??
    attrs?.lnds_riskr ??
    attrs?.["Landslide - Individual Hazard Risk Rating"] ??
    attrs?.["LANDSLIDE - INDIVIDUAL HAZARD RISK RATING"] ??
    null
  );
}

// Mapping FEMA → tes 5 niveaux (+ undetermined)
function mapToFive(raw: string | null | undefined) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return { level: "Undetermined", label: "No Rating" };

  if (s.includes("very high")) return { level: "Very High", label: "Very High" };
  if (s.includes("relatively high")) return { level: "High", label: "Relatively High" };
  if (s.includes("relatively moderate")) return { level: "Moderate", label: "Relatively Moderate" };
  if (s.includes("relatively low")) return { level: "Low", label: "Relatively Low" };
  if (s.includes("very low")) return { level: "Very Low", label: "Very Low" };

  if (s.includes("no rating") || s.includes("insufficient") || s.includes("not applicable")) {
    return { level: "Undetermined", label: raw as string };
  }
  // Inconnu -> undetermined mais on garde l’étiquette brute
  return { level: "Undetermined", label: raw as string };
}

// Requête ArcGIS FeatureServer au point
async function queryAtPoint(
  baseFeature0: string, // .../FeatureServer/0
  lon: number,
  lat: number
) {
  const params = new URLSearchParams({
    f: "json",
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "false",
  });
  const url = `${baseFeature0}/query?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return { ok: false, status: r.status, url };

  const j = await r.json();
  const feat = Array.isArray(j.features) && j.features.length ? j.features[0] : null;
  if (!feat?.attributes) return { ok: true, attrs: null, url };

  return { ok: true, attrs: feat.attributes as Record<string, any>, url };
}

export async function GET(req: NextRequest) {
  try {
    const u = new URL(req.url);
    const lat = Number(u.searchParams.get("lat"));
    const lon = Number(u.searchParams.get("lon"));
    const debug = u.searchParams.get("debug") === "1";
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return Response.json({ error: "Missing lat/lon" }, { status: 400 });
    }

    // 1) TRAC T
    const tract = await queryAtPoint(NRI_TRACTS, lon, lat);
    if (tract.ok && tract.attrs) {
      const raw = readNriLandslide(tract.attrs);
      const mapped = mapToFive(raw);
      if (mapped.level !== "Undetermined") {
        const county = tract.attrs.COUNTY ?? tract.attrs.COUNTY_NAME ?? tract.attrs.NAME ?? null;
        const state = tract.attrs.STATE ?? tract.attrs.STATE_NAME ?? tract.attrs.ST_ABBR ?? null;

        const body: any = {
          level: mapped.level,
          label: mapped.label,
          adminUnit: "tract",
          county,
          state,
          provider: "FEMA National Risk Index (tract)",
        };
        if (debug) body.debug = { url: tract.url, attrs: tract.attrs, raw };
        return Response.json(body, { headers: { "cache-control": "no-store" } });
      }
    }

    // 2) FALLBACK COUNTY
    const county = await queryAtPoint(NRI_COUNTIES, lon, lat);
    if (county.ok && county.attrs) {
      const raw = readNriLandslide(county.attrs);
      const mapped = mapToFive(raw);

      const countyName = county.attrs.COUNTY ?? county.attrs.COUNTY_NAME ?? county.attrs.NAME ?? null;
      const state = county.attrs.STATE ?? county.attrs.STATE_NAME ?? county.attrs.ST_ABBR ?? null;

      const body: any = {
        level: mapped.level,
        label: mapped.label,
        adminUnit: "county",
        county: countyName,
        state,
        provider: "FEMA National Risk Index (county)",
      };
      if (debug) body.debug = { url: county.url, attrs: county.attrs, raw };
      return Response.json(body, { headers: { "cache-control": "no-store" } });
    }

    // 3) Rien trouvé → Undetermined
    return Response.json(
      { level: "Undetermined", label: "No Rating", provider: "FEMA NRI" },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e: any) {
    return Response.json({ error: e?.message || "Landslide service error" }, { status: 500 });
  }
}
