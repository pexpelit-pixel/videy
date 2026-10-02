/**
 * Imgstorage Secure Gateway
 *
 * Public:
 *   GET  /media/<key>
 *   HEAD /media/<key>
 *
 * StorePost / server-to-server only:
 *   POST   /api/upload
 *   DELETE /api/object?key=<key>
 *   GET    /api/health
 *
 * Authentication for mutation endpoints:
 *   X-Img-Timestamp
 *   X-Img-Request-Id
 *   X-Img-Signature
 *
 * Signature:
 *   HMAC-SHA256(IMGSTORAGE_SERVICE_SECRET,
 *     timestamp + "\n" +
 *     requestId + "\n" +
 *     method + "\n" +
 *     pathname + "\n" +
 *     sha256(body)
 *   )
 *
 * DBByte is accessed through S3-compatible API.
 * DBByte credentials must be Cloudflare Worker Secrets.
 *
 * Important:
 * - This Worker intentionally does NOT expose a public DELETE endpoint.
 * - It does not make the DBByte bucket public.
 * - It does not implement server-side image re-encoding or malware scanning.
 *   Those require a dedicated image-processing/sandbox pipeline.
 */

const ALLOWED_IMAGE_TYPES = new Map([
  ["image/jpeg", { ext: "jpg" }],
  ["image/png", { ext: "png" }],
  ["image/webp", { ext: "webp" }],
  ["image/gif", { ext: "gif" }],
  ["image/avif", { ext: "avif" }]
]);

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const AUTH_CLOCK_SKEW_SECONDS = 300;
const KEY_PREFIX = "images/";

const AUTH_STATE_KV = "IMG_AUTH";
const LOGIN_CHALLENGE_TTL_SECONDS = 120;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const PASSWORD_MIN_LENGTH = 14;
const POW_DIFFICULTY = 4;
const MAX_STRUCTURE_CHUNKS = 2048;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100000000;
const CRC32_TABLE = makeCrc32Table();

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();

    try {
      const url = new URL(request.url);
      const pathname = url.pathname;

      if (request.method === "OPTIONS") {
        return corsPreflight(request, env);
      }

      if (pathname === "/") {
        return json({
          ok: true,
          service: "imgstorage-secure",
          public: ["/media/<key>"],
          private: ["/api/upload", "DELETE /api/object"],
          requestId
        }, 200, { "Cache-Control": "no-store" });
      }

      if (pathname === "/admin") {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed(["GET", "HEAD"], requestId);
        }
        return adminPage(requestId, request.method === "HEAD");
      }

      if (pathname === "/api/auth/challenge") {
        if (request.method !== "GET") {
          return methodNotAllowed(["GET"], requestId);
        }
        return await handleAuthChallenge(request, env, requestId);
      }

      if (pathname === "/api/auth/login") {
        if (request.method !== "POST") {
          return methodNotAllowed(["POST"], requestId);
        }
        return await handleAdminLogin(request, env, requestId);
      }

      if (pathname === "/api/auth/logout") {
        if (request.method !== "POST") {
          return methodNotAllowed(["POST"], requestId);
        }
        return await handleAdminLogout(request, env, requestId);
      }

      if (pathname === "/api/auth/password") {
        if (request.method !== "POST") {
          return methodNotAllowed(["POST"], requestId);
        }
        return await handlePasswordChange(request, env, requestId);
      }

      if (pathname === "/api/auth/me") {
        if (request.method !== "GET") {
          return methodNotAllowed(["GET"], requestId);
        }
        return await handleAuthMe(request, env, requestId);
      }

      if (pathname === "/api/auth/revoke-sessions") {
        if (request.method !== "POST") {
          return methodNotAllowed(["POST"], requestId);
        }
        return await handleSessionRevoke(request, env, requestId);
      }

      if (pathname === "/api/service/revoke") {
        if (request.method !== "POST") {
          return methodNotAllowed(["POST"], requestId);
        }
        return await handleServiceRevoke(request, env, requestId, true);
      }

      if (pathname === "/api/service/unrevoke") {
        if (request.method !== "POST") {
          return methodNotAllowed(["POST"], requestId);
        }
        return await handleServiceRevoke(request, env, requestId, false);
      }

      if (pathname === "/api/health") {
        const auth = await requireServiceAuth(request, env);
        if (!auth.ok) return auth.response;

        const checks = {
          dbbyteEndpoint: Boolean(env.DBBYTE_ENDPOINT),
          dbbyteBucket: Boolean(env.DBBYTE_BUCKET_NAME),
          dbbyteAccessKey: Boolean(env.DBBYTE_ACCESS_KEY_ID),
          dbbyteSecret: Boolean(env.DBBYTE_SECRET_ACCESS_KEY),
          serviceSecret: Boolean(env.IMGSTORAGE_SERVICE_SECRET),
          authStateStore: Boolean(getStateStore(env)),
          defaultAdminPassword: Boolean(env.IMGSTORAGE_DEFAULT_ADMIN_PASSWORD)
        };

        return json({
          ok: Object.values(checks).every(Boolean),
          service: "imgstorage-secure",
          checks,
          requestId
        }, Object.values(checks).every(Boolean) ? 200 : 503, {
          "Cache-Control": "no-store"
        });
      }

      if (pathname === "/api/upload") {
        if (request.method !== "POST") {
          return methodNotAllowed(["POST"], requestId);
        }

        const body = await request.arrayBuffer();
        const auth = await requireServiceAuth(request, env, body);
        if (!auth.ok) return auth.response;

        return await handleUpload(body, request, env, requestId);
      }

      if (pathname === "/api/object") {
        if (request.method !== "DELETE") {
          return methodNotAllowed(["DELETE"], requestId);
        }

        const body = await request.arrayBuffer();
        const auth = await requireServiceAuth(request, env, body);
        if (!auth.ok) return auth.response;

        const key = url.searchParams.get("key") || "";
        return await handleDelete(key, env, requestId);
      }

      if (pathname.startsWith("/media/")) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return methodNotAllowed(["GET", "HEAD"], requestId);
        }

        const key = decodeMediaKey(pathname);
        if (!key) {
          return json({
            ok: false,
            error: "invalid_media_key",
            requestId
          }, 400);
        }

        return await handlePublicMedia(key, request, env, requestId);
      }

      return json({
        ok: false,
        error: "not_found",
        requestId
      }, 404);
    } catch (error) {
      console.error("[IMGSTORAGE SECURE]", requestId, error);
      return json({
        ok: false,
        error: "internal_error",
        requestId
      }, 500, { "Cache-Control": "no-store" });
    }
  }
};

async function handleUpload(body, request, env, requestId) {
  if (!body.byteLength) {
    return json({
      ok: false,
      error: "empty_body",
      requestId
    }, 400);
  }

  if (body.byteLength > MAX_UPLOAD_BYTES) {
    return json({
      ok: false,
      error: "file_too_large",
      maxBytes: MAX_UPLOAD_BYTES,
      requestId
    }, 413);
  }

  const declaredType = normalizeMime(request.headers.get("Content-Type"));
  const detected = detectImageType(body);

  if (!detected) {
    return json({
      ok: false,
      error: "invalid_image_signature",
      requestId
    }, 415);
  }

  if (!ALLOWED_IMAGE_TYPES.has(detected.mime)) {
    return json({
      ok: false,
      error: "unsupported_image_type",
      detected: detected.mime,
      requestId
    }, 415);
  }

  if (declaredType && declaredType !== detected.mime) {
    return json({
      ok: false,
      error: "content_type_mismatch",
      declared: declaredType,
      detected: detected.mime,
      requestId
    }, 415);
  }

  const normalized = await normalizeAndVerifyImage(body, detected.mime);
  if (!normalized.ok) {
    return json({
      ok: false,
      error: normalized.error,
      requestId
    }, 415);
  }

  const finalBody = normalized.body;
  const verified = detectImageType(finalBody);
  if (!verified || verified.mime !== detected.mime) {
    return json({
      ok: false,
      error: "normalized_image_verification_failed",
      requestId
    }, 422);
  }

  if (finalBody.byteLength > MAX_UPLOAD_BYTES) {
    return json({
      ok: false,
      error: "normalized_file_too_large",
      maxBytes: MAX_UPLOAD_BYTES,
      requestId
    }, 413);
  }

  const extension = ALLOWED_IMAGE_TYPES.get(verified.mime).ext;
  const key = makeObjectKey(extension);

  const upstream = await s3Request({
    method: "PUT",
    key,
    body: finalBody,
    contentType: verified.mime,
    env
  });

  if (!upstream.ok) {
    const detail = await safeText(upstream.response);
    console.error("[DBBYTE UPLOAD]", requestId, upstream.status, detail.slice(0, 1000));

    return json({
      ok: false,
      error: "storage_upload_failed",
      upstreamStatus: upstream.status,
      requestId
    }, upstream.status >= 500 ? 502 : 502);
  }

  return json({
    ok: true,
    key,
    mediaUrl: new URL("/media/" + encodeKeyForPath(key), request.url).toString(),
    contentType: verified.mime,
    originalSize: body.byteLength,
    size: finalBody.byteLength,
    normalized: normalized.changed,
    requestId
  }, 201, {
    "Cache-Control": "no-store"
  });
}

async function handleDelete(key, env, requestId) {
  if (!isSafeObjectKey(key)) {
    return json({
      ok: false,
      error: "invalid_object_key",
      requestId
    }, 400);
  }

  const upstream = await s3Request({
    method: "DELETE",
    key,
    body: new ArrayBuffer(0),
    contentType: "",
    env
  });

  if (!upstream.ok && upstream.status !== 404) {
    const detail = await safeText(upstream.response);
    console.error("[DBBYTE DELETE]", requestId, upstream.status, detail.slice(0, 1000));

    return json({
      ok: false,
      error: "storage_delete_failed",
      upstreamStatus: upstream.status,
      requestId
    }, 502);
  }

  return json({
    ok: true,
    deleted: upstream.status !== 404,
    key,
    requestId
  }, 200, {
    "Cache-Control": "no-store"
  });
}

async function handlePublicMedia(key, request, env, requestId) {
  if (!isSafeObjectKey(key)) {
    return json({
      ok: false,
      error: "invalid_media_key",
      requestId
    }, 400);
  }

  const upstream = await s3Request({
    method: request.method,
    key,
    body: new ArrayBuffer(0),
    contentType: "",
    env
  });

  if (!upstream.ok) {
    if (upstream.status === 404) {
      return json({
        ok: false,
        error: "media_not_found",
        requestId
      }, 404, {
        "Cache-Control": "public, max-age=60"
      });
    }

    console.error("[DBBYTE MEDIA]", requestId, upstream.status);

    return json({
      ok: false,
      error: "storage_read_failed",
      requestId
    }, 502);
  }

  const sourceHeaders = upstream.response.headers;
  const headers = new Headers();

  const contentType = safeImageMime(sourceHeaders.get("content-type"));
  headers.set("Content-Type", contentType || "application/octet-stream");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  const contentLength = sourceHeaders.get("content-length");
  if (contentLength) headers.set("Content-Length", contentLength);

  const etag = sourceHeaders.get("etag");
  if (etag) headers.set("ETag", etag);

  const lastModified = sourceHeaders.get("last-modified");
  if (lastModified) headers.set("Last-Modified", lastModified);

  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers
    });
  }

  return new Response(upstream.response.body, {
    status: 200,
    headers
  });
}

async function requireServiceAuth(request, env, body = new ArrayBuffer(0)) {
  const secret = String(env.IMGSTORAGE_SERVICE_SECRET || "");
  const kv = getStateStore(env);

  if (!secret || secret.length < 32 || !kv) {
    return {
      ok: false,
      response: json({
        ok: false,
        error: !secret ? "service_auth_not_configured" : "auth_state_store_not_configured"
      }, 503, {
        "Cache-Control": "no-store"
      })
    };
  }

  const revoked = await stateGetText(kv, "service:revoked");
  if (revoked === "1") {
    return {
      ok: false,
      response: json({
        ok: false,
        error: "service_auth_revoked"
      }, 403, {
        "Cache-Control": "no-store"
      })
    };
  }

  const timestamp = request.headers.get("X-Img-Timestamp") || "";
  const requestId = request.headers.get("X-Img-Request-Id") || "";
  const signature = request.headers.get("X-Img-Signature") || "";

  if (!/^\d{10,13}$/.test(timestamp) ||
      !/^[A-Za-z0-9._:-]{16,128}$/.test(requestId) ||
      !/^[a-f0-9]{64}$/i.test(signature)) {
    return {
      ok: false,
      response: json({
        ok: false,
        error: "service_auth_required"
      }, 401, {
        "Cache-Control": "no-store",
        "WWW-Authenticate": "HMAC"
      })
    };
  }

  const timestampMs = String(timestamp).length === 13
    ? Number(timestamp)
    : Number(timestamp) * 1000;

  if (!Number.isFinite(timestampMs)) {
    return {
      ok: false,
      response: json({
        ok: false,
        error: "invalid_auth_timestamp"
      }, 401)
    };
  }

  if (Math.abs(Date.now() - timestampMs) > AUTH_CLOCK_SKEW_SECONDS * 1000) {
    return {
      ok: false,
      response: json({
        ok: false,
        error: "expired_auth_request"
      }, 401)
    };
  }

  const bodyHash = await sha256Hex(body);
  const canonical = [
    timestamp,
    requestId,
    request.method.toUpperCase(),
    (() => {
      const u = new URL(request.url);
      return u.pathname + u.search;
    })(),
    bodyHash
  ].join("\n");

  const expected = await hmacHex(secret, canonical);

  if (!timingSafeEqual(signature, expected)) {
    return {
      ok: false,
      response: json({
        ok: false,
        error: "invalid_service_signature"
      }, 403)
    };
  }

  const replayKey = "replay:" + await sha256Hex(requestId);
  const seen = await stateGetText(kv, replayKey);
  if (seen) {
    return {
      ok: false,
      response: json({
        ok: false,
        error: "replayed_request_id"
      }, 409, {
        "Cache-Control": "no-store"
      })
    };
  }

  try {
    await kv.put(replayKey, "1", { expirationTtl: AUTH_CLOCK_SKEW_SECONDS * 2 });
  } catch (error) {
    console.error("[AUTH REPLAY STORE]", error);
    return {
      ok: false,
      response: json({
        ok: false,
        error: "replay_guard_unavailable"
      }, 503, {
        "Cache-Control": "no-store"
      })
    };
  }

  return { ok: true };
}



async function normalizeAndVerifyImage(buffer, mime) {
  try {
    let body;

    switch (mime) {
      case "image/jpeg":
        body = normalizeJpeg(buffer);
        break;
      case "image/png":
        body = normalizePng(buffer);
        break;
      case "image/webp":
        body = normalizeWebp(buffer);
        break;
      case "image/gif":
        body = normalizeGif(buffer);
        break;
      case "image/avif":
        body = normalizeAvif(buffer);
        break;
      default:
        return { ok: false, error: "unsupported_image_type" };
    }

    if (!body || body.byteLength < 1 || body.byteLength > MAX_UPLOAD_BYTES) {
      return { ok: false, error: "normalized_file_invalid_size" };
    }

    const detected = detectImageType(body);
    if (!detected || detected.mime !== mime) {
      return { ok: false, error: "normalized_image_magic_mismatch" };
    }

    validateImageContainer(body, mime);

    return {
      ok: true,
      body,
      changed: body.byteLength !== buffer.byteLength ||
        !bytesEqual(new Uint8Array(body), new Uint8Array(buffer))
    };
  } catch (error) {
    console.error("[IMAGE NORMALIZER]", mime, error);
    return {
      ok: false,
      error: error && error.code === "image_structure_limit"
        ? "image_structure_limit"
        : "invalid_image_container"
    };
  }
}

function validateImageContainer(buffer, mime) {
  switch (mime) {
    case "image/jpeg":
      parseJpeg(buffer, false);
      return;
    case "image/png":
      parsePng(buffer, false);
      return;
    case "image/webp":
      parseWebp(buffer, false);
      return;
    case "image/gif":
      parseGif(buffer, false);
      return;
    case "image/avif":
      parseAvif(buffer, false);
      return;
    default:
      throw imageError("unsupported_image_type");
  }
}

function normalizeJpeg(buffer) {
  return parseJpeg(buffer, true).buffer;
}

function parseJpeg(buffer, buildOutput) {
  const b = new Uint8Array(buffer);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) {
    throw imageError("jpeg_header_invalid");
  }

  const parts = [b.slice(0, 2)];
  let pos = 2;
  let segments = 0;
  let sawSof = false;
  let sawSos = false;
  let width = 0;
  let height = 0;
  let sawEoi = false;

  while (pos < b.length) {
    if (b[pos] !== 0xff) throw imageError("jpeg_marker_invalid");

    const markerStart = pos;
    while (pos < b.length && b[pos] === 0xff) pos++;
    if (pos >= b.length) throw imageError("jpeg_marker_truncated");

    const marker = b[pos++];

    if (marker === 0x00) throw imageError("jpeg_stuffed_marker_outside_scan");
    if (marker === 0xd8) throw imageError("jpeg_nested_soi");

    if (marker === 0xd9) {
      if (!sawSos || !sawSof || pos !== b.length) {
        throw imageError("jpeg_trailing_data");
      }
      if (buildOutput) parts.push(b.slice(markerStart, pos));
      sawEoi = true;
      break;
    }

    if (marker >= 0xd0 && marker <= 0xd7) {
      throw imageError("jpeg_restart_marker_outside_scan");
    }

    if (marker === 0xda) {
      if (pos + 2 > b.length) throw imageError("jpeg_sos_length_truncated");
      const segLength = readU16BE(b, pos);
      if (segLength < 2) throw imageError("jpeg_sos_length_invalid");
      const segEnd = pos + segLength;
      if (segEnd > b.length) throw imageError("jpeg_sos_out_of_bounds");

      if (buildOutput) parts.push(b.slice(markerStart, segEnd));
      sawSos = true;
      pos = segEnd;

      while (pos < b.length) {
        if (b[pos] !== 0xff) {
          pos++;
          continue;
        }

        const scanMarkerStart = pos;
        while (pos < b.length && b[pos] === 0xff) pos++;
        if (pos >= b.length) throw imageError("jpeg_scan_truncated");

        const next = b[pos];

        if (next === 0x00) {
          pos++;
          continue;
        }

        if (next >= 0xd0 && next <= 0xd7) {
          pos++;
          continue;
        }

        if (next === 0xd9) {
          pos++;
          if (buildOutput) parts.push(b.slice(markerStart + (segEnd - markerStart), scanMarkerStart));
          if (buildOutput) parts.push(new Uint8Array([0xff, 0xd9]));
          sawEoi = true;
          if (pos !== b.length) throw imageError("jpeg_trailing_data");
          return {
            buffer: concatBytes(parts),
            width,
            height,
            segments
          };
        }

        if (buildOutput) parts.push(b.slice(markerStart + (segEnd - markerStart), scanMarkerStart));
        pos = scanMarkerStart;
        break;
      }

      continue;
    }

    if (pos + 2 > b.length) throw imageError("jpeg_segment_length_truncated");
    const segLength = readU16BE(b, pos);
    if (segLength < 2) throw imageError("jpeg_segment_length_invalid");

    const segEnd = pos + segLength;
    if (segEnd > b.length) throw imageError("jpeg_segment_out_of_bounds");
    if (segLength > 65535) throw imageError("jpeg_segment_too_large");

    segments++;
    if (segments > MAX_STRUCTURE_CHUNKS) throw imageError("image_structure_limit");

    if (isJpegSofMarker(marker)) {
      if (segLength < 8) throw imageError("jpeg_sof_invalid");
      height = readU16BE(b, pos + 3);
      width = readU16BE(b, pos + 5);
      if (!width || !height || width > 100000 || height > 100000 ||
          width * height > MAX_IMAGE_PIXELS) {
        throw imageError("jpeg_dimensions_invalid");
      }
      sawSof = true;
    }

    const drop = marker === 0xe1 || marker === 0xe2 || marker === 0xfe;
    if (buildOutput && !drop) parts.push(b.slice(markerStart, segEnd));
    pos = segEnd;
  }

  if (!sawSof || !sawSos || !sawEoi) {
    throw imageError("jpeg_structure_incomplete");
  }

  return {
    buffer: buildOutput ? concatBytes(parts) : b,
    width,
    height,
    segments
  };
}

function normalizePng(buffer) {
  return parsePng(buffer, true).buffer;
}

function parsePng(buffer, buildOutput) {
  const b = new Uint8Array(buffer);
  if (b.length < 33 ||
      b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47 ||
      b[4] !== 0x0d || b[5] !== 0x0a || b[6] !== 0x1a || b[7] !== 0x0a) {
    throw imageError("png_header_invalid");
  }

  const parts = [b.slice(0, 8)];
  let pos = 8;
  let chunks = 0;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;
  let sawPlte = false;
  let colorType = -1;

  while (pos < b.length) {
    if (pos + 12 > b.length) throw imageError("png_chunk_truncated");

    const length = readU32BE(b, pos);
    if (length > MAX_CHUNK_BYTES) throw imageError("png_chunk_too_large");

    const typeBytes = b.slice(pos + 4, pos + 8);
    if (!isPngChunkType(typeBytes)) throw imageError("png_chunk_type_invalid");

    const type = ascii(typeBytes);
    const chunkEnd = pos + 12 + length;
    if (chunkEnd > b.length) throw imageError("png_chunk_out_of_bounds");

    const storedCrc = readU32BE(b, chunkEnd - 4);
    const computedCrc = crc32(b, pos + 4, pos + 8 + length);
    if (storedCrc !== computedCrc) throw imageError("png_crc_invalid");

    chunks++;
    if (chunks > MAX_STRUCTURE_CHUNKS) throw imageError("image_structure_limit");

    if (!sawIhdr && type !== "IHDR") throw imageError("png_ihdr_not_first");

    if (type === "IHDR") {
      if (sawIhdr || length !== 13) throw imageError("png_ihdr_invalid");
      sawIhdr = true;
      const width = readU32BE(b, pos + 8);
      const height = readU32BE(b, pos + 12);
      colorType = b[pos + 17];
      const bitDepth = b[pos + 16];

      if (!width || !height || width > 100000 || height > 100000 ||
          width * height > MAX_IMAGE_PIXELS) {
        throw imageError("png_dimensions_invalid");
      }

      if (![0, 2, 3, 4, 6].includes(colorType)) {
        throw imageError("png_color_type_invalid");
      }

      if (![1, 2, 4, 8, 16].includes(bitDepth)) {
        throw imageError("png_bit_depth_invalid");
      }
    }

    if (type === "PLTE") {
      if (sawIdat || length === 0 || length > 768 || length % 3 !== 0) {
        throw imageError("png_plte_invalid");
      }
      sawPlte = true;
    }

    if (type === "IDAT") {
      sawIdat = true;
      if (colorType === 3 && !sawPlte) {
        throw imageError("png_palette_missing");
      }
    }

    if (type === "IEND") {
      if (length !== 0 || !sawIhdr || !sawIdat || chunkEnd !== b.length) {
        throw imageError("png_iend_invalid");
      }
      sawIend = true;
    }

    const dropMetadata = type === "eXIf" ||
      type === "iTXt" ||
      type === "tEXt" ||
      type === "zTXt" ||
      type === "iCCP";

    if (buildOutput && !dropMetadata) {
      parts.push(b.slice(pos, chunkEnd));
    }

    pos = chunkEnd;
    if (sawIend) break;
  }

  if (!sawIhdr || !sawIdat || !sawIend || pos !== b.length) {
    throw imageError("png_structure_incomplete");
  }

  return {
    buffer: buildOutput ? concatBytes(parts) : b,
    chunks
  };
}

function normalizeWebp(buffer) {
  return parseWebp(buffer, true).buffer;
}

function parseWebp(buffer, buildOutput) {
  const b = new Uint8Array(buffer);
  if (b.length < 20 ||
      ascii(b.slice(0, 4)) !== "RIFF" ||
      ascii(b.slice(8, 12)) !== "WEBP") {
    throw imageError("webp_header_invalid");
  }

  if (readU32LE(b, 4) !== b.length - 8) {
    throw imageError("webp_riff_size_invalid");
  }

  const parts = [];
  let pos = 12;
  let chunks = 0;
  let imagePayload = false;
  let outputBytes = 0;

  while (pos < b.length) {
    if (pos + 8 > b.length) throw imageError("webp_chunk_truncated");

    const type = ascii(b.slice(pos, pos + 4));
    const length = readU32LE(b, pos + 4);
    if (length > MAX_CHUNK_BYTES) throw imageError("webp_chunk_too_large");

    const payloadEnd = pos + 8 + length;
    const paddedEnd = payloadEnd + (length & 1);
    if (paddedEnd > b.length) throw imageError("webp_chunk_out_of_bounds");
    if ((length & 1) && b[payloadEnd] !== 0) {
      throw imageError("webp_padding_invalid");
    }

    chunks++;
    if (chunks > MAX_STRUCTURE_CHUNKS) throw imageError("image_structure_limit");

    const payload = b.slice(pos + 8, payloadEnd);

    if (type === "VP8X") {
      if (length !== 10) throw imageError("webp_vp8x_invalid");
      const flags = payload[0];
      if ((flags & 0x61) !== 0) throw imageError("webp_vp8x_reserved_bits");
      const width = 1 +
        payload[4] +
        (payload[5] << 8) +
        (payload[6] << 16);
      const height = 1 +
        payload[7] +
        (payload[8] << 8) +
        (payload[9] << 16);

      if (width > 100000 || height > 100000 || width * height > MAX_IMAGE_PIXELS) {
        throw imageError("webp_dimensions_invalid");
      }

      imagePayload = true;

      if (buildOutput) {
        const cloned = payload.slice();
        cloned[0] &= 0x73;
        parts.push(makeWebpChunk(type, cloned));
        outputBytes += 8 + cloned.length + (cloned.length & 1);
      }
    } else {
      if (type === "VP8 " || type === "VP8L" || type === "ANMF") {
        imagePayload = true;

        if (type === "VP8 ") {
          if (length < 10 ||
              payload[3] !== 0x9d || payload[4] !== 0x01 || payload[5] !== 0x2a) {
            throw imageError("webp_vp8_frame_invalid");
          }
        }

        if (type === "VP8L" && (length < 5 || payload[0] !== 0x2f)) {
          throw imageError("webp_vp8l_frame_invalid");
        }

        if (type === "ANMF" && length < 16) {
          throw imageError("webp_anmf_invalid");
        }
      }

      const dropMetadata = type === "EXIF" || type === "XMP " || type === "ICCP" ||
        type === "JUNK" || type === "PAD ";

      if (buildOutput && !dropMetadata) {
        const chunk = b.slice(pos, paddedEnd);
        parts.push(chunk);
        outputBytes += chunk.length;
      }
    }

    pos = paddedEnd;
  }

  if (pos !== b.length || !imagePayload) {
    throw imageError("webp_structure_incomplete");
  }

  if (!buildOutput) {
    return { buffer: b, chunks };
  }

  const header = new Uint8Array(12);
  header.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  const out = new Uint8Array(concatBytes([header, ...parts]));
  writeU32LE(out, 4, out.length - 8);

  return {
    buffer: out.buffer,
    chunks
  };
}

function normalizeGif(buffer) {
  return parseGif(buffer, true).buffer;
}

function parseGif(buffer, buildOutput) {
  const b = new Uint8Array(buffer);
  if (b.length < 13) throw imageError("gif_header_invalid");

  const header = ascii(b.slice(0, 6));
  if (header !== "GIF87a" && header !== "GIF89a") {
    throw imageError("gif_header_invalid");
  }

  const width = readU16LE(b, 6);
  const height = readU16LE(b, 8);
  if (!width || !height || width > 100000 || height > 100000 ||
      width * height > MAX_IMAGE_PIXELS) {
    throw imageError("gif_dimensions_invalid");
  }

  const parts = [b.slice(0, 13)];
  let pos = 13;
  let blocks = 0;
  let images = 0;

  const packed = b[10];
  if (packed & 0x80) {
    const tableBytes = 3 * (1 << ((packed & 0x07) + 1));
    if (pos + tableBytes > b.length) throw imageError("gif_global_table_invalid");
    if (buildOutput) parts.push(b.slice(pos, pos + tableBytes));
    pos += tableBytes;
  }

  while (pos < b.length) {
    if (b[pos] === 0x3b) {
      if (pos !== b.length - 1 || images === 0) {
        throw imageError("gif_trailing_or_empty");
      }
      if (buildOutput) parts.push(new Uint8Array([0x3b]));
      pos++;
      break;
    }

    blocks++;
    if (blocks > MAX_STRUCTURE_CHUNKS) throw imageError("image_structure_limit");

    if (b[pos] === 0x2c) {
      const start = pos;
      if (pos + 10 > b.length) throw imageError("gif_image_descriptor_invalid");
      const packedLocal = b[pos + 9];
      pos += 10;

      if (packedLocal & 0x80) {
        const localTableBytes = 3 * (1 << ((packedLocal & 0x07) + 1));
        if (pos + localTableBytes > b.length) throw imageError("gif_local_table_invalid");
        pos += localTableBytes;
      }

      if (pos >= b.length) throw imageError("gif_lzw_missing");
      const lzwMin = b[pos++];
      if (lzwMin < 2 || lzwMin > 8) throw imageError("gif_lzw_invalid");

      const dataStart = pos;
      pos = skipGifSubBlocks(b, pos);
      if (buildOutput) parts.push(b.slice(start, pos));
      if (pos > dataStart + MAX_CHUNK_BYTES) throw imageError("gif_data_too_large");
      images++;
      continue;
    }

    if (b[pos] !== 0x21) throw imageError("gif_block_invalid");
    const start = pos;
    pos++;
    if (pos >= b.length) throw imageError("gif_extension_missing");

    const label = b[pos++];

    if (label === 0xf9) {
      if (pos + 6 > b.length || b[pos] !== 4 || b[pos + 5] !== 0) {
        throw imageError("gif_gce_invalid");
      }
      pos += 6;
      if (buildOutput) parts.push(b.slice(start, pos));
      continue;
    }

    if (label === 0xff) {
      if (pos >= b.length) throw imageError("gif_app_missing");
      const blockSize = b[pos++];
      if (blockSize !== 11 || pos + blockSize > b.length) {
        throw imageError("gif_app_header_invalid");
      }
      const appId = ascii(b.slice(pos, pos + 11));
      pos += blockSize;
      const subBlocksStart = pos;
      pos = skipGifSubBlocks(b, pos);
      const isXmp = /XMP/i.test(appId);
      if (buildOutput && !isXmp) {
        parts.push(b.slice(start, pos));
      }
      if (pos - subBlocksStart > MAX_CHUNK_BYTES) {
        throw imageError("gif_extension_too_large");
      }
      continue;
    }

    pos = skipGifSubBlocks(b, pos);
    if (buildOutput && label !== 0xfe) {
      parts.push(b.slice(start, pos));
    }
  }

  if (pos !== b.length || images === 0) {
    throw imageError("gif_structure_incomplete");
  }

  return {
    buffer: buildOutput ? concatBytes(parts) : b,
    blocks,
    images
  };
}

function normalizeAvif(buffer) {
  return parseAvif(buffer, true).buffer;
}

function parseAvif(buffer, buildOutput) {
  const b = new Uint8Array(buffer);
  if (b.length < 24 || ascii(b.slice(4, 8)) !== "ftyp") {
    throw imageError("avif_header_invalid");
  }

  const parts = [];
  let pos = 0;
  let boxes = 0;
  let sawFtyp = false;
  let sawMeta = false;

  while (pos < b.length) {
    if (pos + 8 > b.length) throw imageError("avif_box_truncated");

    const size32 = readU32BE(b, pos);
    const type = ascii(b.slice(pos + 4, pos + 8));
    let size = size32;
    let headerSize = 8;

    if (size32 === 1) {
      if (pos + 16 > b.length) throw imageError("avif_large_box_unsupported");
      const high = readU32BE(b, pos + 8);
      const low = readU32BE(b, pos + 12);
      size = high * 4294967296 + low;
      headerSize = 16;
    } else if (size32 === 0) {
      size = b.length - pos;
    }

    if (!Number.isSafeInteger(size) || size < headerSize || pos + size > b.length) {
      throw imageError("avif_box_size_invalid");
    }

    boxes++;
    if (boxes > MAX_STRUCTURE_CHUNKS) throw imageError("image_structure_limit");

    if (boxes === 1 && type !== "ftyp") throw imageError("avif_ftyp_not_first");
    if (type === "ftyp") {
      if (size < headerSize + 8) throw imageError("avif_ftyp_invalid");
      const majorBrand = ascii(b.slice(pos + headerSize, pos + headerSize + 4));
      if (majorBrand !== "avif" && majorBrand !== "avis") {
        throw imageError("avif_brand_invalid");
      }
      sawFtyp = true;
    }

    if (type === "meta") {
      if (size < headerSize + 4) throw imageError("avif_meta_invalid");
      parseIsoBoxChildren(b.slice(pos + headerSize + 4, pos + size), MAX_STRUCTURE_CHUNKS);
      sawMeta = true;
    }

    if (buildOutput) parts.push(b.slice(pos, pos + size));
    pos += size;
  }

  if (pos !== b.length || !sawFtyp || !sawMeta) {
    throw imageError("avif_structure_incomplete");
  }

  return {
    buffer: buildOutput ? concatBytes(parts) : b,
    boxes
  };
}

function parseIsoBoxChildren(bytes, maxBoxes) {
  let pos = 0;
  let count = 0;
  while (pos < bytes.length) {
    if (pos + 8 > bytes.length) throw imageError("avif_meta_child_truncated");

    const size32 = readU32BE(bytes, pos);
    let size = size32;
    let headerSize = 8;
    if (size32 === 1) {
      if (pos + 16 > bytes.length) throw imageError("avif_meta_child_large");
      size = readU32BE(bytes, pos + 8) * 4294967296 + readU32BE(bytes, pos + 12);
      headerSize = 16;
    } else if (size32 === 0) {
      size = bytes.length - pos;
    }

    if (!Number.isSafeInteger(size) || size < headerSize || pos + size > bytes.length) {
      throw imageError("avif_meta_child_size_invalid");
    }

    count++;
    if (count > maxBoxes) throw imageError("image_structure_limit");
    pos += size;
  }

  if (pos !== bytes.length) throw imageError("avif_meta_child_boundary");
}

function skipGifSubBlocks(b, pos) {
  let blocks = 0;
  let total = 0;
  while (true) {
    if (pos >= b.length) throw imageError("gif_subblock_truncated");
    const len = b[pos++];
    if (len === 0) return pos;
    if (pos + len > b.length) throw imageError("gif_subblock_out_of_bounds");
    pos += len;
    total += len;
    blocks++;
    if (blocks > MAX_STRUCTURE_CHUNKS) throw imageError("image_structure_limit");
    if (total > MAX_CHUNK_BYTES) throw imageError("gif_subblock_too_large");
  }
}

function isJpegSofMarker(marker) {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function isPngChunkType(bytes) {
  for (const byte of bytes) {
    const upper = byte >= 0x41 && byte <= 0x5a;
    const lower = byte >= 0x61 && byte <= 0x7a;
    if (!upper && !lower) return false;
  }
  return true;
}

function makeWebpChunk(type, payload) {
  const padding = payload.length & 1;
  const out = new Uint8Array(8 + payload.length + padding);
  out.set(new TextEncoder().encode(type), 0);
  writeU32LE(out, 4, payload.length);
  out.set(payload, 8);
  return out;
}

function hasPriorChunk(parts, type) {
  for (const part of parts) {
    if (part.length >= 12 && ascii(part.slice(4, 8)) === type) return true;
  }
  return false;
}

function imageError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function concatBytes(parts) {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out.buffer;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function readU16BE(b, i) {
  return (b[i] << 8) | b[i + 1];
}

function readU16LE(b, i) {
  return b[i] | (b[i + 1] << 8);
}

function readU32BE(b, i) {
  return ((b[i] * 0x1000000) +
    (b[i + 1] << 16) +
    (b[i + 2] << 8) +
    b[i + 3]);
}

function readU32LE(b, i) {
  return ((b[i]) |
    (b[i + 1] << 8) |
    (b[i + 2] << 16) |
    (b[i + 3] * 0x1000000));
}

function writeU32BE(b, i, value) {
  b[i] = Math.floor(value / 0x1000000) & 0xff;
  b[i + 1] = (value >>> 16) & 0xff;
  b[i + 2] = (value >>> 8) & 0xff;
  b[i + 3] = value & 0xff;
}

function writeU32LE(b, i, value) {
  b[i] = value & 0xff;
  b[i + 1] = (value >>> 8) & 0xff;
  b[i + 2] = (value >>> 16) & 0xff;
  b[i + 3] = Math.floor(value / 0x1000000) & 0xff;
}

function makeCrc32Table() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(b, start, end) {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = CRC32_TABLE[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}



function getStateStore(env) {
  return env && env[AUTH_STATE_KV] ? env[AUTH_STATE_KV] : null;
}

async function stateGetText(kv, key) {
  return await kv.get(key);
}

async function stateGetJson(kv, key) {
  const value = await kv.get(key);
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

async function statePutJson(kv, key, value, expirationTtl) {
  const options = expirationTtl ? { expirationTtl } : undefined;
  await kv.put(key, JSON.stringify(value), options);
}

function getClientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    "unknown"
  ).split(",")[0].trim().slice(0, 128);
}

async function hashString(value) {
  return await sha256Hex(String(value));
}

function randomBytes(size) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).split("+").join("-").split("/").join("_").replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function getCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (key === name) return part.slice(index + 1).trim();
  }
  return "";
}

function sessionCookie(token) {
  return "__Host-imgstorage_session=" + token +
    "; Path=/; Max-Age=" + SESSION_TTL_SECONDS +
    "; HttpOnly; Secure; SameSite=Strict";
}

function expiredSessionCookie() {
  return "__Host-imgstorage_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict";
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

async function readJson(request, maxBytes) {
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) {
    throw imageError("request_body_too_large");
  }
  const text = new TextDecoder().decode(body);
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw imageError("invalid_json_body");
  }
  return value;
}

function validPassword(password) {
  const value = String(password || "");
  if (value.length < PASSWORD_MIN_LENGTH || value.length > 256) return false;
  if (!/[A-Z]/.test(value)) return false;
  if (!/[a-z]/.test(value)) return false;
  if (!/[0-9]/.test(value)) return false;
  return true;
}

async function hashPassword(password, saltBytes, iterations = 120000) {
  const salt = saltBytes || randomBytes(16);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations
    },
    baseKey,
    256
  );

  return {
    algorithm: "PBKDF2-SHA-256",
    iterations,
    salt: bytesToBase64Url(salt),
    hash: bytesToBase64Url(new Uint8Array(bits))
  };
}

async function verifyPassword(password, record) {
  if (!record || !record.hash || !record.salt || !record.iterations) return false;

  let salt;
  let expected;
  try {
    salt = base64UrlToBytes(record.salt);
    expected = base64UrlToBytes(record.hash);
  } catch {
    return false;
  }

  const derived = await hashPassword(password, salt, Number(record.iterations));
  let actual;
  try {
    actual = base64UrlToBytes(derived.hash);
  } catch {
    return false;
  }
  return bytesEqual(actual, expected);
}

async function loadPasswordRecord(kv) {
  return await stateGetJson(kv, "admin:password");
}

async function currentSessionEpoch(kv) {
  const value = await stateGetText(kv, "admin:session_epoch");
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

async function bumpSessionEpoch(kv) {
  const epoch = await currentSessionEpoch(kv);
  const next = epoch + 1;
  await kv.put("admin:session_epoch", String(next));
  return next;
}

async function createAdminSession(kv, mustChangePassword) {
  const token = bytesToBase64Url(randomBytes(32));
  const tokenHash = await sha256Hex(token);
  const epoch = await currentSessionEpoch(kv);
  const now = Date.now();
  const session = {
    createdAt: now,
    expiresAt: now + SESSION_TTL_SECONDS * 1000,
    epoch,
    mustChangePassword: Boolean(mustChangePassword)
  };
  await statePutJson(
    kv,
    "session:" + tokenHash,
    session,
    SESSION_TTL_SECONDS
  );
  return { token, session };
}

async function requireAdminSession(request, env, options = {}) {
  const kv = getStateStore(env);
  if (!kv) {
    return {
      ok: false,
      response: json({
        ok: false,
        error: "auth_state_store_not_configured"
      }, 503, { "Cache-Control": "no-store" })
    };
  }

  const token = getCookie(request, "__Host-imgstorage_session");
  if (!token || token.length < 32 || token.length > 256) {
    return {
      ok: false,
      response: json({
        ok: false,
        error: "admin_login_required"
      }, 401, { "Cache-Control": "no-store" })
    };
  }

  const tokenHash = await sha256Hex(token);
  const session = await stateGetJson(kv, "session:" + tokenHash);
  if (!session) {
    return {
      ok: false,
      response: json({
        ok: false,
        error: "admin_session_invalid"
      }, 401, {
        "Cache-Control": "no-store",
        "Set-Cookie": expiredSessionCookie()
      })
    };
  }

  if (Number(session.expiresAt) <= Date.now() ||
      Number(session.epoch) !== await currentSessionEpoch(kv)) {
    await kv.delete("session:" + tokenHash);
    return {
      ok: false,
      response: json({
        ok: false,
        error: "admin_session_expired"
      }, 401, {
        "Cache-Control": "no-store",
        "Set-Cookie": expiredSessionCookie()
      })
    };
  }

  if (session.mustChangePassword && !options.allowPasswordChange) {
    return {
      ok: false,
      response: json({
        ok: false,
        error: "password_change_required"
      }, 403, { "Cache-Control": "no-store" })
    };
  }

  return {
    ok: true,
    kv,
    token,
    tokenHash,
    session
  };
}

async function loginGuard(kv, ipHash) {
  const key = "login:guard:" + ipHash;
  const now = Date.now();
  let guard = await stateGetJson(kv, key);

  if (!guard || now - Number(guard.windowStart) >= LOGIN_WINDOW_MS) {
    guard = {
      windowStart: now,
      attempts: 0,
      lockedUntil: 0
    };
  }

  if (Number(guard.lockedUntil) > now) {
    return {
      blocked: true,
      retryAfter: Math.ceil((Number(guard.lockedUntil) - now) / 1000)
    };
  }

  return { blocked: false, guard, key };
}

async function recordLoginFailure(kv, ipHash, guard) {
  guard.attempts = Number(guard.attempts || 0) + 1;
  if (guard.attempts >= LOGIN_MAX_ATTEMPTS) {
    guard.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    guard.attempts = 0;
  }
  await statePutJson(kv, "login:guard:" + ipHash, guard, Math.ceil(LOGIN_WINDOW_MS / 1000));
}

async function clearLoginGuard(kv, ipHash) {
  await kv.delete("login:guard:" + ipHash);
}

async function verifyChallenge(kv, challengeId, counter, request) {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(String(challengeId || ""))) return false;
  if (!/^\d{1,10}$/.test(String(counter || ""))) return false;

  const challenge = await stateGetJson(kv, "challenge:" + challengeId);
  if (!challenge) return false;

  await kv.delete("challenge:" + challengeId);

  if (Date.now() - Number(challenge.issuedAt) > LOGIN_CHALLENGE_TTL_SECONDS * 1000) {
    return false;
  }

  const ipHash = await hashString(getClientIp(request));
  if (ipHash !== challenge.ipHash) return false;

  const numeric = Number(counter);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 0xffffffff) {
    return false;
  }

  const digest = await sha256Hex(String(challenge.nonce) + ":" + String(numeric));
  return digest.startsWith("0".repeat(POW_DIFFICULTY));
}

async function handleAuthChallenge(request, env, requestId) {
  const kv = getStateStore(env);
  if (!kv) {
    return json({ ok: false, error: "auth_state_store_not_configured", requestId }, 503, {
      "Cache-Control": "no-store"
    });
  }

  const ipHash = await hashString(getClientIp(request));
  const rateKey = "challenge:rate:" + ipHash;
  const rate = await stateGetJson(kv, rateKey);
  const now = Date.now();
  let nextRate = rate;
  if (!rate || now - Number(rate.windowStart) >= LOGIN_WINDOW_MS) {
    nextRate = { windowStart: now, count: 0 };
  }
  if (Number(nextRate.count) >= 20) {
    return json({
      ok: false,
      error: "challenge_rate_limited",
      retryAfter: Math.ceil((Number(nextRate.windowStart) + LOGIN_WINDOW_MS - now) / 1000),
      requestId
    }, 429, { "Cache-Control": "no-store" });
  }

  nextRate.count = Number(nextRate.count) + 1;
  await statePutJson(kv, rateKey, nextRate, Math.ceil(LOGIN_WINDOW_MS / 1000));

  const challengeId = bytesToBase64Url(randomBytes(18));
  const nonce = bytesToBase64Url(randomBytes(24));

  await statePutJson(kv, "challenge:" + challengeId, {
    nonce,
    ipHash,
    issuedAt: now
  }, LOGIN_CHALLENGE_TTL_SECONDS);

  return json({
    ok: true,
    challengeId,
    nonce,
    difficulty: POW_DIFFICULTY,
    expiresIn: LOGIN_CHALLENGE_TTL_SECONDS,
    requestId
  }, 200, {
    "Cache-Control": "no-store"
  });
}

async function handleAdminLogin(request, env, requestId) {
  if (!sameOrigin(request)) {
    return json({ ok: false, error: "origin_not_allowed", requestId }, 403, {
      "Cache-Control": "no-store"
    });
  }

  const kv = getStateStore(env);
  if (!kv) {
    return json({ ok: false, error: "auth_state_store_not_configured", requestId }, 503, {
      "Cache-Control": "no-store"
    });
  }

  const password = String(env.IMGSTORAGE_DEFAULT_ADMIN_PASSWORD || "");
  const ipHash = await hashString(getClientIp(request));
  const guard = await loginGuard(kv, ipHash);

  if (guard.blocked) {
    return json({
      ok: false,
      error: "login_locked",
      retryAfter: guard.retryAfter,
      requestId
    }, 429, {
      "Cache-Control": "no-store",
      "Retry-After": String(guard.retryAfter)
    });
  }

  let body;
  try {
    body = await readJson(request, 16 * 1024);
  } catch {
    await recordLoginFailure(kv, ipHash, guard.guard);
    return json({ ok: false, error: "invalid_login_body", requestId }, 400, {
      "Cache-Control": "no-store"
    });
  }

  const suppliedPassword = String(body.password || "");
  const challengeOk = await verifyChallenge(
    kv,
    String(body.challengeId || ""),
    String(body.counter || ""),
    request
  );

  if (!challengeOk) {
    await recordLoginFailure(kv, ipHash, guard.guard);
    return json({ ok: false, error: "invalid_bot_challenge", requestId }, 403, {
      "Cache-Control": "no-store"
    });
  }

  if (suppliedPassword.length > 256) {
    await recordLoginFailure(kv, ipHash, guard.guard);
    return json({ ok: false, error: "invalid_credentials", requestId }, 401, {
      "Cache-Control": "no-store"
    });
  }

  const storedRecord = await loadPasswordRecord(kv);

  if (!storedRecord && !validPassword(password)) {
    await recordLoginFailure(kv, ipHash, guard.guard);
    return json({
      ok: false,
      error: "admin_default_password_misconfigured",
      requestId
    }, 503, {
      "Cache-Control": "no-store"
    });
  }

  let passwordOk = false;
  let mustChange = false;

  if (storedRecord) {
    passwordOk = await verifyPassword(suppliedPassword, storedRecord);
  } else {
    mustChange = true;
    passwordOk = Boolean(password) && suppliedPassword === password;
  }

  if (!passwordOk) {
    await recordLoginFailure(kv, ipHash, guard.guard);
    return json({ ok: false, error: "invalid_credentials", requestId }, 401, {
      "Cache-Control": "no-store"
    });
  }

  await clearLoginGuard(kv, ipHash);
  const session = await createAdminSession(kv, mustChange);

  return json({
    ok: true,
    authenticated: true,
    mustChangePassword: mustChange,
    expiresIn: SESSION_TTL_SECONDS,
    requestId
  }, 200, {
    "Cache-Control": "no-store",
    "Set-Cookie": sessionCookie(session.token)
  });
}

async function handleAdminLogout(request, env, requestId) {
  const kv = getStateStore(env);
  if (kv) {
    const token = getCookie(request, "__Host-imgstorage_session");
    if (token) {
      await kv.delete("session:" + await sha256Hex(token));
    }
  }

  return json({
    ok: true,
    loggedOut: true,
    requestId
  }, 200, {
    "Cache-Control": "no-store",
    "Set-Cookie": expiredSessionCookie()
  });
}

async function handleAuthMe(request, env, requestId) {
  const auth = await requireAdminSession(request, env, { allowPasswordChange: true });
  if (!auth.ok) return auth.response;

  const serviceHmacRevoked = (await stateGetText(auth.kv, "service:revoked")) === "1";

  return json({
    ok: true,
    authenticated: true,
    mustChangePassword: Boolean(auth.session.mustChangePassword),
    expiresAt: auth.session.expiresAt,
    serviceHmacRevoked,
    requestId
  }, 200, {
    "Cache-Control": "no-store"
  });
}

async function handlePasswordChange(request, env, requestId) {
  if (!sameOrigin(request)) {
    return json({ ok: false, error: "origin_not_allowed", requestId }, 403, {
      "Cache-Control": "no-store"
    });
  }

  const auth = await requireAdminSession(request, env, { allowPasswordChange: true });
  if (!auth.ok) return auth.response;

  let body;
  try {
    body = await readJson(request, 16 * 1024);
  } catch {
    return json({ ok: false, error: "invalid_password_body", requestId }, 400, {
      "Cache-Control": "no-store"
    });
  }

  const currentPassword = String(body.currentPassword || "");
  const newPassword = String(body.newPassword || "");

  if (!validPassword(newPassword)) {
    return json({
      ok: false,
      error: "weak_new_password",
      requirements: {
        minLength: PASSWORD_MIN_LENGTH,
        uppercase: true,
        lowercase: true,
        digit: true
      },
      requestId
    }, 400, {
      "Cache-Control": "no-store"
    });
  }

  const storedRecord = await loadPasswordRecord(auth.kv);
  let currentOk = false;

  if (storedRecord) {
    currentOk = await verifyPassword(currentPassword, storedRecord);
  } else {
    const defaultPassword = String(env.IMGSTORAGE_DEFAULT_ADMIN_PASSWORD || "");
    currentOk = Boolean(defaultPassword) && currentPassword === defaultPassword;
  }

  if (!currentOk) {
    return json({ ok: false, error: "current_password_invalid", requestId }, 401, {
      "Cache-Control": "no-store"
    });
  }

  const record = await hashPassword(newPassword);
  record.changedAt = Date.now();
  await statePutJson(auth.kv, "admin:password", record);

  await bumpSessionEpoch(auth.kv);
  const newSession = await createAdminSession(auth.kv, false);

  return json({
    ok: true,
    passwordChanged: true,
    requestId
  }, 200, {
    "Cache-Control": "no-store",
    "Set-Cookie": sessionCookie(newSession.token)
  });
}

async function handleSessionRevoke(request, env, requestId) {
  if (!sameOrigin(request)) {
    return json({ ok: false, error: "origin_not_allowed", requestId }, 403, {
      "Cache-Control": "no-store"
    });
  }

  const auth = await requireAdminSession(request, env);
  if (!auth.ok) return auth.response;

  await bumpSessionEpoch(auth.kv);

  return json({
    ok: true,
    sessionsRevoked: true,
    requestId
  }, 200, {
    "Cache-Control": "no-store",
    "Set-Cookie": expiredSessionCookie()
  });
}

async function handleServiceRevoke(request, env, requestId, revoke) {
  if (!sameOrigin(request)) {
    return json({ ok: false, error: "origin_not_allowed", requestId }, 403, {
      "Cache-Control": "no-store"
    });
  }

  const auth = await requireAdminSession(request, env);
  if (!auth.ok) return auth.response;

  await auth.kv.put("service:revoked", revoke ? "1" : "0");

  return json({
    ok: true,
    serviceHmacRevoked: revoke,
    requestId
  }, 200, {
    "Cache-Control": "no-store"
  });
}

async function s3Request({ method, key, body, contentType, env }) {
  const endpoint = String(env.DBBYTE_ENDPOINT || "").trim().replace(/\/$/, "");
  const bucket = String(env.DBBYTE_BUCKET_NAME || "").trim();
  const region = String(env.DBBYTE_REGION || "us-east-1").trim();
  const accessKeyId = String(env.DBBYTE_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = String(env.DBBYTE_SECRET_ACCESS_KEY || "").trim();

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return {
      ok: false,
      status: 503,
      response: new Response("DBByte storage is not configured", { status: 503 })
    };
  }

  if (!isSafeObjectKey(key)) {
    return {
      ok: false,
      status: 400,
      response: new Response("Invalid object key", { status: 400 })
    };
  }

  const url = new URL(endpoint + "/" + encodeURIComponent(bucket) + "/" + encodeKeyForPath(key));
  const host = url.host;

  const payloadHash = await sha256Hex(method === "PUT" ? body : new ArrayBuffer(0));
  const amzDate = toAmzDate(new Date());
  const dateStamp = amzDate.slice(0, 8);
  const service = "s3";

  const canonicalUri = "/" +
    encodeURIComponent(bucket) +
    "/" +
    encodeKeyForPath(key);

  const canonicalHeaders = [
    "host:" + host,
    "x-amz-content-sha256:" + payloadHash,
    "x-amz-date:" + amzDate
  ];

  const signedHeaders = [
    "host",
    "x-amz-content-sha256",
    "x-amz-date"
  ];

  if (method === "PUT" && contentType) {
    canonicalHeaders.splice(1, 0, "content-type:" + contentType);
    signedHeaders.splice(1, 0, "content-type");
  }

  const canonicalRequest = [
    method,
    canonicalUri,
    "",
    canonicalHeaders.join("\n") + "\n",
    signedHeaders.join(";"),
    payloadHash
  ].join("\n");

  const scope = [
    dateStamp,
    region,
    service,
    "aws4_request"
  ].join("/");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest)
  ].join("\n");

  const signingKey = await getSignatureKey(
    secretAccessKey,
    dateStamp,
    region,
    service
  );

  const signature = await hmacHexRaw(signingKey, stringToSign);

  const authorization =
    "AWS4-HMAC-SHA256 " +
    "Credential=" + accessKeyId + "/" + scope + "," +
    "SignedHeaders=" + signedHeaders.join(";") + "," +
    "Signature=" + signature;

  const headers = new Headers({
    "X-Amz-Date": amzDate,
    "X-Amz-Content-Sha256": payloadHash,
    "Authorization": authorization
  });

  if (method === "PUT" && contentType) {
    headers.set("Content-Type", contentType);
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    body: method === "PUT" ? body : undefined,
    redirect: "manual"
  });

  return {
    ok: response.ok,
    status: response.status,
    response
  };
}

function detectImageType(buffer) {
  const b = new Uint8Array(buffer);
  if (b.length >= 3 &&
      b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    return { mime: "image/jpeg" };
  }

  if (b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return { mime: "image/png" };
  }

  if (b.length >= 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    return { mime: "image/webp" };
  }

  if (b.length >= 6 &&
      b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 &&
      ((b[3] === 0x38 && b[4] === 0x37 && b[5] === 0x61) ||
       (b[3] === 0x38 && b[4] === 0x39 && b[5] === 0x61))) {
    return { mime: "image/gif" };
  }

  if (b.length >= 12) {
    const major = ascii(b.slice(4, 8));
    const brand = ascii(b.slice(8, 12));
    if (major === "ftyp" && (brand === "avif" || brand === "avis")) {
      return { mime: "image/avif" };
    }
  }

  return null;
}

function safeImageMime(value) {
  const mime = normalizeMime(value);
  return ALLOWED_IMAGE_TYPES.has(mime) ? mime : null;
}

function normalizeMime(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function isSafeObjectKey(key) {
  if (!key || key.length > 512) return false;
  if (!key.startsWith(KEY_PREFIX)) return false;
  if (key.includes("..") || key.includes("\\") || key.includes("\0")) return false;
  if (!/^[A-Za-z0-9._\/-]+$/.test(key)) return false;
  return true;
}

function decodeMediaKey(pathname) {
  const raw = pathname.slice("/media/".length);
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return "";
  }
}

function encodeKeyForPath(key) {
  return key
    .split("/")
    .map(part => encodeURIComponent(part))
    .join("/");
}

function makeObjectKey(ext) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return KEY_PREFIX + yyyy + "/" + mm + "/" + dd + "/" +
    crypto.randomUUID() + "." + ext;
}

function toAmzDate(date) {
  const p = n => String(n).padStart(2, "0");
  return date.getUTCFullYear() +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) + "T" +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) + "Z";
}

async function getSignatureKey(secret, dateStamp, region, service) {
  const kDate = await hmacBytes("AWS4" + secret, dateStamp);
  const kRegion = await hmacBytes(kDate, region);
  const kService = await hmacBytes(kRegion, service);
  return await hmacBytes(kService, "aws4_request");
}

async function hmacBytes(keyInput, data) {
  const keyData = typeof keyInput === "string"
    ? new TextEncoder().encode(keyInput)
    : keyInput;

  const key = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data))
  );
}

async function hmacHex(secret, data) {
  const bytes = await hmacBytes(secret, data);
  return bytesToHex(bytes);
}

async function hmacHexRaw(keyBytes, data) {
  const bytes = await hmacBytes(keyBytes, data);
  return bytesToHex(bytes);
}

async function sha256Hex(value) {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value;

  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

function timingSafeEqual(a, b) {
  const aa = String(a);
  const bb = String(b);

  if (aa.length !== bb.length) return false;

  let diff = 0;
  for (let i = 0; i < aa.length; i++) {
    diff |= aa.charCodeAt(i) ^ bb.charCodeAt(i);
  }

  return diff === 0;
}

function bytesToHex(bytes) {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function ascii(bytes) {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}


function adminPage(requestId, headOnly = false) {
  const nonce = bytesToBase64Url(randomBytes(18));

  if (headOnly) {
    return new Response(null, {
      status: 200,
      headers: adminPageHeaders(nonce, requestId)
    });
  }

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Imgstorage Admin</title>
<style>
:root{color-scheme:dark;--bg:#070b12;--card:#0e1624;--line:#223047;--text:#eaf2ff;--muted:#93a4bf;--accent:#65b8ff;--danger:#ff6b7a;--ok:#67e58b}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:radial-gradient(circle at top,#102238 0,#070b12 48%);font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--text);padding:24px}
main{width:min(760px,100%);margin:0 auto}
.card{background:rgba(14,22,36,.94);border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 18px 60px rgba(0,0,0,.3);backdrop-filter:blur(8px)}
h1{font-size:24px;margin:0 0 8px}
h2{font-size:18px;margin:24px 0 10px}
p{color:var(--muted);line-height:1.5}
label{display:block;margin:14px 0 7px;font-size:14px;color:#c7d5e8}
input{width:100%;padding:12px 13px;border-radius:11px;border:1px solid #2b3b55;background:#09111d;color:var(--text);outline:none}
input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(101,184,255,.12)}
button{border:0;border-radius:11px;padding:11px 14px;font-weight:700;cursor:pointer;background:var(--accent);color:#06101c;margin:6px 6px 0 0}
button.secondary{background:#1b2a3e;color:var(--text)}
button.danger{background:var(--danger);color:#22050a}
button:disabled{opacity:.55;cursor:not-allowed}
.hidden{display:none}
.status{margin:14px 0;padding:11px 13px;border-radius:10px;background:#0a1220;border:1px solid var(--line);white-space:pre-wrap}
.status.ok{border-color:rgba(103,229,139,.45);color:var(--ok)}
.status.err{border-color:rgba(255,107,122,.45);color:#ffb7bf}
.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
@media(max-width:620px){body{padding:12px}.grid{grid-template-columns:1fr}}
small{color:var(--muted)}
.badge{display:inline-block;padding:4px 8px;border-radius:999px;background:#15263a;color:#b9d8ff;font-size:12px}
</style>
</head>
<body>
<main>
<section id="loginCard" class="card">
  <h1>Imgstorage Admin</h1>
  <p>Protected administrator console. Browser session uses an HttpOnly, Secure, SameSite=Strict cookie.</p>
  <label for="password">Password</label>
  <input id="password" type="password" autocomplete="current-password" maxlength="256">
  <button id="loginBtn">Login</button>
  <div id="loginStatus" class="status hidden"></div>
</section>

<section id="panel" class="card hidden">
  <h1>Admin Console</h1>
  <p>Session: <span id="sessionBadge" class="badge">checking…</span></p>
  <div id="panelStatus" class="status hidden"></div>

  <h2>Service HMAC</h2>
  <p id="serviceState">Checking…</p>
  <button id="serviceBtn">...</button>

  <h2>Security</h2>
  <div class="grid">
    <button id="revokeSessions" class="danger">Revoke all sessions</button>
    <button id="logout" class="secondary">Logout</button>
  </div>

  <h2>Change admin password</h2>
  <label for="currentPassword">Current password</label>
  <input id="currentPassword" type="password" autocomplete="current-password" maxlength="256">
  <label for="newPassword">New password</label>
  <input id="newPassword" type="password" autocomplete="new-password" maxlength="256">
  <label for="confirmPassword">Confirm new password</label>
  <input id="confirmPassword" type="password" autocomplete="new-password" maxlength="256">
  <button id="changePassword">Change password</button>
  <p><small>Minimum 14 characters, including uppercase, lowercase, and a digit.</small></p>
</section>
</main>

<script nonce="${nonce}">
const $ = (id) => document.getElementById(id);

function showStatus(el, message, ok=false) {
  el.textContent = message || "";
  el.classList.remove("hidden","ok","err");
  el.classList.add(ok ? "ok" : "err");
}

function hideStatus(el) {
  el.textContent = "";
  el.classList.add("hidden");
  el.classList.remove("ok","err");
}

async function api(path, options={}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  let body = null;
  try { body = await response.json(); } catch {}
  return { response, body };
}

async function solvePow(nonce, difficulty) {
  const prefix = "0".repeat(Number(difficulty) || 0);
  const encoder = new TextEncoder();
  for (let counter = 0; counter <= 0xffffffff; counter++) {
    const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(nonce + ":" + counter));
    const hex = [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2,"0")).join("");
    if (hex.startsWith(prefix)) return String(counter);
    if ((counter & 4095) === 0) await new Promise(r => setTimeout(r, 0));
  }
  throw new Error("PoW exhausted");
}

async function loadMe() {
  const {response, body} = await api("/api/auth/me", {method:"GET", headers:{}});
  if (!response.ok || !body?.authenticated) {
    $("loginCard").classList.remove("hidden");
    $("panel").classList.add("hidden");
    return false;
  }
  $("loginCard").classList.add("hidden");
  $("panel").classList.remove("hidden");
  $("sessionBadge").textContent = body.mustChangePassword ? "password change required" : "authenticated";
  $("serviceState").textContent = body.serviceHmacRevoked ? "HMAC service access is REVOKED." : "HMAC service access is ACTIVE.";
  $("serviceBtn").textContent = body.serviceHmacRevoked ? "Enable HMAC service" : "Revoke HMAC service";
  $("serviceBtn").className = body.serviceHmacRevoked ? "secondary" : "danger";
  if (body.mustChangePassword) {
    showStatus($("panelStatus"), "Change the default admin password before using the console.", false);
  } else {
    hideStatus($("panelStatus"));
  }
  return true;
}

$("loginBtn").addEventListener("click", async () => {
  const btn = $("loginBtn");
  const status = $("loginStatus");
  btn.disabled = true;
  showStatus(status, "Requesting anti-bot challenge…");
  try {
    const challenge = await api("/api/auth/challenge", {method:"GET", headers:{}});
    if (!challenge.response.ok) throw new Error(challenge.body?.error || "challenge_failed");
    showStatus(status, "Solving proof-of-work…");
    const counter = await solvePow(challenge.body.nonce, challenge.body.difficulty);
    const login = await api("/api/auth/login", {
      method:"POST",
      body: JSON.stringify({
        password: $("password").value,
        challengeId: challenge.body.challengeId,
        counter
      })
    });
    if (!login.response.ok) throw new Error(login.body?.error || "login_failed");
    $("password").value = "";
    await loadMe();
    showStatus($("panelStatus"), login.body.mustChangePassword ? "Login successful. Change the default password now." : "Login successful.", true);
  } catch (error) {
    showStatus(status, String(error.message || error));
  } finally {
    btn.disabled = false;
  }
});

$("changePassword").addEventListener("click", async () => {
  const currentPassword = $("currentPassword").value;
  const newPassword = $("newPassword").value;
  const confirmPassword = $("confirmPassword").value;
  if (newPassword !== confirmPassword) {
    showStatus($("panelStatus"), "New password confirmation does not match.");
    return;
  }
  const result = await api("/api/auth/password", {
    method:"POST",
    body: JSON.stringify({currentPassword, newPassword})
  });
  if (!result.response.ok) {
    showStatus($("panelStatus"), result.body?.error || "password_change_failed");
    return;
  }
  $("currentPassword").value = "";
  $("newPassword").value = "";
  $("confirmPassword").value = "";
  showStatus($("panelStatus"), "Password changed and previous sessions revoked.", true);
  await loadMe();
});

$("revokeSessions").addEventListener("click", async () => {
  const result = await api("/api/auth/revoke-sessions", {method:"POST",body:"{}"});
  if (!result.response.ok) {
    showStatus($("panelStatus"), result.body?.error || "session_revoke_failed");
    return;
  }
  $("panel").classList.add("hidden");
  $("loginCard").classList.remove("hidden");
  showStatus($("loginStatus"), "All sessions were revoked. Log in again.", true);
});

$("serviceBtn").addEventListener("click", async () => {
  const me = await api("/api/auth/me", {method:"GET",headers:{}});
  const revoked = Boolean(me.body?.serviceHmacRevoked);
  const endpoint = revoked ? "/api/service/unrevoke" : "/api/service/revoke";
  const result = await api(endpoint, {method:"POST",body:"{}"});
  if (!result.response.ok) {
    showStatus($("panelStatus"), result.body?.error || "service_state_change_failed");
    return;
  }
  await loadMe();
  showStatus($("panelStatus"), revoked ? "HMAC service access enabled." : "HMAC service access revoked.", true);
});

$("logout").addEventListener("click", async () => {
  await api("/api/auth/logout", {method:"POST",body:"{}"});
  location.reload();
});

loadMe().catch(() => {
  $("loginCard").classList.remove("hidden");
  $("panel").classList.add("hidden");
});
</script>
</body>
</html>`;

  const headers = adminPageHeaders(nonce, requestId);
  return new Response(html, { status: 200, headers });
}

function adminPageHeaders(nonce, requestId) {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, no-cache, max-age=0, must-revalidate",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'",
    "X-Request-Id": requestId
  };
}

function corsPreflight(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = allowedStoreOrigin(request, origin, env);

  const headers = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Img-Timestamp, X-Img-Request-Id, X-Img-Signature",
    "Access-Control-Max-Age": "600"
  };

  if (allowed) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return new Response(null, {
    status: 204,
    headers
  });
}

function allowedStoreOrigin(request, origin, env) {
  if (!origin) return false;
  const allowed = String(env.STORE_ORIGIN || "").trim();
  return Boolean(allowed && origin === allowed);
}

function json(value, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });

  return new Response(JSON.stringify(value), {
    status,
    headers
  });
}

function methodNotAllowed(allowed, requestId) {
  return json({
    ok: false,
    error: "method_not_allowed",
    allowed,
    requestId
  }, 405, {
    "Allow": allowed.join(", "),
    "Cache-Control": "no-store"
  });
}
