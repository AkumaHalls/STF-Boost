const express = require('express');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { MongoClient, ObjectId } = require('mongodb'); 
const crypto = require('crypto');
const { fork } = require('child_process');
const https = require('https');
const bcrypt = require('bcryptjs'); 

// --- CONFIGURAÇÃO ---
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const ADMIN_PASSWORD = process.env.SITE_PASSWORD; 
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL; 

if (!MONGODB_URI) { console.error("ERRO CRÍTICO: A variável de ambiente MONGODB_URI precisa de ser definida!"); process.exit(1); }
const ALGORITHM = 'aes-256-cbc';
let appSecretKey; 
let steamAppListCache = { data: [], timestamp: 0 }; 

// --- (Funções sendDiscordNotification, encrypt, decrypt) ---
// (Sem alterações)
function sendDiscordNotification(title, message, color, username) {
    if (!DISCORD_WEBHOOK_URL) return;
    const safeTitle = title || '\u200b';
    const safeMessage = message || '\u200b';
    const safeUsername = username || 'N/A';
    const embed = { title: safeTitle, description: safeMessage, color: color, fields: [{ name: "Conta", value: `\`${safeUsername}\``, inline: true }], footer: { text: "STF Boost Notifier" }, timestamp: new Date().toISOString() };
    const payload = JSON.stringify({ embeds: [embed] });
    const payloadByteLength = Buffer.byteLength(payload);
    try {
        const url = new URL(DISCORD_WEBHOOK_URL);
        const options = { hostname: url.hostname, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payloadByteLength }};
        const req = https.request(options, res => {
            if (res.statusCode < 200 || res.statusCode >= 300) { console.error(`[DISCORD] Falha ao enviar notificação, status: ${res.statusCode}`); res.on('data', (d) => { console.error(`[DISCORD] Resposta de erro: ${d.toString()}`); }); }
        });
        req.on('error', error => { console.error('[DISCORD] Erro na requisição do webhook:', error); });
        req.write(payload);
        req.end();
    } catch (e) { console.error("[DISCORD] URL do webhook inválida.", e); }
}
const encrypt = (text) => { if (!appSecretKey) { console.error("[ENCRIPTAR] ERRO CRÍTICO: appSecretKey não está definida!"); return null; } const iv = crypto.randomBytes(16); const cipher = crypto.createCipheriv(ALGORITHM, appSecretKey, iv); let encrypted = cipher.update(text, 'utf8', 'hex'); encrypted += cipher.final('hex'); return `${iv.toString('hex')}:${encrypted}`; };
const decrypt = (text) => { try { if (!appSecretKey) { return ""; } if (!text) { return ""; } const textParts = text.split(':'); const iv = Buffer.from(textParts.shift(), 'hex'); const encryptedText = Buffer.from(textParts.join(':'), 'hex'); const decipher = crypto.createDecipheriv(ALGORITHM, appSecretKey, iv); let decrypted = decipher.update(encryptedText, 'hex', 'utf8'); decrypted += decipher.final('utf8'); return decrypted; } catch (error) { console.error("[DESENCRIPTAR] Falha crítica na função de desencriptar:", error); return ""; }};

// --- GESTÃO DE CONTAS E BANCO DE DADOS ---
const mongoClient = new MongoClient(MONGODB_URI);
let accountsCollection;
let siteSettingsCollection;
let usersCollection; 
let liveAccounts = {};

async function connectToDB() { 
    try { 
        await mongoClient.connect(); 
        console.log("Conectado ao MongoDB Atlas com sucesso!"); 
        const db = mongoClient.db("stf-saas-db"); 
        
        accountsCollection = db.collection("accounts");
        siteSettingsCollection = db.collection("site_settings");
        usersCollection = db.collection("users"); 
        
        await usersCollection.createIndex({ username: 1 }, { unique: true });
        await usersCollection.createIndex({ email: 1 }, { unique: true });

    } catch (e) { 
        console.error("Não foi possível conectar ao MongoDB", e); 
        process.exit(1); 
    } 
}

async function initializeMasterKey() {
    // (Sem alterações)
    let settings = await siteSettingsCollection.findOne({ _id: 'config' });
    if (!settings || !settings.appSecret) {
        console.log("[GESTOR] Nenhuma chave mestra encontrada. A gerar uma nova...");
        const newSecret = crypto.randomBytes(32).toString('hex');
        appSecretKey = crypto.createHash('sha256').update(newSecret).digest('base64').substr(0, 32);
        await siteSettingsCollection.updateOne( { _id: 'config' }, { $set: { appSecret: newSecret } }, { upsert: true } );
        console.log("[GESTOR] Nova chave mestra gerada e guardada na base de dados.");
    } else {
        console.log("[GESTOR] Chave mestra carregada da base de dados.");
        appSecretKey = crypto.createHash('sha256').update(settings.appSecret).digest('base64').substr(0, 32);
    }
}

// --- BUSCA DE JOGOS (COM STEAMSPY) ---
// (Sem alterações)
async function getSteamAppList() {
    if (Date.now() - steamAppListCache.timestamp < 24 * 60 * 60 * 1000 && steamAppListCache.data.length > 0) {
        return steamAppListCache.data;
    }
    console.log("[GESTOR] Cache da lista de apps (SteamSpy) expirado. A buscar nova lista...");
    const url = 'https://steamspy.com/api.php?request=all';
    const options = { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/5.37 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }};
    try {
        const response = await fetch(url, options);
        if (!response.ok) { throw new Error(`Falha ao buscar lista de apps do SteamSpy. Status: ${response.status} ${response.statusText}`); }
        const jsonData = await response.json();
        if (!jsonData) { throw new Error("SteamSpy retornou dados vazios ou inválidos."); }
        const appList = Object.values(jsonData); 
        if (appList.length === 0) { throw new Error("SteamSpy retornou JSON, mas estava vazio."); }
        steamAppListCache = { data: appList, timestamp: Date.now() };
        console.log("[GESTOR] Cache da lista de apps (via SteamSpy) atualizado.");
        return steamAppListCache.data;
    } catch (e) {
        console.error("[GESTOR] Erro ao processar lista de apps do SteamSpy:", e);
        return steamAppListCache.data;
    }
}

// --- LÓGICA DO WORKER ---
// (Sem alterações)
function startWorkerForAccount(accountData) {
    const username = accountData.username;
    console.log(`[GESTOR] A iniciar worker para ${username} (Dono: ${accountData.ownerUserID})`);
    if (liveAccounts[username] && liveAccounts[username].worker) { liveAccounts[username].worker.kill(); }
    if (liveAccounts[username] && liveAccounts[username].startupTimeout) { clearTimeout(liveAccounts[username].startupTimeout); }
    const worker = fork(path.join(__dirname, 'worker.js'));
    liveAccounts[username].worker = worker;
    liveAccounts[username].status = "Iniciando...";
    liveAccounts[username].manual_logout = false;
    liveAccounts[username].timed_out = false; 
    liveAccounts[username].ownerUserID = accountData.ownerUserID; 
    const startupTimeout = setTimeout(() => {
        if (liveAccounts[username] && liveAccounts[username].status === "Iniciando...") {
            console.error(`[GESTOR] Worker para ${username} demorou muito para iniciar (Timeout). Acionando reinicialização automática.`);
            sendDiscordNotification("❄️ Conta Congelada (Timeout)", "O worker não respondeu a tempo e será reiniciado.", 16776960, username);
            liveAccounts[username].timed_out = true; 
            worker.kill(); 
        }
    }, 60000); 
    liveAccounts[username].startupTimeout = startupTimeout;
    worker.send({ command: 'start', data: accountData });
    worker.on('message', (message) => {
        if (!liveAccounts[username]) return;
        clearTimeout(liveAccounts[username].startupTimeout);
        liveAccounts[username].startupTimeout = null;
        const { type, payload } = message;
        if (liveAccounts[username]) {
            if (type === 'statusUpdate') {
                const oldStatus = liveAccounts[username].status;
                const newStatus = payload.status;
                if (oldStatus !== newStatus) {
                    if (newStatus === 'Rodando') { sendDiscordNotification("✅ Conta Online", "A conta conectou-se com sucesso e está a farmar horas.", 5763719, username); } 
                    else if (newStatus === 'Pendente: Steam Guard') { sendDiscordNotification("🛡️ Steam Guard Requerido", "A conta precisa de um código de autenticação para continuar.", 3447003, username); } 
                    else if (newStatus.startsWith('Erro:')) { sendDiscordNotification("❌ Erro Crítico", `Ocorreu um erro: **${newStatus}**. A conta parou.`, 15548997, username); }
                }
                Object.assign(liveAccounts[username], payload);
            }
            if (type === 'sentryUpdate') {
                liveAccounts[username].sentryFileHash = payload.sentryFileHash;
                accountsCollection.updateOne({ username, ownerUserID: liveAccounts[username].ownerUserID }, { $set: { sentryFileHash: payload.sentryFileHash } });
            }
        }
    });
    worker.on('exit', (code) => {
        if (liveAccounts[username] && liveAccounts[username].startupTimeout) { clearTimeout(liveAccounts[username].startupTimeout); liveAccounts[username].startupTimeout = null; }
        const accountExited = liveAccounts[username];
        if (!accountExited) return;
        const wasTimeout = accountExited.timed_out;
        accountExited.timed_out = false; 
        console.log(`[GESTOR] Worker para ${username} (Dono: ${accountExited.ownerUserID}) saiu com código ${code}.`);
        
        if (accountExited.manual_logout === false && accountExited.settings.autoRelogin === true) {
            // VERIFICA SE O PLANO AINDA PERMITE REINICIAR
            usersCollection.findOne({ _id: new ObjectId(accountExited.ownerUserID) }).then(user => {
                if (user && user.plan === 'free' && user.freeHoursRemaining <= 0) {
                    console.log(`[GESTOR] ${username} não será reiniciado. Usuário 'free' sem tempo.`);
                    accountExited.status = "Tempo Esgotado";
                    accountExited.sessionStartTime = null;
                } else {
                    // Usuário pago ou free com tempo, reinicia normalmente
                    const restartDelay = wasTimeout ? 5000 : 30000;
                    const reason = wasTimeout ? "devido a um timeout" : "após uma desconexão";
                    sendDiscordNotification("🔄 A Reiniciar Conta", `A conta será reiniciada em ${restartDelay / 1000}s ${reason}.`, 16776960, username);
                    console.log(`[GESTOR] A reiniciar worker para ${username} em ${restartDelay / 1000} segundos...`);
                    accountExited.status = "Reiniciando...";
                    setTimeout(() => {
                        if(liveAccounts[username]) {
                            const accData = { ...liveAccounts[username], password: decrypt(liveAccounts[username].encryptedPassword) };
                            if (accData.password) startWorkerForAccount(accData);
                        }
                    }, restartDelay);
                }
            });
        } else {
            accountExited.status = wasTimeout ? "Erro: Timeout" : (accountExited.status === "Tempo Esgotado" ? "Tempo Esgotado" : "Parado");
            accountExited.sessionStartTime = null;
        }
    });
    worker.on('error', (err) => {
        console.error(`[GESTOR] Erro no canal de comunicação do worker ${username}:`, err.message);
    });
}

async function loadAccountsIntoMemory() {
    // (Sem alterações)
    const defaultSettings = { customInGameTitle: '', customAwayMessage: '', appearOffline: false, autoAcceptFriends: false, autoRelogin: true, sharedSecret: '' };
    const savedAccounts = await accountsCollection.find({ "settings.autoRelogin": true }).toArray(); 
    savedAccounts.forEach((acc, index) => {
        liveAccounts[acc.username] = { ...acc, encryptedPassword: acc.password, settings: { ...defaultSettings, ...(acc.settings || {}) }, status: 'Parado', worker: null, sessionStartTime: null, manual_logout: false };
        
        const delay = index * 15000;
        console.log(`[GESTOR] Worker para ${acc.username} (Dono: ${acc.ownerUserID}) agendado para iniciar em ${delay / 1000}s.`);
        setTimeout(() => {
            const accountData = { ...liveAccounts[acc.username], password: decrypt(acc.password) };
            if (accountData.password) {
                startWorkerForAccount(accountData);
            } else {
                console.error(`[GESTOR] Falha ao desencriptar senha para ${acc.username}, início automático abortado.`);
            }
        }, delay);
    });
    console.log(`[GESTOR] ${savedAccounts.length} contas (com auto-relogin) carregadas.`);
}

// --- EXPRESS APP E ROTAS ---
// (Sem alterações na configuração)
app.use(express.json()); 
app.use(express.urlencoded({ extended: true })); 
app.use(session({ 
    secret: 'uma-nova-chave-secreta-para-sessoes-saas', 
    resave: false, 
    saveUninitialized: false, 
    store: MongoStore.create({ mongoUrl: MONGODB_URI, dbName: 'stf-saas-db' }), 
    cookie: { secure: 'auto', httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
})); 
const isAuthenticated = (req, res, next) => { 
    if (req.session.userId) { 
        return next(); 
    } 
    res.redirect('/login?error=unauthorized'); 
};

// --- ROTAS DE PÁGINAS ---
// (Sem alterações)
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('/login', (req, res) => { if (req.session.userId) { return res.redirect('/dashboard'); } res.sendFile(path.join(__dirname, 'public', 'login.html')); });
app.get('/register', (req, res) => { if (req.session.userId) { return res.redirect('/dashboard'); } res.sendFile(path.join(__dirname, 'public', 'register.html')); });
app.get('/dashboard', isAuthenticated, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); });
app.get('/logout', (req, res) => { req.session.destroy(err => { if (err) { console.error("Erro ao fazer logout:", err); return res.status(500).send("Não foi possível fazer logout."); } res.clearCookie('connect.sid'); res.redirect('/'); }); });
app.use(express.static(path.join(__dirname, 'public'))); 
app.get('/health', (req, res) => { res.status(200).send('OK'); }); 

// --- ROTAS DE API (Autenticação) ---
const apiRouter = express.Router();
// (Rotas /register e /login sem alterações)
apiRouter.post('/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ message: "Todos os campos são obrigatórios." });
    }
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        await usersCollection.insertOne({
            username,
            email,
            password: hashedPassword,
            plan: 'free', 
            freeHoursRemaining: 100 * 60 * 60 * 1000, // 100 horas grátis
            createdAt: new Date()
        });
        res.status(201).json({ message: "Usuário registado com sucesso!" });
    } catch (error) {
        if (error.code === 11000) { 
            res.status(409).json({ message: "Username ou email já existe." });
        } else {
            console.error("Erro no registo:", error);
            res.status(500).json({ message: "Erro interno ao registar usuário." });
        }
    }
});
apiRouter.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: "Username e senha são obrigatórios." });
    }
    try {
        const user = await usersCollection.findOne({ username });
        if (!user) {
            return res.status(401).json({ message: "Credenciais inválidas." });
        }
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: "Credenciais inválidas." });
        }
        req.session.userId = user._id.toString(); 
        req.session.username = user.username;
        res.status(200).json({ message: "Login bem-sucedido!" });
    } catch (error) {
        console.error("Erro no login:", error);
        res.status(500).json({ message: "Erro interno ao fazer login." });
    }
});

// --- API PROTEGIDA ---
apiRouter.use(isAuthenticated); 

// Rota /user-info (Sem alterações)
apiRouter.get('/user-info', async (req, res) => {
    try {
        const user = await usersCollection.findOne({ _id: new ObjectId(req.session.userId) });
        if (!user) {
            return res.status(404).json({ message: "Usuário não encontrado." });
        }
        
        let freeHours = 0;
        if (user.plan === 'free' && user.freeHoursRemaining) {
            // Arredonda para cima
            freeHours = Math.ceil(user.freeHoursRemaining / (60 * 60 * 1000)); 
        }

        res.status(200).json({
            username: user.username,
            plan: user.plan,
            freeHoursRemaining: freeHours 
        });
    } catch (error) {
        console.error("Erro ao buscar info do usuário:", error);
        res.status(500).json({ message: "Erro ao buscar informações do usuário." });
    }
});

// Rota /status (Sem alterações)
apiRouter.get('/status', (req, res) => {
    const publicState = { accounts: {} };
    const currentUserID = req.session.userId;

    for (const username in liveAccounts) {
        const acc = liveAccounts[username];
        if (acc.ownerUserID === currentUserID) {
            const publicData = {
                username: acc.username,
                status: acc.status,
                games: acc.games,
                settings: acc.settings,
                uptime: acc.sessionStartTime ? Date.now() - acc.sessionStartTime : 0
            };
            publicState.accounts[username] = publicData;
        }
    }
    res.json(publicState);
});

// *** ROTA /start/:username (COM VERIFICAÇÃO DE TEMPO) ***
apiRouter.post('/start/:username', async (req, res) => { 
    const account = liveAccounts[req.params.username]; 
    const currentUserID = req.session.userId;

    if (account && account.ownerUserID === currentUserID) { 
        // --- INÍCIO DA VERIFICAÇÃO DE PLANO ---
        const user = await usersCollection.findOne({ _id: new ObjectId(currentUserID) });
        if (user.plan === 'free' && user.freeHoursRemaining <= 0) {
            return res.status(403).json({ message: "Suas horas grátis acabaram. Faça upgrade para continuar." });
        }
        // --- FIM DA VERIFICAÇÃO DE PLANO ---

        const accountData = { ...account, password: decrypt(account.encryptedPassword) }; 
        if (accountData.password) { startWorkerForAccount(accountData); res.status(200).json({ message: "Iniciando worker..." }); } 
        else { res.status(500).json({ message: "Erro ao desencriptar senha."}); } 
    } else { res.status(404).json({ message: "Conta não encontrada." }); } 
});

// Rota /stop/:username (Sem alterações)
apiRouter.post('/stop/:username', (req, res) => {
    const account = liveAccounts[req.params.username];
    if (account && account.ownerUserID === req.session.userId) {
        if(account.startupTimeout) { clearTimeout(account.startupTimeout); account.startupTimeout = null; }
        account.manual_logout = true;
        account.worker.kill();
        account.status = "Parado";
        account.sessionStartTime = null; 
        res.status(200).json({ message: "Parando worker..." });
    } else { res.status(404).json({ message: "Conta ou worker não encontrado." }); }
});

// Rotas /bulk-xxx (Sem alterações)
apiRouter.post('/bulk-start', async (req, res) => {
    const { usernames } = req.body;
    const currentUserID = req.session.userId;
    if (!usernames || !Array.isArray(usernames)) return res.status(400).json({ message: "Requisição inválida." });

    // --- INÍCIO DA VERIFICAÇÃO DE PLANO ---
    const user = await usersCollection.findOne({ _id: new ObjectId(currentUserID) });
    if (user.plan === 'free' && user.freeHoursRemaining <= 0) {
        return res.status(403).json({ message: "Suas horas grátis acabaram. Faça upgrade para continuar." });
    }
    // --- FIM DA VERIFICAÇÃO DE PLANO ---

    let startedCount = 0;
    usernames.forEach(username => {
        const account = liveAccounts[username];
        if (account && account.ownerUserID === currentUserID) {
            const accountData = { ...account, password: decrypt(account.encryptedPassword) };
            if (accountData.password) {
                startWorkerForAccount(accountData);
                startedCount++;
            }
        }
    });
    res.status(200).json({ message: `${startedCount} contas enviadas para início.` });
});
apiRouter.post('/bulk-stop', (req, res) => {
    const { usernames } = req.body;
    if (!usernames || !Array.isArray(usernames)) return res.status(400).json({ message: "Requisição inválida." });
    let stoppedCount = 0;
    usernames.forEach(username => {
        const account = liveAccounts[username];
        if (account && account.worker && account.ownerUserID === req.session.userId) {
            if(account.startupTimeout) { clearTimeout(account.startupTimeout); account.startupTimeout = null; }
            account.manual_logout = true;
            account.worker.kill();
            account.status = "Parado";
            account.sessionStartTime = null; 
            stoppedCount++;
        }
    });
    res.status(200).json({ message: `${stoppedCount} contas paradas.` });
});
apiRouter.post('/bulk-remove', async (req, res) => {
    const { usernames } = req.body;
    if (!usernames || !Array.isArray(usernames)) return res.status(400).json({ message: "Requisição inválida." });
    const currentUserID = req.session.userId;
    usernames.forEach(username => {
        const account = liveAccounts[username];
        if (account && account.ownerUserID === currentUserID) {
            if (account.worker) {
                account.manual_logout = true;
                account.worker.kill();
            }
            delete liveAccounts[username];
        }
    });
    await accountsCollection.deleteMany({ username: { $in: usernames }, ownerUserID: currentUserID });
    res.status(200).json({ message: `${usernames.length} contas removidas.` });
});

// Rota /add-account (Sem alterações)
apiRouter.post('/add-account', async (req, res) => { 
    const { username, password } = req.body; 
    const currentUserID = req.session.userId;
    if (!username || !password) return res.status(400).json({ message: "Usuário e senha são obrigatórios."}); 

    const user = await usersCollection.findOne({ _id: new ObjectId(currentUserID) });
    const userAccountsCount = await accountsCollection.countDocuments({ ownerUserID: currentUserID });
    
    // (Vamos ajustar os limites exatos dos planos mais tarde)
    if (user.plan === 'free' && userAccountsCount >= 1) {
        return res.status(403).json({ message: "Seu plano gratuito permite apenas 1 conta Steam. Faça upgrade para adicionar mais." });
    }

    const existing = await accountsCollection.findOne({ username }); 
    if (existing) return res.status(400).json({ message: "Esta conta Steam já está a ser usada por outro usuário." }); 

    const encryptedPassword = encrypt(password); 
    if (!encryptedPassword) { return res.status(500).json({ message: "Falha ao encriptar senha ao adicionar conta."}); } 
    
    const newAccountData = { 
        username, 
        password: encryptedPassword, 
        games: [730], 
        settings: {}, 
        sentryFileHash: null,
        ownerUserID: currentUserID 
    }; 
    
    await accountsCollection.insertOne(newAccountData); 
    liveAccounts[username] = { ...newAccountData, encryptedPassword: newAccountData.password, status: 'Parado', worker: null }; 
    res.status(200).json({ message: "Conta adicionada." }); 
});

// Rotas /remove-account, /submit-guard, /save-settings, /set-games, /search-game (Sem alterações)
apiRouter.delete('/remove-account/:username', async (req, res) => { 
    const account = liveAccounts[req.params.username]; 
    const currentUserID = req.session.userId;
    if (account && account.ownerUserID === currentUserID) { 
        if (account.worker) { account.manual_logout = true; account.worker.kill(); } 
        delete liveAccounts[req.params.username]; 
        await accountsCollection.deleteOne({ username: req.params.username, ownerUserID: currentUserID }); 
        res.status(200).json({ message: "Conta removida." }); 
    } else { 
        const result = await accountsCollection.deleteOne({ username: req.params.username, ownerUserID: currentUserID });
        if (result.deletedCount > 0) {
            res.status(200).json({ message: "Conta removida." });
        } else {
            res.status(404).json({ message: "Conta não encontrada." });
        }
    } 
});
apiRouter.post('/submit-guard/:username', (req, res) => { 
    const account = liveAccounts[req.params.username]; 
    if (account && account.ownerUserID === req.session.userId && account.worker) { 
        account.worker.send({ command: 'submitGuard', data: { code: req.body.code } }); 
        res.status(200).json({ message: "Código enviado ao worker." }); 
    } else { res.status(404).json({ message: "Conta ou worker não encontrado." }); } 
});
apiRouter.post('/save-settings/:username', async (req, res) => {
    const { username } = req.params;
    const { settings, newPassword } = req.body; 
    const account = liveAccounts[username];
    const currentUserID = req.session.userId;
    if (!account || account.ownerUserID !== currentUserID) {
        const dbAccount = await accountsCollection.findOne({ username: username, ownerUserID: currentUserID });
        if (!dbAccount) {
            return res.status(404).json({ message: "Conta não encontrada." });
        }
        if (!account) liveAccounts[username] = dbAccount;
    }
    let message = "Configurações salvas.";
    if (settings) {
        await accountsCollection.updateOne({ username, ownerUserID: currentUserID }, { $set: { settings } }); 
        liveAccounts[username].settings = settings;
        if (liveAccounts[username].worker) {
            try { liveAccounts[username].worker.send({ command: 'updateSettings', data: { settings, games: liveAccounts[username].games } }); } 
            catch (ipcError) { console.error(`[GESTOR] Falha ao enviar 'updateSettings' para ${username}:`, ipcError.message); }
        }
    }
    if (newPassword) {
        const encryptedPassword = encrypt(newPassword);
        if (!encryptedPassword) { return res.status(500).json({ message: "Falha ao encriptar nova senha." }); }
        await accountsCollection.updateOne({ username, ownerUserID: currentUserID }, { $set: { password: encryptedPassword } }); 
        liveAccounts[username].encryptedPassword = encryptedPassword;
        message = "Configurações e senha atualizadas.";
        if (liveAccounts[username].worker) {
            liveAccounts[username].manual_logout = true; 
            liveAccounts[username].worker.kill();
            liveAccounts[username].status = "Parado";
            liveAccounts[username].sessionStartTime = null; 
            message += " A conta foi parada para aplicar a nova senha.";
            setTimeout(() => { if (liveAccounts[username]) { liveAccounts[username].manual_logout = false; } }, 1000);
        }
    }
    res.status(200).json({ message });
});
apiRouter.post('/set-games/:username', async (req, res) => { 
    const { username } = req.params; 
    const { games } = req.body; 
    const account = liveAccounts[username]; 
    const currentUserID = req.session.userId;
    const user = await usersCollection.findOne({ _id: new ObjectId(currentUserID) });
    let gameLimit = 2; // Limite 'free'
    if (user.plan === 'premium') gameLimit = 24; 
    if (user.plan === 'lifetime') gameLimit = 33; 
    
    if (games.length > gameLimit) {
        return res.status(403).json({ message: `Seu plano (${user.plan}) permite um máximo de ${gameLimit} jogos.`});
    }
    if (account && account.ownerUserID === currentUserID) { 
        await accountsCollection.updateOne({ username, ownerUserID: currentUserID }, { $set: { games } }); 
        account.games = games; 
        if (account.worker) { 
            try { account.worker.send({ command: 'updateSettings', data: { settings: account.settings, games } }); } 
            catch (ipcError) { console.error(`[GESTOR] Falha ao enviar 'set-games' para ${username}:`, ipcError.message); }
        } 
        res.status(200).json({ message: "Jogos atualizados." }); 
    } else { 
        res.status(404).json({ message: "Conta não encontrada." }); 
    } 
});
apiRouter.get('/search-game', async (req, res) => {
    const searchTerm = req.query.q ? req.query.q.toLowerCase() : '';
    if (searchTerm.length < 2) { return res.json([]); }
    try {
        const appList = await getSteamAppList();
        const results = appList.filter(app => app.name.toLowerCase().includes(searchTerm)).slice(0, 50);
        res.json(results);
    } catch (e) { res.status(500).json({ message: "Erro ao buscar lista de jogos." }); }
});

app.use('/api', apiRouter);

// --- *** NOVO: LÓGICA DE DESCONTO DE TEMPO *** ---
const TIME_DEDUCTION_INTERVAL = 5 * 60 * 1000; // 5 minutos

async function deductFreeTime() {
    console.log("[GESTOR DE TEMPO] A verificar contas 'free' ativas...");
    const activeUserIDs = new Set();

    // 1. Encontra todos os usuários 'free' que estão com contas ativas
    for (const username in liveAccounts) {
        const account = liveAccounts[username];
        if (account.status === "Rodando") {
            activeUserIDs.add(account.ownerUserID);
        }
    }

    if (activeUserIDs.size === 0) {
        console.log("[GESTOR DE TEMPO] Nenhuma conta 'free' ativa encontrada.");
        return;
    }

    // 2. Desconta o tempo desses usuários no MongoDB
    const usersToUpdate = Array.from(activeUserIDs).map(id => new ObjectId(id));
    
    try {
        const updateResult = await usersCollection.updateMany(
            { _id: { $in: usersToUpdate }, plan: 'free', freeHoursRemaining: { $gt: 0 } },
            { $inc: { freeHoursRemaining: -TIME_DEDUCTION_INTERVAL } }
        );

        if (updateResult.modifiedCount > 0) {
            console.log(`[GESTOR DE TEMPO] Descontado tempo de ${updateResult.modifiedCount} usuários 'free'.`);
        }

        // 3. Verifica se algum usuário ficou sem tempo
        const usersOutOfTime = await usersCollection.find(
            { _id: { $in: usersToUpdate }, plan: 'free', freeHoursRemaining: { $lte: 0 } }
        ).toArray();

        for (const user of usersOutOfTime) {
            console.log(`[GESTOR DE TEMPO] Usuário ${user.username} (${user._id}) ficou sem tempo. A parar contas...`);
            
            // Para todas as contas ativas desse usuário
            for (const username in liveAccounts) {
                const account = liveAccounts[username];
                if (account.ownerUserID === user._id.toString() && account.worker) {
                    console.log(`[GESTOR DE TEMPO] A parar ${username} por falta de tempo.`);
                    account.status = "Tempo Esgotado";
                    account.manual_logout = true; // Impede reinício automático
                    account.worker.kill();
                }
            }
        }

    } catch (e) {
        console.error("[GESTOR DE TEMPO] Erro ao descontar tempo:", e);
    }
}

// --- INICIALIZAÇÃO DO SERVIDOR ---
async function startServer() {
    await connectToDB();
    await initializeMasterKey();
    await loadAccountsIntoMemory(); 
    
    // Inicia o relógio de desconto de tempo
    setInterval(deductFreeTime, TIME_DEDUCTION_INTERVAL);
    console.log(`[GESTOR DE TEMPO] Relógio de desconto de horas iniciado (a cada ${TIME_DEDUCTION_INTERVAL / 60000} minutos).`);

    app.listen(PORT, () => console.log(`[GESTOR] Servidor SaaS iniciado na porta ${PORT}`));
}
startServer();
