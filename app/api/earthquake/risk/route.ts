export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function json(h: Record<string, string> = {}) {
  return { "content-type": "application/json", "access-control-allow-origin": "*", ...h };
}

const UA = process.env.EQ_USER_AGENT || "HydrauRiskChecker/1.0 (+server)";

type RiskLevel = "Very Low" | "Low" | "Moderate" | "High" | "Very High";

function levelFromSDC(sdc: string): RiskLevel {
  const x = String(sdc || "").toUpperCase();
  if (x === "A") return "Very Low";
  if (x === "B") return "Low";
  if (x === "C") return "Moderate";
  if (x === "D") return "High";
  return "Very High"; // E ou F
}

async function callUSGS(lat: number, lon: number, edition: "asce7-22" | "asce7-16", siteClass: string) {
  const endpoint = `https://earthquake.usgs.gov/ws/designmaps/${edition}.json`;
  const qs = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    riskCategory: "I",
    siteClass,
    title: "HydrauRisk",
  });
  const r = await fetch(`${endpoint}?${qs}`, {
    headers: { accept: "application/json", "user-agent": UA },
    cache: "no-store",
  });
  const bodyText = await r.text();
  let body: any = null;
  try { body = JSON.parse(bodyText); } catch {}

  const d = body?.data ?? body?.response?.data ?? null;
  const sdc = d?.sdc ?? null;
  const sds = d?.sds ?? null;
  const sd1 = d?.sd1 ?? null;
  const pgam = d?.pgam ?? null;

  return {
    ok: r.ok,
    status: r.status,
    edition,
    siteClass,
    sdc, sds, sd1, pgam,
    debug: {
      hasData: !!d,
      keys: d ? Object.keys(d).slice(0, 10) : [],
      message: body?.message || body?.error || null,
    }
  };
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));
  const debug = u.searchParams.get("debug") === "1";

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return new Response(JSON.stringify({ error: "lat & lon required" }), { status: 400, headers: json() });
  }

  const tries: Array<{edition: "asce7-22"|"asce7-16"; siteClass: string}> = [
    { edition: "asce7-22", siteClass: "D" },
    { edition: "asce7-22", siteClass: "Default" },
    { edition: "asce7-16", siteClass: "D" },
    { edition: "asce7-16", siteClass: "Default" },
  ];

  const attempts: any[] = [];
  for (const t of tries) {
    try {
      const res = await callUSGS(lat, lon, t.edition, t.siteClass);
      attempts.push(res);
      if (res.ok && res.sdc) {
        const level = levelFromSDC(res.sdc);
        return new Response(JSON.stringify({
          level,
          sdc: res.sdc,
          sds: res.sds,
          sd1: res.sd1,
          pgam: res.pgam,
          edition: t.edition.toUpperCase(),
          siteClass: t.siteClass,
          note: "USGS Design Maps (ASCE), Risk Category I",
        }), { headers: json() });
      }
    } catch (e: any) {
      attempts.push({ edition: t.edition, siteClass: t.siteClass, error: String(e?.message || e) });
    }
  }

  const diag = attempts.map(a => ({
    edition: a.edition,
    siteClass: a.siteClass,
    ok: a.ok,
    status: a.status,
    sdc: a.sdc ?? null,
    dbg: a.debug || a.error || null,
  }));

  const body = debug
    ? { error: "No SDC returned from USGS after fallbacks.", attempts: diag }
    : { error: "No SDC returned from USGS" };

  return new Response(JSON.stringify(body), { status: 502, headers: json() });
}
