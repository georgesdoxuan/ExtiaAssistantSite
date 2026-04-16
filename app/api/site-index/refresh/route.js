import { buildExtiaSiteIndex } from "../../../../src/siteIndexer.js";
import { ensureSupabaseSchema, isSupabaseConfigured, writeIndexToSupabase } from "../../../../src/supabaseIndexStore.js";

function getApiBase() {
  return process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "";
}

// Allow up to 10 minutes for indexing large URL lists.
export const maxDuration = 600;

export async function POST(request) {
  const apiBase = getApiBase();
  if (apiBase) {
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

  try {
    const payload = await request.json().catch(() => ({}));
    const maxUrls = Number(payload?.maxUrls || process.env.EXTIA_MAX_URLS || "300");
    const forceBrowser = payload?.forceBrowser === true;
    const visionEnabled = process.env.EXTIA_VISION_ENABLED === "true";
    const index = await buildExtiaSiteIndex({ maxUrls, forceBrowser, visionEnabled });
    let stored_in = "file";
    if (isSupabaseConfigured()) {
      await ensureSupabaseSchema();
      await writeIndexToSupabase(index);
      stored_in = "file+supabase";
    }
    return Response.json({
      ok: true,
      total_pages: index.total_pages,
      total_errors: index.total_errors,
      categories: index.categories,
      stored_in
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

