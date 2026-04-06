# AuthenX Design System
## "Trust at First Sight" — Modern SaaS, Figma-Inspired

---

## Brand Identity

### Brand Voice
- **Professional** but not cold
- **Clear** but not plain
- **Secure** but not intimidating
- **Modern** — feels like Stripe, Linear, or Vercel

### Logo Mark
- "AX" monogram inside a shield-hex shape
- Color: White on Deep Navy
- Tagline: "Verified. Always."

---

## Color Palette

### Primary
```
--ax-navy:       #0F2044    (deep trust, primary brand)
--ax-blue:       #1D4ED8    (CTA, links, active states)
--ax-blue-light: #3B82F6    (hover states, highlights)
--ax-sky:        #EFF6FF    (backgrounds, subtle fills)
```

### Semantic
```
--ax-verified:   #059669    (green — verified status)
--ax-verified-bg:#ECFDF5    (light green bg)
--ax-revoked:    #DC2626    (red — revoked/error)
--ax-revoked-bg: #FEF2F2    (light red bg)
--ax-pending:    #D97706    (amber — pending/warning)
--ax-pending-bg: #FFFBEB    (light amber bg)
```

### Neutral
```
--ax-gray-50:    #F8FAFC
--ax-gray-100:   #F1F5F9
--ax-gray-200:   #E2E8F0
--ax-gray-400:   #94A3B8
--ax-gray-500:   #64748B
--ax-gray-600:   #475569
--ax-gray-700:   #334155
--ax-gray-800:   #1E293B
--ax-gray-900:   #0F172A
--ax-white:      #FFFFFF
```

### Gradients
```
--ax-gradient-hero:    linear-gradient(135deg, #0F2044 0%, #1D4ED8 100%)
--ax-gradient-card:    linear-gradient(135deg, #F8FAFC 0%, #EFF6FF 100%)
--ax-gradient-verified:linear-gradient(135deg, #ECFDF5 0%, #D1FAE5 100%)
```

---

## Typography

### Font Stack
```css
font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
```

### Scale
```
--text-xs:   11px / 1.4  (labels, metadata)
--text-sm:   13px / 1.5  (body small, table cells)
--text-base: 15px / 1.6  (body text)
--text-lg:   18px / 1.5  (section headings)
--text-xl:   22px / 1.4  (page titles)
--text-2xl:  28px / 1.3  (hero headings)
--text-3xl:  36px / 1.2  (landing hero)
--text-4xl:  48px / 1.1  (large display)
```

### Weights
```
Regular: 400 (body text)
Medium:  500 (labels, UI elements)
SemiBold:600 (headings, card titles)
Bold:    700 (page titles, key numbers)
```

---

## Spacing System (8px base grid)
```
4px  — tight (icon gaps)
8px  — xs (inline spacing)
12px — sm (compact padding)
16px — md (standard padding)
24px — lg (card padding)
32px — xl (section gaps)
48px — 2xl (large sections)
64px — 3xl (hero spacing)
```

---

## Component Library

### Buttons
```
Primary:   bg #1D4ED8, text white, hover #1E40AF, radius 8px, padding 10px 20px
Secondary: bg #F1F5F9, text #334155, hover #E2E8F0, radius 8px
Danger:    bg #DC2626, text white, hover #B91C1C
Ghost:     transparent, text #1D4ED8, hover bg #EFF6FF
```

### Cards
```
Background: white
Border:     1px solid #E2E8F0
Radius:     12px
Shadow:     0 1px 3px rgba(0,0,0,0.08), 0 4px 16px rgba(0,0,0,0.04)
Padding:    24px
```

### Badges
```
Verified:  bg #ECFDF5, text #065F46, border #A7F3D0, "● Verified"
Revoked:   bg #FEF2F2, text #991B1B, border #FECACA, "✕ Revoked"
Active:    bg #EFF6FF, text #1E40AF, border #BFDBFE, "● Active"
Pending:   bg #FFFBEB, text #92400E, border #FDE68A, "◌ Pending"
```

### Form Inputs
```
Border:       1px solid #E2E8F0
Border-focus: 1px solid #3B82F6 + 0 0 0 3px rgba(59,130,246,0.15)
Radius:       8px
Padding:      10px 14px
Font:         15px, color #1E293B
Placeholder:  color #94A3B8
```

### Tables
```
Header:      bg #F8FAFC, text #64748B, 11px uppercase
Row:         bg white, hover #F8FAFC
Border:      1px solid #F1F5F9 (between rows)
Cell padding: 14px 16px
```

### Navigation Sidebar
```
Width:       240px
Background:  #0F2044 (deep navy)
Active item: bg rgba(59,130,246,0.2), left border 3px solid #3B82F6
Hover item:  bg rgba(255,255,255,0.06)
Text:        #94A3B8 (inactive), white (active)
```

### Stat Cards
```
Corner accent:  3px left border in brand color
Value:          32px bold, #0F172A
Label:          11px uppercase, #94A3B8
Sub:            13px, #64748B
Hover:          slight shadow lift
```

---

## Icon System
Use Heroicons (outline style for nav, solid for status indicators)

Key icons:
```
Dashboard:   ChartBarIcon
Colleges:    BuildingLibraryIcon
Credentials: AcademicCapIcon
Verify:      ShieldCheckIcon
Audit:       ClipboardDocumentListIcon
Settings:    CogIcon
Users:       UserGroupIcon
Revoke:      XCircleIcon
Issue:       PlusCircleIcon
Copy:        DocumentDuplicateIcon
Verified:    CheckBadgeIcon
```

---

## Layout Patterns

### Authenticated App Shell
```
┌─────────────────────────────────────────────────────────┐
│  Topbar (64px) — Logo + Nav + User Avatar              │
├──────────────────────────────────────────────────────────┤
│ Sidebar │                                               │
│ (240px) │          Main Content Area                   │
│         │          (fluid width, 32px padding)         │
│  Fixed  │                                              │
│  Scroll │                                              │
└─────────────────────────────────────────────────────────┘
```

### Page Header Pattern
```
┌─────────────────────────────────────────────────────────┐
│  Page Title (24px bold)           [Primary Action Btn] │
│  Subtitle / breadcrumb (13px gray)                     │
└─────────────────────────────────────────────────────────┘
```

### Stats Row Pattern
```
┌───────────┐ ┌───────────┐ ┌───────────┐ ┌───────────┐
│  Stat 1   │ │  Stat 2   │ │  Stat 3   │ │  Stat 4   │
│           │ │           │ │           │ │           │
│   142     │ │    3      │ │   89      │ │    7      │
│  TOKENS   │ │ COLLEGES  │ │  VERIFS   │ │  REVOKED  │
└───────────┘ └───────────┘ └───────────┘ └───────────┘
```

---

## Application Portals

### Portal 1: College Admin Portal
**URL**: app.authenx.in/college
**Users**: College IT admins, registrar office
**Primary Actions**: Issue credentials, manage students, view audit
**Color Accent**: #1D4ED8 (Blue — trust)

### Portal 2: Employer Verification Portal
**URL**: app.authenx.in/verify
**Users**: HR teams, hiring managers, background check companies
**Primary Actions**: Verify candidate code, view live results
**Color Accent**: #059669 (Green — verified)

### Portal 3: AuthenX Admin Portal
**URL**: app.authenx.in/admin
**Users**: AuthenX super admins
**Primary Actions**: Onboard colleges, manage keys, view global audit
**Color Accent**: #0F2044 (Navy — authority)

---

## Screen Inventory

### College Admin Portal (7 screens)
1. Login
2. Dashboard (stats + recent activity)
3. Students (list, search, filter)
4. Issue Credential (form + preview)
5. Credential Issued (code display + share)
6. Manage Tokens (list + revoke)
7. Audit Log

### Employer Verification Portal (5 screens)
1. Login / Landing
2. Paste Code (step 1)
3. Code Decoded (step 2 — registry check)
4. Live Verified (step 3 — ERP confirmed ✓)
5. Revoked Result (step 3 — credential invalid ✗)

### AuthenX Admin Portal (4 screens)
1. Dashboard (global stats)
2. College Onboarding
3. College Management
4. Global Audit Log

---

## Motion & Animation

```
Transitions:  150ms ease-out (standard UI)
Hover lift:   transform: translateY(-1px) + shadow increase
Modal open:   opacity 0→1, scale 0.97→1, 150ms
Toast:        slide in from right, 300ms
Loading:      subtle pulse or spinner (14px)
Page enter:   fade + slide up (200ms)
```

---

## Responsiveness

```
Mobile:  320px – 768px   (stack everything, hamburger nav)
Tablet:  768px – 1024px  (condensed sidebar, 2-col grids)
Desktop: 1024px+          (full layout as designed)
```

---

## Empty States

Every list/table should have a meaningful empty state:
- Icon (relevant to content)
- Heading: "No [items] yet"
- Sub: Short description of what this section does
- CTA: Primary action button (e.g., "Issue your first credential")

---

## Error States

```
Form errors:  Red border + error text below field
API errors:   Toast notification (top right, red, auto-dismiss 5s)
Page errors:  Full-page error card with retry option
Not found:    404 illustration + return home link
```
