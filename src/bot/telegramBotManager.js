const axios = require('axios');
const { Telegraf, Markup } = require('telegraf');
const db = require('../db/pg');
const providerManager = require('../services/providerManager');
const otpPoller = require('../services/otpPoller');

const bots = {};

async function fetchLiveTraffic() {
  const traffic = {};
  try {
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
        const res = await axios.get(`${baseUrl}/api/live-console`, {
          headers: { 'X-API-Key': account.api_key },
          params: { since: 0, limit: 100 },
          timeout: 6000
        });

        if (res.data && res.data.data && res.data.data.otps) {
          for (const otp of res.data.data.otps) {
            if (otp.hidden === true || otp.platform === '***') continue;
            const platform = otp.platform || 'Unknown';
            const range = otp.range || 'Unknown';
            if (!traffic[platform]) traffic[platform] = {};
            if (!traffic[platform][range]) {
              traffic[platform][range] = { count: 0, providerCode: account.provider_code };
            }
            traffic[platform][range].count++;
            if (!traffic[platform][range].providerCode && account.provider_code) {
              traffic[platform][range].providerCode = account.provider_code;
            }
          }
        }
      } catch (err) {
        console.error(`Traffic fetch error for account:`, err.message);
      }
    }
  } catch (err) {
    console.error('Fetch live traffic error:', err.message);
  }
  return traffic;
} // Store bot instances by token

function getMainMenuMarkup() {
  return Markup.keyboard([
    ['📱 Services', '🔄 Get a New Number'],
    ['📊 Traffic', '📊 OTP Traffic'],
    ['🔢 Number Range', '📞 Support']
  ]).resize();
}

/**
 * Middlewares for bot authentication, blocking check, and user creation
 */
async function handleUserAndCheckBlocked(ctx, next) {
  const telegramId = ctx.from.id;
  const username = ctx.from.username || null;
  const firstName = ctx.from.first_name || '';
  const lastName = ctx.from.last_name || '';
  const botToken = ctx.telegram.token;
  const msgText = ctx.message?.text || '';

  try {
    // Find Bot ID
    const botRes = await db.query(
      'SELECT id, name FROM telegram_bots WHERE token = $1 LIMIT 1',
      [botToken]
    );
    const botInfo = botRes.rows[0];

    if (!botInfo) return; // Unknown bot token

    ctx.state.botId = botInfo.id;
    ctx.state.botName = botInfo.name;

    // Get or Create user
    const userRes = await db.query(
      'SELECT * FROM bot_users WHERE bot_id = $1 AND telegram_id = $2 LIMIT 1',
      [botInfo.id, telegramId]
    );
    let user = userRes.rows[0];

    if (!user) {
      const id = db.generateUUID();
      await db.query(
        `INSERT INTO bot_users (id, bot_id, telegram_id, username, first_name, last_name, is_blocked)
         VALUES ($1, $2, $3, $4, $5, $6, false)`,
        [id, botInfo.id, telegramId, username, firstName, lastName]
      );
      user = { id, bot_id: botInfo.id, telegram_id: telegramId, username, first_name: firstName, last_name: lastName, is_blocked: false };
    } else {
      await db.query(
        `UPDATE bot_users 
         SET username = $1, first_name = $2, last_name = $3, last_active_at = NOW() 
         WHERE id = $4`,
        [username, firstName, lastName, user.id]
      );
      user.username = username || user.username;
      user.first_name = firstName;
      user.last_name = lastName;
    }

    if (user.is_blocked) {
      return ctx.reply('❌ You are blocked. Please contact support.');
    }

    ctx.state.dbUser = user;
    return next();
  } catch (err) {
    console.error('Error in handleUserAndCheckBlocked middleware:', err.message, '| msg:', msgText);
  }
}

/**
 * Initializes and configures handlers for a bot token
 */
function createBotInstance(botRecord) {
  const token = botRecord.token;
  if (bots[token]) {
    return bots[token];
  }

  const bot = new Telegraf(token);
  bot.use(handleUserAndCheckBlocked);

  // Command handlers
  bot.start(async (ctx) => {
    console.log(`📩 /start received from user ${ctx.from.id} (${ctx.from.username || ctx.from.first_name}) on bot "${ctx.state.botName}"`);
    const startText = ctx.message?.text || '';
    
    // Check for web auth token
    const webAuthMatch = startText.match(/web_(.+)/);
    if (webAuthMatch) {
      const authToken = webAuthMatch[1];
      try {
        const tokenRes = await db.query(
          'SELECT * FROM web_auth_tokens WHERE token = $1 AND used = false AND expires_at > NOW() LIMIT 1',
          [authToken]
        );
        const authTokenRecord = tokenRes.rows[0];
        
        if (authTokenRecord) {
          await db.query(
            'UPDATE web_auth_tokens SET telegram_user_id = $1 WHERE id = $2',
            [ctx.from.id, authTokenRecord.id]
          );
          
          const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3000';
          const verifyUrl = `${websiteUrl}/api/user-panel/auth/verify?token=${authToken}`;
          
          await ctx.reply(
            `✅ <b>Authentication Successful!</b>\n\nClick the button below to access your panel:`,
            Markup.inlineKeyboard([
              [Markup.button.url('🌐 Access My Panel', verifyUrl)]
            ])
          );
          return;
        }
      } catch (err) {
        console.error('Web auth error:', err.message);
      }
    }
    
    const brandName = ctx.state.botName || 'AK NUMBER PANEL';
    await ctx.reply(
      `👋 Welcome to ${brandName}!\n\nUse the menu buttons below to manage your OTP requests.`,
      getMainMenuMarkup()
    );
  });

  // 📱 Services Button
  bot.hears('📱 Services', async (ctx) => {
    try {
      await ctx.reply('⏳ Loading available services...');
      const services = await providerManager.getLiveServices();

      if (services.length === 0) {
        return ctx.reply('⚠️ No services are currently available. Please try again later.');
      }

      const buttons = services.map(s => [Markup.button.callback(s.sid, `select_service:${s.sid}`)]);
      await ctx.reply('📱 Select a service:', Markup.inlineKeyboard(buttons));
    } catch (err) {
      console.error('Services error:', err.message);
      try { await ctx.reply('❌ Failed to retrieve services.'); } catch (e) {}
    }
  });

  // Callback to select a service → show country groups
  bot.action(/^select_service:(.+)$/, async (ctx) => {
    const serviceName = ctx.match[1];
    await ctx.answerCbQuery();

    try {
      const services = await providerManager.getLiveServices();
      const match = services.find(s => s.sid === serviceName);

      if (!match || match.ranges.length === 0) {
        return ctx.reply(`⚠️ No ranges available for ${serviceName}.`);
      }

      // Group ranges by country
      const countryMap = {};
      for (const r of match.ranges) {
        const c = providerManager.getCountryByPrefix(r.rawRange.replace(/X/gi, ''));
        const cKey = c.name;
        if (!countryMap[cKey]) countryMap[cKey] = { name: c.name, flag: c.flag, ranges: [] };
        countryMap[cKey].ranges.push(r);
      }

      // Build 2-column country buttons
      const entries = Object.entries(countryMap).sort((a, b) => a[0].localeCompare(b[0]));
      const buttons = [];
      for (let i = 0; i < entries.length; i += 2) {
        const row = [];
        for (let j = i; j < Math.min(i + 2, entries.length); j++) {
          const [cName, cData] = entries[j];
          const label = `${cData.flag} ${cName} (${cData.ranges.length})`;
          row.push(Markup.button.callback(label, `select_country:${serviceName}:${cName}`));
        }
        buttons.push(row);
      }

      await ctx.reply(`🌍 Select country for ${serviceName}:`, Markup.inlineKeyboard(buttons));
    } catch (err) {
      console.error(err);
      try { await ctx.reply('❌ Failed to load country list.'); } catch (e) {}
    }
  });

  // Callback to select a country → show specific ranges
  bot.action(/^select_country:(.+):(.+)$/, async (ctx) => {
    const serviceName = ctx.match[1];
    const countryName = ctx.match[2];
    await ctx.answerCbQuery();

    try {
      const services = await providerManager.getLiveServices();
      const match = services.find(s => s.sid === serviceName);
      if (!match) return ctx.reply('⚠️ Service not found.');

      // Filter ranges for this country
      const countryRanges = match.ranges.filter(r => {
        const c = providerManager.getCountryByPrefix(r.rawRange.replace(/X/gi, ''));
        return c.name === countryName;
      }).sort((a, b) => a.rawRange.localeCompare(b.rawRange));

      if (countryRanges.length === 0) return ctx.reply(`⚠️ No ranges for ${countryName}.`);

      const buttons = countryRanges.map(r => [
        Markup.button.callback(r.displayName, `select_range:${serviceName}:${r.providerCode}:${r.rawRange}`)
      ]);

      await ctx.reply(`🔢 ${countryName} ranges:`, Markup.inlineKeyboard(buttons));
    } catch (err) {
      console.error(err);
      try { await ctx.reply('❌ Failed to load ranges.'); } catch (e) {}
    }
  });

  // Callback to select a specific range & allocate number
  bot.action(/^select_range:(.+):(.+):(.+)$/, async (ctx) => {
    const platform = ctx.match[1];
    const providerCode = ctx.match[2];
    const range = ctx.match[3];
    await ctx.answerCbQuery();

    await ctx.reply(`⏳ Requesting number from range ${range}...`);

    try {
      const botUserId = ctx.state.dbUser.id;
      const botId = ctx.state.botId;

      await db.query(
        "UPDATE allocated_numbers SET status = 'expired' WHERE bot_user_id = $1 AND status = 'active'",
        [botUserId]
      );

      const result = await providerManager.allocateNumber(providerCode, range, platform, botUserId, botId);

      await db.query(
        `UPDATE bot_users SET last_platform = $1, last_range = $2, last_provider_code = $3 WHERE id = $4`,
        [platform, range, providerCode, botUserId]
      );

      let msg = `✅ <b>Number Allocated!</b>\n\n`;
      msg += `📱 Service: ${platform}\n`;
      msg += `🔢 Range: ${range} (${providerCode})\n`;
      msg += `📍 Country: ${result.country}\n`;
      msg += `📶 Operator: ${result.operator}\n\n`;
      msg += `📞 <code>${result.number}</code> (tap to copy)\n\n`;
      msg += `⏳ Waiting for OTP. Max wait: 10 mins.`;

      await ctx.reply(msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Get Another Number', 'get_new_number_direct')]
      ]) });
    } catch (err) {
      console.error(err);
      const errorMsg = err.message || 'Unknown error';
      const friendlyMsg = errorMsg.toLowerCase().includes('stock')
        ? `❌ স্টক শেষ — এই লেন্সে নাম্বার available নেই। অন্য লেন্স সিলেক্ট করুন।`
        : errorMsg.includes('400') || errorMsg.includes('status code')
          ? `❌ এই লেন্সে নাম্বার নেই (স্টক শেষ)। অন্য লেন্স বা রেঞ্জ ট্রাই করুন।`
          : `❌ Failed: ${errorMsg}`;
      try { await ctx.reply(friendlyMsg); } catch (e) {}
    }
  });

  // 🔄 Get a New Number Button / Callback
  async function handleGetNewNumber(ctx) {
    const user = ctx.state.dbUser;
    if (!user.last_platform || !user.last_range || !user.last_provider_code) {
      return ctx.reply('⚠️ No previous service. Click 📱 Services first.');
    }

    await ctx.reply(`⏳ Requesting new number for ${user.last_platform}...`);

    try {
      const botUserId = user.id;
      const botId = ctx.state.botId;

      await db.query(
        "UPDATE allocated_numbers SET status = 'expired' WHERE bot_user_id = $1 AND status = 'active'",
        [botUserId]
      );

      const result = await providerManager.allocateNumber(
        user.last_provider_code, user.last_range, user.last_platform, botUserId, botId
      );

      let msg = `✅ <b>Number Allocated!</b>\n\n`;
      msg += `📱 Service: ${user.last_platform}\n`;
      msg += `🔢 Range: ${user.last_range} (${user.last_provider_code})\n`;
      msg += `📍 Country: ${result.country}\n`;
      msg += `📶 Operator: ${result.operator}\n\n`;
      msg += `📞 <code>${result.number}</code> (tap to copy)\n\n`;
      msg += `⏳ Waiting for OTP.`;

      await ctx.reply(msg, { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Get Another Number', 'get_new_number_direct')]
      ]) });
    } catch (err) {
      console.error(err);
      const errorMsg = err.message || 'Unknown error';
      const friendlyMsg = errorMsg.toLowerCase().includes('stock')
        ? `❌ স্টক শেষ — এই লেন্সে নাম্বার available নেই। অন্য লেন্স সিলেক্ট করুন।`
        : errorMsg.includes('400') || errorMsg.includes('status code')
          ? `❌ এই লেন্সে নাম্বার নেই (স্টক শেষ)। অন্য লেন্স বা রেঞ্জ ট্রাই করুন।`
          : `❌ Failed: ${errorMsg}`;
      try { await ctx.reply(friendlyMsg); } catch (e) {}
    }
  }

  bot.hears('🔄 Get a New Number', handleGetNewNumber);
  bot.action('get_new_number_direct', async (ctx) => {
    await ctx.answerCbQuery();
    await handleGetNewNumber(ctx);
  });

  // 📊 Traffic Button - Live traffic from API
  bot.hears('📊 Traffic', async (ctx) => {
    await ctx.reply('⏳ Loading live traffic data from providers...');
    try {
      const trafficData = await fetchLiveTraffic();

      if (Object.keys(trafficData).length === 0) {
        return ctx.reply('📊 Live Traffic Report\n\nNo traffic detected from providers.');
      }

      let msg = '📊 Live Traffic Report\n\n';
      const platforms = Object.keys(trafficData).sort((a, b) => {
        let ta = 0, tb = 0;
        Object.values(trafficData[a]).forEach(v => ta += v.count);
        Object.values(trafficData[b]).forEach(v => tb += v.count);
        return tb - ta;
      });

      for (const platform of platforms) {
        const ranges = trafficData[platform];
        let total = 0;
        Object.values(ranges).forEach(v => total += v.count);
        msg += `\n${platform} (${total}):\n`;
        const sorted = Object.entries(ranges).sort((a, b) => b[1].count - a[1].count);
        for (const [range, info] of sorted) {
          msg += `  ${range} - ${info.count}\n`;
        }
      }

      if (msg.length > 4000) msg = msg.substring(0, 3950) + '\n...Report truncated';

      await ctx.reply(msg);
    } catch (err) {
      console.error('Traffic error:', err.message);
      try { await ctx.reply('❌ Failed to load traffic data. Please try again.'); } catch (e) {}
    }
  });

  // 📊 OTP Traffic Button - Our users' received OTPs from DB
  bot.hears('📊 OTP Traffic', async (ctx) => {
    await ctx.reply('⏳ Loading OTP receiving stats...');
    try {
      const statsRes = await db.query(`
        SELECT an.platform, an.range, COUNT(*) as count
        FROM received_otps ro
        JOIN allocated_numbers an ON ro.allocated_number_id = an.id
        WHERE ro.received_at > NOW()::date
        GROUP BY an.platform, an.range
        ORDER BY an.platform, count DESC
      `);

      const rows = statsRes.rows;
      if (rows.length === 0) {
        return ctx.reply('📊 OTP Traffic (Today)\n\nNo OTPs received today yet.');
      }

      const grouped = {};
      let totalAll = 0;
      for (const r of rows) {
        if (!grouped[r.platform]) grouped[r.platform] = { ranges: [], total: 0 };
        const prefix = (r.range || '').replace(/X/gi, '');
        const c = providerManager.getCountryByPrefix(prefix);
        grouped[r.platform].ranges.push({ range: r.range, country: c.name, flag: c.flag, count: parseInt(r.count) });
        grouped[r.platform].total += parseInt(r.count);
        totalAll += parseInt(r.count);
      }

      const platforms = Object.entries(grouped).sort((a, b) => b[1].total - a[1].total);

      let msg = '📊 OTP Traffic (Our Users)\n\n';
      for (const [platform, data] of platforms) {
        msg += `\n<b>${platform}</b> (${data.total}):\n`;
        data.ranges.sort((a, b) => b.count - a.count);
        for (const r of data.ranges) {
          msg += `  ${r.flag} ${r.country} (${r.range}) - ${r.count}\n`;
        }
      }
      msg += `\n──────────\nTotal: ${totalAll} OTPs (today)`;

      if (msg.length > 4000) msg = msg.substring(0, 3950) + '\n...truncated';
      await ctx.reply(msg, { parse_mode: 'HTML' });
    } catch (err) {
      console.error('OTP Traffic error:', err.message);
      try { await ctx.reply('❌ Failed to load OTP stats.'); } catch (e) {}
    }
  });

  // 📞 Support Button
  bot.hears('📞 Support', async (ctx) => {
    try {
      const botRes = await db.query('SELECT support_username FROM telegram_bots WHERE token = $1 LIMIT 1', [token]);
      const supportUser = botRes.rows[0]?.support_username || 'ak_admin';
      const cleanSupport = supportUser.replace('@', '');
      await ctx.reply(`📞 Support & Contact\n\nFor help, contact admin:\n@${cleanSupport}\nhttps://t.me/${cleanSupport}`);
    } catch (err) {
      try { await ctx.reply('📞 Support: @ak_admin\nhttps://t.me/ak_admin'); } catch (e) {}
    }
  });

  // 🔢 Number Range Button
  bot.hears('🔢 Number Range', async (ctx) => {
    await ctx.reply('🔢 Direct Range Request\n\nEnter phone prefix (e.g. 88017 or 44740):');
  });

  // Text Listener for range inputs
  bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/') || ['📱 Services', '🔄 Get a New Number', '📊 Traffic', '📊 OTP Traffic', '🔢 Number Range', '📞 Support'].includes(text)) {
      return;
    }

    const cleanPrefix = text.replace(/[^0-9]/g, '');
    if (cleanPrefix.length < 3) return;

    await ctx.reply(`⏳ Searching ranges for prefix ${cleanPrefix}...`);

    try {
      const services = await providerManager.getLiveServices();
      const matches = [];

      for (const s of services) {
        for (const r of s.ranges) {
          if (r.rawRange.startsWith(cleanPrefix) || r.key.includes(cleanPrefix)) {
            matches.push({ platform: s.sid, ...r });
          }
        }
      }

      if (matches.length === 0) {
        return ctx.reply(`❌ No ranges match prefix ${cleanPrefix}.`);
      }

      const buttons = matches.slice(0, 15).map(m => [
        Markup.button.callback(
          `[${m.platform}] ${m.displayName}`,
          `select_range:${m.platform}:${m.providerCode}:${m.rawRange}`
        )
      ]);

      await ctx.reply(`🔍 Select range matching "${cleanPrefix}":`, Markup.inlineKeyboard(buttons));
    } catch (err) {
      console.error(err);
      try { await ctx.reply('❌ Failed to search ranges.'); } catch (e) {}
    }
  });

  bots[token] = bot;
  otpPoller.registerBotInstance(token, bot);

  // Use webhook in production (WEBHOOK_URL set), long-polling for local dev
  if (!process.env.WEBHOOK_URL) {
    bot.launch(() => {
      console.log(`🤖 Bot "${botRecord.name}" launched successfully (long-polling)`);
    }).catch(err => {
      console.error(`❌ Bot "${botRecord.name}" failed to launch:`, err.message);
    });
  } else {
    console.log(`🤖 Bot "${botRecord.name}" ready (webhook mode)`);
  }

  return bot;
}

process.once('SIGINT', () => {
  for (const token in bots) {
    bots[token].stop('SIGINT');
  }
});
process.once('SIGTERM', () => {
  for (const token in bots) {
    bots[token].stop('SIGTERM');
  }
});

/**
 * Loads all active bots from database and starts them
 */
async function initBots() {
  try {
    const botsRes = await db.query('SELECT * FROM telegram_bots WHERE is_active = true');
    const botRecords = botsRes.rows;

    console.log(`Loading ${botRecords.length} active Telegram bots...`);

    for (const botRecord of botRecords) {
      try {
        createBotInstance(botRecord);
        console.log(`  ✓ "${botRecord.name}" configured`);
      } catch (err) {
        console.error(`Failed to launch bot "${botRecord.name}":`, err.message);
      }
    }
  } catch (err) {
    console.error('Failed to load Telegram bots from Database:', err.message);
  }
}

/**
 * Handle incoming webhooks dynamically
 */
async function handleWebhook(token, req, res) {
  const bot = bots[token];
  if (bot) {
    await bot.handleUpdate(req.body, res);
  } else {
    res.status(404).send('Bot not found');
  }
}

module.exports = {
  initBots,
  createBotInstance,
  handleWebhook,
  bots
};
