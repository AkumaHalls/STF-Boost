const express = require('express');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { MongoClient, ObjectId } = require('mongodb'); 
const crypto = require('crypto');
const { fork } = require('child_process');
const https = require('https');
const bcrypt = require('bcryptjs'); 

console.log("[SYSTEM] Inicializando módulos...");

// --- CONFIGURAÇÃO ---
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_PASSWORD = process.env.SITE_PASSWORD; 
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL; 

if (!MONGODB_URI || !ADMIN_PASSWORD) { 
    console.error("ERRO CRÍTICO: As variáveis de ambiente MONGODB_URI e SITE_PASSWORD precisam de ser definidas!"); 
    process.exit(1); 
}

const ALGORITHM = 'aes-256-cbc';
let appSecretKey; 
let steamAppListCache = { data: [{appid: 730, name: "Counter-Strike 2"}], timestamp: 0 }; 

// --- DEFINIÇÃO DOS ROUTERS ---
const apiRouter = express.Router();
const adminApiRouter = express.Router();

// --- CONSTANTES ---
const FREE_HOURS_MS = 50 * 60 * 60 * 1000; 
const FREE_RENEW_COOLDOWN_MS = 24 * 60 * 60 * 1000; 
let GLOBAL_PLANS = {}; 
let PLAN_LIMITS = {};

// --- GESTÃO DE DADOS ---
const mongoClient = new MongoClient(MONGODB_URI);
let accountsCollection;
let siteSettingsCollection;
let usersCollection; 
let licensesCollection; 
let plansCollection;
let liveAccounts = {};

// --- FUNÇÕES DE BANCO DE DADOS ---
async function connectToDB() { 
    try { 
        await mongoClient.connect(); 
        console.log("[DB] Conectado ao MongoDB Atlas com sucesso!"); 
        const db = mongoClient.db("stf-saas-db"); 
        
        accountsCollection = db.collection("accounts");
        siteSettingsCollection = db.collection("site_settings");
        usersCollection = db.collection("users"); 
        licensesCollection = db.collection("licenses"); 
        plansCollection = db.collection("plans"); 
        
        await usersCollection.createIndex({ username: 1 }, { unique: true });
        await usersCollection.createIndex({ email: 1 }, { unique: true });
        await licensesCollection.createIndex({ key: 1 }, { unique: true }); 

    } catch (e) { 
        console.error("[DB] Não foi possível conectar ao MongoDB", e); 
        process.exit(1); 
    } 
}

async function initializePlans() {
    const count = await plansCollection.countDocuments();
    if (count === 0) {
        console.log("[SYSTEM] Criando planos padrão no banco de dados...");
        const defaultPlans = [
            { id: 'free', name: 'Gratuito', price: 0, days: 0, accounts: 1, games: 1, style: 'none', active: true, features: ['50 Horas (Renovável)', '1 Conta Steam', '1 Limite de Jogo', 'Suporte 2FA & Guard', 'Sem Risco de VAC', 'Auto-Restart'] },
            { id: 'basic', name: 'Basic', price: 7.90, days: 30, accounts: 2, games: 6, style: 'none', active: true, features: ['30 Dias de Acesso', 'Horas Ilimitadas', '2 Contas Steam', '6 Limite de Jogos', 'Suporte 2FA', 'Auto-Restart', 'Aparecer Offline'] },
            { id: 'plus', name: 'Plus', price: 15.90, days: 30, accounts: 4, games: 12, style: 'none', active: true, features: ['30 Dias de Acesso', 'Horas Ilimitadas', '4 Contas Steam', '12 Limite de Jogos', 'Auto-Aceitar Amigos'] },
            { id: 'premium', name: 'Premium', price: 27.90, days: 30, accounts: 6, games: 24, style: 'fire', active: true, features: ['30 Dias de Acesso', 'Horas Ilimitadas', '6 Contas Steam', '24 Limite de Jogos', 'Mensagem Ausente', 'Título no Jogo'] },
            { id: 'ultimate', name: 'Ultimate', price: 54.90, days: 30, accounts: 10, games: 33, style: 'none', active: true, features: ['30 Dias de Acesso', 'Horas Ilimitadas', '10 Contas Steam', '33 Limite de Jogos (Máx)', 'Prioridade Suporte'] },
            { id: 'lifetime', name: 'Vitalício', price: 249.90, days: 0, accounts: 10, games: 33, style: 'cosmic', active: true, features: ['Acesso Vitalício', 'Horas Ilimitadas', '10 Contas Steam', '33 Limite de Jogos (Máx)', 'Todos Recursos Premium'] }
        ];
        await plansCollection.insertMany(defaultPlans);
    }
    await refreshPlansCache();
}

async function refreshPlansCache() {
    const plans = await plansCollection.find({}).toArray();
    GLOBAL_PLANS = {};
    PLAN_LIMITS = {}; // Reinicia os limites
    plans.forEach(p => { 
        GLOBAL_PLANS[p.id] = p; 
        // Atualiza os limites globais baseados no DB
        PLAN_LIMITS[p.id] = { accounts: p.accounts, games: p.games };
    });
    console.log("[SYSTEM] Cache de planos atualizado.");
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

function sendDiscordNotification(title, message, color, username) {
    if (!DISCORD_WEBHOOK_URL) return;
    const payload = JSON.stringify({ embeds: [{ title: title || '\u200b', description: message || '\u200b', color: color, fields: [{ name: "Conta", value: `\`${username || 'N/A'}\``, inline: true }], footer: { text: "STF Boost Notifier" }, timestamp: new Date().toISOString() }] });
    try {
        const req = https.request({ hostname: new URL(DISCORD_WEBHOOK_URL).hostname, path: new URL(DISCORD_WEBHOOK_URL).pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }}, () => {});
        req.on('error', (e) => console.error('[DISCORD] Erro:', e));
        req.write(payload);
        req.end();
    } catch (e) {}
}

async function getSteamAppList() {
    if (Date.now() - steamAppListCache.timestamp < 24 * 60 * 60 * 1000 && steamAppListCache.data.length > 1) {
        return steamAppListCache.data;
    }
    try {
        const response = await fetch('https://steamspy.com/api.php?request=all', { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (response.ok) {
            const jsonData = await response.json();
            const appList = Object.values(jsonData);
            if (appList.length > 0) {
                steamAppListCache = { data: appList, timestamp: Date.now() };
                return steamAppListCache.data;
            }
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

// --- WORKER MANAGER ---
function startWorkerForAccount(accountData) {
    const username = accountData.username;
    if (liveAccounts[username]?.worker) liveAccounts[username].worker.kill();
    if (liveAccounts[username]?.startupTimeout) clearTimeout(liveAccounts[username].startupTimeout);

    const worker = fork(path.join(__dirname, 'worker.js'));
    liveAccounts[username].worker = worker;
    liveAccounts[username].status = "Iniciando...";
    liveAccounts[username].manual_logout = false;
    liveAccounts[username].ownerUserID = accountData.ownerUserID;

    liveAccounts[username].startupTimeout = setTimeout(() => {
        if (liveAccounts[username]?.status === "Iniciando...") {
            sendDiscordNotification("❄️ Conta Congelada", "Worker não respondeu.", 16776960, username);
            worker.kill();
        }
    }, 60000);

    worker.send({ command: 'start', data: accountData });

    worker.on('message', (msg) => {
        if (!liveAccounts[username]) return;
        if (liveAccounts[username].startupTimeout) { clearTimeout(liveAccounts[username].startupTimeout); liveAccounts[username].startupTimeout = null; }
        
        if (msg.type === 'statusUpdate') {
            if (liveAccounts[username].status !== msg.payload.status) {
                if (msg.payload.status === 'Rodando') sendDiscordNotification("✅ Conta Online", "Farmando horas.", 5763719, username);
                else if (msg.payload.status.startsWith('Erro')) sendDiscordNotification("❌ Erro", msg.payload.status, 15548997, username);
                else if (msg.payload.status.startsWith('Pendente')) sendDiscordNotification("🛡️ Guard Requerido", "Precisa de código.", 3447003, username);
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
                    acc.status = user?.isBanned ? "Banido" : "Tempo Esgotado/Expirado";
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
        } else {
            acc.status = "Parado";
            acc.sessionStartTime = null;
        }
    });
}

async function loadAccountsIntoMemory() {
    const defaultSettings = { customInGameTitle: '', customAwayMessage: '', appearOffline: false, autoAcceptFriends: false, autoRelogin: true, sharedSecret: '' };
    const savedAccounts = await accountsCollection.find({ "settings.autoRelogin": true }).toArray(); 
    savedAccounts.forEach((acc, index) => {
        liveAccounts[acc.username] = { ...acc, encryptedPassword: acc.password, settings: { ...defaultSettings, ...(acc.settings || {}) }, status: 'Parado', worker: null, sessionStartTime: null, manual_logout: false };
        const delay = index * 15000;
        setTimeout(() => {
            const accountData = { ...liveAccounts[acc.username], password: decrypt(acc.password) };
            if (accountData.password) startWorkerForAccount(accountData);
        }, delay);
    });
}

// --- MIDDLEWARES ---
app.use(express.json()); 
app.use(express.urlencoded({ extended: true })); 
app.use(session({ 
    secret: 'uma-nova-chave-secreta-para-sessoes-saas', 
    resave: false, 
    saveUninitialized: false, 
    store: MongoStore.create({ mongoUrl: MONGODB_URI, dbName: 'stf-saas-db' }), 
    cookie: { secure: 'auto', httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
})); 
app.use(express.static(path.join(__dirname, 'public'))); 

const isAuthenticated = async (req, res, next) => { 
    if (req.session.userId) { 
        try {
            const user = await usersCollection.findOne({ _id: new ObjectId(req.session.userId) });
            if (user) {
                if (user.isBanned) { req.session.destroy(() => res.redirect('/banned')); return; }
                return next();
            }
        } catch (e) { console.error("Erro auth:", e); }
    } 
    res.redirect('/login?error=unauthorized'); 
};

const isAdminAuthenticated = (req, res, next) => {
    if (req.session.isAdmin) return next();
    res.redirect('/admin/login?error=unauthorized');
};

// --- ROTAS DE PÁGINAS ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => req.session.userId ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/register', (req, res) => req.session.userId ? res.redirect('/dashboard') : res.sendFile(path.join(__dirname, 'public', 'register.html')));
app.get('/dashboard', isAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/banned', (req, res) => res.sendFile(path.join(__dirname, 'public', 'banned.html')));
app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// --- ROTAS ADMIN PÁGINAS ---
app.get('/admin', (req, res) => res.redirect('/admin/dashboard'));
app.get('/admin/login', (req, res) => req.session.isAdmin ? res.redirect('/admin/dashboard') : res.sendFile(path.join(__dirname, 'public', 'admin', 'login.html')));
app.get('/admin/dashboard', isAdminAuthenticated, (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin', 'dashboard.html')));
app.post('/admin/login', (req, res) => { req.body.password === ADMIN_PASSWORD ? (req.session.isAdmin = true, res.redirect('/admin/dashboard')) : res.redirect('/admin/login?error=invalid'); });
app.get('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// ==========================================
// === API USUÁRIO ===
// ==========================================
apiRouter.get('/auth-status', (req, res) => res.json({ loggedIn: !!req.session.userId }));

// *** ROTA PÚBLICA PARA LISTAR APENAS PLANOS ATIVOS ***
apiRouter.get('/plans', async (req, res) => {
    try {
        const plans = await plansCollection.find({ active: true }).toArray();
        // Ordenação segura: Free primeiro, depois por preço
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

// ROTAS PROTEGIDAS (Usuário)
apiRouter.use(isAuthenticated);

apiRouter.get('/user-info', async (req, res) => {
    const user = await usersCollection.findOne({ _id: new ObjectId(req.session.userId) });
    if (!user) return res.status(404).json({ message: "Erro user." });
    let fh = 0;
    if (user.plan === 'free') fh = Math.ceil(user.freeHoursRemaining / 3600000);
    
    // Busca limites do DB, fallback para PLAN_LIMITS inicial se der erro
    const planDetails = GLOBAL_PLANS[user.plan] || PLAN_LIMITS[user.plan] || PLAN_LIMITS['free'];
    
    res.json({ 
        username: user.username, 
        plan: user.plan, 
        freeHoursRemaining: fh, 
        planExpiresAt: user.planExpiresAt,
        gameLimit: planDetails.games,
        accountLimit: planDetails.accounts 
    });
});

apiRouter.get('/status', (req, res) => {
    const myAccounts = {};
    for (const user in liveAccounts) {
        if (liveAccounts[user].ownerUserID === req.session.userId) {
            const acc = liveAccounts[user];
            myAccounts[user] = { username: acc.username, status: acc.status, games: acc.games, settings: acc.settings, uptime: acc.sessionStartTime ? Date.now() - acc.sessionStartTime : 0 };
        }
    }
    res.json({ accounts: myAccounts });
});
apiRouter.post('/add-account', async (req, res) => {
    const { username, password } = req.body;
    const uid = req.session.userId;
    const user = await usersCollection.findOne({ _id: new ObjectId(uid) });
    const count = await accountsCollection.countDocuments({ ownerUserID: uid });
    
    const planDetails = GLOBAL_PLANS[user.plan] || PLAN_LIMITS[user.plan] || PLAN_LIMITS['free'];
    const limit = planDetails.accounts;

    if (count >= limit) return res.status(403).json({ message: `Limite de contas do plano atingido (${limit}).` });
    if (await accountsCollection.findOne({ username })) return res.status(400).json({ message: "Conta Steam já cadastrada." });
    const encPass = encrypt(password);
    await accountsCollection.insertOne({ username, password: encPass, games: [730], settings: {}, ownerUserID: uid });
    liveAccounts[username] = { username, encryptedPassword: encPass, games: [730], settings: {}, status: 'Parado', ownerUserID: uid };
    res.json({ message: "Conta adicionada." });
});
apiRouter.post('/start/:username', async (req, res) => {
    const username = req.params.username;
    const acc = liveAccounts[username];
    if (!acc || acc.ownerUserID !== req.session.userId) return res.status(404).json({ message: "Conta não encontrada." });
    
    const user = await usersCollection.findOne({ _id: new ObjectId(req.session.userId) });
    if (user.plan === 'free' && user.freeHoursRemaining <= 0) return res.status(403).json({ message: "Sem horas grátis." });
    if (user.planExpiresAt && user.planExpiresAt < new Date()) return res.status(403).json({ message: "Plano expirado." });
    
    const planDetails = GLOBAL_PLANS[user.plan] || PLAN_LIMITS[user.plan] || PLAN_LIMITS['free'];
    const limit = planDetails.games;

    if (acc.games.length > limit) return res.status(403).json({ message: `Limite de jogos (${limit}) excedido.` });

    const pass = decrypt(acc.encryptedPassword);
    if (pass) { startWorkerForAccount({ ...acc, password: pass }); res.json({ message: "Iniciando..." }); } 
    else { res.status(500).json({ message: "Erro senha." }); }
});
apiRouter.post('/stop/:username', (req, res) => {
    const acc = liveAccounts[req.params.username];
    if (acc && acc.ownerUserID === req.session.userId) {
        acc.manual_logout = true;
        if (acc.worker) acc.worker.kill();
        acc.status = "Parado";
        res.json({ message: "Parando..." });
    } else { res.status(404).json({ message: "Erro." }); }
});
apiRouter.delete('/remove-account/:username', async (req, res) => {
    const username = req.params.username;
    const acc = liveAccounts[username];
    if (acc && acc.ownerUserID === req.session.userId) {
        acc.manual_logout = true;
        if (acc.worker) acc.worker.kill();
        delete liveAccounts[username];
    }
    await accountsCollection.deleteOne({ username, ownerUserID: req.session.userId });
    res.json({ message: "Removido." });
});
apiRouter.post('/save-settings/:username', async (req, res) => {
    const { username } = req.params;
    const { settings, newPassword } = req.body;
    const uid = req.session.userId;
    const user = await usersCollection.findOne({ _id: new ObjectId(uid) });
    
    if (user.plan === 'free' && (settings.appearOffline || settings.customInGameTitle)) return res.status(403).json({ message: "Funcionalidade Premium." });

    if (liveAccounts[username] && liveAccounts[username].ownerUserID === uid) {
        if (settings) {
            await accountsCollection.updateOne({ username, ownerUserID: uid }, { $set: { settings } });
            liveAccounts[username].settings = settings;
            if (liveAccounts[username].worker) liveAccounts[username].worker.send({ command: 'updateSettings', data: { settings, games: liveAccounts[username].games } });
        }
        res.json({ message: "Salvo." });
    } else { res.status(404).json({ message: "Erro." }); }
});
apiRouter.post('/set-games/:username', async (req, res) => {
    const { username } = req.params;
    const { games } = req.body;
    const uid = req.session.userId;
    const user = await usersCollection.findOne({ _id: new ObjectId(uid) });
    
    const planDetails = GLOBAL_PLANS[user.plan] || PLAN_LIMITS[user.plan] || PLAN_LIMITS['free'];
    const limit = planDetails.games;

    if (games.length > limit) return res.status(403).json({ message: `Limite de jogos (${limit}) excedido.` });

    if (liveAccounts[username] && liveAccounts[username].ownerUserID === uid) {
        await accountsCollection.updateOne({ username, ownerUserID: uid }, { $set: { games } });
        liveAccounts[username].games = games;
        if (liveAccounts[username].worker) liveAccounts[username].worker.send({ command: 'updateSettings', data: { settings: liveAccounts[username].settings, games } });
        res.json({ message: "Jogos salvos." });
    } else { res.status(404).json({ message: "Erro." }); }
});
apiRouter.get('/search-game', async (req, res) => {
    const q = (req.query.q || '').toLowerCase();
    if (q.length < 2) return res.json([]);
    const list = await getSteamAppList();
    res.json(list.filter(a => a.name.toLowerCase().includes(q)).slice(0, 50));
});
apiRouter.post('/activate-license', async (req, res) => {
    const { licenseKey } = req.body;
    const uid = req.session.userId;
    const key = await licensesCollection.findOne({ key: licenseKey });
    if (!key || key.isUsed) return res.status(400).json({ message: "Chave inválida ou usada." });
    if (key.assignedTo && key.assignedTo.toString() !== uid) return res.status(403).json({ message: "Chave não é para você." });
    
    // Verificar se o plano existe no DB/Cache
    if (!GLOBAL_PLANS[key.plan]) return res.status(400).json({ message: "Erro: Plano da chave não existe." });

    let expiry = null;
    // Usa duração da chave ou do plano
    const duration = key.durationDays || GLOBAL_PLANS[key.plan].days;
    
    if (duration > 0) { expiry = new Date(); expiry.setDate(expiry.getDate() + duration); }
    await usersCollection.updateOne({ _id: new ObjectId(uid) }, { $set: { plan: key.plan, planExpiresAt: expiry, freeHoursRemaining: 0 } });
    await licensesCollection.updateOne({ _id: key._id }, { $set: { isUsed: true, usedBy: new ObjectId(uid), activatedAt: new Date() } });
    res.json({ message: "Plano ativado!" });
});
apiRouter.get('/my-keys', async (req, res) => {
    const keys = await licensesCollection.find({ assignedTo: new ObjectId(req.session.userId), isUsed: false }).toArray();
    res.json(keys);
});
apiRouter.post('/renew-free-time', async (req, res) => {
    const uid = req.session.userId;
    const user = await usersCollection.findOne({ _id: new ObjectId(uid) });
    if (user.plan !== 'free' || user.freeHoursRemaining > 0) return res.status(400).json({ message: "Não elegível." });
    if (user.lastFreeRenew && (Date.now() - user.lastFreeRenew < FREE_RENEW_COOLDOWN_MS)) return res.status(429).json({ message: "Aguarde 24h." });
    await usersCollection.updateOne({ _id: new ObjectId(uid) }, { $set: { freeHoursRemaining: FREE_HOURS_MS, lastFreeRenew: new Date() } });
    res.json({ message: "Renovado!" });
});
apiRouter.post('/change-password', async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    const user = await usersCollection.findOne({ _id: new ObjectId(req.session.userId) });
    if (!await bcrypt.compare(currentPassword, user.password)) return res.status(401).json({ message: "Senha atual errada." });
    const hash = await bcrypt.hash(newPassword, 10);
    await usersCollection.updateOne({ _id: new ObjectId(req.session.userId) }, { $set: { password: hash } });
    res.json({ message: "Senha alterada." });
});
apiRouter.post('/bulk-start', async (req, res) => {
    const { usernames } = req.body;
    const uid = req.session.userId;
    const user = await usersCollection.findOne({ _id: new ObjectId(uid) });
    if (user.plan === 'free' && user.freeHoursRemaining <= 0) return res.status(403).json({ message: "Sem horas." });
    
    const planDetails = GLOBAL_PLANS[user.plan] || GLOBAL_PLANS['free'];
    const limit = planDetails.games;

    let c = 0;
    usernames.forEach(u => {
        const acc = liveAccounts[u];
        if (acc && acc.ownerUserID === uid && acc.games.length <= limit) {
            const p = decrypt(acc.encryptedPassword);
            if (p) { startWorkerForAccount({ ...acc, password: p }); c++; }
        }
    });
    res.json({ message: `${c} iniciadas.` });
});
// ... (bulk-stop e bulk-remove são iguais, podem ficar como estavam ou simplificados)
apiRouter.post('/bulk-stop', (req, res) => {
    const { usernames } = req.body;
    usernames.forEach(u => {
        const acc = liveAccounts[u];
        if (acc && acc.ownerUserID === req.session.userId) {
            acc.manual_logout = true;
            if (acc.worker) acc.worker.kill();
            acc.status = "Parado";
        }
    });
    res.json({ message: "Paradas." });
});
apiRouter.post('/bulk-remove', async (req, res) => {
    const { usernames } = req.body;
    usernames.forEach(u => {
        const acc = liveAccounts[u];
        if (acc && acc.ownerUserID === req.session.userId) {
            if (acc.worker) acc.worker.kill();
            delete liveAccounts[u];
        }
    });
    await accountsCollection.deleteMany({ username: { $in: usernames }, ownerUserID: req.session.userId });
    res.json({ message: "Removidas." });
});

// ==========================================
// === API ADMIN (PROTEGIDA) ===
// ==========================================
adminApiRouter.use(isAdminAuthenticated);

// *** ROTA CRÍTICA PARA O PAINEL ADMIN: VER TODOS OS PLANOS ***
adminApiRouter.get('/all-plans', async (req, res) => {
    try {
        const plans = await plansCollection.find({}).sort({ price: 1 }).toArray();
        res.json(plans);
    } catch(e) { res.status(500).json([]); }
});

adminApiRouter.post('/update-plan-details', async (req, res) => {
    const { id, name, price, days, accounts, games, style, active, features } = req.body;
    await plansCollection.updateOne(
        { id: id }, 
        { $set: { name, price: parseFloat(price), days: parseInt(days), accounts: parseInt(accounts), games: parseInt(games), style, active, features } },
        { upsert: true } 
    );
    await refreshPlansCache();
    res.json({ message: "Plano atualizado." });
});

adminApiRouter.post('/delete-plan', async (req, res) => {
    const { id } = req.body;
    await plansCollection.deleteOne({ id: id });
    await refreshPlansCache();
    res.json({ message: "Plano excluído." });
});

adminApiRouter.get('/users', async (req, res) => {
    res.json(await usersCollection.find({}, { projection: { password: 0 } }).toArray());
});
adminApiRouter.get('/licenses', async (req, res) => {
    res.json(await licensesCollection.find({}).sort({ createdAt: -1 }).toArray());
});
adminApiRouter.post('/generate-keys', async (req, res) => {
    const { plan, quantity, durationDays } = req.body;
    const qty = parseInt(quantity) || 1;
    const keys = [];
    for(let i=0; i<qty; i++) {
        const key = `${plan.toUpperCase()}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
        await licensesCollection.insertOne({ key, plan, durationDays: parseInt(durationDays) || null, isUsed: false, createdAt: new Date() });
        keys.push(key);
    }
    res.json({ keys, message: "Gerado." });
});
adminApiRouter.post('/ban-user', async (req, res) => {
    await usersCollection.updateOne({ _id: new ObjectId(req.body.userId) }, { $set: { isBanned: true } });
    for(const u in liveAccounts) { if (liveAccounts[u].ownerUserID === req.body.userId && liveAccounts[u].worker) liveAccounts[u].worker.kill(); }
    res.json({ message: "Banido." });
});
adminApiRouter.post('/unban-user', async (req, res) => {
    await usersCollection.updateOne({ _id: new ObjectId(req.body.userId) }, { $set: { isBanned: false } });
    res.json({ message: "Desbanido." });
});
adminApiRouter.post('/assign-key', async (req, res) => {
    const { licenseId, username } = req.body;
    const user = await usersCollection.findOne({ username });
    if (!user) return res.status(404).json({ message: "User não achado." });
    await licensesCollection.updateOne({ _id: new ObjectId(licenseId) }, { $set: { assignedTo: user._id, assignedToUsername: user.username } });
    res.json({ message: "Atribuído." });
});
adminApiRouter.post('/delete-license', async (req, res) => {
    await licensesCollection.deleteOne({ _id: new ObjectId(req.body.licenseId) });
    res.json({ message: "Deletado." });
});
adminApiRouter.post('/delete-user', async (req, res) => {
    const uid = req.body.userId;
    await usersCollection.deleteOne({ _id: new ObjectId(uid) });
    await accountsCollection.deleteMany({ ownerUserID: uid });
    for(const u in liveAccounts) { if (liveAccounts[u].ownerUserID === uid) delete liveAccounts[u]; }
    res.json({ message: "Deletado." });
});
adminApiRouter.post('/update-plan', async (req, res) => {
    const { userId, newPlan } = req.body;
    await usersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: { plan: newPlan, planExpiresAt: null } });
    res.json({ message: "Atualizado." });
});

// --- APLICAÇÃO DOS ROUTERS (IMPORTANTE: No Fim) ---
app.use('/api/admin', adminApiRouter);
app.use('/api', apiRouter);

// --- CRON JOBS ---
async function deductFreeTime() {
    const updates = new Set();
    for (const u in liveAccounts) { if (liveAccounts[u].status === 'Rodando') updates.add(liveAccounts[u].ownerUserID); }
    if (updates.size === 0) return;
    const ids = Array.from(updates).map(id => new ObjectId(id));
    await usersCollection.updateMany({ _id: { $in: ids }, plan: 'free' }, { $inc: { freeHoursRemaining: -300000 } });
    const expired = await usersCollection.find({ _id: { $in: ids }, plan: 'free', freeHoursRemaining: { $lte: 0 } }).toArray();
    expired.forEach(u => {
        for (const acc in liveAccounts) {
            if (liveAccounts[acc].ownerUserID === u._id.toString() && liveAccounts[acc].worker) {
                liveAccounts[acc].worker.kill();
                liveAccounts[acc].status = "Tempo Esgotado";
            }
        }
    });
}

async function checkExpiredPlans() {
    const now = new Date();
    const expired = await usersCollection.find({ plan: { $ne: 'free' }, planExpiresAt: { $lt: now } }).toArray();
    for (const u of expired) {
        await usersCollection.updateOne({ _id: u._id }, { $set: { plan: 'free', planExpiresAt: null, freeHoursRemaining: FREE_HOURS_MS } });
        for (const acc in liveAccounts) { if (liveAccounts[acc].ownerUserID === u._id.toString() && liveAccounts[acc].worker) liveAccounts[acc].worker.kill(); }
    }
}

// --- START ---
async function startServer() {
    console.log("[SYSTEM] Conectando ao DB...");
    try {
        await connectToDB();
        await initializePlans(); // Cria planos
        await initializeMasterKey();
        await loadAccountsIntoMemory();
        setInterval(deductFreeTime, 300000);
        setInterval(checkExpiredPlans, 3600000);
        app.listen(PORT, () => console.log(`[SYSTEM] SERVIDOR ONLINE NA PORTA ${PORT}`));
    } catch (e) {
        console.error("[SYSTEM] ERRO FATAL:", e);
    }
}

startServer();
