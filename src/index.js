const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const botManager = require('./bot/telegramBotManager');
const providerManager = require('./services/providerManager');
const serviceAutoSync = require('./services/serviceAutoSync');
const otpPoller = require('./services/otpPoller');
const adminRouter = require('./admin/server');
const userPanelRouter = require('./admin/userPanel');
const db = require('./db/pg');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretjwtkeyforaknumberpanel';

// Production webhook setup for Telegram bots
async function setupProductionWebhooks(baseUrl) {
  const axios = require('axios');
  const cleanUrl = baseUrl.replace(/\/+$/, '');
  console.log(`🔗 Setting up webhooks at: ${cleanUrl}/webhook/telegram/<token>`);

  try {
    const botsRes = await db.query('SELECT token, name FROM telegram_bots WHERE is_active = true');
    for (const bot of botsRes.rows) {
      try {
        const webhookPath = `${cleanUrl}/webhook/telegram/${bot.token}`;
        const res = await axios.post(`https://api.telegram.org/bot${bot.token}/setWebhook`, { url: webhookPath });
        if (res.data && res.data.ok) {
          console.log(`  ✓ "${bot.name}" webhook set`);
        } else {
          console.log(`  ✗ "${bot.name}" webhook failed:`, res.data.description);
        }
      } catch (err) {
        console.error(`  ✗ "${bot.name}" webhook error:`, err.message);
      }
    }
  } catch (err) {
    console.error('Webhook setup error:', err.message);
  }
}

// Enable CORS
app.use(cors());

// Parse JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ===== PAGE ROUTES (must be before express.static) =====

// Landing page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/landing.html'));
});

// User Panel (requires auth — redirects to landing if no cookie)
app.get('/user', (req, res) => {
  const token = req.cookies?.user_session;
  if (!token) return res.redirect('/');
  try {
    jwt.verify(token, JWT_SECRET);
    res.sendFile(path.join(__dirname, '../public/user.html'));
  } catch (e) {
    res.redirect('/');
  }
});

// Admin Panel (requires admin auth — redirects to landing if no token)
app.get('/admin', (req, res) => {
  const token = req.cookies?.ak_token || req.headers['authorization']?.split(' ')[1];
  if (!token) {
    // Serve index.html — the JS will check localStorage and show login
    res.sendFile(path.join(__dirname, '../public/index.html'));
  } else {
    try {
      jwt.verify(token, JWT_SECRET);
      res.sendFile(path.join(__dirname, '../public/index.html'));
    } catch (e) {
      res.sendFile(path.join(__dirname, '../public/index.html'));
    }
  }
});

// Serve static frontend files from 'public' folder (CSS, JS, icons, etc.)
// index: false prevents auto-serving index.html at /
app.use('/index.html', (req, res) => res.redirect('/admin'));
app.use(express.static(path.join(__dirname, '../public'), { index: false }));

// Webhook endpoint for Telegram Bots
app.post('/webhook/telegram/:token', async (req, res) => {
  const { token } = req.params;
  try {
    await botManager.handleWebhook(token, req, res);
  } catch (err) {
    console.error(`Error processing webhook for token ${token}:`, err.message);
    res.status(500).send('Internal Server Error');
  }
});

// Admin REST APIs
app.use('/api', adminRouter);

// User Panel REST APIs
app.use('/api/user-panel', userPanelRouter);

// Catch-all redirect to landing
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/webhook')) return;
  res.redirect('/');
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Express Error:', err.message);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Initialize Background Workers and Launch server
async function bootstrap() {
  console.log('Bootstrapping AK NUMBER PANEL System...');

  try {
    // 0. Auto-initialize Database tables if they do not exist
    await db.initializeDatabase();

    // 1. Start dynamic Telegram Bots loading and configuration
    await botManager.initBots();

    // 2. Start API Health Latency Checks
    providerManager.startHealthChecks();

    // 3. Start Service Auto-Sync (every 10 minutes)
    serviceAutoSync.startAutoSync();

    // 4. Start OTP Poller Loop
    otpPoller.startPolling();

    // 5. Start Server Listening
    app.listen(PORT, () => {
      console.log(`🚀 AK NUMBER PANEL is running on port ${PORT}`);
      console.log(`🤖 Telegram Webhook path: /webhook/telegram/<token>`);

      // Production: auto-configure Telegram webhooks if WEBHOOK_URL is set
      const webhookUrl = process.env.WEBHOOK_URL;
      if (webhookUrl) {
        setupProductionWebhooks(webhookUrl);
      }
    });
  } catch (err) {
    console.error('FATAL System Bootstrap Error:', err);
    process.exit(1);
  }
}

bootstrap();
