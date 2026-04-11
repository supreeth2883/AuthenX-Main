/**
 * AuthenX Employer Verification Portal — Shared JS
 *
 * API base is resolved at runtime by probing candidates in order.
 * The resolved base is cached for the lifetime of the page.
 */

// ── Resilient API base resolution ─────────────────────────────────────────────
// Priority order for finding the live backend:
//   1. Same origin as the current page (works when UI is served by the backend)
//   2. localhost variants on common dev ports
// Result is cached after the first successful probe.
function _buildCandidates() {
  const same = (typeof window !== 'undefined' && window.location?.origin)
    ? [window.location.origin + '/v1']
    : [];
  return [
    ...same,
    'http://localhost:3001/v1',
    'http://localhost:3002/v1',
    'http://localhost:3000/v1',
    'http://localhost:3011/v1',
    'http://localhost:3100/v1',
    'http://localhost:3200/v1',
    'http://localhost:3300/v1',
    'http://127.0.0.1:3001/v1',
    'http://127.0.0.1:3002/v1',
    'http://127.0.0.1:3000/v1',
    'http://127.0.0.1:3011/v1',
    'http://127.0.0.1:3100/v1',
    'http://127.0.0.1:3200/v1',
    'http://127.0.0.1:3300/v1',
  ].filter((v, i, a) => a.indexOf(v) === i); // deduplicate
}

let _resolvedApiBase = null;
const _badApiBases = new Set();

async function _isAuthenxBackend(base) {
  try {
    const detailed = await fetch(`${base}/health/detailed`, { signal: AbortSignal.timeout(2000) });
    if (!detailed.ok) return false;
    const payload = await detailed.json();
    return payload?.status === 'ok' && !!payload?.db && !!payload?.security;
  } catch {
    return false;
  }
}

async function resolveApiBase(forceRefresh = false) {
  if (!forceRefresh && _resolvedApiBase) return _resolvedApiBase;
  for (const base of _buildCandidates()) {
    if (_badApiBases.has(base)) continue;
    if (await _isAuthenxBackend(base)) {
      _resolvedApiBase = base;
      return _resolvedApiBase;
    }
  }
  // Silent fallback — the actual API call will surface the error
  const firstAvailable = _buildCandidates().find((b) => !_badApiBases.has(b));
  _resolvedApiBase = firstAvailable || _buildCandidates()[0];
  return _resolvedApiBase;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────
const Auth = {
  getToken() { return localStorage.getItem('ax_emp_token'); },
  clearToken() { localStorage.removeItem('ax_emp_token'); },
  getClaims() {
    const t = this.getToken();
    if (!t) return null;
    try { return JSON.parse(atob(t.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))); }
    catch { return null; }
  },
  isEmployerClaims(c) {
    return !!c && c.exp > Date.now() / 1000 && c.role === 'employer';
  },
  isLoggedIn() { return this.isEmployerClaims(this.getClaims()); },
  logout() { this.clearToken(); window.location.href = 'index.html'; },
  requireAuth() {
    if (!this.isLoggedIn()) {
      this.clearToken();
      window.location.href = 'index.html';
      return false;
    }
    return true;
  },
};

// ── API client ────────────────────────────────────────────────────────────────
// All employer API calls go through here. Base URL is resolved once per page.
// Endpoints used by this portal:
//   POST /v1/auth/login        — employer login
//   POST /v1/verify/code       — decode AuthenX code against registry
//   POST /v1/verify/live       — live verification via college ERP connector
const API = {
  async call(method, path, body = null) {
    let lastError = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const base = await resolveApiBase(attempt > 0);
      const opts = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(Auth.getToken() ? { 'Authorization': `Bearer ${Auth.getToken()}` } : {})
        },
        signal: AbortSignal.timeout(15000)
      };
      if (body) opts.body = JSON.stringify(body);

      try {
        const res = await fetch(`${base}${path}`, opts);
        let data;
        try { data = await res.json(); } catch { data = {}; }

        if (!res.ok) {
          // If we hit a 404, this base is likely not the AuthenX backend.
          // Mark it bad and retry once against the next discovered candidate.
          if (res.status === 404 && attempt === 0) {
            _badApiBases.add(base);
            _resolvedApiBase = null;
            continue;
          }
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        return data;
      } catch (err) {
        lastError = err;
        if (attempt === 0) {
          _badApiBases.add(base);
          _resolvedApiBase = null;
          continue;
        }
      }
    }

    throw lastError || new Error('Unable to reach AuthenX backend');
  },
  get:  (path)       => API.call('GET',  path),
  post: (path, body) => API.call('POST', path, body),
};

// ── Toast notifications ───────────────────────────────────────────────────────
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
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ';
  const iconEl = document.createElement('span');
  iconEl.textContent = icon;
  t.appendChild(iconEl);
  t.appendChild(document.createTextNode(' ' + message));
  container.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateX(120%)';
    t.style.transition = '0.3s';
    setTimeout(() => t.remove(), 300);
  }, duration);
}

// ── Navbar renderer ───────────────────────────────────────────────────────────
function renderNavbar(active) {
  return `
  <nav class="top-nav">
    <a href="index.html" class="nav-logo">
      <div class="mark">AX</div>
      <div>
        <div class="nav-logo-text">AuthenX</div>
        <div class="nav-logo-sub">Employer Verification Portal</div>
      </div>
    </a>
    <div class="nav-actions">
      ${Auth.isLoggedIn()
        ? `<span style="font-size:13px;color:var(--ax-gray-500)">${Auth.getClaims()?.email||''}</span>
           <a href="verify.html" class="btn btn-primary btn-sm" style="padding:7px 14px">Verify a Code</a>
           <button class="btn btn-secondary" style="padding:7px 14px" onclick="Auth.logout()">Logout</button>`
        : `<a href="index.html" class="btn btn-primary" style="padding:7px 14px">Login to Verify →</a>`
      }
    </div>
  </nav>`;
}

// ── Stepper renderer ──────────────────────────────────────────────────────────
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
