"use strict";

const { config } = require("./config");
const { escapeHtml } = require("./security");

/**
 * Envio de correos.
 *
 * Canal principal: EmailJS a traves de su API REST, SIEMPRE desde el servidor.
 * La clave privada (accessToken) vive solo en variables de entorno; el navegador
 * nunca ve un identificador de EmailJS. Si alguien inspecciona el HTML de la
 * pagina no encuentra nada con lo que enviar correos en tu nombre.
 *
 * Canal de respaldo: SMTP con nodemailer, opcional.
 *
 * El QR no viaja como adjunto: viaja como una URL firmada de nuestro propio
 * dominio (qr_url). Esquiva los limites de tamano de EmailJS y permite revocar
 * el acceso a la imagen si hace falta.
 */

const EMAILJS_TIMEOUT_MS = 10000;

function emailjsReady() {
  return Boolean(
    config.emailjs.serviceId &&
    config.emailjs.publicKey &&
    config.emailjs.privateKey &&
    config.emailjs.templateTicket
  );
}

function smtpReady() {
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.password);
}

let transporter = null;

function getTransporter() {
  if (!smtpReady()) return null;
  if (transporter) return transporter;

  const nodemailer = require("nodemailer");
  transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.password }
  });

  return transporter;
}

async function enviarConEmailJs(templateId, params) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMAILJS_TIMEOUT_MS);

  try {
    const response = await fetch(config.emailjs.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        service_id: config.emailjs.serviceId,
        template_id: templateId,
        user_id: config.emailjs.publicKey,
        accessToken: config.emailjs.privateKey,
        template_params: params
      })
    });

    if (!response.ok) {
      const detalle = await response.text().catch(() => "");
      throw new Error(`EmailJS respondio ${response.status}: ${detalle.slice(0, 200)}`);
    }

    return { ok: true, canal: "emailjs" };
  } finally {
    clearTimeout(timeout);
  }
}

async function enviarConSmtp({ to, subject, text, html }) {
  const transport = getTransporter();
  if (!transport) throw new Error("SMTP no configurado.");

  await transport.sendMail({
    from: config.smtp.from,
    to,
    subject,
    text,
    html
  });

  return { ok: true, canal: "smtp" };
}

function cuerpoRespaldo(params) {
  const nombre = escapeHtml(params.to_name);
  const evento = escapeHtml(params.evento);
  const mensaje = escapeHtml(params.mensaje);
  const qrUrl = encodeURI(String(params.qr_url || ""));
  const ticketUrl = encodeURI(String(params.ticket_url || ""));

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#111">
      <h2 style="margin:0 0 16px">${evento}</h2>
      <p>Hola ${nombre},</p>
      <p>${mensaje}</p>
      ${qrUrl ? `<p style="text-align:center"><img src="${qrUrl}" alt="Codigo QR de tu entrada" width="260" height="260" style="border:12px solid #fff;border-radius:12px" /></p>` : ""}
      ${ticketUrl ? `<p style="text-align:center"><a href="${ticketUrl}">Ver mi entrada</a></p>` : ""}
      <p style="font-size:12px;color:#666">Tipo: ${escapeHtml(params.tipo_entrada)} &middot; ${escapeHtml(params.fecha)} &middot; ${escapeHtml(params.lugar)}</p>
      <p style="font-size:12px;color:#666">Este codigo es personal y de un solo uso. No lo compartas ni lo publiques.</p>
    </div>
  `;

  const text = [
    `Hola ${params.to_name},`,
    params.mensaje,
    params.ticket_url ? `Tu entrada: ${params.ticket_url}` : "",
    "Este codigo es personal y de un solo uso."
  ].filter(Boolean).join("\n\n");

  return { html, text };
}

/**
 * Envia un correo. No lanza: el fallo de un correo nunca debe tumbar una venta
 * ni una validacion. Devuelve el resultado para poder registrarlo.
 */
async function enviarCorreo({ templateId, asunto, params }) {
  if (!params || !params.to_email) {
    return { ok: false, canal: "ninguno", error: "Falta el destinatario." };
  }

  if (emailjsReady() && templateId) {
    try {
      return await enviarConEmailJs(templateId, { ...params, subject: asunto });
    } catch (error) {
      console.warn("[email] EmailJS fallo, se intenta SMTP:", error.message);
    }
  }

  if (smtpReady()) {
    try {
      const { html, text } = cuerpoRespaldo(params);
      return await enviarConSmtp({ to: params.to_email, subject: asunto, text, html });
    } catch (error) {
      console.warn("[email] SMTP fallo:", error.message);
      return { ok: false, canal: "smtp", error: error.message };
    }
  }

  console.warn("[email] Ningun canal de correo configurado; no se envio nada.");
  return { ok: false, canal: "ninguno", error: "Sin canal de correo." };
}

function estado() {
  return { emailjs: emailjsReady(), smtp: smtpReady() };
}

module.exports = {
  enviarCorreo,
  estado,
  plantillas: {
    compra: () => config.emailjs.templateCompra || config.emailjs.templateTicket,
    ticket: () => config.emailjs.templateTicket
  }
};
