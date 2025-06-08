const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const SteamUser = require('steam-user');

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
        console.error("Erro ao descodificar a senha.");
        return "";
    }
};

// --- LÓGICA DO BANCO DE DADOS ---
const mongoClient = new MongoClient(MONGODB_URI);
let accountsCollection;
let steamApps = [];

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

// --- GESTÃO DE CONTAS ---
let liveAccounts = {}; 
let serverState = { appListReady: false }; // Guarda o estado geral, como o carregamento da lista de apps

function setupListenersForAccount(account) {
    account.client.on('loggedOn', () => { account.status = "Rodando"; account.sessionStartTime = Date.now(); account.client.setPersona(SteamUser.EPersonaState.Online); account.client.gamesPlayed(account.games); });
    account.client.on('steamGuard', (domain, callback) => { account.status = "Pendente: Steam Guard"; account.steamGuardCallback = callback; });
    account.client.on('disconnected', () => { account.status = "Parado"; account.sessionStartTime = null; });
    account.client.on('error', () => { account.status = "Erro"; account.sessionStartTime = null; });
}

async function loadAccountsIntoMemory() {
    const savedAccounts = await accountsCollection.find({}).toArray();
    for (const acc of savedAccounts) {
        liveAccounts[acc.username] = { ...acc, password: decrypt(acc.password), status: 'Parado', client: new SteamUser(), sessionStartTime: null, steamGuardCallback: null };
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

app.post('/add-account', async (req, res) => { /* ... (código sem alterações da resposta anterior) ... */ });
app.post('/start/:username', (req, res) => { /* ... (código sem alterações da resposta anterior) ... */ });
app.post('/stop/:username', (req, res) => { /* ... (código sem alterações da resposta anterior) ... */ });
app.post('/submit-guard/:username', (req, res) => { /* ... (código sem alterações da resposta anterior) ... */ });

// Rota para definir jogos de uma conta
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

// Rota para remover uma conta
app.delete('/remove-account/:username', async (req, res) => {
    const { username } = req.params;
    const account = liveAccounts[username];
    if (account) {
        if (account.status === "Rodando") {
            account.client.logOff();
        }
        delete liveAccounts[username];
        await accountsCollection.deleteOne({ username });
        res.status(200).json({ message: "Conta removida com sucesso." });
    } else {
        res.status(404).json({ message: "Conta não encontrada." });
    }
});

app.get('/search-games', (req, res) => { /* ... (código sem alterações da resposta anterior) ... */ });


// --- INICIALIZAÇÃO DO SERVIDOR ---
async function startServer() {
    await connectToDB();
    await loadAccountsIntoMemory();
    await fetchSteamApps(); // Movemos para depois de carregar as contas
    app.listen(PORT, () => console.log(`Servidor iniciado na porta ${PORT}`));
}
startServer();
