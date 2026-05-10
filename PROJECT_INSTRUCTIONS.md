# FARO — Project Instructions
> Documento de contexto base para sesiones de Claude. Refleja el estado real del código y las decisiones tomadas. Actualizar tras cada sprint.

---

## 1. Visión General

**FARO** es un co-piloto financiero personal para Chile y LatAm. Combina seguimiento de flujos, metas financieras, patrimonio neto y un asesor con IA contextualizado en las finanzas reales del usuario. No es un chatbot genérico — la IA recibe el perfil completo, transacciones recientes, deudas y metas antes de responder.

**Propuesta de valor:** "Tu situación financiera real + inteligencia artificial = decisiones mejores." Sin API keys del usuario, sin setup técnico, sin consejos genéricos.

**Usuario objetivo:** Profesionales chilenos 25–45 años, ingresos medios-altos, que quieren orden financiero pero no tienen asesor privado.

**Modelo de negocio:** Freemium SaaS.
- Plan gratuito: 3 mensajes IA/mes (pendiente de implementar), funcionalidades base
- Plan FARO Base: $7.990 CLP/mes → acceso completo al Asesor IA (50 msg/mes)
- Costo IA por usuario: ~$0.15 USD/mes máximo → margen bruto ~98%

**Nombre:** FARO (definitivo por ahora). `faro.cl` y `faroapp.cl` están tomados. Alternativas evaluadas: GUÍA, AXIA, VALIA, SOFÍA, ARIA. Dominio objetivo: `faro.app` o `mifaro.cl`.

---

## 2. Estado Actual

### ✅ Funcionando en producción
- Firebase Auth (registro + login con email/password)
- Onboarding de 5 pasos (perfil completo → Firestore)
- Dashboard con puntaje financiero (0–100) y alertas
- Módulo Transacciones (CRUD, categorías, filtros)
- Módulo Metas (creación, seguimiento de progreso)
- Módulo Configuración (editar perfil)
- Asesor IA (Cloud Function → Anthropic API) — **requiere créditos Anthropic**
- Firebase Hosting con rewrites a Cloud Run
- Firestore Security Rules (solo el dueño lee/escribe sus datos)

### 🔴 Bloqueante inmediato
- **Créditos Anthropic agotados** → el Asesor IA devuelve 500. Recargar en `console.anthropic.com/settings/billing`

### 🟡 Pendiente de implementar
- Freemium: 3 mensajes gratis para usuarios sin suscripción activa
- Sistema de cobro (Flow.cl o Stripe) → actualmente `suscripcion/estado` se crea manual en Firestore
- Módulo Patrimonio (Net Worth) — estructura Firestore existe, UI pendiente
- UI de upload de cartola bancaria — Cloud Function `procesarCartola` existe, falta el frontend
- PWA icon-192.png faltante (404 en consola)
- Migrar de Babel in-browser a build process (deuda técnica)

### 🟢 Sprint 2 (siguiente)
- Módulo Patrimonio completo (activos + pasivos + gráfico evolución)
- Cartola upload UI con drag & drop
- Dashboard mejorado (gráfico de gastos por categoría)

---

## 3. Stack Técnico

| Capa | Tecnología | Notas |
|------|-----------|-------|
| Frontend | React 18 (CDN UMD) + Babel Standalone | Single HTML file. Deuda técnica: no hay build process |
| Fonts | Google Fonts: Fraunces + Plus Jakarta Sans | Cargadas por CDN |
| Auth | Firebase Auth v10.14.1 (modular SDK) | Email/password únicamente |
| Database | Firestore (Firebase) | Reglas por UID, Admin SDK solo escribe suscripcion/uso_ia |
| Hosting | Firebase Hosting | Proyecto: `faro-e4410` |
| Functions | Firebase Cloud Functions v2 (Node.js 20, 2nd Gen) | Región: us-central1 |
| AI | Anthropic API — modelo `claude-sonnet-4-5` | Via Cloud Function proxy, prompt caching activado |
| Secrets | Firebase Secret Manager | `ANTHROPIC_API_KEY` guardada como secreto |
| Runtime | Cloud Run (subyacente a Functions v2) | invoker: 'public' — auth manejada por la función |
| Secondary hosting | GitHub Pages (`afrancoallen-hub.github.io/FARO4/`) | Espejo del mismo index.html |

**Dependencias functions/package.json:**
```json
"@anthropic-ai/sdk": "^0.27.0"
"busboy": "^1.6.0"
"firebase-admin": "^12.0.0"
"firebase-functions": "^6.0.0"
"xlsx": "^0.18.5"
```
`devDependencies: {}` — vacío a propósito (firebase-functions-test causaba conflictos con npm ci en Cloud Build).

---

## 4. Arquitectura

### Estructura de archivos
```
FARO4/
├── index.html                  # App completa (React + Firebase SDK + lógica)
├── firebase.json               # Hosting rewrites + functions config
├── firestore.rules             # Security rules
├── firestore.indexes.json      # Índice compuesto: tipo ASC + creadoEn DESC
├── manifest.webmanifest        # PWA manifest
├── sw.js                       # Service Worker (PWA)
├── icon-192.png                # FALTANTE — causa 404
└── functions/
    ├── package.json
    ├── package-lock.json       # Regenerado limpio (sin jest)
    └── src/
        ├── index.js            # Entry point: admin.initializeApp() + exports
        ├── asistente.js        # Asesor IA — proxy Anthropic
        └── procesarCartola.js  # Parser de cartolas bancarias (Excel/PDF)
```

### Flujo de datos — Asesor IA
```
Browser (index.html)
  → getIdToken()                          # Firebase Auth JWT
  → POST /api/asistente                   # Header + body.idToken
    → Firebase Hosting rewrite
      → Cloud Run "asistente" (us-central1)
        → verifyIdToken(idToken)          # Firebase Admin SDK
        → Firestore: suscripcion/estado   # Verificar plan activo
        → Firestore: uso_ia/{periodo}     # Atomic counter (transacción)
        → Firestore: perfil+txns+metas+patrimonio  # Contexto financiero
        → Anthropic API (claude-sonnet-4-5)        # Con prompt caching
        → Response: { respuesta, mensajes_restantes }
```

### Firestore Schema
```
usuarios/{uid}
  ├── [document fields]: nombre, email, edad, empleo, pais, ingreso,
  │   ingresoAdicional, moneda, frecuencia, estadoCivil, hijos,
  │   gastos{}, metas[], ahorro, deuda, toleranciaRiesgo, perfilCompletado
  ├── transacciones/{txId}: tipo, monto, categoria, descripcion, fecha, creadoEn
  ├── metas/{metaId}: label, objetivo, ahorrado, activa
  ├── patrimonio/resumen: netWorth, totalActivos, totalPasivos,
  │   activos{}, pasivos{creditoHipotecario, tarjetas[], creditosConsumo[]}
  ├── suscripcion/estado: estado("activa"|"inactiva"), plan("base")
  │   → Solo lectura para el usuario. Escritura: Admin SDK únicamente.
  └── uso_ia/{YYYY-MM}: mensajes(int), periodo, ultimoUso(timestamp)
      → Solo lectura para el usuario. Escritura: Admin SDK únicamente.
```

### Módulos del frontend (vistas)
| ID | Componente | Estado |
|----|-----------|--------|
| `panel` | Panel Principal (dashboard) | ✅ Completo |
| `transacciones` | CRUD de transacciones | ✅ Completo |
| `asesor` | AsesorIA (chat) | ✅ Completo (necesita créditos) |
| `metas` | Mis Metas | ✅ Completo |
| `configuracion` | Configuración de perfil | ✅ Completo |
| `patrimonio` | Net Worth (activos/pasivos) | 🔴 UI pendiente |

---

## 5. Funciones Cloud (API)

### `asistente` — POST /api/asistente
- **Auth:** Firebase ID token en `Authorization: Bearer` Y en `body.idToken` (Firebase Hosting stripea el header en rewrites a Cloud Run — CRÍTICO)
- **Config:** `invoker: 'public'`, `memory: 256MiB`, `timeout: 60s`, `region: us-central1`
- **Rate limit:** 50 mensajes/mes por usuario (atómico en Firestore)
- **Requisito:** `usuarios/{uid}/suscripcion/estado` con `estado === 'activa'`
- **Contexto enviado a Claude:** perfil completo + últimas 40 transacciones + metas activas + patrimonio/resumen
- **Prompt caching:** activado (`cache_control: { type: 'ephemeral' }` en system prompt)
- **Modo contextual:** `body.modo` = `'patrimonio'` | `'flujos'` | undefined → ajusta el system prompt
- **Response:** `{ respuesta: string, mensajes_restantes: number }`

### `procesarCartola` — POST /api/procesarCartola
- **Auth:** Solo header Authorization (pendiente: agregar body.idToken como fallback igual que asistente)
- **Config:** `memory: 512MiB`, `timeout: 120s`
- **Input:** multipart/form-data con archivo (Excel/PDF) + campo `banco`
- **Límites:** 5MB max, 40.000 chars de contenido procesado
- **Estado:** Backend completo. UI de upload pendiente.
- **CORS:** Solo acepta `ALLOWED_ORIGIN` (no tiene multi-origen todavía — BUG PENDIENTE)

---

## 6. Decisiones Clave — NO Revertir

1. **Token en body + header:** `body.idToken` es obligatorio. Firebase Hosting stripea el header `Authorization` en rewrites a Cloud Run (v2). Si se quita del body, los requests fallan con 401 antes de llegar al código.

2. **`invoker: 'public'`:** Cloud Run requiere IAM auth por defecto. Las funciones manejan su propia autenticación (Firebase Auth), por lo tanto Cloud Run debe ser público a nivel IAM.

3. **Rewrite con formato `"run"` (no `"function"`):** Firebase Hosting para Cloud Functions v2 usa `"run": { "serviceId": "...", "region": "..." }`. El formato `"function"` es solo para v1 y da 404 silencioso.

4. **`devDependencies: {}`:** firebase-functions-test introduce jest en el árbol de dependencias y rompe `npm ci` en Cloud Build. No agregar devDependencies sin regenerar package-lock.json.

5. **Admin SDK solo escribe `suscripcion` y `uso_ia`:** Las Firestore Rules tienen `allow write: if false` para estos paths desde el cliente. Nunca dar acceso de escritura al cliente en estas colecciones.

6. **Prompt caching activado:** Reduce costo ~80% en requests frecuentes. El system prompt con el perfil completo se cachea. No mover los datos del usuario a los mensajes de usuario.

7. **`serviceId: "procesarcartola"` (minúsculas):** Cloud Run convierte nombres de funciones a lowercase. `procesarCartola` → `procesarcartola` en el serviceId del rewrite.

---

## 7. Seguridad

- **Firestore Rules:** Solo el usuario dueño (por UID) puede leer/escribir sus datos. Todo lo demás denegado.
- **API Key Anthropic:** Guardada como Firebase Secret (`ANTHROPIC_API_KEY`), nunca en el código ni en el cliente.
- **Firebase API Key en index.html:** Es pública intencionalmente (Firebase design). La seguridad está en Auth + Firestore Rules.
- **No hay CORS en `procesarCartola`:** BUG — solo acepta el origen de GitHub Pages. Falla desde `faro-e4410.web.app`. Mismo fix que `asistente`: agregar ALLOWED_ORIGINS array.

---

## 8. Negocio

### Decisiones tomadas
- Precio: $7.990 CLP/mes (≈$8.5 USD)
- Límite IA: 50 msg/mes/usuario en plan pagado
- Freemium: 3 mensajes gratis (lógica pendiente en `asistente.js`)
- Mercado inicial: Chile (CLP, español chileno, tramos de impuestos Chile)
- Cobro: Flow.cl (preferido para Chile) o Stripe — no implementado
- Activación de suscripción: manual en Firestore por ahora (MVP)

### Métricas de costo IA
- Costo por mensaje: ~$0.003 USD (Claude Sonnet)
- Costo máximo por usuario/mes (50 msg): ~$0.15 USD
- Margen bruto estimado: ~98% por usuario

### Pendiente de negocio
- Integración Flow.cl/Stripe → escritura automática en `suscripcion/estado` vía webhook
- Lógica freemium en función (verificar si `estado !== 'activa'` y permitir hasta 3 msg gratis con contador separado)
- Landing page de marketing
- Sistema de referidos

---

## 9. Problemas Conocidos / Deuda Técnica

| Problema | Impacto | Prioridad |
|---------|---------|-----------|
| Créditos Anthropic agotados | Asesor IA no funciona | 🔴 Inmediato |
| `icon-192.png` faltante | PWA warning en consola | 🟡 Bajo |
| Babel in-browser | No apto para producción a escala, lento en carga | 🟡 Sprint 3 |
| `procesarCartola` CORS incompleto | No acepta requests desde `faro-e4410.web.app` | 🟡 Antes de activar UI |
| `procesarCartola` sin body.idToken fallback | 401 desde Firebase Hosting igual que asistente tenía | 🟡 Junto con CORS fix |
| Node.js 20 deprecado (30 abril 2026) | Decommission: 30 oct 2026 | 🟡 Antes de oct 2026 |
| `firebase-functions` package desactualizado | Warning en deploy | 🟢 Bajo |
| Service Worker puede cachear versiones viejas | Usuarios ven código antiguo | 🟡 Agregar versioning |
| Single HTML file (~1900 líneas) | Mantenibilidad baja | 🟢 Sprint 4+ |

---

## 10. Convenciones

### Código
- **Idioma:** Español en UI, variables y comentarios. Inglés solo en nombres técnicos estándar (`useState`, `async/await`, etc.)
- **Montos:** Siempre `toLocaleString('es-CL')` para display. Almacenar como número en Firestore.
- **Fechas:** ISO string (`new Date().toISOString()`) para almacenamiento. `toLocaleDateString('es-CL')` para display.
- **Error codes:** snake_case en español: `token_requerido`, `suscripcion_requerida`, `limite_alcanzado`
- **Firestore paths:** `usuarios/{uid}/coleccion/{docId}` — nunca colecciones raíz para datos de usuario

### Git (pendiente — no hay commits todavía)
- Conventional commits: `feat:`, `fix:`, `deploy:`, `refactor:`
- Branch principal: `main`
- No hay CI/CD configurado — deploy manual con `firebase deploy`

### Deploy
```bash
# Solo hosting (cambios en index.html, firebase.json):
firebase deploy --only hosting

# Solo función asistente:
firebase deploy --only functions:asistente

# Todo:
firebase deploy
```

---

## 11. URLs y Recursos

| Recurso | URL |
|---------|-----|
| App (producción) | https://faro-e4410.web.app |
| App (espejo GitHub Pages) | https://afrancoallen-hub.github.io/FARO4/ |
| Firebase Console | https://console.firebase.google.com/project/faro-e4410 |
| Firestore Console | https://console.firebase.google.com/project/faro-e4410/firestore |
| Functions Logs | https://console.firebase.google.com/project/faro-e4410/functions/logs |
| Cloud Run Console | https://console.cloud.google.com/run?project=faro-e4410 |
| Anthropic Billing | https://console.anthropic.com/settings/billing |
| Function asistente (directo) | https://asistente-rzzw3rnsjq-uc.a.run.app |
| Function procesarCartola (directo) | https://procesarcartola-rzzw3rnsjq-uc.a.run.app |
| Firebase proyecto ID | `faro-e4410` |
| Firebase proyecto número | `662713689980` |

---

## 12. Roadmap Completo del Negocio

> Cubre producto, tecnología, legal, seguridad, marketing, operaciones y finanzas. Organizado por fase de madurez, no solo por sprint técnico.

---

### FASE 0 — Desbloquear el MVP (esta semana)

**Producto / Técnico**
- [ ] Recargar créditos Anthropic ($20–50 USD) → `console.anthropic.com/settings/billing`
- [ ] Implementar freemium: 3 msg gratis en `asistente.js` para usuarios sin suscripción activa
- [ ] Fix CORS + `body.idToken` en `procesarCartola` (clonar patrón de `asistente.js`)
- [ ] Crear `icon-192.png` para eliminar el error 404 del PWA

**Seguridad mínima**
- [ ] Configurar spending limit mensual en Anthropic (evitar facturas sorpresa)
- [ ] Configurar Firebase budget alerts en Google Cloud Console

---

### FASE 1 — MVP Lanzable (2–4 semanas)

**Producto / Técnico**
- [ ] Módulo Patrimonio UI: activos + pasivos + net worth + gráfico de evolución
- [ ] Cartola upload UI (drag & drop → `procesarCartola` → importar transacciones)
- [ ] Dashboard mejorado: gráfico de gastos por categoría (últimos 30 días)
- [ ] Modo oscuro / responsividad móvil completa
- [ ] Migrar Babel CDN → Vite (o similar) para cargas más rápidas
- [ ] Versioning del Service Worker (evitar que usuarios vean código cacheado antiguo)

**Pagos y suscripciones**
- [ ] Integrar Flow.cl (mercado chileno) o Stripe (internacional)
- [ ] Webhook de pago → escribe `suscripcion/estado: "activa"` vía Admin SDK
- [ ] Página de pricing dentro de la app (plan gratis vs. plan FARO)
- [ ] Manejo de cancelación y expiración de suscripción
- [ ] Gestión de pagos fallidos (reintentos, notificación al usuario)

**Legal (obligatorio antes de cobrar)**
- [ ] Definir estructura legal: persona natural (boletas) vs. SpA (empresa)
- [ ] Términos y Condiciones de uso (redactar o usar template + adaptar)
- [ ] Política de Privacidad — cumplimiento Ley 19.628 (protección datos Chile)
- [ ] Disclaimer financiero: FARO no es asesor financiero licenciado, es una herramienta de apoyo
- [ ] Definir qué datos se guardan, por cuánto tiempo, y cómo se pueden eliminar (derecho al olvido)

**Identidad y marca**
- [ ] Decisión definitiva de nombre (FARO u alternativa con IA: GUÍA, AXIA, ARIA, etc.)
- [ ] Registro de dominio (`faro.app`, `mifaro.cl` u opción elegida)
- [ ] Logo y paleta de colores (actualmente solo tipografía + color accent #111)
- [ ] Favicon y meta tags OG (para compartir en redes)

---

### FASE 2 — Primeros usuarios pagados (1–2 meses)

**Adquisición de usuarios**
- [ ] Landing page independiente (separada de la app): propuesta de valor, pricing, CTA
- [ ] SEO básico: title tags, meta descriptions, keywords financieras Chile
- [ ] Perfil en Product Hunt para lanzamiento
- [ ] Post en comunidades: r/finanzaspersonales, grupos FB/LinkedIn Chile finanzas
- [ ] Contenido orgánico: 1 hilo en X/Twitter o LinkedIn explicando el problema que resuelve FARO

**Retención y activación**
- [ ] Email de bienvenida al registrarse (Firebase → trigger → email via SendGrid/Resend)
- [ ] Secuencia de onboarding: 3 emails en 7 días (activar perfil → primera transacción → usar asesor)
- [ ] Notificación en-app si el usuario no ha registrado transacciones en 7 días
- [ ] Sistema de referidos: código único por usuario, 1 mes gratis al referir a alguien que pague

**Analytics**
- [ ] Google Analytics 4 o Mixpanel (eventos clave: registro, completar onboarding, primer mensaje IA, suscripción)
- [ ] Dashboard interno de métricas: MRR, churn, usuarios activos, mensajes IA consumidos
- [ ] Definir North Star Metric (sugerido: "usuarios que completan perfil Y envían ≥1 mensaje IA/semana")

**Seguridad**
- [ ] Activar Firebase App Check (bloquea requests que no vienen de la app legítima)
- [ ] Rate limiting adicional en Cloud Functions (por IP, además del límite por usuario)
- [ ] Auditoría de Firestore Rules (revisar que no haya paths sin cubrir)
- [ ] Habilitar Cloud Armor o similar si hay ataques de fuerza bruta en Auth

---

### FASE 3 — Crecimiento y expansión (3–6 meses)

**Producto**
- [ ] App móvil nativa (React Native o Flutter) o PWA installable mejorada
- [ ] Conexión bancaria directa (Fintoc API para Chile — open banking)
- [ ] Alertas automáticas: gasto inusual en categoría, meta próxima a vencer
- [ ] Reportes mensuales automáticos (PDF o email con resumen financiero del mes)
- [ ] Modo familiar / pareja (finanzas compartidas)
- [ ] Módulo de inversiones: portafolio básico, seguimiento de acciones/fondos mutuos
- [ ] Calculadora de impuestos mejorada (integrar con SII si hay API)

**Expansión geográfica**
- [ ] Adaptar para México (MXN, tramos ISR, bancos locales)
- [ ] Adaptar para Colombia (COP, DIAN, Nequi/Daviplata)
- [ ] Adaptar para Perú (PEN, SUNAT)
- [ ] Versión en inglés para LatAm expats

**Negocio**
- [ ] Plan Pro: $14.990 CLP/mes (más mensajes IA, conexión bancaria, reportes)
- [ ] Plan Familia: $19.990 CLP/mes (hasta 3 usuarios)
- [ ] Plan Anual con descuento (~2 meses gratis)
- [ ] Affiliate program: asesores financieros y contadores que recomienden FARO
- [ ] B2B: versión para empresas (beneficio para empleados como parte del paquete de compensación)

**Operaciones**
- [ ] Sistema de soporte al cliente (Intercom, Crisp o similar dentro de la app)
- [ ] Base de conocimiento / FAQ pública
- [ ] SLA definido: tiempo de respuesta a problemas críticos
- [ ] Runbook de incidentes: qué hacer si cae Firebase, si Anthropic tiene outage, si hay fuga de datos
- [ ] Backups periódicos de Firestore (Cloud Scheduler → export a Cloud Storage)
- [ ] Monitoring y alertas: Uptime checks, errores 5xx, latencia de funciones

**Finanzas del negocio**
- [ ] Proyección financiera 12 meses: usuarios, MRR, costos (Firebase, Anthropic, dominio, marketing)
- [ ] Breakeven: ¿cuántos usuarios pagados cubren costos fijos?
- [ ] Separar cuentas: cuenta bancaria exclusiva para FARO (no mezclar con finanzas personales)
- [ ] Facturación electrónica al SII (si hay ingresos formales)
- [ ] Evaluar levantar capital: ¿bootstrapped hasta cuántos usuarios? ¿angel round?

---

### Métricas clave a trackear desde el día 1

| Métrica | Definición | Objetivo mes 3 |
|---------|-----------|----------------|
| Registros | Cuentas creadas | 200 |
| Activación | % que completan onboarding | >60% |
| Conversión free→paid | % que suscriben en 30 días | >10% |
| MRR | Ingresos mensuales recurrentes | $150.000 CLP |
| Churn mensual | % que cancela por mes | <5% |
| Mensajes IA / usuario activo | Uso del feature core | >10/mes |
| CAC | Costo de adquirir un usuario pagado | <$3.000 CLP |
| LTV | Ingreso total por usuario (asumiendo 12 meses) | ~$95.880 CLP |

---

*Última actualización: Mayo 2026 — Roadmap completo de negocio agregado*
