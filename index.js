const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const SteamUser = require('steam-user');
const fetch = require('node-fetch');

// --- CONFIGURAÇÃO ---
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const SECRET_KEY = process.env.APP_SECRET;

if (!MONGODB_URI || !SECRET_KEY) {
    console.error("ERRO CRÍTICO: As variáveis de ambiente MONGODB_URI e APP_SECRET precisam de ser definidas!");
    process.exit(1);
}

// --- CRIPTOGRAFIA ---
const ALGORITHM = 'aes-256-cbc';
const key = crypto.createHash('sha256').update(String(SECRET_KEY)).digest('base64').substr(0, 32);

const encrypt = (text) => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
};

const decrypt = (text) => {
    try {
        const textParts = text.split(':');
        const iv = Buffer.from(textParts.shift(), 'hex');
        const encryptedText = Buffer.from(textParts.join(':'), 'hex');
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        return decrypted.toString();
    } catch (error) {
        console.error("Erro ao descodificar a senha. Verifique se a APP_SECRET mudou.");
        return "";
    }
};

// --- LÓGICA DO BANCO DE DADOS E ESTADO ---
const mongoClient = new MongoClient(MONGODB_URI);
let accountsCollection;
let steamApps = [];
let liveAccounts = {}; 
let serverState = { appListReady: false };

async function connectToDB() {
    try {
        await mongoClient.connect();
        console.log("Conectado ao MongoDB Atlas com sucesso!");
        const db = mongoClient.db("stf_boost_db");
        accountsCollection = db.collection("accounts");
    } catch (e) {
        console.error("Não foi possível conectar ao MongoDB", e);
        process.exit(1);
    }
}

async function fetchSteamApps() {
    try {
        console.log("A buscar a lista de jogos da Steam...");
        const response = await fetch('https://api.steampowered.com/ISteamApps/GetAppList/v2/');
        const data = await response.json();
        steamApps = data.applist.apps;
        serverState.appListReady = true;
        console.log(`Lista de jogos carregada: ${steamApps.length} apps.`);
    } catch (error) {
        console.error("Falha ao buscar a lista de jogos da Steam:", error);
    }
}

function setupListenersForAccount(account) {
    account.client.on('loggedOn', () => {
        console.log(`Login OK para: ${account.username}`);
        account.status = "Rodando";
        account.sessionStartTime = Date.now();
        account.client.setPersona(SteamUser.EPersonaState.Online);
        account.client.gamesPlayed(account.games);
    });
    account.client.on('steamGuard', (domain, callback) => {
        console.log(`Steam Guard solicitado para: ${account.username}`);
        account.status = "Pendente: Steam Guard";
        account.steamGuardCallback = callback;
    });
    account.client.on('disconnected', () => {
        account.status = "Parado";
        account.sessionStartTime = null;
    });
    account.client.on('error', () => {
        account.status = "Erro";
        account.sessionStartTime = null;
    });
}

async function loadAccountsIntoMemory() {
    const savedAccounts = await accountsCollection.find({}).toArray();
    for (const acc of savedAccounts) {
        liveAccounts[acc.username] = {
            ...acc,
            password: decrypt(acc.password),
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

app.get('/status', (req, res) => {
    const publicState = { accounts: {}, appListReady: serverState.appListReady };
    for (const username in liveAccounts) {
        const acc = liveAccounts[username];
        publicState.accounts[username] = { username: acc.username, status: acc.status, games: acc.games, uptime: acc.sessionStartTime ? Date.now() - acc.sessionStartTime : 0 };
    }
    res.json(publicState);
});

app.post('/add-account', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ message: "Usuário e senha são obrigatórios." });

    const existing = await accountsCollection.findOne({ username });
    if (existing) return res.status(400).json({ message: "Conta já existe." });
    
    const newAccountData = { username, password: encrypt(password), games: [730] };
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
    } else {
        res.status(404).json({ message: "Conta não encontrada." });
    }
});

app.post('/start/:username', (req, res) => {
    const account = liveAccounts[req.params.username];
    if (account) {
        account.status = "Iniciando...";
        account.client.logOn({ accountName: account.username, password: account.password });
        res.status(200).json({ message: "Iniciando..." });
    } else {
        res.status(404).json({ message: "Conta não encontrada." });
    }
});

app.post('/stop/:username', (req, res) => {
    const account = liveAccounts[req.params.username];
    if (account) {
        account.status = "Parando...";
        account.client.logOff();
        res.status(200).json({ message: "Parando..." });
    } else {
        res.status(404).json({ message: "Conta não encontrada." });
    }
});

app.post('/submit-guard/:username', (req, res) => {
    const account = liveAccounts[req.params.username];
    if (account && account.steamGuardCallback) {
        account.steamGuardCallback(req.body.code);
        account.steamGuardCallback = null;
        res.status(200).json({ message: "Código enviado." });
    } else {
        res.status(400).json({ message: "Pedido de Steam Guard não estava ativo." });
    }
});

app.post('/set-games/:username', async (req, res) => {
    const { games } = req.body;
    const { username } = req.params;
    const account = liveAccounts[username];
    if (account && games && Array.isArray(games)) {
        account.games = games;
        await accountsCollection.updateOne({ username }, { $set: { games: games } });
        if (account.status === "Rodando") {
            account.client.gamesPlayed(account.games);
        }
        res.status(200).json({ message: `Jogos atualizados.` });
    } else {
        res.status(400).json({ message: 'Conta ou formato de jogos inválido.' });
    }
});

app.get('/search-games', (req, res) => {
    if (!serverState.appListReady) {
        return res.json([{ name: "A lista de jogos ainda está a ser carregada, tente novamente em alguns segundos.", appid: 0 }]);
    }
    const query = req.query.q ? req.query.q.toLowerCase() : "";
    if (query.length < 2) return res.json([]);
    
    const results = steamApps
        .filter(app => app.name && app.name.toLowerCase().includes(query))
        .slice(0, 20);
    res.json(results);
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
async function startServer() {
    await connectToDB();
    await loadAccountsIntoMemory();
    await fetchSteamApps();
    app.listen(PORT, () => console.log(`Servidor iniciado na porta ${PORT}`));
}

startServer();
