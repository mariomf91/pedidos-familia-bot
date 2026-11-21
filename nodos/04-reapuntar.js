// Los enlaces compartidos desde la app de Amazon llegan a veces como
// amzn.eu/XXXX, sin el código del producto dentro. El nodo "Resolver
// enlace" hace un HEAD sin seguir redirects; si la respuesta trae
// Location con un /dp/ASIN, este paso recupera el ASIN y apunta el
// sondeo a la URL MÓVIL (/gp/aw/d/), que es la que sirve la página
// completa al nodo HTTP de n8n. Si no hay redirect, se va tal cual.

const link = $('Es enlace').item.json;
const r = $json;

const loc = r.headers && (r.headers.location || r.headers.Location);
let url = link.url;
const urlOriginal = link.urlOriginal || link.url;

if (loc) {
  const m = String(loc).match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i);
  if (m) {
    url = 'https://www.amazon.es/gp/aw/d/' + m[1];
  } else {
    // Redirección sin ASIN reconocible: se sondea el destino saneado.
    url = String(loc).replace(/[^A-Za-z0-9\-._~:\/?#\[\]@!*+,=%]/g, (c) =>
      '%' + c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase());
  }
}

return { json: {
  op: 'link',
  pid: link.pid,
  url,
  urlOriginal,
  nota: link.nota || '',
  quien: link.quien,
  chatId: link.chatId,
  cantidad: link.cantidad || 1,
  sinConfirmar: !!link.sinConfirmar,
} };
