// app/api/landslide/risk/route.ts
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NRI_TRACTS =
  process.env.NRI_TRACTS_URL ??
  "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0";

const NRI_COUNTIES =
  process.env.NRI_COUNTIES_URL ??
  "https://services5.arcgis.com/W1uyphp8h2tna3qJ/ArcGIS/rest/services/NRI_GDB_Counties_%282%29/FeatureServer/0";

// --- helpers ---
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
  if (s.includes("very high")) return { level: "Very High" as const, label: "Very High" };
  if (s.includes("relatively high")) return { level: "High" as const, label: "Relatively High" };
  if (s.includes("relatively moderate")) return { level: "Moderate" as const, label: "Relatively Moderate" };
  if (s.includes("relatively low")) return { level: "Low" as const, label: "Relatively Low" };
  if (s.includes("very low")) return { level: "Very Low" as const, label: "Very Low" };
  if (s.includes("no rating") || s.includes("insufficient") || s.includes("not applicable")) {
    return { level: "Undetermined" as const, label: raw as string };
  }
  return { level: "Undetermined" as const, label: raw as string };
}

// Entêtes “navigateur” → certains serveurs .gov en tiennent compte
const REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "application/json,*/*",
  "Referer": "https://hazards.fema.gov/",
  "Origin": "https://hazards.fema.gov"
};

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
    const r = await fetch(url, { cache: "no-store", headers: REQUEST_HEADERS });
    out.status = r.status;
    const text = await r.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch {/* ignore */}
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

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));
  const debug = u.searchParams.get("debug") === "1";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return Response.json({ error: "Missing lat/lon" }, { status: 400 });
  }

  const attempts: any[] = [];

  // 1) Tract
  const t = await queryAtPoint(NRI_TRACTS, lon, lat);
  attempts.push({ source: "tract", ...t });
  if (t.ok && t.attrs) {
    const raw = readNriLandslide(t.attrs);
    const mapped = mapToFive(raw);
    if (mapped.level !== "Undetermined") {
      const county = t.attrs.COUNTY ?? t.attrs.COUNTY_NAME ?? t.attrs.NAME ?? null;
      const state  = t.attrs.STATE ?? t.attrs.STATE_NAME ?? t.attrs.ST_ABBR ?? null;
      const body: any = { level: mapped.level, label: mapped.label, adminUnit: "tract", county, state,
        provider: "FEMA National Risk Index (tract)" };
      if (debug) body.debug = { attempts, raw };
      return Response.json(body, { headers: { "cache-control": "no-store" } });
    }
  }

  // 2) County fallback
  const c = await queryAtPoint(NRI_COUNTIES, lon, lat);
  attempts.push({ source: "county", ...c });
  if (c.ok && c.attrs) {
    const raw = readNriLandslide(c.attrs);
    const mapped = mapToFive(raw);
    const county = c.attrs.COUNTY ?? c.attrs.COUNTY_NAME ?? c.attrs.NAME ?? null;
    const state  = c.attrs.STATE ?? c.attrs.STATE_NAME ?? c.attrs.ST_ABBR ?? null;
    const body: any = { level: mapped.level, label: mapped.label, adminUnit: "county", county, state,
      provider: "FEMA National Risk Index (county)" };
    if (debug) body.debug = { attempts, raw };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  // 3) Rien
  if (debug) return Response.json({ error: "NRI landslide not available", attempts }, { status: 502 });
  return Response.json({ level: "Undetermined", label: "No Rating", provider: "FEMA NRI" });
}
