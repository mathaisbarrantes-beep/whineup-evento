"use strict";

process.env.NODE_ENV = "test";
process.env.TICKET_SIGNING_SECRET = process.env.TICKET_SIGNING_SECRET ||
  "secreto-solo-para-pruebas-con-longitud-suficiente-1234567890";

const test = require("node:test");
const assert = require("node:assert");

const { createTicketToken, readTicketToken, createTicketId } = require("../lib/tokens");
const { escapeHtml } = require("../lib/security");

test("un token recien creado se verifica y devuelve su id", () => {
  const id = createTicketId();
  const token = createTicketToken(id);

  assert.strictEqual(readTicketToken(token), id);
});

test("un id sin firma no es un token valido", () => {
  const id = createTicketId();

  assert.strictEqual(readTicketToken(id), null);
});

test("una firma manipulada se rechaza", () => {
  const token = createTicketToken(createTicketId());
  const [id, firma] = token.split(".");
  const alterada = firma.slice(0, -1) + (firma.endsWith("A") ? "B" : "A");

  assert.strictEqual(readTicketToken(`${id}.${alterada}`), null);
});

test("la firma de un ticket no sirve para otro", () => {
  const primero = createTicketToken(createTicketId());
  const segundo = createTicketToken(createTicketId());
  const mezclado = `${primero.split(".")[0]}.${segundo.split(".")[1]}`;

  assert.strictEqual(readTicketToken(mezclado), null);
});

test("entradas basura no rompen la verificacion", () => {
  [null, undefined, "", "..", "a.b", { toString: () => "x.y" }, "../../etc/passwd"].forEach((valor) => {
    assert.strictEqual(readTicketToken(valor), null);
  });
});

test("los ids generados no se repiten", () => {
  const ids = new Set();
  for (let i = 0; i < 5000; i += 1) ids.add(createTicketId());

  assert.strictEqual(ids.size, 5000);
});

test("escapeHtml neutraliza etiquetas", () => {
  const peligroso = '<img src=x onerror="alert(1)">';

  assert.ok(!escapeHtml(peligroso).includes("<"));
  assert.ok(!escapeHtml(peligroso).includes(">"));
});
