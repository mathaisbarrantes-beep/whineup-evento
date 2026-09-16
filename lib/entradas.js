// lib/entradas.js
const NO_CONFIGURADO = { error: 'NO_CONFIGURADO' };
const SELECT_CON_EVENTO = '*, eventos(nombre, fecha, lugar, cortesia)';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_ENCONTRADO = {
  permitido: false,
  mensaje: 'Ticket no encontrado.',
  nombre: null,
  evento: null,
  tipoEntrada: null
};

const MENSAJES_CANJE = {
  ENTREGAR: 'Entregar la cortesía.',
  YA_ENTREGADA: 'Esta cortesía ya se entregó.',
  SIN_CORTESIA: 'Esta entrada no trae cortesía.',
  NO_INGRESO: 'Primero tiene que pasar por la puerta.',
  NO_ENCONTRADA: 'Ticket no encontrado.'
};

function resultadoCanje(row) {
  return {
    permitido: Boolean(row.permitido),
    motivo: row.motivo,
    mensaje: MENSAJES_CANJE[row.motivo] || 'No se pudo canjear la cortesía.',
    nombre: row.nombre || null,
    evento: row.evento || null,
    cortesia: row.cortesia || null,
    entregadaEn: row.entregada_en || null
  };
}

// Un escáner en la puerta lee cualquier QR, no solo los nuestros. Si ese texto
// llega a un filtro sobre una columna uuid, Postgres responde 22P02
// ("invalid input syntax for type uuid") y el error sube como 500. Descartamos
// el id antes de consultar y devolvemos la forma normal de "no encontrado".
function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

function mapEntradaRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    eventoId: row.evento_id,
    evento: row.eventos ? row.eventos.nombre : null,
    // La entrada tiene que poder mostrarse sola: sin la fecha y el lugar, el
    // ticket que abre el comprador no dice a que evento ni cuando entrar.
    eventoFecha: row.eventos ? row.eventos.fecha : null,
    eventoLugar: row.eventos ? row.eventos.lugar : null,
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
    creadoEn: row.creado_en,
    cortesia: row.cortesia || null,
    cortesiaEntregadaEn: row.cortesia_entregada_en || null,
    // La cortesía que el evento tiene configurada hoy: el panel la usa para
    // saber si puede ofrecer "Dar cortesía".
    eventoCortesia: row.eventos ? (row.eventos.cortesia || null) : null
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
    if (!isUuid(id)) return null;
    const { data, error } = await supabase.from('entradas').select(SELECT_CON_EVENTO).eq('id', id).maybeSingle();
    if (error) throw error;
    return mapEntradaRow(data);
  }

  async function confirmarPago(id, staffId) {
    assertConfigured();
    if (!isUuid(id)) return null;
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
    if (!isUuid(id)) return { ...NO_ENCONTRADO };
    const { data, error } = await supabase.rpc('validar_entrada', { p_entrada_id: id });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) {
      return { ...NO_ENCONTRADO };
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

  // Dos conteos exactos: contar filas en JavaScript quedaría cortado en las
  // 1000 que devuelve Supabase por pedido.
  async function contarCortesias(eventoId) {
    assertConfigured();
    const base = () => supabase
      .from('entradas').select('id', { count: 'exact', head: true })
      .eq('evento_id', eventoId).not('cortesia', 'is', null);
    const [asignadas, entregadas] = await Promise.all([
      base(),
      base().not('cortesia_entregada_en', 'is', null)
    ]);
    if (asignadas.error) throw asignadas.error;
    if (entregadas.error) throw entregadas.error;
    return { asignadas: asignadas.count || 0, entregadas: entregadas.count || 0 };
  }

  // Los updates van condicionados: si otro admin la dio, o la barra la
  // entregó entre la lectura y el cambio, no se pisa nada.
  async function ponerCortesia(id, dar) {
    assertConfigured();
    if (!isUuid(id)) throw { error: 'ENTRADA_NO_ENCONTRADA' };
    const actual = await obtenerPorId(id);
    if (!actual) throw { error: 'ENTRADA_NO_ENCONTRADA' };

    if (dar) {
      if (actual.cortesia) throw { error: 'YA_TIENE_CORTESIA' };
      if (!actual.eventoCortesia) throw { error: 'EVENTO_SIN_CORTESIA' };
      const { data, error } = await supabase
        .from('entradas').update({ cortesia: actual.eventoCortesia })
        .eq('id', id).is('cortesia', null)
        .select(SELECT_CON_EVENTO).maybeSingle();
      if (error) throw error;
      if (!data) throw { error: 'YA_TIENE_CORTESIA' };
      return mapEntradaRow(data);
    }

    if (!actual.cortesia) return actual;
    if (actual.cortesiaEntregadaEn) throw { error: 'CORTESIA_ENTREGADA' };
    const { data, error } = await supabase
      .from('entradas').update({ cortesia: null })
      .eq('id', id).is('cortesia_entregada_en', null)
      .select(SELECT_CON_EVENTO).maybeSingle();
    if (error) throw error;
    if (!data) throw { error: 'CORTESIA_ENTREGADA' };
    return mapEntradaRow(data);
  }

  async function canjearCortesia(id, staffId) {
    assertConfigured();
    if (!isUuid(id)) return resultadoCanje({ permitido: false, motivo: 'NO_ENCONTRADA' });
    const { data, error } = await supabase.rpc('canjear_cortesia', { p_entrada_id: id, p_staff_id: staffId });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return resultadoCanje(row || { permitido: false, motivo: 'NO_ENCONTRADA' });
  }

  return {
    NO_CONFIGURADO, crear, obtenerPorId, confirmarPago, pagosPendientes,
    generadas, misEntradas, crearGenerada, validar, contarTotal,
    contarCortesias, ponerCortesia, canjearCortesia
  };
}

module.exports = { createEntradasRepo, mapEntradaRow, isUuid, NO_CONFIGURADO };
