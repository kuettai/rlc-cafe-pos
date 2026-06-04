# RLC Café POS — Requirements Document

## 1. Overview

A Progressive Web App (PWA) replacing the current Loyverse POS for the church café at Oasis of Care (RLC), Petaling Jaya. The system enables customer self-ordering, real-time order management, recipe-based inventory tracking, and end-of-day reconciliation.

**Operating schedule:** Sundays only, two windows — 10:15–11:30 and 12:45–13:30.

## 2. Users & Roles

| Role | Access | Auth |
|------|--------|------|
| Customer | Public ordering page | None (name saved in cookie) |
| Cashier | POS order board, enable/disable items, walk-up orders, inventory adjustment during service | Individual PIN → JWT (4hr expiry) |
| Admin | Full system access (menu, inventory, reports, settings, people) | Stronger PIN/passphrase → JWT |

## 3. Customer Features

### 3.1 Ordering Flow
- Scan QR code at table/counter → opens PWA
- Enter preferred name (persisted in cookie for repeat visits)
- Browse menu (drinks + food), see available quantities for food items
- Select variant groups: Temperature (Hot/Iced), Milk (Oat Milk), Flavor (for Tea/Soda)
- Variant groups can be: single (pick one), optional (toggle on/off), multi (pick many)
- Iced-only drinks named with "(Iced)" suffix — no selection needed
- Add multiple items to cart, modify freely
- Submit order → system checks food stock availability at submission
- If food unavailable, customer notified to adjust order

### 3.2 Order Tracking
- After submission, customer sees live tracking page (5-10s polling)
- Statuses: Pending → Preparing → Ready for Collection
- If cashier disables an item mid-service, customer is notified: "Item became unavailable — please update your order"
- Customer can modify/cancel own order while still in Pending (unpaid)

### 3.3 Payment
- After submitting, customer sees total amount + Maybank QR code to scan
- Customer pays via DuitNow/TnG/bank (all supported by Maybank QR)
- Customer shows payment proof to cashier at counter

### 3.4 Queue Awareness
- Customer sees prompt: "There are X drinks ahead of you, expect slight delay"

### 3.5 Closed State
- If café is not open, customer sees: "Café is closed, see you next Sunday" + church location info

## 4. Cashier Features

### 4.1 Order Board
- Kanban view (3 columns: Pending | Preparing | Ready) on iPad
- Single-list view option for mobile
- Toggle between views
- Latest orders at top in Pending column
- Filter/search by customer name
- Ready orders auto-archive after 15 minutes

### 4.2 Order Actions
- Tap order → see: customer name, items, total price
- Actions on pending orders:
  - **Approve** → move to Preparing (after verifying payment proof)
  - **Mark Newcomer** → move to Preparing, log offset (free drinks)
  - **Reject** → only for unpaid orders, select rejection reason
- Actions on preparing orders:
  - **Ready** → move to Ready for Collection

### 4.3 Walk-up Orders
- Cashier creates order for staff/pastors who come to counter
- Select items from same menu → apply discount type (Staff RM5 / Pastor Free) → confirm → auto-moves to Preparing

### 4.4 Day Management
- Open café for the day (enables customer ordering)
- Close café (disables ordering) — manual button or auto-close at configured hour
- Enable/disable individual menu items for the day
- Toggle Special Celebration mode (all drinks RM5)
- When disabling an item: system flags all pending orders containing that item

### 4.5 Inventory (During Service)
- View estimated remaining stock per ingredient
- Adjust/correct stock counts manually (for test shots, spills, etc.)

### 4.6 Menu Changes
- Cashier can add/edit menu items and prices
- All cashier menu changes logged and included in end-of-day notification to admin

## 5. Admin Features

### 5.1 Everything Cashier Can Do
- Admin has full cashier capabilities

### 5.2 Menu Management
- Add/edit/remove menu items (name, price, category: drink/food)
- Define variants (hot/iced, milk options + price modifiers)
- Upload item images (optional)
- Configure Special Celebration flat price

### 5.3 Inventory Management
- Define raw ingredients with measurement units (ml, grams, spoons)
- Define recipes per menu item (e.g., Iced Latte = 200ml milk + 20g coffee + 30ml syrup)
- Set low-stock thresholds per ingredient
- View current estimated stock levels (auto-calculated from sales)
- Adjust/correct stock counts manually
- View stock history and consumption trends
- Restock log (who added what, when)

### 5.4 People Management
- Add/remove volunteer PINs
- Assign roles (cashier / admin)
- View activity log (who logged in, actions taken)

### 5.5 Reporting
- End-of-day reconciliation: total orders, expected revenue, newcomer offsets, net expected collection
- Weekly/monthly sales summary
- Popular items ranking
- Revenue trends
- Inventory consumption rate (predict reorder timing)
- Notification history

### 5.6 Settings
- Email recipients for restock alerts
- Low-stock thresholds per ingredient
- Order expiry time (default: 1 hour)
- Café operating hours (for auto-close)
- Auto-archive time for ready orders (default: 15 minutes)

### 5.7 Notifications
- Low-stock email alert to restocking person (triggered when ingredient hits threshold)
- End-of-day summary email to admin (includes cashier menu changes, sales summary, inventory status)

## 6. Pricing Logic

| Customer Type | Drinks Price | Food Price | Who Applies |
|---------------|-------------|------------|-------------|
| Regular | Normal menu price | Normal | Automatic |
| Special Celebration | RM5 flat (all drinks) | Normal | Cashier toggles for the day; customer sees RM5 on menu |
| Newcomer | Free | Normal | Cashier marks per-order at approval |
| Staff (walk-up) | RM5 flat | Normal | Cashier creates walk-up order |
| Pastor (walk-up) | Free | Normal | Cashier creates walk-up order |
| Staff/Pastor (self-order) | Normal price | Normal | No discount — self-service = normal pricing |

## 7. Inventory Logic

- Each menu item has a recipe defining ingredient consumption
- On order completion (moved to Preparing), ingredients are deducted by recipe amounts
- System shows estimated remaining quantities
- Cashier can override/adjust at any time (test shots, spillage, etc.)
- End-of-service: cashier confirms final stock count
- If ingredient hits low-stock threshold → email alert sent

## 8. Order Lifecycle

```
Customer submits → [PENDING]
  ├── Customer can modify/cancel
  ├── If item disabled by cashier → customer notified to update
  ├── Auto-expires after 1 hour
  │
  Cashier approves (payment verified) → [PREPARING]
  ├── Inventory deducted
  ├── Newcomer/discount offset logged
  │
  Barista/Cashier marks ready → [READY FOR COLLECTION]
  ├── Name called out
  ├── Auto-archives after 15 minutes
  │
  [ARCHIVED] → available in reporting
```

## 9. Non-Functional Requirements

- **PWA:** Installable on iPad and mobile devices via Add to Home Screen
- **Responsive:** Works on iPad (primary), mobile phones (cashier + customer)
- **Performance:** Page load < 2s, polling every 5-10s
- **Availability:** Must be reliable during Sunday service windows
- **Cost:** Minimal/near-zero monthly cost
- **Security:** PIN-based auth with JWT tokens, no secrets in frontend
- **Data retention:** Order history and inventory logs retained for reporting

## 10. Out of Scope (Future Enhancements)

- Display screen for "Ready" orders (digital signage)
- Customer order history visible to customer
- Payment API integration (auto-verify payment)
- Push notifications to customer devices
- Volunteer scheduling
- Multi-language support (BM)
- Offline mode / service worker data sync
