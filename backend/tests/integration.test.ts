const API_BASE = 'https://hcydppml1a.execute-api.ap-southeast-5.amazonaws.com/prod';

// Credentials are never committed. Set them in the environment before running:
//   TEST_ADMIN_USER, TEST_ADMIN_PIN, TEST_CASHIER_USER, TEST_CASHIER_PIN
// Auth cases that need them are skipped when unset so the rest of the suite
// still runs.
const ADMIN_USER = process.env.TEST_ADMIN_USER;
const ADMIN_PIN = process.env.TEST_ADMIN_PIN;
const CASHIER_USER = process.env.TEST_CASHIER_USER;
const CASHIER_PIN = process.env.TEST_CASHIER_PIN;

const hasAdminCreds = !!(ADMIN_USER && ADMIN_PIN);
const hasCashierCreds = !!(CASHIER_USER && CASHIER_PIN);

// Groups that need a token are skipped rather than failed when creds are absent,
// so a checkout without secrets still exercises the public endpoints.
const describeAuthed = hasAdminCreds ? describe : describe.skip;

/**
 * Second, independent gate for tests that MUTATE production.
 *
 * The Order Flow group opens the café, creates a real order, approves it
 * (deducting ingredient stock), then closes the café — which fires an
 * end-of-day summary EMAIL to the admin. On 2026-08-02 seven such orders
 * entered the Sunday figures and sent two spurious reports before anyone
 * realised `npm test` was writing to the live café.
 *
 * Credentials alone must not be sufficient to trigger that, so this requires
 * RUN_LIVE_WRITE_TESTS=1 as well:
 *
 *   $env:TEST_ADMIN_USER="..."; $env:TEST_ADMIN_PIN="..."
 *   $env:RUN_LIVE_WRITE_TESTS="1"; npx jest tests/integration.test.ts
 *
 * Only do that against a non-production stack, or knowingly accept a real
 * order plus an email. `scripts/cleanup-test-orders.mjs` removes the orders.
 */
const liveWritesEnabled = hasAdminCreds && process.env.RUN_LIVE_WRITE_TESTS === '1';
const describeLiveWrites = liveWritesEnabled ? describe : describe.skip;

if (hasAdminCreds && !liveWritesEnabled) {
  console.warn(
    '[integration] Credentials present but RUN_LIVE_WRITE_TESTS is not "1" — '
    + 'skipping Order Flow. It creates a real order and emails an end-of-day summary.',
  );
}

if (!hasAdminCreds) {
  console.warn('[integration] TEST_ADMIN_USER / TEST_ADMIN_PIN not set — admin cases skipped.');
}

async function apiFetch(path: string, options: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_BASE}${path}`, options);
  const body = await res.json();
  return { status: res.status, body };
}

async function login(userId?: string, pin?: string) {
  return apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, pin }),
  });
}

async function getAdminToken(): Promise<string> {
  if (!hasAdminCreds) return '';
  const { body } = await login(ADMIN_USER, ADMIN_PIN);
  return body.token;
}

describe('Integration Tests (Live API)', () => {
  let adminToken: string;

  beforeAll(async () => {
    adminToken = await getAdminToken();
  }, 15000);

  describe('Public Endpoints', () => {
    it('GET /api/cafe/status should return cafeStatus', async () => {
      const { status, body } = await apiFetch('/api/cafe/status');
      expect(status).toBe(200);
      expect(body.cafeStatus).toBeDefined();
      expect(['OPEN', 'CLOSED']).toContain(body.cafeStatus);
      expect(typeof body.queueSize).toBe('number');
    });

    it('GET /api/menu should return items array', async () => {
      const { status, body } = await apiFetch('/api/menu');
      expect(status).toBe(200);
      expect(body.items).toBeDefined();
      expect(Array.isArray(body.items)).toBe(true);
    });

    it('GET /api/menu items should have required fields', async () => {
      const { body } = await apiFetch('/api/menu');
      if (body.items.length > 0) {
        const item = body.items[0];
        expect(item.menuItemId).toBeDefined();
        expect(item.name).toBeDefined();
        expect(item.category).toBeDefined();
        expect(['DRINK', 'FOOD']).toContain(item.category);
        expect(typeof item.basePrice).toBe('number');
      }
    });
  });

  describe('Auth', () => {
    const itAdmin = hasAdminCreds ? it : it.skip;
    const itCashier = hasCashierCreds ? it : it.skip;

    itAdmin('POST /api/auth/login should return token for valid admin', async () => {
      const { status, body } = await login(ADMIN_USER, ADMIN_PIN);
      expect(status).toBe(200);
      expect(body.token).toBeDefined();
      expect(body.role).toBe('ADMIN');
      expect(body.name).toBeDefined();
    });

    // This test requires backend redeployment (login-by-name feature)
    itCashier('POST /api/auth/login should allow login by userId', async () => {
      const { status, body } = await login(CASHIER_USER, CASHIER_PIN);
      expect(status).toBe(200);
      expect(body.token).toBeDefined();
      expect(body.role).toBe('CASHIER');
    });

    itAdmin('POST /api/auth/login should reject wrong PIN', async () => {
      // Deliberately invalid PIN — never a real one.
      const { status } = await login(ADMIN_USER, '000000');
      expect(status).toBe(401);
    });

    itAdmin('POST /api/auth/login should reject missing fields', async () => {
      const { status } = await login(ADMIN_USER, undefined);
      expect(status).toBe(400);
    });
  });

  describeAuthed('POS Endpoints (Authenticated)', () => {
    it('GET /api/pos/orders should return orders array', async () => {
      const { status, body } = await apiFetch('/api/pos/orders', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(status).toBe(200);
      expect(body.orders || Array.isArray(body)).toBeTruthy();
    });

    it('GET /api/pos/inventory should return ingredients', async () => {
      const { status, body } = await apiFetch('/api/pos/inventory', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(status).toBe(200);
      expect(body.ingredients).toBeDefined();
      expect(Array.isArray(body.ingredients)).toBe(true);
    });

    it('GET /api/pos/inventory ingredients should have usageUnit', async () => {
      const { body } = await apiFetch('/api/pos/inventory', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const ingredients = body.ingredients.filter((i: any) => i.PK?.startsWith('INGREDIENT#') && i.SK === 'META');
      if (ingredients.length > 0) {
        expect(ingredients[0].usageUnit).toBeDefined();
        expect(ingredients[0].unit).toBeDefined();
        expect(ingredients[0].name).toBeDefined();
      }
    });

    it('should reject unauthenticated POS request', async () => {
      const { status } = await apiFetch('/api/pos/orders');
      expect(status).toBe(401);
    });
  });

  describeAuthed('Admin Endpoints', () => {
    it('GET /api/admin/settings should return settings', async () => {
      const { status, body } = await apiFetch('/api/admin/settings', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(status).toBe(200);
      expect(body).toBeDefined();
    });

    it('GET /api/admin/reports/daily should return report', async () => {
      const { status, body } = await apiFetch('/api/admin/reports/daily', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(status).toBe(200);
      expect(body.date).toBeDefined();
      expect(typeof body.totalOrders).toBe('number');
      expect(typeof body.totalRevenue).toBe('number');
    });

    it('GET /api/admin/reports/inventory should return low stock', async () => {
      const { status, body } = await apiFetch('/api/admin/reports/inventory', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(status).toBe(200);
      expect(body.lowStock).toBeDefined();
      expect(Array.isArray(body.lowStock)).toBe(true);
    });

    (hasCashierCreds ? it : it.skip)('should reject cashier accessing admin routes', async () => {
      const { body: loginBody } = await login(CASHIER_USER, CASHIER_PIN);
      const { status } = await apiFetch('/api/admin/settings', {
        headers: { Authorization: `Bearer ${loginBody.token}` },
      });
      expect(status).toBe(403);
    });
  });

  // MUTATES PRODUCTION: opens the café, creates a real order, deducts
  // ingredient stock, and closes the café (which sends an email).
  describeLiveWrites('Order Flow', () => {
    let orderId: string;
    let wasClosed = false;

    beforeAll(async () => {
      // Ensure café is open for order tests
      const { body: statusBody } = await apiFetch('/api/cafe/status');
      if (statusBody.cafeStatus === 'CLOSED') {
        wasClosed = true;
        await apiFetch('/api/pos/cafe/open', {
          method: 'PUT',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
      }
    }, 10000);

    afterAll(async () => {
      // Restore closed state if it was closed
      if (wasClosed) {
        await apiFetch('/api/pos/cafe/close', {
          method: 'PUT',
          headers: { Authorization: `Bearer ${adminToken}` },
        });
      }
    }, 10000);

    it('POST /api/orders should create an order', async () => {
      const { body: menuBody } = await apiFetch('/api/menu');
      const drink = menuBody.items.find((i: any) => i.category === 'DRINK');
      if (!drink) return;

      const { status, body } = await apiFetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Test Customer',
          items: [{ menuItemId: drink.menuItemId, variant: drink.variants?.[0]?.id || null, quantity: 1 }],
        }),
      });
      expect(status).toBe(201);
      expect(body.orderId).toBeDefined();
      orderId = body.orderId;
    });

    it('GET /api/orders/:id should return the order', async () => {
      if (!orderId) return;
      const { status, body } = await apiFetch(`/api/orders/${orderId}`);
      expect(status).toBe(200);
      expect(body.customerName).toBe('Test Customer');
      expect(body.status).toBe('PENDING');
    });

    it('PUT /api/pos/orders/:id/approve should approve the order', async () => {
      if (!orderId) return;
      const { status, body } = await apiFetch(`/api/pos/orders/${orderId}/approve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ approvedBy: 'Test Admin' }),
      });
      expect(status).toBe(200);
    });

    it('GET /api/orders/:id should show PREPARING after approve', async () => {
      if (!orderId) return;
      const { body } = await apiFetch(`/api/orders/${orderId}`);
      expect(body.status).toBe('PREPARING');
    });

    it('PUT /api/pos/orders/:id/ready should mark ready', async () => {
      if (!orderId) return;
      const { status } = await apiFetch(`/api/pos/orders/${orderId}/ready`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      expect(status).toBe(200);
    });

    it('GET /api/orders/:id should show READY', async () => {
      if (!orderId) return;
      const { body } = await apiFetch(`/api/orders/${orderId}`);
      expect(body.status).toBe('READY');
    });
  });
});
