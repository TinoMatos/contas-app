const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const path = require('path');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'troque-este-segredo-em-producao';
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('DATABASE_URL não definida. Conecte um Postgres ao serviço no Railway.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      category TEXT,
      amount NUMERIC(12,2) NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('income','expense')),
      date DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id);
    CREATE TABLE IF NOT EXISTS profiles (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_profiles_user ON profiles(user_id);
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_tx_profile ON transactions(profile_id);
  `);

  // Backfill: cria perfil "Principal" para cada usuário que ainda não tem,
  // e associa transações órfãs (profile_id NULL) a esse perfil.
  await pool.query(`
    INSERT INTO profiles (user_id, name)
    SELECT u.id, 'Principal'
    FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM profiles p WHERE p.user_id = u.id);
  `);
  await pool.query(`
    UPDATE transactions t
    SET profile_id = (
      SELECT p.id FROM profiles p
      WHERE p.user_id = t.user_id
      ORDER BY p.id ASC LIMIT 1
    )
    WHERE t.profile_id IS NULL;
  `);

  console.log('Banco inicializado.');
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Sem token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// Resolve o perfil ativo a partir do header X-Profile-Id, garantindo que pertence ao usuário.
async function resolveProfile(req, res, next) {
  const raw = req.headers['x-profile-id'];
  const pid = raw ? parseInt(raw, 10) : NaN;
  if (!pid) return res.status(400).json({ error: 'Perfil não selecionado' });
  const r = await pool.query('SELECT id FROM profiles WHERE id=$1 AND user_id=$2', [pid, req.user.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Perfil inválido' });
  req.profileId = pid;
  next();
}

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Dados inválidos' });
  const u = String(username).trim().toLowerCase();
  if (!/^[a-z0-9_.-]{2,30}$/.test(u)) return res.status(400).json({ error: 'Usuário inválido' });
  if (password.length < 3) return res.status(400).json({ error: 'Senha muito curta' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id,username',
      [u, hash]
    );
    await pool.query('INSERT INTO profiles(user_id,name) VALUES($1,$2)', [r.rows[0].id, 'Principal']);
    const token = jwt.sign({ id: r.rows[0].id, username: u }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, username: u });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Usuário já existe' });
    console.error(e);
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Dados inválidos' });
  const u = String(username).trim().toLowerCase();
  const r = await pool.query('SELECT id,password_hash FROM users WHERE username=$1', [u]);
  if (r.rowCount === 0) return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  const ok = await bcrypt.compare(password, r.rows[0].password_hash);
  if (!ok) return res.status(401).json({ error: 'Usuário ou senha inválidos' });
  const token = jwt.sign({ id: r.rows[0].id, username: u }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: u });
});

app.get('/api/profiles', auth, async (req, res) => {
  const r = await pool.query(
    'SELECT id, name FROM profiles WHERE user_id=$1 ORDER BY id ASC',
    [req.user.id]
  );
  res.json(r.rows);
});

app.post('/api/profiles', auth, async (req, res) => {
  const { name } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.status(400).json({ error: 'Nome obrigatório' });
  if (n.length > 40) return res.status(400).json({ error: 'Nome muito longo' });
  const r = await pool.query(
    'INSERT INTO profiles(user_id,name) VALUES($1,$2) RETURNING id, name',
    [req.user.id, n]
  );
  res.json(r.rows[0]);
});

app.put('/api/profiles/:id', auth, async (req, res) => {
  const { name } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.status(400).json({ error: 'Nome obrigatório' });
  const r = await pool.query(
    'UPDATE profiles SET name=$1 WHERE id=$2 AND user_id=$3 RETURNING id, name',
    [n, req.params.id, req.user.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Perfil não encontrado' });
  res.json(r.rows[0]);
});

app.delete('/api/profiles/:id', auth, async (req, res) => {
  const count = await pool.query('SELECT COUNT(*)::int AS n FROM profiles WHERE user_id=$1', [req.user.id]);
  if (count.rows[0].n <= 1) return res.status(400).json({ error: 'Mantenha pelo menos um perfil' });
  const r = await pool.query(
    'DELETE FROM profiles WHERE id=$1 AND user_id=$2',
    [req.params.id, req.user.id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Perfil não encontrado' });
  res.json({ ok: true });
});

app.get('/api/transactions', auth, resolveProfile, async (req, res) => {
  const r = await pool.query(
    `SELECT id, description AS desc, category, amount::float AS amount, type, to_char(date,'YYYY-MM-DD') AS date
     FROM transactions WHERE user_id=$1 AND profile_id=$2 ORDER BY date DESC, id DESC`,
    [req.user.id, req.profileId]
  );
  res.json(r.rows);
});

app.post('/api/transactions', auth, resolveProfile, async (req, res) => {
  const { desc, category, amount, type, date } = req.body || {};
  if (!desc || !amount || !type || !date) return res.status(400).json({ error: 'Dados inválidos' });
  if (!['income','expense'].includes(type)) return res.status(400).json({ error: 'Tipo inválido' });
  const r = await pool.query(
    `INSERT INTO transactions(user_id,profile_id,description,category,amount,type,date)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, description AS desc, category, amount::float AS amount, type, to_char(date,'YYYY-MM-DD') AS date`,
    [req.user.id, req.profileId, String(desc).trim(), category ? String(category).trim() : null, amount, type, date]
  );
  res.json(r.rows[0]);
});

app.put('/api/transactions/:id', auth, resolveProfile, async (req, res) => {
  const { desc, category, amount, type, date } = req.body || {};
  if (!desc || !amount || !type || !date) return res.status(400).json({ error: 'Dados inválidos' });
  if (!['income','expense'].includes(type)) return res.status(400).json({ error: 'Tipo inválido' });
  const r = await pool.query(
    `UPDATE transactions SET description=$1, category=$2, amount=$3, type=$4, date=$5
     WHERE id=$6 AND user_id=$7 AND profile_id=$8
     RETURNING id, description AS desc, category, amount::float AS amount, type, to_char(date,'YYYY-MM-DD') AS date`,
    [String(desc).trim(), category ? String(category).trim() : null, amount, type, date, req.params.id, req.user.id, req.profileId]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Não encontrada' });
  res.json(r.rows[0]);
});

app.delete('/api/transactions/:id', auth, resolveProfile, async (req, res) => {
  const r = await pool.query(
    'DELETE FROM transactions WHERE id=$1 AND user_id=$2 AND profile_id=$3',
    [req.params.id, req.user.id, req.profileId]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Não encontrada' });
  res.json({ ok: true });
});

app.get('/health', (_, res) => res.json({ ok: true }));

initDb()
  .then(() => app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`)))
  .catch(err => { console.error('Falha ao iniciar:', err); process.exit(1); });
