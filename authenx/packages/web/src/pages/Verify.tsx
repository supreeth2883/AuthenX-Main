/**
 * AuthenX Web — Employer Verification Page
 *
 * The main page employers use to verify candidate credentials.
 * Flow: Enter AuthenX Code → Decode → Run Live Verification → See Result
 */

import { useState } from 'react';
import { verifyApi, type VerificationResult } from '../api/client';

type Step = 'input' | 'decoded' | 'verifying' | 'result';

export function VerifyPage() {
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>('input');
  const [decodedInfo, setDecodedInfo] = useState<Record<string, string> | null>(null);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const [error, setError] = useState('');

  // ── Step 1: Decode the AuthenX Code ────────────────────────────────────────
  async function handleDecodeCode() {
    setError('');
    try {
      const { data } = await verifyApi.decodeCode(code.trim());

      if (data.result === 'revoked') {
        setResult(data);
        setStep('result');
        return;
      }

      setDecodedInfo({
        college: data.college,
        credential_type: data.credential_type,
        issued_at: data.issued_at,
      });
      setStep('decoded');
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'Invalid AuthenX Code');
    }
  }

  // ── Step 2: Run live connector verification ─────────────────────────────────
  async function handleLiveVerify() {
    setStep('verifying');
    setError('');
    try {
      const { data } = await verifyApi.liveVerify(code.trim());
      setResult(data);
      setStep('result');
    } catch (err: any) {
      setError(err.response?.data?.message ?? 'Verification failed');
      setStep('decoded');
    }
  }

  function reset() {
    setCode(''); setStep('input');
    setDecodedInfo(null); setResult(null); setError('');
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-blue-900">AuthenX Verification</h1>
          <p className="text-gray-600 mt-1">Live academic credential verification from the source</p>
        </div>

        {/* Step 1: Input */}
        {step === 'input' && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-800 mb-4">Enter AuthenX Code</h2>
            <p className="text-sm text-gray-500 mb-4">
              Ask the candidate to share their AuthenX Code. Paste it below.
            </p>
            <textarea
              className="w-full border border-gray-300 rounded-lg p-3 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              rows={4}
              placeholder="Paste AuthenX Code here..."
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            {error && <p className="text-red-600 text-sm mt-2">{error}</p>}
            <button
              onClick={handleDecodeCode}
              disabled={!code.trim()}
              className="mt-4 w-full bg-blue-700 text-white py-3 rounded-lg font-semibold hover:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Decode Code
            </button>
          </div>
        )}

        {/* Step 2: Decoded — confirm before live check */}
        {step === 'decoded' && decodedInfo && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-3 h-3 rounded-full bg-blue-500"></div>
              <h2 className="text-lg font-semibold text-gray-800">Code Decoded Successfully</h2>
            </div>
            <div className="bg-blue-50 rounded-lg p-4 mb-6 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Issuing College</span>
                <span className="font-medium text-gray-800">{decodedInfo.college}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Credential Type</span>
                <span className="font-medium text-gray-800">{decodedInfo.credential_type}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Issued</span>
                <span className="font-medium text-gray-800">
                  {new Date(decodedInfo.issued_at).toLocaleDateString()}
                </span>
              </div>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              Click below to run live verification against the college ERP.
              This confirms the credential is currently valid at the source.
            </p>
            {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
            <button
              onClick={handleLiveVerify}
              className="w-full bg-green-700 text-white py-3 rounded-lg font-semibold hover:bg-green-800"
            >
              Run Live Verification
            </button>
            <button onClick={reset} className="w-full mt-2 text-gray-500 text-sm py-2 hover:text-gray-700">
              ← Start over
            </button>
          </div>
        )}

        {/* Step 3: Verifying spinner */}
        {step === 'verifying' && (
          <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-12 text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-4 border-blue-700 mx-auto mb-4"></div>
            <p className="text-gray-700 font-medium">Verifying with college ERP...</p>
            <p className="text-gray-400 text-sm mt-1">Connecting to live source. This takes 1-3 seconds.</p>
          </div>
        )}

        {/* Step 4: Result */}
        {step === 'result' && result && (
          <div className="space-y-4">
            {/* Result badge */}
            <div className={`rounded-xl p-6 ${
              result.result === 'verified' ? 'bg-green-50 border border-green-200' :
              result.result === 'revoked' ? 'bg-red-50 border border-red-200' :
              'bg-orange-50 border border-orange-200'
            }`}>
              <div className="flex items-center gap-3 mb-4">
                <div className={`text-2xl ${
                  result.result === 'verified' ? 'text-green-600' :
                  result.result === 'revoked' ? 'text-red-600' : 'text-orange-600'
                }`}>
                  {result.result === 'verified' ? '✓' : result.result === 'revoked' ? '✗' : '⚠'}
                </div>
                <div>
                  <div className={`font-bold text-xl ${
                    result.result === 'verified' ? 'text-green-800' :
                    result.result === 'revoked' ? 'text-red-800' : 'text-orange-800'
                  }`}>
                    {result.result === 'verified' ? 'CREDENTIAL VERIFIED' :
                     result.result === 'revoked' ? 'CREDENTIAL REVOKED' :
                     result.result.toUpperCase()}
                  </div>
                  {result.college && <div className="text-sm text-gray-600">Issuer: {result.college}</div>}
                </div>
              </div>

              {/* Verified candidate fields */}
              {result.result === 'verified' && result.candidate && (
                <div className="bg-white rounded-lg p-4 space-y-2 mt-4">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
                    Live Verified Fields — from {result.college}
                  </p>
                  {Object.entries(result.candidate).map(([key, value]) => (
                    <div key={key} className="flex justify-between text-sm">
                      <span className="text-gray-500 capitalize">{key.replace('_', ' ')}</span>
                      <span className="font-semibold text-gray-800">{String(value)}</span>
                    </div>
                  ))}
                  <div className="border-t border-gray-100 pt-2 mt-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-gray-400">Verification source</span>
                      <span className="text-green-700 font-medium">Live ERP  ✓</span>
                    </div>
                    <div className="flex justify-between text-xs mt-1">
                      <span className="text-gray-400">Issuance signature</span>
                      <span className="text-green-700 font-medium">VALID  ✓</span>
                    </div>
                    <div className="flex justify-between text-xs mt-1">
                      <span className="text-gray-400">Live verification signature</span>
                      <span className="text-green-700 font-medium">VALID  ✓</span>
                    </div>
                    {result.latency_ms && (
                      <div className="flex justify-between text-xs mt-1">
                        <span className="text-gray-400">Verified in</span>
                        <span className="text-gray-600">{result.latency_ms}ms</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {result.message && (
                <p className="text-sm text-gray-600 mt-3">{result.message}</p>
              )}
            </div>

            <button
              onClick={reset}
              className="w-full bg-blue-700 text-white py-3 rounded-lg font-semibold hover:bg-blue-800"
            >
              Verify Another Candidate
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
