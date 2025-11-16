const express = require('express');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const { fork } = require('child_process');
const https = require('https');
const bcrypt = require('bcryptjs'); // Nova dependência para encriptar senhas de usuário

// --- CONFIGURAÇÃO ---
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
// O SITE_PASSWORD não é mais usado para login, mas podemos mantê-lo para um futuro painel admin
const ADMIN_PASSWORD = process.env.SITE_PASSWORD; 
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL; 

if (!MONGODB_URI) { console.error("ERRO CRÍTICO: A variável de ambiente MONGODB_URI precisa de ser definida!"); process.exit(1); }
const ALGORITHM = 'aes-256-cbc';
let appSecretKey; 
let steamAppListCache = { data: [], timestamp: 0 }; 

// --- FUNÇÃO DE NOTIFICAÇÃO DISCORD ---
// (Sem alterações, continua igual)
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

// --- FUNÇÕES DE CRIPTOGRAFIA ---
// (Sem alterações, continua igual para as senhas da Steam)
const encrypt = (text) => { if (!appSecretKey) { console.error("[ENCRIPTAR] ERRO CRÍTICO: appSecretKey não está definida!"); return null; } const iv = crypto.randomBytes(16); const cipher = crypto.createCipheriv(ALGORITHM, appSecretKey, iv); let encrypted = cipher.update(text, 'utf8', 'hex'); encrypted += cipher.final('hex'); return `${iv.toString('hex')}:${encrypted}`; };
const decrypt = (text) => { try { if (!appSecretKey) { return ""; } if (!text) { return ""; } const textParts = text.split(':'); const iv = Buffer.from(textParts.shift(), 'hex'); const encryptedText = Buffer.from(textParts.join(':'), 'hex'); const decipher = crypto.createDecipheriv(ALGORITHM, appSecretKey, iv); let decrypted = decipher.update(encryptedText, 'hex', 'utf8'); decrypted += decipher.final('utf8'); return decrypted; } catch (error) { console.error("[DESENCRIPTAR] Falha crítica na função de desencriptar:", error); return ""; }};

// --- GESTÃO DE CONTAS E BANCO DE DADOS ---
const mongoClient = new MongoClient(MONGODB_URI);
let accountsCollection;
let siteSettingsCollection;
let usersCollection; // NOVA COLEÇÃO: Para guardar usuários do site
let liveAccounts = {};

async function connectToDB() { 
    try { 
        await mongoClient.connect(); 
        console.log("Conectado ao MongoDB Atlas com sucesso!"); 
        const db = mongoClient.db("stf-saas-db"); // Nome da nova base de dados
        
        // Coleção para as contas Steam (como antes)
        accountsCollection = db.collection("accounts");
        // Coleção para configurações do site (como antes)
        siteSettingsCollection = db.collection("site_settings");
        // NOVA COLEÇÃO
        usersCollection = db.collection("users"); 
        // Criar um índice único para usernames e emails para evitar duplicados
        await usersCollection.createIndex({ username: 1 }, { unique: true });
        await usersCollection.createIndex({ email: 1 }, { unique: true });

    } catch (e) { 
        console.error("Não foi possível conectar ao MongoDB", e); 
        process.exit(1); 
    } 
}

async function initializeMasterKey() {
    let settings = await siteSettingsCollection.findOne({ _id: 'config' });
    if (!settings || !settings.appSecret) {
        console.log("[GESTOR] Nenhuma chave mestra encontrada. A gerar uma nova...");
        const newSecret = crypto.randomBytes(32).toString('hex');
        appSecretKey = crypto.createHash('sha256').update(newSecret).digest('base64').substr(0, 32);
        // Não vamos mais guardar a senha do site aqui, mas sim a chave secreta
        await siteSettingsCollection.updateOne( { _id: 'config' }, { $set: { appSecret: newSecret } }, { upsert: true } );
        console.log("[GESTOR] Nova chave mestra gerada e guardada na base de dados.");
    } else {
        console.log("[GESTOR] Chave mestra carregada da base de dados.");
        appSecretKey = crypto.createHash('sha256').update(settings.appSecret).digest('base64').substr(0, 32);
    }
}

// --- BUSCA DE JOGOS (COM STEAMSPY) ---
// (Sem alterações, continua igual)
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
// (Sem alterações por agora, mas no Passo 2, teremos que filtrar por ownerUserID)
function startWorkerForAccount(accountData) {
    const username = accountData.username;
    console.log(`[GESTOR] A iniciar worker para ${username}`);
    if (liveAccounts[username] && liveAccounts[username].worker) { liveAccounts[username].worker.kill(); }
    if (liveAccounts[username] && liveAccounts[username].startupTimeout) { clearTimeout(liveAccounts[username].startupTimeout); }
    const worker = fork(path.join(__dirname, 'worker.js'));
    liveAccounts[username].worker = worker;
    liveAccounts[username].status = "Iniciando...";
    liveAccounts[username].manual_logout = false;
    liveAccounts[username].timed_out = false; 
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
                accountsCollection.updateOne({ username }, { $set: { sentryFileHash: payload.sentryFileHash } });
            }
        }
    });
    worker.on('exit', (code) => {
        if (liveAccounts[username] && liveAccounts[username].startupTimeout) { clearTimeout(liveAccounts[username].startupTimeout); liveAccounts[username].startupTimeout = null; }
        const accountExited = liveAccounts[username];
        if (!accountExited) return;
        const wasTimeout = accountExited.timed_out;
        accountExited.timed_out = false; 
        console.log(`[GESTOR] Worker para ${username} saiu com código ${code}.`);
        if (accountExited.manual_logout === false && accountExited.settings.autoRelogin === true) {
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
        } else {
            accountExited.status = wasTimeout ? "Erro: Timeout" : "Parado";
            accountExited.sessionStartTime = null;
        }
    });
    worker.on('error', (err) => {
        console.error(`[GESTOR] Erro no canal de comunicação do worker ${username}:`, err.message);
    });
}

// (Sem alterações, continua igual)
async function loadAccountsIntoMemory() {
    // IMPORTANTE: No Passo 2, esta função terá de ser modificada para
    // carregar apenas contas de usuários que estão ativamente logados,
    // ou talvez apenas contas com `autoRelogin=true`.
    // Por agora, deixamos como está, mas ela vai carregar TODAS as contas de
    // TODOS os usuários, o que pode ser um problema de escala (e segurança).
    // No momento, vamos focar no login.

    const defaultSettings = { customInGameTitle: '', customAwayMessage: '', appearOffline: false, autoAcceptFriends: false, autoRelogin: true, sharedSecret: '' };
    const savedAccounts = await accountsCollection.find({ "settings.autoRelogin": true }).toArray(); // Apenas carrega contas com auto-relogin
    savedAccounts.forEach((acc, index) => {
        liveAccounts[acc.username] = { username: acc.username, encryptedPassword: acc.password, games: acc.games || [730], settings: { ...defaultSettings, ...(acc.settings || {}) }, sentryFileHash: acc.sentryFileHash || null, status: 'Parado', worker: null, sessionStartTime: null, manual_logout: false };
        
        // Vamos manter o delay para não sobrecarregar a Steam
        const delay = index * 15000;
        console.log(`[GESTOR] Worker para ${acc.username} (de ${acc.ownerUserID}) agendado para iniciar em ${delay / 1000}s.`);
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
app.use(express.json()); 
app.use(express.urlencoded({ extended: true })); 
app.use(session({ 
    secret: 'uma-nova-chave-secreta-para-sessoes-saas', // Mude isto para algo aleatório
    resave: false, 
    saveUninitialized: false, 
    store: MongoStore.create({ mongoUrl: MONGODB_URI, dbName: 'stf-saas-db' }), 
    cookie: { secure: 'auto', httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
})); 

// --- NOVO MIDDLEWARE DE AUTENTICAÇÃO ---
const isAuthenticated = (req, res, next) => { 
    if (req.session.userId) { 
        return next(); 
    } 
    res.redirect('/login?error=unauthorized'); 
};

// --- NOVAS ROTAS DE PÁGINAS ---
// Rota principal (Landing Page) - não precisa de login
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Página de Login - não precisa de login
app.get('/login', (req, res) => {
    if (req.session.userId) { return res.redirect('/dashboard'); } // Se já logado, vai para o painel
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Página de Registo - não precisa de login
app.get('/register', (req, res) => {
    if (req.session.userId) { return res.redirect('/dashboard'); } // Se já logado, vai para o painel
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Página do Dashboard (o seu painel antigo) - PRECISA de login
app.get('/dashboard', isAuthenticated, (req, res) => {
    // O nome deste arquivo foi o que você RENOMEOU
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html')); 
});

// --- ROTAS ESTÁTICAS ---
// Serve arquivos como style.css, logo.png, etc.
app.use(express.static(path.join(__dirname, 'public'))); 
app.get('/health', (req, res) => { res.status(200).send('OK'); }); 

// --- NOVAS ROTAS DE API (Autenticação) ---
const apiRouter = express.Router();

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
            plan: 'free', // Começa como 'free'
            freeHoursRemaining: 50 * 60 * 60 * 1000, // 50 horas em milissegundos
            createdAt: new Date()
        });
        res.status(201).json({ message: "Usuário registado com sucesso!" });
    } catch (error) {
        if (error.code === 11000) { // Erro de duplicado
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
        // Login bem-sucedido!
        req.session.userId = user._id.toString(); // Guarda o ID na sessão
        req.session.username = user.username;
        res.status(200).json({ message: "Login bem-sucedido!" });
    } catch (error) {
        console.error("Erro no login:", error);
        res.status(500).json({ message: "Erro interno ao fazer login." });
    }
});

apiRouter.get('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ message: "Não foi possível fazer logout." });
        }
        res.redirect('/'); // Redireciona para a Landing Page
    });
});

// --- API ANTIGA (Agora protegida e precisa de FILTROS) ---
// Este middleware aplica 'isAuthenticated' a todas as rotas de API abaixo
apiRouter.use(isAuthenticated); 

apiRouter.get('/status', (req, res) => {
    // **** PASSO 2 (Futuro): Filtrar `liveAccounts` por `ownerUserID` ****
    // Por enquanto, isto vai mostrar contas de TODOS os usuários. Não é seguro!
    // Mas vamos focar em fazer o login funcionar primeiro.
    const publicState = { accounts: {} };
    for (const username in liveAccounts) {
        const acc = liveAccounts[username];
        // **** PASSO 2 (Futuro): Adicionar if (acc.ownerUserID === req.session.userId) ****
        const publicData = {
            username: acc.username,
            status: acc.status,
            games: acc.games,
            settings: acc.settings,
            uptime: acc.sessionStartTime ? Date.now() - acc.sessionStartTime : 0
        };
        publicState.accounts[username] = publicData;
    }
    res.json(publicState);
});

apiRouter.post('/start/:username', (req, res) => { 
    // **** PASSO 2 (Futuro): Verificar se o usuário é dono desta conta ****
    const account = liveAccounts[req.params.username]; 
    if (account) { 
        const accountData = { ...account, password: decrypt(account.encryptedPassword) }; 
        if (accountData.password) { startWorkerForAccount(accountData); res.status(200).json({ message: "Iniciando worker..." }); } 
        else { res.status(500).json({ message: "Erro ao desencriptar senha."}); } 
    } else { res.status(404).json({ message: "Conta não encontrada." }); } 
});

apiRouter.post('/stop/:username', (req, res) => {
    // **** PASSO 2 (Futuro): Verificar se o usuário é dono desta conta ****
    const account = liveAccounts[req.params.username];
    if (account && account.worker) {
        if(account.startupTimeout) { clearTimeout(account.startupTimeout); account.startupTimeout = null; }
        account.manual_logout = true;
        account.worker.kill();
        account.status = "Parado";
        account.sessionStartTime = null; 
        res.status(200).json({ message: "Parando worker..." });
    } else { res.status(404).json({ message: "Conta ou worker não encontrado." }); }
});

// (As rotas de Ações em Massa /bulk-xxx foram removidas por enquanto para simplificar o Passo 1)
// (Vamos re-adicioná-las no Passo 2)

apiRouter.post('/add-account', async (req, res) => { 
    const { username, password } = req.body; 
    if (!username || !password) return res.status(400).json({ message: "Usuário e senha são obrigatórios."}); 
    
    // **** PASSO 2 (Futuro): Verificar limite do plano (ex: 1 conta para free) ****

    const existing = await accountsCollection.findOne({ username }); 
    if (existing) return res.status(400).json({ message: "Esta conta Steam já está a ser usada." }); 

    const encryptedPassword = encrypt(password); 
    if (!encryptedPassword) { return res.status(500).json({ message: "Falha ao encriptar senha ao adicionar conta."}); } 
    
    const newAccountData = { 
        username, 
        password: encryptedPassword, 
        games: [730], 
        settings: {}, 
        sentryFileHash: null,
        ownerUserID: req.session.userId // <- LIGA A CONTA AO USUÁRIO
    }; 
    
    await accountsCollection.insertOne(newAccountData); 
    liveAccounts[username] = { ...newAccountData, encryptedPassword: newAccountData.password, status: 'Parado', worker: null }; 
    res.status(200).json({ message: "Conta adicionada." }); 
});

apiRouter.delete('/remove-account/:username', async (req, res) => { 
    // **** PASSO 2 (Futuro): Verificar se o usuário é dono desta conta ****
    const account = liveAccounts[req.params.username]; 
    if (account) { 
        if (account.worker) { account.manual_logout = true; account.worker.kill(); } 
        delete liveAccounts[req.params.username]; 
        await accountsCollection.deleteOne({ username: req.params.username, ownerUserID: req.session.userId }); // Segurança
        res.status(200).json({ message: "Conta removida." }); 
    } else { res.status(404).json({ message: "Conta não encontrada." }); } 
});

apiRouter.post('/submit-guard/:username', (req, res) => { 
    // **** PASSO 2 (Futuro): Verificar se o usuário é dono desta conta ****
    const account = liveAccounts[req.params.username]; 
    if (account && account.worker) { 
        account.worker.send({ command: 'submitGuard', data: { code: req.body.code } }); 
        res.status(200).json({ message: "Código enviado ao worker." }); 
    } else { res.status(404).json({ message: "Conta ou worker não encontrado." }); } 
});

apiRouter.post('/save-settings/:username', async (req, res) => {
    // **** PASSO 2 (Futuro): Verificar se o usuário é dono desta conta ****
    const { username } = req.params;
    const { settings, newPassword } = req.body; 
    const account = liveAccounts[username];
    if (!account) return res.status(404).json({ message: "Conta não encontrada." });
    let message = "Configurações salvas.";
    if (settings) {
        await accountsCollection.updateOne({ username, ownerUserID: req.session.userId }, { $set: { settings } }); // Segurança
        account.settings = settings;
        if (account.worker) {
            try { account.worker.send({ command: 'updateSettings', data: { settings, games: account.games } }); } 
            catch (ipcError) { console.error(`[GESTOR] Falha ao enviar 'updateSettings' para ${username}:`, ipcError.message); }
        }
    }
    if (newPassword) {
        const encryptedPassword = encrypt(newPassword);
        if (!encryptedPassword) { return res.status(500).json({ message: "Falha ao encriptar nova senha." }); }
        await accountsCollection.updateOne({ username, ownerUserID: req.session.userId }, { $set: { password: encryptedPassword } }); // Segurança
        account.encryptedPassword = encryptedPassword;
        message = "Configurações e senha atualizadas.";
        if (account.worker) {
            account.manual_logout = true; 
            account.worker.kill();
            account.status = "Parado";
            account.sessionStartTime = null; 
            message += " A conta foi parada para aplicar a nova senha.";
            setTimeout(() => { if (liveAccounts[username]) { liveAccounts[username].manual_logout = false; } }, 1000);
        }
    }
    res.status(200).json({ message });
});

apiRouter.post('/set-games/:username', async (req, res) => { 
    // **** PASSO 2 (Futuro): Verificar se o usuário é dono desta conta ****
    const { username } = req.params; 
    const { games } = req.body; 
    const account = liveAccounts[username]; 
    if (account && games) { 
        // **** PASSO 2 (Futuro): Verificar limite de jogos do plano ****
        await accountsCollection.updateOne({ username, ownerUserID: req.session.userId }, { $set: { games } }); // Segurança
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
    // (Sem alterações, esta rota é segura)
    const searchTerm = req.query.q ? req.query.q.toLowerCase() : '';
    if (searchTerm.length < 2) { return res.json([]); }
    try {
        const appList = await getSteamAppList();
        const results = appList.filter(app => app.name.toLowerCase().includes(searchTerm)).slice(0, 50);
        res.json(results);
    } catch (e) { res.status(500).json({ message: "Erro ao buscar lista de jogos." }); }
});

// Monta o router de API no prefixo /api
app.use('/api', apiRouter);

// --- INICIALIZAÇÃO DO SERVIDOR ---
async function startServer() {
    await connectToDB();
    await initializeMasterKey();
    await loadAccountsIntoMemory(); // Carrega contas com auto-relogin
    app.listen(PORT, () => console.log(`[GESTOR] Servidor SaaS iniciado na porta ${PORT}`));
}
startServer();
