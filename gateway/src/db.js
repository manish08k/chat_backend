'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DB_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[Gateway] Unexpected pg pool error:', err.message);
});

module.exports = { pool };
