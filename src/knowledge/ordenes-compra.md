# Conocimiento del proceso de órdenes de compra

Este documento es el conocimiento del negocio que el agente consulta. Se mantiene
separado del comportamiento (`agent/prompt.md`) y de la ejecución (`src/tools/`):
un cambio de política de compras se edita aquí, sin tocar código.

## El proceso

Cada compra llega a administración por correo con tres piezas:

1. **Solicitud** — el Excel que diligencia quien necesita comprar.
2. **Cotización** — el documento del proveedor con el precio en firme.
3. **Aprobación** — el correo del líder del área autorizando el gasto.

La analista valida, digita en SAP y adjunta la evidencia de aprobación.

## Qué significa cada control

| Regla | Qué protege |
|---|---|
| RC1 | Que no se emita una OC a un tercero que no existe o fue dado de baja en el maestro. |
| RC2 | Que quien autoriza el gasto tenga facultad sobre ese centro de costo. Una aprobación de otra área no es válida aunque la persona sea senior. |
| RC3 | Que el monto no supere la facultad del aprobador. Es el control de segregación de funciones. |
| RC4 | Que el gasto se impute a la subárea correcta, para que el cierre contable no deba corregirlo. |
| RC5 | Que el precio tenga respaldo en una cotización. Una diferencia mayor al 2% significa que se está comprando algo distinto a lo cotizado. |
| RC6 | Que el IVA sea el correcto: un indicador mal puesto distorsiona la declaración. |
| RC7 | Que las condiciones de pago correspondan al acuerdo comercial con el proveedor. |
| RC8 | Que se mida cuántas compras se ejecutan antes de autorizarse. |
| RC9 | Que la aprobación corresponda a esta compra y no a una anterior. |
| RC10 | Que la aritmética de la solicitud cuadre antes de llevarla a SAP. |

## Glosario

- **Centro de costo**: unidad organizacional que asume el gasto (CC-1010 Tecnología, CC-2020 Administración, CC-3030 Comercial).
- **Subárea**: desagregación dentro del centro de costo. Cada centro tiene su lista cerrada.
- **Tope**: monto máximo que un aprobador puede autorizar en un centro de costo.
- **Indicador de IVA**: código SAP de la tasa aplicable (C0 excluido, C1 19%, C2 5%).
- **Condiciones de pago**: código del plazo acordado (Z000 inmediato, Z015, Z030, Z060 días).
- **OC retroactiva**: orden creada después de que la factura ya llegó. Invierte el propósito del control.

## Sobre las compras retroactivas

Una OC retroactiva no es un error de digitación: es una señal de que el proceso se
ejecutó al revés. Alguien comprometió el gasto antes de que existiera autorización
formal, y la orden se usa para poder radicar una factura que ya está en la casa.

El agente no las rechaza por su cuenta —esa decisión es de la dirección— pero las
marca, exige confirmación humana y las deja registradas en `out/control.csv` para
que puedan medirse.
