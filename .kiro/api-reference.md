# API Reference

Base URL: `https://hcydppml1a.execute-api.ap-southeast-5.amazonaws.com/prod`

## Public Endpoints (No Auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/cafe/status | Returns {cafeStatus, queueSize} |
| GET | /api/menu | Returns {items: [...]} (active + enabled today) |
| POST | /api/orders | Create order. Body: {customerName, items: [{menuItemId, variant?, selectedVariants?, quantity}]} |
| GET | /api/orders/{id} | Get order status (for polling) |
| PUT | /api/orders/{id} | Modify/cancel. Body: {action: 'cancel'} or {action: 'update', items} |
| POST | /api/auth/login | Login. Body: {userId, pin} → Returns {token, userId, name, role, forceUpdatePin} |
| POST | /api/auth/update-pin | Update PIN (requires JWT). Body: {newPin} → Sets forceUpdatePin=false |

## POS Endpoints (Requires JWT, role: CASHIER or ADMIN)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/pos/orders | List active orders (PENDING/PREPARING/READY). ?search=name |
| POST | /api/pos/orders | Create walk-up order. Body: {customerName, items, discountType?} |
| PUT | /api/pos/orders/{id}/approve | Approve. Body: {approvedBy, discountType?} |
| PUT | /api/pos/orders/{id}/ready | Mark ready (PREPARING→READY) |
| PUT | /api/pos/orders/{id}/undo | Undo (PREPARING→PENDING) |
| PUT | /api/pos/orders/{id}/reject | Reject. Body: {reason} |
| PUT | /api/pos/cafe/open | Open café |
| PUT | /api/pos/cafe/close | Close café |
| PUT | /api/pos/cafe/celebration | Toggle celebration. Body: {enabled} |
| PUT | /api/pos/menu/{id}/toggle | Toggle item enabled today |
| GET | /api/pos/inventory | Get all ingredients |
| PUT | /api/pos/inventory/{id} | Adjust stock. Body: {currentStock} |

## Admin Endpoints (Requires JWT, role: ADMIN)

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/admin/menu | Add menu item |
| PUT | /api/admin/menu/{id} | Edit menu item |
| DELETE | /api/admin/menu/{id} | Delete menu item |
| POST | /api/admin/ingredients | Add ingredient |
| PUT | /api/admin/ingredients/{id} | Edit ingredient |
| POST | /api/admin/recipes | Define recipe. Body: {menuItemId, variantId?, ingredients: [{ingredientId, quantity}]} |
| POST | /api/admin/users | Add user. Body: {name, pin, role} |
| PUT | /api/admin/users/{id} | Edit user |
| DELETE | /api/admin/users/{id} | Delete user |
| GET | /api/admin/settings | Get settings |
| PUT | /api/admin/settings | Update settings |
| GET | /api/admin/reports/daily | Daily reconciliation report |
| GET | /api/admin/reports/weekly | Weekly summary (stub) |
| GET | /api/admin/reports/inventory | Low stock report |
| GET | /api/admin/activity-log | Activity log (stub) |
| GET | /api/admin/checklist/config | Get checklist configuration |
| PUT | /api/admin/checklist/config | Save checklist config. Body: {open: [...], close: [...]} |
| GET | /api/admin/checklist/logs | Get historical checklist completion logs |
| POST | /api/admin/planogram/reference | Upload reference photo. Body: {location, image (base64)} |

## Checklist Endpoints (Requires JWT, role: CASHIER or ADMIN)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/pos/checklist | Get checklist config + today's completion status |
| PUT | /api/pos/checklist/check | Mark item done. Body: {phase, itemId, completedBy} |
| PUT | /api/pos/checklist/uncheck | Uncheck item. Body: {phase, itemId} |

## Planogram Endpoints (Requires JWT, role: CASHIER or ADMIN)

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/pos/planogram/analyze | Upload photos for AI stock count. Body: {location, images[]} |
| POST | /api/pos/planogram/confirm | Confirm counts and save. Body: {counts: [{ingredientId, count}]} |
| GET | /api/pos/planogram/reference/{location} | Get reference photo presigned URL |

## Receipt Endpoints (Public)

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/orders/{id}/receipt | Upload receipt image. Body: {image (base64)} |
| GET | /api/orders/{id}/receipt | Get presigned URL to view receipt |
