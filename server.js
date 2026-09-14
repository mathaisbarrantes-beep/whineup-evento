require("dotenv").config();

const express = require("express");
const path = require("path");
const QRCode = require("qrcode");
const nodemailer = require("nodemailer");
const { buildSupabaseClient } = require("./lib/supabaseClient");
const { createAuthMiddleware } = require("./lib/auth");
const { createEventosRepo } = require("./lib/eventos");
const { createEntradasRepo } = require("./lib/entradas");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_PRODUCTION = process.env.NODE_ENV === "production";

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

const CATEGORIAS_VALIDAS = ["General", "VIP"];

function correoValido(correo) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo);
}

const { supabase, supabaseConfigured } = buildSupabaseClient();
const { requireRole, getUserAndRole } = createAuthMiddleware({ supabase, supabaseConfigured });
const eventosRepo = createEventosRepo({ supabase, supabaseConfigured });
const entradasRepo = createEntradasRepo({ supabase, supabaseConfigured });

function requireSupabase(req, res, next) {
  if (!supabaseConfigured) {
    return res.status(503).json({ ok: false, mensaje: "El servicio no está disponible en este momento." });
  }
  return next();
}

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

async function createTicketQr(ticketId) {
  return QRCode.toBuffer(ticketId, {
    type: "png",
    width: 500,
    margin: 2,
    errorCorrectionLevel: "H"
  });
}

async function enviarCorreoTicket({ to, subject, text, html, qrBuffer, ticketId }) {
  if (!transporter) return;
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html,
      attachments: [{
        filename: `ticket-${ticketId}.png`,
        content: qrBuffer,
        contentType: "image/png"
      }]
    });
  } catch (emailError) {
    console.warn("No se pudo enviar el correo del ticket:", emailError.message);
  }
}

app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null
  });
});

app.get("/api/salud", (req, res) => {
  res.json({
    ok: true,
    mensaje: "Servidor funcionando correctamente.",
    supabase: Boolean(supabaseConfigured),
    smtp: Boolean(transporter)
  });
});

app.get("/api/eventos", requireSupabase, async (req, res) => {
  try {
    const eventos = await eventosRepo.listarPublicos();
    res.json({ ok: true, eventos });
  } catch (error) {
    console.error("Error al consultar eventos:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudieron consultar los eventos." });
  }
});

app.get("/api/estadisticas-publicas", requireSupabase, async (req, res) => {
  try {
    const entradas = await entradasRepo.contarTotal();
    res.json({ ok: true, entradas });
  } catch (error) {
    console.error("Error al consultar estadísticas públicas:", error);
    res.json({ ok: true, entradas: 0 });
  }
});

app.get("/api/session-status", async (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || !supabaseConfigured) {
    return res.json({ ok: true, authenticated: false });
  }

  const usuario = await getUserAndRole(token);
  if (!usuario) {
    return res.json({ ok: true, authenticated: false });
  }

  return res.json({
    ok: true,
    authenticated: true,
    user: { username: usuario.email, role: usuario.rol, name: usuario.nombre || usuario.email }
  });
});

app.get("/api/admin/eventos", requireRole("admin"), async (req, res) => {
  try {
    const eventos = await eventosRepo.listarTodos();
    res.json({ ok: true, eventos });
  } catch (error) {
    console.error("Error al consultar eventos del panel:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudieron consultar los eventos." });
  }
});

app.post("/api/admin/eventos", requireRole("admin"), async (req, res) => {
  try {
    // La categoría del evento se usa como tipo_entrada al comprar y esa
    // columna tiene un CHECK: si aquí entra texto libre, toda compra de ese
    // evento falla con un 500 opaco. Se valida al crear, no al comprar.
    const categoria = String(req.body.categoria || "General").trim();
    if (!CATEGORIAS_VALIDAS.includes(categoria)) {
      return res.status(400).json({ ok: false, mensaje: "La categoría del evento debe ser General o VIP." });
    }

    const evento = await eventosRepo.crear({
      nombre: String(req.body.nombre || "").trim(),
      fecha: req.body.fecha,
      lugar: String(req.body.lugar || "").trim(),
      precio: Number(req.body.precio || 0),
      categoria,
      descripcion: String(req.body.descripcion || "").trim(),
      cupo_maximo: req.body.cupoMaximo ? Number(req.body.cupoMaximo) : null,
      creado_por: req.usuario.id
    });
    res.status(201).json({ ok: true, evento });
  } catch (error) {
    console.error("Error al crear evento:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo crear el evento." });
  }
});

app.put("/api/admin/eventos/:id", requireRole("admin"), async (req, res) => {
  try {
    const cambios = {};
    if (req.body.nombre !== undefined) cambios.nombre = String(req.body.nombre).trim();
    if (req.body.fecha !== undefined) cambios.fecha = req.body.fecha;
    if (req.body.lugar !== undefined) cambios.lugar = String(req.body.lugar).trim();
    if (req.body.precio !== undefined) cambios.precio = Number(req.body.precio);
    if (req.body.categoria !== undefined) {
      const categoria = String(req.body.categoria).trim();
      if (!CATEGORIAS_VALIDAS.includes(categoria)) {
        return res.status(400).json({ ok: false, mensaje: "La categoría del evento debe ser General o VIP." });
      }
      cambios.categoria = categoria;
    }
    if (req.body.descripcion !== undefined) cambios.descripcion = String(req.body.descripcion).trim();
    if (req.body.cupoMaximo !== undefined) cambios.cupo_maximo = req.body.cupoMaximo ? Number(req.body.cupoMaximo) : null;
    if (req.body.activo !== undefined) cambios.activo = Boolean(req.body.activo);

    const evento = await eventosRepo.actualizar(req.params.id, cambios);
    res.json({ ok: true, evento });
  } catch (error) {
    console.error("Error al actualizar evento:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo actualizar el evento." });
  }
});

app.delete("/api/admin/eventos/:id", requireRole("admin"), async (req, res) => {
  try {
    const evento = await eventosRepo.desactivar(req.params.id);
    res.json({ ok: true, evento });
  } catch (error) {
    console.error("Error al desactivar evento:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo desactivar el evento." });
  }
});

app.post("/api/crear-ticket", requireRole(), async (req, res) => {
  try {
    const nombre = String(req.body.nombre || "").trim();
    const correo = String(req.body.correo || "").trim().toLowerCase();
    const telefono = String(req.body.telefono || "").trim();
    const eventoId = String(req.body.eventoId || "").trim();
    const tipoEntrada = String(req.body.tipoEntrada || "General").trim();
    const paymentMethod = String(req.body.paymentMethod || "").trim().toLowerCase();
    const paymentReference = String(req.body.paymentReference || "").trim();

    if (!nombre || !correo || !telefono || !correoValido(correo) || !eventoId) {
      return res.status(400).json({ ok: false, mensaje: "Completa los datos y selecciona un evento válido." });
    }

    const evento = await eventosRepo.obtenerPorId(eventoId);
    if (!evento) {
      return res.status(400).json({ ok: false, mensaje: "Completa los datos y selecciona un evento válido." });
    }

    if (!paymentMethod || !["paypal", "numero"].includes(paymentMethod)) {
      return res.status(400).json({ ok: false, mensaje: "Selecciona un método de pago válido: PayPal o número de pago." });
    }

    if (!paymentReference) {
      return res.status(400).json({ ok: false, mensaje: "Debes incluir la referencia del pago para generar la entrada." });
    }

    const ticket = await entradasRepo.crear({
      usuario_id: req.usuario.id,
      evento_id: evento.id,
      nombre,
      correo,
      telefono,
      tipo_entrada: tipoEntrada,
      precio: evento.precio,
      metodo_pago: paymentMethod,
      referencia_pago: paymentReference,
      pagado: false,
      estado: "PENDIENTE_PAGO"
    });

    const qrBuffer = await createTicketQr(ticket.id);
    await enviarCorreoTicket({
      to: correo,
      subject: `Solicitud de pago para ${evento.nombre}`,
      text: `Hola ${nombre}. Recibimos tu referencia de pago para ${evento.nombre}. El QR se activará al confirmar el pago.`,
      html: `<h2>Solicitud de pago para ${evento.nombre}</h2><p>Hola ${nombre},</p><p>Recibimos tu referencia. El equipo confirmará el pago antes de activar el QR.</p><p><strong>ID del ticket:</strong> ${ticket.id}</p>`,
      qrBuffer,
      ticketId: ticket.id
    });

    res.status(201).json({
      ok: true,
      mensaje: "Solicitud recibida. El QR se activará cuando se confirme el pago.",
      ticket: { ...ticket, qrDataUrl: `data:image/png;base64,${qrBuffer.toString("base64")}` }
    });
  } catch (error) {
    console.error("Error al crear ticket:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo crear la entrada." });
  }
});

app.get("/api/mis-entradas", requireRole(), async (req, res) => {
  try {
    const entradas = await entradasRepo.misEntradas(req.usuario.id);
    res.json({ ok: true, entradas });
  } catch (error) {
    console.error("Error al consultar mis entradas:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudieron consultar tus entradas." });
  }
});

app.post("/api/admin/confirmar-pago/:ticketId", requireRole("admin"), async (req, res) => {
  try {
    const ticket = await entradasRepo.obtenerPorId(req.params.ticketId);
    if (!ticket) {
      return res.status(404).json({ ok: false, mensaje: "Ticket no encontrado." });
    }
    if (ticket.pagado) {
      return res.json({ ok: true, mensaje: "El pago ya estaba confirmado.", ticket });
    }

    const updated = await entradasRepo.confirmarPago(req.params.ticketId, req.usuario.id);
    const qrBuffer = await createTicketQr(updated.id);
    await enviarCorreoTicket({
      to: updated.correo,
      subject: `Pago confirmado: tu entrada para ${updated.evento}`,
      text: `Hola ${updated.nombre}. Tu pago fue confirmado. Presenta el QR adjunto al ingresar al evento.`,
      html: `<h2>Pago confirmado</h2><p>Hola ${updated.nombre},</p><p>Tu entrada para <strong>${updated.evento}</strong> ya está activa.</p><p><strong>ID del ticket:</strong> ${updated.id}</p>`,
      qrBuffer,
      ticketId: updated.id
    });

    res.json({ ok: true, mensaje: "Pago confirmado y QR activado.", ticket: updated });
  } catch (error) {
    console.error("Error al confirmar pago:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo confirmar el pago." });
  }
});

app.get("/api/admin/pagos-pendientes", requireRole("admin"), async (req, res) => {
  try {
    const tickets = await entradasRepo.pagosPendientes();
    res.json({ ok: true, tickets });
  } catch (error) {
    console.error("Error al consultar pagos pendientes:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudieron consultar los pagos pendientes." });
  }
});

app.get("/api/admin/entradas", requireRole("admin"), async (req, res) => {
  try {
    const tickets = await entradasRepo.generadas();
    res.json({ ok: true, tickets });
  } catch (error) {
    console.error("Error al consultar entradas:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudieron consultar las entradas." });
  }
});

app.post("/api/admin/crear-qr", requireRole("admin", "staff"), async (req, res) => {
  try {
    const nombre = String(req.body.nombre || "Invitado").trim();
    const correo = String(req.body.correo || "").trim().toLowerCase();
    const eventoId = String(req.body.eventoId || "").trim();
    const tipoEntrada = String(req.body.tipoEntrada || "General").trim();
    const cantidad = Number(req.body.cantidad || 1);

    const evento = await eventosRepo.obtenerPorId(eventoId);
    if (!correoValido(correo) || !evento) {
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
      const ticket = await entradasRepo.crearGenerada({
        evento_id: evento.id,
        nombre,
        correo,
        telefono: "ADMIN-FREE",
        tipo_entrada: tipoEntrada,
        precio: evento.precio,
        pagado: true,
        estado: "PENDIENTE",
        generado_por: req.usuario.id
      });

      const qrBuffer = await createTicketQr(ticket.id);
      await enviarCorreoTicket({
        to: correo,
        subject: `Tu entrada para ${evento.nombre}`,
        text: `Hola ${nombre}. El administrador generó una entrada ${tipoEntrada} para ${evento.nombre}.`,
        html: `<h2>Tu entrada</h2><p>Hola ${nombre},</p><p>Tu entrada <strong>${tipoEntrada}</strong> para <strong>${evento.nombre}</strong> está lista.</p><p><strong>ID del ticket:</strong> ${ticket.id}</p>`,
        qrBuffer,
        ticketId: ticket.id
      });

      generated.push({ ...ticket, qrDataUrl: `data:image/png;base64,${qrBuffer.toString("base64")}` });
    }

    res.status(201).json({
      ok: true,
      mensaje: `Se generaron ${generated.length} QR correctamente y se enviaron al correo indicado.`,
      tickets: generated
    });
  } catch (error) {
    console.error("Error al generar QR:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo generar el QR." });
  }
});

app.get("/api/ticket/:ticketId", requireSupabase, async (req, res) => {
  try {
    const ticket = await entradasRepo.obtenerPorId(req.params.ticketId);
    if (!ticket) {
      return res.status(404).json({ ok: false, mensaje: "Ticket no encontrado." });
    }
    // Enlace público de consulta: solo lo que ticket.html muestra. El resto
    // del renglón (correo, teléfono, referencia de pago, ids de usuario) no
    // sale de aquí.
    res.json({
      ok: true,
      ticket: {
        id: ticket.id,
        evento: ticket.evento,
        nombre: ticket.nombre,
        tipoEntrada: ticket.tipoEntrada,
        creadoEn: ticket.creadoEn,
        precio: ticket.precio,
        pagado: ticket.pagado
      }
    });
  } catch (error) {
    console.error("Error al consultar ticket:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo consultar el ticket." });
  }
});

app.post("/api/validar-ticket", requireRole("staff", "admin"), async (req, res) => {
  try {
    const ticketId = String(req.body.ticketId || "").trim();
    if (!ticketId) {
      return res.status(400).json({ ok: false, permitido: false, mensaje: "QR no válido." });
    }

    const resultado = await entradasRepo.validar(ticketId);
    res.status(resultado.permitido ? 200 : 403).json({ ok: true, ...resultado });
  } catch (error) {
    console.error("Error al validar ticket:", error);
    res.status(500).json({ ok: false, permitido: false, mensaje: "No se pudo validar el ticket." });
  }
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/scanner-dashboard", (req, res) => {
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
