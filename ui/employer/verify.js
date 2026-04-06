/**
 * AuthenX Employer Verification Portal — Shared JS
 */

const API_BASE = 'http://localhost:3000/v1';

const Auth = {
  getToken() { return localStorage.getItem('ax_emp_token'); },
  getClaims() {
    const t = this.getToken();
    if (!t) return null;
    try { return JSON.parse(atob(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); }
    catch { return null; }
  },
  isLoggedIn() { const c = this.getClaims(); return c && c.exp > Date.now()/1000; },
  logout() { localStorage.removeItem('ax_emp_token'); window.location.href = '/employer/index.html'; },
  requireAuth() { if (!this.isLoggedIn()) { window.location.href = '/employer/index.html'; return false; } return true; },
};

const API = {
  async call(method, path, body = null) {
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(Auth.getToken() ? { 'Authorization': `Bearer ${Auth.getToken()}` } : {})
      }
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API_BASE}${path}`, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },
  get:  (path)       => API.call('GET', path),
  post: (path, body) => API.call('POST', path, body),
};

function toast(message, type = 'info', duration = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span>${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</span> ${message}`;
  container.appendChild(t);
  setTimeout(() => { t.style.opacity='0'; t.style.transform='translateX(120%)'; t.style.transition='0.3s'; setTimeout(()=>t.remove(),300); }, duration);
}

function renderNavbar(active) {
  return `
  <nav class="top-nav">
    <a href="/employer/index.html" class="nav-logo">
      <div class="mark">AX</div>
      <div>
        <div class="nav-logo-text">AuthenX</div>
        <div class="nav-logo-sub">Employer Verification Portal</div>
      </div>
    </a>
    <div class="nav-actions">
      ${Auth.isLoggedIn()
        ? `<span style="font-size:13px;color:var(--ax-gray-500)">${Auth.getClaims()?.email||''}</span>
           <a href="/employer/verify.html" class="btn btn-primary btn-sm" style="padding:7px 14px">Verify a Code</a>
           <button class="btn btn-secondary" style="padding:7px 14px" onclick="Auth.logout()">Logout</button>`
        : `<a href="/employer/index.html" class="btn btn-primary" style="padding:7px 14px">Login to Verify →</a>`
      }
    </div>
  </nav>`;
}

function renderStepper(current) {
  const steps = [
    { n: 1, label: 'Paste Code' },
    { n: 2, label: 'Registry Check' },
    { n: 3, label: 'Live Verified' },
  ];
  return `
  <div class="stepper">
    ${steps.map((s, i) => `
      <div class="step-item ${current > s.n ? 'done' : current === s.n ? 'active' : ''}">
        <div class="step-circle">${current > s.n ? '✓' : s.n}</div>
        <div class="step-label">${s.label}</div>
      </div>
      ${i < steps.length - 1 ? `<div class="step-line ${current > s.n ? 'done' : ''}"></div>` : ''}
    `).join('')}
  </div>`;
}
