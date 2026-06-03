const API_BASE = 'https://hcydppml1a.execute-api.ap-southeast-5.amazonaws.com/prod';

async function apiFetch(path: string, options: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_BASE}${path}`, options);
  const body = await res.json();
  return { status: res.status, body };
}

async function getAdminToken(): Promise<string> {
  const { body } = await apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'admin-001', pin: '123456' }),
  });
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
    it('POST /api/auth/login should return token for valid admin', async () => {
      const { status, body } = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'admin-001', pin: '123456' }),
      });
      expect(status).toBe(200);
      expect(body.token).toBeDefined();
      expect(body.role).toBe('ADMIN');
      expect(body.name).toBeDefined();
    });

    // This test requires backend redeployment (login-by-name feature)
    it('POST /api/auth/login should allow login by userId', async () => {
      const { status, body } = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: '7cf1994a-4e5d-4603-af7e-475e5043fcde', pin: '1234' }),
      });
      expect(status).toBe(200);
      expect(body.token).toBeDefined();
      expect(body.role).toBe('CASHIER');
    });

    it('POST /api/auth/login should reject wrong PIN', async () => {
      const { status } = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'admin-001', pin: '000000' }),
      });
      expect(status).toBe(401);
    });

    it('POST /api/auth/login should reject missing fields', async () => {
      const { status } = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'admin-001' }),
      });
      expect(status).toBe(400);
    });
  });

  describe('POS Endpoints (Authenticated)', () => {
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

  describe('Admin Endpoints', () => {
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

    it('should reject cashier accessing admin routes', async () => {
      const { body: loginBody } = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: '7cf1994a-4e5d-4603-af7e-475e5043fcde', pin: '1234' }),
      });
      const { status } = await apiFetch('/api/admin/settings', {
        headers: { Authorization: `Bearer ${loginBody.token}` },
      });
      expect(status).toBe(403);
    });
  });

  describe('Order Flow', () => {
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
