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
                const want = filter[k];
                if (want && typeof want === 'object' && !Array.isArray(want) && '$in' in want) {
                    if (!want.$in.map(String).includes(String(doc._id))) return false;
                } else {
                    const wantS = String(want);
                    const gotS = doc._id !== undefined ? String(doc._id) : '';
                    if (wantS !== gotS) return false;
                }
                continue;
            }
            if (k === '$or') {
                if (!filter.$or.some(cond => this._match(doc, cond))) return false;
                continue;
            }
            if (k === '$expr') {
                if (!this._evalExpr(doc, filter.$expr)) return false;
                continue;
            }
            const v = filter[k];
            if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) {
                const cmp = (a, b) => {
                    const norm = x => (x instanceof Date) ? x.getTime() : x;
                    const na = norm(a), nb = norm(b);
                    return na < nb ? -1 : na > nb ? 1 : 0;
                };
                if ('$in' in v && !v.$in.map(String).includes(String(doc[k]))) return false;
                if ('$lt' in v && !(cmp(doc[k], v.$lt) < 0)) return false;
                if ('$lte' in v && !(cmp(doc[k], v.$lte) <= 0)) return false;
                if ('$gt' in v && !(cmp(doc[k], v.$gt) > 0)) return false;
                if ('$gte' in v && !(cmp(doc[k], v.$gte) >= 0)) return false;
                if ('$ne' in v && (String(doc[k]) === String(v.$ne))) return false;
                continue;
            }
            if (String(doc[k]) !== String(v)) return false;
        }
        return true;
    }
    _evalExpr(doc, expr) {
        if (expr === null || typeof expr !== 'object' || Array.isArray(expr)) return false;
        const keys = Object.keys(expr);
        if (keys.length !== 1) return false;
        const op = keys[0];
        const args = expr[op];
        const resolve = (v) => {
            if (typeof v === 'string' && v.startsWith('$')) return doc[v.slice(1)];
            if (v && typeof v === 'object' && !Array.isArray(v)) return this._evalExpr(doc, v);
            return v;
        };
        switch (op) {
            case '$and': return args.every(a => this._evalExpr(doc, a));
            case '$or': return args.some(a => this._evalExpr(doc, a));
            case '$not': return !this._evalExpr(doc, args);
            case '$eq': return resolve(args[0]) === resolve(args[1]);
            case '$lt': return resolve(args[0]) < resolve(args[1]);
            case '$lte': return resolve(args[0]) <= resolve(args[1]);
            case '$gt': return resolve(args[0]) > resolve(args[1]);
            case '$gte': return resolve(args[0]) >= resolve(args[1]);
            case '$ifNull': { const r = resolve(args[0]); return (r === null || r === undefined) ? resolve(args[1]) : r; }
            default: return false;
        }
    }
    async find(filter = {}) {
        const docs = this.docs.filter(d => this._match(d, filter));
        return { toArray: async () => docs.slice() };
    }
    async findOne(filter = {}) {
        const d = this.docs.find(x => this._match(x, filter));
        return d ? { ...d } : null;
    }
    async findOneAndUpdate(filter, update, options = {}) {
        // Espelha o driver real do Mongo (v6): por padrão retorna o documento (ou null);
        // com includeResultMetadata:true retorna { value, ok } (value = doc 'after'/'before').
        const idx = this.docs.findIndex(x => this._match(x, filter));
        if (idx === -1) return options.includeResultMetadata ? { ok: 1, value: null } : null;
        const before = { ...this.docs[idx] };
        this._applyUpdate(this.docs[idx], update);
        const after = { ...this.docs[idx] };
        const doc = options.returnDocument === 'after' ? after : before;
        return options.includeResultMetadata ? { ok: 1, value: doc } : doc;
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
    async updateMany(filter, update) {
        let matched = 0;
        for (const d of this.docs) {
            if (this._match(d, filter)) { this._applyUpdate(d, update); matched++; }
        }
        return { matchedCount: matched, modifiedCount: matched };
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
    'mercadopago': { MercadoPagoConfig: function () {}, Preference: class { async create() { return { id: 'pref_1', init_point: 'https://mp.test/init' }; } } },
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