# Pedidos familia — bot de Telegram

Bot privado para que los padres de Mario pidan cosas (Amazon, Zara Home…)
por Telegram. Mario aprueba con un tap y compra con su cuenta, su dirección
y su tarjeta. **El bot nunca compra solo: sin el tap de Mario no hay pedido.**

```
Padres                          Homelab (n8n)                      Mario
  │                                │                                │
  │── enlace o texto ─────────────▶│                                │
  │◀── "Anotado ✓ (n.º 12)" ───────│                                │
  │                                │── lee la página del producto ──│
  │                                │   (título, precio, foto)       │
  │                                │── ficha [✅ Pedir] [❌ Pasar] ─▶│
  │                                │◀──────── tap ✅ ──────────────│
  │                                │── enlace con el carrito ──────▶│
  │                                │   ya preparado + 📦 Comprado   │
  │                                │◀──────── tap 📦 ───────────────│
  │◀── "🎉 ¡Hecho!" ────────────────│                                │
```

## Piezas del proyecto

| Fichero | Qué es |
|---|---|
| `nodos/01-sondeo.js` | Arranque del ciclo: offset de sondeo + limpieza de registros viejos |
| `nodos/02-encaminar.js` | El cerebro: clasifica mensajes y botones, responde, registra |
| `nodos/03-analizar.js` | Lee la página del producto y monta la ficha de Mario |
| `build-workflow.mjs` | Regenera `workflow-pedidos.json` (clona el convenio de Prospección IA) |
| `workflow-pedidos.json` | El importable en n8n (10 nodos) |

El registro de pedidos, la lista de accesos y el offset viven en el
`staticData` **global** de n8n, con espacio de nombres propio (`raiz.pedidos`)
— la misma vía que usa Prospección IA. Ojo a la peculiaridad del task runner
de n8n 2.x: los Code nodes solo aceptan `$getWorkflowStaticData('global')`
y `'node'`; el tipo `'workflow'` lanza
`Unknown context type. Only 'global' and 'node' are supported`.
No hace falta base de datos externa.

## Cómo funciona (12 nodos)

1. **Cada 30 segundos** (scheduleTrigger) → sondeo `getUpdates`.
   No hay webhook porque la instancia de n8n solo es alcanzable por
   Tailscale: Telegram no puede entrar. El sondeo sale desde dentro.
2. **Leer novedades** (HTTP) → trae hasta 50 novedades.
3. **Encaminar** (Code) → clasifica cada novedad:
   - `/start` o `/ayuda` → instrucciones.
   - Desconocido → "bot privado, dale este número a Mario" (se autoriza
     con `/permitir <id>`).
   - Familia con enlace → acuse "Anotado ✓" + rama de ficha.
   - Familia con texto → ficha directa a Mario.
   - Botones `✅/❌/📦` (solo Mario puede pulsarlos) → compra, descarte
     o cierre con aviso a los padres. Dedupe de callbacks y guarda
     anti-doble-pulsación de 20 s.
4. **Es enlace** (IF) separa los enlaces del resto (los acuses van antes).
5. **Resolver enlace** (HTTP GET sin seguir redirects, con
   `fullResponse: true` — sin esa opción las cabeceras nunca llegan al
   siguiente nodo): los enlaces cortos de la app (`amzn.eu`) responden
   301 con el `/dp/ASIN` en la cabecera Location.
6. **Reapuntar** (Code) → con el ASIN, apunta a la URL MÓVIL
   (`/gp/aw/d/`), la única que sirve la página completa al nodo HTTP de
   n8n (para `/dp/`, Amazon devuelve un stub sin datos porque n8n
   anuncia gzip en sus peticiones).
7. **Abrir producto** (HTTP) descarga la página con User-Agent de navegador.
8. **Analizar producto** (Code) saca título/precio/ASIN del JSON-LD
   (con plan B de marcado de Amazon). Si algo falla: la ficha sale igual
   con línea 🔍 de diagnóstico — **nunca se pierde el pedido**.
9. **Telegram: fichas** / **Telegram: responder** envían por la API,
   **sin reintentos** (un reintento sobre un envío ya entregado
   duplicaría el mensaje).

## Configuración (10 minutos, una vez)

1. **Crear el bot**: en Telegram, hablar con [@BotFather](https://t.me/botfather):
   `/newbot` → nombre p. ej. `Pedidos casa Mario` → username que acabe en
   `bot` (p. ej. `pedidos_casa_mario_bot`) → copiar el token
   (`123456789:AAE…`).
2. **Tu id numérica**: hablar con [@userinfobot](https://t.me/userinfobot),
   responde con `Your ID: 123456789`.
3. **Pegar ambos** en `build-workflow.mjs` (`BOT_TOKEN` y `ADMIN_ID`).
4. **Regenerar**: `node build-workflow.mjs` → JSON nuevo en
   `workflow-pedidos.json`. (Sin token real el build avisa y genera igual:
   NO activar esa versión, el sondeo daría 401.)

## Despliegue (con confirmación de Mario; no lo hace nadie solo)

```bash
# 1. Copiar al homelab
scp workflow-pedidos.json homelab:/tmp/pedidos-familia.json
ssh homelab "sudo mv /tmp/pedidos-familia.json /opt/stacks/n8n/files/pedidos-familia.json"

# 2. Importar (crea un workflow NUEVO; el CLI no tiene delete, borrar copias en la UI)
ssh homelab "sudo docker exec n8n n8n import:workflow --input=/files/pedidos-familia.json"

# 3. Averiguar el id (en la UI, abrir el workflow y mirar la URL) y activar
ssh homelab "sudo docker exec n8n n8n update:workflow --id=<ID> --active=true"
```

Tras activar: en *Ejecuciones* aparecen ticks silenciosos cada 30 s.
**Nota real (n8n 2.47.7):** los ajustes del workflow (`saveDataSuccessExecution:
none`) NO llegan al runtime — la tabla `workflow_history` de la versión
publicada no guarda settings y `toSaveSettings` cae al default de instancia
(`all`). Consecuencia: cada tick guarda ~21 KB (≈60 MB/día en bruto) y el
auto-podado de n8n (`pruneData`, tope 10.000 filas / 14 días) mantiene un
techo estable de ~200 MB. Si molesta el ruido en la lista de *Ejecuciones*,
el arreglo limpio es de instancia: `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none` en
el `compose.yaml` (afectaría también al historial de éxitos de los demás
workflows; manuales y errores se siguen guardando).

**Primera prueba**: abrir el workflow en la UI y pulsar *Ejecutar workflow*
una vez → procesa los `/start` que ya hayan escrito. Luego un pedido real
de prueba con un enlace de Amazon. Con la **Compra con 1 clic** activada en
la cuenta de Mario, al pulsar ✅ el bot devuelve el enlace del producto:
abrir → «Comprar ya» → pedido hecho (sin comprar de verdad en la prueba:
se puede dejar a un paso del pago y desistir).

## Uso diario

**Los padres** (una vez):
1. Instalar Telegram, buscar el bot por su username, `/start`.
2. El bot les responde con instrucciones; a los desconocidos les dice su
   número — mandarlo a Mario.
3. Mario: `/permitir <ese número>` (o `/accesos` para ver quiénes están).

**Los padres** (cada pedido): abrir el producto → Compartir → Copiar
enlace → pegarlo en el bot. Reciben "Anotado ✓ (n.º X)" y luego el 🎉.
Sin enlace también vale: escriben "necesito detergente ACE" y Mario lo busca.

**Mario**: recibe fichas con [✅ Pedir] [❌ Pasar].
- ✅ → le llega el enlace con el carrito ya preparado (su sesión, dirección
  y tarjeta guardadas) y un botón 📦 Comprado para avisarles.
- ❌ → los padres reciben "Visto ✓. Mario te escribe en un rato".
- `/listar` → últimos 10 pedidos. Aviso automático si algo se repite en
  7 días (por el mismo ASIN).

## Decisiones y avisos honestos

- **Token del bot embebido en el workflow.** La credencial `telegramApi`
  de n8n no se puede usar desde el nodo HTTP Request (verificado en la
  instancia), y los Code nodes no leen credenciales ni variables de
  entorno. Como el token es de un bot dedicado (no toca la cuenta
  personal de nadie), el riesgo es bajo: si se filtra, se rota con
  `/revoke` en BotFather y se regenera el workflow. No compartir el
  JSON ni pantallas del workflow con el token visible.
- **Precio orientativo.** Lo que lee el bot es lo que publica la página;
  el precio real lo ves tú en el carrito antes de pagar.
- **Compra con 1 clic (decisión de Mario, 21/11/2026)**: el bot NO automatiza
  la cuenta de Amazon. Tras pulsar ✅ devuelve el enlace del producto y Mario
  usa «Comprar ya» (dirección y tarjeta por defecto). Para otras webs: el
  autofill del navegador (autofill / Google Pay) rellena el checkout.
  Se descartó el robot con sesión propia: contra los ToS de Amazon, captchas,
  riesgo de suspensión de la cuenta de Mario, y guardar la tarjeta en el
  homelab para las demás webs.
- **Zara/Zara Home**: anti-bot agresivo; a veces la ficha saldrá sin
  título ni precio. El enlace llega igual y compras tú en 2 minutos.
- **Sondeo cada 30 s**: sin webhook público, tu n8n sigue siendo
  inalcanzable desde internet. Aceptable con el tráfico de una familia.
- **Doble acuse (raro)**: si una ejecución cascase justo a mitad, el
  siguiente tick podría reprocesar el último mensaje y repetir un acuse.
  No duplica compras (nunca compra solo), a lo sumo un "Anotado ✓" doble.

## Si algo falla

- **El bot está mudo** → ejecutar el workflow a mano una vez y mirar qué
  nodo se pone rojo. Lo típico: token mal pegado (401 en *Leer novedades*)
  o `ADMIN_ID` sin poner (el bot responde "sin configurar").
- **Después de re-desplegar puede haber dobles**: al publicar una versión
  nueva, el trigger viejo tarda en descargarse y dos latidos pueden leer
  el mismo callback. Arreglo: tras el último despliegue,
  `sudo docker restart n8n` (queda un único latido). Ya aplicado el
  21/11/2026 tras la versión definitiva.
- **Enlaces cortos (amzn.eu)**: el nodo "Resolver enlace" necesita
  `fullResponse: true` — sin esa opción n8n solo entrega el cuerpo y la
  cabecera Location (donde vive el ASIN) nunca llega a "Reapuntar".
  Bug real encontrado y corregido el 21/11/2026; verificado con un
  workflow de diagnóstico que inyecta el item tal cual lo produce el
  router.
- **409 Conflict** (un webhook antiguo bloquea el sondeo) →
  `curl https://api.telegram.org/bot<TOKEN>/deleteWebhook` y ya.
