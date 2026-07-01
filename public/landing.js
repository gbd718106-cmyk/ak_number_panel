// Load support contact link
async function loadSupportLink() {
  try {
    const res = await fetch('/api/settings/public-contact');
    if (res.ok) {
      const data = await res.json();
      if (data.support_url) {
        document.getElementById('admin-contact-link').href = data.support_url;
      }
    }
  } catch (e) {}
}

// Login form
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('btn-login');
  const errEl = document.getElementById('login-error');
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  btn.disabled = true;
  btn.innerHTML = '<ion-icon name="sync-outline"></ion-icon> Signing in...';
  errEl.style.display = 'none';

  try {
    const res = await fetch('/api/auth/unified-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Login failed');

    if (data.redirect === 'admin') {
      localStorage.setItem('ak_token', data.token);
      localStorage.setItem('ak_email', data.email);
      window.location.href = '/admin';
    } else {
      window.location.href = '/user';
    }
  } catch (err) {
    btn.disabled = false;
    btn.innerHTML = '<ion-icon name="log-in-outline"></ion-icon> Sign In';
    errEl.style.display = 'block';
    errEl.textContent = err.message;
  }
});

// On load: check if already logged in
document.addEventListener('DOMContentLoaded', () => {
  loadSupportLink();

  // Check admin token
  const akToken = localStorage.getItem('ak_token');
  if (akToken) {
    fetch('/api/dashboard/stats', { headers: { Authorization: 'Bearer ' + akToken } })
      .then(r => { if (r.ok) window.location.href = '/admin'; })
      .catch(() => {});
  }

  // Check user session
  fetch('/api/user-panel/auth/me', { credentials: 'include' })
    .then(r => { if (r.ok) window.location.href = '/user'; })
    .catch(() => { /* not logged in — stay on landing */ });
});
