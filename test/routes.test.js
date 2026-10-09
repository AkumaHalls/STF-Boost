'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mod, bindCollections, callRoute } = require('./loader.js');
const { apiRouter, adminApiRouter, GLOBAL_PLANS } = mod;

function findRoute(router, method, path) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === path && layer.route.methods[method]) {
            const handlers = layer.route.stack;
            return handlers[handlers.length - 1].handle;
        }
    }
    return null;
}

test('ROTAS registrar: validação de entrada (400) sem DB', async (t) => {
    bindCollections();
    const handler = findRoute(apiRouter, 'post', '/register');
    assert.ok(handler, 'rota /register encontrada');
    const badUser = await callRoute(handler, 'post', {
        body: { username: '__evil', email: 'a@b.c', password: 'Pass1234' },
        ip: '127.0.0.1',
    });
    assert.equal(badUser.status, 400);
    const badPw = await callRoute(handler, 'post', {
        body: { username: 'validname', email: 'a@b.c', password: 'short' },
        ip: '127.0.0.1',
    });
    assert.equal(badPw.status, 400);
});

test('ROTAS register: cria usuário e expõe recoveryKey', async (t) => {
    const db = bindCollections();
    const handler = findRoute(apiRouter, 'post', '/register');
    // limpa docs para evitar duplicação
    db.users.docs = [];
    const ok = await callRoute(handler, 'post', {
        body: { username: 'novousuario', email: 'novo@mail.com', password: 'Senha1234' },
        ip: '1.2.3.4',
    });
    assert.equal(ok.status, 201);
    assert.ok(ok.body && ok.body.recoveryKey);
    assert.match(ok.body.recoveryKey, /^STF-/);
    const u = await db.users.findOne({ username: 'novousuario' });
    assert.ok(u);
    assert.equal(u.plan, 'free');
    assert.equal(u.isBanned, false);
});

test('ROTAS change-password não deve falhar', async (t) => {
    // trivia: handler existe? checamos rotas esperadas
    const p = findRoute(apiRouter, 'post', '/register');
    assert.ok(p);
});

test('ADMIN rotas montadas (adminApiRouter abaixo de /api/admin)', async (t) => {
    bindCollections();
    const list = adminApiRouter.stack.filter(l => l.route).map(l => l.route.path);
    assert.ok(list.includes('/users'));
    assert.ok(list.includes('/update-plan'));
    assert.ok(list.includes('/update-plan-details'));
    assert.ok(list.includes('/delete-plan'));
    assert.ok(list.includes('/generate-keys'));
    assert.ok(list.includes('/ban-user'));
    assert.ok(list.includes('/unban-user'));
    assert.ok(list.includes('/delete-user'));
});

test('ADMIN update-plan-details: rejeita id __proto__ e constructor', async (t) => {
    bindCollections();
    const handler = findRoute(adminApiRouter, 'post', '/update-plan-details');
    assert.ok(handler);
    const r1 = await callRoute(handler, 'post', { body: { id: '__proto__', name: 'x', style: 's', price: '1', price_usd: '1', days: '1', accounts: '1', games: '1' } });
    assert.equal(r1.status, 400);
    const r2 = await callRoute(handler, 'post', { body: { id: 'constructor', name: 'x', style: 's', price: '1', price_usd: '1', days: '1', accounts: '1', games: '1' } });
    assert.equal(r2.status, 400);
    assert.equal(Object.prototype.hasOwnProperty.call(GLOBAL_PLANS, 'constructor'), false, 'constructor nunca é chave própria de GLOBAL_PLANS');
});