#!/usr/bin/env node
"use strict";

/**
 * Genera los secretos que necesita el servidor, sin escribirlos nunca en disco
 * ni en el repositorio. Copia la salida al panel de variables de entorno de tu
 * proveedor (Render, Vercel, Railway...).
 *
 *   node scripts/generar-credenciales.js secreto
 *   node scripts/generar-credenciales.js hash "MI CONTRASENA"
 *   node scripts/generar-credenciales.js staff admin@midominio.com "MI CONTRASENA" admin "Nombre"
 */

const crypto = require("crypto");

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

const [, , comando, ...argumentos] = process.argv;

switch (comando) {
  case "secreto": {
    console.log("TICKET_SIGNING_SECRET=" + crypto.randomBytes(48).toString("hex"));
    break;
  }

  case "hash": {
    const password = argumentos[0];
    if (!password) {
      console.error('Uso: node scripts/generar-credenciales.js hash "MI CONTRASENA"');
      process.exit(1);
    }
    console.log(hashPassword(password));
    break;
  }

  case "staff": {
    const [username, password, role = "staff", name = ""] = argumentos;
    if (!username || !password) {
      console.error('Uso: node scripts/generar-credenciales.js staff correo@dominio.com "MI CONTRASENA" admin "Nombre"');
      process.exit(1);
    }

    const usuario = {
      username: username.toLowerCase(),
      passwordHash: hashPassword(password),
      role: role === "admin" ? "admin" : "staff",
      name: name || username
    };

    console.log("STAFF_USERS=" + JSON.stringify([usuario]));
    console.log("\nPara varios usuarios, junta los objetos dentro del mismo array JSON.");
    break;
  }

  default: {
    console.log(`Comandos disponibles:

  secreto                                  Genera TICKET_SIGNING_SECRET
  hash "CONTRASENA"                        Genera el hash scrypt de una contrasena
  staff correo "CONTRASENA" rol "Nombre"   Genera la variable STAFF_USERS completa

Nada de lo que imprime este script debe acabar en un commit.`);
  }
}
