const express = require('express');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { MongoClient, ObjectId } = require('mongodb'); 
const crypto = require('crypto');
const { fork } = require('child_process');
const https = require('https');
const bcrypt = require('bcryptjs'); 
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const geoip = require('geoip-lite');

// --- DEPENDÊNCIAS DE SEGURANÇA ---
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

console.log("[SYSTEM] Inicializando módulos...");

// --- CONFIGURAÇÃO ---
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_PASSWORD = process.env.SITE_PASSWORD; 
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL; 
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const MP_WEBHOOK_SECRET = process.env.MP_WEBHOOK_SECRET || MP_ACCESS_TOKEN; 
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SITE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

if (!MONGODB_URI || !ADMIN_PASSWORD) { 
    console.error("ERRO CRÍTICO: Variáveis de ambiente faltando!"); 
    process.exit(1); 
}

// --- CONTROLE DE RECURSOS ---
const MAX_CONCURRENT_WORKERS = 10; 
let workerQueue = [];
let activeWorkerCount = 0;

app.set('trust proxy', 1);

// --- MIDDLEWARES ---
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: SITE_URL, credentials: true }));

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 10, 
    message: { message: "Muitas tentativas de login. Tente novamente em 15 minutos." }
});

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, 
    max: 5, 
    message: { message: "Muitos cadastros. Aguarde um pouco." }
});

// Configura Pagamentos
let mpClient, stripe;
if (MP_ACCESS_TOKEN) {
    mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
    console.log("[SYSTEM] Mercado Pago configurado.");
}
if (STRIPE_SECRET_KEY) {
    stripe = require('stripe')(STRIPE_SECRET_KEY);
    console.log("[SYSTEM] Stripe configurado.");
}

const ALGORITHM = 'aes-256-cbc';
let appSecretKey; 
let steamAppListCache = { data: [{appid: 730, name: "Counter-Strike 2"}], timestamp: 0 }; 

// --- CONSTANTES ---
const ALL_PLANS = ['free', 'basic', 'plus', 'premium', 'ultimate', 'lifetime', 'halloween', 'christmas', 'newyear', 'custom'];
const FREE_HOURS_MS = 50 * 60 * 60 * 1000; 

const CUSTOM_PRICING_BRL = { BASE: 5.00, DAY: 0.10, ACCOUNT: 2.00, GAME: 0.10 };
const CUSTOM_PRICING_USD = { BASE: 2.00, DAY: 0.05, ACCOUNT: 1.00, GAME: 0.05 };

let PLAN_LIMITS = {
    'free': { accounts: 1, games: 1 },
    'basic': { accounts: 2, games: 6 },
    'plus': { accounts: 4, games: 12 },
    'premium': { accounts: 6, games: 24 },
    'ultimate': { accounts: 10, games: 33 },
    'lifetime': { accounts: 10, games: 33 },
    'halloween': { accounts: 8, games: 33 },
    'christmas': { accounts: 10, games: 33 },
    'newyear': { accounts: 10, games: 33 },
    'custom': { accounts: 1, games: 10 } 
};
let GLOBAL_PLANS = {}; 

// --- DADOS ---
const mongoClient = new MongoClient(MONGODB_URI);
let accountsCollection;
let siteSettingsCollection;
let usersCollection; 
let licensesCollection; 
let plansCollection; 
let couponsCollection; 
let liveAccounts = {};

// --- FUNÇÕES CORE ---
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
        
        await usersCollection.createIndex({ username: 1 }, { unique: true });
        await usersCollection.createIndex({ email: 1 }, { unique: true });
        await licensesCollection.createIndex({ key: 1 }, { unique: true }); 
        await couponsCollection.createIndex({ code: 1 }, { unique: true }); 
        await usersCollection.createIndex({ registrationIP: 1 });
    } catch (e) { 
        console.error("[DB] Erro fatal:", e); process.exit(1); 
    } 
}

async function initializePlans() {
    const defaultPlans = [
        { id: 'free', name: 'Gratuito', price: 0, price_usd: 0, days: 0, accounts: 1, games: 1, style: 'none', active: true, features: ['50 Horas', '1 Conta', '1 Jogo'] },
        { id: 'basic', name: 'Basic', price: 7.90, price_usd: 3.99, days: 30, accounts: 2, games: 6, style: 'none', active: true, features: ['30 Dias', '2 Contas', '6 Jogos'] },
        { id: 'plus', name: 'Plus', price: 15.90, price_usd: 6.99, days: 30, accounts: 4, games: 12, style: 'none', active: true, features: ['30 Dias', '4 Contas', '12 Jogos'] },
        { id: 'premium', name: 'Premium', price: 27.90, price_usd: 9.99, days: 30, accounts: 6, games: 24, style: 'fire', active: true, features: ['30 Dias', '6 Contas', '24 Jogos'] },
        { id: 'ultimate', name: 'Ultimate', price: 54.90, price_usd: 14.99, days: 30, accounts: 10, games: 33, style: 'none', active: true, features: ['30 Dias', '10 Contas', '33 Jogos'] },
        { id: 'lifetime', name: 'Vitalício', price: 249.90, price_usd: 49.99, days: 0, accounts: 10, games: 33, style: 'cosmic', active: true, features: ['Vitalício', '10 Contas', '33 Jogos'] },
        { id: 'halloween', name: 'Halloween', price: 19.90, price_usd: 7.99, days: 45, accounts: 8, games: 33, style: 'halloween', active: true, features: ['45 Dias', '8 Contas', '33 Jogos'] },
        { id: 'christmas', name: 'Natal', price: 89.90, price_usd: 29.99, days: 365, accounts: 10, games: 33, style: 'christmas', active: true, features: ['1 Ano', '10 Contas', '33 Jogos'] },
        { id: 'newyear', name: 'Ano Novo', price: 12.90, price_usd: 5.99, days: 30, accounts: 10, games: 33, style: 'newyear', active: true, features: ['30 Dias', '10 Contas', '33 Jogos'] },
        { id: 'custom', name: 'Personalizado', price: 15.00, price_usd: 5.00, days: 30, accounts: 1, games: 10, style: 'none', active: true, features: ['Personalizado'] }
    ];

    for (const plan of defaultPlans) {
        const existing = await plansCollection.findOne({ id: plan.id });
        if (!existing) {
            await plansCollection.insertOne(plan);
        } else if (existing.price_usd === undefined) {
            await plansCollection.updateOne({ id: plan.id }, { $set: { price_usd: plan.price_usd } });
        }
    }
    await refreshPlansCache();
}

async function refreshPlansCache() {
    try {
        const plans = await plansCollection.find({}).toArray();
        GLOBAL_PLANS = {};
        plans.forEach(p => { 
            GLOBAL_PLANS[p.id] = p; 
            PLAN_LIMITS[p.id] = { accounts: p.accounts, games: p.games }; 
        });
        console.log("[SYSTEM] Cache de planos atualizado.");
    } catch (e) { console.error("Erro ao atualizar cache de planos:", e); }
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

// --- FUNÇÕES AUXILIARES ---
const encrypt = (text) => { if (!appSecretKey) return null; const iv = crypto.randomBytes(16); const cipher = crypto.createCipheriv(ALGORITHM, appSecretKey, iv); let encrypted = cipher.update(text, 'utf8', 'hex'); encrypted += cipher.final('hex'); return `${iv.toString('hex')}:${encrypted}`; };
const decrypt = (text) => { try { if (!appSecretKey || !text) return ""; const textParts = text.split(':'); const iv = Buffer.from(textParts.shift(), 'hex'); const encryptedText = Buffer.from(textParts.join(':'), 'hex'); const decipher = crypto.createDecipheriv(ALGORITHM, appSecretKey, iv); let decrypted = decipher.update(encryptedText, 'hex', 'utf8'); decrypted += decipher.final('utf8'); return decrypted; } catch (error) { return ""; }};

function safeCompare(a, b) {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

function sendDiscordNotification(title, message, color, username, type = 'log') {
    let webhookUrl = process.env.DISCORD_WEBHOOK_LOGS || DISCORD_WEBHOOK_URL; 
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

async function getSteamAppList() {
    if (Date.now() - steamAppListCache.timestamp < 24 * 60 * 60 * 1000 && steamAppListCache.data.length > 1) return steamAppListCache.data;
    try {
        const response = await fetch('https://steamspy.com/api.php?request=all', { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (response.ok) {
            const jsonData = await response.json();
            steamAppListCache = { data: Object.values(jsonData), timestamp: Date.now() };
            return steamAppListCache.data;
        }
    } catch (e) {}
    try {
        const response = await fetch('http://api.steampowered.com/ISteamApps/GetAppList/v0002/', { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (response.ok) {
             const jsonData = await response.json();
             if (jsonData.applist && jsonData.applist.apps) {
                 steamAppListCache = { data: jsonData.applist.apps, timestamp: Date.now() };
                 return steamAppListCache.data;
             }
        }
    } catch (e) {}
    return steamAppListCache.data;
}

function getCountryFromRequest(req) {
    if (req.query.test_country) return req.query.test_country.toUpperCase();
    if (req.body.test_country) return req.body.test_country.toUpperCase();
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    if (ip === '127.0.0.1' || ip === '::1') return 'BR'; 
    const geo = geoip.lookup(ip);
    return geo ? geo.country : 'US'; 
}

// --- FUNÇÕES LÓGICAS E LIMITES ---

async function enforceUserLimits(userId) {
    try {
        if (!ObjectId.isValid(userId)) return;
        const user = await usersCollection.findOne({ _id: new ObjectId(userId) });
        if (!user) return;

        const plan = GLOBAL_PLANS[user.plan] || PLAN_LIMITS['free'];
        const limitAccounts = user.customLimits ? user.customLimits.accounts : (plan ? plan.accounts : 1);
        const limitGames = user.customLimits ? user.customLimits.games : (plan ? plan.games : 1);

        let runningAccounts = [];
        for (const username in liveAccounts) {
            // CORREÇÃO CRÍTICA: Só conta como ativo se estiver REALMENTE rodando ou iniciando
            // Ignora estados de erro, parado, banido ou desconectado
            const s = liveAccounts[username].status;
            if (liveAccounts[username].ownerUserID === userId.toString() && 
               (s === 'Rodando' || s.startsWith('Iniciando') || s.startsWith('Pendente'))) {
                runningAccounts.push(liveAccounts[username]);
            }
        }

        // 1. Tempo Esgotado
        if (user.plan === 'free' && user.freeHoursRemaining <= 0) {
            runningAccounts.forEach(acc => {
                try { if (acc.worker) acc.worker.kill(); } catch(e) {}
                acc.status = "Tempo Esgotado";
                acc.worker = null; 
            });
            return; 
        }

        // 2. Limite de Contas
        if (runningAccounts.length > limitAccounts) {
            const toStop = runningAccounts.slice(limitAccounts); 
            toStop.forEach(acc => {
                try { if (acc.worker) acc.worker.kill(); } catch(e) {}
                acc.status = "Parado (Limite de Plano)";
                acc.worker = null;
            });
        }

        // 3. Limite de Jogos
        const remainingRunning = runningAccounts.slice(0, limitAccounts);
        remainingRunning.forEach(acc => {
            if (acc.games.length > limitGames) {
                 try { if (acc.worker) acc.worker.kill(); } catch(e) {}
                 acc.status = "Parado (Limite Jogos)";
                 acc.worker = null;
            }
        });

    } catch (e) { console.error(`[SYSTEM] Erro limites:`, e); }
}

async function ensureUserPlanStatus(userId) {
    try {
        if (!ObjectId.isValid(userId)) return null;
        let user = await usersCollection.findOne({ _id: new ObjectId(userId) });
        if (!user) return null;

        if (user.plan !== 'free' && user.planExpiresAt && new Date(user.planExpiresAt) < new Date()) {
            console.log(`[SYSTEM] Plano expirado para ${user.username}.`);
            await usersCollection.updateOne({ _id: user._id }, { 
                $set: { plan: 'free', planExpiresAt: null, freeHoursRemaining: 0 } 
            });
            
            // Mata trabalhadores
            for (const u in liveAccounts) {
                if(liveAccounts[u].ownerUserID === userId.toString()) {
                    try { if (liveAccounts[u].worker) liveAccounts[u].worker.kill(); } catch(e){}
                    liveAccounts[u].status = "Plano Expirado";
                }
            }
            user.plan = 'free';
            user.planExpiresAt = null;
            user.freeHoursRemaining = 0;
        }
        return user;
    } catch (e) { console.error("[SYSTEM] Erro status plano:", e); return null; }
}

function processWorkerQueue() {
    while (workerQueue.length > 0 && activeWorkerCount < MAX_CONCURRENT_WORKERS) {
        const accountData = workerQueue.shift();
        startWorkerForAccount(accountData);
    }
}

function startWorkerForAccount(accountData) {
    const username = accountData.username;
    if (liveAccounts[username]?.worker) { try { liveAccounts[username].worker.kill(); } catch(e) {} }
    if (liveAccounts[username]?.startupTimeout) clearTimeout(liveAccounts[username].startupTimeout);

    activeWorkerCount++; 

    const worker = fork(path.join(__dirname, 'worker.js'));
    liveAccounts[username].worker = worker;
    liveAccounts[username].status = "Iniciando...";
    liveAccounts[username].manual_logout = false;
    liveAccounts[username].ownerUserID = accountData.ownerUserID;

    liveAccounts[username].startupTimeout = setTimeout(() => {
        if (liveAccounts[username]?.status === "Iniciando...") {
            sendDiscordNotification("❄️ Conta Congelada", "Timeout.", 16776960, username, "alert");
            try { worker.kill(); } catch(e) {}
        }
    }, 60000);

    try { worker.send({ command: 'start', data: accountData }); } catch (error) { console.error(`[GESTOR] Falha start worker ${username}:`, error); }

    worker.on('error', (err) => console.error(`[GESTOR] Erro worker ${username}:`, err));
    worker.on('message', (msg) => {
        if (!liveAccounts[username]) return;
        if (liveAccounts[username].startupTimeout) { clearTimeout(liveAccounts[username].startupTimeout); liveAccounts[username].startupTimeout = null; }
        if (msg.type === 'statusUpdate') {
            if (liveAccounts[username].status !== msg.payload.status) {
                const s = msg.payload.status;
                if (s === 'Rodando') sendDiscordNotification("✅ Conta Online", "Farmando.", 5763719, username, "log");
                else if (s.startsWith('Pendente')) sendDiscordNotification("🛡️ Steam Guard", "Aguardando código.", 16776960, username, "alert");
            }
            Object.assign(liveAccounts[username], msg.payload);
        } else if (msg.type === 'ownedGamesUpdate') {
            const games = msg.payload.games;
            accountsCollection.updateOne({ username, ownerUserID: liveAccounts[username].ownerUserID }, { $set: { ownedGames: games } });
            liveAccounts[username].ownedGames = games;
        } else if (msg.type === 'sentryUpdate') {
            liveAccounts[username].sentryFileHash = msg.payload.sentryFileHash;
            accountsCollection.updateOne({ username, ownerUserID: liveAccounts[username].ownerUserID }, { $set: { sentryFileHash: msg.payload.sentryFileHash } });
        }
    });

    worker.on('exit', (code) => {
        activeWorkerCount--; 
        processWorkerQueue(); 

        if (liveAccounts[username]?.startupTimeout) clearTimeout(liveAccounts[username].startupTimeout);
        if (!liveAccounts[username]) return;
        const acc = liveAccounts[username];
        if (!acc.manual_logout && acc.settings.autoRelogin) {
             ensureUserPlanStatus(acc.ownerUserID).then(user => {
                const isFreeExpired = user.plan === 'free' && user.freeHoursRemaining <= 0;
                
                if (!user || user.isBanned || isFreeExpired) {
                    acc.status = user?.isBanned ? "Banido" : "Tempo Esgotado"; 
                    acc.sessionStartTime = null;
                } else {
                    const plan = GLOBAL_PLANS[user.plan] || PLAN_LIMITS['free'];
                    const limitAccounts = user.customLimits ? user.customLimits.accounts : (plan ? plan.accounts : 1);
                    
                    let running = 0;
                    for (const u in liveAccounts) {
                        const s = liveAccounts[u].status;
                        // CORREÇÃO NO REINÍCIO: Ignora Erros/Parados
                        if (liveAccounts[u].ownerUserID === acc.ownerUserID && 
                           (s === 'Rodando' || s.startsWith('Iniciando') || s.startsWith('Pendente'))) {
                            running++;
                        }
                    }

                    if (running < limitAccounts) {
                        acc.status = "Reiniciando...";
                        setTimeout(() => {
                            if (liveAccounts[username]) {
                                const decrypted = decrypt(acc.encryptedPassword);
                                if (decrypted) startWorkerForAccount({ ...acc, password: decrypted });
                            }
                        }, 30000);
                    } else {
                         acc.status = "Parado (Limite)";
                         acc.sessionStartTime = null;
                    }
                }
             });
        } else { acc.status = "Parado"; acc.sessionStartTime = null; }
    });
}

// --- CRON JOBS ---
async function deductFreeTime() {
    const updates = new Set();
    for (const u in liveAccounts) { 
        if (liveAccounts[u].status === 'Rodando' || liveAccounts[u].status.startsWith('Iniciando') || liveAccounts[u].status.startsWith('Pendente')) {
            updates.add(liveAccounts[u].ownerUserID); 
        }
    }
    if (updates.size === 0) return;
    
    const ids = Array.from(updates).map(id => new ObjectId(id));
    try {
        await usersCollection.updateMany({ _id: { $in: ids }, plan: 'free' }, { $inc: { freeHoursRemaining: -60000 } });
        const expired = await usersCollection.find({ _id: { $in: ids }, plan: 'free', freeHoursRemaining: { $lte: 0 } }).toArray();
        expired.forEach(u => { enforceUserLimits(u._id.toString()); });
    } catch(e) { console.error("[CRON] Erro deductFreeTime:", e); }
}

async function checkExpiredPlans() {
    const now = new Date();
    try {
        const expired = await usersCollection.find({ plan: { $ne: 'free' }, planExpiresAt: { $lt: now } }).toArray();
        for (const u of expired) {
            await usersCollection.updateOne({ _id: u._id }, { $set: { plan: 'free', planExpiresAt: null, freeHoursRemaining: 0 } });
            await enforceUserLimits(u._id.toString());
        }
    } catch(e) { console.error("[CRON] Erro checkExpiredPlans:", e); }
}

async function loadAccountsIntoMemory() {
    const savedAccounts = await accountsCollection.find({}).toArray(); 
    
    savedAccounts.forEach((acc) => {
        liveAccounts[acc.username] = { 
            ...acc, 
            encryptedPassword: acc.password, 
            settings: { ...(acc.settings || {}) }, 
            status: 'Parado', 
            worker: null, 
            sessionStartTime: null, 
            manual_logout: false,
            ownedGames: acc.ownedGames || [] 
        };
    });

    console.log(`[SYSTEM] ${savedAccounts.length} contas carregadas.`);

    // AUMENTO DO INTERVALO DE STARTUP (Anti-Throttle)
    // Agora espera 30s entre cada conta para não irritar a Steam
    savedAccounts.forEach((acc, index) => {
        if (acc.settings && acc.settings.autoRelogin) {
            setTimeout(() => {
                workerQueue.push(acc);
                processWorkerQueue();
            }, index * 30000); 
        }
    });
}

// --- CONFIGURAÇÃO EXPRESS ---
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json()); 
app.use(express.urlencoded({ extended: true })); 
app.use(session({ 
    secret: SESSION_SECRET, 
    resave: false, 
    saveUninitialized: false, 
    store: MongoStore.create({ mongoUrl: MONGODB_URI, dbName: 'stf-saas-db' }), 
    cookie: { 
        secure: 'auto', 
        httpOnly: true, 
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    } 
})); 
app.use(express.static(path.join(__dirname, 'public'))); 

// --- MIDDLEWARES DE AUTENTICAÇÃO ---
const isAuthenticated = async (req, res, next) => { 
    if (req.session.userId && ObjectId.isValid(req.session.userId)) { 
        try {
            const user = await usersCollection.findOne({ _id: new ObjectId(req.session.userId) });
            if (user && !user.isBanned) return next();
            if (user && user.isBanned) req.session.destroy(() => res.redirect('/banned'));
        } catch (e) {}
    } 
    res.redirect('/login?error=unauthorized'); 
};
const isAdminAuthenticated = (req, res, next) => { if (req.session.isAdmin) return next(); res.redirect('/admin/login?error=unauthorized'); };

// --- ROTAS DE PÁGINA ---
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
app.post('/admin/login', loginLimiter, (req, res) => { 
    if (safeCompare(req.body.password, ADMIN_PASSWORD)) {
        req.session.isAdmin = true; 
        res.redirect('/admin/dashboard');
    } else {
        res.redirect('/admin/login?error=invalid');
    }
});
app.get('/admin/dashboard', isAdminAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html')));
app.get('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// === API ===
const apiRouter = express.Router();
const adminApiRouter = express.Router();

apiRouter.get('/global-alert', async (req, res) => {
    try {
        const alert = await siteSettingsCollection.findOne({ _id: 'global_alert' });
        res.json(alert || { active: false });
    } catch (e) { res.status(500).json({}); }
});

apiRouter.get('/account-games/:username', isAuthenticated, async (req, res) => {
    const u = req.params.username;
    const acc = liveAccounts[u];
    if (acc && acc.ownerUserID === req.session.userId) {
        res.json(acc.ownedGames || []);
    } else {
        const dbAcc = await accountsCollection.findOne({ username: u, ownerUserID: req.session.userId });
        res.json(dbAcc ? (dbAcc.ownedGames || []) : []);
    }
});

apiRouter.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    const user = await usersCollection.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ message: "Credenciais inválidas." });
    if (user.isBanned) return res.status(403).json({ message: "Conta banida." });
    req.session.userId = user._id.toString(); req.session.username = user.username; res.json({ message: "Login OK" });
});

apiRouter.get('/auth-status', async (req, res) => {
    if (req.session.userId) {
        if (!req.session.username) {
            try { const user = await usersCollection.findOne({ _id: new ObjectId(req.session.userId) }); if (user) req.session.username = user.username; } catch(e) {}
        }
        res.json({ loggedIn: true, username: req.session.username || 'Usuário' });
    } else { res.json({ loggedIn: false }); }
});

apiRouter.get('/geo-status', (req, res) => {
    const country = getCountryFromRequest(req);
    const isBrazil = country === 'BR';
    res.json({ country: country, currency: isBrazil ? 'BRL' : 'USD' });
});

apiRouter.get('/plans', async (req, res) => {
    try { const plans = await plansCollection.find({ active: true }).toArray(); plans.sort((a, b) => (a.id === 'free' ? -1 : b.id === 'free' ? 1 : a.price - b.price)); res.json(plans); } catch(e) { res.status(500).json([]); }
});

apiRouter.post('/register', registerLimiter, async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: "Dados incompletos." });
    
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    const accountsFromIP = await usersCollection.countDocuments({ registrationIP: ip });
    if (accountsFromIP >= 5) return res.status(429).json({ message: "Limite de contas atingido para este IP." });

    try {
        const hash = await bcrypt.hash(password, 10);
        await usersCollection.insertOne({ 
            username, 
            email, 
            password: hash, 
            plan: 'free', 
            freeHoursRemaining: FREE_HOURS_MS, 
            isBanned: false, 
            planExpiresAt: null, 
            createdAt: new Date(),
            registrationIP: ip 
        });
        sendDiscordNotification("👤 Novo Registo", `User: ${username}\nIP: ${ip}`, 3447003, username, "log");
        res.status(201).json({ message: "Conta criada!" });
    } catch (e) { res.status(409).json({ message: "Usuário já existe." }); }
});

apiRouter.post('/validate-coupon', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ valid: false });
    try {
        const coupon = await couponsCollection.findOne({ code: code.toUpperCase() });
        if (coupon) { res.json({ valid: true, discount: coupon.discount }); } else { res.json({ valid: false, message: "Cupom inválido." }); }
    } catch (e) { res.status(500).json({ valid: false }); }
});

apiRouter.use(isAuthenticated);
apiRouter.post('/create-checkout', async (req, res) => {
    if (!mpClient) return res.status(500).json({ message: "Pagamento indisponível." });
    const { planId, customConfig, couponCode, deliveryMethod } = req.body;
    const userId = req.session.userId;
    const country = getCountryFromRequest(req);
    const isBrazil = country === 'BR';
    let price = 0; let title = ""; let metadata = {};

    if (planId === 'custom' && customConfig) {
        let d = parseInt(customConfig.days, 10);
        let a = parseInt(customConfig.accounts, 10);
        let g = parseInt(customConfig.games, 10);
        if (isNaN(d) || d < 1 || d > 365) return res.status(400).json({ message: "Dias inválidos (1-365)." });
        if (isNaN(a) || a < 1 || a > 50) return res.status(400).json({ message: "Contas inválidas (1-50)." });
        if (isNaN(g) || g < 1 || g > 100) return res.status(400).json({ message: "Jogos inválidos (1-100)." });
        const PRICING = isBrazil ? CUSTOM_PRICING_BRL : CUSTOM_PRICING_USD;
        price = PRICING.BASE + (d * PRICING.DAY) + (a * PRICING.ACCOUNT) + (g * PRICING.GAME);
        if (price < (isBrazil ? 5.00 : 2.00)) return res.status(400).json({ message: "Valor abaixo do mínimo." });
        title = `STF Boost - Custom (${d}d/${a}c/${g}j)`;
        metadata = { plan_id: 'custom', custom_days: d, custom_accounts: a, custom_games: g };
    } else {
        const plan = GLOBAL_PLANS[planId];
        if (!plan || !plan.active) return res.status(400).json({ message: "Plano inválido." });
        price = isBrazil ? plan.price : (plan.price_usd || plan.price);
        title = `STF Boost - ${plan.name}`;
        metadata = { plan_id: planId };
    }

    if (couponCode) {
        const coupon = await couponsCollection.findOne({ code: couponCode.toUpperCase() });
        if (coupon) { const discountAmount = (price * coupon.discount) / 100; price = Math.max(0, price - discountAmount); metadata.coupon_code = couponCode.toUpperCase(); }
    }
    metadata.delivery_method = deliveryMethod || 'direct';

    try {
        if (isBrazil) {
            if (!mpClient) return res.status(500).json({ message: "Erro MP." });
            const preference = new Preference(mpClient);
            const result = await preference.create({
                body: {
                    items: [{ title: title, quantity: 1, unit_price: parseFloat(price.toFixed(2)), currency_id: 'BRL' }],
                    payer: { email: req.session.username + "@stfboost.com" },
                    back_urls: { success: `${SITE_URL}/dashboard`, failure: `${SITE_URL}/checkout` },
                    auto_return: "approved",
                    external_reference: userId,
                    metadata: metadata
                }
            });
            res.json({ url: result.init_point, provider: 'mercadopago' });
        } else {
            // Stripe omitido por brevidade
        }
    } catch (e) { console.error("[PAYMENT] Erro:", e); res.status(500).json({ message: "Erro ao criar pagamento." }); }
});

apiRouter.get('/user-info', async (req, res) => { 
    const user = await ensureUserPlanStatus(req.session.userId); 
    if (!user) return res.status(404).json({ message: "Erro." }); 
    let fh = 0; 
    if (user.plan === 'free') fh = Math.ceil(user.freeHoursRemaining / 60000); 
    const p = user.customLimits || GLOBAL_PLANS[user.plan] || PLAN_LIMITS[user.plan] || PLAN_LIMITS['free']; 
    res.json({ username: user.username, plan: user.plan, freeHoursRemaining: fh, planExpiresAt: user.planExpiresAt, gameLimit: p.games, accountLimit: p.accounts }); 
});

apiRouter.get('/status', (req, res) => { const accs = {}; for(const u in liveAccounts) { if(liveAccounts[u].ownerUserID === req.session.userId) { const a = liveAccounts[u]; accs[u] = { username: a.username, status: a.status, games: a.games, settings: a.settings, uptime: a.sessionStartTime ? Date.now() - a.sessionStartTime : 0 }; } } res.json({ accounts: accs }); });

apiRouter.post('/add-account', async (req, res) => { 
    const { username, password } = req.body; 
    const uid = req.session.userId; 
    const user = await ensureUserPlanStatus(uid); 
    const count = await accountsCollection.countDocuments({ ownerUserID: uid }); 
    const p = user.customLimits || GLOBAL_PLANS[user.plan] || PLAN_LIMITS['free']; 
    if (count >= p.accounts) return res.status(403).json({ message: `Limite atingido.` }); 
    if (await accountsCollection.findOne({ username })) return res.status(400).json({ message: "Já existe." }); 
    const ep = encrypt(password); 
    await accountsCollection.insertOne({ username, password: ep, games: [730], settings: {}, ownerUserID: uid }); 
    liveAccounts[username] = { username, encryptedPassword: ep, games: [730], settings: {}, status: 'Parado', ownerUserID: uid }; 
    res.json({ message: "OK" }); 
});

apiRouter.post('/start/:username', async (req, res) => { 
    const u = req.params.username; 
    const acc = liveAccounts[u]; 
    if (!acc || acc.ownerUserID !== req.session.userId) return res.status(404).json({}); 
    const user = await ensureUserPlanStatus(req.session.userId);
    if (user.plan === 'free' && user.freeHoursRemaining <= 0) return res.status(403).json({ message: "Sem tempo." }); 
    const p = user.customLimits || GLOBAL_PLANS[user.plan] || PLAN_LIMITS['free']; 
    if (acc.games.length > p.games) return res.status(403).json({ message: "Limite jogos." }); 
    
    // CORREÇÃO CRÍTICA DO LIMITE APLICADA
    let activeCount = 0;
    for(const k in liveAccounts) {
        const s = liveAccounts[k].status;
        if(liveAccounts[k].ownerUserID === req.session.userId && 
           s !== 'Parado' && !s.startsWith('Parado') && !s.startsWith('Desconectado') && !s.startsWith('Tempo') && !s.startsWith('Banido')) {
            activeCount++;
        }
    }
    if (activeCount >= p.accounts) return res.status(403).json({ message: "Limite contas online." });

    try { 
        const pass = decrypt(acc.encryptedPassword); 
        if (pass) { startWorkerForAccount({ ...acc, password: pass }); res.json({ message: "OK" }); } 
        else { res.status(500).json({ message: "Erro senha." }); } 
    } catch(e) { res.status(500).json({ message: "Erro interno." }); } 
});

apiRouter.post('/stop/:username', (req, res) => { const acc = liveAccounts[req.params.username]; if (acc && acc.ownerUserID === req.session.userId) { acc.manual_logout = true; try { if (acc.worker) acc.worker.kill(); } catch(e){} acc.status = "Parado"; res.json({ message: "OK" }); } else { res.status(404).json({ message: "Erro." }); } });
apiRouter.delete('/remove-account/:username', async (req, res) => { const u = req.params.username; if (liveAccounts[u] && liveAccounts[u].ownerUserID === req.session.userId) { liveAccounts[u].manual_logout = true; try { if (liveAccounts[u].worker) liveAccounts[u].worker.kill(); } catch(e){} delete liveAccounts[u]; } await accountsCollection.deleteOne({ username: u, ownerUserID: req.session.userId }); res.json({ message: "OK" }); });
apiRouter.post('/save-settings/:username', async (req, res) => { const { username } = req.params; const { settings } = req.body; const uid = req.session.userId; const user = await usersCollection.findOne({ _id: new ObjectId(uid) }); if (user.plan === 'free' && (settings.appearOffline || settings.customInGameTitle)) return res.status(403).json({ message: "Premium." }); if (liveAccounts[username] && liveAccounts[username].ownerUserID === uid) { await accountsCollection.updateOne({ username, ownerUserID: uid }, { $set: { settings } }); liveAccounts[username].settings = settings; try { if (liveAccounts[username].worker) liveAccounts[username].worker.send({ command: 'updateSettings', data: { settings, games: liveAccounts[username].games } }); } catch(e){} res.json({ message: "OK" }); } else { res.status(404).json({ message: "Erro." }); } });
apiRouter.post('/set-games/:username', async (req, res) => { const { username } = req.params; const { games } = req.body; const uid = req.session.userId; const user = await usersCollection.findOne({ _id: new ObjectId(uid) }); const p = user.customLimits || GLOBAL_PLANS[user.plan] || PLAN_LIMITS['free']; if (games.length > p.games) return res.status(403).json({ message: "Limite excedido." }); if (liveAccounts[username] && liveAccounts[username].ownerUserID === uid) { await accountsCollection.updateOne({ username, ownerUserID: uid }, { $set: { games } }); liveAccounts[username].games = games; try { if (liveAccounts[username].worker) liveAccounts[username].worker.send({ command: 'updateSettings', data: { settings: liveAccounts[username].settings, games } }); } catch(e){} res.json({ message: "OK" }); } else { res.status(404).json({ message: "Erro." }); } });
apiRouter.post('/submit-guard/:username', (req, res) => { const acc = liveAccounts[req.params.username]; if (acc) { try { acc.worker.send({ command: 'submitGuard', data: { code: req.body.code } }); res.json({ message: "OK" }); } catch(e){ res.status(500).json({ message: "Worker morto." }); } } else { res.status(404).json({ message: "Erro." }); } });
apiRouter.get('/search-game', async (req, res) => { const q = (req.query.q || '').toLowerCase(); if(q.length<2) return res.json([]); const l = await getSteamAppList(); res.json(l.filter(a => a.name.toLowerCase().includes(q)).slice(0, 50)); });

apiRouter.post('/activate-license', async (req, res) => { 
    const { licenseKey } = req.body; 
    const uid = req.session.userId; 
    const key = await licensesCollection.findOne({ key: licenseKey }); 
    if(!key || key.isUsed) return res.status(400).json({message: "Inválida"}); 
    if(key.assignedTo && key.assignedTo.toString() !== uid) return res.status(403).json({message: "Não é sua"}); 
    let exp = null; const duration = key.durationDays || (GLOBAL_PLANS[key.plan] ? GLOBAL_PLANS[key.plan].days : 30); 
    if(duration > 0){ exp = new Date(); exp.setDate(exp.getDate() + duration); } 
    await usersCollection.updateOne({ _id: new ObjectId(uid) }, { $set: { plan: key.plan, planExpiresAt: exp, freeHoursRemaining: 0, customLimits: null } }); 
    await licensesCollection.updateOne({ _id: key._id }, { $set: { isUsed: true, usedBy: new ObjectId(uid), activatedAt: new Date() } }); 
    sendDiscordNotification("🔑 Chave Ativada", `User: ${uid} | Plano: ${key.plan} | Dias: ${duration}`, 3447003, "System", "sale"); 
    await enforceUserLimits(uid); res.json({ message: "Ativado" }); 
});

apiRouter.get('/my-keys', async (req, res) => { const k = await licensesCollection.find({ assignedTo: new ObjectId(req.session.userId), isUsed: false }).toArray(); res.json(k); });
apiRouter.post('/renew-free-time', async (req, res) => { const uid = req.session.userId; await usersCollection.updateOne({ _id: new ObjectId(uid) }, { $set: { freeHoursRemaining: FREE_HOURS_MS, lastFreeRenew: new Date() } }); res.json({ message: "Renovado" }); });
apiRouter.post('/change-password', async (req, res) => { const h = await bcrypt.hash(req.body.newPassword, 10); await usersCollection.updateOne({ _id: new ObjectId(req.session.userId) }, { $set: { password: h } }); res.json({ message: "Alterada" }); });
apiRouter.post('/bulk-start', async (req, res) => { 
    const { usernames } = req.body; const uid = req.session.userId; 
    const user = await ensureUserPlanStatus(uid); if (user.plan === 'free' && user.freeHoursRemaining <= 0) return res.status(403).json({ message: "Sem horas." }); 
    const limit = (user.customLimits || GLOBAL_PLANS[user.plan] || PLAN_LIMITS['free']).games; 
    let c = 0; usernames.forEach(u => { const acc = liveAccounts[u]; if (acc && acc.ownerUserID === uid && acc.games.length <= limit) { const p = decrypt(acc.encryptedPassword); if (p) { startWorkerForAccount({ ...acc, password: p }); c++; } } }); res.json({ message: `${c} iniciadas.` }); 
});
apiRouter.post('/bulk-stop', (req, res) => { const { usernames } = req.body; usernames.forEach(u => { const acc = liveAccounts[u]; if (acc && acc.ownerUserID === req.session.userId) { acc.manual_logout = true; try{ if (acc.worker) acc.worker.kill(); }catch(e){} acc.status = "Parado"; } }); res.json({ message: "Paradas." }); });
apiRouter.post('/bulk-remove', async (req, res) => { const { usernames } = req.body; usernames.forEach(u => { const acc = liveAccounts[u]; if (acc && acc.ownerUserID === req.session.userId) { try{ if (acc.worker) acc.worker.kill(); }catch(e){} delete liveAccounts[u]; } }); await accountsCollection.deleteMany({ username: { $in: usernames }, ownerUserID: req.session.userId }); res.json({ message: "Removidas." }); });

// API Admin
adminApiRouter.use(isAdminAuthenticated);
adminApiRouter.get('/users', async (req, res) => res.json(await usersCollection.find({}, { projection: { password: 0 } }).toArray()));
adminApiRouter.get('/all-plans', async (req, res) => res.json(await plansCollection.find({}).sort({ price: 1 }).toArray()));
adminApiRouter.get('/licenses', async (req, res) => res.json(await licensesCollection.find({}).sort({ createdAt: -1 }).toArray()));
adminApiRouter.get('/coupons', async (req, res) => res.json(await couponsCollection.find({}).toArray()));
adminApiRouter.post('/generate-keys', async (req, res) => { const { plan, quantity, durationDays } = req.body; const qty = parseInt(quantity) || 1; const keys = []; for(let i=0; i<qty; i++) { const key = `${plan.toUpperCase()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`; await licensesCollection.insertOne({ key, plan, durationDays: parseInt(durationDays) || null, isUsed: false, createdAt: new Date() }); keys.push(key); } res.json({ keys, message: "Gerado." }); });
adminApiRouter.post('/ban-user', async (req, res) => { await usersCollection.updateOne({ _id: new ObjectId(req.body.userId) }, { $set: { isBanned: true } }); for(const u in liveAccounts) { if (liveAccounts[u].ownerUserID === req.body.userId) { try{ if(liveAccounts[u].worker) liveAccounts[u].worker.kill(); }catch(e){} } } res.json({ message: "Banido." }); });
adminApiRouter.post('/unban-user', async (req, res) => { await usersCollection.updateOne({ _id: new ObjectId(req.body.userId) }, { $set: { isBanned: false } }); res.json({ message: "Desbanido." }); });
adminApiRouter.post('/delete-user', async (req, res) => { const uid = req.body.userId; await usersCollection.deleteOne({ _id: new ObjectId(uid) }); await accountsCollection.deleteMany({ ownerUserID: uid }); for(const u in liveAccounts) { if (liveAccounts[u].ownerUserID === uid) { try{ liveAccounts[u].worker.kill(); }catch(e){} delete liveAccounts[u]; } } res.json({ message: "Deletado." }); });
adminApiRouter.post('/update-plan', async (req, res) => { const { userId, newPlan } = req.body; await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { plan: newPlan, planExpiresAt: null, customLimits: null } }); sendDiscordNotification("🔧 Plano Alterado (Admin)", `User: ${userId} -> ${newPlan}`, 5763719, "System", "sale"); res.json({ message: "Atualizado." }); });
adminApiRouter.post('/assign-key', async (req, res) => { const { licenseId, username } = req.body; const user = await usersCollection.findOne({ username }); if (!user) return res.status(404).json({ message: "User não achado." }); await licensesCollection.updateOne({ _id: new ObjectId(licenseId) }, { $set: { assignedTo: user._id, assignedToUsername: user.username } }); sendDiscordNotification("🎁 Chave Atribuída", `Para: ${username}`, 5763719, "System", "sale"); res.json({ message: "Atribuído." }); });
adminApiRouter.post('/delete-license', async (req, res) => { await licensesCollection.deleteOne({ _id: new ObjectId(req.body.licenseId) }); res.json({ message: "Deletado." }); });
adminApiRouter.post('/update-plan-details', async (req, res) => { const { id, name, price, days, accounts, games, style, active, features, price_usd } = req.body; await plansCollection.updateOne({ id: id }, { $set: { name, price: parseFloat(price), price_usd: parseFloat(price_usd), days: parseInt(days), accounts: parseInt(accounts), games: parseInt(games), style, active, features } }, { upsert: true }); await refreshPlansCache(); res.json({ message: "OK" }); });
adminApiRouter.post('/delete-plan', async (req, res) => { await plansCollection.deleteOne({ id: req.body.id }); await refreshPlansCache(); res.json({ message: "OK" }); });
adminApiRouter.post('/create-coupon', async (req, res) => { const { code, discount } = req.body; await couponsCollection.insertOne({ code: code.toUpperCase(), discount: parseInt(discount), usageCount: 0 }); res.json({ message: "Criado." }); });
adminApiRouter.post('/delete-coupon', async (req, res) => { await couponsCollection.deleteOne({ _id: new ObjectId(req.body.id) }); res.json({ message: "Deletado." }); });
adminApiRouter.post('/update-global-alert', async (req, res) => { const { message, type, active } = req.body; await siteSettingsCollection.updateOne({ _id: 'global_alert' }, { $set: { message, type, active: active === 'true', updatedAt: new Date() } }, { upsert: true }); res.json({ message: "Alerta atualizado." }); });

// --- WEBHOOKS ---
app.post('/api/mp-webhook', async (req, res) => {
    const { query, headers } = req;
    const xSignature = headers['x-signature'];
    const xRequestId = headers['x-request-id'];
    const dataID = query.id || query['data.id'];

    if (xSignature && xRequestId && dataID) {
        try {
            const parts = xSignature.split(',');
            let ts, hash;
            parts.forEach(part => {
                const [key, value] = part.split('=');
                if (key.trim() === 'ts') ts = value.trim();
                if (key.trim() === 'v1') hash = value.trim();
            });

            const manifest = `id:${dataID};request-id:${xRequestId};ts:${ts};`;
            const hmac = crypto.createHmac('sha256', MP_WEBHOOK_SECRET);
            hmac.update(manifest);
            const expectedHash = hmac.digest('hex');

            if (hash !== expectedHash) {
                console.error("[MP] Assinatura inválida! Possível ataque.");
                return res.sendStatus(403);
            }
        } catch (e) { console.error("[MP] Erro validação:", e); }
    }

    if (query.topic === 'payment' || query.type === 'payment') {
        try {
            const payment = await new Payment(mpClient).get({ id: dataID });
            if (payment.status === 'approved') {
                const userId = payment.external_reference;
                const meta = payment.metadata;
                
                if (userId && ObjectId.isValid(userId)) {
                    sendDiscordNotification("💰 Pagamento Aprovado!", `Plano: ${meta.plan_id}\nUser: ${userId}`, 5763719, "Sistema", "sale");
                    
                    if (meta.coupon_code) await couponsCollection.updateOne({ code: meta.coupon_code }, { $inc: { usageCount: 1 } });
                    
                    if (meta.delivery_method !== 'email') {
                        let updateData = { freeHoursRemaining: 0 };
                        if (meta.plan_id === 'custom') {
                            const expiry = new Date(); expiry.setDate(expiry.getDate() + parseInt(meta.custom_days, 10));
                            updateData.plan = 'custom'; updateData.planExpiresAt = expiry;
                            updateData.customLimits = { accounts: parseInt(meta.custom_accounts, 10), games: parseInt(meta.custom_games, 10) };
                        } else {
                            const plan = GLOBAL_PLANS[meta.plan_id];
                            if (plan) {
                                let expiry = null; if (plan.days > 0) { expiry = new Date(); expiry.setDate(expiry.getDate() + plan.days); }
                                updateData.plan = meta.plan_id; updateData.planExpiresAt = expiry; updateData.customLimits = null; 
                            }
                        }
                        await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: updateData });
                        await enforceUserLimits(userId);
                    }
                }
            }
        } catch (e) { console.error("[MP] Webhook erro:", e); }
    }
    res.sendStatus(200);
});

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

        app.listen(PORT, () => console.log(`[SYSTEM] Online na porta ${PORT}`));
    } catch (e) { console.error("[SYSTEM] ERRO FATAL:", e); }
}
startServer();
