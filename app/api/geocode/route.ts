export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}

// Utilise Nominatim (OSM). Mets ton email si tu veux être clean vis-à-vis de leur policy.
const UA = process.env.GEOCODE_UA || "HydrauRiskChecker/1.0 (contact: you@example.com)";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const address = url.searchParams.get("address");
  if (!address) {
    return new Response(JSON.stringify({ error: "address is required" }), { status: 400, headers: json() });
  }

  const qs = new URLSearchParams({
    format: "jsonv2",
    q: address,
    limit: "1",
    addressdetails: "0",
  });

  const r = await fetch(`https://nominatim.openstreetmap.org/search?${qs}`, {
    headers: { "user-agent": UA, accept: "application/json" },
    cache: "no-store",
  });

  if (!r.ok) {
    return new Response(JSON.stringify({ error: `geocode failed (${r.status})` }), {
      status: 502,
      headers: json(),
    });
  }

  const arr = await r.json();
  if (!arr || !arr[0]) {
    return new Response(JSON.stringify({ error: "no result" }), { status: 404, headers: json() });
  }

  const lat = parseFloat(arr[0].lat);
  const lon = parseFloat(arr[0].lon);

  return new Response(
    JSON.stringify({ lat, lon, display_name: arr[0].display_name }),
    { headers: json() }
  );
}
