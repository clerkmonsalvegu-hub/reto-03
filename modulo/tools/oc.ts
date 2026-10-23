/**
 * Herramientas del agente, importables sin el servidor.
 *
 * Reexporta EXACTAMENTE las mismas implementaciones que usa la aplicación
 * (src/tools/oc.ts). No es una copia: es el mismo módulo, para que no existan
 * versiones divergentes entre el producto y el módulo reutilizable.
 */

export {
  leer_paquete,
  validar,
  construir_payload,
  generar_evidencia,
  crear,
  HERRAMIENTAS,
  type Ctx,
  type NombreHerramienta,
} from "../../src/tools/oc.ts";
