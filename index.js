// index.js
const UPLOAD_PATH = "/api/upload";
const VIDEO_PREFIX = "video:";
const META_PREFIX = "meta:";
const CDN_BASE = "https://cdn.videy.co";
const DEFAULT_VISITOR_ID = "1f5f718b-06b2-40f9-82da-0a73dfdadd1c";
const DEFAULT_UPLOAD_URL = "https://videy.co/api/upload";
const MAX_DEBUG_TEXT = 4000;

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
        const { order, slug } = parseApiVideoPath(pathname);
        return await handleApiVideo(env, order, slug);
      }

      const route = parsePublicRoute(pathname);
      if (route) {
        return await serveVideoByRoute(route, request, env);
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
  const visitorIdInput = clean(form.get("visitorId"));
  const sourceUrl = clean(form.get("sourceUrl"));
  const file = form.get("file");

  const visitorId = visitorIdInput || DEFAULT_VISITOR_ID;
  const mode = sourceUrl ? "proxy" : "videy";

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

  if (mode === "proxy") {
    if (!isValidHttpUrl(sourceUrl)) {
      return htmlResponse(
        renderResult({
          title: "Upload gagal",
          message: "URL sumber proxy tidak valid.",
          color: "red",
        }),
        400
      );
    }

    const slug = await uniqueSlug(env, slugify(title));
    const order = await allocateOrder(env, slug);
    const key = makeVideoKey(order, slug);

    const record = {
      title,
      slug,
      order,
      mode: "proxy",
      sourceUrl,
      visitorId,
      createdAt: new Date().toISOString(),
    };

    await env.VIDEY_KV.put(key, JSON.stringify(record));

    const publicUrl = `${url.origin}/${order}/${slug}.mp4`;
    const apiUrl = `${url.origin}/api/video/${order}/${slug}`;

    return htmlResponse(
      renderResult({
        title: "Proxy berhasil",
        message: "Link proxy sudah disimpan ke KV dan siap dipakai.",
        data: {
          publicUrl,
          apiUrl,
          order,
          slug,
          mode: "proxy",
          sourceUrl,
          visitorId,
        },
        color: "green",
      })
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
  const order = await allocateOrder(env, slug);
  const key = makeVideoKey(order, slug);

  const record = {
    title,
    slug,
    order,
    mode: "videy",
    videyId: upload.videyId,
    visitorId,
    createdAt: new Date().toISOString(),
  };

  await env.VIDEY_KV.put(key, JSON.stringify(record));

  const publicUrl = `${url.origin}/${order}/${slug}.mp4`;
  const apiUrl = `${url.origin}/api/video/${order}/${slug}`;

  return htmlResponse(
    renderResult({
      title: "Upload sukses",
      message: "ID asli Videy berhasil disimpan ke KV.",
      data: {
        publicUrl,
        apiUrl,
        order,
        slug,
        mode: "videy",
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
    rawText: rawText ? rawText.slice(0, MAX_DEBUG_TEXT) : "",
  };
}

async function serveVideoByRoute(route, request, env) {
  const record = await findRecordByRoute(env, route);
  if (!record) return textResponse("Video tidak ditemukan", 404);

  if (record.mode === "proxy") {
    return await proxyToSource(record, request);
  }

  if (!record.videyId) return textResponse("videyId kosong", 500);

  const upstreamUrl = `${CDN_BASE}/${encodeURIComponent(record.videyId)}.mp4`;
  return await proxyToUpstream(upstreamUrl, request, record);
}

async function proxyToSource(record, request) {
  return await proxyToUpstream(record.sourceUrl, request, record);
}

async function proxyToUpstream(upstreamUrl, request, record) {
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
  headers.set("X-Video-Order", String(record.order ?? ""));
  headers.set("X-Video-Slug", record.slug || "");
  headers.set("X-Video-Title", record.title || "");

  if (!headers.get("Content-Type")) {
    headers.set("Content-Type", "video/mp4");
  }

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers,
  });
}

async function handleApiVideo(env, order, slug) {
  const record = await findRecordByRoute(env, { order, slug });
  if (!record) return jsonResponse({ ok: false, error: "not_found" }, 404);

  return jsonResponse({
    ok: true,
    data: record,
  });
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
    const ao = Number(a.order || 0);
    const bo = Number(b.order || 0);
    if (ao !== bo) return ao - bo;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });

  return jsonResponse({ ok: true, items: out });
}

async function findRecordByRoute(env, route) {
  if (route.order && route.slug) {
    const key = makeVideoKey(route.order, route.slug);
    const raw = await env.VIDEY_KV.get(key);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
  }

  const result = await env.VIDEY_KV.list({ prefix: VIDEO_PREFIX, limit: 1000 });
  for (const key of result.keys) {
    const raw = await env.VIDEY_KV.get(key.name);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw);
      if (route.order && route.slug) {
        if (String(record.order) === String(route.order) && record.slug === route.slug) {
          return record;
        }
      } else if (route.slug) {
        if (record.slug === route.slug) return record;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function uniqueSlug(env, base) {
  const root = base || `video-${Date.now()}`;
  let slug = root;
  let i = 0;

  while (await slugExists(env, slug)) {
    i += 1;
    slug = `${root}-${i}`;
  }

  return slug;
}

async function slugExists(env, slug) {
  const result = await env.VIDEY_KV.list({ prefix: VIDEO_PREFIX, limit: 1000 });
  for (const key of result.keys) {
    const raw = await env.VIDEY_KV.get(key.name);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw);
      if (record.slug === slug) return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function allocateOrder(env, slug) {
  const result = await env.VIDEY_KV.list({ prefix: VIDEO_PREFIX, limit: 1000 });
  let maxOrder = 0;

  for (const key of result.keys) {
    const raw = await env.VIDEY_KV.get(key.name);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw);
      const ord = Number(record.order || 0);
      if (ord > maxOrder) maxOrder = ord;
    } catch {
      continue;
    }
  }

  let order = maxOrder + 1;
  while (await env.VIDEY_KV.get(makeVideoKey(order, slug))) {
    order += 1;
  }

  return order;
}

function makeVideoKey(order, slug) {
  return `${VIDEO_PREFIX}${String(order)}:${String(slug)}`;
}

function parsePublicRoute(pathname) {
  const m1 = pathname.match(/^\/(\d+)\/([^/]+)\.mp4$/i);
  if (m1) {
    return {
      order: m1[1],
      slug: decodeURIComponentSafe(m1[2]),
    };
  }

  const m2 = pathname.match(/^\/([^/]+)\.mp4$/i);
  if (m2) {
    return {
      order: null,
      slug: decodeURIComponentSafe(m2[1]),
    };
  }

  return null;
}

function parseApiVideoPath(pathname) {
  const rest = pathname.slice("/api/video/".length);
  const m = rest.match(/^(\d+)\/([^/]+)(?:\.mp4)?$/i);
  if (m) {
    return {
      order: m[1],
      slug: decodeURIComponentSafe(m[2]),
    };
  }

  return {
    order: null,
    slug: decodeURIComponentSafe(rest.replace(/\.mp4$/i, "")),
  };
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isValidHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
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
    /([A-Za-z0-9_-]{5,})/i,
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m?.[1]) return m[1];
  }

  return null;
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
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:920px;margin:40px auto;padding:0 16px;line-height:1.5}
    .box{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
    a{color:#2563eb;text-decoration:none}
    code{background:#f4f4f5;padding:2px 6px;border-radius:6px}
    ul{margin:8px 0 0 18px}
  </style>
</head>
<body>
  <h1>MyBlobVidey</h1>
  <div class="box">
    <p>Polos, minimalis, tapi tetap jalan cepat.</p>
    <p><a href="/api/upload">Buka uploader</a> | <a href="/api/list">Lihat JSON list</a></p>
  </div>

  <div class="box">
    <strong>Format URL publik</strong>
    <ul>
      <li><code>${escapeHtml(url.origin)}/1/judul-video.mp4</code></li>
      <li><code>${escapeHtml(url.origin)}/judul-video.mp4</code></li>
    </ul>
  </div>

  <div class="box">
    <strong>Mode yang didukung</strong>
    <ul>
      <li>Upload ke Videy</li>
      <li>Proxy langsung dari URL sumber</li>
    </ul>
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
    button:disabled{opacity:.7;cursor:not-allowed}
    small{color:#666}
    pre{white-space:pre-wrap;background:#f6f6f6;border:1px solid #ddd;padding:12px;border-radius:12px;overflow:auto}
    progress{width:100%;height:16px}
    .row{display:grid;grid-template-columns:1fr;gap:10px}
    .hint{margin-top:8px;color:#666;font-size:.95rem}
    .status{margin-top:12px;font-weight:600}
  </style>
</head>
<body>
  <h1>Uploader</h1>
  <div class="box">
    <form id="uploadForm" method="POST" enctype="multipart/form-data">
      <label>Judul</label>
      <input name="title" required placeholder="contoh: kucing-lucu">

      <label>URL sumber proxy (opsional)</label>
      <input name="sourceUrl" placeholder="https://Moonlight.co/jua.mp4">

      <label>File video</label>
      <input type="file" name="file" accept="video/*">

      <label>visitorId (opsional)</label>
      <input name="visitorId" placeholder="1f5f718b-06b2-40f9-82da-0a73dfdadd1c">

      <button id="submitBtn" type="submit">Upload / Simpan Proxy</button>
      <div class="hint">Kalau <code>sourceUrl</code> diisi, Worker akan langsung menyimpan proxy tanpa upload ke Videy.</div>
    </form>

    <div style="margin-top:14px">
      <progress id="progressBar" value="0" max="100" hidden></progress>
      <div class="status" id="statusText">Siap</div>
    </div>

    <div style="margin-top:14px">
      <pre id="resultBox" style="display:none"></pre>
    </div>
  </div>

  <p><small>Field yang dipakai hanya judul, file, URL sumber proxy, dan visitorId opsional.</small></p>

  <script>
    const form = document.getElementById("uploadForm");
    const submitBtn = document.getElementById("submitBtn");
    const progressBar = document.getElementById("progressBar");
    const statusText = document.getElementById("statusText");
    const resultBox = document.getElementById("resultBox");

    function showResult(data) {
      resultBox.style.display = "block";
      resultBox.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    }

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      resultBox.style.display = "none";
      resultBox.textContent = "";

      const fd = new FormData(form);
      const xhr = new XMLHttpRequest();

      xhr.open("POST", "/api/upload", true);
      xhr.responseType = "text";

      xhr.upload.onprogress = function (ev) {
        if (ev.lengthComputable) {
          progressBar.hidden = false;
          progressBar.value = Math.round((ev.loaded / ev.total) * 100);
          statusText.textContent = "Mengirim... " + progressBar.value + "%";
        } else {
          progressBar.hidden = false;
          progressBar.removeAttribute("value");
          statusText.textContent = "Mengirim...";
        }
      };

      xhr.onreadystatechange = function () {
        if (xhr.readyState === 2) {
          statusText.textContent = "Memproses respons...";
        }
        if (xhr.readyState === 4) {
          submitBtn.disabled = false;
          progressBar.hidden = true;
          progressBar.value = 0;

          let payload = xhr.responseText;
          try {
            payload = JSON.parse(xhr.responseText);
          } catch (err) {}

          if (xhr.status >= 200 && xhr.status < 300) {
            statusText.textContent = "Selesai";
          } else {
            statusText.textContent = "Gagal";
          }

          showResult(payload);
        }
      };

      xhr.onerror = function () {
        submitBtn.disabled = false;
        progressBar.hidden = true;
        statusText.textContent = "Gagal jaringan";
        showResult("Terjadi error jaringan.");
      };

      submitBtn.disabled = true;
      progressBar.hidden = false;
      progressBar.value = 5;
      statusText.textContent = "Menyiapkan upload...";

      xhr.send(fd);

      let fake = 5;
      const timer = setInterval(() => {
        if (submitBtn.disabled === false) {
          clearInterval(timer);
          return;
        }
        fake = Math.min(fake + 3, 95);
        if (!progressBar.hidden) progressBar.value = fake;
      }, 180);
    });
  </script>
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
    code{background:#f4f4f5;padding:2px 6px;border-radius:6px}
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
