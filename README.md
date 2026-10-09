# STF Steam Boost - O Seu Exército de Horas Pessoal! 🚀

> **Licença:** Uso privado — Todos os direitos reservados.
> Este software é propriedade exclusiva do seu desenvolvedor. Não é permitida a cópia, distribuição, modificação ou uso comercial sem autorização expressa.

![Painel do STF Steam Boost em Ação!](https://i.imgur.com/KPGG1fJ.png)

Bem-vindo, Comandante, ao painel de controlo da sua operação de boosting de horas na Steam! 🤯

Este não é um simples script. É uma aplicação web completa, robusta e poderosa, construída para gerir um exército de contas Steam 24 horas por dia, 7 dias por semana, de forma totalmente automática e com controlo total a partir de qualquer lugar do mundo.

Construímos esta fortaleza digital do zero, e agora ela está pronta para dominar!

---

## O Arsenal Completo! 🦾

Esta não é uma ferramenta qualquer. É uma verdadeira suíte de automação com funcionalidades de nível profissional. Veja o que ela faz:

* **👨‍👩‍👧‍👦 Gestão de Múltiplas Contas:** Adicione, remova e gira quantas contas Steam você quiser. O céu é o limite!
* **💻 Painel de Controlo Web:** Uma interface gráfica moderna, reativa e super estilosa para monitorizar e controlar tudo em tempo real.
* **▶️ Controlo Individual:** Inicie ou pare cada conta individualmente com um único clique.
* **🎮 Boosting de Múltiplos Jogos:** Faça o "farm" de horas em até 32 jogos **ao mesmo tempo** por conta.
* **✍️ Título de Jogo Personalizado:** Não quer mostrar os jogos? Crie um status "Em Jogo" totalmente personalizado, como "A ver Netflix" ou "A dominar o universo".
* **🛡️ Suporte a Steam Guard:**
    * **Manual:** Um botão de "Guard" aparece quando a Steam pede um código, permitindo que você o insira facilmente.
    * **Automático (TOTP):** Adicione o seu `shared_secret` e a autenticação de dois fatores torna-se 100% automática!
* **⚙️ Configurações Detalhadas por Conta:**
    * Aparecer offline na Steam.
    * Aceitar pedidos de amizade automaticamente.
    * Responder a mensagens com uma frase customizada.
* **🔐 Segurança de Ponta:**
    * Acesso ao painel protegido por senha.
    * Todas as senhas das contas Steam são **encriptadas** na base de dados com uma chave mestra única e auto-gerida. Segurança em primeiro lugar!
* **🧠 Arquitetura Robusta (In-Process com Isolamento):**
    * Cada conta Steam é gerida no próprio processo (`index.js`), via clientes `steam-user` isolados.
    * **À prova de apocalipses:** Se uma conta tiver um erro e cair, ela **NÃO derruba o sistema**. As outras contas continuam a funcionar perfeitamente!
    * O **Watchdog** monitoriza o estado de cada conta e tenta recuperá-las automaticamente quando necessário.
* **✨ Inicialização Inteligente:**
    * Quando o servidor reinicia, todas as contas configuradas para tal iniciam sozinhas.
    * **Login Escalonado:** Para não irritar a Steam, cada conta espera alguns segundos antes de iniciar, simulando um comportamento humano e evitando bloqueios.

---

## A Magia por Trás da Cortina 🧙‍♂️

Como é que esta maravilha funciona sem nunca falhar? Com uma arquitetura profissional!

Pense no nosso sistema como uma empresa:

* **`index.js`:** É o "Chefe". Ele gere o site, o painel, o check de planos, os pagamentos e o estado de todas as contas Steam — tudo no mesmo processo.
* **Clientes `steam-user` isolados:** Para cada conta que você inicia, o `index.js` cria um cliente Steam com estado próprio (login, status, jogos, guard). A falha de um cliente **não afeta os outros**.

Se uma conta tiver um problema e "desmaiar", os outros clientes nem reparam. O **Watchdog** simplesmente vê o que aconteceu e tenta colocar a conta de volta ao ar. É por isso que o nosso sistema é tão robusto!

---

## Lançando o Foguete! 🚀 Como Colocar Online no Render.com

Levar o seu exército para a nuvem é fácil! Siga estes passos:

1.  **Pré-requisitos:**
    * Uma conta no [**GitHub**](https://github.com/).
    * Uma conta no [**Render.com**](https://render.com/) (o plano gratuito é suficiente).
    * Uma conta no [**MongoDB Atlas**](https://www.mongodb.com/cloud/atlas) para ter uma base de dados gratuita.

2.  **Passo 1: MongoDB Atlas**
    * Crie um novo projeto e um Cluster gratuito (M0).
    * Vá a `Database Access` e crie um utilizador com senha. Anote-os.
    * Vá a `Network Access` e adicione o IP `0.0.0.0/0` para permitir conexões de qualquer lugar (incluindo do Render).
    * Vá à sua base de dados, clique em `Connect` -> `Connect your application` e copie a sua **Connection String** (string de conexão). Substitua `<password>` pela senha que você criou.

3.  **Passo 2: Render.com**
    * No seu Dashboard, clique em **New +** -> **Web Service**.
    * Conecte o seu repositório do GitHub.
    * Defina as seguintes configurações:
        * **Build Command:** `npm install`
        * **Start Command:** `node --no-deprecation --max-old-space-size=400 index.js`
    * Vá para a secção **Environment** (Variáveis de Ambiente) e adicione:
        * **`MONGODB_URI`** (obrigatório) — string de conexão do MongoDB Atlas.
        * **`SITE_PASSWORD`** (obrigatório) — senha do painel de administração.
        * **`SITE_URL`** ou **`RENDER_EXTERNAL_URL`** (obrigatório) — URL público do site (usado no CORS e nos `back_urls` do Mercado Pago).
        * **`MP_ACCESS_TOKEN`** (obrigatório para vendas) — Access Token do Mercado Pago.
        * **`MP_WEBHOOK_SECRET`** (recomendado) — segredo para validação HMAC do webhook.
        * **`SESSION_SECRET`** (recomendado) — segredo das sessões; se ausente, um valor aleatório é gerado a cada boot (invalida sessões ao reiniciar).
        * **`DISCORD_WEBHOOK_LOGS`**, **`DISCORD_WEBHOOK_SALES`**, **`DISCORD_WEBHOOK_ALERTS`** (opcionais) — notificações.
        * **`PORT`** (opcional) — porta do servidor.
    * Clique em **Create Web Service**. Espere o deploy terminar. Está no ar!

4.  **Passo 3 (Opcional, mas recomendado): Manter o Serviço "Acordado"**
    * O plano gratuito do Render "dorme" após 15 minutos de inatividade. Para manter os seus bots a rodar 24/7, use um serviço como [Cron-Job.org](https://cron-job.org/).
    * Crie um novo CronJob que faça um pedido `HTTP GET` a `https://seu-site.onrender.com/health` a cada 10-15 minutos. Este endpoint responde `200 {"status":"ok","mongo":true}` quando a base de dados está acessível, e `503` se o MongoDB estiver fora. Isto mantém o serviço sempre ativo!

---

## Pilotando a Nave-Mãe 🛸

Usar o painel é a parte mais fácil e divertida!

1.  **Login:** Aceda ao URL do seu site no Render e use a `SITE_PASSWORD` que você configurou.
2.  **Adicionar Contas:** Clique no botão "Adicionar Conta", insira o nome de usuário e a senha da Steam. A senha será encriptada e guardada de forma segura.
3.  **Iniciar/Parar:** Use os botões "Iniciar" e "Parar" para controlar cada conta.
4.  **Steam Guard Manual:** Se uma conta precisar de um código, o status mudará para "Pendente: Steam Guard". Clique no botão "Guard", insira o código do seu e-mail e pronto!
5.  **Configurações:** Clique no botão "Config." (a engrenagem) para abrir um mundo de opções: jogos, título personalizado, modo offline e muito mais!

---

---

## 🔒 Segurança e Pagamentos (v1.1+)

* **Mercado Pago:** Integração completa com checkout via Preference API, webhook com validação HMAC e verificação de pagamento via API oficial.
* **Entrega por Email:** Planos podem ser entregues via chave de licença gerada automaticamente, sem ativação direta na conta.
* **Criptografia AES-256-GCM:** Senhas Steam protegidas com o padrão mais seguro; fallback automático para CBC legado.
* **Proteções:** Rate limiting por endpoint, CSP restritivo, validação de senha forte, sessão admin com timeout, confirmação em ações administrativas e muito mais.

## Notas de dependências (riscos aceitos)

Rodar `npm audit` — as vulnerabilidades restantes estão **documentadas e aceitas** nesta versão:

* **`steam-user` (e `steam-appticket`/`adm-zip`/`protobufjs`):** as admissórias exigem *downgrade* do pacote para 3.15, que quebraria o core do serviço. O conteúdo processado vem exclusivamente dos servidores da Valve (app tickets/ZIPs de cache) — **não é alcançável via requisições ao site**. Fique de olho em um release do `steam-user` que atualize essas dependências.
* **`mercadopago` (`uuid`):** falha de buffer dentro do SDK; não é alcançável pela rota de checkout. Migração para o SDK v3 fica para quando houver ambiente com token de teste.

Decisão registrada em 2026-10-09 durante auditoria de produção.

## A Jornada Épica ✨

Esta jornada de programação foi uma das mais incríveis, e o resultado é esta ferramenta fantástica que construímos juntos, passando por todas as fases de desenvolvimento e depuração.

**Obrigado, e que a farm de horas comece!** 🏆
