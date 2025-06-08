// index.js - O nosso servidor Backend (Atualizado)

const express = require('express');
const path = require('path');
// 1. Importar o módulo 'exec' para executar comandos no servidor
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json()); // Middleware para entender JSON nos pedidos

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. INÍCIO DA NOVA ROTA /start
// Esta rota ouve por pedidos do tipo POST
app.post('/start', (req, res) => {
    console.log('Recebido pedido na rota /start.');
    
    // 3. Executar o script worker.js em segundo plano
    console.log('A tentar iniciar o worker.js...');
    const workerProcess = exec('node worker.js', (error, stdout, stderr) => {
        if (error) {
            console.error(`Erro ao executar worker: ${error.message}`);
            return;
        }
        if (stderr) {
            console.error(`Worker stderr: ${stderr}`);
            return;
        }
        console.log(`Worker stdout: ${stdout}`);
    });

    workerProcess.on('spawn', () => {
        console.log('Processo do worker.js foi iniciado com sucesso!');
    });

    // 4. Enviar uma resposta de volta para o navegador
    res.status(200).json({ message: 'Comando para iniciar o boost recebido! Verifique os logs no Render.' });
});
// FIM DA NOVA ROTA

app.listen(PORT, () => {
  console.log(`Servidor do STF Steam Boost iniciado na porta ${PORT}`);
});
