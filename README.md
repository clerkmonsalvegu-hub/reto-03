# Agente conversacional — Órdenes de Compra SAP

Reto técnico 03 · Periferia IT Group · Clerk Jonathan Monsalve Guzmán

Agente que lee el paquete de una solicitud de compra, lo valida contra los maestros
corporativos aplicando diez reglas de control, construye el payload de la OC y la crea
en un SAP simulado — pidiendo confirmación humana cuando hay excepciones.

---

## Puesta en marcha

Requisitos: **Node 20+** (probado en Node 24).

```bash
npm install
cp .env.example .env     # y completa ANTHROPIC_API_KEY
npm start                # http://localhost:3000
```

### Verificación sin modelo

```bash
npm run demo
```

Procesa los 6 casos llamando directamente a las herramientas, **sin clave ni modelo**.
Demuestra además idempotencia (`sol-001` dos veces) y confirmación explícita (`sol-004`).

---

## Variables de entorno

| Variable | Obligatoria | Por defecto | Para qué |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Sí (solo para el chat) | — | Clave del proveedor. Solo en el backend. |
| `LLM_MODELO` | No | `claude-sonnet-5-5` | Modelo a usar. |
| `MAX_ITERACIONES` | No | `25` | Tope de vueltas herramienta→modelo por turno. |
| `MAX_TOKENS_SESION` | No | `200000` | Tope de gasto por sesión. |
| `PORT` | No | `3000` | Puerto del servidor. |

---

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId, message }` → `{ reply, toolCalls[], needsConfirmation, eventos[] }` |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión |
| `POST` | `/api/sessions/:id/reset` | Reinicia la sesión |
| `GET` | `/api/health` | `{ ok, provider, model, herramientas, casos }` — sin exponer claves |
| `GET` | `/api/control` | Log de control en CSV |

---

## Herramientas

| Nombre | Qué hace |
|---|---|
| `oc_leer_paquete` | Lee y normaliza correo, solicitud, cotización, aprobación y factura |
| `oc_validar` | Aplica RC1–RC10; devuelve apta, bloqueos, confirmaciones, derivados y retroactiva |
| `oc_construir_payload` | Arma la OC validada con zod y guarda la trazabilidad por campo |
| `oc_generar_evidencia` | Genera la evidencia de aprobación con sha256 |
| `oc_crear` | Crea la OC en SAP simulado; idempotente por `solicitud_id` |

---

## Qué se genera en `out/`

```
out/
├── control.csv              una fila por intento: resultado, OC, retroactiva, reglas
├── log.jsonl                toda llamada a herramienta con argumentos y resultado
├── sap/ordenes.jsonl        las OC creadas en el SAP simulado
└── <caso>/
    ├── aprobacion.txt       evidencia de aprobación + sha256
    └── trazabilidad.json    cada campo del payload y su fuente
```

`out/` se limpia al inicio de `demo.ts` para garantizar determinismo.

---

## Prueba sugerida en el chat

```
Procesa la solicitud "sol-004". Muéstrame la OC como quedaría en SAP, qué
validaciones pasó y cuáles no, y no la crees hasta que yo lo confirme.
```

Luego responde `confirmo` para ver la creación y el número de OC.

---

## Documentación

- **`SOLUCION.md`** — arquitectura, matriz de controles, diseño del adaptador SAP real,
  lectura del proceso, decisiones, supuestos, cobertura, uso de IA y riesgos.
- **`agent/prompt.md`** — comportamiento del agente.
- **`src/knowledge/ordenes-compra.md`** — conocimiento del proceso.

## Link de prueba

https://reto-03-oc-sap-tm5z.onrender.com

Nota: instancia en plan gratuito de Render. La primera peticion tras un periodo
de inactividad puede tardar hasta 50 segundos mientras el servicio despierta.