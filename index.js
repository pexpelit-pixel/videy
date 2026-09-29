// index.js
//
// CHUNKED B2 UPLOAD + IMAGE SUPPORT
// - Menjaga API upload lama tetap ada.
// - Menambahkan:
//
//   POST /api/upload/chunk/init
//   PUT  /api/upload/chunk/part?uploadId=...&partNumber=...
//   POST /api/upload/chunk/complete
//   GET  /api/upload/chunk/status?uploadId=...
//   POST /api/upload/image            <- Gambar B2 only
//
// - Chunk dikirim langsung sebagai request body, bukan multipart FormData.
// - Worker tidak memuat file 2.26 GB ke memory.
// - Setiap chunk diteruskan langsung ke B2 Large File API.
// - Default chunk 50 MiB, aman terhadap batas request Cloudflare 100 MB.
// - B2 Large File memakai start -> upload_part -> finish.
// - D1 menyimpan session + SHA1 setiap part.
// - Ada token session agar upload tidak bisa dipalsukan hanya dengan uploadId.
// - Debug diperketat melalui X-Upload-Debug dan /status.
// - API /api/upload lama tetap dipertahankan untuk kompatibilitas.
// - Dukungan gambar B2 (single-shot, max 25 MiB).

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

const D1_UPLOAD_SESSIONS_TABLE = "b2_upload_sessions";
const D1_UPLOAD_PARTS_TABLE = "b2_upload_parts";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 200;
const DEFAULT_LEGACY_LIMIT = 100;
const MAX_LEGACY_LIMIT = 200;
const DEFAULT_KV_MIRROR = false;

// ============================================================
// CHUNK CONFIG
// ============================================================

const DEFAULT_CHUNK_SIZE = 50 * 1024 * 1024; // 50 MiB
const MIN_CHUNK_SIZE = 5 * 1024 * 1024;      // B2 minimum
const MAX_CHUNK_SIZE = 90 * 1024 * 1024;     // safety margin under CF 100 MB

const MAX_B2_PARTS = 10000;
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024 * 1024 * 1024; // 10 TiB

const CHUNK_UPLOAD_EXPIRY_MS = 24 * 60 * 60 * 1000;
const UPLOAD_TOKEN_BYTES = 24;

const DEBUG_HEADER = "X-Upload-Debug";

// ============================================================
// IMAGE CONFIG (B2 ONLY)
// ============================================================

const MAX_IMAGE_SIZE = 25 * 1024 * 1024; // 25 MiB

const IMAGE_MIME_TO_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/tiff": ".tiff",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico"
};

const IMAGE_EXT_TO_MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const IMAGE_EXTENSIONS = Object.keys(IMAGE_EXT_TO_MIME);

let b2AuthCache = {
  token: null,
  apiUrl: null,
  downloadUrl: null,
  accountId: null,
  recommendedPartSize: null,
  expires: 0
};

let b2BucketCache = {
  id: null,
  name: null
};

// ============================================================
// MAIN ROUTER
// ============================================================

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();

    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      if (pathname === "/") {
        return htmlResponse(renderHome(url), 200, {
          "X-Request-Id": requestId
        });
      }

      // LEGACY UPLOAD
      if (pathname === UPLOAD_PATH) {
        if (request.method === "GET") {
          return htmlResponse(renderUploadPage(), 200, {
            "X-Request-Id": requestId
          });
        }

        if (request.method === "POST") {
          return await handleUpload(request, env, url, requestId);
        }

        return textResponse("Method Not Allowed", 405, {
          "X-Request-Id": requestId
        });
      }

      // CHUNKED B2 UPLOAD
      if (pathname === "/api/upload/chunk/init") {
        if (request.method !== "POST") {
          return jsonResponse(
            { ok: false, error: "method_not_allowed", requestId },
            405,
            { "X-Request-Id": requestId }
          );
        }
        return await handleChunkInit(request, env, url, requestId);
      }

      if (pathname === "/api/upload/chunk/part") {
        if (request.method !== "PUT" && request.method !== "POST") {
          return jsonResponse(
            { ok: false, error: "method_not_allowed", requestId },
            405,
            { "X-Request-Id": requestId }
          );
        }
        return await handleChunkPart(request, env, requestId);
      }

      if (pathname === "/api/upload/chunk/complete") {
        if (request.method !== "POST") {
          return jsonResponse(
            { ok: false, error: "method_not_allowed", requestId },
            405,
            { "X-Request-Id": requestId }
          );
        }
        return await handleChunkComplete(request, env, url, requestId);
      }

      if (pathname === "/api/upload/chunk/status") {
        if (request.method !== "GET") {
          return jsonResponse(
            { ok: false, error: "method_not_allowed", requestId },
            405,
            { "X-Request-Id": requestId }
          );
        }
        return await handleChunkStatus(request, env, requestId);
      }

      // B2 IMAGE UPLOAD (SINGLE-SHOT)
      if (pathname === "/api/upload/image") {
        if (request.method !== "POST") {
          return jsonResponse(
            { ok: false, error: "method_not_allowed", requestId },
            405,
            { "X-Request-Id": requestId }
          );
        }
        return await handleImageUpload(request, env, url, requestId);
      }

      // LIST
      if (pathname === "/api/list" || pathname === "/list") {
        if ((url.searchParams.get("source") || "").toLowerCase() === "kv") {
          return await handleLegacyList(env, url, request);
        }
        return await handleList(env, url, request);
      }

      if (pathname === "/api/list/legacy" || pathname === "/list/legacy") {
        return await handleLegacyList(env, url, request);
      }

      // API VIDEO
      if (pathname.startsWith("/api/video/")) {
        const { order, slug } = parseApiVideoPath(pathname);
        return await handleApiVideo(env, order, slug);
      }

      // PUBLIC VIDEO / IMAGE
      const route = parsePublicRoute(pathname);
      if (route) {
        return await serveVideoByRoute(route, request, env);
      }

      return textResponse("Not Found", 404, {
        "X-Request-Id": requestId
      });
    } catch (err) {
      console.error("[FATAL]", err);
      return textResponse(
        `Error: ${err?.message || String(err)}`,
        500,
        { "X-Request-Id": requestId }
      );
    }
  },
};

// ============================================================
// D1
// ============================================================

function getD1(env) {
  return env?.DB || env?.D1 || env?.VIDEY_DB || null;
}

async function ensureD1Schema(env) {
  const db = getD1(env);
  if (!db) return false;

  if (!globalThis.__videyD1InitPromise) {
    globalThis.__videyD1InitPromise = (async () => {
      try {
        await db.prepare(`
          CREATE TABLE IF NOT EXISTS ${D1_VIDEOS_TABLE} (
            order_num INTEGER PRIMARY KEY,
            slug TEXT UNIQUE,
            title TEXT,
            mode TEXT,
            videy_id TEXT,
            source_url TEXT,
            b2_file_name TEXT,
            content_type TEXT,
            media_type TEXT,
            created_at TEXT
          )
        `).run();

        await db.prepare(`
          CREATE TABLE IF NOT EXISTS ${D1_COUNTERS_TABLE} (
            name TEXT PRIMARY KEY,
            value INTEGER
          )
        `).run();

        await db
          .prepare(`
            INSERT OR IGNORE INTO ${D1_COUNTERS_TABLE}
            (name, value)
            VALUES (?, ?)
          `)
          .bind(D1_COUNTER_NAME, 0)
          .run();

        try {
          const tableInfo = await db
            .prepare(`PRAGMA table_info(${D1_VIDEOS_TABLE})`)
            .all();

          const columns = (tableInfo.results || []).map(c => c.name);

          if (!columns.includes("b2_file_name")) {
            await db
              .prepare(`
                ALTER TABLE ${D1_VIDEOS_TABLE}
                ADD COLUMN b2_file_name TEXT
              `)
              .run();
          }

          if (!columns.includes("content_type")) {
            await db
              .prepare(`
                ALTER TABLE ${D1_VIDEOS_TABLE}
                ADD COLUMN content_type TEXT
              `)
              .run();
          }

          if (!columns.includes("media_type")) {
            await db
              .prepare(`
                ALTER TABLE ${D1_VIDEOS_TABLE}
                ADD COLUMN media_type TEXT
              `)
              .run();
          }
        } catch (err) {
          console.error("[D1 MIGRATE VIDEO]", err);
        }

        await db.prepare(`
          CREATE TABLE IF NOT EXISTS ${D1_UPLOAD_SESSIONS_TABLE} (
            upload_id TEXT PRIMARY KEY,
            session_token TEXT NOT NULL,
            title TEXT NOT NULL,
            base_slug TEXT NOT NULL,
            file_name TEXT NOT NULL,
            content_type TEXT NOT NULL,
            file_size INTEGER NOT NULL,
            chunk_size INTEGER NOT NULL,
            total_parts INTEGER NOT NULL,
            b2_file_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            result_order INTEGER,
            result_slug TEXT,
            b2_file_name TEXT
          )
        `).run();

        await db.prepare(`
          CREATE TABLE IF NOT EXISTS ${D1_UPLOAD_PARTS_TABLE} (
            upload_id TEXT NOT NULL,
            part_number INTEGER NOT NULL,
            sha1 TEXT NOT NULL,
            size INTEGER NOT NULL,
            uploaded_at TEXT NOT NULL,
            PRIMARY KEY (upload_id, part_number)
          )
        `).run();

        await db.prepare(`
          CREATE INDEX IF NOT EXISTS idx_b2_upload_parts_upload_id
          ON ${D1_UPLOAD_PARTS_TABLE}(upload_id)
        `).run();

        await db.prepare(`
          CREATE INDEX IF NOT EXISTS idx_b2_upload_sessions_status
          ON ${D1_UPLOAD_SESSIONS_TABLE}(status)
        `).run();

        console.log("[D1] Schema ready");
      } catch (err) {
        console.error("[D1 INIT]", err);
      }
    })();
  }

  await globalThis.__videyD1InitPromise;
  return true;
}

// ============================================================
// ORDER COUNTER
// ============================================================

async function getMaxOrderFromKv(env) {
  if (!env?.VIDEY_KV) return 0;

  const out = [];
  const result = await env.VIDEY_KV.list({
    prefix: VIDEO_PREFIX,
    limit: 1000
  });

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
    .prepare(`
      SELECT value
      FROM ${D1_COUNTERS_TABLE}
      WHERE name = ?
      LIMIT 1
    `)
    .bind(D1_COUNTER_NAME)
    .first();

  const d1MaxRow = await db
    .prepare(`
      SELECT COALESCE(MAX(order_num), 0) AS maxOrder
      FROM ${D1_VIDEOS_TABLE}
    `)
    .first();

  const kvMax = await getMaxOrderFromKv(env);

  const currentCounter = Number(currentCounterRow?.value || 0);
  const d1Max = Number(d1MaxRow?.maxOrder || 0);

  const target = Math.max(currentCounter, d1Max, kvMax);

  if (currentCounterRow) {
    if (currentCounter < target) {
      await db
        .prepare(`
          UPDATE ${D1_COUNTERS_TABLE}
          SET value = ?
          WHERE name = ?
        `)
        .bind(target, D1_COUNTER_NAME)
        .run();
    }
    return target;
  }

  try {
    await db
      .prepare(`
        INSERT INTO ${D1_COUNTERS_TABLE}
        (name, value)
        VALUES (?, ?)
      `)
      .bind(D1_COUNTER_NAME, target)
      .run();
  } catch (err) {
    if (!isUniqueConstraintError(err)) throw err;
  }

  return target;
}

async function reserveOrder(env) {
  const db = getD1(env);
  if (!db) {
    return await allocateOrderFromKV(env);
  }

  await seedOrderCounter(env);

  let row = await db
    .prepare(`
      UPDATE ${D1_COUNTERS_TABLE}
      SET value = value + 1
      WHERE name = ?
      RETURNING value
    `)
    .bind(D1_COUNTER_NAME)
    .first();

  let order = Number(row?.value || 0);

  if (!order) {
    await seedOrderCounter(env);
    row = await db
      .prepare(`
        UPDATE ${D1_COUNTERS_TABLE}
        SET value = value + 1
        WHERE name = ?
        RETURNING value
      `)
      .bind(D1_COUNTER_NAME)
      .first();
    order = Number(row?.value || 0);
  }

  if (order) return order;
  return await allocateOrderFromKV(env);
}

async function allocateOrderFromKV(env) {
  if (!env?.VIDEY_KV) return 1;

  const result = await env.VIDEY_KV.list({
    prefix: VIDEO_PREFIX,
    limit: 1000
  });

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

// ============================================================
// B2 AUTH
// ============================================================

async function getB2Auth(env) {
  const now = Date.now();

  if (b2AuthCache.token && b2AuthCache.expires > now + 60000) {
    return b2AuthCache;
  }

  const keyId = env?.B2_KEY_ID;
  const appKey = env?.B2_APP_KEY;

  if (!keyId || !appKey) {
    throw new Error("B2 credentials missing");
  }

  const authResp = await fetch(
    "https://api.backblazeb2.com/b2api/v2/b2_authorize_account",
    {
      headers: {
        "Authorization": "Basic " + btoa(`${keyId}:${appKey}`)
      }
    }
  );

  if (!authResp.ok) {
    const text = await safeReadText(authResp);
    throw new Error(
      `B2 auth failed: HTTP ${authResp.status} ${text.slice(0, 500)}`
    );
  }

  const authData = await authResp.json();

  b2AuthCache = {
    token: authData.authorizationToken,
    apiUrl: authData.apiUrl,
    downloadUrl: authData.downloadUrl,
    accountId: authData.accountId,
    recommendedPartSize: Number(authData.recommendedPartSize) || null,
    expires: now + (23 * 60 * 60 * 1000)
  };

  return b2AuthCache;
}

// ============================================================
// B2 BUCKET
// ============================================================

async function getB2BucketId(env, auth) {
  const bucketName = env?.B2_BUCKET_NAME;

  if (!bucketName) {
    throw new Error("B2_BUCKET_NAME belum disetting");
  }

  let bucketId = env?.B2_BUCKET_ID;
  if (bucketId) return bucketId;

  if (b2BucketCache.id && b2BucketCache.name === bucketName) {
    return b2BucketCache.id;
  }

  const listResp = await fetch(
    `${auth.apiUrl}/b2api/v2/b2_list_buckets`,
    {
      method: "POST",
      headers: {
        "Authorization": auth.token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        accountId: auth.accountId,
        bucketName
      })
    }
  );

  if (!listResp.ok) {
    const text = await safeReadText(listResp);
    throw new Error(
      `B2 list buckets failed: HTTP ${listResp.status} ${text.slice(0, 500)}`
    );
  }

  const listData = await listResp.json();

  const bucket = (listData.buckets || []).find(
    b => b.bucketName === bucketName
  );

  if (!bucket) {
    throw new Error(`B2 bucket '${bucketName}' tidak ditemukan`);
  }

  b2BucketCache = {
    id: bucket.bucketId,
    name: bucketName
  };

  return bucket.bucketId;
}

// ============================================================
// B2 START LARGE FILE
// ============================================================

async function b2StartLargeFile(env, fileName, contentType) {
  const auth = await getB2Auth(env);
  const bucketId = await getB2BucketId(env, auth);

  const resp = await fetch(
    `${auth.apiUrl}/b2api/v4/b2_start_large_file`,
    {
      method: "POST",
      headers: {
        "Authorization": auth.token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        bucketId,
        fileName,
        contentType: contentType || "video/mp4"
      })
    }
  );

  const text = await safeReadText(resp);

  if (!resp.ok) {
    throw new Error(
      `b2_start_large_file failed: HTTP ${resp.status} ${text.slice(0, 1000)}`
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("B2 start large file mengembalikan JSON tidak valid");
  }

  if (!data.fileId) {
    throw new Error("B2 start large file tidak mengembalikan fileId");
  }

  return {
    auth,
    bucketId,
    fileId: data.fileId,
    fileName: data.fileName || fileName
  };
}

// ============================================================
// B2 GET PART URL
// ============================================================

async function b2GetUploadPartUrl(env, fileId) {
  const auth = await getB2Auth(env);

  const resp = await fetch(
    `${auth.apiUrl}/b2api/v4/b2_get_upload_part_url`,
    {
      method: "POST",
      headers: {
        "Authorization": auth.token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fileId })
    }
  );

  const text = await safeReadText(resp);

  if (!resp.ok) {
    throw new Error(
      `b2_get_upload_part_url failed: HTTP ${resp.status} ${text.slice(0, 1000)}`
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("B2 part URL response bukan JSON valid");
  }

  if (!data.uploadUrl || !data.authorizationToken) {
    throw new Error("B2 part URL tidak lengkap");
  }

  return data;
}

// ============================================================
// B2 UPLOAD PART
// ============================================================

async function b2UploadPart(
  uploadData,
  partNumber,
  body,
  size,
  sha1,
  debug = false
) {
  if (!uploadData?.uploadUrl) {
    throw new Error("uploadUrl B2 kosong");
  }

  if (!body) {
    throw new Error("request.body kosong");
  }

  if (!Number.isInteger(partNumber)) {
    throw new Error("partNumber tidak valid");
  }

  if (partNumber < 1 || partNumber > MAX_B2_PARTS) {
    throw new Error(`partNumber harus 1-${MAX_B2_PARTS}`);
  }

  if (!Number.isInteger(size) || size <= 0) {
    throw new Error("Content-Length part tidak valid");
  }

  if (!/^[a-f0-9]{40}$/i.test(sha1)) {
    throw new Error("SHA1 part tidak valid");
  }

  const started = Date.now();

  const headers = new Headers();
  headers.set("Authorization", uploadData.authorizationToken);
  headers.set("X-Bz-Part-Number", String(partNumber));
  headers.set("Content-Length", String(size));
  headers.set("X-Bz-Content-Sha1", sha1.toLowerCase());
  headers.set("Content-Type", "application/octet-stream");

  const resp = await fetch(uploadData.uploadUrl, {
    method: "POST",
    headers,
    body
  });

  const text = await safeReadText(resp);
  const elapsed = Date.now() - started;

  if (!resp.ok) {
    if (debug) {
      console.log(
        "[B2 PART ERROR]",
        JSON.stringify({
          status: resp.status,
          elapsed,
          partNumber,
          size,
          sha1,
          response: text.slice(0, 1000)
        })
      );
    }
    throw new Error(
      `b2_upload_part failed: HTTP ${resp.status} ${text.slice(0, 1000)}`
    );
  }

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 1000) };
    }
  }

  if (debug) {
    console.log(
      "[B2 PART OK]",
      JSON.stringify({
        status: resp.status,
        elapsed,
        partNumber,
        size,
        sha1,
        fileId: data?.fileId || null,
        action: data?.action || null
      })
    );
  }

  return { ok: true, data };
}

// ============================================================
// B2 FINISH LARGE FILE
// ============================================================

async function b2FinishLargeFile(env, fileId, partSha1Array) {
  if (!fileId) throw new Error("fileId kosong");

  if (!Array.isArray(partSha1Array) || !partSha1Array.length) {
    throw new Error("partSha1Array kosong");
  }

  if (partSha1Array.length > MAX_B2_PARTS) {
    throw new Error(`Part terlalu banyak. Maks ${MAX_B2_PARTS}`);
  }

  for (const sha1 of partSha1Array) {
    if (!/^[a-f0-9]{40}$/i.test(sha1)) {
      throw new Error(`SHA1 tidak valid: ${sha1}`);
    }
  }

  const auth = await getB2Auth(env);

  const resp = await fetch(
    `${auth.apiUrl}/b2api/v4/b2_finish_large_file`,
    {
      method: "POST",
      headers: {
        "Authorization": auth.token,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fileId, partSha1Array })
    }
  );

  const text = await safeReadText(resp);

  if (!resp.ok) {
    throw new Error(
      `b2_finish_large_file failed: HTTP ${resp.status} ${text.slice(0, 1200)}`
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("B2 finish mengembalikan JSON tidak valid");
  }

  return data;
}

// ============================================================
// B2 IMAGE UPLOAD (SINGLE SHOT)
// ============================================================

async function b2UploadImage(file, fileName, contentType, env) {
  try {
    const auth = await getB2Auth(env);
    const bucketId = await getB2BucketId(env, auth);

    const getUrlResp = await fetch(
      `${auth.apiUrl}/b2api/v2/b2_get_upload_url`,
      {
        method: "POST",
        headers: {
          "Authorization": auth.token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ bucketId })
      }
    );

    if (!getUrlResp.ok) {
      return {
        ok: false,
        error: "B2 get_upload_url gagal",
        raw: (await safeReadText(getUrlResp)).slice(0, 1000)
      };
    }

    const uploadData = await getUrlResp.json();
    const arrayBuffer = await file.arrayBuffer();

    const uploadResp = await fetch(uploadData.uploadUrl, {
      method: "POST",
      headers: {
        "Authorization": uploadData.authorizationToken,
        "X-Bz-File-Name": encodeURIComponent(fileName),
        "Content-Type": contentType,
        "X-Bz-Content-Sha1": "do_not_verify",
        "Content-Length": String(arrayBuffer.byteLength)
      },
      body: arrayBuffer
    });

    if (!uploadResp.ok) {
      return {
        ok: false,
        error: "B2 upload image gagal",
        raw: (await safeReadText(uploadResp)).slice(0, 1000)
      };
    }

    const result = await uploadResp.json();

    const publicUrl =
      `${auth.downloadUrl}/file/` +
      `${encodeURIComponent(env.B2_BUCKET_NAME)}/` +
      `${encodeURIComponent(fileName)}`;

    return {
      ok: true,
      fileId: result.fileId,
      publicUrl,
      fileName
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err)
    };
  }
}

// ============================================================
// OLD B2 UPLOAD
// ============================================================

async function uploadToB2(file, slugBase, env) {
  const keyId = env?.B2_KEY_ID;
  const appKey = env?.B2_APP_KEY;
  const bucketName = env?.B2_BUCKET_NAME;

  if (!keyId || !appKey) {
    return {
      ok: false,
      error: "B2 credentials (B2_KEY_ID / B2_APP_KEY) belum disetting"
    };
  }

  if (!bucketName) {
    return {
      ok: false,
      error: "B2_BUCKET_NAME belum disetting"
    };
  }

  try {
    const auth = await getB2Auth(env);
    const bucketId = await getB2BucketId(env, auth);

    const getUrlResp = await fetch(
      `${auth.apiUrl}/b2api/v2/b2_get_upload_url`,
      {
        method: "POST",
        headers: {
          "Authorization": auth.token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ bucketId })
      }
    );

    if (!getUrlResp.ok) {
      return {
        ok: false,
        error: "B2 get upload url failed",
        raw: (await safeReadText(getUrlResp)).slice(0, 1000)
      };
    }

    const uploadData = await getUrlResp.json();
    const fileName = `${Date.now()}-${slugBase}.mp4`;
    const arrayBuffer = await file.arrayBuffer();

    const uploadResp = await fetch(uploadData.uploadUrl, {
      method: "POST",
      headers: {
        "Authorization": uploadData.authorizationToken,
        "X-Bz-File-Name": encodeURIComponent(fileName),
        "Content-Type": file.type || "video/mp4",
        "X-Bz-Content-Sha1": "do_not_verify",
        "Content-Length": String(arrayBuffer.byteLength)
      },
      body: arrayBuffer
    });

    if (!uploadResp.ok) {
      return {
        ok: false,
        error: "B2 upload gagal",
        raw: (await safeReadText(uploadResp)).slice(0, 1000)
      };
    }

    const uploadResult = await uploadResp.json();

    const publicUrl =
      `${auth.downloadUrl}/file/` +
      `${encodeURIComponent(bucketName)}/` +
      `${encodeURIComponent(fileName)}`;

    return {
      ok: true,
      b2FileId: uploadResult.fileId,
      publicUrl,
      fileName
    };
  } catch (err) {
    return {
      ok: false,
      error: err.message || String(err)
    };
  }
}

// ============================================================
// CHUNK HELPERS
// ============================================================

function getChunkSizeFromEnv(env) {
  const raw = Number(env?.B2_CHUNK_SIZE);
  if (
    Number.isFinite(raw) &&
    raw >= MIN_CHUNK_SIZE &&
    raw <= MAX_CHUNK_SIZE
  ) {
    return Math.floor(raw);
  }
  return DEFAULT_CHUNK_SIZE;
}

function getChunkSessionId(url, request) {
  return clean(
    url.searchParams.get("uploadId") ||
    request.headers.get("X-Upload-Id")
  );
}

function getPartNumber(url, request) {
  const value =
    url.searchParams.get("partNumber") ||
    request.headers.get("X-Part-Number");

  const n = Number.parseInt(String(value || ""), 10);

  if (!Number.isInteger(n) || n < 1 || n > MAX_B2_PARTS) {
    return null;
  }
  return n;
}

function getChunkSha1(request) {
  return clean(request.headers.get("X-Chunk-Sha1") || "").toLowerCase();
}

function getChunkContentLength(request) {
  const header = request.headers.get("Content-Length");
  const n = Number.parseInt(String(header || ""), 10);
  return Number.isInteger(n) ? n : null;
}

function validateUploadSize(fileSize, chunkSize) {
  if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
    throw new Error("fileSize tidak valid");
  }

  if (fileSize > MAX_UPLOAD_SIZE) {
    throw new Error("Ukuran file melebihi batas upload");
  }

  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < MIN_CHUNK_SIZE ||
    chunkSize > MAX_CHUNK_SIZE
  ) {
    throw new Error("chunkSize tidak valid");
  }

  const totalParts = Math.ceil(fileSize / chunkSize);

  if (totalParts < 2) {
    throw new Error(
      "Chunked upload dipakai untuk file besar. " +
      "Gunakan upload biasa untuk file kecil."
    );
  }

  if (totalParts > MAX_B2_PARTS) {
    throw new Error(
      `Jumlah part ${totalParts} melebihi maksimum ${MAX_B2_PARTS}`
    );
  }

  return totalParts;
}

function randomToken(bytes = UPLOAD_TOKEN_BYTES) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);

  let binary = "";
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function makeChunkHeaders(requestId) {
  return {
    "Cache-Control": "no-store",
    "X-Request-Id": requestId,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type, X-Upload-Id, X-Upload-Token, X-Part-Number, X-Chunk-Sha1, X-Chunk-Size, X-Upload-Debug",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS"
  };
}

async function readJsonRequest(request) {
  const text = await request.text();

  if (!text) throw new Error("JSON body kosong");

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("JSON body tidak valid");
  }
}

// ============================================================
// CHUNK INIT
// ============================================================

async function handleChunkInit(request, env, url, requestId) {
  const debug = isDebugRequest(request);
  const started = Date.now();

  try {
    const db = getD1(env);
    if (!db) {
      return jsonResponse(
        { ok: false, error: "d1_not_available", requestId },
        503,
        makeChunkHeaders(requestId)
      );
    }

    await ensureD1Schema(env);

    const body = await readJsonRequest(request);
    const title = clean(body.title);
    const fileNameInput = clean(body.fileName);
    const contentType = clean(body.contentType) || "video/mp4";
    const fileSize = Number(body.fileSize);
    let chunkSize = Number(body.chunkSize);

    if (!title) {
      return jsonResponse(
        { ok: false, error: "Judul wajib diisi", requestId },
        400,
        makeChunkHeaders(requestId)
      );
    }

    if (!Number.isSafeInteger(fileSize) || fileSize <= 0) {
      return jsonResponse(
        { ok: false, error: "fileSize wajib berupa integer positif", requestId },
        400,
        makeChunkHeaders(requestId)
      );
    }

    if (!Number.isInteger(chunkSize)) {
      chunkSize = getChunkSizeFromEnv(env);
    }

    chunkSize = Math.min(
      MAX_CHUNK_SIZE,
      Math.max(MIN_CHUNK_SIZE, Math.floor(chunkSize))
    );

    if (!body.chunkSize) {
      chunkSize = getChunkSizeFromEnv(env);
    }

    let totalParts;
    try {
      totalParts = validateUploadSize(fileSize, chunkSize);
    } catch (err) {
      return jsonResponse(
        { ok: false, error: err.message, requestId },
        400,
        makeChunkHeaders(requestId)
      );
    }

    const baseSlug = slugify(title);
    const extension = getSafeExtension(fileNameInput, contentType);
    const fileName = `${Date.now()}-${baseSlug}${extension}`;

    console.log(
      "[CHUNK INIT]",
      JSON.stringify({
        requestId,
        title,
        fileName,
        fileSize,
        chunkSize,
        totalParts,
        contentType
      })
    );

    const large = await b2StartLargeFile(env, fileName, contentType);
    const uploadId = crypto.randomUUID();
    const sessionToken = randomToken();
    const now = new Date().toISOString();

    await db
      .prepare(`
        INSERT INTO ${D1_UPLOAD_SESSIONS_TABLE}
        (
          upload_id,
          session_token,
          title,
          base_slug,
          file_name,
          content_type,
          file_size,
          chunk_size,
          total_parts,
          b2_file_id,
          created_at,
          updated_at,
          status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        uploadId,
        sessionToken,
        title,
        baseSlug,
        fileName,
        contentType,
        fileSize,
        chunkSize,
        totalParts,
        large.fileId,
        now,
        now,
        "active"
      )
      .run();

    const result = {
      ok: true,
      uploadId,
      uploadToken: sessionToken,
      fileName,
      fileSize,
      chunkSize,
      totalParts,
      minChunkSize: MIN_CHUNK_SIZE,
      maxChunkSize: MAX_CHUNK_SIZE,
      mode: "b2",
      method: "chunked-b2",
      expiresAt: new Date(Date.now() + CHUNK_UPLOAD_EXPIRY_MS).toISOString(),
      requestId
    };

    if (debug) {
      result.debug = {
        elapsedMs: Date.now() - started,
        b2FileId: large.fileId,
        b2BucketId: large.bucketId,
        recommendedPartSize: b2AuthCache.recommendedPartSize,
        source: "b2_start_large_file"
      };
    }

    return jsonResponse(result, 200, makeChunkHeaders(requestId));
  } catch (err) {
    console.error("[CHUNK INIT ERROR]", requestId, err);

    return jsonResponse(
      {
        ok: false,
        error: err.message || String(err),
        requestId,
        debug: debug
          ? { stage: "init", elapsedMs: Date.now() - started }
          : undefined
      },
      500,
      makeChunkHeaders(requestId)
    );
  }
}

// ============================================================
// CHUNK PART
// ============================================================

async function handleChunkPart(request, env, requestId) {
  const debug = isDebugRequest(request);
  const started = Date.now();

  try {
    const db = getD1(env);
    if (!db) {
      return jsonResponse(
        { ok: false, error: "d1_not_available", requestId },
        503,
        makeChunkHeaders(requestId)
      );
    }

    await ensureD1Schema(env);

    const url = new URL(request.url);
    const uploadId = getChunkSessionId(url, request);
    const partNumber = getPartNumber(url, request);
    const sessionToken = clean(request.headers.get("X-Upload-Token"));
    const sha1 = getChunkSha1(request);
    const contentLength = getChunkContentLength(request);

    if (!uploadId) {
      return jsonResponse(
        { ok: false, error: "uploadId wajib", requestId },
        400,
        makeChunkHeaders(requestId)
      );
    }

    if (!sessionToken) {
      return jsonResponse(
        { ok: false, error: "X-Upload-Token wajib", requestId },
        401,
        makeChunkHeaders(requestId)
      );
    }

    if (!partNumber) {
      return jsonResponse(
        { ok: false, error: "partNumber tidak valid", requestId },
        400,
        makeChunkHeaders(requestId)
      );
    }

    if (!sha1) {
      return jsonResponse(
        { ok: false, error: "X-Chunk-Sha1 wajib", requestId },
        400,
        makeChunkHeaders(requestId)
      );
    }

    if (!/^[a-f0-9]{40}$/i.test(sha1)) {
      return jsonResponse(
        { ok: false, error: "X-Chunk-Sha1 harus SHA1 40 hex", requestId },
        400,
        makeChunkHeaders(requestId)
      );
    }

    if (!contentLength || contentLength <= 0) {
      return jsonResponse(
        { ok: false, error: "Content-Length wajib dan harus > 0", requestId },
        400,
        makeChunkHeaders(requestId)
      );
    }

    if (contentLength > MAX_CHUNK_SIZE) {
      return jsonResponse(
        {
          ok: false,
          error: `Chunk terlalu besar. Maks ${MAX_CHUNK_SIZE} byte`,
          requestId
        },
        413,
        makeChunkHeaders(requestId)
      );
    }

    const session = await db
      .prepare(`
        SELECT *
        FROM ${D1_UPLOAD_SESSIONS_TABLE}
        WHERE upload_id = ?
        LIMIT 1
      `)
      .bind(uploadId)
      .first();

    if (!session) {
      return jsonResponse(
        { ok: false, error: "upload_session_not_found", requestId },
        404,
        makeChunkHeaders(requestId)
      );
    }

    if (session.session_token !== sessionToken) {
      return jsonResponse(
        { ok: false, error: "invalid_upload_token", requestId },
        403,
        makeChunkHeaders(requestId)
      );
    }

    if (session.status !== "active") {
      return jsonResponse(
        { ok: false, error: `Upload session status=${session.status}`, requestId },
        409,
        makeChunkHeaders(requestId)
      );
    }

    const createdAt = Date.parse(session.created_at);
    if (
      Number.isFinite(createdAt) &&
      Date.now() - createdAt > CHUNK_UPLOAD_EXPIRY_MS
    ) {
      return jsonResponse(
        { ok: false, error: "upload_session_expired", requestId },
        410,
        makeChunkHeaders(requestId)
      );
    }

    const totalParts = Number(session.total_parts);
    const expectedSize = getExpectedPartSize(
      Number(session.file_size),
      Number(session.chunk_size),
      totalParts,
      partNumber
    );

    if (partNumber < 1 || partNumber > totalParts) {
      return jsonResponse(
        { ok: false, error: "partNumber di luar rentang", requestId },
        400,
        makeChunkHeaders(requestId)
      );
    }

    if (contentLength !== expectedSize) {
      return jsonResponse(
        {
          ok: false,
          error: "Ukuran chunk tidak sesuai",
          expectedSize,
          receivedSize: contentLength,
          partNumber,
          requestId
        },
        400,
        makeChunkHeaders(requestId)
      );
    }

    const existing = await db
      .prepare(`
        SELECT part_number, sha1, size
        FROM ${D1_UPLOAD_PARTS_TABLE}
        WHERE upload_id = ? AND part_number = ?
        LIMIT 1
      `)
      .bind(uploadId, partNumber)
      .first();

    if (existing) {
      if (
        String(existing.sha1).toLowerCase() === sha1 &&
        Number(existing.size) === contentLength
      ) {
        console.log(
          "[CHUNK DUPLICATE]",
          JSON.stringify({ requestId, uploadId, partNumber, size: contentLength })
        );

        return jsonResponse(
          {
            ok: true,
            duplicate: true,
            uploadId,
            partNumber,
            size: contentLength,
            sha1,
            elapsedMs: Date.now() - started,
            requestId
          },
          200,
          makeChunkHeaders(requestId)
        );
      }

      return jsonResponse(
        {
          ok: false,
          error: "Part sudah ada dengan SHA1/size berbeda",
          requestId
        },
        409,
        makeChunkHeaders(requestId)
      );
    }

    if (!request.body) {
      return jsonResponse(
        { ok: false, error: "Request body kosong", requestId },
        400,
        makeChunkHeaders(requestId)
      );
    }

    console.log(
      "[CHUNK PART START]",
      JSON.stringify({
        requestId,
        uploadId,
        partNumber,
        totalParts,
        contentLength,
        expectedSize,
        sha1
      })
    );

    const uploadData = await b2GetUploadPartUrl(env, session.b2_file_id);

    const uploaded = await b2UploadPart(
      uploadData,
      partNumber,
      request.body,
      contentLength,
      sha1,
      debug
    );

    if (!uploaded.ok) {
      throw new Error("B2 upload part gagal");
    }

    const now = new Date().toISOString();

    await db
      .prepare(`
        INSERT OR REPLACE INTO ${D1_UPLOAD_PARTS_TABLE}
        (upload_id, part_number, sha1, size, uploaded_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .bind(uploadId, partNumber, sha1, contentLength, now)
      .run();

    await db
      .prepare(`
        UPDATE ${D1_UPLOAD_SESSIONS_TABLE}
        SET updated_at = ?
        WHERE upload_id = ?
      `)
      .bind(now, uploadId)
      .run();

    const partsRow = await db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM ${D1_UPLOAD_PARTS_TABLE}
        WHERE upload_id = ?
      `)
      .bind(uploadId)
      .first();

    const uploadedParts = Number(partsRow?.count || 0);

    const response = {
      ok: true,
      uploadId,
      partNumber,
      totalParts,
      size: contentLength,
      sha1,
      uploadedParts,
      remainingParts: Math.max(0, totalParts - uploadedParts),
      progress: Number(
        ((uploadedParts / totalParts) * 100).toFixed(2)
      ),
      requestId
    };

    if (debug) {
      response.debug = {
        elapsedMs: Date.now() - started,
        stage: "part",
        b2FileId: session.b2_file_id,
        bodyStream: true
      };
    }

    console.log("[CHUNK PART OK]", JSON.stringify(response));

    return jsonResponse(response, 200, makeChunkHeaders(requestId));
  } catch (err) {
    console.error("[CHUNK PART ERROR]", requestId, err);

    return jsonResponse(
      {
        ok: false,
        error: err.message || String(err),
        requestId,
        debug: debug
          ? { stage: "part", elapsedMs: Date.now() - started }
          : undefined
      },
      500,
      makeChunkHeaders(requestId)
    );
  }
}

// ============================================================
// CHUNK STATUS
// ============================================================

async function handleChunkStatus(request, env, requestId) {
  try {
    const db = getD1(env);
    if (!db) {
      return jsonResponse(
        { ok: false, error: "d1_not_available", requestId },
        503
      );
    }

    await ensureD1Schema(env);

    const url = new URL(request.url);
    const uploadId = clean(url.searchParams.get("uploadId"));
    const token = clean(request.headers.get("X-Upload-Token"));

    if (!uploadId) {
      return jsonResponse(
        { ok: false, error: "uploadId wajib", requestId },
        400
      );
    }

    if (!token) {
      return jsonResponse(
        { ok: false, error: "X-Upload-Token wajib", requestId },
        401
      );
    }

    const session = await db
      .prepare(`
        SELECT *
        FROM ${D1_UPLOAD_SESSIONS_TABLE}
        WHERE upload_id = ?
        LIMIT 1
      `)
      .bind(uploadId)
      .first();

    if (!session) {
      return jsonResponse(
        { ok: false, error: "upload_session_not_found", requestId },
        404
      );
    }

    if (session.session_token !== token) {
      return jsonResponse(
        { ok: false, error: "invalid_upload_token", requestId },
        403
      );
    }

    const partsResult = await db
      .prepare(`
        SELECT part_number, sha1, size, uploaded_at
        FROM ${D1_UPLOAD_PARTS_TABLE}
        WHERE upload_id = ?
        ORDER BY part_number ASC
      `)
      .bind(uploadId)
      .all();

    const parts = partsResult.results || [];

    return jsonResponse(
      {
        ok: true,
        uploadId,
        title: session.title,
        fileName: session.file_name,
        fileSize: Number(session.file_size),
        chunkSize: Number(session.chunk_size),
        totalParts: Number(session.total_parts),
        b2FileId: session.b2_file_id,
        status: session.status,
        uploadedParts: parts.length,
        missingParts: buildMissingParts(
          Number(session.total_parts),
          parts
        ),
        parts,
        progress: Number(
          ((parts.length / Number(session.total_parts)) * 100).toFixed(2)
        ),
        createdAt: session.created_at,
        updatedAt: session.updated_at,
        result: session.result_order
          ? {
              order: Number(session.result_order),
              slug: session.result_slug,
              b2FileName: session.b2_file_name
            }
          : null,
        requestId
      },
      200,
      makeChunkHeaders(requestId)
    );
  } catch (err) {
    console.error("[CHUNK STATUS]", requestId, err);
    return jsonResponse(
      { ok: false, error: err.message || String(err), requestId },
      500
    );
  }
}

// ============================================================
// CHUNK COMPLETE
// ============================================================

async function handleChunkComplete(request, env, url, requestId) {
  const debug = isDebugRequest(request);
  const started = Date.now();

  try {
    const db = getD1(env);
    if (!db) {
      return jsonResponse(
        { ok: false, error: "d1_not_available", requestId },
        503
      );
    }

    await ensureD1Schema(env);

    const body = await readJsonRequest(request);
    const uploadId = clean(body.uploadId);
    const uploadToken = clean(
      body.uploadToken || request.headers.get("X-Upload-Token")
    );

    if (!uploadId) {
      return jsonResponse(
        { ok: false, error: "uploadId wajib", requestId },
        400
      );
    }

    if (!uploadToken) {
      return jsonResponse(
        { ok: false, error: "uploadToken wajib", requestId },
        401
      );
    }

    const session = await db
      .prepare(`
        SELECT *
        FROM ${D1_UPLOAD_SESSIONS_TABLE}
        WHERE upload_id = ?
        LIMIT 1
      `)
      .bind(uploadId)
      .first();

    if (!session) {
      return jsonResponse(
        { ok: false, error: "upload_session_not_found", requestId },
        404
      );
    }

    if (session.session_token !== uploadToken) {
      return jsonResponse(
        { ok: false, error: "invalid_upload_token", requestId },
        403
      );
    }

    if (session.status === "complete") {
      const result = {
        ok: true,
        alreadyComplete: true,
        uploadId,
        order: Number(session.result_order),
        slug: session.result_slug,
        b2FileName: session.b2_file_name,
        publicUrl:
          `${url.origin}/${session.result_order}/${session.result_slug}.mp4`,
        apiUrl:
          `${url.origin}/api/video/${session.result_order}/${session.result_slug}`,
        requestId
      };

      if (debug) {
        result.debug = {
          stage: "complete-idempotent",
          elapsedMs: Date.now() - started
        };
      }

      return jsonResponse(result, 200);
    }

    if (session.status !== "active") {
      return jsonResponse(
        { ok: false, error: `Session status=${session.status}`, requestId },
        409
      );
    }

    const totalParts = Number(session.total_parts);
    const expectedFileSize = Number(session.file_size);

    const partsResult = await db
      .prepare(`
        SELECT part_number, sha1, size
        FROM ${D1_UPLOAD_PARTS_TABLE}
        WHERE upload_id = ?
        ORDER BY part_number ASC
      `)
      .bind(uploadId)
      .all();

    const parts = partsResult.results || [];

    if (parts.length !== totalParts) {
      return jsonResponse(
        {
          ok: false,
          error: "Belum semua chunk diterima",
          expectedParts: totalParts,
          uploadedParts: parts.length,
          missingParts: buildMissingParts(totalParts, parts),
          requestId
        },
        409
      );
    }

    let totalSize = 0;
    const sha1Array = [];

    for (let i = 0; i < parts.length; i++) {
      const row = parts[i];
      const partNumber = Number(row.part_number);

      if (partNumber !== i + 1) {
        return jsonResponse(
          {
            ok: false,
            error: "Nomor part tidak contiguous",
            expected: i + 1,
            actual: partNumber,
            requestId
          },
          409
        );
      }

      const size = Number(row.size);

      if (!Number.isInteger(size) || size <= 0) {
        return jsonResponse(
          {
            ok: false,
            error: `Ukuran part ${partNumber} tidak valid`,
            requestId
          },
          409
        );
      }

      totalSize += size;

      const sha1 = String(row.sha1 || "").toLowerCase();

      if (!/^[a-f0-9]{40}$/.test(sha1)) {
        return jsonResponse(
          {
            ok: false,
            error: `SHA1 part ${partNumber} tidak valid`,
            requestId
          },
          409
        );
      }

      sha1Array.push(sha1);
    }

    if (totalSize !== expectedFileSize) {
      return jsonResponse(
        {
          ok: false,
          error: "Total ukuran part tidak sama dengan fileSize",
          expectedSize: expectedFileSize,
          actualSize: totalSize,
          requestId
        },
        409
      );
    }

    console.log(
      "[CHUNK COMPLETE START]",
      JSON.stringify({
        requestId,
        uploadId,
        totalParts,
        expectedFileSize,
        totalSize,
        b2FileId: session.b2_file_id
      })
    );

    const finish = await b2FinishLargeFile(
      env,
      session.b2_file_id,
      sha1Array
    );

    const baseSlug = slugify(session.base_slug || session.title);
    const slugCandidate = await uniqueSlug(env, baseSlug);
    const createdAt = session.created_at;

    const publicSourceUrl =
      `${(await getB2Auth(env)).downloadUrl}/file/` +
      `${encodeURIComponent(env.B2_BUCKET_NAME)}/` +
      `${encodeURIComponent(session.file_name)}`;

    const saved = await saveRecord(env, {
      title: session.title,
      slug: slugCandidate,
      mode: "b2",
      mediaType: "video",
      contentType: session.content_type || "video/mp4",
      sourceUrl: publicSourceUrl,
      b2FileName: session.file_name,
      createdAt
    });

    const publicUrl = `${url.origin}/${saved.order}/${saved.slug}.mp4`;
    const apiUrl = `${url.origin}/api/video/${saved.order}/${saved.slug}`;
    const key = makeVideoKey(saved.order, saved.slug);

    const payload = {
      title: saved.title,
      slug: saved.slug,
      order: saved.order,
      mode: saved.mode,
      mediaType: "video",
      createdAt: saved.createdAt,
      sourceUrl: saved.sourceUrl,
      b2FileName: saved.b2FileName
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

    const now = new Date().toISOString();

    await db
      .prepare(`
        UPDATE ${D1_UPLOAD_SESSIONS_TABLE}
        SET
          status = ?,
          updated_at = ?,
          result_order = ?,
          result_slug = ?,
          b2_file_name = ?
        WHERE upload_id = ?
      `)
      .bind(
        "complete",
        now,
        saved.order,
        saved.slug,
        saved.b2FileName,
        uploadId
      )
      .run();

    const response = {
      ok: true,
      uploadId,
      alreadyComplete: false,
      order: saved.order,
      slug: saved.slug,
      title: saved.title,
      mode: "b2",
      mediaType: "video",
      publicUrl,
      apiUrl,
      b2FileName: saved.b2FileName,
      b2FileId: finish.fileId || session.b2_file_id,
      storage: {
        d1: !!saved.storedInD1,
        kv: kvMirrored
      },
      message: kvMirrored
        ? (saved.storedInD1
            ? "File B2 chunked berhasil diselesaikan dan metadata tersimpan di D1 + KV."
            : "File B2 chunked berhasil diselesaikan dan metadata tersimpan di KV.")
        : (saved.storedInD1
            ? "File B2 chunked berhasil diselesaikan dan metadata tersimpan di D1."
            : `File B2 chunked berhasil diselesaikan. Mirror KV gagal: ${kvError || "mirror dimatikan"}`),
      requestId
    };

    if (debug) {
      response.debug = {
        stage: "complete",
        elapsedMs: Date.now() - started,
        totalParts,
        totalSize,
        b2FileId: session.b2_file_id,
        b2Action: finish.action || "upload"
      };
    }

    console.log("[CHUNK COMPLETE OK]", JSON.stringify(response));

    return jsonResponse(response, 200);
  } catch (err) {
    console.error("[CHUNK COMPLETE ERROR]", requestId, err);

    return jsonResponse(
      {
        ok: false,
        error: err.message || String(err),
        requestId,
        debug: debug
          ? { stage: "complete", elapsedMs: Date.now() - started }
          : undefined
      },
      500
    );
  }
}

// ============================================================
// HANDLE IMAGE UPLOAD
// ============================================================

async function handleImageUpload(request, env, url, requestId) {
  const debug = isDebugRequest(request);
  const started = Date.now();

  try {
    const db = getD1(env);
    if (!db) {
      return jsonResponse(
        { ok: false, error: "d1_not_available", requestId },
        503
      );
    }

    await ensureD1Schema(env);

    const declaredLength = Number(
      request.headers.get("Content-Length") || 0
    );

    if (
      declaredLength > 0 &&
      declaredLength > MAX_IMAGE_SIZE + 512 * 1024
    ) {
      return jsonResponse(
        {
          ok: false,
          error: `Ukuran request melebihi batas ${MAX_IMAGE_SIZE} byte`,
          requestId
        },
        413
      );
    }

    const form = await request.formData();
    const title = clean(form.get("title"));
    const file = form.get("file");

    if (!title) {
      return jsonResponse(
        { ok: false, error: "Judul wajib diisi", requestId },
        400
      );
    }

    if (!(file instanceof File) || file.size <= 0) {
      return jsonResponse(
        { ok: false, error: "File gambar wajib dipilih", requestId },
        400
      );
    }

    if (file.size > MAX_IMAGE_SIZE) {
      return jsonResponse(
        {
          ok: false,
          error: `Ukuran gambar maksimum ${MAX_IMAGE_SIZE} byte`,
          requestId
        },
        413
      );
    }

    const contentType = file.type || "image/jpeg";

    if (!contentType.startsWith("image/")) {
      return jsonResponse(
        {
          ok: false,
          error: "Hanya file gambar (image/*) yang didukung",
          requestId
        },
        400
      );
    }

    const ext =
      IMAGE_MIME_TO_EXT[contentType] ||
      getSafeExtension(file.name, contentType) ||
      ".jpg";

    const baseSlug = slugify(title);
    const fileName = `${Date.now()}-${baseSlug}${ext}`;

    console.log(
      "[IMAGE UPLOAD]",
      JSON.stringify({
        requestId,
        title,
        fileName,
        size: file.size,
        contentType
      })
    );

    const upload = await b2UploadImage(file, fileName, contentType, env);

    if (!upload.ok) {
      return jsonResponse(
        {
          ok: false,
          error: `Upload gambar B2 gagal: ${upload.error}`,
          raw: upload.raw,
          requestId
        },
        502
      );
    }

    const slugCandidate = await uniqueSlug(env, baseSlug);
    const createdAt = new Date().toISOString();

    const saved = await saveRecord(env, {
      title,
      slug: slugCandidate,
      mode: "b2",
      mediaType: "image",
      contentType,
      sourceUrl: upload.publicUrl,
      b2FileName: upload.fileName,
      createdAt
    });

    const publicUrl = `${url.origin}/${saved.order}/${saved.slug}${ext}`;
    const apiUrl = `${url.origin}/api/video/${saved.order}/${saved.slug}`;

    let kvMirrored = false;
    let kvError = "";

    if (shouldMirrorKv(env) && env?.VIDEY_KV) {
      try {
        await env.VIDEY_KV.put(
          makeVideoKey(saved.order, saved.slug),
          JSON.stringify({
            title: saved.title,
            slug: saved.slug,
            order: saved.order,
            mode: saved.mode,
            mediaType: "image",
            contentType,
            createdAt: saved.createdAt,
            sourceUrl: saved.sourceUrl,
            b2FileName: saved.b2FileName
          })
        );
        kvMirrored = true;
      } catch (err) {
        kvError = err?.message || String(err);
      }
    }

    const response = {
      ok: true,
      mediaType: "image",
      contentType,
      order: saved.order,
      slug: saved.slug,
      title: saved.title,
      publicUrl,
      apiUrl,
      b2FileName: saved.b2FileName,
      b2FileId: upload.fileId,
      storage: {
        d1: !!saved.storedInD1,
        kv: kvMirrored
      },
      message: kvMirrored
        ? "Gambar berhasil diupload ke B2 dan metadata tersimpan di D1 + KV."
        : "Gambar berhasil diupload ke B2 dan metadata tersimpan di D1.",
      requestId
    };

    if (debug) {
      response.debug = {
        stage: "image-upload",
        elapsedMs: Date.now() - started,
        size: file.size
      };
    }

    return jsonResponse(response, 200);
  } catch (err) {
    console.error("[IMAGE UPLOAD ERROR]", requestId, err);

    return jsonResponse(
      {
        ok: false,
        error: err?.message || String(err),
        requestId,
        debug: debug
          ? { stage: "image-upload", elapsedMs: Date.now() - started }
          : undefined
      },
      500
    );
  }
}

// ============================================================
// UPLOAD DEBUG
// ============================================================

function isDebugRequest(request) {
  const header = request.headers.get(DEBUG_HEADER);
  if (header === "1" || header === "true") {
    return true;
  }

  const url = new URL(request.url);
  return url.searchParams.get("debug") === "1";
}

// ============================================================
// CHUNK UTILITIES
// ============================================================

function getExpectedPartSize(fileSize, chunkSize, totalParts, partNumber) {
  if (partNumber < totalParts) {
    return chunkSize;
  }
  return fileSize - chunkSize * (totalParts - 1);
}

function buildMissingParts(totalParts, parts) {
  const existing = new Set(
    (parts || []).map(p => Number(p.part_number))
  );

  const missing = [];
  for (let i = 1; i <= totalParts; i++) {
    if (!existing.has(i)) {
      missing.push(i);
    }
  }
  return missing;
}

function getSafeExtension(fileName, contentType) {
  const cleanName = String(fileName || "")
    .split("/")
    .pop()
    .split("\\")
    .pop();

  const match = cleanName.match(/(\.[a-zA-Z0-9]{1,10})$/);
  if (match) {
    return match[1].toLowerCase();
  }

  const map = {
    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/quicktime": ".mov",
    "video/x-msvideo": ".avi",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/avif": ".avif",
    "image/bmp": ".bmp",
    "image/tiff": ".tiff",
    "image/svg+xml": ".svg",
    "image/x-icon": ".ico"
  };

  return map[contentType] || ".mp4";
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// ============================================================
// KV
// ============================================================

function shouldMirrorKv(env) {
  const raw = env?.VIDEY_KV_WRITE_ENABLED;

  if (typeof raw === "boolean") {
    return raw;
  }

  if (typeof raw === "string") {
    return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
  }

  return DEFAULT_KV_MIRROR;
}

// ============================================================
// LEGACY UPLOAD
// ============================================================

async function handleUpload(request, env, url, requestId) {
  const contentLength = Number(
    request.headers.get("Content-Length") || 0
  );

  if (
    contentLength > 100 * 1024 * 1024 &&
    !request.headers.get("X-Upload-Debug")
  ) {
    return respondUploadError(
      "Request terlalu besar untuk upload biasa. Gunakan Chunked B2.",
      {
        mode: "b2",
        requestId,
        hint: "POST /api/upload/chunk/init"
      },
      413,
      request
    );
  }

  const form = await request.formData();
  const title = clean(form.get("title"));
  const visitorIdInput = clean(form.get("visitorId"));
  const sourceUrl = clean(form.get("sourceUrl"));
  const modeInput = clean(form.get("mode")).toLowerCase();
  const file = form.get("file");

  const visitorId = visitorIdInput || DEFAULT_VISITOR_ID;

  let mode = modeInput || (sourceUrl ? "proxy" : "videy");

  if (mode === "video") {
    mode = "videy";
  }

  if (!["videy", "proxy", "b2"].includes(mode)) {
    mode = sourceUrl ? "proxy" : "videy";
  }

  if (mode === "proxy" && !sourceUrl) {
    mode = "videy";
  }

  const createdAt = new Date().toISOString();

  if (!title) {
    return respondUploadError(
      "Judul wajib diisi.",
      { mode, requestId },
      400,
      request
    );
  }

  // PROXY
  if (mode === "proxy") {
    if (!isValidHttpUrl(sourceUrl)) {
      return respondUploadError(
        "URL sumber proxy tidak valid.",
        { mode, requestId },
        400,
        request
      );
    }

    const baseSlug = slugify(title);
    const slugCandidate = await uniqueSlug(env, baseSlug);

    const saved = await saveRecord(env, {
      title,
      slug: slugCandidate,
      mode: "proxy",
      sourceUrl,
      createdAt
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
      sourceUrl: saved.sourceUrl
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
          ? (saved.storedInD1
              ? "Proxy link tersimpan di D1 dan KV."
              : "Proxy link tersimpan di KV.")
          : (saved.storedInD1
              ? "Proxy link tersimpan di D1."
              : `Proxy link tersimpan di D1, mirror KV gagal: ${kvError || "mirror dimatikan"}`),
        storage: {
          d1: !!saved.storedInD1,
          kv: kvMirrored
        },
        requestId
      },
      request
    );
  }

  // B2 LEGACY
  if (mode === "b2") {
    if (!(file instanceof File) || file.size <= 0) {
      return respondUploadError(
        "File video/gambar wajib dipilih untuk mode B2.",
        { mode, requestId },
        400,
        request
      );
    }

    const baseSlug = slugify(title);
    const isImageFile = String(file.type || "").startsWith("image/");

    if (isImageFile) {
      if (file.size > MAX_IMAGE_SIZE) {
        return respondUploadError(
          `Ukuran gambar maksimum ${MAX_IMAGE_SIZE} byte.`,
          { mode, requestId },
          413,
          request
        );
      }

      const ext =
        IMAGE_MIME_TO_EXT[file.type] ||
        getSafeExtension(file.name, file.type) ||
        ".jpg";

      const imgFileName = `${Date.now()}-${baseSlug}${ext}`;

      const uploadImg = await b2UploadImage(
        file,
        imgFileName,
        file.type || "image/jpeg",
        env
      );

      if (!uploadImg.ok) {
        return respondUploadError(
          `Upload gambar B2 gagal: ${uploadImg.error}`,
          { mode, raw: uploadImg.raw, requestId },
          502,
          request
        );
      }

      const slugCandidateImg = await uniqueSlug(env, baseSlug);

      const savedImg = await saveRecord(env, {
        title,
        slug: slugCandidateImg,
        mode: "b2",
        mediaType: "image",
        contentType: file.type || "image/jpeg",
        sourceUrl: uploadImg.publicUrl,
        b2FileName: uploadImg.fileName,
        createdAt
      });

      const publicUrlImg = `${url.origin}/${savedImg.order}/${savedImg.slug}${ext}`;
      const apiUrlImg = `${url.origin}/api/video/${savedImg.order}/${savedImg.slug}`;

      return respondUploadSuccess(
        {
          publicUrl: publicUrlImg,
          apiUrl: apiUrlImg,
          order: savedImg.order,
          slug: savedImg.slug,
          mode,
          mediaType: "image",
          contentType: file.type || "image/jpeg",
          title,
          message: "Gambar B2 berhasil disimpan.",
          storage: { d1: !!savedImg.storedInD1, kv: false },
          requestId
        },
        request
      );
    }

    const upload = await uploadToB2(file, baseSlug, env);

    if (!upload.ok) {
      return respondUploadError(
        `Upload B2 gagal: ${upload.error}`,
        { mode, raw: upload.raw, requestId },
        502,
        request
      );
    }

    const slugCandidate = await uniqueSlug(env, baseSlug);

    const saved = await saveRecord(env, {
      title,
      slug: slugCandidate,
      mode: "b2",
      mediaType: "video",
      contentType: file.type || "video/mp4",
      sourceUrl: upload.publicUrl,
      b2FileName: upload.fileName,
      createdAt
    });

    const publicUrl = `${url.origin}/${saved.order}/${saved.slug}.mp4`;
    const apiUrl = `${url.origin}/api/video/${saved.order}/${saved.slug}`;
    const key = makeVideoKey(saved.order, saved.slug);

    const payload = {
      title: saved.title,
      slug: saved.slug,
      order: saved.order,
      mode: saved.mode,
      mediaType: "video",
      createdAt: saved.createdAt,
      sourceUrl: saved.sourceUrl,
      b2FileName: saved.b2FileName
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
          ? (saved.storedInD1
              ? "File B2 berhasil disimpan ke D1 dan KV."
              : "File B2 berhasil disimpan ke KV.")
          : (saved.storedInD1
              ? "File B2 berhasil disimpan ke D1."
              : `File B2 berhasil disimpan ke D1, mirror KV gagal: ${kvError || "mirror dimatikan"}`),
        storage: {
          d1: !!saved.storedInD1,
          kv: kvMirrored
        },
        requestId
      },
      request
    );
  }

  // VIDEY
  if (!(file instanceof File) || file.size <= 0) {
    return respondUploadError(
      "File video wajib dipilih.",
      { mode, requestId },
      400,
      request
    );
  }

  const upload = await uploadToVidey(file, visitorId, env);

  if (!upload.ok) {
    return respondUploadError(
      "Videy tidak mengembalikan ID video yang valid.",
      {
        mode,
        status: upload.status,
        contentType: upload.contentType,
        location: upload.location,
        rawJson: upload.rawJson,
        rawText: upload.rawText,
        requestId
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
    createdAt
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
    videyId: saved.videyId
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
        ? (saved.storedInD1
            ? "ID asli Videy berhasil disimpan ke D1 dan KV."
            : "ID asli Videy berhasil disimpan ke KV.")
        : (saved.storedInD1
            ? "ID asli Videy berhasil disimpan ke D1."
            : `ID asli Videy berhasil disimpan ke D1, mirror KV gagal: ${kvError || "mirror dimatikan"}`),
      storage: {
        d1: !!saved.storedInD1,
        kv: kvMirrored
      },
      requestId
    },
    request
  );
}

// ============================================================
// SAVE RECORD
// ============================================================

async function saveRecord(env, draft) {
  const db = getD1(env);

  if (!db) {
    const slug = await uniqueSlug(env, draft.slug);
    const order = await allocateOrderFromKV(env);

    return {
      ...draft,
      slug,
      order,
      storedInD1: false
    };
  }

  await ensureD1Schema(env);
  await seedOrderCounter(env);

  let order = await reserveOrder(env);
  let slug = draft.slug;

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await db
        .prepare(`
          INSERT INTO ${D1_VIDEOS_TABLE}
          (
            order_num,
            slug,
            title,
            mode,
            videy_id,
            source_url,
            b2_file_name,
            content_type,
            media_type,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          order,
          slug,
          draft.title,
          draft.mode,
          draft.videyId ?? null,
          draft.sourceUrl ?? null,
          draft.b2FileName ?? null,
          draft.contentType ?? null,
          draft.mediaType ?? null,
          draft.createdAt
        )
        .run();

      return {
        ...draft,
        slug,
        order,
        storedInD1: true
      };
    } catch (err) {
      if (!isUniqueConstraintError(err)) {
        throw err;
      }

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

// ============================================================
// KV unused
// ============================================================

async function getMaxOrderFromKvUnused() {
  return 0;
}

// ============================================================
// VIDEY UPLOAD
// ============================================================

async function uploadToVidey(file, visitorId, env) {
  const uploadUrlInput = env?.VIDEY_UPLOAD_URL || DEFAULT_UPLOAD_URL;
  const uploadField = env?.VIDEY_UPLOAD_FIELD || DEFAULT_UPLOAD_FIELD;

  const uploadTarget = new URL(uploadUrlInput);

  if (!uploadTarget.searchParams.has("visitorId")) {
    uploadTarget.searchParams.set("visitorId", visitorId);
  }

  const headers = {
    "User-Agent": "Mozilla/5.0",
    Accept: "application/json"
  };

  const formData = new FormData();
  formData.append(uploadField, file, file.name || "video.mp4");

  const resp = await fetch(uploadTarget.toString(), {
    method: "POST",
    headers,
    body: formData,
    redirect: "follow"
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
    rawText: rawText ? rawText.slice(0, MAX_DEBUG_TEXT) : ""
  };
}

// ============================================================
// VIDEO / IMAGE SERVING
// ============================================================

async function serveVideoByRoute(route, request, env) {
  const record = await findRecordByRoute(env, route);

  if (!record) {
    return textResponse("File tidak ditemukan", 404);
  }

  if (record.mode === "proxy") {
    return await proxyToUpstream(record.sourceUrl, request, record);
  }

  if (record.mode === "b2") {
    return await streamFromB2(record, request, env);
  }

  if (!record.videyId) {
    return textResponse("videyId kosong", 500);
  }

  const upstreamUrl =
    `${CDN_BASE}/${encodeURIComponent(record.videyId)}.mp4`;

  return await proxyToUpstream(upstreamUrl, request, record);
}

async function streamFromB2(record, request, env) {
  if (!record.b2FileName) {
    return textResponse("B2 filename missing di Database", 500);
  }

  const auth = await getB2Auth(env);
  const bucketName = env?.B2_BUCKET_NAME || "videy-bucket";

  const downloadUrl =
    `${auth.downloadUrl}/file/` +
    `${encodeURIComponent(bucketName)}/` +
    `${encodeURIComponent(record.b2FileName)}`;

  const headers = new Headers();

  copyHeader(request.headers, headers, "Range");
  copyHeader(request.headers, headers, "If-Range");
  copyHeader(request.headers, headers, "Accept");
  copyHeader(request.headers, headers, "User-Agent");
  copyHeader(request.headers, headers, "Origin");
  copyHeader(request.headers, headers, "Referer");

  headers.set("Authorization", auth.token);

  const upstreamResp = await fetch(downloadUrl, {
    method: "GET",
    headers,
    redirect: "follow"
  });

  if (!upstreamResp.ok && upstreamResp.status !== 206) {
    return textResponse(
      `B2 download failed: ${upstreamResp.status}`,
      upstreamResp.status
    );
  }

  const responseHeaders = new Headers(upstreamResp.headers);

  const ext = "." + String(record.b2FileName || "")
    .split(".")
    .pop()
    .toLowerCase();

  const isImage = record.mediaType === "image";

  const inferredType = isImage
    ? (IMAGE_EXT_TO_MIME[ext] || "application/octet-stream")
    : "video/mp4";

  responseHeaders.set(
    "Content-Type",
    record.contentType || inferredType
  );

  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Cache-Control", "public, max-age=3600");
  responseHeaders.set("X-Video-Order", String(record.order ?? ""));
  responseHeaders.set("X-Video-Slug", record.slug || "");
  responseHeaders.set("X-Video-Title", record.title || "");

  if (!responseHeaders.get("Accept-Ranges")) {
    responseHeaders.set("Accept-Ranges", "bytes");
  }

  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers: responseHeaders
  });
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
    redirect: "follow"
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
    headers
  });
}

// ============================================================
// API VIDEO
// ============================================================

async function handleApiVideo(env, order, slug) {
  const record = await findRecordByRoute(env, { order, slug });

  if (!record) {
    return jsonResponse({ ok: false, error: "not_found" }, 404);
  }

  return jsonResponse({
    ok: true,
    data: publicRecord(record)
  });
}

// ============================================================
// LIST
// ============================================================

async function handleList(env, url, request) {
  const db = getD1(env);

  if (!db) {
    if (request && !wantsJson(request)) {
      return htmlResponse("<h1>D1 Database tidak tersedia</h1>", 503);
    }
    return jsonResponse(
      { ok: false, error: "d1_not_available" },
      503
    );
  }

  await ensureD1Schema(env);

  const { page, limit, offset } = parsePagination(
    url,
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT
  );

  const result = await db
    .prepare(`
      SELECT
        order_num AS order_num,
        slug,
        title,
        mode,
        videy_id AS videyId,
        source_url AS sourceUrl,
        b2_file_name AS b2FileName,
        content_type AS contentType,
        media_type AS mediaType,
        created_at AS createdAt
      FROM ${D1_VIDEOS_TABLE}
      ORDER BY order_num ASC
      LIMIT ? OFFSET ?
    `)
    .bind(limit + 1, offset)
    .all();

  const rows = result?.results || [];
  const hasMore = rows.length > limit;

  const items = rows.slice(0, limit).map(row =>
    publicRecord(normalizeRecord(row))
  );

  if (request && !wantsJson(request)) {
    return renderListHtml(items, hasMore, page, limit, url, "D1");
  }

  return jsonResponse({
    ok: true,
    source: "d1",
    page,
    limit,
    hasMore,
    nextPage: hasMore ? page + 1 : null,
    nextPageUrl: hasMore
      ? `${url.origin}/api/list?page=${page + 1}&limit=${limit}`
      : null,
    items
  });
}

// ============================================================
// LEGACY KV LIST
// ============================================================

async function handleLegacyList(env, url, request) {
  const kv = env?.VIDEY_KV;

  if (!kv) {
    if (request && !wantsJson(request)) {
      return htmlResponse("<h1>KV tidak tersedia</h1>", 503);
    }
    return jsonResponse(
      { ok: false, error: "kv_not_available" },
      503
    );
  }

  const { limit, cursor } = parseKvPagination(url);

  const listArgs = {
    prefix: VIDEO_PREFIX,
    limit: limit + 1
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
      items.push(publicRecord(normalizeRecord(JSON.parse(raw))));
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

  const nextCursor = hasMore ? (result?.cursor || null) : null;

  if (request && !wantsJson(request)) {
    return renderLegacyListHtml(items, hasMore, nextCursor, limit, url);
  }

  return jsonResponse({
    ok: true,
    source: "kv",
    limit,
    hasMore,
    nextCursor,
    listComplete: !!result?.list_complete,
    items
  });
}

// ============================================================
// FIND RECORD
// ============================================================

async function findRecordByRoute(env, route) {
  const db = getD1(env);

  if (db) {
    await ensureD1Schema(env);

    if (route.order && route.slug) {
      const row = await db
        .prepare(`
          SELECT
            order_num AS order_num,
            slug,
            title,
            mode,
            videy_id AS videyId,
            source_url AS sourceUrl,
            b2_file_name AS b2FileName,
            content_type AS contentType,
            media_type AS mediaType,
            created_at AS createdAt
          FROM ${D1_VIDEOS_TABLE}
          WHERE order_num = ? AND slug = ?
          LIMIT 1
        `)
        .bind(Number(route.order), route.slug)
        .first();

      if (row) return normalizeRecord(row);
    }

    if (route.slug) {
      const row = await db
        .prepare(`
          SELECT
            order_num AS order_num,
            slug,
            title,
            mode,
            videy_id AS videyId,
            source_url AS sourceUrl,
            b2_file_name AS b2FileName,
            content_type AS contentType,
            media_type AS mediaType,
            created_at AS createdAt
          FROM ${D1_VIDEOS_TABLE}
          WHERE slug = ?
          ORDER BY order_num DESC
          LIMIT 1
        `)
        .bind(route.slug)
        .first();

      if (row) return normalizeRecord(row);
    }
  }

  const kv = env?.VIDEY_KV;
  if (!kv) return null;

  const result = await kv.list({
    prefix: VIDEO_PREFIX,
    limit: 1000
  });

  for (const key of result.keys) {
    const raw = await kv.get(key.name);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw);

      if (route.order && route.slug) {
        if (
          String(record.order) === String(route.order) &&
          record.slug === route.slug
        ) {
          return normalizeRecord(record);
        }
      } else if (route.slug) {
        if (record.slug === route.slug) {
          return normalizeRecord(record);
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

// ============================================================
// SLUG
// ============================================================

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
      .prepare(`
        SELECT 1 AS found
        FROM ${D1_VIDEOS_TABLE}
        WHERE slug = ?
        LIMIT 1
      `)
      .bind(slug)
      .first();

    if (row) return true;
  }

  const kv = env?.VIDEY_KV;
  if (!kv) return false;

  const result = await kv.list({
    prefix: VIDEO_PREFIX,
    limit: 1000
  });

  for (const key of result.keys) {
    const raw = await kv.get(key.name);
    if (!raw) continue;
    try {
      if (JSON.parse(raw).slug === slug) {
        return true;
      }
    } catch {
      continue;
    }
  }

  return false;
}

// ============================================================
// ROUTES
// ============================================================

function makeVideoKey(order, slug) {
  return `${VIDEO_PREFIX}${String(order)}:${String(slug)}`;
}

function parsePublicRoute(pathname) {
  const m1 = pathname.match(
    /^\/(\d+)\/([^/]+)\.([a-zA-Z0-9]{2,5})$/i
  );

  if (m1) {
    const ext = "." + m1[3].toLowerCase();
    return {
      order: m1[1],
      slug: decodeURIComponentSafe(m1[2]),
      ext,
      isImage: !!IMAGE_EXT_TO_MIME[ext]
    };
  }

  const m2 = pathname.match(
    /^\/([^/]+)\.([a-zA-Z0-9]{2,5})$/i
  );

  if (m2) {
    const ext = "." + m2[2].toLowerCase();
    return {
      order: null,
      slug: decodeURIComponentSafe(m2[1]),
      ext,
      isImage: !!IMAGE_EXT_TO_MIME[ext]
    };
  }

  return null;
}

function parseApiVideoPath(pathname) {
  const rest = pathname.slice("/api/video/".length);

  const m = rest.match(
    /^(\d+)\/([^/]+)(?:\.(?:mp4|jpg|jpeg|png|gif|webp|avif|bmp|tiff|svg|ico))?$/i
  );

  if (m) {
    return {
      order: m[1],
      slug: decodeURIComponentSafe(m[2])
    };
  }

  return {
    order: null,
    slug: decodeURIComponentSafe(
      rest.replace(
        /\.(?:mp4|jpg|jpeg|png|gif|webp|avif|bmp|tiff|svg|ico)$/i,
        ""
      )
    )
  };
}

// ============================================================
// NORMALIZERS
// ============================================================

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

function normalizeRecord(record) {
  if (!record || typeof record !== "object") {
    return record;
  }

  const order = Number(
    record.order ??
    record.order_num ??
    record.orderNum ??
    0
  ) || null;

  return {
    title: record.title ?? "",
    slug: record.slug ?? "",
    order,
    mode: record.mode ?? "",
    createdAt: record.createdAt ?? record.created_at ?? "",
    videyId: record.videyId ?? record.videy_id ?? null,
    sourceUrl: record.sourceUrl ?? record.source_url ?? null,
    b2FileName: record.b2FileName ?? record.b2_file_name ?? null,
    contentType: record.contentType ?? record.content_type ?? null,
    mediaType: record.mediaType ?? record.media_type ?? null
  };
}

function publicRecord(record) {
  const n = normalizeRecord(record);

  if (!n || typeof n !== "object") {
    return record;
  }

  const out = {
    title: n.title,
    slug: n.slug,
    order: n.order,
    mode: n.mode,
    createdAt: n.createdAt
  };

  if (n.mode === "videy" && n.videyId) {
    out.videyId = n.videyId;
  }

  if (n.mediaType) {
    out.mediaType = n.mediaType;
  }

  if (n.contentType) {
    out.contentType = n.contentType;
  }

  return out;
}

// ============================================================
// ID EXTRACT
// ============================================================

function extractIdFromJson(data) {
  if (!data || typeof data !== "object") {
    return null;
  }

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
    data.response?.videyId
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      return c.trim();
    }
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
    /([A-Za-z0-9_-]{5,})/i
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m?.[1]) {
      return m[1];
    }
  }

  return null;
}

// ============================================================
// HEADERS
// ============================================================

function copyHeader(src, dst, name) {
  const val = src.get(name);
  if (val) {
    dst.set(name, val);
  }
}

function wantsJson(request) {
  const accept = request.headers.get("accept") || "";
  const xrw = request.headers.get("x-requested-with") || "";

  return (
    accept.includes("application/json") ||
    xrw.toLowerCase() === "xmlhttprequest"
  );
}

// ============================================================
// INTEGER PARSING
// ============================================================

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
  const limit = clampInt(
    url.searchParams.get("limit"),
    defaultLimit,
    1,
    maxLimit
  );

  return {
    page,
    limit,
    offset: (page - 1) * limit
  };
}

function parseKvPagination(url) {
  const limit = clampInt(
    url.searchParams.get("limit"),
    DEFAULT_LEGACY_LIMIT,
    1,
    MAX_LEGACY_LIMIT
  );

  const cursor = clean(url.searchParams.get("cursor"));

  return {
    limit,
    cursor: cursor || null
  };
}

// ============================================================
// ERRORS / RESPONSE
// ============================================================

function isUniqueConstraintError(err) {
  const msg = String(err?.message || err || "");
  return /UNIQUE constraint failed|constraint failed|PRIMARY KEY constraint failed/i.test(msg);
}

function respondUploadSuccess(payload, request) {
  if (wantsJson(request)) {
    return jsonResponse({ ok: true, ...payload }, 200);
  }
  return htmlResponse(renderResultBlock(payload));
}

function respondUploadError(message, data, status, request) {
  if (wantsJson(request)) {
    return jsonResponse(
      { ok: false, error: message, data },
      status
    );
  }

  return htmlResponse(
    renderResultBlock({
      title: "Upload gagal",
      message,
      data,
      color: "red"
    }),
    status
  );
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(
    JSON.stringify(obj, null, 2),
    {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...extraHeaders
      }
    }
  );
}

function htmlResponse(html, status = 200, extraHeaders = {}) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

function textResponse(text, status = 200, extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

// ============================================================
// HTML HOME
// ============================================================

function renderHome(url) {
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MyBlobVidey</title>

<style>
body{
  font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
  max-width:920px;
  margin:40px auto;
  padding:0 16px;
  line-height:1.5
}
.box{border:1px solid #ddd;border-radius:12px;padding:16px;margin:12px 0}
a{color:#2563eb;text-decoration:none}
code{background:#f4f4f5;padding:2px 6px;border-radius:6px}
ul{margin:8px 0 0 18px}
.debug{margin-top:16px;padding:12px;border-radius:12px;background:#f7f7f7;border:1px solid #ddd}
</style>
</head>

<body>

<h1>MyBlobVidey</h1>

<div class="box">
  <p>Polos, minimalis, dan tetap lincah.</p>
  <p>
    <a href="/api/upload">Buka uploader</a>
    |
    <a href="/api/list">Lihat Daftar Video</a>
    |
    <a href="/api/list/legacy">KV Legacy</a>
  </p>
</div>

<div class="box">
<strong>Format URL publik</strong>
<ul>
  <li><code>${escapeHtml(url.origin)}/1/judul-video.mp4</code></li>
  <li><code>${escapeHtml(url.origin)}/judul-video.mp4</code></li>
  <li><code>${escapeHtml(url.origin)}/1/foto.jpg</code> &mdash; gambar B2</li>
</ul>
</div>

<div class="debug">
<strong>Chunk B2 &amp; Gambar</strong>
<p>
File video B2 besar memakai Large File API, 50 MiB per chunk.
Gambar B2 (max 25 MiB) diupload via endpoint
<code>/api/upload/image</code>.
</p>
</div>

</body>
</html>`;
}

// ============================================================
// HTML UPLOADER (FIXED — no nested template literals)
// ============================================================

function renderUploadPage() {
  return `<!doctype html>
<html lang="id">

<head>

<meta charset="utf-8">

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>Upload</title>

<style>

body{
  font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
  max-width:760px;
  margin:40px auto;
  padding:0 16px;
  line-height:1.5
}

.box{
  border:1px solid #ddd;
  border-radius:12px;
  padding:16px
}

label{
  display:block;
  margin:12px 0 6px
}

input,
button{
  width:100%;
  box-sizing:border-box;
  padding:10px;
  border:1px solid #ccc;
  border-radius:10px;
  font:inherit
}

button{
  cursor:pointer;
  background:#111;
  color:#fff;
  border:none;
  margin-top:14px
}

button:disabled{
  opacity:.7;
  cursor:not-allowed
}

small{
  color:#666
}

progress{
  width:100%;
  height:16px
}

pre{
  white-space:pre-wrap;
  background:#f6f6f6;
  border:1px solid #ddd;
  padding:12px;
  border-radius:12px;
  overflow:auto
}

.row{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:10px
}

.muted{
  color:#666;
  font-size:.95rem
}

.hidden{
  display:none
}

.radioRow{
  display:flex;
  gap:14px;
  flex-wrap:wrap;
  margin:8px 0 4px
}

.radioRow label{
  display:flex;
  gap:6px;
  align-items:center;
  margin:0
}

.block{
  border:1px solid #ddd;
  border-radius:12px;
  padding:14px;
  margin-top:16px
}

.blockTitle{
  font-weight:700;
  margin-bottom:8px
}

.urlRow{
  display:grid;
  grid-template-columns:1fr auto;
  gap:8px;
  align-items:center;
  margin-top:10px
}

.urlRow input{
  width:100%
}

.copyBtn{
  width:auto;
  min-width:86px;
  padding:10px 12px;
  background:#f3f4f6;
  color:#111;
  border:1px solid #ccc
}

.actions{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
  margin-top:12px
}

.secondary{
  display:inline-block;
  padding:10px 12px;
  border:1px solid #ccc;
  border-radius:10px;
  color:#111;
  text-decoration:none;
  background:#f9f9f9
}

.hint{
  margin-top:8px;
  color:#666;
  font-size:.95rem
}

.status{
  margin-top:12px;
  font-weight:600
}

.chunkInfo{
  display:grid;
  grid-template-columns:1fr 1fr 1fr;
  gap:8px;
  margin-top:12px
}

.chunkCard{
  border:1px solid #ddd;
  border-radius:10px;
  padding:10px;
  background:#fafafa
}

@media(max-width:600px){
  .chunkInfo{
    grid-template-columns:1fr
  }
}

</style>

</head>

<body>

<h1>Uploader</h1>

<div class="box">

<form
id="uploadForm"
method="POST"
enctype="multipart/form-data"
>

<label>Judul</label>

<input
name="title"
required
placeholder="contoh: kucing-lucu"
>

<div
class="radioRow"
aria-label="Mode upload"
>

<label>
<input
type="radio"
name="mode"
value="video"
checked
>
Upload video (Videy)
</label>

<label>
<input
type="radio"
name="mode"
value="b2"
>
Upload video (B2)
</label>

<label>
<input
type="radio"
name="mode"
value="image"
>
Upload gambar (B2 only)
</label>

<label>
<input
type="radio"
name="mode"
value="proxy"
>
Upload link (Proxy)
</label>

</div>

<div id="videoFields">

<label>File video / gambar</label>

<input
type="file"
name="file"
accept="video/*"
>

</div>

<div
id="proxyFields"
class="hidden"
>

<label>Link video sumber</label>

<input
name="sourceUrl"
placeholder="https://example.com/video.mp4"
>

</div>

<label>
visitorId
(opsional - khusus Videy)
</label>

<input
name="visitorId"
placeholder="1f5f718b-06b2-40f9-82da-0a73dfdadd1c"
>

<button
id="submitBtn"
type="submit"
>
Upload
</button>

<div class="hint">
Mode Videy upload ke Videy.
Mode B2 memakai Chunked Large File otomatis untuk file besar.
Mode Gambar khusus upload gambar ke B2 (max 25 MiB).
Mode Proxy hanya menyimpan link sumber.
</div>

</form>

<div
class="chunkInfo"
id="chunkInfo"
hidden
>

<div class="chunkCard">
<strong>Mode</strong>
<div id="chunkMode">-</div>
</div>

<div class="chunkCard">
<strong>Chunk</strong>
<div id="chunkSize">-</div>
</div>

<div class="chunkCard">
<strong>Part</strong>
<div id="chunkPart">-</div>
</div>

</div>

<div
style="margin-top:14px"
>

<progress
id="progressBar"
value="0"
max="100"
hidden
>
</progress>

<div
class="status"
id="statusText"
>
Siap
</div>

</div>

<div
id="resultWrap"
class="block hidden"
>
</div>

</div>

<p>
<small>
Semua tetap polos, ringan, dan ramah mata.
</small>
</p>

<script>

var form=document.getElementById("uploadForm");
var submitBtn=document.getElementById("submitBtn");
var progressBar=document.getElementById("progressBar");
var statusText=document.getElementById("statusText");
var resultWrap=document.getElementById("resultWrap");
var videoFields=document.getElementById("videoFields");
var proxyFields=document.getElementById("proxyFields");
var chunkInfo=document.getElementById("chunkInfo");
var chunkMode=document.getElementById("chunkMode");
var chunkSizeEl=document.getElementById("chunkSize");
var chunkPartEl=document.getElementById("chunkPart");
var modeRadios=Array.prototype.slice.call(form.querySelectorAll('input[name="mode"]'));

function esc(s){
  return String(s==null?"":s)
    .replace(/&/g,"&amp;")
    .replace(/</g,"&lt;")
    .replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;")
    .replace(/'/g,"&#39;");
}

function currentMode(){
  var c=form.querySelector('input[name="mode"]:checked');
  return c?c.value:"video";
}

function toggleMode(){
  var m=currentMode();
  if(m==="proxy"){
    proxyFields.classList.remove("hidden");
    videoFields.classList.add("hidden");
  }else{
    proxyFields.classList.add("hidden");
    videoFields.classList.remove("hidden");
  }
  chunkInfo.hidden=(m!=="b2");
  var fi=form.querySelector('input[type="file"]');
  if(fi){
    fi.setAttribute("accept",m==="image"?"image/*":"video/*");
  }
}

function setStatus(t){statusText.textContent=t;}

function setLoading(on){
  submitBtn.disabled=on;
  if(on){progressBar.hidden=false;progressBar.value=0;}
  else{progressBar.hidden=true;progressBar.value=0;}
}

function setChunkInfo(mode,size,part){
  chunkMode.textContent=mode||"-";
  chunkSizeEl.textContent=size||"-";
  chunkPartEl.textContent=part||"-";
}

function formatBytes(bytes){
  if(!isFinite(bytes))return "-";
  var u=["B","KB","MB","GB","TB"];
  var v=bytes,i=0;
  while(v>=1024&&i<u.length-1){v/=1024;i++;}
  return (v>=100?v.toFixed(0):v.toFixed(2))+" "+u[i];
}

function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}

function sha1Hex(buf){
  return crypto.subtle.digest("SHA-1",buf).then(function(h){
    var b=new Uint8Array(h),o="";
    for(var i=0;i<b.length;i++){o+=b[i].toString(16).padStart(2,"0");}
    return o;
  });
}

function jsonFetch(url,opt){
  opt=opt||{};
  return fetch(url,opt).then(function(res){
    return res.text().then(function(txt){
      var data;
      try{data=txt?JSON.parse(txt):{};}catch(e){data={ok:false,error:txt||("HTTP "+res.status)};}
      if(!res.ok){
        var err=new Error(data.error||("HTTP "+res.status));
        err.status=res.status;
        err.data=data;
        throw err;
      }
      return data;
    });
  });
}

function initChunkUpload(file,title){
  return jsonFetch("/api/upload/chunk/init",{
    method:"POST",
    headers:{"Content-Type":"application/json","Accept":"application/json","X-Upload-Debug":"1"},
    body:JSON.stringify({title:title,fileName:file.name,contentType:file.type||"video/mp4",fileSize:file.size})
  });
}

function uploadOneChunk(upload,file,partNumber){
  var start=(partNumber-1)*upload.chunkSize;
  var end=Math.min(file.size,start+upload.chunkSize);
  var blob=file.slice(start,end);
  return blob.arrayBuffer().then(function(buf){
    return sha1Hex(buf).then(function(sha1){
      setChunkInfo("B2 Chunk",formatBytes(blob.size),partNumber+"/"+upload.totalParts);
      var url="/api/upload/chunk/part?uploadId="+encodeURIComponent(upload.uploadId)+"&partNumber="+partNumber;
      return jsonFetch(url,{
        method:"PUT",
        headers:{
          "Content-Type":"application/octet-stream",
          "Accept":"application/json",
          "X-Upload-Token":upload.uploadToken,
          "X-Part-Number":String(partNumber),
          "X-Chunk-Sha1":sha1,
          "X-Chunk-Size":String(blob.size),
          "X-Upload-Debug":"1"
        },
        body:buf
      });
    });
  });
}

function uploadChunkWithRetry(upload,file,partNumber,retries){
  retries=retries||3;
  var last;
  function attemptOne(a){
    setStatus("Upload part "+partNumber+"/"+upload.totalParts+"...");
    return uploadOneChunk(upload,file,partNumber).catch(function(err){
      last=err;
      console.warn("chunk retry",{partNumber:partNumber,attempt:a,error:err&&err.message?err.message:String(err)});
      if(a<retries){
        setStatus("Part "+partNumber+" gagal, retry "+(a+1)+"/"+retries+"...");
        return sleep(700*a).then(function(){return attemptOne(a+1);});
      }
      throw last;
    });
  }
  return attemptOne(1);
}

function completeChunkUpload(upload){
  return jsonFetch("/api/upload/chunk/complete",{
    method:"POST",
    headers:{"Content-Type":"application/json","Accept":"application/json","X-Upload-Token":upload.uploadToken,"X-Upload-Debug":"1"},
    body:JSON.stringify({uploadId:upload.uploadId,uploadToken:upload.uploadToken})
  });
}

function statusChunkUpload(upload){
  var url="/api/upload/chunk/status?uploadId="+encodeURIComponent(upload.uploadId);
  return jsonFetch(url,{
    method:"GET",
    headers:{"Accept":"application/json","X-Upload-Token":upload.uploadToken}
  });
}

function uploadB2Chunked(file,title){
  var upload;
  return initChunkUpload(file,title).then(function(u){
    upload=u;
    console.log("[CHUNK INIT]",upload);
    setChunkInfo("B2 Chunk",formatBytes(upload.chunkSize),"0/"+upload.totalParts);
    localStorage.setItem("videy_last_chunk_upload",JSON.stringify({uploadId:upload.uploadId,uploadToken:upload.uploadToken,fileName:file.name}));
    var part=1;
    function nextPart(){
      if(part>upload.totalParts)return Promise.resolve();
      var currentPart=part;
      return uploadChunkWithRetry(upload,file,currentPart).then(function(r){
        var p=Number(r.progress||(currentPart/upload.totalParts*100));
        progressBar.value=p;
        setStatus("Part "+currentPart+"/"+upload.totalParts+" selesai ("+p.toFixed(1)+"%)");
        part++;
        return nextPart();
      });
    }
    return nextPart();
  }).then(function(){
    setStatus("Semua chunk selesai. B2 sedang menyatukan file...");
    return statusChunkUpload(upload);
  }).then(function(st){
    console.log("[CHUNK STATUS]",st);
    return completeChunkUpload(upload);
  }).then(function(res){
    progressBar.value=100;
    setStatus("Upload B2 selesai.");
    localStorage.removeItem("videy_last_chunk_upload");
    return res;
  });
}

function renderResult(data){
  var ok=!!data.ok;
  var isImage=data.mediaType==="image";
  var title=ok?(data.mode==="proxy"?"Successfully saved proxy":(isImage?"Gambar berhasil diupload":"Successfully uploaded")):"Upload gagal";
  var color=ok?"green":"red";
  var publicUrl=data.publicUrl||"";
  var apiUrl=data.apiUrl||"";
  var order=(data.order!=null?data.order:"");
  var slug=data.slug||"";
  var mode=data.mode||"";
  var mediaType=data.mediaType||"";
  var message=data.message||(ok?"Selesai.":(data.error||"Terjadi kesalahan."));
  resultWrap.classList.remove("hidden");
  var html="";
  html+='<div class="blockTitle" style="color:'+color+'">'+esc(title)+"</div>";
  html+='<div class="muted">'+esc(message)+"</div>";
  html+='<div class="row" style="margin-top:10px">';
  html+="<div><strong>Order</strong><br>"+esc(order)+"</div>";
  html+="<div><strong>Mode</strong><br>"+esc(mode)+(mediaType?" / "+esc(mediaType):"")+"</div>";
  html+="</div>";
  html+='<div style="margin-top:10px"><strong>Slug</strong><br>'+esc(slug)+"</div>";
  html+='<div style="margin-top:12px"><strong>URL hasil</strong>';
  html+='<div class="urlRow">';
  html+='<input readonly value="'+esc(publicUrl)+'" id="publicUrlInput">';
  html+='<button type="button" class="copyBtn" data-copy="'+esc(publicUrl)+'">Copy</button>';
  html+="</div></div>";
  html+='<div style="margin-top:12px"><strong>API</strong>';
  html+='<div class="urlRow">';
  html+='<input readonly value="'+esc(apiUrl)+'" id="apiUrlInput">';
  html+='<button type="button" class="copyBtn" data-copy="'+esc(apiUrl)+'">Copy</button>';
  html+="</div></div>";
  html+='<div class="actions">';
  html+='<a class="secondary" href="/api/upload">Upload lagi?</a>';
  html+='<button type="button" class="secondary" id="resetBtn">Bersihkan</button>';
  html+="</div>";
  html+='<details style="margin-top:12px"><summary>Lihat data/debug</summary>';
  html+="<pre>"+esc(JSON.stringify(data,null,2))+"</pre>";
  html+="</details>";
  resultWrap.innerHTML=html;
  resultWrap.querySelectorAll("[data-copy]").forEach(function(b){
    b.addEventListener("click",function(){
      var t=b.getAttribute("data-copy")||"";
      navigator.clipboard.writeText(t).then(function(){
        var o=b.textContent;
        b.textContent="Copied";
        setTimeout(function(){b.textContent=o;},1000);
      }).catch(function(){
        var o=b.textContent;
        b.textContent="Gagal";
        setTimeout(function(){b.textContent=o;},1000);
      });
    });
  });
  var r=resultWrap.querySelector("#resetBtn");
  if(r)r.addEventListener("click",function(){
    form.reset();
    toggleMode();
    resultWrap.classList.add("hidden");
    resultWrap.innerHTML="";
    setStatus("Siap");
    chunkInfo.hidden=true;
    window.scrollTo({top:0,behavior:"smooth"});
  });
}

modeRadios.forEach(function(r){r.addEventListener("change",toggleMode);});
toggleMode();

form.addEventListener("submit",function(e){
  e.preventDefault();
  resultWrap.classList.add("hidden");
  resultWrap.innerHTML="";
  var m=currentMode();
  var fd=new FormData(form);
  var fileEl=form.querySelector('input[type="file"]');
  var file=fileEl&&fileEl.files?fileEl.files[0]:null;

  setLoading(true);

  function showError(msg){
    setLoading(false);
    setStatus("Gagal");
    renderResult({ok:false,error:msg});
  }

  if(m==="image"){
    if(!file){showError("File gambar wajib dipilih.");return;}
    setStatus("Mengupload gambar ke B2 ("+formatBytes(file.size)+")...");
    progressBar.hidden=false;
    progressBar.value=0;
    var imgFd=new FormData();
    imgFd.append("title",form.querySelector('input[name="title"]').value);
    imgFd.append("file",file);
    fetch("/api/upload/image",{
      method:"POST",
      headers:{"Accept":"application/json","X-Upload-Debug":"1"},
      body:imgFd
    }).then(function(res){
      return res.text().then(function(txt){
        var data;
        try{data=txt?JSON.parse(txt):{};}catch(err){data={ok:false,error:txt||("HTTP "+res.status)};}
        progressBar.value=100;
        setStatus(data.ok?"Gambar selesai diupload.":"Upload gambar gagal.");
        setLoading(false);
        renderResult(data);
      });
    }).catch(function(err){
      showError(err&&err.message?err.message:String(err));
    });
    return;
  }

  if(m==="b2"){
    if(!file){showError("File video wajib dipilih.");return;}
    setStatus("Menyiapkan B2 Chunked ("+formatBytes(file.size)+")...");
    uploadB2Chunked(file,form.querySelector('input[name="title"]').value)
      .then(function(result){setLoading(false);renderResult(result);})
      .catch(function(err){
        console.error("[UPLOAD UI]",err);
        showError(err&&err.message?err.message:String(err));
      });
    return;
  }

  if(m==="proxy"){fd.delete("file");}else{fd.delete("sourceUrl");}
  setStatus(m==="proxy"?"Menyimpan link...":"Menyiapkan upload...");

  var xhr=new XMLHttpRequest();
  xhr.open("POST","/api/upload",true);
  xhr.setRequestHeader("Accept","application/json");
  xhr.upload.onprogress=function(ev){
    if(m==="video"&&ev.lengthComputable){
      var p=Math.round(ev.loaded/ev.total*100);
      progressBar.hidden=false;
      progressBar.value=p;
      setStatus("Mengirim... "+p+"%");
    }else{
      progressBar.hidden=false;
      setStatus(m==="proxy"?"Menyimpan link...":"Mengirim...");
    }
  };
  xhr.onreadystatechange=function(){
    if(xhr.readyState===2){setStatus("Memproses respons...");}
    if(xhr.readyState===4){
      setLoading(false);
      var data=xhr.responseText;
      try{data=JSON.parse(xhr.responseText);}catch(err){}
      if(xhr.status>=200&&xhr.status<300){
        setStatus("Selesai");
        renderResult(data);
      }else{
        setStatus("Gagal");
        renderResult(data);
      }
    }
  };
  xhr.onerror=function(){
    setLoading(false);
    setStatus("Gagal jaringan");
    renderResult({ok:false,error:"Terjadi error jaringan."});
  };
  xhr.send(fd);
});

</script>

</body>
</html>`;
}

// ============================================================
// RESULT HTML
// ============================================================

function renderResultBlock({ title, message, data = null, color = "black" }) {
  const payload = data ? JSON.stringify(data, null, 2) : "";

  return `<!doctype html>
<html lang="id">

<head>

<meta charset="utf-8">

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>
${escapeHtml(title)}
</title>

<style>

body{
  font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
  max-width:760px;
  margin:40px auto;
  padding:0 16px;
  line-height:1.5
}

.block{
  border:1px solid #ddd;
  border-radius:12px;
  padding:16px
}

.top{
  display:flex;
  justify-content:space-between;
  gap:12px;
  align-items:center;
  flex-wrap:wrap
}

.title{
  font-weight:700
}

.muted{
  color:#666
}

.row{
  display:grid;
  grid-template-columns:1fr auto;
  gap:8px;
  align-items:center;
  margin-top:10px
}

input{
  width:100%;
  box-sizing:border-box;
  padding:10px;
  border:1px solid #ccc;
  border-radius:10px;
  font:inherit
}

button,
a.btn{
  padding:10px 12px;
  border:1px solid #ccc;
  border-radius:10px;
  background:#f9f9f9;
  color:#111;
  text-decoration:none;
  display:inline-block;
  cursor:pointer
}

.actions{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
  margin-top:12px
}

pre{
  white-space:pre-wrap;
  background:#f6f6f6;
  border:1px solid #ddd;
  padding:12px;
  border-radius:12px;
  overflow:auto;
  margin-top:12px
}

details{
  margin-top:12px
}

</style>

</head>

<body>

<div class="block">

<div class="top">

<div
class="title"
style="color:${color}"
>
${escapeHtml(title)}
</div>

<div>
${escapeHtml(message)}
</div>

</div>

${
  data
    ? `

<div
style="margin-top:10px"
>
<strong>Order</strong>
<br>
${escapeHtml(
  data.order ??
  ""
)}
</div>

<div
style="margin-top:10px"
>
<strong>Mode</strong>
<br>
${escapeHtml(
  data.mode ??
  ""
)}${data.mediaType ? " / " + escapeHtml(data.mediaType) : ""}
</div>

<div
style="margin-top:10px"
>
<strong>Slug</strong>
<br>
${escapeHtml(
  data.slug ??
  ""
)}
</div>

<div
style="margin-top:12px"
>

<strong>URL hasil</strong>

<div class="row">

<input
readonly
value="${escapeHtml(
  data.publicUrl ??
  ""
)}"
id="publicUrlInput"
>

<button
type="button"
data-copy="${escapeHtml(
  data.publicUrl ??
  ""
)}"
>
Copy
</button>

</div>

</div>

<div
style="margin-top:12px"
>

<strong>API</strong>

<div class="row">

<input
readonly
value="${escapeHtml(
  data.apiUrl ??
  ""
)}"
id="apiUrlInput"
>

<button
type="button"
data-copy="${escapeHtml(
  data.apiUrl ??
  ""
)}"
>
Copy
</button>

</div>

</div>

<div class="actions">

<a
class="btn"
href="/api/upload"
>
Upload lagi?
</a>

<a
class="btn"
href="/"
>
Beranda
</a>

</div>

<details>

<summary>
Lihat data
</summary>

<pre>
${escapeHtml(
  payload
)}
</pre>

</details>

`
    : ""
}

</div>

<script>

document
  .querySelectorAll(
    "[data-copy]"
  )
  .forEach(
    b => {

      b.addEventListener(
        "click",
        async () => {

          const t =
            b.getAttribute(
              "data-copy"
            ) ||
            "";

          try{

            await navigator
              .clipboard
              .writeText(
                t
              );

            const o =
              b.textContent;

            b.textContent =
              "Copied";

            setTimeout(
              () =>
                b.textContent =
                  o,
              1000
            );

          }catch{

            const o =
              b.textContent;

            b.textContent =
              "Gagal";

            setTimeout(
              () =>
                b.textContent =
                  o,
              1000
            );

          }

        }
      );

    }
  );

</script>

</body>
</html>`;
}

// ============================================================
// LIST HTML
// ============================================================

function renderListHtml(items, hasMore, page, limit, url, sourceType) {
  const nextPageUrl = hasMore
    ? `${url.origin}${url.pathname}?page=${page + 1}&limit=${limit}`
    : null;

  const prevPageUrl = page > 1
    ? `${url.origin}${url.pathname}?page=${page - 1}&limit=${limit}`
    : null;

  let html = `<!doctype html>
<html lang="id">

<head>

<meta charset="utf-8">

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>
Daftar File
(${escapeHtml(sourceType)})
</title>

<style>

body{
  font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
  max-width:920px;
  margin:40px auto;
  padding:0 16px;
  line-height:1.5
}

table{
  width:100%;
  border-collapse:collapse;
  margin-top:16px
}

th,
td{
  border:1px solid #ddd;
  padding:8px;
  text-align:left;
  word-break:break-all
}

th{
  background:#f4f4f5
}

.pagination{
  margin-top:20px;
  display:flex;
  gap:12px;
  justify-content:center;
  flex-wrap:wrap
}

.btn{
  padding:10px 16px;
  background:#111;
  color:#fff;
  text-decoration:none;
  border-radius:8px;
  display:inline-block
}

.btn.disabled{
  background:#ccc;
  pointer-events:none;
  cursor:not-allowed
}

</style>

</head>

<body>

<h1>
Daftar File
(${escapeHtml(sourceType)})
</h1>

<p>
<a href="/api/upload">
Upload baru
</a>
|
<a href="/">
Beranda
</a>
</p>

<table>

<thead>

<tr>
<th>Order</th>
<th>Slug</th>
<th>Title</th>
<th>Mode</th>
<th>Tipe</th>
<th>URL</th>
</tr>

</thead>

<tbody>`;

  for (const item of items) {
    const ext = item.mediaType === "image"
      ? (item.contentType
          ? (IMAGE_MIME_TO_EXT[item.contentType] || ".jpg")
          : ".jpg")
      : ".mp4";

    const pubUrl = `${url.origin}/${item.order}/${item.slug}${ext}`;

    const tipeLabel =
      item.mediaType ||
      (item.mode === "b2" ? "video" : "-");

    html += `<tr>
<td>${escapeHtml(item.order)}</td>
<td>${escapeHtml(item.slug)}</td>
<td>${escapeHtml(item.title)}</td>
<td>${escapeHtml(item.mode)}</td>
<td>${escapeHtml(tipeLabel)}</td>
<td><a href="${escapeHtml(pubUrl)}" target="_blank">Buka</a></td>
</tr>`;
  }

  html += `</tbody>

</table>

<div class="pagination">

<a
href="${prevPageUrl || "#"}"
class="btn ${!prevPageUrl ? "disabled" : ""}"
>
← Halaman Sebelumnya
</a>

<a
href="${nextPageUrl || "#"}"
class="btn ${!hasMore ? "disabled" : ""}"
>
Halaman Berikutnya →
</a>

</div>

</body>

</html>`;

  return html;
}

// ============================================================
// LEGACY LIST HTML
// ============================================================

function renderLegacyListHtml(items, hasMore, nextCursor, limit, url) {
  const nextUrl = hasMore && nextCursor
    ? `${url.origin}${url.pathname}?limit=${limit}&cursor=${encodeURIComponent(nextCursor)}`
    : null;

  let html = `<!doctype html>
<html lang="id">

<head>

<meta charset="utf-8">

<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>
Daftar File (KV Legacy)
</title>

<style>

body{
  font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
  max-width:920px;
  margin:40px auto;
  padding:0 16px;
  line-height:1.5
}

table{
  width:100%;
  border-collapse:collapse;
  margin-top:16px
}

th,
td{
  border:1px solid #ddd;
  padding:8px;
  text-align:left;
  word-break:break-all
}

th{
  background:#f4f4f5
}

.pagination{
  margin-top:20px;
  display:flex;
  gap:12px;
  justify-content:center;
  flex-wrap:wrap
}

.btn{
  padding:10px 16px;
  background:#111;
  color:#fff;
  text-decoration:none;
  border-radius:8px;
  display:inline-block
}

.btn.disabled{
  background:#ccc;
  pointer-events:none;
  cursor:not-allowed
}

</style>

</head>

<body>

<h1>
Daftar File (KV Legacy)
</h1>

<p>
<a href="/api/upload">
Upload baru
</a>
|
<a href="/">
Beranda
</a>
</p>

<table>

<thead>

<tr>
<th>Order</th>
<th>Slug</th>
<th>Title</th>
<th>Mode</th>
<th>Tipe</th>
<th>URL</th>
</tr>

</thead>

<tbody>`;

  for (const item of items) {
    const ext = item.mediaType === "image"
      ? (item.contentType
          ? (IMAGE_MIME_TO_EXT[item.contentType] || ".jpg")
          : ".jpg")
      : ".mp4";

    const pubUrl = `${url.origin}/${item.order}/${item.slug}${ext}`;

    const tipeLabel =
      item.mediaType ||
      (item.mode === "b2" ? "video" : "-");

    html += `<tr>
<td>${escapeHtml(item.order)}</td>
<td>${escapeHtml(item.slug)}</td>
<td>${escapeHtml(item.title)}</td>
<td>${escapeHtml(item.mode)}</td>
<td>${escapeHtml(tipeLabel)}</td>
<td><a href="${escapeHtml(pubUrl)}" target="_blank">Buka</a></td>
</tr>`;
  }

  html += `</tbody>

</table>

<div class="pagination">

<a
href="${nextUrl || "#"}"
class="btn ${!nextUrl ? "disabled" : ""}"
>
Halaman Berikutnya →
</a>

</div>

</body>

</html>`;

  return html;
}

// ============================================================
// ESCAPE
// ============================================================

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ============================================================
// OPTIONAL CORS PREFLIGHT
// ============================================================

function corsOptionsResponse(requestId) {
  return new Response(null, {
    status: 204,
    headers: makeChunkHeaders(requestId)
  });
}
