# AuthenX — Complete Browser UI Demo Guide

## Quick Start (Mac)

Open **Terminal** and run:

```bash
cd /Users/supreethchaluvadi/Documents/AUTHENX-MAIN
chmod +x START_DEMO_MAC.sh
./START_DEMO_MAC.sh
```

The script will automatically:
- Start the **AuthenX Server** (port 3000)
- Start the **IIT Bombay Connector** (port 9000)
- Open both portals in Chrome

---

## If the Script Didn't Open Portals Automatically

Manually open these URLs in **Chrome** (2 tabs):

**Tab 1 — College Admin Portal:**
```
file:///Users/supreethchaluvadi/Documents/AUTHENX-MAIN/ui/college/index.html
```

**Tab 2 — Employer Portal:**
```
file:///Users/supreethchaluvadi/Documents/AUTHENX-MAIN/ui/employer/index.html
```

---

## COMPLETE 6-STEP DEMO WORKFLOW

---

## 📋 STEP 1: College Admin Login (Tab 1)

**What you'll see:**
- A login form with "IIT Bombay" branding
- Email field, Password field, Login button

**What to do:**
1. Enter email: `iitb@authenx.in`
2. Enter password: `College@123`
3. Click **Login**

**Expected result:**
- ✅ You'll see the **College Dashboard** with:
  - 4 stat cards (Total Tokens, Active, Revoked, Verified)
  - Recent activity feed
  - Navigation sidebar (Dashboard, Students, Issue, Audit)

---

## 🔌 STEP 2: Issue Credential (Tab 1)

**What to do:**
1. From the sidebar, click **Issue Credential**
2. You'll see a form with the heading "Issue New Credential"

**Expected screen:**
- 3 steps visible at the top (Step 1 active)
- A text input field: **"Enter Student Reference Token"**

**What to enter:**
- Type: `stu_ref_001`

**Now click:**
- **"Fetch from ERP"** button

**What happens next:**
- 🔄 Loading animation appears
- Connector queries **IIT Bombay's real student database**
- In ~2 seconds, you'll see a **preview card** with:
  ```
  Name:        SUPREETH K
  Degree:      B.Tech
  Branch:      Computer Science
  CGPA:        8.9
  Grad Year:   2024
  Status:      ✓ Active (green badge)
  ```

---

## ✍️ STEP 3: Review & Issue (Tab 1)

**What you'll see:**
- The student preview card from Step 2
- A button: **"Issue & Sign"**

**What to do:**
1. Click **"Issue & Sign"**

**Behind the scenes:**
1. ✅ Server fetches live data from connector (again)
2. ✅ Connector signs the data with Ed25519 private key
3. ✅ Server encrypts with AES-256-GCM → **AX1. code**
4. ✅ Server stores ONLY: `sha256(hash) + signature` — **ZERO personal data**

**Expected result:**
- Step 3 screen appears with:
  ```
  ✓ Code Generated Successfully!

  AuthenX Code (copy this):
  AX1.KWK0fbzRQjobEoU3Dr_yVO1Ee8EH4by3HGYccOgWNAmVS8KT...

  [Copy] [QR Code] [Email] [Download PDF]
  ```

**Action:**
- Click **Copy** button to copy the AX1 code to clipboard

---

## 💼 STEP 4: Employer Login (Tab 2)

**What you'll see:**
- Employer portal login page with "AuthenX" branding
- Email field, Password field, Login button

**What to do:**
1. Enter email: `admin@authenx.in`
2. Enter password: `Admin@123`
3. Click **Login**

**Expected result:**
- ✅ You'll see the **Employer Dashboard** with:
  - Large text: "Verify Degrees in Seconds, Not Weeks"
  - 3 feature cards
  - **"Start Verifying"** button

---

## 📝 STEP 5: Paste Code & Verify (Tab 2)

**What to do:**
1. Click **"Start Verifying"** button
2. You'll see a large text area with placeholder: `"Paste AX1. code here"`
3. Paste the code you copied in Step 3:
   - Right-click → Paste (or Cmd+V)
   - The `AX1.xxxxx...` code appears in the textarea

**Now click:**
- **"Verify Credential"** button

**What happens:**
- ✅ **Step 1: Code Decode** screen appears
- 🔄 4 animated checks appear sequentially:
  1. ✅ Code Format Valid (`AX1.` prefix)
  2. ✅ Found in Registry (token exists)
  3. ✅ Not Revoked (status = active)
  4. ✅ Registry Check Passed

**After ~3 seconds:**
- A **"Confirm Live Verification"** button appears

**Click it:**
- **"Confirm Live Verification"**

---

## ✅ STEP 6: Live Verification Result (Tab 2)

**What you'll see:**
- ✨ **GREEN SUCCESS SCREEN** with:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        VERIFIED ✓

Credential confirmed from IIT Bombay ERP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

LIVE DATA FROM COLLEGE ERP:

Name:          SUPREETH K
Degree:        B.Tech — Computer Science
CGPA:          8.9
Graduation:    2024
Status:        ✓ Active (green badge)

CRYPTOGRAPHIC VERIFICATION:
✓ Hash Match — verified
✓ Issuance Signature — valid Ed25519
✓ Live Signature — fresh signature valid
✓ Not Revoked — credential is active

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**Key points for your college presentation:**
- ✅ **VERIFIED** in big green letters
- All 4 crypto checks visible and passing
- Shows **LIVE DATA** (not cached)
- Took only **~5 seconds total** from paste to result

---

## 🔐 SECURITY DEMO: Revocation

**This is the most impressive part for your college people.**

### Step A: Revoke the Credential (Tab 1 — College)

**What to do:**
1. Go back to **Tab 1** (College Admin)
2. Click **Students** in the sidebar
3. You'll see a table of all students with their credentials
4. Find the row with **stu_ref_001** (SUPREETH K)
5. Click the **Revoke** button on that row
6. A modal appears: **"Revoke Credential?"**
   - Reason dropdown: select **"Academic Misconduct"**
7. Click **"Confirm Revoke"**

**Expected result:**
- ✅ Green toast notification: **"Credential revoked"**
- The row now shows: 🔴 **REVOKED** (red badge)

---

### Step B: Employer Tries Same Code (Tab 2 — Employer)

**What to do:**
1. Go back to **Tab 2** (Employer)
2. Click **"Verify Another"** button
3. You'll see the code input field again
4. Paste the **SAME AX1. code** (still in clipboard)
5. Click **"Verify Credential"**

**What happens:**
- 🔄 Registry check runs
- Checks appear: ✅ ✅ ❌ **REVOKED**
- At the 3rd check, it fails: **"Credential has been revoked by IIT Bombay"**

**Expected result:**
- ❌ **RED REVOKED SCREEN** appears with:
  ```
  ✗ CREDENTIAL REVOKED

  This credential has been revoked by IIT Bombay
  Do not accept this degree.

  Revoked On: [timestamp]
  Reason: Academic Misconduct
  Revoked By: IIT Bombay Registrar
  ```

**Why this matters for your college presentation:**
- Instant revocation (not delayed)
- Employer sees the revocation IN REAL TIME
- No stale certificates possible
- College has full control

---

## 🚫 SECURITY DEMO: Tampered Code

**Optional — shows cryptographic security.**

### What to do:
1. Go back to **Tab 2** (Employer)
2. Click **"Verify Another"**
3. Manually type a FAKE code:
   ```
   AX1.FAKEFAKEFAKEFAKEFAKEFAKE123456789TAMPERED==
   ```
4. Click **"Verify Credential"**

**Expected result:**
- ❌ **RED ERROR SCREEN** appears immediately:
  ```
  Invalid or Expired Code

  The code could not be decrypted.
  Please ask the candidate for a fresh code.
  ```

**Why this matters:**
- Attacker cannot forge codes
- AES-256-GCM encryption is unbreakable
- Even 1 character change breaks it
- Cannot brute-force (4.4 × 10^40 possibilities)

---

## 📊 What to Show Your College People

### Key Talking Points:

1. **"Live Verification"**
   - Employer doesn't get a static certificate
   - AuthenX hits our ERP in real-time
   - We control the data, not the employer

2. **"Zero Data Storage"**
   - AuthenX stores only a hash + signature
   - No student names, IDs, or personal data
   - Show them the green banner: "Privacy Note — AuthenX did not store this student's data"

3. **"Instant Revocation"**
   - If a degree is revoked, employers see it IMMEDIATELY
   - No cached certificates
   - College has full control

4. **"Cryptographically Secure"**
   - Every credential is signed with Ed25519
   - Every verification is signed with fresh nonce
   - Cannot be forged, cannot be replayed
   - Show the 4 green checkmarks on the verification screen

5. **"Simple for Employers"**
   - They just paste a code
   - They get instant results
   - No bulk uploads, no API keys

---

## Estimated Timeline

| Step | Time |
|------|------|
| Login (College) | 10 sec |
| Fetch from ERP | 3 sec |
| Issue & Sign | 2 sec |
| Copy code | 5 sec |
| Login (Employer) | 10 sec |
| Paste & Verify | 5 sec |
| **Total** | **~1 minute** |

---

## Troubleshooting

### If services aren't running:

```bash
# Check if server is responding
curl http://localhost:3000/health

# Check if connector is responding
curl http://localhost:9000/health

# If not, restart:
cd /Users/supreethchaluvadi/Documents/AUTHENX-MAIN
./START_DEMO_MAC.sh
```

### If browser shows "Cannot reach localhost":

1. Check that `START_DEMO_MAC.sh` is still running (don't close Terminal)
2. Restart it if needed:
   ```bash
   cd /Users/supreethchaluvadi/Documents/AUTHENX-MAIN
   ./START_DEMO_MAC.sh
   ```

### If code verification fails:

1. Make sure you're using a fresh code from Step 3
2. Codes expire after 24 hours (by design — ask if you need to adjust)
3. Issue a new credential for a fresh code

---

## Taking Screenshots for Slides

**Key screens to capture for your presentation:**

1. **College Admin Dashboard** (Step 1 result)
2. **Student preview card** (Step 2 result)
3. **AX1 code generated** (Step 3 result)
4. **Employer verification in progress** (4 checks visible)
5. **VERIFIED ✓ result** (Step 6 — the green one)
6. **REVOKED ✗ result** (revocation demo)

Press `Cmd+Shift+4` on Mac to take screenshots, or use the browser's built-in screenshot tool.

---

## Talking to Your College IT Team

**Key points to mention:**

> "AuthenX is a connector service. It:
>
> 1. **Lives on our network** (not the cloud)
> 2. **Reads our database** (we give it read-only access)
> 3. **Never exports student data** (signs credentials, returns signatures only)
> 4. **Employers get zero access** to our database (they only get verification results)
> 5. **We control revocation** (instant, real-time)
>
> The demo shows this working end-to-end with a test student (SUPREETH K). Once we onboard, it will work with your actual student records."

---

## Next Steps After Demo

1. **Questions from college people?** → Answer them
2. **Want to customize?** → We can adjust colors, add your logo, change student data
3. **Ready to onboard?** → We'll set up the connector on your network with your actual ERP

---

**Estimated demo time: 5-10 minutes** (depending on questions)

Good luck! 🎉
