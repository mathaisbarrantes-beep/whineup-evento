// lib/eventos.js
const NO_CONFIGURADO = { error: 'NO_CONFIGURADO' };

function mapEventoRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre,
    fecha: row.fecha,
    lugar: row.lugar,
    precio: row.precio,
    categoria: row.categoria,
    descripcion: row.descripcion,
    cupoMaximo: row.cupo_maximo,
    activo: row.activo
  };
}

function createEventosRepo({ supabase, supabaseConfigured }) {
  function assertConfigured() {
    if (!supabaseConfigured) throw NO_CONFIGURADO;
  }

  async function listarPublicos() {
    assertConfigured();
    const { data, error } = await supabase
      .from('eventos').select('*').eq('activo', true).order('fecha', { ascending: true });
    if (error) throw error;
    return (data || []).map(mapEventoRow);
  }

  async function listarTodos() {
    assertConfigured();
    const { data, error } = await supabase
      .from('eventos').select('*').order('fecha', { ascending: true });
    if (error) throw error;
    return (data || []).map(mapEventoRow);
  }

  async function obtenerPorId(id) {
    assertConfigured();
    const { data, error } = await supabase.from('eventos').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return mapEventoRow(data);
  }

  async function crear(datos) {
    assertConfigured();
    const { data, error } = await supabase.from('eventos').insert(datos).select().single();
    if (error) throw error;
    return mapEventoRow(data);
  }

  async function actualizar(id, cambios) {
    assertConfigured();
    const { data, error } = await supabase.from('eventos').update(cambios).eq('id', id).select().single();
    if (error) throw error;
    return mapEventoRow(data);
  }

  async function desactivar(id) {
    return actualizar(id, { activo: false });
  }

  return { NO_CONFIGURADO, listarPublicos, listarTodos, obtenerPorId, crear, actualizar, desactivar };
}

module.exports = { createEventosRepo, mapEventoRow, NO_CONFIGURADO };
