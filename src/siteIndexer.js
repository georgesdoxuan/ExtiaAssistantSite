import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
import { extractImageUrls, extractTextFromImages, createOCRWorker, terminateOCRWorker } from "./visionExtractor.js";

const SITE_BASE = "https://www.extia.fr";
const INDEX_PATH = path.resolve(process.cwd(), "output", "extia-site-index.json");
const SITE_HOSTS = new Set(["www.extia.fr", "extia.fr", "www.extia-group.com", "extia-group.com"]);
const PROVIDED_URLS_PATH = path.resolve(process.cwd(), "listeliens.md");

function normalizeInternalUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!SITE_HOSTS.has(u.hostname.toLowerCase())) return null;
    if (!/^https?:$/.test(u.protocol)) return null;
    if (u.pathname.startsWith("/wp-json")) return null;
    if (/\.(pdf|jpg|jpeg|png|gif|webp|svg|zip|xml)$/i.test(u.pathname)) return null;
    u.hash = "";
    u.search = "";
    return u.toString();
  } catch {
    return null;
  }
}

function categoryFromUrl(urlString) {
  try {
    const u = new URL(urlString);
    const seg = u.pathname.split("/").filter(Boolean)[0] || "home";
    return seg.toLowerCase();
  } catch {
    return "autre";
  }
}

async function fetchText(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "GET", signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractFirst(regex, text) {
  const m = String(text || "").match(regex);
  return (m?.[1] || "").trim();
}

async function fetchSitemapUrls(maxUrls = 150) {
  const candidates = [
    `${SITE_BASE}/sitemap.xml`,
    `${SITE_BASE}/sitemap_index.xml`,
    `https://extia.fr/sitemap.xml`,
    `https://extia.fr/sitemap_index.xml`
  ];

  async function parseSitemap(xml) {
    return [...xml.matchAll(/<loc>(.*?)<\/loc>/gi)].map((m) => m[1].trim());
  }

  for (const sm of candidates) {
    try {
      const xml = await fetchText(sm);
      const locs = await parseSitemap(xml);

      const nestedSitemaps = locs.filter((u) => u.endsWith(".xml"));
      let nestedUrls = [];
      for (const n of nestedSitemaps.slice(0, 20)) {
        try {
          const nxml = await fetchText(n);
          const nlocs = await parseSitemap(nxml);
          nestedUrls.push(...nlocs);
        } catch { /* ignore */ }
      }

      const merged = [...locs, ...nestedUrls];
      const urls = merged.filter((u) => {
        try {
          const h = new URL(u).hostname.toLowerCase();
          return SITE_HOSTS.has(h) && !u.endsWith(".xml");
        } catch { return false; }
      });
      if (urls.length) return urls.slice(0, maxUrls);
    } catch { /* try next */ }
  }
  return [SITE_BASE];
}

async function readProvidedUrls(maxUrls = 150) {
  try {
    const text = await fs.readFile(PROVIDED_URLS_PATH, "utf8");
    const urls = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((l) => /^https?:\/\//i.test(l))
      .map((u) => normalizeInternalUrl(u))
      .filter(Boolean);
    return [...new Set(urls)].slice(0, maxUrls);
  } catch {
    return [];
  }
}

// Render a page with Puppeteer (full JS execution) and extract text content.
// Uses networkidle2 to wait for async data fetching to complete.
async function renderPage(browser, url) {
  const page = await browser.newPage();
  try {
    // Block images/fonts/media to speed up rendering — we only need text.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "media", "font", "stylesheet"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });

    // Extract content from the fully-rendered DOM.
    const data = await page.evaluate(() => {
      const getText = (sel) => document.querySelector(sel)?.innerText?.trim() || "";
      const getMeta = (name) =>
        document.querySelector(`meta[name="${name}"]`)?.getAttribute("content")?.trim() || "";

      // Get all visible text, excluding nav/footer noise.
      // We target the main content area if possible, fall back to body.
      const mainEl =
        document.querySelector("main") ||
        document.querySelector("[role='main']") ||
        document.querySelector("article") ||
        document.body;

      // Clone to avoid mutating the live DOM
      const clone = mainEl.cloneNode(true);
      // Remove nav, header, footer elements from the clone
      for (const el of clone.querySelectorAll("nav, header, footer, script, style, [aria-hidden='true']")) {
        el.remove();
      }
      const mainText = (clone.innerText || clone.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 8000);

      return {
        title: document.title?.trim() || "",
        h1: getText("h1"),
        meta_description: getMeta("description"),
        text_snippet: mainText
      };
    });

    return data;
  } finally {
    await page.close();
  }
}

async function extractInternalLinks(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (["image", "media", "font"].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 20000 });
    const hrefs = await page.evaluate(() =>
      [...document.querySelectorAll("a[href]")].map((a) => a.href).filter(Boolean)
    );
    return hrefs.map((h) => normalizeInternalUrl(h)).filter(Boolean);
  } finally {
    await page.close();
  }
}

async function crawlInternalUrls(browser, { startUrl = SITE_BASE, maxUrls = 120 } = {}) {
  const queue = [startUrl];
  const seen = new Set();
  const collected = [];

  while (queue.length > 0 && collected.length < maxUrls) {
    const current = queue.shift();
    const normalized = normalizeInternalUrl(current);
    if (!normalized || seen.has(normalized)) continue;

    seen.add(normalized);
    collected.push(normalized);

    let links = [];
    try {
      links = await extractInternalLinks(browser, normalized);
    } catch {
      continue;
    }

    for (const nextUrl of links) {
      if (!seen.has(nextUrl) && !queue.includes(nextUrl)) {
        queue.push(nextUrl);
      }
      if (queue.length + collected.length >= maxUrls * 2) break;
    }
  }

  return collected;
}

async function indexPage(browser, url) {
  const data = await renderPage(browser, url);
  return {
    url,
    category: categoryFromUrl(url),
    title: data.title,
    h1: data.h1,
    meta_description: data.meta_description,
    text_snippet: data.text_snippet
  };
}

function parsePageHtml(url, html) {
  const title = extractFirst(/<title[^>]*>([\s\S]*?)<\/title>/i, html);
  const rawH1 = extractFirst(/<h1[^>]*>([\s\S]*?)<\/h1>/i, html);
  const h1 = stripHtml(rawH1);
  const meta_description = extractFirst(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
    html
  );
  const text_snippet = stripHtml(html).slice(0, 8000);
  return {
    url,
    category: categoryFromUrl(url),
    title: stripHtml(title),
    h1,
    meta_description: stripHtml(meta_description),
    text_snippet,
    image_text: ""
  };
}

async function indexPageHttp(url) {
  const html = await fetchText(url);
  return parsePageHtml(url, html);
}

async function indexPageHttpWithVision(url, ocrWorker) {
  const html = await fetchText(url);
  const page = parsePageHtml(url, html);
  const imageUrls = extractImageUrls(html, url, 3);
  const imageText = imageUrls.length ? await extractTextFromImages(imageUrls, ocrWorker) : "";
  page.image_text = imageText;
  if (imageText) {
    page.text_snippet = (page.text_snippet + "\n" + imageText).slice(0, 10000);
  }
  return page;
}

export async function buildExtiaSiteIndex({ maxUrls = 300, forceBrowser = false, visionEnabled = false } = {}) {
  const pages = [];
  const errors = [];

  // 1) Primary source: user-provided URL list (listeliens.md).
  const providedUrls = await readProvidedUrls(maxUrls);
  let uniqueUrls = [...providedUrls];

  // 2) Secondary source: sitemap (only if no provided list).
  if (uniqueUrls.length === 0) {
    const sitemapUrls = await fetchSitemapUrls(maxUrls);
    uniqueUrls = [...new Set(sitemapUrls.map((u) => normalizeInternalUrl(u)).filter(Boolean))];
  }

  const useBrowser = forceBrowser && uniqueUrls.length <= 30;

  // Start Tesseract OCR worker once for the whole indexing run (reuse across pages).
  let ocrWorker = null;
  if (visionEnabled && !useBrowser) {
    console.log("[indexer] Starting Tesseract OCR worker (fra+eng)...");
    try { ocrWorker = await createOCRWorker(); } catch (e) {
      console.warn("[indexer] Tesseract init failed, vision disabled:", e?.message);
    }
  }

  let browser = null;
  if (useBrowser) {
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
      });
    } catch {
      browser = null;
    }
  }

  // 3) Fallback crawl when source is sparse (browser mode only).
  if (browser && uniqueUrls.length < Math.min(15, maxUrls)) {
    const crawledUrls = await crawlInternalUrls(browser, { startUrl: SITE_BASE, maxUrls });
    uniqueUrls = [...new Set([...uniqueUrls, ...crawledUrls])].slice(0, maxUrls);
  }

  try {
    // Tesseract is CPU-bound — reduce concurrency when OCR is active.
    const CONCURRENCY = browser ? 4 : (ocrWorker ? 3 : 12);
    for (let i = 0; i < uniqueUrls.length; i += CONCURRENCY) {
      const batch = uniqueUrls.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((url) => {
          if (browser) return indexPage(browser, url);
          if (ocrWorker) return indexPageHttpWithVision(url, ocrWorker);
          return indexPageHttp(url);
        })
      );
      for (let j = 0; j < results.length; j++) {
        const r = results[j];
        if (r.status === "fulfilled") {
          pages.push(r.value);
        } else {
          errors.push({ url: batch[j], error: r.reason?.message || String(r.reason) });
        }
      }
    }
  } finally {
    if (browser) await browser.close();
    await terminateOCRWorker(ocrWorker);
  }

  const grouped = {};
  for (const p of pages) {
    if (!grouped[p.category]) grouped[p.category] = [];
    grouped[p.category].push(p);
  }

  const payload = {
    site: SITE_BASE,
    built_at: new Date().toISOString(),
    total_pages: pages.length,
    total_errors: errors.length,
    categories: Object.keys(grouped).sort(),
    grouped_pages: grouped,
    errors: errors.slice(0, 30)
  };

  await fs.mkdir(path.dirname(INDEX_PATH), { recursive: true });
  await fs.writeFile(INDEX_PATH, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

export async function readExtiaSiteIndex() {
  const text = await fs.readFile(INDEX_PATH, "utf8");
  return JSON.parse(text);
}

export function getIndexPath() {
  return INDEX_PATH;
}
