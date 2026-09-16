// lib/eventos.js
const { isUuid } = require('./entradas');

const NO_CONFIGURADO = { error: 'NO_CONFIGURADO' };
const BUCKET_BANNERS = 'eventos';
const MAX_BANNER_BYTES = 3 * 1024 * 1024;
const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// El tipo se lee de los primeros bytes y no del Content-Type, que lo declara el
// navegador: el bucket es público y no debe servir nada que no sea una imagen.
function tipoDeImagen(contenido) {
  if (contenido.length >= 3 && contenido[0] === 0xff && contenido[1] === 0xd8 && contenido[2] === 0xff) {
    return { tipo: 'image/jpeg', extension: 'jpg' };
  }
  if (contenido.subarray(0, 8).equals(FIRMA_PNG)) {
    return { tipo: 'image/png', extension: 'png' };
  }
  if (contenido.toString('latin1', 0, 4) === 'RIFF' && contenido.toString('latin1', 8, 12) === 'WEBP') {
    return { tipo: 'image/webp', extension: 'webp' };
  }
  return null;
}

function mapEventoRow(row, urlDeBanner = () => null) {
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
    activo: row.activo,
    bannerUrl: row.banner_path ? urlDeBanner(row.banner_path) : null
  };
}

function createEventosRepo({ supabase, supabaseConfigured }) {
  function assertConfigured() {
    if (!supabaseConfigured) throw NO_CONFIGURADO;
  }

  function urlDeBanner(ruta) {
    return supabase.storage.from(BUCKET_BANNERS).getPublicUrl(ruta).data.publicUrl;
  }

  const mapear = (row) => mapEventoRow(row, urlDeBanner);

  async function listarPublicos() {
    assertConfigured();
    const { data, error } = await supabase
      .from('eventos').select('*').eq('activo', true).order('fecha', { ascending: true });
    if (error) throw error;
    return (data || []).map(mapear);
  }

  async function listarTodos() {
    assertConfigured();
    const { data, error } = await supabase
      .from('eventos').select('*').order('fecha', { ascending: true });
    if (error) throw error;
    return (data || []).map(mapear);
  }

  async function obtenerPorId(id) {
    assertConfigured();
    const { data, error } = await supabase.from('eventos').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return mapear(data);
  }

  async function crear(datos) {
    assertConfigured();
    const { data, error } = await supabase.from('eventos').insert(datos).select().single();
    if (error) throw error;
    return mapear(data);
  }

  async function actualizar(id, cambios) {
    assertConfigured();
    const { data, error } = await supabase.from('eventos').update(cambios).eq('id', id).select().single();
    if (error) throw error;
    return mapear(data);
  }

  async function desactivar(id) {
    return actualizar(id, { activo: false });
  }

  // El id termina en la ruta del archivo, así que se valida antes de todo.
  async function bannerActual(id) {
    if (!isUuid(id)) throw { error: 'EVENTO_NO_ENCONTRADO' };
    const { data, error } = await supabase.from('eventos').select('id, banner_path').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!data) throw { error: 'EVENTO_NO_ENCONTRADO' };
    return data.banner_path;
  }

  // Un archivo viejo que no se pudo borrar no justifica fallar: el evento ya
  // apunta al nuevo, y lo peor que queda es un archivo sin uso en el bucket.
  async function borrarArchivo(ruta) {
    const { error } = await supabase.storage.from(BUCKET_BANNERS).remove([ruta]);
    if (error) console.error(`[eventos] No se pudo borrar ${ruta}:`, error.message);
  }

  async function ponerBanner(id, contenido) {
    assertConfigured();
    // Si el Content-Type no era de imagen, express.raw no lee el cuerpo y
    // llega el objeto vacío de express.json.
    if (!Buffer.isBuffer(contenido)) throw { error: 'BANNER_TIPO' };
    if (!contenido.length) throw { error: 'BANNER_VACIO' };
    if (contenido.length > MAX_BANNER_BYTES) throw { error: 'BANNER_MUY_GRANDE' };
    const imagen = tipoDeImagen(contenido);
    if (!imagen) throw { error: 'BANNER_TIPO' };

    const anterior = await bannerActual(id);

    // Un nombre nuevo en cada subida: cambia la URL, así que ninguna caché
    // sigue mostrando el banner viejo, y se puede cachear un año.
    const ruta = `${id}/${Date.now()}.${imagen.extension}`;
    const { error: subirError } = await supabase.storage.from(BUCKET_BANNERS).upload(ruta, contenido, {
      contentType: imagen.tipo,
      upsert: false,
      cacheControl: '31536000'
    });
    if (subirError) throw subirError;

    let evento;
    try {
      evento = await actualizar(id, { banner_path: ruta });
    } catch (error) {
      await borrarArchivo(ruta);
      throw error;
    }

    if (anterior) await borrarArchivo(anterior);
    return evento;
  }

  async function quitarBanner(id) {
    assertConfigured();
    const anterior = await bannerActual(id);
    const evento = await actualizar(id, { banner_path: null });
    if (anterior) await borrarArchivo(anterior);
    return evento;
  }

  return {
    NO_CONFIGURADO, listarPublicos, listarTodos, obtenerPorId, crear, actualizar, desactivar,
    ponerBanner, quitarBanner
  };
}

module.exports = { createEventosRepo, mapEventoRow, NO_CONFIGURADO, MAX_BANNER_BYTES };
