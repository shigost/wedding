// venue-autofill — server-side venue page reader + Anthropic extraction + photo import.
//
// Two actions (POST JSON):
//   { action: "extract",       url:  "<venue page url>" }
//   { action: "import-photos", urls: ["<img url>", ...] }
//
// The static app can't fetch other origins or hold API keys; this function does both.
// JWT verification is left ON (Supabase default), so only your logged-in app can call it.
//
// Secrets you set:   ANTHROPIC_API_KEY   (required),  EXTRACT_MODEL (optional)
// Auto-injected:     SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const EXTRACT_MODEL = Deno.env.get("EXTRACT_MODEL") || "claude-haiku-4-5-20251001";
const ALLOWED_ORIGIN = Deno.env.get("ALLOWED_ORIGIN") || "*";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const VENUE_BUCKET = "venue-images";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}
function fail(error: string, message: string, status = 200): Response {
  return json({ ok: false, error, message }, status);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("method", "POST only", 405);

  let payload: any;
  try { payload = await req.json(); } catch { return fail("bad_request", "Invalid JSON body."); }

  const action = payload?.action;
  try {
    if (action === "extract") return await handleExtract(String(payload.url || ""));
    if (action === "import-photos") return await handleImport(Array.isArray(payload.urls) ? payload.urls : []);
    return fail("bad_request", "Unknown action.");
  } catch (e) {
    console.error("unhandled", e);
    return fail("server_error", "Something went wrong on the server.");
  }
});

// ── URL guard: only http/https, no internal/loopback/metadata hosts (basic SSRF guard) ──
function safeUrl(raw: string): URL | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (
    h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") ||
    h === "0.0.0.0" || h === "::1" || h === "metadata.google.internal" ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  ) return null;
  return u;
}

async function fetchWithTimeout(url: string, ms: number, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, redirect: "follow" });
  } finally { clearTimeout(t); }
}

// ══════════════════════════════ EXTRACT ══════════════════════════════
async function handleExtract(rawUrl: string): Promise<Response> {
  if (!ANTHROPIC_API_KEY) return fail("config", "Server is missing ANTHROPIC_API_KEY.");
  const u = safeUrl(rawUrl);
  if (!u) return fail("bad_request", "Enter a valid http(s) venue URL.");

  let res: Response;
  try {
    res = await fetchWithTimeout(u.href, 12000, {
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en" },
    });
  } catch (e) {
    return fail("timeout", "The site took too long to respond — enter details manually.");
  }
  if (!res.ok) {
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      return fail("blocked", `That site blocked the fetch (HTTP ${res.status}) — enter details manually.`);
    }
    return fail("fetch_failed", `Couldn't load the page (HTTP ${res.status}).`);
  }

  const finalUrl = res.url || u.href;
  const html = (await res.text()).slice(0, 2_000_000); // cap 2MB of HTML
  const parsed = parsePage(html, finalUrl);

  if (!parsed.text && !parsed.jsonld && !parsed.title && !parsed.description) {
    return fail("js_required", "This page loads its content with JavaScript; I couldn't read it. Enter details manually.");
  }

  const fields = await extractFields(parsed);
  if (!fields) return fail("extract_failed", "Couldn't read venue details from this page.");

  const EXPECTED: [string, string][] = [
    ["name", "Venue name"], ["subtitle", "Subtitle / type"], ["area", "Area / location"],
    ["dist", "Transfer / distance"], ["capacity", "Guest capacity"], ["cost_estimate", "Pricing"],
    ["best_season", "Best season"], ["overview", "Overview"],
  ];
  const isEmpty = (v: unknown) => v == null || v === "" || (Array.isArray(v) && v.length === 0);
  const missing = EXPECTED.filter(([k]) => isEmpty((fields as any)[k])).map(([key, label]) => ({ key, label }));

  return json({
    ok: true,
    fields,
    missing,
    images: parsed.images.slice(0, 30).map((url) => ({ url })),
    source: { finalUrl, title: parsed.title || null },
  });
}

// ── Lightweight HTML parsing: JSON-LD, OG/meta, readable text, image URLs ──
function parsePage(html: string, baseUrl: string) {
  const abs = (src: string): string | null => { try { return new URL(src, baseUrl).href; } catch { return null; } };

  // JSON-LD (schema.org) — often the cleanest structured data on venue pages.
  const jsonldBlocks: string[] = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const t = (m[1] || "").trim();
    if (t) { try { JSON.parse(t); jsonldBlocks.push(t); } catch { /* skip malformed */ } }
  }
  const jsonld = jsonldBlocks.join("\n").slice(0, 6000);

  const metaOf = (re: RegExp) => { const m = html.match(re); return m ? decode(m[1].trim()) : ""; };
  const title =
    metaOf(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    metaOf(/<title[^>]*>([^<]+)<\/title>/i);
  const description =
    metaOf(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
    metaOf(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);

  // Images: og:image, <img src|data-src>, srcset (first candidate of each).
  const imgs = new Set<string>();
  for (const m of html.matchAll(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/gi)) {
    const a = abs(m[1]); if (a) imgs.add(a);
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = (tag.match(/\b(?:data-src|src)=["']([^"']+)["']/i) || [])[1];
    if (src) { const a = abs(src); if (a) imgs.add(a); }
    const srcset = (tag.match(/\bsrcset=["']([^"']+)["']/i) || [])[1];
    if (srcset) { const first = srcset.split(",")[0]?.trim().split(/\s+/)[0]; if (first) { const a = abs(first); if (a) imgs.add(a); } }
  }
  const images = [...imgs].filter((s) => /^https?:/i.test(s) && !looksLikeIcon(s));

  // Readable text: drop non-content blocks, strip tags, decode, collapse.
  const text = decode(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ).slice(0, 12000);

  return { jsonld, title, description, images, text };
}

function looksLikeIcon(url: string): boolean {
  return /\.svg(\?|$)/i.test(url) || /(sprite|favicon|logo|icon|badge|pixel|spacer|1x1)/i.test(url);
}

function decode(s: string): string {
  return (s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

// ── Anthropic extraction via tool-use (forces valid JSON; every field nullable) ──
const VENUE_TOOL = {
  name: "emit_venue",
  description: "Return venue facts stated on the page. Use null for anything not explicitly stated.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: ["string", "null"], description: "Official venue name." },
      subtitle: { type: ["string", "null"], description: "Short descriptor line in the style '<Venue type> · <Area> · <tier/notable>', e.g. 'Cliffside Resort · Pedregal · Ultra-Luxury'. Build only from stated facts." },
      area: { type: ["string", "null"], description: "Town/region/location." },
      dist: { type: ["string", "null"], description: "Transfer/distance as written, e.g. '25 min from Lisbon'." },
      dist_min: { type: ["number", "null"], description: "Transfer time in minutes, only if a number of minutes is explicitly stated." },
      capacity: { type: ["string", "null"], description: "Guest capacity as written, e.g. '60–1,200'. Only if stated." },
      cost_estimate: { type: ["string", "null"], description: "Pricing exactly as written (e.g. 'from €15,000', 'Pricing on request'). Never invent or estimate figures." },
      best_season: { type: ["string", "null"], description: "Best/recommended season if stated, e.g. 'Apr–Oct'." },
      overview: { type: ["string", "null"], description: "1–3 sentence factual summary drawn from the page. No invented facts." },
      tags: { type: ["array", "null"], items: { type: "string" }, description: "3–8 short descriptors actually supported by the page (e.g. 'Oceanfront', 'Historic', 'Garden')." },
      website: { type: ["string", "null"], description: "Official website URL if shown." },
      contact_email: { type: ["string", "null"] },
      contact_phone: { type: ["string", "null"] },
      ocean: { type: ["boolean", "null"], description: "true/false only if the page states ocean/beach access; else null." },
      on_site_rooms: { type: ["boolean", "null"], description: "true/false only if on-site accommodation is stated; else null." },
      catering_included: { type: ["boolean", "null"], description: "true/false only if in-house/included catering is stated; else null." },
    },
    required: [
      "name", "subtitle", "area", "dist", "dist_min", "capacity", "cost_estimate",
      "best_season", "overview", "tags", "website", "contact_email", "contact_phone",
      "ocean", "on_site_rooms", "catering_included",
    ],
  },
};

const SYSTEM = [
  "You extract wedding-venue facts from a single web page into a fixed JSON schema via the emit_venue tool.",
  "Rules:",
  "- Use null for anything the page does not explicitly state. Do NOT guess or infer.",
  "- NEVER invent or estimate numbers, capacities, distances, or prices. Capture figures only as written.",
  "- subtitle: compose '<Venue type> · <Area> · <tier/notable>' from stated facts only; if type isn't clear, omit that segment rather than inventing one.",
  "- overview may lightly paraphrase the page's own description but must add no facts not present.",
  "- Prefer JSON-LD and meta values when present; fall back to the page text.",
].join("\n");

async function extractFields(parsed: { jsonld: string; title: string; description: string; text: string }) {
  const content =
    `PAGE TITLE:\n${parsed.title || "(none)"}\n\n` +
    `META DESCRIPTION:\n${parsed.description || "(none)"}\n\n` +
    `JSON-LD (schema.org), if any:\n${parsed.jsonld || "(none)"}\n\n` +
    `READABLE PAGE TEXT:\n${parsed.text || "(none)"}`;

  let r: Response;
  try {
    r = await fetchWithTimeout("https://api.anthropic.com/v1/messages", 30000, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        max_tokens: 1500,
        system: SYSTEM,
        tools: [VENUE_TOOL],
        tool_choice: { type: "tool", name: "emit_venue" },
        messages: [{ role: "user", content }],
      }),
    });
  } catch { return null; }

  if (!r.ok) { console.error("anthropic", r.status, await r.text().catch(() => "")); return null; }
  const data = await r.json().catch(() => null);
  const block = data?.content?.find((b: any) => b.type === "tool_use" && b.name === "emit_venue");
  if (!block?.input) return null;
  const f = block.input;
  if (Array.isArray(f.tags)) f.tags = f.tags.map((t: any) => String(t).trim()).filter(Boolean).slice(0, 8);
  return f;
}

// ══════════════════════════════ IMPORT PHOTOS ══════════════════════════════
async function handleImport(urls: string[]): Promise<Response> {
  if (!SUPABASE_URL || !SERVICE_ROLE) return fail("config", "Server storage is not configured.");
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const photos: { url: string }[] = [];
  const skipped: { url: string; reason: string }[] = [];

  for (const raw of urls.slice(0, 16)) {
    const u = safeUrl(String(raw || ""));
    if (!u) { skipped.push({ url: String(raw), reason: "invalid URL" }); continue; }
    if (looksLikeIcon(u.href)) { skipped.push({ url: u.href, reason: "logo/icon" }); continue; }
    try {
      const res = await fetchWithTimeout(u.href, 10000, { headers: { "User-Agent": UA, "Referer": u.origin } });
      if (!res.ok) { skipped.push({ url: u.href, reason: `HTTP ${res.status}` }); continue; }
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!ct.startsWith("image/") || ct.includes("svg")) { skipped.push({ url: u.href, reason: "not a raster image" }); continue; }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength < 20_000) { skipped.push({ url: u.href, reason: "too small (<20KB)" }); continue; }
      if (bytes.byteLength > 8_000_000) { skipped.push({ url: u.href, reason: "too large (>8MB)" }); continue; }
      const dim = imageSize(bytes);
      if (dim && Math.max(dim.w, dim.h) < 500) { skipped.push({ url: u.href, reason: `too small (${dim.w}×${dim.h})` }); continue; }

      const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : ct.includes("gif") ? "gif" : "jpg";
      const path = `imported/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error } = await sb.storage.from(VENUE_BUCKET).upload(path, bytes, { contentType: ct, upsert: false });
      if (error) { skipped.push({ url: u.href, reason: "upload failed" }); continue; }
      photos.push({ url: sb.storage.from(VENUE_BUCKET).getPublicUrl(path).data.publicUrl });
    } catch {
      skipped.push({ url: u.href, reason: "download failed/timeout" });
    }
  }
  return json({ ok: true, photos, skipped });
}

// ── Read pixel dimensions from the file header (PNG / JPEG / GIF / WEBP) ──
function imageSize(b: Uint8Array): { w: number; h: number } | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // PNG
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { w: dv.getUint32(16), h: dv.getUint32(20) };
  }
  // GIF
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { w: dv.getUint16(6, true), h: dv.getUint16(8, true) };
  }
  // JPEG — walk markers to a Start-Of-Frame
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: dv.getUint16(i + 5), w: dv.getUint16(i + 7) };
      }
      const len = dv.getUint16(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  }
  // WEBP
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (fourcc === "VP8 ") return { w: (dv.getUint16(26, true) & 0x3fff), h: (dv.getUint16(28, true) & 0x3fff) };
    if (fourcc === "VP8L") {
      const bits = dv.getUint32(21, true);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === "VP8X") {
      const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
      const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
      return { w, h };
    }
  }
  return null;
}
