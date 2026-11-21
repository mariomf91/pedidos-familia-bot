// Arranque del ciclo: garantiza la estructura del registro interno
// (whitelist, pedidos, registro, contador) y calcula el offset de sondeo
// para no releer mensajes ya procesados.

// API del task runner de n8n 2.x: aquí 'workflow' no está soportado
// (error "Unknown context type"); se usa 'global' con espacio de
// nombres propio, igual que el registro de Prospección IA.
const raiz = $getWorkflowStaticData('global');
if (!raiz.pedidos || typeof raiz.pedidos !== 'object') raiz.pedidos = {};
const sd = raiz.pedidos;

if (!Array.isArray(sd.whitelist)) sd.whitelist = [];
if (!Array.isArray(sd.log)) sd.log = [];
if (!sd.pendientes || typeof sd.pendientes !== 'object') sd.pendientes = {};
if (typeof sd.seq !== 'number') sd.seq = 1;

// Limpieza: pedidos antiguos ya cerrados (más de 30 días) no ocupan memoria.
const limite = Date.now() - 30 * 86400000;
for (const pid of Object.keys(sd.pendientes)) {
  const p = sd.pendientes[pid];
  if (p.ts < limite && p.estado !== 'pendiente') delete sd.pendientes[pid];
}

return [{ json: { offset: typeof sd.offset === 'number' ? sd.offset : 0 } }];
