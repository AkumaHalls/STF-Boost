const express = require('express');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { MongoClient, ObjectId } = require('mongodb'); 
const crypto = require('crypto');
const https = require('https');
const bcrypt = require('bcryptjs'); 
const { MercadoPagoConfig, Preference } = require('mercadopago');
const geoip = require('geoip-lite');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const SteamUser = require('steam-user');
const SteamTotp = require('steam-totp');

console.log("[SYSTEM] Inicializando módulos...");

// --- FUNÇÃO DE NOTIFICAÇÃO ---
function sendDiscordNotification(title, message, color, username, type = 'log') {
    let webhookUrl = process.env.DISCORD_WEBHOOK_LOGS || process.env.DISCORD_WEBHOOK_URL; 
    if (type === 'sale') webhookUrl = process.env.DISCORD_WEBHOOK_SALES || webhookUrl;
    if (type === 'alert') webhookUrl = process.env.DISCORD_WEBHOOK_ALERTS || webhookUrl;

    if (!webhookUrl) return;
    const safeMessage = (message || '').replace(/`/g, "'");
    const payload = JSON.stringify({ embeds: [{ title: title || '\u200b', description: safeMessage || '\u200b', color: color, fields: [{ name: "Conta", value: `\`${username || 'N/A'}\``, inline: true }], footer: { text: "STF Boost System" }, timestamp: new Date().toISOString() }] });
    try {
        const req = https.request({ hostname: new URL(webhookUrl).hostname, path: new URL(webhookUrl).pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }}, () => {});
        req.on('error', (e) => {}); req.write(payload); req.end();
    } catch (e) {}
}

// Proteção Global de Crash
process.on('uncaughtException', (err) => {
    if (err.message && (err.message.includes('Already attempting') || err.message.includes('Already logged on'))) return;
    console.error(`[CRASH PREVENIDO] Erro:`, err);
});

// --- CONFIGURAÇÃO E VARIÁVEIS GLOBAIS ---
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_PASSWORD = process.env.SITE_PASSWORD; 
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET;
const SITE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) console.warn("[AVISO] SESSION_SECRET não definida! Sessões serão perdidas ao reiniciar.");

if (process.env.NODE_ENV !== 'test' && (!MONGODB_URI || !ADMIN_PASSWORD || !MP_ACCESS_TOKEN || !SITE_URL)) { 
    console.error("ERRO CRÍTICO: Variáveis de ambiente faltando! Necessário: MONGODB_URI, SITE_PASSWORD, MP_ACCESS_TOKEN"); 
    process.exit(1); 
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", "'unsafe-inline'", "cdn.tailwindcss.com", "fonts.googleapis.com", "akuma-labs.duckdns.org", "https://*.mercadopago.com"], styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "cdn.tailwindcss.com"], fontSrc: ["'self'", "fonts.gstatic.com"], imgSrc: ["'self'", "data:", "https:"], connectSrc: ["'self'", "https://api.mercadopago.com", "https://api.ipify.org", "akuma-labs.duckdns.org"], frameSrc: ["'self'", "https://*.mercadopago.com.br", "https://*.mercadopago.com"] } } }));
app.use(cors({ origin: SITE_URL, credentials: true }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { message: "Muitas tentativas de login." }});
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { message: "Muitos cadastros. Aguarde." }});
const resetLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { message: "Muitas tentativas de recuperação. Aguarde." }});
const apiLimiter = rateLimit({ windowMs: 1 * 60 * 1000, max: 300, message: { message: "Muitas requisições. Aguarde." }});
const sensitiveLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { message: "Muitas ações sensíveis. Aguarde." }});
const addAccountLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, message: { message: "Muitas adições de conta por hora." }});
const checkoutLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { message: "Muitas verificações de pagamento. Aguarde." }});

let mpClient;
if (MP_ACCESS_TOKEN) {
    mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
    console.log("[SYSTEM] Mercado Pago configurado.");
}

const ALGORITHM = 'aes-256-gcm';
let appSecretKey; 
let steamAppListCache = { data: [{appid: 730, name: "Counter-Strike 2"}], timestamp: 0 }; 
const replyCooldowns = new Map();

const FREE_HOURS_MS = 50 * 60 * 60 * 1000; 
const CUSTOM_PRICING_BRL = { BASE: 5.00, DAY: 0.10, ACCOUNT: 2.00, GAME: 0.10 };
const CUSTOM_PRICING_USD = { BASE: 2.00, DAY: 0.05, ACCOUNT: 1.00, GAME: 0.05 };

const PLAN_LEVELS = { 'free': 0, 'basic': 1, 'plus': 2, 'premium': 3, 'ultimate': 4, 'lifetime': 5, 'halloween': 3, 'christmas': 4, 'newyear': 4, 'custom': 1 };
let PLAN_LIMITS = { 'free': { accounts: 1, games: 1 }, 'basic': { accounts: 2, games: 6 }, 'plus': { accounts: 4, games: 12 }, 'premium': { accounts: 6, games: 24 }, 'ultimate': { accounts: 10, games: 33 }, 'lifetime': { accounts: 10, games: 33 }, 'custom': { accounts: 1, games: 10 } };
let GLOBAL_PLANS = {}; 
const hasPlan = (id) => typeof id === 'string' && Object.prototype.hasOwnProperty.call(GLOBAL_PLANS, id); 

const mongoClient = new MongoClient(MONGODB_URI);
let accountsCollection, siteSettingsCollection, usersCollection, licensesCollection, plansCollection, couponsCollection, purchasesCollection;
let liveAccounts = {};

// --- FUNÇÕES UTILITÁRIAS ---
const encrypt = (text) => {
    if (!appSecretKey) return null;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, appSecretKey, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
};
const decrypt = (text) => {
    try {
        if (!appSecretKey || !text) return "";
        const textParts = text.split(':');
        if (textParts.length === 3) {
            const iv = Buffer.from(textParts[0], 'hex');
            const authTag = Buffer.from(textParts[1], 'hex');
            const encryptedText = Buffer.from(textParts[2], 'hex');
            const decipher = crypto.createDecipheriv(ALGORITHM, appSecretKey, iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } else {
            const iv = Buffer.from(textParts.shift(), 'hex');
            const encryptedText = Buffer.from(textParts.join(':'), 'hex');
            const decipher = crypto.createDecipheriv('aes-256-cbc', appSecretKey, iv);
            let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        }
    } catch (error) {
        console.error("[CRYPTO] Erro ao descriptografar:", error.message);
        return "";
    }
};
function safeCompare(a, b) { if (typeof a !== 'string' || typeof b !== 'string') return false; const bufA = Buffer.from(a); const bufB = Buffer.from(b); return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB); }

// --- VALIDAÇÃO DE ENTRADA & ERROR HANDLER ASYNC (Express 4 não captura rejeições) ---
const ah = (fn) => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };
function apiErrorHandler(err, req, res, next) {
    if (res.headersSent) return next(err);
    if (req.path.startsWith('/api/')) {
        console.error(`[API] ${req.method} ${req.originalUrl}:`, err.message);
        return res.status(500).json({ message: "Erro interno do servidor." });
    }
    next(err);
}
const isStr = (v, min = 1, max = 500) => typeof v === 'string' && v.length >= min && v.length <= max;
const USERNAME_RE = /^[\p{L}\p{N}_.\-]{3,32}$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;
const isUsername = (v) => isStr(v, 3, 32) && USERNAME_RE.test(v.trim()) && !v.trim().startsWith('__');
const isEmail = (v) => isStr(v, 5, 254) && EMAIL_RE.test(v);
const isObjId = (v) => isStr(v, 24, 24) && OBJECT_ID_RE.test(v);
const isStrArray = (v, max) => Array.isArray(v) && v.length > 0 && v.length <= max && v.every(x => isStr(x, 1, 64));

function getIpAndCountry(req) {
    try {
        const ip = String(req.ip || (req.socket ? req.socket.remoteAddress : '') || '127.0.0.1').replace(/^::ffff:/, '');
        if (!ip || ip === '127.0.0.1' || ip === '::1') return { ip: '127.0.0.1', country: 'BR' };
        const geo = geoip.lookup(ip);
        return { ip: ip, country: geo ? geo.country : 'US' };
    } catch(e) {
        return { ip: 'Desconhecido', country: 'BR' };
    }
}

function getCountryFromRequest(req) {
    return getIpAndCountry(req).country;
}

function getUserLimits(user) { 
    if (user.customLimits && typeof user.customLimits.accounts === 'number') { return user.customLimits; } 
    return hasPlan(user.plan) ? GLOBAL_PLANS[user.plan] : ({ ...(PLAN_LIMITS['free'] || { accounts: 1, games: 1 }) }); 
}

// Rebaixa/limpa settings premium (gated) conforme o nível do usuário dono.
// Chamado no start do worker e em mudanças/rebaixamentos de plano.
async function sanitizeGatedSettingsForOwner(acc) {
    if (!acc || !acc.ownerUserID || !ObjectId.isValid(acc.ownerUserID)) return acc;
    try {
        const user = await usersCollection.findOne({ _id: new ObjectId(acc.ownerUserID) });
        if (!user) return acc;
        const level = PLAN_LEVELS[user.plan] || 0;
        const s = { ...(acc.settings || {}) };
        let dirty = false;
        if (level < 3) {
            if (s.appearOffline) { s.appearOffline = false; dirty = true; }
            if (s.customInGameTitle) { s.customInGameTitle = ''; dirty = true; }
            if (s.customAwayMessage) { s.customAwayMessage = ''; dirty = true; }
        }
        if (level < 2) {
            if (s.autoAcceptFriends) { s.autoAcceptFriends = false; dirty = true; }
        }
        if (dirty) {
            acc.settings = s;
            if (acc.username) await accountsCollection.updateOne({ username: acc.username }, { $set: { settings: s } });
        }
    } catch (e) { console.error("[PLAN] Erro sanitizeGatedSettingsForOwner:", e.message); }
    return acc;
}

// --- FUNÇÕES DE LIMITES E PLANOS ---
async function enforceUserLimits(userId) {
    try {
        if (!ObjectId.isValid(userId)) return;
        const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
        if (!user) return;

        const limits = getUserLimits(user);
        const limitAccounts = limits.accounts;
        const limitGames = limits.games;

        let runningAccounts = [];
        for (const username in liveAccounts) {
            const s = liveAccounts[username].status;
            if (liveAccounts[username].ownerUserID === userId.toString() && (s === 'Rodando' || s.startsWith('Iniciando') || s.startsWith('Pendente'))) {
                runningAccounts.push(liveAccounts[username]);
            }
        }

        if (user.plan === 'free' && user.freeHoursRemaining <= 0) {
            runningAccounts.forEach(acc => { cleanupAccount(acc); acc.status = "Tempo Esgotado"; });
            return; 
        }

        if (runningAccounts.length > limitAccounts) {
            const toStop = runningAccounts.slice(limitAccounts); 
            toStop.forEach(acc => { cleanupAccount(acc); acc.status = "Parado (Limite de Plano)"; });
        }

        const remainingRunning = runningAccounts.slice(0, limitAccounts);
        remainingRunning.forEach(acc => {
            if (acc.games.length > limitGames) { cleanupAccount(acc); acc.status = "Parado (Limite Jogos)"; }
        });
    } catch (e) { console.error(`[SYSTEM] Erro limites:`, e); }
}

async function ensureUserPlanStatus(userId) {
    try {
        if (!ObjectId.isValid(userId)) return null;
        let user = await usersCollection.findOne({ _id: new ObjectId(userId) });
        if (!user) return null;

        if (user.plan !== 'free' && user.plan !== 'lifetime' && user.planExpiresAt && new Date(user.planExpiresAt) < new Date()) {
            await usersCollection.updateOne({ _id: user._id }, { $set: { plan: 'free', planExpiresAt: null, freeHoursRemaining: 0 }, $unset: { customLimits: "" } });
            await enforceUserLimits(userId);
            for (const u in liveAccounts) {
                if(liveAccounts[u].ownerUserID === userId.toString()) { cleanupAccount(liveAccounts[u]); liveAccounts[u].status = "Plano Expirado"; }
            }
            user.plan = 'free'; user.planExpiresAt = null; user.freeHoursRemaining = 0; delete user.customLimits; 
        }
        return user;
    } catch (e) { return null; }
}


// --- LÓGICA STEAM UNIFICADA ---
function cleanupAccount(acc) {
    if (acc.client) {
        try { acc.client.logOff(); } catch(e){}
        acc.client.removeAllListeners();
    }
    if (acc.farmInterval) clearInterval(acc.farmInterval);
    if (acc.reloginTimeout) clearTimeout(acc.reloginTimeout);
    if (acc.guardTimeout) clearTimeout(acc.guardTimeout);
    acc.steamGuardCallback = null;
    acc.isLoggingIn = false;
    acc.sessionStartTime = null; 
}

function farmGames(acc) {
    if (!acc.client || !acc.client.steamID) return;
    let gamesToPlay = [];
    if (acc.settings.customInGameTitle && acc.settings.customInGameTitle.trim().length > 0) {
        gamesToPlay = [acc.settings.customInGameTitle];
    } else {
        gamesToPlay = acc.games.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0).slice(0, 32);
    }
    const personaState = acc.settings.appearOffline ? SteamUser.EPersonaState.Invisible : SteamUser.EPersonaState.Online;
    try {
        acc.client.setPersona(personaState);
        acc.client.gamesPlayed(gamesToPlay.length > 0 ? gamesToPlay : []);
    } catch (e) { console.error(`[${acc.username}] Erro farmGames:`, e.message); }
}

function handleLoginError(acc, erroMsg, password) {
    acc.isLoggingIn = false;
    if (erroMsg.includes('InvalidPassword')) {
        acc.status = "Erro: Senha Inválida";
        return;
    }
    if (erroMsg.includes('RateLimitExceeded') || erroMsg.includes('AccountLoginDeniedThrottle')) {
        acc.status = "Bloqueio Temp. (30min)";
        if (acc.reloginTimeout) clearTimeout(acc.reloginTimeout);
        acc.reloginTimeout = setTimeout(() => performLogin(acc, password), 30 * 60 * 1000);
        return;
    }
    const delay = Math.min(10000 * Math.pow(2, acc.retryCount || 0), 120000);
    acc.status = `Reconectando (${Math.ceil(delay/1000)}s)`;
    if (acc.reloginTimeout) clearTimeout(acc.reloginTimeout);
    acc.reloginTimeout = setTimeout(() => {
        acc.retryCount = (acc.retryCount || 0) + 1;
        performLogin(acc, password);
    }, delay);
}

function performLogin(acc, password) {
    if (acc.isLoggingIn || (acc.client && acc.client.steamID)) return;
    acc.isLoggingIn = true;
    const logonOptions = { accountName: acc.username, password: password, autoRelogin: false };
    if (acc.sentryFileHash) logonOptions.shaSentryfile = Buffer.from(acc.sentryFileHash, 'base64');
    
    console.log(`[${acc.username}] Conectando...`);
    try { acc.client.logOn(logonOptions); } 
    catch (e) { acc.isLoggingIn = false; handleLoginError(acc, e.message, password); }
}

function setupSteamListeners(acc, password) {
    if (acc.client.listenerCount('loggedOn') > 0) return;

    acc.client.on('loggedOn', () => {
        console.log(`[${acc.username}] LOGIN: Sucesso!`);
        acc.isLoggingIn = false;
        acc.retryCount = 0;
        acc.status = "Rodando";
        acc.sessionStartTime = Date.now();
        
        sendDiscordNotification("✅ Conta Online", "Farmando.", 5763719, acc.username, "log");
        
        farmGames(acc);

        try {
            const filter = { includePlayedFreeGames: true, includeFreeSubGames: true };
            acc.client.getUserOwnedApps(acc.client.steamID, filter, (err, response) => {
                if (err) return;
                let validApps = [];
                if (Array.isArray(response)) validApps = response;
                else if (response && Array.isArray(response.apps)) validApps = response.apps;
                if (validApps.length > 0) {
                    acc.ownedGames = validApps.map(app => ({ appid: app.appid, name: app.name }));
                    accountsCollection.updateOne({ username: acc.username }, { $set: { ownedGames: acc.ownedGames } });
                }
            });
        } catch (e) {}

        if (acc.farmInterval) clearInterval(acc.farmInterval);
        acc.farmInterval = setInterval(() => farmGames(acc), 5 * 60 * 1000);
    });

    acc.client.on('friendMessage', (steamID, message) => {
        if (acc.settings.customAwayMessage && acc.settings.customAwayMessage.trim().length > 0) {
            const sid = steamID.getSteamID64();
            const now = Date.now();
            const lastReply = replyCooldowns.get(sid) || 0;
            if (now - lastReply > 300000) {
                acc.client.chatMessage(steamID, acc.settings.customAwayMessage);
                replyCooldowns.set(sid, now);
            }
        }
    });

    acc.client.on('steamGuard', (domain, callback) => {
        acc.isLoggingIn = false;
        if (acc.settings.sharedSecret) {
            try {
                const code = SteamTotp.generateAuthCode(acc.settings.sharedSecret);
                callback(code);
            } catch (e) { acc.status = "Erro: Secret Inválido"; }
        } else {
            acc.status = "Pendente: Steam Guard";
            acc.steamGuardCallback = callback;
            if (acc.guardTimeout) clearTimeout(acc.guardTimeout);
            acc.guardTimeout = setTimeout(() => {
                acc.steamGuardCallback = null;
                if (acc.status === "Pendente: Steam Guard") {
                    acc.status = "Parado (Guard Timeout)";
                    cleanupAccount(acc);
                }
            }, 5 * 60 * 1000);
            sendDiscordNotification("🛡️ Steam Guard", "Aguardando código (expira em 5min).", 16776960, acc.username, "alert");
        }
    });

    acc.client.on('error', (err) => handleLoginError(acc, err.message, password));

    acc.client.on('disconnected', (eresult, msg) => {
        console.log(`[${acc.username}] Caiu: ${msg} (${eresult})`);
        if (eresult === 5) return handleLoginError(acc, "InvalidPassword", password);
        
        if (!acc.manual_logout && acc.settings.autoRelogin) {
            ensureUserPlanStatus(acc.ownerUserID).then(user => {
                const isFreeExpired = user && user.plan === 'free' && user.freeHoursRemaining <= 0;
                if (!user || user.isBanned || isFreeExpired) {
                    acc.status = user?.isBanned ? "Banido" : "Tempo Esgotado";
                    acc.sessionStartTime = null;
                } else {
                    const limits = getUserLimits(user);
                    let running = 0;
                    for (const u in liveAccounts) {
                        const s = liveAccounts[u].status;
                        if (liveAccounts[u].ownerUserID === acc.ownerUserID && (s === 'Rodando' || s.startsWith('Iniciando') || s.startsWith('Pendente'))) {
                            running++;
                        }
                    }
                    if (running <= limits.accounts) handleLoginError(acc, "Disconnected", password);
                    else { acc.status = "Parado (Limite)"; acc.sessionStartTime = null; }
                }
            });
        } else {
            acc.status = "Parado";
            acc.sessionStartTime = null;
        }
    });

    acc.client.on('sentry', (sentryHash) => {
        acc.sentryFileHash = sentryHash.toString('base64');
        accountsCollection.updateOne({ username: acc.username }, { $set: { sentryFileHash: acc.sentryFileHash } });
    });

    acc.client.on('friendRelationship', (steamID, relationship) => {
        if (relationship === 2 && acc.settings.autoAcceptFriends) acc.client.addFriend(steamID);
    });
}

async function startWorkerForAccount(accountData) {
    const username = accountData.username;
    const acc = liveAccounts[username];
    
    cleanupAccount(acc);

    if (!accountData.machineId) {
        accountData.machineId = crypto.randomBytes(10).toString('hex');
        await accountsCollection.updateOne({ username: username }, { $set: { machineId: accountData.machineId } });
    }

    acc.ownerUserID = accountData.ownerUserID;
    acc.machineId = accountData.machineId;
    acc.status = "Iniciando...";
    acc.manual_logout = false;
    acc.retryCount = 0;
    acc.client = new SteamUser({ enablePicsCache: false });

    await sanitizeGatedSettingsForOwner(acc);

    setupSteamListeners(acc, accountData.password);
    performLogin(acc, accountData.password);
}


// --- FUNÇÕES CORE DB ---
async function connectToDB() { 
    try { 
        await mongoClient.connect(); 
        console.log("[DB] Conectado ao MongoDB Atlas!"); 
        const db = mongoClient.db("stf-saas-db"); 
        accountsCollection = db.collection("accounts");
        siteSettingsCollection = db.collection("site_settings");
        usersCollection = db.collection("users"); 
        licensesCollection = db.collection("licenses"); 
        plansCollection = db.collection("plans"); 
        couponsCollection = db.collection("coupons");
        purchasesCollection = db.collection("purchases");
        
        await usersCollection.createIndex({ username: 1 }, { unique: true });
        await usersCollection.createIndex({ email: 1 }, { unique: true });
        await licensesCollection.createIndex({ key: 1 }, { unique: true }); 
        await couponsCollection.createIndex({ code: 1 }, { unique: true }); 
        await usersCollection.createIndex({ registrationIP: 1 });
        await purchasesCollection.createIndex({ userId: 1, status: 1 }); 
        await purchasesCollection.createIndex({ paymentId: 1 }, { sparse: true }); 
        await accountsCollection.createIndex({ ownerUserID: 1 }); 
    } catch (e) { console.error("[DB] Erro fatal:", e); process.exit(1); } 
}

async function initializePlans() {
    const defaultPlans = [
        { id: 'free', name: 'Gratuito', price: 0, price_usd: 0, days: 0, accounts: 1, games: 1, style: 'none', active: true, features: ['50 Horas Renováveis', '1 Conta Steam', '1 Jogo Simultâneo', 'Suporte Básico'] },
        { id: 'basic', name: 'Basic', price: 7.90, price_usd: 3.99, days: 30, accounts: 2, games: 6, style: 'none', active: true, features: ['30 Dias de Acesso', '2 Contas Steam', '6 Jogos Simultâneos', 'Reconexão Automática', 'Suporte 2FA'] },
        { id: 'plus', name: 'Plus', price: 15.90, price_usd: 6.99, days: 30, accounts: 4, games: 12, style: 'none', active: true, features: ['30 Dias de Acesso', '4 Contas Steam', '12 Jogos Simultâneos', 'Auto-Aceitar Amigos', 'Prioridade na Fila'] },
        { id: 'premium', name: 'Premium', price: 27.90, price_usd: 9.99, days: 30, accounts: 6, games: 24, style: 'fire', active: true, features: ['30 Dias de Acesso', '6 Contas Steam', '24 Jogos Simultâneos', 'Aparecer Offline', 'Título Personalizado', 'Mensagem Ausente'] },
        { id: 'ultimate', name: 'Ultimate', price: 54.90, price_usd: 14.99, days: 30, accounts: 10, games: 33, style: 'none', active: true, features: ['30 Dias de Acesso', '10 Contas Steam', '33 Jogos (Máx)', 'Todos os Benefícios', 'Suporte VIP', 'Slots Dedicados'] },
        { id: 'lifetime', name: 'Vitalício', price: 249.90, price_usd: 49.99, days: 0, accounts: 10, games: 33, style: 'cosmic', active: true, features: ['Acesso Vitalício', '10 Contas Steam', '33 Jogos (Máx)', 'Status Cósmico no Painel', 'Todas as Funcionalidades'] },
        { id: 'halloween', name: 'Halloween', price: 19.90, price_usd: 7.99, days: 45, accounts: 8, games: 33, style: 'halloween', active: true, features: ['45 Dias (Promo)', '8 Contas', '33 Jogos'] },
        { id: 'christmas', name: 'Natal', price: 89.90, price_usd: 29.99, days: 365, accounts: 10, games: 33, style: 'christmas', active: true, features: ['1 Ano de Acesso', '10 Contas', '33 Jogos'] },
        { id: 'newyear', name: 'Ano Novo', price: 12.90, price_usd: 5.99, days: 30, accounts: 10, games: 33, style: 'newyear', active: true, features: ['30 Dias', '10 Contas', '33 Jogos'] },
        { id: 'custom', name: 'Personalizado', price: 15.00, price_usd: 5.00, days: 30, accounts: 1, games: 10, style: 'none', active: true, features: ['Configuração Flexível'] }
    ];
    for (const plan of defaultPlans) {
        await plansCollection.updateOne({ id: plan.id }, { $setOnInsert: plan }, { upsert: true });
    }
    await refreshPlansCache();
}

async function refreshPlansCache() {
    try {
        const plans = await plansCollection.find({}).toArray();
        GLOBAL_PLANS = {};
        plans.forEach(p => { if (p && typeof p.id === 'string' && /^[a-z0-9_\-]{1,32}$/.test(p.id) && p.id !== '__proto__') { GLOBAL_PLANS[p.id] = p; PLAN_LIMITS[p.id] = { accounts: p.accounts, games: p.games }; } });
    } catch (e) { console.error("[PLANS] Erro ao atualizar cache:", e.message); }
}

async function initializeMasterKey() {
    let settings = await siteSettingsCollection.findOne({ _id: 'config' });
    if (!settings || !settings.appSecret) {
        const newSecret = crypto.randomBytes(32).toString('hex');
        appSecretKey = crypto.createHash('sha256').update(newSecret).digest('base64').substr(0, 32);
        await siteSettingsCollection.updateOne( { _id: 'config' }, { $set: { appSecret: newSecret } }, { upsert: true } );
    } else {
        appSecretKey = crypto.createHash('sha256').update(settings.appSecret).digest('base64').substr(0, 32);
    }
}

async function getSteamAppList() {
    if (Date.now() - steamAppListCache.timestamp < 24 * 60 * 60 * 1000 && steamAppListCache.data.length > 1) return steamAppListCache.data;
    try { const response = await fetch('https://steamspy.com/api.php?request=all', { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (response.ok) { const jsonData = await response.json(); steamAppListCache = { data: Object.values(jsonData), timestamp: Date.now() }; return steamAppListCache.data; } } catch (e) {}
    try { const response = await fetch('https://api.steampowered.com/ISteamApps/GetAppList/v0002/', { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (response.ok) { const jsonData = await response.json(); if (jsonData.applist && jsonData.applist.apps) { steamAppListCache = { data: jsonData.applist.apps, timestamp: Date.now() }; return steamAppListCache.data; } } } catch (e) {}
    return steamAppListCache.data;
}

async function deductFreeTime() {
    const updates = new Set();
    for (const u in liveAccounts) { if (liveAccounts[u].status === 'Rodando' || liveAccounts[u].status.startsWith('Iniciando') || liveAccounts[u].status.startsWith('Pendente')) { updates.add(liveAccounts[u].ownerUserID); } }
    if (updates.size === 0) return;
    const ids = Array.from(updates).map(id => new ObjectId(id));
    try {
        await usersCollection.updateMany({ _id: { $in: ids }, plan: 'free' }, { $inc: { freeHoursRemaining: -60000 } });
        const expired = await usersCollection.find({ _id: { $in: ids }, plan: 'free', freeHoursRemaining: { $lte: 0 } }).toArray();
        expired.forEach(u => { enforceUserLimits(u._id.toString()); });
    } catch(e) { console.error("[SYSTEM] Erro deductFreeTime:", e.message); }
}

async function checkExpiredPlans() {
    const now = new Date();
    try {
        const expired = await usersCollection.find({ plan: { $ne: 'free', $ne: 'lifetime' }, planExpiresAt: { $lt: now } }).toArray();
        for (const u of expired) {
            await usersCollection.updateOne({ _id: u._id }, { $set: { plan: 'free', planExpiresAt: null, freeHoursRemaining: 0 }, $unset: { customLimits: "" }});
            const accs = await accountsCollection.find({ ownerUserID: u._id.toString() }).toArray();
            for (const a of accs) {
                const s = { ...(a.settings || {}) };
                let dirty = false;
                if (s.appearOffline) { s.appearOffline = false; dirty = true; }
                if (s.customInGameTitle) { s.customInGameTitle = ''; dirty = true; }
                if (s.customAwayMessage) { s.customAwayMessage = ''; dirty = true; }
                if (s.autoAcceptFriends) { s.autoAcceptFriends = false; dirty = true; }
                if (dirty) {
                    await accountsCollection.updateOne({ _id: a._id }, { $set: { settings: s } });
                    if (liveAccounts[a.username]) liveAccounts[a.username].settings = s;
                }
            }
            await enforceUserLimits(u._id.toString());
        }
    } catch(e) { console.error("[SYSTEM] Erro checkExpiredPlans:", e.message); }
}

async function loadAccountsIntoMemory() {
    const savedAccounts = await accountsCollection.find({}).toArray(); 
    savedAccounts.forEach((acc) => {
        liveAccounts[acc.username] = { ...acc, encryptedPassword: acc.password, settings: { ...(acc.settings || {}) }, status: 'Parado', sessionStartTime: null, manual_logout: false, ownedGames: acc.ownedGames || [], machineId: acc.machineId };
    });
    console.log(`[SYSTEM] ${savedAccounts.length} contas carregadas.`);

    const autoStartAccounts = savedAccounts.filter(acc => acc.settings && acc.settings.autoRelogin);
    for (const [i, acc] of autoStartAccounts.entries()) {
        const delay = i * 15000; 
        setTimeout(() => {
            if (liveAccounts[acc.username]) {
                const pass = decrypt(acc.password);
                if (pass) startWorkerForAccount({ ...liveAccounts[acc.username], password: pass });
            }
        }, delay);
    }
}

async function generateLicenseForPurchase(purchase, userId) {
    try {
        const planId = purchase.planId;
        const planDetails = hasPlan(planId) ? GLOBAL_PLANS[planId] : null;
        const durationDays = planDetails && planDetails.days > 0 ? planDetails.days : (purchase.customConfig ? purchase.customConfig.days : 30);
        const key = `${planId.toUpperCase()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
        await licensesCollection.insertOne({
            key,
            plan: planId,
            durationDays,
            isUsed: false,
            assignedTo: new ObjectId(userId),
            createdAt: new Date()
        });
        return key;
    } catch (e) {
        console.error("[LICENSE] Erro ao gerar chave:", e.message);
        return null;
    }
}

// --- FUNÇÃO DE ATIVAÇÃO DE PLANO ---
async function activateUserPlan(userId, planId, customConfig) {
    try {
        const planDetails = hasPlan(planId) ? GLOBAL_PLANS[planId] : null;
        const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
        let newExpiry = null;
        const isSamePlan = user && user.plan === planId && user.planExpiresAt && new Date(user.planExpiresAt) > new Date();
        if (planId === 'lifetime') {
            // Vitalício: sem expiração
        } else if (planId === 'custom' && customConfig) {
            const days = customConfig.days || 30;
            const base = isSamePlan && new Date(user.planExpiresAt) > new Date() ? new Date(user.planExpiresAt) : new Date();
            base.setDate(base.getDate() + days); newExpiry = base;
        } else if (planDetails && planDetails.days > 0) {
            const base = isSamePlan ? new Date(user.planExpiresAt) : new Date();
            base.setDate(base.getDate() + planDetails.days); newExpiry = base;
        }

        const updateData = {
            plan: planId,
            planExpiresAt: newExpiry,
            freeHoursRemaining: 0,
            customLimits: null
        };

        const validLifetime = planId === 'lifetime';
        const validCustom = planId === 'custom' && customConfig;
        if (!validLifetime && !validCustom && newExpiry === null) {
            console.error(`[PAGAMENTO] Plano sem duração válida (deletado/days<=0): ${planId}. Ativação bloqueada.`);
            return false;
        }

        if (planId === 'custom' && customConfig) {
            updateData.customLimits = {
                accounts: customConfig.accounts || 1,
                games: customConfig.games || 10
            };
        }

        await usersCollection.updateOne(
            { _id: new ObjectId(userId) },
            { $set: updateData }
        );
        await enforceUserLimits(userId);
        return true;
    } catch (e) {
        console.error("[PAGAMENTO] Erro ao ativar plano:", e);
        return false;
    }
}

// Claim atômico de compra pendente — evita double-activation em webhook + polling concorrentes.
// Regra: o primeiro findOneAndUpdate em status 'pending' ganha; concorrentes não casam mais
// (status vira 'processing'), e nunca re-claim de um processing fresco — só stalled >10min.
async function claimPendingPurchase(userId, preferenceId, paymentId) {
    const staleAt = new Date(Date.now() - 10 * 60 * 1000);
    const now = new Date();

    // 1º: claim atômico em 'pending', priorizando a preferência correta
    let purchase = await purchasesCollection.findOneAndUpdate(
        preferenceId
            ? { userId: userId, status: 'pending', preferenceId: preferenceId }
            : { userId: userId, status: 'pending' },
        { $set: { status: 'processing', claimedAt: now, paymentId: paymentId || null } },
        { sort: { createdAt: 1 } }
    );

    if (purchase) return purchase;

    // 2º: fallback para purchases legadas sem preferenceId (só pendente)
    if (preferenceId) {
        purchase = await purchasesCollection.findOneAndUpdate(
            { userId: userId, status: 'pending' },
            { $set: { status: 'processing', claimedAt: now, paymentId: paymentId || null } },
            { sort: { createdAt: 1 } }
        );
        if (purchase) return purchase;
    }

    // 3º: recupera compra travada em 'processing' há >10min (crash/rede) — nunca um claim fresco
    return purchasesCollection.findOneAndUpdate(
        { userId: userId, status: 'processing', claimedAt: { $lt: staleAt } },
        { $set: { status: 'processing', claimedAt: now, paymentId: paymentId || null } },
        { sort: { claimedAt: 1 } }
    );
}

// --- WEBHOOK MERCADO PAGO ---
function verifyMpSignature(req, bodyRaw) {
    try {
        const signature = req.headers['x-signature'];
        const requestId = req.headers['x-request-id'];
        if (!signature || !requestId || !bodyRaw || !bodyRaw.data) return false;

        const parts = {};
        signature.split(',').forEach(p => {
            const [k, v] = p.split('=');
            parts[k.trim()] = v.trim();
        });

        if (!parts.ts || !parts.v1) return false;

        const manifest = `id:${bodyRaw.data.id};request-id:${requestId};ts:${parts.ts};`;
        const secret = MP_WEBHOOK_SECRET || MP_ACCESS_TOKEN;
        const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
        return safeCompare(hmac, parts.v1);
    } catch (e) {
        return false;
    }
}

app.post('/api/mercadopago-webhook', express.json(), ah(async (req, res) => {
    res.status(200).send('OK');

    try {
        const { type, data } = req.body || {};
        if (type !== 'payment' || !data || !data.id) return;
        if (!isStr(data.id, 1, 32) || !/^\d+$/.test(data.id)) return;

        if (MP_WEBHOOK_SECRET) {
            if (!verifyMpSignature(req, req.body)) {
                console.warn("[WEBHOOK MP] Assinatura inválida. Evento descartado.");
                return;
            }
        } else if (!verifyMpSignature(req, req.body)) {
            console.warn("[WEBHOOK MP] Sem MP_WEBHOOK_SECRET configurado — validando pagamento via API MP...");
        }

        const paymentId = data.id;

        const alreadyProcessed = await purchasesCollection.findOne({ paymentId: paymentId, status: 'completed' });
        if (alreadyProcessed) return;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
            headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
            signal: controller.signal
        });
        clearTimeout(timeout);
        const payment = await response.json();

        if (payment.status === 'approved' && payment.external_reference) {
            const userId = payment.external_reference;
            const purchase = await claimPendingPurchase(userId, payment.preference_id, paymentId);

            if (purchase) {
                console.log(`[WEBHOOK MP] Pagamento aprovado userId: ${userId}, plano: ${purchase.planId}`);

                const expected = typeof purchase.price === 'number' ? purchase.price : 0;
                const paid = typeof payment.transaction_amount === 'number' ? payment.transaction_amount : 0;
                if (paid + 0.01 < expected) {
                    console.warn(`[WEBHOOK MP] Valor divergente: esperado ${expected}, recebido ${paid}. Marcando como failed.`);
                    await purchasesCollection.updateOne({ _id: purchase._id }, { $set: { status: 'failed', paymentId: paymentId, paidAt: new Date() } });
                    sendDiscordNotification("⚠️ Pagamento com valor divergente", `MP ID: ${paymentId}\nEsperado: R$ ${expected}\nRecebido: R$ ${paid}`, 16753920, "System", "alert");
                    return;
                }

                let completed = false;

                if (purchase.deliveryMethod === 'email') {
                    const key = await generateLicenseForPurchase(purchase, userId);
                    completed = !!key;
                    if (key) {
                        sendDiscordNotification(
                            "📧 Licença Gerada (Email)",
                            `Usuário: ${purchase.username || userId}\nPlano: ${purchase.planId}\nChave: ${key}\nMP ID: ${paymentId}`,
                            16753920, "System", "sale"
                        );
                    }
                } else {
                    const activated = await activateUserPlan(
                        userId,
                        purchase.planId,
                        purchase.customConfig
                    );
                    completed = activated;
                }

                if (completed && purchase.couponCode) {
                    await couponsCollection.updateOne(
                        { code: purchase.couponCode },
                        { $inc: { usageCount: 1 } }
                    );
                }

                await purchasesCollection.updateOne(
                    { _id: purchase._id },
                    {
                        $set: {
                            status: completed ? 'completed' : 'processing',
                            claimedAt: new Date(),
                            paymentId: paymentId,
                            paidAt: new Date(),
                            paymentDetail: {
                                status: payment.status,
                                payment_method: payment.payment_method_id,
                                transaction_amount: payment.transaction_amount
                            }
                        }
                    }
                );

                if (completed) {
                    sendDiscordNotification(
                        "✅ Pagamento Aprovado",
                        `Usuário: ${purchase.username || userId}\nPlano: ${purchase.planId}\nValor: R$ ${payment.transaction_amount}\nMP ID: ${paymentId}`,
                        5763719, "System", "sale"
                    );
                }
            }
        }
    } catch (e) {
        console.error("[WEBHOOK MP] Erro ao processar:", e);
    }
}));

// --- EXPRESS MIDDLEWARES E ROTAS ---
app.use(express.json()); 
app.use(express.urlencoded({ extended: true })); 
app.use(session({ secret: SESSION_SECRET, resave: false, saveUninitialized: false, store: MongoStore.create({ mongoUrl: MONGODB_URI, dbName: 'stf-saas-db' }), cookie: { secure: 'auto', httpOnly: true, maxAge: 24 * 60 * 60 * 1000, sameSite: 'lax' } })); 
async function isAuthenticated(req, res, next) { 
    const isApiReq = req.baseUrl.startsWith('/api') || req.originalUrl.startsWith('/api/');
    if (req.session.userId && ObjectId.isValid(req.session.userId)) { 
        try {
            const user = await usersCollection.findOne({ _id: new ObjectId(req.session.userId) });
            if (user && !user.isBanned) return next();
            if (user && user.isBanned) req.session.destroy(() => { if (isApiReq) return res.status(401).json({ message: 'unauthorized' }); res.redirect('/banned'); });
        } catch (e) { console.error("[AUTH] Erro isAuthenticated:", e.message); }
    } 
    if (isApiReq) return res.status(401).json({ message: 'unauthorized' });
    res.redirect('/login?error=unauthorized'); 
}
const isAdminAuthenticated = (req, res, next) => { 
    const denied = () => { if (req.baseUrl.startsWith('/api') || req.originalUrl.startsWith('/api/')) return res.status(401).json({ message: 'unauthorized' }); return res.redirect('/admin/login?error=unauthorized'); };
    if (!req.session.isAdmin) return denied();
    const now = Date.now();
    if (req.session.adminLastActivity && (now - req.session.adminLastActivity) > 30 * 60 * 1000) {
        return req.session.destroy(() => denied());
    }
    req.session.adminLastActivity = now;
    next(); 
};

async function isMaintenanceMode() {
    try {
        const setting = await siteSettingsCollection.findOne({ _id: 'maintenance' });
        return setting && setting.active === true;
    } catch (e) { return false; }
}

// Maintenance middleware — BEFORE static files to catch index.html
app.use(async (req, res, next) => {
    if (req.path.startsWith('/admin/') || req.path.startsWith('/api/admin/')) return next();
    if (req.path === '/maintenance' || req.path === '/maintenance.html' || req.path === '/health') return next();
    if (req.path === '/api/global-alert' || req.path === '/api/auth-status' || req.path === '/api/geo-status') return next();
    // Let static assets through so maintenance page can load images/css
    if (/\.(png|jpg|jpeg|gif|ico|svg|css|js|woff2?|ttf|eot)$/i.test(req.path)) return next();
    const m = await isMaintenanceMode();
    if (m) {
        if (req.path.startsWith('/api/')) return res.status(503).json({ message: 'maintenance' });
        return res.sendFile(path.join(__dirname, 'public', 'maintenance.html'));
    }
    next();
});

// Bloqueia acesso direto a páginas autenticadas via static (authz só nas rotas protegidas)
const PROTECTED_PUBLIC_PAGES = {
    '/dashboard.html': '/dashboard',
    '/checkout.html': '/checkout',
    '/tutorial.html': '/tutorial',
    '/admin/dashboard.html': '/admin/dashboard'
};
app.use((req, res, next) => {
    let raw = req.path;
    try { raw = decodeURIComponent(raw); } catch (e) { /* mantém raw se inválido */ }
    const normalizedPath = path.posix.normalize(raw).replace(/\/+/g, '/');
    if (PROTECTED_PUBLIC_PAGES[normalizedPath]) return res.redirect(PROTECTED_PUBLIC_PAGES[normalizedPath]);
    next();
});

app.use(express.static(path.join(__dirname, 'public'))); 

// Health check público para uptime/lb (cron-job.org, Render, etc.)
app.get('/health', async (req, res) => {
    let dbOk = false;
    try {
        await mongoClient.db("stf-saas-db").command({ ping: 1 });
        dbOk = true;
    } catch (e) { dbOk = false; }
    if (!dbOk) return res.status(503).json({ status: 'degraded', uptime: process.uptime(), mongo: false });
    res.json({ status: 'ok', uptime: process.uptime(), mongo: true });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => req.session.userId ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => req.session.userId ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/dashboard', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/checkout', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkout.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/tutorial', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'tutorial.html')));
app.get('/banned', (req, res) => res.sendFile(path.join(__dirname, 'public', 'banned.html')));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));
app.get('/admin', (req, res) => res.redirect('/admin/dashboard'));
app.get('/admin/login', (req, res) => req.session.isAdmin ? res.redirect('/admin/dashboard') : res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html')));
app.post('/admin/login', loginLimiter, ah(async (req, res) => { const pw = req.body && req.body.password; if (safeCompare(pw, ADMIN_PASSWORD)) { req.session.regenerate((err) => { if (err) return res.redirect('/admin/login?error=invalid'); req.session.isAdmin = true; res.redirect('/admin/dashboard'); }); } else { res.redirect('/admin/login?error=invalid'); } }));
app.get('/admin/dashboard', isAdminAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html')));
app.get('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// --- ROTA DE VERIFICAÇÃO PÓS-COMPRA (registrada DEPOIS do middleware de sessão) ---
app.get('/api/checkout-success', checkoutLimiter, isAuthenticated, ah(async (req, res) => {
    const { payment_id } = req.query;
    const uid = req.session.userId;

    const paymentIdOk = payment_id === undefined || (isStr(payment_id, 1, 32) && /^\d+$/.test(payment_id));
    if (!paymentIdOk) return res.json({ success: false, message: "Pagamento inválido." });

    let payment = null;
    if (payment_id && MP_ACCESS_TOKEN) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);
            const response = await fetch(`https://api.mercadopago.com/v1/payments/${payment_id}`, {
                headers: { 'Authorization': `Bearer ${MP_ACCESS_TOKEN}` },
                signal: controller.signal
            });
            clearTimeout(timeout);
            if (response.ok) payment = await response.json();
        } catch (e) {
            console.error("[CHECKOUT] Erro ao verificar pagamento:", e.message);
        }
    }

    const paymentApproved = payment && payment.status === 'approved' && payment.external_reference === uid;

    if (!paymentApproved) {
        const completed = await purchasesCollection.findOne({ userId: uid, status: 'completed' });
        if (completed) return res.json({ success: true, message: "Plano já ativado anteriormente." });
        return res.json({ success: false, message: "Nenhuma compra pendente encontrada. Se você pagou, aguarde a confirmação automática (pode levar alguns minutos)." });
    }

    const purchase = await claimPendingPurchase(uid, payment && payment.preference_id, payment_id ? String(payment_id) : null);

    if (!purchase) {
        const completed = await purchasesCollection.findOne({ userId: uid, status: 'completed' });
        if (completed) return res.json({ success: true, message: "Plano já ativado anteriormente." });
        return res.json({ success: false, message: "Nenhuma compra pendente encontrada." });
    }

    const expected = typeof purchase.price === 'number' ? purchase.price : 0;
    const paid = typeof payment.transaction_amount === 'number' ? payment.transaction_amount : 0;
    if (paid + 0.01 < expected) {
        await purchasesCollection.updateOne({ _id: purchase._id }, { $set: { status: 'failed', paymentId: String(payment_id), paidAt: new Date() } });
        return res.json({ success: false, message: "Valor do pagamento não corresponde à compra." });
    }

    let completed = false;
    if (purchase.deliveryMethod === 'email') {
        const key = await generateLicenseForPurchase(purchase, uid);
        completed = !!key;
    } else {
        completed = await activateUserPlan(uid, purchase.planId, purchase.customConfig);
    }

    if (completed && purchase.couponCode) {
        await couponsCollection.updateOne({ code: purchase.couponCode }, { $inc: { usageCount: 1 } });
    }

    await purchasesCollection.updateOne(
        { _id: purchase._id },
        { $set: { status: completed ? 'completed' : 'processing', paymentId: String(payment_id), paidAt: new Date() } }
    );

    if (completed) return res.json({ success: true, message: purchase.deliveryMethod === 'email' ? "Licença gerada! O admin enviará a chave por email em breve." : "Plano ativado com sucesso!" });
    res.json({ success: false, message: "Erro ao ativar plano. Contate o suporte." });
}));

// === API ===
const apiRouter = express.Router();
const adminApiRouter = express.Router();

apiRouter.get('/global-alert', ah(async (req, res) => { try { const alert = await siteSettingsCollection.findOne({ _id: 'global_alert' }); res.json(alert || { active: false }); } catch (e) { res.status(500).json({}); } }));
apiRouter.get('/account-games/:username', isAuthenticated, ah(async (req, res) => { const u = req.params.username; if (!isStr(u, 1, 64)) return res.json([]); const acc = liveAccounts[u]; if (acc && acc.ownerUserID === req.session.userId) { res.json(acc.ownedGames || []); } else { const dbAcc = await accountsCollection.findOne({ username: u, ownerUserID: req.session.userId }); res.json(dbAcc ? (dbAcc.ownedGames || []) : []); } }));

apiRouter.post('/login', loginLimiter, ah(async (req, res) => { const { username, password } = req.body || {}; if (!isStr(username, 1, 64) || !isStr(password, 1, 128)) return res.status(401).json({ message: "Credenciais inválidas." }); const user = await usersCollection.findOne({ username: username.trim() }); if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ message: "Credenciais inválidas." }); if (user.isBanned) return res.status(403).json({ message: "Conta banida." }); req.session.regenerate((err) => { if (err) return res.status(500).json({ message: "Erro interno." }); req.session.userId = user._id.toString(); req.session.username = user.username; res.json({ message: "Login OK" }); }); }));
apiRouter.get('/auth-status', ah(async (req, res) => { if (req.session.userId) { if (!req.session.username) { try { const user = await usersCollection.findOne({ _id: new ObjectId(req.session.userId) }); if (user) req.session.username = user.username; } catch(e) {} } res.json({ loggedIn: true, username: req.session.username || 'Usuário' }); } else { res.json({ loggedIn: false }); }}));
apiRouter.get('/geo-status', (req, res) => { const country = getCountryFromRequest(req); res.json({ country: country, currency: country === 'BR' ? 'BRL' : 'USD' });});
apiRouter.get('/plans', async (req, res) => { try { const plans = await plansCollection.find({ active: true }).toArray(); plans.sort((a, b) => (a.id === 'free' ? -1 : b.id === 'free' ? 1 : a.price - b.price)); res.json(plans); } catch(e) { res.status(500).json([]); }});

// ATUALIZAÇÃO NO REGISTER (Gera a chave)
function validatePasswordStrength(password) {
    if (typeof password !== 'string' || password.length < 8) return "Senha deve ter no mínimo 8 caracteres.";
    if (password.length > 128) return "Senha muito longa (máx. 128 caracteres).";
    if (!/[A-Z]/.test(password)) return "Senha deve conter pelo menos uma letra maiúscula.";
    if (!/[0-9]/.test(password)) return "Senha deve conter pelo menos um número.";
    return null;
}

apiRouter.post('/register', registerLimiter, ah(async (req, res) => { 
    const { username, email, password } = req.body || {}; 
    if (!isUsername(username)) return res.status(400).json({ message: "Usuário deve ter 3-32 caracteres (letras, números, . _ -)." }); 
    if (!isEmail(email)) return res.status(400).json({ message: "E-mail válido é obrigatório." }); 
    const pwError = validatePasswordStrength(password);
    if (pwError) return res.status(400).json({ message: pwError });
    const ip = String(req.ip || '').replace(/^::ffff:/, '') || 'unknown'; 
    const accountsFromIP = await usersCollection.countDocuments({ registrationIP: ip }); 
    if (accountsFromIP >= 5) return res.status(429).json({ message: "Limite atingido." }); 
    try { 
        const hash = await bcrypt.hash(password, 10); 
        const recoveryKey = 'STF-' + crypto.randomBytes(8).toString('hex').toUpperCase(); 
        await usersCollection.insertOne({ username: username.trim(), email: email.trim().toLowerCase(), password: hash, recoveryKey, plan: 'free', freeHoursRemaining: FREE_HOURS_MS, isBanned: false, planExpiresAt: null, createdAt: new Date(), registrationIP: ip }); 
        sendDiscordNotification("👤 Novo Registo", `User: ${username.trim()}\nIP: ${ip}`, 3447003, username.trim(), "log"); 
        res.status(201).json({ message: "Conta criada!", recoveryKey }); 
    } catch (e) { res.status(409).json({ message: "Erro ao criar conta. Tente outro nome ou email." }); }
}));

apiRouter.post('/validate-coupon', apiLimiter, ah(async (req, res) => { const { code } = req.body || {}; if (!isStr(code, 1, 64)) return res.status(400).json({ valid: false }); try { const coupon = await couponsCollection.findOne({ code: code.toUpperCase() }); if (coupon) { const expired = coupon.expiresAt && new Date(coupon.expiresAt) < new Date(); const exhausted = coupon.maxUses && (coupon.usageCount || 0) >= coupon.maxUses; if (expired || exhausted) return res.json({ valid: false, message: "Cupom expirado ou esgotado." }); res.json({ valid: true, discount: coupon.discount }); } else { res.json({ valid: false, message: "Cupom inválido." }); } } catch (e) { res.status(500).json({ valid: false }); }}));

// NOVA ROTA DE RECUPERAÇÃO COM CHAVE
apiRouter.post('/recover-password', resetLimiter, ah(async (req, res) => {
    const { username, recoveryKey, newPassword } = req.body || {};
    if (!isStr(username, 3, 64) || !isStr(recoveryKey, 8, 64)) return res.status(400).json({ message: "Dados inválidos." });
    const pwError = validatePasswordStrength(newPassword);
    if (pwError) return res.status(400).json({ message: pwError });
    
    const user = await usersCollection.findOne({ username: username.trim(), recoveryKey: recoveryKey.toUpperCase().trim() });
    if (!user) return res.status(401).json({ message: "Usuário ou Chave de Recuperação inválidos." });
    
    const hash = await bcrypt.hash(newPassword, 10);
    const newKey = 'STF-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    await usersCollection.updateOne({ _id: user._id }, { $set: { password: hash, passwordChangedAt: new Date(), recoveryKey: newKey } });
    
    sendDiscordNotification("🔄 Senha Alterada (Recovery Key)", `User: ${username} recuperou a conta. Nova chave de recuperação gerada.`, 16753920, username, "log");
    res.json({ message: "Senha alterada com sucesso! Você já pode fazer login.", recoveryKey: newKey });
}));

apiRouter.use(isAuthenticated);
apiRouter.use(apiLimiter);
apiRouter.post('/renew-free-time', ah(async (req, res) => { const uid = req.session.userId; const user = await usersCollection.findOne({ _id: new ObjectId(uid) }); if (!user) return res.status(401).json({ message: "Sessão inválida." }); if (user.plan !== 'free') return res.status(400).json({ message: "Renovação disponível apenas no plano Gratuito." }); if (user.lastFreeRenew && (Date.now() - new Date(user.lastFreeRenew).getTime()) < 7 * 24 * 60 * 60 * 1000) { return res.status(429).json({ message: "Renovação disponível 1x por semana." }); } await usersCollection.updateOne({ _id: new ObjectId(uid) }, { $set: { freeHoursRemaining: FREE_HOURS_MS, lastFreeRenew: new Date() } }); res.json({ message: "Renovado" });}));
apiRouter.post('/create-checkout', ah(async (req, res) => {
    if (!mpClient) return res.status(500).json({ message: "Pagamento indisponível." });
    const { planId, customConfig, couponCode, deliveryMethod } = req.body || {};
    if (!isStr(planId, 1, 32)) return res.status(400).json({ message: "Plano inválido." });
    if (deliveryMethod && deliveryMethod !== 'direct' && deliveryMethod !== 'email') return res.status(400).json({ message: "Entrega inválida." });
    const delivery = deliveryMethod || 'direct';
    const userId = req.session.userId;
    const username = req.session.username;
    const isBrazil = getCountryFromRequest(req) === 'BR';
    let price = 0;
    let title = "";
    let metadata = {};
    let purchaseCustomConfig = null;
    if (planId === 'custom') {
        if (typeof customConfig !== 'object' || customConfig === null) return res.status(400).json({ message: "Config inválida." });
        let d = parseInt(customConfig.days, 10);
        let a = parseInt(customConfig.accounts, 10);
        let g = parseInt(customConfig.games, 10);
        if (isNaN(d) || d < 1 || d > 365 || isNaN(a) || a < 1 || a > 50 || isNaN(g) || g < 1 || g > 100) return res.status(400).json({ message: "Config inválida." });
        const PRICING = isBrazil ? CUSTOM_PRICING_BRL : CUSTOM_PRICING_USD;
        price = PRICING.BASE + (d * PRICING.DAY) + (a * PRICING.ACCOUNT) + (g * PRICING.GAME);
        if (price < (isBrazil ? 5.00 : 2.00)) return res.status(400).json({ message: "Abaixo do mínimo." });
        title = `STF Boost - Custom (${d}d/${a}c/${g}j)`;
        purchaseCustomConfig = { days: d, accounts: a, games: g };
        metadata = { plan_id: 'custom', custom_days: d, custom_accounts: a, custom_games: g };
    } else if (planId === 'free') {
        return res.status(400).json({ message: "Plano inválido." });
} else {
        const plan = hasPlan(planId) ? GLOBAL_PLANS[planId] : null;
        if (!plan || !plan.active) return res.status(400).json({ message: "Plano inválido." });
        price = isBrazil ? plan.price : (plan.price_usd || plan.price);
        if (typeof price !== 'number' || !isFinite(price) || price <= 0) return res.status(400).json({ message: "Plano inválido." });
        title = `STF Boost - ${plan.name}`;
        metadata = { plan_id: planId };
    }
    let appliedCoupon = null;
    if (couponCode) {
        if (!isStr(couponCode, 1, 64)) return res.status(400).json({ message: "Cupom inválido." });
        const coupon = await couponsCollection.findOne({ code: couponCode.toUpperCase().trim() });
        if (coupon) {
            const expired = coupon.expiresAt && new Date(coupon.expiresAt) < new Date();
            const exhausted = coupon.maxUses && (coupon.usageCount || 0) >= coupon.maxUses;
            if (expired || exhausted) return res.status(400).json({ message: "Cupom expirado ou esgotado." });
            let discount = coupon.discount;
            if (typeof discount !== 'number' || !isFinite(discount)) discount = 0;
            discount = Math.min(100, Math.max(0, discount));
            price = Math.max(0, price - ((price * discount) / 100));
            appliedCoupon = couponCode.toUpperCase().trim();
            metadata.coupon_code = appliedCoupon;
        }
    }
    metadata.delivery_method = delivery;
    const purchase = { userId, username, planId, price: parseFloat(price.toFixed(2)), deliveryMethod: delivery, couponCode: appliedCoupon, customConfig: purchaseCustomConfig, status: 'pending', preferenceId: null, paymentId: null, createdAt: new Date() };
    const purchaseResult = await purchasesCollection.insertOne(purchase);
    const userDoc = await usersCollection.findOne({ _id: new ObjectId(userId) });
    const userEmail = (userDoc && userDoc.email) ? userDoc.email : username + "@stfboost.com";
    if (isBrazil && mpClient) {
        const preference = new Preference(mpClient);
        const result = await preference.create({ body: { items: [{ title: title, quantity: 1, unit_price: purchase.price, currency_id: 'BRL' }], payer: { email: userEmail }, back_urls: { success: `${SITE_URL}/dashboard`, failure: `${SITE_URL}/checkout` }, auto_return: "approved", notification_url: `${SITE_URL}/api/mercadopago-webhook`, external_reference: userId, metadata: metadata } });
        await purchasesCollection.updateOne({ _id: purchaseResult.insertedId }, { $set: { preferenceId: result.id } });
        res.json({ url: result.init_point, provider: 'mercadopago' });
    } else {
        await purchasesCollection.updateOne({ _id: purchaseResult.insertedId }, { $set: { status: 'failed' } });
        res.status(400).json({ message: "Método de pagamento não disponível para sua região." });
    }
}));apiRouter.get('/user-info', ah(async (req, res) => { const user = await ensureUserPlanStatus(req.session.userId); if (!user) return res.status(404).json({ message: "Erro." }); let fh = user.plan === 'free' ? Math.ceil(user.freeHoursRemaining / 60000) : 0; const limits = getUserLimits(user); res.json({ username: user.username, plan: user.plan, freeHoursRemaining: fh, planExpiresAt: user.planExpiresAt, gameLimit: limits.games, accountLimit: limits.accounts, currentIP: getIpAndCountry(req).ip }); }));
apiRouter.get('/status', (req, res) => { const accs = {}; for(const u in liveAccounts) { if(liveAccounts[u].ownerUserID === req.session.userId) { const a = liveAccounts[u]; accs[u] = { username: a.username, status: a.status, games: a.games, settings: a.settings, uptime: a.sessionStartTime ? Date.now() - a.sessionStartTime : 0 }; } } res.json({ accounts: accs }); });
apiRouter.post('/add-account', addAccountLimiter, ah(async (req, res) => { const { username, password } = req.body || {}; if (!isUsername(username)) return res.status(400).json({ message: "Usuário deve ter 3-32 caracteres (letras, números, . _ -)." }); if (!isStr(password, 1, 128)) return res.status(400).json({ message: "Usuário ou senha inválidos." }); const uname = username.trim(); const uid = req.session.userId; const user = await ensureUserPlanStatus(uid); if (!user) return res.status(401).json({ message: "Sessão inválida." }); if (user.isBanned) return res.status(403).json({ message: "Conta banida." }); const count = await accountsCollection.countDocuments({ ownerUserID: uid }); const limits = getUserLimits(user); if (count >= limits.accounts) return res.status(403).json({ message: `Limite atingido.` }); if (await accountsCollection.findOne({ username: uname })) return res.status(400).json({ message: "Já existe." }); const ep = encrypt(password); if (!ep) return res.status(500).json({ message: "Erro interno. Tente novamente." }); await accountsCollection.insertOne({ username: uname, password: ep, games: [730], settings: {}, ownerUserID: uid }); liveAccounts[uname] = { username: uname, encryptedPassword: ep, games: [730], settings: {}, status: 'Parado', ownerUserID: uid }; res.json({ message: "OK" }); }));
apiRouter.post('/start/:username', ah(async (req, res) => { const u = req.params.username; if (!isStr(u, 1, 64)) return res.status(404).json({ message: "Erro." }); const acc = liveAccounts[u]; if (!acc || acc.ownerUserID !== req.session.userId) return res.status(404).json({ message: "Erro." }); const user = await ensureUserPlanStatus(req.session.userId); if (!user) return res.status(401).json({ message: "Sessão inválida." }); if (user.plan === 'free' && user.freeHoursRemaining <= 0) return res.status(403).json({ message: "Sem tempo." }); const limits = getUserLimits(user); if (acc.games.length > limits.games) return res.status(403).json({ message: "Limite jogos." }); let activeCount = 0; for (const k in liveAccounts) { const s = liveAccounts[k].status; if (liveAccounts[k].ownerUserID === req.session.userId && (s === 'Rodando' || s.startsWith('Iniciando') || s.startsWith('Pendente'))) activeCount++; } if (activeCount >= limits.accounts) return res.status(403).json({ message: "Limite contas online." }); try { const pass = decrypt(acc.encryptedPassword); if (pass) { startWorkerForAccount({ ...acc, password: pass }); res.json({ message: "OK" }); } else res.status(500).json({ message: "Erro senha." }); } catch (e) { res.status(500).json({ message: "Erro interno." }); } }));
apiRouter.post('/stop/:username', (req, res) => { const u = req.params.username; if (!isStr(u, 1, 64)) return res.status(404).json({ message: "Erro." }); const acc = liveAccounts[u]; if (acc && acc.ownerUserID === req.session.userId) { acc.manual_logout = true; cleanupAccount(acc); acc.status = "Parado"; res.json({ message: "OK" }); } else res.status(404).json({ message: "Erro." }); });
apiRouter.delete('/remove-account/:username', ah(async (req, res) => { const u = req.params.username; if (!isStr(u, 1, 64)) return res.status(404).json({ message: "Erro." }); if (liveAccounts[u] && liveAccounts[u].ownerUserID === req.session.userId) { liveAccounts[u].manual_logout = true; cleanupAccount(liveAccounts[u]); delete liveAccounts[u]; } await accountsCollection.deleteOne({ username: u, ownerUserID: req.session.userId }); res.json({ message: "OK" }); }));

const SETTINGS_SCHEMA = { appearOffline: 'bool', autoAcceptFriends: 'bool', autoRelogin: 'bool', customInGameTitle: 'str', customAwayMessage: 'str', sharedSecret: 'str' };
apiRouter.post('/save-settings/:username', ah(async (req, res) => {
    const u = req.params.username;
    const { settings } = req.body || {};
    if (!isStr(u, 1, 64) || typeof settings !== 'object' || settings === null || Array.isArray(settings)) return res.status(400).json({ message: "Dados inválidos." });
    const uid = req.session.userId;
    const user = await usersCollection.findOne({ _id: new ObjectId(uid) });
    if (!user) return res.status(401).json({ message: "Sessão inválida." });
    const currentLevel = PLAN_LEVELS[user.plan] || 0;
    for (const key of Object.keys(settings)) { if (!Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key)) return res.status(400).json({ message: "Configuração desconhecida." }); }
    const sanitized = {};
    if ('appearOffline' in settings) { if (typeof settings.appearOffline !== 'boolean') return res.status(400).json({ message: "appearOffline deve ser booleano." }); if (settings.appearOffline && currentLevel < 3) return res.status(403).json({ message: "Requer Plano Premium." }); sanitized.appearOffline = settings.appearOffline; }
    if ('autoAcceptFriends' in settings) { if (typeof settings.autoAcceptFriends !== 'boolean') return res.status(400).json({ message: "autoAcceptFriends deve ser booleano." }); if (settings.autoAcceptFriends && currentLevel < 2) return res.status(403).json({ message: "Requer Plano Plus." }); sanitized.autoAcceptFriends = settings.autoAcceptFriends; }
    if ('autoRelogin' in settings) { if (typeof settings.autoRelogin !== 'boolean') return res.status(400).json({ message: "autoRelogin deve ser booleano." }); sanitized.autoRelogin = settings.autoRelogin; }
    if ('customInGameTitle' in settings) { if (typeof settings.customInGameTitle !== 'string' || settings.customInGameTitle.length > 128) return res.status(400).json({ message: "Título inválido." }); if (settings.customInGameTitle.trim().length > 0 && currentLevel < 3) return res.status(403).json({ message: "Requer Plano Premium." }); sanitized.customInGameTitle = settings.customInGameTitle; }
    if ('customAwayMessage' in settings) { if (typeof settings.customAwayMessage !== 'string' || settings.customAwayMessage.length > 128) return res.status(400).json({ message: "Mensagem inválida." }); if (settings.customAwayMessage.trim().length > 0 && currentLevel < 3) return res.status(403).json({ message: "Requer Plano Premium." }); sanitized.customAwayMessage = settings.customAwayMessage; }
    if ('sharedSecret' in settings) { if (settings.sharedSecret !== '' && (typeof settings.sharedSecret !== 'string' || settings.sharedSecret.length < 8 || settings.sharedSecret.length > 64)) return res.status(400).json({ message: "Shared Secret inválido." }); sanitized.sharedSecret = settings.sharedSecret; }
    if (liveAccounts[u] && liveAccounts[u].ownerUserID === uid) {
        const merged = { ...(liveAccounts[u].settings || {}), ...sanitized };
        await accountsCollection.updateOne({ username: u, ownerUserID: uid }, { $set: { settings: merged } });
        liveAccounts[u].settings = merged;
        farmGames(liveAccounts[u]);
        res.json({ message: "OK" });
    } else res.status(404).json({ message: "Erro." });
}));
apiRouter.post('/set-games/:username', ah(async (req, res) => {
    const u = req.params.username;
    const { games } = req.body || {};
    if (!isStr(u, 1, 64)) return res.status(404).json({ message: "Erro." });
    if (!Array.isArray(games) || games.length === 0 || games.length > 100) return res.status(400).json({ message: "Lista de jogos inválida." });
    if (!games.every(g => Number.isInteger(g) && g > 0 && g < 2147483647)) return res.status(400).json({ message: "Jogo inválido." });
    const uid = req.session.userId;
    const user = await usersCollection.findOne({ _id: new ObjectId(uid) });
    if (!user) return res.status(401).json({ message: "Sessão inválida." });
    const limits = getUserLimits(user);
    const unique = [...new Set(games)];
    if (unique.length > limits.games) return res.status(403).json({ message: "Limite excedido." });
    if (liveAccounts[u] && liveAccounts[u].ownerUserID === uid) { await accountsCollection.updateOne({ username: u, ownerUserID: uid }, { $set: { games: unique } }); liveAccounts[u].games = unique; farmGames(liveAccounts[u]); res.json({ message: "OK" }); } else res.status(404).json({ message: "Erro." });
}));
apiRouter.post('/submit-guard/:username', (req, res) => { const u = req.params.username; const code = req.body && req.body.code; if (!isStr(u, 1, 64) || !isStr(code, 1, 32)) return res.status(400).json({ message: "Dados inválidos." }); const acc = liveAccounts[u]; if (acc && acc.ownerUserID === req.session.userId) { if (acc.steamGuardCallback) { acc.steamGuardCallback(code); acc.steamGuardCallback = null; } res.json({ message: "OK" }); } else res.status(404).json({ message: "Erro." }); });
apiRouter.get('/search-game', ah(async (req, res) => { const q = String(req.query.q || '').toLowerCase(); if (!isStr(q, 2, 100)) return res.json([]); const l = await getSteamAppList(); res.json(l.filter(a => String(a.name || '').toLowerCase().includes(q)).slice(0, 50)); }));
apiRouter.post('/activate-license', ah(async (req, res) => {
    const { licenseKey } = req.body || {};
    if (!isStr(licenseKey, 8, 64)) return res.status(400).json({ message: "Chave inválida." });
    const uid = req.session.userId;
    const key = await licensesCollection.findOne({ key: licenseKey.toUpperCase().trim() });
    if (!key || key.isUsed) return res.status(400).json({ message: "Inválida" });
    if (key.assignedTo && key.assignedTo.toString() !== uid) return res.status(403).json({ message: "Não é sua" });
    let exp = null; const duration = key.durationDays || (hasPlan(key.plan) ? GLOBAL_PLANS[key.plan].days : 30);
    if (duration > 0) { exp = new Date(); exp.setDate(exp.getDate() + duration); }
    const claimed = await licensesCollection.updateOne({ _id: key._id, isUsed: false }, { $set: { isUsed: true, usedBy: new ObjectId(uid), activatedAt: new Date() } });
    if (claimed.modifiedCount !== 1) return res.status(400).json({ message: "Chave já utilizada." });
    await usersCollection.updateOne({ _id: new ObjectId(uid) }, { $set: { plan: key.plan, planExpiresAt: exp, freeHoursRemaining: 0, customLimits: null } });
    await enforceUserLimits(uid);
    sendDiscordNotification("🔑 Chave Ativada", `User: ${uid} | Plano: ${key.plan}`, 3447003, "System", "sale");
    res.json({ message: "Ativado" });
}));
apiRouter.get('/my-keys', ah(async (req, res) => { const k = await licensesCollection.find({ assignedTo: new ObjectId(req.session.userId), isUsed: false }).toArray(); res.json(k); }));
apiRouter.post('/change-password', sensitiveLimiter, ah(async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body || {};
    if (!isStr(currentPassword, 1, 128)) return res.status(400).json({ message: "Senha atual é obrigatória." });
    const pwError = validatePasswordStrength(newPassword);
    if (pwError) return res.status(400).json({ message: pwError });
    if (newPassword !== confirmPassword) return res.status(400).json({ message: "Senhas não conferem." });
    const user = await usersCollection.findOne({ _id: new ObjectId(req.session.userId) });
    if (!user || !(await bcrypt.compare(currentPassword, user.password))) return res.status(401).json({ message: "Senha atual incorreta." });
    const h = await bcrypt.hash(newPassword, 10);
    const newKey = 'STF-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    await usersCollection.updateOne({ _id: new ObjectId(req.session.userId) }, { $set: { password: h, passwordChangedAt: new Date(), recoveryKey: newKey } });
    res.json({ message: "Senha alterada com sucesso.", recoveryKey: newKey });
}));
apiRouter.post('/bulk-start', ah(async (req, res) => {
    const { usernames } = req.body || {};
    if (!isStrArray(usernames, 50)) return res.status(400).json({ message: "Lista inválida." });
    const uid = req.session.userId;
    const user = await ensureUserPlanStatus(uid);
    if (!user) return res.status(401).json({ message: "Sessão inválida." });
    if (user.plan === 'free' && user.freeHoursRemaining <= 0) return res.status(403).json({ message: "Sem horas." });
    const limits = getUserLimits(user);
    let active = 0;
    for (const k in liveAccounts) { if (liveAccounts[k].ownerUserID === uid && (liveAccounts[k].status === 'Rodando' || liveAccounts[k].status.startsWith('Iniciando') || liveAccounts[k].status.startsWith('Pendente'))) active++; }
    let c = 0;
    for (const uname of usernames) {
        if (active >= limits.accounts) break;
        const acc = liveAccounts[uname];
        if (acc && acc.ownerUserID === uid && acc.games.length > 0 && acc.games.length <= limits.games && (acc.status === 'Parado' || acc.status.includes('Esgotado') || acc.status.includes('Expirado'))) {
            const p = decrypt(acc.encryptedPassword);
            if (p) { startWorkerForAccount({ ...acc, password: p }); c++; active++; }
        }
    }
    res.json({ message: `${c} iniciadas.` });
}));
apiRouter.post('/bulk-stop', (req, res) => {
    const { usernames } = req.body || {};
    if (!isStrArray(usernames, 50)) return res.status(400).json({ message: "Lista inválida." });
    usernames.forEach(u => { const acc = liveAccounts[u]; if (acc && acc.ownerUserID === req.session.userId) { acc.manual_logout = true; cleanupAccount(acc); acc.status = "Parado"; } });
    res.json({ message: "Paradas." });
});
apiRouter.post('/bulk-remove', ah(async (req, res) => {
    const { usernames } = req.body || {};
    if (!isStrArray(usernames, 50)) return res.status(400).json({ message: "Lista inválida." });
    usernames.forEach(u => { const acc = liveAccounts[u]; if (acc && acc.ownerUserID === req.session.userId) { cleanupAccount(acc); delete liveAccounts[u]; } });
    await accountsCollection.deleteMany({ username: { $in: usernames }, ownerUserID: req.session.userId });
    res.json({ message: "Removidas." });
}));

apiRouter.use(apiErrorHandler);

// API Admin
adminApiRouter.use(isAdminAuthenticated);
adminApiRouter.get('/users', ah(async (req, res) => { 
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const total = await usersCollection.countDocuments({});
    const users = await usersCollection.aggregate([
        { $sort: { _id: -1 } },
        { $skip: skip },
        { $limit: limit },
        {
            $addFields: { userIdStr: { $toString: "$_id" } }
        },
        {
            $lookup: {
                from: "accounts",
                localField: "userIdStr",
                foreignField: "ownerUserID",
                as: "steamAccounts"
            }
        },
        {
            $project: {
                username: 1,
                email: 1,
                plan: 1,
                isBanned: 1,
                recoveryKey: 1,
                freeHoursRemaining: 1,
                planExpiresAt: 1,
                createdAt: 1,
                steamAccounts: 1
            }
        }
    ]).toArray();

    for (let u of users) {
        u.steamAccounts = (u.steamAccounts || []).map(a => ({
            username: a.username,
            sharedSecret: a.settings && a.settings.sharedSecret ? a.settings.sharedSecret : null
        }));
    }

    res.json({
        users,
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit)
    });
}));

// NOVA ROTA: Reset da Key pelo Admin
adminApiRouter.post('/reset-user-key', ah(async (req, res) => {
    const { userId } = req.body || {};
    if (!isObjId(userId)) return res.status(400).json({ message: "Usuário inválido." });
    const newKey = 'STF-' + crypto.randomBytes(8).toString('hex').toUpperCase();
    const updated = await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { recoveryKey: newKey } });
    if (updated.modifiedCount !== 1 && updated.matchedCount !== 1) return res.status(404).json({ message: "Usuário não encontrado." });
    res.json({ message: "Nova chave gerada com sucesso: " + newKey, newKey });
}));

adminApiRouter.get('/all-plans', ah(async (req, res) => res.json(await plansCollection.find({}).sort({ price: 1 }).toArray())));
adminApiRouter.get('/licenses', ah(async (req, res) => { 
    const licenses = await licensesCollection.find({}).sort({ createdAt: -1 }).toArray();
    for (let k of licenses) {
        if (k.isUsed && k.usedBy) {
            const u = await usersCollection.findOne({ _id: k.usedBy });
            if (u) k.usedByUsername = u.username;
        }
    }
    res.json(licenses);
}));
adminApiRouter.get('/coupons', ah(async (req, res) => res.json(await couponsCollection.find({}).toArray())));
adminApiRouter.post('/generate-keys', ah(async (req, res) => { const { plan, quantity, durationDays } = req.body || {}; if (!isStr(plan, 1, 32) || !hasPlan(plan)) return res.status(400).json({ message: "Plano inválido." }); const qty = Math.min(100, Math.max(1, parseInt(quantity) || 1)); if (!Number.isInteger(qty)) return res.status(400).json({ message: "Quantidade inválida." }); let days = parseInt(durationDays, 10); if (isNaN(days)) days = null; else if (days < 0 || days > 3650) return res.status(400).json({ message: "Duração inválida." }); const keys = []; for (let i = 0; i < qty; i++) { const key = `${plan.toUpperCase()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`; await licensesCollection.insertOne({ key, plan, durationDays: days, isUsed: false, createdAt: new Date() }); keys.push(key); } res.json({ keys, message: "Gerado." }); }));
adminApiRouter.post('/ban-user', ah(async (req, res) => { if (req.body.confirm !== true && req.body.confirm !== 'true') return res.status(400).json({ message: "Confirmação necessária." }); if (!isObjId(req.body.userId)) return res.status(400).json({ message: "Usuário inválido." }); await usersCollection.updateOne({ _id: new ObjectId(req.body.userId) }, { $set: { isBanned: true } }); for (const u in liveAccounts) { if (liveAccounts[u].ownerUserID === req.body.userId) { cleanupAccount(liveAccounts[u]); } } res.json({ message: "Banido." }); }));
adminApiRouter.post('/unban-user', ah(async (req, res) => { if (req.body.confirm !== true && req.body.confirm !== 'true') return res.status(400).json({ message: "Confirmação necessária." }); if (!isObjId(req.body.userId)) return res.status(400).json({ message: "Usuário inválido." }); await usersCollection.updateOne({ _id: new ObjectId(req.body.userId) }, { $set: { isBanned: false } }); res.json({ message: "Desbanido." }); }));
adminApiRouter.post('/delete-user', ah(async (req, res) => { if (req.body.confirm !== true && req.body.confirm !== 'true') return res.status(400).json({ message: "Confirmação necessária." }); const uid = req.body.userId; if (!isObjId(uid)) return res.status(400).json({ message: "Usuário inválido." }); await usersCollection.deleteOne({ _id: new ObjectId(uid) }); await accountsCollection.deleteMany({ ownerUserID: uid }); for (const u in liveAccounts) { if (liveAccounts[u].ownerUserID === uid) { cleanupAccount(liveAccounts[u]); delete liveAccounts[u]; } } res.json({ message: "Deletado." }); }));

adminApiRouter.post('/update-plan', ah(async (req, res) => {
    const { userId, newPlan } = req.body || {};
    if (!isObjId(userId)) return res.status(400).json({ message: "Usuário inválido." });
    if (!isStr(newPlan, 1, 32) || !hasPlan(newPlan)) return res.status(400).json({ message: "Plano inválido." });
    const planDetails = hasPlan(newPlan) ? GLOBAL_PLANS[newPlan] : null;
    let newExpiry = null;
    if (newPlan !== 'free' && newPlan !== 'lifetime' && planDetails && planDetails.days > 0) { const d = new Date(); d.setDate(d.getDate() + planDetails.days); newExpiry = d; }
    const userAfter = await usersCollection.findOne({ _id: new ObjectId(userId) });
    const wasLevel = userAfter ? (PLAN_LEVELS[userAfter.plan] || 0) : 0;
    const nowLevel = (PLAN_LEVELS[newPlan] || 0);
    await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { plan: newPlan, planExpiresAt: newExpiry || null, customLimits: null, freeHoursRemaining: 0 } });
    if (nowLevel < wasLevel) {
        const accs = await accountsCollection.find({ ownerUserID: userId }).toArray();
        for (const a of accs) {
            const s = { ...(a.settings || {}) };
            let dirty = false;
            if (nowLevel < 3) {
                if (s.appearOffline) { s.appearOffline = false; dirty = true; }
                if (s.customInGameTitle) { s.customInGameTitle = ''; dirty = true; }
                if (s.customAwayMessage) { s.customAwayMessage = ''; dirty = true; }
            }
            if (nowLevel < 2 && s.autoAcceptFriends) { s.autoAcceptFriends = false; dirty = true; }
            if (dirty) {
                await accountsCollection.updateOne({ _id: a._id }, { $set: { settings: s } });
                if (liveAccounts[a.username]) liveAccounts[a.username].settings = s;
            }
        }
    }
    sendDiscordNotification("🔧 Plano Alterado", `User: ${userId} -> ${newPlan}`, 5763719, "System", "sale");
    await enforceUserLimits(userId);
    res.json({ message: "Atualizado." });
}));

adminApiRouter.post('/assign-key', ah(async (req, res) => { const { licenseId, username } = req.body || {}; if (!isObjId(licenseId)) return res.status(400).json({ message: "Licença inválida." }); if (!isStr(username, 3, 64)) return res.status(400).json({ message: "Usuário inválido." }); const user = await usersCollection.findOne({ username: username.trim() }); if (!user) return res.status(404).json({ message: "User não achado." }); await licensesCollection.updateOne({ _id: new ObjectId(licenseId) }, { $set: { assignedTo: user._id, assignedToUsername: user.username } }); res.json({ message: "Atribuído." }); }));
adminApiRouter.post('/delete-license', ah(async (req, res) => { const { licenseId } = req.body || {}; if (!isObjId(licenseId)) return res.status(400).json({ message: "Licença inválida." }); await licensesCollection.deleteOne({ _id: new ObjectId(licenseId) }); res.json({ message: "Deletado." }); }));
adminApiRouter.post('/update-plan-details', ah(async (req, res) => {
    const { id, name, price, days, accounts, games, style, active, features, price_usd } = req.body || {};
    if (!isStr(id, 1, 32) || !/^[a-z0-9_\-]{1,32}$/.test(id) || id === '__proto__' || id === 'constructor' || !isStr(name, 1, 64) || !isStr(style, 1, 32)) return res.status(400).json({ message: "Dados inválidos." });
    const p = parseFloat(price); const pu = parseFloat(price_usd);
    const d = parseInt(days, 10); const a = parseInt(accounts, 10); const g = parseInt(games, 10);
    if (isNaN(p) || !isFinite(p) || p < 0 || p > 100000 || isNaN(pu) || !isFinite(pu) || pu < 0 || pu > 100000) return res.status(400).json({ message: "Preço inválido." });
    if (isNaN(d) || d < 0 || d > 3650 || isNaN(a) || a < 1 || a > 100 || isNaN(g) || g < 1 || g > 100) return res.status(400).json({ message: "Valores inválidos." });
    if (features !== undefined && (!Array.isArray(features) || features.length > 20 || !features.every(f => typeof f === 'string' && f.length <= 200))) return res.status(400).json({ message: "Features inválidas." });
    const set = { name, price: p, price_usd: pu, days: d, accounts: a, games: g, style, active: active === true || active === 'true', features: features || [] };
    await plansCollection.updateOne({ id: id }, { $set: set }, { upsert: true });
    await refreshPlansCache();
    res.json({ message: "OK" });
}));
adminApiRouter.post('/delete-plan', ah(async (req, res) => { const { id } = req.body || {}; if (!isStr(id, 1, 32) || !/^[a-z0-9_\-]{1,32}$/.test(id) || id === '__proto__' || id === 'constructor') return res.status(400).json({ message: "Plano inválido." }); if (id === 'free' || id === 'custom') return res.status(400).json({ message: "Este plano não pode ser removido." }); await plansCollection.deleteOne({ id: id }); await refreshPlansCache(); res.json({ message: "OK" }); }));
adminApiRouter.post('/create-coupon', ah(async (req, res) => {
    const { code, discount, maxUses, expiresAt } = req.body || {};
    if (!isStr(code, 3, 32) || !/^[A-Za-z0-9_\-]+$/.test(code)) return res.status(400).json({ message: "Código inválido (3-32 letras/números/_/-)." });
    const discountNum = parseInt(discount, 10);
    if (isNaN(discountNum) || discountNum < 0 || discountNum > 100) return res.status(400).json({ message: "Desconto deve ser 0-100%." });
    let newExpiresAt = null;
    if (expiresAt) { const t = new Date(expiresAt); if (isNaN(t.getTime())) return res.status(400).json({ message: "Data de expiração inválida." }); newExpiresAt = t; }
    const maxUsesNum = maxUses === undefined || maxUses === null || maxUses === '' ? null : parseInt(maxUses, 10);
    if (maxUsesNum !== null && (isNaN(maxUsesNum) || maxUsesNum < 1 || maxUsesNum > 1000000)) return res.status(400).json({ message: "Limite de usos inválido." });
    const existing = await couponsCollection.findOne({ code: code.toUpperCase() });
    if (existing) return res.status(409).json({ message: "Cupom já existe." });
    await couponsCollection.insertOne({ code: code.toUpperCase(), discount: discountNum, usageCount: 0, maxUses: maxUsesNum, expiresAt: newExpiresAt, createdAt: new Date() });
    res.json({ message: "Criado." });
}));
adminApiRouter.post('/delete-coupon', ah(async (req, res) => { const { id } = req.body || {}; if (!isObjId(id)) return res.status(400).json({ message: "Cupom inválido." }); await couponsCollection.deleteOne({ _id: new ObjectId(id) }); res.json({ message: "Deletado." }); }));
adminApiRouter.post('/update-global-alert', ah(async (req, res) => { const { message, type, active } = req.body || {}; if (!isStr(message, 1, 500)) return res.status(400).json({ message: "Mensagem inválida." }); if (type !== undefined && type !== 'info' && type !== 'warning' && type !== 'danger' && type !== 'success') return res.status(400).json({ message: "Tipo inválido." }); await siteSettingsCollection.updateOne({ _id: 'global_alert' }, { $set: { message, type: type || 'info', active: active === true || active === 'true', updatedAt: new Date() } }, { upsert: true }); res.json({ message: "Alerta atualizado." }); }));

adminApiRouter.post('/toggle-maintenance', ah(async (req, res) => {
    const setting = await siteSettingsCollection.findOne({ _id: 'maintenance' });
    const nowActive = setting && setting.active === true;
    await siteSettingsCollection.updateOne(
        { _id: 'maintenance' },
        { $set: { active: !nowActive, updatedAt: new Date() } },
        { upsert: true }
    );
    res.json({ active: !nowActive, message: nowActive ? 'Manutenção desligada' : 'Manutenção ligada' });
}));
adminApiRouter.get('/maintenance-status', ah(async (req, res) => {
    const setting = await siteSettingsCollection.findOne({ _id: 'maintenance' });
    res.json({ active: setting && setting.active === true });
}));
adminApiRouter.get('/account-password/:username', ah(async (req, res) => { const username = req.params.username; if (!isStr(username, 1, 64)) return res.status(400).json({ message: "Conta inválida." }); const acc = await accountsCollection.findOne({ username }); if (!acc) return res.status(404).json({ message: "Conta não encontrada." }); const pass = decrypt(acc.password); res.json({ password: pass || "Erro ao descriptografar" }); }));

adminApiRouter.use(apiErrorHandler);

// --- WATCHDOG (SISTEMA DE INTELIGÊNCIA ANTI-CONGELAMENTO E ANTI-LOOP) ---
if (process.env.NODE_ENV !== 'test') setInterval(() => {
    const now = Date.now();
    for (const u in liveAccounts) {
        const acc = liveAccounts[u];
        
        if (!acc.lastHealthyTime) acc.lastHealthyTime = now;

        if (acc.manual_logout || !acc.settings || !acc.settings.autoRelogin) {
            acc.lastHealthyTime = now; 
            continue;
        }

        const accStatus = String(acc.status || '');

        const isHealthyOrWaiting = 
            accStatus === 'Rodando' || 
            accStatus.includes('Guard') || 
            accStatus.includes('Senha Inválida') || 
            accStatus.includes('Limite') || 
            accStatus.includes('Esgotado') || 
            accStatus.includes('Expirado') || 
            accStatus.includes('Banido') || 
            accStatus.includes('Secret Inválido') ||
            accStatus.includes('Bloqueio Temp'); 

        if (isHealthyOrWaiting) {
            if (accStatus === 'Rodando' && (!acc.client || !acc.client.steamID)) {
                // False positive
            } else {
                acc.lastHealthyTime = now; 
            }
        }

        if (now - acc.lastHealthyTime > 4 * 60 * 1000) {
            console.log(`[WATCHDOG] ⚠️ Conta congelada/em loop detectada: ${acc.username} (Presa no status: ${accStatus}). Injetando reinício limpo...`);
            
            sendDiscordNotification("🔧 Watchdog Atuou!", `A conta estava presa no status:\n**${accStatus}**\n\nO sistema forçou um reinício automático para curar o loop.`, 16753920, acc.username, "alert");

            acc.status = "Auto-Recuperando..."; 
            acc.lastHealthyTime = now; 
            acc.retryCount = 0; 
            
            const pass = decrypt(acc.encryptedPassword);
            if (pass) {
                startWorkerForAccount({ ...acc, password: pass });
            }
        }
    }
}, 60000); 


// --- START SERVER ---
async function startServer() {
    console.log("[SYSTEM] Conectando ao DB...");
    try {
        await connectToDB();
        await initializePlans(); 
        await initializeMasterKey();
        await loadAccountsIntoMemory();
        setInterval(deductFreeTime, 60000);
        setInterval(checkExpiredPlans, 60000);
        app.use('/api/admin', adminApiRouter);
        app.use('/api', apiRouter);
        app.use(apiErrorHandler);
        app.listen(PORT, () => console.log(`[SYSTEM] Online na porta ${PORT}`));
    } catch (e) { console.error("[SYSTEM] ERRO FATAL:", e); }
}
if (process.env.NODE_ENV === 'test') {
    const __setCollections = (cols = {}) => {
        accountsCollection = cols.accounts || accountsCollection;
        usersCollection = cols.users || usersCollection;
        licensesCollection = cols.licenses || licensesCollection;
        plansCollection = cols.plans || plansCollection;
        couponsCollection = cols.coupons || couponsCollection;
        purchasesCollection = cols.purchases || purchasesCollection;
        siteSettingsCollection = cols.siteSettings || siteSettingsCollection;
        return true;
    };
    module.exports = {
        app, apiRouter, adminApiRouter, __setCollections,
        GLOBAL_PLANS, PLAN_LEVELS, PLAN_LIMITS, hasPlan, getUserLimits,
        encrypt, decrypt, safeCompare, isStr, isUsername, isEmail, isObjId,
        isStrArray, validatePasswordStrength,
        claimPendingPurchase, activateUserPlan, sanitizeGatedSettingsForOwner,
        generateLicenseForPurchase, refreshPlansCache, isMaintenanceMode,
        checkExpiredPlans, enforceUserLimits, verifyMpSignature,
        isAuthenticated, isAdminAuthenticated, apiErrorHandler,
        liveAccounts,
    };
    if (typeof module.exports.liveAccounts !== 'object') module.exports.liveAccounts = {};
} else {
    startServer();
}
