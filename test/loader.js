'use strict';
// ---------------------------------------------------------------------------
// Carregador de teste: configura env/stubs e requer index.js UMA vez.
// Expõe o módulo e fábricas de coleções fake + helpers HTTP.
// ---------------------------------------------------------------------------
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-secret';
process.env.MP_ACCESS_TOKEN = 'TEST-123';
process.env.SITE_PASSWORD = 'admin-secret';
process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
process.env.PORT = '39999';

const { FakeCollection } = require('./stubs.js');
require('./stubs.js'); // registra Module._load hook

const SRC = path.join(__dirname, '..', 'index.js');
const mod = require(SRC);

const newCollection = (name) => new FakeCollection(name);

// injeta coleções fake e devolve referências para os testes
function bindCollections(opts = {}) {
    const collections = {
        users: opts.users || newCollection('users'),
        accounts: opts.accounts || newCollection('accounts'),
        licenses: opts.licenses || newCollection('licenses'),
        plans: opts.plans || newCollection('plans'),
        coupons: opts.coupons || newCollection('coupons'),
        purchases: opts.purchases || newCollection('purchases'),
        siteSettings: opts.siteSettings || newCollection('siteSettings'),
        referrals: opts.referrals || newCollection('referrals'),
        fraudEvents: opts.fraudEvents || newCollection('fraudEvents'),
    };
    mod.__setCollections({
        users: collections.users,
        accounts: collections.accounts,
        licenses: collections.licenses,
        plans: collections.plans,
        coupons: collections.coupons,
        purchases: collections.purchases,
        siteSettings: collections.siteSettings,
        referrals: collections.referrals,
        fraudEvents: collections.fraudEvents,
    });
    return collections;
}

// helpers de request para router ou handler (express.Router não pode listen; usamos supertest-equivalente leve)
function callRoute(route, method, reqOverrides = {}, resOverrides = {}) {
    return new Promise((resolve) => {
        const req = {
            body: {}, query: {}, params: {}, headers: {}, session: {},
            ip: '127.0.0.1',
            path: '', originalUrl: '',
            ...reqOverrides,
        };
        const res = {};
        let statusCode = 200;
        let body = undefined;
        let ended = false;
        const finish = (s, b) => { if (!ended) { ended = true; statusCode = s; body = b; resolve({ status: s, body: b, req, res }); } };
        res.status = (s) => { statusCode = s; return res; };
        res.json = (b) => { finish(statusCode, b); return res; };
        res.send = (b) => { finish(statusCode, b); return res; };
        res.sendFile = (p) => { finish(200, { __file: p }); return res; };
        res.redirect = (u) => { finish(302, { __redirect: u }); return res; };
        res.set = () => res;
        res.end = () => finish(statusCode, body);
        if (resOverrides.headersSent) Object.defineProperty(res, 'headersSent', { value: true });
        const handler = typeof route === 'function' ? route : route[method];
        Promise.resolve(handler(req, res)).catch((e) => finish(500, { __error: e }));
    });
}

module.exports = { mod, bindCollections, callRoute, newCollection, SRC };