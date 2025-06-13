const express = require('express');
const path = require('path');
const session = require('express-session');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const SteamUser = require('steam-user');

// --- CONFIGURAÇÃO ---
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const APP_SECRET = process.env.APP_SECRET;
const SITE_PASSWORD = process.env.SITE_PASSWORD;

if (!MONGODB_URI || !APP_SECRET || !SITE_PASSWORD) {
    console.error("ERRO CRÍTICO: As variáveis de ambiente MONGODB_URI, APP_SECRET e SITE_PASSWORD precisam de ser definidas!");
    process.exit(1);
}

// --- CRIPTOGRAFIA ---
const ALGORITHM = 'aes-256-cbc';
const key = crypto.createHash('sha256').update(String(APP_SECRET)).digest('base64').substr(0, 32);

const encrypt = (text) => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
};

const decrypt = (text) => {
    try {
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (error) {
        console.error("Erro ao descodificar a senha. Verifique se a APP_SECRET mudou ou se os dados estão corrompidos.");
        return "";
    }
};

// --- LÓGICA DO BANCO DE DADOS E SESSÃO ---
const mongoClient = new MongoClient(MONGODB_URI);
let accountsCollection;
let siteSettingsCollection;
let liveAccounts = {}; 

async function connectToDB() {
    try {
        await mongoClient.connect();
        console.log("Conectado ao MongoDB Atlas com sucesso!");
        const db = mongoClient.db("stf_boost_db");
        accountsCollection = db.collection("accounts");
        siteSettingsCollection = db.collection("site_settings");
    } catch (e) {
        console.error("Não foi possível conectar ao MongoDB", e);
        process.exit(1);
    }
}

app.use(session({
    secret: APP_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production', // Use 'auto' no Render ou true se tiver HTTPS
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // Sessão de 24 horas
    }
}));

// --- MIDDLEWARE DE AUTENTICAÇÃO ---
const isAuthenticated = (req, res, next) => {
    if (req.session.isLoggedIn) {
        return next();
    }
    res.redirect('/login');
};

// --- GESTÃO DE CONTAS ---
function applyLiveSettings(account) {
    if (account.status !== "Rodando") return;
    const personaState = account.settings.appearOffline ? SteamUser.EPersonaState.Offline : SteamUser.EPersonaState.Online;
    account.client.setPersona(personaState);
    let gamesToPlay = account.settings.customInGameTitle ? [{ game_id: 0, game_extra_info: account.settings.customInGameTitle }] : [...account.games];
    if (gamesToPlay.length > 0) {
        account.client.gamesPlayed(gamesToPlay);
    }
}

function setupListenersForAccount(account) {
    account.client.on('loggedOn', () => { console.log(`[${account.username}] Login OK!`); account.status = "Rodando"; account.sessionStartTime = Date.now(); applyLiveSettings(account); });
    account.client.on('steamGuard', (domain, callback) => { console.log(`[${account.username}] Steam Guard solicitado.`); account.status = "Pendente: Steam Guard"; account.steamGuardCallback = callback; });
    account.client.on('disconnected', (eresult, msg) => { console.log(`[${account.username}] Desconectado: ${msg}`); account.status = "Parado"; account.sessionStartTime = null; });
    account.client.on('error', (err) => { console.log(`[${account.username}] Erro: ${err.message || err.eresult}`); account.status = "Erro"; account.sessionStartTime = null; });
    account.client.on('friendRelationship', (steamID, relationship) => { if (relationship === SteamUser.EFriendRelationship.RequestRecipient && account.settings.autoAcceptFriends) { account.client.addFriend(steamID); } });
    account.client.on('friendMessage', (sender, message) => { if (account.settings.customAwayMessage) { account.client.chatMessage(sender, account.settings.customAwayMessage); } });
}

async function loadAccountsIntoMemory() {
    const defaultSettings = { customInGameTitle: '', customAwayMessage: '', appearOffline: false, autoAcceptFriends: false };
    const savedAccounts = await accountsCollection.find({}).toArray();
    for (const acc of savedAccounts) {
        liveAccounts[acc.username] = {
            username: acc.username,
            password: decrypt(acc.password),
            games: acc.games || [730],
            settings: { ...defaultSettings, ...(acc.settings || {}) },
            status: 'Parado',
            client: new SteamUser(),
            sessionStartTime: null,
            steamGuardCallback: null
        };
        setupListenersForAccount(liveAccounts[acc.username]);
    }
    console.log(`${Object.keys(liveAccounts).length} contas carregadas na memória.`);
}

// --- API ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- ROTAS PÚBLICAS (LOGIN) ---
app.get('/login', (req, res) => {
    if (req.session.isLoggedIn) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', async (req, res) => {
    let settings = await siteSettingsCollection.findOne({ _id: 'config' });
    const submittedPass = req.body.password;
    if (settings && submittedPass && decrypt(settings.sitePassword) === submittedPass) {
        req.session.isLoggedIn = true;
        res.redirect('/');
    } else {
        res.redirect('/login');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            return res.redirect('/');
        }
        res.clearCookie('connect.sid');
        res.redirect('/login');
    });
});

// --- ROTAS PROTEGIDAS ---
app.use(isAuthenticated);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/status', (req, res) => {
    const publicState = { accounts: {} };
    for (const username in liveAccounts) {
        const acc = liveAccounts[username];
        publicState.accounts[username] = { username: acc.username, status: acc.status, games: acc.games, uptime: acc.sessionStartTime ? Date.now() - acc.sessionStartTime : 0, settings: acc.settings };
    }
    res.json(publicState);
});

app.post('/add-account', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: "Usuário e senha são obrigatórios."});
    const existing = await accountsCollection.findOne({ username });
    if (existing) return res.status(400).json({ message: "Conta já existe." });
    const newAccountData = { username, password: encrypt(password), games: [730], settings: { customInGameTitle: 'STF Boost', customAwayMessage: '', appearOffline: false, autoAcceptFriends: false } };
    await accountsCollection.insertOne(newAccountData);
    liveAccounts[username] = { ...newAccountData, password: password, status: 'Parado', client: new SteamUser(), sessionStartTime: null, steamGuardCallback: null };
    setupListenersForAccount(liveAccounts[username]);
    res.status(200).json({ message: "Conta adicionada com sucesso." });
});

app.delete('/remove-account/:username', async (req, res) => {
    const { username } = req.params;
    const account = liveAccounts[username];
    if (account) {
        if (account.status === "Rodando") account.client.logOff();
        delete liveAccounts[username];
        await accountsCollection.deleteOne({ username });
        res.status(200).json({ message: "Conta removida com sucesso." });
    } else { res.status(404).json({ message: "Conta não encontrada." }); }
});

app.post('/start/:username', (req, res) => {
    const account = liveAccounts[req.params.username];
    if (account) {
        account.status = "Iniciando...";
        account.client.logOn({ accountName: account.username, password: account.password });
        res.status(200).json({ message: "Iniciando..." });
    } else { res.status(404).json({ message: "Conta não encontrada." }); }
});

app.post('/stop/:username', (req, res) => {
    const account = liveAccounts[req.params.username];
    if (account) {
        account.status = "Parando...";
        account.client.logOff();
        res.status(200).json({ message: "Parando..." });
    } else { res.status(404).json({ message: "Conta não encontrada." }); }
});

app.post('/submit-guard/:username', (req, res) => {
    const account = liveAccounts[req.params.username];
    if (account && account.steamGuardCallback) {
        account.steamGuardCallback(req.body.code);
        account.steamGuardCallback = null;
        res.status(200).json({ message: "Código enviado." });
    } else { res.status(400).json({ message: "Pedido de Steam Guard não estava ativo." }); }
});

app.post('/set-games/:username', async (req, res) => {
    const { games } = req.body;
    const { username } = req.params;
    const account = liveAccounts[username];
    if (account && games && Array.isArray(games)) {
        account.games = games;
        await accountsCollection.updateOne({ username }, { $set: { games: games } });
        applyLiveSettings(account);
        res.status(200).json({ message: `Jogos atualizados.` });
    } else { res.status(400).json({ message: 'Conta ou formato de jogos inválido.' }); }
});

app.post('/save-settings/:username', async (req, res) => {
    const { username } = req.params;
    const newSettings = req.body.settings;
    const account = liveAccounts[username];
    if (account && newSettings) {
        account.settings = newSettings;
        await accountsCollection.updateOne({ username }, { $set: { settings: newSettings } });
        applyLiveSettings(account);
        res.status(200).json({ message: "Configurações salvas!" });
    } else { res.status(404).json({ message: "Conta não encontrada." }); }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
async function startServer() {
    await connectToDB();
    let settings = await siteSettingsCollection.findOne({ _id: 'config' });
    if (!settings) {
        console.log("Nenhuma senha de site encontrada. A configurar a partir de SITE_PASSWORD...");
        await siteSettingsCollection.insertOne({ _id: 'config', sitePassword: encrypt(SITE_PASSWORD) });
        console.log("Senha do site configurada com sucesso!");
    }
    await loadAccountsIntoMemory();
    app.listen(PORT, () => console.log(`Servidor iniciado na porta ${PORT}`));
}

startServer();
