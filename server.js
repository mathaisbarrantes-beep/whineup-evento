require("dotenv").config();

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const QRCode = require("qrcode");
const nodemailer = require("nodemailer");
const admin = require("firebase-admin");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const AUTH_COOKIE = "whineup_staff_session";
const AUTH_SESSION_TTL = 1000 * 60 * 60 * 12;
const MEMORY_TICKETS = new Map();
const STAFF_SESSIONS = new Map();
const LOGIN_ATTEMPTS = new Map();

const EVENTOS = [
  {
    id: "nightwave-2026",
    nombre: "NightWave Festival",
    fecha: "12 Oct 2026",
    lugar: "Plaza del Sol, Madrid",
    precio: 45000,
    categoria: "General",
    descripcion: "Música en vivo, DJs, barra y ambiente premium durante toda la noche."
  },
  {
    id: "sunset-club",
    nombre: "Sunset Club",
    fecha: "25 Oct 2026",
    lugar: "Terreno Sur, Valencia",
    precio: 68000,
    categoria: "VIP",
    descripcion: "Acceso exclusivo con zona lounge, cócteles y vista panorámica."
  },
  {
    id: "creative-summit",
    nombre: "Creative Summit",
    fecha: "02 Nov 2026",
    lugar: "Centro de Congresos, Barcelona",
    precio: 32000,
    categoria: "Early Access",
    descripcion: "Networking, speakers internacionales y experiencia de innovación."
  }
];

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (IS_PRODUCTION) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

function correoValido(correo) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo);
}

function parseStaffUsers() {
  const raw = process.env.STAFF_USERS || "[]";

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("STAFF_USERS no es un JSON valido:", error.message);
    return [];
  }
}

const STAFF_USERS = parseStaffUsers();

function createSessionToken() {
  return crypto.randomBytes(24).toString("hex");
}

function verifyStaffPassword(password, user) {
  if (user.passwordHash) {
    const [, salt, expected] = String(user.passwordHash).split("$");
    if (!salt || !expected || !/^[a-f0-9]{128}$/i.test(expected)) return false;
    const actual = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
  }

  return !IS_PRODUCTION && user.password === password;
}

function readCookies(req) {
  const raw = req.headers.cookie || "";
  const cookies = {};

  raw.split(";").forEach((cookie) => {
    const [key, ...valueParts] = cookie.split("=");
    if (!key) return;
    const value = valueParts.join("=");
    cookies[key.trim()] = decodeURIComponent((value || "").trim());
  });

  return cookies;
}

function getStaffSession(req) {
  const cookies = readCookies(req);
  const token = cookies[AUTH_COOKIE];
  if (!token || !STAFF_SESSIONS.has(token)) return null;

  const session = STAFF_SESSIONS.get(token);
  if (Date.now() > session.expiresAt) {
    STAFF_SESSIONS.delete(token);
    return null;
  }

  return session;
}

function requireStaffAuth(req, res, next) {
  const session = getStaffSession(req);

  if (!session) {
    return res.status(401).json({ ok: false, mensaje: "No autorizado." });
  }

  req.staffSession = session;
  return next();
}

function loginRateLimit(username) {
  const now = Date.now();
  const current = LOGIN_ATTEMPTS.get(username) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > current.resetAt) {
    current.count = 0;
    current.resetAt = now + 15 * 60 * 1000;
  }
  current.count += 1;
  LOGIN_ATTEMPTS.set(username, current);
  return current.count <= 10;
}

function findEvent(eventId, eventName) {
  return EVENTOS.find((item) => item.id === eventId || item.nombre === eventName) || null;
}

// Inicializa Firebase solo cuando las credenciales ya estan configuradas.
const firebaseServiceAccountFile = process.env.FIREBASE_SERVICE_ACCOUNT_FILE;
let firebaseServiceAccount = null;

if (firebaseServiceAccountFile && fs.existsSync(firebaseServiceAccountFile)) {
  try {
    firebaseServiceAccount = JSON.parse(fs.readFileSync(firebaseServiceAccountFile, "utf8"));
  } catch (error) {
    console.error("La cuenta de servicio Firebase no es un JSON válido:", error.message);
  }
}

const firebaseVariables = ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"];
const faltanFirebase = firebaseVariables.filter((key) => !process.env[key]);
const canInitializeFirebase = firebaseServiceAccount || faltanFirebase.length === 0;

if (canInitializeFirebase) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(firebaseServiceAccount || {
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
        })
    });
  } catch (error) {
    console.error("Firebase no pudo inicializarse:", error.message);
  }
}

const db = admin.apps.length ? admin.firestore() : null;

const mailConfigured = Boolean(
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASSWORD
);

const transporter = mailConfigured ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD
  }
}) : null;

async function saveTicket(ticket) {
  if (db) {
    await db.collection("tickets").doc(ticket.id).set({
      ...ticket,
      creadoEn: admin.firestore.FieldValue.serverTimestamp()
    });
  }

  MEMORY_TICKETS.set(ticket.id, { ...ticket, creadoEn: ticket.creadoEn || new Date().toISOString() });
}

async function getTicket(ticketId) {
  if (db) {
    const snapshot = await db.collection("tickets").doc(ticketId).get();
    return snapshot.exists ? snapshot.data() : null;
  }

  return MEMORY_TICKETS.get(ticketId) || null;
}

async function updateTicketStatus(ticketId, updates) {
  if (db) {
    const reference = db.collection("tickets").doc(ticketId);
    await reference.update(updates);
    const snapshot = await reference.get();
    return snapshot.exists ? snapshot.data() : null;
  }

  const current = MEMORY_TICKETS.get(ticketId);
  if (!current) return null;

  const updated = { ...current, ...updates };
  MEMORY_TICKETS.set(ticketId, updated);
  return updated;
}

async function getPendingPaymentTickets() {
  if (db) {
    const snapshot = await db.collection("tickets")
      .where("estado", "==", "PENDIENTE_PAGO")
      .get();
    return snapshot.docs
      .map((document) => document.data())
      .sort((left, right) => new Date(right.creadoEn) - new Date(left.creadoEn))
      .slice(0, 100);
  }

  return Array.from(MEMORY_TICKETS.values())
    .filter((ticket) => ticket.estado === "PENDIENTE_PAGO")
    .sort((left, right) => new Date(right.creadoEn) - new Date(left.creadoEn))
    .slice(0, 100);
}

async function getGeneratedTickets() {
  if (db) {
    const snapshot = await db.collection("tickets").limit(200).get();
    return snapshot.docs
      .map((document) => document.data())
      .sort((left, right) => new Date(right.creadoEn) - new Date(left.creadoEn));
  }

  return Array.from(MEMORY_TICKETS.values())
    .sort((left, right) => new Date(right.creadoEn) - new Date(left.creadoEn))
    .slice(0, 200);
}

async function createTicketQr(ticketId) {
  return QRCode.toBuffer(ticketId, {
    type: "png",
    width: 500,
    margin: 2,
    errorCorrectionLevel: "H"
  });
}

app.get("/api/salud", (req, res) => {
  res.json({
    ok: true,
    mensaje: "Servidor funcionando correctamente.",
    firebase: Boolean(db),
    smtp: Boolean(transporter)
  });
});

app.get("/api/eventos", (req, res) => {
  res.json({ ok: true, eventos: EVENTOS });
});

app.get("/api/estadisticas-publicas", async (req, res) => {
  try {
    let entradas = MEMORY_TICKETS.size;
    if (db) {
      const snapshot = await db.collection("tickets").count().get();
      entradas = snapshot.data().count;
    }

    return res.json({ ok: true, entradas });
  } catch (error) {
    console.error("Error al consultar estadísticas públicas:", error);
    return res.json({ ok: true, entradas: 0 });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const username = String(req.body.username || "").trim().toLowerCase();
    const password = String(req.body.password || "");

    if (!username || !password) {
      return res.status(400).json({ ok: false, mensaje: "Usuario y contraseña requeridos." });
    }

    if (!loginRateLimit(username)) {
      return res.status(429).json({ ok: false, mensaje: "Demasiados intentos. Espera 15 minutos." });
    }

    const user = STAFF_USERS.find((item) => item.username.toLowerCase() === username && verifyStaffPassword(password, item));

    if (!user) {
      return res.status(401).json({ ok: false, mensaje: "Credenciales no válidas." });
    }

    const token = createSessionToken();
    STAFF_SESSIONS.set(token, {
      user: {
        username: user.username,
        role: user.role,
        name: user.name
      },
      expiresAt: Date.now() + AUTH_SESSION_TTL
    });

    res.cookie(AUTH_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: IS_PRODUCTION,
      maxAge: AUTH_SESSION_TTL
    });

    return res.json({ ok: true, mensaje: "Sesión iniciada.", user: { username: user.username, role: user.role, name: user.name } });
  } catch (error) {
    console.error("Error al iniciar sesión:", error);
    return res.status(500).json({ ok: false, mensaje: "No se pudo iniciar sesión." });
  }
});

app.post("/api/logout", (req, res) => {
  const token = readCookies(req)[AUTH_COOKIE];
  if (token) {
    STAFF_SESSIONS.delete(token);
  }

  res.clearCookie(AUTH_COOKIE);
  return res.json({ ok: true, mensaje: "Sesión cerrada." });
});

app.get("/api/session-status", (req, res) => {
  const session = getStaffSession(req);
  if (!session) {
    return res.json({ ok: true, authenticated: false });
  }

  return res.json({ ok: true, authenticated: true, user: session.user });
});

app.post("/api/crear-ticket", async (req, res) => {
  try {
    const nombre = String(req.body.nombre || "").trim();
    const correo = String(req.body.correo || "").trim().toLowerCase();
    const telefono = String(req.body.telefono || "").trim();
    const eventoId = String(req.body.eventoId || "").trim();
    const requestedEvent = String(req.body.evento || "").trim();
    const tipoEntrada = String(req.body.tipoEntrada || "General").trim();
    const paymentMethod = String(req.body.paymentMethod || "").trim().toLowerCase();
    const paymentReference = String(req.body.paymentReference || "").trim();
    const event = findEvent(eventoId, requestedEvent);

    if (!nombre || !correo || !telefono || !correoValido(correo) || !event) {
      return res.status(400).json({
        ok: false,
        mensaje: "Completa los datos y selecciona un evento válido."
      });
    }

    if (!paymentMethod || !["paypal", "numero"].includes(paymentMethod)) {
      return res.status(400).json({
        ok: false,
        mensaje: "Selecciona un método de pago válido: PayPal o número de pago."
      });
    }

    if (!paymentReference) {
      return res.status(400).json({
        ok: false,
        mensaje: "Debes incluir la referencia del pago para generar la entrada."
      });
    }

    const ticketId = crypto.randomUUID();
    const ticket = {
      id: ticketId,
      nombre,
      correo,
      telefono,
      eventoId: event.id,
      evento: event.nombre,
      tipoEntrada,
      precio: event.precio,
      metodoPago: paymentMethod,
      referenciaPago: paymentReference,
      pagado: false,
      estado: "PENDIENTE_PAGO",
      creadoEn: new Date().toISOString()
    };

    await saveTicket(ticket);

    const qrBuffer = await createTicketQr(ticketId);

    if (transporter) {
      try {
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: correo,
          subject: `Solicitud de pago para ${event.nombre}`,
          text: `Hola ${nombre}. Recibimos tu referencia de pago para ${event.nombre}. El QR se activará al confirmar el pago.`,
          html: `
            <h2>Solicitud de pago para ${event.nombre}</h2>
            <p>Hola ${nombre},</p>
            <p>Recibimos tu referencia. El equipo confirmará el pago antes de activar el QR.</p>
            <p><strong>ID del ticket:</strong> ${ticketId}</p>
          `,
          attachments: [{
            filename: `ticket-${ticketId}.png`,
            content: qrBuffer,
            contentType: "image/png"
          }]
        });
      } catch (emailError) {
        console.warn("No se pudo enviar el correo del ticket, pero el ticket se generó correctamente:", emailError.message);
      }
    }

    return res.status(201).json({
      ok: true,
      mensaje: "Solicitud recibida. El QR se activará cuando se confirme el pago.",
      ticket: {
        ...ticket,
        qrDataUrl: `data:image/png;base64,${qrBuffer.toString("base64")}`
      }
    });
  } catch (error) {
    console.error("Error al crear ticket:", error);
    return res.status(500).json({
      ok: false,
      mensaje: "No se pudo crear la entrada."
    });
  }
});

app.post("/api/admin/confirmar-pago/:ticketId", requireStaffAuth, async (req, res) => {
  try {
    if (req.staffSession.user.role !== "admin") {
      return res.status(403).json({ ok: false, mensaje: "Solo el administrador puede confirmar pagos." });
    }

    const ticket = await getTicket(req.params.ticketId);
    if (!ticket) {
      return res.status(404).json({ ok: false, mensaje: "Ticket no encontrado." });
    }
    if (ticket.pagado) {
      return res.json({ ok: true, mensaje: "El pago ya estaba confirmado.", ticket });
    }

    const updated = await updateTicketStatus(req.params.ticketId, {
      pagado: true,
      estado: "PENDIENTE",
      pagoConfirmadoPor: req.staffSession.user.username,
      pagoConfirmadoEn: new Date().toISOString()
    });

    if (transporter && updated.correo) {
      try {
        const qrBuffer = await createTicketQr(updated.id);
        await transporter.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: updated.correo,
          subject: `Pago confirmado: tu entrada para ${updated.evento}`,
          text: `Hola ${updated.nombre}. Tu pago fue confirmado. Presenta el QR adjunto al ingresar al evento.`,
          html: `
            <h2>Pago confirmado</h2>
            <p>Hola ${updated.nombre},</p>
            <p>Tu entrada para <strong>${updated.evento}</strong> ya está activa.</p>
            <p><strong>ID del ticket:</strong> ${updated.id}</p>
          `,
          attachments: [{
            filename: `ticket-${updated.id}.png`,
            content: qrBuffer,
            contentType: "image/png"
          }]
        });
      } catch (emailError) {
        console.warn("Pago confirmado, pero no se pudo enviar el correo de activación:", emailError.message);
      }
    }

    return res.json({ ok: true, mensaje: "Pago confirmado y QR activado.", ticket: updated });
  } catch (error) {
    console.error("Error al confirmar pago:", error);
    return res.status(500).json({ ok: false, mensaje: "No se pudo confirmar el pago." });
  }
});

app.get("/api/admin/pagos-pendientes", requireStaffAuth, async (req, res) => {
  try {
    if (req.staffSession.user.role !== "admin") {
      return res.status(403).json({ ok: false, mensaje: "Solo el administrador puede revisar pagos." });
    }

    const tickets = await getPendingPaymentTickets();
    return res.json({ ok: true, tickets });
  } catch (error) {
    console.error("Error al consultar pagos pendientes:", error);
    return res.status(500).json({ ok: false, mensaje: "No se pudieron consultar los pagos pendientes." });
  }
});

app.get("/api/admin/entradas", requireStaffAuth, async (req, res) => {
  try {
    if (req.staffSession.user.role !== "admin") {
      return res.status(403).json({ ok: false, mensaje: "Solo el administrador puede revisar las entradas." });
    }

    const tickets = await getGeneratedTickets();
    return res.json({ ok: true, tickets });
  } catch (error) {
    console.error("Error al consultar entradas:", error);
    return res.status(500).json({ ok: false, mensaje: "No se pudieron consultar las entradas." });
  }
});

app.post("/api/admin/crear-qr", requireStaffAuth, async (req, res) => {
  try {
    const sessionRole = req.staffSession.user.role;
    if (sessionRole !== "admin" && sessionRole !== "staff") {
      return res.status(403).json({ ok: false, mensaje: "No tienes permiso para generar QR." });
    }

    const nombre = String(req.body.nombre || "Invitado").trim();
    const correo = String(req.body.correo || "").trim().toLowerCase();
    const eventoId = String(req.body.eventoId || "").trim();
    const tipoEntrada = String(req.body.tipoEntrada || "General").trim();
    const cantidad = Number(req.body.cantidad || 1);
    const event = EVENTOS.find((item) => item.id === eventoId);

    if (!correoValido(correo) || !event) {
      return res.status(400).json({ ok: false, mensaje: "Indica un correo y un evento válido." });
    }

    if (!["General", "VIP"].includes(tipoEntrada)) {
      return res.status(400).json({ ok: false, mensaje: "El tipo de entrada debe ser General o VIP." });
    }

    if (!Number.isFinite(cantidad) || cantidad < 1 || cantidad > 200) {
      return res.status(400).json({ ok: false, mensaje: "La cantidad debe estar entre 1 y 200." });
    }

    const generated = [];

    for (let i = 0; i < cantidad; i += 1) {
      const ticketId = crypto.randomUUID();
      const ticket = {
        id: ticketId,
        nombre,
        correo,
        telefono: "ADMIN-FREE",
        eventoId: event.id,
        evento: event.nombre,
        tipoEntrada,
        precio: event.precio,
        pagado: true,
        generadoPor: req.staffSession.user.username,
        estado: "PENDIENTE",
        creadoEn: new Date().toISOString()
      };

      await saveTicket(ticket);

      const qrBuffer = await createTicketQr(ticketId);
      if (transporter) {
        try {
          await transporter.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: correo,
            subject: `Tu entrada para ${event.nombre}`,
            text: `Hola ${nombre}. El administrador generó una entrada ${tipoEntrada} para ${event.nombre}. Adjuntamos tu código QR.`,
            html: `
              <h2>Tu entrada</h2>
              <p>Hola ${nombre},</p>
              <p>Tu entrada <strong>${tipoEntrada}</strong> para <strong>${event.nombre}</strong> está lista.</p>
              <p><strong>ID del ticket:</strong> ${ticketId}</p>
            `,
            attachments: [{
              filename: `ticket-${ticketId}.png`,
              content: qrBuffer,
              contentType: "image/png"
            }]
          });
        } catch (emailError) {
          console.warn("QR generado, pero no se pudo enviar el correo:", emailError.message);
        }
      }
      generated.push({
        ...ticket,
        qrDataUrl: `data:image/png;base64,${qrBuffer.toString("base64")}`
      });
    }

    return res.status(201).json({
      ok: true,
      mensaje: `Se generaron ${generated.length} QR correctamente y se enviaron al correo indicado.`,
      tickets: generated
    });
  } catch (error) {
    console.error("Error al generar QR:", error);
    return res.status(500).json({
      ok: false,
      mensaje: "No se pudo generar el QR."
    });
  }
});

app.get("/api/ticket/:ticketId", async (req, res) => {
  try {
    const ticket = await getTicket(req.params.ticketId);

    if (!ticket) {
      return res.status(404).json({ ok: false, mensaje: "Ticket no encontrado." });
    }

    return res.json({ ok: true, ticket });
  } catch (error) {
    console.error("Error al consultar ticket:", error);
    return res.status(500).json({ ok: false, mensaje: "No se pudo consultar el ticket." });
  }
});

app.post("/api/validar-ticket", async (req, res) => {
  try {
    const ticketId = String(req.body.ticketId || "").trim();

    if (!ticketId) {
      return res.status(400).json({
        ok: false,
        permitido: false,
        mensaje: "QR no válido."
      });
    }

    if (db) {
      const referencia = db.collection("tickets").doc(ticketId);
      const resultado = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(referencia);

        if (!snapshot.exists) {
          return { permitido: false, mensaje: "Ticket no encontrado." };
        }

        const ticket = snapshot.data();
        if (!ticket.pagado || ticket.estado === "PENDIENTE_PAGO") {
          return { permitido: false, mensaje: "Denegado: pago pendiente de confirmación." };
        }
        if (ticket.estado !== "PENDIENTE") {
          return { permitido: false, mensaje: "Denegado: ticket ya utilizado." };
        }

        transaction.update(referencia, {
          estado: "INGRESADO",
          ingresadoEn: admin.firestore.FieldValue.serverTimestamp()
        });

        return {
          permitido: true,
          mensaje: "Acceso permitido.",
          nombre: ticket.nombre,
          evento: ticket.evento,
          tipoEntrada: ticket.tipoEntrada
        };
      });

      return res.status(resultado.permitido ? 200 : 403).json({
        ok: true,
        ...resultado
      });
    }

    const ticket = MEMORY_TICKETS.get(ticketId);
    if (!ticket) {
      return res.status(404).json({ ok: false, permitido: false, mensaje: "Ticket no encontrado." });
    }

    if (!ticket.pagado || ticket.estado === "PENDIENTE_PAGO") {
      return res.status(403).json({ ok: true, permitido: false, mensaje: "Denegado: pago pendiente de confirmación." });
    }

    if (ticket.estado !== "PENDIENTE") {
      return res.status(403).json({ ok: true, permitido: false, mensaje: "Denegado: ticket ya utilizado.", nombre: ticket.nombre, evento: ticket.evento, tipoEntrada: ticket.tipoEntrada });
    }

    const actualizado = await updateTicketStatus(ticketId, {
      estado: "INGRESADO",
      ingresadoEn: new Date().toISOString()
    });

    return res.status(200).json({
      ok: true,
      permitido: true,
      mensaje: "Acceso permitido.",
      nombre: actualizado.nombre,
      evento: actualizado.evento,
      tipoEntrada: actualizado.tipoEntrada
    });
  } catch (error) {
    console.error("Error al validar ticket:", error);
    return res.status(500).json({
      ok: false,
      permitido: false,
      mensaje: "No se pudo validar el ticket."
    });
  }
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/scanner-dashboard", requireStaffAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "scanner-dashboard.html"));
});

app.get("/ticket", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "ticket.html"));
});

app.get("/escaner", (req, res) => {
  res.redirect("/scanner-dashboard");
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor ejecutandose en http://localhost:${PORT}`);
    console.log(`Panel de staff: http://localhost:${PORT}/login`);
  });
}

module.exports = app;
