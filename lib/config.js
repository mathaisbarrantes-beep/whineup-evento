"use strict";

/**
 * Punto unico de lectura de process.env.
 * Ningun otro modulo debe tocar variables de entorno directamente:
 * asi es imposible filtrar una credencial a una respuesta HTTP por descuido.
 */

require("dotenv").config();

const crypto = require("crypto");

const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

function readString(name, fallback = "") {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function readBoolean(name, fallback = false) {
  const value = readString(name).toLowerCase();
  if (!value) return fallback;
  return value === "true" || value === "1" || value === "yes";
}

function parseStaffUsers() {
  const raw = readString("STAFF_USERS", "[]");

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((user) => user && typeof user.username === "string")
      .map((user) => ({
        username: String(user.username).trim().toLowerCase(),
        passwordHash: typeof user.passwordHash === "string" ? user.passwordHash : "",
        password: typeof user.password === "string" ? user.password : "",
        role: user.role === "admin" ? "admin" : "staff",
        name: typeof user.name === "string" && user.name.trim() ? user.name.trim() : String(user.username)
      }));
  } catch (error) {
    console.error("[config] STAFF_USERS no es un JSON valido:", error.message);
    return [];
  }
}

const firebase = {
  projectId: readString("FIREBASE_PROJECT_ID"),
  clientEmail: readString("FIREBASE_CLIENT_EMAIL"),
  privateKey: readString("FIREBASE_PRIVATE_KEY").replace(/\n/g, "\n"),
  serviceAccountFile: readString("FIREBASE_SERVICE_ACCOUNT_FILE")
};

const emailjs = {
  serviceId: readString("EMAILJS_SERVICE_ID"),
  publicKey: readString("EMAILJS_PUBLIC_KEY"),
  privateKey: readString("EMAILJS_PRIVATE_KEY"),
  templateCompra: readString("EMAILJS_TEMPLATE_COMPRA"),
  templateTicket: readString("EMAILJS_TEMPLATE_TICKET"),
  endpoint: readString("EMAILJS_ENDPOINT", "https://api.emailjs.com/api/v1.0/email/send")
};

const smtp = {
  host: readString("SMTP_HOST"),
  port: readNumber("SMTP_PORT", 587),
  secure: readBoolean("SMTP_SECURE", false),
  user: readString("SMTP_USER"),
  password: readString("SMTP_PASSWORD"),
  from: readString("SMTP_FROM") || readString("SMTP_USER")
};

// En desarrollo generamos un secreto efimero para no bloquear el arranque:
// los QR firmados con el dejan de ser validos al reiniciar, y eso es correcto.
const ticketSecret = readString("TICKET_SIGNING_SECRET") ||
  (IS_PRODUCTION ? "" : crypto.randomBytes(32).toString("hex"));

const config = {
  nodeEnv: NODE_ENV,
  isProduction: IS_PRODUCTION,
  port: readNumber("PORT", 3000),
  publicUrl: readString("PUBLIC_URL").replace(/\/+$/, ""),
  trustProxy: readBoolean("TRUST_PROXY", IS_PRODUCTION),
  sessionTtlMs: readNumber("SESSION_TTL_HOURS", 12) * 60 * 60 * 1000,
  ticketSecret,
  staffUsers: parseStaffUsers(),
  firebase,
  emailjs,
  smtp,
  paymentPhone: readString("PAYMENT_PHONE"),
  // Superficie publica: lo unico que el navegador puede llegar a ver.
  publicSnapshot() {
    return {
      entorno: NODE_ENV,
      pagoTelefono: config.paymentPhone || null
    };
  }
};

/** Errores que impiden operar de forma segura en produccion. */
function validateConfig() {
  const errors = [];
  const warnings = [];

  if (!config.ticketSecret || config.ticketSecret.length < 32) {
    errors.push("TICKET_SIGNING_SECRET falta o es demasiado corto (minimo 32 caracteres). Genera uno con: node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\"");
  }

  const hasFirebase = Boolean(
    (firebase.projectId && firebase.clientEmail && firebase.privateKey) || firebase.serviceAccountFile
  );

  if (IS_PRODUCTION && !hasFirebase) {
    errors.push("Firestore no esta configurado. El almacenamiento en memoria NO garantiza que un QR se use una sola vez.");
  }

  if (IS_PRODUCTION && !config.staffUsers.length) {
    errors.push("STAFF_USERS esta vacio: nadie podria validar entradas.");
  }

  if (IS_PRODUCTION && config.staffUsers.some((user) => !user.passwordHash)) {
    errors.push("Hay usuarios de STAFF_USERS sin passwordHash. Las contrasenas en texto plano estan prohibidas en produccion.");
  }

  if (IS_PRODUCTION && !config.publicUrl) {
    errors.push("PUBLIC_URL es obligatorio en produccion: se usa para construir los enlaces del QR en el correo.");
  }

  const emailjsReady = Boolean(
    emailjs.serviceId && emailjs.publicKey && emailjs.privateKey && emailjs.templateTicket
  );
  const smtpReady = Boolean(smtp.host && smtp.user && smtp.password);

  if (IS_PRODUCTION && !emailjsReady && !smtpReady) {
    errors.push("No hay forma de enviar correos: configura EmailJS (recomendado) o SMTP.");
  }

  if (!emailjsReady && smtpReady) {
    warnings.push("EmailJS no esta configurado; se usara SMTP como respaldo.");
  }

  if (!IS_PRODUCTION && !hasFirebase) {
    warnings.push("Sin Firestore: modo memoria, solo para desarrollo local.");
  }

  return { errors, warnings, hasFirebase, emailjsReady, smtpReady };
}

module.exports = { config, validateConfig };
