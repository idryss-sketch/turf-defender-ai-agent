// Pronto AI · Published weekly reports API.
//
// Self-contained: creates its own table on first use, handles CORS for the
// client dashboard (different origin), and sits BEFORE the Basic-auth gate —
// the client portal must load reports without dashboard credentials.
//
//   GET  /api/reports?client=<id>   → { meta, reports, latestWeekEscalations }
//   POST /api/reports               → upsert one report (x-admin-key header)
//
// Env required: ADMIN_KEY

import { getPool } from '../storage/db.js';

let tableReady = false;

async function ensureTable() {
  if (tableReady) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS pronto_reports (
      id          SERIAL PRIMARY KEY,
      client_id   TEXT NOT NULL,
      period_end  DATE NOT NULL,
      meta        JSONB,
      report      JSONB NOT NULL,
      published   BOOLEAN DEFAULT TRUE,
      updated_at  TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (client_id, period_end)
    );
  `);
  tableReady = true;
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
}

function json(res, status, body) {
  cors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch (e) { reject(new Error('Invalid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

/** Returns true if this module handled the request. */
export async function handleProntoReports(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/api/reports') return false;

  // Browser preflight for the POST with the x-admin-key header.
  if (req.method === 'OPTIONS') {
    cors(res);
    res.writeHead(204);
    res.end();
    return true;
  }

  if (req.method === 'GET') {
    const clientId = String(url.searchParams.get('client') || '').trim();
    if (!clientId) {
      json(res, 400, { error: 'client query param is required' });
      return true;
    }
    try {
      await ensureTable();
      const { rows } = await getPool().query(
        `SELECT meta, report
         FROM pronto_reports
         WHERE client_id = $1 AND published = TRUE
         ORDER BY period_end ASC
         LIMIT 52`,
        [clientId],
      );
      if (rows.length === 0) {
        json(res, 404, { error: 'No published reports' });
        return true;
      }
      json(res, 200, {
        meta: rows[rows.length - 1].meta ?? null,
        reports: rows.map((r) => r.report),
        latestWeekEscalations: [],
      });
    } catch (e) {
      console.error('GET /api/reports failed:', e);
      json(res, 500, { error: 'Failed to load reports' });
    }
    return true;
  }

  if (req.method === 'POST') {
    if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY.trim()) {
      json(res, 401, { error: 'Admin only' });
      return true;
    }
    try {
      const { clientId, meta, report } = await readBody(req);
      if (!clientId || !report || !report.end) {
        json(res, 400, { error: 'clientId and report.end are required' });
        return true;
      }
      await ensureTable();
      const { rows } = await getPool().query(
        `INSERT INTO pronto_reports (client_id, period_end, meta, report, published, updated_at)
         VALUES ($1, $2, $3, $4, TRUE, NOW())
         ON CONFLICT (client_id, period_end) DO UPDATE
           SET meta = EXCLUDED.meta,
               report = EXCLUDED.report,
               published = TRUE,
               updated_at = NOW()
         RETURNING period_end`,
        [clientId, report.end, meta ?? null, report],
      );
      console.log(`📊 Report published: ${clientId} · period ending ${rows[0].period_end}`);
      json(res, 200, { ok: true, clientId, period_end: rows[0].period_end });
    } catch (e) {
      console.error('POST /api/reports failed:', e);
      json(res, 500, { error: 'Failed to publish report' });
    }
    return true;
  }

  json(res, 405, { error: 'Method not allowed' });
  return true;
}
