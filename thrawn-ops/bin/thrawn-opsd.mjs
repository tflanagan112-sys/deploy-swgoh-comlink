#!/usr/bin/env node
// thrawn-opsd: narrow signed-request ops API. Listens on loopback only; Caddy terminates TLS and proxies /ops/v1/*.
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { OpsError } from '../lib/util.mjs';
import { Store } from '../lib/store.mjs';
import { Audit, stdoutMirror } from '../lib/audit.mjs';
import { Approvals } from '../lib/approvals.mjs';
import { NonceCache, RateLimiter } from '../lib/limits.mjs';
import { makeCtl } from '../lib/ctlclient.mjs';
import { DeployRunner } from '../lib/deploy.mjs';
import { downloadArtifact } from '../lib/download.mjs';
import { extractTarGz } from '../lib/safetar.mjs';
import { makeActions } from '../lib/actions.mjs';
import { makeHandler } from '../lib/server.mjs';
import { MAX_BODY } from '../lib/envelope.mjs';

export const VERSION = '1.0.0';
export const DEFAULTS = {
  host: '127.0.0.1',
  port: 9101,
  configDir: '/etc/thrawn-opsd',
  stateDir: '/var/lib/thrawn-opsd',
  auditFile: '/var/log/thrawn-opsd/audit.jsonl',
  releasesDir: '/srv/thrawn-browser/releases',
  ctlBin: '/usr/local/sbin/thrawn-ctl',
};

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const cl = Number(req.headers['content-length']);
    if (Number.isFinite(cl) && cl > max) return reject(new OpsError(413, 'too_large', 'body too large'));
    const chunks = [];
    let n = 0, over = false;
    req.on('data', (c) => {
      n += c.length;
      if (n > max) { over = true; chunks.length = 0; if (n > max * 8) req.destroy(); return; }
      if (!over) chunks.push(c);
    });
    req.on('end', () => (over ? reject(new OpsError(413, 'too_large', 'body too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

export function clientIp(req) {
  const remote = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const xff = String(req.headers['x-forwarded-for'] || '');
  if ((remote === '127.0.0.1' || remote === '::1') && xff) {
    const last = xff.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last && /^[0-9a-fA-F:.]{2,45}$/.test(last)) return last;
  }
  return remote || 'unknown';
}

export function buildApp(cfg = {}, o = {}) {
  const c = { ...DEFAULTS, ...cfg };
  const log = o.log ?? ((m) => process.stderr.write(`[opsd] ${m}\n`));
  const now = o.now ?? (() => Math.floor(Date.now() / 1000));
  const epoch = now();
  const store = new Store({ principalsFile: path.join(c.configDir, 'principals.json'), policyFile: path.join(c.configDir, 'policy.json'), trustUid: o.trustUid ?? 0, log });
  const audit = new Audit({ file: c.auditFile, headFile: path.join(c.stateDir, 'audit-head'), mirror: o.mirror === undefined ? stdoutMirror : o.mirror }).init();
  const approvals = new Approvals({ dir: path.join(c.stateDir, 'pending'), now }).init();
  const ctl = o.ctl ?? makeCtl({ bin: c.ctlBin });
  const deploys = new DeployRunner({
    approvals, store, ctl, download: o.download ?? downloadArtifact, extract: o.extract ?? ((archive, dest) => extractTarGz(archive, dest, {}, { topDirMode: 0o775 })),
    releasesDir: c.releasesDir, downloadsDir: path.join(c.stateDir, 'downloads'), now, log,
  });
  const actions = makeActions({ store, audit, ctl, approvals, deploys, now, startedAt: epoch, version: VERSION, releasesDir: c.releasesDir, probeFetch: o.probeFetch ?? fetch });
  const handler = makeHandler({ store, audit, nonces: new NonceCache({ now }), limiter: new RateLimiter(), actions, now, epoch, log, version: VERSION });

  const send = (res, status, obj, headers = {}) => {
    const b = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers });
    res.end(b);
  };
  const fail = (res, e) => { const w = handler.wrap(e.status, handler.errBody(e)); send(res, w.status, w.body); };

  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://local');
      if (req.method === 'GET' && pathname === '/ops/v1/ping') return send(res, 200, handler.ping());
      if (pathname !== '/ops/v1/req') return fail(res, new OpsError(404, 'not_found', 'not found'));
      if (req.method !== 'POST') return fail(res, new OpsError(405, 'method_not_allowed', 'POST only'));
      if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return fail(res, new OpsError(415, 'unsupported_media_type', 'content-type must be application/json'));
      const body = await readBody(req, MAX_BODY);
      const out = await handler.handle(body, clientIp(req));
      return send(res, out.status, out.body, out.body.error?.retryAfterSec ? { 'retry-after': String(out.body.error.retryAfterSec) } : {});
    } catch (e) {
      if (e instanceof OpsError) return fail(res, e);
      log(`unhandled: ${e.stack || e.message}`);
      return fail(res, new OpsError(500, 'internal', 'internal error'));
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 20000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;

  const timers = [];
  if (o.timers !== false) {
    timers.push(setInterval(() => { try { deploys.scan(); } catch (e) { log(`scan: ${e.message}`); } }, 3000));
    timers.push(setInterval(() => { try { handler.flushAuthFails(); } catch (e) { log(`flush: ${e.message}`); } }, 60000));
    timers.forEach((t) => t.unref());
  }
  deploys.recoverInterrupted();
  return { server, handler, deploys, approvals, store, audit, cfg: c, close: () => { timers.forEach(clearInterval); return new Promise((r) => server.close(() => r())); } };
}

export async function main(env = process.env) {
  const cfg = { ...DEFAULTS };
  for (const [k, e] of [['host', 'OPSD_HOST'], ['configDir', 'OPSD_CONFIG_DIR'], ['stateDir', 'OPSD_STATE_DIR'], ['auditFile', 'OPSD_AUDIT_FILE'], ['releasesDir', 'THRAWN_RELEASES_DIR'], ['ctlBin', 'THRAWN_CTL']]) if (env[e]) cfg[k] = env[e];
  if (env.OPSD_PORT) cfg.port = Number(env.OPSD_PORT);
  if (!['127.0.0.1', '::1'].includes(cfg.host)) throw new Error('opsd only binds to loopback; put Caddy in front');
  const app = buildApp(cfg);
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(cfg.port, cfg.host, resolve); });
  process.stderr.write(`[opsd] v${VERSION} listening on ${cfg.host}:${cfg.port}\n`);
  const stop = () => { app.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('uncaughtException', (e) => { process.stderr.write(`[opsd] fatal: ${e.stack}\n`); process.exit(1); });
  return app;
}

if (process.argv[1] && pathToFileURL(fileURLToPath(import.meta.url)).href === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { process.stderr.write(`[opsd] ${e.message}\n`); process.exit(1); });
}
