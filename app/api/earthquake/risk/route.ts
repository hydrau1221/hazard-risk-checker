export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}

// Map SDC -> ton échelle de risque
function levelFromSDC(sdc: string) {
  const x = String(sdc || "").toUpperCase();
  if (x === "A") return "Very Low";
  if (x === "B") return "Low";
  if (x === "C") return "Moderate";
  if (x === "D") return "High";
  // E ou F
  return "Very High";
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));
  // Par défaut on prend ASCE 7-22 + Site Class D (usage courant quand inconnu)
  const edition = (u.searchParams.get("edition") || "asce7-22").toLowerCase(); // "asce7-22" ou "asce7-16"
  const siteClass = (u.searchParams.get("siteClass") || "D").toUpperCase();    // A,B,BC,C,CD,D,DE,E,Default

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return new Response(JSON.stringify({ error: "lat & lon required" }), { status: 400, headers: json() });
  }

  const endpoint = `https://earthquake.usgs.gov/ws/designmaps/${edition}.json`;
  const qs = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    riskCategory: "I",      // <= demandé
    siteClass,
    title: "HydrauRisk"
  });

  const r = await fetch(`${endpoint}?${qs.toString()}`, {
    headers: { accept: "application/json", "user-agent": "HydrauRiskChecker/1.0 (+server)" },
    cache: "no-store",
  });

  if (!r.ok) {
    return new Response(JSON.stringify({ error: `USGS Design Maps failed (${r.status})` }), {
      status: 502, headers: json(),
    });
  }

  const j = await r.json();
  const data = j?.data || {};
  const sdc = data?.sdc;           // "A"..."F"
  if (!sdc) {
    return new Response(JSON.stringify({ error: "No SDC returned from USGS" }), { status: 502, headers: json() });
  }

  const level = levelFromSDC(sdc);

  return new Response(JSON.stringify({
    level,                  // "Very Low" | "Low" | "Moderate" | "High" | "Very High"
    sdc,                    // A..F
    sds: data?.sds ?? null, // design spectral accelerations (utile si tu veux)
    sd1: data?.sd1 ?? null,
    pgam: data?.pgam ?? null,
    edition: edition.toUpperCase(), // ASCE7-22 ou ASCE7-16
    siteClass,
    note: "USGS Design Maps (ASCE), Risk Category I"
  }), { headers: json() });
}
