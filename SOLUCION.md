# SOLUCIÓN — Agente conversacional "Órdenes de Compra SAP"

Reto técnico 03 · Periferia IT Group
Candidato: **Clerk Jonathan Monsalve Guzmán**

---

## 1. El problema en una frase

La analista administrativa digita a mano en SAP cada orden de compra y valida de memoria
si quien aprobó podía aprobar ese monto en ese centro de costo; le duele a ella por el
tiempo, a contabilidad por los errores que aparecen en el cierre, y a la dirección porque
nadie sabe cuántas órdenes se crean cuando la factura ya llegó.

---

## 2. Arquitectura

```
┌─────────────────┐   POST /api/chat   ┌──────────────────────────────────────┐
│  web/index.html │ ─────────────────▶ │  src/server.ts                       │
│  · historial    │ ◀───────────────── │  · ciclo del agente (CA1–CA5)        │
│  · tool calls   │   eventos          │  · validación zod de argumentos      │
│  · confirmación │                    │  · sesiones en memoria               │
└─────────────────┘                    └──────┬───────────────────┬───────────┘
                                              │                   │
                              src/llm/adapter.ts          src/tools/oc.ts
                              (contrato proveedor)        (RC1–RC10, puras)
                                      │                           │
                              src/llm/anthropic.ts        src/sap/adapter.ts
                                                          src/sap/mock.ts
                                                                  │
                                          fixtures/ (lectura)   out/ (escritura)
```

**Dónde vive cada cosa** — ésta es la separación que sostiene todo el diseño:

| Capa | Archivo | Qué contiene |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Cómo conversa el agente, cuándo pide confirmación, qué nunca puede afirmar. |
| **Conocimiento** | `src/knowledge/ordenes-compra.md` | Qué protege cada control, glosario, política de retroactivas. |
| **Ejecución** | `src/tools/oc.ts` | Las reglas implementadas como funciones deterministas. |
| **Integración** | `src/sap/`, `src/llm/` | Contratos e implementaciones intercambiables. |

Un cambio de política de compras se edita en `knowledge`. Un cambio de umbral se edita en
`tools`. Un cambio de proveedor de modelo se edita en `llm`. **Ninguno toca el servidor.**

---

## 3. Ciclo del agente

Implementado en `ejecutarTurno()` (`src/server.ts`):

1. Se envía al modelo el system prompt (prompt + conocimiento), el historial y el catálogo
   de herramientas derivado de los esquemas `zod`.
2. El modelo responde con texto, con llamadas a herramientas, o ambas.
3. Por cada llamada: se **valida con zod antes de ejecutar**. Si los argumentos no cumplen,
   el error vuelve al modelo como `tool_result` y el modelo corrige — no se ejecuta nada.
4. El resultado vuelve al modelo y el bucle continúa.
5. Termina cuando el modelo responde sin pedir herramientas.

| Regla | Implementación |
|---|---|
| **CA1** · tope de iteraciones | `MAX_ITERACIONES = 25` configurable. Al alcanzarlo el agente responde con lo obtenido y lo que falta. |
| **CA2** · no afirmar sin herramienta | Lo prohíbe el prompt y lo hace innecesario el diseño: todo valor del payload sale de una herramienta y queda en `trazabilidad.json`. |
| **CA3** · confirmación humana | `oc_crear` devuelve `motivo: "requiere_confirmacion"` si hay excepciones y `confirmado !== true`. El turno termina con pregunta; el front resalta el estado con un aviso. |
| **CA4** · trazabilidad | Toda llamada se registra en `out/log.jsonl` y se muestra en el chat con argumentos y resultado desplegables. |
| **CA5** · errores | Las herramientas nunca lanzan: devuelven `{ ok:false, error }`. Un fallo del proveedor LLM se muestra en lenguaje claro y la sesión sobrevive. |

---

## 4. Elección del modelo

| Decisión | Valor |
|---|---|
| Proveedor | Anthropic |
| Modelo | `claude-sonnet-5-5` (configurable por `LLM_MODELO`) |

**Por qué.** El trabajo del modelo aquí es orquestación, no razonamiento profundo: decidir
qué herramienta llamar y redactar el resultado para la analista. Toda la lógica de negocio
está fuera del modelo. Un modelo de gama media cumple ese rol con menor costo y latencia;
reservar un modelo mayor no mejoraría la decisión porque las reglas no las decide él.

**Costo estimado por caso procesado.** Un caso completo consume alrededor de 4 a 6 llamadas
a herramientas, con un historial que crece a medida que vuelven los resultados.

| Concepto | Estimación |
|---|---|
| Entrada acumulada por caso | ~12.000–18.000 tokens (system prompt + conocimiento + resultados de herramientas reinyectados) |
| Salida por caso | ~1.500–2.500 tokens |
| Costo aproximado | del orden de centavos de dólar por caso |

**Optimizaciones aplicadas y disponibles:** los resultados que vuelven al chat se resumen
(`resumir()`) para no arrastrar el payload completo en cada iteración; hay tope de tokens
por sesión (`MAX_TOKENS_SESION`) para que nadie agote la clave; y el system prompt es
candidato natural a caché de prompts, al ser idéntico en todas las sesiones.

**Observación de diseño:** como `demo.ts` cubre el 100% de la lógica sin modelo, el costo
se concentra en la conversación, nunca en la validación.

---

## 5. Matriz de controles (RC1–RC10)

| # | Regla | Tipo | Implementación | Caso que la evidencia |
|---|---|---|---|---|
| RC1 | Proveedor existe y activo | Bloqueo | Busca por NIT normalizado; si la solicitud no trae NIT, por nombre normalizado (sin tildes, sin signos) | `sol-002` bloquea · `sol-006` resuelve por nombre |
| RC2 | Aprobación válida y de aprobador del centro | Bloqueo | Detecta "Aprobado" en el cuerpo y cruza el remitente con `aprobadores[]` del centro | `sol-003` bloquea |
| RC3 | Monto ≤ tope del aprobador | Bloqueo | Compara `valor_total` con el `tope` del aprobador resuelto en RC2 | — |
| RC4 | Subárea pertenece al centro | Bloqueo | `centro.subareas.includes(subarea)` | — |
| RC5 | Cotización vs solicitud ≤ 2% | Confirmación | Desviación relativa; sin cotización también confirma | `sol-004` (6,0%) · `sol-002/003/005` sin cotización |
| RC6 | IVA ausente → derivar | Confirmación + derivado | Toma `indicador_iva_default` del proveedor | `sol-006` |
| RC7 | Condiciones de pago ausentes → derivar | Derivado | Toma `condiciones_pago_default`; solo informa | `sol-006` |
| RC8 | Factura anterior a la solicitud | Confirmación | Compara fechas; marca `retroactiva = true` | `sol-005` |
| RC9 | Aprobación ≥ fecha de solicitud | Confirmación | Compara fechas normalizadas a `YYYY-MM-DD` | — |
| RC10 | cantidad × unitario = total (±1) | Bloqueo | Verifica la aritmética antes de llevarla a SAP | — |

### La más difícil: RC1 sin NIT

`sol-006` llega sin `proveedor_nit`. La regla dice "por NIT; si no hay NIT, por nombre
normalizado", y ahí está la trampa: el nombre en la solicitud es `"TecnoSuministros S.A.S."`
y en el maestro también, pero en la cotización aparece como `NIT: 900.555.111-2` —con puntos,
guion y **dígito de verificación**— mientras el maestro guarda `"900555111"`.

Dos normalizaciones distintas, y confundirlas rompe el control sin que se note:

- **Nombre**: minúsculas, sin tildes (`NFD` + descarte de diacríticos), sin espacios ni signos.
- **NIT**: solo dígitos, sin ceros a la izquierda, y descartando el dígito de verificación.

Lo trato como un problema de calidad de datos, no de parsing: si la coincidencia por nombre
fuera ambigua (dos proveedores con nombre parecido), la regla correcta sería **bloquear y
pedir el NIT**, no adivinar. Hoy el maestro no tiene ese caso; lo dejo anotado como riesgo
en la sección 12.

---

## 6. Diseño del adaptador SAP real

**Opción elegida: OData `API_PURCHASEORDER_PROCESS_SRV`**, con RFC/BAPI `BAPI_PO_CREATE1`
como alternativa si el landscape es ECC y no S/4HANA.

**Por qué.** La viabilidad no está confirmada, así que el criterio es minimizar la superficie
de integración: OData es HTTP + JSON, se consume desde Node sin middleware adicional, trae
versionado y se puede probar contra un sandbox antes de pedir cualquier apertura de red.
RFC exige librería nativa (`node-rfc`), compilación en el host y conectividad a nivel de red,
lo que convierte un problema de integración en un problema de infraestructura.

**Mapeo del payload (7.4) a OData:**

| Payload | OData |
|---|---|
| `proveedor.codigo_sap` | `Supplier` |
| `sociedad` | `CompanyCode` |
| `organizacion_compras` | `PurchasingOrganization` |
| `condiciones_pago` | `PaymentTerms` |
| `moneda` | `DocumentCurrency` |
| `referencia.solicitud_id` | `PurchaseOrderByCustomer` (clave de idempotencia) |
| `posiciones[]` | `to_PurchaseOrderItem` (`PurchaseOrderItem`, `PurchaseOrderItemText`, `OrderQuantity`, `PurchaseOrderQuantityUnit`, `NetPriceAmount`, `TaxCode`) |
| `posiciones[].centro_costo` / `subarea` | `to_AccountAssignment` (`CostCenter`, `WBSElement` o campo Z según el modelo contable) |
| `aprobador.evidencia_sha256` | adjunto vía `API_CV_ATTACHMENT_SRV`, con el hash en el texto de cabecera |

**Autenticación y credenciales.** OAuth 2.0 client credentials contra el servidor de
autorización de BTP, o certificado X.509 en mTLS si el equipo SAP lo prefiere. Las
credenciales viven en el gestor de secretos del entorno (Azure Key Vault, AWS Secrets
Manager o las variables cifradas del orquestador) y se inyectan al backend en tiempo de
ejecución. **Nunca** en el repositorio, el prompt, el front ni los logs. El agente no las
conoce: las usa el adaptador.

**Idempotencia frente a reintentos.** `solicitud_id` viaja como clave externa en
`PurchaseOrderByCustomer`. Antes de crear, el adaptador consulta por esa referencia
(`buscarOrdenPorReferencia`); si existe, devuelve el número existente. Así un reintento por
timeout nunca produce una segunda OC — que es el modo de falla más caro de esta integración,
porque genera doble compromiso presupuestal.

**Error parcial.** Si SAP crea la cabecera y falla en una posición, el adaptador registra la
OC como `PARCIAL` en el log de control, devuelve el número asignado y señala qué posición
quedó pendiente. No se reintenta la creación completa: se completa la posición faltante.
Reintentar entero sobre una cabecera existente es justo lo que la idempotencia evita.

**Plan B si la conexión no es viable.** El valor del agente no depende de SAP: lo que ahorra
tiempo es la validación y la preparación del dato, no el `INSERT`. Sin conexión, el agente
igual entrega la OC validada en dos formatos: un resumen listo para copiar campo por campo
en SAP GUI, y un archivo de carga masiva (CSV o LSMW) para procesar en lote. La analista
pasa de validar y digitar, a solo digitar sobre datos ya verificados —o ni eso, si se usa la
carga masiva.

---

## 7. Lectura del proceso: qué le diría a la dirección sobre las OC retroactivas

Una orden retroactiva no es un error de digitación: es evidencia de que el proceso se ejecutó
al revés. Alguien comprometió el gasto antes de que existiera autorización formal, y la orden
se emite después para poder radicar una factura que ya está en la casa. El control deja de
ser una autorización previa y se convierte en un trámite de legalización — es decir, deja de
controlar algo.

Lo primero que diría es que **hoy no sabemos de qué tamaño es el problema**, y esa es la
razón por la que no se ha resuelto. Por eso el agente no las bloquea: las marca. A partir de
la primera semana de operación, `out/control.csv` responde con datos qué porcentaje de las
órdenes son retroactivas, de qué centros de costo vienen y con qué proveedores se repiten.
Sin ese número, cualquier política es una opinión.

Con el dato en mano, el cambio de proceso que propondría es no atacar la retroactividad de
frente, sino **su causa**: en la mayoría de los casos no hay mala fe, hay un proceso que no
alcanza la velocidad de la operación. Si una compra urgente tarda tres días en autorizarse,
la gente compra primero y legaliza después. La corrección es un **carril rápido**: montos
bajos y proveedores recurrentes con aprobación simplificada y tope propio, de modo que el
camino correcto sea también el camino fácil. Y para lo que siga saliendo retroactivo, una
excepción explícita que alguien firma — no un correo que se pierde.

Mi recomendación sería tolerarlas con marca durante un trimestre para medir y entender, y
solo entonces decidir si se rechazan. Prohibir antes de medir no elimina la práctica: la
vuelve invisible.

---

## 8. Decisiones y trade-offs

**1. Las reglas en herramientas, no en el prompt.**
*Alternativa descartada:* describir RC1–RC10 en `prompt.md` y dejar que el modelo las aplique.
Es más rápido de escribir y más flexible.
*Por qué la descarté:* un prompt no es auditable ni determinista. La misma solicitud podría
dar dos resultados distintos, y ante auditoría no hay forma de demostrar por qué se aprobó un
gasto. Con las reglas en funciones, `demo.ts` prueba el 100% de la lógica sin costo de modelo
y el resultado es reproducible.

**2. Herramientas que devuelven `{ ok, data | error }` y nunca lanzan.**
*Alternativa descartada:* dejar que lancen excepciones y capturarlas en el servidor.
*Por qué la descarté:* una excepción no llega al modelo; un `{ ok:false, error }` sí, y el
modelo puede explicarle a la analista qué falta y a quién pedírselo. Convierte un error
técnico en una acción de negocio — que es justamente el objetivo O3 del PRD.

**3. Confirmación humana resuelta en la herramienta, no solo en el prompt.**
*Alternativa descartada:* instruir al modelo para que pregunte antes de crear.
*Por qué la descarté:* eso depende de que el modelo obedezca. `oc_crear` se niega a crear si
hay confirmaciones pendientes y `confirmado !== true`, **sin importar lo que el modelo
decida**. El prompt refuerza el comportamiento; la herramienta lo garantiza. Defensa en
profundidad: si el prompt falla, el control sigue en pie.

**4. Resumir los resultados que vuelven al chat.**
*Alternativa descartada:* mandar el payload completo en cada iteración.
*Por qué la descarté:* el historial crece en cada vuelta del bucle y el costo con él. El
detalle completo queda en `out/log.jsonl`, que es donde lo busca auditoría; el chat recibe lo
que la analista necesita ver.

---

## 9. Supuestos

1. **Un caso = una posición de OC.** Los fixtures traen una línea por solicitud. El esquema
   soporta `posiciones[]`, pero el constructor arma una sola. Para multi-ítem habría que
   decidir primero si el Excel real los trae desagregados.
2. **"Aprobado" se detecta por expresión regular** sobre el cuerpo del correo. Es suficiente
   para los fixtures; en producción un "no aprobado" podría pasar la detección, así que la
   regla correcta sería exigir una estructura o integrarse con el workflow de aprobación.
3. **La unidad de medida se infiere** de la descripción (`H` si menciona horas, `UN` en el
   resto). Los fixtures no la traen. En producción debe venir del maestro de materiales.
4. **El dígito de verificación del NIT se descarta** en la comparación: el maestro guarda 9
   dígitos y la cotización trae 10 con DV.
5. **La fecha de aprobación se compara a nivel de día**, no de hora, para no bloquear casos
   donde la aprobación llega el mismo día a una hora anterior.
6. **El tope aplica al `valor_total`** de la solicitud, no al valor con IVA ni al acumulado
   del centro de costo en el período.

---

## 10. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 · Leer el paquete | **Hecho** | Lectura real de `.xlsx` y `.pdf` binarios (P1 del PRD). |
| HU-2 · Validar controles | **Hecho** | RC1–RC10 implementadas y evidenciadas en `demo.ts`. Faltaría parametrizar umbrales (el 2% está en código). |
| HU-3 · Construir payload | **Hecho** | Soporte multi-posición y unidad desde maestro de materiales. |
| HU-4 · Evidencia de aprobación | **Parcial** | `aprobacion.txt` con sha256 (P0) está. El PDF (P1) no se implementó: elegí invertir el tiempo en los controles y la documentación, que pesan más en el objetivo del reto. Se resuelve con `pdf-lib` sobre el mismo contenido ya generado. |
| HU-5 · Crear OC en SAP | **Hecho** | Numeración desde 4500000001, idempotencia por `solicitud_id`, `control.csv` por cada intento. Falta el adaptador real (diseñado en §6). |
| HU-6 · Manejo de errores | **Hecho** | Errores tipados que el agente traduce a acción de negocio. |
| Bonus · Módulo reutilizable | **Hecho** | `modulo/` con `agent.md`, `tools/oc.ts` y `skill/ordenes-compra/SKILL.md` reexportando las mismas piezas, sin copias divergentes. |

---

## 11. Uso de IA

**Asistente usado:** Claude (Anthropic), en conversación, para construir la solución.

| Tarea | Cómo lo usé |
|---|---|
| Andamiaje del proyecto | Generación de la estructura base (servidor, ciclo del agente, adaptadores) a partir de la especificación del PRD. |
| Implementación de RC1–RC10 | Traduje cada regla del PRD a una especificación precisa —condición, tipo, mensaje, caso que la evidencia— y la IA generó la implementación. El trabajo mío fue la especificación y la verificación contra los 6 casos. |
| Parsers de cotización y factura | Generación de las expresiones regulares a partir del formato real de los fixtures. |
| Documentación | Estructura y redacción, sobre decisiones de diseño que tomé yo. |

**Qué descarté de lo que me propuso:**

1. **Resolver el proveedor por coincidencia parcial de nombre** (`includes`) cuando no hay NIT.
   Lo rechacé: una coincidencia parcial puede emparejar dos proveedores distintos y emitir una
   OC al tercero equivocado. Preferí normalización estricta y, ante ambigüedad, bloquear.
2. **Dejar que el modelo decidiera si una excepción requiere confirmación.** Lo rechacé por lo
   explicado en la decisión 3: eso depende de que el modelo obedezca. La herramienta lo impone.
3. **Un `catch` que devolviera el error crudo al chat.** Lo rechacé porque expone rutas internas
   y trazas de stack al usuario final; los errores se traducen a lenguaje de negocio.

**Método de trabajo:** apliqué desarrollo guiado por especificación. Primero derivé del PRD la
matriz de controles con el resultado esperado de los 6 casos, y esa matriz fue la fuente contra
la que verifiqué cada implementación. Mi aporte está en la precisión de la especificación y en
la verificación — que es exactamente mi oficio: vengo de liderar aseguramiento de calidad de
sistemas core de telecomunicaciones, donde el trabajo es convertir requisitos ambiguos en
criterios verificables antes de que lleguen a producción.

---

## 12. Riesgos en producción y mitigación

| Riesgo | Impacto | Mitigación |
|---|---|---|
| **Doble creación de OC** por reintento ante timeout de SAP | Doble compromiso presupuestal; corrección manual en cierre | Idempotencia por `solicitud_id` ya implementada, consultando antes de crear |
| **Proveedor homónimo** resuelto por nombre al faltar el NIT | OC emitida al tercero equivocado | Normalización estricta; ante más de una coincidencia, bloquear y exigir NIT |
| **Detección de "Aprobado" por texto libre** | Una negación podría pasar como aprobación | Integrar con el workflow formal de aprobación o exigir estructura en el correo |
| **El modelo altera un monto** para que cuadre con la cotización | OC por un valor no autorizado | Los montos salen de las herramientas y el payload se valida con zod; el modelo no puede modificarlo |
| **Maestros desactualizados** respecto a SAP | Validaciones contra datos viejos | En producción consultar los maestros en SAP en tiempo real, con caché corto |
| **Costo del modelo sin control** | Gasto no previsto de la clave | Tope de iteraciones por turno y de tokens por sesión, ambos configurables |
| **Umbrales en código** (2% de RC5) | Un cambio de política exige despliegue | Externalizar a configuración junto con el resto de los parámetros de negocio |
| **Sesiones en memoria** | Se pierden al reiniciar el servicio | Aceptable para el reto; en producción, almacenamiento persistente de sesiones |

---

## 13. Cómo verificar esta entrega

```bash
npm install
npm run demo      # 6 casos + idempotencia + confirmación, sin modelo ni clave
npm start         # agente conversacional en http://localhost:3000
```

`demo.ts` evidencia los cuatro objetivos del PRD §3.1: `sol-001` crea la OC sin intervención,
`sol-002` y `sol-003` bloquean con razón y acción sugerida, `sol-004` y `sol-006` exigen
confirmación, y `sol-005` queda marcada `retroactiva = true` en `out/control.csv`.
