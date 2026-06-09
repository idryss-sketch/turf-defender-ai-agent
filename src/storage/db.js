// Postgres connection + schema bootstrap.
//
// On boot:
//   1. Create the connection pool from DATABASE_URL.
//   2. Run idempotent CREATE TABLE statements (safe to call every boot).
//
// Two tables:
//   conversations  — per-conversation state (replaces data/conversations.json)
//   notifications  — append-only event log (replaces data/notifications.json)
//
// Both tables use JSONB columns for flexibility — the application code stores
// arbitrary state shapes (sqft, customerName, contact, tokenUsage, etc.)
// without needing migrations every time we add a field.

import pg from 'pg';

const { Pool } = pg;

let pool = null;
let initialized = false;

/**
 * Lazily-initialized connection pool. Reads DATABASE_URL from env on first use.
 * Railway sets DATABASE_URL automatically when you reference the Postgres service.
 */
export function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL not set — link the Postgres service in Railway → Variables → reference ${{Postgres.DATABASE_URL}}');
  }
  pool = new Pool({
    connectionString: url,
    // Railway's internal Postgres uses self-signed certs; relax verification.
    ssl: url.includes('railway.internal') ? false : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
  });
  pool.on('error', (err) => console.error('🚨 Postgres pool error:', err.message));
  return pool;
}

/**
 * Run idempotent schema setup. Safe to call multiple times (uses IF NOT EXISTS).
 * Called once at server boot before the HTTP listener starts accepting requests.
 */
export async function initSchema() {
  if (initialized) return;
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      conversation_id TEXT PRIMARY KEY,
      state JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_conversations_last_updated
    ON conversations (last_updated DESC);
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      type TEXT NOT NULL,
      conversation_id TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_notifications_created_at
    ON notifications (created_at DESC);
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_notifications_type
    ON notifications (type);
  `);
  // Learning loop: AI-generated suggestions for prompt/script improvements.
  await p.query(`
    CREATE TABLE IF NOT EXISTS suggestions (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT,
      proposed_change TEXT,
      evidence JSONB,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewer_note TEXT
    );
  `);
  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_suggestions_status_created
    ON suggestions (status, created_at DESC);
  `);
  initialized = true;
  console.log('✅ Postgres schema ready');
}

// ===== Learning loop: suggestions store =====

export async function listSuggestions(filters = {}) {
  const p = getPool();
  const args = [];
  const where = [];
  if (filters.status) {
    args.push(filters.status);
    where.push(`status = $${args.length}`);
  }
  const sql = `SELECT id, created_at, reviewed_at, kind, title, detail,
                      proposed_change, evidence, status, reviewer_note
               FROM suggestions
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at DESC LIMIT 100`;
  const { rows } = await p.query(sql, args);
  return rows;
}

export async function insertSuggestion(s) {
  const p = getPool();
  const { rows } = await p.query(
    `INSERT INTO suggestions (kind, title, detail, proposed_change, evidence, status)
     VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING id`,
    [s.kind || 'observation', s.title, s.detail || '', s.proposedChange || '', s.evidence || {}],
  );
  return rows[0].id;
}

export async function updateSuggestionStatus(id, status, reviewerNote = null) {
  const p = getPool();
  await p.query(
    `UPDATE suggestions
     SET status = $1, reviewer_note = $2, reviewed_at = NOW()
     WHERE id = $3`,
    [status, reviewerNote, id],
  );
}

/**
 * Load all conversations from DB into a plain object keyed by conversation_id.
 * Used at boot to populate the in-memory cache.
 */
export async function loadAllConversations() {
  const p = getPool();
  const { rows } = await p.query('SELECT conversation_id, state FROM conversations');
  const out = {};
  for (const r of rows) {
    out[r.conversation_id] = r.state || {};
  }
  return out;
}

/**
 * Upsert a conversation's state (full row replace).
 */
export async function saveConversation(conversationId, state) {
  const p = getPool();
  await p.query(
    `INSERT INTO conversations (conversation_id, state, last_updated)
     VALUES ($1, $2, NOW())
     ON CONFLICT (conversation_id)
     DO UPDATE SET state = EXCLUDED.state, last_updated = NOW()`,
    [conversationId, state],
  );
}

/**
 * Load all notifications, newest first.
 */
export async function loadAllNotifications() {
  const p = getPool();
  const { rows } = await p.query(
    `SELECT created_at, type, conversation_id, payload
     FROM notifications
     ORDER BY created_at ASC`,
  );
  return rows.map((r) => ({
    timestamp: r.created_at.toISOString(),
    type: r.type,
    conversationId: r.conversation_id,
    ...(r.payload || {}),
  }));
}

/**
 * Append a notification event.
 */
export async function appendNotification(event) {
  const p = getPool();
  const { type, conversationId, ...rest } = event;
  await p.query(
    `INSERT INTO notifications (type, conversation_id, payload)
     VALUES ($1, $2, $3)`,
    [type || 'unknown', conversationId || null, rest],
  );
}
