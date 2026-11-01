// My Music — backend for a YouTube Music-style app.
// No sample data anywhere: every track shown comes from the real
// YouTube Data API, or from Supabase (saved tracks) when configured.
// If a key is missing, the API returns a clear error instead of fake data.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");

// ---- Load .env from the root folder (this file's folder) ----
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
// YouTube key: the name used in Vercel is YOUTUBE_API_KEY; the older
// YOUTUBE_DATA_API name still works as a fallback. Either one is fine.
const YOUTUBE_API = process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_DATA_API || "";
// GROQ_API_KEY is reserved for future AI features. It is read here only
// so /api/health can report whether it is set — no GROQ feature uses
// it yet, and its value is never returned to the browser.
// Admin panel (built 2026-11-01, user request): sign in at /admin
// with ADMIN_EMAIL + ADMIN_PASSWORD from Vercel env vars. Those
// values are NEVER sent to the browser, never logged, and never put
// in the repo — the server only compares a login attempt against
// them and issues a signed, HttpOnly session cookie. If either var
// is missing, admin sign-in fails closed (503). Use a strong, unique
// password in Vercel; a short default password is not safe for this.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_NAME = (process.env.ADMIN_NAME || "").trim();
// Google sign-in: ENABLED 2026-11-01 (user added GOOGLE_CLIENT_ID +
// GOOGLE_CLIENT_SECRET in Vercel and asked to enable it). It turns on
// automatically when both vars are present, so no AUTH_ENABLED=true
// step is needed; set AUTH_ENABLED=false to turn it off again.
// Sign-in is optional — the app still works without it, and saved
// tracks still live in the browser. The session cookie below is NOT
// a security boundary for the library API (which still takes an
// email param); it only identifies the profile shown in the UI.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const AUTH_ENABLED = process.env.AUTH_ENABLED === "false"
  ? false
  : (process.env.AUTH_ENABLED === "true" || Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET));
// Redirect URI: if GOOGLE_REDIRECT_URI is set in Vercel, use it.
// Otherwise derive it from the incoming request host, so production
// automatically uses https://<your-domain>/auth/google/callback
// instead of the old localhost default. That exact URI must be
// registered in the Google Cloud OAuth client, or Google returns
// redirect_uri_mismatch.
function getRedirectUri(req) {
  const proto = (req.get && req.get("x-forwarded-proto")) || req.protocol || "https";
  const host = (req.get && req.get("host")) || `localhost:${PORT}`;
  const fromHost = `${proto}://${host}/auth/google/callback`;
  const envUri = process.env.GOOGLE_REDIRECT_URI || "";
  // Guard against the exact bug seen live 2026-11-01: Vercel had
  // GOOGLE_REDIRECT_URI=http://localhost:3000/... set, so production
  // sent Google a localhost redirect and got redirect_uri_mismatch.
  // A localhost env value must never win on a non-localhost host.
  if (envUri && !(host.startsWith("localhost") || host.startsWith("127.0.0.1")) && envUri.includes("localhost")) return fromHost;
  if (envUri) return envUri;
  return fromHost;
}
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k] = decodeURIComponent(rest.join("="));
  }
  return out;
}
function signUserSession(user) {
  // Signed like the admin session: payload.sig with HMAC keyed by
  // GOOGLE_CLIENT_SECRET (server-side only, never sent to the browser).
  // Without this, anyone who knew an approved email could forge a
  // plain base64 cookie and walk past the approval gate, so old
  // unsigned cookies are treated as no session at all — those users
  // simply sign in again through Google.
  const payload = Buffer.from(JSON.stringify(user), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", GOOGLE_CLIENT_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function getUser(req) {
  try {
    if (!GOOGLE_CLIENT_SECRET) return null;
    const raw = parseCookies(req).my_music_user || "";
    const [payload, sig] = raw.split(".");
    if (!payload || !sig) return null;
    const expected = crypto.createHmac("sha256", GOOGLE_CLIENT_SECRET).update(payload).digest("base64url");
    if (!safeEqualString(sig, expected)) return null;
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}
function parseDuration(iso) {
  if (!iso) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  return (parseInt(m[1] || "0", 10) * 3600) + (parseInt(m[2] || "0", 10) * 60) + parseInt(m[3] || "0", 10);
}
function mapVideo(item) {
  const id = typeof item.id === "string" ? item.id : item.id && item.id.videoId;
  const s = item.snippet || {};
  return {
    id,
    title: s.title || "",
    channel: s.channelTitle || "",
    thumbnail:
      (s.thumbnails && (s.thumbnails.medium || s.thumbnails.default || {}).url) || "",
    publishedAt: s.publishedAt || "",
    // YouTube tracks have no downloadable file: downloadUrl stays null.
    // It is only set for saved / file tracks the user attached a direct
    // audio link to (see /api/library and /api/library/download-url).
    downloadUrl: null,
    // Real duration in seconds when YouTube returned contentDetails.
    // Search results don't include it, so mergeDurations fills it in.
    durationSeconds: item.contentDetails ? parseDuration(item.contentDetails.duration) : null,
  };
}
// India availability filter (added 2026-11-01, user request):
// Do not show videos that cannot play in India. YouTube's search
// regionCode alone is not reliable, so every list is also checked
// against videos.list, which reports the real availability:
//  - a video videos.list does not return at all = removed / private
//  - status.privacyStatus != "public" = not publicly playable
//  - status.embeddable === false = cannot play in My Music's hidden
//    YouTube player at all, so showing it only leads to a stuck 0:00
//  - contentDetails.regionRestriction.blocked contains "IN", or
//    .allowed exists and does not contain "IN" = blocked in India
// If the availability check itself fails (API outage), fail open and
// return the list unfiltered rather than blanking the whole app.
function isAvailableInIndia(detail) {
  if (!detail) return false;
  if (detail.status && detail.status.privacyStatus && detail.status.privacyStatus !== "public") return false;
  if (detail.status && detail.status.embeddable === false) return false;
  const rr = (detail.contentDetails && detail.contentDetails.regionRestriction) || null;
  if (!rr) return true;
  if (Array.isArray(rr.blocked) && rr.blocked.includes("IN")) return false;
  if (Array.isArray(rr.allowed) && !rr.allowed.includes("IN")) return false;
  return true;
}
async function filterAvailableInIndia(items) {
  if (!items || !items.length) return items;
  try {
    const kept = [];
    for (let i = 0; i < items.length; i += 50) {
      const chunk = items.slice(i, i + 50);
      const data = await youtube("videos", { part: "status,contentDetails", id: chunk.map((x) => x.id).filter(Boolean).join(",") });
      const byId = new Map((data.items || []).map((it) => [typeof it.id === "string" ? it.id : it.id.videoId, it]));
      for (const x of chunk) if (isAvailableInIndia(byId.get(x.id))) kept.push(x);
    }
    return kept;
  } catch { return items; }
}
// Search/related/artist use the search endpoint, which has no duration.
// One cheap videos.list call (cost 1) fills durations for all ids.
async function mergeDurations(items) {
  const ids = (items || []).filter((x) => x.durationSeconds == null).map((x) => x.id).filter(Boolean);
  if (!ids.length) return items;
  try {
    const data = await youtube("videos", { part: "contentDetails", id: ids.join(",") });
    const byId = new Map((data.items || []).map((it) => [typeof it.id === "string" ? it.id : it.id.videoId, parseDuration(it.contentDetails && it.contentDetails.duration)]));
    for (const x of items) if (x.durationSeconds == null && byId.has(x.id)) x.durationSeconds = byId.get(x.id);
  } catch { /* duration stays null; the UI shows 0:00 rather than a fake time */ }
  return items;
}
async function youtube(pathname, params) {
  if (!YOUTUBE_API) {
    const err = new Error("YOUTUBE_DATA_API is not set in .env");
    err.status = 503;
    throw err;
  }
  const url = new URL(`https://www.googleapis.com/youtube/v3/${pathname}`);
  url.searchParams.set("key", YOUTUBE_API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || "YouTube API error");
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---- Health / config (never returns secret values) ----
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    authEnabled: AUTH_ENABLED,
    youtubeConfigured: Boolean(YOUTUBE_API),
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    googleConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
  });
});

app.get("/api/me", async (req, res) => {
  const user = AUTH_ENABLED ? getUser(req) : null;
  if (!user || !user.email) return res.json({ user: null, authEnabled: AUTH_ENABLED });
  // Admin approval enforcement (2026-11-01, gated app 2026-11-01):
  // a signed-in Google user who is not approved in Supabase is signed
  // out here, so removing a user in /admin revokes them without
  // waiting for their cookie to expire. If Supabase is not
  // configured, approval cannot be verified, so NO session counts
  // as approved — the app shows only the landing page (fail closed).
  // New Google sign-ins are blocked in the callback too.
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.json({ user: null, authEnabled: AUTH_ENABLED, registrationStatus: "setup" });
  }
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const row = await getRegisteredUser(user.email);
      if (!row || row.status !== "approved") {
        const isHttps = (req.get && req.get("x-forwarded-proto") === "https") || req.secure;
        res.setHeader("Set-Cookie", `my_music_user=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isHttps ? "; Secure" : ""}`);
        return res.json({ user: null, authEnabled: AUTH_ENABLED, registrationStatus: row ? row.status : "removed" });
      }
    } catch { /* transient DB error: do not revoke on a blip; the
                 callback check is strict on the next sign-in */ }
  }
  return res.json({ user, authEnabled: AUTH_ENABLED });
});

// ---- YouTube Data API (proxied so the API key never reaches the browser) ----
app.get("/api/search", requireApprovedUser, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing ?q=" });
  try {
    const data = await youtube("search", {
      part: "snippet", type: "video", q, maxResults: "25", order: "relevance", regionCode: "IN",
    });
    const withDurations = await mergeDurations((data.items || []).map(mapVideo));
    res.json({ items: await filterAvailableInIndia(withDurations) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/trending", requireApprovedUser, async (req, res) => {
  try {
    const data = await youtube("videos", {
      part: "snippet,statistics,contentDetails,status", chart: "mostPopular",
      videoCategoryId: "10", maxResults: "25", regionCode: "IN",
    });
    res.json({ items: await filterAvailableInIndia((data.items || []).map(mapVideo)) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/video/:id", requireApprovedUser, async (req, res) => {
  try {
    const data = await youtube("videos", {
      part: "snippet,statistics,contentDetails,status", id: req.params.id,
    });
    const item = (data.items || [])[0];
    if (!item) return res.status(404).json({ error: "Video not found" });
    if (!isAvailableInIndia(item)) return res.status(404).json({ error: "Video not available in India" });
    res.json(mapVideo(item));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/artist/:name", requireApprovedUser, async (req, res) => {
  const name = (req.params.name || "").trim();
  if (!name) return res.status(400).json({ error: "Missing artist name" });
  try {
    const data = await youtube("search", {
      part: "snippet", type: "video", q: name, maxResults: "25", order: "relevance", regionCode: "IN",
    });
    const all = await filterAvailableInIndia(await mergeDurations((data.items || []).map(mapVideo)));
    // Only songs actually by this channel, not just relevance matches.
    const exact = all.filter((t) => t.channel.toLowerCase() === name.toLowerCase());
    res.json({ items: exact, searched: all.length, exact: exact.length });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get("/api/related/:id", requireApprovedUser, async (req, res) => {
  try {
    const data = await youtube("search", {
      part: "snippet", type: "video", relatedToVideoId: req.params.id, maxResults: "12", regionCode: "IN",
    });
    const withDurations = await mergeDurations((data.items || []).map(mapVideo));
    res.json({ items: await filterAvailableInIndia(withDurations) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- Google sign-in (OAuth 2.0) — enabled when ID+Secret are set ----
app.get("/auth/google", (req, res) => {
  if (!AUTH_ENABLED) return res.status(503).send("Google sign-in is not enabled. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel and redeploy.");
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(503).send("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set. Add them in Vercel and redeploy.");
  }
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", getRedirectUri(req));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  res.redirect(url.toString());
});

app.get("/auth/google/callback", async (req, res) => {
  if (!AUTH_ENABLED) return res.status(503).send("Google sign-in is not enabled.");
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: getRedirectUri(req), grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error_description || "Token exchange failed");
    const meRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const profile = await meRes.json();
    const user = { name: profile.name || "", email: profile.email || "", picture: profile.picture || "" };
    if (!user.email) throw new Error("Google did not return an email address");
    // ---- Admin approval gate (2026-11-01, user request) ----
    // First Google sign-in = a registration that needs admin
    // permission. No one is signed in until an admin approves them
    // in /admin (with the admin email/password, not Google).
    // Approval lives in Supabase (my_music_users) because playlists
    // and Library are browser-local and cannot be approved across
    // devices from there. If Supabase is not configured, sign-in is
    // paused with a clear message — it is never bypassed.
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).send("User registration requires admin approval, but Supabase is not configured yet. Ask the admin to set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Vercel, run supabase/schema.sql (which creates the my_music_users table), and redeploy. Sign-in is paused until then.");
    }
    let row;
    try {
      row = await getRegisteredUser(user.email);
    } catch (e) {
      return res.status(500).send(`User approval check failed: ${e.message}. The admin needs to run supabase/schema.sql (my_music_users table) and redeploy.`);
    }
    if (!row) {
      try {
        await supabaseFetch("my_music_users", "POST", { user_email: user.email, name: user.name, picture: user.picture, status: "pending" });
      } catch {
        // Race (two sign-ins at once): re-read, do not fail the user.
        try { row = await getRegisteredUser(user.email); } catch {}
      }
      if (!row) return res.redirect("/?registration=pending");
    }
    if (row && row.status !== "approved") {
      return res.redirect(`/?registration=${row.status === "rejected" ? "rejected" : "pending"}`);
    }
    const cookie = signUserSession(user);
    const isHttps = (req.get && req.get("x-forwarded-proto") === "https") || req.secure;
    res.setHeader("Set-Cookie", `my_music_user=${encodeURIComponent(cookie)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${isHttps ? "; Secure" : ""}`);
    res.redirect("/");
  } catch (e) {
    res.status(500).send(`Google sign-in failed: ${e.message}`);
  }
});

app.get("/auth/logout", (req, res) => {
  const isHttpsOut = (req.get && req.get("x-forwarded-proto") === "https") || req.secure;
  res.setHeader("Set-Cookie", `my_music_user=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isHttpsOut ? "; Secure" : ""}`);
  res.redirect("/");
});

// Registered users for admin approval (Supabase, server-side only).
// Function declarations hoist, so the Google callback above can use
// these even though they are defined here.
async function getRegisteredUser(email) {
  const rows = await supabaseFetch(`my_music_users?select=*&user_email=eq.${encodeURIComponent(email)}`);
  return (rows || [])[0] || null;
}

// ---- Supabase: saved tracks (server-side only, service key never sent to browser) ----
async function supabaseFetch(query, method = "GET", body) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const err = new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set in .env");
    err.status = 503;
    throw err;
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${query}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err = new Error((data && data.message) || `Supabase error (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

app.get("/api/library", requireApprovedUser, async (req, res) => {
  // Gated app: a user can only read their own saved tracks.
  const requested = (req.query.email || "").trim();
  if (requested && requested.toLowerCase() !== req.approvedUser.email.toLowerCase()) {
    return res.status(403).json({ error: "You can only access your own library" });
  }
  const email = requested || req.approvedUser.email;
  if (!email) return res.json({ tracks: [], supabaseConfigured: Boolean(SUPABASE_URL) });
  try {
    const rows = await supabaseFetch(
      `saved_tracks?select=*&user_email=eq.${encodeURIComponent(email)}&order=created_at.desc`
    );
    res.json({
      tracks: (rows || []).map((r) => ({
        id: r.video_id, title: r.title, channel: r.channel, thumbnail: r.thumbnail,
        downloadUrl: r.download_url || null,
      })),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

function validDownloadUrl(url) {
  if (!url) return "";
  if (typeof url !== "string" || url.length > 2048) return null;
  if (!/^https?:\/\//i.test(url)) return null;
  return url;
}

// ---- Offline file proxy (for downloading direct file URLs that lack CORS headers) ----
// Enforces strict SSRF protection, content-length cap (50 MB), and timeout.
function isSafeExternalUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const host = (u.hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return false;
    // Block loopback, link-local, cloud metadata, and RFC1918 private IPv4/IPv6 ranges
    if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
    if (host === "::1" || host === "0:0:0:0:0:0:0:1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return false;
    return true;
  } catch {
    return false;
  }
}

app.get("/api/offline-proxy", async (req, res) => {
  const targetUrl = String(req.query.url || "").trim();
  if (!isSafeExternalUrl(targetUrl)) {
    return res.status(400).json({ error: "Invalid or restricted file URL" });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const upstream = await fetch(targetUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "MyMusic-OfflineFetcher/1.0" },
    });
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: `Remote server returned ${upstream.status}` });
    }
    const finalUrl = upstream.url || targetUrl;
    if (!isSafeExternalUrl(finalUrl)) {
      return res.status(400).json({ error: "Redirected to restricted address" });
    }
    const contentLength = parseInt(upstream.headers.get("content-length") || "0", 10);
    const MAX_BYTES = 50 * 1024 * 1024; // 50 MB limit
    if (contentLength > MAX_BYTES) {
      return res.status(413).json({ error: "File exceeds 50 MB offline limit" });
    }
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const arrayBuffer = await upstream.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_BYTES) {
      return res.status(413).json({ error: "File exceeds 50 MB offline limit" });
    }
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(arrayBuffer.byteLength));
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(arrayBuffer));
  } catch (e) {
    const msg = e && e.name === "AbortError" ? "Download timed out" : (e.message || "Could not fetch remote file");
    res.status(502).json({ error: msg });
  } finally {
    clearTimeout(timeout);
  }
});

app.post("/api/library", requireApprovedUser, async (req, res) => {
  const { email, video_id, title, channel, thumbnail, download_url } = req.body || {};
  if (!email || !video_id) return res.status(400).json({ error: "email and video_id are required" });
  if (email.toLowerCase() !== req.approvedUser.email.toLowerCase()) {
    return res.status(403).json({ error: "You can only save to your own library" });
  }
  const dl = validDownloadUrl(download_url);
  if (dl === null) return res.status(400).json({ error: "download_url must be an http(s) link" });
  try {
    await supabaseFetch("saved_tracks", "POST", {
      user_email: email, video_id, title: title || "", channel: channel || "", thumbnail: thumbnail || "",
      download_url: dl,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Attach (or replace) a direct audio file link for a saved track.
// This is the user's own / licensed file — it never extracts a YouTube stream.
app.patch("/api/library/download-url", requireApprovedUser, async (req, res) => {
  const { email, video_id, download_url } = req.body || {};
  if (!email || !video_id) return res.status(400).json({ error: "email and video_id are required" });
  if (email.toLowerCase() !== req.approvedUser.email.toLowerCase()) {
    return res.status(403).json({ error: "You can only change your own library" });
  }
  const dl = validDownloadUrl(download_url);
  if (dl === null) return res.status(400).json({ error: "download_url must be an http(s) link" });
  try {
    await supabaseFetch(
      `saved_tracks?user_email=eq.${encodeURIComponent(email)}&video_id=eq.${encodeURIComponent(video_id)}`,
      "PATCH",
      { download_url: dl }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.delete("/api/library", requireApprovedUser, async (req, res) => {
  const email = (req.query.email || "").trim();
  const videoId = (req.query.video_id || "").trim();
  if (!email || !videoId) return res.status(400).json({ error: "email and video_id are required" });
  if (email.toLowerCase() !== req.approvedUser.email.toLowerCase()) {
    return res.status(403).json({ error: "You can only delete from your own library" });
  }
  try {
    await supabaseFetch(
      `saved_tracks?user_email=eq.${encodeURIComponent(email)}&video_id=eq.${encodeURIComponent(videoId)}`,
      "DELETE"
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- Gated app (2026-11-01, user request) ----
// Without admin approval, a visitor sees ONLY the landing page.
// The frontend enforces that, but the content APIs enforce it too,
// so a direct /api/trending or /api/search call without an approved
// signed session gets 401/403, not music. Admin sessions do NOT
// grant app access — an admin who wants the app signs in with
// Google and approves themselves in /admin like anyone else.
async function requireApprovedUser(req, res, next) {
  if (!AUTH_ENABLED) return res.status(401).json({ error: "Sign-in and admin approval required" });
  const user = getUser(req);
  if (!user || !user.email) return res.status(401).json({ error: "Sign-in and admin approval required" });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: "User approval is not configured yet (Supabase)" });
  }
  try {
    const row = await getRegisteredUser(user.email);
    if (!row || row.status !== "approved") return res.status(403).json({ error: "Admin approval required" });
  } catch (e) {
    return res.status(500).json({ error: `Approval check failed: ${e.message}` });
  }
  req.approvedUser = user;
  next();
}

// ---- Server playlists: public sharing (2026-11-01, user request) ----
// Before this, playlists lived only in browser localStorage, so a
// "Public" playlist was public in name only — no other user or
// device could ever see it. Now a playlist marked Public is stored
// on the server (Supabase) and is readable by ANY user, signed in
// or not, via GET /api/playlists/public and /api/playlists/:id.
// Private playlists are never stored here: the bridge only syncs
// public ones, and toggling to private deletes the server copy.
// Writing (create/update/delete) still requires an approved Google
// session, and only the owner can change or delete their playlist.
// File tracks are never shared: only YouTube tracks are synced,
// because a file track's link is the owner's own file.
function mapPlaylistTrack(r) {
  return {
    id: r.video_id, videoId: r.video_id, title: r.title || "", artist: r.channel || "",
    channel: r.channel || "", cover: r.thumbnail || "", thumbnail: r.thumbnail || "",
    duration: r.duration_seconds || 0, audioUrl: null,
  };
}
app.post("/api/playlists", requireApprovedUser, async (req, res) => {
  const name = String((req.body && req.body.name) || "").trim();
  const visibility = (req.body && req.body.visibility) === "public" ? "public" : "private";
  const owner = req.approvedUser;
  if (!name) return res.status(400).json({ error: "Playlist name is required" });
  try {
    const existing = await supabaseFetch(
      `my_music_playlists?select=*&owner_email=eq.${encodeURIComponent(owner.email)}&name=eq.${encodeURIComponent(name)}`
    );
    const old = (existing || [])[0] || null;
    if (visibility !== "public") {
      // Private = not on the server at all.
      if (old) {
        await supabaseFetch(`my_music_playlist_tracks?playlist_id=eq.${old.id}`, "DELETE");
        await supabaseFetch(`my_music_playlists?id=eq.${old.id}`, "DELETE");
      }
      return res.json({ ok: true, stored: false });
    }
    const tracks = ((req.body && req.body.tracks) || [])
      .filter((t) => t && t.id && !String(t.id).startsWith("file-"))
      .map((t, i) => ({
        video_id: t.videoId || t.id, title: t.title || "", channel: t.artist || t.channel || "",
        thumbnail: t.cover || t.thumbnail || "", duration_seconds: Math.floor(t.duration || t.durationSeconds || 0) || 0,
        position: i,
      }));
    let playlistId;
    if (old) {
      playlistId = old.id;
      await supabaseFetch(`my_music_playlists?id=eq.${playlistId}`, "PATCH", { name, visibility: "public", owner_name: owner.name || "" });
      await supabaseFetch(`my_music_playlist_tracks?playlist_id=eq.${playlistId}`, "DELETE");
    } else {
      const created = await supabaseFetch("my_music_playlists", "POST", {
        owner_email: owner.email, owner_name: owner.name || "", name, visibility: "public",
      });
      playlistId = (Array.isArray(created) ? created[0] : created) && (Array.isArray(created) ? created[0].id : created.id);
      if (!playlistId) throw new Error("Could not create playlist on the server");
    }
    if (tracks.length) {
      await supabaseFetch("my_music_playlist_tracks", "POST", tracks.map((t) => ({ ...t, playlist_id: playlistId })));
    }
    res.json({ ok: true, stored: true, id: playlistId, name, visibility: "public" });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.delete("/api/playlists/:id", requireApprovedUser, async (req, res) => {
  try {
    const rows = await supabaseFetch(`my_music_playlists?select=*&id=eq.${encodeURIComponent(req.params.id)}`);
    const pl = (rows || [])[0];
    if (!pl) return res.status(404).json({ error: "Playlist not found" });
    if (pl.owner_email.toLowerCase() !== req.approvedUser.email.toLowerCase()) {
      return res.status(403).json({ error: "Only the owner can delete this playlist" });
    }
    await supabaseFetch(`my_music_playlist_tracks?playlist_id=eq.${pl.id}`, "DELETE");
    await supabaseFetch(`my_music_playlists?id=eq.${pl.id}`, "DELETE");
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.get("/api/playlists/public", async (req, res) => {
  try {
    const rows = await supabaseFetch("my_music_playlists?select=id,owner_email,owner_name,name,visibility,created_at&visibility=eq.public&order=created_at.desc&limit=100");
    const list = rows || [];
    let counts = {};
    if (list.length) {
      const ids = list.map((p) => p.id).join(",");
      const trackRows = await supabaseFetch(`my_music_playlist_tracks?select=playlist_id&playlist_id=in.(${ids})&limit=1000`);
      for (const t of trackRows || []) counts[t.playlist_id] = (counts[t.playlist_id] || 0) + 1;
    }
    res.json({ playlists: list.map((p) => ({ ...p, track_count: counts[p.id] || 0 })) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.get("/api/playlists/:id", async (req, res) => {
  try {
    const rows = await supabaseFetch(`my_music_playlists?select=*&id=eq.${encodeURIComponent(req.params.id)}`);
    const pl = (rows || [])[0];
    if (!pl) return res.status(404).json({ error: "Playlist not found" });
    if (pl.visibility !== "public") {
      const user = getUser(req);
      if (!user || !user.email || user.email.toLowerCase() !== String(pl.owner_email).toLowerCase()) {
        return res.status(404).json({ error: "Playlist not found" });
      }
    }
    const trackRows = await supabaseFetch(`my_music_playlist_tracks?select=*&playlist_id=eq.${pl.id}&order=position.asc`);
    res.json({ id: pl.id, name: pl.name, owner_email: pl.owner_email, owner_name: pl.owner_name, visibility: pl.visibility, tracks: (trackRows || []).map(mapPlaylistTrack) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- Admin panel (/admin) ----
// Stateless signed session: the cookie holds {email, exp} plus an
// HMAC made with ADMIN_PASSWORD, so it works across serverless
// invocations with no server-side session store. The password itself
// is never in the cookie, the page, or any API response.
function adminConfigured() { return Boolean(ADMIN_EMAIL && ADMIN_PASSWORD); }
function safeEqualString(a, b) {
  const ab = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}
function signAdminSession() {
  const payload = Buffer.from(JSON.stringify({ email: ADMIN_EMAIL, exp: Date.now() + 12 * 3600 * 1000 }), "utf8").toString("base64url");
  const sig = crypto.createHmac("sha256", ADMIN_PASSWORD).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifyAdminSession(req) {
  try {
    if (!adminConfigured()) return false;
    const token = parseCookies(req).my_music_admin || "";
    const [payload, sig] = token.split(".");
    if (!payload || !sig) return false;
    const expected = crypto.createHmac("sha256", ADMIN_PASSWORD).update(payload).digest("base64url");
    if (!safeEqualString(sig, expected)) return false;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.email === ADMIN_EMAIL && typeof data.exp === "number" && data.exp > Date.now();
  } catch { return false; }
}
function requireAdmin(req, res, next) {
  if (!verifyAdminSession(req)) return res.status(401).json({ error: "Admin sign-in required" });
  next();
}
function adminCookie(req, value, maxAge) {
  const isHttps = (req.get && req.get("x-forwarded-proto") === "https") || req.secure;
  return `my_music_admin=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${isHttps ? "; Secure" : ""}`;
}
// Basic failed-login throttling, per calling IP, in memory. On
// serverless it is per-instance, so it slows guessing rather than
// guaranteeing a global block — the strong-password advice above is
// still the real protection.
const adminFailedLogins = new Map();
function adminRateLimited(ip) {
  const now = Date.now();
  const entry = adminFailedLogins.get(ip);
  if (!entry || now - entry.first > 10 * 60 * 1000) { adminFailedLogins.set(ip, { count: 0, first: now }); return false; }
  return entry.count >= 10;
}
function recordAdminFailure(ip) {
  const now = Date.now();
  const entry = adminFailedLogins.get(ip) || { count: 0, first: now };
  if (now - entry.first > 10 * 60 * 1000) { entry.count = 0; entry.first = now; }
  entry.count += 1;
  adminFailedLogins.set(ip, entry);
}
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});
app.post("/api/admin/login", (req, res) => {
  if (!adminConfigured()) return res.status(503).json({ error: "Admin is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD in Vercel and redeploy." });
  const ip = ((req.headers["x-forwarded-for"] || "").split(",")[0] || "").trim() || req.ip || "unknown";
  if (adminRateLimited(ip)) return res.status(429).json({ error: "Too many failed admin sign-in attempts. Try again later." });
  const { email, password } = req.body || {};
  // Generic message on purpose: do not reveal whether the email or
  // the password was the wrong part.
  if (!safeEqualString((email || "").trim(), ADMIN_EMAIL) || !safeEqualString(password || "", ADMIN_PASSWORD)) {
    recordAdminFailure(ip);
    return res.status(401).json({ error: "Invalid admin email or password" });
  }
  adminFailedLogins.delete(ip);
  res.setHeader("Set-Cookie", adminCookie(req, signAdminSession(), 12 * 3600));
  res.json({ ok: true, admin: { name: ADMIN_NAME, email: ADMIN_EMAIL } });
});
app.post("/api/admin/logout", (req, res) => {
  res.setHeader("Set-Cookie", adminCookie(req, "", 0));
  res.json({ ok: true });
});
app.get("/api/admin/me", (req, res) => {
  if (!verifyAdminSession(req)) return res.json({ admin: null });
  res.json({ admin: { name: ADMIN_NAME, email: ADMIN_EMAIL } });
});
app.get("/api/admin/health", requireAdmin, (req, res) => {
  res.json({
    admin: { name: ADMIN_NAME, email: ADMIN_EMAIL },
    youtubeConfigured: Boolean(YOUTUBE_API),
    googleConfigured: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
    supabaseConfigured: Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY),
    groqConfigured: Boolean(process.env.GROQ_API_KEY),
    authEnabled: AUTH_ENABLED,
  });
});
app.get("/api/admin/youtube-test", requireAdmin, async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing ?q=" });
  try {
    const data = await youtube("search", { part: "snippet", type: "video", q, maxResults: "5", order: "relevance", regionCode: "IN" });
    const withDurations = await mergeDurations((data.items || []).map(mapVideo));
    res.json({ items: await filterAvailableInIndia(withDurations) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.get("/api/admin/saved-tracks", requireAdmin, async (req, res) => {
  try {
    const rows = await supabaseFetch("saved_tracks?select=user_email,video_id,title,channel,thumbnail,created_at&order=created_at.desc&limit=100");
    res.json({ tracks: rows || [], supabaseConfigured: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.delete("/api/admin/saved-tracks", requireAdmin, async (req, res) => {
  const email = (req.query.email || "").trim();
  const videoId = (req.query.video_id || "").trim();
  if (!email || !videoId) return res.status(400).json({ error: "email and video_id are required" });
  try {
    await supabaseFetch(
      `saved_tracks?user_email=eq.${encodeURIComponent(email)}&video_id=eq.${encodeURIComponent(videoId)}`,
      "DELETE"
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ---- Admin: user registrations (approve / reject / remove) ----
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const rows = await supabaseFetch("my_music_users?select=user_email,name,picture,status,created_at,approved_at&order=created_at.desc&limit=200");
    res.json({ users: rows || [] });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.post("/api/admin/users/approve", requireAdmin, async (req, res) => {
  const email = ((req.body && req.body.email) || "").trim();
  if (!email) return res.status(400).json({ error: "email is required" });
  try {
    await supabaseFetch(
      `my_music_users?user_email=eq.${encodeURIComponent(email)}`,
      "PATCH",
      { status: "approved", approved_at: new Date().toISOString() }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.post("/api/admin/users/reject", requireAdmin, async (req, res) => {
  const email = ((req.body && req.body.email) || "").trim();
  if (!email) return res.status(400).json({ error: "email is required" });
  try {
    await supabaseFetch(
      `my_music_users?user_email=eq.${encodeURIComponent(email)}`,
      "PATCH",
      { status: "rejected", approved_at: null }
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});
app.delete("/api/admin/users", requireAdmin, async (req, res) => {
  const email = (req.query.email || "").trim();
  if (!email) return res.status(400).json({ error: "email is required" });
  try {
    // Removing a user deletes their registration row. Their next
    // Google sign-in creates a fresh pending registration, and
    // /api/me revokes any existing session on its next check.
    await supabaseFetch(
      `my_music_users?user_email=eq.${encodeURIComponent(email)}`,
      "DELETE"
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// SPA fallback: /song/:id, /artist/:name, /profile, /explore, /library
// and /watch?v=:id are all served by the same single-page app, so a
// shared link or a refresh on one of those pages must not 404.
app.get(["/explore", "/library", "/profile", "/watch", "/song/*", "/artist/*"], (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Local run: `npm start` listens. On Vercel, api/index.js imports this
// app as a serverless function instead, so do not listen there.
if (require.main === module) {
  app.listen(PORT, "0.0.0.0", () => console.log(`My Music running at http://localhost:${PORT}`));
}
module.exports = app;
