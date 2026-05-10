const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');

const LIMITE_MENSAJES_MES = 100; // protección de costos — el desarrollador financia todos los créditos
const ALLOWED_ORIGINS = [
  'https://afrancoallen-hub.github.io',
  'https://faro-e4410.web.app',
  'https://faro-e4410.firebaseapp.com',
];

exports.asistente = onRequest(
  { region: 'us-central1', timeoutSeconds: 60, memory: '256MiB', invoker: 'public' },
  async (req, res) => {
    const origin = req.headers.origin || '';
    const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    res.set('Access-Control-Allow-Origin', allowedOrigin);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    // 1. Verificar Firebase Auth token (header o body — Firebase Hosting stripea el header en rewrites a Cloud Run)
    const authHeader = req.headers.authorization || '';
    const tokenFromHeader = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const tokenFromBody = req.body && typeof req.body.idToken === 'string' ? req.body.idToken : null;
    const idToken = tokenFromHeader || tokenFromBody;

    console.log(`[auth] header=${!!tokenFromHeader} body=${!!tokenFromBody} tokenLen=${idToken ? idToken.length : 0}`);

    if (!idToken) return res.status(401).json({ error: 'token_requerido' });

    let uid;
    try {
      const decoded = await admin.auth().verifyIdToken(idToken);
      uid = decoded.uid;
      console.log(`[auth] OK uid=${uid}`);
    } catch (authErr) {
      console.error(`[auth] FAIL code=${authErr.code} msg=${authErr.message}`);
      return res.status(401).json({ error: 'token_invalido', detalle: authErr.code });
    }

    const db = admin.firestore();

    // 2. Verificar y decrementar límite de mensajes (transacción atómica)
    const ahora = new Date();
    const periodo = `${ahora.getFullYear()}-${String(ahora.getMonth() + 1).padStart(2, '0')}`;
    const usoRef = db.doc(`usuarios/${uid}/uso_ia/${periodo}`);

    const conteoActual = await db.runTransaction(async (tx) => {
      const usoDoc = await tx.get(usoRef);
      const uso = usoDoc.exists ? usoDoc.data() : { mensajes: 0, periodo };
      if (uso.mensajes >= LIMITE_MENSAJES_MES) return null;
      tx.set(usoRef, {
        mensajes: uso.mensajes + 1,
        periodo,
        ultimoUso: admin.firestore.FieldValue.serverTimestamp(),
      });
      return uso.mensajes + 1;
    });

    if (conteoActual === null) {
      const renovacion = new Date(ahora.getFullYear(), ahora.getMonth() + 1, 1).toISOString();
      return res.status(429).json({
        error: 'limite_alcanzado',
        mensaje: `Alcanzaste tu límite de ${LIMITE_MENSAJES_MES} mensajes este mes.`,
        renovacion,
        mensajes_restantes: 0,
      });
    }

    // 4. Obtener contexto financiero completo en paralelo
    const [perfilDoc, transSnap, metasSnap, patrimonioDoc] = await Promise.all([
      db.doc(`usuarios/${uid}`).get(),
      db.collection(`usuarios/${uid}/transacciones`)
        .orderBy('creadoEn', 'desc')
        .limit(40)
        .get(),
      db.collection(`usuarios/${uid}/metas`).where('activa', '!=', false).get(),
      db.doc(`usuarios/${uid}/patrimonio/resumen`).get(),
    ]);

    const perfil = perfilDoc.data() || {};
    const transacciones = transSnap.docs.map((d) => d.data());
    const metas = metasSnap.docs.map((d) => d.data());
    const patrimonio = patrimonioDoc.data() || {};

    // 5. Validar el body del request
    const { mensaje, historial = [], modo } = req.body;
    if (!mensaje || typeof mensaje !== 'string' || mensaje.trim().length === 0) {
      return res.status(400).json({ error: 'mensaje_requerido' });
    }
    if (mensaje.length > 2000) {
      return res.status(400).json({ error: 'mensaje_demasiado_largo' });
    }
    if (!Array.isArray(historial) || historial.length > 20) {
      return res.status(400).json({ error: 'historial_invalido' });
    }

    // 6. Construir system prompt (candidato a prompt caching)
    const systemPrompt = buildSystemPrompt(perfil, transacciones, metas, patrimonio, modo);

    // 7. Llamar a Anthropic con prompt caching activado
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const historialValido = historial
      .slice(-8)
      .filter((m) => m.role && typeof m.content === 'string')
      .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content.slice(0, 4000) }));

    let respuesta;
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: [
          {
            type: 'text',
            text: systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: [
          ...historialValido,
          { role: 'user', content: mensaje.trim() },
        ],
      });
      respuesta = response.content[0].text;
    } catch (err) {
      if (err.status === 529 || err.status === 503) {
        return res.status(503).json({
          error: 'ia_no_disponible',
          mensaje: 'El servicio de IA está temporalmente sobrecargado. Intenta en 30 segundos.',
        });
      }
      console.error('Error Anthropic:', err.message);
      return res.status(500).json({ error: 'error_interno' });
    }

    return res.status(200).json({
      respuesta,
      mensajes_restantes: LIMITE_MENSAJES_MES - conteoActual,
    });
  }
);

function buildSystemPrompt(perfil, transacciones, metas, patrimonio, modo) {
  const hoy = new Date().toLocaleDateString('es-CL', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const ingresoTotal = (+perfil.ingreso || 0) + (+perfil.ingresoAdicional || 0);
  const gastosFijos = Object.values(perfil.gastos || {}).reduce((a, b) => a + (+b || 0), 0);

  // Resumen de los últimos 30 días de transacciones
  const hace30dias = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const txRecientes = transacciones.filter((t) => new Date(t.fecha) >= hace30dias);
  const gastosMes = txRecientes.filter((t) => t.tipo === 'gasto').reduce((s, t) => s + (+t.monto || 0), 0);
  const ingresosMes = txRecientes.filter((t) => t.tipo === 'ingreso').reduce((s, t) => s + (+t.monto || 0), 0);

  // Gastos por categoría este mes
  const porCategoria = txRecientes
    .filter((t) => t.tipo === 'gasto')
    .reduce((acc, t) => { acc[t.categoria] = (acc[t.categoria] || 0) + (+t.monto || 0); return acc; }, {});
  const topCategorias = Object.entries(porCategoria)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([cat, monto]) => `  - ${cat}: $${monto.toLocaleString('es-CL')}`)
    .join('\n');

  const netWorth = patrimonio.netWorth || 0;
  const totalActivos = patrimonio.totalActivos || 0;
  const totalPasivos = patrimonio.totalPasivos || 0;

  // Detalle de pasivos relevante para consejos de deuda
  const tarjetas = (patrimonio.pasivos?.tarjetas || []);
  const detalleDeudas = [
    ...(patrimonio.pasivos?.creditoHipotecario
      ? [`  - Hipoteca ${patrimonio.pasivos.creditoHipotecario.banco}: saldo $${(patrimonio.pasivos.creditoHipotecario.saldoDeuda || 0).toLocaleString('es-CL')}, cuota $${(patrimonio.pasivos.creditoHipotecario.cuotaMensual || 0).toLocaleString('es-CL')}/mes`]
      : []),
    ...tarjetas.map((t) => `  - Tarjeta ${t.banco} ${t.nombre}: deuda $${(t.deudaActual || 0).toLocaleString('es-CL')}, tasa ${t.tasaMensual || '?'}% mensual`),
    ...(patrimonio.pasivos?.creditosConsumo || []).map((c) => `  - Crédito consumo ${c.banco}: saldo $${(c.saldoDeuda || 0).toLocaleString('es-CL')}`),
  ].join('\n') || '  Sin deudas registradas';

  const metasActivas = metas
    .filter((m) => m.objetivo > 0)
    .map((m) => `  - ${m.label}: objetivo $${(m.objetivo || 0).toLocaleString('es-CL')}, ahorrado $${(m.ahorrado || 0).toLocaleString('es-CL')} (${Math.round(((m.ahorrado || 0) / (m.objetivo || 1)) * 100)}%)`)
    .join('\n') || '  Sin metas definidas';

  // Contexto según el módulo desde donde se consulta
  const contextoModulo = modo === 'patrimonio'
    ? '\nCONTEXTO: El usuario está viendo su módulo de PATRIMONIO. Enfoca tus respuestas en estrategias de balance sheet: optimización de deudas, rentabilización de activos, crecimiento del net worth.'
    : modo === 'flujos'
    ? '\nCONTEXTO: El usuario está viendo su módulo de FLUJOS. Enfoca tus respuestas en cash flow: patrones de gasto, presupuesto, categorías fuera de control, timing de pagos.'
    : '';

  return `Eres FARO, el co-piloto financiero personal de ${perfil.nombre || 'este usuario'} en Chile. Hoy es ${hoy}.
${contextoModulo}

## PERFIL
- ${perfil.nombre}, ${perfil.edad || '?'} años, ${perfil.estadoCivil || 'estado civil no informado'}, ${perfil.hijos ? `${perfil.hijos} hijos` : 'sin hijos'}
- Empleo: ${perfil.empleo} | País: ${perfil.pais} | Tolerancia riesgo: ${perfil.toleranciaRiesgo || 5}/10

## FLUJOS MENSUALES
- Ingreso mensual: $${ingresoTotal.toLocaleString('es-CL')} CLP
- Gastos fijos declarados: $${gastosFijos.toLocaleString('es-CL')} CLP
- Gastos reales (últimos 30d): $${gastosMes.toLocaleString('es-CL')} CLP
- Ingresos registrados (últimos 30d): $${ingresosMes.toLocaleString('es-CL')} CLP
- Flujo neto estimado: $${(ingresoTotal - gastosMes).toLocaleString('es-CL')} CLP

## TOP CATEGORÍAS DE GASTO (últimos 30 días)
${topCategorias || '  Sin transacciones registradas'}

## PATRIMONIO NETO: $${netWorth.toLocaleString('es-CL')} CLP
- Activos totales: $${totalActivos.toLocaleString('es-CL')}
- Pasivos totales: $${totalPasivos.toLocaleString('es-CL')}

### Detalle de deudas
${detalleDeudas}

## METAS (${metas.length} activas)
${metasActivas}

## INSTRUCCIONES
1. Responde en español chileno directo. Sin rodeos, sin frases vacías como "¡Excelente pregunta!".
2. Usa montos en CLP con formato local: $1.200.000 (no $1200000).
3. Sé específico con números. Si hay deudas, calcula el costo real en intereses. Si hay metas, calcula cuánto falta y en cuánto tiempo.
4. Si el usuario pide metas o un plan, propón 2-3 metas concretas con pasos específicos y plazos reales.
5. Si falta información relevante para responder bien, pídela directamente.
6. Máximo 3 párrafos salvo que el usuario pida un análisis detallado.
7. Nunca inventes datos que no están en el perfil.`;
}
