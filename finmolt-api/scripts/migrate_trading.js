#!/usr/bin/env node
// Creates trading tables and extends polymarket_markets with price columns.
// Usage: node scripts/migrate_trading.js

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
    console.log('Running trading schema migration…');
    const sql = fs.readFileSync(path.join(__dirname, 'trading_schema.sql'), 'utf8');
    await pool.query(sql);
    console.log('Done.');
    await pool.end();
}

run().catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
