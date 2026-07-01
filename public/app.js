// STATE MANAGEMENT
let token = localStorage.getItem('ak_token') || null;
let currentTab = 'dashboard';
let currentProviderIdForAccount = null;
let currentBotFilter = 'all';

// API REQUEST HELPER
async function apiCall(endpoint, method = 'GET', body = null) {
  const headers = {
    'Content-Type': 'application/json'
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const config = {
    method,
    headers
  };
  if (body) {
    config.body = JSON.stringify(body);
  }

  try {
    const res = await fetch(endpoint, config);
    
    // Handle session expiration
    if (res.status === 401 || res.status === 403) {
      logout();
      showToast('Session expired. Please log in again.', 'red');
      throw new Error('Unauthorized');
    }

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'Request failed');
    }
    return data;
  } catch (err) {
    console.error('API Error:', err.message);
    throw err;
  }
}

// TOAST ALERT
function showToast(message, type = 'green') {
  const toast = document.getElementById('toast');
  toast.innerText = message;
  toast.className = `toast active`;
  if (type === 'red') {
    toast.style.background = '#ef4444';
  } else if (type === 'orange') {
    toast.style.background = '#f59e0b';
  } else {
    toast.style.background = '#6366f1';
  }
  
  setTimeout(() => {
    toast.classList.remove('active');
  }, 3000);
}

// BOOTSTRAP INITIAL SESSION
window.addEventListener('DOMContentLoaded', () => {
  if (token) {
    showAppScreen();
  } else {
    showLoginScreen();
  }
  setupEventListeners();
  loadPublicSupportLink();
});

// LOAD SUPPORT ID ON LOGIN PAGE
async function loadPublicSupportLink() {
  try {
    const res = await fetch('/api/settings/public-contact');
    if (res.ok) {
      const data = await res.json();
      if (data.support_url) {
        document.getElementById('admin-contact-btn').href = data.support_url;
      }
    }
  } catch (err) {
    // Ignore fail since it's just support link decoration
  }
}

function showLoginScreen() {
  document.getElementById('login-screen').classList.add('active');
  document.getElementById('app-screen').classList.remove('active');
}

function showAppScreen() {
  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('active');
  document.getElementById('user-display-email').innerText = localStorage.getItem('ak_email') || 'Admin User';
  switchTab('dashboard');
  
  // Start periodic dashboard polling (every 8 seconds)
  setInterval(() => {
    if (currentTab === 'dashboard' && token) {
      loadDashboardStats();
      loadProviderStats();
    }
  }, 8000);
}

function logout() {
  localStorage.removeItem('ak_token');
  localStorage.removeItem('ak_email');
  token = null;
  showLoginScreen();
}

// SCREEN TAB SWITCHING
function switchTab(tabName) {
  currentTab = tabName;
  
  // Manage Nav Item active styling
  document.querySelectorAll('.nav-item').forEach(btn => {
    if (btn.getAttribute('data-tab') === tabName) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Manage Panel active visibility
  document.querySelectorAll('.tab-pane').forEach(pane => {
    if (pane.id === `tab-${tabName}`) {
      pane.classList.add('active');
    } else {
      pane.classList.remove('active');
    }
  });

  // Set Title
  const titleMap = {
    'dashboard': 'Dashboard Overview',
    'bots': 'Telegram Bots Configuration',
    'users': 'Users & Access Controls',
    'providers': 'API Providers & Keys Rotation',
    'services': 'Service Platform Customizations',
    'broadcast': 'Announcements & Broadcast',
    'settings': 'Global System Settings'
  };
  document.getElementById('page-title').innerText = titleMap[tabName] || 'AK NUMBER PANEL';

  // Load Tab Specific Data
  if (tabName === 'dashboard') { loadDashboardStats(); loadProviderStats(); }
  if (tabName === 'bots') loadBots();
  if (tabName === 'users') loadUsers();
  if (tabName === 'providers') loadProviders();
  if (tabName === 'services') loadServicesProviderList();
  if (tabName === 'broadcast') loadBroadcastBots();
  if (tabName === 'settings') loadGlobalSettings();
}

// ----------------------------------------------------
// EVENT LISTENERS CONFIG
// ----------------------------------------------------
function setupEventListeners() {
  // Login Form
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    try {
      const data = await apiCall('/api/auth/unified-login', 'POST', { email, password });

      if (data.redirect === 'admin') {
        token = data.token;
        localStorage.setItem('ak_token', token);
        localStorage.setItem('ak_email', data.email);
        showToast('Logged in successfully!');
        showAppScreen();
      } else {
        window.location.href = '/user';
      }
    } catch (err) {
      showToast(err.message || 'Login failed', 'red');
    }
  });

  // Sidebar Nav Items
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tab = e.currentTarget.getAttribute('data-tab');
      switchTab(tab);
    });
  });

  // Sub tab navigation (inside Users tab)
  document.querySelectorAll('.tab-sub-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const subTab = e.target.getAttribute('data-sub-tab');
      
      document.querySelectorAll('.tab-sub-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');

      document.querySelectorAll('.sub-tab-pane').forEach(p => p.classList.remove('active'));
      document.getElementById(`sub-tab-${subTab}`).classList.add('active');
    });
  });

  // Logout Button
  document.getElementById('logout-btn').addEventListener('click', () => {
    if (confirm('Are you sure you want to sign out?')) {
      logout();
    }
  });

  // Add Bot Form
  document.getElementById('add-bot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('bot-name').value;
    const botToken = document.getElementById('bot-token').value;
    const support_username = document.getElementById('bot-support').value;

    try {
      await apiCall('/api/bots', 'POST', { name, token: botToken, support_username });
      showToast('Telegram bot created & webhook active!');
      document.getElementById('add-bot-form').reset();
      loadBots();
    } catch (err) {
      showToast(err.message, 'red');
    }
  });

  // Test Bot Connection
  document.getElementById('btn-test-bot').addEventListener('click', async () => {
    const botToken = document.getElementById('bot-token').value;
    if (!botToken) return showToast('Please enter a bot token first', 'orange');

    showToast('Testing connection...');
    try {
      const data = await apiCall('/api/bots/test', 'POST', { token: botToken });
      showToast(`Success! Connected to @${data.result.username}`, 'green');
    } catch (err) {
      showToast('Connection failed. Token may be invalid.', 'red');
    }
  });

  // Create Web Account
  document.getElementById('add-admin-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('admin-email').value;
    const temp_password = document.getElementById('admin-password').value;
    const role = document.getElementById('admin-role').value;

    try {
      await apiCall('/api/users/admin', 'POST', { email, temp_password, role });
      showToast('Web account created!');
      document.getElementById('add-admin-form').reset();
      loadAdminUsers();
    } catch (err) {
      showToast(err.message, 'red');
    }
  });

  // Add Provider Form
  document.getElementById('add-provider-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('provider-name').value;
    const unique_code = document.getElementById('provider-code').value;
    const base_url = document.getElementById('provider-url').value;

    try {
      await apiCall('/api/providers', 'POST', { name, unique_code, base_url });
      showToast('Provider API registered!');
      document.getElementById('add-provider-form').reset();
      loadProviders();
    } catch (err) {
      showToast(err.message, 'red');
    }
  });

  // Add Account Form
  document.getElementById('add-account-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const providerId = document.getElementById('account-provider-id').value;
    const name = document.getElementById('account-name').value;
    const api_key = document.getElementById('account-key').value;
    const priority = parseInt(document.getElementById('account-priority').value);

    try {
      await apiCall(`/api/providers/${providerId}/accounts`, 'POST', { name, api_key, priority });
      showToast('API key account connected!');
      document.getElementById('add-account-form').reset();
      loadProviders();
    } catch (err) {
      showToast(err.message, 'red');
    }
  });

  // Global Settings Form
  document.getElementById('settings-global-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const support_url = document.getElementById('global-support-url').value;

    try {
      await apiCall('/api/settings/global', 'POST', { support_url });
      showToast('Global settings updated!');
    } catch (err) {
      showToast(err.message, 'red');
    }
  });

  // Update Password Form
  document.getElementById('change-password-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const old_password = document.getElementById('old-password').value;
    const new_password = document.getElementById('new-password').value;

    try {
      await apiCall('/api/settings/change-password', 'POST', { old_password, new_password });
      showToast('Password updated!');
      document.getElementById('change-password-form').reset();
    } catch (err) {
      showToast(err.message, 'red');
    }
  });
}

// ----------------------------------------------------
// 1. DASHBOARD OVERVIEW DATA LOADER
// ----------------------------------------------------
async function loadDashboardStats() {
  try {
    const data = await apiCall('/api/dashboard/stats');
    
    // Set counters
    document.getElementById('stat-users').innerText = data.counters.users;
    document.getElementById('stat-bots').innerText = data.counters.bots;
    document.getElementById('stat-otps-24h').innerText = data.counters.otps24h;
    document.getElementById('stat-otps-30d').innerText = data.counters.otps30d;

    // Render Service leaderboard
    const svcTbody = document.getElementById('leaderboard-services');
    svcTbody.innerHTML = '';
    if (data.topServices.length === 0) {
      svcTbody.innerHTML = `<tr><td colspan="3" class="text-center">No successful verifications recorded.</td></tr>`;
    } else {
      data.topServices.forEach((svc, idx) => {
        svcTbody.innerHTML += `
          <tr>
            <td><strong>#${idx + 1}</strong></td>
            <td>${svc.name}</td>
            <td><span class="badge blue">${svc.count} OTPs</span></td>
          </tr>
        `;
      });
    }

    // Render Range leaderboard
    const rangeTbody = document.getElementById('leaderboard-ranges');
    rangeTbody.innerHTML = '';
    if (data.topRanges.length === 0) {
      rangeTbody.innerHTML = `<tr><td colspan="3" class="text-center">No range traffic recorded.</td></tr>`;
    } else {
      data.topRanges.forEach((r, idx) => {
        rangeTbody.innerHTML += `
          <tr>
            <td><strong>#${idx + 1}</strong></td>
            <td>${r.flag} ${r.country} (${r.range})</td>
            <td><span class="badge green">${r.count} OTPs</span></td>
          </tr>
        `;
      });
    }
    } catch (err) {
    console.error('Failed to load stats:', err.message);
  }
}

async function loadProviderStats() {
  try {
    const data = await apiCall('/api/dashboard/provider-stats');
    const tbody = document.getElementById('provider-stats-body');
    tbody.innerHTML = '';

    if (data.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center">No providers configured yet.</td></tr>`;
      return;
    }

    data.forEach((p, idx) => {
      const topSvc = p.topServices && p.topServices.length > 0 ? p.topServices[0].name : '-';
      tbody.innerHTML += `
        <tr>
          <td><strong>[${p.uniqueCode}] ${p.name}</strong></td>
          <td><span class="badge blue">${p.activeAccounts}</span></td>
          <td><span class="badge green">${p.otps24h}</span></td>
          <td><span class="badge purple">${p.otps7d}</span></td>
          <td><span class="badge gold">${p.otps30d}</span></td>
          <td>${topSvc}</td>
        </tr>
      `;
    });
  } catch (err) {
    console.error('Failed to load provider stats:', err.message);
  }
}

// ----------------------------------------------------
// 2. TELEGRAM BOTS DATA LOADER
// ----------------------------------------------------
async function loadBots() {
  try {
    const bots = await apiCall('/api/bots');
    const container = document.getElementById('bots-list');
    container.innerHTML = '';

    if (bots.length === 0) {
      container.innerHTML = `<div class="section-desc text-center" style="grid-column: 1/-1;">No Telegram bots connected. Add one using the form.</div>`;
      return;
    }

    bots.forEach(bot => {
      const card = document.createElement('div');
      card.className = 'bot-card';
      card.innerHTML = `
        <div class="bot-card-header">
          <h4>${bot.name}</h4>
          <span class="badge ${bot.is_active ? 'green' : 'red'}">${bot.is_active ? 'Online' : 'Offline'}</span>
        </div>
        <div class="bot-card-body">
          <p>Support username: <strong>@${bot.support_username || 'ak_admin'}</strong></p>
          <p>Token: <code>${bot.token.substring(0, 15)}...</code></p>
        </div>
        <div class="form-actions-row" style="margin-top: 8px; justify-content: flex-end;">
          <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px;" onclick="editBot('${bot.id}', '${bot.name.replace(/'/g, "\\'")}', '${bot.token.replace(/'/g, "\\'")}', '${(bot.support_username || '').replace(/'/g, "\\'")}')" title="Edit Bot">
            <ion-icon name="create-outline"></ion-icon> Edit
          </button>
          <button class="badge-action red" onclick="deleteBot('${bot.id}')" title="Remove Bot">
            <ion-icon name="trash-outline"></ion-icon>
          </button>
        </div>
      `;
      container.appendChild(card);
    });
  } catch (err) {
    showToast(err.message, 'red');
  }
}

async function deleteBot(id) {
  if (!confirm('Are you sure you want to delete this bot? This action will disable it immediately.')) return;
  try {
    await apiCall(`/api/bots/${id}`, 'DELETE');
    showToast('Telegram bot disconnected');
    loadBots();
  } catch (err) {
    showToast(err.message, 'red');
  }
}

async function editBot(id, oldName, oldToken, oldSupport) {
  const name = prompt('Bot Name:', oldName);
  if (name === null) return;
  const token = prompt('Bot API Token:', oldToken);
  if (token === null) return;
  const support = prompt('Support Username:', oldSupport || '');

  try {
    await apiCall(`/api/bots/${id}`, 'PUT', { name, token, support_username: support });
    showToast('Bot updated! Bot will reconnect...');
    loadBots();
  } catch (err) {
    showToast(err.message || 'Update failed', 'red');
  }
}

// ----------------------------------------------------
// 3. USERS MANAGEMENT DATA LOADER
// ----------------------------------------------------
function loadUsers() {
  loadBotUsers();
  loadAdminUsers();
  loadBotFilterOptions();
}

async function loadBotFilterOptions() {
  try {
    const bots = await apiCall('/api/bots');
    const select = document.getElementById('bot-user-filter');
    select.innerHTML = '<option value="all">All Bots</option>';
    bots.forEach(b => {
      select.innerHTML += `<option value="${b.id}">${b.name}</option>`;
    });
    select.value = currentBotFilter;
  } catch (err) {
    // ignore
  }
}

function filterBotUsers() {
  currentBotFilter = document.getElementById('bot-user-filter').value;
  loadBotUsers();
}

async function loadBotUsers() {
  try {
    const url = currentBotFilter === 'all' ? '/api/users/bot' : `/api/users/bot?bot_id=${currentBotFilter}`;
    const users = await apiCall(url);
    const tbody = document.getElementById('bot-users-table-body');
    tbody.innerHTML = '';

    if (users.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center">No bot users registered.</td></tr>`;
      return;
    }

    users.forEach(u => {
      tbody.innerHTML += `
        <tr>
          <td>
            <strong>${u.first_name} ${u.last_name || ''}</strong><br>
            <small class="text-muted">@${u.username || 'no_username'} (${u.telegram_id})</small>
          </td>
          <td>${u.botName}</td>
          <td><span class="badge blue">${u.otpCount}</span></td>
          <td>${new Date(u.created_at).toLocaleDateString()}</td>
          <td>
            <span class="badge ${u.is_blocked ? 'red' : 'green'}">${u.is_blocked ? 'Blocked' : 'Active'}</span>
          </td>
          <td>
            <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 12px;" onclick="toggleBlockUser('${u.id}', ${!u.is_blocked})">
              ${u.is_blocked ? 'Unblock' : 'Block'}
            </button>
          </td>
        </tr>
      `;
    });
  } catch (err) {
    showToast(err.message, 'red');
  }
}

async function toggleBlockUser(id, blockStatus) {
  const confirmationMsg = blockStatus 
    ? 'Are you sure you want to block this user? They will not be able to get OTP numbers.' 
    : 'Are you sure you want to unblock this user?';

  if (!confirm(confirmationMsg)) return;

  try {
    await apiCall(`/api/users/bot/${id}/toggle-block`, 'POST', { is_blocked: blockStatus });
    showToast(blockStatus ? 'User blocked' : 'User unblocked');
    loadBotUsers();
  } catch (err) {
    showToast(err.message, 'red');
  }
}

async function loadAdminUsers() {
  try {
    const admins = await apiCall('/api/users/admin');
    const tbody = document.getElementById('admin-users-table-body');
    tbody.innerHTML = '';

    admins.forEach(admin => {
      const roleBadge = admin.role === 'superadmin' ? 'gold' : 'green';
      const statusBadge = admin.is_active ? '<span class="badge green">Active</span>' : '<span class="badge red">Suspended</span>';
      const toggleBtn = admin.is_active
        ? `<button class="badge-action orange" onclick="toggleAdminActive('${admin.id}', false)" title="Suspend">⏸</button>`
        : `<button class="badge-action green" onclick="toggleAdminActive('${admin.id}', true)" title="Activate">▶</button>`;

      tbody.innerHTML += `
        <tr>
          <td>${admin.email}</td>
          <td><span class="badge ${roleBadge}">${admin.role}</span></td>
          <td>${statusBadge}</td>
          <td>${new Date(admin.created_at).toLocaleDateString()}</td>
          <td>
            ${toggleBtn}
            <button class="badge-action red" onclick="deleteAdmin('${admin.id}')" title="Delete">
              <ion-icon name="trash-outline"></ion-icon>
            </button>
          </td>
        </tr>
      `;
    });
  } catch (err) {
    showToast(err.message, 'red');
  }
}

async function toggleAdminActive(id, isActive) {
  const msg = isActive ? 'Activate this account?' : 'Suspend this account?';
  if (!confirm(msg)) return;
  try {
    await apiCall(`/api/users/admin/${id}/toggle-active`, 'POST', { is_active: isActive });
    showToast(isActive ? 'Account activated' : 'Account suspended');
    loadAdminUsers();
  } catch (err) {
    showToast(err.message, 'red');
  }
}

async function deleteAdmin(id) {
  if (!confirm('Are you sure you want to permanently delete this account?')) return;
  try {
    await apiCall(`/api/users/admin/${id}`, 'DELETE');
    showToast('Web account deleted');
    loadAdminUsers();
  } catch (err) {
    showToast(err.message, 'red');
  }
}

// ----------------------------------------------------
// 4. PROVIDERS & KEYS ROTATION DATA LOADER
// ----------------------------------------------------
async function loadProviders() {
  try {
    const providers = await apiCall('/api/providers');
    const container = document.getElementById('providers-list');
    container.innerHTML = '';

    if (providers.length === 0) {
      container.innerHTML = `<div class="section-desc text-center">No providers registered. Add one using the form.</div>`;
      return;
    }

    for (const p of providers) {
      const accounts = await apiCall(`/api/providers/${p.id}/accounts`);

      const pItem = document.createElement('div');
      pItem.className = 'accordion-item';
      pItem.id = `provider-item-${p.id}`;
      
      let accountsHtml = '';
      if (accounts.length === 0) {
        accountsHtml = `<div class="section-desc text-center mt-1">No API Accounts/Keys connected for this provider.</div>`;
      } else {
        accounts.forEach(acc => {
          let latClass = 'excellent';
          if (acc.latency_ms > 4000) latClass = 'offline';
          else if (acc.latency_ms > 1500) latClass = 'warning';

          accountsHtml += `
            <div class="account-card">
              <div class="account-card-header">
                <h5>${acc.name}</h5>
                <span class="latency-badge ${latClass}">
                  ${acc.latency_ms >= 99999 ? 'Offline' : `${acc.latency_ms} ms`}
                </span>
              </div>
              <div class="bot-card-body">
                <p>Priority Rank: <strong>#${acc.priority}</strong></p>
                <p>Status: <span class="badge ${acc.is_active ? 'green' : 'red'}">${acc.is_active ? 'Active' : 'Disabled'}</span></p>
              </div>
              <div class="form-actions-row mt-1" style="justify-content: space-between; align-items: center;">
                <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 11px;" onclick="toggleAccountActive('${acc.id}', ${!acc.is_active})">
                  ${acc.is_active ? 'Disable' : 'Enable'}
                </button>
                <div style="display:flex; gap: 8px;">
                  <button class="btn btn-primary" style="padding: 4px 8px; font-size: 11px;" onclick="openAccount('${acc.id}')" title="Open Account">
                    <ion-icon name="open-outline"></ion-icon> Open
                  </button>
                  <button class="badge-action" onclick="changeAccountPriority('${acc.id}', ${acc.priority})" title="Edit Priority">
                    <ion-icon name="options-outline"></ion-icon>
                  </button>
                  <button class="badge-action red" onclick="deleteAccount('${acc.id}')" title="Delete Key">
                    <ion-icon name="trash-outline"></ion-icon>
                  </button>
                </div>
              </div>
            </div>
          `;
        });
      }

      pItem.innerHTML = `
        <div class="accordion-header" onclick="toggleProviderAccordion('${p.id}')">
          <div class="accordion-title">
            <ion-icon name="chevron-forward-outline" class="acc-icon"></ion-icon>
            <h4>${p.name} [${p.unique_code}]</h4>
          </div>
          <div style="display:flex; gap:12px; align-items:center;">
            <span class="badge blue">${accounts.length} Accounts</span>
            <button class="btn btn-secondary" style="padding: 6px 10px; font-size:12px;" onclick="selectProviderForAccount(event, '${p.id}', '${p.name}')">
              Manage Keys
            </button>
            <button class="badge-action red" onclick="deleteProvider(event, '${p.id}')">
              <ion-icon name="trash-outline"></ion-icon>
            </button>
          </div>
        </div>
        <div class="accordion-content">
          <p class="section-desc" style="margin-bottom:8px;">Base URL: <code>${p.base_url}</code></p>
          <div class="accounts-grid">
            ${accountsHtml}
          </div>
        </div>
      `;

      container.appendChild(pItem);
    }
  } catch (err) {
    showToast(err.message, 'red');
  }
}

function toggleProviderAccordion(id) {
  const el = document.getElementById(`provider-item-${id}`);
  const icon = el.querySelector('.acc-icon');
  
  if (el.classList.contains('open')) {
    el.classList.remove('open');
    icon.style.transform = 'rotate(0deg)';
  } else {
    el.classList.add('open');
    icon.style.transform = 'rotate(90deg)';
  }
}

function selectProviderForAccount(event, providerId, providerName) {
  event.stopPropagation(); // prevent accordion toggle
  currentProviderIdForAccount = providerId;
  document.getElementById('account-provider-id').value = providerId;
  document.getElementById('current-provider-name').innerText = providerName;
  document.getElementById('add-account-section').style.display = 'block';
  
  // Smooth scroll to form section
  document.getElementById('add-account-section').scrollIntoView({ behavior: 'smooth' });
}

async function deleteProvider(event, id) {
  event.stopPropagation();
  if (!confirm('Are you sure you want to delete this API provider? All connected accounts will be deleted.')) return;
  try {
    await apiCall(`/api/providers/${id}`, 'DELETE');
    showToast('Provider deleted');
    document.getElementById('add-account-section').style.display = 'none';
    loadProviders();
  } catch (err) {
    showToast(err.message, 'red');
  }
}

async function toggleAccountActive(id, newStatus) {
  try {
    await apiCall(`/api/providers/accounts/${id}/toggle-active`, 'POST', { is_active: newStatus });
    showToast('Account state updated');
    loadProviders();
  } catch (err) {
    showToast(err.message, 'red');
  }
}

async function changeAccountPriority(id, currentPriority) {
  const prio = prompt('Enter priority rank (1 = first priority, 2 = fallback, etc):', currentPriority);
  if (prio === null || isNaN(prio) || parseInt(prio) < 1) return;

  try {
    await apiCall(`/api/providers/accounts/${id}/priority`, 'POST', { priority: parseInt(prio) });
    showToast('Priority updated');
    loadProviders();
  } catch (err) {
    showToast(err.message, 'red');
  }
}

async function deleteAccount(id) {
  if (!confirm('Are you sure you want to remove this API key account?')) return;
  try {
    await apiCall(`/api/providers/accounts/${id}`, 'DELETE');
    showToast('Key account deleted');
    loadProviders();
  } catch (err) {
    showToast(err.message, 'red');
  }
}

async function openAccount(accountId) {
  showToast('Loading account details...');
  try {
    const data = await apiCall(`/api/providers/accounts/${accountId}/open`);

    let html = `<h3><ion-icon name="eye-outline"></ion-icon> Account: ${data.accountName}</h3>`;
    html += `<p class="section-desc">Provider: ${data.providerName}</p>`;
    html += `<hr style="margin:12px 0; border-color: var(--border-color);">`;

    if (data.services.length === 0) {
      html += `<p class="section-desc text-center">No services available for this account.</p>`;
    } else {
      html += `<div class="services-grid" style="display:flex; flex-wrap:wrap; gap:12px;">`;
      data.services.forEach(svc => {
        html += `<div class="glass-card" style="flex:1; min-width:200px; padding:12px;">`;
        html += `<h4>${svc.platform}</h4>`;
        svc.ranges.forEach(r => {
          html += `<div style="display:flex; justify-content:space-between; align-items:center; padding:4px 0; border-bottom:1px solid var(--border-color);">`;
          html += `<code>${r.range}</code>`;
          html += `<span class="badge ${r.trafficCount > 0 ? 'green' : ''}" style="font-size:10px;">${r.trafficCount} OTPs</span>`;
          html += `</div>`;
        });
        html += `</div>`;
      });
      html += `</div>`;
    }

    document.getElementById('account-detail-content').innerHTML = html;
    document.getElementById('account-detail-modal').style.display = 'flex';
  } catch (err) {
    showToast(err.message || 'Failed to open account', 'red');
  }
}

function closeAccountModal() {
  document.getElementById('account-detail-modal').style.display = 'none';
}

// ----------------------------------------------------
// 5. SERVICES & PLATFORM CONTROLS DATA LOADER
// ----------------------------------------------------
let loadedServices = [];
let selectedProviderId = null;

async function loadServicesProviderList() {
  try {
    const providers = await apiCall('/api/providers');
    const select = document.getElementById('svc-provider-select');
    select.innerHTML = '<option value="">-- Select a provider --</option>';
    providers.forEach(p => {
      select.innerHTML += `<option value="${p.id}">[${p.unique_code}] ${p.name}</option>`;
    });
  } catch (err) { /* ignore */ }
}

async function loadProviderServices() {
  const select = document.getElementById('svc-provider-select');
  selectedProviderId = select.value;
  if (!selectedProviderId) {
    document.getElementById('svc-load-status').innerHTML = '<span style="color:var(--text-danger)">Please select a provider first.</span>';
    return;
  }

  document.getElementById('svc-load-status').innerHTML = '⏳ Loading services from API...';
  try {
    const data = await apiCall(`/api/services/live-from-provider/${selectedProviderId}`);
    loadedServices = data.services;

    if (loadedServices.length === 0) {
      document.getElementById('svc-load-status').innerHTML = '<span style="color:var(--text-warning)">No services found from this provider.</span>';
      document.getElementById('svc-toggle-list').innerHTML = '';
      return;
    }

    document.getElementById('svc-load-status').innerHTML = `<span style="color:var(--text-success)">✓ Loaded ${loadedServices.length} services from [${data.providerCode}]</span>`;
    renderServiceToggles();
  } catch (err) {
    document.getElementById('svc-load-status').innerHTML = `<span style="color:var(--text-danger)">Failed: ${err.message}</span>`;
  }
}

function renderServiceToggles() {
  const container = document.getElementById('svc-toggle-list');
  container.innerHTML = '';

  loadedServices.forEach((svc, i) => {
    const newBadge = svc.isNew ? ' <span style="font-size:10px; color:var(--accent); background:rgba(20,184,166,0.15); padding:2px 6px; border-radius:4px;">NEW</span>' : '';
    container.innerHTML += `
      <div class="service-toggle-row" style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px solid var(--border-color); cursor:pointer;" onclick="loadServiceRanges('${svc.platform.replace(/'/g, "\\'")}', ${i})">
        <span style="font-weight:500;">${svc.platform}${newBadge} <small style="color:var(--text-muted);">(${svc.rangeCount} ranges)</small></span>
        <label class="switch-container" onclick="event.stopPropagation()">
          <input type="checkbox" ${svc.isEnabled ? 'checked' : ''} onchange="toggleService('${i}', this.checked)">
          <span class="switch-slider"></span>
        </label>
      </div>
    `;
  });
}

function toggleService(index, enabled) {
  loadedServices[index].isEnabled = enabled;
}

async function saveServiceSelection() {
  if (!selectedProviderId || loadedServices.length === 0) {
    showToast('Load services first', 'orange');
    return;
  }

  try {
    for (const svc of loadedServices) {
      const enabledRanges = svc.ranges.filter(r => r.isEnabled).map(r => r.range);
      const disabledRanges = svc.ranges.filter(r => !r.isEnabled).map(r => r.range);

      await apiCall('/api/services/settings', 'POST', {
        platform: svc.platform,
        is_enabled: svc.isEnabled,
        disabled_providers: svc.isEnabled ? [] : [selectedProviderId],
        disabled_ranges: disabledRanges
      });
    }
    showToast('Service & range selection saved!');
  } catch (err) {
    showToast(err.message || 'Save failed', 'red');
  }
}

function loadServiceRanges(platform, svcIndex) {
  if (svcIndex === undefined) {
    const svc = loadedServices.find(s => s.platform === platform);
    svcIndex = loadedServices.indexOf(svc);
  }
  const svc = loadedServices[svcIndex];
  if (!svc) return;

  document.getElementById('svc-range-title').innerText = `${platform} Ranges`;
  document.getElementById('svc-range-subtitle').innerText = `${svc.ranges.length} ranges`;

  const container = document.getElementById('svc-range-list');
  container.innerHTML = `
    <table class="custom-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Country / Range</th>
          <th>Prefix</th>
          <th>Traffic</th>
          <th>Active</th>
        </tr>
      </thead>
      <tbody>
        ${svc.ranges.map((r, i) => `
          <tr>
            <td>${i + 1}</td>
            <td>${r.flag} ${r.country} <code>${r.range}</code>${r.isNew ? ' <span style="font-size:10px;color:var(--accent);">NEW</span>' : ''}</td>
            <td><code>${r.prefix}</code></td>
            <td><span class="badge ${r.traffic > 0 ? 'green' : ''}">${r.traffic} codes</span></td>
            <td>
              <label class="switch-container">
                <input type="checkbox" ${r.isEnabled ? 'checked' : ''} onchange="toggleRange('${svcIndex}', ${i}, this.checked)">
                <span class="switch-slider"></span>
              </label>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function toggleRange(svcIndex, rangeIndex, enabled) {
  loadedServices[svcIndex].ranges[rangeIndex].isEnabled = enabled;
}

async function loadGlobalSettings() {
  try {
    const data = await apiCall('/api/settings/global');
    document.getElementById('global-support-url').value = data.support_url || '';
  } catch (err) {
    showToast('Failed to load global settings', 'red');
  }
}

// ----------------------------------------------------
// 8. BROADCAST / ANNOUNCEMENT
// ----------------------------------------------------
async function loadBroadcastBots() {
  try {
    const bots = await apiCall('/api/bots');
    const select = document.getElementById('broadcast-bot-select');
    select.innerHTML = '<option value="">-- Select bot --</option>';
    bots.forEach(b => {
      select.innerHTML += `<option value="${b.id}">${b.name}</option>`;
    });
  } catch (err) { /* ignore */ }
}

async function loadBroadcastUsers() {
  const botId = document.getElementById('broadcast-bot-select').value;
  const userSelect = document.getElementById('broadcast-user-select');
  userSelect.innerHTML = '<option value="all">All Users</option>';
  if (!botId) return;

  try {
    const users = await apiCall(`/api/broadcast/users/${botId}`);
    users.forEach(u => {
      const name = u.first_name || u.username || u.telegram_id;
      userSelect.innerHTML += `<option value="${u.id}">${name} (@${u.username || u.telegram_id})</option>`;
    });
  } catch (err) { /* ignore */ }
}

async function sendBroadcast() {
  const botId = document.getElementById('broadcast-bot-select').value;
  const userId = document.getElementById('broadcast-user-select').value;
  const message = document.getElementById('broadcast-message').value.trim();

  if (!botId) return showToast('Select a bot first', 'orange');
  if (!message) return showToast('Type a message', 'orange');

  const status = document.getElementById('broadcast-status');
  status.innerHTML = '⏳ Sending...';

  try {
    const result = await apiCall('/api/broadcast/send', 'POST', {
      bot_id: botId, user_id: userId, message
    });
    status.innerHTML = `<span style="color:var(--text-success);">✅ Sent: ${result.sent} | Failed: ${result.failed}</span>`;
    document.getElementById('broadcast-message').value = '';
  } catch (err) {
    status.innerHTML = `<span style="color:var(--text-danger);">Failed: ${err.message}</span>`;
  }
}

