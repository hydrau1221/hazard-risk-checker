export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["iad1", "cle1", "pdx1"]; // régions US Vercel

function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36 RiskChecker/1.0";

const CANDIDATE_BASES = [
  process.env.NFHL_BASE, // si tu veux forcer une URL via env
  "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL",
  "https://gis.fema.gov/arcgis/rest/services/NFHL",
].filter(Boolean) as string[];

async function pickBase() {
  for (const base of CANDIDATE_BASES) {
    try {
      const r = await fetch(`${base}/MapServer?f=json`, {
        headers: { accept: "application/json", "user-agent": UA },
        cache: "no-store",
      });
      if (r.ok) return base;
    } catch {}
  }
  throw new Error("All NFHL endpoints unreachable");
}

export async function GET() {
  try {
    const base = await pickBase();
    const r = await fetch(`${base}/MapServer?f=json`, {
      headers: { accept: "application/json", "user-agent": UA },
      cache: "no-store",
    });
    if (!r.ok) {
      return new Response(JSON.stringify({ error: `NFHL unreachable (${r.status})` }), {
        status: 502, headers: json(),
      });
    }
    const data = await r.json();
    const layers = data?.layers ?? [];
    const target = layers.find((l: any) => String(l.name).toUpperCase() === "S_FLD_HAZ_AR");
    if (!target) {
      return new Response(JSON.stringify({ error: "S_FLD_HAZ_AR not found" }), {
        status: 404, headers: json(),
      });
    }
    return new Response(
      JSON.stringify({
        layerId: target.id,
        name: target.name,
        base,
        serviceUrl: `${base}/MapServer/${target.id}`,
      }),
      { headers: json() }
    );
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: json() });
  }
}
