const axios = require('axios');
const db = require('../db/pg');

const failCounts = {};

// Store max_id per provider account in memory
const accountMaxIds = {};

// Keep track of active bot instances
const botInstances = {};

function registerBotInstance(token, telegrafInstance) {
  botInstances[token] = telegrafInstance;
}

/**
 * Polls a single provider account for new OTPs
 */
async function pollAccount(account) {
  try {
    const baseUrl = account.base_url.replace(/\/+$/, '');
    let since = accountMaxIds[account.id];

    // If we don't have since value, fetch latest 1 entry to establish baseline
    if (since === undefined) {
      const initRes = await axios.get(`${baseUrl}/api/live-console`, {
        headers: { 'X-API-Key': account.api_key },
        params: { limit: 1 },
        timeout: 4000
      });
      if (initRes.data && initRes.data.data && initRes.data.data.otps && initRes.data.data.otps.length > 0) {
        accountMaxIds[account.id] = initRes.data.data.max_id || 0;
      } else {
        accountMaxIds[account.id] = 0;
      }
      return;
    }

    const res = await axios.get(`${baseUrl}/api/live-console`, {
      headers: { 'X-API-Key': account.api_key },
      params: { since: since, limit: 100 },
      timeout: 5000
    });

    if (res.data && res.data.meta && res.data.meta.code === 200 && res.data.data) {
      const otps = res.data.data.otps || [];
      const newMaxId = res.data.data.max_id;

      if (newMaxId && newMaxId > since) {
        accountMaxIds[account.id] = newMaxId;
      }

      if (otps.length > 0) {
        for (const otp of otps) {
          if (otp.hidden === true || otp.platform === '***') continue;
          await handleIncomingOTP(account.id, otp);
        }
      }
    }
  } catch (err) {
    const key = account.id;
    failCounts[key] = (failCounts[key] || 0) + 1;
    if (failCounts[key] % 10 === 1 || failCounts[key] === 1) {
      console.error(`Poll error (x${failCounts[key]}): ${account.name} - ${err.message}`);
    }
  }
}

/**
 * Handles incoming OTP from live-console feed
 */
async function handleIncomingOTP(accountId, otpData) {
  const number = otpData.number;
  const cleanNumber = number.replace(/[^0-9]/g, '');

  // Query matching active allocated numbers with flexible phone number matching
  // Handles format differences (country code vs trunk prefix, +/- symbols, spaces)
  const queryStr = `
    SELECT an.id, an.number, an.platform, bu.telegram_id, tb.token AS bot_token, tb.name AS bot_name
    FROM allocated_numbers an
    JOIN bot_users bu ON an.bot_user_id = bu.id
    JOIN telegram_bots tb ON an.bot_id = tb.id
    WHERE an.status = 'active' AND (
      an.number = $1
      OR an.number = $2
      OR an.number = $3
      OR REGEXP_REPLACE(an.number, '[^0-9]', '') = $3
      OR $3 LIKE '%' || REGEXP_REPLACE(an.number, '[^0-9]', '')
      OR REGEXP_REPLACE(an.number, '[^0-9]', '') LIKE '%' || $3
      OR RIGHT(REGEXP_REPLACE(an.number, '[^0-9]', ''), 9) = RIGHT($3, 9)
    )
    ORDER BY an.allocated_at DESC
  `;
  
  const allocRes = await db.query(queryStr, [number, `+${cleanNumber}`, cleanNumber]);
  const allocated = allocRes.rows;

  if (allocated.length === 0) {
    console.log(`⚠️ OTP UNMATCHED: number=${number} clean=${cleanNumber} — no active allocation found`);
    return;
  }

  const alloc = allocated[0];
  console.log(`📨 OTP MATCHED: +${otpData.number} → Platform: ${alloc.platform} → User: ${alloc.telegram_id}`);

  // Prevent duplicate OTP processing
  const dupCheckRes = await db.query(
    'SELECT id FROM received_otps WHERE allocated_number_id = $1 AND otp_code = $2 AND raw_message = $3',
    [alloc.id, otpData.otp, otpData.message]
  );
  
  if (dupCheckRes.rows.length > 0) {
    return; // Already logged
  }

  // Insert OTP into database
  const otpCode = otpData.otp || '';
  const rawMessage = otpData.message || '';
  const id = db.generateUUID();
  await db.query(
    'INSERT INTO received_otps (id, allocated_number_id, otp_code, raw_message) VALUES ($1, $2, $3, $4)',
    [id, alloc.id, otpCode, rawMessage]
  );

  // Dispatch message to user via correct Bot
  const botToken = alloc.bot_token;
  const telegramId = alloc.telegram_id;
  const bot = botInstances[botToken];

  if (bot && telegramId) {
    try {
      const cleanOtp = otpCode.replace(/[^0-9]/g, '');
      const hasSymbols = otpCode && otpCode !== cleanOtp;

      let msg = `✨ <b>OTP Received!</b>\n\n`;
      msg += `📱 Number: <code>${alloc.number}</code>\n`;
      msg += `💬 Platform: ${alloc.platform}\n`;
      msg += `✉️ Message: ${escapeHtml(rawMessage)}\n\n`;
      if (otpCode) msg += `🔑 OTP Code: <code>${otpCode}</code>\n`;
      if (hasSymbols) msg += `👉 Clean OTP: <code>${cleanOtp}</code>\n`;

      await bot.telegram.sendMessage(telegramId, msg, { parse_mode: 'HTML' });
    } catch (botErr) {
      console.error(`Failed to dispatch message to user ${telegramId}:`, botErr.message);
    }
  }
}

function escapeMarkdown(text) {
  return text.replace(/[_*[\]()~`>#+-=|{}.!]/g, '\\$&');
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Polls all active provider accounts
 */
async function pollAllAccounts() {
  try {
    const res = await db.query(`
      SELECT pa.id, pa.name, pa.api_key, p.base_url 
      FROM provider_accounts pa
      JOIN providers p ON pa.provider_id = p.id
      WHERE pa.is_active = true AND p.is_active = true
    `);
    const accounts = res.rows;

    for (const account of accounts) {
      await pollAccount(account);
    }
  } catch (err) {
    console.error('Error in poller account retrieval:', err.message);
  }
}

/**
 * Starts the polling loop
 */
function startPolling() {
  setInterval(pollAllAccounts, 3000); // Check every 3 seconds
}

module.exports = {
  startPolling,
  registerBotInstance
};
