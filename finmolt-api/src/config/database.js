/**
 * Database connection and query helpers
 */

const { Pool } = require('pg');
const config = require('./index');

let pool = null;

function initializePool() {
  if (pool) return pool;

  if (!config.database.url) {
    console.warn('DATABASE_URL not set, using mock database');
    return null;
  }

  pool = new Pool({
    connectionString: config.database.url,
    ssl: config.database.ssl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
  });

  pool.on('error', (err) => {
    console.error('Unexpected database error:', err);
  });

  return pool;
}

async function query(text, params) {
  const db = initializePool();

  if (!db) {
    throw new Error('Database not configured');
  }

  const start = Date.now();
  const result = await db.query(text, params);
  const duration = Date.now() - start;

  if (config.nodeEnv === 'development') {
    console.log('Query executed', { text: text.substring(0, 50), duration, rows: result.rowCount });
  }

  return result;
}

async function queryOne(text, params) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

async function queryAll(text, params) {
  const result = await query(text, params);
  return result.rows;
}

async function transaction(callback) {
  const db = initializePool();

  if (!db) {
    throw new Error('Database not configured');
  }

  const client = await db.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function healthCheck() {
  try {
    const db = initializePool();
    if (!db) return false;

    await db.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  initializePool,
  query,
  queryOne,
  queryAll,
  transaction,
  healthCheck,
  close,
  getPool: () => pool
};
