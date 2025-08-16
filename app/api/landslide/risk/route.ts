// app/api/landslide/risk/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RiskLevel = "Very Low" | "Low" | "Moderate" | "High" | "Very High" | "Undetermined";

const UA = process.env.LS_UA || "HydrauRiskChecker/1.0 (+server)";
function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}

// ---------- helpers ----------
function toLevelFromLabel(s: string): RiskLevel {
  const t = (s || "").trim().toLowerCase();
  if (/very\s*high|\bvh\b/.test(t)) return "Very High";
  if (/\bhigh\b|\bh\b/.test(t)) return "High";
  if (/moderate|\bm\b/.test(t)) return "Moderate";
  if (/very\s*low|\bvl\b/.test(t)) return "Very Low";
  if (/\blow\b|\bl\b/.test(t)) return "Low";
  if (/no ?data|unknown|undetermined/.test(t)) return "Undetermined";
  return "Undetermined";
}
function toLevelFromValue(v: number): RiskLevel {
  const map: Record<string, string> = (() => {
    try { return process.env.LANDSLIDE_VALUE_MAP ? JSON.parse(process.env.LANDSLIDE_VALUE_MAP) : {};} catch { return {}; }
  })();
  const lbl = map[String(Math.round(v))] ?? ({1:"Very Low",2:"Low",3:"Moderate",4:"High",5:"Very High"} as any)[String(Math.round(v))];
  return toLevelFromLabel(lbl || "");
}

async function featureQuery(url: string, lat: number, lon: number) {
  const geom = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });
  const qs = new URLSearchParams({
    f:"json", where:"1=1",
    geometry: geom, geometryType:"esriGeometryPoint", inSR:"4326",
    spatialRel:"esriSpatialRelIntersects", returnGeometry:"false", outFields:"*",
  });
  const r = await fetch(`${url.replace(/\/+$/,"")}/query?${qs}`, { headers:{accept:"application/json","user-agent":UA}, cache:"no-store" });
  const j = await r.json().catch(()=>null);
  if (!r.ok) return { ok:false, err:`query ${r.status}` };
  const feats = j?.features || [];
  if (!feats.length) return { ok:false, err:"no feature" };

  const attrs = feats[0].attributes || {};
  const forced = (process.env.LANDSLIDE_FIELD || "").trim();
  let val: any = forced && forced in attrs ? attrs[forced] : undefined;
  if (val === undefined) {
    const common = "SUSC_CLASS,SUSCEPTIBILITY,CLASS,CATEGORY,CLASSNAME,CLASS_NAME,NAME,TYPE".split(",").map(x=>x.toLowerCase());
    for (const k of Object.keys(attrs)) if (common.includes(k.toLowerCase())) { val = attrs[k]; break; }
  }
  if (val === undefined) {
    for (const [k,v] of Object.entries(attrs)) {
      if (typeof v === "string" && /(very\s*high|high|moderate|very\s*low|low|\bvh\b|\bh\b|\bm\b|\bvl\b|\bl\b)/i.test(v)) { val = v; break; }
      if (typeof v === "number" && v>=0 && v<=10) { val = v; break; }
    }
  }

  let level: RiskLevel, label: string|null = null;
  if (typeof val === "number") { level = toLevelFromValue(val); label = String(val); }
  else if (val != null) { label = String(val); level = toLevelFromLabel(label); }
  else { level = "Undetermined"; }

  return { ok:true, source:"feature", level, label };
}

async function imageIdentify(url: string, lat: number, lon: number) {
  const geom = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });
  const qs = new URLSearchParams({ f:"json", geometry:geom, geometryType:"esriGeometryPoint", sr:"4326", returnGeometry:"false" });
  const r = await fetch(`${url.replace(/\/+$/,"")}/identify?${qs}`, { headers:{accept:"application/json","user-agent":UA}, cache:"no-store" });
  const j = await r.json().catch(()=>null);
  if (!r.ok) return { ok:false, err:`identify ${r.status}` };
  const value = j?.value ?? j?.pixelValue ?? j?.catalogItems?.[0]?.value ?? null;
  if (value == null) return { ok:false, err:"no pixel value" };
  return { ok:true, source:"image", level: toLevelFromValue(Number(value)), value };
}

// ---------- handler ----------
export async function GET(req: Request) {
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));
  const debug = u.searchParams.get("debug") === "1";
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return new Response(JSON.stringify({ error:"lat & lon required" }), { status:400, headers: json() });
  }

  const base = (process.env.LANDSLIDE_URL || "").replace(/\/+$/,"");
  if (!base) {
    return new Response(JSON.stringify({ error:"Set LANDSLIDE_URL in env." }), { status:500, headers: json() });
  }

  // Détermine quoi tenter
  const candidates: string[] = [base];
  if (/\/tiles\//i.test(base)) {
    const svc = base.replace(/\/tiles\//i, "/services/");
    candidates.push(svc);
    if (/\/MapServer$/i.test(svc)) candidates.push(svc.replace(/\/MapServer$/i, "/ImageServer"));
  } else {
    if (/\/MapServer\/\d+$/i.test(base)) candidates.push(base.replace(/\/MapServer\/\d+$/i, "/ImageServer"));
    if (/\/ImageServer$/i.test(base)) candidates.push(base.replace(/\/ImageServer$/i, "/MapServer/0"));
  }

  const attempts: any[] = [];
  for (const url of candidates) {
    try {
      if (/\/ImageServer$/i.test(url)) {
        const r = await imageIdentify(url, lat, lon);
        attempts.push({ url, ...(r as any) });
        if (r.ok) return new Response(JSON.stringify({ level:r.level, value:(r as any).value ?? null, source:"image", serviceUrl:url }), { headers: json() });
      } else {
        const r = await featureQuery(url, lat, lon);
        attempts.push({ url, ...(r as any) });
        if (r.ok) return new Response(JSON.stringify({ level:r.level, label:(r as any).label ?? null, source:"feature", serviceUrl:url }), { headers: json() });
      }
    } catch (e:any) {
      attempts.push({ url, err:String(e?.message || e) });
    }
  }

  // Zone blanche (aucun polygone intersecté) → 404 explicite
  if (attempts.some(a => a?.err === "no feature")) {
    return new Response(JSON.stringify({ error:"no feature found at this point" }), { status:404, headers: json() });
  }

  const body = debug ? { error:"Landslide service not available", attempts } : { error:"Landslide service not available" };
  return new Response(JSON.stringify(body), { status:502, headers: json() });
}
