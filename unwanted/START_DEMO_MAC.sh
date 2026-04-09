#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
#  AuthenX — One-Click Demo Startup for Mac (v2 — Universal)
#  Usage: Open Terminal, cd to AUTHENX-MAIN, then run:
#         chmod +x START_DEMO_MAC.sh && ./START_DEMO_MAC.sh
# ══════════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/authenx-node/authenx-node"
CONNECTOR_DIR="$SCRIPT_DIR/authenx-connector"
HSM_DIR="$SCRIPT_DIR/authenx-hsm"
LEDGER_DIR="$SCRIPT_DIR/authenx-ledger"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║       AuthenX — Academic Credential Verification            ║"
echo "║       Universal Demo Startup (v2)                           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── Check Node version ──────────────────────────────────────────
NODE_VER=$(node --version 2>/dev/null || echo "NOT FOUND")
echo "  Node.js: $NODE_VER"
if [[ "$NODE_VER" == "NOT FOUND" ]]; then
  echo ""
  echo "  ERROR: Node.js is not installed!"
  echo "  Install it from https://nodejs.org (download v22 LTS)"
  exit 1
fi

# ── Run first-time setup if connector.db is missing or empty ────
if [ ! -s "$CONNECTOR_DIR/connector.db" ]; then
  echo "  Running first-time setup (creating student database)..."
  cd "$CONNECTOR_DIR"
  node connector-setup.js
  echo "  ✅ Setup complete!"
  echo ""
fi

# ── Clear ports ─────────────────────────────────────────────────
echo "  Clearing ports 3000, 9000, 9002, 8080..."
for port in 3000 9000 9002 8080; do
  lsof -ti:$port | xargs kill -9 2>/dev/null || true
done
sleep 1

# ── Start HSM (Port 9002) ────────────────────────────────────────
if [ -f "$HSM_DIR/server.js" ]; then
  echo "  Starting HSM service (port 9002)..."
  cd "$HSM_DIR"
  node server.js > "$HSM_DIR/hsm.log" 2>&1 &
  sleep 1
  if curl -s -X POST http://localhost:9002/sign -H "Content-Type:application/json" -d '{"payload":"test"}' > /dev/null 2>&1; then
    echo "  ✅ HSM Service      → port 9002"
  else
    echo "  ⚠️  HSM not responding — signatures may fall back to inline"
  fi
fi

# ── Start Universal Connector (Port 9000) ────────────────────────
echo "  Starting Universal Connector (port 9000)..."
cd "$CONNECTOR_DIR"
# Use universal-connector.js if college-config.json or .env exists, else legacy
if [ -f "universal-connector.js" ] && [ -f ".env" ]; then
  node universal-connector.js > "$CONNECTOR_DIR/connector.log" 2>&1 &
else
  node connector.js > "$CONNECTOR_DIR/connector.log" 2>&1 &
fi
sleep 2

if curl -s http://localhost:9000/health > /dev/null 2>&1; then
  echo "  ✅ Connector        → http://localhost:9000"
else
  echo "  ⚠️  Connector not reachable — demo will use built-in mock"
fi

# ── Start Ledger (Port 8080, optional) ──────────────────────────
if [ -f "$LEDGER_DIR/server.js" ]; then
  echo "  Starting Ledger service (port 8080)..."
  cd "$LEDGER_DIR"
  node server.js > "$LEDGER_DIR/ledger.log" 2>&1 &
  sleep 1
  echo "  ✅ Ledger           → port 8080"
fi

# ── Start AuthenX Server (Port 3000) ────────────────────────────
echo "  Starting AuthenX Server (port 3000)..."
cd "$SERVER_DIR"
node src/server.js > "$SERVER_DIR/server.log" 2>&1 &
sleep 4

if curl -s http://localhost:3000/health > /dev/null 2>&1; then
  echo "  ✅ AuthenX Server   → http://localhost:3000"
else
  echo "  ❌ Server failed! Check: tail -f $SERVER_DIR/server.log"
  exit 1
fi

# ── Print Demo Guide ─────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                   AUTHENX IS READY!  🚀                     ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  PORTALS:                                                    ║"
echo "║  College Admin  → ui/college/index.html                      ║"
echo "║  Employer       → ui/employer/index.html                     ║"
echo "║  Admin/Onboard  → ui/admin/onboarding.html                   ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  DEMO ACCOUNTS                                               ║"
echo "║  College Admin : iitb@authenx.in   / College@123            ║"
echo "║  Employer      : admin@authenx.in  / Admin@123              ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  QUICK DEMO FLOW:                                            ║"
echo "║  1. College Portal → Login → Issue → stu_ref_001            ║"
echo "║  2. Copy AX1. code                                           ║"
echo "║  3. Employer Portal → Login → Paste code → VERIFIED ✅       ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  ONBOARD A NEW COLLEGE:                                      ║"
echo "║  → ui/admin/onboarding.html (5-step wizard)                  ║"
echo "║  Supports: SQLite · MySQL · PostgreSQL · MSSQL · REST API   ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ── Open browser automatically ──────────────────────────────────
if command -v open &> /dev/null; then
  echo "  Opening portals in browser..."
  sleep 1
  open "file://$SCRIPT_DIR/ui/college/index.html"
  sleep 0.5
  open "file://$SCRIPT_DIR/ui/employer/index.html"
  echo "  ✅ Portals opened in browser!"
fi

echo ""
echo "  Logs: tail -f $SERVER_DIR/server.log"
echo "        tail -f $CONNECTOR_DIR/connector.log"
echo ""
echo "  Press Ctrl+C to stop all services"
echo ""

wait
