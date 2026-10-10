'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mod, bindCollections, callRoute } = require('./loader.js');

const { adminApiRouter, isAdminAuthenticated } = mod;

function findRoute(router, method, path) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === path && layer.route.methods[method]) {
            const handlers = layer.route.stack;
            return handlers[handlers.length - 1].handle;
        }
    }
    return null;
}

function makeSession(over = {}) {
    return {
        regenerate: (cb) => cb(null),
        destroy: (cb) => cb(null),
        ...over,
    };
}

test('isAdminAuthenticated: sem sessão admin → 401 na API', async () => {
    const res = await callRoute(isAdminAuthenticated, 'mw', {
        baseUrl: '/api/admin',
        originalUrl: '/api/admin/users',
        session: makeSession({}),
    });
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { message: 'unauthorized' });
});

test('gate admin: middleware isAdminAuthenticated precede as rotas de referral/fraude', () => {
    const mwIdx = adminApiRouter.stack.findIndex(l => l.handle === isAdminAuthenticated);
    assert.ok(mwIdx >= 0, 'middleware de gate montado no router admin');
    for (const p of ['/referrals', '/referrals/stats', '/fraud-alerts']) {
        const rIdx = adminApiRouter.stack.findIndex(l => l.route && l.route.path === p);
        assert.ok(rIdx > mwIdx, `rota ${p} vem depois do gate de admin`);
    }
});

test('GET /api/admin/referrals: listagem paginada com filtro por status', async () => {
    const db = bindCollections();
    await db.referrals.insertOne({ inviterUserId: 'a'.repeat(24), referrerUsername: 'r1', invitedUsername: 'x1', code: 'AAA11111', ip: '1.1.1.1', status: 'suspicious', riskFlags: ['same-ip'], createdAt: new Date() });
    await db.referrals.insertOne({ inviterUserId: 'b'.repeat(24), referrerUsername: 'r2', invitedUsername: 'x2', code: 'BBB22222', ip: '2.2.2.2', status: 'credited', riskFlags: [], createdAt: new Date() });

    const handler = findRoute(adminApiRouter, 'get', '/referrals');
    const all = await callRoute(handler, 'get', { query: { page: 1, limit: 10 } });
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 2);
    assert.equal(all.body.referrals.length, 2);
    assert.equal(all.body.totalPages, 1);

    const sus = await callRoute(handler, 'get', { query: { page: 1, limit: 10, status: 'suspicious' } });
    assert.equal(sus.body.total, 1);
    assert.equal(sus.body.referrals[0].status, 'suspicious');
});

test('GET /api/admin/referrals/stats: totais e top indicadores', async () => {
    const db = bindCollections();
    await db.referrals.insertOne({ inviterUserId: 'a'.repeat(24), referrerUsername: 'top1', invitedUsername: 'x1', code: 'A1', ip: '1.1.1.1', status: 'credited', createdAt: new Date() });
    await db.referrals.insertOne({ inviterUserId: 'c'.repeat(24), referrerUsername: 'top1', invitedUsername: 'x2', code: 'A2', ip: '1.1.1.2', status: 'credited', createdAt: new Date() });
    await db.referrals.insertOne({ inviterUserId: 'd'.repeat(24), referrerUsername: 'sus', invitedUsername: 'x3', code: 'A3', ip: '1.1.1.3', status: 'suspicious', riskFlags: ['same-ip'], createdAt: new Date() });

    const handler = findRoute(adminApiRouter, 'get', '/referrals/stats');
    const r = await callRoute(handler, 'get', { query: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 3);
    assert.equal(r.body.credited, 2);
    assert.equal(r.body.suspicious, 1);
    assert.equal(r.body.topReferrers[0].username, 'top1');
    assert.equal(r.body.topReferrers[0].count, 2);
});

test('GET /api/admin/fraud-alerts + POST ack: fluxo de alerta', async () => {
    const db = bindCollections();
    const evtA = await db.fraudEvents.insertOne({ type: 'referral', severity: 'high', message: 'bloqueio', refUser: 'r1', refTarget: 'x1', ip: '9.9.9.9', riskFlags: ['same-ip'], signature: 's1', status: 'open', createdAt: new Date() });
    await db.fraudEvents.insertOne({ type: 'system', severity: 'medium', message: 'anel', refUser: 'r2', refTarget: null, ip: '5.6.7.8', riskFlags: [], signature: 's2', status: 'open', createdAt: new Date() });

    const listHandler = findRoute(adminApiRouter, 'get', '/fraud-alerts');
    const list = await callRoute(listHandler, 'get', { query: {} });
    assert.equal(list.status, 200);
    assert.equal(list.body.totalOpen, 2);
    assert.equal(list.body.alerts.length, 2);

    const ackHandler = findRoute(adminApiRouter, 'post', '/fraud-alerts/:id/ack');
    const ack = await callRoute(ackHandler, 'post', { params: { id: evtA.insertedId }, body: {} });
    assert.equal(ack.status, 200);
    const after = await db.fraudEvents.findOne({ _id: evtA.insertedId });
    assert.equal(after.status, 'acked');
    assert.ok(after.ackedAt);
});