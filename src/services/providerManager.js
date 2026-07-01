const axios = require('axios');
const db = require('../db/pg');

const failCounts = {};

// Dynamic Country Code to Flag + Name mapping
const countryCodes = {
  '880': { name: 'Bangladesh', flag: '🇧🇩' },
  '91': { name: 'India', flag: '🇮🇳' },
  '92': { name: 'Pakistan', flag: '🇵🇰' },
  '7': { name: 'Russia/Kazakhstan', flag: '🇷🇺' },
  '44': { name: 'United Kingdom', flag: '🇬🇧' },
  '1': { name: 'USA/Canada', flag: '🇺🇸' },
  '62': { name: 'Indonesia', flag: '🇮🇩' },
  '63': { name: 'Philippines', flag: '🇵🇭' },
  '84': { name: 'Vietnam', flag: '🇻🇳' },
  '66': { name: 'Thailand', flag: '🇹🇭' },
  '60': { name: 'Malaysia', flag: '🇲🇾' },
  '90': { name: 'Turkey', flag: '🇹🇷' },
  '380': { name: 'Ukraine', flag: '🇺🇦' },
  '55': { name: 'Brazil', flag: '🇧🇷' },
  '20': { name: 'Egypt', flag: '🇪🇬' },
  '234': { name: 'Nigeria', flag: '🇳🇬' },
  '254': { name: 'Kenya', flag: '🇰🇪' },
  '27': { name: 'South Africa', flag: '🇿🇦' },
  '33': { name: 'France', flag: '🇫🇷' },
  '49': { name: 'Germany', flag: '🇩🇪' },
  '39': { name: 'Italy', flag: '🇮🇹' },
  '34': { name: 'Spain', flag: '🇪🇸' },
  '31': { name: 'Netherlands', flag: '🇳🇱' },
  '46': { name: 'Sweden', flag: '🇸🇪' },
  '47': { name: 'Norway', flag: '🇳🇴' },
  '48': { name: 'Poland', flag: '🇵🇱' },
  '40': { name: 'Romania', flag: '🇷🇴' },
  '36': { name: 'Hungary', flag: '🇭🇺' },
  '52': { name: 'Mexico', flag: '🇲🇽' },
  '54': { name: 'Argentina', flag: '🇦🇷' },
  '56': { name: 'Chile', flag: '🇨🇱' },
  '57': { name: 'Colombia', flag: '🇨🇴' },
  '51': { name: 'Peru', flag: '🇵🇪' },
  '86': { name: 'China', flag: '🇨🇳' },
  '81': { name: 'Japan', flag: '🇯🇵' },
  '82': { name: 'South Korea', flag: '🇰🇷' },
  '61': { name: 'Australia', flag: '🇦🇺' },
  '64': { name: 'New Zealand', flag: '🇳🇿' },
  '65': { name: 'Singapore', flag: '🇸🇬' },
  '971': { name: 'UAE', flag: '🇦🇪' },
  '966': { name: 'Saudi Arabia', flag: '🇸🇦' },
  '974': { name: 'Qatar', flag: '🇶🇦' },
  '965': { name: 'Kuwait', flag: '🇰🇼' },
  '973': { name: 'Bahrain', flag: '🇧🇭' },
  '968': { name: 'Oman', flag: '🇴🇲' },
  '212': { name: 'Morocco', flag: '🇲🇦' },
  '213': { name: 'Algeria', flag: '🇩🇿' },
  '216': { name: 'Tunisia', flag: '🇹🇳' },
  '225': { name: 'Ivory Coast', flag: '🇨🇮' },
  '221': { name: 'Senegal', flag: '🇸🇳' },
  '237': { name: 'Cameroon', flag: '🇨🇲' },
  '256': { name: 'Uganda', flag: '🇺🇬' },
  '255': { name: 'Tanzania', flag: '🇹🇿' },
  '263': { name: 'Zimbabwe', flag: '🇿🇼' },
  '260': { name: 'Zambia', flag: '🇿🇲' },
  '261': { name: 'Madagascar', flag: '🇲🇬' },
  '230': { name: 'Mauritius', flag: '🇲🇺' },
  '358': { name: 'Finland', flag: '🇫🇮' },
  '45': { name: 'Denmark', flag: '🇩🇰' },
  '43': { name: 'Austria', flag: '🇦🇹' },
  '41': { name: 'Switzerland', flag: '🇨🇭' },
  '32': { name: 'Belgium', flag: '🇧🇪' },
  '351': { name: 'Portugal', flag: '🇵🇹' },
  '353': { name: 'Ireland', flag: '🇮🇪' },
  '30': { name: 'Greece', flag: '🇬🇷' },
  '420': { name: 'Czech Republic', flag: '🇨🇿' },
  '359': { name: 'Bulgaria', flag: '🇧🇬' },
  '373': { name: 'Moldova', flag: '🇲🇩' },
  '370': { name: 'Lithuania', flag: '🇱🇹' },
  '371': { name: 'Latvia', flag: '🇱🇻' },
  '372': { name: 'Estonia', flag: '🇪🇪' },
  '375': { name: 'Belarus', flag: '🇧🇾' },
  '355': { name: 'Albania', flag: '🇦🇱' },
  '387': { name: 'Bosnia', flag: '🇧🇦' },
  '385': { name: 'Croatia', flag: '🇭🇷' },
  '381': { name: 'Serbia', flag: '🇷🇸' },
  '389': { name: 'North Macedonia', flag: '🇲🇰' },
  '229': { name: 'Benin', flag: '🇧🇯' },
  '236': { name: 'Central African Rep', flag: '🇨🇫' },
  '224': { name: 'Guinea', flag: '🇬🇳' },
  '223': { name: 'Mali', flag: '🇲🇱' },
  '226': { name: 'Burkina Faso', flag: '🇧🇫' },
  '227': { name: 'Niger', flag: '🇳🇪' },
  '228': { name: 'Togo', flag: '🇹🇬' },
  '231': { name: 'Liberia', flag: '🇱🇷' },
  '232': { name: 'Sierra Leone', flag: '🇸🇱' },
  '233': { name: 'Ghana', flag: '🇬🇭' },
  '235': { name: 'Chad', flag: '🇹🇩' },
  '238': { name: 'Cape Verde', flag: '🇨🇻' },
  '239': { name: 'Sao Tome', flag: '🇸🇹' },
  '240': { name: 'Eq Guinea', flag: '🇬🇶' },
  '241': { name: 'Gabon', flag: '🇬🇦' },
  '242': { name: 'Congo', flag: '🇨🇬' },
  '243': { name: 'DR Congo', flag: '🇨🇩' },
  '244': { name: 'Angola', flag: '🇦🇴' },
  '245': { name: 'Guinea-Bissau', flag: '🇬🇼' },
  '248': { name: 'Seychelles', flag: '🇸🇨' },
  '249': { name: 'Sudan', flag: '🇸🇩' },
  '250': { name: 'Rwanda', flag: '🇷🇼' },
  '251': { name: 'Ethiopia', flag: '🇪🇹' },
  '252': { name: 'Somalia', flag: '🇸🇴' },
  '253': { name: 'Djibouti', flag: '🇩🇯' },
  '257': { name: 'Burundi', flag: '🇧🇮' },
  '258': { name: 'Mozambique', flag: '🇲🇿' },
  '262': { name: 'Reunion', flag: '🇷🇪' },
  '264': { name: 'Namibia', flag: '🇳🇦' },
  '265': { name: 'Malawi', flag: '🇲🇼' },
  '267': { name: 'Botswana', flag: '🇧🇼' },
  '268': { name: 'Eswatini', flag: '🇸🇿' },
  '269': { name: 'Comoros', flag: '🇰🇲' },
  '291': { name: 'Eritrea', flag: '🇪🇷' },
  '503': { name: 'El Salvador', flag: '🇸🇻' },
  '502': { name: 'Guatemala', flag: '🇬🇹' },
  '504': { name: 'Honduras', flag: '🇭🇳' },
  '505': { name: 'Nicaragua', flag: '🇳🇮' },
  '506': { name: 'Costa Rica', flag: '🇨🇷' },
  '507': { name: 'Panama', flag: '🇵🇦' },
  '509': { name: 'Haiti', flag: '🇭🇹' },
  '58': { name: 'Venezuela', flag: '🇻🇪' },
  '593': { name: 'Ecuador', flag: '🇪🇨' },
  '591': { name: 'Bolivia', flag: '🇧🇴' },
  '592': { name: 'Guyana', flag: '🇬🇾' },
  '595': { name: 'Paraguay', flag: '🇵🇾' },
  '598': { name: 'Uruguay', flag: '🇺🇾' },
};

// Helper to extract country details from prefix
function getCountryByPrefix(prefix) {
  for (let len = 4; len >= 1; len--) {
    const sub = prefix.substring(0, len);
    if (countryCodes[sub]) {
      return countryCodes[sub];
    }
  }
  return { name: 'Unknown Country', flag: '🏳️' };
}

/**
 * Periodically measures latency for all active provider accounts
 */
async function checkAccountsHealth() {
  try {
    const queryStr = `
      SELECT pa.id, pa.name, pa.api_key, p.base_url 
      FROM provider_accounts pa
      JOIN providers p ON pa.provider_id = p.id
      WHERE pa.is_active = true AND p.is_active = true
    `;
    const res = await db.query(queryStr);
    const accounts = res.rows;

    for (const account of accounts) {
      const start = Date.now();
      let latency = 99999;
      try {
        const baseUrl = account.base_url.replace(/\/+$/, '');
        const response = await axios.get(`${baseUrl}/api/liveaccess`, {
          headers: { 'X-API-Key': account.api_key },
          timeout: 4000
        });
        if (response.status === 200) {
          latency = Date.now() - start;
        }
      } catch (err) {
        const key = account.id;
        failCounts[key] = (failCounts[key] || 0) + 1;
        if (failCounts[key] % 10 === 1 || failCounts[key] === 1) {
          console.error(`Health check failed (x${failCounts[key]}): ${account.name} - ${err.message}`);
        }
      }

      await db.query(
        'UPDATE provider_accounts SET latency_ms = $1, last_checked_at = NOW() WHERE id = $2',
        [latency, account.id]
      );
    }
  } catch (err) {
    console.error('Error during provider health checks:', err.message);
  }
}

/**
 * Start health check scheduler
 */
function startHealthChecks() {
  checkAccountsHealth();
  setInterval(checkAccountsHealth, 60000); // check every minute
}

/**
 * Resolves available services and ranges from all active providers,
 * merging them, filtering blacklists and naming them dynamically.
 */
async function getLiveServices() {
  try {
    // Fetch active accounts with their provider info
    const accountsRes = await db.query(`
      SELECT pa.api_key, p.id AS provider_id, p.unique_code, p.base_url, p.is_active AS provider_active, pa.name AS account_name
      FROM provider_accounts pa
      JOIN providers p ON pa.provider_id = p.id
      WHERE pa.is_active = true AND p.is_active = true
    `);
    const accounts = accountsRes.rows;

    // Fetch settings for disabled services/providers/ranges
    const settingsRes = await db.query('SELECT * FROM service_settings');
    const settings = settingsRes.rows;
    
    const disabledServices = new Set();
    const disabledProvMap = new Map();
    const disabledRangeMap = new Map();
    const savedServiceSet = new Set();

    for (const s of settings) {
      savedServiceSet.add(s.platform.toLowerCase());
      if (!s.is_enabled) {
        disabledServices.add(s.platform.toLowerCase());
      }
      if (s.disabled_providers && Array.isArray(s.disabled_providers)) {
        disabledProvMap.set(s.platform.toLowerCase(), new Set(s.disabled_providers));
      }
      if (s.disabled_ranges && Array.isArray(s.disabled_ranges)) {
        disabledRangeMap.set(s.platform.toLowerCase(), new Set(s.disabled_ranges.map(r => r.toLowerCase())));
      }
    }

    const consolidated = {};

    for (const account of accounts) {
      try {
        const baseUrl = account.base_url.replace(/\/+$/, '');
        const res = await axios.get(`${baseUrl}/api/liveaccess`, {
          headers: { 'X-API-Key': account.api_key },
          timeout: 5000
        });

        if (res.data && res.data.status === 'ok' && res.data.services) {
          for (const svc of res.data.services) {
            const platformLower = svc.sid.toLowerCase();

            // Global service disabled check
            if (disabledServices.has(platformLower)) continue;

            // Service disabled for this provider check
            const disabledProvs = disabledProvMap.get(platformLower);
            if (disabledProvs && disabledProvs.has(account.provider_id)) continue;

            const disabledRanges = disabledRangeMap.get(platformLower);

            if (!consolidated[svc.sid]) {
              consolidated[svc.sid] = {
                sid: svc.sid,
                ranges: []
              };
            }

            // Process ranges
            for (const range of svc.ranges) {
              const rangePrefix = range.replace(/X/gi, '');
              if (disabledRanges && disabledRanges.has(rangePrefix.toLowerCase())) continue;

              // Avoid adding duplicate range under same provider
              const key = `${account.unique_code}:${range}`;
              if (!consolidated[svc.sid].ranges.some(r => r.key === key)) {
                consolidated[svc.sid].ranges.push({
                  key: key,
                  raw: range,
                  providerId: account.provider_id,
                  providerCode: account.unique_code,
                  prefix: rangePrefix
                });
              }
            }
          }
        }
      } catch (err) {
        console.error(`Error loading services for account ${account.account_name}:`, err.message);
      }
    }

    // Format and group ranges by country sequentially
    const servicesList = [];
    for (const sid in consolidated) {
      const svc = consolidated[sid];

      // Group ranges by country code
      const countryGroups = {};
      for (const r of svc.ranges) {
        const c = getCountryByPrefix(r.prefix);
        const cKey = c.name;
        if (!countryGroups[cKey]) {
          countryGroups[cKey] = {
            name: c.name,
            flag: c.flag,
            ranges: []
          };
        }
        countryGroups[cKey].ranges.push(r);
      }

      // Now format ranges dynamically, e.g. "Bangladesh 1 (88017XXX)"
      const formattedRanges = [];
      for (const cName in countryGroups) {
        const group = countryGroups[cName];
        // Sort ranges to be consistent
        group.ranges.sort((a, b) => a.raw.localeCompare(b.raw));
        
        group.ranges.forEach((r, idx) => {
          const displayName = `[${r.providerCode}] ${group.flag} ${group.name} ${idx + 1} (${r.raw})`;
          formattedRanges.push({
            displayName: displayName,
            rawRange: r.raw,
            providerCode: r.providerCode,
            providerId: r.providerId,
            key: r.key
          });
        });
      }

      servicesList.push({
        sid: svc.sid,
        ranges: formattedRanges
      });
    }

    return servicesList;
  } catch (err) {
    console.error('Error fetching live services:', err.message);
    return [];
  }
}

/**
 * Allocate number with fallback rotation
 */
async function allocateNumber(providerCode, range, platform, botUserId, botId) {
  // Find the provider by unique code
  const providerRes = await db.query(
    'SELECT * FROM providers WHERE unique_code = $1 AND is_active = true',
    [providerCode]
  );
  const provider = providerRes.rows[0];

  if (!provider) {
    throw new Error('Provider not found or inactive');
  }

  // Find active accounts for this provider, sorted by priority (1 is highest) and then latency
  const accountsRes = await db.query(
    `SELECT * FROM provider_accounts 
     WHERE provider_id = $1 AND is_active = true 
     ORDER BY priority ASC, latency_ms ASC`,
    [provider.id]
  );
  const accounts = accountsRes.rows;

  if (accounts.length === 0) {
    throw new Error('No active accounts found for this provider');
  }

  let allocatedData = null;
  let successfulAccount = null;
  let apiError = null;

  // Try accounts in priority order (Rotation)
  for (const account of accounts) {
    try {
      const baseUrl = provider.base_url.replace(/\/+$/, '');
      const response = await axios.post(
        `${baseUrl}/api/getnum`,
        { range: range },
        {
          headers: { 'X-API-Key': account.api_key },
          timeout: 8000
        }
      );

      const resData = response.data;
      if (resData && resData.meta && resData.meta.code === 200 && resData.data) {
        allocatedData = resData.data;
        successfulAccount = account;
        break; // Stop rotation since we got a number
      } else if (resData && resData.meta && resData.meta.code === 2946) {
        console.warn(`Account ${account.name} out of stock for range ${range}`);
        apiError = 'Out of stock';
      } else {
        console.warn(`Account ${account.name} returned error:`, resData.message);
        apiError = resData.message || 'API error';
      }
    } catch (err) {
      let errorMsg = err.message;
      if (err.response && err.response.status === 400) {
        errorMsg = err.response.data?.message || err.response.data?.error || 'এই লেন্সে নাম্বার স্টক শেষ';
      }
      console.error(`Account ${account.name} request failed:`, errorMsg);
      apiError = errorMsg;
    }
  }

  if (!allocatedData) {
    throw new Error(apiError || 'Failed to allocate number');
  }

  // Save allocated number to Database
  const id = db.generateUUID();
  const insertQuery = `
    INSERT INTO allocated_numbers (id, bot_user_id, bot_id, provider_account_id, platform, range, number, status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
  `;
  await db.query(insertQuery, [
    id,
    botUserId,
    botId,
    successfulAccount.id,
    platform,
    range,
    allocatedData.full_number
  ]);
  
  return {
    allocatedId: id,
    number: allocatedData.full_number,
    country: allocatedData.country,
    operator: allocatedData.operator
  };
}

module.exports = {
  startHealthChecks,
  getLiveServices,
  allocateNumber,
  getCountryByPrefix
};
