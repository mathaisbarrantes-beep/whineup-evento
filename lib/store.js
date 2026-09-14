"use strict";

const fs = require("fs");
const admin = require("firebase-admin");
const { config } = require("./config");
const { sha256 } = require("./security");

/**
 * Capa de persistencia.
 *
 * Firestore es obligatorio en produccion: es el unico modo de garantizar
 * que un QR se use UNA sola vez, porque la transaccion atomica evita que
 * dos escaneres simultaneos acepten el mismo ticket. El modo memoria es
 * exclusivamente para desarrollo local.
 */

const MEMORY = {
  tickets: new Map(),
  sesiones: new Map(),
  intentos: new Map()
};

let db = null;
let initialised = false;

function resolveCredential() {
  if (config.firebase.serviceAccountFile && fs.existsSync(config.firebase.serviceAccountFile)) {
    try {
      return JSON.parse(fs.readFileSync(config.firebase.serviceAccountFile, "utf8"));
    } catch (error) {
      console.error("[store] La cuenta de servicio no es un JSON valido:", error.message);
    }
  }

  if (config.firebase.projectId && config.firebase.clientEmail && config.firebase.privateKey) {
    return {
      projectId: config.firebase.projectId,
      clientEmail: config.firebase.clientEmail,
      privateKey: config.firebase.privateKey
    };
  }

  return null;
}

function initStore() {
  if (initialised) return db;
  initialised = true;

  const credential = resolveCredential();
  if (!credential) {
    console.warn("[store] Firestore no configurado: usando memoria (solo desarrollo).");
    return null;
  }

  try {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(credential) });
    }
    db = admin.firestore();
    console.log("[store] Firestore conectado.");
  } catch (error) {
    console.error("[store] Firestore no pudo inicializarse:", error.message);
    db = null;
  }

  return db;
}

function isPersistent() {
  return Boolean(db);
}

/* ---------------------------------------------------------------- tickets */

async function saveTicket(ticket) {
  if (db) {
    await db.collection("tickets").doc(ticket.id).create(ticket);
    return ticket;
  }

  if (MEMORY.tickets.has(ticket.id)) {
    throw new Error("El ticket ya existe.");
  }
  MEMORY.tickets.set(ticket.id, { ...ticket });
  return ticket;
}

async function getTicket(ticketId) {
  if (db) {
    const snapshot = await db.collection("tickets").doc(ticketId).get();
    return snapshot.exists ? snapshot.data() : null;
  }

  const ticket = MEMORY.tickets.get(ticketId);
  return ticket ? { ...ticket } : null;
}

async function updateTicket(ticketId, updates) {
  if (db) {
    const reference = db.collection("tickets").doc(ticketId);
    await reference.update(updates);
    const snapshot = await reference.get();
    return snapshot.exists ? snapshot.data() : null;
  }

  const current = MEMORY.tickets.get(ticketId);
  if (!current) return null;

  const updated = { ...current, ...updates };
  MEMORY.tickets.set(ticketId, updated);
  return { ...updated };
}

function ordenarPorFecha(tickets) {
  return tickets.sort((left, right) =>
    String(right.creadoEn || "").localeCompare(String(left.creadoEn || ""))
  );
}

async function listTickets({ estado = null, limite = 200 } = {}) {
  if (db) {
    // Con filtro ordenamos en memoria: combinar where + orderBy obligaria a
    // crear un indice compuesto en Firestore, y la consulta fallaria en
    // produccion justo cuando mas falta hace.
    if (estado) {
      const snapshot = await db.collection("tickets")
        .where("estado", "==", estado)
        .limit(limite)
        .get();
      return ordenarPorFecha(snapshot.docs.map((document) => document.data()));
    }

    const snapshot = await db.collection("tickets")
      .orderBy("creadoEn", "desc")
      .limit(limite)
      .get();
    return snapshot.docs.map((document) => document.data());
  }

  const tickets = Array.from(MEMORY.tickets.values())
    .filter((ticket) => !estado || ticket.estado === estado)
    .map((ticket) => ({ ...ticket }));

  return ordenarPorFecha(tickets).slice(0, limite);
}

async function countTickets() {
  if (db) {
    const snapshot = await db.collection("tickets").count().get();
    return snapshot.data().count;
  }
  return MEMORY.tickets.size;
}

/** Evita que la misma referencia de pago genere varias entradas. */
async function referenciaPagoYaUsada(referenciaHash, eventoId) {
  if (db) {
    const snapshot = await db.collection("tickets")
      .where("referenciaPagoHash", "==", referenciaHash)
      .limit(10)
      .get();
    return snapshot.docs.some((document) => document.data().eventoId === eventoId);
  }

  return Array.from(MEMORY.tickets.values())
    .some((ticket) => ticket.referenciaPagoHash === referenciaHash && ticket.eventoId === eventoId);
}

/**
 * Marca la entrada como usada de forma atomica.
 * Devuelve { permitido, motivo, ticket }.
 */
async function consumirTicket(ticketId, staffUsername) {
  const ahora = new Date().toISOString();

  function evaluar(ticket) {
    if (!ticket) return { permitido: false, motivo: "NO_EXISTE" };
    if (ticket.estado === "ANULADO") return { permitido: false, motivo: "ANULADO" };
    if (!ticket.pagado || ticket.estado === "PENDIENTE_PAGO") {
      return { permitido: false, motivo: "PAGO_PENDIENTE" };
    }
    if (ticket.estado === "INGRESADO") return { permitido: false, motivo: "YA_USADO" };
    if (ticket.estado !== "PENDIENTE") return { permitido: false, motivo: "ESTADO_INVALIDO" };
    return { permitido: true };
  }

  const cambios = {
    estado: "INGRESADO",
    ingresadoEn: ahora,
    ingresadoPor: staffUsername
  };

  if (db) {
    const reference = db.collection("tickets").doc(ticketId);
    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const ticket = snapshot.exists ? snapshot.data() : null;
      const veredicto = evaluar(ticket);

      if (!veredicto.permitido) return { ...veredicto, ticket };

      transaction.update(reference, cambios);
      return { permitido: true, ticket: { ...ticket, ...cambios } };
    });
  }

  const ticket = MEMORY.tickets.get(ticketId) || null;
  const veredicto = evaluar(ticket);
  if (!veredicto.permitido) return { ...veredicto, ticket: ticket ? { ...ticket } : null };

  const actualizado = { ...ticket, ...cambios };
  MEMORY.tickets.set(ticketId, actualizado);
  return { permitido: true, ticket: actualizado };
}

/* --------------------------------------------------------------- sesiones */

/** Guardamos el hash del token, no el token: la base de datos no sirve para suplantar. */
async function saveSession(token, session) {
  const id = sha256(token);

  if (db) {
    await db.collection("sesiones").doc(id).set(session);
    return;
  }

  MEMORY.sesiones.set(id, session);
}

async function getSession(token) {
  const id = sha256(token);

  if (db) {
    const snapshot = await db.collection("sesiones").doc(id).get();
    return snapshot.exists ? snapshot.data() : null;
  }

  return MEMORY.sesiones.get(id) || null;
}

async function deleteSession(token) {
  const id = sha256(token);

  if (db) {
    await db.collection("sesiones").doc(id).delete();
    return;
  }

  MEMORY.sesiones.delete(id);
}

/* ------------------------------------------------------ intentos de login */

/** Contador persistente: sobrevive a reinicios y a instancias serverless. */
async function registrarIntentoLogin(clave, ventanaMs) {
  const ahora = Date.now();
  const id = sha256(clave);

  if (db) {
    const reference = db.collection("intentos_login").doc(id);
    return db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(reference);
      const actual = snapshot.exists ? snapshot.data() : null;
      const vigente = actual && ahora < actual.resetAt
        ? actual
        : { intentos: 0, resetAt: ahora + ventanaMs };
      const siguiente = { intentos: vigente.intentos + 1, resetAt: vigente.resetAt };
      transaction.set(reference, siguiente);
      return siguiente;
    });
  }

  const actual = MEMORY.intentos.get(id);
  const vigente = actual && ahora < actual.resetAt
    ? actual
    : { intentos: 0, resetAt: ahora + ventanaMs };
  const siguiente = { intentos: vigente.intentos + 1, resetAt: vigente.resetAt };
  MEMORY.intentos.set(id, siguiente);
  return siguiente;
}

async function limpiarIntentosLogin(clave) {
  const id = sha256(clave);

  if (db) {
    await db.collection("intentos_login").doc(id).delete().catch(() => {});
    return;
  }

  MEMORY.intentos.delete(id);
}

module.exports = {
  initStore,
  isPersistent,
  saveTicket,
  getTicket,
  updateTicket,
  listTickets,
  countTickets,
  referenciaPagoYaUsada,
  consumirTicket,
  saveSession,
  getSession,
  deleteSession,
  registrarIntentoLogin,
  limpiarIntentosLogin
};
