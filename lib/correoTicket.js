// lib/correoTicket.js

// Los nombres de estos campos son el contrato con las plantillas de EmailJS:
// si aquí se renombra uno, la plantilla lo imprime vacío y EmailJS no avisa.
function paramsDeTicket(ticket, { asunto, mensaje }, { qrUrl, ticketUrl }) {
  const cortesia = ticket.cortesia || '';
  return {
    to_email: ticket.correo,
    to_name: ticket.nombre,
    subject: asunto,
    // La cortesía va dentro del mensaje porque todas las plantillas ya lo
    // imprimen: así se ve sin tocar nada en EmailJS. También va sola, por si
    // alguna plantilla la quiere destacar.
    mensaje: cortesia
      ? `${mensaje} Tu entrada incluye una cortesía: ${cortesia}. La reclamás en la barra mostrando este mismo QR, después de entrar.`
      : mensaje,
    cortesia,
    evento: ticket.evento || 'tu evento',
    tipo_entrada: ticket.tipoEntrada || 'General',
    qr_url: qrUrl,
    ticket_url: ticketUrl,
    // El uuid completo ya va dentro del QR y del enlace; para soporte basta el
    // fragmento, y así no queda un id entero suelto en la bandeja de entrada.
    referencia_corta: String(ticket.id).slice(0, 8).toUpperCase()
  };
}

module.exports = { paramsDeTicket };
