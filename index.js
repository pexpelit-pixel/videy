// index.js
const UPLOAD_PATH = "/api/upload";
const PROXY_PATH = "/api/proxy";
const VIDEO_PREFIX = "video:";
const ORDER_PREFIX = "order:";
const CDN_BASE = "https://cdn.videy.co";
const DEFAULT_VISITOR_ID = "1f5f718b-06b2-40f9-82da-0a73dfdadd1c";
const DEFAULT_UPLOAD_URL = "https://videy.co/api/upload";

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      if (pathname === "/") {
        return htmlResponse(renderHome(url));
      }

      if (pathname === UPLOAD_PATH) {
        if (request.method === "GET") {
          return htmlResponse(renderUploadPage());
        }

        if (request.method === "POST") {
          return await handleUpload(request, env, url);
        }

        return textResponse("Method Not Allowed", 405);
      }

      if (pathname === PROXY_PATH) {
        if (request.method === "GET") {
          return htmlResponse(renderProxyPage());
        }

        if (request.method === "POST") {
          return await handleProxyCreate(request, env, url);
        }

        return textResponse("Method Not Allowed", 405);
      }

      if (pathname === "/api/list") {
        return await handleList(env);
      }

      if (pathname.startsWith("/api/video/")) {
        const slug = pathname.slice("/api/video/".length).replace(/\.mp4$/i, "");
        return await handleApiVideo(env, slug);
      }

      const orderMatch = pathname.match(/^\/(\d+)\/([^/]+)\.mp4$/i);
      if (orderMatch) {
        const uploadOrder = orderMatch[1];
        const slug = orderMatch[2];
        return await serveVideoByOrderAndSlug(uploadOrder, slug, request, env);
      }

      if (pathname.endsWith(".mp4")) {
        const slug = pathname.slice(1, -4);
        return await serveVideoBySlug(slug, request, env);
      }

      const slug = pathname.replace(/^\/+/, "");
      if (slug) {
        return await serveVideoBySlug(slug, request, env);
      }

      return textResponse("Not Found", 404);
    } catch (err) {
      return textResponse(`Error: ${err?.message || String(err)}`, 500);
    }
  },
};

async function handleUpload(request, env, url) {
  const form = await request.formData();

  const title = clean(form.get("title"));
  const file = form.get("file");

  if (!title) {
    return htmlResponse(
      renderResult({
        title: "Upload gagal",
        message: "Judul wajib diisi.",
        color: "red",
      }),
      400
    );
  }

  if (!(file instanceof File) || file.size <= 0) {
    return htmlResponse(
      renderResult({
        title: "Upload gagal",
        message: "File video wajib dipilih.",
        color: "red",
      }),
      400
    );
  }

  const visitorId = DEFAULT_VISITOR_ID;
  const upload = await uploadToVidey(file, visitorId);

  if (!upload.ok) {
    return htmlResponse(
      renderResult({
        title: "Upload gagal",
        message: "Videy tidak mengembalikan ID video yang valid. Tidak ada data yang disimpan ke KV.",
        data: {
          status: upload.status,
          contentType: upload.contentType,
          location: upload.location,
          rawJson: upload.rawJson,
          rawText: upload.rawText,
        },
        color: "red",
      }),
      502
    );
  }

  const uploadOrder = await nextUploadOrder(env);
  const slug = await uniqueSlug(env, slugify(title));

  const record = {
    title,
    slug,
    uploadOrder,
    mode: "videy",
    videyId: upload.videyId,
    visitorId,
    createdAt: new Date().toISOString(),
  };

  await env.VIDEY_KV.put(`${VIDEO_PREFIX}${slug}`, JSON.stringify(record));
  await env.VIDEY_KV.put(`${ORDER_PREFIX}${uploadOrder}`, JSON.stringify(record));

  const publicUrl = `${url.origin}/${uploadOrder}/${slug}.mp4`;
  const legacyUrl = `${url.origin}/${slug}.mp4`;
  const apiUrl = `${url.origin}/api/video/${slug}`;

  return htmlResponse(
    renderResult({
      title: "Upload sukses",
      message: "ID asli Videy berhasil disimpan ke KV.",
      data: {
        publicUrl,
        legacyUrl,
        apiUrl,
        slug,
        uploadOrder,
        videyId: upload.videyId,
        visitorId,
      },
      color: "green",
    })
  );
}

async function handleProxyCreate(request, env, url) {
  const form = await request.formData();

  const title = clean(form.get("title"));
  const sourceUrl = clean(form.get("sourceUrl") || form.get("url"));
  const slugInput = clean(form.get("slug"));

  if (!title) {
    return htmlResponse(
      renderResult({
        title: "Proxy gagal",
        message: "Judul wajib diisi.",
        color: "red",
      }),
      400
    );
  }

  if (!sourceUrl || !isValidHttpUrl(sourceUrl)) {
    return htmlResponse(
      renderResult({
        title: "Proxy gagal",
        message: "Source URL tidak valid.",
        color: "red",
      }),
      400
    );
  }

  const uploadOrder = await nextUploadOrder(env);
  const slug = await uniqueSlug(env, slugInput || slugify(title));

  const record = {
    title,
    slug,
    uploadOrder,
    mode: "proxy",
    sourceUrl,
    createdAt: new Date().toISOString(),
  };

  await env.VIDEY_KV.put(`${VIDEO_PREFIX}${slug}`, JSON.stringify(record));
  await env.VIDEY_KV.put(`${ORDER_PREFIX}${uploadOrder}`, JSON.stringify(record));

  const publicUrl = `${url.origin}/${uploadOrder}/${slug}.mp4`;
  const apiUrl = `${url.origin}/api/video/${slug}`;

  return htmlResponse(
    renderResult({
      title: "Proxy sukses",
      message: "Link sumber sudah dipasangkan ke worker.",
      data: {
        publicUrl,
        apiUrl,
        slug,
        uploadOrder,
        sourceUrl,
      },
      color: "green",
    })
  );
}

async function uploadToVidey(file, visitorId) {
  const uploadUrl = DEFAULT_UPLOAD_URL;

  const headers = {
    "User-Agent": "Mozilla/5.0",
    Accept: "application/json",
  };

  const formData = new FormData();
  formData.append("file", file, file.name || "video.mp4");

  const resp = await fetch(`${uploadUrl}?visitorId=${encodeURIComponent(visitorId)}`, {
    method: "POST",
    headers,
    body: formData,
    redirect: "follow",
  });

  const contentType = resp.headers.get("content-type") || "";
  const location = resp.headers.get("location") || "";

  let rawText = "";
  let rawJson = null;

  if (contentType.includes("application/json")) {
    try {
      rawJson = await resp.json();
    } catch {
      rawJson = null;
    }
  } else {
    try {
      rawText = await resp.text();
    } catch {
      rawText = "";
    }
  }

  const videyId =
    extractIdFromJson(rawJson) ||
    extractIdFromText(rawText) ||
    extractIdFromText(JSON.stringify(rawJson || {})) ||
    extractIdFromText(location) ||
    null;

  return {
    ok: Boolean(videyId),
    videyId,
    status: resp.status,
    contentType,
    location,
    rawJson,
    rawText: rawText ? rawText.slice(0, 4000) : "",
  };
}

async function serveVideoByOrderAndSlug(uploadOrder, slug, request, env) {
  const rawOrder = await env.VIDEY_KV.get(`${ORDER_PREFIX}${uploadOrder}`);
  if (!rawOrder) return textResponse("Video tidak ditemukan", 404);

  let meta;
  try {
    meta = JSON.parse(rawOrder);
  } catch {
    return textResponse("Data KV rusak", 500);
  }

  if (meta.slug && meta.slug !== slug) {
    return textResponse("Video tidak ditemukan", 404);
  }

  return await serveVideoFromRecord(meta, slug, request);
}

async function serveVideoBySlug(slug, request, env) {
  const raw = await env.VIDEY_KV.get(`${VIDEO_PREFIX}${slug}`);
  if (!raw) return textResponse("Video tidak ditemukan", 404);

  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    return textResponse("Data KV rusak", 500);
  }

  return await serveVideoFromRecord(meta, slug, request);
}

async function serveVideoFromRecord(meta, slug, request) {
  if (!meta) return textResponse("Video tidak ditemukan", 404);

  if (meta.mode === "proxy" && meta.sourceUrl) {
    return await proxyRemoteVideo(meta.sourceUrl, slug, meta, request);
  }

  if (!meta?.videyId) return textResponse("videyId kosong", 500);

  const upstreamUrl = `${CDN_BASE}/${encodeURIComponent(meta.videyId)}.mp4`;
  return await proxyRemoteVideo(upstreamUrl, slug, meta, request);
}

async function proxyRemoteVideo(upstreamUrl, slug, meta, request) {
  const upstreamHeaders = new Headers();
  copyHeader(request.headers, upstreamHeaders, "Range");
  copyHeader(request.headers, upstreamHeaders, "If-Range");
  copyHeader(request.headers, upstreamHeaders, "Accept");
  copyHeader(request.headers, upstreamHeaders, "User-Agent");
  copyHeader(request.headers, upstreamHeaders, "Origin");
  copyHeader(request.headers, upstreamHeaders, "Referer");

  const upstreamResp = await fetch(upstreamUrl, {
    method: "GET",
    headers: upstreamHeaders,
    redirect: "follow",
  });

  const headers = new Headers(upstreamResp.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set("X-Video-Slug", slug);
  headers.set("X-Video-Title", meta?.title || slug);
  headers.set("X-Upload-Order", String(meta?.uploadOrder || ""));
  headers.set("X-Proxy-Mode", meta?.mode === "proxy" ? "source" : "videy");

  if (!headers.get("Content-Type")) {
    headers.set("Content-Type", "video/mp4");
  }

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers,
  });
}

async function handleApiVideo(env, slug) {
  const raw = await env.VIDEY_KV.get(`${VIDEO_PREFIX}${slug}`);
  if (!raw) return jsonResponse({ ok: false, error: "not_found" }, 404);

  try {
    return jsonResponse({ ok: true, data: JSON.parse(raw) });
  } catch {
    return jsonResponse({ ok: false, error: "bad_data" }, 500);
  }
}

async function handleList(env) {
  const out = [];
  const result = await env.VIDEY_KV.list({ prefix: VIDEO_PREFIX, limit: 1000 });

  for (const key of result.keys) {
    const raw = await env.VIDEY_KV.get(key.name);
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      continue;
    }
  }

  out.sort((a, b) => {
    const ao = Number(a.uploadOrder || 0);
    const bo = Number(b.uploadOrder || 0);
    if (ao !== bo) return bo - ao;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });

  return jsonResponse({ ok: true, items: out });
}

async function nextUploadOrder(env) {
  const result = await env.VIDEY_KV.list({ prefix: VIDEO_PREFIX, limit: 50000 });
  let max = 0;

  for (const key of result.keys) {
    const raw = await env.VIDEY_KV.get(key.name);
    if (!raw) continue;

    try {
      const data = JSON.parse(raw);
      const n = Number(data?.uploadOrder || 0);
      if (n > max) max = n;
    } catch {
      continue;
    }
  }

  return max + 1;
}

async function uniqueSlug(env, base) {
  const root = base || `video-${Date.now()}`;
  let slug = root;
  let i = 0;

  while (await env.VIDEY_KV.get(`${VIDEO_PREFIX}${slug}`)) {
    i += 1;
    slug = `${root}-${i}`;
  }

  return slug;
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || `video-${Date.now()}`;
}

function clean(v) {
  return String(v ?? "").trim();
}

function isValidHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function extractIdFromJson(data) {
  if (!data || typeof data !== "object") return null;

  const candidates = [
    data.id,
    data.videoId,
    data.fileId,
    data.videyId,
    data.data?.id,
    data.data?.videoId,
    data.data?.fileId,
    data.data?.videyId,
    data.result?.id,
    data.result?.videoId,
    data.result?.fileId,
    data.result?.videyId,
    data.response?.id,
    data.response?.videoId,
    data.response?.fileId,
    data.response?.videyId,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }

  return null;
}

function extractIdFromText(text) {
  if (!text) return null;

  const s = String(text);

  const patterns = [
    /"id"\s*:\s*"([^"]+)"/i,
    /'id'\s*:\s*'([^']+)'/i,
    /"videoId"\s*:\s*"([^"]+)"/i,
    /'videoId'\s*:\s*'([^']+)'/i,
    /"fileId"\s*:\s*"([^"]+)"/i,
    /'fileId'\s*:\s*'([^']+)'/i,
    /"videyId"\s*:\s*"([^"]+)"/i,
    /'videyId'\s*:\s*'([^']+)'/i,
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m?.[1]) return m[1];
  }

  const fallback = s.match(/\b([A-Za-z0-9_-]{5,})\b/);
  return fallback ? fallback[1] : null;
}

function copyHeader(src, dst, name) {
  const val = src.get(name);
  if (val) dst.set(name, val);
}

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHome(url) {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MyBlobVidey</title>
  <style>
    :root{
      --bg:#07070c;
      --fg:#edf2ff;
      --muted:#9aa7c7;
      --line:#23304f;
      --accent:#a855f7;
      --accent2:#22d3ee;
      --danger:#ff4d6d;
    }
    body{
      margin:0;
      min-height:100vh;
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
      background:
        radial-gradient(circle at 20% 20%, rgba(168,85,247,.18), transparent 22%),
        radial-gradient(circle at 80% 10%, rgba(34,211,238,.14), transparent 18%),
        radial-gradient(circle at 50% 80%, rgba(255,77,109,.12), transparent 24%),
        linear-gradient(180deg, #05050a 0%, #090912 100%);
      color:var(--fg);
    }
    .wrap{
      max-width:920px;
      margin:0 auto;
      padding:32px 16px 52px;
    }
    .panel{
      border:1px solid rgba(255,255,255,.09);
      background:rgba(255,255,255,.04);
      box-shadow:0 20px 60px rgba(0,0,0,.45);
      border-radius:24px;
      overflow:hidden;
    }
    .top{
      padding:22px 22px 18px;
      border-bottom:1px solid rgba(255,255,255,.08);
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
      flex-wrap:wrap;
    }
    .title{
      font-size:30px;
      letter-spacing:.4px;
      margin:0;
    }
    .sub{
      margin:4px 0 0;
      color:var(--muted);
      font-size:14px;
    }
    .body{
      padding:22px;
      display:grid;
      gap:16px;
    }
    .card{
      border:1px solid rgba(255,255,255,.08);
      background:rgba(0,0,0,.18);
      border-radius:18px;
      padding:16px;
    }
    a{
      color:#7dd3fc;
      text-decoration:none;
    }
    code{
      display:inline-block;
      background:rgba(255,255,255,.07);
      border:1px solid rgba(255,255,255,.09);
      padding:2px 7px;
      border-radius:8px;
      color:#e9d5ff;
      word-break:break-all;
    }
    .grid{
      display:grid;
      grid-template-columns:repeat(2,minmax(0,1fr));
      gap:12px;
    }
    .pill{
      display:inline-flex;
      align-items:center;
      gap:8px;
      border:1px solid rgba(255,255,255,.11);
      padding:8px 12px;
      border-radius:999px;
      background:rgba(255,255,255,.04);
      color:var(--fg);
      width:fit-content;
    }
    .ghost{
      color:var(--muted);
    }
    .blink{
      animation:blink 1.1s steps(2,end) infinite;
    }
    @keyframes blink{50%{opacity:.35}}
    @media (max-width:700px){
      .grid{grid-template-columns:1fr}
      .title{font-size:24px}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="panel">
      <div class="top">
        <div>
          <h1 class="title">MyBlobVidey</h1>
          <p class="sub">minimal proxy, order URL, dan mode sumber langsung.</p>
        </div>
        <div class="pill">status <span class="blink">▣</span> alive</div>
      </div>

      <div class="body">
        <div class="card">
          <div class="grid">
            <div>
              <div class="ghost">Upload</div>
              <div><a href="/api/upload">/api/upload</a></div>
            </div>
            <div>
              <div class="ghost">Proxy Source</div>
              <div><a href="/api/proxy">/api/proxy</a></div>
            </div>
            <div>
              <div class="ghost">List</div>
              <div><a href="/api/list">/api/list</a></div>
            </div>
            <div>
              <div class="ghost">Contoh URL</div>
              <div><code>${escapeHtml(url.origin)}/1/jua.mp4</code></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="ghost">Pola upload</div>
          <div><code>${escapeHtml(url.origin)}/$uploadorder/$judul.mp4</code></div>
        </div>

        <div class="card">
          <div class="ghost">Pola proxy tanpa upload Videy</div>
          <div><code>Moonlight.co/jua.mp4</code> → <code>${escapeHtml(url.origin)}/$uploadorder/$judul.mp4</code></div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function renderUploadPage() {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Upload Videy</title>
  <style>
    :root{
      --bg:#05050a;
      --fg:#e5ecff;
      --muted:#8b95b5;
      --card:rgba(255,255,255,.05);
      --line:rgba(255,255,255,.12);
      --accent:#8b5cf6;
      --accent2:#22d3ee;
      --danger:#ff4d6d;
      --ok:#34d399;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      min-height:100vh;
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
      color:var(--fg);
      background:
        radial-gradient(circle at 18% 18%, rgba(139,92,246,.22), transparent 18%),
        radial-gradient(circle at 82% 8%, rgba(34,211,238,.16), transparent 16%),
        radial-gradient(circle at 50% 88%, rgba(255,77,109,.15), transparent 22%),
        linear-gradient(180deg, #05050a 0%, #090912 100%);
      overflow-x:hidden;
    }
    .wrap{
      max-width:780px;
      margin:0 auto;
      padding:28px 16px 60px;
    }
    .panel{
      border:1px solid var(--line);
      background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03));
      border-radius:28px;
      box-shadow:0 24px 80px rgba(0,0,0,.5);
      overflow:hidden;
      position:relative;
    }
    .panel::before,
    .panel::after{
      content:"";
      position:absolute;
      inset:auto;
      width:160px;
      height:160px;
      border-radius:999px;
      filter:blur(28px);
      opacity:.45;
      pointer-events:none;
      animation:floaty 6s ease-in-out infinite;
    }
    .panel::before{
      top:-40px;
      right:-40px;
      background:rgba(34,211,238,.22);
    }
    .panel::after{
      bottom:-60px;
      left:-40px;
      background:rgba(139,92,246,.26);
      animation-delay:-2s;
    }
    @keyframes floaty{
      0%,100%{transform:translate3d(0,0,0) rotate(0deg)}
      50%{transform:translate3d(10px,-8px,0) rotate(12deg)}
    }
    .head{
      padding:22px 22px 18px;
      border-bottom:1px solid var(--line);
      display:flex;
      justify-content:space-between;
      gap:12px;
      flex-wrap:wrap;
      align-items:center;
    }
    .title{
      margin:0;
      font-size:30px;
      letter-spacing:.4px;
    }
    .subtitle{
      margin:4px 0 0;
      color:var(--muted);
      font-size:14px;
    }
    .glitch{
      position:relative;
      color:#fff;
      font-weight:700;
      letter-spacing:.3px;
      text-transform:uppercase;
      font-size:12px;
      padding:9px 12px;
      border-radius:999px;
      border:1px solid rgba(255,255,255,.12);
      background:rgba(255,255,255,.05);
      overflow:hidden;
    }
    .glitch::before,
    .glitch::after{
      content:"upload mode";
      position:absolute;
      inset:0;
      display:grid;
      place-items:center;
      mix-blend-mode:screen;
      opacity:.7;
      pointer-events:none;
    }
    .glitch::before{
      color:var(--accent2);
      transform:translate(2px,0);
      clip-path:inset(0 0 55% 0);
      animation:gl1 1.8s infinite linear alternate-reverse;
    }
    .glitch::after{
      color:var(--accent);
      transform:translate(-2px,0);
      clip-path:inset(45% 0 0 0);
      animation:gl2 1.5s infinite linear alternate-reverse;
    }
    @keyframes gl1{
      0%{transform:translate(2px,0) skewX(0deg)}
      100%{transform:translate(4px,-1px) skewX(6deg)}
    }
    @keyframes gl2{
      0%{transform:translate(-2px,0) skewX(0deg)}
      100%{transform:translate(-5px,1px) skewX(-6deg)}
    }
    .body{
      padding:22px;
      display:grid;
      gap:16px;
    }
    .box{
      border:1px solid var(--line);
      background:var(--card);
      border-radius:22px;
      padding:16px;
    }
    label{
      display:block;
      margin:12px 0 7px;
      color:#dbe6ff;
      font-size:14px;
    }
    input, button{
      width:100%;
      padding:12px 14px;
      border-radius:14px;
      border:1px solid rgba(255,255,255,.14);
      background:rgba(0,0,0,.2);
      color:var(--fg);
      font:inherit;
      outline:none;
    }
    input:focus{
      border-color:rgba(34,211,238,.6);
      box-shadow:0 0 0 3px rgba(34,211,238,.12);
    }
    button{
      cursor:pointer;
      margin-top:14px;
      background:linear-gradient(135deg, rgba(139,92,246,.96), rgba(34,211,238,.96));
      border:none;
      font-weight:700;
      letter-spacing:.2px;
      position:relative;
      overflow:hidden;
    }
    button::after{
      content:"";
      position:absolute;
      inset:0;
      background:linear-gradient(90deg, transparent, rgba(255,255,255,.28), transparent);
      transform:translateX(-100%);
      animation:scan 2.2s linear infinite;
    }
    @keyframes scan{
      0%{transform:translateX(-100%)}
      100%{transform:translateX(100%)}
    }
    .hint{
      color:var(--muted);
      font-size:13px;
      line-height:1.5;
    }
    .loaderWrap{
      display:none;
      margin-top:16px;
      border:1px solid var(--line);
      background:rgba(0,0,0,.26);
      border-radius:20px;
      padding:14px;
      overflow:hidden;
    }
    .loaderWrap.show{display:block}
    .loaderTitle{
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:12px;
      font-size:13px;
      margin-bottom:10px;
      color:#dbe6ff;
    }
    .loaderBar{
      position:relative;
      height:12px;
      border-radius:999px;
      background:rgba(255,255,255,.08);
      overflow:hidden;
      border:1px solid rgba(255,255,255,.08);
    }
    .loaderBar > span{
      position:absolute;
      inset:0;
      width:0%;
      background:linear-gradient(90deg, #ff4d6d, #a855f7, #22d3ee, #34d399);
      border-radius:999px;
      transition:width .14s linear;
    }
    .orbits{
      display:flex;
      gap:8px;
      margin-top:12px;
      align-items:center;
    }
    .orb{
      width:10px;
      height:10px;
      border-radius:999px;
      background:var(--accent2);
      box-shadow:0 0 18px rgba(34,211,238,.7);
      animation:orb 1s infinite ease-in-out;
    }
    .orb:nth-child(2){animation-delay:.15s;background:var(--accent);box-shadow:0 0 18px rgba(139,92,246,.7)}
    .orb:nth-child(3){animation-delay:.3s;background:#ff4d6d;box-shadow:0 0 18px rgba(255,77,109,.7)}
    .orb:nth-child(4){animation-delay:.45s;background:#34d399;box-shadow:0 0 18px rgba(52,211,153,.7)}
    @keyframes orb{
      0%,100%{transform:translateY(0) scale(1)}
      50%{transform:translateY(-6px) scale(1.18)}
    }
    .status{
      margin-top:10px;
      font-size:13px;
      color:var(--muted);
      min-height:18px;
    }
    .status strong{color:#fff}
    .micro{
      display:flex;
      justify-content:space-between;
      gap:10px;
      margin-top:10px;
      color:var(--muted);
      font-size:12px;
      flex-wrap:wrap;
    }
    .danger{
      color:#fecdd3;
    }
    .footerGlow{
      margin-top:10px;
      color:#c4b5fd;
      font-size:12px;
      opacity:.9;
    }
    @media (max-width:700px){
      .title{font-size:24px}
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="panel">
      <div class="head">
        <div>
          <h1 class="title">Uploader</h1>
          <p class="subtitle">judul + file saja. loading aneh, hidup, dan sedikit galak.</p>
        </div>
        <div class="glitch">loading ritual</div>
      </div>

      <div class="body">
        <div class="box">
          <form id="uploadForm" method="POST" enctype="multipart/form-data">
            <label>Judul</label>
            <input name="title" required placeholder="contoh: kucing-lucu">

            <label>File video</label>
            <input type="file" name="file" accept="video/*" required>

            <button id="submitBtn" type="submit">Upload</button>
          </form>

          <div id="loaderWrap" class="loaderWrap">
            <div class="loaderTitle">
              <span id="loaderLabel">mengurai multipart</span>
              <span id="percentLabel">0%</span>
            </div>
            <div class="loaderBar"><span id="loaderBarFill"></span></div>
            <div class="orbits">
              <div class="orb"></div>
              <div class="orb"></div>
              <div class="orb"></div>
              <div class="orb"></div>
            </div>
            <div id="statusText" class="status"><strong>menunggu</strong> untuk melompat ke server</div>
            <div class="micro">
              <span>local send</span>
              <span>worker relay</span>
              <span>videy gate</span>
              <span>kv seal</span>
            </div>
            <div class="footerGlow">jika terasa aneh, itu memang sengaja.</div>
          </div>
        </div>

        <div class="hint">
          Field upload hanya <code>title</code> dan <code>file</code>. URL publik mengikuti pola
          <code>/$uploadorder/$judul.mp4</code>. Ada juga mode proxy sumber langsung lewat <code>/api/proxy</code>.
        </div>
      </div>
    </div>
  </div>

  <script>
    const form = document.getElementById("uploadForm");
    const btn = document.getElementById("submitBtn");
    const loaderWrap = document.getElementById("loaderWrap");
    const bar = document.getElementById("loaderBarFill");
    const percentLabel = document.getElementById("percentLabel");
    const statusText = document.getElementById("statusText");
    const loaderLabel = document.getElementById("loaderLabel");

    let fakeProgress = 0;
    let timer = null;

    const states = [
      "mengikat boundary",
      "mencari folder bayangan",
      "menabur header",
      "melepas file ke kabut",
      "menunggu suara dari videy",
      "menjalin order",
      "menutup segel kv",
    ];

    function setProgress(p) {
      fakeProgress = Math.max(0, Math.min(100, p));
      bar.style.width = fakeProgress + "%";
      percentLabel.textContent = fakeProgress + "%";
      loaderLabel.textContent = states[Math.min(states.length - 1, Math.floor((fakeProgress / 100) * states.length))] || "mengalir";
    }

    function startGlitchLoader() {
      loaderWrap.classList.add("show");
      let idx = 0;
      timer = setInterval(() => {
        idx = (idx + 1) % states.length;
        statusText.innerHTML = "<strong>" + states[idx] + "</strong>";
        if (fakeProgress < 93) {
          setProgress(fakeProgress + (fakeProgress < 40 ? 3 : fakeProgress < 75 ? 2 : 1));
        }
      }, 250);
    }

    function stopGlitchLoader() {
      if (timer) clearInterval(timer);
      timer = null;
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();

      const xhr = new XMLHttpRequest();
      xhr.open("POST", location.pathname, true);

      const fd = new FormData(form);

      btn.disabled = true;
      btn.textContent = "mengirim...";
      startGlitchLoader();
      setProgress(2);

      xhr.upload.onprogress = function (ev) {
        if (ev.lengthComputable) {
          const p = Math.max(1, Math.floor((ev.loaded / ev.total) * 82));
          setProgress(p);
          statusText.innerHTML = "<strong>mengirim</strong> " + ev.loaded + " / " + ev.total + " byte";
        } else {
          setProgress(Math.min(82, fakeProgress + 1));
        }
      };

      xhr.onreadystatechange = function () {
        if (xhr.readyState === 2) {
          setProgress(88);
          statusText.innerHTML = "<strong>server</strong> menerima paket";
        }
        if (xhr.readyState === 3) {
          setProgress(94);
          statusText.innerHTML = "<strong>server</strong> sedang memahat jawaban";
        }
        if (xhr.readyState === 4) {
          stopGlitchLoader();
          setProgress(100);
          btn.disabled = false;
          btn.textContent = "Upload";

          if (xhr.status >= 200 && xhr.status < 300) {
            document.open();
            document.write(xhr.responseText);
            document.close();
            return;
          }

          statusText.innerHTML = '<strong class="danger">gagal</strong> ' + xhr.status;
          loaderLabel.textContent = "error rune";
          btn.disabled = false;
          btn.textContent = "Upload";
        }
      };

      xhr.send(fd);
    });
  </script>
</body>
</html>`;
}

function renderProxyPage() {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proxy Source</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.5}
    .box{border:1px solid #ddd;border-radius:12px;padding:16px}
    label{display:block;margin:12px 0 6px}
    input,button{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:10px;font:inherit}
    button{cursor:pointer;background:#111;color:#fff;border:none;margin-top:14px}
    small{color:#666}
  </style>
</head>
<body>
  <h1>Proxy Source</h1>
  <div class="box">
    <form method="POST" enctype="multipart/form-data">
      <label>Judul</label>
      <input name="title" required placeholder="contoh: jua">

      <label>Source URL</label>
      <input name="sourceUrl" required placeholder="https://Moonlight.co/jua.mp4">

      <label>Slug custom (opsional)</label>
      <input name="slug" placeholder="jua">

      <button type="submit">Simpan Proxy</button>
    </form>
  </div>
  <p><small>Mode ini tidak upload ke Videy. Worker hanya menyimpan URL sumber dan mem-proxy langsung.</small></p>
</body>
</html>`;
}

function renderResult({ title, message, data = null, color = "black" }) {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root{
      --bg:#05050a;
      --fg:#e5ecff;
      --line:rgba(255,255,255,.12);
    }
    body{
      margin:0;
      min-height:100vh;
      font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
      color:var(--fg);
      background:
        radial-gradient(circle at 20% 20%, rgba(139,92,246,.18), transparent 18%),
        radial-gradient(circle at 80% 10%, rgba(34,211,238,.14), transparent 16%),
        linear-gradient(180deg, #05050a 0%, #090912 100%);
    }
    .wrap{max-width:780px;margin:0 auto;padding:36px 16px 52px}
    .box{
      border:1px solid var(--line);
      border-radius:22px;
      padding:18px;
      background:rgba(255,255,255,.05);
      box-shadow:0 24px 70px rgba(0,0,0,.45);
    }
    pre{
      white-space:pre-wrap;
      background:rgba(0,0,0,.26);
      border:1px solid rgba(255,255,255,.08);
      padding:12px;
      border-radius:16px;
      overflow:auto;
      color:#dbeafe;
    }
    a{color:#7dd3fc;text-decoration:none}
    code{
      background:rgba(255,255,255,.07);
      border:1px solid rgba(255,255,255,.08);
      padding:2px 6px;
      border-radius:8px;
      color:#e9d5ff;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1 style="color:${color}">${escapeHtml(title)}</h1>
    <div class="box">
      <p>${escapeHtml(message)}</p>
      ${data ? `<pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>` : ""}
      <p><a href="/api/upload">Kembali</a> | <a href="/">Beranda</a> | <a href="/api/proxy">Proxy mode</a></p>
    </div>
  </div>
</body>
</html>`;
}
