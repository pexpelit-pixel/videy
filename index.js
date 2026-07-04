// index.js
const UPLOAD_PATH = "/api/upload";
const VIDEO_PREFIX = "video:";
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

      if (pathname === "/api/list") {
        return await handleList(env);
      }

      if (pathname.startsWith("/api/video/")) {
        const slug = pathname.slice("/api/video/".length).replace(/\.mp4$/i, "");
        return await handleApiVideo(env, slug);
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

  const slug = await uniqueSlug(env, slugify(title));
  const record = {
    title,
    slug,
    videyId: upload.videyId,
    visitorId,
    createdAt: new Date().toISOString(),
  };

  await env.VIDEY_KV.put(`${VIDEO_PREFIX}${slug}`, JSON.stringify(record));

  const publicUrl = `${url.origin}/${slug}.mp4`;
  const apiUrl = `${url.origin}/api/video/${slug}`;

  return htmlResponse(
    renderResult({
      title: "Upload sukses",
      message: "ID asli Videy berhasil disimpan ke KV.",
      data: {
        publicUrl,
        apiUrl,
        slug,
        videyId: upload.videyId,
        visitorId,
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

async function serveVideoBySlug(slug, request, env) {
  const raw = await env.VIDEY_KV.get(`${VIDEO_PREFIX}${slug}`);
  if (!raw) return textResponse("Video tidak ditemukan", 404);

  let meta;
  try {
    meta = JSON.parse(raw);
  } catch {
    return textResponse("Data KV rusak", 500);
  }

  if (!meta?.videyId) return textResponse("videyId kosong", 500);

  const upstreamUrl = `${CDN_BASE}/${encodeURIComponent(meta.videyId)}.mp4`;

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
  headers.set("X-Video-Title", meta.title || slug);

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
  const result = await env.VIDEY_KV.list({ prefix: VIDEO_PREFIX, limit: 100 });

  for (const key of result.keys) {
    const raw = await env.VIDEY_KV.get(key.name);
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      continue;
    }
  }

  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return jsonResponse({ ok: true, items: out });
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
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:820px;margin:40px auto;padding:0 16px;line-height:1.5}
    .box{border:1px solid #ddd;border-radius:12px;padding:16px}
    a{color:#2563eb;text-decoration:none}
    code{background:#f4f4f5;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <h1>MyBlobVidey</h1>
  <div class="box">
    <p><a href="/api/upload">Buka uploader</a></p>
    <p><a href="/api/list">Lihat JSON list</a></p>
    <p>Link publik: <code>${escapeHtml(url.origin)}/judul-video.mp4</code></p>
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
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.5}
    .box{border:1px solid #ddd;border-radius:12px;padding:16px}
    label{display:block;margin:12px 0 6px}
    input,button{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:10px;font:inherit}
    button{cursor:pointer;background:#111;color:#fff;border:none;margin-top:14px}
    small{color:#666}
  </style>
</head>
<body>
  <h1>Uploader</h1>
  <div class="box">
    <form method="POST" enctype="multipart/form-data">
      <label>Judul</label>
      <input name="title" required placeholder="contoh: kucing-lucu">

      <label>File video</label>
      <input type="file" name="file" accept="video/*" required>

      <button type="submit">Upload</button>
    </form>
  </div>
  <p><small>Field upload hanya <code>title</code> dan <code>file</code>. ID hanya diambil dari respons resmi Videy.</small></p>
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
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.5}
    .box{border:1px solid #ddd;border-radius:12px;padding:16px}
    pre{white-space:pre-wrap;background:#f6f6f6;border:1px solid #ddd;padding:12px;border-radius:12px;overflow:auto}
    a{color:#2563eb;text-decoration:none}
  </style>
</head>
<body>
  <h1 style="color:${color}">${escapeHtml(title)}</h1>
  <div class="box">
    <p>${escapeHtml(message)}</p>
    ${data ? `<pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>` : ""}
    <p><a href="/api/upload">Kembali</a> | <a href="/">Beranda</a></p>
  </div>
</body>
</html>`;
}
