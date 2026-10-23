/**
 * demo.ts — Verificación de las herramientas SIN modelo de lenguaje (PRD 6.6)
 * ==================================================================
 * Procesa los 6 casos llamando directamente a las herramientas.
 * Demuestra además:
 *   - idempotencia: sol-001 se ejecuta dos veces
 *   - confirmación explícita: sol-004 primero sin confirmar, luego confirmado
 *
 * Corre sin clave de ningún proveedor:  npm run demo
 */

import { listarCasos } from "./src/repo.ts";
import { limpiarOut, rutaOut } from "./src/repo.ts";
import { HERRAMIENTAS } from "./src/tools/oc.ts";
import fs from "node:fs";

const V = "\x1b[32m", R = "\x1b[31m", A = "\x1b[33m", C = "\x1b[36m", G = "\x1b[90m", X = "\x1b[0m";
const ctx = { directory: ".", sessionId: "demo" };

function parse(s: string) {
  return JSON.parse(s);
}

async function procesar(caso: string, confirmado = false, etiqueta = "") {
  const titulo = `${caso}${etiqueta ? ` ${G}(${etiqueta})${X}` : ""}`;
  console.log(`\n${C}┌─ ${titulo}${X}`);

  const paq = parse(await HERRAMIENTAS.oc_leer_paquete.execute({ caso }, ctx));
  if (!paq.ok) {
    console.log(`${R}│  ✗ ${paq.error}${X}`);
    return;
  }
  if (paq.data.faltantes.length) {
    console.log(`${G}│  adjuntos ausentes: ${paq.data.faltantes.join(", ")}${X}`);
  }

  const val = parse(await HERRAMIENTAS.oc_validar.execute({ caso, paquete: paq.data }, ctx));
  if (!val.ok) {
    console.log(`${R}│  ✗ ${val.error}${X}`);
    return;
  }
  const v = val.data;

  console.log(
    `│  apta: ${v.apta ? `${V}sí${X}` : `${R}no${X}`}   retroactiva: ${
      v.retroactiva ? `${A}sí${X}` : "no"
    }`
  );

  for (const b of v.bloqueos) console.log(`${R}│  ✗ [${b.codigo}] ${b.detalle}${X}`);
  for (const c of v.confirmaciones) console.log(`${A}│  ! [${c.codigo}] ${c.detalle}${X}`);
  for (const [k, d] of Object.entries(v.derivados as Record<string, any>)) {
    console.log(`${G}│  → derivado ${k} = ${d.valor}  (${d.origen})${X}`);
  }

  const cre = parse(await HERRAMIENTAS.oc_crear.execute({ caso, confirmado }, ctx));
  if (!cre.ok) {
    console.log(`${R}│  ✗ ${cre.error}${X}`);
    return;
  }

  if (cre.data.creada) {
    const marca = cre.data.idempotente ? `${A}IDEMPOTENTE${X}` : `${V}CREADA${X}`;
    console.log(`│  ${marca}  OC ${V}${cre.data.numero_oc}${X}  evidencia: ${G}${cre.data.evidencia}${X}`);
  } else if (cre.data.motivo === "bloqueada") {
    console.log(`${R}│  OC NO CREADA — bloqueos de control${X}`);
  } else {
    console.log(`${A}│  OC PENDIENTE — requiere confirmación explícita del usuario${X}`);
  }
  console.log(`${C}└${"─".repeat(60)}${X}`);
}

/* ------------------------------------------------------------------ */

limpiarOut(); // determinismo: out/ se limpia al inicio

console.log(`\n${C}${"═".repeat(64)}`);
console.log(`  VERIFICACIÓN DE HERRAMIENTAS — sin modelo de lenguaje`);
console.log(`${"═".repeat(64)}${X}`);

for (const caso of listarCasos()) {
  await procesar(caso);
}

console.log(`\n${C}${"═".repeat(64)}`);
console.log(`  PRUEBAS ESPECÍFICAS`);
console.log(`${"═".repeat(64)}${X}`);

// Idempotencia: sol-001 por segunda vez no debe crear una OC nueva
await procesar("sol-001", false, "segunda ejecución: idempotencia");

// Confirmación explícita: sol-004 tenía confirmación pendiente
await procesar("sol-004", true, "con confirmación del usuario");

/* ------------------------------------------------------------------ */

const control = rutaOut("control.csv");
if (fs.existsSync(control)) {
  console.log(`\n${C}${"═".repeat(64)}`);
  console.log(`  LOG DE CONTROL — out/control.csv`);
  console.log(`${"═".repeat(64)}${X}`);
  console.log(fs.readFileSync(control, "utf-8"));
}

const ordenes = rutaOut("sap", "ordenes.jsonl");
if (fs.existsSync(ordenes)) {
  const n = fs.readFileSync(ordenes, "utf-8").split("\n").filter((l) => l.trim()).length;
  console.log(`${G}Órdenes en el SAP simulado: ${n}  (out/sap/ordenes.jsonl)${X}\n`);
}
