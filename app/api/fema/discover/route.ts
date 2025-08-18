export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = ["iad1", "cle1", "pdx1"];

function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}

export async function GET() {
  const base = (process.env.NFHL_BASE ||
    "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL"
  ).replace(/\/+$/, "");

  return new Response(JSON.stringify({
    base,
    layerId: 28,
    name: "Flood Hazard Zones",
    serviceUrl: `${base}/MapServer/28`,
    _mode: "hardcoded-28",
  }), { headers: json() });
}
