/**
 * Implementación simulada del SapAdapter sobre archivos en out/sap/.
 *
 * Numeración secuencial desde 4500000001 e idempotencia por solicitud_id,
 * según PRD HU-5.
 */

import fs from "node:fs";
import path from "node:path";
import type { SapAdapter, OrdenCompra } from "./adapter.ts";
import { rutaOut, leerMaestro } from "../repo.ts";

const NUMERO_INICIAL = 4500000001;

function archivoOrdenes(): string {
  const dir = rutaOut("sap");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "ordenes.jsonl");
}

function leerOrdenes(): Array<OrdenCompra & { numero_oc: string; fecha: string }> {
  const archivo = archivoOrdenes();
  if (!fs.existsSync(archivo)) return [];
  return fs
    .readFileSync(archivo, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

export class SapMock implements SapAdapter {
  async consultarProveedor(nit: string) {
    const proveedores = leerMaestro("proveedores");
    const p = proveedores.find((x: any) => normalizarNit(x.nit) === normalizarNit(nit));
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo === true } : null;
  }

  async buscarOrdenPorReferencia(solicitud_id: string) {
    const existente = leerOrdenes().find((o) => o.referencia?.solicitud_id === solicitud_id);
    return existente ? { numero_oc: existente.numero_oc } : null;
  }

  async crearOrden(orden: OrdenCompra) {
    // Idempotencia: la misma solicitud nunca genera dos OC.
    const previa = await this.buscarOrdenPorReferencia(orden.referencia.solicitud_id);
    if (previa) {
      const registro = leerOrdenes().find((o) => o.numero_oc === previa.numero_oc)!;
      return { numero_oc: registro.numero_oc, fecha: registro.fecha };
    }

    const ordenes = leerOrdenes();
    const numero_oc = String(NUMERO_INICIAL + ordenes.length);
    const fecha = new Date().toISOString();

    fs.appendFileSync(
      archivoOrdenes(),
      JSON.stringify({ numero_oc, fecha, ...orden }) + "\n",
      "utf-8"
    );

    return { numero_oc, fecha };
  }
}

export function normalizarNit(nit: string | null | undefined): string {
  return String(nit ?? "").replace(/\D/g, "").replace(/^0+/, "");
}
