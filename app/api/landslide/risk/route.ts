import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** NRI – miroirs ArcGIS Online (répondent bien) */
const NRI_TRACTS =
  process.env.NRI_TRACTS_URL ??
  "https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0";
const NRI_COUNTIES =
  process.env.NRI_COUNTIES_URL ??
  "https://services5.arcgis.com/W1uyphp8h2tna3qJ/ArcGIS/rest/services/NRI_GDB_Counties_%282%29/FeatureServer/0";

type Five = "Very Low" | "Low" | "Moderate" | "High" | "Very High" | "Undetermined";

/** normalisation agressive des libellés/codes/scores */
function mapLabelLoose(raw: unknown): { level: Five; label: string; source: "text" | "code" | "numeric" } {
  if (raw == null) return { level: "Undetermined", label: "No Rating", source: "text" };

  if (typeof raw === "number") {
    const v = raw;
    if (v >= 1 && v <= 5) {
      const map: Record<number, Five> = { 1: "Very Low", 2: "Low", 3: "Moderate", 4: "High", 5: "Very High" };
      return { level: map[Math.round(v)] ?? "Undetermined", label: String(v), source: "numeric" };
    }
    const x = v > 1.5 ? v / 100 : v; // 0–100 → 0–1
    if (x <= 0.2) return { level: "Very Low", label: String(v), source: "numeric" };
    if (x <= 0.4) return { level: "Low", label: String(v), source: "numeric" };
    if (x <= 0.6) return { level: "Moderate", label: String(v), source: "numeric" };
    if (x <= 0.8) return { level: "High", label: String(v), source: "numeric" };
    return { level: "Very High", label: String(v), source: "numeric" };
  }

  const s0 = String(raw);
  const s = s0.toLowerCase().trim();
  const norm = s.replace(/[\s_\-()/]+/g, "");
  const has = (needle: string) => norm.includes(needle);

  if (has("norating") || has("insufficient") || has("notapplicable"))
    return { level: "Undetermined", label: s0, source: "text" };

  // codes courts
  if (norm === "vh") return { level: "Very High", label: s0, source: "code" };
  if (norm === "h")  return { level: "High",      label: s0, source: "code" };
  if (norm === "m")  return { level: "Moderate",  label: s0, source: "code" };
  if (norm === "l")  return { level: "Low",       label: s0, source: "code" };
  if (norm === "vl") return { level: "Very Low",  label: s0, source: "code" };

  // ordre important
  if (has("veryhigh"))       return { level: "Very High", label: s0, source: "text" };
  if (has("relativelyhigh")) return { level: "High",      label: s0, source: "text" };
  if (has("high"))           return { level: "High",      label: s0, source: "text" };

  if (has("relativelymoderate")) return { level: "Moderate", label: s0, source: "text" };
  if (has("moderate"))           return { level: "Moderate", label: s0, source: "text" };

  if (has("verylow"))       return { level: "Very Low", label: s0, source: "text" };
  if (has("relativelylow")) return { level: "Low",      label: s0, source: "text" };
  if (has("low"))           return { level: "Low",      label: s0, source: "text" };

  return { level: "Undetermined", label: s0, source: "text" };
}

/** mini buffer si le point ne renvoie rien */
function tinyEnvelope(lon: number, lat: number, meters = 50) {
  const degLat = meters / 111_320;
  const degLon = meters / (111_320 * Math.cos((lat * Math.PI) / 180) || 1);
  return { xmin: lon - degLon, ymin: lat - degLat, xmax: lon + degLon, ymax: lat + degLat };
}

/** util: essaye de trouver une clé d’attribut par motifs (insensible au préfixe NRI_….) */
function findAttr(attrs: Record<string, any>, patterns: RegExp[]): { key: string; value: any } | null {
  for (const k of Object.keys(attrs)) {
    const up = k.toUpperCase();
    if (patterns.some((rx) => rx.test(up))) return { key: k, value: attrs[k] };
  }
  return null;
}

/** extraction robuste: texte → code → numérique, en acceptant les préfixes (NRI_CensusTracts_/NRI_Counties_) */
function extractRating(attrs: Record<string, any>) {
  // 1) Libellé texte “...LNDS_RISKR”
  const text = findAttr(attrs, [/(_|^)LNDS.*_RISKR$/i, /LANDSLIDE.*RISK.*RATING/i]);
  if (text) {
    const m = mapLabelLoose(text.value);
    return { level: m.level, label: m.label, usedField: text.key, sourceKind: m.source };
  }
  // 2) Code court “...LNDS_RISKC”
  const code = findAttr(attrs, [/(_|^)LNDS.*_RISKC$/i]);
  if (code) {
    const m = mapLabelLoose(code.value);
    return { level: m.level, label: String(code.value), usedField: code.key, sourceKind: "code" as const };
  }
  // 3) Score “...LNDS_RISKS” (ou value “…_RISKV”)
  const score = findAttr(attrs, [/(_|^)LNDS.*_RISKS$/i, /(_|^)LNDS.*_RISKV$/i, /RISK(_|)SCORE$/i]);
  if (score) {
    const m = mapLabelLoose(typeof score.value === "number" ? score.value : Number(score.value));
    return { level: m.level, label: String(score.value), usedField: score.key, sourceKind: "numeric" as const };
  }
  // 4) Dernier recours
  const fallback = findAttr(attrs, [/RISK.*RAT(ING|NG)$/i]);
  if (fallback) {
    const m = mapLabelLoose(fallback.value);
    return { level: m.level, label: m.label, usedField: fallback.key, sourceKind: m.source };
  }
  return { level: "Undetermined" as Five, label: "No Rating", usedField: "(none)", sourceKind: "text" as const };
}

/** Query au point (Within) */
async function queryPoint(feature0Url: string, lon: number, lat: number) {
  const params = new URLSearchParams({
    f: "json",
    geometry: JSON.stringify({ x: lon, y: lat }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelWithin",
    outFields: "*",
    returnGeometry: "false",
    resultRecordCount: "1",
  });
  const url = `${feature0Url}/query?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  let j: any = null; try { j = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) return { ok: false as const, status: r.status, url, body: text };
  const feat = j?.features?.[0];
  return { ok: true as const, url, attrs: feat?.attributes ?? null };
}

/** Query enveloppe (fallback si le point ne renvoie rien) */
async function queryEnvelope(feature0Url: string, lon: number, lat: number, meters = 70) {
  const env = tinyEnvelope(lon, lat, meters);
  const params = new URLSearchParams({
    f: "json",
    geometry: JSON.stringify({ xmin: env.xmin, ymin: env.ymin, xmax: env.xmax, ymax: env.ymax, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "false",
    resultRecordCount: "1",
  });
  const url = `${feature0Url}/query?${params.toString()}`;
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  let j: any = null; try { j = text ? JSON.parse(text) : null; } catch {}
  if (!r.ok) return { ok: false as const, status: r.status, url, body: text };
  const feat = j?.features?.[0];
  return { ok: true as const, url, attrs: feat?.attributes ?? null };
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

  // 1) TRACT — point then small buffer
  const tractPt = await queryPoint(NRI_TRACTS, lon, lat);
  attempts.push({ source: "tract:point", ...tractPt });
  let tract = tractPt;
  if (tractPt.ok && !tractPt.attrs) {
    const tractEnv = await queryEnvelope(NRI_TRACTS, lon, lat, 50);
    attempts.push({ source: "tract:envelope50", ...tractEnv });
    tract = tractEnv;
    if (tractEnv.ok && !tractEnv.attrs) {
      const tractEnv70 = await queryEnvelope(NRI_TRACTS, lon, lat, 70);
      attempts.push({ source: "tract:envelope70", ...tractEnv70 });
      tract = tractEnv70;
    }
  }
  if (tract.ok && tract.attrs) {
    const { level, label, usedField, sourceKind } = extractRating(tract.attrs);
    const county = tract.attrs.COUNTY ?? tract.attrs.COUNTY_NAME ?? tract.attrs.NAME ?? null;
    const state  = tract.attrs.STATE ?? tract.attrs.STATE_NAME ?? tract.attrs.ST_ABBR ?? null;
    const body: any = {
      level, label, adminUnit: "tract", county, state,
      provider: "FEMA National Risk Index (tract)"
    };
    if (debug) body.debug = { attempts, usedField, sourceKind };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  // 2) COUNTY — point then buffer
  const countyPt = await queryPoint(NRI_COUNTIES, lon, lat);
  attempts.push({ source: "county:point", ...countyPt });
  let county = countyPt;
  if (countyPt.ok && !countyPt.attrs) {
    const countyEnv = await queryEnvelope(NRI_COUNTIES, lon, lat, 50);
    attempts.push({ source: "county:envelope50", ...countyEnv });
    county = countyEnv;
    if (countyEnv.ok && !countyEnv.attrs) {
      const countyEnv70 = await queryEnvelope(NRI_COUNTIES, lon, lat, 70);
      attempts.push({ source: "county:envelope70", ...countyEnv70 });
      county = countyEnv70;
    }
  }
  if (county.ok && county.attrs) {
    const { level, label, usedField, sourceKind } = extractRating(county.attrs);
    const countyName = county.attrs.COUNTY ?? county.attrs.COUNTY_NAME ?? county.attrs.NAME ?? null;
    const state      = county.attrs.STATE ?? county.attrs.STATE_NAME ?? county.attrs.ST_ABBR ?? null;
    const body: any = {
      level, label, adminUnit: "county", county: countyName, state,
      provider: "FEMA National Risk Index (county)"
    };
    if (debug) body.debug = { attempts, usedField, sourceKind };
    return Response.json(body, { headers: { "cache-control": "no-store" } });
  }

  if (debug) return Response.json({ error: "NRI landslide not available", attempts }, { status: 502 });
  return Response.json({ level: "Undetermined", label: "No Rating", provider: "FEMA NRI" });
}
