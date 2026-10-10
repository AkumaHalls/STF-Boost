'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { mod, bindCollections, callRoute } = require('./loader.js');

const { apiRouter, isAuthenticated } = mod;

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

function resStub() {
    const res = { statusCode: 200 };
    res.status = (s) => { res.statusCode = s; return res; };
    res.json = (b) => { res.jsonBody = b; return res; };
    res.redirect = (u) => { res.redirectUrl = u; return res; };
    res.send = () => res;
    res.end = () => res;
    return res;
}

test('isAuthenticated: sessão emitida ANTES da última troca de senha → 401 na API (NV-1)', async () => {
    const db = bindCollections();
    const uid = '1'.repeat(12) + '000000000001';
    await db.users.insertOne({
        _id: uid,
        username: 'alvo1',
        password: 'x',
        passwordChangedAt: new Date(Date.now() + 60000), // mudou depois da sessão ser emitida
    });
    const res = resStub();
    const req = {
        baseUrl: '/api',
        originalUrl: '/api/privado',
        session: makeSession({ userId: uid, pwdIssuedAt: Date.now() - 10000 }),
    };
    let nextCalled = false;
    await isAuthenticated(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false, 'não deve seguir');
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.jsonBody, { message: 'unauthorized' });
});

test('isAuthenticated: mesma invalidação redireciona para login em página (não-API)', async () => {
    const db = bindCollections();
    const uid = '1'.repeat(12) + '000000000002';
    await db.users.insertOne({
        _id: uid,
        username: 'alvo2',
        password: 'x',
        passwordChangedAt: new Date(Date.now() + 60000),
    });
    const res = resStub();
    const req = {
        baseUrl: '',
        originalUrl: '/dashboard',
        session: makeSession({ userId: uid, pwdIssuedAt: Date.now() - 10000 }),
    };
    let nextCalled = false;
    await isAuthenticated(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.redirectUrl, '/login?error=unauthorized');
});

test('isAuthenticated: sessão emitida DEPOIS/na MESMA troca de senha → liberada', async () => {
    const db = bindCollections();
    const uid = '1'.repeat(12) + '000000000003';
    const changedAt = Date.now() - 5000;
    await db.users.insertOne({
        _id: uid,
        username: 'ok1',
        password: 'x',
        passwordChangedAt: new Date(changedAt),
    });
    const res = resStub();
    const req = {
        baseUrl: '/api',
        originalUrl: '/api/privado',
        session: makeSession({ userId: uid, pwdIssuedAt: changedAt }),
    };
    let nextCalled = false;
    await isAuthenticated(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
});

test('isAuthenticated: sessão antiga sem pwdIssuedAt ganha fallback e é liberada', async () => {
    const db = bindCollections();
    const uid = '1'.repeat(12) + '000000000004';
    const createdAt = new Date(Date.now() - 86400000);
    await db.users.insertOne({ _id: uid, username: 'legacy', password: 'x', createdAt });
    const req = {
        baseUrl: '/api',
        originalUrl: '/api/privado',
        session: makeSession({ userId: uid }),
    };
    let nextCalled = false;
    const res = resStub();
    await isAuthenticated(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(req.session.pwdIssuedAt, createdAt.getTime(), 'fallback gravado na sessão');
});

test('login → change-password: sessão ATUAL sobrevive e sessões antigas caem (F1)', async () => {
    const db = bindCollections();
    const uid = '2'.repeat(12) + '000000000001';
    const pwdHash = bcrypt.hashSync('Senha1234', 4);
    await db.users.insertOne({ _id: uid, username: 'dono', password: pwdHash, plan: 'free', createdAt: new Date(Date.now() - 86400000) });

    // login (sessão A): snapshot gravado
    const loginHandler = findRoute(apiRouter, 'post', '/login');
    const sessionA = makeSession();
    const rLogin = await callRoute(loginHandler, 'post', {
        session: sessionA,
        body: { username: 'dono', password: 'Senha1234' },
    });
    assert.equal(rLogin.status, 200);
    assert.equal(typeof sessionA.pwdIssuedAt, 'number', 'login grava snapshot pwdIssuedAt');

    // change-password pela sessão A: snapshot atualizado → A continua válida
    const changeHandler = findRoute(apiRouter, 'post', '/change-password');
    const rChange = await callRoute(changeHandler, 'post', {
        session: sessionA,
        body: { currentPassword: 'Senha1234', newPassword: 'NovaSenha123', confirmPassword: 'NovaSenha123' },
    });
    assert.equal(rChange.status, 200);
    assert.equal(sessionA.pwdIssuedAt, new Date((await db.users.findOne({ _id: uid })).passwordChangedAt).getTime(), 'session atual sync com a troca');

    let passedA = false;
    await isAuthenticated(
        { baseUrl: '/api', originalUrl: '/api/x', session: sessionA },
        resStub(),
        () => { passedA = true; }
    );
    assert.equal(passedA, true, 'quem trocou senha continua logado');

    // sessão B = outro dispositivo com snapshot antigo → derrubada
    const sessionB = makeSession({ userId: uid, pwdIssuedAt: Date.now() - 999999 });
    let passedB = false;
    const resB = resStub();
    await isAuthenticated(
        { baseUrl: '/api', originalUrl: '/api/y', session: sessionB },
        resB,
        () => { passedB = true; }
    );
    assert.equal(passedB, false);
    assert.equal(resB.statusCode, 401, 'outras sessões são invalidadas');
});

test('recover-password invalida sessões emitidas antes da troca (F1)', async () => {
    const db = bindCollections();
    const uid = '3'.repeat(12) + '000000000001';
    const pwdHash = bcrypt.hashSync('VelhaSenha1', 4);
    const beforeChange = Date.now() - 86400000;
    await db.users.insertOne({ _id: uid, username: 'recov', password: pwdHash, plan: 'free', recoveryKey: 'STF-RECOVERYKEY1', passwordChangedAt: new Date(beforeChange) });

    const recoverHandler = findRoute(apiRouter, 'post', '/recover-password');
    const r = await callRoute(recoverHandler, 'post', {
        session: makeSession(),
        body: { username: 'recov', recoveryKey: 'stf-recoverykey1', newPassword: 'NovaSenha456' },
    });
    assert.equal(r.status, 200);
    assert.ok(r.body.recoveryKey);

    const sessionV = makeSession({ userId: uid, pwdIssuedAt: beforeChange });
    const resV = resStub();
    let nextCalled = false;
    await isAuthenticated(
        { baseUrl: '/api', originalUrl: '/api/z', session: sessionV },
        resV,
        () => { nextCalled = true; }
    );
    assert.equal(nextCalled, false, 'sessão anterior à recuperação cai');
});