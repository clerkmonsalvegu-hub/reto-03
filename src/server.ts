/**
 * SERVIDOR Y CICLO DEL AGENTE
 * ==================================================================
 * Implementa las reglas CA1–CA5 del PRD:
 *   CA1 tope de iteraciones por turno
 *   CA2 el modelo solo afirma lo que sale de herramientas (lo impone el prompt)
 *   CA3 confirmación humana: el turno termina con pregunta y solo procede
 *       si el siguiente mensaje del usuario confirma
 *   CA4 toda llamada queda en el historial visible y en out/log.jsonl
 *   CA5 los errores se muestran en lenguaje claro y la sesión no muere
 */

import express from "express";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { RAIZ, listarCasos, rutaOut } from "./repo.ts";
import { HERRAMIENTAS, type Ctx } from "./tools/oc.ts";
import { ProveedorAnthropic } from "./llm/anthropic.ts";
import type { ProveedorLlm, MensajeLlm } from "./llm/adapter.ts";

const MAX_ITERACIONES = Number(process.env.MAX_ITERACIONES ?? 25);
const MAX_TOKENS_SESION = Number(process.env.MAX_TOKENS_SESION ?? 200000);

/* ---------------- Prompt y conocimiento ---------------- */

function cargar(ruta: string, porDefecto = ""): string {
  try {
    return fs.readFileSync(path.join(RAIZ, ruta), "utf-8");
  } catch {
    return porDefecto;
  }
}

function systemPrompt(): string {
  const prompt = cargar("agent/prompt.md", "Eres un agente de órdenes de compra.");
  const conocimiento = cargar("src/knowledge/ordenes-compra.md", "");
  return conocimiento
    ? `${prompt}\n\n---\n\n# Conocimiento del proceso\n\n${conocimiento}`
    : prompt;
}

/* ---------------- Catálogo de herramientas para el modelo ---------------- */

function jsonSchemaDe(args: Record<string, z.ZodTypeAny>) {
  const properties: Record<string, any> = {};
  const required: string[] = [];
  for (const [clave, esquema] of Object.entries(args)) {
    properties[clave] = tipoDe(esquema);
    if (!esquema.isOptional()) required.push(clave);
  }
  return { type: "object", properties, required };
}

function tipoDe(e: z.ZodTypeAny): any {
  const d = e.description;
  if (e instanceof z.ZodOptional) return tipoDe(e.unwrap());
  if (e instanceof z.ZodString) return { type: "string", description: d };
  if (e instanceof z.ZodNumber) return { type: "number", description: d };
  if (e instanceof z.ZodBoolean) return { type: "boolean", description: d };
  if (e instanceof z.ZodAny) return { type: "object", description: d };
  return { type: "string", description: d };
}

function catalogo() {
  return Object.entries(HERRAMIENTAS).map(([nombre, h]) => ({
    name: nombre,
    description: h.description,
    input_schema: jsonSchemaDe(h.args as Record<string, z.ZodTypeAny>),
  }));
}

/* ---------------- Sesiones ---------------- */

interface Sesion {
  id: string;
  mensajes: MensajeLlm[];
  tokens: number;
  historialVisible: any[];
}

const sesiones = new Map<string, Sesion>();

function obtenerSesion(id: string): Sesion {
  if (!sesiones.has(id)) {
    sesiones.set(id, { id, mensajes: [], tokens: 0, historialVisible: [] });
  }
  return sesiones.get(id)!;
}

/* ---------------- Ciclo del agente ---------------- */

async function ejecutarTurno(sesion: Sesion, mensaje: string, llm: ProveedorLlm) {
  const ctx: Ctx = { directory: RAIZ, sessionId: sesion.id };
  const eventos: any[] = [];
  let necesitaConfirmacion = false;

  sesion.mensajes.push({ role: "user", content: mensaje });
  sesion.historialVisible.push({ tipo: "usuario", contenido: mensaje });

  for (let i = 0; i < MAX_ITERACIONES; i++) {
    if (sesion.tokens > MAX_TOKENS_SESION) {
      const aviso = "Se alcanzó el tope de tokens de la sesión. Inicia una sesión nueva.";
      eventos.push({ tipo: "error", contenido: aviso });
      break;
    }

    let respuesta;
    try {
      respuesta = await llm.enviar(systemPrompt(), sesion.mensajes, catalogo());
    } catch (e: any) {
      // CA5: error del proveedor en lenguaje claro, la sesión sobrevive
      const msg = `No pude contactar el modelo (${llm.nombre}): ${e.message}. Puedes reintentar.`;
      eventos.push({ tipo: "error", contenido: msg });
      sesion.historialVisible.push({ tipo: "error", contenido: msg });
      return { eventos, necesitaConfirmacion: false };
    }

    sesion.tokens += (respuesta.uso?.entrada ?? 0) + (respuesta.uso?.salida ?? 0);
    sesion.mensajes.push({ role: "assistant", content: respuesta.crudo });

    if (respuesta.texto) {
      eventos.push({ tipo: "texto", contenido: respuesta.texto });
      sesion.historialVisible.push({ tipo: "agente", contenido: respuesta.texto });
      if (/\b(confirm|autoriz)/i.test(respuesta.texto) && /\?/.test(respuesta.texto)) {
        necesitaConfirmacion = true;
      }
    }

    if (respuesta.llamadas.length === 0) break;

    const resultados: any[] = [];

    for (const llamada of respuesta.llamadas) {
      const herramienta = (HERRAMIENTAS as any)[llamada.nombre];

      if (!herramienta) {
        resultados.push({
          type: "tool_result",
          tool_use_id: llamada.id,
          content: JSON.stringify({ ok: false, error: `Herramienta desconocida: ${llamada.nombre}` }),
          is_error: true,
        });
        continue;
      }

      // Validación zod de los argumentos ANTES de ejecutar
      const esquema = z.object(herramienta.args as Record<string, z.ZodTypeAny>);
      const validacion = esquema.safeParse(llamada.argumentos);

      if (!validacion.success) {
        const detalle = validacion.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ");
        resultados.push({
          type: "tool_result",
          tool_use_id: llamada.id,
          content: JSON.stringify({ ok: false, error: `Argumentos inválidos — ${detalle}` }),
          is_error: true,
        });
        eventos.push({
          tipo: "herramienta",
          nombre: llamada.nombre,
          argumentos: llamada.argumentos,
          resultado: { ok: false, error: detalle },
        });
        continue;
      }

      const salida = await herramienta.execute(validacion.data, ctx);
      const parseada = JSON.parse(salida);

      const evento = {
        tipo: "herramienta",
        nombre: llamada.nombre,
        argumentos: validacion.data,
        resultado: resumir(parseada),
      };
      eventos.push(evento);
      sesion.historialVisible.push(evento);

      if (parseada.ok && parseada.data?.motivo === "requiere_confirmacion") {
        necesitaConfirmacion = true;
      }

      resultados.push({ type: "tool_result", tool_use_id: llamada.id, content: salida });
    }

    sesion.mensajes.push({ role: "user", content: resultados });

    if (i === MAX_ITERACIONES - 1) {
      // CA1: al alcanzar el tope, el agente responde con lo que tiene
      eventos.push({
        tipo: "texto",
        contenido:
          "Alcancé el tope de iteraciones de este turno. Te comparto lo obtenido hasta aquí; pídeme continuar si falta algo.",
      });
    }
  }

  return { eventos, necesitaConfirmacion };
}

/** Resume el resultado para el chat: el detalle completo vive en out/log.jsonl. */
function resumir(r: any) {
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.data ?? {};
  const resumen: Record<string, unknown> = { ok: true };
  for (const clave of [
    "apta",
    "bloqueos",
    "confirmaciones",
    "derivados",
    "retroactiva",
    "creada",
    "numero_oc",
    "idempotente",
    "motivo",
    "mensaje",
    "ruta",
    "sha256",
    "trazabilidad_ruta",
    "faltantes",
  ]) {
    if (d[clave] !== undefined) resumen[clave] = d[clave];
  }
  if (d.payload) resumen.payload = d.payload;
  if (d.solicitud) resumen.solicitud = d.solicitud;
  return Object.keys(resumen).length > 1 ? resumen : { ok: true, data: d };
}

/* ---------------- API ---------------- */

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(RAIZ, "web")));

let llm: ProveedorLlm | null = null;
const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey) llm = new ProveedorAnthropic(apiKey);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    provider: llm?.nombre ?? null,
    model: llm?.modelo ?? null,
    herramientas: Object.keys(HERRAMIENTAS),
    casos: listarCasos(),
    max_iteraciones: MAX_ITERACIONES,
  });
});

app.post("/api/chat", async (req, res) => {
  const { sessionId = "default", message } = req.body ?? {};
  if (!message) return res.status(400).json({ error: "Falta 'message'." });
  if (!llm) {
    return res.status(503).json({
      error: "No hay proveedor de modelo configurado. Define ANTHROPIC_API_KEY en el backend.",
    });
  }

  try {
    const sesion = obtenerSesion(sessionId);
    const { eventos, necesitaConfirmacion } = await ejecutarTurno(sesion, message, llm);
    const reply = eventos.filter((e) => e.tipo === "texto").map((e) => e.contenido).join("\n\n");
    res.json({
      reply,
      toolCalls: eventos.filter((e) => e.tipo === "herramienta"),
      needsConfirmation: necesitaConfirmacion,
      eventos,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/sessions/:id", (req, res) => {
  const s = sesiones.get(req.params.id);
  if (!s) return res.status(404).json({ error: "Sesión no encontrada." });
  res.json({ id: s.id, historial: s.historialVisible, tokens: s.tokens });
});

app.post("/api/sessions/:id/reset", (req, res) => {
  sesiones.delete(req.params.id);
  res.json({ ok: true });
});

app.get("/api/control", (_req, res) => {
  const archivo = rutaOut("control.csv");
  res.type("text/csv").send(fs.existsSync(archivo) ? fs.readFileSync(archivo, "utf-8") : "");
});

const PUERTO = Number(process.env.PORT ?? 3000);
app.listen(PUERTO, () => {
  console.log(`\n  Agente OC-SAP en http://localhost:${PUERTO}`);
  console.log(`  Proveedor: ${llm ? `${llm.nombre} / ${llm.modelo}` : "SIN CONFIGURAR"}`);
  console.log(`  Herramientas: ${Object.keys(HERRAMIENTAS).join(", ")}`);
  console.log(`  Casos: ${listarCasos().join(", ")}\n`);
});
