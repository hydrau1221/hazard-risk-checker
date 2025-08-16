// app/api/landslide/risk/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NRI_TRACTS =
  process.env.NRI_TRACTS_URL ??
  "https://hazards.geoplatform.gov/server/rest/services/Hosted/NRI_Tracts_%28October_2020%29/FeatureServer/0";
const NRI_COUNTIES =
  process.env.NRI_COUNTIES_URL ??
  "https://hazards.geoplatform.gov/server/rest/services/Hosted/NRI_Counties_%28October_2020%29/FeatureServer/0";

// ---- helpers ----
function readNriLandslide(attrs: Record<string, any>): string | null {
  return (
    attrs?.LNDS_RISKR ??
    attrs?.lnds_riskr ??
    attrs?.["Landslide - Individual Hazard Risk Rating"] ??
    attrs?.["LANDSLIDE - INDIVIDUAL HAZARD RISK RATING"] ??
    null
  );
}
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
  return { level: "Undetermined" as const, label: raw as string };
}

async function queryAtPoint(base0: string, lon: number, lat: number) {
  const params = new URLSearchParams({
    f: "json",
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "false",
  });
  const url = `${base0}/query?${params.toString()}`;
  const out: any = { url, ok: false as boolean, status: 0 };
  try {
    const r = await fetch(url, { cache: "no-store" });
    out.status = r.status;
    const text = await r.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch { /* leave j null */ }
    out.body = j ?? text ?? null;
    if (!r.ok) return out;
    const feat = j?.features?.[0];
    if (!feat?.attributes) { out.ok = true; out.attrs = null; return out; }
    out.ok = true; out.attrs = feat.attributes; return out;
  } catch (e: any) {
    out.err = e?.message || String(e);
    return out;
  }
}

// ---- handler ----
export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));
  const debug = u.searchParams.get("debug") === "1";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return Response.json({ error: "Missing lat/lon" }, { status: 400 });
  }

  const attempts: any[] = [];

  // 1) Tract d’abord
  const tract = await queryAtPoint(NRI_TRACTS, lon, lat);
  attempts.push({ source: "tract", ...tract });
  if (tract.ok && tract.attrs) {
    const raw = readNriLandslide(tract.attrs);
    const mapped = mapToFive(raw);
    if (mapped.level !== "Undetermined") {
      const county = tract.attrs.COUNTY ?? tract.attrs.COUNTY_NAME ?? tract.attrs.NAME ?? null;
      const state  = tract.attrs.STATE ?? tract.attrs.STATE_NAME ?? tract.attrs.ST_ABBR ?? null;
      const body: any = {
        level: mapped.level, label: mapped.label,
        adminUnit: "tract", county, state,
        provider: "FEMA National Risk Index (tract)"
      };
      if (debug) body.debug = { attempts, raw };
      return Response.json(body, { headers: { "cache-control": "no-store" } });
    }
  }

  // 2) Fallback County
  const county = await queryAtPoint(NRI_COUNTIES, lon, lat);
  attempts.push({ source: "county", ...county });
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

  // 3) Rien de concluant → expose les tentatives (debug) ou message simple
  if (debug) {
    return Response.json({ error: "NRI landslide not available", attempts }, { status: 502 });
  }
  return Response.json({ level: "Undetermined", label: "No Rating", provider: "FEMA NRI" });
}
