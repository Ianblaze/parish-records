// server.js (with session-based auth protecting /api/* endpoints)
// Replace DB_CONFIG credentials with your MySQL values, save, then `node server.js`.

const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const session = require('express-session');

const app = express();

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
  const [u,p] = decoded.split(':');
  if (u === BASIC_USER && p === BASIC_PASS) return next();
  res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
  return res.status(401).send('Auth required');
});

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// server.js — DB config (use env vars)
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
console.log('DB_CONFIG in use:', {
  host: DB_CONFIG.host,
  user: DB_CONFIG.user,
  database: DB_CONFIG.database,
  port: DB_CONFIG.port,
  passwordSet: !!DB_CONFIG.password
});


const PORT = process.env.PORT || 3000;

// session configuration (in-memory store — replace with Redis/DB in production)
app.use(session({
  name: 'sid',
  secret: process.env.SESSION_SECRET || 'dev-session-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: (process.env.NODE_ENV === 'production'), // set true under HTTPS
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 6 // 6 hours
  }
}));

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

/*
  PUBLIC UNPROTECTED API: /api/login and /api/logout
  - /api/login: accepts { username, password } JSON — checks only admin/ian.rdr4
  - on success it sets req.session.user and returns { ok:true, redirect: '/' }
*/
app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok:false, error: 'Missing username or password' });

  // TEMPORARY: single hardcoded credential (admin / ian.rdr4)
  if (username === 'admin' && password === 'ian.rdr4') {
    // set the session
    req.session.user = { username: 'admin', role: 'admin' };
    // send success + redirect to root (index.html)
    return res.json({ ok: true, redirect: '/' });
  }

  // invalid credentials
  return res.status(401).json({ ok:false, error: 'Invalid username or password' });
});

// logout (public)
app.post('/api/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Session destroy error', err);
      return res.status(500).json({ ok:false, error: 'Logout failed' });
    }
    res.clearCookie('sid');
    return res.json({ ok:true });
  });
});

// --- Auth middleware for protecting API endpoints ---
function requireAuth(req, res, next) {
  // Allow health check
  if (req.path === '/ping') return next();
  // Allow login/logout (they are defined before the middleware)
  // Otherwise require a session user
  if (req.session && req.session.user && req.session.user.username) {
    return next();
  }
  // If request expects JSON, return 401 JSON
  if (req.headers.accept && req.headers.accept.indexOf('application/json') !== -1) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  // Otherwise redirect to login page
  return res.redirect('/login.html');
}

// Apply requireAuth to all /api routes except login/logout which are already defined
app.use('/api', (req, res, next) => {
  // If path is /api/login or /api/logout, skip
  if (req.path === '/login' || req.path === '/logout') return next();
  return requireAuth(req, res, next);
});

// --- API endpoints (protected by requireAuth) ---
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

// Root route: if logged in serve index.html, otherwise redirect to login
app.get('/', (req, res) => {
  if (req.session && req.session.user && req.session.user.username) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  return res.redirect('/login.html');
});

// SPA fallback (must be last) — for non-API requests, serve index if authenticated, otherwise login.
app.use((req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/ping')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  if (req.session && req.session.user && req.session.user.username) {
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// start server
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  console.log('Try: http://localhost:' + PORT + '/ping  and /api/allFamilies');
});

