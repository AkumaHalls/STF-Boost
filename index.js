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

console.log("[SYSTEM] Inicializando módulos...");

// --- CONFIGURAÇÃO ---
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_PASSWORD = process.env.SITE_PASSWORD; 
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL; 
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN; 
const SITE_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

if (!MONGODB_URI || !ADMIN_PASSWORD) { 
    console.error("ERRO CRÍTICO: As variáveis de ambiente MONGODB_URI e SITE_PASSWORD precisam de ser definidas!"); 
    process.exit(1); 
}

let mpClient;
if (MP_ACCESS_TOKEN) {
    mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN });
    console.log("[SYSTEM] Mercado Pago configurado.");
}

const ALGORITHM = 'aes-256-cbc';
let appSecretKey; 
let steamAppListCache = { data: [{appid: 730, name: "Counter-Strike 2"}], timestamp: 0 }; 

// --- CONSTANTES ---
const ALL_PLANS = ['free', 'basic', 'plus', 'premium', 'ultimate', 'lifetime', 'halloween', 'christmas', 'newyear'];
const FREE_HOURS_MS = 50 * 60 * 60 * 1000; 
const FREE_RENEW_COOLDOWN_MS = 24 * 60 * 60 * 1000; 
const CUSTOM_PRICING = { BASE: 5.00, DAY: 0.10, ACCOUNT: 2.00, GAME: 0.10 };

let PLAN_LIMITS = {
    'free': { accounts: 1, games: 1 },
    'basic': { accounts: 2, games: 6 },
    'plus': { accounts: 4, games: 12 },
    'premium': { accounts: 6, games: 24 },
    'ultimate': { accounts: 10, games: 33 },
    'lifetime': { accounts: 10, games: 33 },
    'halloween': { accounts: 8, games: 33 },
    'christmas': { accounts: 10, games: 33 },
    'newyear': { accounts: 10, games: 33 }
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
    } catch (e) { 
        console.error("[DB] Erro fatal:", e); process.exit(1); 
    } 
}

async function initializePlans() {
    const defaultPlans = [
        { id: 'free', name: 'Gratuito', price: 0, days: 0, accounts: 1, games: 1, style: 'none', active: true, features: ['50 Horas (Renovável)', '1 Conta Steam', '1 Limite de Jogo'] },
        { id: 'basic', name: 'Basic', price: 7.90, days: 30, accounts: 2, games: 6, style: 'none', active: true, features: ['30 Dias', '2 Contas', '6 Jogos'] },
        { id: 'plus', name: 'Plus', price: 15.90, days: 30, accounts: 4, games: 12, style: 'none', active: true, features: ['30 Dias', '4 Contas', '12 Jogos'] },
        { id: 'premium', name: 'Premium', price: 27.90, days: 30, accounts: 6, games: 24, style: 'fire', active: true, features: ['30 Dias', '6 Contas', '24 Jogos'] },
        { id: 'ultimate', name: 'Ultimate', price: 54.90, days: 30, accounts: 10, games: 33, style: 'none', active: true, features: ['30 Dias', '10 Contas', '33 Jogos'] },
        { id: 'lifetime', name: 'Vitalício', price: 249.90, days: 0, accounts: 10, games: 33, style: 'cosmic', active: true, features: ['Vitalício', '10 Contas', '33 Jogos'] },
        { id: 'halloween', name: 'Halloween Spooky', price: 19.90, days: 45, accounts: 8, games: 33, style: 'halloween', active: true, features: ['45 Dias', '8 Contas', '33 Jogos'] },
        { id: 'christmas', name: 'Natal Gift', price: 89.90, days: 365, accounts: 10, games: 33, style: 'christmas', active: true, features: ['1 Ano', '10 Contas', '33 Jogos'] },
        { id: 'newyear', name: 'Ano Novo Era', price: 12.90, days: 30, accounts: 10, games: 33, style: 'newyear', active: true, features: ['30 Dias', '10 Contas', '33 Jogos'] }
    ];
    for (const plan of defaultPlans) { await plansCollection.updateOne({ id: plan.id }, { $setOnInsert: plan }, { upsert: true }); }
    await refreshPlansCache();
}

async function refreshPlansCache() {
    try {
        const plans = await plansCollection.find({}).toArray();
        GLOBAL_PLANS = {};
        plans.forEach(p => { GLOBAL_PLANS[p.id] = p; PLAN_LIMITS[p.id] = { accounts: p.accounts, games: p.games }; });
        console.log("[SYSTEM] Planos carregados.");
    } catch (e) {}
}

async function initializeMasterKey() {
    let settings = await siteSettingsCollection.findOne({ _id: 'config' });
    if (!settings || !settings.appSecret) {
        const newSecret = crypto.randomBytes(32).toString('hex');
        appSecretKey = crypto.createHash('sha256').update(newSecret).digest('base64').substr(0, 32);
        await siteSettingsCollection.updateOne( { _id: 'config' }, { $set: { appSecret: newSecret } }, { upsert: true } );
    } else { appSecretKey = crypto.createHash('sha256').update(settings.appSecret).digest('base64').substr(0, 32); }
}

const encrypt = (text) => { if (!appSecretKey) return null; const iv = crypto.randomBytes(16); const cipher = crypto.createCipheriv(ALGORITHM, appSecretKey, iv); let encrypted = cipher.update(text, 'utf8', 'hex'); encrypted += cipher.final('hex'); return `${iv.toString('hex')}:${encrypted}`; };
const decrypt = (text) => { try { if (!appSecretKey || !text) return ""; const textParts = text.split(':'); const iv = Buffer.from(textParts.shift(), 'hex'); const encryptedText = Buffer.from(textParts.join(':'), 'hex'); const decipher = crypto.createDecipheriv(ALGORITHM, appSecretKey, iv); let decrypted = decipher.update(encryptedText, 'hex', 'utf8'); decrypted += decipher.final('utf8'); return decrypted; } catch (error) { return ""; }};

function sendDiscordNotification(title, message, color, username) {
    if (!DISCORD_WEBHOOK_URL) return;
    const payload = JSON.stringify({ embeds: [{ title: title || '\u200b', description: message || '\u200b', color: color, fields: [{ name: "Conta", value: `\`${username || 'N/A'}\``, inline: true }], footer: { text: "STF Boost Notifier" }, timestamp: new Date().toISOString() }] });
    try {
        const req = https.request({ hostname: new URL(DISCORD_WEBHOOK_URL).hostname, path: new URL(DISCORD_WEBHOOK_URL).pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }}, () => {});
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
    return steamAppListCache.data;
}

// --- WORKER ---
function startWorkerForAccount(accountData) {
    const username = accountData.username;
    if (liveAccounts[username]?.worker) {
        try { liveAccounts[username].worker.kill(); } catch(e) {}
    }
    if (liveAccounts[username]?.startupTimeout) clearTimeout(liveAccounts[username].startupTimeout);

    const worker = fork(path.join(__dirname, 'worker.js'));
    liveAccounts[username].worker = worker;
    liveAccounts[username].status = "Iniciando...";
    liveAccounts[username].manual_logout = false;
    liveAccounts[username].ownerUserID = accountData.ownerUserID;

    liveAccounts[username].startupTimeout = setTimeout(() => {
        if (liveAccounts[username]?.status === "Iniciando...") {
            sendDiscordNotification("❄️ Conta Congelada", "Timeout.", 16776960, username);
            try { worker.kill(); } catch(e) {}
        }
    }, 60000);

    // Proteção contra crash
    try {
        worker.send({ command: 'start', data: accountData });
    } catch (error) {
        console.error(`[GESTOR] Falha ao iniciar worker para ${username}:`, error);
    }

    worker.on('error', (err) => console.error(`[GESTOR] Erro worker ${username}:`, err));

    worker.on('message', (msg) => {
        if (!liveAccounts[username]) return;
        if (liveAccounts[username].startupTimeout) { clearTimeout(liveAccounts[username].startupTimeout); liveAccounts[username].startupTimeout = null; }
        if (msg.type === 'statusUpdate') {
            if (liveAccounts[username].status !== msg.payload.status) {
                if (msg.payload.status === 'Rodando') sendDiscordNotification("✅ Conta Online", "Farmando.", 5763719, username);
            }
            Object.assign(liveAccounts[username], msg.payload);
        } else if (msg.type === 'sentryUpdate') {
            liveAccounts[username].sentryFileHash = msg.payload.sentryFileHash;
            accountsCollection.updateOne({ username, ownerUserID: liveAccounts[username].ownerUserID }, { $set: { sentryFileHash: msg.payload.sentryFileHash } });
        }
    });

    worker.on('exit', (code) => {
        if (liveAccounts[username]?.startupTimeout) clearTimeout(liveAccounts[username].startupTimeout);
        if (!liveAccounts[username]) return;
        const acc = liveAccounts[username];
        if (!acc.manual_logout && acc.settings.autoRelogin) {
             usersCollection.findOne({ _id: new ObjectId(acc.ownerUserID) }).then(user => {
                if (!user || user.isBanned || (user.plan === 'free' && user.freeHoursRemaining <= 0) || (user.planExpiresAt && user.planExpiresAt < new Date())) {
                    acc.status = user?.isBanned ? "Banido" : "Tempo Esgotado";
                    acc.sessionStartTime = null;
                } else {
                    acc.status = "Reiniciando...";
                    setTimeout(() => {
                        if (liveAccounts[username]) {
                            const decrypted = decrypt(acc.encryptedPassword);
                            if (decrypted) startWorkerForAccount({ ...acc, password: decrypted });
                        }
                    }, 30000);
                }
             });
        } else { acc.status = "Parado"; acc.sessionStartTime = null; }
    });
}

async function loadAccountsIntoMemory() {
    const savedAccounts = await accountsCollection.find({ "settings.autoRelogin": true }).toArray(); 
    savedAccounts.forEach((acc, index) => {
        liveAccounts[acc.username] = { ...acc, encryptedPassword: acc.password, settings: { ...(acc.settings || {}) }, status: 'Parado', worker: null, sessionStartTime: null, manual_logout: false };
        setTimeout(() => {
            const pass = decrypt(acc.password);
            if (pass) startWorkerForAccount({ ...liveAccounts[acc.username], password: pass });
        }, index * 15000);
    });
}

// --- APP ---
app.use(express.json()); 
app.use(express.urlencoded({ extended: true })); 
app.use(session({ secret: 'stfboost_secret', resave: false, saveUninitialized: false, store: MongoStore.create({ mongoUrl: MONGODB_URI, dbName: 'stf-saas-db' }), cookie: { secure: 'auto', httpOnly: true, maxAge: 24 * 60 * 60 * 1000 } })); 
app.use(express.static(path.join(__dirname, 'public'))); 

const isAuthenticated = async (req, res, next) => { 
    if (req.session.userId) { 
        try {
            const user = await usersCollection.findOne({ _id: new ObjectId(req.session.userId) });
            if (user && !user.isBanned) return next();
            if (user && user.isBanned) req.session.destroy(() => res.redirect('/banned'));
        } catch (e) {}
    } 
    res.redirect('/login?error=unauthorized'); 
};
const isAdminAuthenticated = (req, res, next) => { if (req.session.isAdmin) return next(); res.redirect('/admin/login?error=unauthorized'); };

// --- ROTAS DE PÁGINAS ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => req.session.userId ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => req.session.userId ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/dashboard', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/checkout', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'checkout.html')));
app.get('/terms', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terms.html')));
app.get('/tutorial', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'tutorial.html')));
app.get('/banned', (req, res) => res.sendFile(path.join(__dirname, 'public', 'banned.html')));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// --- ROTAS ADMIN PÁGINAS ---
app.get('/admin', (req, res) => res.redirect('/admin/dashboard'));
app.get('/admin/login', (req, res) => req.session.isAdmin ? res.redirect('/admin/dashboard') : res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html')));
app.post('/admin/login', (req, res) => { req.body.password === ADMIN_PASSWORD ? (req.session.isAdmin = true, res.redirect('/admin/dashboard')) : res.redirect('/admin/login?error=invalid'); });
app.get('/admin/dashboard', isAdminAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html')));
app.get('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// --- DEFINIÇÃO DE ROUTERS (API) ---
const apiRouter = express.Router();
const adminApiRouter = express.Router();

// === API PÚBLICA / AUTH ===
apiRouter.get('/auth-status', async (req, res) => {
    if (req.session.userId) {
        if (!req.session.username) {
            try {
                const user = await usersCollection.findOne({ _id: new ObjectId(req.session.userId) });
                if (user) req.session.username = user.username;
            } catch(e) {}
        }
        res.json({ loggedIn: true, username: req.session.username || 'Usuário' });
    } else {
        res.json({ loggedIn: false });
    }
});

apiRouter.get('/plans', async (req, res) => {
    try {
        const plans = await plansCollection.find({ active: true }).toArray();
        plans.sort((a, b) => (a.id === 'free' ? -1 : b.id === 'free' ? 1 : a.price - b.price));
        res.json(plans);
    } catch(e) { res.status(500).json([]); }
});

apiRouter.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: "Dados incompletos." });
    try {
        const hash = await bcrypt.hash(password, 10);
        await usersCollection.insertOne({ username, email, password: hash, plan: 'free', freeHoursRemaining: FREE_HOURS_MS, isBanned: false, planExpiresAt: null, createdAt: new Date() });
        res.status(201).json({ message: "Conta criada!" });
    } catch (e) { res.status(409).json({ message: "Usuário já existe." }); }
});

apiRouter.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await usersCollection.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ message: "Credenciais inválidas." });
    if (user.isBanned) return res.status(403).json({ message: "Conta banida." });
    req.session.userId = user._id.toString();
    req.session.username = user.username;
    res.json({ message: "Login OK" });
});

apiRouter.post('/validate-coupon', async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ valid: false });
    try {
        const coupon = await couponsCollection.findOne({ code: code.toUpperCase() });
        if (coupon) {
            res.json({ valid: true, discount: coupon.discount });
        } else {
            res.json({ valid: false, message: "Cupom inválido." });
        }
    } catch (e) { res.status(500).json({ valid: false }); }
});

// ==========================================
// === API PROTEGIDA (USUÁRIO) ===
// ==========================================
apiRouter.use(isAuthenticated);

apiRouter.post('/create-checkout', async (req, res) => {
    if (!mpClient) return res.status(500).json({ message: "Pagamento indisponível." });
    
    const { planId, customConfig, couponCode } = req.body;
    let price = 0; let title = ""; let metadata = {};

    if (planId === 'custom' && customConfig) {
        const d = parseInt(customConfig.days) || 30;
        const a = parseInt(customConfig.accounts) || 1;
        const g = parseInt(customConfig.games) || 10;
        price = CUSTOM_PRICING.BASE + (d * CUSTOM_PRICING.DAY) + (a * CUSTOM_PRICING.ACCOUNT) + (g * CUSTOM_PRICING.GAME);
        title = `STF Boost - Personalizado (${d}d, ${a}c, ${g}j)`;
        metadata = { plan_id: 'custom', custom_days: d, custom_accounts: a, custom_games: g };
    } else {
        const plan = GLOBAL_PLANS[planId];
        if (!plan) return res.status(400).json({ message: "Plano inválido." });
        price = plan.price;
        title = `STF Boost - ${plan.name}`;
        metadata = { plan_id: planId };
    }

    if (couponCode) {
        const coupon = await couponsCollection.findOne({ code: couponCode.toUpperCase() });
        if (coupon) {
            const discountAmount = (price * coupon.discount) / 100;
            price = Math.max(0, price - discountAmount);
        }
    }

    try {
        const preference = new Preference(mpClient);
        const result = await preference.create({
            body: {
                items: [{ title: title, quantity: 1, unit_price: parseFloat(price.toFixed(2)), currency_id: 'BRL' }],
                payer: { email: req.session.username + "@stfboost.com" },
                back_urls: { success: `${SITE_URL}/dashboard`, failure: `${SITE_URL}/checkout` },
                auto_return: "approved",
                external_reference: req.session.userId,
                metadata: metadata
            }
        });
        res.json({ url: result.init_point });
    } catch (e) {
        console.error("[MP] Erro:", e);
        res.status(500).json({ message: "Erro ao criar pagamento." });
    }
});

apiRouter.get('/user-info', async (req, res) => {
    const user = await usersCollection.findOne({ _id: new ObjectId(req.session.userId) });
    if (!user) return res.status(404).json({ message: "Erro user." });
    let fh = 0; if (user.plan === 'free') fh = Math.ceil(user.freeHoursRemaining / 3600000);
    const p = user.customLimits || GLOBAL_PLANS[user.plan] || PLAN_LIMITS[user.plan] || PLAN_LIMITS['free'];
    res.json({ username: user.username, plan: user.plan, freeHoursRemaining: fh, planExpiresAt: user.planExpiresAt, gameLimit: p.games, accountLimit: p.accounts });
});
apiRouter.get('/status', (req, res) => { const accs = {}; for(const u in liveAccounts) { if(liveAccounts[u].ownerUserID === req.session.userId) { const a = liveAccounts[u]; accs[u] = { username: a.username, status: a.status, games: a.games, settings: a.settings, uptime: a.sessionStartTime ? Date.now() - a.sessionStartTime : 0 }; } } res.json({ accounts: accs }); });
apiRouter.post('/add-account', async (req, res) => { const { username, password } = req.body; const uid = req.session.userId; const user = await usersCollection.findOne({ _id: new ObjectId(uid) }); const count = await accountsCollection.countDocuments({ ownerUserID: uid }); const p = user.customLimits || GLOBAL_PLANS[user.plan] || PLAN_LIMITS['free']; if (count >= p.accounts) return res.status(403).json({ message: `Limite atingido.` }); if (await accountsCollection.findOne({ username })) return res.status(400).json({ message: "Já existe." }); const ep = encrypt(password); await accountsCollection.insertOne({ username, password: ep, games: [730], settings: {}, ownerUserID: uid }); liveAccounts[username] = { username, encryptedPassword: ep, games: [730], settings: {}, status: 'Parado', ownerUserID: uid }; res.json({ message: "OK" }); });
apiRouter.post('/start/:username', async (req, res) => { 
    const u = req.params.username; const acc = liveAccounts[u]; 
    if (!acc || acc.ownerUserID !== req.session.userId) return res.status(404).json({}); 
    const user = await usersCollection.findOne({ _id: new ObjectId(req.session.userId) }); 
    if (user.plan === 'free' && user.freeHoursRemaining <= 0) return res.status(403).json({ message: "Sem tempo." }); 
    if (user.planExpiresAt && user.planExpiresAt < new Date()) return res.status(403).json({ message: "Expirado." }); 
    const p = user.customLimits || GLOBAL_PLANS[user.plan] || PLAN_LIMITS['free'];
    if (acc.games.length > p.games) return res.status(403).json({ message: "Limite jogos." });
    
    // Try-catch para evitar crash se worker já morreu
    try {
        const pass = decrypt(acc.encryptedPassword); 
        if (pass) { startWorkerForAccount({ ...acc, password: pass }); res.json({ message: "OK" }); } 
        else { res.status(500).json({ message: "Erro senha." }); }
    } catch(e) {
        res.status(500).json({ message: "Erro interno." });
    }
});
apiRouter.post('/stop/:username', (req, res) => { 
    const acc = liveAccounts[req.params.username]; 
    if (acc && acc.ownerUserID === req.session.userId) { 
        acc.manual_logout = true; 
        try { if (acc.worker) acc.worker.kill(); } catch(e){}
        acc.status = "Parado"; 
        res.json({ message: "OK" }); 
    } else { res.status(404).json({ message: "Erro." }); } 
});
apiRouter.delete('/remove-account/:username', async (req, res) => { const u = req.params.username; if (liveAccounts[u] && liveAccounts[u].ownerUserID === req.session.userId) { liveAccounts[u].manual_logout = true; try { if (liveAccounts[u].worker) liveAccounts[u].worker.kill(); } catch(e){} delete liveAccounts[u]; } await accountsCollection.deleteOne({ username: u, ownerUserID: req.session.userId }); res.json({ message: "OK" }); });
apiRouter.post('/save-settings/:username', async (req, res) => { 
    const { username } = req.params; const { settings } = req.body; const uid = req.session.userId; 
    const user = await usersCollection.findOne({ _id: new ObjectId(uid) }); 
    if (user.plan === 'free' && (settings.appearOffline || settings.customInGameTitle)) return res.status(403).json({ message: "Premium." }); 
    if (liveAccounts[username] && liveAccounts[username].ownerUserID === uid) { 
        await accountsCollection.updateOne({ username, ownerUserID: uid }, { $set: { settings } }); 
        liveAccounts[username].settings = settings; 
        try { if (liveAccounts[username].worker) liveAccounts[username].worker.send({ command: 'updateSettings', data: { settings, games: liveAccounts[username].games } }); } catch(e){}
        res.json({ message: "OK" }); 
    } else { res.status(404).json({ message: "Erro." }); } 
});
apiRouter.post('/set-games/:username', async (req, res) => { 
    const { username } = req.params; const { games } = req.body; const uid = req.session.userId; 
    const user = await usersCollection.findOne({ _id: new ObjectId(uid) }); 
    const p = user.customLimits || GLOBAL_PLANS[user.plan] || PLAN_LIMITS['free'];
    if (games.length > p.games) return res.status(403).json({ message: "Limite excedido." }); 
    if (liveAccounts[username] && liveAccounts[username].ownerUserID === uid) { 
        await accountsCollection.updateOne({ username, ownerUserID: uid }, { $set: { games } }); 
        liveAccounts[username].games = games; 
        try { if (liveAccounts[username].worker) liveAccounts[username].worker.send({ command: 'updateSettings', data: { settings: liveAccounts[username].settings, games } }); } catch(e){}
        res.json({ message: "OK" }); 
    } else { res.status(404).json({ message: "Erro." }); } 
});
apiRouter.post('/submit-guard/:username', (req, res) => { 
    const acc = liveAccounts[req.params.username]; 
    if (acc) { 
        try { acc.worker.send({ command: 'submitGuard', data: { code: req.body.code } }); res.json({ message: "OK" }); } 
        catch(e){ res.status(500).json({ message: "Worker morto." }); } 
    } else { res.status(404).json({ message: "Erro." }); } 
});
apiRouter.get('/search-game', async (req, res) => { const q = (req.query.q || '').toLowerCase(); if(q.length<2) return res.json([]); const l = await getSteamAppList(); res.json(l.filter(a => a.name.toLowerCase().includes(q)).slice(0, 50)); });
apiRouter.post('/activate-license', async (req, res) => { const { licenseKey } = req.body; const uid = req.session.userId; const key = await licensesCollection.findOne({ key: licenseKey }); if(!key || key.isUsed) return res.status(400).json({message: "Inválida"}); if(key.assignedTo && key.assignedTo.toString() !== uid) return res.status(403).json({message: "Não é sua"}); let exp=null; const duration = key.durationDays || (GLOBAL_PLANS[key.plan] ? GLOBAL_PLANS[key.plan].days : 30); if(duration > 0){ exp=new Date(); exp.setDate(exp.getDate()+duration); } await usersCollection.updateOne({ _id: new ObjectId(uid) }, { $set: { plan: key.plan, planExpiresAt: exp, freeHoursRemaining: 0, customLimits: null } }); await licensesCollection.updateOne({ _id: key._id }, { $set: { isUsed: true, usedBy: new ObjectId(uid), activatedAt: new Date() } }); res.json({ message: "Ativado" }); });
apiRouter.get('/my-keys', async (req, res) => { const k = await licensesCollection.find({ assignedTo: new ObjectId(req.session.userId), isUsed: false }).toArray(); res.json(k); });
apiRouter.post('/renew-free-time', async (req, res) => { const uid = req.session.userId; await usersCollection.updateOne({ _id: new ObjectId(uid) }, { $set: { freeHoursRemaining: FREE_HOURS_MS, lastFreeRenew: new Date() } }); res.json({ message: "Renovado" }); });
apiRouter.post('/change-password', async (req, res) => { const h = await bcrypt.hash(req.body.newPassword, 10); await usersCollection.updateOne({ _id: new ObjectId(req.session.userId) }, { $set: { password: h } }); res.json({ message: "Alterada" }); });
apiRouter.post('/bulk-start', async (req, res) => { const { usernames } = req.body; const uid = req.session.userId; const user = await usersCollection.findOne({ _id: new ObjectId(uid) }); if (user.plan === 'free' && user.freeHoursRemaining <= 0) return res.status(403).json({ message: "Sem horas." }); const limit = (user.customLimits || GLOBAL_PLANS[user.plan] || PLAN_LIMITS['free']).games; let c = 0; usernames.forEach(u => { const acc = liveAccounts[u]; if (acc && acc.ownerUserID === uid && acc.games.length <= limit) { const p = decrypt(acc.encryptedPassword); if (p) { startWorkerForAccount({ ...acc, password: p }); c++; } } }); res.json({ message: `${c} iniciadas.` }); });
apiRouter.post('/bulk-stop', (req, res) => { const { usernames } = req.body; usernames.forEach(u => { const acc = liveAccounts[u]; if (acc && acc.ownerUserID === req.session.userId) { acc.manual_logout = true; try{ if (acc.worker) acc.worker.kill(); }catch(e){} acc.status = "Parado"; } }); res.json({ message: "Paradas." }); });
apiRouter.post('/bulk-remove', async (req, res) => { const { usernames } = req.body; usernames.forEach(u => { const acc = liveAccounts[u]; if (acc && acc.ownerUserID === req.session.userId) { try{ if (acc.worker) acc.worker.kill(); }catch(e){} delete liveAccounts[u]; } }); await accountsCollection.deleteMany({ username: { $in: usernames }, ownerUserID: req.session.userId }); res.json({ message: "Removidas." }); });

app.use('/api', apiRouter);

// === API ADMIN ===
adminApiRouter.use(isAdminAuthenticated);
adminApiRouter.get('/users', async (req, res) => res.json(await usersCollection.find({}, { projection: { password: 0 } }).toArray()));
adminApiRouter.get('/all-plans', async (req, res) => res.json(await plansCollection.find({}).sort({ price: 1 }).toArray()));
adminApiRouter.get('/licenses', async (req, res) => res.json(await licensesCollection.find({}).sort({ createdAt: -1 }).toArray()));
adminApiRouter.get('/coupons', async (req, res) => res.json(await couponsCollection.find({}).toArray()));
adminApiRouter.post('/generate-keys', async (req, res) => { const { plan, quantity, durationDays } = req.body; const qty = parseInt(quantity) || 1; const keys = []; for(let i=0; i<qty; i++) { const key = `${plan.toUpperCase()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`; await licensesCollection.insertOne({ key, plan, durationDays: parseInt(durationDays) || null, isUsed: false, createdAt: new Date() }); keys.push(key); } res.json({ keys, message: "Gerado." }); });
adminApiRouter.post('/ban-user', async (req, res) => { await usersCollection.updateOne({ _id: new ObjectId(req.body.userId) }, { $set: { isBanned: true } }); for(const u in liveAccounts) { if (liveAccounts[u].ownerUserID === req.body.userId) { try{ if(liveAccounts[u].worker) liveAccounts[u].worker.kill(); }catch(e){} } } res.json({ message: "Banido." }); });
adminApiRouter.post('/unban-user', async (req, res) => { await usersCollection.updateOne({ _id: new ObjectId(req.body.userId) }, { $set: { isBanned: false } }); res.json({ message: "Desbanido." }); });
adminApiRouter.post('/delete-user', async (req, res) => { const uid = req.body.userId; await usersCollection.deleteOne({ _id: new ObjectId(uid) }); await accountsCollection.deleteMany({ ownerUserID: uid }); for(const u in liveAccounts) { if (liveAccounts[u].ownerUserID === uid) { try{ liveAccounts[u].worker.kill(); }catch(e){} delete liveAccounts[u]; } } res.json({ message: "Deletado." }); });
adminApiRouter.post('/update-plan', async (req, res) => { const { userId, newPlan } = req.body; await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { plan: newPlan, planExpiresAt: null, customLimits: null } }); res.json({ message: "Atualizado." }); });
adminApiRouter.post('/assign-key', async (req, res) => { const { licenseId, username } = req.body; const user = await usersCollection.findOne({ username }); if (!user) return res.status(404).json({ message: "User não achado." }); await licensesCollection.updateOne({ _id: new ObjectId(licenseId) }, { $set: { assignedTo: user._id, assignedToUsername: user.username } }); res.json({ message: "Atribuído." }); });
adminApiRouter.post('/delete-license', async (req, res) => { await licensesCollection.deleteOne({ _id: new ObjectId(req.body.licenseId) }); res.json({ message: "Deletado." }); });
adminApiRouter.post('/update-plan-details', async (req, res) => { await plansCollection.updateOne({ id: req.body.id }, { $set: { ...req.body, price: parseFloat(req.body.price) } }, { upsert: true }); await refreshPlansCache(); res.json({ message: "OK" }); });
adminApiRouter.post('/delete-plan', async (req, res) => { await plansCollection.deleteOne({ id: req.body.id }); await refreshPlansCache(); res.json({ message: "OK" }); });
adminApiRouter.post('/create-coupon', async (req, res) => { const { code, discount } = req.body; await couponsCollection.insertOne({ code: code.toUpperCase(), discount: parseInt(discount) }); res.json({ message: "Criado." }); });
adminApiRouter.post('/delete-coupon', async (req, res) => { await couponsCollection.deleteOne({ _id: new ObjectId(req.body.id) }); res.json({ message: "Deletado." }); });

app.use('/api/admin', adminApiRouter);

// --- WEBHOOK ---
app.post('/api/mp-webhook', async (req, res) => {
    const { query } = req;
    if (query.topic === 'payment' || query.type === 'payment') {
        const paymentId = query.id || query['data.id'];
        try {
            const payment = await new Payment(mpClient).get({ id: paymentId });
            if (payment.status === 'approved') {
                const userId = payment.external_reference;
                const meta = payment.metadata;
                if (userId) {
                    let updateData = { freeHoursRemaining: 0 };
                    if (meta.plan_id === 'custom') {
                        const expiry = new Date(); expiry.setDate(expiry.getDate() + parseInt(meta.custom_days));
                        updateData.plan = 'custom'; updateData.planExpiresAt = expiry;
                        updateData.customLimits = { accounts: parseInt(meta.custom_accounts), games: parseInt(meta.custom_games) };
                    } else {
                        const plan = GLOBAL_PLANS[meta.plan_id];
                        if (plan) {
                            let expiry = null; if (plan.days > 0) { expiry = new Date(); expiry.setDate(expiry.getDate() + plan.days); }
                            updateData.plan = meta.plan_id; updateData.planExpiresAt = expiry; updateData.customLimits = null; 
                        }
                    }
                    await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: updateData });
                }
            }
        } catch (e) { console.error("[MP] Webhook:", e); }
    }
    res.sendStatus(200);
});

// --- CRON FUNCTIONS ---
async function deductFreeTime() {
    const updates = new Set();
    for (const u in liveAccounts) { if (liveAccounts[u].status === 'Rodando') updates.add(liveAccounts[u].ownerUserID); }
    if (updates.size === 0) return;
    const ids = Array.from(updates).map(id => new ObjectId(id));
    await usersCollection.updateMany({ _id: { $in: ids }, plan: 'free' }, { $inc: { freeHoursRemaining: -300000 } });
    const expired = await usersCollection.find({ _id: { $in: ids }, plan: 'free', freeHoursRemaining: { $lte: 0 } }).toArray();
    expired.forEach(u => { for (const acc in liveAccounts) { if (liveAccounts[acc].ownerUserID === u._id.toString() && liveAccounts[acc].worker) { try{ liveAccounts[acc].worker.kill(); }catch(e){} liveAccounts[acc].status = "Tempo Esgotado"; } } });
}

async function checkExpiredPlans() {
    const now = new Date();
    const expired = await usersCollection.find({ plan: { $ne: 'free' }, planExpiresAt: { $lt: now } }).toArray();
    for (const u of expired) {
        await usersCollection.updateOne({ _id: u._id }, { $set: { plan: 'free', planExpiresAt: null, freeHoursRemaining: FREE_HOURS_MS } });
        for (const acc in liveAccounts) { if (liveAccounts[acc].ownerUserID === u._id.toString() && liveAccounts[acc].worker) { try{ liveAccounts[acc].worker.kill(); }catch(e){} } }
        const userSteamAccounts = await accountsCollection.find({ ownerUserID: u._id.toString() }).toArray();
        if (userSteamAccounts.length > 0) {
            const firstAccount = userSteamAccounts[0];
            await accountsCollection.updateOne({ _id: firstAccount._id }, { $set: { games: [730] } });
            if (userSteamAccounts.length > 1) {
                const accountsToDelete = userSteamAccounts.slice(1).map(acc => acc._id);
                await accountsCollection.deleteMany({ _id: { $in: accountsToDelete } });
                userSteamAccounts.slice(1).forEach(acc => { if (liveAccounts[acc.username]) delete liveAccounts[acc.username]; });
            }
        }
    }
}

async function startServer() {
    console.log("[SYSTEM] Conectando ao DB...");
    try {
        await connectToDB();
        await initializePlans(); 
        await initializeMasterKey();
        await loadAccountsIntoMemory();
        setInterval(deductFreeTime, 300000);
        setInterval(checkExpiredPlans, 3600000);
        app.listen(PORT, () => console.log(`[SYSTEM] Online na porta ${PORT}`));
    } catch (e) { console.error("[SYSTEM] ERRO FATAL:", e); }
}

startServer();
