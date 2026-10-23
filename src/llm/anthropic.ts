/**
 * Implementación del ProveedorLlm para Anthropic.
 *
 * La clave se lee de variable de entorno y nunca se expone al front,
 * al repositorio ni a los logs (PRD 8 · Seguridad).
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ProveedorLlm,
  MensajeLlm,
  DefinicionHerramienta,
  RespuestaLlm,
} from "./adapter.ts";

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 60000);
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS ?? 2048);

export class ProveedorAnthropic implements ProveedorLlm {
  nombre = "anthropic";
  modelo: string;
  private cliente: Anthropic;

  constructor(apiKey: string, modelo = process.env.LLM_MODELO ?? "claude-sonnet-5-5") {
    this.modelo = modelo;
    this.cliente = new Anthropic({ apiKey, timeout: TIMEOUT_MS });
  }

  async enviar(
    sistema: string,
    mensajes: MensajeLlm[],
    herramientas: DefinicionHerramienta[]
  ): Promise<RespuestaLlm> {
    const r = await this.cliente.messages.create({
      model: this.modelo,
      max_tokens: MAX_TOKENS,
      system: sistema,
      tools: herramientas as any,
      messages: mensajes as any,
    });

    const texto = r.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();

    const llamadas = r.content
      .filter((b: any) => b.type === "tool_use")
      .map((b: any) => ({
        id: b.id,
        nombre: b.name,
        argumentos: b.input as Record<string, unknown>,
      }));

    return {
      texto,
      llamadas,
      crudo: r.content,
      uso: { entrada: r.usage?.input_tokens ?? 0, salida: r.usage?.output_tokens ?? 0 },
    };
  }
}
