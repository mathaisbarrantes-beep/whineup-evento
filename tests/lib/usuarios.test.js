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

function fakeInvitador({ resultado, errorInvite, onUpdate } = {}) {
  return {
    auth: {
      admin: {
        inviteUserByEmail: async (correo, opciones) => {
          if (errorInvite) return { data: null, error: errorInvite };
          return { data: { user: { id: resultado || CLIENTE, email: correo } }, error: null, opciones };
        }
      }
    },
    from(tabla) {
      assert.equal(tabla, 'perfiles');
      return {
        update(cambios) {
          return { eq: async (_col, id) => { if (onUpdate) onUpdate({ id, cambios }); return { error: null }; } };
        }
      };
    }
  };
}

test('invitar rejects with NO_CONFIGURADO when Supabase is not configured', async () => {
  const repo = createUsuariosRepo({ supabase: null, supabaseConfigured: false });
  await assert.rejects(
    () => repo.invitar({ correo: 'a@b.com', baseUrl: 'https://x.com' }),
    (err) => err === repo.NO_CONFIGURADO
  );
});

test('invitar sends the invite and promotes the new account to staff', async () => {
  let recibido = null;
  let enviado = null;
  const supabase = fakeInvitador({ onUpdate: (x) => { recibido = x; } });
  const original = supabase.auth.admin.inviteUserByEmail;
  supabase.auth.admin.inviteUserByEmail = async (correo, opciones) => {
    enviado = { correo, opciones };
    return original(correo, opciones);
  };

  const repo = createUsuariosRepo({ supabase, supabaseConfigured: true });
  const r = await repo.invitar({ correo: '  Staff@Whineup.CR ', baseUrl: 'https://whineup-evento.vercel.app/' });

  assert.equal(enviado.correo, 'staff@whineup.cr', 'el correo se normaliza');
  assert.equal(enviado.opciones.redirectTo, 'https://whineup-evento.vercel.app/establecer-clave');
  assert.deepEqual(recibido, { id: CLIENTE, cambios: { rol: 'staff' } });
  assert.equal(r.rol, 'staff');
});

test('invitar as cliente does not touch the perfil row', async () => {
  const supabase = fakeInvitador({ onUpdate: () => { throw new Error('no debe actualizar el perfil'); } });
  const repo = createUsuariosRepo({ supabase, supabaseConfigured: true });
  const r = await repo.invitar({ correo: 'cliente@x.com', rol: 'cliente', baseUrl: 'https://x.com' });
  assert.equal(r.rol, 'cliente');
});

test('invitar rejects a malformed email before calling Supabase', async () => {
  const supabase = {
    auth: { admin: { inviteUserByEmail: async () => { throw new Error('no debe llamarse'); } } },
    from() { throw new Error('no debe llamarse'); }
  };
  await assert.rejects(
    () => createUsuariosRepo({ supabase, supabaseConfigured: true }).invitar({ correo: 'no-es-correo', baseUrl: 'https://x.com' }),
    (err) => err.error === 'CORREO_INVALIDO'
  );
});

test('invitar refuses to hand out admin', async () => {
  const supabase = fakeInvitador();
  await assert.rejects(
    () => createUsuariosRepo({ supabase, supabaseConfigured: true })
      .invitar({ correo: 'a@b.com', rol: 'admin', baseUrl: 'https://x.com' }),
    (err) => err.error === 'ROL_INVALIDO'
  );
});

test('invitar maps an already-registered address to YA_EXISTE', async () => {
  const supabase = fakeInvitador({ errorInvite: { message: 'A user with this email address has already been registered' } });
  await assert.rejects(
    () => createUsuariosRepo({ supabase, supabaseConfigured: true })
      .invitar({ correo: 'a@b.com', baseUrl: 'https://x.com' }),
    (err) => err.error === 'YA_EXISTE'
  );
});
