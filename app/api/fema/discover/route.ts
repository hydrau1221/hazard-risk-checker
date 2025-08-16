export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["iad1", "cle1", "pdx1"];

function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}

const UA = "RiskChecker/1.0 (+vercel)";

// 1) on privilégie gis.fema.gov (celui qui répond chez toi)
const CANDIDATE_BASES = [
  (process.env.NFHL_BASE || "").replace(/\/+$/, ""),
  "https://gis.fema.gov/arcgis/rest/services/NFHL",
  // "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL", // laissé en backup si besoin
].filter(Boolean) as string[];

async function fetchJSON(url: string) {
  const r = await fetch(url, {
    headers: { accept: "application/json", "user-agent": UA },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

function goodFields(info: any) {
  const names = (info?.fields || []).map((f: any) => String(f.name).toUpperCase());
  const has = (n: string) => names.includes(n);
  const geom = String(info?.geometryType || "").toLowerCase();
  const okGeom = geom.includes("polygon");
  const okCore = has("FLD_ZONE") && has("SFHA_TF");
  return okGeom && okCore;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const debug = url.searchParams.get("debug") === "1";
  const reports: any[] = [];

  for (const base of CANDIDATE_BASES) {
    try {
      // A) **Chemin court ultra-fiable** : tester directement l’ID 28 (Flood Hazard Zones)
      try {
        const info28 = await fetchJSON(`${base}/MapServer/28?f=pjson`);
        if (goodFields(info28)) {
          const payload: any = {
            base,
            layerId: 28,
            name: info28?.name || "Flood Hazard Zones",
            serviceUrl: `${base}/MapServer/28`,
            _mode: "forced-28",
          };
          return new Response(JSON.stringify(payload), { headers: json() });
        }
        reports.push({ base, tried: 28, ok: false });
      } catch (e: any) {
        reports.push({ base, tried: 28, error: String(e?.message || e) });
      }

      // B) **Fallback** : lecture de la liste, puis match par nom / scoring si possible
      const top = await fetchJSON(`${base}/MapServer?f=pjson`); // f=pjson marche mieux sur certains ArcGIS
      const layers: any[] = top?.layers ?? [];

      // 1) Nom direct (ex: "Flood Hazard Zones")
      const direct = layers.find((L: any) =>
        String(L.name).toUpperCase().includes("FLOOD HAZARD ZONES")
      );
      if (direct) {
        const info = await fetchJSON(`${base}/MapServer/${direct.id}?f=pjson`);
        if (goodFields(info)) {
          return new Response(JSON.stringify({
            base,
            layerId: direct.id,
            name: info?.name ?? direct.name,
            serviceUrl: `${base}/MapServer/${direct.id}`,
            _mode: "direct-name",
          }), { headers: json() });
        }
      }

      // 2) Dernier recours : balayer quelques IDs probables (20..35)
      for (let id = 20; id <= 35; id++) {
        try {
          const info = await fetchJSON(`${base}/MapServer/${id}?f=pjson`);
          if (goodFields(info)) {
            return new Response(JSON.stringify({
              base,
              layerId: id,
              name: info?.name ?? `Layer ${id}`,
              serviceUrl: `${base}/MapServer/${id}`,
              _mode: "scan-range",
            }), { headers: json() });
          }
        } catch {}
      }

      reports.push({ base, msg: "no suitable layer found by fallback" });
      // essaie la base suivante si dispo
    } catch (e: any) {
      reports.push({ base, error: String(e?.message || e) });
    }
  }

  const body = debug
    ? { error: "Could not locate NFHL flood layer on any base.", reports }
    : { error: "Could not locate NFHL flood layer on any base." };

  return new Response(JSON.stringify(body), { status: 404, headers: json() });
}
