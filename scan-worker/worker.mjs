#!/usr/bin/env node
/**
 * NEO free-scan worker (Fase 3).
 *
 * Corre en kryon. Loop single-slot:
 *   1. GET  {SCAN_API_BASE}/api/jobs/next   (Bearer SCAN_WORKER_TOKEN)
 *   2. Ejecuta NEO en modo headless one-shot sobre el dominio, con el overlay
 *      free-scan (persona de analista de superficie externa).
 *   3. Extrae el bloque JSON del informe del stdout del agente.
 *   4. POST {SCAN_API_BASE}/api/jobs/:id/result  con el reporte (o el fallo).
 *
 * Solo hace HTTPS saliente + shell-out a `dsh`. No abre puertos.
 * Sin dependencias externas (usa fetch global y node:child_process).
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const cfg = {
  apiBase: (process.env.SCAN_API_BASE ?? "https://www.skyvanguard.com.py").replace(/\/$/, ""),
  token: process.env.SCAN_WORKER_TOKEN ?? "",
  workerId: process.env.SCAN_WORKER_ID ?? "neo-kryon-1",
  // Comando para invocar el CLI de NEO. Ej.: "dsh", "pnpm dsh",
  // "node --import tsx/esm apps/cli/src/bin.ts". Se parte por espacios.
  dshCmd: process.env.NEO_CMD ?? "dsh",
  patchFile: process.env.FREE_SCAN_PATCH ?? resolve(HERE, "free-scan.headless.patch.yml"),
  // Directorio de trabajo del agente (workspace del scan, no el checkout de NEO).
  workspace: process.env.SCAN_WORKSPACE ?? process.cwd(),
  pollIntervalMs: Number(process.env.SCAN_POLL_INTERVAL_MS ?? "15000"),
  timeoutMs: Number(process.env.SCAN_TIMEOUT_MS ?? String(75 * 60 * 1000)), // 75 min
  // Timeout por llamada HTTP al API. El timeoutMs del scan solo mata al proceso
  // hijo; sin este, un socket colgado hacia el API bloquea el slot unico para
  // siempre (Restart=always no rescata un loop vivo pero atascado).
  httpTimeoutMs: Number(process.env.SCAN_HTTP_TIMEOUT_MS ?? String(30_000)),
  // Cota del stdout capturado del hijo. El reporte JSON esta al final, asi que
  // se conserva la COLA; sin esto una sesion verbosa de hasta 75 min podia
  // acumular cientos de MB y tumbar el worker (OOM).
  stdoutMaxChars: Number(process.env.SCAN_STDOUT_MAX_CHARS ?? String(8_000_000)),
};

const SEVERITIES = new Set(["info", "low", "medium", "high", "critical"]);
const OVERALL = new Set(["green", "yellow", "red"]);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function assertConfig() {
  if (!cfg.token) {
    console.error("Falta SCAN_WORKER_TOKEN en el entorno.");
    process.exit(1);
  }
}

async function fetchNextJob() {
  const res = await fetch(`${cfg.apiBase}/api/jobs/next?worker=${encodeURIComponent(cfg.workerId)}`, {
    headers: { authorization: `Bearer ${cfg.token}` },
    signal: AbortSignal.timeout(cfg.httpTimeoutMs),
  });
  if (res.status === 204) return null;
  if (res.status === 401) throw new Error("token de worker inválido (401)");
  if (!res.ok) throw new Error(`GET /api/jobs/next → ${res.status}`);
  const body = await res.json();
  return body.job ?? null;
}

/** Latido de operaciones (best-effort): prueba que el worker está vivo. */
async function postHeartbeat() {
  try {
    await fetch(`${cfg.apiBase}/api/ops/heartbeat?worker=${encodeURIComponent(cfg.workerId)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.token}` },
      signal: AbortSignal.timeout(cfg.httpTimeoutMs),
    });
  } catch {
    // el latido no debe frenar el loop; el chequeo de salud detectará el silencio
  }
}

async function postResult(jobId, payload) {
  // Reintenta hasta 3 veces: un 500 transitorio no debe perder el resultado.
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(`${cfg.apiBase}/api/jobs/${jobId}/result`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(cfg.httpTimeoutMs),
      });
    } catch (err) {
      lastErr = err;
    }
    if (res) {
      if (res.ok) return res.json();
      const text = await res.text().catch(() => "");
      lastErr = new Error(`POST result → ${res.status} ${text.slice(0, 200)}`);
      if (res.status === 409) throw lastErr; // ya no está en running: no reintentar
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 3000));
  }
  throw lastErr;
}

function taskText(domain, locale) {
  if (locale === "en") {
    return `Analyze the internet-facing attack surface of the domain "${domain}". Report language: en. Stay strictly within the observational scope defined in your instructions.`;
  }
  return `Analizá la superficie de ataque expuesta a internet del dominio "${domain}". Idioma del informe: es. Mantenete estrictamente dentro del alcance observacional definido en tus instrucciones.`;
}

/** Ejecuta NEO headless y devuelve el stdout capturado (o lanza en fallo/timeout). */
function runNeo(domain, locale) {
  const parts = cfg.dshCmd.split(/\s+/).filter(Boolean);
  const bin = parts[0];
  const args = [
    ...parts.slice(1),
    "--profile", "headless",
    "--patch", cfg.patchFile,
    taskText(domain, locale),
  ];

  return new Promise((resolvePromise, reject) => {
    // Scrub the worker's own credential from the child environment: NEO never
    // needs SCAN_WORKER_TOKEN, and the child spawns further subprocesses (the
    // agent's bash), so the token has no business crossing this boundary.
    const { SCAN_WORKER_TOKEN, ...childEnv } = process.env;
    void SCAN_WORKER_TOKEN;
    const child = spawn(bin, args, {
      cwd: cfg.workspace,
      env: childEnv,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timeout tras ${Math.round(cfg.timeoutMs / 60000)} min`));
    }, cfg.timeoutMs);

    // Conservar solo la cola: recortar cuando supera 2x el maximo mantiene el
    // costo amortizado O(1) por byte (no O(n^2) recortando en cada chunk).
    const stdoutMax = cfg.stdoutMaxChars;
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > stdoutMax * 2) stdout = stdout.slice(-stdoutMax);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 131072) stderr = stderr.slice(-65536);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`no se pudo ejecutar "${bin}": ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolvePromise(stdout);
      reject(new Error(`dsh headless salió con código ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/** Extrae y sanea el reporte JSON del stdout del agente. Devuelve null si no hay. */
function extractReport(stdout) {
  let raw = null;

  // Preferir el último bloque ```json ... ```.
  const fences = [...stdout.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (fences.length) {
    raw = fences[fences.length - 1][1].trim();
  } else {
    // Fallback: el último objeto {...} balanceado del texto.
    const start = stdout.lastIndexOf("{");
    const end = stdout.lastIndexOf("}");
    if (start !== -1 && end > start) raw = stdout.slice(start, end + 1);
  }
  if (!raw) return null;

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }

  const hosts = Number.isFinite(obj.hostsExposed) ? Math.max(0, Math.trunc(obj.hostsExposed)) : 0;
  const overall = OVERALL.has(obj.overall) ? obj.overall : hosts > 0 ? "yellow" : "green";
  const findings = Array.isArray(obj.findings)
    ? obj.findings.slice(0, 20).map((f) => ({
        title: String(f?.title ?? "").slice(0, 200) || "Hallazgo",
        severity: SEVERITIES.has(f?.severity) ? f.severity : "info",
        ...(f?.impact ? { impact: String(f.impact).slice(0, 600) } : {}),
      }))
    : [];

  const exposedSurface = Array.isArray(obj.exposedSurface)
    ? obj.exposedSurface
        .slice(0, 15)
        .map((a) => ({
          host: String(a?.host ?? "").slice(0, 200),
          ...(a?.role ? { role: String(a.role).slice(0, 80) } : {}),
        }))
        .filter((a) => a.host)
    : [];

  const report = {
    overall,
    headline: String(obj.headline ?? "").slice(0, 280) || "Análisis de superficie externa completado.",
    hostsExposed: hosts,
    exposedSurface,
    findings,
  };
  if (typeof obj.recommendedPlan === "string") {
    report.recommendedPlan = obj.recommendedPlan.slice(0, 80);
  }
  return report;
}

// A single DNS hostname: 1-253 chars, dot-separated labels of letters/digits/
// hyphens (no leading/trailing hyphen), at least two labels. Rejects URLs,
// paths, IPs, spaces, and anything that is not a plain domain to scan.
const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(?:\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

async function processJob(job) {
  if (typeof job.domain !== "string" || !HOSTNAME_RE.test(job.domain)) {
    log(`job ${job.id} → dominio invalido: ${JSON.stringify(job.domain)}`);
    try {
      await postResult(job.id, { status: "failed", error: `Dominio invalido: ${String(job.domain)}` });
    } catch (postErr) {
      log(`job ${job.id} → dominio invalido y ademas fallo el POST: ${postErr}`);
    }
    return;
  }
  log(`job ${job.id} → analizando ${job.domain} (${job.locale}, intento ${job.attempts})`);
  try {
    const stdout = await runNeo(job.domain, job.locale);
    const report = extractReport(stdout);
    if (!report) {
      const tail = stdout.slice(-300).replace(/\s+/g, " ").trim();
      await postResult(job.id, { status: "failed", error: `Sin JSON parseable. Cola del output: ${tail}` });
      log(`job ${job.id} → failed (sin reporte parseable). Cola: ${tail}`);
      return;
    }
    const out = await postResult(job.id, { status: "done", report });
    log(`job ${job.id} → ${out.outcome} (${report.hostsExposed} hosts, overall ${report.overall})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      const out = await postResult(job.id, { status: "failed", error: msg.slice(0, 2000) });
      log(`job ${job.id} → ${out.outcome} tras error: ${msg}`);
    } catch (postErr) {
      log(`job ${job.id} → error y además falló el POST: ${postErr}`);
    }
  }
}

let running = true;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log(`${sig} recibido, cerrando tras el job actual…`);
    running = false;
  });
}

async function main() {
  assertConfig();
  log(`worker "${cfg.workerId}" iniciado → ${cfg.apiBase} (poll ${cfg.pollIntervalMs}ms)`);
  while (running) {
    await postHeartbeat();
    let job = null;
    try {
      job = await fetchNextJob();
    } catch (err) {
      log(`error al reclamar job: ${err instanceof Error ? err.message : err}`);
    }
    if (!job) {
      await new Promise((r) => setTimeout(r, cfg.pollIntervalMs));
      continue;
    }
    await processJob(job);
  }
  log("worker detenido.");
}

main();
