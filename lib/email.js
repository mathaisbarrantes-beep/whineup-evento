// lib/email.js
const ENDPOINT_POR_DEFECTO = 'https://api.emailjs.com/api/v1.0/email/send';
const TIMEOUT_MS = 10000;

// El QR no viaja como adjunto: viaja como una URL de nuestro propio dominio.
// EmailJS cobra los adjuntos dinámicos y les pone límite de tamaño; una <img>
// apuntando a /api/ticket/<id>/qr.png funciona en el plan gratuito, se ve en
// Gmail (que bloquea las data: URI) y nos deja cambiar el QR sin reenviar nada.
function construirUrls(baseUrl, ticketId) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return {
    qrUrl: `${base}/api/ticket/${encodeURIComponent(ticketId)}/qr.png`,
    ticketUrl: `${base}/ticket?ticketId=${encodeURIComponent(ticketId)}`
  };
}

// En Vercel PUBLIC_URL puede faltar. VERCEL_URL no sirve de respaldo: es la
// dirección de cada deployment, cambia en cada push y Supabase no la tiene
// entre sus redirecciones permitidas, así que las invitaciones caían en la Site
// URL. VERCEL_PROJECT_PRODUCTION_URL es el dominio de producción y no cambia.
function resolverBaseUrl(env) {
  if (env.PUBLIC_URL) return env.PUBLIC_URL;
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (env.VERCEL_URL) return `https://${env.VERCEL_URL}`;
  return `http://localhost:${env.PORT || 3000}`;
}

function buildEmailer(env = process.env) {
  const serviceId = env.EMAILJS_SERVICE_ID;
  const publicKey = env.EMAILJS_PUBLIC_KEY;
  const privateKey = env.EMAILJS_PRIVATE_KEY;
  const templateCompra = env.EMAILJS_TEMPLATE_COMPRA;
  const templateTicket = env.EMAILJS_TEMPLATE_TICKET;
  const endpoint = env.EMAILJS_ENDPOINT || ENDPOINT_POR_DEFECTO;
  const baseUrl = resolverBaseUrl(env);

  // Las cinco hacen falta. Con cuatro, EmailJS responde 400 en cada envío y el
  // fallo aparece ticket por ticket en vez de una sola vez al arrancar.
  const emailConfigured = Boolean(
    serviceId && publicKey && privateKey && templateCompra && templateTicket
  );

  async function enviar({ templateId, params }) {
    if (!emailConfigured) {
      // Ruidoso a propósito: la versión anterior descartaba el correo en
      // silencio y nadie se enteraba hasta que un comprador reclamaba.
      console.warn('[email] EmailJS sin configurar: no se envió nada a', params?.to_email);
      return { ok: false, error: 'NO_CONFIGURADO' };
    }
    if (!params || !params.to_email) {
      console.warn('[email] Envío sin destinatario; se descarta.');
      return { ok: false, error: 'SIN_DESTINATARIO' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          service_id: serviceId,
          template_id: templateId,
          // user_id es la clave pública; accessToken es la privada. EmailJS
          // exige la privada cuando la llamada no viene de un navegador, que
          // es justo lo que queremos: nada de esto llega al cliente.
          user_id: publicKey,
          accessToken: privateKey,
          template_params: params
        })
      });

      if (!response.ok) {
        const detalle = await response.text().catch(() => '');
        throw new Error(`EmailJS respondió ${response.status}: ${detalle.slice(0, 200)}`);
      }

      return { ok: true };
    } catch (error) {
      // No relanzamos: un correo caído no puede tumbar una venta ni una
      // confirmación de pago. El ticket ya existe en la base.
      const mensaje = error.name === 'AbortError' ? `sin respuesta en ${TIMEOUT_MS}ms` : error.message;
      console.error(`[email] Falló el envío a ${params.to_email}: ${mensaje}`);
      return { ok: false, error: mensaje };
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    emailConfigured,
    baseUrl,
    plantillas: { compra: templateCompra, ticket: templateTicket },
    urlsDeTicket: (ticketId) => construirUrls(baseUrl, ticketId),
    enviar
  };
}

module.exports = { buildEmailer, construirUrls, resolverBaseUrl, ENDPOINT_POR_DEFECTO };
