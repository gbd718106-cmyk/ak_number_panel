const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const db = require('../db/pg');
const providerManager = require('../services/providerManager');

const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkeyforaknumberpanel';

// Cache for live services to avoid repeated API calls
let servicesCache = null;
let servicesCacheTime = 0;
const CACHE_TTL = 30000; // 30 seconds

async function getCachedServices() {
  const now = Date.now();
  if (servicesCache && (now - servicesCacheTime) < CACHE_TTL) {
    return servicesCache;
  }
  servicesCache = await providerManager.getLiveServices();
  servicesCacheTime = now;
  return servicesCache;
}

// Unified User Panel JWT Auth Middleware (Telegram + Web accounts)
async function authenticateUser(req, res, next) {
  const token = req.cookies?.user_session || req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired session' });
    req.user = user;
    next();
  });
}

// Check if user is blocked (runs after authenticateUser)
async function checkUserBlocked(req, res, next) {
  try {
    const userRes = await db.query(
      'SELECT is_blocked FROM bot_users WHERE id = $1 LIMIT 1',
      [req.user.bot_user_id]
    );
    const user = userRes.rows[0];
    if (user && user.is_blocked) {
      return res.status(403).json({ error: 'Your account has been blocked. Please contact support.' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ----------------------------------------------------
// 1. AUTHENTICATION ROUTES
// ----------------------------------------------------

// Generate auth token and return Telegram deep link
router.post('/auth/start', async (req, res) => {
  try {
    const { bot_id } = req.body;
    
    const botRes = await db.query('SELECT id FROM telegram_bots WHERE is_active = true LIMIT 1');
    const targetBot = bot_id ? await db.query('SELECT id FROM telegram_bots WHERE id = $1 AND is_active = true', [bot_id]) : botRes;
    const bot = targetBot.rows[0];
    
    if (!bot) return res.status(400).json({ error: 'No active bot available' });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes

    await db.query(
      `INSERT INTO web_auth_tokens (token, bot_id, expires_at) VALUES ($1, $2, $3)`,
      [rawToken, bot.id, expiresAt.toISOString()]
    );

    const botToken = (await db.query('SELECT token FROM telegram_bots WHERE id = $1', [bot.id])).rows[0]?.token;
    const botUsername = (await db.query('SELECT name FROM telegram_bots WHERE id = $1', [bot.id])).rows[0]?.name || 'AK NUMBER PANEL';
    
    let botTelegramUsername = 'AKNUMBERPANELBOT';
    if (botToken) {
      try {
        const meRes = await axios.get(`https://api.telegram.org/bot${botToken}/getMe`);
        botTelegramUsername = meRes.data.result?.username || botTelegramUsername;
      } catch (e) {
        console.error('Failed to get bot username:', e.message);
      }
    }
    
    const deepLink = `https://t.me/${botTelegramUsername}?start=web_${rawToken}`;

    res.json({ 
      deep_link: deepLink,
      bot_name: botUsername,
      token: rawToken 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Email/Password login for Web Accounts
router.post('/auth/login-web', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  try {
    const userRes = await db.query('SELECT * FROM admin_users WHERE email = $1 LIMIT 1', [email]);
    const webUser = userRes.rows[0];

    if (!webUser) return res.status(401).json({ error: 'Invalid credentials' });
    if (!webUser.is_active) return res.status(403).json({ error: 'Account suspended' });

    const valid = await bcrypt.compare(password, webUser.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // Find or create bot_user record for this web user
    const fakeTelegramId = -(parseInt(crypto.createHash('md5').update(email).digest('hex').substring(0, 12), 16) % 900000000000) - 100000;
    const botRes = await db.query('SELECT id FROM telegram_bots WHERE is_active = true LIMIT 1');
    const bot = botRes.rows[0];
    if (!bot) return res.status(500).json({ error: 'No active bot available' });

    let botUserId;
    const buRes = await db.query(
      'SELECT id FROM bot_users WHERE bot_id = $1 AND telegram_id = $2 LIMIT 1',
      [bot.id, fakeTelegramId]
    );
    if (buRes.rows[0]) {
      botUserId = buRes.rows[0].id;
    } else {
      botUserId = db.generateUUID();
      await db.query(
        'INSERT INTO bot_users (id, bot_id, telegram_id, username, first_name) VALUES ($1, $2, $3, $4, $5)',
        [botUserId, bot.id, fakeTelegramId, email, email.split('@')[0]]
      );
    }

    const sessionToken = jwt.sign(
      { user_type: 'web', email: webUser.email, role: webUser.role, bot_user_id: botUserId, bot_id: bot.id },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.cookie('user_session', sessionToken, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000
    });

    res.json({ success: true, email: webUser.email, role: webUser.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify auth token (called after user clicks link in Telegram)
router.get('/auth/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) {
    return res.redirect('/landing?error=missing_token');
  }

  try {
    const tokenRes = await db.query(
      'SELECT * FROM web_auth_tokens WHERE token = $1 AND used = false AND expires_at > NOW() LIMIT 1',
      [token]
    );
    const authToken = tokenRes.rows[0];

    if (!authToken) {
      return res.redirect('/landing?error=invalid_token');
    }

    // Mark token as used
    await db.query('UPDATE web_auth_tokens SET used = true WHERE id = $1', [authToken.id]);

    // Get or create bot_user
    let botUser;
    if (authToken.telegram_user_id) {
      const userRes = await db.query(
        'SELECT * FROM bot_users WHERE bot_id = $1 AND telegram_id = $2 LIMIT 1',
        [authToken.bot_id, authToken.telegram_user_id]
      );
      botUser = userRes.rows[0];
      
      if (!botUser) {
        const newId = db.generateUUID();
        await db.query(
          `INSERT INTO bot_users (id, bot_id, telegram_id) VALUES ($1, $2, $3)`,
          [newId, authToken.bot_id, authToken.telegram_user_id]
        );
        botUser = { id: newId, bot_id: authToken.bot_id, telegram_id: authToken.telegram_user_id };
      }
    } else {
      return res.redirect('/landing?error=incomplete_auth');
    }

    // Create JWT session
    const sessionToken = jwt.sign(
      { 
        telegram_user_id: botUser.telegram_id, 
        bot_user_id: botUser.id, 
        bot_id: authToken.bot_id 
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Set httpOnly cookie and redirect to user panel
    res.cookie('user_session', sessionToken, {
      path: '/',
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });

    res.redirect('/user');
  } catch (err) {
    console.error('Verify auth error:', err.message);
    res.redirect('/landing?error=server_error');
  }
});

// Get current user info
router.get('/auth/me', authenticateUser, checkUserBlocked, async (req, res) => {
  try {
    const userRes = await db.query(
      'SELECT bu.*, tb.name AS bot_name, tb.support_username FROM bot_users bu JOIN telegram_bots tb ON bu.bot_id = tb.id WHERE bu.id = $1',
      [req.user.bot_user_id]
    );
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    
    if (req.user.user_type === 'web') {
      user.email = req.user.email;
      user.role = req.user.role;
    }
    
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Logout
router.post('/auth/logout', (req, res) => {
  res.clearCookie('user_session');
  res.json({ success: true });
});

// Change password (web accounts only)
router.post('/auth/change-password', authenticateUser, checkUserBlocked, async (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) {
    return res.status(400).json({ error: 'Both old and new passwords required' });
  }
  if (new_password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    if (req.user.user_type !== 'web') {
      return res.status(400).json({ error: 'Password change only available for web accounts' });
    }

    const userRes = await db.query('SELECT * FROM admin_users WHERE email = $1 LIMIT 1', [req.user.email]);
    const webUser = userRes.rows[0];
    if (!webUser) return res.status(404).json({ error: 'Account not found' });

    const valid = await bcrypt.compare(old_password, webUser.password_hash);
    if (!valid) return res.status(401).json({ error: 'Incorrect current password' });

    const hash = await bcrypt.hash(new_password, 10);
    await db.query('UPDATE admin_users SET password_hash = $1 WHERE email = $2', [hash, req.user.email]);
    res.json({ message: 'Password changed successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 2. DASHBOARD ROUTES
// ----------------------------------------------------

router.get('/dashboard', authenticateUser, checkUserBlocked, async (req, res) => {
  try {
    const botUserId = req.user.bot_user_id;
    
    const activeNumberRes = await db.query(
      "SELECT COUNT(*) AS count FROM allocated_numbers WHERE bot_user_id = $1 AND status = 'active'",
      [botUserId]
    );
    const completedRes = await db.query(
      "SELECT COUNT(*) AS count FROM received_otps ro JOIN allocated_numbers an ON ro.allocated_number_id = an.id WHERE an.bot_user_id = $1 AND ro.received_at > NOW()::date",
      [botUserId]
    );
    const totalOtpRes = await db.query(
      "SELECT COUNT(*) AS count FROM received_otps ro JOIN allocated_numbers an ON ro.allocated_number_id = an.id WHERE an.bot_user_id = $1",
      [botUserId]
    );

    res.json({
      activeNumbers: parseInt(activeNumberRes.rows[0]?.count || 0),
      otpsToday: parseInt(completedRes.rows[0]?.count || 0),
      totalOtps: parseInt(totalOtpRes.rows[0]?.count || 0)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 3. SERVICES ROUTES
// ----------------------------------------------------

// Get enabled services for the user
router.get('/services', authenticateUser, checkUserBlocked, async (req, res) => {
  try {
    const services = await getCachedServices();
    const settingsRes = await db.query('SELECT * FROM service_settings');
    const settingsMap = {};
    settingsRes.rows.forEach(s => { settingsMap[s.platform.toLowerCase()] = s; });

    const enabledServices = services.filter(s => {
      const setting = settingsMap[s.sid.toLowerCase()];
      return setting && setting.is_enabled;
    });

    res.json(enabledServices);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get countries/ranges for a service
router.get('/services/:platform/countries', authenticateUser, checkUserBlocked, async (req, res) => {
  try {
    const { platform } = req.params;
    const services = await getCachedServices();
    const match = services.find(s => s.sid === platform);
    
    if (!match) return res.status(404).json({ error: 'Service not found' });

    const settingsRes = await db.query('SELECT disabled_ranges FROM service_settings WHERE platform = $1', [platform]);
    const disabledRanges = settingsRes.rows[0]?.disabled_ranges 
      ? (typeof settingsRes.rows[0].disabled_ranges === 'string' ? JSON.parse(settingsRes.rows[0].disabled_ranges) : settingsRes.rows[0].disabled_ranges)
      : [];

    const countryMap = {};
    for (const r of match.ranges) {
      if (disabledRanges.some(d => r.rawRange.startsWith(d))) continue;
      const c = providerManager.getCountryByPrefix(r.rawRange.replace(/X/gi, ''));
      const cKey = c.name;
      if (!countryMap[cKey]) countryMap[cKey] = { name: c.name, flag: c.flag, ranges: [] };
      countryMap[cKey].ranges.push({ range: r.rawRange, displayName: r.displayName, providerCode: r.providerCode });
    }

    const countries = Object.entries(countryMap).map(([name, data]) => ({
      name: data.name,
      flag: data.flag,
      rangeCount: data.ranges.length
    })).sort((a, b) => a.name.localeCompare(b.name));

    res.json(countries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get ranges for a specific country within a service
router.get('/services/:platform/countries/:countryName/ranges', authenticateUser, checkUserBlocked, async (req, res) => {
  try {
    const { platform, countryName } = req.params;
    const services = await getCachedServices();
    const match = services.find(s => s.sid === platform);
    
    if (!match) return res.status(404).json({ error: 'Service not found' });

    const settingsRes = await db.query('SELECT disabled_ranges FROM service_settings WHERE platform = $1', [platform]);
    const disabledRanges = settingsRes.rows[0]?.disabled_ranges 
      ? (typeof settingsRes.rows[0].disabled_ranges === 'string' ? JSON.parse(settingsRes.rows[0].disabled_ranges) : settingsRes.rows[0].disabled_ranges)
      : [];

    const ranges = match.ranges
      .filter(r => {
        if (disabledRanges.some(d => r.rawRange.startsWith(d))) return false;
        const c = providerManager.getCountryByPrefix(r.rawRange.replace(/X/gi, ''));
        return c.name === countryName;
      })
      .map(r => ({
        range: r.rawRange,
        displayName: r.displayName,
        providerCode: r.providerCode
      }))
      .sort((a, b) => a.range.localeCompare(b.range));

    res.json(ranges);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Allocate a number
router.post('/services/allocate', authenticateUser, checkUserBlocked, async (req, res) => {
  const { platform, providerCode, range } = req.body;
  if (!platform || !providerCode || !range) {
    return res.status(400).json({ error: 'Platform, providerCode, and range are required' });
  }

  try {
    const botUserId = req.user.bot_user_id;
    const botId = req.user.bot_id;

    await db.query(
      "UPDATE allocated_numbers SET status = 'expired' WHERE bot_user_id = $1 AND status = 'active'",
      [botUserId]
    );

    const result = await providerManager.allocateNumber(providerCode, range, platform, botUserId, botId);

    if (!result || !result.number) {
      return res.status(500).json({ error: 'Failed to allocate number. Provider may be out of stock.' });
    }

    await db.query(
      `UPDATE bot_users SET last_platform = $1, last_range = $2, last_provider_code = $3 WHERE id = $4`,
      [platform, range, providerCode, botUserId]
    );

    res.json({
      success: true,
      number: result.number,
      platform,
      range,
      providerCode,
      country: result.country,
      operator: result.operator
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 4. OTP ROUTES
// ----------------------------------------------------

// Get user's OTP history
router.get('/otps', authenticateUser, checkUserBlocked, async (req, res) => {
  try {
    const botUserId = req.user.bot_user_id;
    const otpsRes = await db.query(`
      SELECT ro.otp_code, ro.raw_message, ro.received_at, an.platform, an.range, an.number
      FROM received_otps ro
      JOIN allocated_numbers an ON ro.allocated_number_id = an.id
      WHERE an.bot_user_id = $1
      ORDER BY ro.received_at DESC
      LIMIT 50
    `, [botUserId]);
    res.json(otpsRes.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get traffic stats
router.get('/traffic', authenticateUser, checkUserBlocked, async (req, res) => {
  try {
    const traffic = {};
    const accountsRes = await db.query(`
      SELECT pa.api_key, p.base_url, p.unique_code AS provider_code
      FROM provider_accounts pa
      JOIN providers p ON pa.provider_id = p.id
      WHERE pa.is_active = true AND p.is_active = true
    `);
    const accounts = accountsRes.rows;

    for (const account of accounts) {
      try {
        const baseUrl = account.base_url.replace(/\/+$/, '');
        const response = await require('axios').get(`${baseUrl}/api/live-console`, {
          headers: { 'X-API-Key': account.api_key },
          params: { since: 0, limit: 200 },
          timeout: 6000
        });

        if (response.data && response.data.data && response.data.data.otps) {
          for (const otp of response.data.data.otps) {
            if (otp.hidden === true || otp.platform === '***') continue;
            const platform = otp.platform || 'Unknown';
            const range = otp.range || 'Unknown';
            if (!traffic[platform]) traffic[platform] = {};
            if (!traffic[platform][range]) {
              traffic[platform][range] = { count: 0, providerCode: account.provider_code };
            }
            traffic[platform][range].count++;
          }
        }
      } catch (err) {
        // Skip failed provider
      }
    }
    res.json(traffic);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get OTP traffic from DB (today's stats)
router.get('/otp-traffic', authenticateUser, checkUserBlocked, async (req, res) => {
  try {
    const statsRes = await db.query(`
      SELECT an.platform, an.range, COUNT(*) as count
      FROM received_otps ro
      JOIN allocated_numbers an ON ro.allocated_number_id = an.id
      WHERE ro.received_at > NOW()::date
      GROUP BY an.platform, an.range
      ORDER BY an.platform, count DESC
    `);

    const grouped = {};
    let totalAll = 0;
    for (const r of statsRes.rows) {
      if (!grouped[r.platform]) grouped[r.platform] = { ranges: [], total: 0 };
      const prefix = (r.range || '').replace(/X/gi, '');
      const c = providerManager.getCountryByPrefix(prefix);
      grouped[r.platform].ranges.push({ range: r.range, country: c.name, flag: c.flag, count: parseInt(r.count) });
      grouped[r.platform].total += parseInt(r.count);
      totalAll += parseInt(r.count);
    }

    res.json({ grouped, total: totalAll });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 5. SUPPORT ROUTE
// ----------------------------------------------------

router.get('/support', authenticateUser, checkUserBlocked, async (req, res) => {
  try {
    const settingRes = await db.query("SELECT value FROM system_settings WHERE key = 'admin_support_url' LIMIT 1");
    const supportUrl = settingRes.rows[0]?.value || 'https://t.me/ak_admin';
    res.json({ support_url: supportUrl });
  } catch (err) {
    res.json({ support_url: 'https://t.me/ak_admin' });
  }
});

module.exports = router;
