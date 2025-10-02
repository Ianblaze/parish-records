// server.js (diagnostic + safe API ordering)
// Replace DB_CONFIG credentials with your MySQL values, save, then `node server.js`.

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// server.js — DB config (use env vars)
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'church_admin',
  password: process.env.DB_PASSWORD || 'stephens!@1234.',
  database: process.env.DB_NAME || 'church_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};


// ---------------------------------------------

let pool = null;

// initialize DB pool but do NOT crash the server permanently if DB fails.
// We log errors so you can diagnose.
async function initDb() {
  try {
    pool = mysql.createPool(DB_CONFIG);
    await pool.query('SELECT 1 as ok'); // quick smoke-test
    console.log('MySQL pool created and tested OK.');
  } catch (err) {
    console.error('MySQL init error:', err.message);
    pool = null;
  }
}
initDb();

// --- Quick health check endpoint (JSON) ---
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

// --- API endpoints (must be defined before static fallback) ---

// GET all families
app.get('/api/allFamilies', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not connected' });
  try {
    const [rows] = await pool.execute(
      `SELECT family_id, family_sr_no, family_name, head_of_family, community_name, zone_no, contact_phone
       FROM family_groups ORDER BY family_id`
    );
    return res.json({ results: rows });
  } catch (err) {
    console.error('/api/allFamilies error', err);
    return res.status(500).json({ error: 'server error' });
  }
});

// GET all members (expanded)
app.get('/api/allMembers', async (req, res) => {
  if (!pool) return res.status(500).json({ error: 'DB not connected' });
  try {
    const [rows] = await pool.execute(
      `SELECT fm.*, fg.family_sr_no, fg.head_of_family
       FROM family_members fm
       JOIN family_groups fg USING(family_id)
       ORDER BY fg.family_id, fm.sr_no_in_family`
    );
    return res.json({ results: rows });
  } catch (err) {
    console.error('/api/allMembers error', err);
    return res.status(500).json({ error: 'server error' });
  }
});

// familyBySr
app.get('/api/familyBySr', async (req, res) => {
  const sr = (req.query.sr || '').trim();
  if (!sr) return res.status(400).json({ error: 'missing sr' });
  if (!pool) return res.status(500).json({ error: 'DB not connected' });
  try {
    const [rows] = await pool.execute(`SELECT * FROM family_groups WHERE family_sr_no = ? LIMIT 1`, [sr]);
    if (rows.length === 0) return res.json({ found: false });
    const family = rows[0];
    const [members] = await pool.execute(`SELECT * FROM family_members WHERE family_id = ? ORDER BY sr_no_in_family`, [family.family_id]);
    return res.json({ found: true, family, members });
  } catch (err) {
    console.error('/api/familyBySr error', err);
    return res.status(500).json({ error: 'server error' });
  }
});

// memberByName
app.get('/api/memberByName', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'missing q' });
  if (!pool) return res.status(500).json({ error: 'DB not connected' });
  try {
    const [rows] = await pool.execute(
      `SELECT fm.*, fg.family_sr_no, fg.head_of_family, fg.community_name, fg.zone_no
       FROM family_members fm
       JOIN family_groups fg USING (family_id)
       WHERE fm.full_name LIKE ?
       ORDER BY fg.family_id, fm.sr_no_in_family
       LIMIT 500`,
      [`%${q}%`]
    );
    return res.json({ results: rows });
  } catch (err) {
    console.error('/api/memberByName error', err);
    return res.status(500).json({ error: 'server error' });
  }
});

// familiesByHead
app.get('/api/familiesByHead', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'missing q' });
  if (!pool) return res.status(500).json({ error: 'DB not connected' });
  try {
    const [rows] = await pool.execute(
      `SELECT family_id, family_sr_no, family_name, head_of_family, community_name, zone_no, contact_phone
       FROM family_groups
       WHERE head_of_family LIKE ?
       ORDER BY family_id
       LIMIT 200`,
      [`%${q}%`]
    );
    return res.json({ results: rows });
  } catch (err) {
    console.error('/api/familiesByHead error', err);
    return res.status(500).json({ error: 'server error' });
  }
});

// --- Serve static frontend files from public/ ---
app.use(express.static(path.join(__dirname, 'public')));

// --- SPA fallback (must be last) ---
app.use((req, res) => {
  // If request is for API path but reached here, return JSON 404 instead of HTML
  if (req.path.startsWith('/api/') || req.path.startsWith('/ping')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// start server
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log('Try: http://localhost:' + PORT + '/ping  and /api/allFamilies');
});

