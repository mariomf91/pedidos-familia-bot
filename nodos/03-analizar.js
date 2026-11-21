// Monta la ficha que recibe Mario a partir del HTML que deja el nodo
// "Abrir producto". En Amazon ese HTML llega descomprimido por el propio
// nodo (n8n fuerza gzip y la URL de sondeo es la móvil /gp/aw/d/, que sí
// sirve la página completa). Se ejecuta UNA vez por enlace; si la lectura
// falla, la ficha sale igual — nunca se pierde el pedido.
//
// Ficha compacta (decisión de Mario, 21/11/2026): mini resumen del
// producto y ya — la URL larga no se muestra; va dentro de "ver producto"
// y reaparece al pulsar ✅.

const BOT_TOKEN = '__BOT_TOKEN__';
const ADMIN_ID = '__ADMIN_ID__';

const link = $('Reapuntar').item.json;
// staticData igual que Prospección IA: 'global' + espacio de nombres propio.
const raiz = $getWorkflowStaticData('global');
if (!raiz.pedidos || typeof raiz.pedidos !== 'object') raiz.pedidos = {};
const sd = raiz.pedidos;

const api = (m) => 'https://api.telegram.org/bot' + BOT_TOKEN + '/' + m;
const esc = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escHref = (s) => esc(s).replace(/"/g, '&quot;');

// El HTML llega como texto en $json.data (o $json.body según versión);
// por si acaso, se rastrea cualquier campo que huela a página.
const html =
  (typeof $json.data === 'string' && $json.data) ||
  (typeof $json.body === 'string' && $json.body) ||
  Object.values($json || {}).find(
    (v) => typeof v === 'string' && v.length > 5000 && /<html|<!doctype/i.test(v)
  ) || '';

const pid = link.pid;
const esAmazon = /amazon\.|amzn\.to|amzn\.eu/i.test(link.url);
let asin = (link.url.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i) || [])[1] || '';
let titulo = '';
let precio = '';
let foto = '';

if (html) {
  // 1) JSON-LD: muchas tiendas publican el producto en schema.org
  const bloques = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of bloques) {
    try {
      const o = JSON.parse(b.replace(/^<script[^>]*>/i, '').replace(/<\/script>\s*$/i, ''));
      const lista = Array.isArray(o) ? o : (o && o['@graph']) || [o];
      const prod = lista.find((x) => x && x['@type'] === 'Product');
      if (!prod) continue;
      if (!titulo && prod.name) titulo = String(prod.name).trim();
      const ofertas = Array.isArray(prod.offers) ? prod.offers[0] : prod.offers;
      if (!precio && ofertas) {
        const pr = ofertas.price ?? ofertas.lowPrice ?? ofertas.highPrice;
        if (pr != null) precio = String(pr) + ' EUR';
      }
      if (!foto && prod.image) foto = Array.isArray(prod.image) ? String(prod.image[0] || '') : String(prod.image || '');
    } catch (e) { /* bloque corrupto: al siguiente */ }
  }

  // 2) <title> genérico: sirve para cualquier tienda. Verificado con
  //    enlaces de cesta compartida de Zara Home (basketShare), que sí
  //    devuelven la página real aunque la home esté tras página-valla.
  if (!titulo) {
    const t = html.match(/<title[^>]*>([^<]{1,300})</i);
    if (t) titulo = t[1].replace(/\s+/g, ' ').trim();
  }

  // 3) Marcadores directos de Amazon (página móvil)
  if (esAmazon) {
    if (!titulo) {
      const t = html.match(/<title[^>]*>([^<]{1,300})</i);
      if (t) titulo = t[1].replace(/\s+/g, ' ').trim();
    }
    if (!precio) {
      const po = html.match(/class="a-offscreen">([^<]{1,40})</);
      if (po) precio = po[1].trim();
      else {
        const pn = html.match(/"priceAmount"\s*:\s*([\d.]+)/);
        if (pn) precio = pn[1] + ' EUR';
      }
    }
    if (!asin) {
      const a = html.match(/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
      if (a) asin = a[1];
    }
    if (!foto) {
      const hi = html.match(/"hiRes"\s*:\s*"([^"]{10,300})"/);
      if (hi) foto = hi[1];
    }
  }
}

// Limpieza del título: sufijo de Amazon y sufijos de marca genéricos
// ("Cesta de la compra | Zara Home España" → "Cesta de la compra").
if (titulo) {
  titulo = titulo.replace(/\s*[:|-]\s*Amazon\.es.*$/i, '').trim();
  if (!esAmazon && titulo.includes(' | ')) {
    const primera = titulo.split(' | ')[0].trim();
    if (primera.length >= 8) titulo = primera;
  }
  if (titulo.length > 90) titulo = titulo.slice(0, 90).trimEnd() + '…';
}
if (precio) {
  const n = precio.match(/^(\d+(?:[.,]\d+)?)/);
  if (n) precio = n[1].replace('.', ',') + ' €';
}

// Registro del pedido pendiente: se FUSIONA con lo apuntado cuando pidió
// (el pendiente ya existía desde el "¿cuántas unidades?") para no perder
// la cantidad ni la identidad de quien pidió.
const previo = sd.pendientes[pid] || {};
sd.pendientes[pid] = {
  ...previo,
  pid, tipo: esAmazon ? 'amazon' : 'web',
  quien: link.quien, chatId: link.chatId,
  url: link.urlOriginal || link.url, asin, titulo, precio, foto,
  nota: link.nota || '', estado: 'pendiente', ts: Date.now(),
};

// Aviso de repetición (mismo ASIN comprado en los últimos 7 días)
let aviso = '';
if (asin) {
  const limite = Date.now() - 7 * 86400000;
  const dup = (sd.log || []).slice().reverse()
    .find((l) => l.asin === asin && l.ts > limite && l.estado === 'comprado');
  if (dup) aviso = '⚠️ Se pidió hace poco (n.º ' + dup.pid + ')';
}

// Ficha compacta: mini resumen, sin URL larga a la vista
const partes = ['🛒 n.º ' + pid + ' — de ' + esc(link.quien)];
if (titulo) partes.push('📦 ' + esc(titulo));
if (precio) partes.push('💶 ' + esc(precio) + ' (orientativo)');
if (link.cantidad) {
  partes.push('🔢 ' + link.cantidad + (link.cantidad === 1 ? ' unidad' : ' unidades') +
    (link.sinConfirmar ? ' (sin confirmar)' : ''));
}
if (link.nota) partes.push('📝 «' + esc(link.nota) + '»');
if (aviso) partes.push(aviso);
partes.push('🛍️ <a href="' + escHref(link.urlOriginal || link.url) + '">ver producto</a>');
// Línea de debug SOLO mientras duran las pruebas: si la lectura falla,
// dice qué llegó para poder diagnosticar sin entrar en n8n.
if (!titulo && !precio) {
  partes.push('🔍 ' + ($json.error ? 'error de red' : 'página ilegible') +
    ' · ' + String(html ? html.length : 0) + ' B · ' + esc((html || '').slice(0, 90)));
}

const reply_markup = { inline_keyboard: [[
  { text: '✅ Pedir', callback_data: 'p:' + pid },
  { text: '❌ Pasar', callback_data: 'x:' + pid },
]] };

return { json: { url: api('sendMessage'), body: {
  chat_id: String(ADMIN_ID),
  text: partes.join('\n'),
  parse_mode: 'HTML',
  reply_markup,
} } };
