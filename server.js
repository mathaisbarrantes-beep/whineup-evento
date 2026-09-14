"use strict";

const express = require("express");
const path = require("path");
const QRCode = require("qrcode");

const { config, validateConfig } = require("./lib/config");
const store = require("./lib/store");
const email = require("./lib/email");
const auth = require("./lib/auth");
const { listarEventos, buscarEvento } = require("./lib/eventos");
const { createTicketToken, readTicketToken, createTicketId } = require("./lib/tokens");
const {
  securityHeaders,
  noStore,
  rateLimit,
  sha256
} = require("./lib/security");

/* ------------------------------------------------------------- arranque */

const revision = validateConfig();
revision.warnings.forEach((aviso) => console.warn(`[config] ${aviso}`));

if (revision.errors.length) {
  console.error("\n=== Configuracion insegura o incompleta ===");
  revision.errors.forEach((error) => console.error(` - ${error}`));

  if (config.isProduction) {
    console.error("\nEl servidor no arranca en produccion con esta configuracion.\n");
    process.exit(1);
  }
  console.warn("\nContinuando en modo desarrollo. NO publiques asi.\n");
}

store.initStore();

const app = express();

app.disable("x-powered-by");
if (config.trustProxy) app.set("trust proxy", 1);

app.use(securityHeaders);
// Solo aceptamos JSON: un formulario HTML de otro sitio no puede fabricar
// una peticion valida, lo que cierra la via clasica de CSRF.
app.use(express.json({ limit: "64kb" }));
// Una peticion sin cuerpo JSON no debe hacer fallar a los manejadores.
app.use((req, res, next) => {
  if (!req.body || typeof req.body !== "object") req.body = {};
  next();
});
app.use(auth.verificarOrigen);
app.use(rateLimit({ windowMs: 60 * 1000, max: 300, key: "global" }));

// Solo se sirven de forma estatica los archivos realmente publicos.
// Las paginas de staff viven en views/ y pasan siempre por el middleware de sesion.
app.use(express.static(path.join(__dirname, "public"), {
  index: false,
  dotfiles: "ignore",
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

/* -------------------------------------------------------------- ayudantes */

function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const protocolo = config.trustProxy ? (req.headers["x-forwarded-proto"] || req.protocol) : req.protocol;
  return `${protocolo}://${req.headers.host}`;
}

function urlsDelTicket(req, token) {
  const base = baseUrl(req);
  return {
    qrUrl: `${base}/qr/${encodeURIComponent(token)}/entrada.png`,
    ticketUrl: `${base}/ticket?t=${encodeURIComponent(token)}`
  };
}

function correoValido(correo) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo) && correo.length <= 254;
}

function limpiar(valor, maximo) {
  // Quitamos caracteres de control: no aportan nada y ensucian correos y paneles.
  const texto = String(valor == null ? "" : valor);
  let salida = "";

  for (const caracter of texto) {
    const codigo = caracter.codePointAt(0);
    if (codigo < 32 || codigo === 127) continue;
    salida += caracter;
    if (salida.length >= maximo) break;
  }

  return salida.trim();
}

function formatearPrecio(precio, moneda) {
  try {
    return new Intl.NumberFormat("es-CR", {
      style: "currency",
      currency: moneda || "CRC",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(Number(precio) || 0);
  } catch (error) {
    return String(precio);
  }
}

/** Vista publica de un ticket: sin correo, telefono ni referencia de pago. */
function ticketPublico(ticket) {
  return {
    nombre: ticket.nombre,
    evento: ticket.evento,
    fecha: ticket.fecha,
    lugar: ticket.lugar,
    tipoEntrada: ticket.tipoEntrada,
    precio: ticket.precio,
    moneda: ticket.moneda,
    estado: ticket.estado,
    pagado: Boolean(ticket.pagado),
    creadoEn: ticket.creadoEn
  };
}

/** Vista para el panel de staff: sin la referencia de pago en claro para el rol staff. */
function ticketStaff(ticket, role) {
  const base = {
    id: ticket.id,
    nombre: ticket.nombre,
    correo: ticket.correo,
    evento: ticket.evento,
    eventoId: ticket.eventoId,
    tipoEntrada: ticket.tipoEntrada,
    precio: ticket.precio,
    moneda: ticket.moneda,
    estado: ticket.estado,
    pagado: Boolean(ticket.pagado),
    metodoPago: ticket.metodoPago || null,
    generadoPor: ticket.generadoPor || null,
    creadoEn: ticket.creadoEn,
    ingresadoEn: ticket.ingresadoEn || null
  };

  if (role === "admin") {
    base.telefono = ticket.telefono || null;
    base.referenciaPago = ticket.referenciaPago || null;
  }

  return base;
}

async function enviarTicketPorCorreo(req, ticket, { plantilla, asunto, mensaje }) {
  const token = createTicketToken(ticket.id);
  const { qrUrl, ticketUrl } = urlsDelTicket(req, token);

  const resultado = await email.enviarCorreo({
    templateId: plantilla,
    asunto,
    params: {
      to_email: ticket.correo,
      to_name: ticket.nombre,
      evento: ticket.evento,
      fecha: ticket.fecha || "",
      lugar: ticket.lugar || "",
      tipo_entrada: ticket.tipoEntrada,
      precio: formatearPrecio(ticket.precio, ticket.moneda),
      estado: ticket.estado,
      mensaje,
      qr_url: qrUrl,
      ticket_url: ticketUrl,
      // El id completo no viaja en el correo; basta el fragmento para soporte.
      referencia_corta: String(ticket.id).slice(0, 8).toUpperCase()
    }
  });

  if (!resultado.ok) {
    console.warn(`[correo] No se pudo enviar el correo del ticket ${ticket.id}: ${resultado.error}`);
  }

  return { token, qrUrl, ticketUrl, correo: resultado };
}

/* ------------------------------------------------------------- endpoints */

app.get("/api/salud", (req, res) => {
  res.json({
    ok: true,
    mensaje: "Servidor funcionando correctamente.",
    persistencia: store.isPersistent() ? "firestore" : "memoria",
    correo: email.estado()
  });
});

app.get("/api/eventos", (req, res) => {
  res.json({ ok: true, eventos: listarEventos() });
});

app.get("/api/estadisticas-publicas", noStore, async (req, res) => {
  try {
    const entradas = await store.countTickets();
    return res.json({ ok: true, entradas });
  } catch (error) {
    console.error("[estadisticas] Error:", error.message);
    return res.json({ ok: true, entradas: 0 });
  }
});

/* ------------------------------------------------------------ compra */

app.post(
  "/api/crear-ticket",
  rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    key: "compra",
    mensaje: "Has enviado demasiadas solicitudes. Intenta de nuevo en unos minutos."
  }),
  async (req, res) => {
    try {
      const nombre = limpiar(req.body.nombre, 80);
      const correo = limpiar(req.body.correo, 254).toLowerCase();
      const telefono = limpiar(req.body.telefono, 30);
      const eventoId = limpiar(req.body.eventoId, 60);
      const metodoPago = limpiar(req.body.paymentMethod, 20).toLowerCase();
      const referenciaPago = limpiar(req.body.paymentReference, 120);
      const evento = buscarEvento(eventoId);

      if (nombre.length < 2 || !correoValido(correo) || telefono.length < 6 || !evento) {
        return res.status(400).json({
          ok: false,
          mensaje: "Completa los datos y selecciona un evento valido."
        });
      }

      if (!["paypal", "numero"].includes(metodoPago)) {
        return res.status(400).json({
          ok: false,
          mensaje: "Selecciona un metodo de pago valido: PayPal o numero de pago."
        });
      }

      if (referenciaPago.length < 4) {
        return res.status(400).json({
          ok: false,
          mensaje: "Incluye la referencia del pago para generar la entrada."
        });
      }

      // La referencia se guarda tambien como hash para poder detectar reusos
      // sin recorrer toda la coleccion.
      const referenciaPagoHash = sha256(`${metodoPago}:${referenciaPago.toLowerCase()}`);

      if (await store.referenciaPagoYaUsada(referenciaPagoHash, evento.id)) {
        return res.status(409).json({
          ok: false,
          mensaje: "Esa referencia de pago ya se uso para este evento. Contacta con soporte si crees que es un error."
        });
      }

      const ticket = {
        id: createTicketId(),
        nombre,
        correo,
        telefono,
        eventoId: evento.id,
        evento: evento.nombre,
        fecha: evento.fecha,
        lugar: evento.lugar,
        // El precio y el tipo salen del catalogo del servidor, no del navegador.
        tipoEntrada: evento.categoria,
        precio: evento.precio,
        moneda: evento.moneda,
        metodoPago,
        referenciaPago,
        referenciaPagoHash,
        pagado: false,
        estado: "PENDIENTE_PAGO",
        creadoEn: new Date().toISOString()
      };

      await store.saveTicket(ticket);

      await enviarTicketPorCorreo(req, ticket, {
        plantilla: email.plantillas.compra(),
        asunto: `Solicitud recibida para ${evento.nombre}`,
        mensaje: "Recibimos tu referencia de pago. Tu codigo QR se activara en cuanto el equipo confirme el pago; te avisaremos por este mismo medio."
      });

      return res.status(201).json({
        ok: true,
        mensaje: "Solicitud recibida. Te enviamos un correo; el QR se activa al confirmar el pago.",
        ticket: ticketPublico(ticket)
      });
    } catch (error) {
      console.error("[crear-ticket] Error:", error.message);
      return res.status(500).json({ ok: false, mensaje: "No se pudo crear la entrada." });
    }
  }
);

/* ------------------------------------------------- consulta publica del QR */

app.get("/api/ticket/:token", noStore, async (req, res) => {
  try {
    const ticketId = readTicketToken(req.params.token);
    if (!ticketId) {
      return res.status(404).json({ ok: false, mensaje: "Entrada no encontrada." });
    }

    const ticket = await store.getTicket(ticketId);
    if (!ticket) {
      return res.status(404).json({ ok: false, mensaje: "Entrada no encontrada." });
    }

    return res.json({ ok: true, ticket: ticketPublico(ticket) });
  } catch (error) {
    console.error("[ticket] Error:", error.message);
    return res.status(500).json({ ok: false, mensaje: "No se pudo consultar la entrada." });
  }
});

/** Imagen del QR. La URL lleva la firma, asi que no es adivinable. */
app.get(
  "/qr/:token/entrada.png",
  rateLimit({ windowMs: 60 * 1000, max: 60, key: "qr" }),
  async (req, res) => {
    try {
      const token = String(req.params.token || "");
      if (!readTicketToken(token)) {
        return res.status(404).send("QR no encontrado.");
      }

      const buffer = await QRCode.toBuffer(token, {
        type: "png",
        width: 512,
        margin: 2,
        errorCorrectionLevel: "H",
        color: { dark: "#000000", light: "#FFFFFF" }
      });

      res.setHeader("Content-Type", "image/png");
      res.setHeader("Content-Length", String(buffer.length));
      // El contenido de un token nunca cambia: cachearlo permite que Gmail
      // y otros clientes muestren la imagen sin volver a pedirla.
      res.setHeader("Cache-Control", "public, max-age=604800, immutable");
      return res.end(buffer);
    } catch (error) {
      console.error("[qr] Error:", error.message);
      return res.status(500).send("No se pudo generar el QR.");
    }
  }
);

/* ------------------------------------------------------------ sesiones */

app.post(
  "/api/login",
  rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: "login", mensaje: "Demasiados intentos. Espera unos minutos." }),
  async (req, res) => {
    try {
      const resultado = await auth.iniciarSesion(req, res, {
        username: req.body.username,
        password: req.body.password
      });

      return res.status(resultado.status).json({
        ok: resultado.ok,
        mensaje: resultado.mensaje,
        user: resultado.user
      });
    } catch (error) {
      console.error("[login] Error:", error.message);
      return res.status(500).json({ ok: false, mensaje: "No se pudo iniciar sesion." });
    }
  }
);

app.post("/api/logout", async (req, res) => {
  await auth.cerrarSesion(req, res);
  return res.json({ ok: true, mensaje: "Sesion cerrada." });
});

app.get("/api/session-status", noStore, async (req, res) => {
  const sesion = await auth.obtenerSesion(req);
  if (!sesion) return res.json({ ok: true, authenticated: false });

  return res.json({
    ok: true,
    authenticated: true,
    user: { username: sesion.username, role: sesion.role, name: sesion.name }
  });
});

/* ----------------------------------------------------------- validacion */

/**
 * Escaneo de entradas. Requiere sesion de staff: sin ella, cualquiera con la
 * URL podria quemar entradas ajenas a base de peticiones.
 */
app.post(
  "/api/validar-ticket",
  auth.requireStaff("admin", "staff"),
  rateLimit({ windowMs: 60 * 1000, max: 120, key: "validar" }),
  noStore,
  async (req, res) => {
    try {
      let entrada = limpiar(req.body.ticketId || req.body.token, 200);

      // Aceptamos tanto el token pelado como una URL que lo contenga.
      if (entrada.includes("/")) {
        const partes = entrada.split(/[/?=]/).filter(Boolean);
        entrada = partes[partes.length - 1];
      }

      const ticketId = readTicketToken(entrada);
      if (!ticketId) {
        return res.status(400).json({
          ok: true,
          permitido: false,
          motivo: "QR_INVALIDO",
          mensaje: "QR no valido o falsificado."
        });
      }

      const resultado = await store.consumirTicket(ticketId, req.staff.username);

      const mensajes = {
        NO_EXISTE: "Entrada no encontrada.",
        ANULADO: "Denegado: entrada anulada.",
        PAGO_PENDIENTE: "Denegado: pago sin confirmar.",
        YA_USADO: "Denegado: esta entrada ya se uso.",
        ESTADO_INVALIDO: "Denegado: estado no valido."
      };

      if (!resultado.permitido) {
        return res.status(200).json({
          ok: true,
          permitido: false,
          motivo: resultado.motivo,
          mensaje: mensajes[resultado.motivo] || "Denegado.",
          nombre: resultado.ticket ? resultado.ticket.nombre : null,
          evento: resultado.ticket ? resultado.ticket.evento : null,
          tipoEntrada: resultado.ticket ? resultado.ticket.tipoEntrada : null,
          ingresadoEn: resultado.ticket ? resultado.ticket.ingresadoEn || null : null
        });
      }

      return res.status(200).json({
        ok: true,
        permitido: true,
        mensaje: "Acceso permitido.",
        nombre: resultado.ticket.nombre,
        evento: resultado.ticket.evento,
        tipoEntrada: resultado.ticket.tipoEntrada
      });
    } catch (error) {
      console.error("[validar] Error:", error.message);
      return res.status(500).json({ ok: false, permitido: false, mensaje: "No se pudo validar la entrada." });
    }
  }
);

/* ------------------------------------------------------ panel de staff */

app.get("/api/admin/entradas", auth.requireStaff("admin"), noStore, async (req, res) => {
  try {
    const tickets = await store.listTickets({ limite: 200 });
    return res.json({ ok: true, tickets: tickets.map((ticket) => ticketStaff(ticket, req.staff.role)) });
  } catch (error) {
    console.error("[entradas] Error:", error.message);
    return res.status(500).json({ ok: false, mensaje: "No se pudieron consultar las entradas." });
  }
});

app.get("/api/admin/pagos-pendientes", auth.requireStaff("admin"), noStore, async (req, res) => {
  try {
    const tickets = await store.listTickets({ estado: "PENDIENTE_PAGO", limite: 100 });
    return res.json({ ok: true, tickets: tickets.map((ticket) => ticketStaff(ticket, req.staff.role)) });
  } catch (error) {
    console.error("[pagos-pendientes] Error:", error.message);
    return res.status(500).json({ ok: false, mensaje: "No se pudieron consultar los pagos pendientes." });
  }
});

app.post("/api/admin/confirmar-pago/:ticketId", auth.requireStaff("admin"), async (req, res) => {
  try {
    const ticketId = limpiar(req.params.ticketId, 80);
    const ticket = await store.getTicket(ticketId);

    if (!ticket) {
      return res.status(404).json({ ok: false, mensaje: "Entrada no encontrada." });
    }

    if (ticket.pagado) {
      return res.json({ ok: true, mensaje: "El pago ya estaba confirmado.", ticket: ticketStaff(ticket, req.staff.role) });
    }

    const actualizado = await store.updateTicket(ticketId, {
      pagado: true,
      estado: "PENDIENTE",
      pagoConfirmadoPor: req.staff.username,
      pagoConfirmadoEn: new Date().toISOString()
    });

    if (!actualizado) {
      return res.status(409).json({ ok: false, mensaje: "La entrada cambio mientras se confirmaba. Vuelve a intentarlo." });
    }

    await enviarTicketPorCorreo(req, actualizado, {
      plantilla: email.plantillas.ticket(),
      asunto: `Tu entrada para ${actualizado.evento}`,
      mensaje: "Confirmamos tu pago. Presenta el codigo QR de este correo al entrar; es personal y sirve una sola vez."
    });

    return res.json({
      ok: true,
      mensaje: "Pago confirmado, QR activado y correo enviado.",
      ticket: ticketStaff(actualizado, req.staff.role)
    });
  } catch (error) {
    console.error("[confirmar-pago] Error:", error.message);
    return res.status(500).json({ ok: false, mensaje: "No se pudo confirmar el pago." });
  }
});

app.post("/api/admin/anular/:ticketId", auth.requireStaff("admin"), async (req, res) => {
  try {
    const ticketId = limpiar(req.params.ticketId, 80);
    const ticket = await store.getTicket(ticketId);

    if (!ticket) {
      return res.status(404).json({ ok: false, mensaje: "Entrada no encontrada." });
    }

    const actualizado = await store.updateTicket(ticketId, {
      estado: "ANULADO",
      anuladoPor: req.staff.username,
      anuladoEn: new Date().toISOString(),
      motivoAnulacion: limpiar(req.body.motivo, 200) || "Sin motivo indicado"
    });

    if (!actualizado) {
      return res.status(409).json({ ok: false, mensaje: "No se pudo anular la entrada. Vuelve a intentarlo." });
    }

    return res.json({
      ok: true,
      mensaje: "Entrada anulada. Su QR ya no sirve.",
      ticket: ticketStaff(actualizado, req.staff.role)
    });
  } catch (error) {
    console.error("[anular] Error:", error.message);
    return res.status(500).json({ ok: false, mensaje: "No se pudo anular la entrada." });
  }
});

app.post("/api/admin/reenviar/:ticketId", auth.requireStaff("admin"), async (req, res) => {
  try {
    const ticketId = limpiar(req.params.ticketId, 80);
    const ticket = await store.getTicket(ticketId);

    if (!ticket) {
      return res.status(404).json({ ok: false, mensaje: "Entrada no encontrada." });
    }

    const esActiva = ticket.pagado && ticket.estado !== "ANULADO";

    const { correo } = await enviarTicketPorCorreo(req, ticket, {
      plantilla: esActiva ? email.plantillas.ticket() : email.plantillas.compra(),
      asunto: esActiva ? `Tu entrada para ${ticket.evento}` : `Solicitud recibida para ${ticket.evento}`,
      mensaje: esActiva
        ? "Te reenviamos tu codigo QR. Es personal y sirve una sola vez."
        : "Tu solicitud sigue pendiente de confirmacion de pago."
    });

    if (!correo.ok) {
      return res.status(502).json({ ok: false, mensaje: "No se pudo enviar el correo. Revisa la configuracion de EmailJS." });
    }

    return res.json({ ok: true, mensaje: `Correo reenviado a ${ticket.correo}.` });
  } catch (error) {
    console.error("[reenviar] Error:", error.message);
    return res.status(500).json({ ok: false, mensaje: "No se pudo reenviar el correo." });
  }
});

app.post("/api/admin/crear-qr", auth.requireStaff("admin", "staff"), async (req, res) => {
  try {
    const nombre = limpiar(req.body.nombre, 80) || "Invitado";
    const correo = limpiar(req.body.correo, 254).toLowerCase();
    const eventoId = limpiar(req.body.eventoId, 60);
    const tipoEntrada = limpiar(req.body.tipoEntrada, 20);
    const cantidad = Number(req.body.cantidad || 1);
    const enviarCorreos = req.body.enviarCorreos !== false;
    const evento = buscarEvento(eventoId);

    if (!correoValido(correo) || !evento) {
      return res.status(400).json({ ok: false, mensaje: "Indica un correo y un evento valido." });
    }

    if (!["General", "VIP", "Cortesia"].includes(tipoEntrada)) {
      return res.status(400).json({ ok: false, mensaje: "Tipo de entrada no valido." });
    }

    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 50) {
      return res.status(400).json({ ok: false, mensaje: "La cantidad debe estar entre 1 y 50." });
    }

    const generados = [];

    for (let i = 0; i < cantidad; i += 1) {
      const ticket = {
        id: createTicketId(),
        nombre,
        correo,
        telefono: "",
        eventoId: evento.id,
        evento: evento.nombre,
        fecha: evento.fecha,
        lugar: evento.lugar,
        tipoEntrada,
        precio: tipoEntrada === "Cortesia" ? 0 : evento.precio,
        moneda: evento.moneda,
        metodoPago: "cortesia",
        pagado: true,
        estado: "PENDIENTE",
        generadoPor: req.staff.username,
        creadoEn: new Date().toISOString()
      };

      await store.saveTicket(ticket);

      const token = createTicketToken(ticket.id);
      const { qrUrl, ticketUrl } = urlsDelTicket(req, token);

      if (enviarCorreos) {
        await enviarTicketPorCorreo(req, ticket, {
          plantilla: email.plantillas.ticket(),
          asunto: `Tu entrada para ${evento.nombre}`,
          mensaje: `Tu entrada ${tipoEntrada} ya esta activa. Presenta el codigo QR al entrar; es personal y sirve una sola vez.`
        });
      }

      generados.push({
        id: ticket.id,
        nombre: ticket.nombre,
        tipoEntrada: ticket.tipoEntrada,
        qrUrl,
        ticketUrl
      });
    }

    return res.status(201).json({
      ok: true,
      mensaje: enviarCorreos
        ? `Se generaron ${generados.length} entradas y se enviaron a ${correo}.`
        : `Se generaron ${generados.length} entradas sin enviar correo.`,
      tickets: generados
    });
  } catch (error) {
    console.error("[crear-qr] Error:", error.message);
    return res.status(500).json({ ok: false, mensaje: "No se pudieron generar las entradas." });
  }
});

/* --------------------------------------------------------------- paginas */

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/ticket", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "ticket.html"));
});

app.get("/escaner", (req, res) => res.redirect("/scanner-dashboard"));

// Vive fuera de public/: sin sesion valida no se sirve nunca.
app.get("/scanner-dashboard", auth.requirePage("admin", "staff"), (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "views", "scanner-dashboard.html"));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ ok: false, mensaje: "Recurso no encontrado." });
  }
  return res.status(404).sendFile(path.join(__dirname, "public", "index.html"));
});

// Ultimo filtro: nunca devolvemos el stack al navegador.
app.use((error, req, res, next) => {
  console.error("[error]", error.message);
  if (res.headersSent) return next(error);
  return res.status(500).json({ ok: false, mensaje: "Error interno." });
});

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Servidor en http://localhost:${config.port}`);
    console.log(`Panel de staff: http://localhost:${config.port}/login`);
  });
}

module.exports = app;
