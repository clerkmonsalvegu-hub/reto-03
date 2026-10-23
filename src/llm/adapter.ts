/**
 * Interfaz del proveedor de modelo (PRD 6.1).
 *
 * El ciclo del agente depende solo de este contrato. Cambiar de Anthropic
 * a OpenAI, Google o un modelo local no toca src/server.ts ni las herramientas.
 */

export interface MensajeLlm {
  role: "user" | "assistant";
  content: any;
}

export interface DefinicionHerramienta {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlamadaHerramienta {
  id: string;
  nombre: string;
  argumentos: Record<string, unknown>;
}

export interface RespuestaLlm {
  texto: string;
  llamadas: LlamadaHerramienta[];
  /** Mensaje del asistente en el formato nativo, para reinyectar en el historial. */
  crudo: any;
  uso?: { entrada: number; salida: number };
}

export interface ProveedorLlm {
  nombre: string;
  modelo: string;
  enviar(
    sistema: string,
    mensajes: MensajeLlm[],
    herramientas: DefinicionHerramienta[]
  ): Promise<RespuestaLlm>;
}
