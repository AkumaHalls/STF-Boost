'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mod, bindCollections, callRoute } = require('./loader.js');

const { apiRouter, getClientIp, evaluateReferralRisk, applyReferralBonus, runFraudScan, emitFraudEvent } = mod;

function findRoute(router, method, path) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === path && layer.route.methods[method]) {
            const handlers = layer.route.stack;
            return handlers[handlers.length - 1].handle;
        }
    }
    return null;
}

// ---- NV-2: getClientIp (rate-limit / geo / registro) ----
test('getClientIp: XFF inválido/junk cai para o socket (não dá para rotacionar IP falso)', () => {
    const req = {
        ip: '999.999.999.999',
        headers: { 'x-forwarded-for': '999.999.999.999' },
        socket: { remoteAddress: '203.0.113.7' },
    };
    assert.equal(getClientIp(req), '203.0.113.7');
});

test('getClientIp: sem XFF usa req.ip', () => {
    const req = { ip: '187.32.1.9', headers: {}, socket: { remoteAddress: '203.0.113.8' } };
    assert.equal(getClientIp(req), '187.32.1.9');
});

test('getClientIp: lista XFF usa a entrada validável mais à direita', () => {
    const req = { ip: '3.3.3.3', headers: { 'x-forwarded-for': '1.1.1.1, garbage!!, 3.3.3.3' }, socket: { remoteAddress: '5.5.5.5' } };
    assert.equal(getClientIp(req), '3.3.3.3');
});

test('getClientIp: XFF só com lixo → socket', () => {
    const req = { ip: '2.2.2.2', headers: { 'x-forwarded-for': 'abc,,999.999.999.999' }, socket: { remoteAddress: '198.51.100.4' } };
    assert.equal(getClientIp(req), '198.51.100.4');
});

test('getClientIp: octeto >255 é inválido e cai para o socket', () => {
    const req = { ip: '1.2.3.999', headers: {}, socket: { remoteAddress: '198.51.100.9' } };
    assert.equal(getClientIp(req), '198.51.100.9');
});

test('getClientIp: normaliza IPv6-mapped IPv4', () => {
    const req = { ip: '::ffff:127.0.0.1', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
    assert.equal(getClientIp(req), '127.0.0.1');
});

test('getClientIp: sem ip/socket → fallback 127.0.0.1', () => {
    assert.equal(getClientIp({ headers: {} }), '127.0.0.1');
});

// ---- NV-3: evaluateReferralRisk ----
test('evaluateReferralRisk: mesmo IP do indicador → bloqueado (same-ip)', async () => {
    const db = bindCollections();
    await db.users.insertOne({ _id: 'b'.repeat(12) + '000000000001', username: 'dealer', referralCode: 'DEALER123', registrationIP: '9.9.9.9' });
    const referrer = await db.users.findOne({ referralCode: 'DEALER123' });
    const r = await evaluateReferralRisk({ referrer, ip: '9.9.9.9', invitedUsername: 'nova' });
    assert.equal(r.blocked, true);
    assert.ok(r.flags.includes('same-ip'));
});

test('evaluateReferralRisk: IP já usado por outro indicado (anel/chain) → bloqueado (ring-ip)', async () => {
    const db = bindCollections();
    const uid = 'c'.repeat(12) + '000000000001';
    await db.users.insertOne({ _id: uid, username: 'dealer2', referralCode: 'DEALER222', registrationIP: '5.5.5.5' });
    await db.referrals.insertOne({ inviterUserId: uid, referrerUsername: 'dealer2', invitedUsername: 'fulano', ip: '6.6.6.6', status: 'credited', createdAt: new Date() });
    const referrer = await db.users.findOne({ referralCode: 'DEALER222' });
    const r = await evaluateReferralRisk({ referrer, ip: '6.6.6.6', invitedUsername: 'beltrano' });
    assert.equal(r.blocked, true);
    assert.ok(r.flags.includes('ring-ip'));
});

test('evaluateReferralRisk: indicador banido → bloqueado', async () => {
    const db = bindCollections();
    await db.users.insertOne({ _id: 'd'.repeat(12) + '000000000001', username: 'bannedref', referralCode: 'BANNED111', isBanned: true });
    const referrer = await db.users.findOne({ referralCode: 'BANNED111' });
    const r = await evaluateReferralRisk({ referrer, ip: '8.8.8.8', invitedUsername: 'nova' });
    assert.equal(r.blocked, true);
    assert.ok(r.flags.includes('referrer-banned'));
});

test('evaluateReferralRisk: IP diferente e indicador ativo → liberado', async () => {
    const db = bindCollections();
    await db.users.insertOne({ _id: 'e'.repeat(12) + '000000000001', username: 'limpa', referralCode: 'LIMPA1234', registrationIP: '4.4.4.4', isBanned: false });
    const referrer = await db.users.findOne({ referralCode: 'LIMPA1234' });
    const r = await evaluateReferralRisk({ referrer, ip: '8.8.8.8', invitedUsername: 'nova' });
    assert.equal(r.blocked, false);
});

// ---- NV-3: register integração (self-farming) ----
test('register com MESMO IP do indicador: sem bônus e sem cupom, ledger suspicious + evento', async () => {
    const db = bindCollections();
    db.users.docs = [];
    const referrerId = 'f'.repeat(12) + '000000000001';
    await db.users.insertOne({ _id: referrerId, username: 'dealer', referralCode: 'DEALER123', referralCount: 0, registrationIP: '9.9.9.9' });
    const handler = findRoute(apiRouter, 'post', '/register');
    const r = await callRoute(handler, 'post', {
        body: { username: 'novafake', email: 'novafake@mail.com', password: 'Senha1234', ref: 'dealer123' },
        ip: '9.9.9.9',
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.bonusHours, 0, 'sem horas bônus quando fraude');
    const invited = await db.users.findOne({ username: 'novafake' });
    assert.equal(invited.bonusHoursRemaining, 0);
    const refUser = await db.users.findOne({ username: 'dealer' });
    assert.equal(refUser.referralCount, 0, 'indicador NÃO recebe crédito');
    assert.equal((await (await db.coupons.find({})).toArray()).length, 0, 'nenhum cupom gerado');
    const ledger = await db.referrals.findOne({ invitedUsername: 'novafake' });
    assert.ok(ledger, 'registrado no ledger');
    assert.equal(ledger.status, 'suspicious');
    const evt = await db.fraudEvents.findOne({ type: 'referral' });
    assert.ok(evt, 'evento de fraude criado');
});

test('register com ref de OUTRO IP: bônus mantido (regressão F-normal)', async () => {
    const db = bindCollections();
    db.users.docs = [];
    await db.users.insertOne({ _id: 'a2'.repeat(6) + '000000000001', username: 'refmaster', referralCode: 'REFCODE1', referralCount: 0, registrationIP: '5.5.5.5' });
    const handler = findRoute(apiRouter, 'post', '/register');
    const r = await callRoute(handler, 'post', {
        body: { username: 'novinh0', email: 'novinh0@mail.com', password: 'Senha1234', ref: 'refcode1' },
        ip: '9.9.9.9',
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.bonusHours, 10);
    const u = await db.users.findOne({ username: 'novinh0' });
    assert.equal(u.bonusHoursRemaining, 10 * 60 * 60 * 1000);
    assert.equal((await db.users.findOne({ username: 'refmaster' })).referralCount, 1);
    const coupon = await db.coupons.findOne({ code: 'REF-REFCODE1-001' });
    assert.ok(coupon, 'cupom validado para indicação legítima');
    const ledger = await db.referrals.findOne({ invitedUsername: 'novinh0' });
    assert.equal(ledger.status, 'credited');
});

// ---- Watchdog: sistema ----
test('emitFraudEvent: dedupe por signature (não duplica evento aberto)', async () => {
    const db = bindCollections();
    const e1 = await emitFraudEvent({ evtSig: 'test:dedupe', type: 'system', severity: 'low', message: 'm1', refUser: 'x', refTarget: null, ip: null, riskFlags: [] });
    const e2 = await emitFraudEvent({ evtSig: 'test:dedupe', type: 'system', severity: 'low', message: 'm2', refUser: 'x', refTarget: null, ip: null, riskFlags: [] });
    assert.equal(e2._id, e1._id, 'mesmo evento retornado');
    assert.equal(await db.fraudEvents.countDocuments({ signature: 'test:dedupe' }), 1);
});

test('runFraudScan: detecta anel de IPs (3+ contas) e indicador com pico, com dedupe', async () => {
    const db = bindCollections();
    db.fraudEvents.docs = [];
    // anel: 3 usuários no mesmo IP
    for (let i = 0; i < 3; i++) {
        await db.users.insertOne({ _id: String(i + 1).padStart(11, '0') + 'a'.repeat(13), username: `ipu${i}`, registrationIP: '5.6.7.8' });
    }
    // pico: 10 indicações creditadas em 24h do mesmo indicador
    for (let i = 0; i < 10; i++) {
        await db.referrals.insertOne({ inviterUserId: 'z'.repeat(24), referrerUsername: 'topref', invitedUsername: `cara${i}`, code: 'X1', ip: '8.8.8.8', status: 'credited', createdAt: new Date(Date.now() - 60000) });
    }

    await runFraudScan();
    const ring = await db.fraudEvents.findOne({ signature: 'system:ip-ring:5.6.7.8' });
    assert.ok(ring, 'evento do anel criado');
    const burst = await db.fraudEvents.findOne({ signature: 'system:referral-burst:topref' });
    assert.ok(burst, 'evento do pico criado');

    await runFraudScan();
    assert.equal(await db.fraudEvents.countDocuments({ signature: 'system:ip-ring:5.6.7.8' }), 1, 'sem duplicar no 2o scan');
    assert.equal(await db.fraudEvents.countDocuments({ signature: 'system:referral-burst:topref' }), 1);
});

test('applyReferralBonus: caminho direto segue funcionando para referência legítima', async () => {
    const db = bindCollections();
    await db.users.insertOne({ _id: 'g'.repeat(12) + '000000000001', username: 'direta', referralCode: 'DIRETA11', referralCount: 0 });
    const res = await applyReferralBonus('novoca2', 'direta11', { ip: '8.8.8.8', invitedUsername: 'novoca2' });
    assert.equal(res.credited, true);
    const ref = await db.users.findOne({ username: 'direta' });
    assert.equal(ref.referralCount, 1);
    assert.equal(ref.bonusHoursRemaining, 10 * 60 * 60 * 1000);
    const coupon = await db.coupons.findOne({ code: 'REF-DIRETA11-001' });
    assert.ok(coupon);
});

test('register com indicador BANIDO: sem bônus, ledger suspicious + evento', async () => {
    const db = bindCollections();
    db.users.docs = [];
    await db.users.insertOne({ _id: 'b'.repeat(12) + '000000000001', username: 'banidoind', referralCode: 'BANIDO12', referralCount: 0, isBanned: true, registrationIP: '7.7.7.7' });
    const handler = findRoute(apiRouter, 'post', '/register');
    const r = await callRoute(handler, 'post', {
        body: { username: 'novoban', email: 'novoban@mail.com', password: 'Senha1234', ref: 'banido12' },
        ip: '9.9.9.9',
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.bonusHours, 0, 'indicador banido não gera bônus');
    assert.equal((await db.users.findOne({ username: 'banidoind' })).referralCount, 0);
    const ledger = await db.referrals.findOne({ invitedUsername: 'novoban' });
    assert.equal(ledger.status, 'suspicious');
    assert.ok(ledger.riskFlags.includes('referrer-banned'));
    assert.ok(await db.fraudEvents.findOne({ type: 'referral' }));
});

test('register com ANEL de IP (mesmo inviter já usou o IP): bloqueia bônus', async () => {
    const db = bindCollections();
    db.users.docs = [];
    const referrerId = 'e'.repeat(12) + '000000000001';
    await db.users.insertOne({ _id: referrerId, username: 'anelind', referralCode: 'ANELED11', referralCount: 0, registrationIP: '3.3.3.3' });
    // indicado anterior já registrou no MESMO IP (ledger) → qualquer novo indicado do mesmo inviter nesse IP é anel
    await db.referrals.insertOne({ inviterUserId: referrerId, referrerUsername: 'anelind', invitedUsername: 'antigo', code: 'ANELED11', ip: '6.6.6.6', status: 'credited', createdAt: new Date() });
    const handler = findRoute(apiRouter, 'post', '/register');
    const r = await callRoute(handler, 'post', {
        body: { username: 'novoanelo', email: 'novoanelo@mail.com', password: 'Senha1234', ref: 'aneled11' },
        ip: '6.6.6.6',
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.bonusHours, 0, 'anel de IP bloqueia bônus');
    const ledger = await db.referrals.findOne({ invitedUsername: 'novoanelo' });
    assert.ok(ledger.riskFlags.includes('ring-ip'));
});