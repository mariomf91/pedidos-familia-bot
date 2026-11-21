// Genera workflow-pedidos.json a partir de los ficheros de nodos/.
// Uso:  node build-workflow.mjs
// Así el workflow se puede reconstruir y revisar sin tocar JSON a mano.
//
// ANTES del primer despliegue hay que rellenar BOT_TOKEN y ADMIN_ID abajo.
// Con los marcadores puestos el JSON se genera igual, pero el bot no
// funcionará hasta que se regenere con valores reales.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const leerNodo = (f) => readFileSync(join(dir, 'nodos', f), 'utf8');

// ── CONFIGURACIÓN ────────────────────────────────────────────────────────
// 1) BOT_TOKEN: crea el bot con @BotFather (/newbot) y pega aquí el token.
const BOT_TOKEN = 'PUT_TOKEN_AQUI';
// 2) ADMIN_ID: tu id numérica de Telegram (mándale /start a @userinfobot).
const ADMIN_ID = 'PUT_ADMIN_ID_AQUI';
// ──────────────────────────────────────────────────────────────────────────

const inyectar = (codigo) =>
  codigo.replaceAll('__BOT_TOKEN__', BOT_TOKEN).replaceAll('__ADMIN_ID__', ADMIN_ID);

const nodes = [
  {
    parameters: {
      content:
        '## Pedidos familia — bot Telegram\n\n' +
        '**Qué hace**\n' +
        '1. Cada 30 s sondea getUpdates (la instancia solo es alcanzable por Tailscale: sin webhooks).\n' +
        '2. Los padres pegan un enlace (o escriben texto) y reciben "Anotado ✓".\n' +
        '3. Se lee la página del producto y Mario recibe una ficha con [✅ Pedir] [❌ Pasar].\n' +
        '4. ✅ → enlace al producto para «Comprar ya» (su sesión, su dirección y su tarjeta).\n' +
        '   📦 Comprado → los padres reciben el 🎉. ❌ → "Visto ✓, Mario te escribe".\n\n' +
        '**Nunca compra solo**: sin el tap de Mario no hay pedido.\n\n' +
        'Admin: /listar · /permitir <id> · /accesos\n' +
        'Token embebido en el workflow: si se filtra, rotar con /revoke en BotFather.\n\n' +
        'Referencia: `Pedidos Familia/README.md`',
      height: 460,
      width: 400,
      color: 4,
    },
    id: 'sticky-pedidos',
    name: 'Nota',
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: [-660, 60],
  },
  {
    parameters: {
      rule: { interval: [{ field: 'seconds', secondsInterval: 30 }] },
    },
    id: 'nodo-cada30',
    name: 'Cada 30 segundos',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [-200, 300],
  },
  {
    parameters: { mode: 'runOnceForAllItems', jsCode: inyectar(leerNodo('01-sondeo.js')) },
    id: 'nodo-sondeo',
    name: 'Sondeo',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [20, 300],
  },
  {
    parameters: {
      method: 'GET',
      url:
        '={{ "https://api.telegram.org/bot" + ' + JSON.stringify(BOT_TOKEN) +
        ' + "/getUpdates?timeout=0&limit=50&offset=" + ($json.offset || 0) }}',
      options: { timeout: 15000 },
    },
    // Un 401 (token mal) o un 409 (webhook ajeno) no tumban el ciclo.
    onError: 'continueRegularOutput',
    retryOnFail: true,
    maxTries: 2,
    waitBetweenTries: 3000,
    id: 'nodo-getupdates',
    name: 'Leer novedades',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [240, 300],
  },
  {
    parameters: { mode: 'runOnceForAllItems', jsCode: inyectar(leerNodo('02-encaminar.js')) },
    id: 'nodo-encaminar',
    name: 'Encaminar',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [460, 300],
  },
  {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
        conditions: [
          {
            id: 'cond-enlace',
            leftValue: '={{ $json.op }}',
            rightValue: 'link',
            operator: { type: 'string', operation: 'notEquals', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: 'nodo-esenlace',
    name: 'Es enlace',
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: [680, 300],
  },
  {
    parameters: {
      method: 'GET',
      url: '={{ $json.url }}',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: 'User-Agent',
            value:
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          },
          { name: 'Accept-Language', value: 'es-ES,es;q=0.9' },
        ],
      },
      options: {
        timeout: 10000,
        redirect: { redirect: { followRedirects: false } },
        // CLAVE: sin fullResponse el nodo solo entrega el cuerpo, nunca
        // las cabeceras — y la Location del redirect vive en las cabeceras.
        // neverError: un 3xx/4xx devuelve respuesta, no error.
        response: { response: { fullResponse: true, neverError: true } },
      },
    },
    // GET sin seguir redirects: amzn.eu no contesta a HEAD (404), pero a
    // GET responde 301 con el /dp/ASIN en la cabecera Location. Si falla,
    // se sondea la URL tal cual.
    onError: 'continueRegularOutput',
    id: 'nodo-resolver',
    name: 'Resolver enlace',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [900, 460],
  },
  {
    parameters: { mode: 'runOnceForEachItem', jsCode: leerNodo('04-reapuntar.js') },
    id: 'nodo-reapuntar',
    name: 'Reapuntar',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1120, 460],
  },
  {
    parameters: {
      method: 'GET',
      url: '={{ $json.url }}',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: 'User-Agent',
            value:
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          },
          { name: 'Accept-Language', value: 'es-ES,es;q=0.9' },
        ],
      },
      options: { timeout: 12000 },
    },
    // n8n fuerza gzip:true en sus peticiones: para /dp/ Amazon responde un
    // stub sin datos, pero para /gp/aw/d/ (versión móvil) sirve la página
    // completa comprimida, que este nodo descomprime solo. "Reapuntar" ya
    // se encarga de que esta URL sea la móvil. Sin reintentos: un intento
    // largo no debe solaparse con el siguiente ciclo de sondeo.
    onError: 'continueRegularOutput',
    id: 'nodo-abrir',
    name: 'Abrir producto',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1340, 460],
  },
  {
    parameters: { mode: 'runOnceForEachItem', jsCode: inyectar(leerNodo('03-analizar.js')) },
    id: 'nodo-analizar',
    name: 'Analizar producto',
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: [1560, 460],
  },
  {
    parameters: {
      method: 'POST',
      url: '={{ $json.url }}',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.body) }}',
      options: { timeout: 15000 },
    },
    // Sin reintentos: un reintento sobre un envío ya entregado duplicaría
    // el mensaje en el chat. Si un envío falla, se pierde (y punto).
    onError: 'continueRegularOutput',
    id: 'nodo-fichas',
    name: 'Telegram: fichas',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1780, 460],
  },
  {
    parameters: {
      method: 'POST',
      url: '={{ $json.url }}',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.body) }}',
      options: { timeout: 15000 },
    },
    // Sin reintentos: un reintento sobre un envío ya entregado duplicaría
    // el mensaje en el chat. Si un envío falla, se pierde (y punto).
    onError: 'continueRegularOutput',
    id: 'nodo-responder',
    name: 'Telegram: responder',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [900, 140],
  },
];

const connections = {
  'Cada 30 segundos': { main: [[{ node: 'Sondeo', type: 'main', index: 0 }]] },
  Sondeo: { main: [[{ node: 'Leer novedades', type: 'main', index: 0 }]] },
  'Leer novedades': { main: [[{ node: 'Encaminar', type: 'main', index: 0 }]] },
  Encaminar: { main: [[{ node: 'Es enlace', type: 'main', index: 0 }]] },
  'Es enlace': {
    // Rama true (op != link): acuses y respuestas directas, que lleguen
    // PRIMERO. Rama false: los enlaces pasan por resolver redirects,
    // reapuntar a la URL buena y leer la página.
    main: [
      [{ node: 'Telegram: responder', type: 'main', index: 0 }],
      [{ node: 'Resolver enlace', type: 'main', index: 0 }],
    ],
  },
  'Resolver enlace': { main: [[{ node: 'Reapuntar', type: 'main', index: 0 }]] },
  Reapuntar: { main: [[{ node: 'Abrir producto', type: 'main', index: 0 }]] },
  'Abrir producto': { main: [[{ node: 'Analizar producto', type: 'main', index: 0 }]] },
  'Analizar producto': { main: [[{ node: 'Telegram: fichas', type: 'main', index: 0 }]] },
};

const workflow = {
  name: 'Pedidos familia — bot Telegram',
  nodes,
  connections,
  settings: {
    executionOrder: 'v1',
    timezone: 'Europe/Madrid',
    // Un sondeo cada 30 s son ~2.880 ejecuciones/día: no guardamos las
    // correctas para no engordar la base de datos; los errores sí.
    saveManualExecutions: true,
    saveDataSuccessExecution: 'none',
    saveDataErrorExecution: 'all',
  },
  active: false,
  pinData: {},
  meta: { generadoPor: 'build-workflow.mjs' },
};

// --- Validación mínima antes de escribir ---
const nombres = new Set(nodes.map((n) => n.name));
if (nombres.size !== nodes.length) throw new Error('Hay nombres de nodo duplicados');
for (const [origen, valor] of Object.entries(connections)) {
  if (!nombres.has(origen)) throw new Error('Origen desconocido: ' + origen);
  for (const rama of valor.main) {
    for (const destino of rama) {
      if (!nombres.has(destino.node)) throw new Error('Destino desconocido: ' + destino.node);
    }
  }
}
for (const n of nodes) {
  if (n.type !== 'n8n-nodes-base.stickyNote' && !n.parameters) {
    throw new Error('Nodo sin parámetros: ' + n.name);
  }
}
for (const f of ['01-sondeo.js', '02-encaminar.js', '03-analizar.js', '04-reapuntar.js']) {
  // Se valida el código YA inyectado: si un marcador está mal escrito
  // en el fichero de nodos, la inyección no lo tocará y esto lo caza.
  const codigo = inyectar(leerNodo(f));
  if (codigo.includes('__BOT_TOKEN__') || codigo.includes('__ADMIN_ID__')) {
    throw new Error('Marcador sin inyectar en ' + f);
  }
}
if (!BOT_TOKEN || BOT_TOKEN === 'PUT_TOKEN_AQUI') {
  console.log('⚠️  BOT_TOKEN sin poner: el JSON se genera, pero NO actives el workflow (el sondeo daría 401).');
} else if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(BOT_TOKEN)) {
  console.log('⚠️  BOT_TOKEN con pinta rara: revísalo (formato 123456789:AA…).');
}
if (!ADMIN_ID || ADMIN_ID === 'PUT_ADMIN_ID_AQUI') {
  console.log('⚠️  ADMIN_ID sin poner: el bot responderá "sin configurar" a todo el mundo.');
} else if (!/^\d+$/.test(ADMIN_ID)) {
  console.log('⚠️  ADMIN_ID debería ser solo números (tu id de @userinfobot).');
}

const salida = join(dir, 'workflow-pedidos.json');
writeFileSync(salida, JSON.stringify(workflow, null, 2), 'utf8');

console.log('OK · ' + nodes.length + ' nodos');
console.log('Escrito en: ' + salida);
