import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// County layer (FEMA NRI, Oct 2020 snapshot – champ LNDS_RISKR)
const NRI_COUNTIES =
  "https://hazards.geoplatform.gov/server/rest/services/Hosted/NRI_Counties_%28October_2020%29/FeatureServer/0/query";

function toFiveLevel(original: string | null | undefined) {
  const t = String(original ?? "").toLowerCase().trim();
  // mapping NRI -> nos 5 niveaux + undetermined
  if (t === "very high") return { level: "Very High", color: "red" };
  if (t === "relatively high") return { level: "High", color: "orange" };
  if (t === "relatively moderate") return { level: "Moderate", color: "yellow" };
  if (t === "relatively low") return { level: "Low", color: "blue" };
  if (t === "very low") return { level: "Very Low", color: "green" };
  // NRI peut aussi renvoyer "No Rating" / "Insufficient Data" / "Not Applicable"
  return { level: "Undetermined", color: "gray" };
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

    // Query: point-in-polygon sur les counties
    const params = new URLSearchParams({
      f: "json",
      geometry: JSON.stringify({ x: lon, y: lat }),
      geometryType: "esriGeometryPoint",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "*",
      returnGeometry: "false",
    });

    const url = `${NRI_COUNTIES}?${params.toString()}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) {
      const body = debug ? { error: "NRI counties query failed", status: r.status, url } : { error: "Landslide service not available" };
      return Response.json(body, { status: 502 });
    }

    const j = await r.json();
    const feat = Array.isArray(j.features) && j.features.length ? j.features[0] : null;
    if (!feat?.attributes) {
      return Response.json({ level: "Undetermined", label: "No county match", provider: "FEMA NRI" });
    }

    const a = feat.attributes as Record<string, any>;
    // plusieurs variantes selon jeux de données (majusc./minusc.)
    const raw =
      a.LNDS_RISKR ??
      a.lnds_riskr ??
      a["Landslide - Individual Hazard Risk Rating"] ??
      null;

    const mapped = toFiveLevel(raw);

    // on renvoie aussi quelques infos county si dispo
    const county =
      a.COUNTY ?? a.COUNTY_NAME ?? a.NAME ?? a.County ?? null;
    const state =
      a.STATE ?? a.STATE_NAME ?? a.ST_ABBR ?? a.State ?? null;

    const payload: any = {
      level: mapped.level,             // Very Low/Low/Moderate/High/Very High/Undetermined
      label: raw ?? "No Rating",
      county,
      state,
      provider: "FEMA National Risk Index (county)",
    };
    if (debug) payload.debug = { service: NRI_COUNTIES, attrs: a };
    return Response.json(payload, { headers: { "cache-control": "no-store" } });
  } catch (e: any) {
    return Response.json({ error: e?.message || "Landslide service error" }, { status: 500 });
  }
}
