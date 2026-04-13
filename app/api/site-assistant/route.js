function getApiBase() {
  return process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";
}

export async function POST(request) {
  const apiBase = getApiBase();
  const body = await request.text();
  const resp = await fetch(`${apiBase}/api/site-assistant`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body || "{}"
  });
  const text = await resp.text();
  return new Response(text, {
    status: resp.status,
    headers: { "Content-Type": resp.headers.get("content-type") || "application/json" }
  });
}

