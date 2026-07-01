const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const db = require('../db/pg');
const providerManager = require('../services/providerManager');
const botManager = require('../bot/telegramBotManager');

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkeyforaknumberpanel';

// JWT Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// ----------------------------------------------------
// 1. AUTHENTICATION ROUTER
// ----------------------------------------------------
router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const userRes = await db.query('SELECT * FROM admin_users WHERE email = $1 LIMIT 1', [email]);
    const user = userRes.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Access denied. Admin panel requires Super Admin role.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ error: 'Account has been suspended. Contact the administrator.' });
    }

    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
    res.json({ token, email: user.email, role: user.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Unified Login — works for admin + user panel from same form
router.post('/auth/unified-login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const userRes = await db.query('SELECT * FROM admin_users WHERE email = $1 LIMIT 1', [email]);
    const user = userRes.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (!user.is_active) return res.status(403).json({ error: 'Account suspended' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.role === 'superadmin') {
      const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
      return res.json({ redirect: 'admin', token, email: user.email, role: user.role });
    }

    // Regular user — create bot_user + user_session cookie
    const fakeTelegramId = -(parseInt(crypto.createHash('md5').update(email).digest('hex').substring(0, 12), 16) % 900000000000) - 100000;
    const botRes = await db.query('SELECT id FROM telegram_bots WHERE is_active = true LIMIT 1');
    const bot = botRes.rows[0];
    if (!bot) return res.status(500).json({ error: 'No active bot' });

    let botUserId;
    const buRes = await db.query('SELECT id FROM bot_users WHERE bot_id = $1 AND telegram_id = $2 LIMIT 1', [bot.id, fakeTelegramId]);
    if (buRes.rows[0]) {
      botUserId = buRes.rows[0].id;
    } else {
      botUserId = db.generateUUID();
      await db.query('INSERT INTO bot_users (id, bot_id, telegram_id, username, first_name) VALUES ($1, $2, $3, $4, $5)', [botUserId, bot.id, fakeTelegramId, email, email.split('@')[0]]);
    }

    const sessionToken = jwt.sign({ user_type: 'web', email: user.email, role: user.role, bot_user_id: botUserId, bot_id: bot.id }, JWT_SECRET, { expiresIn: '30d' });

    res.cookie('user_session', sessionToken, { path: '/', httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ redirect: 'user', email: user.email, role: user.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 2. DASHBOARD / STATISTICS ROUTER
// ----------------------------------------------------
router.get('/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    // 1. Get counts
    const usersCountRes = await db.query('SELECT COUNT(*) AS count FROM bot_users');
    const botsCountRes = await db.query('SELECT COUNT(*) AS count FROM telegram_bots');
    const providersCountRes = await db.query('SELECT COUNT(*) AS count FROM providers');
    
    // 2. successful OTP counts
    const otps24hRes = await db.query("SELECT COUNT(*) AS count FROM received_otps WHERE received_at > NOW()::date");
    const otps7dRes = await db.query("SELECT COUNT(*) AS count FROM received_otps WHERE received_at > NOW() - INTERVAL '7 days'");
    const otps30dRes = await db.query("SELECT COUNT(*) AS count FROM received_otps WHERE received_at > NOW() - INTERVAL '30 days'");

    // 3. Leaderboard - Services (Platforms)
    const topServicesRes = await db.query(`
      SELECT an.platform AS name, COUNT(*) AS count 
      FROM received_otps ro 
      JOIN allocated_numbers an ON ro.allocated_number_id = an.id 
      GROUP BY an.platform 
      ORDER BY count DESC
    `);

    // 4. Leaderboard - Ranges
    const topRangesRes = await db.query(`
      SELECT an.range, COUNT(*) AS count 
      FROM received_otps ro 
      JOIN allocated_numbers an ON ro.allocated_number_id = an.id 
      GROUP BY an.range 
      ORDER BY count DESC
    `);

    const topRangesFormatted = topRangesRes.rows.map(r => {
      const prefix = r.range.replace(/X/gi, '');
      const c = providerManager.getCountryByPrefix(prefix);
      return {
        range: r.range,
        count: parseInt(r.count),
        country: c.name,
        flag: c.flag
      };
    });

    res.json({
      counters: {
        users: parseInt(usersCountRes.rows[0].count) || 0,
        bots: parseInt(botsCountRes.rows[0].count) || 0,
        providers: parseInt(providersCountRes.rows[0].count) || 0,
        otps24h: parseInt(otps24hRes.rows[0].count) || 0,
        otps7d: parseInt(otps7dRes.rows[0].count) || 0,
        otps30d: parseInt(otps30dRes.rows[0].count) || 0
      },
      topServices: topServicesRes.rows.map(s => ({ name: s.name, count: parseInt(s.count) })),
      topRanges: topRangesFormatted
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Provider Statistics Dashboard (per-provider daily/weekly/monthly)
router.get('/dashboard/provider-stats', authenticateToken, async (req, res) => {
  try {
    const providersRes = await db.query('SELECT id, name, unique_code FROM providers ORDER BY created_at ASC');
    const providers = providersRes.rows;

    const result = [];
    for (const p of providers) {
      const otps24hRes = await db.query(
        `SELECT COUNT(*) AS count FROM received_otps ro 
         JOIN allocated_numbers an ON ro.allocated_number_id = an.id 
         JOIN provider_accounts pa ON an.provider_account_id = pa.id 
         WHERE pa.provider_id = $1 AND ro.received_at > NOW()::date`,
        [p.id]
      );
      const otps7dRes = await db.query(
        `SELECT COUNT(*) AS count FROM received_otps ro 
         JOIN allocated_numbers an ON ro.allocated_number_id = an.id 
         JOIN provider_accounts pa ON an.provider_account_id = pa.id 
         WHERE pa.provider_id = $1 AND ro.received_at > NOW() - INTERVAL '7 days'`,
        [p.id]
      );
      const otps30dRes = await db.query(
        `SELECT COUNT(*) AS count FROM received_otps ro 
         JOIN allocated_numbers an ON ro.allocated_number_id = an.id 
         JOIN provider_accounts pa ON an.provider_account_id = pa.id 
         WHERE pa.provider_id = $1 AND ro.received_at > NOW() - INTERVAL '30 days'`,
        [p.id]
      );

      const topServicesRes = await db.query(
        `SELECT an.platform AS name, COUNT(*) AS count 
         FROM received_otps ro 
         JOIN allocated_numbers an ON ro.allocated_number_id = an.id 
         JOIN provider_accounts pa ON an.provider_account_id = pa.id 
         WHERE pa.provider_id = $1 
         GROUP BY an.platform 
         ORDER BY count DESC`,
        [p.id]
      );

      const activeAccountsRes = await db.query(
        'SELECT COUNT(*) AS count FROM provider_accounts WHERE provider_id = $1 AND is_active = true',
        [p.id]
      );

      result.push({
        id: p.id,
        name: p.name,
        uniqueCode: p.unique_code,
        activeAccounts: parseInt(activeAccountsRes.rows[0].count) || 0,
        otps24h: parseInt(otps24hRes.rows[0].count) || 0,
        otps7d: parseInt(otps7dRes.rows[0].count) || 0,
        otps30d: parseInt(otps30dRes.rows[0].count) || 0,
        topServices: topServicesRes.rows.map(s => ({ name: s.name, count: parseInt(s.count) }))
      });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch live services & ranges from a specific provider via API
router.get('/services/live-from-provider/:providerId', authenticateToken, async (req, res) => {
  try {
    const accountsRes = await db.query(
      `SELECT pa.id, pa.name, pa.api_key, p.base_url, p.unique_code
       FROM provider_accounts pa
       JOIN providers p ON pa.provider_id = p.id
       WHERE pa.provider_id = $1 AND pa.is_active = true AND p.is_active = true
       ORDER BY pa.priority ASC`,
      [req.params.providerId]
    );
    const accounts = accountsRes.rows;
    if (accounts.length === 0) return res.json({ services: [] });

    const baseUrl = accounts[0].base_url.replace(/\/+$/, '');
    const liveAccessRes = await axios.get(
      `${baseUrl}/api/liveaccess`,
      { headers: { 'X-API-Key': accounts[0].api_key }, timeout: 8000 }
    );

    const rawServices = liveAccessRes.data?.services || [];

    let consoleOtps = [];
    try {
      const consoleRes = await axios.get(
        `${accounts[0].base_url.replace(/\/+$/, '')}/api/live-console`,
        { headers: { 'X-API-Key': accounts[0].api_key }, params: { since: 0, limit: 200 }, timeout: 8000 }
      );
      consoleOtps = consoleRes.data?.data?.otps || [];
    } catch (e) {}

    const trafficByRange = {};
    consoleOtps.forEach(o => {
      if (o.hidden === true || o.platform === '***') return;
      const r = o.range || 'Unknown';
      trafficByRange[r] = (trafficByRange[r] || 0) + 1;
    });

    const existingSettings = await db.query('SELECT * FROM service_settings');
    const settingsMap = {};
    existingSettings.rows.forEach(s => { settingsMap[s.platform.toLowerCase()] = s; });

    const services = rawServices.map(svc => {
      const existing = settingsMap[svc.sid.toLowerCase()];
      const savedDisabledRanges = existing && existing.disabled_ranges ? 
        (typeof existing.disabled_ranges === 'string' ? JSON.parse(existing.disabled_ranges) : existing.disabled_ranges) : [];

      const cGroups = {};
      svc.ranges.forEach(r => {
        const prefix = r.replace(/X/gi, '');
        const c = providerManager.getCountryByPrefix(prefix);
        const cKey = c.name;
        if (!cGroups[cKey]) cGroups[cKey] = { name: c.name, flag: c.flag, ranges: [] };
        cGroups[cKey].ranges.push({ range: r, prefix, traffic: trafficByRange[r] || 0 });
      });

      const formattedRanges = [];
      for (const cName in cGroups) {
        const g = cGroups[cName];
        g.ranges.sort((a, b) => a.range.localeCompare(b.range));
        g.ranges.forEach((r, idx) => {
          const isNewRange = existing && !savedDisabledRanges.some(d => d === r.range || d === r.prefix);
          formattedRanges.push({
            range: r.range,
            prefix: r.prefix,
            country: g.name,
            flag: g.flag,
            label: `${g.flag} ${g.name} ${idx + 1}`,
            traffic: r.traffic,
            isEnabled: existing ? isNewRange : true,
            isNew: existing ? isNewRange : true
          });
        });
      }

      return {
        platform: svc.sid,
        isEnabled: existing ? existing.is_enabled : true,
        isNew: !existing,
        ranges: formattedRanges,
        rangeCount: formattedRanges.length
      };
    });

    res.json({ services, providerCode: accounts[0].unique_code });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 3. TELEGRAM BOTS ROUTER
// ----------------------------------------------------
router.get('/bots', authenticateToken, async (req, res) => {
  try {
    const botsRes = await db.query('SELECT * FROM telegram_bots ORDER BY created_at DESC');
    res.json(botsRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bots', authenticateToken, async (req, res) => {
  const { name, token, support_username } = req.body;
  if (!name || !token) {
    return res.status(400).json({ error: 'Name and Token are required' });
  }

  try {
    const id = db.generateUUID();
    const insertRes = await db.query(
      `INSERT INTO telegram_bots (id, name, token, support_username) 
       VALUES ($1, $2, $3, $4)`,
      [id, name, token, support_username]
    );
    const newBot = insertRes.rows[0] || { id, name, token, support_username };
    newBot.is_active = true;

    // Dynamically register the bot webhook/instance
    botManager.createBotInstance(newBot);

    res.status(201).json(newBot);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/bots/test', authenticateToken, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    const resTelegram = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
    res.json(resTelegram.data);
  } catch (err) {
    res.status(400).json({ error: 'Invalid Bot Token. Connection failed.' });
  }
});

router.delete('/bots/:id', authenticateToken, async (req, res) => {
  try {
    const tokenRes = await db.query('SELECT token FROM telegram_bots WHERE id = $1', [req.params.id]);
    const botRecord = tokenRes.rows[0];

    await db.query('DELETE FROM telegram_bots WHERE id = $1', [req.params.id]);

    if (botRecord && botManager.bots[botRecord.token]) {
      try { botManager.bots[botRecord.token].stop(); } catch (e) {}
      delete botManager.bots[botRecord.token];
    }

    res.json({ message: 'Bot deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/bots/:id', authenticateToken, async (req, res) => {
  const { name, token, support_username } = req.body;
  try {
    const fields = [];
    const params = [];
    let idx = 1;

    if (name !== undefined) { fields.push(`name = $${idx++}`); params.push(name); }
    if (token !== undefined) { fields.push(`token = $${idx++}`); params.push(token); }
    if (support_username !== undefined) { fields.push(`support_username = $${idx++}`); params.push(support_username); }

    if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);

    await db.query(
      `UPDATE telegram_bots SET ${fields.join(', ')} WHERE id = $${idx}`,
      params
    );

    const selectRes = await db.query('SELECT * FROM telegram_bots WHERE id = $1', [req.params.id]);
    const updated = selectRes.rows[0];

    if (!updated) return res.status(404).json({ error: 'Bot not found' });

    if (botManager.bots[updated.token]) {
      try { botManager.bots[updated.token].stop(); } catch (e) {}
      delete botManager.bots[updated.token];
    }

    botManager.createBotInstance(updated);

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 4. USERS MANAGEMENT ROUTER
// ----------------------------------------------------
router.get('/users/bot', authenticateToken, async (req, res) => {
  try {
    const botIdFilter = req.query.bot_id;

    let query = `
      SELECT bu.*, tb.name AS bot_name
      FROM bot_users bu
      LEFT JOIN telegram_bots tb ON bu.bot_id = tb.id
    `;
    const params = [];

    if (botIdFilter && botIdFilter !== 'all') {
      query += ' WHERE bu.bot_id = $1';
      params.push(botIdFilter);
    }

    query += ' ORDER BY bu.created_at DESC';
    const usersRes = await db.query(query, params);
    const users = usersRes.rows;

    // Get code count for each user
    const countsRes = await db.query(`
      SELECT an.bot_user_id, COUNT(ro.id) AS count
      FROM allocated_numbers an
      LEFT JOIN received_otps ro ON ro.allocated_number_id = an.id
      GROUP BY an.bot_user_id
    `);
    const counts = countsRes.rows;

    const userOtpsMap = {};
    counts.forEach(item => {
      userOtpsMap[item.bot_user_id] = parseInt(item.count);
    });

    const formattedUsers = users.map(u => ({
      ...u,
      botName: u.bot_name || 'Unknown',
      otpCount: userOtpsMap[u.id] || 0
    }));

    res.json(formattedUsers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/bot/:id/toggle-block', authenticateToken, async (req, res) => {
  const { is_blocked } = req.body;
  try {
    await db.query(
      'UPDATE bot_users SET is_blocked = $1 WHERE id = $2',
      [is_blocked, req.params.id]
    );
    const selRes = await db.query('SELECT * FROM bot_users WHERE id = $1', [req.params.id]);
    res.json(selRes.rows[0] || { id: req.params.id, is_blocked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Web Accounts list
router.get('/users/admin', authenticateToken, async (req, res) => {
  try {
    const adminRes = await db.query('SELECT id, email, role, is_active, created_at FROM admin_users ORDER BY created_at DESC');
    res.json(adminRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/users/admin', authenticateToken, async (req, res) => {
  const { email, temp_password, role, is_active } = req.body;
  if (!email || !temp_password) {
    return res.status(400).json({ error: 'Email and temporary password are required' });
  }

  try {
    const id = db.generateUUID();
    const hash = await bcrypt.hash(temp_password, 10);
    const finalRole = role || 'user';
    const finalActive = is_active !== undefined ? is_active : true;
    await db.query(
      `INSERT INTO admin_users (id, email, password_hash, role, is_active) 
       VALUES ($1, $2, $3, $4, $5)`,
      [id, email, hash, finalRole, finalActive]
    );
    res.status(201).json({ id, email, role: finalRole, is_active: finalActive });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle web account active/suspend status
router.post('/users/admin/:id/toggle-active', authenticateToken, async (req, res) => {
  if (req.user.id === req.params.id) {
    return res.status(400).json({ error: 'Cannot suspend your own account' });
  }

  const { is_active } = req.body;
  try {
    await db.query(
      'UPDATE admin_users SET is_active = $1 WHERE id = $2',
      [is_active, req.params.id]
    );
    const selRes = await db.query('SELECT id, email, role, is_active, created_at FROM admin_users WHERE id = $1', [req.params.id]);
    res.json(selRes.rows[0] || { id: req.params.id, is_active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/users/admin/:id', authenticateToken, async (req, res) => {
  if (req.user.id === req.params.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  try {
    await db.query('DELETE FROM admin_users WHERE id = $1', [req.params.id]);
    res.json({ message: 'Web account deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 5. PROVIDERS & ACCOUNTS (ROTATION) ROUTER
// ----------------------------------------------------
router.get('/providers', authenticateToken, async (req, res) => {
  try {
    const providerRes = await db.query('SELECT * FROM providers');
    res.json(providerRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/providers', authenticateToken, async (req, res) => {
  const { name, unique_code, base_url } = req.body;
  try {
    const id = db.generateUUID();
    const insertRes = await db.query(
      `INSERT INTO providers (id, name, unique_code, base_url) 
       VALUES ($1, $2, $3, $4)`,
      [id, name, unique_code.toUpperCase(), base_url]
    );
    res.status(201).json(insertRes.rows[0] || { id, name, unique_code: unique_code.toUpperCase(), base_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/providers/:id', authenticateToken, async (req, res) => {
  try {
    await db.query('DELETE FROM providers WHERE id = $1', [req.params.id]);
    res.json({ message: 'Provider deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accounts under provider
router.get('/providers/:id/accounts', authenticateToken, async (req, res) => {
  try {
    const accountsRes = await db.query(
      'SELECT * FROM provider_accounts WHERE provider_id = $1 ORDER BY priority ASC',
      [req.params.id]
    );
    res.json(accountsRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/providers/:id/accounts', authenticateToken, async (req, res) => {
  const { name, api_key, priority } = req.body;
  try {
    const id = db.generateUUID();
    const insertRes = await db.query(
      `INSERT INTO provider_accounts (id, provider_id, name, api_key, priority, is_active) 
       VALUES ($1, $2, $3, $4, $5, true)`,
      [id, req.params.id, name, api_key, priority || 1]
    );
    res.status(201).json(insertRes.rows[0] || { id, provider_id: req.params.id, name, api_key, priority: priority || 1, is_active: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/providers/accounts/:accountId', authenticateToken, async (req, res) => {
  try {
    await db.query('DELETE FROM provider_accounts WHERE id = $1', [req.params.accountId]);
    res.json({ message: 'Account deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/providers/accounts/:accountId/toggle-active', authenticateToken, async (req, res) => {
  const { is_active } = req.body;
  try {
    await db.query(
      'UPDATE provider_accounts SET is_active = $1 WHERE id = $2',
      [is_active, req.params.accountId]
    );
    const selRes = await db.query('SELECT * FROM provider_accounts WHERE id = $1', [req.params.accountId]);
    res.json(selRes.rows[0] || { id: req.params.accountId, is_active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/providers/accounts/:accountId/priority', authenticateToken, async (req, res) => {
  const { priority } = req.body;
  try {
    await db.query(
      'UPDATE provider_accounts SET priority = $1 WHERE id = $2',
      [priority, req.params.accountId]
    );
    const selRes = await db.query('SELECT * FROM provider_accounts WHERE id = $1', [req.params.accountId]);
    res.json(selRes.rows[0] || { id: req.params.accountId, priority });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Open Account: view services & ranges for a specific API account
router.get('/providers/accounts/:accountId/open', authenticateToken, async (req, res) => {
  try {
    const accountRes = await db.query(
      `SELECT pa.id, pa.name, pa.api_key, p.base_url, p.name AS provider_name
       FROM provider_accounts pa
       JOIN providers p ON pa.provider_id = p.id
       WHERE pa.id = $1`,
      [req.params.accountId]
    );
    const account = accountRes.rows[0];
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const axios = require('axios');
    const baseUrl = account.base_url.replace(/\/+$/, '');

    const [liveAccessRes, consoleRes] = await Promise.all([
      axios.get(`${baseUrl}/api/liveaccess`, {
        headers: { 'X-API-Key': account.api_key },
        timeout: 8000
      }),
      axios.get(`${baseUrl}/api/live-console`, {
        headers: { 'X-API-Key': account.api_key },
        params: { since: 0, limit: 200 },
        timeout: 8000
      })
    ]);

    const services = liveAccessRes.data?.services || [];
    const otps = consoleRes.data?.data?.otps || [];

    const trafficByRange = {};
    otps.forEach(o => {
      if (o.hidden === true || o.platform === '***') return;
      const r = o.range || 'Unknown';
      trafficByRange[r] = (trafficByRange[r] || 0) + 1;
    });

    const formattedServices = services.map(svc => ({
      platform: svc.sid,
      ranges: (svc.ranges || []).map(r => ({
        range: r,
        prefix: r.replace(/X/gi, ''),
        trafficCount: trafficByRange[r] || 0
      }))
    }));

    res.json({
      accountName: account.name,
      providerName: account.provider_name,
      services: formattedServices
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 9. SYSTEM SETTINGS & ACCOUNT PASSWORD CHANGE
// ----------------------------------------------------
router.get('/services/settings', authenticateToken, async (req, res) => {
  try {
    const settingsRes = await db.query('SELECT * FROM service_settings');
    res.json(settingsRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/services/settings', authenticateToken, async (req, res) => {
  const { platform, is_enabled, disabled_providers, disabled_ranges } = req.body;
  try {
    const id = db.generateUUID();
    const upsertRes = await db.query(
      `INSERT INTO service_settings (id, platform, is_enabled, disabled_providers, disabled_ranges)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (platform) DO UPDATE 
       SET is_enabled = EXCLUDED.is_enabled, 
           disabled_providers = EXCLUDED.disabled_providers, 
            disabled_ranges = EXCLUDED.disabled_ranges`,
      [id, platform, is_enabled, JSON.stringify(disabled_providers), JSON.stringify(disabled_ranges)]
    );
    res.json(upsertRes.rows[0] || { id, platform, is_enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 8. BROADCAST / ANNOUNCEMENT ROUTER
// ----------------------------------------------------
router.get('/broadcast/users/:botId', authenticateToken, async (req, res) => {
  try {
    const usersRes = await db.query(
      `SELECT id, telegram_id, username, first_name, last_name, is_blocked
       FROM bot_users WHERE bot_id = $1 AND is_blocked = false
       ORDER BY first_name ASC`,
      [req.params.botId]
    );
    res.json(usersRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/broadcast/send', authenticateToken, async (req, res) => {
  const { bot_id, user_id, message } = req.body;
  if (!bot_id || !message) return res.status(400).json({ error: 'Bot and message required' });

  try {
    const botRes = await db.query('SELECT token FROM telegram_bots WHERE id = $1', [bot_id]);
    const botRecord = botRes.rows[0];
    if (!botRecord) return res.status(404).json({ error: 'Bot not found' });

    const bot = botManager.bots[botRecord.token];
    if (!bot) return res.status(400).json({ error: 'Bot not running' });

    let sent = 0;
    let failed = 0;

    if (user_id && user_id !== 'all') {
      const userRes = await db.query(
        'SELECT telegram_id FROM bot_users WHERE id = $1 AND is_blocked = false',
        [user_id]
      );
      const user = userRes.rows[0];
      if (user) {
        try {
          await bot.telegram.sendMessage(user.telegram_id, `📢 Announcement\n\n${message}`);
          sent = 1;
        } catch (e) { failed = 1; }
      }
    } else {
      const usersRes = await db.query(
        'SELECT telegram_id FROM bot_users WHERE bot_id = $1 AND is_blocked = false',
        [bot_id]
      );
      for (const u of usersRes.rows) {
        try {
          await bot.telegram.sendMessage(u.telegram_id, `📢 Announcement\n\n${message}`);
          sent++;
          await new Promise(r => setTimeout(r, 200));
        } catch (e) { failed++; }
      }
    }

    res.json({ sent, failed, total: sent + failed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
router.get('/settings/public-contact', async (req, res) => {
  try {
    const settingRes = await db.query("SELECT value FROM system_settings WHERE key = 'admin_support_url' LIMIT 1");
    const data = settingRes.rows[0];

    if (!data) {
      return res.json({ support_url: 'https://t.me/ak_admin' });
    }
    res.json({ support_url: data.value });
  } catch (err) {
    res.json({ support_url: 'https://t.me/ak_admin' });
  }
});

router.get('/settings/global', authenticateToken, async (req, res) => {
  try {
    const settingRes = await db.query("SELECT value FROM system_settings WHERE key = 'admin_support_url' LIMIT 1");
    const data = settingRes.rows[0];

    if (!data) {
      return res.json({ support_url: 'https://t.me/ak_admin' });
    }
    res.json({ support_url: data.value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/settings/global', authenticateToken, async (req, res) => {
  const { support_url } = req.body;
  if (!support_url) return res.status(400).json({ error: 'Support URL is required' });

  try {
    await db.query(
      `INSERT INTO system_settings (key, value) VALUES ('admin_support_url', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [support_url]
    );
    res.json({ message: 'Settings saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/settings/change-password', authenticateToken, async (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) {
    return res.status(400).json({ error: 'Old and new passwords are required' });
  }

  try {
    const userRes = await db.query('SELECT * FROM admin_users WHERE id = $1 LIMIT 1', [req.user.id]);
    const user = userRes.rows[0];

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const validPassword = await bcrypt.compare(old_password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Incorrect current password' });
    }

    const hash = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);

    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
