const express = require('express');
const path = require('path');
const { MongoClient } = require('mongodb'); // Driver do MongoDB
const crypto = require('crypto');
const SteamUser = require('steam-user');

// --- CONFIGURAÇÃO ---
const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI; // A Connection String virá do Render

if (!MONGODB_URI) {
    console.error("ERRO CRÍTICO: Variável de ambiente MONGODB_URI não definida!");
    process.exit(1);
}

// --- LÓGICA DO BANCO DE DADOS ---
const mongoClient = new MongoClient(MONGODB_URI);
let accountsCollection;

async function connectToDB() {
    try {
        await mongoClient.connect();
        console.log("Conectado ao MongoDB Atlas com sucesso!");
        const db = mongoClient.db("stf_boost_db"); // Pode dar qualquer nome à sua base de dados
        accountsCollection = db.collection("accounts");
    } catch (e) {
        console.error("Não foi possível conectar ao MongoDB", e);
        process.exit(1);
    }
}

// --- Criptografia (sem alterações) ---
const ALGORITHM = 'aes-256-cbc';
const SECRET_KEY = process.env.APP_SECRET;
// ... (cole aqui as funções 'encrypt' e 'decrypt' da resposta anterior) ...

// --- GESTÃO DE CONTAS ---
let liveAccounts = {}; // Objeto para guardar o estado VIVO das contas (clientes Steam, status, etc.)

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

function setupListenersForAccount(account) {
    // ... (cole aqui a função setupListenersForAccount da resposta anterior) ...
}

// --- API ---
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Rota para adicionar conta (agora no DB)
app.post('/add-account', async (req, res) => {
    const { username, password } = req.body;
    const existing = await accountsCollection.findOne({ username });
    if (existing) {
        return res.status(400).json({ message: "Conta já existe." });
    }
    
    const newAccount = {
        username,
        password: encrypt(password),
        games: [730]
    };
    await accountsCollection.insertOne(newAccount);
    
    // Adiciona à memória também
    liveAccounts[username] = { ...newAccount, password: password, status: 'Parado', client: new SteamUser() /* ... */ };
    setupListenersForAccount(liveAccounts[username]);

    res.status(200).json({ message: "Conta adicionada com sucesso." });
});

// Outras rotas (/start, /stop, etc.) precisam ser adaptadas para ler de 'liveAccounts'
// ... (a lógica das outras rotas permanece muito semelhante à da resposta anterior, mas operando sobre 'liveAccounts')

// --- INICIALIZAÇÃO ---
async function startServer() {
    await connectToDB();
    await loadAccountsIntoMemory();
    
    app.listen(PORT, () => {
        console.log(`Servidor iniciado na porta ${PORT}`);
    });
}

startServer();
