// server.js
// Church DB — simple auth + protected dashboard (serves login.html as root)
// Notes:
// - This file expects express, express-session, mysql2, cors to be installed.
// - For production use a proper session store (Redis, MySQL store, etc.) instead of MemoryStore.

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const session = require('express-session');

const app = express();

// Basic HTTP auth (optional) — kept from your original file
const BASIC_USER = process.env.BASIC_USER;
const BASIC_PASS = process.env.BASIC_PASS;

app.use((req, res, next) => {
  if (!BASIC_USER) return next(); // disabled unless env set
  const auth = req.headers.authorization;
  if (!auth) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).send('Auth required');
  }
  const token = auth.split(' ')[1] || '';
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  const [u, p] = decoded.split(':');
  if (u === BASIC_USER && p === BASIC_PASS) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
  return res.status(401).send('Auth required');
});

app.use(cors());
app.use(express.json()); // parse JSON bodies
app.use(express.urlencoded({ extended: true })); // parse form bodies

// --------------------- DB config (env overrides allowed) ---------------------
const DB_CONFIG = {
  host: process.env.MYSQLHOST || process.env.DB_HOST || 'localhost',
  user: process.env.MYSQLUSER || process.env.DB_USER || 'root',
  password: process.env.MYSQLPASSWORD || process.env.DB_PASSWORD || '',
  database: process.env.MYSQLDATABASE || process.env.DB_NAME || 'railway',
  port: Number(process.env.MYSQLPORT || process.env.DB_PORT || 3306),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// If a DATABASE_URL / MYSQL_URL string is provided, parse and override config
const dbUrl = process.env.DATABASE_URL || process.env.MYSQL_URL || process.env.MYSQL_URL;
if (dbUrl && dbUrl.startsWith('mysql://')) {
  const m = dbUrl.match(/mysql:\/\/([^:]+):([^@]+)@([^:\/]+):(\d+)\/(.+)/);
  if (m) {
    DB_CONFIG.user = m[1];
    DB_CONFIG.password = m[2];
    DB_CONFIG.host = m[3];
    DB_CONFIG.port = Number(m[4]);
    DB_CONFIG.database = m[5];
    console.log('Parsed DB URL from env and updated DB_CONFIG.');
  } else {
    console.warn('DATABASE_URL present but failed to parse — falling back to individual env vars.');
  }
}

console.log('DB_CONFIG in use:', {
  host: DB_CONFIG.host,
  user: DB_CONFIG.user,
  database: DB_CONFIG.database,
  port: DB_CONFIG.port,
  passwordSet: !!DB_CONFIG.password
});

// --------------------- Session middleware ---------------------
// IMPORTANT: MemoryStore is fine for testing but NOT for production.
// Put a proper store (connect-redis, express-mysql-session, etc.) for multi-process deploys.
const SESSION_SECRET = process.env.SESSION_SECRET || 'please-change-this-secret';
app.use(session({
  name: 'church.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: (process.env.NODE_ENV === 'production'), // set true if served over HTTPS
    maxAge: 1000 * 60 * 60 * 8 // 8 hours
  }
}));

// Warn about MemoryStore in logs
console.warn('Warning: connect.session() MemoryStore is not designed for production — use a persistent session store.');

// --------------------- Initialize DB pool (non-fatal) ---------------------
let pool = null;
async function initDb() {
  try {
    pool = mysql.createPool(DB_CONFIG);
    await pool.query('SELECT 1 as ok'); // smoke test
    console.log('MySQL pool created and tested OK.');
  } catch (err) {
    console.error('MySQL init error:', err.message);
    pool = null; // keep server running even if DB is down
  }
}
initDb();

// --------------------- Static files ---------------------
const PUBLIC_DIR = path.join(__dirname, 'public');
// serve static files but do NOT auto-serve index.html for GET /
app.use(express.static(PUBLIC_DIR, { index: false }));


// --------------------- Simple auth routes ---------------------
/**
 * Simple login endpoint (POST /login)
 * Accepts JSON: { username, password }
 * For now accepts a single credential:
 *   username: 'admin'
 *   password: 'ian.rdr4'
 *
 * On success: sets req.session.user and returns { success: true, redirect: '/dashboard' }
 * On failure: returns 401 with { success: false, message }
 */
app.post('/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Missing username or password' });
    }

    // Replace this block with your real authentication (DB / hashed password) as needed.
    if (username === 'admin' && password === 'ian.rdr4') {
      req.session.user = { name: username };
      return res.json({ success: true, redirect: '/dashboard' });
    }

    return res.status(401).json({ success: false, message: 'Invalid credentials' });
  } catch (e) {
    console.error('POST /login error', e);
    return res.status(500).json({ success: false, message: 'server error' });
  }
});

// Logout route
app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('session destroy error', err);
      return res.status(500).json({ ok: false });
    }
    res.clearCookie('church.sid');
    return res.json({ ok: true, redirect: '/' });
  });
});

// middleware to require login
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  // if API request, return 401 JSON
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'not authenticated' });
  // otherwise redirect to login page
  return res.redirect('/');
}

// Protected dashboard route (serves index.html)
app.get('/dashboard', requireLogin, (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Serve login.html at root
app.get('/', (req, res) => {
  // If already logged in, send them to dashboard
  if (req.session && req.session.user) {
    return res.redirect('/dashboard');
  }
  return res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

// --------------------- Your existing API endpoints ---------------------
// (I retained the endpoints from your original server.js — they will continue to work,
// but when a client needs them they will return DB not connected if pool==null)
app.get('/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));

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

// --------------------- Static fallback for other routes ---------------------
// If route isn't API and not matched above, redirect unauthenticated users to login,
// and authenticated users to /dashboard (this prevents index.html being served to public root unintentionally).
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/ping')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  if (req.session && req.session.user) {
    // authenticated -> serve SPA (index.html) for client-side routing under /dashboard
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
  // not authenticated -> redirect to login
  return res.redirect('/');
});

// --------------------- start server ---------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log('Try: http://localhost:' + PORT + '/ping  and /api/allFamilies');
});

