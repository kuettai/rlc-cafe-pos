# Questionnaire v1

## Operations & Volume
1. How many drinks/items do you serve on a typical Sunday (or whichever day the café operates)? Is it only on service days or daily?
- During service day only, only sunday. There are 2 services on Sunday, between 0900-1030, and 1130-1300. Hence the cafe will be active between 1015-1130 and 1245-1330

2. How many volunteers typically work the counter at one time?
- minimum 2, maximum 3. (1 cashier, 1-2 barista)

3. Is there a menu with fixed prices, or is it donation/pay-what-you-want?
- Fix price, with additional option to make it (Special Celebration - MYR 5.00, New Comer - Free, Pastors - Free, Staff - MYR 5.00)

## Payment
4. When you say customers scan a QR code — is this DuitNow QR, Touch 'n Go eWallet, or a specific bank's QR? Or do you have multiple options?
- It is Maybank QR code but it is already supporting all the platforms. (DuitNow, TnG, and banks)

5. Does the café need to reconcile payments against orders, or is it purely "scan and pay the amount shown"?
- Scan and pay the amount shown, manually validated by Cashier

## Inventory & Restocking
6. Who decides when to restock and who does the purchasing? Is it one person or rotated among volunteers?
- One person now, church staff

7. The stock check seems weekly — is that the only time someone looks at inventory, or do people notice mid-week that something ran out?
- Mid-week most of the time, inconsistent

8. Where is stock stored? Single location or split between a counter area and a storeroom (I noticed "check storeroom" notes)?
- 2 places, store rooms and within the cafe fridge

## Tech & Constraints
9. Is the iPad the only device available, or could volunteers use their own phones as well?
- Currently iPad

10. Does the café have reliable WiFi, or should the system work offline too?
- There is, to ensure payment receive

11. Are you looking to self-host (e.g., on a cheap server or Raspberry Pi at the church) or would a cloud-hosted solution be fine?
- AWS Serverless Expresso type of setup maybe?

12. Any budget constraints, or is this a "free/minimal cost" requirement like the current Loyverse setup?
- Minimal cost

## Design Direction

**Customer self-ordering flow (Serverless-Espresso inspired):**
- Café opens → customers open website (no app install needed)
- Customer saves preferred name via cookie
- Customer browses menu, adds items, modifies freely before submitting
- Customer submits order → appears as "Pending" on Admin POS
- Customer pays via Maybank QR, shows proof to Cashier
- Cashier moves order from "Pending" → "Preparing"
- Barista/Cashier moves order from "Preparing" → "Ready for Collection"
- Customer sees status update on their device

**Benefits:**
- Eliminates queue at counter
- Cashier doesn't need to key in items
- Customers can take their time choosing
- Order accuracy improves (customer owns their order)

## Decisions Made

**Order expiry:** Auto-expire after 1 hour if not moved from Pending.

**Pending Orders view (Cashier):**
- Latest orders at top, older orders at bottom
- Filter/search input to quickly find by customer name

**Name display / collection:** Keep it simple — someone calls out the name. Display screen is a future enhancement.

**Inventory tie-in:** NOT automatic. Cashier manually enables/disables menu items at the start of the day.

**Concurrency:** Let it flow. Customer sees a prompt like "There are 5 drinks ahead of you, expect slight delay" based on current queue size.

## Follow-up Questions (Round 2)

1. How many menu items are there roughly? Is it just drinks, or food too?
- Drinks maybe 10 (exclude Ice/Hot), Food subject to availability. Cashier need to handle food count / day. Usually drinks will NOT run out, food will run out.

2. Do items have variants (e.g., hot/iced, size options) or is each menu item a single SKU?
- Hot/iced, and Latte has varince of using either Normal Milk or Oat Milk (+1 MYR)

3. For the "open" items in your spreadsheet (e.g., "Milk (open)" showing fractions) — is that tracking how much of a carton/bottle is left? Would you want the POS to estimate this based on recipes (e.g., 1 latte = ~200ml milk), or keep it manual?
- Let's try to estimate; Systems should auto estimate the remaining but Cashier should decide the final remaining amount (reason: there might be test-shot and experimentation-drink on-going which might cause items not tally)

4. The special pricing (Special Celebration RM5, Newcomer Free, etc.) — is that applied to the whole order or per item? Does the cashier just select a category for the customer?
- Oh true, currently this option is handle by Cashier, as in when adding item to the "order", cashier selected the item and make it MYR 5. Same goes with Newcomer. Maybe during store-open day, Cashier to decide any Special Celebration (this discount only apply to Drinks, not food). For Newcomer, we just need to amend the process of Cashier. Instead of showing payment proof, Cashier can move the order from "Pending" to "Preparing" and click "newcomer", to add the offset to the bills so total closing / end-day amount is tally. Make sense?

5. Would the restocking person want a simple dashboard or just a notification (e.g., "Oat milk: 1 carton left, reorder needed")?
Yes, dashboard + notification maybe

## Follow-up Questions (Round 3)

1. **Customer view of special pricing** — does the customer see "RM5 Special Celebration" pricing on the menu directly, or do they see normal prices and the cashier adjusts at approval? (I'm thinking the menu should reflect the active pricing so customers aren't confused.)
- Customer see the RM 5 for all drinks. Now i have another Dilemma, how do we handle Church Staffs' drink where they are FLAT-price for all drinks as well.

2. **Food ordering** — since food is "subject to availability" and cashier-managed, should food even appear on the customer self-order menu? Or is food a counter-only item (customer asks at counter, cashier adds manually)?
- Appear. Reason: we do not want separate payment for drinks/foods. Remember, upon customer confirm order, need to "hold" the items so no other customer can take up this food.

3. **End-of-day reconciliation** — do you want the system to produce a summary like: "Total orders: 45, Total revenue expected: RM320, Newcomer offsets: RM24, Actual collected (from bank): RM296"? Or simpler?
- Sounds good

4. **Notifications for restocking** — WhatsApp message? Email? Or just visible on the dashboard for the staff person to check?
- Email seems cheapest option?

5. **Menu management** — should the cashier be able to add/edit menu items and prices, or is that an "admin" function done less frequently (maybe by you)?
- Cashier + Admin. However, all changes by Cashier should send an end-of-day notification to Admin.

## Decisions Made (Round 3)

**Customer types & pricing:**
- Regular — normal menu prices
- Special Celebration — all drinks RM5 (cashier activates café-wide for the day)
- Newcomer — free drinks (cashier marks per-order)
- Staff — flat RM5 all drinks (persistent)
- Pastor — free drinks (persistent)
- Cashier applies the type when moving order to "Preparing" (Option B). Customer sees active price (normal or celebration).

**Food + hold inventory:**
- Food appears on customer menu with available count shown
- When order is submitted, items are reserved (held)
- If order expires (1hr unpaid), reserved items release back to available

**Notifications:**
- Restocking alerts via email (cheapest)
- End-of-day summary of any cashier menu changes sent to admin

## Follow-up Questions (Round 4)

1. For the food "hold" — should it reserve immediately when added to cart, or only when the order is submitted? (Immediate hold risks people adding and never submitting; on-submit risks two people submitting for the last item simultaneously.)
- When order is Submitted. So if the submission contains food, always check stock availability.

2. Do staff/pastors still go through the same self-order flow on their phone, or do they just walk up and the cashier creates the order for them?
- I want to go through same-process. Ok make it simple, if staffs go through their phone, no discount. If they order with Cashier, Cashier can creates the discounted price items for them.

## Decisions Made (Round 4)

**Food hold:** Reserve on submit with stock availability check. If unavailable, customer notified to adjust order.

**Staff/Pastor ordering:**
- Self-order via phone = normal price (no discount)
- Walk-up to cashier = cashier creates order with staff/pastor pricing

## Cost Optimization Ideas

- **Frontend hosting:** GitHub Pages (free) for static HTML/JS apps
- **Email notifications:** Gmail API (free tier) instead of AWS SES

## Decisions Made (Round 5)

**Authentication:** Option 2 — Individual PINs per volunteer. JWT token issued on login, expires after 4 hours inactivity or end of day. Admin has separate stronger PIN/passphrase.

## Admin Page Scope

**Day-to-Day Operations:**
- Open/close café for the day (enables/disables customer ordering)
- View live order board (Admin can act as cashier)
- End-of-day reconciliation report (total orders, revenue, offsets, expected vs actual)

**Menu Management:**
- Add/edit/remove menu items (name, price, category: drink/food, variants)
- Set drink variants (hot/iced, milk options + price modifiers)
- Upload item images (optional)
- Set Special Celebration mode (toggle on/off, flat price)

**Inventory:**
- View current estimated stock levels
- Adjust/correct stock counts manually
- Add new stock items, set low-stock thresholds
- View stock history/trends
- Restock log

**People Management:**
- Add/remove volunteer PINs
- Assign roles (cashier vs admin)
- View activity log

**Reporting:**
- Weekly/monthly sales summary
- Popular items ranking
- Revenue trends
- Inventory consumption rate
- Notification history

**Settings:**
- Email recipients for restock alerts
- Low-stock thresholds per item
- Order expiry time (configurable, default 1hr)
- Café operating hours

**Admin vs Cashier permissions:**
- Only Admin: edit menu/prices, manage PINs, view historical reports, change settings, adjust inventory outside service day
- Cashier: operate order board, enable/disable items for the day, adjust inventory during service

## Decisions Made (Round 6)

**PWA (Progressive Web App):** Yes — the app should be installable on mobile devices and iPad via "Add to Home Screen". Service worker for caching shell assets.

## Follow-up Questions (Round 5)

### Customer Ordering UX
1. How does the customer access the menu? QR code on tables/counter that links to the website? Or a sign with the URL?
- QR on tables/counter that links to the website. No sign in required.

2. Order flow: Customer lands on page → enters name (saved in cookie for next time) → browses menu → adds to cart → reviews order → submits. Sound right, or different?
- Yes

3. After submitting, should the customer stay on a "tracking" page that auto-updates (Pending → Preparing → Ready)? Or just get a confirmation and check back manually?
- Auto-updates

4. Can a customer modify/cancel their own order after submitting but before cashier approves it?
- Yes


### Cashier POS Screen
5. The order board — three columns side by side (Kanban: Pending | Preparing | Ready)? Or a single list with tabs/filters?
- OPtion to change between 3 columns | single list. Reason: Ipad has bigger view-port compare to mobile.

6. When cashier taps a pending order, what do they see? Thinking: customer name, items ordered, total price, action buttons (Approve / Mark Newcomer / Reject). Anything else?
- Yes

7. Should the cashier be able to create a walk-up order from scratch (for staff/pastors or people who don't want to use the app)?
- Yes

8. At what point does the cashier "close" a ready order? When customer collects it? Or auto-archive after some time?
- Auto-archive after sometimes, maybe 15 minutes?

### Inventory Estimation
9. For auto-estimation — do you want to define recipes? E.g., "1 Iced Latte = 200ml milk + 1 shot coffee beans + 30ml syrup". Each sale deducts from ingredient stock automatically.
- Yes, should define

10. How granular should this be? Track by individual ingredient (milk in ml, coffee in grams), or simpler units like "cartons of milk" and "bags of coffee beans"?
- Milk in ML, coffee in grams. So we likely need to have page to add "raw ingredient and measurement unit". e.g: coffee beans - 20g, milk - 100ml, matcha powder - 20g, nata de coco jelly - 2 spoons.

### Real-time Updates
11. How fast does the customer need to see status changes? Instant (WebSocket, slightly more complex) or 5-10 second polling (simpler, still feels responsive)?
- 5-10 second polling

## Decisions Made (Round 7)

**Customer UX:** QR on tables, no sign-in. Name saved in cookie. Auto-updating order tracking page. Can modify/cancel before cashier approval.

**Cashier POS:** Responsive — Kanban on iPad, single-list on mobile. Tap order to see details + actions. Can create walk-up orders. Ready orders auto-archive after 15 minutes.

**Inventory:** Recipe-based. Admin defines raw ingredients with measurement units (ml, grams, spoons, etc.). Each menu item has a recipe that deducts from ingredients on sale.

**Real-time:** 5-10 second polling (no WebSocket).

## Follow-up Questions (Round 6)

1. Should orders have a visible day-number (e.g., "#012") so cashier/barista can call "Order 12 ready!" in addition to the name?
- Call out Name + Drinks

2. A customer can order multiple items in one order (e.g., 2 iced lattes + 1 cake). Correct?
- yes

3. If cashier rejects an order, does the customer get notified on their tracking page? Can they resubmit a modified version?
- Cashier should click Reject, then has option to choose "Rejection Reasons". But thinking about it, customer should already at "making payment" page. Let's dive deeper.

4. When café is not open, what does the customer see if they scan the QR? "Café is closed, see you next Sunday"?
- Yes, and church location

5. Should returning customers (cookie-based) see their past orders? Or unnecessary?
- Unnecessary for now, but i think it is useful data for Admin to understand behavior and planning (who always come for special events etc)

6. Cashier walk-up order: select items from same menu → apply discount type → skip payment step. Correct?
- Select items, choose if any applicable discount, proceed to payment confirmation page, then after confirm, should auto jump to "Preparing"

7. End-of-day: does the cashier explicitly "close" the café, or auto-close based on configured hours?
- Both, explicitly close and Admin can set auto-close hour.

## Decisions Made (Round 8)

**Order rejection approach: Option C (proactive prevention)**
- When cashier disables an item mid-service, all pending (unpaid) orders containing that item get flagged
- Customer sees notification: "Iced Latte just became unavailable — please update your order"
- Customer must remove/replace the item before they can proceed to pay
- Cashier cannot reject orders that are already paid — must fulfil or resolve in person
- "Reject" button only available on unpaid pending orders as a fallback

**Other Round 6 decisions:**
- Order identification: Call out Name + Drinks (no order numbers)
- Multiple items per order: Yes
- Closed state: Show "Café is closed" + church location
- Customer history: Not shown to customer, but data stored for admin analytics
- Walk-up orders: Cashier selects items → applies discount if any → confirms payment → auto-moves to Preparing
- Café close: Both explicit (cashier button) and auto-close based on configured hours

## Decisions Made (Round 9)

**Branding:**
- Church: Oasis of Care (RLC) — Petaling Jaya, Selangor
- Website: oasisofcare.org
- Colour scheme: Derive from church branding (clean, modern — blues/whites from their site)
- Café name: TBD (or just "RLC Café"?)
- Tone: Warm, welcoming, aligned with church values ("Deeply Loved, Greatly Blessed, Highly Favoured")

**Language:** English only

**Analytics:** Sufficient with what's already discussed in Admin scope
