// El cerebro del bot. Clasifica cada novedad de Telegram y prepara las
// respuestas como items {url, body} listos para "Telegram: responder".
// Los pedidos con enlace salen como items {op:'link'} hacia la rama de ficha.
// BOT_TOKEN y ADMIN_ID los inyecta build-workflow.mjs (marcadores de abajo).

const BOT_TOKEN = '__BOT_TOKEN__';
const ADMIN_ID = '__ADMIN_ID__';

// staticData igual que Prospección IA: 'global' + espacio de nombres propio.
const raiz = $getWorkflowStaticData('global');
if (!raiz.pedidos || typeof raiz.pedidos !== 'object') raiz.pedidos = {};
const sd = raiz.pedidos;
const ADMIN = String(ADMIN_ID || '');
const api = (m) => 'https://api.telegram.org/bot' + BOT_TOKEN + '/' + m;
const esc = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escHref = (s) => esc(s).replace(/"/g, '&quot;');

const salidas = []; // {op:'send'|'answer'|'edit', url, body}
const enlaces = []; // {op:'link', ...}

const enviar = (chat_id, text, reply_markup) =>
  salidas.push({ op: 'send', url: api('sendMessage'), body: {
    chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true,
    ...(reply_markup ? { reply_markup } : {}),
  } });

const contestarCB = (id, text) =>
  salidas.push({ op: 'answer', url: api('answerCallbackQuery'), body: {
    callback_query_id: id, ...(text ? { text } : {}),
  } });

const quitarBotones = (chat_id, message_id) =>
  salidas.push({ op: 'edit', url: api('editMessageReplyMarkup'), body: {
    chat_id, message_id, reply_markup: { inline_keyboard: [] },
  } });

const tecladoPedido = (pid) => ({ inline_keyboard: [[
  { text: '✅ Pedir', callback_data: 'p:' + pid },
  { text: '❌ Pasar', callback_data: 'x:' + pid },
]] });

const tecladoComprado = (pid) => ({ inline_keyboard: [[
  { text: '📦 Comprado', callback_data: 'c:' + pid },
]] });
const tecladoCantidad = (pid) => ({ inline_keyboard: [
  [1, 2, 3, 4, 5].map((n) => ({ text: String(n), callback_data: 'q:' + pid + ':' + n })),
] });

const AYUDA =
  'Soy el bot de pedidos de la familia 👋\n\n' +
  'Para pedir algo:\n' +
  '1️⃣ Abre el producto (Amazon, Zara…) y pulsa Compartir → Copiar enlace.\n' +
  '2️⃣ Pega el enlace aquí.\n\n' +
  'Mario lo verá enseguida y te aviso cuando lo pida 📦\n' +
  'Si no tienes el enlace, escríbeme el producto con tus palabras y Mario lo busca.';

const filaLog = (l) => {
  const d = new Date(l.ts).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' });
  return '#' + l.pid + ' · ' + d + ' · ' + (l.titulo || l.nota || '?') +
    (l.precio ? ' (' + l.precio + ')' : '') + (l.cantidad > 1 ? ' ×' + l.cantidad : '') + ' · ' + l.estado;
};

// ---- Entrada: respuesta de getUpdates ----
const r = $input.first().json;

if (!r || r.ok !== true || !Array.isArray(r.result)) {
  // Token mal, red caída o conflicto de sondeo (409). El 409 puede ser
  // transitorio (dos ticks solapados); aviso solo si persiste 3 ciclos.
  if (r && r.ok === false && r.error_code === 409) {
    sd.cont409 = (sd.cont409 || 0) + 1;
    if (ADMIN && sd.cont409 === 3) {
      enviar(ADMIN, '⚠️ El bot lleva varios ciclos con conflicto de sondeo (409).\nSi no has tocado nada: sección "Si aparece 409" del README de Pedidos Familia.');
    }
  } else {
    sd.cont409 = 0;
  }
  return salidas.map((s) => ({ json: s }));
}
sd.cont409 = 0;

let offset = typeof sd.offset === 'number' ? sd.offset : 0;

for (const u of r.result) {
  if (typeof u.update_id === 'number') offset = Math.max(offset, u.update_id + 1);

  // Dedupe general por update_id: cubre re-entregas y carreras entre
  // ejecuciones solapadas (parcial pero gratis; el offset convergen).
  if (!Array.isArray(sd.vistos)) sd.vistos = [];
  const idVisto = String(u.update_id);
  if (sd.vistos.includes(idVisto)) continue;
  sd.vistos.push(idVisto);
  if (sd.vistos.length > 200) sd.vistos = sd.vistos.slice(-200);

  // ---------- Mensajes ----------
  const m = u.message;
  if (m && m.chat) {
    const fromId = String((m.from && m.from.id) != null ? m.from.id : '');
    const chatId = String(m.chat.id);
    const nombre = (m.from && m.from.first_name) || 'alguien';
    const texto = (m.text || '').trim();
    const esAdmin = !!ADMIN && fromId === ADMIN;
    const esFamilia = esAdmin || sd.whitelist.includes(fromId);

    if (!ADMIN) {
      enviar(chatId, '🛠️ El bot aún no está configurado (falta el adminId en build-workflow.mjs).');
      continue;
    }
    if (/^\/(start|ayuda)\b/i.test(texto)) { enviar(chatId, AYUDA); continue; }

    if (esAdmin && /^\/permitir\s+(\d{3,})/i.test(texto)) {
      const nuevo = texto.match(/^\/permitir\s+(\d{3,})/i)[1];
      if (!sd.whitelist.includes(nuevo)) sd.whitelist.push(nuevo);
      sd.log.push({ ts: Date.now(), pid: '-', quien: 'admin', titulo: 'acceso a ' + nuevo, estado: 'config' });
      enviar(chatId, '✅ Acceso concedido a <code>' + nuevo + '</code>.');
      continue;
    }
    if (esAdmin && /^\/accesos\b/i.test(texto)) {
      enviar(chatId, sd.whitelist.length
        ? 'Con acceso:\n<code>' + sd.whitelist.join('\n') + '</code>'
        : 'Nadie tiene acceso aún. Usa /permitir &lt;id&gt;.');
      continue;
    }
    if (esAdmin && /^\/listar\b/i.test(texto)) {
      const ultimos = sd.log.slice(-10).reverse();
      enviar(chatId, ultimos.length ? ultimos.map(filaLog).join('\n') : 'Aún no hay pedidos.');
      continue;
    }
    if (esAdmin && /^\/\w+/.test(texto)) {
      enviar(chatId, 'No conozco ese comando. Tienes: /listar · /permitir &lt;id&gt; · /accesos');
      continue;
    }
    if (!esFamilia) {
      enviar(chatId, 'Hola 👋 Este bot es privado de la familia.\nSi Mario tiene que darte acceso, dile este número: <code>' + fromId + '</code>');
      continue;
    }
    if (!texto) {
      enviar(chatId, 'Casi 🙏 Necesito el <b>enlace</b> del producto.\n\n' + AYUDA);
      continue;
    }
    if (esAdmin && !/https?:\/\//i.test(texto)) {
      // El propio Mario escribe algo suelto: no es un pedido.
      enviar(chatId, 'Tú eres el admin 😄 — /listar, /permitir &lt;id&gt;, o pega enlaces de lo que pidan.');
      continue;
    }

    // ---- Pedido válido ----
    const pid = sd.seq++;
    const urls = texto.match(/https?:\/\/[^\s]+/gi) || [];
    const nota = texto.replace(/https?:\/\/[^\s]+/gi, '').replace(/\s+/g, ' ').trim();

    if (urls.length) {
      const urlOriginal = urls[0];
      // Amazon: se sondea la URL MÓVIL del ASIN (/gp/aw/d/): el nodo HTTP
      // de n8n anuncia gzip (lo fuerza) y Amazon sirve la versión completa
      // solo en esa variante; en /dp/ devolvería un stub sin datos.
      // El enlace que se le muestra a Mario sigue siendo el /dp/ bonito.
      const m = urlOriginal.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
      let urlSondeo = m ? 'https://www.amazon.es/gp/aw/d/' + m[1] : urlOriginal;
      // Saneado defensivo de la URL (por si algún día vuelve a usarse
      // en un contexto de shell): sin comillas, $, ; ni & interpretables.
      urlSondeo = urlSondeo.replace(/[^A-Za-z0-9\-._~:\/?#\[\]@!*+,=%]/g, (c) =>
        '%' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase());

      // Se pregunta la cantidad ANTES de generar la ficha: la respuesta
      // dispara la lectura de la página. Si nadie contesta en 10 minutos,
      // el ciclo lo procesa como 1 unidad sin confirmar.
      sd.pendientes[pid] = {
        pid, quien: nombre, chatId,
        url: urlSondeo, urlOriginal, nota,
        estado: 'cantidad', ts: Date.now(),
      };
      enviar(chatId, 'Anotado ✓ (n.º ' + pid + '). ¿Cuántas unidades quieres?', tecladoCantidad(pid));
    } else {
      sd.pendientes[pid] = {
        pid, tipo: 'texto', quien: nombre, chatId, nota: texto,
        estado: 'pendiente', ts: Date.now(),
      };
      enviar(ADMIN,
        '📝 <b>Pedido n.º ' + pid + '</b> — de ' + esc(nombre) + '\n' +
        '«' + esc(texto) + '»\n' +
        'Es texto, no enlace: búscalo tú cuando puedas.',
        tecladoPedido(pid));
    }
    continue;
  }

  // ---------- Botones ----------
  const cb = u.callback_query;
  if (cb) {
    // Dedupe: callbacks re-entregados no se procesan dos veces.
    if (!Array.isArray(sd.cbVistos)) sd.cbVistos = [];
    if (sd.cbVistos.includes(cb.id)) continue;
    sd.cbVistos.push(cb.id);
    if (sd.cbVistos.length > 60) sd.cbVistos = sd.cbVistos.slice(-60);
    contestarCB(cb.id);
    const fromId = String((cb.from && cb.from.id) != null ? cb.from.id : '');
    const par = String(cb.data || '').match(/^([pxcq]):(\d+)(?::(\d+))?$/);
    if (!par) continue;

    // "¿Cuántas unidades?" lo contesta quien pidió (la familia), no solo
    // Mario: la respuesta dispara la lectura de la página del producto.
    if (par[1] === 'q') {
      const esFamiliaCB = (!!ADMIN && fromId === ADMIN) || sd.whitelist.includes(fromId);
      if (!esFamiliaCB) continue;
      const pq = sd.pendientes[par[2]];
      if (!pq || pq.estado !== 'cantidad') continue;
      const n = Math.max(1, Math.min(5, parseInt(par[3] || '1', 10)));
      pq.cantidad = n;
      pq.estado = 'pendiente';
      pq.tsAccion = Date.now();
      if (cb.message && cb.message.chat) {
        quitarBotones(String(cb.message.chat.id), cb.message.message_id);
      }
      enviar(pq.chatId, '✅ ' + n + (n === 1 ? ' unidad' : ' unidades') + '. Se lo paso a Mario 📨');
      enlaces.push({ json: {
        op: 'link', pid: pq.pid, url: pq.url, urlOriginal: pq.urlOriginal,
        nota: pq.nota || '', quien: pq.quien, chatId: pq.chatId, cantidad: n,
      } });
      continue;
    }

    // Los botones de compra/pasar/cerrar solo puede pulsarlos Mario.
    if (!ADMIN || fromId !== ADMIN) continue;

    const pid = par[2];
    const letra = par[1];
    const p = sd.pendientes[pid];
    const cardChat = (cb.message && cb.message.chat) ? String(cb.message.chat.id) : ADMIN;
    const cardMsg = cb.message && cb.message.message_id;

    if (!p) {
      // Tarjeta de una versión anterior o pedido ya cerrado: se le quitan
      // los botones también, para que no invite a seguir pulsándola.
      if (cb.message && cb.message.chat) {
        quitarBotones(String(cb.message.chat.id), cb.message.message_id);
      }
      enviar(ADMIN, 'Ese pedido ya no está pendiente 🤷 (si lo quieres, vuelve a pegar el enlace)');
      continue;
    }
    // Doble pulsación: la primera ya cambió el estado. El criterio
    // "reciente" cubre además la carrera si el guardado llega tarde.
    const recien = p.tsAccion && Date.now() - p.tsAccion < 20000;
    if (letra === 'c' ? (p.estado === 'comprado' || recien) : (p.estado !== 'pendiente' || recien)) continue;
    p.tsAccion = Date.now();

    quitarBotones(cardChat, cardMsg);

    if (letra === 'p') {
      p.estado = 'pedido';
      let linea;
      if (p.tipo === 'texto') {
        linea = '📝 Es texto: búscalo tú («' + esc(p.nota) + '») — al tenerlo, pulsa 📦.';
      } else if (p.tipo === 'amazon' && p.asin) {
        linea = '🛍️ <a href="https://www.amazon.es/dp/' + p.asin + '">abrir en Amazon</a> → «Comprar ya» (tu casa y tu tarjeta ya puestas)';
      } else {
        linea = '🛍️ <a href="' + escHref(p.url) + '">abrir producto</a> → tu navegador rellena el resto';
      }
      if (p.cantidad && p.cantidad > 1) {
        linea += '\n🔢 Son ' + p.cantidad + ' unidades.';
      }
      // El marcador 🔍 (cola del id de callback + hora del tick) es
      // temporal para pruebas: si sale doble, mismos números y misma hora
      // = un envío duplicado; misma id y horas distintas = reproceso.
      const tAprob = new Date().toLocaleTimeString('es-ES', { hour12: false });
      enviar(ADMIN, '🛒 n.º ' + pid + ' aprobado.\n' + linea + '\nAl pagar: 📦\n🔍' + String(cb.id).slice(-6) + ' ' + tAprob, tecladoComprado(pid));
    } else if (letra === 'x') {
      p.estado = 'pasado';
      sd.log.push({ ts: Date.now(), pid, quien: p.quien, titulo: p.titulo || '', nota: p.nota || '',
        precio: p.precio || '', asin: p.asin || '', cantidad: p.cantidad || 1, estado: 'pasado' });
      delete sd.pendientes[pid];
      enviar(p.chatId, 'Visto ✓. Mario te escribe en un rato 💬 (n.º ' + pid + ')');
    } else {
      p.estado = 'comprado';
      sd.log.push({ ts: Date.now(), pid, quien: p.quien, titulo: p.titulo || '', nota: p.nota || '',
        precio: p.precio || '', asin: p.asin || '', cantidad: p.cantidad || 1, estado: 'comprado' });
      delete sd.pendientes[pid];
      enviar(p.chatId, '🎉 ¡Hecho! Mario ya lo ha comprado (n.º ' + pid + ').');
    }
    continue;
  }
}

// Pedidos que se quedaron sin contestar el "¿cuántas unidades?": a los
// 10 minutos se procesan como 1 unidad sin confirmar, para que ningún
// pedido se quede frito esperando una respuesta que no llega.
const hace10 = Date.now() - 10 * 60000;
for (const pidVencido of Object.keys(sd.pendientes)) {
  const pv = sd.pendientes[pidVencido];
  if (pv.estado === 'cantidad' && pv.ts < hace10) {
    pv.cantidad = 1;
    pv.estado = 'pendiente';
    enlaces.push({ json: {
      op: 'link', pid: pv.pid, url: pv.url, urlOriginal: pv.urlOriginal,
      nota: pv.nota || '', quien: pv.quien, chatId: pv.chatId,
      cantidad: 1, sinConfirmar: true,
    } });
  }
}

sd.offset = offset;
if (sd.log.length > 200) sd.log = sd.log.slice(-200);

return [...salidas.map((s) => ({ json: s })), ...enlaces];
