// app/api/tornado/risk/route.ts
import { NextRequest } from "next/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NRI_TRACTS =
  process.env.NRI_TRACTS_URL ??
  "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0";
const NRI_COUNTIES =
  process.env.NRI_COUNTIES_URL ??
  "https://services5.arcgis.com/W1uyphp8h2tna3qJ/ArcGIS/rest/services/NRI_GDB_Counties_%282%29/FeatureServer/0";

type Five = "Very Low" | "Low" | "Moderate" | "High" | "Very High" | "Undetermined" | "Not Applicable";

function mapLabelToFive(raw: unknown): Five {
  if (raw == null) return "Undetermined";
  const s = String(raw).toLowerCase().replace(/[\s_\-()/]+/g, "");
  if (s.includes("veryhigh")) return "Very High";
  if (s.includes("relativelyhigh") || s === "high") return "High";
  if (s.includes("relativelymoderate") || s === "moderate") return "Moderate";
  if (s.includes("relativelylow") || s === "low") return "Low";
  if (s.includes("verylow")) return "Very Low";
  if (s.includes("insufficient") || s.includes("norating") || s.includes("notapplicable"))
    return "Not Applicable";
  return "Undetermined";
}

function findAttr(attrs: Record<string, any>, testers: ((upKey: string)=>boolean)[]) {
  for (const k of Object.keys(attrs)) {
    const up = k.toUpperCase();
    if (testers.some(fn => fn(up))) return { key: k, value: attrs[k] };
  }
  return null;
}

function extract(attrs: Record<string, any>) {
  const isTornadoKey = (up: string) => (up.includes("TORN") || up.includes("TORNADO"));
  const ends = (s: string) => (up: string) => up.endsWith(s);

  const riskR = findAttr(attrs, [ (up) => isTornadoKey(up) && ends("_RISKR")(up) ]);
  let riskS   = findAttr(attrs, [ (up) => isTornadoKey(up) && ends("_RISKS")(up) ]);

  if (!riskS) {
    const cand = Object.keys(attrs).find(k => {
      const up = k.toUpperCase();
      return isTornadoKey(up) && up.endsWith("RISKS") &&
        !up.includes("RISKR") && !up.includes("RANK") && !up.includes("PCTL") && !up.includes("INDEX");
    });
    if (cand) riskS = { key: cand, value: attrs[cand] };
  }

  let score: number | null = null;
  if (riskS && typeof riskS.value === "number" && Number.isFinite(riskS.value)) score = riskS.value;

  const level = mapLabelToFive(riskR?.value);
  return { level, label: riskR?.value == null ? null : String(riskR.value), score,
    usedFields: { labelField: riskR?.key ?? null, scoreField: riskS?.key ?? null } };
}

function tinyEnvelope(lon: number, lat: number, meters = 50) {
  const degLat = meters / 111_320;
  const degLon = meters / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
  return { xmin: lon - degLon, ymin: lat - degLat, xmax: lon + degLon, ymax: lat + degLat };
}
async function query(feature0Url: string, p: Record<string, string>) {
  const params = new URLSearchParams({ f: "json", outFields: "*", returnGeometry: "false", resultRecordCount: "1", ...p });
  const url = `${feature0Url}/query?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  let j: any = null; try { j = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) return { ok: false as const, status: r.status, url, body: text };
  const feat = j?.features?.[0];
  return { ok: true as const, url, attrs: feat?.attributes ?? null };
}
async function pickFeature(feature0Url: string, lon: number, lat: number) {
  const attempts: Array<{ step: string; url: string }> = [];
  const pWithin = await query(feature0Url, {
    geometry: JSON.stringify({ x: lon, y: lat }), geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelWithin",
  });
  attempts.push({ step: "point:within", url: (pWithin as any).url });
  if (pWithin.ok && pWithin.attrs) return { pick: pWithin, attempts };

  for (const d of [3, 7, 15, 30, 50]) {
    const pInter = await query(feature0Url, {
      geometry: JSON.stringify({ x: lon, y: lat }), geometryType: "esriGeometryPoint", inSR: "4326",
      spatialRel: "esriSpatialRelIntersects", distance: String(d), units: "esriSRUnit_Meter",
    });
    attempts.push({ step: `point:intersects:${d}m`, url: (pInter as any).url });
    if (pInter.ok && pInter.attrs) return { pick: pInter, attempts };
  }

  const env = tinyEnvelope(lon, lat, 1000);
  const eInter = await query(feature0Url, {
    geometry: JSON.stringify({ xmin: env.xmin, ymin: env.ymin, xmax: env.xmax, ymax: env.ymax, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryEnvelope", inSR: "4326", spatialRel: "esriSpatialRelIntersects",
  });
  attempts.push({ step: "envelope:intersects:50m", url: (eInter as any).url });
  if (eInter.ok && eInter.attrs) return { pick: eInter, attempts };

  return { pick: null as any, attempts };
}
async function geocodeFromAddress(req: NextRequest, address: string) {
  const origin = new URL(req.url).origin;
  const url = `${origin}/api/geocode?address=${encodeURIComponent(address)}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`geocode failed: ${r.status}`);
  const j = await r.json();
  if (typeof j.lat !== "number" || typeof j.lon !== "number") throw new Error("geocode returned invalid lat/lon");
  return { lat: j.lat as number, lon: j.lon as number, geocode: j };
}
export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const debug = u.searchParams.get("debug") === "1";
  let lat = u.searchParams.get("lat");
  let lon = u.searchParams.get("lon");
  const address = u.searchParams.get("address");
  let latNum: number, lonNum: number; let geocodeInfo: any = null;

  try {
    if (address && (!lat || !lon)) { const g = await geocodeFromAddress(req, address); latNum = g.lat; lonNum = g.lon; geocodeInfo = g.geocode; }
    else { latNum = Number(lat); lonNum = Number(lon); }
  } catch (e: any) { return Response.json({ error: e?.message || "geocode error" }, { status: 400 }); }

  if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) return Response.json({ error: "Missing lat/lon" }, { status: 400 });

  const steps: any[] = [];
  const tractTry = await pickFeature(NRI_TRACTS, lonNum, latNum);
  steps.push({ unit: "tract", attempts: tractTry.attempts });
  if (tractTry.pick && tractTry.pick.ok && tractTry.pick.attrs) {
    const attrs = tractTry.pick.attrs as Record<string, any>; const out = extract(attrs);
    const county = attrs.COUNTY ?? attrs.COUNTY_NAME ?? attrs.NAME ?? null;
    const state  = attrs.STATE ?? attrs.STATE_NAME ?? attrs.ST_ABBR ?? null;
    const body: any = { level: out.level, label: out.label, score: out.score, adminUnit: "tract", county, state, provider: "FEMA National Risk Index (tract)" };
    if (debug) body.debug = { geocode: geocodeInfo ?? null, steps, usedFields: out.usedFields, attrKeys: Object.keys(attrs).sort() };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  const countyTry = await pickFeature(NRI_COUNTIES, lonNum, latNum);
  steps.push({ unit: "county", attempts: countyTry.attempts });
  if (countyTry.pick && countyTry.pick.ok && countyTry.pick.attrs) {
    const attrs = countyTry.pick.attrs as Record<string, any>; const out = extract(attrs);
    const countyName = attrs.COUNTY ?? attrs.COUNTY_NAME ?? attrs.NAME ?? null;
    const state      = attrs.STATE ?? attrs.STATE_NAME ?? attrs.ST_ABBR ?? null;
    const body: any = { level: out.level, label: out.label, score: out.score, adminUnit: "county", county: countyName, state, provider: "FEMA National Risk Index (county)" };
    if (debug) body.debug = { geocode: geocodeInfo ?? null, steps, usedFields: out.usedFields, attrKeys: Object.keys(attrs).sort() };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  const res: any = { level: "Undetermined", label: "No Rating", provider: "FEMA NRI" };
  if (debug) res.debug = { geocode: geocodeInfo ?? null, steps };
  return Response.json(res, { headers: { "cache-control": "no-store" } });
}
