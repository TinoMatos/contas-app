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
    CREATE TABLE IF NOT EXISTS recurring_bills (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      category TEXT,
      amount NUMERIC(12,2) NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('income','expense')),
      day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_recurring_profile ON recurring_bills(profile_id);
    CREATE TABLE IF NOT EXISTS cash_boxes (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      initial_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_boxes_profile ON cash_boxes(profile_id);
    -- Data a que o saldo inicial se refere: lançamentos ANTERIORES a ela já estão
    -- embutidos nesse saldo e não podem ser descontados de novo.
    ALTER TABLE cash_boxes ADD COLUMN IF NOT EXISTS start_date DATE;
    UPDATE cash_boxes SET start_date = created_at::date WHERE start_date IS NULL;
    ALTER TABLE transactions ADD COLUMN IF NOT EXISTS box_id INTEGER REFERENCES cash_boxes(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_tx_box ON transactions(box_id);
    ALTER TABLE recurring_bills ADD COLUMN IF NOT EXISTS box_id INTEGER REFERENCES cash_boxes(id) ON DELETE SET NULL;
    CREATE TABLE IF NOT EXISTS transfers (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      from_box_id INTEGER REFERENCES cash_boxes(id) ON DELETE CASCADE,
      to_box_id INTEGER REFERENCES cash_boxes(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL,
      date DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_transfers_profile ON transfers(profile_id);
    CREATE TABLE IF NOT EXISTS investments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_investments_profile ON investments(profile_id);
    CREATE TABLE IF NOT EXISTS investment_snapshots (
      id SERIAL PRIMARY KEY,
      investment_id INTEGER NOT NULL REFERENCES investments(id) ON DELETE CASCADE,
      value NUMERIC(14,2) NOT NULL,
      date DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_inv_snap ON investment_snapshots(investment_id);
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

// Valida que o caixa (opcional) pertence ao usuário/perfil. Retorna o id ou null.
async function resolveBoxId(rawBoxId, userId, profileId) {
  if (rawBoxId === undefined || rawBoxId === null || rawBoxId === '') return null;
  const bid = parseInt(rawBoxId, 10);
  if (!bid) return null;
  const r = await pool.query('SELECT id FROM cash_boxes WHERE id=$1 AND user_id=$2 AND profile_id=$3', [bid, userId, profileId]);
  return r.rowCount === 0 ? null : bid;
}

app.get('/api/transactions', auth, resolveProfile, async (req, res) => {
  const r = await pool.query(
    `SELECT id, description AS desc, category, amount::float AS amount, type, to_char(date,'YYYY-MM-DD') AS date, box_id
     FROM transactions WHERE user_id=$1 AND profile_id=$2 ORDER BY date DESC, id DESC`,
    [req.user.id, req.profileId]
  );
  res.json(r.rows);
});

app.post('/api/transactions', auth, resolveProfile, async (req, res) => {
  const { desc, category, amount, type, date, box_id } = req.body || {};
  if (!desc || !amount || !type || !date) return res.status(400).json({ error: 'Dados inválidos' });
  if (!['income','expense'].includes(type)) return res.status(400).json({ error: 'Tipo inválido' });
  const boxId = await resolveBoxId(box_id, req.user.id, req.profileId);
  const r = await pool.query(
    `INSERT INTO transactions(user_id,profile_id,description,category,amount,type,date,box_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, description AS desc, category, amount::float AS amount, type, to_char(date,'YYYY-MM-DD') AS date, box_id`,
    [req.user.id, req.profileId, String(desc).trim(), category ? String(category).trim() : null, amount, type, date, boxId]
  );
  res.json(r.rows[0]);
});

app.put('/api/transactions/:id', auth, resolveProfile, async (req, res) => {
  const { desc, category, amount, type, date, box_id } = req.body || {};
  if (!desc || !amount || !type || !date) return res.status(400).json({ error: 'Dados inválidos' });
  if (!['income','expense'].includes(type)) return res.status(400).json({ error: 'Tipo inválido' });
  const boxId = await resolveBoxId(box_id, req.user.id, req.profileId);
  const r = await pool.query(
    `UPDATE transactions SET description=$1, category=$2, amount=$3, type=$4, date=$5, box_id=$6
     WHERE id=$7 AND user_id=$8 AND profile_id=$9
     RETURNING id, description AS desc, category, amount::float AS amount, type, to_char(date,'YYYY-MM-DD') AS date, box_id`,
    [String(desc).trim(), category ? String(category).trim() : null, amount, type, date, boxId, req.params.id, req.user.id, req.profileId]
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

app.get('/api/recurring', auth, resolveProfile, async (req, res) => {
  const r = await pool.query(
    `SELECT id, description AS desc, category, amount::float AS amount, type, day_of_month, box_id
     FROM recurring_bills WHERE user_id=$1 AND profile_id=$2 ORDER BY day_of_month ASC, id ASC`,
    [req.user.id, req.profileId]
  );
  res.json(r.rows);
});

app.post('/api/recurring', auth, resolveProfile, async (req, res) => {
  const { desc, category, amount, type, day_of_month, box_id } = req.body || {};
  const day = parseInt(day_of_month, 10);
  if (!desc || !amount || !type || !day || day < 1 || day > 31) return res.status(400).json({ error: 'Dados inválidos' });
  if (!['income','expense'].includes(type)) return res.status(400).json({ error: 'Tipo inválido' });
  const boxId = await resolveBoxId(box_id, req.user.id, req.profileId);
  const r = await pool.query(
    `INSERT INTO recurring_bills(user_id,profile_id,description,category,amount,type,day_of_month,box_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id, description AS desc, category, amount::float AS amount, type, day_of_month, box_id`,
    [req.user.id, req.profileId, String(desc).trim(), category ? String(category).trim() : null, amount, type, day, boxId]
  );
  res.json(r.rows[0]);
});

app.put('/api/recurring/:id', auth, resolveProfile, async (req, res) => {
  const { box_id, day_of_month, amount } = req.body || {};
  const boxId = await resolveBoxId(box_id, req.user.id, req.profileId);
  // day_of_month / amount são opcionais: quando não vêm, mantém o valor atual.
  let day = null;
  if (day_of_month !== undefined && day_of_month !== null) {
    day = parseInt(day_of_month, 10);
    if (!day || day < 1 || day > 31) return res.status(400).json({ error: 'Dia inválido' });
  }
  let amt = null;
  if (amount !== undefined && amount !== null && amount !== '') {
    amt = Number(amount);
    if (!(amt > 0)) return res.status(400).json({ error: 'Valor inválido' });
  }
  const r = await pool.query(
    `UPDATE recurring_bills
        SET box_id=$1,
            day_of_month=COALESCE($5, day_of_month),
            amount=COALESCE($6, amount)
     WHERE id=$2 AND user_id=$3 AND profile_id=$4
     RETURNING id, description AS desc, category, amount::float AS amount, type, day_of_month, box_id`,
    [boxId, req.params.id, req.user.id, req.profileId, day, amt]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Não encontrada' });
  res.json(r.rows[0]);
});

app.delete('/api/recurring/:id', auth, resolveProfile, async (req, res) => {
  const r = await pool.query(
    'DELETE FROM recurring_bills WHERE id=$1 AND user_id=$2 AND profile_id=$3',
    [req.params.id, req.user.id, req.profileId]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Não encontrada' });
  res.json({ ok: true });
});

// ---- Caixas (carteiras: bancos, dinheiro, etc) ----
// O saldo de cada caixa = saldo inicial + recebimentos - pagamentos atribuídos a ele.
app.get('/api/boxes', auth, resolveProfile, async (req, res) => {
  const r = await pool.query(
    `SELECT b.id, b.name, b.initial_balance::float AS initial_balance,
            to_char(b.start_date,'YYYY-MM-DD') AS start_date,
            (b.initial_balance
              + COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount ELSE 0 END),0)
              - COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END),0)
              + COALESCE((SELECT SUM(amount) FROM transfers tr WHERE tr.to_box_id = b.id
                           AND tr.date >= COALESCE(b.start_date, DATE '1900-01-01')),0)
              - COALESCE((SELECT SUM(amount) FROM transfers tr WHERE tr.from_box_id = b.id
                           AND tr.date >= COALESCE(b.start_date, DATE '1900-01-01')),0))::float AS balance
     FROM cash_boxes b
     LEFT JOIN transactions t ON t.box_id = b.id
                             AND t.date >= COALESCE(b.start_date, DATE '1900-01-01')
     WHERE b.user_id=$1 AND b.profile_id=$2
     GROUP BY b.id
     ORDER BY b.id ASC`,
    [req.user.id, req.profileId]
  );
  res.json(r.rows);
});

app.post('/api/boxes', auth, resolveProfile, async (req, res) => {
  const { name, initial_balance, start_date } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.status(400).json({ error: 'Nome obrigatório' });
  if (n.length > 40) return res.status(400).json({ error: 'Nome muito longo' });
  const init = Number(initial_balance) || 0;
  const start = start_date || null;
  const r = await pool.query(
    `INSERT INTO cash_boxes(user_id,profile_id,name,initial_balance,start_date)
     VALUES($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE))
     RETURNING id, name, initial_balance::float AS initial_balance, initial_balance::float AS balance,
               to_char(start_date,'YYYY-MM-DD') AS start_date`,
    [req.user.id, req.profileId, n, init, start]
  );
  res.json(r.rows[0]);
});

app.put('/api/boxes/:id', auth, resolveProfile, async (req, res) => {
  const { name, initial_balance, start_date } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.status(400).json({ error: 'Nome obrigatório' });
  if (n.length > 40) return res.status(400).json({ error: 'Nome muito longo' });
  const init = Number(initial_balance) || 0;
  const start = start_date || null;
  const r = await pool.query(
    `UPDATE cash_boxes SET name=$1, initial_balance=$2, start_date=COALESCE($6::date, start_date)
     WHERE id=$3 AND user_id=$4 AND profile_id=$5
     RETURNING id, name, initial_balance::float AS initial_balance,
               to_char(start_date,'YYYY-MM-DD') AS start_date`,
    [n, init, req.params.id, req.user.id, req.profileId, start]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Caixa não encontrado' });
  res.json(r.rows[0]);
});

app.delete('/api/boxes/:id', auth, resolveProfile, async (req, res) => {
  const r = await pool.query(
    'DELETE FROM cash_boxes WHERE id=$1 AND user_id=$2 AND profile_id=$3',
    [req.params.id, req.user.id, req.profileId]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Caixa não encontrado' });
  res.json({ ok: true });
});

// ---- Transferências entre caixas (não contam como receita/despesa) ----
app.get('/api/transfers', auth, resolveProfile, async (req, res) => {
  const r = await pool.query(
    `SELECT tr.id, tr.from_box_id, tr.to_box_id, tr.amount::float AS amount,
            to_char(tr.date,'YYYY-MM-DD') AS date, fb.name AS from_name, tb.name AS to_name
     FROM transfers tr
     LEFT JOIN cash_boxes fb ON fb.id = tr.from_box_id
     LEFT JOIN cash_boxes tb ON tb.id = tr.to_box_id
     WHERE tr.user_id=$1 AND tr.profile_id=$2
     ORDER BY tr.date DESC, tr.id DESC`,
    [req.user.id, req.profileId]
  );
  res.json(r.rows);
});

app.post('/api/transfers', auth, resolveProfile, async (req, res) => {
  const { from_box_id, to_box_id, amount, date } = req.body || {};
  const from = await resolveBoxId(from_box_id, req.user.id, req.profileId);
  const to = await resolveBoxId(to_box_id, req.user.id, req.profileId);
  const val = Number(amount);
  if (!from || !to) return res.status(400).json({ error: 'Escolha os caixas de origem e destino' });
  if (from === to) return res.status(400).json({ error: 'Origem e destino devem ser diferentes' });
  if (!val || val <= 0) return res.status(400).json({ error: 'Valor inválido' });
  if (!date) return res.status(400).json({ error: 'Data inválida' });
  const r = await pool.query(
    `INSERT INTO transfers(user_id,profile_id,from_box_id,to_box_id,amount,date)
     VALUES($1,$2,$3,$4,$5,$6)
     RETURNING id, from_box_id, to_box_id, amount::float AS amount, to_char(date,'YYYY-MM-DD') AS date`,
    [req.user.id, req.profileId, from, to, val, date]
  );
  res.json(r.rows[0]);
});

app.delete('/api/transfers/:id', auth, resolveProfile, async (req, res) => {
  const r = await pool.query(
    'DELETE FROM transfers WHERE id=$1 AND user_id=$2 AND profile_id=$3',
    [req.params.id, req.user.id, req.profileId]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Transferência não encontrada' });
  res.json({ ok: true });
});

// ---- Investimentos (CDB, ações, etc) ----
// Cada investimento guarda um histórico de valores (snapshots). O rendimento
// é calculado comparando o valor atual com o valor anterior registrado.
function investmentRowQuery() {
  return `
    SELECT i.id, i.name,
      (SELECT s.value::float FROM investment_snapshots s WHERE s.investment_id=i.id ORDER BY s.date DESC, s.id DESC LIMIT 1) AS current_value,
      (SELECT to_char(s.date,'YYYY-MM-DD') FROM investment_snapshots s WHERE s.investment_id=i.id ORDER BY s.date DESC, s.id DESC LIMIT 1) AS current_date,
      (SELECT s.value::float FROM investment_snapshots s WHERE s.investment_id=i.id ORDER BY s.date DESC, s.id DESC LIMIT 1 OFFSET 1) AS prev_value,
      (SELECT to_char(s.date,'YYYY-MM-DD') FROM investment_snapshots s WHERE s.investment_id=i.id ORDER BY s.date DESC, s.id DESC LIMIT 1 OFFSET 1) AS prev_date,
      (SELECT s.value::float FROM investment_snapshots s WHERE s.investment_id=i.id ORDER BY s.date ASC, s.id ASC LIMIT 1) AS first_value,
      (SELECT to_char(s.date,'YYYY-MM-DD') FROM investment_snapshots s WHERE s.investment_id=i.id ORDER BY s.date ASC, s.id ASC LIMIT 1) AS first_date,
      (SELECT COUNT(*)::int FROM investment_snapshots s WHERE s.investment_id=i.id) AS snapshot_count
    FROM investments i`;
}

async function resolveInvestment(rawId, userId, profileId) {
  const iid = parseInt(rawId, 10);
  if (!iid) return null;
  const r = await pool.query('SELECT id FROM investments WHERE id=$1 AND user_id=$2 AND profile_id=$3', [iid, userId, profileId]);
  return r.rowCount === 0 ? null : iid;
}

app.get('/api/investments', auth, resolveProfile, async (req, res) => {
  const r = await pool.query(
    investmentRowQuery() + ' WHERE i.user_id=$1 AND i.profile_id=$2 ORDER BY i.id ASC',
    [req.user.id, req.profileId]
  );
  res.json(r.rows);
});

app.post('/api/investments', auth, resolveProfile, async (req, res) => {
  const { name, value, date } = req.body || {};
  const n = String(name || '').trim();
  const val = Number(value);
  if (!n) return res.status(400).json({ error: 'Nome obrigatório' });
  if (n.length > 40) return res.status(400).json({ error: 'Nome muito longo' });
  if (!isFinite(val) || val < 0) return res.status(400).json({ error: 'Valor inválido' });
  if (!date) return res.status(400).json({ error: 'Data inválida' });
  const ins = await pool.query(
    'INSERT INTO investments(user_id,profile_id,name) VALUES($1,$2,$3) RETURNING id',
    [req.user.id, req.profileId, n]
  );
  const id = ins.rows[0].id;
  await pool.query(
    'INSERT INTO investment_snapshots(investment_id,value,date) VALUES($1,$2,$3)',
    [id, val, date]
  );
  const r = await pool.query(investmentRowQuery() + ' WHERE i.id=$1', [id]);
  res.json(r.rows[0]);
});

app.put('/api/investments/:id', auth, resolveProfile, async (req, res) => {
  const { name } = req.body || {};
  const n = String(name || '').trim();
  if (!n) return res.status(400).json({ error: 'Nome obrigatório' });
  if (n.length > 40) return res.status(400).json({ error: 'Nome muito longo' });
  const r = await pool.query(
    'UPDATE investments SET name=$1 WHERE id=$2 AND user_id=$3 AND profile_id=$4 RETURNING id',
    [n, req.params.id, req.user.id, req.profileId]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Investimento não encontrado' });
  const row = await pool.query(investmentRowQuery() + ' WHERE i.id=$1', [r.rows[0].id]);
  res.json(row.rows[0]);
});

app.delete('/api/investments/:id', auth, resolveProfile, async (req, res) => {
  const r = await pool.query(
    'DELETE FROM investments WHERE id=$1 AND user_id=$2 AND profile_id=$3',
    [req.params.id, req.user.id, req.profileId]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Investimento não encontrado' });
  res.json({ ok: true });
});

app.get('/api/investments/:id/snapshots', auth, resolveProfile, async (req, res) => {
  const id = await resolveInvestment(req.params.id, req.user.id, req.profileId);
  if (!id) return res.status(404).json({ error: 'Investimento não encontrado' });
  const r = await pool.query(
    `SELECT id, value::float AS value, to_char(date,'YYYY-MM-DD') AS date
     FROM investment_snapshots WHERE investment_id=$1 ORDER BY date DESC, id DESC`,
    [id]
  );
  res.json(r.rows);
});

app.post('/api/investments/:id/snapshots', auth, resolveProfile, async (req, res) => {
  const id = await resolveInvestment(req.params.id, req.user.id, req.profileId);
  if (!id) return res.status(404).json({ error: 'Investimento não encontrado' });
  const { value, date } = req.body || {};
  const val = Number(value);
  if (!isFinite(val) || val < 0) return res.status(400).json({ error: 'Valor inválido' });
  if (!date) return res.status(400).json({ error: 'Data inválida' });
  await pool.query(
    'INSERT INTO investment_snapshots(investment_id,value,date) VALUES($1,$2,$3)',
    [id, val, date]
  );
  const r = await pool.query(investmentRowQuery() + ' WHERE i.id=$1', [id]);
  res.json(r.rows[0]);
});

app.delete('/api/investments/:id/snapshots/:sid', auth, resolveProfile, async (req, res) => {
  const id = await resolveInvestment(req.params.id, req.user.id, req.profileId);
  if (!id) return res.status(404).json({ error: 'Investimento não encontrado' });
  const r = await pool.query(
    'DELETE FROM investment_snapshots WHERE id=$1 AND investment_id=$2',
    [req.params.sid, id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Registro não encontrado' });
  res.json({ ok: true });
});

app.get('/health', (_, res) => res.json({ ok: true }));

initDb()
  .then(() => app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`)))
  .catch(err => { console.error('Falha ao iniciar:', err); process.exit(1); });
