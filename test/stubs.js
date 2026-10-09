'use strict';
// ---------------------------------------------------------------------------
// Stubs de dependências pesadas para testar index.js sem rede/DB/Steam/MP.
// Hook em Module._load: módulos reais abaixo são substituídos por fakes.
// ---------------------------------------------------------------------------
const Module = require('module');

// In-memory "MongoDB" minimal que espelha a API usada pelo index.js.
class FakeCollection {
    constructor(name) {
        this.name = name;
        this.docs = [];
        this._autoId = 1;
    }
    _nextId() {
        return 'aaaaaaaaaaaa' + String(this._autoId++).padStart(12, '0');
    }
    _docId(id) {
        if (typeof id !== 'string') return null;
        return /^[0-9a-f]{24}$/i.test(id) ? id : null;
    }
    _match(doc, filter = {}) {
        for (const k of Object.keys(filter)) {
            if (k === '_id') {
                const want = String(filter[k]);
                const got = doc._id !== undefined ? String(doc._id) : '';
                if (want !== got) return false;
                continue;
            }
            if (k === '$or') {
                if (!filter.$or.some(cond => this._match(doc, cond))) return false;
                continue;
            }
            const v = filter[k];
            if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) {
                if ('$in' in v && !v.$in.map(String).includes(String(doc[k]))) return false;
                if ('$lt' in v && !(doc[k] && new Date(doc[k]) < new Date(v.$lt))) return false;
                if ('$gte' in v && !(doc[k] && new Date(doc[k]) >= new Date(v.$gte))) return false;
                if ('$ne' in v && (String(doc[k]) === String(v.$ne))) return false;
                continue;
            }
            if (String(doc[k]) !== String(v)) return false;
        }
        return true;
    }
    async find(filter = {}) {
        const docs = this.docs.filter(d => this._match(d, filter));
        return { toArray: async () => docs.slice() };
    }
    async findOne(filter = {}) {
        const d = this.docs.find(x => this._match(x, filter));
        return d ? { ...d } : null;
    }
    async findOneAndUpdate(filter, update) {
        const idx = this.docs.findIndex(x => this._match(x, filter));
        if (idx === -1) return null;
        this._applyUpdate(this.docs[idx], update);
        return { ...this.docs[idx] };
    }
    async insertOne(doc) {
        const d = { ...doc };
        if (d._id === undefined) d._id = this._nextId();
        this.docs.push(d);
        return { insertedId: d._id };
    }
    async updateOne(filter, update) {
        const idx = this.docs.findIndex(x => this._match(x, filter));
        if (idx === -1) return { matchedCount: 0, modifiedCount: 0 };
        this._applyUpdate(this.docs[idx], update);
        return { matchedCount: 1, modifiedCount: 1 };
    }
    async deleteOne(filter) {
        const idx = this.docs.findIndex(x => this._match(x, filter));
        if (idx === -1) return { deletedCount: 0 };
        this.docs.splice(idx, 1);
        return { deletedCount: 1 };
    }
    async deleteMany(filter = {}) {
        const before = this.docs.length;
        this.docs = this.docs.filter(x => !this._match(x, filter));
        return { deletedCount: before - this.docs.length };
    }
    async countDocuments(filter = {}) {
        return this.docs.filter(x => this._match(x, filter)).length;
    }
    async aggregate(pipeline = []) {
        let out = this.docs.slice();
        for (const stage of pipeline) {
            if (stage.$sort) {
                const keys = Object.keys(stage.$sort);
                out.sort((a, b) => {
                    for (const k of keys) {
                        const dir = stage.$sort[k];
                        const av = a[k], bv = b[k];
                        if (av < bv) return -dir;
                        if (av > bv) return dir;
                    }
                    return 0;
                });
            }
            if (stage.$skip) out = out.slice(stage.$skip);
            if (stage.$limit) out = out.slice(0, stage.$limit);
            if (stage.$addFields) {
                out = out.map(d => ({ ...d, ...stage.$addFields }));
            }
        }
        return { toArray: async () => out.slice() };
    }
    _applyUpdate(doc, update) {
        const keys = Object.keys(update || {});
        for (const op of keys) {
            if (op === '$set') Object.assign(doc, update.$set);
            else if (op === '$unset') { for (const u of Object.keys(update.$unset || {})) delete doc[u]; }
            else if (op === '$inc') { for (const k of Object.keys(update.$inc || {})) doc[k] = (doc[k] || 0) + update.$inc[k]; }
            else if (op === '$push') { for (const k of Object.keys(update.$push || {})) (doc[k] = doc[k] || []).push(update.$push[k]); }
        }
    }
}

const FakeMongoClientClass = function () {};
FakeMongoClientClass.prototype.connect = async function () {};
FakeMongoClientClass.prototype.db = function () {
    return {
        collection: (name) => new FakeCollection(name),
        command: async () => ({ ok: 1 }),
    };
};

const FakeObjectId = function (v) { this.toString = () => String(v); return String(v); };
FakeObjectId.isValid = (v) => /^[0-9a-f]{24}$/i.test(String(v));
FakeObjectId.createFromHexString = (v) => v;

const MODULE_STUBS = {
    'mongodb': { MongoClient: FakeMongoClientClass, ObjectId: FakeObjectId },
    'mercadopago': { MercadoPagoConfig: function () {}, Preference: class { async create() { return { body: { init_point: 'https://mp.test/init' } }; } } },
    'steam-user': function () {}, // fake ctor; será spin-up somente se testes de worker existirem
    'steam-totp': { generateAuthCode: () => '12345' },
    'geoip-lite': { lookup: () => ({ country: 'BR' }) },
    'connect-mongo': { create: function () { return function (req, res, next) { next(); }; } },
    'express-session': function () { return function (req, res, next) { req.session = req.session || {}; next(); }; },
    'express-rate-limit': () => (req, res, next) => next(),
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(MODULE_STUBS, request)) {
        return MODULE_STUBS[request];
    }
    return originalLoad.apply(this, arguments);
};

module.exports = {
    Module,
    MODULE_STUBS,
    FakeCollection,
    unstub() {
        Module._load = originalLoad;
    },
};