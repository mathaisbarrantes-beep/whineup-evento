// lib/usuarios.js
const NO_CONFIGURADO = { error: 'NO_CONFIGURADO' };

// Desde el panel solo se mueve entre estos dos. 'admin' queda deliberadamente
// fuera: un admin no puede fabricar otro admin ni degradar a uno existente
// desde la interfaz. Los admin se crean a mano en el SQL Editor, que es una
// fricción a propósito — si la cuenta de un admin se ve comprometida, quien la
// tenga no puede repartir el mismo poder desde el navegador.
const ROLES_ASIGNABLES = ['cliente', 'staff'];
const MAX_USUARIOS = 200;

function correoValido(correo) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(correo || ''));
}

function createUsuariosRepo({ supabase, supabaseConfigured }) {
  function assertConfigured() {
    if (!supabaseConfigured) throw NO_CONFIGURADO;
  }

  // El correo vive en auth.users y el rol en public.perfiles, así que hay que
  // juntar las dos mitades: no hay una vista que las traiga de un tirón.
  async function listar() {
    assertConfigured();

    const { data, error } = await supabase.auth.admin.listUsers({ page: 1, perPage: MAX_USUARIOS });
    if (error) throw error;

    const usuarios = (data && data.users) || [];
    if (!usuarios.length) return [];

    const { data: perfiles, error: perfilError } = await supabase
      .from('perfiles')
      .select('id, rol, nombre')
      .in('id', usuarios.map((u) => u.id));
    if (perfilError) throw perfilError;

    const porId = new Map((perfiles || []).map((p) => [p.id, p]));

    return usuarios.map((u) => {
      const perfil = porId.get(u.id);
      return {
        id: u.id,
        correo: u.email || null,
        // Sin perfil, el trigger todavía no corrió: es un usuario recién creado
        // que aún no ha iniciado sesión. Se muestra como cliente, que es lo que
        // será en cuanto entre.
        nombre: (perfil && perfil.nombre) || null,
        rol: (perfil && perfil.rol) || 'cliente',
        creadoEn: u.created_at || null,
        ultimoAcceso: u.last_sign_in_at || null,
        // Invitado y sin aceptar todavía: existe la cuenta pero nunca entró.
        pendiente: Boolean(u.invited_at) && !u.last_sign_in_at
      };
    }).sort((a, b) => String(a.correo || '').localeCompare(String(b.correo || '')));
  }

  async function cambiarRol({ id, rol, actorId }) {
    assertConfigured();

    if (!ROLES_ASIGNABLES.includes(rol)) {
      throw { error: 'ROL_INVALIDO' };
    }
    if (id === actorId) {
      throw { error: 'NO_A_TI_MISMO' };
    }

    const { data: actual, error: leerError } = await supabase
      .from('perfiles').select('id, rol, nombre').eq('id', id).maybeSingle();
    if (leerError) throw leerError;
    if (!actual) throw { error: 'NO_ENCONTRADO' };
    if (actual.rol === 'admin') throw { error: 'NO_TOCAR_ADMIN' };

    const { data, error } = await supabase
      .from('perfiles').update({ rol }).eq('id', id).select('id, rol, nombre').single();
    if (error) throw error;

    return { id: data.id, rol: data.rol, nombre: data.nombre };
  }

  // Invitar en vez de crear la cuenta aquí: Supabase manda el correo y la
  // persona elige su propia contraseña en su navegador. Así ninguna contraseña
  // pasa por esta aplicación ni por el panel de quien invita.
  async function invitar({ correo, rol = 'staff', baseUrl }) {
    assertConfigured();

    const destino = String(correo || '').trim().toLowerCase();
    if (!correoValido(destino)) throw { error: 'CORREO_INVALIDO' };
    if (!ROLES_ASIGNABLES.includes(rol)) throw { error: 'ROL_INVALIDO' };

    const { data, error } = await supabase.auth.admin.inviteUserByEmail(destino, {
      redirectTo: `${String(baseUrl || '').replace(/\/+$/, '')}/establecer-clave`
    });

    if (error) {
      const mensaje = String(error.message || '').toLowerCase();
      if (mensaje.includes('already') && (mensaje.includes('registered') || mensaje.includes('exists'))) {
        throw { error: 'YA_EXISTE' };
      }
      throw error;
    }

    const id = data && data.user && data.user.id;
    if (!id) throw { error: 'SIN_USUARIO' };

    // El trigger on_auth_user_created ya dejó el perfil con rol 'cliente' al
    // insertarse la fila en auth.users, así que aquí solo hay que ajustarlo.
    if (rol !== 'cliente') {
      const { error: rolError } = await supabase.from('perfiles').update({ rol }).eq('id', id);
      if (rolError) throw rolError;
    }

    return { id, correo: destino, rol };
  }

  return { NO_CONFIGURADO, ROLES_ASIGNABLES, listar, cambiarRol, invitar };
}

module.exports = { createUsuariosRepo, ROLES_ASIGNABLES, NO_CONFIGURADO, correoValido };
