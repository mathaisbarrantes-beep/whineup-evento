const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEmailer, construirUrls, resolverBaseUrl } = require('../../lib/email');

const ENV_COMPLETO = {
  EMAILJS_SERVICE_ID: 'service_x',
  EMAILJS_PUBLIC_KEY: 'public_x',
  EMAILJS_PRIVATE_KEY: 'private_x',
  EMAILJS_TEMPLATE_COMPRA: 'tpl_compra',
  EMAILJS_TEMPLATE_TICKET: 'tpl_ticket',
  PUBLIC_URL: 'https://whineup-evento.vercel.app'
};

test('emailConfigured=false when no env vars are set', () => {
  assert.equal(buildEmailer({}).emailConfigured, false);
});

test('emailConfigured=false when a single template id is missing', () => {
  const { EMAILJS_TEMPLATE_TICKET, ...incompleto } = ENV_COMPLETO;
  assert.equal(buildEmailer(incompleto).emailConfigured, false);
});

test('emailConfigured=true with the five required vars', () => {
  assert.equal(buildEmailer(ENV_COMPLETO).emailConfigured, true);
});

test('enviar() resolves NO_CONFIGURADO instead of throwing when unconfigured', async () => {
  const resultado = await buildEmailer({}).enviar({
    templateId: 'tpl', params: { to_email: 'a@b.com' }
  });
  assert.equal(resultado.ok, false);
  assert.equal(resultado.error, 'NO_CONFIGURADO');
});

test('enviar() refuses a send with no recipient', async () => {
  const resultado = await buildEmailer(ENV_COMPLETO).enviar({ templateId: 'tpl', params: {} });
  assert.equal(resultado.ok, false);
  assert.equal(resultado.error, 'SIN_DESTINATARIO');
});

test('enviar() posts the EmailJS payload with the private key as accessToken', async () => {
  const llamadas = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opciones) => {
    llamadas.push({ url, body: JSON.parse(opciones.body) });
    return { ok: true, status: 200, text: async () => '' };
  };

  try {
    const emailer = buildEmailer(ENV_COMPLETO);
    const resultado = await emailer.enviar({
      templateId: 'tpl_ticket',
      params: { to_email: 'comprador@ejemplo.com', evento: 'Fiesta' }
    });

    assert.equal(resultado.ok, true);
    assert.equal(llamadas.length, 1);
    assert.equal(llamadas[0].url, 'https://api.emailjs.com/api/v1.0/email/send');
    assert.equal(llamadas[0].body.service_id, 'service_x');
    assert.equal(llamadas[0].body.template_id, 'tpl_ticket');
    assert.equal(llamadas[0].body.user_id, 'public_x');
    assert.equal(llamadas[0].body.accessToken, 'private_x');
    assert.equal(llamadas[0].body.template_params.to_email, 'comprador@ejemplo.com');
  } finally {
    global.fetch = originalFetch;
  }
});

// Un 4xx de EmailJS (plantilla mal escrita, clave rotada) no puede propagarse:
// el ticket ya está en la base y la venta no se deshace por un correo.
test('enviar() swallows an EmailJS error response and reports it', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 422, text: async () => 'template not found' });

  try {
    const resultado = await buildEmailer(ENV_COMPLETO).enviar({
      templateId: 'tpl_malo', params: { to_email: 'a@b.com' }
    });
    assert.equal(resultado.ok, false);
    assert.match(resultado.error, /422/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('enviar() swallows a network failure', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };

  try {
    const resultado = await buildEmailer(ENV_COMPLETO).enviar({
      templateId: 'tpl', params: { to_email: 'a@b.com' }
    });
    assert.equal(resultado.ok, false);
    assert.match(resultado.error, /ECONNREFUSED/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('construirUrls builds qr and ticket urls and tolerates a trailing slash', () => {
  const urls = construirUrls('https://ejemplo.com/', 'abc-123');
  assert.equal(urls.qrUrl, 'https://ejemplo.com/api/ticket/abc-123/qr.png');
  assert.equal(urls.ticketUrl, 'https://ejemplo.com/ticket?ticketId=abc-123');
});

test('resolverBaseUrl prefers PUBLIC_URL, then VERCEL_URL, then localhost', () => {
  assert.equal(resolverBaseUrl({ PUBLIC_URL: 'https://a.com', VERCEL_URL: 'b.vercel.app' }), 'https://a.com');
  assert.equal(resolverBaseUrl({ VERCEL_URL: 'b.vercel.app' }), 'https://b.vercel.app');
  assert.equal(resolverBaseUrl({ PORT: '4000' }), 'http://localhost:4000');
});
