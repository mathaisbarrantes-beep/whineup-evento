// tests/lib/eventos.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createEventosRepo } = require('../../lib/eventos');

test('listarPublicos rejects with NO_CONFIGURADO when Supabase is not configured', async () => {
  const repo = createEventosRepo({ supabase: null, supabaseConfigured: false });
  await assert.rejects(() => repo.listarPublicos(), (err) => err === repo.NO_CONFIGURADO);
});

test('crear rejects with NO_CONFIGURADO when Supabase is not configured', async () => {
  const repo = createEventosRepo({ supabase: null, supabaseConfigured: false });
  await assert.rejects(() => repo.crear({ nombre: 'Test' }), (err) => err === repo.NO_CONFIGURADO);
});

test('mapEventoRow maps snake_case columns to the camelCase shape the frontend expects', () => {
  const { mapEventoRow } = require('../../lib/eventos');
  const row = {
    id: 'e1', nombre: 'HALLOWEEN PARTY', fecha: '2026-10-31', lugar: 'WhineUp CR',
    precio: 45000, categoria: 'General', descripcion: 'desc', cupo_maximo: null, activo: true
  };
  assert.deepEqual(mapEventoRow(row), {
    id: 'e1', nombre: 'HALLOWEEN PARTY', fecha: '2026-10-31', lugar: 'WhineUp CR',
    precio: 45000, categoria: 'General', descripcion: 'desc', cupoMaximo: null, activo: true,
    bannerUrl: null
  });
});

/* ---------------------------------------------------------------- banners */

const ID = '0f8c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
const PUBLICO = 'https://orgbeuxvwgmrmnvkmyah.supabase.co/storage/v1/object/public';
const AHORA = 1789545600000;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(24)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);

function filaEvento(extra = {}) {
  return {
    id: ID, nombre: 'HALLOWEEN PARTY', fecha: '2026-10-31T03:00:00+00:00', lugar: 'WhineUp CR',
    precio: 15000, categoria: 'General', descripcion: null, cupo_maximo: null, activo: true,
    creado_por: null, creado_en: '2026-09-15T20:00:00+00:00', banner_path: null,
    ...extra
  };
}

// Imita lo que el repo usa de supabase-js: la tabla eventos y el bucket.
// getPublicUrl arma la URL sin ir a la red, como el real.
function fakeEventos({ filas = [filaEvento()], errorUpdate = null, errorUpload = null, errorRemove = null } = {}) {
  const registro = { lecturas: 0, updates: [], subidas: [], borrados: [] };
  const supabase = {
    from(tabla) {
      assert.equal(tabla, 'eventos');
      return {
        select() {
          return {
            eq(columna, valor) {
              const coinciden = filas.filter((f) => f[columna] === valor);
              return {
                maybeSingle: async () => { registro.lecturas += 1; return { data: coinciden[0] || null, error: null }; },
                order: async () => ({ data: coinciden, error: null })
              };
            }
          };
        },
        update(cambios) {
          return {
            eq(_columna, id) {
              return {
                select() {
                  return {
                    single: async () => {
                      registro.updates.push({ id, cambios });
                      if (errorUpdate) return { data: null, error: errorUpdate };
                      const fila = filas.find((f) => f.id === id);
                      Object.assign(fila, cambios);
                      return { data: { ...fila }, error: null };
                    }
                  };
                }
              };
            }
          };
        }
      };
    },
    storage: {
      from(bucket) {
        return {
          upload: async (ruta, contenido, opciones) => {
            registro.subidas.push({ bucket, ruta, bytes: contenido.length, opciones });
            if (errorUpload) return { data: null, error: errorUpload };
            return { data: { id: 'obj-1', path: ruta, fullPath: `${bucket}/${ruta}` }, error: null };
          },
          remove: async (rutas) => {
            registro.borrados.push({ bucket, rutas });
            if (errorRemove) return { data: null, error: errorRemove };
            return { data: rutas.map((name) => ({ name })), error: null };
          },
          getPublicUrl: (ruta) => ({ data: { publicUrl: `${PUBLICO}/${bucket}/${ruta}` } })
        };
      }
    }
  };
  return { supabase, registro };
}

function repoCon(fake) {
  return createEventosRepo({ supabase: fake.supabase, supabaseConfigured: true });
}

async function conReloj(fn) {
  const original = Date.now;
  Date.now = () => AHORA;
  try { return await fn(); } finally { Date.now = original; }
}

test('listarPublicos exposes the public url of each banner', async () => {
  const fake = fakeEventos({ filas: [filaEvento({ banner_path: `${ID}/1.webp` })] });
  const [evento] = await repoCon(fake).listarPublicos();
  assert.equal(evento.bannerUrl, `${PUBLICO}/eventos/${ID}/1.webp`);
});

// El tipo sale del contenido: el Content-Type lo declara el navegador y el
// bucket es público.
test('ponerBanner stores the image under the event with the type read from its bytes', async () => {
  for (const [contenido, extension, tipo] of [[PNG, 'png', 'image/png'], [JPEG, 'jpg', 'image/jpeg'], [WEBP, 'webp', 'image/webp']]) {
    const fake = fakeEventos();
    const evento = await conReloj(() => repoCon(fake).ponerBanner(ID, contenido));
    const ruta = `${ID}/${AHORA}.${extension}`;

    assert.deepEqual(fake.registro.subidas, [{
      bucket: 'eventos', ruta, bytes: contenido.length,
      opciones: { contentType: tipo, upsert: false, cacheControl: '31536000' }
    }]);
    assert.deepEqual(fake.registro.updates, [{ id: ID, cambios: { banner_path: ruta } }]);
    assert.equal(evento.bannerUrl, `${PUBLICO}/eventos/${ruta}`);
  }
});

test('ponerBanner rejects content that is not jpeg, png or webp', async () => {
  for (const contenido of [Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00'), Buffer.from('<html><script>alert(1)</script></html>')]) {
    const fake = fakeEventos();
    await assert.rejects(() => repoCon(fake).ponerBanner(ID, contenido), (err) => err.error === 'BANNER_TIPO');
    assert.deepEqual(fake.registro.subidas, []);
  }
});

// Con un Content-Type que express.raw no acepta, el cuerpo llega como {}.
test('ponerBanner treats a body that is not a buffer as the wrong type and an empty one as missing', async () => {
  const fake = fakeEventos();
  await assert.rejects(() => repoCon(fake).ponerBanner(ID, {}), (err) => err.error === 'BANNER_TIPO');
  await assert.rejects(() => repoCon(fake).ponerBanner(ID, Buffer.alloc(0)), (err) => err.error === 'BANNER_VACIO');
  assert.deepEqual(fake.registro.subidas, []);
});

test('ponerBanner refuses images over 3 MB before uploading', async () => {
  const fake = fakeEventos();
  const grande = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024 - PNG.length + 1)]);
  await assert.rejects(() => repoCon(fake).ponerBanner(ID, grande), (err) => err.error === 'BANNER_MUY_GRANDE');
  assert.deepEqual(fake.registro.subidas, []);
});

test('ponerBanner accepts an image of exactly 3 MB', async () => {
  const fake = fakeEventos();
  const justo = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024 - PNG.length)]);
  await conReloj(() => repoCon(fake).ponerBanner(ID, justo));
  assert.equal(fake.registro.subidas.length, 1);
});

test('ponerBanner rejects an unknown event without uploading', async () => {
  const fake = fakeEventos({ filas: [] });
  await assert.rejects(() => repoCon(fake).ponerBanner(ID, PNG), (err) => err.error === 'EVENTO_NO_ENCONTRADO');
  assert.deepEqual(fake.registro.subidas, []);
});

// El id termina en la ruta del archivo: uno que no es uuid no llega ni a la base.
test('ponerBanner rejects a malformed event id before touching the database or storage', async () => {
  const fake = fakeEventos();
  await assert.rejects(() => repoCon(fake).ponerBanner('../otro-evento', PNG), (err) => err.error === 'EVENTO_NO_ENCONTRADO');
  assert.equal(fake.registro.lecturas, 0);
  assert.deepEqual(fake.registro.subidas, []);
});

test('ponerBanner deletes the previous banner once the event points at the new one', async () => {
  const fake = fakeEventos({ filas: [filaEvento({ banner_path: `${ID}/viejo.png` })] });
  await conReloj(() => repoCon(fake).ponerBanner(ID, WEBP));
  assert.deepEqual(fake.registro.borrados, [{ bucket: 'eventos', rutas: [`${ID}/viejo.png`] }]);
});

// El evento ya apunta al banner nuevo: un archivo viejo sin borrar no es un
// error que el admin tenga que ver.
test('ponerBanner still succeeds when the previous file cannot be deleted', async () => {
  const fake = fakeEventos({
    filas: [filaEvento({ banner_path: `${ID}/viejo.png` })],
    errorRemove: { message: 'Object not found', statusCode: '404' }
  });
  const consola = console.error;
  console.error = () => {};
  try {
    const evento = await conReloj(() => repoCon(fake).ponerBanner(ID, PNG));
    assert.equal(evento.bannerUrl, `${PUBLICO}/eventos/${ID}/${AHORA}.png`);
  } finally {
    console.error = consola;
  }
});

// Si la fila no llega a apuntar al archivo, el archivo quedaría huérfano.
test('ponerBanner deletes the uploaded file when the event update fails', async () => {
  const fallo = { message: 'connection reset', code: '08006' };
  const fake = fakeEventos({ filas: [filaEvento({ banner_path: `${ID}/viejo.png` })], errorUpdate: fallo });
  await assert.rejects(() => conReloj(() => repoCon(fake).ponerBanner(ID, PNG)), (err) => err === fallo);
  assert.deepEqual(fake.registro.borrados, [{ bucket: 'eventos', rutas: [`${ID}/${AHORA}.png`] }]);
});

test('ponerBanner leaves the event alone when the upload fails', async () => {
  const fallo = { message: 'The object exceeded the maximum allowed size', statusCode: '413' };
  const fake = fakeEventos({ errorUpload: fallo });
  await assert.rejects(() => conReloj(() => repoCon(fake).ponerBanner(ID, PNG)), (err) => err === fallo);
  assert.deepEqual(fake.registro.updates, []);
});

test('quitarBanner clears the event and deletes its file', async () => {
  const fake = fakeEventos({ filas: [filaEvento({ banner_path: `${ID}/1.png` })] });
  const evento = await repoCon(fake).quitarBanner(ID);
  assert.deepEqual(fake.registro.updates, [{ id: ID, cambios: { banner_path: null } }]);
  assert.deepEqual(fake.registro.borrados, [{ bucket: 'eventos', rutas: [`${ID}/1.png`] }]);
  assert.equal(evento.bannerUrl, null);
});

test('quitarBanner on an event without banner does not touch storage', async () => {
  const fake = fakeEventos();
  await repoCon(fake).quitarBanner(ID);
  assert.deepEqual(fake.registro.borrados, []);
});
