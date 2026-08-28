# Plan de mejoras — cobertura de análisis de NEO

> Objetivo: subir **lo que NEO analiza y encuentra**, cerrando la brecha entre lo
> que ya demostró en assessments profundos (Britimp, Herimarc) y lo que el
> pipeline automático hace hoy. Cubre las mejoras de **alto y medio ROI** (1–6).
> Los items de tier pago (puertos, cloud storage, DNS security) quedan fuera de
> este plan.
>
> **Regla transversal (no negociable):** cada hallazgo nuevo debe mantener el
> pilar de *evidencia verificada, sin falsos positivos*. Nada se reporta sin
> prueba directa observada. Lo que no se puede verificar → "info", no "hallazgo".
> Dónde se implementa casi todo: la persona `free-scan.headless.patch.yml` (+ su
> gemela en `apps/cli/config/agent-presets/free-scan/agent.cordis.yml`) y el
> schema del informe (`websky/src/lib/scan/report.ts` + parseo del worker).

---

## ALTO ROI

### 1. Descubrimiento real de subdominios (Certificate Transparency)

**Qué:** hoy la persona resuelve una lista fija de ~12 subdominios → se pierde
todo lo demás. Certificate Transparency lista **todos** los subdominios que
alguna vez tuvieron un certificado.

**Cómo:**
- Consultar `https://crt.sh/?q=%25.<dominio>&output=json` (via `curl -sS` o
  `web_fetch`), extraer `name_value`, deduplicar, quitar wildcards.
- Resolver cada candidato (`dig +short`) y quedarse con los que resuelven.
- Probar HTTP/HTTPS solo en los vivos; sumarlos al mapa de superficie.
- Complementa (no reemplaza) la lista fija actual.

**Grounding:** solo reportar como superficie los subdominios que **resuelven y
responden**. Los que no resuelven → no van al informe (o "info").

**Impacto extra:** más hosts descubiertos = más superficie vigilada = **mayor
precio** (el pricing es por host). Sube ingreso y valor a la vez.

**Esfuerzo:** bajo. Es un bloque nuevo en el METHOD de la persona + el uso de
crt.sh. Nada de infraestructura.

---

### 2. Secretos en JavaScript / source maps

**Qué:** NEO ya encontró esto **a mano en Britimp** (OAuth secret activo, API key
de Google, código fuente completo por source maps). El free-scan automático no
lo busca. Es de los hallazgos de mayor impacto.

**Cómo:**
- Descargar el/los bundles JS del sitio principal (`curl -sS` sobre los `<script src>`).
- Buscar **source maps públicos**: pedir `<bundle>.js.map` — si devuelve 200 con
  contenido, el código fuente es descargable (hallazgo alto por sí solo).
- Escanear el JS (y los .map) por patrones de secretos: claves de API (Google
  `AIza…`, AWS `AKIA…`, Stripe `sk_live…`), tokens, `client_secret`,
  credenciales hardcodeadas, endpoints internos.
- Lista de patrones tipo *gitleaks/trufflehog* embebida en la persona.

**Grounding (crítico):** un string con forma de key **no es** un hallazgo hasta
verificar que es real/activo cuando se pueda (como en Britimp: NEO confirmó que
el OAuth secret era aceptado por el auth server). Placeholders, claves de test o
públicas por diseño (ej. claves publicables de Stripe/Firebase) → "info", no
"crítico". Distinguir clave pública de secreta.

**Esfuerzo:** medio. Requiere el bloque de descarga+regex en la persona y unos
5–10 patrones. NEO ya sabe el método.

---

### 3. Subdomain takeover

**Qué:** un subdominio con un `CNAME` que apunta a un servicio de terceros
muerto/huérfano (S3, GitHub Pages, Heroku, Azure, Cloudfront, Fastly…) puede ser
**secuestrado** por un atacante. Hallazgo de alto impacto.

**Cómo:**
- Para cada subdominio descubierto, obtener el `CNAME` (`dig CNAME +short`).
- Si apunta a un proveedor de terceros conocido, pedir la URL y buscar la
  **firma de takeover** (ej. `NoSuchBucket`, `There isn't a GitHub Pages site
  here`, `Fastly error: unknown domain`, `Repository not found`).
- Reportar solo si la firma está presente (recurso huérfano + reclamable).

**Grounding (crítico — acá abundan los falsos positivos):** un CNAME a un tercero
**no** es takeover por sí solo. Solo se reporta con la **firma de error
específica** observada. Sin firma → no se reporta. Basar la lista de firmas en
`can-i-take-over-xyz`.

**Esfuerzo:** medio. Bloque en la persona + una tabla de firmas por proveedor.

---

## MEDIO ROI

### 4. Exposición en filtraciones de datos (credenciales / dominio)

**Qué:** si los correos o el dominio del cliente aparecen en brechas de datos
públicas, sus credenciales pueden estar circulando. Muy tangible para el cliente.

**Cómo (decisión de fuente):**
- **Opción A — HaveIBeenPwned API** (de pago, ~US$4/mes por key): consulta por
  dominio (`/breacheddomain`) y devuelve cuentas afectadas. La más limpia.
- **Opción B — OSINT gratuito:** buscar el dominio en fuentes públicas de leaks.
  Más ruidoso y menos confiable.
- Recomendación: **Opción A** cuando haya presupuesto (una key sirve para todos
  los clientes); mientras tanto, marcar este item como "fase 2".

**Grounding + legalidad:** reportar solo la **existencia** de la exposición ("N
cuentas de tu dominio aparecen en la brecha X, año Y"), **nunca** las
credenciales en claro. No almacenar contraseñas.

**Esfuerzo:** medio (requiere integrar una fuente de datos / API key). Es el
único que necesita algo externo.

---

### 5. DKIM (completar el email auth)

**Qué:** hoy se analiza SPF y DMARC; falta DKIM. Sin DKIM, el correo del cliente
es más suplantable.

**Cómo:**
- Consultar TXT en selectores comunes: `default._domainkey.<dom>`,
  `google._domainkey`, `k1._domainkey`, `selector1/2._domainkey`, `s1/s2`.
- Verificar si existe al menos un registro DKIM válido.
- Integrar al bloque de "email auth" existente (junto a SPF/DMARC), con el mismo
  criterio de matiz (no alarmar si la postura es intencional).

**Grounding:** DKIM se descubre por selector; no encontrar un selector común **no
prueba** que no haya DKIM → framear como "no pudimos verificar DKIM desde
selectores comunes", no como "no tiene DKIM".

**Esfuerzo:** bajo. Unas líneas de `dig TXT` en la persona.

---

### 6. Flags de cookies + CORS

**Qué:** cookies sin `Secure`/`HttpOnly`/`SameSite` (robables por XSS/red) y CORS
mal configurado (reflejo de `Origin` arbitrario). NEO detectó el CORS en Britimp.

**Cómo:**
- **Cookies:** inspeccionar los `Set-Cookie` de las respuestas del login/app y
  verificar los flags.
- **CORS:** enviar `Origin: https://evil.example` y ver si
  `Access-Control-Allow-Origin` lo refleja + `Allow-Credentials: true`.

**Grounding (lección de Britimp):** CORS que devuelve un valor **estático** (no
refleja el Origin del atacante) **no es explotable** — NEO ya lo notó bien.
Reportar CORS solo cuando **refleja orígenes arbitrarios** con credenciales.
Cookies: matizar según sensibilidad de la cookie.

**Esfuerzo:** bajo. NEO ya tiene el método del assessment de Britimp.

---

## Cambios al schema del informe

Los tipos de hallazgo nuevos entran en el `findings[]` existente
(`report.ts`) — no hace falta cambiar la estructura, solo enriquecer las
categorías que NEO puede emitir. Sí conviene:
- Que `exposedSurface[]` refleje los subdominios nuevos de CT logs.
- Mantener el tope de findings y el truncado del worker.

## Orden de implementación sugerido

1. **CT logs (#1)** — desbloquea todo lo demás (más superficie = más objetivos
   para #2 y #3) y sube el precio. Empezar acá.
2. **Secretos en JS / source maps (#2)** — alto impacto, NEO ya sabe.
3. **Subdomain takeover (#3)** — alto impacto, cuidar el grounding.
4. **DKIM (#5)** y **cookies/CORS (#6)** — baratos, se hacen juntos.
5. **Breaches (#4)** — fase 2 (depende de la fuente de datos / API key).

## Consideraciones transversales

- **Falsos positivos:** #2, #3 y #6 son los más propensos. El grounding estricto
  de cada uno es parte del entregable, no un extra — es lo que vendemos.
- **Rendimiento:** CT logs y descarga de JS agregan tiempo al scan. Medir el
  impacto en la ventana (~15 min hoy); si se estira, mover lo más pesado (JS
  deep-scan, breaches) al **tier pago**, dejando el free-scan liviano.
- **Free vs pago:** #1, #5, #6 pueden ir en el free-scan (livianos). #2 y #3
  livianos también, pero un escaneo JS/takeover exhaustivo conviene reservarlo
  para el tier pago → más razón para pagar (ataca la objeción "para qué sigo
  pagando").
- **Legalidad:** todo sigue siendo observacional sobre lo público; ninguna
  mejora requiere autorización extra más allá de la verificación de propiedad ya
  prevista (A1 del threat model).
- **Sincronización:** todo cambio en la persona va a los **dos** archivos
  (worker patch + preset front), como siempre.
