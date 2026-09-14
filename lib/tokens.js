"use strict";

const crypto = require("crypto");
const { config } = require("./config");
const { safeEqual } = require("./security");

/**
 * El QR no lleva solo el id del ticket: lleva "<id>.<firma>".
 *
 * Por que importa:
 *  - Un id filtrado (logs, captura de pantalla, historial del navegador)
 *    no basta para fabricar un QR valido.
 *  - El escaner descarta un QR falsificado sin tocar la base de datos.
 *  - La URL publica de la imagen del QR no es adivinable por fuerza bruta.
 */

const SIGNATURE_LENGTH = 27; // 160 bits en base64url
const TOKEN_PATTERN = /^([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{20,64})$/;

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signTicketId(ticketId) {
  return base64url(
    crypto.createHmac("sha256", config.ticketSecret).update(`ticket:${ticketId}`).digest()
  ).slice(0, SIGNATURE_LENGTH);
}

/** Crea el texto que se codifica dentro del QR. */
function createTicketToken(ticketId) {
  return `${ticketId}.${signTicketId(ticketId)}`;
}

/** Devuelve el ticketId si la firma es valida, o null. No lanza nunca. */
function readTicketToken(token) {
  const match = TOKEN_PATTERN.exec(String(token || "").trim());
  if (!match) return null;

  const [, ticketId, signature] = match;
  return safeEqual(signature, signTicketId(ticketId)) ? ticketId : null;
}

/** Ids opacos y aleatorios; no revelan orden ni volumen de ventas. */
function createTicketId() {
  return base64url(crypto.randomBytes(18));
}

module.exports = { createTicketToken, readTicketToken, createTicketId };
