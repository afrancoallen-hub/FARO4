const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');
const Busboy = require('busboy');
const XLSX = require('xlsx');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://afrancoallen-hub.github.io';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_CONTENT_CHARS = 40000;

exports.procesarCartola = onRequest(
  { region: 'us-central1', timeoutSeconds: 120, memory: '512MiB' },
  async (req, res) => {
    res.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');

    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    // 1. Verificar Auth token
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) return res.status(401).json({ error: 'token_requerido' });

    try {
      await admin.auth().verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ error: 'token_invalido' });
    }

    // 2. Leer el archivo multipart
    let fileBuffer, fileName, banco;
    try {
      ({ fileBuffer, fileName, banco } = await readMultipart(req));
    } catch (err) {
      return res.status(400).json({ error: 'archivo_invalido', mensaje: err.message });
    }

    if (fileBuffer.length > MAX_FILE_SIZE) {
      return res.status(400).json({ error: 'archivo_demasiado_grande', mensaje: 'El archivo no puede superar 5MB.' });
    }

    // 3. Convertir a texto plano
    let contenidoTexto;
    try {
      const ext = (fileName || '').toLowerCase();
      if (ext.endsWith('.csv')) {
        contenidoTexto = fileBuffer.toString('utf-8');
      } else {
        // xlsx / xls
        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        contenidoTexto = XLSX.utils.sheet_to_csv(sheet);
      }
    } catch {
      return res.status(400).json({
        error: 'formato_no_soportado',
        mensaje: 'No se pudo leer el archivo. Asegúrate de subir un archivo Excel (.xls, .xlsx) o CSV.',
      });
    }

    // Truncar si es muy largo
    if (contenidoTexto.length > MAX_CONTENT_CHARS) {
      contenidoTexto = contenidoTexto.slice(0, MAX_CONTENT_CHARS);
    }

    // 4. Llamar a Claude Haiku para extraer transacciones
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    let resultado;
    try {
      const response = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 4096,
        messages: [
          {
            role: 'user',
            content: buildCartolaPrompt(banco || 'banco', contenidoTexto),
          },
        ],
      });

      const jsonText = response.content[0].text.trim();
      // Extraer el JSON aunque venga con texto extra
      const match = jsonText.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Respuesta sin JSON válido');
      resultado = JSON.parse(match[0]);
    } catch (err) {
      console.error('Error procesando cartola:', err.message);
      return res.status(500).json({
        error: 'error_procesamiento',
        mensaje: 'No se pudo analizar el archivo. Intenta con un archivo diferente o ingresa las transacciones manualmente.',
      });
    }

    // 5. Validar y limpiar las transacciones extraídas
    const transacciones = (resultado.transacciones || [])
      .filter((t) => t.fecha && t.monto && t.tipo)
      .map((t) => ({
        fecha: t.fecha,
        monto: Math.abs(Number(t.monto)) || 0,
        tipo: t.tipo === 'ingreso' ? 'ingreso' : 'gasto',
        categoria: t.categoria || 'otros',
        desc: (t.desc || '').slice(0, 100),
        moneda: t.moneda || 'CLP',
        fuente: `cartola_${(banco || 'banco').toLowerCase().replace(/\s+/g, '_')}`,
      }))
      .filter((t) => t.monto > 0);

    return res.status(200).json({
      transacciones,
      advertencias: resultado.advertencias || [],
      total: transacciones.length,
    });
  }
);

function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const chunks = [];
    let fileName = '';
    let banco = '';

    busboy.on('file', (fieldname, file, info) => {
      fileName = info.filename || '';
      file.on('data', (chunk) => chunks.push(chunk));
    });

    busboy.on('field', (name, value) => {
      if (name === 'banco') banco = value;
    });

    busboy.on('finish', () => {
      if (chunks.length === 0) return reject(new Error('No se recibió ningún archivo.'));
      resolve({ fileBuffer: Buffer.concat(chunks), fileName, banco });
    });

    busboy.on('error', reject);
    req.pipe(busboy);
  });
}

function buildCartolaPrompt(banco, csv) {
  return `Analiza esta cartola bancaria de ${banco.toUpperCase()} exportada en formato CSV/Excel y extrae TODAS las transacciones.

CARTOLA:
\`\`\`
${csv}
\`\`\`

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional antes ni después:
{
  "transacciones": [
    {
      "fecha": "YYYY-MM-DD",
      "monto": 50000,
      "tipo": "gasto",
      "categoria": "alimentacion",
      "desc": "SUPERMERCADO LIDER",
      "moneda": "CLP"
    }
  ],
  "advertencias": []
}

REGLAS:
- "tipo": "ingreso" si es abono/depósito/crédito, "gasto" si es cargo/débito/retiro
- "monto": siempre número positivo
- "fecha": formato ISO YYYY-MM-DD estricto
- "categoria": una de: alimentacion, transporte, arriendo, salud, educacion, entretenimiento, serviciosBasicos, restaurante, vestuario, tecnologia, deuda, inversion, otros
- Ignora filas de saldo, encabezados, totales — solo transacciones reales
- Incluye transferencias entre cuentas con categoria "transferencia"
- Si no puedes interpretar una fila, agrégala a "advertencias" con descripción
- "desc": nombre del comercio o descripción de la transacción, máximo 80 caracteres`;
}
