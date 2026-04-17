'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DB_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  console.error('[ChatService] pg pool error:', err.message);
});

module.exports = { pool };
