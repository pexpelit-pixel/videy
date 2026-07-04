// Cloudflare Worker - minimal upload page + KV mapping + Videy CDN proxy
// Bind KV: VIDEY_KV
// Optional env:
// - VIDEY_UPLOAD_URL = endpoint upload Videy kalau kamu punya API upload-nya
// - VIDEY_UPLOAD_FIELD = nama field file, default: "file"

const UPLOAD_PATH = "/api/upload";
const API_PREFIX = "/api/";
const VIDEO_PREFIX = "video:";
const DEFAULT_UPLOAD_FIELD = "file";
const CDN_BASE = "https://cdn.videy.co";

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      if (pathname === "/") {
        return htmlResponse(renderHomePage(url, env));
      }

      if (pathname === UPLOAD_PATH) {
        if (request.method === "GET") {
          return htmlResponse(renderUploadPage(url));
        }

        if (request.method === "POST") {
          return await handleUpload(request, env, url);
        }

        return textResponse("Method Not Allowed", 405);
      }

      if (pathname.startsWith(API_PREFIX)) {
        return await handleApi(request, env, url);
      }

      if (pathname.endsWith(".mp4")) {
        const slug = pathname.slice(1, -4); // /judul.mp4 -> judul
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

async function handleApi(request, env, url) {
  const pathname = url.pathname;

  if (pathname.startsWith("/api/video/")) {
    const slug = pathname.replace("/api/video/", "").replace(/\.mp4$/, "");
    const key = `${VIDEO_PREFIX}${slug}`;
    const raw = await env.VIDEY_KV.get(key);
    if (!raw) return jsonResponse({ ok: false, error: "not_found" }, 404);

    return jsonResponse({ ok: true, data: JSON.parse(raw) });
  }

  if (pathname === "/api/list") {
    const items = await listVideos(env, 50);
    return jsonResponse({ ok: true, items });
  }

  return jsonResponse({ ok: false, error: "not_found" }, 404);
}

async function handleUpload(request, env, url) {
  const form = await request.formData();

  const title = normalizeTitle(form.get("title"));
  const visitorId = normalizeTitle(form.get("visitorId")) || url.searchParams.get("visitorId") || crypto.randomUUID();
  const customSlug = normalizeTitle(form.get("slug"));
  const uploadedFile = form.get("video");
  const videyIdFromForm = normalizeTitle(form.get("videyId"));

  if (!title) {
    return htmlResponse(renderResultPage({
      ok: false,
      title: "Upload gagal",
      message: "Judul wajib diisi.",
      color: "red",
    }), 400);
  }

  let videyId = videyIdFromForm;

  if (!videyId && uploadedFile instanceof File && uploadedFile.size > 0) {
    const uploadUrl = env.VIDEY_UPLOAD_URL;
    if (!uploadUrl) {
      return htmlResponse(renderResultPage({
        ok: false,
        title: "Upload gagal",
        message: "VIDEY_UPLOAD_URL belum diatur. Isi videyId manual atau set endpoint upload Videy.",
        color: "red",
      }), 400);
    }

    videyId = await uploadToVidey(uploadedFile, title, env);
    if (!videyId) {
      return htmlResponse(renderResultPage({
        ok: false,
        title: "Upload gagal",
        message: "Worker tidak berhasil mendapatkan ID dari response upload Videy.",
        color: "red",
      }), 500);
    }
  }

  if (!videyId) {
    return htmlResponse(renderResultPage({
      ok: false,
      title: "Upload gagal",
      message: "Isi videyId manual atau unggah file jika VIDEY_UPLOAD_URL sudah dipasang.",
      color: "red",
    }), 400);
  }

  const baseSlug = customSlug || slugify(title);
  const slug = await ensureUniqueSlug(env, baseSlug);

  const record = {
    title,
    slug,
    visitorId,
    videyId,
    createdAt: new Date().toISOString(),
  };

  await env.VIDEY_KV.put(`${VIDEO_PREFIX}${slug}`, JSON.stringify(record));

  const publicUrl = `${url.origin}/${slug}.mp4`;
  const apiUrl = `${url.origin}/api/video/${slug}`;

  return htmlResponse(renderResultPage({
    ok: true,
    title: "Upload sukses",
    message: "Judul sudah disimpan di KV dan link publik sudah siap.",
    data: {
      publicUrl,
      apiUrl,
      slug,
      videyId,
      visitorId,
    },
    color: "green",
  }));
}

async function serveVideoBySlug(slug, request, env) {
  const key = `${VIDEO_PREFIX}${slug}`;
  const raw = await env.VIDEY_KV.get(key);

  if (!raw) {
    return textResponse("Video tidak ditemukan", 404);
  }

  const meta = JSON.parse(raw);
  const videyId = meta.videyId;

  if (!videyId) {
    return textResponse("Mapping video rusak: videyId kosong", 500);
  }

  const upstreamUrl = `${CDN_BASE}/${encodeURIComponent(videyId)}.mp4`;
  const upstreamHeaders = new Headers();

  const range = request.headers.get("Range");
  if (range) upstreamHeaders.set("Range", range);

  const ifRange = request.headers.get("If-Range");
  if (ifRange) upstreamHeaders.set("If-Range", ifRange);

  const accept = request.headers.get("Accept");
  if (accept) upstreamHeaders.set("Accept", accept);

  const userAgent = request.headers.get("User-Agent");
  if (userAgent) upstreamHeaders.set("User-Agent", userAgent);

  const fetchResp = await fetch(upstreamUrl, {
    method: "GET",
    headers: upstreamHeaders,
    redirect: "follow",
  });

  const headers = new Headers(fetchResp.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cache-Control", "public, max-age=3600");
  headers.set("X-Video-Slug", slug);
  headers.set("X-Video-Title", meta.title || slug);

  if (!headers.get("Content-Type")) {
    headers.set("Content-Type", "video/mp4");
  }

  return new Response(fetchResp.body, {
    status: fetchResp.status,
    statusText: fetchResp.statusText,
    headers,
  });
}

async function uploadToVidey(file, title, env) {
  const uploadUrl = env.VIDEY_UPLOAD_URL;
  const fieldName = env.VIDEY_UPLOAD_FIELD || DEFAULT_UPLOAD_FIELD;

  const fd = new FormData();
  fd.append(fieldName, file, file.name || `${slugify(title)}.mp4`);
  fd.append("title", title);

  const resp = await fetch(uploadUrl, {
    method: "POST",
    body: fd,
  });

  const contentType = resp.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const json = await resp.json().catch(() => null);
    if (!json) return null;

    return (
      json.id ||
      json.videoId ||
      json.fileId ||
      json.data?.id ||
      json.data?.videoId ||
      extractIdFromString(JSON.stringify(json))
    );
  }

  const text = await resp.text().catch(() => "");
  const id = extractIdFromString(text);
  if (id) return id;

  const location = resp.headers.get("location");
  if (location) {
    const locId = extractIdFromString(location);
    if (locId) return locId;
  }

  return null;
}

async function listVideos(env, limit = 50) {
  const out = [];
  const res = await env.VIDEY_KV.list({ prefix: VIDEO_PREFIX, limit });

  for (const item of res.keys) {
    const raw = await env.VIDEY_KV.get(item.name);
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // skip
    }
  }

  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return out;
}

async function ensureUniqueSlug(env, slug) {
  const base = slug || `video-${Date.now()}`;
  let current = base;
  let i = 0;

  while (await env.VIDEY_KV.get(`${VIDEO_PREFIX}${current}`)) {
    i += 1;
    current = `${base}-${i}`;
  }

  return current;
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

function extractIdFromString(text) {
  if (!text) return null;
  const m = String(text).match(/([A-Za-z0-9_-]{5,})/);
  return m ? m[1] : null;
}

function normalizeTitle(value) {
  return String(value || "").trim();
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

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHomePage(url, env) {
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MyBlobVidey</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:900px;margin:40px auto;padding:0 16px;line-height:1.5}
    a{color:#2563eb;text-decoration:none}
    .card{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
    code{background:#f4f4f5;padding:2px 6px;border-radius:6px}
    ul{padding-left:18px}
    small{color:#666}
  </style>
</head>
<body>
  <h1>MyBlobVidey</h1>
  <p>Minimal proxy + KV title mapper.</p>

  <div class="card">
    <div><a href="/api/upload?visitorId=${encodeURIComponent(url.searchParams.get("visitorId") || "")}">Buka upload</a></div>
    <div><a href="/api/list">Lihat daftar JSON</a></div>
  </div>

  <div class="card">
    <strong>Format link:</strong><br>
    <code>${escapeHtml(url.origin)}/judul-video.mp4</code>
  </div>

  <div class="card">
    <strong>Konfigurasi:</strong>
    <ul>
      <li>KV binding: <code>VIDEY_KV</code></li>
      <li>Optional: <code>VIDEY_UPLOAD_URL</code></li>
      <li>Optional: <code>VIDEY_UPLOAD_FIELD=file</code></li>
    </ul>
  </div>

  <small>Worker ini minimalis, polos, dan langsung jalan.</small>
</body>
</html>`;
}

function renderUploadPage(url) {
  const visitorId = url.searchParams.get("visitorId") || "";
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Upload Videy</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.5}
    label{display:block;margin:10px 0 6px}
    input,button{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:10px;font:inherit}
    button{cursor:pointer;background:#111;color:#fff;border:none;margin-top:14px}
    .box{border:1px solid #ddd;border-radius:12px;padding:16px}
    small{color:#666}
  </style>
</head>
<body>
  <h1>Upload</h1>
  <div class="box">
    <form method="POST" enctype="multipart/form-data">
      <label>Title</label>
      <input name="title" required placeholder="contoh: kucing-lucu">

      <label>Slug custom (opsional)</label>
      <input name="slug" placeholder="kucing-lucu">

      <label>Videy ID manual (opsional)</label>
      <input name="videyId" placeholder="A8sjKd92">

      <label>File video (opsional jika VIDEY_UPLOAD_URL sudah diatur)</label>
      <input type="file" name="video" accept="video/*">

      <input type="hidden" name="visitorId" value="${escapeHtml(visitorId)}">

      <button type="submit">Upload</button>
    </form>
  </div>
  <p><small>Kalau kamu belum punya endpoint upload Videy, isi <code>videyId</code> manual dulu.</small></p>
</body>
</html>`;
}

function renderResultPage({ ok, title, message, data = null, color = "black" }) {
  const dataHtml = data
    ? `<pre style="white-space:pre-wrap;background:#f6f6f6;border:1px solid #ddd;padding:12px;border-radius:12px;overflow:auto">${escapeHtml(
        JSON.stringify(data, null, 2)
      )}</pre>`
    : "";

  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.5}
    .box{border:1px solid #ddd;border-radius:12px;padding:16px}
    a{color:#2563eb;text-decoration:none}
    code{background:#f4f4f5;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <h1 style="color:${color}">${escapeHtml(title)}</h1>
  <div class="box">
    <p>${escapeHtml(message)}</p>
    ${dataHtml}
    <p><a href="/api/upload">Kembali</a> | <a href="/">Beranda</a></p>
  </div>
</body>
</html>`;
}
