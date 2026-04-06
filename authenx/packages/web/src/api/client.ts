/**
 * AuthenX Web — API Client
 *
 * Axios instance pre-configured for the AuthenX API.
 * Automatically attaches the JWT token from localStorage to every request.
 */

import axios from 'axios';

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001';

export const api = axios.create({
  baseURL: `${API_BASE}/v1`,
  headers: { 'Content-Type': 'application/json' },
  timeout: 15_000,
});

// Attach JWT to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('authenx_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle 401 globally — redirect to login
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('authenx_token');
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// ─── Auth API calls ───────────────────────────────────────────────────────────

export const authApi = {
  login: (email: string, password: string) =>
    api.post<{ token: string; user: AuthenXUser }>('/auth/login', { email, password }),

  me: () =>
    api.get<{ user: AuthenXUser }>('/auth/me'),
};

// ─── Verification API calls ───────────────────────────────────────────────────

export const verifyApi = {
  decodeCode: (authenxCode: string) =>
    api.post('/verify/code', { authenx_code: authenxCode }),

  liveVerify: (tokenId: string) =>
    api.post('/verify/live', { token_id: tokenId }),
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AuthenXUser {
  id: string;
  email: string;
  full_name: string;
  role: string;
  entity_id?: string;
}

export interface VerificationResult {
  result: 'verified' | 'revoked' | 'mismatch' | 'unavailable' | 'code_valid';
  message?: string;
  college?: string;
  credential_type?: string;
  verified_at?: string;
  latency_ms?: number;
  candidate?: {
    name?: string;
    degree?: string;
    branch?: string;
    graduation_year?: string;
    cgpa?: string;
  };
  signatures?: {
    live_verification: string;
    issuer: string;
    source: string;
  };
}
