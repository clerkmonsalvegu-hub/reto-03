# Módulo reutilizable (bonus §9.4)

El agente empaquetado para integrarse a otras plataformas, sin depender del servidor
de esta aplicación.

```
modulo/
├── agent.md                        comportamiento (frontmatter + system prompt)
├── tools/oc.ts                     herramientas, reexportadas desde src/tools/oc.ts
└── skill/ordenes-compra/SKILL.md   conocimiento del proceso
```

**Las tres piezas son las mismas que usa la aplicación**, no copias:

| Pieza del módulo | Fuente en la aplicación |
|---|---|
| `agent.md` (cuerpo) | `agent/prompt.md` |
| `tools/oc.ts` | reexporta `src/tools/oc.ts` |
| `skill/ordenes-compra/SKILL.md` (cuerpo) | `src/knowledge/ordenes-compra.md` |

Un cambio en las reglas se hace una sola vez y queda reflejado en ambos.

## Uso

```ts
import { HERRAMIENTAS } from "./modulo/tools/oc.ts";

const r = JSON.parse(
  await HERRAMIENTAS.oc_validar.execute({ caso: "sol-004" }, { directory: ".", sessionId: "x" })
);
console.log(r.data.confirmaciones);
```
