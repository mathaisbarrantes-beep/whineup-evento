const test = require('node:test');
const assert = require('node:assert/strict');
const { createUsuariosRepo, ROLES_ASIGNABLES } = require('../../lib/usuarios');

const ADMIN = 'aaaaaaaa-0000-4000-8000-000000000001';
const STAFF = 'bbbbbbbb-0000-4000-8000-000000000002';
const CLIENTE = 'cccccccc-0000-4000-8000-000000000003';

// Doble mínimo: auth.admin.listUsers() para los correos y from('perfiles')
// para los roles, que es exactamente lo que el repo junta.
function fakeSupabase({ usuarios = [], perfiles = [], onUpdate } = {}) {
  return {
    auth: { admin: { listUsers: async () => ({ data: { users: usuarios }, error: null }) } },
    from(tabla) {
      assert.equal(tabla, 'perfiles');
      return {
        select() {
          return {
            in: async () => ({ data: perfiles, error: null }),
            eq(_col, id) {
              return {
                maybeSingle: async () => ({ data: perfiles.find((p) => p.id === id) || null, error: null })
              };
            }
          };
        },
        update(cambios) {
          return {
            eq(_col, id) {
              return {
                select() {
                  return {
                    single: async () => {
                      if (onUpdate) onUpdate({ id, cambios });
                      const previo = perfiles.find((p) => p.id === id) || {};
                      return { data: { ...previo, ...cambios, id }, error: null };
                    }
                  };
                }
              };
            }
          };
        }
      };
    }
  };
}

test('listar rejects with NO_CONFIGURADO when Supabase is not configured', async () => {
  const repo = createUsuariosRepo({ supabase: null, supabaseConfigured: false });
  await assert.rejects(() => repo.listar(), (err) => err === repo.NO_CONFIGURADO);
});

test('cambiarRol rejects with NO_CONFIGURADO when Supabase is not configured', async () => {
  const repo = createUsuariosRepo({ supabase: null, supabaseConfigured: false });
  await assert.rejects(
    () => repo.cambiarRol({ id: STAFF, rol: 'staff', actorId: ADMIN }),
    (err) => err === repo.NO_CONFIGURADO
  );
});

test('listar joins auth emails with perfil roles', async () => {
  const supabase = fakeSupabase({
    usuarios: [
      { id: STAFF, email: 'staff@whineup.cr', created_at: '2026-01-02T00:00:00Z', last_sign_in_at: '2026-02-01T00:00:00Z' },
      { id: ADMIN, email: 'admin@whineup.cr', created_at: '2026-01-01T00:00:00Z', last_sign_in_at: null }
    ],
    perfiles: [
      { id: STAFF, rol: 'staff', nombre: 'Staff Uno' },
      { id: ADMIN, rol: 'admin', nombre: 'Jefa' }
    ]
  });

  const lista = await createUsuariosRepo({ supabase, supabaseConfigured: true }).listar();
  assert.equal(lista.length, 2);
  // Ordenados por correo: admin@ antes que staff@.
  assert.equal(lista[0].correo, 'admin@whineup.cr');
  assert.equal(lista[0].rol, 'admin');
  assert.equal(lista[1].correo, 'staff@whineup.cr');
  assert.equal(lista[1].nombre, 'Staff Uno');
});

// El trigger crea el perfil en el primer login. Entre "Add user" y ese primer
// login hay una ventana en la que el usuario existe sin perfil: la lista tiene
// que mostrarlo igual, no esconderlo.
test('listar shows a user with no perfil row yet as cliente', async () => {
  const supabase = fakeSupabase({
    usuarios: [{ id: CLIENTE, email: 'nuevo@ejemplo.com', created_at: '2026-03-01T00:00:00Z' }],
    perfiles: []
  });
  const lista = await createUsuariosRepo({ supabase, supabaseConfigured: true }).listar();
  assert.equal(lista[0].rol, 'cliente');
  assert.equal(lista[0].nombre, null);
});

test('listar returns an empty list without querying perfiles when there are no users', async () => {
  const supabase = {
    auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } },
    from() { throw new Error('no debe consultarse perfiles sin usuarios'); }
  };
  assert.deepEqual(await createUsuariosRepo({ supabase, supabaseConfigured: true }).listar(), []);
});

test('cambiarRol promotes a cliente to staff', async () => {
  let recibido = null;
  const supabase = fakeSupabase({
    perfiles: [{ id: CLIENTE, rol: 'cliente', nombre: 'Ana' }],
    onUpdate: (x) => { recibido = x; }
  });

  const resultado = await createUsuariosRepo({ supabase, supabaseConfigured: true })
    .cambiarRol({ id: CLIENTE, rol: 'staff', actorId: ADMIN });

  assert.deepEqual(recibido, { id: CLIENTE, cambios: { rol: 'staff' } });
  assert.equal(resultado.rol, 'staff');
});

test('cambiarRol demotes a staff back to cliente', async () => {
  const supabase = fakeSupabase({ perfiles: [{ id: STAFF, rol: 'staff', nombre: 'Staff Uno' }] });
  const resultado = await createUsuariosRepo({ supabase, supabaseConfigured: true })
    .cambiarRol({ id: STAFF, rol: 'cliente', actorId: ADMIN });
  assert.equal(resultado.rol, 'cliente');
});

// Las tres barreras que impiden que el panel reparta o quite poder de admin.
test('cambiarRol refuses to mint an admin from the panel', async () => {
  const supabase = fakeSupabase({ perfiles: [{ id: CLIENTE, rol: 'cliente' }] });
  await assert.rejects(
    () => createUsuariosRepo({ supabase, supabaseConfigured: true })
      .cambiarRol({ id: CLIENTE, rol: 'admin', actorId: ADMIN }),
    (err) => err.error === 'ROL_INVALIDO'
  );
  assert.equal(ROLES_ASIGNABLES.includes('admin'), false);
});

test('cambiarRol refuses to demote an existing admin', async () => {
  const supabase = fakeSupabase({ perfiles: [{ id: STAFF, rol: 'admin', nombre: 'Otro jefe' }] });
  await assert.rejects(
    () => createUsuariosRepo({ supabase, supabaseConfigured: true })
      .cambiarRol({ id: STAFF, rol: 'cliente', actorId: ADMIN }),
    (err) => err.error === 'NO_TOCAR_ADMIN'
  );
});

test('cambiarRol refuses to change your own role', async () => {
  const supabase = fakeSupabase({ perfiles: [{ id: ADMIN, rol: 'admin' }] });
  await assert.rejects(
    () => createUsuariosRepo({ supabase, supabaseConfigured: true })
      .cambiarRol({ id: ADMIN, rol: 'cliente', actorId: ADMIN }),
    (err) => err.error === 'NO_A_TI_MISMO'
  );
});

test('cambiarRol rejects an unknown user', async () => {
  const supabase = fakeSupabase({ perfiles: [] });
  await assert.rejects(
    () => createUsuariosRepo({ supabase, supabaseConfigured: true })
      .cambiarRol({ id: CLIENTE, rol: 'staff', actorId: ADMIN }),
    (err) => err.error === 'NO_ENCONTRADO'
  );
});

/* ---------------------------------------------------------- invitaciones */

const NUEVO = 'dddddddd-0000-4000-8000-000000000004';
const TOKEN = 'a3f1c9e27b5d48f06e2c1b9a7d4e3f5081c6b2a9d7e4f3c1b8a5d2e9';
const BASE = 'https://whineup-evento.vercel.app';

function usuarioAuth(id, email, extra = {}) {
  return {
    id,
    aud: 'authenticated',
    role: 'authenticated',
    email,
    email_confirmed_at: '2026-09-16T07:40:35Z',
    invited_at: '2026-09-16T07:40:04Z',
    last_sign_in_at: '2026-09-16T07:40:35Z',
    created_at: '2026-09-16T07:40:04Z',
    updated_at: '2026-09-16T07:40:35Z',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    ...extra
  };
}

const YA_REGISTRADO = {
  data: { properties: null, user: null },
  error: { message: 'A user with this email address has already been registered', status: 422, code: 'email_exists' }
};

// Imita a GoTrue: generate_link no manda ningún correo; 'invite' crea la cuenta
// y falla si ya está confirmada; 'recovery' exige que exista. listUsers pagina
// y no devuelve más de `tope` por página, aunque se pidan más.
function fakeEnlaces({ usuarios = [], perfiles = [], tope = 100, respuestaEnlace } = {}) {
  const enlaces = [];
  const actualizaciones = [];
  const supabase = {
    auth: {
      admin: {
        listUsers: async ({ page = 1, perPage = 50 } = {}) => {
          const tamano = Math.min(perPage, tope);
          const desde = (page - 1) * tamano;
          return {
            data: { users: usuarios.slice(desde, desde + tamano), aud: 'authenticated', nextPage: null, lastPage: 0, total: 0 },
            error: null
          };
        },
        generateLink: async (params) => {
          enlaces.push(params);
          if (respuestaEnlace) return respuestaEnlace;
          const existente = usuarios.find((u) => u.email === params.email);
          if (params.type === 'invite' && existente && existente.email_confirmed_at) return YA_REGISTRADO;
          if (params.type === 'recovery' && !existente) {
            return {
              data: { properties: null, user: null },
              error: { message: 'User with this email not found', status: 404, code: 'user_not_found' }
            };
          }
          const user = existente || usuarioAuth(NUEVO, params.email, {
            email_confirmed_at: null, last_sign_in_at: null, invited_at: '2026-09-16T08:30:00Z'
          });
          return {
            data: {
              properties: {
                action_link: `https://orgbeuxvwgmrmnvkmyah.supabase.co/auth/v1/verify?token=${TOKEN}&type=${params.type}&redirect_to=http://localhost:3000`,
                email_otp: '482913',
                hashed_token: TOKEN,
                redirect_to: 'http://localhost:3000',
                verification_type: params.type
              },
              user
            },
            error: null
          };
        }
      }
    },
    from(tabla) {
      assert.equal(tabla, 'perfiles');
      return {
        select() {
          return {
            eq(_col, id) {
              return { maybeSingle: async () => ({ data: perfiles.find((p) => p.id === id) || null, error: null }) };
            }
          };
        },
        update(cambios) {
          return { eq: async (_col, id) => { actualizaciones.push({ id, cambios }); return { error: null }; } };
        }
      };
    }
  };
  return { supabase, enlaces, actualizaciones };
}

function repoCon(fake) {
  return createUsuariosRepo({ supabase: fake.supabase, supabaseConfigured: true });
}

test('invitar rejects with NO_CONFIGURADO when Supabase is not configured', async () => {
  const repo = createUsuariosRepo({ supabase: null, supabaseConfigured: false });
  await assert.rejects(
    () => repo.invitar({ correo: 'a@b.com', baseUrl: BASE }),
    (err) => err === repo.NO_CONFIGURADO
  );
});

// El enlace apunta a nuestra página y lleva el código en el fragmento. El verify
// de Supabase se gasta en cuanto WhatsApp lo abre para armar la vista previa.
test('invitar creates the account without sending mail and returns a shareable link', async () => {
  const fake = fakeEnlaces();
  const r = await repoCon(fake).invitar({ correo: '  Staff@Whineup.CR ', baseUrl: `${BASE}/` });

  assert.deepEqual(fake.enlaces, [{ type: 'invite', email: 'staff@whineup.cr' }]);
  assert.equal(r.enlace, `https://whineup-evento.vercel.app/establecer-clave#token_hash=${TOKEN}&type=invite`);
  assert.deepEqual(fake.actualizaciones, [{ id: NUEVO, cambios: { rol: 'staff' } }]);
  assert.deepEqual(
    { id: r.id, correo: r.correo, rol: r.rol, nueva: r.nueva },
    { id: NUEVO, correo: 'staff@whineup.cr', rol: 'staff', nueva: true }
  );
});

test('invitar as cliente leaves the perfil the trigger created', async () => {
  const fake = fakeEnlaces();
  const r = await repoCon(fake).invitar({ correo: 'cliente@x.com', rol: 'cliente', baseUrl: BASE });
  assert.deepEqual(fake.actualizaciones, []);
  assert.equal(r.rol, 'cliente');
  assert.equal(r.enlace, `https://whineup-evento.vercel.app/establecer-clave#token_hash=${TOKEN}&type=invite`);
});

test('invitar rejects a malformed email before calling Supabase', async () => {
  const supabase = { auth: { admin: {} }, from() { throw new Error('no debe llamarse'); } };
  await assert.rejects(
    () => createUsuariosRepo({ supabase, supabaseConfigured: true }).invitar({ correo: 'no-es-correo', baseUrl: BASE }),
    (err) => err.error === 'CORREO_INVALIDO'
  );
});

test('invitar refuses to hand out admin', async () => {
  const fake = fakeEnlaces();
  await assert.rejects(
    () => repoCon(fake).invitar({ correo: 'a@b.com', rol: 'admin', baseUrl: BASE }),
    (err) => err.error === 'ROL_INVALIDO'
  );
  assert.deepEqual(fake.enlaces, []);
});

// Una cuenta confirmada no se puede volver a invitar. A una de staff se le da
// un enlace de recuperación: sirve si nunca puso la clave o si se la olvidó.
test('invitar gives an existing staff account a recovery link instead of a new invite', async () => {
  const fake = fakeEnlaces({
    usuarios: [usuarioAuth(STAFF, 'staff@x.com')],
    perfiles: [{ id: STAFF, rol: 'staff', nombre: 'Staff' }]
  });
  const r = await repoCon(fake).invitar({ correo: 'staff@x.com', baseUrl: BASE });

  assert.deepEqual(fake.enlaces, [{ type: 'recovery', email: 'staff@x.com' }]);
  assert.equal(r.enlace, `https://whineup-evento.vercel.app/establecer-clave#token_hash=${TOKEN}&type=recovery`);
  assert.deepEqual(fake.actualizaciones, []);
  assert.deepEqual({ id: r.id, rol: r.rol, nueva: r.nueva }, { id: STAFF, rol: 'staff', nueva: false });
});

// Un enlace de acceso a un admin es tomar su cuenta. Ni siquiera se genera.
test('invitar refuses to generate any link for an admin account', async () => {
  const fake = fakeEnlaces({
    usuarios: [usuarioAuth(ADMIN, 'admin@x.com')],
    perfiles: [{ id: ADMIN, rol: 'admin', nombre: 'Admin' }]
  });
  await assert.rejects(
    () => repoCon(fake).invitar({ correo: 'admin@x.com', baseUrl: BASE }),
    (err) => err.error === 'ES_ADMIN'
  );
  assert.deepEqual(fake.enlaces, []);
});

test('invitar sends an existing cliente back to the role list', async () => {
  const fake = fakeEnlaces({
    usuarios: [usuarioAuth(CLIENTE, 'cliente@x.com')],
    perfiles: [{ id: CLIENTE, rol: 'cliente', nombre: 'Cliente' }]
  });
  await assert.rejects(
    () => repoCon(fake).invitar({ correo: 'cliente@x.com', baseUrl: BASE }),
    (err) => err.error === 'YA_EXISTE'
  );
  assert.deepEqual(fake.enlaces, []);
});

// Sin recorrer todas las páginas, una cuenta de staff que no está en la
// primera parece nueva, y Supabase rechaza la invitación.
test('invitar finds an account past the first page even when the server caps the page size', async () => {
  const clientes = Array.from({ length: 150 }, (_, i) =>
    usuarioAuth(`cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`, `cliente${i}@x.com`));
  const fake = fakeEnlaces({
    usuarios: [...clientes, usuarioAuth(STAFF, 'staff@x.com')],
    perfiles: [{ id: STAFF, rol: 'staff', nombre: 'Staff' }],
    tope: 100
  });
  const r = await repoCon(fake).invitar({ correo: 'staff@x.com', baseUrl: BASE });

  assert.equal(r.id, STAFF);
  assert.deepEqual(fake.enlaces, [{ type: 'recovery', email: 'staff@x.com' }]);
});

// La cuenta puede aparecer entre la búsqueda y la invitación.
test('invitar maps an already-registered address to YA_EXISTE', async () => {
  const fake = fakeEnlaces({ respuestaEnlace: YA_REGISTRADO });
  await assert.rejects(
    () => repoCon(fake).invitar({ correo: 'a@b.com', baseUrl: BASE }),
    (err) => err.error === 'YA_EXISTE'
  );
});

// Un enlace sin código se vería bien en el panel y fallaría en el teléfono.
test('invitar refuses to return a link when Supabase sends no token', async () => {
  const fake = fakeEnlaces({
    respuestaEnlace: {
      data: {
        properties: { action_link: null, email_otp: null, hashed_token: '', redirect_to: null, verification_type: 'invite' },
        user: usuarioAuth(NUEVO, 'a@b.com', { email_confirmed_at: null })
      },
      error: null
    }
  });
  await assert.rejects(
    () => repoCon(fake).invitar({ correo: 'a@b.com', baseUrl: BASE }),
    (err) => err.error === 'SIN_ENLACE'
  );
});
