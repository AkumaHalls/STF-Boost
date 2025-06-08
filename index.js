// index.js - Servidor com estado e novas rotas

const express = require('express');
const path = require('path');
const SteamUser = require('steam-user');

const app = express();
const client = new SteamUser();
const PORT = process.env.PORT || 3000;

// Objeto para guardar o estado atual do nosso serviço
let serverState = {
    status: "Parado",
    accountName: process.env.STEAM_USER || "N/D", // Pega o nome do usuário da variável de ambiente
    games: (process.env.STEAM_GAMES || "730,2923300").split(',').map(Number) // Pega os jogos das variáveis ou usa um padrão
};

let steamGuardCallback = null;

// Configuração do Express
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// --- ROTAS DA API ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// NOVA Rota para o painel pedir o estado atual
app.get('/status', (req, res) => {
    res.status(200).json(serverState);
});

app.post('/start', (req, res) => {
    client.logOn({ accountName: process.env.STEAM_USER, password: process.env.STEAM_PASS });
    res.status(200).json({ message: 'Tentativa de login iniciada.' });
});

app.post('/submit-guard', (req, res) => {
    if (steamGuardCallback) {
        steamGuardCallback(req.body.code);
        steamGuardCallback = null;
        res.status(200).json({ message: 'Código do Steam Guard enviado!' });
    } else {
        res.status(400).json({ message: 'Nenhum pedido de código estava ativo.' });
    }
});

// NOVA Rota para definir os jogos
app.post('/set-games', (req, res) => {
    const { games } = req.body;
    if (games && Array.isArray(games)) {
        serverState.games = games;
        client.gamesPlayed(serverState.games); // Atualiza os jogos em tempo real
        console.log(`Lista de jogos atualizada para: ${games.join(', ')}`);
        res.status(200).json({ message: `Jogos atualizados para: ${games.join(', ')}` });
    } else {
        res.status(400).json({ message: 'Formato de jogos inválido.' });
    }
});

// --- OUVINTES DO CLIENTE STEAM ---

client.on('loggedOn', () => {
    console.log(`Login efetuado com sucesso para ${serverState.accountName}!`);
    serverState.status = "A Correr"; // Atualiza o status
    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed(serverState.games);
    console.log(`Boost iniciado para os jogos: ${serverState.games.join(', ')}`);
});

client.on('steamGuard', (domain, callback) => {
    console.log(`A Steam está a pedir um código de autenticação!`);
    steamGuardCallback = callback;
});

// NOVO Ouvinte para quando a conta é desconectada
client.on('disconnected', (eresult, msg) => {
    console.log(`Desconectado da Steam: ${msg}`);
    serverState.status = "Parado"; // Atualiza o status
});

client.on('error', (err) => {
    console.error(`Ocorreu um erro: ${SteamUser.EResult[err.eresult]}`);
    serverState.status = "Erro"; // Atualiza o status
});

// Iniciar o servidor
app.listen(PORT, () => {
  console.log(`Servidor iniciado na porta ${PORT}`);
});
