import { createHarness, STRONG_PASSWORD, type TestHarness } from './harness.js';

let harness: TestHarness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await harness.reset();
});

async function registerCustomer(email: string): Promise<string> {
  const response = await harness.http().post('/api/v1/auth/register').send({
    email,
    password: STRONG_PASSWORD,
    firstName: 'Test',
    lastName: 'Customer',
    acceptsTerms: true,
  });
  return response.body.accessToken as string;
}

const address = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  line1: '350 Fifth Avenue',
  city: 'New York',
  region: 'NY',
  postalCode: '10118',
};

describe('customer profile', () => {
  it('returns the signed-in customer’s own profile with a readable reference', async () => {
    const token = await registerCustomer('one@example.test');
    const response = await harness
      .http()
      .get('/api/v1/me/profile')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.email).toBe('one@example.test');
    expect(response.body.reference).toMatch(/^HC-\d{6}$/);
  });

  it('updates name and phone', async () => {
    const token = await registerCustomer('one@example.test');
    const response = await harness
      .http()
      .patch('/api/v1/me/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ firstName: 'Augusta', phone: '+12125550123' });

    expect(response.status).toBe(200);
    expect(response.body.firstName).toBe('Augusta');
    expect(response.body.phone).toBe('+12125550123');
  });

  it('rejects a phone number that is not in international format', async () => {
    const token = await registerCustomer('one@example.test');
    const response = await harness
      .http()
      .patch('/api/v1/me/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ phone: '(212) 555-0123' });
    expect(response.status).toBe(400);
  });

  it('appends every marketing preference change to the consent ledger', async () => {
    const token = await registerCustomer('one@example.test');

    await harness
      .http()
      .put('/api/v1/me/preferences/marketing')
      .set('Authorization', `Bearer ${token}`)
      .send({ acceptsMarketingEmail: true, acceptsMarketingSms: false });

    await harness
      .http()
      .put('/api/v1/me/preferences/marketing')
      .set('Authorization', `Bearer ${token}`)
      .send({ acceptsMarketingEmail: false, acceptsMarketingSms: false });

    const consents = await harness
      .http()
      .get('/api/v1/me/consents')
      .set('Authorization', `Bearer ${token}`);

    const emailConsents = consents.body.data.filter(
      (c: { type: string }) => c.type === 'MARKETING_EMAIL',
    );
    // Registration (false), opt in (true), opt out (false) — all three retained.
    expect(emailConsents).toHaveLength(3);
    expect(emailConsents.map((c: { granted: boolean }) => c.granted)).toEqual([false, true, false]);
  });

  it('is not reachable by a staff account', async () => {
    const role = await harness.prisma.role.findUniqueOrThrow({ where: { key: 'ANALYST' } });
    const { hashPassword, PASSWORD_ALGORITHM_ID } = await import('@health/auth');
    await harness.prisma.user.create({
      data: {
        email: 'analyst@example.test',
        emailNormalized: 'analyst@example.test',
        passwordHash: await hashPassword(STRONG_PASSWORD),
        passwordAlgorithm: PASSWORD_ALGORITHM_ID,
        type: 'STAFF',
        status: 'ACTIVE',
        roles: { create: { roleId: role.id } },
      },
    });
    const login = await harness
      .http()
      .post('/api/v1/auth/login')
      .send({ email: 'analyst@example.test', password: STRONG_PASSWORD });

    const response = await harness
      .http()
      .get('/api/v1/me/profile')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(response.status).toBe(403);
  });
});

describe('customer addresses', () => {
  it('makes the first saved address the default for both shipping and billing', async () => {
    const token = await registerCustomer('one@example.test');
    const response = await harness
      .http()
      .post('/api/v1/me/addresses')
      .set('Authorization', `Bearer ${token}`)
      .send(address);

    expect(response.status).toBe(201);
    expect(response.body.isDefaultShipping).toBe(true);
    expect(response.body.isDefaultBilling).toBe(true);
  });

  it('moves the default rather than ending up with two', async () => {
    const token = await registerCustomer('one@example.test');
    await harness
      .http()
      .post('/api/v1/me/addresses')
      .set('Authorization', `Bearer ${token}`)
      .send(address);

    const second = await harness
      .http()
      .post('/api/v1/me/addresses')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...address, line1: '1 Infinite Loop', isDefaultShipping: true });

    expect(second.body.isDefaultShipping).toBe(true);

    const list = await harness
      .http()
      .get('/api/v1/me/addresses')
      .set('Authorization', `Bearer ${token}`);
    const defaults = list.body.data.filter(
      (a: { isDefaultShipping: boolean }) => a.isDefaultShipping,
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0].line1).toBe('1 Infinite Loop');
  });

  it('refuses a non-US destination and an invalid ZIP', async () => {
    const token = await registerCustomer('one@example.test');

    const international = await harness
      .http()
      .post('/api/v1/me/addresses')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...address, country: 'CA' });
    expect(international.status).toBe(400);

    const badZip = await harness
      .http()
      .post('/api/v1/me/addresses')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...address, postalCode: 'SW1A 1AA' });
    expect(badZip.status).toBe(400);
  });

  it('soft-deletes and promotes a replacement default', async () => {
    const token = await registerCustomer('one@example.test');
    const first = await harness
      .http()
      .post('/api/v1/me/addresses')
      .set('Authorization', `Bearer ${token}`)
      .send(address);
    await harness
      .http()
      .post('/api/v1/me/addresses')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...address, line1: '1 Infinite Loop' });

    const removed = await harness
      .http()
      .delete(`/api/v1/me/addresses/${first.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(removed.status).toBe(204);

    // Retained for order history, hidden from the address book.
    const row = await harness.prisma.customerAddress.findUniqueOrThrow({
      where: { id: first.body.id },
    });
    expect(row.deletedAt).not.toBeNull();

    const list = await harness
      .http()
      .get('/api/v1/me/addresses')
      .set('Authorization', `Bearer ${token}`);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].isDefaultShipping).toBe(true);
  });

  it('never exposes another customer’s address', async () => {
    const alice = await registerCustomer('alice@example.test');
    const bob = await registerCustomer('bob@example.test');

    const aliceAddress = await harness
      .http()
      .post('/api/v1/me/addresses')
      .set('Authorization', `Bearer ${alice}`)
      .send(address);

    // Bob's list must not contain it...
    const bobList = await harness
      .http()
      .get('/api/v1/me/addresses')
      .set('Authorization', `Bearer ${bob}`);
    expect(bobList.body.data).toHaveLength(0);

    // ...and addressing it directly must look like it does not exist, rather
    // than confirming its existence with a 403.
    const read = await harness
      .http()
      .patch(`/api/v1/me/addresses/${aliceAddress.body.id}`)
      .set('Authorization', `Bearer ${bob}`)
      .send({ city: 'Hijacked' });
    expect(read.status).toBe(404);

    const deletion = await harness
      .http()
      .delete(`/api/v1/me/addresses/${aliceAddress.body.id}`)
      .set('Authorization', `Bearer ${bob}`);
    expect(deletion.status).toBe(404);

    const untouched = await harness.prisma.customerAddress.findUniqueOrThrow({
      where: { id: aliceAddress.body.id },
    });
    expect(untouched.city).toBe('New York');
    expect(untouched.deletedAt).toBeNull();
  });

  it('rejects a malformed address id without reaching the database', async () => {
    const token = await registerCustomer('one@example.test');
    const response = await harness
      .http()
      .delete('/api/v1/me/addresses/not-a-uuid')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(400);
  });
});
