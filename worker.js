// worker.js - O nosso script para o "boost" de horas

const SteamUser = require('steam-user');

const client = new SteamUser();

// --- INFORMAÇÕES DE LOGIN (PARA TESTE) ---
const logOnOptions = {
    accountName: 'SEU_NOME_DE_USUARIO_STEAM',
    password: 'SUA_SENHA_STEAM'
};

client.logOn(logOnOptions);

client.on('loggedOn', () => {
    console.log('Login na Steam efetuado com sucesso!');
    client.setPersona(SteamUser.EPersonaState.Online);
    
    // AppIDs dos jogos para fazer o boost. Ex: 2923300 para Banana.
    client.gamesPlayed([2923300, 730]); 
    console.log('Boost de horas iniciado.');
});

client.on('steamGuard', (domain, callback) => {
    console.log(`É necessário um código do Steam Guard enviado para ${domain || 'o seu telemóvel'}.`);
    // Para testar, você precisará de inserir o código manualmente aqui.
    // Ex: callback('CODIGO_AQUI');
});

client.on('error', (err) => {
    console.error('Ocorreu um erro no worker:', err);
});