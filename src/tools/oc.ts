/**
 * HERRAMIENTAS DEL AGENTE — Órdenes de Compra
 * ==================================================================
 * Contrato (PRD 6.2): cada herramienta es un objeto con
 *   { description, args (zod), execute(args, ctx) -> string }
 * El nombre que ve el modelo es `oc_<export>`.
 *
 * Principio de diseño: las herramientas son la ÚNICA fuente de valores
 * que el agente puede afirmar (CA2). Son funciones puras y deterministas,
 * importables desde demo.ts sin levantar el servidor ni usar el modelo.
 *
 * Nunca lanzan: todo error se devuelve como { ok: false, error }.
 */

import { z } from "zod";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  leerMaestro,
  leerJsonCaso,
  leerArchivoCaso,
  escribirOut,
  agregarLinea,
  rutaOut,
} from "../repo.ts";
import { SapMock, normalizarNit } from "../sap/mock.ts";
import { OrdenCompraSchema, type OrdenCompra } from "../sap/adapter.ts";

const sap = new SapMock();

export interface Ctx {
  directory: string;
  sessionId: string;
}

const CTX_DEFECTO: Ctx = { directory: ".", sessionId: "demo" };

/* ================================================================
 * Utilidades de parsing
 * ================================================================ */

/** "COP 11.400.000" | "11.400.000" -> 11400000 */
function aNumero(texto: string | null | undefined): number | null {
  if (!texto) return null;
  const limpio = texto.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(/,/g, ".");
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

function normalizarNombre(s: string | null | undefined): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

function soloFecha(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = String(iso).match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

/** Extrae los campos de cotizacion.txt según el formato de los fixtures. */
function parsearCotizacion(texto: string | null) {
  if (!texto) return null;

  const ref = texto.match(/COTIZACI[ÓO]N\s+([A-Z0-9-]+)/i)?.[1] ?? null;
  const proveedor = texto.match(/Proveedor:\s*(.+)/i)?.[1]?.trim() ?? "";
  const nitCrudo = texto.match(/NIT:\s*([\d.\-]+)/i)?.[1] ?? null;
  const totalCrudo = texto.match(/TOTAL[^:\n]*:\s*([A-Z]{3})?\s*([\d.,]+)/i);
  const moneda = totalCrudo?.[1] ?? "COP";
  const total = aNumero(totalCrudo?.[2]);
  const fecha = soloFecha(texto.match(/Fecha:\s*([\d-]+)/i)?.[1]);
  const diasValidez = Number(texto.match(/Validez[^:]*:\s*(\d+)/i)?.[1] ?? 0);

  let validez_hasta: string | null = null;
  if (fecha && diasValidez) {
    const d = new Date(fecha);
    d.setDate(d.getDate() + diasValidez);
    validez_hasta = d.toISOString().slice(0, 10);
  }

  return {
    referencia: ref,
    proveedor,
    nit: nitCrudo ? normalizarNit(nitCrudo).slice(0, 9) : null,
    total,
    moneda,
    validez_hasta,
    texto,
  };
}

/** Extrae los campos de factura.txt. */
function parsearFactura(texto: string | null) {
  if (!texto) return null;
  const numero = texto.match(/No\.\s*([A-Z0-9-]+)/i)?.[1] ?? "";
  const fecha = soloFecha(texto.match(/Fecha de emisi[óo]n:\s*([\d-]+)/i)?.[1]);
  const total = aNumero(texto.match(/TOTAL:\s*([A-Z]{3})?\s*([\d.,]+)/i)?.[2]);
  return { numero, fecha: fecha ?? "", total: total ?? 0, texto };
}

function sha256(texto: string): string {
  return crypto.createHash("sha256").update(texto, "utf-8").digest("hex");
}

function ok(data: unknown): string {
  return JSON.stringify({ ok: true, data });
}
function fallo(error: string): string {
  return JSON.stringify({ ok: false, error });
}

/** Registra toda llamada a herramienta en out/log.jsonl (CA4). */
function registrarLog(herramienta: string, args: unknown, resultado: string, ctx: Ctx) {
  try {
    agregarLinea(
      "log.jsonl",
      JSON.stringify({
        ts: new Date().toISOString(),
        sessionId: ctx.sessionId,
        herramienta,
        args,
        resultado: resultado.slice(0, 2000),
      })
    );
  } catch {
    /* el log nunca debe tumbar la ejecución */
  }
}

/* ================================================================
 * HU-1 · oc_leer_paquete
 * ================================================================ */

export const leer_paquete = {
  description:
    "Lee y normaliza el paquete completo de una solicitud de compra: correo, solicitud, cotización, aprobación y factura si existe.",
  args: {
    caso: z
      .string()
      .describe("Nombre de la carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo sol-001"),
  },
  async execute(args: { caso: string }, ctx: Ctx = CTX_DEFECTO): Promise<string> {
    try {
      const correo = leerJsonCaso(args.caso, "correo.json");
      const solicitud = leerJsonCaso(args.caso, "solicitud.json");

      if (!solicitud) {
        const r = fallo(
          `No se encontró solicitud.json para el caso "${args.caso}". Pedir al solicitante el Excel de solicitud.`
        );
        registrarLog("oc_leer_paquete", args, r, ctx);
        return r;
      }

      const cotizacion = parsearCotizacion(leerArchivoCaso(args.caso, "cotizacion.txt"));
      const aprobacionCruda = leerJsonCaso(args.caso, "aprobacion.json");
      const factura = parsearFactura(leerArchivoCaso(args.caso, "factura.txt"));

      const aprobacion = aprobacionCruda
        ? {
            de: aprobacionCruda.de ?? "",
            para: aprobacionCruda.para ?? "",
            fecha: aprobacionCruda.fecha ?? "",
            asunto: aprobacionCruda.asunto ?? "",
            aprobado: /\baprobad[oa]\b/i.test(String(aprobacionCruda.cuerpo ?? "")),
            texto: String(aprobacionCruda.cuerpo ?? ""),
          }
        : null;

      const faltantes: string[] = [];
      if (!correo) faltantes.push("correo.json");
      if (!cotizacion) faltantes.push("cotizacion.txt");
      if (!aprobacion) faltantes.push("aprobacion.json");

      const paquete = {
        caso: args.caso,
        correo: correo
          ? { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha }
          : null,
        solicitud,
        cotizacion,
        aprobacion,
        factura,
        faltantes,
      };

      const r = ok(paquete);
      registrarLog("oc_leer_paquete", args, r, ctx);
      return r;
    } catch (e: any) {
      const r = fallo(`Error leyendo el paquete: ${e.message}`);
      registrarLog("oc_leer_paquete", args, r, ctx);
      return r;
    }
  },
};

/* ================================================================
 * HU-2 · oc_validar — Reglas RC1 a RC10
 * ================================================================ */

interface Hallazgo {
  codigo: string;
  detalle: string;
}

export const validar = {
  description:
    "Aplica las 10 reglas de control (RC1-RC10) sobre el paquete y devuelve si la solicitud es apta, los bloqueos, las confirmaciones requeridas, los valores derivados de maestros y si es retroactiva.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    paquete: z
      .any()
      .optional()
      .describe("Paquete normalizado devuelto por oc_leer_paquete. Si se omite, se vuelve a leer."),
  },
  async execute(args: { caso: string; paquete?: any }, ctx: Ctx = CTX_DEFECTO): Promise<string> {
    try {
      let paquete = args.paquete;
      if (!paquete || !paquete.solicitud) {
        const crudo = JSON.parse(await leer_paquete.execute({ caso: args.caso }, ctx));
        if (!crudo.ok) return crudo.ok === false ? JSON.stringify(crudo) : fallo("Paquete inválido");
        paquete = crudo.data;
      }

      const sol = paquete.solicitud;
      const cot = paquete.cotizacion;
      const apr = paquete.aprobacion;
      const fac = paquete.factura;

      const bloqueos: Hallazgo[] = [];
      const confirmaciones: Hallazgo[] = [];
      const derivados: Record<string, { valor: string; origen: string }> = {};
      let retroactiva = false;

      const proveedores = leerMaestro("proveedores");
      const centros = leerMaestro("centros-costo");
      const ivas = leerMaestro("indicadores-iva");
      const condiciones = leerMaestro("condiciones-pago");

      /* ---------- RC1 · Proveedor existe y está activo ---------- */
      let proveedor: any = null;
      if (sol.proveedor_nit) {
        proveedor = proveedores.find(
          (p: any) => normalizarNit(p.nit) === normalizarNit(sol.proveedor_nit)
        );
      }
      if (!proveedor && sol.proveedor_nombre) {
        proveedor = proveedores.find(
          (p: any) => normalizarNombre(p.nombre) === normalizarNombre(sol.proveedor_nombre)
        );
      }

      if (!proveedor) {
        bloqueos.push({
          codigo: "RC1",
          detalle: `El proveedor "${sol.proveedor_nombre}"${
            sol.proveedor_nit ? ` (NIT ${sol.proveedor_nit})` : ""
          } no existe en el maestro. Acción sugerida: solicitar creación del proveedor en SAP antes de emitir la OC.`,
        });
      } else if (proveedor.activo !== true) {
        bloqueos.push({
          codigo: "RC1",
          detalle: `El proveedor "${proveedor.nombre}" existe pero está inactivo en el maestro. Acción sugerida: solicitar reactivación a maestros de datos.`,
        });
      }

      /* ---------- RC4 · Subárea pertenece al centro de costo ---------- */
      const centro = centros.find((c: any) => c.centro_costo === sol.centro_costo);
      if (!centro) {
        bloqueos.push({
          codigo: "RC4",
          detalle: `El centro de costo "${sol.centro_costo}" no existe en el maestro.`,
        });
      } else if (!centro.subareas.includes(sol.subarea)) {
        bloqueos.push({
          codigo: "RC4",
          detalle: `La subárea "${sol.subarea}" no pertenece al centro "${
            sol.centro_costo
          }". Subáreas válidas: ${centro.subareas.join(", ")}.`,
        });
      }

      /* ---------- RC2 · Aprobación válida y de un aprobador autorizado ---------- */
      let aprobador: any = null;
      if (!apr) {
        bloqueos.push({
          codigo: "RC2",
          detalle: "No hay correo de aprobación en el paquete. Acción sugerida: solicitarlo al líder.",
        });
      } else if (!apr.aprobado) {
        bloqueos.push({
          codigo: "RC2",
          detalle: `El correo de ${apr.de} no contiene una aprobación explícita.`,
        });
      } else if (centro) {
        aprobador = centro.aprobadores.find(
          (a: any) => a.email.toLowerCase() === String(apr.de).toLowerCase()
        );
        if (!aprobador) {
          const validos = centro.aprobadores.map((a: any) => a.email).join(", ");
          bloqueos.push({
            codigo: "RC2",
            detalle: `${apr.de} no está autorizado para aprobar en el centro ${sol.centro_costo}. Aprobadores válidos: ${validos}. Acción sugerida: reenviar la solicitud al aprobador correcto.`,
          });
        }
      }

      /* ---------- RC3 · Monto dentro del tope del aprobador ---------- */
      if (aprobador && Number(sol.valor_total) > Number(aprobador.tope)) {
        bloqueos.push({
          codigo: "RC3",
          detalle: `El valor total ${fmt(sol.valor_total)} supera el tope de ${fmt(
            aprobador.tope
          )} de ${aprobador.email}. Acción sugerida: escalar a un aprobador con tope superior.`,
        });
      }

      /* ---------- RC10 · Aritmética de la solicitud ---------- */
      const calculado = Number(sol.cantidad) * Number(sol.valor_unitario);
      if (!Number.isFinite(calculado)) {
        bloqueos.push({ codigo: "RC10", detalle: "Cantidad o valor unitario no son numéricos." });
      } else if (Math.abs(calculado - Number(sol.valor_total)) > 1) {
        bloqueos.push({
          codigo: "RC10",
          detalle: `Inconsistencia aritmética: ${sol.cantidad} × ${fmt(
            sol.valor_unitario
          )} = ${fmt(calculado)}, pero la solicitud declara ${fmt(sol.valor_total)}.`,
        });
      }

      /* ---------- RC5 · Cotización vs solicitud (tolerancia 2%) ---------- */
      if (!cot) {
        confirmaciones.push({
          codigo: "RC5",
          detalle:
            "La solicitud no trae cotización del proveedor. Sin cotización no hay respaldo del precio: se requiere confirmación para continuar.",
        });
      } else if (cot.total !== null && Number(sol.valor_total) > 0) {
        const desviacion = Math.abs(cot.total - Number(sol.valor_total)) / Number(sol.valor_total);
        if (desviacion > 0.02) {
          confirmaciones.push({
            codigo: "RC5",
            detalle: `La cotización (${fmt(cot.total)}) difiere de la solicitud (${fmt(
              sol.valor_total
            )}) en ${(desviacion * 100).toFixed(1)}%, por encima del 2% tolerado. Diferencia: ${fmt(
              cot.total - Number(sol.valor_total)
            )}. Confirmar con qué valor se crea la OC.`,
          });
        }
      }

      /* ---------- RC6 · Indicador de IVA ausente ---------- */
      let indicador_iva = sol.indicador_iva;
      if (!indicador_iva) {
        indicador_iva = proveedor?.indicador_iva_default ?? null;
        if (indicador_iva) {
          const desc = ivas.find((i: any) => i.codigo === indicador_iva)?.descripcion ?? "";
          derivados.indicador_iva = {
            valor: indicador_iva,
            origen: `maestro.proveedores (indicador_iva_default de ${proveedor?.nombre})`,
          };
          confirmaciones.push({
            codigo: "RC6",
            detalle: `La solicitud no informa indicador de IVA. Se derivó "${indicador_iva}" (${desc}) del maestro del proveedor. Confirmar que aplica.`,
          });
        } else {
          bloqueos.push({
            codigo: "RC6",
            detalle: "No hay indicador de IVA en la solicitud ni valor por defecto del proveedor.",
          });
        }
      }

      /* ---------- RC7 · Condiciones de pago ausentes (solo informa) ---------- */
      let condiciones_pago = sol.condiciones_pago;
      if (!condiciones_pago) {
        condiciones_pago = proveedor?.condiciones_pago_default ?? null;
        if (condiciones_pago) {
          const desc =
            condiciones.find((c: any) => c.codigo === condiciones_pago)?.descripcion ?? "";
          derivados.condiciones_pago = {
            valor: condiciones_pago,
            origen: `maestro.proveedores (condiciones_pago_default de ${proveedor?.nombre})`,
          };
        }
      }

      /* ---------- RC8 · Compra retroactiva ---------- */
      if (fac && fac.fecha && sol.fecha_solicitud && fac.fecha < sol.fecha_solicitud) {
        retroactiva = true;
        confirmaciones.push({
          codigo: "RC8",
          detalle: `Compra retroactiva: la factura ${fac.numero} es del ${fac.fecha}, anterior a la solicitud del ${sol.fecha_solicitud}. La OC legalizaría un gasto ya ejecutado. Confirmar para continuar; quedará marcada en el log de control.`,
        });
      }

      /* ---------- RC9 · Fecha de aprobación ---------- */
      const fAprob = soloFecha(apr?.fecha);
      if (fAprob && sol.fecha_solicitud && fAprob < sol.fecha_solicitud) {
        confirmaciones.push({
          codigo: "RC9",
          detalle: `La aprobación (${fAprob}) es anterior a la solicitud (${sol.fecha_solicitud}). Confirmar que corresponde a esta compra.`,
        });
      }

      const resultado = {
        caso: args.caso,
        apta: bloqueos.length === 0,
        bloqueos,
        confirmaciones,
        derivados,
        retroactiva,
        proveedor_resuelto: proveedor
          ? { codigo_sap: proveedor.codigo_sap, nit: proveedor.nit, nombre: proveedor.nombre }
          : null,
        aprobador_resuelto: aprobador
          ? { email: aprobador.email, tope: aprobador.tope }
          : null,
        valores_efectivos: { indicador_iva, condiciones_pago },
      };

      const r = ok(resultado);
      registrarLog("oc_validar", { caso: args.caso }, r, ctx);
      return r;
    } catch (e: any) {
      const r = fallo(`Error validando: ${e.message}`);
      registrarLog("oc_validar", args, r, ctx);
      return r;
    }
  },
};

function fmt(n: number): string {
  return "COP " + new Intl.NumberFormat("es-CO").format(Math.round(Number(n)));
}

/* ================================================================
 * HU-3 · oc_construir_payload
 * ================================================================ */

export const construir_payload = {
  description:
    "Construye el payload de la orden de compra listo para SAP, validado con zod, y guarda la trazabilidad de cada valor a su fuente.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    paquete: z.any().optional().describe("Paquete normalizado de oc_leer_paquete"),
    derivados: z.any().optional().describe("Valores derivados devueltos por oc_validar"),
  },
  async execute(
    args: { caso: string; paquete?: any; derivados?: any },
    ctx: Ctx = CTX_DEFECTO
  ): Promise<string> {
    try {
      const crudoV = JSON.parse(await validar.execute({ caso: args.caso, paquete: args.paquete }, ctx));
      if (!crudoV.ok) return JSON.stringify(crudoV);
      const v = crudoV.data;

      const crudoP = JSON.parse(await leer_paquete.execute({ caso: args.caso }, ctx));
      if (!crudoP.ok) return JSON.stringify(crudoP);
      const paquete = crudoP.data;

      const sol = paquete.solicitud;
      const apr = paquete.aprobacion;

      if (!v.proveedor_resuelto) {
        return fallo("No se puede construir el payload: el proveedor no está resuelto en el maestro.");
      }

      // Evidencia de aprobación (necesaria para el sha256 del payload)
      const crudoE = JSON.parse(await generar_evidencia.execute({ caso: args.caso }, ctx));
      const evidencia_sha256 = crudoE.ok ? crudoE.data.sha256 : "";

      const unidad: "UN" | "H" | "MES" = /\bhora/i.test(sol.descripcion ?? "") ? "H" : "UN";

      const payload: OrdenCompra = {
        referencia: {
          solicitud_id: sol.solicitud_id,
          correo_id: paquete.correo?.id ?? "",
          cotizacion_ref: paquete.cotizacion?.referencia ?? null,
        },
        sociedad: "1000",
        organizacion_compras: "1000",
        proveedor: {
          codigo_sap: v.proveedor_resuelto.codigo_sap,
          nit: v.proveedor_resuelto.nit,
          nombre: v.proveedor_resuelto.nombre,
        },
        moneda: (sol.moneda === "USD" ? "USD" : "COP") as "COP" | "USD",
        condiciones_pago: v.valores_efectivos.condiciones_pago ?? "Z030",
        aprobador: {
          email: apr?.de ?? "",
          fecha_aprobacion: apr?.fecha ?? "",
          evidencia_sha256,
        },
        posiciones: [
          {
            numero: 10,
            descripcion: String(sol.descripcion ?? "").slice(0, 40), // límite SAP
            cantidad: Number(sol.cantidad),
            unidad,
            precio_unitario: Number(sol.valor_unitario),
            centro_costo: sol.centro_costo,
            subarea: sol.subarea,
            indicador_iva: v.valores_efectivos.indicador_iva ?? "C1",
          },
        ],
        excepciones: [
          ...v.bloqueos.map((b: Hallazgo) => ({
            codigo: b.codigo,
            detalle: b.detalle,
            confirmado_por: null,
          })),
          ...v.confirmaciones.map((c: Hallazgo) => ({
            codigo: c.codigo,
            detalle: c.detalle,
            confirmado_por: null,
          })),
        ],
      };

      const validacion = OrdenCompraSchema.safeParse(payload);
      if (!validacion.success) {
        return fallo(`El payload no cumple el esquema SAP: ${validacion.error.issues[0]?.message}`);
      }

      /* Trazabilidad: cada valor del payload a su fuente (HU-3) */
      const trazabilidad = {
        "referencia.solicitud_id": "solicitud",
        "referencia.correo_id": "correo",
        "referencia.cotizacion_ref": paquete.cotizacion ? "cotizacion" : "derivado (ausente)",
        "proveedor.codigo_sap": "maestro.proveedores",
        "proveedor.nit": "maestro.proveedores",
        "proveedor.nombre": "maestro.proveedores",
        moneda: "solicitud",
        condiciones_pago: v.derivados.condiciones_pago
          ? v.derivados.condiciones_pago.origen
          : "solicitud",
        "aprobador.email": "aprobacion",
        "aprobador.fecha_aprobacion": "aprobacion",
        "aprobador.evidencia_sha256": "derivado (sha256 de out/<caso>/aprobacion.txt)",
        "posiciones[0].descripcion": "solicitud (truncada a 40 caracteres, límite SAP)",
        "posiciones[0].cantidad": "solicitud",
        "posiciones[0].precio_unitario": "solicitud",
        "posiciones[0].centro_costo": "solicitud (validado contra maestro.centros-costo)",
        "posiciones[0].subarea": "solicitud (validada contra maestro.centros-costo)",
        "posiciones[0].indicador_iva": v.derivados.indicador_iva
          ? v.derivados.indicador_iva.origen
          : "solicitud",
      };

      const rutaTraza = escribirOut(
        `${args.caso}/trazabilidad.json`,
        JSON.stringify({ caso: args.caso, generado: new Date().toISOString(), trazabilidad }, null, 2)
      );

      const r = ok({ payload, trazabilidad_ruta: rutaTraza, apta: v.apta });
      registrarLog("oc_construir_payload", { caso: args.caso }, r, ctx);
      return r;
    } catch (e: any) {
      const r = fallo(`Error construyendo el payload: ${e.message}`);
      registrarLog("oc_construir_payload", args, r, ctx);
      return r;
    }
  },
};

/* ================================================================
 * HU-4 · oc_generar_evidencia
 * ================================================================ */

export const generar_evidencia = {
  description:
    "Genera el archivo de evidencia de la aprobación (encabezados, cuerpo y sha256) que se adjunta a la orden de compra para auditoría.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
  },
  async execute(args: { caso: string }, ctx: Ctx = CTX_DEFECTO): Promise<string> {
    try {
      const apr = leerJsonCaso(args.caso, "aprobacion.json");
      if (!apr) return fallo(`No hay aprobacion.json para el caso "${args.caso}".`);

      const contenido = [
        "EVIDENCIA DE APROBACIÓN",
        "=".repeat(60),
        `De:      ${apr.de ?? ""}`,
        `Para:    ${apr.para ?? ""}`,
        `CC:      ${(apr.cc ?? []).join(", ")}`,
        `Fecha:   ${apr.fecha ?? ""}`,
        `Asunto:  ${apr.asunto ?? ""}`,
        "=".repeat(60),
        "",
        String(apr.cuerpo ?? ""),
      ].join("\n");

      const hash = sha256(contenido);
      const ruta = escribirOut(
        `${args.caso}/aprobacion.txt`,
        contenido + `\n\n${"=".repeat(60)}\nsha256: ${hash}\n`
      );

      const r = ok({ ruta, sha256: hash });
      registrarLog("oc_generar_evidencia", args, r, ctx);
      return r;
    } catch (e: any) {
      const r = fallo(`Error generando evidencia: ${e.message}`);
      registrarLog("oc_generar_evidencia", args, r, ctx);
      return r;
    }
  },
};

/* ================================================================
 * HU-5 · oc_crear
 * ================================================================ */

export const crear = {
  description:
    "Crea la orden de compra en SAP. Solo procede si la validación es apta y, cuando hay confirmaciones pendientes, si el usuario confirmó explícitamente. Es idempotente por solicitud_id.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    confirmado: z
      .boolean()
      .optional()
      .describe("true solo si el usuario confirmó explícitamente las excepciones señaladas"),
  },
  async execute(args: { caso: string; confirmado?: boolean }, ctx: Ctx = CTX_DEFECTO): Promise<string> {
    try {
      const crudoV = JSON.parse(await validar.execute({ caso: args.caso }, ctx));
      if (!crudoV.ok) return JSON.stringify(crudoV);
      const v = crudoV.data;

      /* Bloqueos: no se crea bajo ninguna circunstancia */
      if (!v.apta) {
        registrarControl(args.caso, "BLOQUEADA", "", v.retroactiva, v.bloqueos, v.confirmaciones);
        const r = ok({
          creada: false,
          motivo: "bloqueada",
          bloqueos: v.bloqueos,
          mensaje: "La solicitud tiene bloqueos de control. No se crea la OC.",
        });
        registrarLog("oc_crear", args, r, ctx);
        return r;
      }

      /* Confirmaciones pendientes */
      if (v.confirmaciones.length > 0 && args.confirmado !== true) {
        registrarControl(args.caso, "PENDIENTE", "", v.retroactiva, v.bloqueos, v.confirmaciones);
        const r = ok({
          creada: false,
          motivo: "requiere_confirmacion",
          confirmaciones: v.confirmaciones,
          mensaje:
            "La solicitud es apta pero tiene excepciones que requieren confirmación explícita del usuario antes de crear la OC.",
        });
        registrarLog("oc_crear", args, r, ctx);
        return r;
      }

      /* Construcción y creación */
      const crudoP = JSON.parse(await construir_payload.execute({ caso: args.caso }, ctx));
      if (!crudoP.ok) return JSON.stringify(crudoP);

      const payload: OrdenCompra = crudoP.data.payload;

      // Marca quién confirmó las excepciones
      if (args.confirmado === true) {
        payload.excepciones = payload.excepciones.map((e) => ({
          ...e,
          confirmado_por: "analista (chat)",
        }));
      }

      const previa = await sap.buscarOrdenPorReferencia(payload.referencia.solicitud_id);
      const { numero_oc, fecha } = await sap.crearOrden(payload);
      const idempotente = Boolean(previa);

      registrarControl(
        args.caso,
        idempotente ? "IDEMPOTENTE" : "CREADA",
        numero_oc,
        v.retroactiva,
        v.bloqueos,
        v.confirmaciones
      );

      const r = ok({
        creada: true,
        numero_oc,
        fecha,
        idempotente,
        retroactiva: v.retroactiva,
        evidencia: `out/${args.caso}/aprobacion.txt`,
        trazabilidad: crudoP.data.trazabilidad_ruta,
        mensaje: idempotente
          ? `La solicitud ${payload.referencia.solicitud_id} ya tenía la OC ${numero_oc}. No se creó una segunda.`
          : `Orden de compra ${numero_oc} creada en SAP.`,
      });
      registrarLog("oc_crear", args, r, ctx);
      return r;
    } catch (e: any) {
      const r = fallo(`Error creando la OC: ${e.message}`);
      registrarLog("oc_crear", args, r, ctx);
      return r;
    }
  },
};

/** Cada intento queda registrado en out/control.csv (HU-5). */
function registrarControl(
  solicitud_id: string,
  resultado: string,
  numero_oc: string,
  retroactiva: boolean,
  bloqueos: Hallazgo[],
  confirmaciones: Hallazgo[]
) {
  const archivo = rutaOut("control.csv");
  const existe = fs.existsSync(archivo);
  fs.mkdirSync(path.dirname(archivo), { recursive: true });

  if (!existe) {
    fs.writeFileSync(
      archivo,
      "solicitud_id,resultado,numero_oc,retroactiva,bloqueos,confirmaciones,ts\n",
      "utf-8"
    );
  }

  const fila = [
    solicitud_id,
    resultado,
    numero_oc,
    String(retroactiva),
    `"${bloqueos.map((b) => b.codigo).join(" ")}"`,
    `"${confirmaciones.map((c) => c.codigo).join(" ")}"`,
    new Date().toISOString(),
  ].join(",");

  fs.appendFileSync(archivo, fila + "\n", "utf-8");
}

/* ================================================================
 * Registro de herramientas (nombre expuesto = oc_<export>)
 * ================================================================ */

export const HERRAMIENTAS = {
  oc_leer_paquete: leer_paquete,
  oc_validar: validar,
  oc_construir_payload: construir_payload,
  oc_generar_evidencia: generar_evidencia,
  oc_crear: crear,
} as const;

export type NombreHerramienta = keyof typeof HERRAMIENTAS;
