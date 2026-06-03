# Questionnaire v2 — New Features

## Feature 1: Café Open/Close Checklist (Easy)

1. **Who fills out the checklist?** Cashier only, or both cashier AND barista separately?
   - Cashier primarily, but anyone on shift can tick items off the shared list

2. **Open checklist items** — please confirm/edit this draft list:
   - [x] Turn on coffee machine
   - [x] Fill ice container
   - [x] Fill hot water in kettle
   - [x] Set out food items
   - [x] Enable menu items in POS
   - [x] Confirm QR code is visible
   - [x] Test shot (machine warm-up)
   - [x] Capture fridge photo for planogram (stock count before open)
   - [x] Capture store room photo for planogram (stock count before open)

3. **Close checklist items** — please confirm/edit this draft list:
   - [x] Clean Up
   - [x] Empty coffee grounds
   - [x] Return unused milk to fridge
   - [x] Close aircon & music
   - [x] Turn off fridge light
   - [x] Turn off Coffee Machines & cover up
   - [x] Capture fridge photo for planogram (stock count before closing)
   - [x] Capture store room photo for planogram (stock count before closing)

4. **Should the checklist block café open/close?** E.g., cashier cannot click "Open Café" until all open-checklist items are checked. Or is it just informational (a reminder)?
   - Check all, hold them accountable. Blocks open/close until complete.

5. **Should the checklist be editable by Admin in settings?** Or is a fixed list sufficient?
   - Editable with flexibility to decide "Checkbox only, Checkbox with input (text or upload image)"

6. **Should completed checklists be logged?** (e.g., "Sarah completed Open Checklist at 10:05 AM on 8 Jun 2025")
   - Yes

---

## Feature 2: Payment Receipt Upload (Medium)

7. **What payment method QR is shown?** Is it always Maybank DuitNow QR, or can it vary? (Need to know what receipt screenshots will look like)
   - Only 1 type, already printed out

8. **What info should the AI extract from the receipt?** Draft: amount paid, date/time, reference number. Anything else?
   - Amount Paid, Date/Time

9. **Where in the customer flow does the upload happen?** Draft: on the tracking page while order is PENDING, a button like "I've paid — upload receipt". Correct?
   - Yes. Show QR code on tracking page so customer can pay without walking to counter. Flow: see QR → pay via banking app → upload receipt screenshot.

10. **What should the cashier see?** Draft: a badge on the order card saying "Receipt: RM12.00" with a "View" link to see the screenshot. The cashier still clicks "Approve" manually. Sound right?
    - Yes, the one with "badge on order card" should always appear at the top (sorted above non-receipt orders)

11. **What if the AI-extracted amount doesn't match the order total?** Options:
    - (B) Auto-reject and tell customer to re-upload. If amount doesn't tally, don't even notify cashier.

12. **Should we support multiple receipt uploads per order?** (e.g., customer uploaded wrong screenshot first time)
    - Should support re-upload

13. **Should the distinct sound for receipt uploads be different from the new-order sound?** (e.g., a softer "ding" vs the two-tone ping for new orders)
    - Yes, different sound

14. **S3 lifecycle** — receipt images auto-delete after how long? Draft: 7 days (enough for dispute resolution). Or strictly 1 day?
    - 1 day

---

## Feature 3: Planogram Stock Count (Complex)

15. **What does the cashier photograph?** Specific locations:
    - A & B (Fridge + Storeroom). Best practice: arrange items labels-forward, single-row depth, grouped by type.

16. **When does this happen?** At open (morning stock check), at close, or anytime?
    - Before Open, and Before Close (integrated into checklist)

17. **How accurate does the AI need to be?** Options:
    - Target one-tap accuracy (Sonnet 4.5+), but show editable pre-filled results. "Confirm All" if correct, tap to adjust individual items. Best of both worlds.

18. **Should the AI identify specific brands/types?** E.g., distinguish "Monin Passion Fruit" bottle from "Monin Lemon" bottle. Or just count "syrup bottles: 5"?
    - Yes, items are visually distinct. AI should identify specific types.

19. **What items are visible/countable from a photo?** Some items like coffee beans inside a sealed bag look the same whether full or empty. Should the AI only count distinct units (bottles, boxes, bags) and not estimate remaining contents?
    - Count distinct sealed units. For transparent containers (matcha, chocolate powder), estimate % remaining. For non-transparent sealed bags (coffee beans), just count units — mark "requires manual input" for fill level.

20. **Should photos be kept for historical reference?** E.g., "what did the fridge look like last Sunday?" Or strictly 1-day lifecycle (gone after 24h)?
    - Keep resized photos for 4 weeks (historical reference)

21. **Multi-photo flow** — should the cashier take multiple photos in a session (fridge shot 1, fridge shot 2, shelf shot) and get a combined count? Or one photo = one count update?
    - 2 photos per location (upper/lower or left/right). AI combines into one count. Flow: tap "Stock Count" → choose Fridge/Storeroom → take 1-3 photos → "Done" → AI shows editable results → "Confirm All".

22. **Budget for Bedrock calls** — roughly how many photos per week? (Affects cost estimate. E.g., 4 photos/Sunday × 4 Sundays = ~16 Bedrock Vision calls/month)
    - ~8 photos per Sunday (2 per location × 2 locations × 2 sessions). ~32/month. Fine with cost.

---

## General

23. **Priority order** — which of these 3 features is most urgent to have working by the next Sunday service?
    - No urgency, no rush. Target go-live in ~4 weeks.

24. **Should all 3 features be accessible from both Admin AND POS?** Or is there a difference in who uses what?
    - Yes, both Admin and POS

25. **Any budget ceiling for AWS costs?** (Bedrock Claude Vision is ~$0.01-0.03 per image, S3 is negligible. Just want to confirm you're OK with usage-based costs.)
    - Ok with cost, adopting AI :)

---

## Clarification Round (Q26-29)

26. **Who fills out the checklist?**
    - Cashier primarily, but shared — anyone on shift can tick items

27. **Checklist items with image upload (planogram)**
    - Inline within the checklist. Camera opens right there, photo saves as part of checklist completion. When planogram item is checked, it triggers the stock-count AI flow inline.

28. **Payment receipt: should customer see QR on tracking page?**
    - Yes, show QR on page. Customer can pay entirely from their phone without walking to counter. Big QR + amount + "Upload Receipt" button below it.

29. **Planogram: reference layout photo?**
    - Yes. Admin uploads a "reference layout" photo of ideal fridge/storeroom arrangement. AI compares against it to better identify items and detect what's missing/moved.

---

## Architecture Notes (for implementation)

### Checklist
- Checklist items stored in Settings table (DynamoDB)
- Each item: `{id, label, type: 'checkbox'|'text'|'image', phase: 'open'|'close', sortOrder}`
- Completion log: stored per day with timestamp + who completed + any image URLs
- Blocks open/close button until all items checked
- Planogram items in checklist trigger the stock-count sub-flow inline

### Payment Receipt
- S3 bucket: `rlc-cafe-receipts` with 1-day lifecycle
- Customer uploads image → Lambda calls Bedrock Claude to extract amount + date
- If amount ≠ order total → reject immediately, tell customer "amount doesn't match, please re-upload"
- If amount matches → store `receiptUrl`, `receiptAmount`, `receiptDate` on order
- POS: orders with receipt badge sorted to top, distinct sound notification
- Customer tracking page: shows Maybank QR code + amount + upload button

### Planogram
- S3 bucket: `rlc-cafe-planogram` with 4-week lifecycle (resized images)
- Reference photos stored permanently (admin uploads ideal layout)
- Flow: take photos → send to Bedrock with reference + ingredient list → get counts → show editable results → confirm
- Results saved as stock update (same as manual stock adjustment)
- Integrated into checklist as "image" type items
- Model: Claude Sonnet 4.5+ for vision accuracy
