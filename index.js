#!/usr/bin/env node
// index.js - Cloudflare Worker
// KV binding: VIDEY_KV
// Optional vars:
// VIDEY_UPLOAD_URL = "https://videy.co/api/upload"
// VIDEY_UPLOAD_FIELD = "file"
// VIDEY_VISITOR_ID = "1f5f718b-06b2-40f9-82da-0a73dfdadd1c"

const UPLOAD_PATH = "/api/upload";
const API_PREFIX = "/api/";
const VIDEO_PREFIX = "video:";
const CDN_BASE = "https://cdn.videy.co";
const DEFAULT_UPLOAD_URL = "https://videy.co/api/upload";
const DEFAULT_UPLOAD_FIELD = "file";
const DEFAULT_VISITOR_ID = "1f5f718b-06b2-40f9-82da-0a73dfdadd1c";

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
          return htmlResponse(renderUploadPage(url, env));
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
        const slug = pathname.replace("/api/video/", "").replace(/\.mp4$/, "");
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
  const slugInput = clean(form.get("slug"));
  const visitorIdInput = clean(form.get("visitorId"));
  const videyIdManual = clean(form.get("videyId"));
  const file = form.get("video");

  const visitorId = visitorIdInput || env.VIDEY_VISITOR_ID || DEFAULT_VISITOR_ID;

  if (!title) {
    return htmlResponse(renderResult({
      ok: false,
      title: "Upload gagal",
      message: "Judul wajib diisi.",
      color: "red",
    }), 400);
  }

  let videyId = videyIdManual;

  if (!videyId && file instanceof File && file.size > 0) {
    videyId = await uploadToVidey(file, env, visitorId, title);
  }

  if (!videyId) {
    return htmlResponse(renderResult({
      ok: false,
      title: "Upload gagal",
      message: "Isi videyId manual atau unggah file supaya Worker bisa meneruskan upload ke Videy.",
      color: "red",
    }), 400);
  }

  const baseSlug = slugInput || slugify(title);
  const slug = await uniqueSlug(env, baseSlug);

  const record = {
    title,
    slug,
    videyId,
    visitorId,
    createdAt: new Date().toISOString(),
  };

  await env.VIDEY_KV.put(`${VIDEO_PREFIX}${slug}`, JSON.stringify(record));

  const publicUrl = `${url.origin}/${slug}.mp4`;
  const apiUrl = `${url.origin}/api/video/${slug}`;

  return htmlResponse(renderResult({
    ok: true,
    title: "Upload sukses",
    message: "Judul sudah masuk KV, link publik siap dipakai.",
    data: { publicUrl, apiUrl, slug, videyId, visitorId },
    color: "green",
  }));
}

async function uploadToVidey(file, env, visitorId, title) {
  const uploadUrl = env.VIDEY_UPLOAD_URL || DEFAULT_UPLOAD_URL;
  const fieldName = env.VIDEY_UPLOAD_FIELD || DEFAULT_UPLOAD_FIELD;

  const mime = file.type || "application/octet-stream";

  const fd = new FormData();
  fd.append(fieldName, file, file.name || `${slugify(title)}.mp4`);
  fd.append("title", title);

  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 15; Termux) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://videy.co",
    "Referer": "https://videy.co/",
    "X-Requested-With": "XMLHttpRequest",
  };

  const resp = await fetch(`${uploadUrl}?visitorId=${encodeURIComponent(visitorId)}`, {
    method: "POST",
    headers,
    body: fd,
    redirect: "follow",
  });

  const ct = resp.headers.get("content-type") || "";
  let data = null;
  let text = "";

  if (ct.includes("application/json")) {
    try {
      data = await resp.json();
    } catch {
      data = null;
    }
  } else {
    try {
      text = await resp.text();
    } catch {
      text = "";
    }
  }

  const videyId =
    extractIdFromJson(data) ||
    extractIdFromText(text) ||
    extractIdFromText(JSON.stringify(data || {})) ||
    extractIdFromText(resp.headers.get("location") || "");

  return videyId;
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
  copyHeader(request.headers, upstreamHeaders, "Referer");
  copyHeader(request.headers, upstreamHeaders, "Origin");

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
  return jsonResponse({ ok: true, data: JSON.parse(raw) });
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
  let slug = base || `video-${Date.now()}`;
  let i = 0;

  while (await env.VIDEY_KV.get(`${VIDEO_PREFIX}${slug}`)) {
    i += 1;
    slug = `${base}-${i}`;
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
  return (
    data.id ||
    data.videoId ||
    data.fileId ||
    data.data?.id ||
    data.data?.videoId ||
    data.data?.fileId ||
    null
  );
}

function extractIdFromText(text) {
  if (!text) return null;
  const s = String(text);
  const m = s.match(/([A-Za-z0-9_-]{5,})/);
  return m ? m[1] : null;
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

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
    <p>Minimal proxy + KV mapper.</p>
    <p><a href="/api/upload?visitorId=${encodeURIComponent(url.searchParams.get("visitorId") || "")}">Buka uploader</a></p>
    <p><a href="/api/list">Lihat JSON list</a></p>
    <p>Link publik: <code>${escapeHtml(url.origin)}/judul-video.mp4</code></p>
  </div>
</body>
</html>`;
}

function renderUploadPage(url, env) {
  const visitorId = clean(url.searchParams.get("visitorId")) || env.VIDEY_VISITOR_ID || DEFAULT_VISITOR_ID;
  const uploadUrl = env.VIDEY_UPLOAD_URL || DEFAULT_UPLOAD_URL;

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
    code{background:#f4f4f5;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <h1>Uploader</h1>
  <div class="box">
    <form method="POST" enctype="multipart/form-data">
      <label>Judul</label>
      <input name="title" required placeholder="contoh: kucing-lucu">

      <label>Slug custom</label>
      <input name="slug" placeholder="kucing-lucu">

      <label>Videy ID manual</label>
      <input name="videyId" placeholder="A8sjKd92">

      <label>File video</label>
      <input type="file" name="video" accept="video/*">

      <label>visitorId</label>
      <input name="visitorId" value="${escapeHtml(visitorId)}">

      <button type="submit">Upload</button>
    </form>
  </div>

  <p><small>Endpoint upload: <code>${escapeHtml(uploadUrl)}</code></small></p>
  <p><small>Kalau kamu ingin pola seperti Termux, ini sudah pakai <code>visitorId</code>, <code>Origin</code>, <code>Referer</code>, dan field <code>file</code>.</small></p>
</body>
</html>`;
}

function renderResult({ ok, title, message, data = null, color = "black" }) {
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
