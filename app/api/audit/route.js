function getApiBase() {
  return process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";
}

export async function POST(request) {
  const apiBase = getApiBase();
  const start = Date.now();
  console.log(`[WEB/api] POST /api/audit (proxy) -> ${apiBase}/api/audit`);
  const body = await request.text();
  const resp = await fetch(`${apiBase}/api/audit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body || "{}"
  });
  const text = await resp.text();
  console.log(`[WEB/api] DONE /api/audit status=${resp.status} (${Date.now() - start}ms)`);
  return new Response(text, {
    status: resp.status,
    headers: { "Content-Type": resp.headers.get("content-type") || "application/json" }
  });
}

