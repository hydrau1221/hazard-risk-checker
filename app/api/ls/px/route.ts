// app/api/ls/px/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const u = new URL(req.url);
  if (u.searchParams.get("ping") === "1") {
    return new Response(JSON.stringify({ ok: true, impl: "stub-ok" }), {
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ msg: "stub body" }), {
    headers: { "content-type": "application/json" },
  });
}
