"use strict";

const crypto = require("crypto");
const { config } = require("./config");
const store = require("./store");
const { readCookies, safeEqual, clientIp } = require("./security");

const AUTH_COOKIE = "whineup_staff_session";
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;

/**
 * Formato del hash: scrypt$<salt hex>$<hash hex de 64 bytes>
 * Generar con: npm run hash -- "TU CONTRASENA"
 */
function verificarPassword(password, user) {
  if (user.passwordHash) {
    const partes = String(user.passwordHash).split("$");
    if (partes.length !== 3 || partes[0] !== "scrypt") return false;

    const [, salt, esperado] = partes;
    if (!salt || !/^[a-f0-9]{128}$/i.test(esperado)) return false;

    let calculado;
    try {
      calculado = crypto.scryptSync(password, salt, 64).toString("hex");
    } catch (error) {
      return false;
    }

    return safeEqual(calculado.toLowerCase(), esperado.toLowerCase());
  }

  // Contrasenas en texto plano: solo en desarrollo, nunca en produccion.
  return !config.isProduction && Boolean(user.password) && safeEqual(password, user.password);
}

function crearToken() {
  return crypto.randomBytes(32).toString("hex");
}

function cookieOptions(maxAge) {
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: config.isProduction,
    path: "/",
    maxAge
  };
}

async function iniciarSesion(req, res, { username, password }) {
  const usuario = String(username || "").trim().toLowerCase();
  const clave = String(password || "");

  if (!usuario || !clave) {
    return { ok: false, status: 400, mensaje: "Usuario y contrasena requeridos." };
  }

  // Limitamos por usuario y por IP: ninguno de los dos vectores queda abierto.
  const [porUsuario, porIp] = await Promise.all([
    store.registrarIntentoLogin(`user:${usuario}`, LOGIN_WINDOW_MS),
    store.registrarIntentoLogin(`ip:${clientIp(req)}`, LOGIN_WINDOW_MS)
  ]);

  if (porUsuario.intentos > LOGIN_MAX_ATTEMPTS || porIp.intentos > LOGIN_MAX_ATTEMPTS * 3) {
    return { ok: false, status: 429, mensaje: "Demasiados intentos. Espera 15 minutos." };
  }

  const candidato = config.staffUsers.find((item) => item.username === usuario);
  const valido = candidato ? verificarPassword(clave, candidato) : false;

  if (!candidato || !valido) {
    // Mismo mensaje para usuario inexistente y contrasena incorrecta.
    return { ok: false, status: 401, mensaje: "Credenciales no validas." };
  }

  // Los contadores solo deben castigar fallos: si no, un equipo de staff
  // entrando desde el wifi del local se bloquearia a si mismo.
  await Promise.all([
    store.limpiarIntentosLogin(`user:${usuario}`),
    store.limpiarIntentosLogin(`ip:${clientIp(req)}`)
  ]);

  const token = crearToken();
  const sesion = {
    username: candidato.username,
    role: candidato.role,
    name: candidato.name,
    creadaEn: new Date().toISOString(),
    expiresAt: Date.now() + config.sessionTtlMs
  };

  await store.saveSession(token, sesion);
  res.cookie(AUTH_COOKIE, token, cookieOptions(config.sessionTtlMs));

  return {
    ok: true,
    status: 200,
    mensaje: "Sesion iniciada.",
    user: { username: sesion.username, role: sesion.role, name: sesion.name }
  };
}

async function cerrarSesion(req, res) {
  const token = readCookies(req)[AUTH_COOKIE];
  if (token) {
    await store.deleteSession(token).catch(() => {});
  }
  res.clearCookie(AUTH_COOKIE, { ...cookieOptions(0), maxAge: undefined });
}

async function obtenerSesion(req) {
  const token = readCookies(req)[AUTH_COOKIE];
  if (!token) return null;

  const sesion = await store.getSession(token).catch(() => null);
  if (!sesion) return null;

  if (Date.now() > Number(sesion.expiresAt || 0)) {
    await store.deleteSession(token).catch(() => {});
    return null;
  }

  // El rol se revalida contra la configuracion vigente: si quitas a alguien
  // de STAFF_USERS, su sesion deja de servir sin esperar a que expire.
  const actual = config.staffUsers.find((item) => item.username === sesion.username);
  if (!actual) return null;

  return { ...sesion, role: actual.role, name: actual.name };
}

/** Protege endpoints JSON. roles: lista de roles admitidos. */
function requireStaff(...roles) {
  const permitidos = roles.length ? roles : ["admin", "staff"];

  return async function middleware(req, res, next) {
    try {
      const sesion = await obtenerSesion(req);

      if (!sesion) {
        return res.status(401).json({ ok: false, mensaje: "No autorizado." });
      }

      if (!permitidos.includes(sesion.role)) {
        return res.status(403).json({ ok: false, mensaje: "No tienes permiso para esta accion." });
      }

      req.staff = sesion;
      return next();
    } catch (error) {
      console.error("[auth] Error verificando sesion:", error.message);
      return res.status(500).json({ ok: false, mensaje: "No se pudo verificar la sesion." });
    }
  };
}

/** Protege paginas HTML: sin sesion, redirige al login en vez de devolver JSON. */
function requirePage(...roles) {
  const permitidos = roles.length ? roles : ["admin", "staff"];

  return async function middleware(req, res, next) {
    try {
      const sesion = await obtenerSesion(req);
      if (!sesion || !permitidos.includes(sesion.role)) {
        return res.redirect("/login");
      }
      req.staff = sesion;
      return next();
    } catch (error) {
      return res.redirect("/login");
    }
  };
}

/**
 * Rechaza peticiones que cambian estado si vienen de otro origen.
 * Segunda barrera frente a CSRF, ademas de SameSite=strict.
 */
function verificarOrigen(req, res, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();

  const origen = req.headers.origin;
  if (!origen) return next(); // Peticiones no-navegador (curl, apps moviles).

  const permitidos = new Set();
  if (config.publicUrl) permitidos.add(config.publicUrl);
  const host = req.headers.host;
  if (host) {
    permitidos.add(`https://${host}`);
    if (!config.isProduction) permitidos.add(`http://${host}`);
  }

  if (!permitidos.has(origen.replace(/\/+$/, ""))) {
    return res.status(403).json({ ok: false, mensaje: "Origen no permitido." });
  }

  return next();
}

module.exports = {
  AUTH_COOKIE,
  iniciarSesion,
  cerrarSesion,
  obtenerSesion,
  requireStaff,
  requirePage,
  verificarOrigen,
  verificarPassword
};
