// index.js - Servidor e Cliente Steam integrados

const express = require('express');
const path = require('path');
const SteamUser = require('steam-user');

const app = express();
const client = new SteamUser();
const PORT = process.env.PORT || 3000;

// Variável para guardar a função de callback do Steam Guard
let steamGuardCallback = null;

// Configuração do Express
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // Essencial para receber o código do painel

// --- ROTAS DA API ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Rota para iniciar o processo de login
app.post('/start', (req, res) => {
    console.log('Recebido pedido para iniciar o boost.');
    
    const logOnOptions = {
        accountName: process.env.STEAM_USER,
        password: process.env.STEAM_PASS,
    };

    if (!logOnOptions.accountName || !logOnOptions.password) {
        console.error("ERRO: Variáveis de ambiente STEAM_USER e STEAM_PASS não definidas.");
        return res.status(400).json({ message: "Credenciais da Steam não configuradas no servidor." });
    }
    
    client.logOn(logOnOptions);
    res.status(200).json({ message: 'Tentativa de login iniciada. Verifique os logs.' });
});

// NOVA Rota para submeter o código do Steam Guard
app.post('/submit-guard', (req, res) => {
    const { code } = req.body; // Pega o código enviado pelo painel

    if (steamGuardCallback) {
        console.log(`Recebido código do Steam Guard do painel: ${code}`);
        steamGuardCallback(code); // Usa o código na função que o Steam está à espera
        steamGuardCallback = null; // Limpa a callback após o uso
        res.status(200).json({ message: 'Código do Steam Guard enviado com sucesso!' });
    } else {
        console.error('Recebido código do Steam Guard, mas não há nenhum pedido em espera.');
        res.status(400).json({ message: 'Nenhum pedido de código do Steam Guard estava ativo.' });
    }
});

// --- OUVINTES DO CLIENTE STEAM ---

client.on('loggedOn', () => {
    console.log(`Login efetuado com sucesso!`);
    client.setPersona(SteamUser.EPersonaState.Online);
    client.gamesPlayed([2923300, 730]); // Inicia o boost nos jogos
    console.log('Boost de horas iniciado.');
});

client.on('steamGuard', (domain, callback) => {
    console.log(`A Steam está a pedir um código de autenticação! Por favor, insira o código no painel.`);
    // Guarda a função de callback para ser usada pela rota /submit-guard
    steamGuardCallback = callback;
});

client.on('error', (err) => {
    const errorName = SteamUser.EResult[err.eresult] || `Código de Erro ${err.eresult}`;
    console.error(`Ocorreu um erro no cliente Steam: ${errorName}`);
});

// Iniciar o servidor web
app.listen(PORT, () => {
  console.log(`Servidor do STF Steam Boost iniciado na porta ${PORT}`);
});
