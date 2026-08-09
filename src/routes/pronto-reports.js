// Pronto AI · Published reports API
const express = require('express');
const { Pool } = require('pg');

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// GET /api/reports?client=squeaky-clean-turf
router.get('/api/reports', async (req, res) => {
  const clientId = String(req.query.client || '').trim();
  if (!clientId) return res.status(400).json({ error: 'client query param is required' });

  try {
    const { rows } = await pool.query(
      `SELECT meta, report
       FROM pronto_reports
       WHERE client_id = $1 AND published = TRUE
       ORDER BY period_end ASC
       LIMIT 52`,
      [clientId],
    );

    if (rows.length === 0) return res.status(404).json({ error: 'No published reports' });

    res.json({
      meta: rows[rows.length - 1].meta ?? null,
      reports: rows.map((row) => row.report),
      latestWeekEscalations: [],
    });
  } catch (err) {
    console.error('GET /api/reports failed:', err);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

// POST /api/reports  headers: x-admin-key  body: { clientId, meta, report }
router.post('/api/reports', express.json({ limit: '1mb' }), async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Admin only' });
  }

  const { clientId, meta, report } = req.body || {};
  if (!clientId || !report || !report.end) {
    return res.status(400).json({ error: 'clientId and report.end are required' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO pronto_reports (client_id, period_end, meta, report, published, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, now())
       ON CONFLICT (client_id, period_end) DO UPDATE
         SET meta = EXCLUDED.meta,
             report = EXCLUDED.report,
             published = TRUE,
             updated_at = now()
       RETURNING period_end`,
      [clientId, report.end, meta ?? null, report],
    );
    res.json({ ok: true, clientId, period_end: rows[0].period_end });
  } catch (err) {
    console.error('POST /api/reports failed:', err);
    res.status(500).json({ error: 'Failed to publish report' });
  }
});

module.exports = router;
