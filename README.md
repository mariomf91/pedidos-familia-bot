# Pedidos Familia — bot de Telegram sobre n8n

> El problema original, tal cual lo contó su autor: *"Mis padres me piden
> muchas veces que les haga pedidos de Amazon con mi cuenta, y a veces de
> otras webs tipo Zara Home."*
>
> Este proyecto convierte eso en: **ellos pegan un enlace, yo apruebo con
> un toque y compro con un clic.**

El sistema vive en un homelab (n8n en Docker, solo alcanzable por
Tailscale) y no guarda ningún secreto de compra: ni la cuenta de Amazon,
ni la dirección, ni la tarjeta. Todo lo sensible sigue viviendo donde
vivía — en la cuenta de Amazon de quien compra.

---

## El flujo, de punta a punta

```
Tu madre                Homelab (n8n)                         Mario
   │                          │                                │
   │── pega el enlace ───────▶│                                │
   │◀─ "Anotado ✓ (n.º 7)" ───│                                │
   │                          │── resuelve el enlace corto ────│
   │                          │── lee la página del producto   │
   │                          │── ficha con título y precio ──▶│
   │                          │   [✅ Pedir] [❌ Pasar]         │
   │                          │◀──────────── tap ✅ ────────────│
   │                          │── "abrir en Amazon →           │
   │                          │    «Comprar ya» (tu casa y     │
   │                          │    tu tarjeta ya puestas)" ─▶│
   │                          │◀──────────── tap 📦 ───────────│
   │◀─ "🎉 ¡Hecho!" ───────────│                                │
```

- **Quien pide** no necesita saber nada: Compartir → Copiar enlace → pegar.
  Sin enlace también vale: escribe *"necesito detergente ACE familia"* y
  llega como ficha de texto.
- **Quien aprueba** lo hace desde donde esté: dos toques (✅ antes de
  pagar, 📦 después) y un clic en «Comprar ya» de Amazon con la dirección
  y la tarjeta por defecto ya puestas.
- **El bot nunca compra.** Sin tu toque no hay pedido. Esa es una decisión
  de diseño, no una limitación: ver abajo.

---

## Decisiones de diseño (y las que se descartaron)

| Decisión | Alternativa descartada | Por qué |
|---|---|---|
| **Telegram** | WhatsApp (API Business no oficial / puentes tipo Baileys) | Telegram tiene API de bots oficial, gratuita y sin riesgo de baneo; los puentes de WhatsApp violan los ToS de Meta y caen por oleadas |
| **Sondeo cada 30 s** (`getUpdates`) | Webhook | La instancia de n8n no es pública (solo Tailscale); Telegram no puede entrar. El sondeo sale desde dentro |
| **El bot no compra nada** | Robot con la sesión de Amazon (Playwright + cookies) | Contra los ToS, activa los anti-bots de Amazon, riesgo de suspensión de la cuenta de la que vives, captchas periódicas… para ahorrarse *abrir un enlace*. Ver abajo cómo se compra igualmente en 2 cliclos |
| **Compra con 1 clic de Amazon** | Guardar dirección/tarjeta en el homelab | Los datos de pago viven solo en Amazon. Tras pulsar ✅, el bot devuelve el enlace del producto: abrir → «Comprar ya» → listo |
| **Otras webs (Zara Home…)**: el bot pasa el enlace y el navegador rellena (autofill / Google Pay) | Robot de checkout multi-web | Recetas por web que se rompen al rediseñar, y guardar la tarjeta completa (con CVV) en un fichero alimentando un proceso desatendido: ahí está el límite |
| **Registro en `staticData`** de n8n | Base de datos externa | Volumen familiar: no hace falta nada más. Sobrevive a reinicios |
| **Sin LLM** | GPT/GLM para interpretar pedidos | El pipeline es 100 % determinista: 0 € por pedido, cero riesgo de invención, latencia mínima. Si algún día hace falta inteligencia, el punto natural es interpretar los pedidos en texto |

### La pregunta incómoda: "¿y cómo sabe el bot que lo he comprado?"

No lo sabe — y es a conciencia: no tiene ojos sobre tu Amazon. Lo
informas con un toque: **✅ antes** ("voy a comprarlo") y **📦 después**
("ya está pagado"), y el bot cierra el pedido y avisa con el 🎉 a quien
lo pidió. Si olvidas el 📦 no pasa nada: el pedido queda simplemente como
"aprobado" en el registro.

---

## Arquitectura (12 nodos)

| Nodo | Qué hace |
|---|---|
| Cada 30 segundos | Sondeo `getUpdates` (sin webhook: la instancia no es pública) |
| Sondeo | Arranque del ciclo: offset + limpieza de registros viejos |
| Leer novedades | HTTP → hasta 50 novedades |
| Encaminar | El cerebro: clasifica mensajes y botones, responde, registra, deduplica callbacks |
| Es enlace | IF: los acuses van primero, los enlaces a la rama de lectura |
| Resolver enlace | GET sin seguir redirects y con `fullResponse` — los enlaces cortos (`amzn.eu`) responden 301 con el ASIN en la cabecera |
| Reapuntar | Con el ASIN, apunta a la URL **móvil** de Amazon (`/gp/aw/d/`) |
| Abrir producto | Descarga la página con UA de navegador |
| Analizar producto | Extrae título/precio/ASIN (JSON-LD + marcadores de Amazon); si falla, la ficha sale igual — **nunca se pierde el pedido** |
| Telegram: responder / fichas | Envíos por API, **sin reintentos** (un reintento sobre un envío ya entregado duplicaría el mensaje) |

Quién puede pedir lo decide el admin: los desconocidos reciben su número
de usuario y el admin los autoriza con `/permitir <número>`. Comandos:
`/ayuda`, `/listar` (historial), `/accesos`, `/permitir <id>`.

El código está en `nodos/*.js` (editables y comentados) y
`build-workflow.mjs` regenera el JSON importable de n8n — nada de JSON a
mano, validación incluida. El despliegue, el detalle operativo y la
guía de reparación están en [`docs/OPERACIONES.md`](docs/OPERACIONES.md).

---

## La caja de sorpresas de n8n (y cómo se cazaron)

Este proyecto se construyó contra n8n **2.47.7** con task runners
activados, probando de punta a punta con enlaces reales de Amazon.
Cosas que solo se descubren rompiéndolas:

1. **El task runner solo admite `$getWorkflowStaticData('global')` y
   `'node'`.** El clásico `'workflow'` lanza
   `Unknown context type. Only 'global' and 'node' are supported.`
   (y además la escritura en modo por-item requiere que el objeto ya
   exista: se inicializa en un nodo `runOnceForAllItems` previo).

2. **Amazon sirve una página-comodín de 3,8 KB sin ningún dato** a los
   clientes que anuncian `Accept-Encoding: gzip` con huella TLS de Node —
   que es justo lo que hace el nodo HTTP de n8n. La sorpresa: a curl
   (OpenSSL) le sirve la página limpia de 2,6 MB. La solución, tras
   sondear desde dentro del contenedor: pedir la **versión móvil**
   (`/gp/aw/d/<ASIN>`), que sí sirve la página completa a esa misma
   huella:

   | Cliente | `/dp/` (escritorio) | `/gp/aw/d/` (móvil) |
   |---|---|---|
   | n8n (Node + gzip anunciado) | stub de 3,8 KB sin datos | **página completa** ✓ |
   | curl (OpenSSL) | página limpia | página limpia |

3. **El nodo HTTP no entrega cabeceras por defecto**: sin
   `options.response.response.fullResponse: true`, la `Location` de un
   redirect jamás llega al siguiente nodo. Este fue el clavo del soporte
   de enlaces cortos (`amzn.eu`), que se descubrió con un workflow de
   diagnóstico que inyectaba el mismo item que produce el router y
   recorría el pipeline real (`diag-build.mjs`, incluido).

4. **`n8n-nodes-base.executeCommand` ya no existe** en n8n 2.x: importa
   sin rechistar, pero `publish:workflow` lo rechaza con
   `Unrecognized node type`. Se descubrió intentando montar la descarga
   con curl dentro del contenedor.

5. **Los ajustes del workflow no viajan en la versión publicada**: la
   tabla de versiones no guarda `settings`, así que
   `saveDataSuccessExecution: 'none'` se ignora y cada tick se guarda en
   la base. Asumible con el auto-podado de ejecuciones; documentado para
   no volver a pelearse con ello.

6. **Mensajes duplicados en las ventanas de re-despliegue**: al publicar
   una versión nueva, el trigger viego tarda en descargarse y dos latidos
   pueden leer el mismo callback pendiente. Arreglo: emisores sin
   reintentos + `docker restart n8n` tras el despliegue definitivo.

7. **El registro es por versión de workflow**: cada import crea una copia
   con su `staticData` en blanco, así que el contador de pedidos y los
   pedidos abiertos se reinician con cada re-despliegue. En producción
   (sin más iteraciones) es invisible; en fase de pruebas, las tarjetas
   viejas caducan y el bot lo dice amablemente.

Todo esto quedó documentado también en
[`docs/OPERACIONES.md`](docs/OPERACIONES.md), sección *"Si algo falla"*.

---

## Cómo replicarlo

Requisitos: un bot de Telegram ([@BotFather](https://t.me/botfather) →
`/newbot`), tu id numérica ([@userinfobot](https://t.me/userinfobot)) y
una instancia de n8n (la tuya puede ser tan privada como quieras: no
necesita webhook ni puerto público).

1. Rellena `BOT_TOKEN` y `ADMIN_ID` en `build-workflow.mjs` y ejecuta
   `node build-workflow.mjs` → genera `workflow-pedidos.json` (12 nodos).
   *Ese JSON lleva el token dentro: está en `.gitignore` por algo.*
2. Impórtalo en n8n (UI o `n8n import:workflow --input=...`) y actívalo.
3. Manda `/start` al bot desde tu Telegram y pruébalo pegando el enlace
   de cualquier producto de Amazon.
4. Activa la **Compra con 1 clic** en tu cuenta de Amazon (dirección y
   tarjeta por defecto) para que «Comprar ya» lo haga todo solo.
5. Da de alta a tu familia: cada uno manda `/start` al bot, te pasa el
   número que les responde, y tú mandas `/permitir <número>`.

En la app de Amazon: *producto → Compartir → Copiar enlace → pegar en el
chat del bot*. Los enlaces cortos (`amzn.eu`) también funcionan: el bot
resuelve el redirect en dos pasos.

---

## Qué NO hace (a conciencia)

- **No compra solo.** Sin tu ✅ y tu clic no hay pedido. El riesgo de una
  compra equivocada con dinero real siempre pasa por una persona.
- **No guarda tu tarjeta, tu dirección ni tu sesión de Amazon.** En
  ninguna parte. Para las demás webs: el autofill de tu navegador.
- **No usa ningún LLM.** Determinista de punta a punta.
- **Otras tiendas (Zara Home…)**: su anti-bot impide leer la página —
  verificado contra `zarahome.com` desde el servidor: responde 200 con
  una página-valla de 2,1 KB en vez de la web real. La ficha sale sin
  título ni precio, pero el enlace y el flujo funcionan igual, y la vista
  previa de Telegram suele mostrar el producto. Es el modo degradado
  previsto; otras tiendas sin anti-bot agresivo sí salen con ficha
  completa vía JSON-LD.

## Estructura del repositorio

```
├── README.md            ← este documento
├── docs/OPERACIONES.md  ← despliegue, operación y reparación del día a día
├── nodos/               ← el código del bot, editable y comentado
│   ├── 01-sondeo.js     ← arranque del ciclo, offset y limpieza
│   ├── 02-encaminar.js  ← el cerebro: clasifica, responde, registra
│   ├── 03-analizar.js   ← extrae título/precio/foto y monta la ficha
│   └── 04-reapuntar.js  ← resuelve enlaces cortos → URL móvil de Amazon
├── build-workflow.mjs   ← regenera el JSON importable (valida todo)
└── diag-build.mjs       ← workflow de diagnóstico: inyecta un item y recorre el pipeline real
```

## Licencia

MIT — hazlo tuyo. Y si montas algo así para tu familia, que tus padres
también le escriban a un bot en lugar de a ti a las 22:47.
