// index.js
const UPLOAD_PATH = "/api/upload";
const VIDEO_PREFIX = "video:";
const CDN_BASE = "https://cdn.videy.co";
const DEFAULT_VISITOR_ID = "1f5f718b-06b2-40f9-82da-0a73dfdadd1c";
const DEFAULT_UPLOAD_URL = "https://videy.co/api/upload";
const DEFAULT_UPLOAD_FIELD = "file";
const MAX_DEBUG_TEXT = 4000;

const D1_VIDEOS_TABLE = "videy_videos";
const D1_COUNTERS_TABLE = "videy_counters";
const D1_COUNTER_NAME = "video_order";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 200;
const DEFAULT_LEGACY_LIMIT = 100;
const MAX_LEGACY_LIMIT = 200;
const DEFAULT_KV_MIRROR = false;

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
        if ((url.searchParams.get("source") || "").toLowerCase() === "kv") {
          return await handleLegacyList(env, url);
        }
        return await handleList(env, url);
      }

      if (pathname === "/api/list/legacy") {
        return await handleLegacyList(env, url);
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

function getD1(env) {
  return env?.DB || env?.D1 || env?.VIDEY_DB || null;
}

async function ensureD1Schema(env) {
  const db = getD1(env);
  if (!db) return false;

  if (!globalThis.__videyD1InitPromise) {
    globalThis.__videyD1InitPromise = (async () => {
      try {
        await db
          .prepare(`INSERT OR IGNORE INTO ${D1_COUNTERS_TABLE} (name, value) VALUES (?, ?)`)
          .bind(D1_COUNTER_NAME, 0)
          .run();
      } catch {
        // kalau counter row belum bisa dibuat, biarkan fungsi lain yang menangani
      }
    })();
  }

  await globalThis.__videyD1InitPromise;
  return true;
}

function shouldMirrorKv(env) {
  const raw = env?.VIDEY_KV_WRITE_ENABLED;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
  }
  return DEFAULT_KV_MIRROR;
}

function isUniqueConstraintError(err) {
  const msg = String(err?.message || err || "");
  return /UNIQUE constraint failed|constraint failed|PRIMARY KEY constraint failed/i.test(msg);
}

function normalizeRecord(record) {
  if (!record || typeof record !== "object") return record;

  const order = Number(record.order ?? record.order_num ?? record.orderNum ?? 0) || null;

  return {
    title: record.title ?? "",
    slug: record.slug ?? "",
    order,
    mode: record.mode ?? "",
    createdAt: record.createdAt ?? record.created_at ?? "",
    videyId: record.videyId ?? record.videy_id ?? null,
    sourceUrl: record.sourceUrl ?? record.source_url ?? null,
  };
}

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clampInt(value, fallback, min, max) {
  const n = parsePositiveInt(value, fallback);
  return Math.min(max, Math.max(min, n));
}

function parsePagination(url, defaultLimit, maxLimit) {
  const page = clampInt(url.searchParams.get("page"), 1, 1, 1000000);
  const limit = clampInt(url.searchParams.get("limit"), defaultLimit, 1, maxLimit);
  return {
    page,
    limit,
    offset: (page - 1) * limit,
  };
}

function parseKvPagination(url) {
  const limit = clampInt(url.searchParams.get("limit"), DEFAULT_LEGACY_LIMIT, 1, MAX_LEGACY_LIMIT);
  const cursor = clean(url.searchParams.get("cursor"));
  return { limit, cursor: cursor || null };
}

async function getMaxOrderFromKv(env) {
  if (!env?.VIDEY_KV) return 0;

  const out = [];
  const result = await env.VIDEY_KV.list({ prefix: VIDEO_PREFIX, limit: 1000 });

  for (const key of result.keys) {
    const raw = await env.VIDEY_KV.get(key.name);
    if (!raw) continue;

    try {
      const record = JSON.parse(raw);
      const ord = Number(record.order || 0);
      if (ord > 0) out.push(ord);
    } catch {
      continue;
    }
  }

  return out.length ? Math.max(...out) : 0;
}

async function seedOrderCounter(env) {
  const db = getD1(env);
  if (!db) return 0;

  await ensureD1Schema(env);

  const currentCounterRow = await db
    .prepare(`SELECT value FROM ${D1_COUNTERS_TABLE} WHERE name = ? LIMIT 1`)
    .bind(D1_COUNTER_NAME)
    .first();

  const d1MaxRow = await db
    .prepare(`SELECT COALESCE(MAX(order_num), 0) AS maxOrder FROM ${D1_VIDEOS_TABLE}`)
    .first();

  const kvMax = await getMaxOrderFromKv(env);
  const currentCounter = Number(currentCounterRow?.value || 0);
  const d1Max = Number(d1MaxRow?.maxOrder || 0);
  const target = Math.max(currentCounter, d1Max, kvMax);

  if (currentCounterRow) {
    if (currentCounter < target) {
      await db
        .prepare(`UPDATE ${D1_COUNTERS_TABLE} SET value = ? WHERE name = ?`)
        .bind(target, D1_COUNTER_NAME)
        .run();
    }
    return target;
  }

  try {
    await db
      .prepare(`INSERT INTO ${D1_COUNTERS_TABLE} (name, value) VALUES (?, ?)`)
      .bind(D1_COUNTER_NAME, target)
      .run();
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
  }

  return target;
}

async function reserveOrder(env) {
  const db = getD1(env);
  if (!db) return await allocateOrderFromKV(env);

  await seedOrderCounter(env);

  let row = await db
    .prepare(`UPDATE ${D1_COUNTERS_TABLE} SET value = value + 1 WHERE name = ? RETURNING value`)
    .bind(D1_COUNTER_NAME)
    .first();

  let order = Number(row?.value || 0);

  if (!order) {
    await seedOrderCounter(env);
    row = await db
      .prepare(`UPDATE ${D1_COUNTERS_TABLE} SET value = value + 1 WHERE name = ? RETURNING value`)
      .bind(D1_COUNTER_NAME)
      .first();

    order = Number(row?.value || 0);
  }

  if (order) return order;

  return await allocateOrderFromKV(env);
}

async function allocateOrderFromKV(env) {
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

  return maxOrder + 1;
}

async function allocateOrder(env) {
  const db = getD1(env);
  if (db) {
    return await reserveOrder(env);
  }
  return await allocateOrderFromKV(env);
}

async function handleUpload(request, env, url) {
  const form = await request.formData();

  const title = clean(form.get("title"));
  const visitorIdInput = clean(form.get("visitorId"));
  const sourceUrl = clean(form.get("sourceUrl"));
  const modeInput = clean(form.get("mode")).toLowerCase();
  const file = form.get("file");

  const visitorId = visitorIdInput || DEFAULT_VISITOR_ID;
  const mode = modeInput === "proxy" || sourceUrl ? "proxy" : "videy";
  const createdAt = new Date().toISOString();

  if (!title) {
    return respondUploadError("Judul wajib diisi.", { mode }, 400, request);
  }

  if (mode === "proxy") {
    if (!isValidHttpUrl(sourceUrl)) {
      return respondUploadError("URL sumber proxy tidak valid.", { mode }, 400, request);
    }

    const baseSlug = slugify(title);
    const slugCandidate = await uniqueSlug(env, baseSlug);

    const saved = await saveRecord(env, {
      title,
      slug: slugCandidate,
      mode: "proxy",
      sourceUrl,
      createdAt,
    });

    const publicUrl = `${url.origin}/${saved.order}/${saved.slug}.mp4`;
    const apiUrl = `${url.origin}/api/video/${saved.order}/${saved.slug}`;

    const key = makeVideoKey(saved.order, saved.slug);
    const payload = {
      title: saved.title,
      slug: saved.slug,
      order: saved.order,
      mode: saved.mode,
      createdAt: saved.createdAt,
      sourceUrl: saved.sourceUrl,
    };

    let kvMirrored = false;
    let kvError = "";
    if (shouldMirrorKv(env) && env?.VIDEY_KV) {
      try {
        await env.VIDEY_KV.put(key, JSON.stringify(payload));
        kvMirrored = true;
      } catch (err) {
        kvError = err?.message || String(err);
      }
    }

    return respondUploadSuccess(
      {
        publicUrl,
        apiUrl,
        order: saved.order,
        slug: saved.slug,
        mode,
        title,
        message: kvMirrored
          ? (saved.storedInD1 ? "Proxy link tersimpan di D1 dan KV." : "Proxy link tersimpan di KV.")
          : saved.storedInD1
            ? "Proxy link tersimpan di D1."
            : `Proxy link tersimpan di D1, mirror KV gagal: ${kvError || "mirror dimatikan"}`,
        storage: {
          d1: !!saved.storedInD1,
          kv: kvMirrored,
        },
      },
      request
    );
  }

  if (!(file instanceof File) || file.size <= 0) {
    return respondUploadError("File video wajib dipilih.", { mode }, 400, request);
  }

  const upload = await uploadToVidey(file, visitorId, env);

  if (!upload.ok) {
    return respondUploadError(
      "Videy tidak mengembalikan ID video yang valid. Tidak ada data yang disimpan ke KV.",
      {
        mode,
        status: upload.status,
        contentType: upload.contentType,
        location: upload.location,
        rawJson: upload.rawJson,
        rawText: upload.rawText,
      },
      502,
      request
    );
  }

  const baseSlug = slugify(title);
  const slugCandidate = await uniqueSlug(env, baseSlug);

  const saved = await saveRecord(env, {
    title,
    slug: slugCandidate,
    mode: "videy",
    videyId: upload.videyId,
    createdAt,
  });

  const publicUrl = `${url.origin}/${saved.order}/${saved.slug}.mp4`;
  const apiUrl = `${url.origin}/api/video/${saved.order}/${saved.slug}`;

  const key = makeVideoKey(saved.order, saved.slug);
  const payload = {
    title: saved.title,
    slug: saved.slug,
    order: saved.order,
    mode: saved.mode,
    createdAt: saved.createdAt,
    videyId: saved.videyId,
  };

  let kvMirrored = false;
  let kvError = "";
  if (shouldMirrorKv(env) && env?.VIDEY_KV) {
    try {
      await env.VIDEY_KV.put(key, JSON.stringify(payload));
      kvMirrored = true;
    } catch (err) {
      kvError = err?.message || String(err);
    }
  }

  return respondUploadSuccess(
    {
      publicUrl,
      apiUrl,
      order: saved.order,
      slug: saved.slug,
      mode,
      title,
      videyId: upload.videyId,
      message: kvMirrored
        ? (saved.storedInD1 ? "ID asli Videy berhasil disimpan ke D1 dan KV." : "ID asli Videy berhasil disimpan ke KV.")
        : saved.storedInD1
          ? "ID asli Videy berhasil disimpan ke D1."
          : `ID asli Videy berhasil disimpan ke D1, mirror KV gagal: ${kvError || "mirror dimatikan"}`,
      storage: {
        d1: !!saved.storedInD1,
        kv: kvMirrored,
      },
    },
    request
  );
}

async function saveRecord(env, draft) {
  const db = getD1(env);

  if (!db) {
    const slug = await uniqueSlug(env, draft.slug);
    const order = await allocateOrderFromKV(env);
    return {
      ...draft,
      slug,
      order,
      storedInD1: false,
    };
  }

  await ensureD1Schema(env);
  await seedOrderCounter(env);

  let order = await reserveOrder(env);
  let slug = draft.slug;

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await db
        .prepare(
          `INSERT INTO ${D1_VIDEOS_TABLE}
           (order_num, slug, title, mode, videy_id, source_url, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          order,
          slug,
          draft.title,
          draft.mode,
          draft.videyId ?? null,
          draft.sourceUrl ?? null,
          draft.createdAt
        )
        .run();

      return {
        ...draft,
        slug,
        order,
        storedInD1: true,
      };
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;

      const msg = String(err?.message || "");
      if (/slug/i.test(msg)) {
        slug = `${draft.slug}-${attempt + 1}`;
        continue;
      }

      if (/order_num|PRIMARY KEY/i.test(msg)) {
        order = await reserveOrder(env);
        continue;
      }

      throw err;
    }
  }

  throw new Error("Gagal menyimpan metadata ke D1.");
}

async function uploadToVidey(file, visitorId, env) {
  const uploadUrlInput = env?.VIDEY_UPLOAD_URL || DEFAULT_UPLOAD_URL;
  const uploadField = env?.VIDEY_UPLOAD_FIELD || DEFAULT_UPLOAD_FIELD;

  const uploadTarget = new URL(uploadUrlInput);
  if (!uploadTarget.searchParams.has("visitorId")) {
    uploadTarget.searchParams.set("visitorId", visitorId);
  }

  const headers = {
    "User-Agent": "Mozilla/5.0",
    Accept: "application/json",
  };

  const formData = new FormData();
  formData.append(uploadField, file, file.name || "video.mp4");

  const resp = await fetch(uploadTarget.toString(), {
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
    return await proxyToUpstream(record.sourceUrl, request, record);
  }

  if (!record.videyId) return textResponse("videyId kosong", 500);

  const upstreamUrl = `${CDN_BASE}/${encodeURIComponent(record.videyId)}.mp4`;
  return await proxyToUpstream(upstreamUrl, request, record);
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
    data: publicRecord(record),
  });
}

async function handleList(env, url) {
  const db = getD1(env);
  if (!db) {
    return jsonResponse({ ok: false, error: "d1_not_available" }, 503);
  }

  await ensureD1Schema(env);

  const { page, limit, offset } = parsePagination(url, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);

  const result = await db
    .prepare(
      `SELECT
        order_num AS order_num,
        slug,
        title,
        mode,
        videy_id AS videyId,
        source_url AS sourceUrl,
        created_at AS createdAt
       FROM ${D1_VIDEOS_TABLE}
       ORDER BY order_num ASC
       LIMIT ? OFFSET ?`
    )
    .bind(limit + 1, offset)
    .all();

  const rows = result?.results || [];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => publicRecord(normalizeRecord(row)));

  return jsonResponse({
    ok: true,
    source: "d1",
    page,
    limit,
    hasMore,
    nextPage: hasMore ? page + 1 : null,
    items,
  });
}

async function handleLegacyList(env, url) {
  const kv = env?.VIDEY_KV;
  if (!kv) {
    return jsonResponse({ ok: false, error: "kv_not_available" }, 503);
  }

  const { limit, cursor } = parseKvPagination(url);

  const listArgs = {
    prefix: VIDEO_PREFIX,
    limit: limit + 1,
  };

  if (cursor) {
    listArgs.cursor = cursor;
  }

  const result = await kv.list(listArgs);
  const keys = result?.keys || [];
  const hasMore = keys.length > limit;
  const pageKeys = keys.slice(0, limit);

  const items = [];
  for (const key of pageKeys) {
    const raw = await kv.get(key.name);
    if (!raw) continue;

    try {
      const record = JSON.parse(raw);
      items.push(publicRecord(normalizeRecord(record)));
    } catch {
      continue;
    }
  }

  items.sort((a, b) => {
    const ao = Number(a.order || 0);
    const bo = Number(b.order || 0);
    if (ao !== bo) return ao - bo;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });

  return jsonResponse({
    ok: true,
    source: "kv",
    limit,
    hasMore,
    nextCursor: hasMore ? (result?.cursor || null) : null,
    listComplete: !!result?.list_complete,
    items,
  });
}

async function findRecordByRoute(env, route) {
  const db = getD1(env);
  if (db) {
    await ensureD1Schema(env);

    if (route.order && route.slug) {
      const row = await db
        .prepare(
          `SELECT
            order_num AS order_num,
            slug,
            title,
            mode,
            videy_id AS videyId,
            source_url AS sourceUrl,
            created_at AS createdAt
           FROM ${D1_VIDEOS_TABLE}
           WHERE order_num = ? AND slug = ?
           LIMIT 1`
        )
        .bind(Number(route.order), route.slug)
        .first();

      if (row) return normalizeRecord(row);
    }

    if (route.slug) {
      const row = await db
        .prepare(
          `SELECT
            order_num AS order_num,
            slug,
            title,
            mode,
            videy_id AS videyId,
            source_url AS sourceUrl,
            created_at AS createdAt
           FROM ${D1_VIDEOS_TABLE}
           WHERE slug = ?
           ORDER BY order_num DESC
           LIMIT 1`
        )
        .bind(route.slug)
        .first();

      if (row) return normalizeRecord(row);
    }
  }

  const kv = env?.VIDEY_KV;
  if (!kv) return null;

  const result = await kv.list({ prefix: VIDEO_PREFIX, limit: 1000 });

  for (const key of result.keys) {
    const raw = await kv.get(key.name);
    if (!raw) continue;

    try {
      const record = JSON.parse(raw);

      if (route.order && route.slug) {
        if (String(record.order) === String(route.order) && record.slug === route.slug) {
          return normalizeRecord(record);
        }
      } else if (route.slug) {
        if (record.slug === route.slug) return normalizeRecord(record);
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
  const db = getD1(env);
  if (db) {
    await ensureD1Schema(env);
    const row = await db
      .prepare(`SELECT 1 AS found FROM ${D1_VIDEOS_TABLE} WHERE slug = ? LIMIT 1`)
      .bind(slug)
      .first();

    if (row) return true;
  }

  const kv = env?.VIDEY_KV;
  if (!kv) return false;

  const result = await kv.list({ prefix: VIDEO_PREFIX, limit: 1000 });
  for (const key of result.keys) {
    const raw = await kv.get(key.name);
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

function publicRecord(record) {
  const n = normalizeRecord(record);
  if (!n || typeof n !== "object") return record;

  const out = {
    title: n.title,
    slug: n.slug,
    order: n.order,
    mode: n.mode,
    createdAt: n.createdAt,
  };

  if (n.mode === "videy" && n.videyId) {
    out.videyId = n.videyId;
  }

  return out;
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

function wantsJson(request) {
  const accept = request.headers.get("accept") || "";
  const xrw = request.headers.get("x-requested-with") || "";
  return accept.includes("application/json") || xrw.toLowerCase() === "xmlhttprequest";
}

function respondUploadSuccess(payload, request) {
  if (wantsJson(request)) {
    return jsonResponse(
      {
        ok: true,
        ...payload,
      },
      200
    );
  }

  return htmlResponse(renderResultBlock(payload));
}

function respondUploadError(message, data, status, request) {
  if (wantsJson(request)) {
    return jsonResponse(
      {
        ok: false,
        error: message,
        data,
      },
      status
    );
  }

  return htmlResponse(
    renderResultBlock({
      title: "Upload gagal",
      message,
      data,
      color: "red",
    }),
    status
  );
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
    <p>Polos, minimalis, dan tetap lincah.</p>
    <p><a href="/api/upload">Buka uploader</a> | <a href="/api/list">Lihat list D1</a> | <a href="/api/list/legacy">Lihat list KV legacy</a></p>
  </div>

  <div class="box">
    <strong>Format URL publik</strong>
    <ul>
      <li><code>${escapeHtml(url.origin)}/1/judul-video.mp4</code></li>
      <li><code>${escapeHtml(url.origin)}/judul-video.mp4</code></li>
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
  <title>Upload</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.5}
    .box{border:1px solid #ddd;border-radius:12px;padding:16px}
    label{display:block;margin:12px 0 6px}
    input,button{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:10px;font:inherit}
    button{cursor:pointer;background:#111;color:#fff;border:none;margin-top:14px}
    button:disabled{opacity:.7;cursor:not-allowed}
    small{color:#666}
    progress{width:100%;height:16px}
    pre{white-space:pre-wrap;background:#f6f6f6;border:1px solid #ddd;padding:12px;border-radius:12px;overflow:auto}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .muted{color:#666;font-size:.95rem}
    .hidden{display:none}
    .radioRow{display:flex;gap:14px;flex-wrap:wrap;margin:8px 0 4px}
    .radioRow label{display:flex;gap:6px;align-items:center;margin:0}
    .block{
      border:1px solid #ddd;
      border-radius:12px;
      padding:14px;
      margin-top:16px;
    }
    .blockTitle{font-weight:700;margin-bottom:8px}
    .resultTop{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}
    .ok{font-weight:700}
    .urlRow{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin-top:10px}
    .urlRow input{width:100%}
    .copyBtn{
      width:auto;
      min-width:86px;
      padding:10px 12px;
      background:#f3f4f6;
      color:#111;
      border:1px solid #ccc;
    }
    .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
    .secondary{
      display:inline-block;
      padding:10px 12px;
      border:1px solid #ccc;
      border-radius:10px;
      color:#111;
      text-decoration:none;
      background:#f9f9f9;
    }
    .hint{margin-top:8px;color:#666;font-size:.95rem}
    .status{margin-top:12px;font-weight:600}
    .sr{position:absolute;left:-9999px}
  </style>
</head>
<body>
  <h1>Uploader</h1>

  <div class="box">
    <form id="uploadForm" method="POST" enctype="multipart/form-data">
      <label>Judul</label>
      <input name="title" required placeholder="contoh: kucing-lucu">

      <div class="radioRow" aria-label="Mode upload">
        <label><input type="radio" name="mode" value="video" checked> Upload video</label>
        <label><input type="radio" name="mode" value="proxy"> Upload link</label>
      </div>

      <div id="videoFields">
        <label>File video</label>
        <input type="file" name="file" accept="video/*">
      </div>

      <div id="proxyFields" class="hidden">
        <label>Link video sumber</label>
        <input name="sourceUrl" placeholder="https://Moonlight.co/jua.mp4">
      </div>

      <label>visitorId (opsional)</label>
      <input name="visitorId" placeholder="1f5f718b-06b2-40f9-82da-0a73dfdadd1c">

      <button id="submitBtn" type="submit">Upload</button>

      <div class="hint">
        Mode video akan upload ke Videy. Mode link akan disimpan sebagai proxy tanpa upload ke Videy.
      </div>
    </form>

    <div style="margin-top:14px">
      <progress id="progressBar" value="0" max="100" hidden></progress>
      <div class="status" id="statusText">Siap</div>
    </div>

    <div id="resultWrap" class="block hidden"></div>
  </div>

  <p><small>Semua tetap polos, ringan, dan ramah mata.</small></p>

  <script>
    const form = document.getElementById("uploadForm");
    const submitBtn = document.getElementById("submitBtn");
    const progressBar = document.getElementById("progressBar");
    const statusText = document.getElementById("statusText");
    const resultWrap = document.getElementById("resultWrap");
    const videoFields = document.getElementById("videoFields");
    const proxyFields = document.getElementById("proxyFields");
    const modeRadios = [...form.querySelectorAll('input[name="mode"]')];

    function esc(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function currentMode() {
      const checked = form.querySelector('input[name="mode"]:checked');
      return checked ? checked.value : "video";
    }

    function toggleMode() {
      const mode = currentMode();
      if (mode === "proxy") {
        proxyFields.classList.remove("hidden");
        videoFields.classList.add("hidden");
      } else {
        proxyFields.classList.add("hidden");
        videoFields.classList.remove("hidden");
      }
    }

    function setStatus(text) {
      statusText.textContent = text;
    }

    function setLoading(on) {
      submitBtn.disabled = on;
      if (on) {
        progressBar.hidden = false;
        progressBar.value = 8;
      } else {
        progressBar.hidden = true;
        progressBar.value = 0;
      }
    }

    function renderResult(data) {
      const ok = !!data.ok;
      const title = ok ? (data.mode === "proxy" ? "Successfully saved proxy" : "Successfully uploaded") : "Upload gagal";
      const color = ok ? "green" : "red";
      const publicUrl = data.publicUrl || "";
      const apiUrl = data.apiUrl || "";
      const order = data.order ?? "";
      const slug = data.slug || "";
      const mode = data.mode || "";
      const message = data.message || (ok ? "Selesai." : data.error || "Terjadi kesalahan.");

      resultWrap.classList.remove("hidden");
      resultWrap.innerHTML = \`
        <div class="blockTitle" style="color:\${color}">\${esc(title)}</div>
        <div class="muted">\${esc(message)}</div>

        <div class="row" style="margin-top:10px">
          <div><strong>Order</strong><br>\${esc(order)}</div>
          <div><strong>Mode</strong><br>\${esc(mode)}</div>
        </div>

        <div style="margin-top:10px"><strong>Slug</strong><br>\${esc(slug)}</div>

        <div style="margin-top:12px">
          <strong>URL hasil</strong>
          <div class="urlRow">
            <input readonly value="\${esc(publicUrl)}" id="publicUrlInput">
            <button type="button" class="copyBtn" data-copy="\${esc(publicUrl)}">Copy</button>
          </div>
        </div>

        <div style="margin-top:12px">
          <strong>API</strong>
          <div class="urlRow">
            <input readonly value="\${esc(apiUrl)}" id="apiUrlInput">
            <button type="button" class="copyBtn" data-copy="\${esc(apiUrl)}">Copy</button>
          </div>
        </div>

        <div class="actions">
          <a class="secondary" href="/api/upload">Upload lagi?</a>
          <button type="button" class="secondary" id="resetBtn">Bersihkan</button>
        </div>

        <details style="margin-top:12px">
          <summary>Lihat data</summary>
          <pre>\${esc(JSON.stringify(data, null, 2))}</pre>
        </details>
      \`;

      resultWrap.querySelectorAll("[data-copy]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const text = btn.getAttribute("data-copy") || "";
          try {
            await navigator.clipboard.writeText(text);
            const old = btn.textContent;
            btn.textContent = "Copied";
            setTimeout(() => (btn.textContent = old), 1000);
          } catch (e) {
            const old = btn.textContent;
            btn.textContent = "Gagal";
            setTimeout(() => (btn.textContent = old), 1000);
          }
        });
      });

      const resetBtn = resultWrap.querySelector("#resetBtn");
      if (resetBtn) {
        resetBtn.addEventListener("click", () => {
          form.reset();
          toggleMode();
          resultWrap.classList.add("hidden");
          resultWrap.innerHTML = "";
          setStatus("Siap");
          window.scrollTo({ top: 0, behavior: "smooth" });
        });
      }
    }

    modeRadios.forEach((r) => r.addEventListener("change", toggleMode));
    toggleMode();

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      resultWrap.classList.add("hidden");
      resultWrap.innerHTML = "";

      const mode = currentMode();
      const fd = new FormData(form);

      if (mode === "proxy") {
        fd.delete("file");
      } else {
        fd.delete("sourceUrl");
      }

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload", true);
      xhr.setRequestHeader("Accept", "application/json");
      xhr.responseType = "text";

      xhr.upload.onprogress = function (ev) {
        if (mode === "video") {
          progressBar.hidden = false;
          if (ev.lengthComputable) {
            progressBar.value = Math.round((ev.loaded / ev.total) * 100);
            setStatus("Mengirim... " + progressBar.value + "%");
          } else {
            progressBar.removeAttribute("value");
            setStatus("Mengirim...");
          }
        } else {
          progressBar.hidden = false;
          progressBar.value = 45;
          setStatus("Menyimpan link...");
        }
      };

      xhr.onreadystatechange = function () {
        if (xhr.readyState === 2) {
          setStatus("Memproses respons...");
        }

        if (xhr.readyState === 4) {
          setLoading(false);

          let payload = xhr.responseText;
          try {
            payload = JSON.parse(xhr.responseText);
          } catch (e) {}

          if (xhr.status >= 200 && xhr.status < 300) {
            setStatus("Selesai");
          } else {
            setStatus("Gagal");
          }

          renderResult(payload);
        }
      };

      xhr.onerror = function () {
        setLoading(false);
        setStatus("Gagal jaringan");
        resultWrap.classList.remove("hidden");
        resultWrap.innerHTML = \`
          <div class="blockTitle" style="color:red">Upload gagal</div>
          <div class="muted">Terjadi error jaringan.</div>
        \`;
      };

      setLoading(true);
      setStatus(mode === "proxy" ? "Menyimpan link..." : "Menyiapkan upload...");
      xhr.send(fd);

      let fake = mode === "proxy" ? 15 : 8;
      const timer = setInterval(() => {
        if (!submitBtn.disabled) {
          clearInterval(timer);
          return;
        }

        if (!progressBar.hidden) {
          fake = Math.min(fake + 3, 95);
          if (progressBar.hasAttribute("value")) {
            progressBar.value = fake;
          }
        }
      }, 180);
    });
  </script>
</body>
</html>`;
}

function renderResultBlock({ title, message, data = null, color = "black" }) {
  const payload = data ? JSON.stringify(data, null, 2) : "";
  return `<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 16px;line-height:1.5}
    .block{border:1px solid #ddd;border-radius:12px;padding:16px}
    .top{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}
    .title{font-weight:700}
    .muted{color:#666}
    .row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;margin-top:10px}
    input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ccc;border-radius:10px;font:inherit}
    button,a.btn{padding:10px 12px;border:1px solid #ccc;border-radius:10px;background:#f9f9f9;color:#111;text-decoration:none;display:inline-block;cursor:pointer}
    .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
    pre{white-space:pre-wrap;background:#f6f6f6;border:1px solid #ddd;padding:12px;border-radius:12px;overflow:auto;margin-top:12px}
    details{margin-top:12px}
  </style>
</head>
<body>
  <div class="block">
    <div class="top">
      <div class="title" style="color:${color}">${escapeHtml(title)}</div>
      <div>${escapeHtml(message)}</div>
    </div>

    ${
      data
        ? `
    <div style="margin-top:10px"><strong>Order</strong><br>${escapeHtml(data.order ?? "")}</div>
    <div style="margin-top:10px"><strong>Mode</strong><br>${escapeHtml(data.mode ?? "")}</div>
    <div style="margin-top:10px"><strong>Slug</strong><br>${escapeHtml(data.slug ?? "")}</div>

    <div style="margin-top:12px">
      <strong>URL hasil</strong>
      <div class="row">
        <input readonly value="${escapeHtml(data.publicUrl ?? "")}" id="publicUrlInput">
        <button type="button" data-copy="${escapeHtml(data.publicUrl ?? "")}">Copy</button>
      </div>
    </div>

    <div style="margin-top:12px">
      <strong>API</strong>
      <div class="row">
        <input readonly value="${escapeHtml(data.apiUrl ?? "")}" id="apiUrlInput">
        <button type="button" data-copy="${escapeHtml(data.apiUrl ?? "")}">Copy</button>
      </div>
    </div>

    <div class="actions">
      <a class="btn" href="/api/upload">Upload lagi?</a>
      <a class="btn" href="/">Beranda</a>
    </div>

    <details>
      <summary>Lihat data</summary>
      <pre>${escapeHtml(payload)}</pre>
    </details>
    `
        : ""
    }
  </div>

  <script>
    document.querySelectorAll("[data-copy]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const text = btn.getAttribute("data-copy") || "";
        try {
          await navigator.clipboard.writeText(text);
          const old = btn.textContent;
          btn.textContent = "Copied";
          setTimeout(() => (btn.textContent = old), 1000);
        } catch (e) {
          const old = btn.textContent;
          btn.textContent = "Gagal";
          setTimeout(() => (btn.textContent = old), 1000);
        }
      });
    });
  </script>
</body>
</html>`;
}
