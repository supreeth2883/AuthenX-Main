/**
 * AuthenX College Admin Portal — Shared JS
 * API calls, auth, navigation, and utilities
 */

const API_BASE = 'http://localhost:3000/v1';

// ─── Auth ─────────────────────────────────────────────────────────────────────
const Auth = {
  getToken() { return localStorage.getItem('ax_token'); },
  getClaims() {
    const t = this.getToken();
    if (!t) return null;
    try { return JSON.parse(atob(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); }
    catch { return null; }
  },
  getCollegeId() { return this.getClaims()?.college_id || null; },
  getConnectorUrl(path = '') {
    const cid = this.getCollegeId();
    if (!cid) return 'http://localhost:9000' + path;
    const match = cid.match(/_(\d+)$/);
    const port = match ? 9000 + parseInt(match[1], 10) : 9000;
    return `http://localhost:${port}${path}`;
  },
  isLoggedIn() {
    const c = this.getClaims();
    return c && c.exp > Date.now()/1000;
  },
  logout() {
    localStorage.removeItem('ax_token');
    localStorage.removeItem('ax_user');
    window.location.href = '/college/index.html';
  },
  requireAuth() {
    if (!this.isLoggedIn()) { window.location.href = '/college/index.html'; return false; }
    return true;
  }
};

// ─── API ──────────────────────────────────────────────────────────────────────
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
  get: (path) => API.call('GET', path),
  post: (path, body) => API.call('POST', path, body),
  put: (path, body) => API.call('PUT', path, body),
  del: (path, body) => API.call('DELETE', path, body),
};

// ─── Crypto helpers (for signing issuance requests) ──────────────────────────
// The college admin portal calls the connector to get live data and signature.
// For the demo, we use the connector's /verify endpoint directly.

// ─── Toast ────────────────────────────────────────────────────────────────────
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
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(120%)'; t.style.transition = '0.3s'; setTimeout(() => t.remove(), 300); }, duration);
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function showModal(opts) {
  // opts: { title, body, confirmText, confirmClass, onConfirm }
  let overlay = document.getElementById('modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'modal-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal">
        <div class="modal-title" id="modal-title"></div>
        <div class="modal-body" id="modal-body"></div>
        <div class="modal-actions" id="modal-actions"></div>
      </div>`;
    document.body.appendChild(overlay);
  }

  document.getElementById('modal-title').textContent = opts.title;
  document.getElementById('modal-body').innerHTML = opts.body;

  const actions = document.getElementById('modal-actions');
  actions.innerHTML = `
    <button class="btn btn-secondary" onclick="closeModal()">Cancel</button>
    <button class="btn ${opts.confirmClass || 'btn-danger'}" id="modal-confirm">${opts.confirmText || 'Confirm'}</button>`;
  document.getElementById('modal-confirm').onclick = () => { closeModal(); opts.onConfirm(); };

  overlay.classList.add('open');
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.classList.remove('open');
}

// ─── Sidebar navigation ───────────────────────────────────────────────────────
function initNav(activeId) {
  const claims = Auth.getClaims();
  if (!claims) return;

  // Set user info
  const nameEl = document.getElementById('user-name');
  const roleEl = document.getElementById('user-role');
  const avatarEl = document.getElementById('user-avatar');
  if (nameEl) nameEl.textContent = claims.email?.split('@')[0]?.toUpperCase() || 'USER';
  if (roleEl) roleEl.textContent = claims.role?.replace('_', ' ') || '';
  if (avatarEl) avatarEl.textContent = (claims.email?.[0] || 'U').toUpperCase();

  // Highlight active nav item
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.id === activeId);
  });

  // Check connector status
  checkConnectorStatus();
}

async function checkConnectorStatus() {
  const statusEl = document.getElementById('connector-status');
  if (!statusEl) return;
  try {
    const data = await API.get('/connector/health');
    if (data && (data.status === 'ok' || data.college_id)) {
      statusEl.className = 'connector-status live';
      statusEl.innerHTML = '<div class="pulse-dot"></div> Live ERP';
    } else throw new Error();
  } catch {
    statusEl.className = 'connector-status mock';
    statusEl.innerHTML = '<div class="pulse-dot"></div> Mock ERP';
  }
}

// ─── Format helpers ───────────────────────────────────────────────────────────
function formatDate(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function formatDateShort(isoStr) {
  if (!isoStr) return '—';
  return new Date(isoStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function statusBadge(status) {
  const map = {
    active:     '<span class="badge badge-active">● Active</span>',
    revoked:    '<span class="badge badge-revoked">✕ Revoked</span>',
    superseded: '<span class="badge badge-pending">↩ Superseded</span>',
    corrected:  '<span class="badge badge-alumni">✎ Corrected</span>',
    alumni:     '<span class="badge badge-alumni">Alumni</span>',
    inactive:   '<span class="badge badge-revoked">Inactive</span>',
  };
  return map[status] || `<span class="badge">${status}</span>`;
}

// ─── Role utilities ───────────────────────────────────────────────────────────
const Role = {
  isAdmin()    { return ['super_admin', 'college_admin'].includes(Auth.getClaims()?.role); },
  isSuperAdmin() { return Auth.getClaims()?.role === 'super_admin'; },
  isOperator() { return Auth.getClaims()?.role === 'issuer_operator'; },
  canManagePolicy() { return this.isAdmin(); },
  canRotateKeys()   { return this.isAdmin(); },
};

// ─── Sidebar HTML template ─────────────────────────────────────────────────────
function renderSidebar(activeId) {
  return `
  <aside class="sidebar">
    <div class="sidebar-logo">
      <div class="logo-mark">AX</div>
      <h1>AuthenX</h1>
      <p>College Admin Portal</p>
    </div>
    <nav class="sidebar-nav">
      <div class="nav-section-label">Main</div>
      <a class="nav-item" data-id="dashboard" href="/college/dashboard.html">
        <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v3a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10-3a1 1 0 011-1h4a1 1 0 011 1v7a1 1 0 01-1 1h-4a1 1 0 01-1-1v-7z"/></svg>
        Dashboard
      </a>
      <a class="nav-item" data-id="students" href="/college/students.html">
        <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        Students
      </a>
      <div class="nav-section-label" style="margin-top:8px">Credentials</div>
      <a class="nav-item" data-id="issue" href="/college/issue.html">
        <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v3m0 0v3m0-3h3m-3 0H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
        Issue Credential
      </a>
      <a class="nav-item" data-id="tokens" href="/college/tokens.html">
        <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
        Manage Tokens
      </a>
      <div class="nav-section-label" style="margin-top:8px">Infrastructure</div>
      <a class="nav-item" data-id="connector" href="/college/connector-management.html">
        <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M12 5l7 7-7 7"/></svg>
        Connector
      </a>
      <a class="nav-item" data-id="disclosure" href="/college/disclosure-policy.html">
        <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.477 0 8.268 2.943 9.542 7-1.274 4.057-5.065 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
        Disclosure Policy
      </a>
      <div class="nav-section-label" style="margin-top:8px">Reports</div>
      <a class="nav-item" data-id="audit" href="/college/audit.html">
        <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/></svg>
        Audit Log
      </a>
      <a class="nav-item" data-id="security" href="/college/security.html">
        <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
        Security
      </a>
      <div class="nav-section-label" style="margin-top:8px">Settings</div>
      <a class="nav-item" data-id="onboarding" href="/college/onboarding.html">
        <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
        Onboarding / Setup
      </a>
    </nav>
    <div class="sidebar-footer">
      <div class="user-pill">
        <div class="user-avatar" id="user-avatar">?</div>
        <div class="user-info">
          <div class="user-name" id="user-name">Loading...</div>
          <div class="user-role" id="user-role"></div>
        </div>
        <button class="logout-btn" onclick="Auth.logout()" title="Logout">
          <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/></svg>
        </button>
      </div>
    </div>
  </aside>`;
}

// ─── Linear flow engine (wizard order + gating) ────────────────────────────────
// Source of truth for which page comes after which.
const Flow = (() => {
  const ORDER = [
    { id: 'index',      path: '/college/index.html' },
    { id: 'onboarding', path: '/college/onboarding.html' },
    { id: 'connector',  path: '/college/connector-management.html' },
    { id: 'disclosure', path: '/college/disclosure-policy.html' },
    { id: 'dashboard',  path: '/college/dashboard.html' },
    { id: 'students',   path: '/college/students.html' },
    { id: 'issue',      path: '/college/issue.html' },
    { id: 'codeIssued', path: '/college/code-issued.html' },
    { id: 'tokens',     path: '/college/tokens.html' },
    { id: 'audit',      path: '/college/audit.html' },
    { id: 'security',   path: '/college/security.html' },
  ];

  function indexById(id) {
    return ORDER.findIndex(p => p.id === id);
  }
  function indexByPath(pathname) {
    return ORDER.findIndex(p => p.path === pathname);
  }
  function getCurrent() {
    const idx = indexByPath(window.location.pathname);
    return idx >= 0 ? ORDER[idx] : null;
  }
  function getNext(idOrPathname = null) {
    const idx = idOrPathname
      ? (idOrPathname.startsWith('/') ? indexByPath(idOrPathname) : indexById(idOrPathname))
      : indexByPath(window.location.pathname);
    return idx >= 0 ? (ORDER[idx + 1] || null) : null;
  }
  function getPrev(idOrPathname = null) {
    const idx = idOrPathname
      ? (idOrPathname.startsWith('/') ? indexByPath(idOrPathname) : indexById(idOrPathname))
      : indexByPath(window.location.pathname);
    return idx > 0 ? ORDER[idx - 1] : null;
  }

  function isOnboarded() {
    return localStorage.getItem('ax_onboarded') === '1';
  }

  /**
   * Guard navigation to enforce linear flow.
   * - Requires auth for all pages except index.
   * - Forces onboarding until completed.
   *
   * This is intentionally client-side only; backend enforcement is added later
   * via persisted onboarding state.
   */
  function guard(activeId) {
    const current = getCurrent();
    const onIndex = window.location.pathname === '/college/index.html';

    if (!onIndex) {
      if (!Auth.isLoggedIn()) {
        window.location.href = '/college/index.html';
        return false;
      }
      if (!isOnboarded()) {
        // Allow onboarding itself; otherwise force it.
        if (window.location.pathname !== '/college/onboarding.html') {
          window.location.href = '/college/onboarding.html';
          return false;
        }
      }
    } else {
      // If already authenticated, skip to dashboard if onboarded, else onboarding.
      if (Auth.isLoggedIn()) {
        window.location.href = isOnboarded() ? '/college/dashboard.html' : '/college/onboarding.html';
        return false;
      }
    }

    return true;
  }

  function goNext() {
    const next = getNext();
    if (next) window.location.href = next.path;
  }
  function goPrev() {
    const prev = getPrev();
    if (prev) window.location.href = prev.path;
  }

  async function syncOnboarding() {
    try {
      const cfg = await API.get('/connector-config');
      localStorage.setItem('ax_onboarded', cfg.onboarding_completed ? '1' : '0');
      if (cfg?.college?.connector_url) localStorage.setItem('ax_connector_url', cfg.college.connector_url);
      if (cfg?.college?.name) {
        const u = JSON.parse(localStorage.getItem('ax_user') || '{}');
        u.college_name = cfg.college.name;
        localStorage.setItem('ax_user', JSON.stringify(u));
      }
      return cfg;
    } catch {
      return null;
    }
  }

  return { ORDER, getCurrent, getNext, getPrev, guard, goNext, goPrev, isOnboarded, syncOnboarding };
})();
