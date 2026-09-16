require("dotenv").config();

const express = require("express");
const path = require("path");
const QRCode = require("qrcode");
const { buildEmailer } = require("./lib/email");
const { buildSupabaseClient } = require("./lib/supabaseClient");
const { createAuthMiddleware } = require("./lib/auth");
const { createEventosRepo } = require("./lib/eventos");
const { createEntradasRepo, isUuid } = require("./lib/entradas");
const { createUsuariosRepo } = require("./lib/usuarios");

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

// Cada cortesía es una inserción, un QR y una llamada a EmailJS. Una función
// serverless tiene unos segundos de vida: con tandas grandes la petición muere
// a medias, con parte de las entradas creadas y parte de los correos sin salir.
const MAX_CORTESIAS = 20;

function correoValido(correo) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo);
}

const { supabase, supabaseConfigured } = buildSupabaseClient();
const { requireRole, getUserAndRole } = createAuthMiddleware({ supabase, supabaseConfigured });
const eventosRepo = createEventosRepo({ supabase, supabaseConfigured });
const entradasRepo = createEntradasRepo({ supabase, supabaseConfigured });
const usuariosRepo = createUsuariosRepo({ supabase, supabaseConfigured });

function requireSupabase(req, res, next) {
  if (!supabaseConfigured) {
    return res.status(503).json({ ok: false, mensaje: "El servicio no está disponible en este momento." });
  }
  return next();
}

const emailer = buildEmailer();

async function createTicketQr(ticketId) {
  return QRCode.toBuffer(ticketId, {
    type: "png",
    width: 500,
    margin: 2,
    errorCorrectionLevel: "H"
  });
}

// Los nombres de estos campos son el contrato con las plantillas de EmailJS:
// si aquí se renombra uno, la plantilla lo imprime vacío y EmailJS no avisa.
function paramsDeTicket(ticket, { asunto, mensaje }) {
  const { qrUrl, ticketUrl } = emailer.urlsDeTicket(ticket.id);
  return {
    to_email: ticket.correo,
    to_name: ticket.nombre,
    subject: asunto,
    mensaje,
    evento: ticket.evento || "tu evento",
    tipo_entrada: ticket.tipoEntrada || "General",
    qr_url: qrUrl,
    ticket_url: ticketUrl,
    // El uuid completo ya va dentro del QR y del enlace; para soporte basta el
    // fragmento, y así no queda un id entero suelto en la bandeja de entrada.
    referencia_corta: String(ticket.id).slice(0, 8).toUpperCase()
  };
}

app.get("/api/config", (req, res) => {
  res.json({
    ok: true,
    supabaseUrl: process.env.SUPABASE_URL || null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || null,
    // El numero al que se hace el SINPE. Sale de aqui y no del HTML para poder
    // cambiarlo sin desplegar, y para no dejarlo escrito en el repositorio.
    paymentPhone: process.env.PAYMENT_PHONE || null
  });
});

app.get("/api/salud", (req, res) => {
  res.json({
    ok: true,
    mensaje: "Servidor funcionando correctamente.",
    supabase: Boolean(supabaseConfigured),
    email: emailer.emailConfigured
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

// El personal lo gestiona solo un admin. Los eventos y el personal son las
// dos cosas que un staff no puede tocar: todo lo demas de la operacion si.
app.get("/api/admin/usuarios", requireRole("admin"), async (req, res) => {
  try {
    const usuarios = await usuariosRepo.listar();
    res.json({ ok: true, usuarios });
  } catch (error) {
    console.error("Error al listar usuarios:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudieron consultar los usuarios." });
  }
});

const ERRORES_ROL = {
  ROL_INVALIDO: [400, "El rol debe ser staff o cliente."],
  NO_A_TI_MISMO: [400, "No puedes cambiar tu propio rol."],
  NO_TOCAR_ADMIN: [403, "No se puede cambiar el rol de otro administrador desde aquí."],
  NO_ENCONTRADO: [404, "Usuario no encontrado."],
  CORREO_INVALIDO: [400, "Escribe un correo válido."],
  YA_EXISTE: [409, "Ya hay una cuenta con ese correo. Si es de cliente, hacela staff en la lista y volvé a generar el enlace."],
  ES_ADMIN: [403, "A una cuenta de administrador no se le generan enlaces desde el panel."],
  SIN_USUARIO: [500, "Supabase no devolvió la cuenta invitada."],
  SIN_ENLACE: [500, "Supabase no devolvió el enlace."]
};

// No sale ningún correo: el panel recibe un enlace y quien invita lo comparte
// por donde quiera. La persona elige su contraseña al abrirlo, así que ninguna
// contraseña pasa por esta aplicación ni por el navegador de quien invita.
app.post("/api/admin/usuarios/invitar", requireRole("admin"), async (req, res) => {
  try {
    const { enlace, nueva, ...usuario } = await usuariosRepo.invitar({
      correo: req.body.correo,
      rol: String(req.body.rol || "staff").trim(),
      baseUrl: emailer.baseUrl
    });
    res.status(nueva ? 201 : 200).json({
      ok: true,
      usuario,
      enlace,
      mensaje: nueva
        ? `Cuenta creada para ${usuario.correo} como ${usuario.rol}. Pasale este enlace para que ponga su contraseña.`
        : `${usuario.correo} ya tenía cuenta de staff. Con este enlace pone una contraseña nueva.`
    });
  } catch (error) {
    const conocido = error && ERRORES_ROL[error.error];
    if (conocido) {
      return res.status(conocido[0]).json({ ok: false, mensaje: conocido[1] });
    }
    console.error("Error al invitar:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo enviar la invitación." });
  }
});

app.put("/api/admin/usuarios/:id/rol", requireRole("admin"), async (req, res) => {
  try {
    const usuario = await usuariosRepo.cambiarRol({
      id: String(req.params.id || "").trim(),
      rol: String(req.body.rol || "").trim(),
      actorId: req.usuario.id
    });
    res.json({ ok: true, usuario, mensaje: `Rol actualizado a ${usuario.rol}.` });
  } catch (error) {
    const conocido = error && ERRORES_ROL[error.error];
    if (conocido) {
      return res.status(conocido[0]).json({ ok: false, mensaje: conocido[1] });
    }
    console.error("Error al cambiar el rol:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo cambiar el rol." });
  }
});

// Un fallo de correo no tumba nada y solo deja rastro en los logs del
// proveedor, que no siempre se pueden mirar. Esta ruta lo hace visible: manda
// un correo de verdad con la plantilla real y devuelve el error tal cual lo
// dio EmailJS, para no tener que adivinar por que no llega nada.
app.post("/api/admin/probar-correo", requireRole("admin"), async (req, res) => {
  const destino = String(req.body.correo || req.usuario.email || "").trim().toLowerCase();
  if (!correoValido(destino)) {
    return res.status(400).json({ ok: false, mensaje: "Escribe un correo válido para la prueba." });
  }

  if (!emailer.emailConfigured) {
    return res.status(503).json({
      ok: false,
      mensaje: "Faltan variables de EmailJS. Hacen falta las cinco: SERVICE_ID, PUBLIC_KEY, PRIVATE_KEY y las dos plantillas."
    });
  }

  const { qrUrl, ticketUrl } = emailer.urlsDeTicket("00000000-0000-4000-8000-000000000000");
  const envio = await emailer.enviar({
    templateId: emailer.plantillas.ticket,
    params: {
      to_email: destino,
      to_name: "Prueba de WhineUp",
      subject: "Prueba de correo de WhineUp",
      mensaje: "Este es un correo de prueba. Si te llegó, EmailJS está bien configurado y las entradas van a salir igual que este mensaje.",
      evento: "Prueba",
      tipo_entrada: "General",
      qr_url: qrUrl,
      ticket_url: ticketUrl,
      referencia_corta: "PRUEBA"
    }
  });

  if (!envio.ok) {
    return res.status(502).json({
      ok: false,
      mensaje: `EmailJS rechazó el envío: ${envio.error}`,
      detalle: envio.error
    });
  }

  res.json({ ok: true, mensaje: `Correo de prueba enviado a ${destino}. Si no llega en un minuto, revisá la carpeta de spam.` });
});

app.post("/api/crear-ticket", requireRole(), async (req, res) => {
  try {
    const nombre = String(req.body.nombre || "").trim();
    const correo = String(req.body.correo || "").trim().toLowerCase();
    const telefono = String(req.body.telefono || "").trim();
    const eventoId = String(req.body.eventoId || "").trim();
    const tipoEntrada = String(req.body.tipoEntrada || "General").trim();
    // paymentReference es el nombre viejo del campo: lo seguimos aceptando por
    // si alguien tiene la pagina anterior abierta en una pestana.
    const comprobante = String(req.body.comprobante || req.body.paymentReference || "").trim();

    if (!nombre || !correo || !telefono || !correoValido(correo) || !eventoId) {
      return res.status(400).json({ ok: false, mensaje: "Completa los datos y selecciona un evento válido." });
    }

    const evento = await eventosRepo.obtenerPorId(eventoId);
    if (!evento) {
      return res.status(400).json({ ok: false, mensaje: "Completa los datos y selecciona un evento válido." });
    }

    if (!comprobante) {
      return res.status(400).json({ ok: false, mensaje: "Escribe el número de comprobante del SINPE para generar la entrada." });
    }

    if (comprobante.length > 60) {
      return res.status(400).json({ ok: false, mensaje: "El número de comprobante es demasiado largo." });
    }

    const ticket = await entradasRepo.crear({
      usuario_id: req.usuario.id,
      evento_id: evento.id,
      nombre,
      correo,
      telefono,
      tipo_entrada: tipoEntrada,
      precio: evento.precio,
      // Unico metodo de pago. Se fija aqui y no se toma del navegador: no hay
      // nada que elegir, asi que tampoco hay nada que falsear.
      metodo_pago: "sinpe",
      referencia_pago: comprobante,
      pagado: false,
      estado: "PENDIENTE_PAGO"
    });

    const qrBuffer = await createTicketQr(ticket.id);
    const envio = await emailer.enviar({
      templateId: emailer.plantillas.compra,
      params: paramsDeTicket(ticket, {
        asunto: `Recibimos tu solicitud para ${evento.nombre}`,
        mensaje: `Recibimos tu referencia de pago para ${evento.nombre}. Tu entrada queda reservada y el código QR se activa en cuanto confirmemos el pago. Te avisamos por este mismo correo.`
      })
    });

    res.status(201).json({
      ok: true,
      mensaje: envio.ok
        ? "Solicitud recibida. Te mandamos un correo y el QR se activará cuando confirmemos el pago."
        : "Solicitud recibida y el QR se activará cuando confirmemos el pago. No pudimos mandarte el correo: guardá el enlace de esta entrada.",
      correoEnviado: envio.ok,
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

app.post("/api/admin/confirmar-pago/:ticketId", requireRole("admin", "staff"), async (req, res) => {
  try {
    const ticket = await entradasRepo.obtenerPorId(req.params.ticketId);
    if (!ticket) {
      return res.status(404).json({ ok: false, mensaje: "Ticket no encontrado." });
    }
    if (ticket.pagado) {
      return res.json({ ok: true, mensaje: "El pago ya estaba confirmado.", ticket });
    }

    const updated = await entradasRepo.confirmarPago(req.params.ticketId, req.usuario.id);
    const envio = await emailer.enviar({
      templateId: emailer.plantillas.ticket,
      params: paramsDeTicket(updated, {
        asunto: `Tu entrada para ${updated.evento} ya está activa`,
        mensaje: "Confirmamos tu pago. Tu código QR ya está activo: preséntalo en la entrada del evento. Es personal y de un solo uso."
      })
    });

    // Quien aprueba tiene que enterarse si el correo no salió: es la única
    // persona en posición de avisar al comprador por otro medio.
    res.json({
      ok: true,
      mensaje: envio.ok
        ? "Pago confirmado y QR activado. Ya le avisamos por correo."
        : `Pago confirmado y QR activado, pero el correo NO salió (${envio.error}). Avisale por otro medio y pasale el enlace de su entrada.`,
      correoEnviado: envio.ok,
      ticket: updated
    });
  } catch (error) {
    console.error("Error al confirmar pago:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo confirmar el pago." });
  }
});

app.get("/api/admin/pagos-pendientes", requireRole("admin", "staff"), async (req, res) => {
  try {
    const tickets = await entradasRepo.pagosPendientes();
    res.json({ ok: true, tickets });
  } catch (error) {
    console.error("Error al consultar pagos pendientes:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudieron consultar los pagos pendientes." });
  }
});

app.get("/api/admin/entradas", requireRole("admin", "staff"), async (req, res) => {
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
    if (!Number.isFinite(cantidad) || cantidad < 1 || cantidad > MAX_CORTESIAS) {
      return res.status(400).json({ ok: false, mensaje: `La cantidad debe estar entre 1 y ${MAX_CORTESIAS}.` });
    }

    const generated = [];
    const envios = [];
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
      // En serie, cada correo suma su latencia a la misma petición. En paralelo
      // la tanda entera tarda lo que el envío más lento.
      envios.push(emailer.enviar({
        templateId: emailer.plantillas.ticket,
        params: paramsDeTicket(ticket, {
          asunto: `Tu entrada para ${evento.nombre}`,
          mensaje: `Tu entrada ${tipoEntrada} para ${evento.nombre} ya está lista y activa. Presenta el código QR en la entrada del evento.`
        })
      }));

      generated.push({ ...ticket, qrDataUrl: `data:image/png;base64,${qrBuffer.toString("base64")}` });
    }

    const resultados = await Promise.all(envios);
    const fallidos = resultados.filter((r) => !r.ok);
    const enviados = resultados.length - fallidos.length;

    res.status(201).json({
      ok: true,
      // Antes esta línea afirmaba que los correos habían salido, saliesen o no.
      mensaje: fallidos.length
        ? `Se generaron ${generated.length} QR, pero ${fallidos.length} correo(s) no salieron (${fallidos[0].error}). Las entradas son válidas igual: podés pasarlas desde el listado.`
        : `Se generaron ${generated.length} QR y se enviaron ${enviados} correo(s) a ${correo}.`,
      correosEnviados: enviados,
      correosFallidos: fallidos.length,
      tickets: generated
    });
  } catch (error) {
    console.error("Error al generar QR:", error);
    res.status(500).json({ ok: false, mensaje: "No se pudo generar el QR." });
  }
});

// La imagen del QR que embeben los correos. Es pública por necesidad: un
// cliente de correo no manda cabeceras de sesión al cargar una <img>. No
// expone nada nuevo (el contenido del QR es el id, que ya viaja en el enlace
// del ticket) y el escáner sigue rechazando cualquier QR sin pago confirmado.
// El filtro de uuid evita que el dominio sirva de generador de QR ajenos.
app.get("/api/ticket/:ticketId/qr.png", async (req, res) => {
  const ticketId = String(req.params.ticketId || "");
  if (!isUuid(ticketId)) {
    return res.status(404).send("QR no encontrado.");
  }
  try {
    const buffer = await createTicketQr(ticketId);
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.send(buffer);
  } catch (error) {
    console.error("Error al generar la imagen del QR:", error);
    res.status(500).send("No se pudo generar el QR.");
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
        eventoFecha: ticket.eventoFecha,
        eventoLugar: ticket.eventoLugar,
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

// Adonde vuelve la persona desde el correo de invitación. Supabase deja la
// sesión en el fragmento de la URL y la página la usa para fijar la clave.
app.get("/establecer-clave", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "establecer-clave.html"));
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

// Escáner a pantalla completa, pensado para el teléfono del staff en la
// puerta. El panel sigue teniendo el suyo embebido para trabajar desde un
// computador.
app.get("/scanner", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "scanner.html"));
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
