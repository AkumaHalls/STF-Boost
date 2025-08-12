const express = require('express');
const path = require('path');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const { fork } = require('child_process');

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

// --- GESTÃO DE CONTAS E BANCO DE DADOS ---
const mongoClient = new MongoClient(MONGODB_URI);
let accountsCollection;
let siteSettingsCollection;
let liveAccounts = {}; 
async function connectToDB() { try { await mongoClient.connect(); console.log("Conectado ao MongoDB Atlas com sucesso!"); const db = mongoClient.db("stf_boost_db"); accountsCollection = db.collection("accounts"); siteSettingsCollection = db.collection("site_settings"); } catch (e) { console.error("Não foi possível conectar ao MongoDB", e); process.exit(1); } }

function startWorkerForAccount(accountData) {
    const username = accountData.username;
    console.log(`[GESTOR] A iniciar worker para ${username}`);

    if (liveAccounts[username] && liveAccounts[username].worker) {
        console.log(`[GESTOR] Worker para ${username} já existe. A terminar o antigo.`);
        liveAccounts[username].worker.kill();
    }
    
    const worker = fork(path.join(__dirname, 'worker.js'));
    liveAccounts[username].worker = worker;
    liveAccounts[username].status = "Iniciando...";
    liveAccounts[username].manual_logout = false;

    worker.send({ command: 'start', data: accountData });

    worker.on('message', (message) => {
        const { type, payload } = message;
        if (type === 'statusUpdate') {
            console.log(`[GESTOR] Atualização de status de ${username}: ${payload.status}`);
            liveAccounts[username] = { ...liveAccounts[username], ...payload };
        }
        if (type === 'sentryUpdate') {
            console.log(`[GESTOR] A guardar nova sentry para ${username}`);
            liveAccounts[username].sentryFileHash = payload.sentryFileHash;
            accountsCollection.updateOne({ username }, { $set: { sentryFileHash: payload.sentryFileHash } });
        }
    });

    worker.on('exit', (code) => {
        console.log(`[GESTOR] Worker para ${username} saiu com código ${code}.`);
        if (liveAccounts[username] && !liveAccounts[username].manual_logout && liveAccounts[username].settings.autoRelogin) {
            console.log(`[GESTOR] A reiniciar worker para ${username} em 30 segundos...`);
            setTimeout(() => {
                const accData = { ...liveAccounts[username], password: decrypt(liveAccounts[username].encryptedPassword) };
                startWorkerForAccount(accData);
            }, 30000); // Tenta reiniciar após 30s
        } else {
            if (liveAccounts[username]) {
                liveAccounts[username].status = "Parado";
            }
        }
    });
}

async function loadAccountsIntoMemory() {
    const defaultSettings = { customInGameTitle: '', customAwayMessage: '', appearOffline: false, autoAcceptFriends: false, autoRelogin: true, sharedSecret: '' };
    const savedAccounts = await accountsCollection.find({}).toArray();
    savedAccounts.forEach((acc, index) => {
        liveAccounts[acc.username] = { username: acc.username, encryptedPassword: acc.password, games: acc.games || [730], settings: { ...defaultSettings, ...(acc.settings || {}) }, sentryFileHash: acc.sentryFileHash || null, status: 'Parado', worker: null, sessionStartTime: null, manual_logout: false };
        if (liveAccounts[acc.username].settings.autoRelogin) {
            const delay = index * 15000; // Mantém o início escalonado
            console.log(`[GESTOR] Worker para ${acc.username} agendado para iniciar em ${delay / 1000}s.`);
            setTimeout(() => {
                const accountData = { ...liveAccounts[acc.username], password: decrypt(acc.encryptedPassword) };
                startWorkerForAccount(accountData);
            }, delay);
        }
    });
    console.log(`[GESTOR] ${savedAccounts.length} contas carregadas.`);
}

// --- EXPRESS APP E ROTAS ---
app.use(express.json()); app.use(express.urlencoded({ extended: true })); app.use(session({ secret: APP_SECRET, resave: false, saveUninitialized: false, store: MongoStore.create({ mongoUrl: MONGODB_URI, dbName: 'stf_boost_db' }), cookie: { secure: 'auto', httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }})); const isAuthenticated = (req, res, next) => { if (req.session.isLoggedIn) { return next(); } res.redirect('/login?error=unauthorized'); }; app.get('/login', (req, res) => { if (req.session.isLoggedIn) { return res.redirect('/'); } res.sendFile(path.join(__dirname, 'public', 'login.html')); }); app.post('/login', async (req, res) => { let settings = await siteSettingsCollection.findOne({ _id: 'config' }); const submittedPass = req.body.password; if (settings && submittedPass && decrypt(settings.sitePassword) === submittedPass) { req.session.isLoggedIn = true; res.redirect('/'); } else { res.redirect('/login?error=1'); } }); app.get('/health', (req, res) => { res.status(200).send('OK'); }); app.get('/', isAuthenticated, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); }); app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const apiRouter = express.Router();
apiRouter.use(isAuthenticated);
apiRouter.get('/status', (req, res) => { const publicState = { accounts: {} }; for (const username in liveAccounts) { const { worker, encryptedPassword, ...accData } = liveAccounts[username]; publicState.accounts[username] = accData; } res.json(publicState); });
apiRouter.post('/start/:username', (req, res) => { const account = liveAccounts[req.params.username]; if (account) { const accountData = { ...account, password: decrypt(account.encryptedPassword) }; startWorkerForAccount(accountData); res.status(200).json({ message: "Iniciando worker..." }); } else { res.status(404).json({ message: "Conta não encontrada." }); } });
apiRouter.post('/stop/:username', (req, res) => { const account = liveAccounts[req.params.username]; if (account && account.worker) { account.manual_logout = true; account.worker.kill(); account.status = "Parado"; res.status(200).json({ message: "Parando worker..." }); } else { res.status(404).json({ message: "Conta ou worker não encontrado." }); } });
apiRouter.post('/add-account', async (req, res) => { const { username, password } = req.body; if (!username || !password) return res.status(400).json({ message: "Usuário e senha são obrigatórios."}); const existing = await accountsCollection.findOne({ username }); if (existing) return res.status(400).json({ message: "Conta já existe." }); const encryptedPassword = encrypt(password); const newAccountData = { username, password: encryptedPassword, games: [730] }; await accountsCollection.insertOne(newAccountData); liveAccounts[username] = { username, encryptedPassword, games: [730], settings: {}, status: 'Parado', worker: null }; res.status(200).json({ message: "Conta adicionada." }); });
apiRouter.delete('/remove-account/:username', async (req, res) => { const account = liveAccounts[req.params.username]; if (account) { if (account.worker) { account.manual_logout = true; account.worker.kill(); } delete liveAccounts[req.params.username]; await accountsCollection.deleteOne({ username: req.params.username }); res.status(200).json({ message: "Conta removida." }); } else { res.status(404).json({ message: "Conta não encontrada." }); } });
apiRouter.post('/submit-guard/:username', (req, res) => { const account = liveAccounts[req.params.username]; if (account && account.worker) { account.worker.send({ command: 'submitGuard', data: { code: req.body.code } }); res.status(200).json({ message: "Código enviado ao worker." }); } else { res.status(404).json({ message: "Conta ou worker não encontrado." }); } });
apiRouter.post('/save-settings/:username', async (req, res) => { const { username } = req.params; const { settings } = req.body; const account = liveAccounts[username]; if (account && settings) { await accountsCollection.updateOne({ username }, { $set: { settings } }); account.settings = settings; if (account.worker) { account.worker.send({ command: 'updateSettings', data: { settings, games: account.games } }); } res.status(200).json({ message: "Configurações salvas." }); } else { res.status(404).json({ message: "Conta não encontrada." }); } });
apiRouter.post('/set-games/:username', async (req, res) => { const { username } = req.params; const { games } = req.body; const account = liveAccounts[username]; if (account && games) { await accountsCollection.updateOne({ username }, { $set: { games } }); account.games = games; if (account.worker) { account.worker.send({ command: 'updateSettings', data: { settings: account.settings, games } }); } res.status(200).json({ message: "Jogos atualizados." }); } else { res.status(404).json({ message: "Conta não encontrada." }); } });

app.use(apiRouter);

// --- INICIALIZAÇÃO DO SERVIDOR ---
async function startServer() { await connectToDB(); await loadAccountsIntoMemory(); app.listen(PORT, () => console.log(`[GESTOR] Servidor iniciado na porta ${PORT}`)); }
startServer();
