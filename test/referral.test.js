'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mod, bindCollections, callRoute } = require('./loader.js');

const {
    apiRouter, liveAccounts, decrypt,
    applyReferralBonus, deductFreeTime, publicSettings,
    releaseCouponReservation, releaseStaleCouponReservations,
    accountTotalFarmedMs, verifyMpSignature,
} = mod;

function findRoute(router, method, path) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === path && layer.route.methods[method]) {
            const handlers = layer.route.stack;
            return handlers[handlers.length - 1].handle;
        }
    }
    return null;
}

function clearLiveAccounts() {
    for (const k of Object.keys(liveAccounts)) delete liveAccounts[k];
}

test('applyReferralBonus: bônus separado + contador e cupom atômicos', async (t) => {
    const db = bindCollections();
    await db.users.insertOne({ _id: 'a'.repeat(12) + '000000000001', username: 'indicador', referralCode: 'ABCD1234', referralCount: 0 });

    await applyReferralBonus('novoca2', 'abcd1234');
    const ref = await db.users.findOne({ username: 'indicador' });
    assert.equal(ref.referralCount, 1);
    assert.equal(ref.bonusHoursRemaining, 10 * 60 * 60 * 1000);
    assert.equal(ref.freeHoursRemaining, undefined, 'bônus NÃO deve ser gravado em freeHoursRemaining');

    const coupon = await db.coupons.findOne({ code: 'REF-ABCD1234-001' });
    assert.ok(coupon, 'cupom criado com contador atualizado');
    assert.equal(coupon.maxUses, 1);
    assert.equal(coupon.discount, 15);
    assert.equal(coupon.ownerUserId, ref._id.toString(), 'cupom amarrado ao dono');

    await applyReferralBonus('outro2', 'ABCD1234');
    const ref2 = await db.users.findOne({ username: 'indicador' });
    assert.equal(ref2.referralCount, 2);
    assert.equal(ref2.bonusHoursRemaining, 2 * 10 * 60 * 60 * 1000);
    assert.ok(await db.coupons.findOne({ code: 'REF-ABCD1234-002' }));
});

test('register com ref válido: free preservado + bonusHoursRemaining separado', async (t) => {
    const db = bindCollections();
    db.users.docs = [];
    await db.users.insertOne({ _id: 'b'.repeat(12) + '000000000001', username: 'refmaster', referralCode: 'REFCODE1', referralCount: 0 });
    const handler = findRoute(apiRouter, 'post', '/register');
    const ok = await callRoute(handler, 'post', {
        body: { username: 'novinh0', email: 'novinh0@mail.com', password: 'Senha1234', ref: 'refcode1' },
        ip: '9.9.9.9',
    });
    assert.equal(ok.status, 201);
    const u = await db.users.findOne({ username: 'novinh0' });
    assert.equal(u.freeHoursRemaining, 50 * 60 * 60 * 1000);
    assert.equal(u.bonusHoursRemaining, 10 * 60 * 60 * 1000);
    assert.equal((await db.users.findOne({ username: 'refmaster' })).referralCount, 1);
});

test('register rejeita código de indicação malformado (REFERRAL_CODE_RE)', async (t) => {
    const db = bindCollections();
    db.users.docs = [];
    const handler = findRoute(apiRouter, 'post', '/register');
    const bad = await callRoute(handler, 'post', {
        body: { username: 'semref00', email: 'semref00@mail.com', password: 'Senha1234', ref: 'tl!' },
        ip: '9.9.9.8',
    });
    assert.equal(bad.status, 400);
    const tooShort = await callRoute(handler, 'post', {
        body: { username: 'semref01', email: 'semref01@mail.com', password: 'Senha1234', ref: 'ABC1' },
        ip: '9.9.9.7',
    });
    assert.equal(tooShort.status, 400);
});

test('validate-coupon: cupom de indicação só vale para o dono (F4)', async (t) => {
    const db = bindCollections();
    await db.coupons.insertOne({ code: 'MEU-REF1', discount: 15, usageCount: 0, maxUses: 1, ownerUserId: 'ownerX', expiresAt: new Date(Date.now() + 86400000) });
    const handler = findRoute(apiRouter, 'post', '/validate-coupon');
    const owner = await callRoute(handler, 'post', { session: { userId: 'ownerX' }, body: { code: 'meu-ref1' } });
    assert.equal(owner.body.valid, true);
    const intruder = await callRoute(handler, 'post', { session: { userId: 'otherY' }, body: { code: 'meu-ref1' } });
    assert.equal(intruder.body.valid, false);
    assert.match(intruder.body.message, /não é seu/);
});

test('create-checkout: reserva atômica de cupom (maxUses=1 → 1 checkout apenas)', async (t) => {
    const db = bindCollections();
    clearLiveAccounts();
    const uid = 'c'.repeat(12) + '000000000001';
    await db.users.insertOne({ _id: uid, username: 'comprador', email: 'compra@mail.com', plan: 'free', freeHoursRemaining: 0 });
    mod.GLOBAL_PLANS['premium'] = { id: 'premium', name: 'Premium', days: 30, accounts: 6, games: 24, price: 27.90, price_usd: 9.99, active: true };
    await db.coupons.insertOne({ code: 'USEONCE', discount: 10, usageCount: 0, maxUses: 1, expiresAt: new Date(Date.now() + 86400000) });
    const handler = findRoute(apiRouter, 'post', '/create-checkout');
    const baseReq = { session: { userId: uid, username: 'comprador' }, body: { planId: 'premium', couponCode: 'useonce' }, ip: '187.1.1.1' };

    const r1 = await callRoute(handler, 'post', baseReq);
    assert.equal(r1.status, 200, 'primeiro checkout reserva o cupom');
    assert.ok(r1.body.url);
    const c1 = await db.coupons.findOne({ code: 'USEONCE' });
    assert.equal(c1.usageCount, 1, 'reserva incrementou atomicamente');
    const p = await db.purchases.findOne({ userId: uid, couponCode: 'USEONCE' });
    assert.equal(p.couponReserved, true);
    assert.equal(p.price, 25.11, 'preço aplica desconto de 10% sobre 27.90');

    const r2 = await callRoute(handler, 'post', baseReq);
    assert.equal(r2.status, 400, 'segundo checkout com maxUses=1 deve ser recusado (reserva atômica)');
    const c2 = await db.coupons.findOne({ code: 'USEONCE' });
    assert.equal(c2.usageCount, 1, 'nenhuma reserva extra');
    delete mod.GLOBAL_PLANS['premium'];
});

test('deductFreeTime: consome bônus antes do fim do free, sem duplo consumo na rodada', async (t) => {
    const db = bindCollections();
    clearLiveAccounts();
    const uidA = 'd'.repeat(12) + '000000000001';
    const uidB = 'd'.repeat(12) + '000000000002';
    await db.users.insertOne({ _id: uidA, username: 'grattis', plan: 'free', freeHoursRemaining: 60000, bonusHoursRemaining: 60000 });
    await db.users.insertOne({ _id: uidB, username: 'bonus', plan: 'free', freeHoursRemaining: 0, bonusHoursRemaining: 60000 });
    liveAccounts['accA'] = { ownerUserID: uidA, status: 'Rodando' };
    liveAccounts['accB'] = { ownerUserID: uidB, status: 'Rodando' };

    await deductFreeTime();

    const a = await db.users.findOne({ _id: uidA });
    assert.equal(a.freeHoursRemaining, 0, 'grátis consumido');
    assert.equal(a.bonusHoursRemaining, 60000, 'bônus intacto enquanto havia grátis');
    const b = await db.users.findOne({ _id: uidB });
    assert.equal(b.bonusHoursRemaining, 0, 'bônus consumido pois grátis estava esgotado');
});

test('publicSettings: sharedSecret nunca sai; expõe hasSharedSecret', async (t) => {
    const out = publicSettings({ appearOffline: true, sharedSecret: 'segredo' });
    assert.equal(out.appearOffline, true);
    assert.equal(out.hasSharedSecret, true);
    assert.equal('sharedSecret' in out, false);
    assert.equal(publicSettings({ appearOffline: false }).hasSharedSecret, undefined);
});

test('save-settings: cifra sharedSecret antes de persistir; vazio mantém o salvo', async (t) => {
    const db = bindCollections();
    clearLiveAccounts();
    mod.__setAppSecretKey('0123456789abcdef0123456789abcdef');
    const uid = 'g'.repeat(12) + '000000000001';
    await db.users.insertOne({ _id: uid, username: 'dono', plan: 'free' });
    await db.accounts.insertOne({ _id: 'h'.repeat(12) + '000000000001', username: 'steamx', ownerUserID: uid, settings: {} });
    liveAccounts['steamx'] = { username: 'steamx', ownerUserID: uid, settings: {} };
    const handler = findRoute(apiRouter, 'post', '/save-settings/:username');

    const r = await callRoute(handler, 'post', { params: { username: 'steamx' }, session: { userId: uid }, body: { settings: { sharedSecret: 'SECRET1234567890' } } });
    assert.equal(r.status, 200);
    const acc = await db.accounts.findOne({ username: 'steamx' });
    assert.ok(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/.test(acc.settings.sharedSecret), 'armazenado cifrado');
    assert.equal(decrypt(acc.settings.sharedSecret), 'SECRET1234567890');
    assert.equal(liveAccounts['steamx'].settings.hasSharedSecret, undefined, 'em memória segue cifrado');

    const r2 = await callRoute(handler, 'post', { params: { username: 'steamx' }, session: { userId: uid }, body: { settings: { sharedSecret: '' } } });
    assert.equal(r2.status, 200);
    const acc2 = await db.accounts.findOne({ username: 'steamx' });
    assert.equal(decrypt(acc2.settings.sharedSecret), 'SECRET1234567890', 'vazio NÃO apaga o secret existente');
    mod.__setAppSecretKey(undefined);
});

test('releaseCouponReservation: libera sem duplo decremento', async (t) => {
    const db = bindCollections();
    const pid = 'e'.repeat(12) + '000000000001';
    await db.purchases.insertOne({ _id: pid, userId: 'u1', status: 'failed', couponCode: 'COUP', couponReserved: true });
    await db.coupons.insertOne({ code: 'COUP', usageCount: 5, maxUses: 10 });
    await releaseCouponReservation(pid, 'COUP');
    let c = await db.coupons.findOne({ code: 'COUP' });
    assert.equal(c.usageCount, 4);
    let p = await db.purchases.findOne({ _id: pid });
    assert.equal(p.couponReleased, true);
    assert.equal(p.couponReserved, undefined);
    await releaseCouponReservation(pid, 'COUP');
    c = await db.coupons.findOne({ code: 'COUP' });
    assert.equal(c.usageCount, 4, 'segunda chamada é no-op');
});

test('releaseStaleCouponReservations: libera pendentes >24h, mantém frescos', async (t) => {
    const db = bindCollections();
    const pidOld = 'f'.repeat(12) + '000000000001';
    const pidNew = 'f'.repeat(12) + '000000000002';
    await db.purchases.insertOne({ _id: pidOld, userId: 'u1', status: 'pending', couponCode: 'STALE', couponReserved: true, createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) });
    await db.purchases.insertOne({ _id: pidNew, userId: 'u1', status: 'pending', couponCode: 'FRESH', couponReserved: true, createdAt: new Date() });
    await db.coupons.insertOne({ code: 'STALE', usageCount: 1 });
    await db.coupons.insertOne({ code: 'FRESH', usageCount: 1 });
    await releaseStaleCouponReservations();
    assert.equal((await db.coupons.findOne({ code: 'STALE' })).usageCount, 0);
    assert.equal((await db.coupons.findOne({ code: 'FRESH' })).usageCount, 1);
});

test('accountTotalFarmedMs: soma sessão ativa; sem farmStartTime não soma a mais', async (t) => {
    assert.equal(accountTotalFarmedMs({ totalFarmedMs: 1000, farmedMs: 500, farmStartTime: null }), 1500);
    const running = { totalFarmedMs: 0, farmedMs: 0, farmStartTime: Date.now() - 2000 };
    const tot = accountTotalFarmedMs(running);
    assert.ok(tot >= 2000 && tot <= 2500, `sessão ativa conta no total (${tot})`);
});

test('verifyMpSignature: ts antigo >10min é recusado (anti-replay F5)', async (t) => {
    await bindCollections();
    const crypto = require('crypto');
    const secret = 'TEST-123';
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    const requestId = 'req-old';
    const bodyRaw = { type: 'payment', data: { id: '999' } };
    const manifest = `id:999;request-id:${requestId};ts:${ts};`;
    const v1 = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    const req = { headers: { 'x-signature': `ts=${ts},v1=${v1}`, 'x-request-id': requestId }, body: bodyRaw };
    assert.equal(verifyMpSignature(req, bodyRaw), false);
});