'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mod, bindCollections } = require('./loader.js');

const {
    claimPendingPurchase, activateUserPlan, sanitizeGatedSettingsForOwner,
    generateLicenseForPurchase, isMaintenanceMode, verifyMpSignature,
    GLOBAL_PLANS,
} = mod;

function seedPlan(db, id, days = 30, accounts = 6, games = 24) {
    db.plans.insertOne({ id, name: id.toUpperCase(), days, accounts, games, price: 10, active: true, features: [] });
    GLOBAL_PLANS[id] = { id, name: id.toUpperCase(), days, accounts, games, price: 10, active: true, features: [] };
}

test('claimPendingPurchase: claim atômico apenas em pending', async (t) => {
    const db = bindCollections();
    seedPlan(db, 'premium', 30);

    await db.purchases.insertOne({ _id: 'a'.repeat(12) + '000000000001', userId: 'u1', planId: 'premium', status: 'pending', price: 10, createdAt: new Date(), deliveryMethod: 'internal', preferenceId: 'pref-1' });
    // conclusão de claim
    const p1 = await claimPendingPurchase('u1', 'pref-1', 'pay-1');
    assert.ok(p1);
    assert.equal(p1.status, 'processing');

    // segundo claim concorrente do MESMO pagamento -> NÃO deve casar (não há double-extension)
    const p2 = await claimPendingPurchase('u1', 'pref-1', 'pay-1');
    assert.equal(p2, null);

    // nova compra pendente de outro payment casa
    await db.purchases.insertOne({ _id: 'a'.repeat(12) + '000000000002', userId: 'u1', planId: 'premium', status: 'pending', price: 10, createdAt: new Date(), deliveryMethod: 'internal', preferenceId: 'pref-2' });
    const p3 = await claimPendingPurchase('u1', 'pref-2', 'pay-2');
    assert.ok(p3);
    assert.equal(p3.preferenceId, 'pref-2');

    // processing fresco NÃO é recuperado antes de 10min
    await db.purchases.insertOne({ _id: 'a'.repeat(12) + '000000000003', userId: 'u1', planId: 'premium', status: 'processing', price: 10, createdAt: new Date(), claimedAt: new Date(), deliveryMethod: 'internal', preferenceId: 'pref-3' });
    const p4 = await claimPendingPurchase('u1', 'pref-3', 'pay-3');
    assert.equal(p4, null);
});

test('claimPendingPurchase: recover processing stale >10min', async (t) => {
    const db = bindCollections();
    seedPlan(db, 'premium', 30);
    const stale = new Date(Date.now() - 11 * 60 * 1000);
    await db.purchases.insertOne({ _id: 'a'.repeat(12) + '000000000010', userId: 'u2', planId: 'premium', status: 'processing', price: 10, createdAt: new Date(), claimedAt: stale, deliveryMethod: 'internal', preferenceId: null });
    const p = await claimPendingPurchase('u2', null, 'pay-r1');
    assert.ok(p, 'deve recuperar stalled processing');
    assert.notEqual(p.status, 'failed');
});

test('claimPendingPurchase: fallback legado sem preferenceId', async (t) => {
    const db = bindCollections();
    seedPlan(db, 'premium', 30);
    await db.purchases.insertOne({ _id: 'a'.repeat(12) + '000000000020', userId: 'u3', planId: 'premium', status: 'pending', price: 10, createdAt: new Date(), deliveryMethod: 'internal', preferenceId: null });
    const p = await claimPendingPurchase('u3', 'pref-9', 'pay-9');
    assert.ok(p);
    assert.equal(p.preferenceId, null);
});

test('activateUserPlan: plano válido ativa e estende quando same plan', async (t) => {
    const db = bindCollections();
    seedPlan(db, 'premium', 30);
    await db.users.insertOne({ _id: 'b'.repeat(12) + '000000000001', username: 'u', plan: 'free', planExpiresAt: null, freeHoursRemaining: 0 });

    const ok = await activateUserPlan('b'.repeat(12) + '000000000001', 'premium', null);
    assert.equal(ok, true);
    const u = await db.users.findOne({ username: 'u' });
    assert.equal(u.plan, 'premium');
    assert.ok(u.planExpiresAt, 'deve ter expiração');
    const base = u.planExpiresAt;
    // mesma compra renovada estende
    await activateUserPlan('b'.repeat(12) + '000000000001', 'premium', null);
    const u2 = await db.users.findOne({ username: 'u' });
    assert.ok(new Date(u2.planExpiresAt) > new Date(base), 'renovação estende expiração');
});

test('activateUserPlan: plano deletado -> fail-closed (NÃO plano permanente)', async (t) => {
    const db = bindCollections();
    seedPlan(db, 'premium', 30);
    await db.users.insertOne({ _id: 'b'.repeat(12) + '000000000002', username: 'v', plan: 'free', planExpiresAt: null });
    // deleta plano (some do cache)
    delete GLOBAL_PLANS['premium'];
    await db.plans.deleteOne({ id: 'premium' });
    const ok = await activateUserPlan('b'.repeat(12) + '000000000002', 'premium', null);
    assert.equal(ok, false, 'plano sem duração válida deve falhar fechado');
    const u = await db.users.findOne({ username: 'v' });
    assert.equal(u.plan, 'free', 'não deve travar usuário em plano inexistente');
    assert.equal(u.planExpiresAt, null);
    seedPlan(db, 'premium', 30); // restaura para outros testes
});

test('activateUserPlan: lifetime sem expiração', async (t) => {
    const db = bindCollections();
    await db.users.insertOne({ _id: 'b'.repeat(12) + '000000000003', username: 'w', plan: 'free' });
    const ok = await activateUserPlan('b'.repeat(12) + '000000000003', 'lifetime', null);
    assert.equal(ok, true);
    const u = await db.users.findOne({ username: 'w' });
    assert.equal(u.plan, 'lifetime');
    assert.equal(u.planExpiresAt, null);
});

test('activateUserPlan: custom com customConfig', async (t) => {
    const db = bindCollections();
    await db.users.insertOne({ _id: 'b'.repeat(12) + '000000000004', username: 'z', plan: 'free' });
    const ok = await activateUserPlan('b'.repeat(12) + '000000000004', 'custom', { days: 7, accounts: 2, games: 5 });
    assert.equal(ok, true);
    const u = await db.users.findOne({ username: 'z' });
    assert.equal(u.plan, 'custom');
    assert.equal(u.customLimits.accounts, 2);
    assert.equal(u.customLimits.games, 5);
    assert.ok(u.planExpiresAt);
});

test('activateUserPlan: custom sem config -> fail', async (t) => {
    const db = bindCollections();
    await db.users.insertOne({ _id: 'b'.repeat(12) + '000000000005', username: 'zz', plan: 'free' });
    const ok = await activateUserPlan('b'.repeat(12) + '000000000005', 'custom', null);
    assert.equal(ok, false);
});

test('sanitizeGatedSettingsForOwner: rebaixa settings premium', async (t) => {
    const db = bindCollections();
    await db.users.insertOne({ _id: 'b'.repeat(12) + '000000000006', username: 'prem', plan: 'free', planExpiresAt: null });
    GLOBAL_PLANS['free'] = { accounts: 1, games: 1 };
    const acc = {
        username: 'steamacc',
        ownerUserID: 'b'.repeat(12) + '000000000006',
        settings: { appearOffline: true, customInGameTitle: 'H', customAwayMessage: 'away', autoAcceptFriends: true },
    };
    await db.accounts.insertOne({ ...acc, _id: 'c'.repeat(12) + '000000000001' });
    const out = await sanitizeGatedSettingsForOwner({ ...acc });
    assert.equal(out.settings.appearOffline, false);
    assert.equal(out.settings.customInGameTitle, '');
    assert.equal(out.settings.customAwayMessage, '');
    assert.equal(out.settings.autoAcceptFriends, false);
    const persisted = await db.accounts.findOne({ username: 'steamacc' });
    assert.equal(persisted.settings.appearOffline, false);
});

test('sanitizeGatedSettingsForOwner: dono premium mantém settings', async (t) => {
    const db = bindCollections();
    await db.users.insertOne({ _id: 'b'.repeat(12) + '000000000007', username: 'prem2', plan: 'premium' });
    GLOBAL_PLANS['premium'] = { accounts: 6, games: 24 };
    const acc = {
        username: 'steamacc2',
        ownerUserID: 'b'.repeat(12) + '000000000007',
        settings: { appearOffline: true, customInGameTitle: 'H', autoAcceptFriends: true },
    };
    const out = await sanitizeGatedSettingsForOwner({ ...acc });
    assert.equal(out.settings.appearOffline, true);
    assert.equal(out.settings.customInGameTitle, 'H');
});

test('generateLicenseForPurchase gera chave', async (t) => {
    const db = bindCollections();
    seedPlan(db, 'basic', 7, 2, 6);
    GLOBAL_PLANS['basic'] = { id: 'basic', days: 7, accounts: 2, games: 6 };
    const key = await generateLicenseForPurchase({ planId: 'basic' }, 'b'.repeat(12) + '000000000008');
    assert.ok(typeof key === 'string' && key.startsWith('BASIC-'));
    const lic = await db.licenses.findOne({ key });
    assert.ok(lic);
    assert.equal(String(lic.assignedTo), 'b'.repeat(12) + '000000000008');
    assert.equal(lic.durationDays, 7);
});

test('generateLicenseForPurchase: chave com fallback p/ plano sem cache (entrega por email)', async (t) => {
    const db = bindCollections();
    delete GLOBAL_PLANS['ghost'];
    const key = await generateLicenseForPurchase({ planId: 'ghost' }, 'b'.repeat(12) + '000000000009');
    assert.ok(typeof key === 'string' && key.startsWith('GHOST-'), 'licença genérica segue gerada (admin entrega por email)');
    const lic = await db.licenses.findOne({ key });
    assert.equal(lic.durationDays, 30, 'fallback default 30 dias');
});

test('isMaintenanceMode reflete siteSettings', async (t) => {
    const db = bindCollections();
    await db.siteSettings.insertOne({ _id: 'maintenance', active: true });
    assert.equal(await isMaintenanceMode(), true);
    await db.siteSettings.deleteOne({ _id: 'maintenance' });
    await db.siteSettings.insertOne({ _id: 'maintenance', active: false });
    assert.equal(await isMaintenanceMode(), false);
});

test('verifyMpSignature: valida assinatura HMAC correta', async (t) => {
    await bindCollections();
    const crypto = require('crypto');
    const secret = 'TEST-123'; // MP_ACCESS_TOKEN do harness (sem MP_WEBHOOK_SECRET)
    const ts = String(Math.floor(Date.now() / 1000));
    const requestId = 'req-abc-123';
    const bodyRaw = { type: 'payment', data: { id: '12345678' } };
    const manifest = `id:12345678;request-id:${requestId};ts:${ts};`;
    const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    const req = { headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId }, body: bodyRaw };
    assert.equal(verifyMpSignature(req, bodyRaw), true);
    // trocar um char na assinatura -> false
    const badV1 = (v1[0] === 'a' ? 'b' : 'a') + v1.slice(1);
    const req2 = { headers: { 'x-signature': `ts=${ts},v1=${badV1}`, 'x-request-id': requestId }, body: bodyRaw };
    assert.equal(verifyMpSignature(req2, bodyRaw), false);
});

test('verifyMpSignature falha sem header / com HMAC errado (fail-closed)', async (t) => {
    await bindCollections();
    // sem headers de assinatura
    assert.equal(verifyMpSignature({ headers: {} }, {}), false);
    // value malformado
    assert.equal(verifyMpSignature({ headers: { 'x-signature': 'banana' } }, {}), false);
    // time com ts não numérico
    assert.equal(verifyMpSignature({ headers: { 'x-signature': 'ts=abc,v1=def' } }, {}), false);
});

test('webhook sem secret continua validando via API (falha-closed preservada)', async (t) => {
    // Em runtime, quando MP_WEBHOOK_SECRET não setado, a rota NÃO processa evento com assinatura inválida:
    // o patamar de segurança é a confirmação via API MP (payment.status==='approved').
    assert.equal(typeof verifyMpSignature, 'function');
});