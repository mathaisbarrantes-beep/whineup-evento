function createAuthMiddleware({ supabase, supabaseConfigured }) {
  function extractToken(req) {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  }

  async function getUserAndRole(token) {
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data?.user) return null;

      const { data: perfil, error: perfilError } = await supabase
        .from('perfiles')
        .select('rol, nombre')
        .eq('id', data.user.id)
        // maybeSingle: un perfil ausente es un caso normal (el trigger aún no
        // corrió), no un error. Con single() eso registraba un PGRST116 en cada
        // petición. El fallback a 'cliente' de abajo no cambia.
        .maybeSingle();

      if (perfilError) {
        console.error('Error consultando perfil:', perfilError);
      }

      return {
        id: data.user.id,
        email: data.user.email,
        rol: perfil?.rol || 'cliente',
        nombre: perfil?.nombre || null
      };
    } catch (error) {
      console.error('Error verificando sesión de usuario:', error);
      return null;
    }
  }

  function requireRole(...roles) {
    return async (req, res, next) => {
      const token = extractToken(req);
      if (!token) {
        return res.status(401).json({ ok: false, mensaje: 'No autorizado.' });
      }

      if (!supabaseConfigured) {
        return res.status(503).json({ ok: false, mensaje: 'El servicio no está disponible en este momento.' });
      }

      const usuario = await getUserAndRole(token);
      if (!usuario) {
        return res.status(401).json({ ok: false, mensaje: 'Sesión expirada, inicia sesión de nuevo.' });
      }

      if (roles.length && !roles.includes(usuario.rol)) {
        return res.status(403).json({ ok: false, mensaje: 'No tienes permiso para esta acción.' });
      }

      req.usuario = usuario;
      return next();
    };
  }

  return { requireRole, getUserAndRole };
}

module.exports = { createAuthMiddleware };
