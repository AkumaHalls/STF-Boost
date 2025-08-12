const express = require('express');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const SteamUser = require('steam-user');

// --- CONFIGURAÇÃO E CRIPTOGRAFIA ---
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const APP_SECRET = process.env.APP_SECRET;
const SITE_PASSWORD = process.env.SITE_PASSWORD;
if (!MONGODB_URI || !APP_SECRET || !SITE_PASSWORD) { console.error("ERRO CRÍTICO: As variáveis de ambiente MONGODB_URI, APP_SECRET e SITE_PASSWORD precisam de ser definidas!"); process.exit(1); }
const ALGORITHM = 'aes-256-cbc';
const key = crypto.createHash('sha256').update(String(APP_SECRET)).digest('base64').substr(0, 32);
const encrypt = (text) => { const iv = crypto.randomBytes(16); const cipher = crypto.createCipheriv(ALGORITHM, key, iv); let encrypted = cipher.update(text, 'utf8', 'hex'); encrypted += cipher.final('hex'); return `${iv.toString('hex')}:${encrypted}`; };
const decrypt = (text) => { try { const textParts = text.split(':'); const iv = Buffer.from(textParts.shift(), 'hex'); const encryptedText = Buffer.from(textParts.join(':'), 'hex'); const decipher = crypto.createDecipheriv(ALGORITHM, key, iv); let decrypted = decipher.update(encryptedText, 'hex', 'utf8'); decrypted += decipher.final('utf8'); return decrypted; } catch (error) { return ""; }};

// --- LÓGICA DO BANCO DE DADOS E GESTÃO DE CONTAS ---
const mongoClient = new MongoClient(MONGODB_URI);
let accountsCollection;
let siteSettingsCollection;
let liveAccounts = {}; 
async function connectToDB() { try { await mongoClient.connect(); console.log("Conectado ao MongoDB Atlas com sucesso!"); const db = mongoClient.db("stf_boost_db"); accountsCollection = db.collection("accounts"); siteSettingsCollection = db.collection("site_settings"); } catch (e) { console.error("Não foi possível conectar ao MongoDB", e); process.exit(1); } }

function applyLiveSettings(account) {
    if (account.status !== "Rodando") return;
    console.log(`[${account.username}] Executando applyLiveSettings...`);
    const personaState = account.settings.appearOffline ? SteamUser.EPersonaState.Offline : SteamUser.EPersonaState.Online;
    account.client.setPersona(personaState);
    let gamesToPlay = account.settings.customInGameTitle ? [{ game_id: 0, game_extra_info: account.settings.customInGameTitle }] : [...account.games];
    if (gamesToPlay.length > 0) {
        account.client.gamesPlayed(gamesToPlay);
        console.log(`[${account.username}] Comando gamesPlayed enviado.`);
    }
}

function scheduleReconnect(account) {
    if (!account.settings.autoRelogin || account.manual_logout) {
        account.status = "Parado";
        if(account.manual_logout) console.log(`[${account.username}] Desconexão manual confirmada.`);
        account.manual_logout = false;
        return;
    }
    account.reconnect_attempts = (account.reconnect_attempts || 0) + 1;
    const delay = Math.min(Math.pow(2, account.reconnect_attempts - 1) * 30000, 1800000);
    const delayInMinutes = Math.round(delay / 60000);
    account.status = `Reconectando em ${delayInMinutes} min...`;
    console.log(`[${account.username}] Próxima tentativa de reconexão em ${delayInMinutes} minutos.`);
    setTimeout(() => {
        console.log(`[${account.username}] A tentar reconexão automática...`);
        account.status = "Iniciando...";
        account.client = new SteamUser();
        setupListenersForAccount(account);
        account.client.logOn(getLogonOptions(account));
    }, delay);
}

function setupListenersForAccount(account) {
    account.client.on('loggedOn', () => {
        console.log(`[${account.username}] Login OK!`);
        account.status = "Rodando";
        account.sessionStartTime = Date.now();
        account.reconnect_attempts = 0;
        
        // **A CORREÇÃO FINAL: O Período de Cortesia**
        // Adicionamos um pequeno atraso para dar tempo à sessão para estabilizar completamente.
        console.log(`[${account.username}] Sessão estável. A aplicar configurações de jogo em 3 segundos...`);
        setTimeout(() => {
            applyLiveSettings(account);
        }, 3000); // Atraso de 3 segundos
    });

    account.client.on('steamGuard', (domain, callback) => { if (account.settings.sharedSecret) { const code = require('steam-totp').generateAuthCode(account.settings.sharedSecret); callback(code); } else { account.status = "Pendente: Steam Guard"; account.steamGuardCallback = callback; } });
    account.client.on('disconnected', (eresult, msg) => { console.log(`[${account.username}] Desconectado: ${msg}`); account.sessionStartTime = null; scheduleReconnect(account); });
    account.client.on('error', (err) => { console.log(`[${account.username}] Erro: ${err.eresult}`); account.sessionStartTime = null; if (err.eresult === SteamUser.EResult.LoggedInElsewhere) { scheduleReconnect(account); } else { account.status = "Erro"; }});
    account.client.on('sentry', (sentryHash) => { const hashString = sentryHash.toString('base64'); account.sentryFileHash = hashString; accountsCollection.updateOne({ username: account.username }, { $set: { sentryFileHash: hashString } }); });
    account.client.on('friendRelationship', (steamID, relationship) => { if (relationship === SteamUser.EFriendRelationship.RequestRecipient && account.settings.autoAcceptFriends) { account.client.addFriend(steamID); } });
    account.client.on('friendMessage', (sender, message) => { if (account.settings.customAwayMessage) { account.client.chatMessage(sender, account.settings.customAwayMessage); } });
}

function getLogonOptions(account) { const options = { accountName: account.username, password: account.password }; if (account.sentryFileHash) { options.shaSentryfile = Buffer.from(account.sentryFileHash, 'base64'); } return options; }
async function loadAccountsIntoMemory() { const defaultSettings = { customInGameTitle: '', customAwayMessage: '', appearOffline: false, autoAcceptFriends: false, autoRelogin: true, sharedSecret: '' }; const savedAccounts = await accountsCollection.find({}).toArray(); savedAccounts.forEach((acc, index) => { liveAccounts[acc.username] = { username: acc.username, password: decrypt(acc.password), games: acc.games || [730], settings: { ...defaultSettings, ...(acc.settings || {}) }, sentryFileHash: acc.sentryFileHash || null, status: 'Parado', client: new SteamUser(), sessionStartTime: null, steamGuardCallback: null, manual_logout: false, reconnect_attempts: 0 }; setupListenersForAccount(liveAccounts[acc.username]); if (liveAccounts[acc.username].settings.autoRelogin) { const delay = index * 15000; console.log(`[${acc.username}] Inicialização automática agendada em ${delay / 1000} segundos...`); setTimeout(() => { console.log(`[${acc.username}] A iniciar agora...`); liveAccounts[acc.username].status = "Iniciando..."; liveAccounts[acc.username].client.logOn(getLogonOptions(liveAccounts[acc.username])); }, delay); } }); console.log(`${Object.keys(liveAccounts).length} contas carregadas e agendadas para iniciar.`); }

// --- CONFIGURAÇÃO DA APLICAÇÃO E ROTAS ---
app.use(express.json()); app.use(express.urlencoded({ extended: true })); app.use(session({ secret: APP_SECRET, resave: false, saveUninitialized: false, store: MongoStore.create({ mongoUrl: MONGODB_URI, dbName: 'stf_boost_db', collectionName: 'sessions', ttl: 24 * 60 * 60 }), cookie: { secure: 'auto', httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }})); const isAuthenticated = (req, res, next) => { if (req.session.isLoggedIn) { return next(); } res.redirect('/login?error=unauthorized'); }; app.get('/login', (req, res) => { if (req.session.isLoggedIn) { return res.redirect('/'); } res.sendFile(path.join(__dirname, 'public', 'login.html')); }); app.post('/login', async (req, res) => { let settings = await siteSettingsCollection.findOne({ _id: 'config' }); const submittedPass = req.body.password; if (settings && submittedPass && decrypt(settings.sitePassword) === submittedPass) { req.session.isLoggedIn = true; res.redirect('/'); } else { res.redirect('/login?error=1'); } }); app.get('/health', (req, res) => { res.status(200).send('OK'); }); app.get('/', isAuthenticated, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); }); app.use(express.static(path.join(__dirname, 'public'), { index: false })); const apiRouter = express.Router(); apiRouter.use(isAuthenticated); apiRouter.get('/status', (req, res) => { const publicState = { accounts: {} }; for (const username in liveAccounts) { const acc = liveAccounts[username]; publicState.accounts[username] = { username: acc.username, status: acc.status, games: acc.games, uptime: acc.sessionStartTime ? Date.now() - acc.sessionStartTime : 0, settings: acc.settings }; } res.json(publicState); }); apiRouter.post('/add-account', async (req, res) => { const { username, password } = req.body; if (!username || !password) return res.status(400).json({ message: "Usuário e senha são obrigatórios."}); const existing = await accountsCollection.findOne({ username }); if (existing) return res.status(400).json({ message: "Conta já existe." }); const newAccountData = { username, password: encrypt(password), games: [730], sentryFileHash: null, settings: { customInGameTitle: 'STF Boost', customAwayMessage: '', appearOffline: false, autoAcceptFriends: false, autoRelogin: true, sharedSecret: '' } }; await accountsCollection.insertOne(newAccountData); liveAccounts[username] = { ...newAccountData, password: password, status: 'Parado', client: new SteamUser(), sessionStartTime: null, steamGuardCallback: null, manual_logout: false, reconnect_attempts: 0 }; setupListenersForAccount(liveAccounts[username]); res.status(200).json({ message: "Conta adicionada com sucesso." }); }); apiRouter.delete('/remove-account/:username', async (req, res) => { const { username } = req.params; const account = liveAccounts[username]; if (account) { account.manual_logout = true; if (account.status === "Rodando") account.client.logOff(); delete liveAccounts[username]; await accountsCollection.deleteOne({ username }); res.status(200).json({ message: "Conta removida com sucesso." }); } else { res.status(404).json({ message: "Conta não encontrada." }); } }); apiRouter.post('/start/:username', (req, res) => { const account = liveAccounts[req.params.username]; if (!account) { return res.status(404).json({ message: "Conta não encontrada." }); } const status = account.status; if (status === 'Parado' || status === 'Erro' || status === 'Pendente: Steam Guard' || status.startsWith('Reconectando')) { console.log(`[${account.username}] Recebido comando de início/reinicio.`); account.status = "Iniciando..."; account.reconnect_attempts = 0; account.manual_logout = false; if (account.client.steamID) { account.client.logOff(); } account.client.logOn(getLogonOptions(account)); res.status(200).json({ message: "Processo iniciado/reiniciado." }); } else { res.status(400).json({ message: "A conta já está rodando." }); } }); apiRouter.post('/stop/:username', (req, res) => { const account = liveAccounts[req.params.username]; if (account) { account.manual_logout = true; account.status = "Parando..."; account.client.logOff(); res.status(200).json({ message: "Parando..." }); } else { res.status(404).json({ message: "Conta não encontrada." }); } }); apiRouter.post('/submit-guard/:username', (req, res) => { const account = liveAccounts[req.params.username]; if (account && account.steamGuardCallback) { account.steamGuardCallback(req.body.code); account.steamGuardCallback = null; res.status(200).json({ message: "Código enviado." }); } else { res.status(400).json({ message: "Pedido de Steam Guard não estava ativo." }); } }); apiRouter.post('/set-games/:username', async (req, res) => { const { games } = req.body; const { username } = req.params; const account = liveAccounts[username]; if (account && games && Array.isArray(games)) { account.games = games; await accountsCollection.updateOne({ username }, { $set: { games: games } }); applyLiveSettings(account); res.status(200).json({ message: `Jogos atualizados.` }); } else { res.status(400).json({ message: 'Conta ou formato de jogos inválido.' }); } }); apiRouter.post('/save-settings/:username', async (req, res) => { const { username } = req.params; const newSettings = req.body.settings; const account = liveAccounts[username]; if (account && newSettings) { account.settings = { ...account.settings, ...newSettings }; await accountsCollection.updateOne({ username }, { $set: { settings: account.settings } }); applyLiveSettings(account); res.status(200).json({ message: "Configurações salvas!" }); } else { res.status(404).json({ message: "Conta não encontrada." }); } }); apiRouter.get('/logout', (req, res) => { req.session.destroy((err) => { if (err) { return res.redirect('/'); } res.clearCookie('connect.sid'); res.redirect('/login'); }); }); app.use(apiRouter);

// --- INICIALIZAÇÃO DO SERVIDOR ---
async function startServer() { await connectToDB(); let settings = await siteSettingsCollection.findOne({ _id: 'config' }); if (!settings) { console.log("Nenhuma senha de site encontrada..."); await siteSettingsCollection.insertOne({ _id: 'config', sitePassword: encrypt(SITE_PASSWORD) }); console.log("Senha do site configurada!"); } await loadAccountsIntoMemory(); app.listen(PORT, () => console.log(`Servidor iniciado na porta ${PORT}`)); }
startServer();
