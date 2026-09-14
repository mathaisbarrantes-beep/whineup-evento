// lib/entradas.js
const NO_CONFIGURADO = { error: 'NO_CONFIGURADO' };
const SELECT_CON_EVENTO = '*, eventos(nombre)';

function mapEntradaRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventoId: row.evento_id,
    evento: row.eventos ? row.eventos.nombre : null,
    usuarioId: row.usuario_id,
    nombre: row.nombre,
    correo: row.correo,
    telefono: row.telefono,
    tipoEntrada: row.tipo_entrada,
    precio: row.precio,
    metodoPago: row.metodo_pago,
    referenciaPago: row.referencia_pago,
    pagado: row.pagado,
    estado: row.estado,
    pagoConfirmadoPor: row.pago_confirmado_por,
    pagoConfirmadoEn: row.pago_confirmado_en,
    ingresadoEn: row.ingresado_en,
    generadoPor: row.generado_por,
    creadoEn: row.creado_en
  };
}

function createEntradasRepo({ supabase, supabaseConfigured }) {
  function assertConfigured() {
    if (!supabaseConfigured) throw NO_CONFIGURADO;
  }

  async function crear(datos) {
    assertConfigured();
    const { data, error } = await supabase.from('entradas').insert(datos).select(SELECT_CON_EVENTO).single();
    if (error) throw error;
    return mapEntradaRow(data);
  }

  async function obtenerPorId(id) {
    assertConfigured();
    const { data, error } = await supabase.from('entradas').select(SELECT_CON_EVENTO).eq('id', id).maybeSingle();
    if (error) throw error;
    return mapEntradaRow(data);
  }

  async function confirmarPago(id, staffId) {
    assertConfigured();
    const { data, error } = await supabase
      .from('entradas')
      .update({
        pagado: true,
        estado: 'PENDIENTE',
        pago_confirmado_por: staffId,
        pago_confirmado_en: new Date().toISOString()
      })
      .eq('id', id)
      .select(SELECT_CON_EVENTO)
      .single();
    if (error) throw error;
    return mapEntradaRow(data);
  }

  async function pagosPendientes() {
    assertConfigured();
    const { data, error } = await supabase
      .from('entradas').select(SELECT_CON_EVENTO).eq('estado', 'PENDIENTE_PAGO')
      .order('creado_en', { ascending: false }).limit(100);
    if (error) throw error;
    return (data || []).map(mapEntradaRow);
  }

  async function generadas() {
    assertConfigured();
    const { data, error } = await supabase
      .from('entradas').select(SELECT_CON_EVENTO)
      .order('creado_en', { ascending: false }).limit(200);
    if (error) throw error;
    return (data || []).map(mapEntradaRow);
  }

  async function misEntradas(usuarioId) {
    assertConfigured();
    const { data, error } = await supabase
      .from('entradas').select(SELECT_CON_EVENTO).eq('usuario_id', usuarioId)
      .order('creado_en', { ascending: false });
    if (error) throw error;
    return (data || []).map(mapEntradaRow);
  }

  async function crearGenerada(datos) {
    return crear(datos);
  }

  async function validar(id) {
    assertConfigured();
    const { data, error } = await supabase.rpc('validar_entrada', { p_entrada_id: id });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return { permitido: false, mensaje: 'Ticket no encontrado.', nombre: null, evento: null, tipoEntrada: null };
    }
    return {
      permitido: row.permitido,
      mensaje: row.mensaje,
      nombre: row.nombre,
      evento: row.evento,
      tipoEntrada: row.tipo_entrada
    };
  }

  async function contarTotal() {
    assertConfigured();
    const { count, error } = await supabase.from('entradas').select('id', { count: 'exact', head: true });
    if (error) throw error;
    return count || 0;
  }

  return {
    NO_CONFIGURADO, crear, obtenerPorId, confirmarPago, pagosPendientes,
    generadas, misEntradas, crearGenerada, validar, contarTotal
  };
}

module.exports = { createEntradasRepo, mapEntradaRow, NO_CONFIGURADO };
