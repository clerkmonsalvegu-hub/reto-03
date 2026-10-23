/**
 * Interfaz del adaptador SAP (obligatoria según PRD 7.4).
 *
 * El agente nunca conoce la implementación: depende solo de este contrato.
 * Cambiar de SAP simulado a SAP real no toca herramientas ni ciclo del agente.
 */

import { z } from "zod";

/* ---------------- Esquema del payload de la OC (PRD 7.4) ---------------- */

export const PosicionSchema = z.object({
  numero: z.number().int().positive(),
  descripcion: z.string().max(40), // límite SAP en texto breve
  cantidad: z.number().positive(),
  unidad: z.enum(["UN", "H", "MES"]),
  precio_unitario: z.number().nonnegative(),
  centro_costo: z.string(),
  subarea: z.string(),
  indicador_iva: z.string(),
});

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({
    codigo_sap: z.string(),
    nit: z.string(),
    nombre: z.string(),
  }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string(),
  }),
  posiciones: z.array(PosicionSchema).min(1),
  excepciones: z.array(
    z.object({
      codigo: z.string(),
      detalle: z.string(),
      confirmado_por: z.string().nullable(),
    })
  ),
});

export type OrdenCompra = z.infer<typeof OrdenCompraSchema>;

/* ---------------- Contrato del adaptador ---------------- */

export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>;
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>;
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>;
}
