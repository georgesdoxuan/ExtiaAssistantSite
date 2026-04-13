function getApiBase() {
  return process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001";
}

// Allow up to 10 minutes for indexing large URL lists.
export const maxDuration = 600;

export async function POST(request) {
  const apiBase = getApiBase();
  const start = Date.now();
  console.log(`[WEB/api] POST /api/site-index/refresh (proxy) -> ${apiBase}/api/site-index/refresh`);
  const body = await request.text();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9 * 60 * 1000); // 9 min abort

  try {
    const resp = await fetch(`${apiBase}/api/site-index/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body || "{}",
      signal: controller.signal
    });
    const text = await resp.text();
    console.log(`[WEB/api] DONE /api/site-index/refresh status=${resp.status} (${Date.now() - start}ms)`);
    return new Response(text, {
      status: resp.status,
      headers: { "Content-Type": resp.headers.get("content-type") || "application/json" }
    });
  } catch (err) {
    if (err.name === "AbortError") {
      console.error(`[WEB/api] TIMEOUT /api/site-index/refresh after ${Date.now() - start}ms`);
      return new Response(JSON.stringify({ error: "Indexation trop longue (timeout 9 min). Réduisez le nombre d'URLs ou relancez." }), {
        status: 504,
        headers: { "Content-Type": "application/json" }
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

