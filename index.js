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
        console.error("Erro ao descodificar a senha. Verifique se a APP_SECRET mudou.");
        return "";
    }
};

// --- LÓGICA DO BANCO DE DADOS E GESTÃO DE CONTAS ---
const mongoClient = new MongoClient(MONGODB_URI);
let accountsCollection;
let liveAccounts = {}; 

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

function applyLiveSettings(account) {
    if (account.status !== "Rodando") return;

    console.log(`[${account.username}] Aplicando configurações ao vivo...`);
    const personaState = account.settings.appearOffline ? SteamUser.EPersonaState.Offline : SteamUser.EPersonaState.Online;
    account.client.setPersona(personaState);
    console.log(`[${account.username}] Status da persona definido para: ${personaState}`);

    let gamesToPlay;

    if (account.settings.customInGameTitle) {
        gamesToPlay = [{ game_id: 0, game_extra_info: account.settings.customInGameTitle }];
    } else {
        gamesToPlay = [...account.games];
    }
    
    if (gamesToPlay.length > 0) {
        console.log(`[${account.username}] Enviando para a Steam os jogos:`, JSON.stringify(gamesToPlay));
        account.client.gamesPlayed(gamesToPlay);
    }
}

function setupListenersForAccount(account) {
    account.client.on('loggedOn', () => {
        console.log(`[${account.username}] Login OK!`);
        account.status = "Rodando";
        account.sessionStartTime = Date.now();
        applyLiveSettings(account);
    });

    account.client.on('steamGuard', (domain, callback) => {
        console.log(`[${account.username}] Steam Guard solicitado.`);
        account.status = "Pendente: Steam Guard";
        account.steamGuardCallback = callback;
    });

    account.client.on('disconnected', (eresult, msg) => {
        console.log(`[${account.username}] Desconectado: ${msg}`);
        account.status = "Parado";
        account.sessionStartTime = null;
    });
    
    account.client.on('error', (err) => {
        console.log(`[${account.username}] Erro: ${err.message || err.eresult}`);
        account.status = "Erro";
        account.sessionStartTime = null;
    });

    account.client.on('friendRelationship', (steamID, relationship) => {
        if (relationship === SteamUser.EFriendRelationship.RequestRecipient && account.settings.autoAcceptFriends) {
            console.log(`[${account.username}] Aceitando pedido de amizade de ${steamID.getSteamID64()}`);
            account.client.addFriend(steamID);
        }
    });

    account.client.on('chatMessage', (sender, message) => {
        console.log(`[${account.username}] Mensagem recebida de ${sender.getSteamID64()}: "${message}"`);
        if (account.settings.customAwayMessage) {
            console.log(`[${account.username}] Enviando resposta automática.`);
            account.client.chatMessage(sender, account.settings.customAwayMessage);
        }
    });
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
    if (!username || !password) return res.status(400).json({ message: "Usuário e senha são obrigatórios." });
    const existing = await accountsCollection.findOne({ username });
    if (existing) return res.status(400).json({ message: "Conta já existe." });
    
    const newAccountData = {
        username,
        password: encrypt(password),
        games: [730],
        settings: { customInGameTitle: 'STF Boost', customAwayMessage: '', appearOffline: false, autoAcceptFriends: false }
    };
    await accountsCollection.insertOne(newAccountData);
    
    liveAccounts[username] = { ...newAccountData, password: password, status: 'Parado', client: new SteamUser(), sessionStartTime: null, steamGuardCallback: null };
    setupListenersForAccount(liveAccounts[username]);
    res.status(200).json({ message: "Conta adicionada com sucesso." });
});

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
        applyLiveSettings(account);
        res.status(200).json({ message: `Jogos atualizados.` });
    } else {
        res.status(400).json({ message: 'Conta ou formato de jogos inválido.' });
    }
});

app.post('/save-settings/:username', async (req, res) => {
    const { username } = req.params;
    const newSettings = req.body.settings;
    const account = liveAccounts[username];
    if (account && newSettings) {
        console.log(`[${username}] Recebido pedido para salvar configurações:`, newSettings);
        account.settings = newSettings;
        await accountsCollection.updateOne({ username }, { $set: { settings: newSettings } });
        applyLiveSettings(account);
        res.status(200).json({ message: "Configurações salvas com sucesso!" });
    } else {
        res.status(404).json({ message: "Conta não encontrada ou dados inválidos." });
    }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
async function startServer() {
    await connectToDB();
    await loadAccountsIntoMemory();
    app.listen(PORT, () => console.log(`Servidor iniciado na porta ${PORT}`));
}

startServer();
