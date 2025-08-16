export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(headers: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...headers };
}

const NFHL_BASE = process.env.NFHL_BASE ?? "https://hazards.fema.gov/gis/nfhl/rest/services/public/NFHL";

export async function GET() {
  const url = `${NFHL_BASE}/MapServer?f=json`;
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) {
    return new Response(JSON.stringify({ error: "NFHL unreachable" }), { status: 502, headers: json() });
  }
  const data = await r.json();
  const layers = data?.layers ?? [];
  const target = layers.find((l: any) => String(l.name).toUpperCase() === "S_FLD_HAZ_AR");
  if (!target) {
    return new Response(JSON.stringify({ error: "S_FLD_HAZ_AR not found" }), { status: 404, headers: json() });
  }
  return new Response(JSON.stringify({ layerId: target.id, name: target.name, serviceUrl: `${NFHL_BASE}/MapServer/${target.id}` }), {
    headers: json(),
  });
}
