// app/api/landslide/risk/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RiskLevel =
  | "Very Low"
  | "Low"
  | "Moderate"
  | "High"
  | "Very High"
  | "Undetermined";

function json(h: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    ...h,
  };
}

const UA = process.env.LS_UA || "HydrauRiskChecker/1.0 (+server)";

// ---------- helpers ----------
function toLevelFromLabel(label: string): RiskLevel {
  const s = (label || "").trim().toLowerCase();
  if (/very\s*high|\bvh\b/.test(s)) return "Very High";
  if (/\bhigh\b|\bh\b/.test(s)) return "High";
  if (/moderate|\bm\b/.test(s)) return "Moderate";
  if (/very\s*low|\bvl\b/.test(s)) return "Very Low";
  if (/\blow\b|\bl\b/.test(s)) return "Low";
  if (/no ?data|unknown|undetermined/.test(s)) return "Undetermined";
  return "Undetermined";
}

function toLevelFromValue(v: number, mapJson?: string): RiskLevel {
  const fallback = {
    "1": "Very Low",
    "2": "Low",
    "3": "Moderate",
    "4": "High",
    "5": "Very High",
  };
  let map = fallback as Record<string, string>;
  try {
    if (mapJson) map = JSON.parse(mapJson);
  } catch {
    /* ignore */
  }
  const lbl = map[String(Math.round(v))];
  return lbl ? toLevelFromLabel(lbl) : "Undetermined";
}

function pickField(attrs: Record<string, any>): {
  value: any;
  field?: string;
  how: string;
} | null {
  const keys = Object.keys(attrs);

  const forced = (process.env.LANDSLIDE_FIELD || "").trim();
  if (forced && forced in attrs) return { value: attrs[forced], field: forced, how: "env" };

  const common = "SUSC_CLASS,SUSCEPTIBILITY,CLASS,CATEGORY,CLASSNAME,CLASS_NAME,NAME,TYPE"
    .split(",")
    .map((s) => s.toLowerCase());
  for (const k of keys) if (common.includes(k.toLowerCase())) return { value: attrs[k], field: k, how: "common" };

  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === "string" && /(very\s*high|high|moderate|very\s*low|low|\bvh\b|\bh\b|\bm\b|\bvl\b|\bl\b)/i.test(v))
      return { value: v, field: k, how: "string-scan" };
  }

  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === "number" && v >= 0 && v <= 10) return { value: v, field: k, how: "small-int" };
    if (typeof v === "string" && /^\d+$/.test(v)) {
      const n = Number(v);
      if (n >= 0 && n <= 10) return { value: n, field: k, how: "small-int-str" };
    }
  }

  for (const k of keys) {
    const v = attrs[k];
    if (typeof v === "string" && /^(VH|H|M|L|VL)$/i.test(v.trim()))
      return { value: v, field: k, how: "code-vh" };
  }
  return null;
}

async function imageIdentify(url: string, lat: number, lon: number) {
  const geom = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });
  const qs = new URLSearchParams({
    f: "json",
    geometry: geom,
    geometryType: "esriGeometryPoint",
    sr: "4326",
    returnGeometry: "false",
  });
  const r = await fetch(`${url.replace(/\/+$/, "")}/identify?${qs}`, {
    headers: { accept: "application/json", "user-agent": UA },
    cache: "no-store",
  });
  const text = await r.text();
  let j: any = null;
  try {
    j = JSON.parse(text);
  } catch {}
  if (!r.ok) return { ok: false, url, status: r.status, err: "identify failed" };
  const value = j?.value ?? j?.pixelValue ?? j?.catalogItems?.[0]?.value ?? null;
  if (value == null) return { ok: false, url, status: r.status, err: "no pixel value" };
  const level = toLevelFromValue(Number(value), process.env.LANDSLIDE_VALUE_MAP);
  return { ok: true, url, mode: "image", level, value };
}

async function featureQuery(url: string, lat: number, lon: number, debug = false) {
  const geom = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });
  const qs = new URLSearchParams({
    f: "json",
    where: "1=1",
    geometry: geom,
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    returnGeometry: "false",
    outFields: "*",
  });
  const r = await fetch(`${url.replace(/\/+$/, "")}/query?${qs}`, {
    headers: { accept: "application/json", "user-agent": UA },
    cache: "no-store",
  });
  const text = await r.text();
  let j: any = null;
  try {
    j = JSON.parse(text);
  } catch {}
  if (!r.ok) return { ok: false, url, status: r.status, err: "query failed" };
  const feats = j?.features || [];
  if (!feats.length) return { ok: false, url, status: r.status, err: "no feature" };

  const attrs = feats[0].attributes || {};
  const pick = pickField(attrs);
  if (!pick)
    return {
      ok: true,
      url,
      mode: "feature",
      level: "Undetermined" as RiskLevel,
      label: null,
      how: "no-field",
      attrs: debug ? attrs : undefined,
    };

  let level: RiskLevel;
  let label: string | null = null;
  if (typeof pick.value === "number") {
    level = toLevelFromValue(pick.value, process.env.LANDSLIDE_VALUE_MAP);
    label = String(pick.value);
  } else {
    label = String(pick.value);
    level = toLevelFromLabel(label);
  }
  return {
    ok: true,
    url,
    mode: "feature",
    level,
    label,
    field: pick.field,
    how: pick.how,
    attrs: debug ? attrs : undefined,
  };
}

// ---------- handler ----------
export async function GET(req: Request) {
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));
  const debug = u.searchParams.get("debug") === "1";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return new Response(JSON.stringify({ error: "lat & lon required" }), {
      status: 400,
      headers: json(),
    });
  }

  const inputUrl = (process.env.LANDSLIDE_URL || "").replace(/\/+$/, "");
  if (!inputUrl) {
    return new Response(JSON.stringify({ error: "Set LANDSLIDE_URL in env." }), {
      status: 500,
      headers: json(),
    });
  }

  const candidates = new Set<string>([inputUrl]);
  if (/\/tiles\//i.test(inputUrl)) {
    const svc = inputUrl.replace(/\/tiles\//i, "/services/");
    candidates.add(svc);
    if (/\/MapServer$/i.test(svc)) candidates.add(svc.replace(/\/MapServer$/i, "/ImageServer"));
  } else {
    if (/\/MapServer\/\d+$/i.test(inputUrl))
      candidates.add(inputUrl.replace(/\/MapServer\/\d+$/i, "/ImageServer"));
    if (/\/ImageServer$/i.test(inputUrl))
      candidates.add(inputUrl.replace(/\/ImageServer$/i, "/MapServer/0"));
  }

  const attempts: any[] = [];
  for (const url of candidates) {
    try {
      if (/\/ImageServer$/i.test(url)) {
        const res = await imageIdentify(url, lat, lon);
        attempts.push(res);
        if (res.ok) {
          return new Response(
            JSON.stringify({
              level: res.level,
              value: res.value,
              source: "image",
              serviceUrl: url,
            }),
            { headers: json() }
          );
        }
      } else {
        const res = await featureQuery(url, lat, lon, debug);
        attempts.push(res);
        if (res.ok) {
          return new Response(
            JSON.stringify({
              level: res.level,
              label: res.label ?? null,
              source: "feature",
              serviceUrl: url,
              field: (res as any).field ?? null,
              how: (res as any).how ?? null,
              ...(debug && (res as any).attrs ? { attrsSample: (res as any).attrs } : {}),
            }),
            { headers: json() }
          );
        }
      }
    } catch (e: any) {
      attempts.push({ url, err: String(e?.message || e) });
    }
  }

  // 👉 Si au moins une tentative répond "no feature", on renvoie 404 explicite
  if (attempts.some((a) => a && a.err === "no feature")) {
    return new Response(
      JSON.stringify({ error: "no feature found at this point" }),
      { status: 404, headers: json() }
    );
  }

  const body = debug
    ? { error: "Landslide service not available", attempts }
    : { error: "Landslide service not available" };
  return new Response(JSON.stringify(body), { status: 502, headers: json() });
}
