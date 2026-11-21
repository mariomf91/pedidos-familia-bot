// Genera diag-pipeline.json: recorre el MISMO pipeline de producción
// (Resolver enlace -> Reapuntar -> Abrir producto -> Analizar producto,
// con los ficheros reales de nodos/) pero inyectando el item de enlace
// directamente, sin depender de Telegram. Uso de un solo ciclo con
// scheduleTrigger y luego se despublica a mano.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const leer = (f) => readFileSync(join(dir, 'nodos', f), 'utf8');

const BOT_TOKEN = 'PUT_TOKEN_AQUI';
const ADMIN_ID = 'PUT_ADMIN_ID_AQUI';
const iny = (c) => c.replaceAll('__BOT_TOKEN__', BOT_TOKEN).replaceAll('__ADMIN_ID__', ADMIN_ID);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const INYECTOR =
  "// Diagnostico: simula el item de enlace que produce el router real.\n" +
  "return [{ json: { op: 'link', pid: 999, url: 'https://amzn.eu/d/06bYj3pp', " +
  "urlOriginal: 'https://amzn.eu/d/06bYj3pp', nota: 'mensaje automatico de prueba', " +
  "quien: 'DIAG', chatId: '" + ADMIN_ID + "' } }];";

const nodes = [
  {
    parameters: { rule: { interval: [{ field: 'seconds', secondsInterval: 30 }] } },
    id: 'd0', name: 'Cada 30 segundos', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0],
  },
  {
    parameters: { jsCode: INYECTOR },
    id: 'd1', name: 'Es enlace', type: 'n8n-nodes-base.code', typeVersion: 2, position: [220, 0],
  },
  {
    parameters: {
      method: 'GET',
      url: '={{ $json.url }}',
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'User-Agent', value: UA },
        { name: 'Accept-Language', value: 'es-ES,es;q=0.9' },
      ] },
      options: {
        timeout: 10000,
        redirect: { redirect: { followRedirects: false } },
        response: { response: { fullResponse: true, neverError: true } },
      },
    },
    onError: 'continueRegularOutput',
    id: 'd2', name: 'Resolver enlace', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [440, 0],
  },
  {
    parameters: { mode: 'runOnceForEachItem', jsCode: leer('04-reapuntar.js') },
    id: 'd3', name: 'Reapuntar', type: 'n8n-nodes-base.code', typeVersion: 2, position: [660, 0],
  },
  {
    parameters: {
      method: 'GET',
      url: '={{ $json.url }}',
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'User-Agent', value: UA },
        { name: 'Accept-Language', value: 'es-ES,es;q=0.9' },
      ] },
      options: { timeout: 12000 },
    },
    onError: 'continueRegularOutput',
    id: 'd4', name: 'Abrir producto', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [880, 0],
  },
  {
    parameters: { mode: 'runOnceForEachItem', jsCode: iny(leer('03-analizar.js')) },
    id: 'd5', name: 'Analizar producto', type: 'n8n-nodes-base.code', typeVersion: 2, position: [1100, 0],
  },
  {
    parameters: {
      method: 'POST', url: '={{ $json.url }}',
      sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}',
      options: { timeout: 15000 },
    },
    onError: 'continueRegularOutput',
    id: 'd6', name: 'Telegram: fichas', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1320, 0],
  },
];

const orden = ['Cada 30 segundos', 'Es enlace', 'Resolver enlace', 'Reapuntar', 'Abrir producto', 'Analizar producto', 'Telegram: fichas'];
const connections = {};
for (let i = 0; i < orden.length - 1; i++) {
  connections[orden[i]] = { main: [[{ node: orden[i + 1], type: 'main', index: 0 }]] };
}

const workflow = {
  name: 'DIAG pipeline pedidos',
  nodes,
  connections,
  settings: { executionOrder: 'v1', timezone: 'Europe/Madrid', saveDataSuccessExecution: 'all' },
  active: false,
  pinData: {},
  meta: { generadoPor: 'diag-build.mjs' },
};

writeFileSync(join(dir, 'diag-pipeline.json'), JSON.stringify(workflow, null, 2), 'utf8');
console.log('OK · ' + nodes.length + ' nodos · diag-pipeline.json');
