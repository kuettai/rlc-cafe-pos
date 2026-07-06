# Dashboard vs Reports Split — Design Spec

## Overview

Separate the Admin page into two distinct views:
- **Dashboard** — TODAY only, live/real-time operational view
- **Reports** — Historical analytics, any date range (weekly/monthly)

Currently both concepts are mixed under a single "Reports" tab, causing confusion (shows today-only data in some sections, all-time in others).

---

## Dashboard Tab (Default Landing — Today Only)

### Purpose
Operational — "How's today going?" Live, auto-refreshing.

### Sections (top to bottom)

#### 1. Stats Cards Row
```
┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐
│ 21  │ │RM134│ │  3  │ │  5  │ │ 13  │
│Total│ │ Rev │ │Pend │ │Prep │ │Done │
└─────┘ └─────┘ └─────┘ └─────┘ └─────┘
```
- Total Orders: count of ARCHIVED + READY + PREPARING + PENDING (all today)
- Revenue: sum totalAmount for ARCHIVED + READY (completed, excl pre-orders where total=0)
- Pending: count of PENDING orders right now
- Preparing: count of PREPARING orders right now
- Completed: count of ARCHIVED + READY

#### 2. Session Comparison
```
┌──────────────────────────────────────┐
│ Session 1 (8:00–11:30)  │ Session 2 (11:31–14:00) │
│ 12 orders · RM 80       │ 9 orders · RM 54        │
│ Top: Latte (5)          │ Top: Soda (3)           │
│ Avg: RM 6.67            │ Avg: RM 6.00            │
└──────────────────────────────────────┘
```
- Split by MYT time (UTC+8), threshold at 11:30 AM (690 minutes)
- Only ARCHIVED + READY orders count
- Show top item, avg order value per session

#### 3. Today's Discounts
```
┌──────────────────────────────────────┐
│ 💰 Today's Discounts                 │
│ Celebration: 5 orders (RM 10)        │
│ Pre-Order:   6 orders (RM 174)       │
│ Staff:       2 orders (RM 8)         │
│ Total:      13 orders (RM 192)       │
└──────────────────────────────────────┘
```
- Scoped to TODAY + ARCHIVED/READY only
- Breakdown by discountType

#### 4. Top Items Today
```
┌──────────────────────────────────────┐
│ 🏆 Top Items                         │
│ 1. Latte (Hot) — 8 sold             │
│ 2. Long Black (Iced) — 5 sold       │
│ 3. Soda (Butterfly Pea) — 4 sold    │
│ 4. Nasi Lemak — 3 sold              │
│ 5. Curry Puff — 3 sold              │
└──────────────────────────────────────┘
```

#### 5. Low Stock Alerts
```
┌──────────────────────────────────────┐
│ ⚠️ Low Stock                         │
│ Oat Milk — 1 left (threshold: 2)    │
│ Ice — 0 left (threshold: 1)         │
└──────────────────────────────────────┘
```
- Items where currentStock <= lowStockThreshold

#### 6. Quick Actions (optional)
- "Load Restock List" button
- "Export Today's Summary" (clipboard copy)

### Data Source
- Existing `/api/admin/reports/daily` endpoint (scoped to today)
- Existing `/api/admin/reports/sessions` endpoint
- Existing `/api/admin/reports/discounts` endpoint (scoped to today)
- Ingredients endpoint for low stock

### Refresh
- Auto-refresh every 30 seconds (or manual refresh button)

---

## Reports Tab (Historical — Any Date Range)

### Purpose
Analytical — "How did we do this week/month?" On-demand, not live.

### Controls
- Month picker (defaults to current month)
- Quick buttons: "This Week" / "Last Week" / "This Month"

### Sections

#### 1. Weekly/Monthly Summary Table
```
           | Jul 6  | Jul 13 | Jul 20 | Jul 27 | Total
Gross      | 430    | 419    | 412    | 435    | 1696
Discounts  | -36    | -15    | -149   | 0      | -200
Net Sales  | 394    | 404    | 263    | 435    | 1496
Refunds    | 0      | -5     | 0      | 0      | -5
Adj Net    | 394    | 399    | 263    | 435    | 1491
Orders     | 45     | 38     | 32     | 41     | 156
Avg        | 8.76   | 10.63  | 8.22   | 10.61  | 9.56
```
- Columns = unique service days in the selected period
- Use existing `/api/admin/reports?startDate=&endDate=` endpoint

#### 2. Discount History
```
           | Jul 6  | Jul 13 | Jul 20 | Total
Newcomer   | 2 (8)  | 1 (5)  | 0      | 3 (13)
Staff      | 3 (12) | 2 (8)  | 4 (16) | 9 (36)
Celebration| 5 (10) | 0      | 12 (24)| 17 (34)
Pre-Order  | 6 (174)| 0      | 0      | 6 (174)
Total      | 16(204)| 3 (13) | 16 (40)| 35 (257)
```
- Same date range as summary table
- Group by service day × discount type

#### 3. Detail View (filterable order table)
```
┌──────────────────────────────────────────────────┐
│ [From: ___] [To: ___] [Filter] [Download CSV]    │
├──────────────────────────────────────────────────┤
│ Date | ID | Items | Gross | Disc | Net | Status   │
│ ...  | .. | ...   | ...   | ...  | ... | ...      │
└──────────────────────────────────────────────────┘
```
- Filterable by date range
- Sortable by date (newest first)
- Refund rows in red
- CSV export (emoji-stripped)

### Data Source
- Existing `/api/admin/reports?startDate=&endDate=` (paginated)
- Client-side aggregation for summary table

---

## Implementation Plan (for next session)

### Phase 1: Rename + Restructure Tabs
- Current "📈 Reports" tab → rename to "📊 Dashboard"
- Current "📊 Monthly Summary" sidebar item → rename to "📈 Reports"
- Move session comparison from Reports into Dashboard rendering
- Move discount breakdown from Reports into Dashboard rendering

### Phase 2: Dashboard — Refactor renderReportsSection
- Scope ALL queries to today only (no date picker)
- Add low stock section (query ingredients)
- Add top items section
- Add auto-refresh (30s interval)
- Remove weekly/monthly sections from Dashboard

### Phase 3: Reports — Refactor Monthly Summary
- Bring the reports.html/reports.js concepts INTO the admin page as a tab
- OR keep reports.html as the "Reports" destination (simplest — it already works)
- Add discount history per-service-day breakdown
- Ensure CSV export strips emoji

### Phase 4: Cleanup
- Remove redundant endpoints/sections
- Ensure all numbers reconcile (same universe of orders everywhere)
- Test: Dashboard today numbers should match Reports' today column

---

## Backend Changes Needed

Minimal — mostly frontend reorganization. But:

1. **Dashboard refresh endpoint** — could be a single `/api/admin/dashboard` that returns all today's data in one call (stats + sessions + discounts + top items + low stock). Reduces frontend from 5 API calls to 1.

2. **Reports endpoint already exists** — `/api/admin/reports?startDate=&endDate=` returns raw orders. Client-side aggregation handles the rest.

---

## Files Affected

| File | Change |
|------|--------|
| `frontend/js/admin.js` | Major — split renderReportsSection into renderDashboard + keep reports.html link |
| `frontend/js/reports.js` | Minor — ensure discount history table is added |
| `backend/src/routes/admin.ts` | Optional — new `/api/admin/dashboard` consolidated endpoint |

---

## Open Questions

1. Should Dashboard auto-refresh, or just have a manual "Refresh" button?
2. Should the Reports tab be the reports.html page (separate), or built into admin.js?
3. Do we need "Compare this Sunday vs last Sunday" in Reports?
