#!/usr/bin/env bash
# AuthenX Demo Startup Script
# Starts both the AuthenX server and the IIT Bombay connector

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_DIR="$SCRIPT_DIR/authenx-node/authenx-node"
CONNECTOR_DIR="$SCRIPT_DIR/authenx-connector"

echo ""
echo "════════════════════════════════════════════════════"
echo "  AuthenX — Academic Credential Verification"
echo "════════════════════════════════════════════════════"
echo ""

# Check node version
NODE_VER=$(node --version 2>/dev/null || echo "not found")
echo "  Node.js: $NODE_VER"
if [[ "$NODE_VER" != v2* ]]; then
  echo "  ⚠ Warning: Node.js v22+ recommended for node:sqlite"
fi

echo ""
echo "  Starting services..."
echo ""

# Kill any existing instances
pkill -f "authenx-node.*server.js" 2>/dev/null && sleep 0.5 || true
pkill -f "connector.js" 2>/dev/null && sleep 0.5 || true

# Start AuthenX server
cd "$SERVER_DIR"
node src/server.js > /tmp/authenx-server.log 2>&1 &
SERVER_PID=$!
echo "  ✓ AuthenX Server started (PID $SERVER_PID)"
echo "    Logs: tail -f /tmp/authenx-server.log"

# Wait for server to start
sleep 2

# Start Connector
cd "$CONNECTOR_DIR"
if [ ! -f ".env" ]; then
  echo ""
  echo "  ⚠ Connector .env not found — run connector-setup.js first:"
  echo "    cd authenx-connector && node connector-setup.js"
  echo ""
else
  node connector.js > /tmp/authenx-connector.log 2>&1 &
  CONNECTOR_PID=$!
  echo "  ✓ IIT Bombay Connector started (PID $CONNECTOR_PID)"
  echo "    Logs: tail -f /tmp/authenx-connector.log"
fi

echo ""
echo "════════════════════════════════════════════════════"
echo ""
echo "  DEMO PORTALS"
echo "  ────────────"
echo "  College Admin   → ui/college/index.html"
echo "  Employer Portal → ui/employer/index.html"
echo ""
echo "  DEMO ACCOUNTS"
echo "  ─────────────"
echo "  IIT Bombay Admin  : iitb@authenx.in / College@123"
echo "  Employer (Admin)  : admin@authenx.in / Admin@123"
echo ""
echo "  API SERVER      → http://localhost:3000"
echo "  CONNECTOR       → http://localhost:9000"
echo ""
echo "  DEMO FLOW"
echo "  ─────────"
echo "  1. Open College Portal → Login as IIT Bombay"
echo "  2. Issue Credential → stu_ref_001 (SUPREETH K)"
echo "  3. Copy the AX1. code"
echo "  4. Open Employer Portal → Login"
echo "  5. Paste code → Verify → See LIVE VERIFIED ✓"
echo ""
echo "  TEST STUDENTS"
echo "  ─────────────"
echo "  stu_ref_001 → SUPREETH K (active) — IIT Bombay"
echo "  stu_ref_002 → PRIYA SHARMA (active) — IIT Bombay"
echo "  stu_ref_003 → RAHUL NAIR (for revocation demo)"
echo ""
echo "════════════════════════════════════════════════════"
echo ""
echo "  Press Ctrl+C to stop all services"
echo ""

# Wait for background processes
wait
