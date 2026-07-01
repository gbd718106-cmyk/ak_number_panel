const axios = require('axios');
const db = require('../db/pg');

async function syncServicesFromAllProviders() {
  try {
    const accountsRes = await db.query(`
      SELECT pa.id, pa.name, pa.api_key, p.base_url, p.unique_code
      FROM provider_accounts pa
      JOIN providers p ON pa.provider_id = p.id
      WHERE pa.is_active = true AND p.is_active = true
    `);
    const accounts = accountsRes.rows;
    if (accounts.length === 0) return;

    const allServices = new Map();

    for (const account of accounts) {
      try {
        const baseUrl = account.base_url.replace(/\/+$/, '');
        const res = await axios.get(`${baseUrl}/api/liveaccess`, {
          headers: { 'X-API-Key': account.api_key },
          timeout: 8000
        });

        if (res.data && res.data.services) {
          for (const svc of res.data.services) {
            const key = svc.sid.toLowerCase();
            if (!allServices.has(key)) {
              allServices.set(key, new Set());
            }
            for (const r of svc.ranges || []) {
              allServices.get(key).add(r);
            }
          }
        }
      } catch (err) {
        console.error(`AutoSync: Failed to fetch from ${account.name}:`, err.message);
      }
    }

    const existingSettings = await db.query('SELECT * FROM service_settings');
    const settingsMap = {};
    for (const s of existingSettings.rows) {
      settingsMap[s.platform.toLowerCase()] = s;
    }

    for (const [platform, rangePrefixes] of allServices) {
      const existing = settingsMap[platform];
      const apiRangeArr = Array.from(rangePrefixes);

      if (!existing) {
        const id = db.generateUUID();
        await db.query(
          `INSERT INTO service_settings (id, platform, is_enabled, disabled_providers, disabled_ranges)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (platform) DO NOTHING`,
          [id, platform, true, JSON.stringify([]), JSON.stringify([])]
        );
        console.log(`AutoSync: New service auto-enabled → ${platform}`);
      } else {
        let savedDisabledRanges = [];
        try {
          savedDisabledRanges = existing.disabled_ranges
            ? (typeof existing.disabled_ranges === 'string' ? JSON.parse(existing.disabled_ranges) : existing.disabled_ranges)
            : [];
        } catch (e) {
          savedDisabledRanges = [];
        }

        if (!Array.isArray(savedDisabledRanges)) savedDisabledRanges = [];

        const cleanedDisabled = savedDisabledRanges.filter(dr => {
          const normalized = String(dr).toLowerCase();
          return apiRangeArr.some(ar => ar.toLowerCase() === normalized);
        });

        const removedCount = savedDisabledRanges.length - cleanedDisabled.length;

        if (removedCount > 0 || JSON.stringify(cleanedDisabled) !== JSON.stringify(savedDisabledRanges)) {
          await db.query(
            `UPDATE service_settings SET disabled_ranges = $1, is_enabled = true WHERE platform = $2`,
            [JSON.stringify(cleanedDisabled), platform]
          );
          if (removedCount > 0) {
            console.log(`AutoSync: Cleaned ${removedCount} stale ranges from ${platform}`);
          }
        }
      }
    }

    console.log(`AutoSync: Synced ${allServices.size} services from ${accounts.length} providers`);
  } catch (err) {
    console.error('AutoSync error:', err.message);
  }
}

function startAutoSync() {
  syncServicesFromAllProviders();
  setInterval(syncServicesFromAllProviders, 10 * 60 * 1000);
  console.log('Service auto-sync started (every 10 minutes)');
}

module.exports = { startAutoSync, syncServicesFromAllProviders };
