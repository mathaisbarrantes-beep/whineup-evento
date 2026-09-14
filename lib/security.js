"use strict";

const crypto = require("crypto");
const { config } = require("./config");

/** Escapa texto que se va a insertar en HTML (correos y paneles). */
function escapeHtml(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Cabeceras de seguridad + Content Security Policy. */
function securityHeaders(req, res, next) {
  const csp = [
    "default-src 'self'",
    // Tailwind CDN y html5-qrcode necesitan 'unsafe-eval'/'unsafe-inline'.
    // Ver RECOMENDACIONES.md: compilar Tailwind elimina esta excepcion.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join("; ");

  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(self), microphone=(), geolocation=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");

  if (config.isProduction) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  next();
}

/** Nunca cachear respuestas con datos de tickets. */
function noStore(req, res, next) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  next();
}

function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (forwarded) return forwarded;
  }
  return req.ip || req.socket?.remoteAddress || "desconocida";
}

const RATE_BUCKETS = new Map();

function pruneBuckets(now) {
  if (RATE_BUCKETS.size < 5000) return;
  for (const [key, bucket] of RATE_BUCKETS) {
    if (now > bucket.resetAt) RATE_BUCKETS.delete(key);
  }
}

/**
 * Limite de peticiones por IP, en memoria.
 * En serverless el contador es por instancia: es una primera barrera,
 * no un sustituto de un WAF (Cloudflare, Vercel Firewall).
 */
function rateLimit({ windowMs, max, key = "global", mensaje }) {
  return function rateLimitMiddleware(req, res, next) {
    const now = Date.now();
    pruneBuckets(now);

    const bucketKey = `${key}:${clientIp(req)}`;
    let bucket = RATE_BUCKETS.get(bucketKey);

    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
    }

    bucket.count += 1;
    RATE_BUCKETS.set(bucketKey, bucket);

    if (bucket.count > max) {
      const segundos = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(segundos));
      return res.status(429).json({
        ok: false,
        mensaje: mensaje || `Demasiadas peticiones. Intenta de nuevo en ${segundos} segundos.`
      });
    }

    return next();
  };
}

function readCookies(req) {
  const raw = req.headers.cookie || "";
  const cookies = {};

  raw.split(";").forEach((cookie) => {
    const separator = cookie.indexOf("=");
    if (separator < 1) return;
    const key = cookie.slice(0, separator).trim();
    const value = cookie.slice(separator + 1).trim();
    if (!key) return;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch (error) {
      cookies[key] = value;
    }
  });

  return cookies;
}

/** Comparacion en tiempo constante tolerante a longitudes distintas. */
function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) {
    // Comparamos igualmente para no filtrar la longitud por tiempo.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

module.exports = {
  escapeHtml,
  securityHeaders,
  noStore,
  rateLimit,
  readCookies,
  clientIp,
  safeEqual,
  sha256
};
