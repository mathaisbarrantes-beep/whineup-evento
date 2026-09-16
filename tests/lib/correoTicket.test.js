const test = require('node:test');
const assert = require('node:assert/strict');
const { paramsDeTicket } = require('../../lib/correoTicket');

const URLS = {
  qrUrl: 'https://whineup-evento.vercel.app/api/ticket/7c4b5944-0000-4000-8000-000000000001/qr.png',
  ticketUrl: 'https://whineup-evento.vercel.app/ticket?ticketId=7c4b5944-0000-4000-8000-000000000001'
};

function ticket(extra = {}) {
  return {
    id: '7c4b5944-0000-4000-8000-000000000001', correo: 'ana@x.com', nombre: 'Ana',
    evento: 'HALLOWEEN PARTY', tipoEntrada: 'General', cortesia: null,
    ...extra
  };
}

// Los nombres son el contrato con las plantillas de EmailJS.
test('paramsDeTicket keeps the EmailJS contract when there is no courtesy', () => {
  assert.deepEqual(paramsDeTicket(ticket(), { asunto: 'Tu entrada', mensaje: 'Confirmamos tu pago.' }, URLS), {
    to_email: 'ana@x.com',
    to_name: 'Ana',
    subject: 'Tu entrada',
    mensaje: 'Confirmamos tu pago.',
    cortesia: '',
    evento: 'HALLOWEEN PARTY',
    tipo_entrada: 'General',
    qr_url: URLS.qrUrl,
    ticket_url: URLS.ticketUrl,
    referencia_corta: '7C4B5944'
  });
});

// Va dentro de "mensaje" porque todas las plantillas ya lo imprimen.
test('paramsDeTicket announces the courtesy inside the message and on its own', () => {
  const params = paramsDeTicket(ticket({ cortesia: '1 shot gratis' }), { asunto: 'Tu entrada', mensaje: 'Confirmamos tu pago.' }, URLS);
  assert.equal(params.mensaje, 'Confirmamos tu pago. Tu entrada incluye una cortesía: 1 shot gratis. La reclamás en la barra mostrando este mismo QR, después de entrar.');
  assert.equal(params.cortesia, '1 shot gratis');
});

test('paramsDeTicket falls back to generic event and ticket type', () => {
  const params = paramsDeTicket(ticket({ evento: null, tipoEntrada: null }), { asunto: 'x', mensaje: 'y' }, URLS);
  assert.equal(params.evento, 'tu evento');
  assert.equal(params.tipo_entrada, 'General');
});
