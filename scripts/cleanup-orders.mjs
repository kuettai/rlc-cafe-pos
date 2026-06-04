const API = 'https://hcydppml1a.execute-api.ap-southeast-5.amazonaws.com/prod';

async function run() {
  const login = await fetch(API + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId: 'admin-001', pin: '123456' }),
  });
  const { token } = await login.json();

  const res = await fetch(API + '/api/pos/orders', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const data = await res.json();
  const orders = data.orders || data;
  console.log('Active orders:', orders.length);

  for (const o of orders) {
    const id = o.orderId || o.id;
    const s = o.status;
    let endpoint = '';
    if (s === 'PENDING') endpoint = `/api/pos/orders/${id}/reject`;
    else if (s === 'PREPARING') endpoint = `/api/pos/orders/${id}/ready`;
    else if (s === 'READY') endpoint = `/api/pos/orders/${id}/archive`;
    if (endpoint) {
      await fetch(API + endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ reason: 'cleanup' }),
      });
      console.log('Cleaned:', id, s);
    }
  }

  // Second pass for orders that were moved to READY
  const res2 = await fetch(API + '/api/pos/orders', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const data2 = await res2.json();
  const remaining = (data2.orders || data2).filter(o => o.status === 'READY');
  for (const o of remaining) {
    const id = o.orderId || o.id;
    await fetch(API + `/api/pos/orders/${id}/archive`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({}),
    });
    console.log('Archived:', id);
  }

  console.log('All orders cleaned up.');
}

run().catch(e => console.error(e));
