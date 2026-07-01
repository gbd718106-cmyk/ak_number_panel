// STATE
let curTab = 'services';
let selService = null;
let selCnt = null;

// API
async function api(endpoint, method = 'GET', body = null) {
  const c = { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include' };
  if (body) c.body = JSON.stringify(body);
  const r = await fetch(endpoint, c);
  if (r.status === 401 || r.status === 403) { window.location.href = '/landing'; throw new Error('Unauthorized'); }
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || 'Request failed');
  return d;
}

function toast(msg, color = '#6366f1') {
  const t = document.getElementById('toast');
  t.innerText = msg;
  t.className = 'toast active';
  t.style.background = color;
  setTimeout(() => t.classList.remove('active'), 3000);
}

// TAB SWITCH
function switchTab(name) {
  curTab = name;
  document.querySelectorAll('.usr-nav-item').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.usr-tab').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
  const titles = { services: 'Services', 'get-number': 'Get New Number', 'live-traffic': 'Live Traffic', 'otp-traffic': 'OTP Traffic (Today)', 'range-search': 'Range Search', support: 'Support' };
  document.getElementById('page-title').innerText = titles[name] || name;

  if (name === 'services') loadServices();
  if (name === 'get-number') loadGetNumberState();
  if (name === 'live-traffic') loadLiveTraffic();
  if (name === 'otp-traffic') loadOtpTraffic();
  if (name === 'support') loadSupport();
}

// ==================== SERVICES ====================
async function loadServices() {
  selService = null; selCnt = null;
  document.getElementById('svc-grid').style.display = 'grid';
  document.getElementById('svc-detail').style.display = 'none';
  document.getElementById('svc-loading').style.display = 'block';
  document.getElementById('svc-grid').innerHTML = '';

  try {
    const services = await api('/api/user-panel/services');
    document.getElementById('svc-loading').style.display = 'none';
    if (!services.length) { document.getElementById('svc-grid').innerHTML = '<p class="section-desc" style="grid-column:1/-1;">No services available. Contact admin.</p>'; return; }
    document.getElementById('svc-grid').innerHTML = services.map(s => `<div class="svc-card" onclick="selSvc('${s.sid}')"><ion-icon name="construct-outline"></ion-icon><div><h3>${s.sid}</h3><p>${s.ranges?.length || 0} ranges</p></div></div>`).join('');
  } catch (e) { document.getElementById('svc-loading').innerHTML = '❌ ' + e.message; }
}

async function selSvc(platform) {
  selService = platform; selCnt = null;
  try {
    const countries = await api('/api/user-panel/services/' + encodeURIComponent(platform) + '/countries');
    document.getElementById('svc-grid').style.display = 'none';
    document.getElementById('svc-detail').style.display = 'block';
    document.getElementById('svc-crumb').innerHTML = `<span>${platform}</span>`;
    document.getElementById('svc-countries').style.display = 'block';
    document.getElementById('svc-ranges').style.display = 'none';
    document.getElementById('svc-result').style.display = 'none';

    document.getElementById('svc-countries').innerHTML = countries.length
      ? '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px;">' + countries.map(c => `<div class="row-item" onclick="selCountry('${c.name.replace(/'/g, "\\'")}')"><div class="rw-left"><span>${c.flag}</span><span>${c.name}</span></div><small style="color:var(--text-muted);">${c.rangeCount}</small></div>`).join('') + '</div>'
      : '<p class="section-desc">No countries available.</p>';
  } catch (e) { toast(e.message, '#ef4444'); }
}

async function selCountry(name) {
  selCnt = name;
  try {
    const ranges = await api('/api/user-panel/services/' + encodeURIComponent(selService) + '/countries/' + encodeURIComponent(name) + '/ranges');
    document.getElementById('svc-crumb').innerHTML = '<span>' + selService + '</span> <span style="color:var(--text-muted)">›</span> <span class="last">' + name + '</span>';
    document.getElementById('svc-countries').style.display = 'none';
    document.getElementById('svc-ranges').style.display = 'block';
    document.getElementById('svc-result').style.display = 'none';

    document.getElementById('svc-ranges').innerHTML = ranges.length
      ? '<p class="section-desc" style="margin-bottom:10px;">Select a range to allocate:</p>' + ranges.map(r => `<div class="row-item" onclick="doAllocate('${r.providerCode}','${r.range}')"><div class="rw-left"><ion-icon name="call-outline"></ion-icon><span style="font-size:13px;">${r.displayName}</span></div><code style="color:var(--primary);font-size:13px;">${r.range}</code></div>`).join('')
      : '<p class="section-desc">No ranges available.</p>';
  } catch (e) { toast(e.message, '#ef4444'); }
}

async function doAllocate(providerCode, range) {
  if (!confirm('Allocate number from ' + range + ' on ' + selService + '?')) return;
  document.getElementById('svc-result').style.display = 'block';
  document.getElementById('svc-result').innerHTML = '<p class="section-desc">⏳ Requesting number...</p>';
  try {
    const r = await api('/api/user-panel/services/allocate', 'POST', { platform: selService, providerCode, range });
    document.getElementById('svc-result').innerHTML = `<div class="result-card">
      <h3 style="color:var(--text-success);margin-bottom:12px;">✅ Number Allocated</h3>
      <p><strong>Service:</strong> ${r.platform}</p>
      <p><strong>Range:</strong> ${r.range} (${r.providerCode})</p>
      <p><strong>Country:</strong> ${r.country}</p>
      <p><strong>Operator:</strong> ${r.operator}</p>
      <div class="num-box" onclick="navigator.clipboard.writeText('${r.number}');toast('Copied!')">📞 ${r.number}</div>
      <p style="color:var(--text-muted);font-size:12px;">Click to copy. Waiting for OTP (max 10 min).</p>
      <button class="btn btn-secondary btn-block" style="margin-top:10px;" onclick="loadServices();selSvc('${selService}');">Get Another Number</button>
    </div>`;
  } catch (e) { document.getElementById('svc-result').innerHTML = '<p style="color:var(--text-danger);">❌ ' + e.message + '</p>'; }
}

document.getElementById('btn-back-svc').addEventListener('click', () => {
  document.getElementById('svc-detail').style.display = 'none';
  document.getElementById('svc-grid').style.display = 'grid';
  selService = null; selCnt = null;
});

// ==================== GET NEW NUMBER ====================
let lastSvc = null, lastRange = null, lastPc = null;
async function loadGetNumberState() {
  try {
    const me = await api('/api/user-panel/auth/me');
    if (me.last_platform && me.last_range && me.last_provider_code) {
      lastSvc = me.last_platform; lastRange = me.last_range; lastPc = me.last_provider_code;
      document.getElementById('gn-status').innerHTML = `<span class="pl-2 ok">Last: ${lastSvc} / ${lastRange}</span>`;
      document.getElementById('btn-get-number').disabled = false;
      document.getElementById('btn-get-number').innerText = 'Request New Number';
    } else {
      document.getElementById('gn-status').innerHTML = '<span class="pl-2 inf">No previous service. Go to Services first.</span>';
      document.getElementById('btn-get-number').disabled = true;
      document.getElementById('btn-get-number').innerText = 'No Previous Service';
    }
  } catch (e) { document.getElementById('gn-status').innerHTML = '<span class="pl-2 err">' + e.message + '</span>'; }
}

async function doGetNewNumber() {
  if (!lastSvc || !lastRange || !lastPc) { toast('Go to Services first', '#f59e0b'); return; }
  document.getElementById('gn-result').innerHTML = '<p class="section-desc">⏳ Requesting number for ' + lastSvc + '...</p>';
  try {
    const r = await api('/api/user-panel/services/allocate', 'POST', { platform: lastSvc, providerCode: lastPc, range: lastRange });
    document.getElementById('gn-result').innerHTML = `<div class="result-card">
      <h3 style="color:var(--text-success);margin-bottom:12px;">✅ New Number</h3>
      <p><strong>Service:</strong> ${r.platform} &nbsp; <strong>Range:</strong> ${r.range} (${r.providerCode})</p>
      <p><strong>Country:</strong> ${r.country} &nbsp; <strong>Operator:</strong> ${r.operator}</p>
      <div class="num-box" onclick="navigator.clipboard.writeText('${r.number}');toast('Copied!')">📞 ${r.number}</div>
      <p style="color:var(--text-muted);font-size:12px;">Click to copy. Waiting for OTP.</p>
      <button class="btn btn-secondary btn-block" style="margin-top:10px;" onclick="doGetNewNumber()">🔄 Get Another</button>
    </div>`;
    loadGetNumberState();
  } catch (e) { document.getElementById('gn-result').innerHTML = '<p style="color:var(--text-danger);">❌ ' + e.message + '</p>'; }
}

// ==================== LIVE TRAFFIC ====================
async function loadLiveTraffic() {
  document.getElementById('lt-loading').style.display = 'block';
  document.getElementById('lt-display').innerHTML = '';
  try {
    const data = await api('/api/user-panel/traffic');
    document.getElementById('lt-loading').style.display = 'none';
    const keys = Object.keys(data);
    if (!keys.length) { document.getElementById('lt-display').innerHTML = '<p class="section-desc">No live traffic detected.</p>'; return; }

    let h = '';
    keys.sort((a, b) => { let ta = 0, tb = 0; Object.values(data[a]).forEach(v => ta += v.count); Object.values(data[b]).forEach(v => tb += v.count); return tb - ta; });
    for (const plat of keys) {
      const ranges = data[plat];
      let total = 0;
      Object.values(ranges).forEach(v => total += v.count);
      h += `<div class="glass-card" style="margin-bottom:10px;"><h3 style="margin-bottom:8px;">${plat} <span style="font-weight:400;font-size:13px;color:var(--text-muted);">(${total} OTPs)</span></h3>`;
      Object.entries(ranges).sort((a, b) => b[1].count - a[1].count).forEach(([range, info]) => {
        h += `<div class="row-item"><div class="rw-left"><ion-icon name="call-outline"></ion-icon><code style="font-size:12px;">${range}</code></div><span style="color:var(--primary);font-weight:600;">${info.count}</span></div>`;
      });
      h += '</div>';
    }
    document.getElementById('lt-display').innerHTML = h;
  } catch (e) { document.getElementById('lt-loading').innerHTML = '❌ ' + e.message; }
}

// ==================== OTP TRAFFIC (DB) ====================
async function loadOtpTraffic() {
  document.getElementById('ot-loading').style.display = 'block';
  document.getElementById('ot-display').innerHTML = '';
  try {
    const data = await api('/api/user-panel/otp-traffic');
    document.getElementById('ot-loading').style.display = 'none';
    if (!data.total) { document.getElementById('ot-display').innerHTML = '<p class="section-desc">No OTPs received today yet.</p>'; return; }

    let h = `<div class="glass-card" style="margin-bottom:14px;"><h3>Total: ${data.total} OTPs today</h3></div>`;
    const entries = Object.entries(data.grouped).sort((a, b) => b[1].total - a[1].total);
    for (const [plat, info] of entries) {
      h += `<div class="glass-card" style="margin-bottom:10px;"><h3 style="margin-bottom:8px;">${plat} (${info.total})</h3>`;
      info.ranges.sort((a, b) => b.count - a.count).forEach(r => {
        h += `<div class="row-item"><div class="rw-left"><span>${r.flag}</span><span>${r.country} (${r.range})</span></div><span style="color:var(--primary);font-weight:600;">${r.count}</span></div>`;
      });
      h += '</div>';
    }
    document.getElementById('ot-display').innerHTML = h;
  } catch (e) { document.getElementById('ot-loading').innerHTML = '❌ ' + e.message; }
}

// ==================== RANGE SEARCH ====================
async function doRangeSearch() {
  const prefix = document.getElementById('search-prefix').value.replace(/[^0-9]/g, '');
  if (prefix.length < 3) { toast('Enter at least 3 digits', '#f59e0b'); return; }

  document.getElementById('rs-loading').style.display = 'block';
  document.getElementById('rs-results').innerHTML = '';

  try {
    const services = await api('/api/user-panel/services');
    const matches = [];
    for (const s of services) {
      const countries = await api('/api/user-panel/services/' + encodeURIComponent(s.sid) + '/countries');
      for (const c of countries) {
        const ranges = await api('/api/user-panel/services/' + encodeURIComponent(s.sid) + '/countries/' + encodeURIComponent(c.name) + '/ranges');
        for (const r of ranges) {
          if (r.range.startsWith(prefix) || r.displayName.toLowerCase().includes(prefix)) {
            matches.push({ platform: s.sid, country: c.name, flag: c.flag, ...r });
          }
        }
      }
    }
    document.getElementById('rs-loading').style.display = 'none';

    if (!matches.length) {
      document.getElementById('rs-results').innerHTML = '<div class="glass-card"><p class="section-desc">No ranges found for prefix <b>' + prefix + '</b>.</p></div>';
      return;
    }

    document.getElementById('rs-results').innerHTML = '<div class="glass-card" style="margin-bottom:10px;"><h3>Results for "' + prefix + '" (' + matches.length + ' matches)</h3></div>' +
      matches.slice(0, 20).map(m => `<div class="row-item" onclick="quickAlloc('${m.platform}','${m.providerCode}','${m.range}')">
        <div class="rw-left"><span>${m.flag}</span><span>[${m.platform}] ${m.displayName}</span></div>
        <code style="color:var(--primary);font-size:12px;">${m.range}</code>
      </div>`).join('');
  } catch (e) { document.getElementById('rs-loading').innerHTML = '❌ ' + e.message; }
}

async function quickAlloc(platform, providerCode, range) {
  if (!confirm('Allocate ' + range + ' for ' + platform + '?')) return;
  try {
    const r = await api('/api/user-panel/services/allocate', 'POST', { platform, providerCode, range });
    document.getElementById('rs-results').innerHTML = `<div class="result-card">
      <h3 style="color:var(--text-success);margin-bottom:12px;">✅ Allocated</h3>
      <p><strong>Service:</strong> ${r.platform} &nbsp; <strong>Range:</strong> ${r.range}</p>
      <p><strong>Country:</strong> ${r.country} &nbsp; <strong>Operator:</strong> ${r.operator}</p>
      <div class="num-box" onclick="navigator.clipboard.writeText('${r.number}');toast('Copied!')">📞 ${r.number}</div>
      <p style="color:var(--text-muted);font-size:12px;">Click to copy. Waiting for OTP.</p>
    </div>` + document.getElementById('rs-results').innerHTML;
    loadGetNumberState();
  } catch (e) { toast(e.message, '#ef4444'); }
}

// ==================== SUPPORT ====================
async function loadSupport() {
  try {
    const d = await api('/api/user-panel/support');
    document.getElementById('support-contact').innerHTML = `<p>For help, contact the administrator:</p>
      <a href="${d.support_url}" target="_blank" class="login-btn" style="margin-top:10px;display:inline-flex;">
        <ion-icon name="paper-plane-outline" style="font-size:20px;"></ion-icon> Contact Admin
      </a>`;
  } catch (e) {}
}

async function checkWebUser() {
  try {
    const me = await api('/api/user-panel/auth/me');
    if (me.email) {
      const card = document.getElementById('change-password-card');
      if (card) card.style.display = '';
    }
    if (me.last_platform) { lastSvc = me.last_platform; lastRange = me.last_range; lastPc = me.last_provider_code; }
  } catch (e) {}
}

document.getElementById('change-password-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const s = document.getElementById('pw-change-status');
  try {
    const r = await api('/api/user-panel/auth/change-password', 'POST', { old_password: document.getElementById('old-pw').value, new_password: document.getElementById('new-pw').value });
    s.style.color = 'var(--text-success)'; s.textContent = r.message;
    document.getElementById('change-password-form').reset();
  } catch (err) { s.style.color = 'var(--text-danger)'; s.textContent = err.message; }
});

// LOGOUT
document.getElementById('btn-logout').addEventListener('click', async () => {
  try { await api('/api/user-panel/auth/logout', 'POST'); } catch (e) {}
  window.location.href = '/landing';
});

// NAV
document.querySelectorAll('.usr-nav-item').forEach(b => b.addEventListener('click', e => switchTab(e.currentTarget.dataset.tab)));

// INIT
document.addEventListener('DOMContentLoaded', () => {
  fetch('/api/user-panel/auth/me', { credentials: 'include' }).then(r => r.ok ? r.json() : Promise.reject()).then(() => { checkWebUser(); loadServices(); }).catch(() => window.location.href = '/landing');
});
