"use strict";

/**
 * Catalogo de eventos.
 *
 * Se puede sobrescribir con la variable EVENTOS (JSON) sin tocar codigo.
 * El precio SIEMPRE sale de aqui, nunca del navegador: el comprador no puede
 * manipular cuanto paga.
 */

const EVENTOS_POR_DEFECTO = [
  {
    id: "halloween-party",
    nombre: "HALLOWEEN PARTY",
    fecha: "31 Oct 2026",
    lugar: "WhineUp CR",
    precio: 45000,
    moneda: "CRC",
    categoria: "General",
    aforo: 0,
    descripcion: "La fiesta de Halloween de WhineUp CR. Musica, disfraces y una noche inolvidable."
  }
];

function cargarEventos() {
  const raw = process.env.EVENTOS;
  if (!raw) return EVENTOS_POR_DEFECTO;

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return EVENTOS_POR_DEFECTO;

    return parsed
      .filter((evento) => evento && evento.id && evento.nombre)
      .map((evento) => ({
        id: String(evento.id),
        nombre: String(evento.nombre),
        fecha: String(evento.fecha || ""),
        lugar: String(evento.lugar || ""),
        precio: Number(evento.precio) || 0,
        moneda: String(evento.moneda || "CRC"),
        categoria: String(evento.categoria || "General"),
        aforo: Number(evento.aforo) || 0,
        descripcion: String(evento.descripcion || "")
      }));
  } catch (error) {
    console.error("[eventos] EVENTOS no es un JSON valido, se usa el catalogo por defecto:", error.message);
    return EVENTOS_POR_DEFECTO;
  }
}

const EVENTOS = cargarEventos();

function listarEventos() {
  return EVENTOS;
}

function buscarEvento(eventoId) {
  return EVENTOS.find((evento) => evento.id === eventoId) || null;
}

module.exports = { listarEventos, buscarEvento };
