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
* **🧠 Arquitetura Imbatível (Gestor/Trabalhador):**
    * Cada conta corre num processo isolado ("Trabalhador").
    * **À prova de apocalipses:** Se uma conta tiver um erro crítico e crashar, ela **NÃO derruba o sistema**. As outras contas continuam a funcionar perfeitamente!
    * O sistema principal ("Gestor") monitoriza tudo e reinicia automaticamente os trabalhadores que falham.
* **✨ Inicialização Inteligente:**
    * Quando o servidor reinicia, todas as contas configuradas para tal iniciam sozinhas.
    * **Login Escalonado:** Para não irritar a Steam, cada conta espera alguns segundos antes de iniciar, simulando um comportamento humano e evitando bloqueios.

---

## A Magia por Trás da Cortina 🧙‍♂️

Como é que esta maravilha funciona sem nunca falhar? Com uma arquitetura profissional!

Pense no nosso sistema como uma empresa:

* **O Gestor (`index.js`):** É o "Chefe". Ele gere o site, o painel, fala consigo, e anota os pedidos. Ele não faz o trabalho sujo.
* **Os Trabalhadores (`worker.js`):** Para cada conta que você inicia, o Gestor contrata um "Funcionário" novo e isolado. A única tarefa deste funcionário é cuidar de UMA conta Steam. Ele faz o login, mantém a conta online e reporta o status ao chefe.

Se um funcionário tiver um problema e "desmaiar" (crashar), os outros funcionários nem reparam. O Chefe simplesmente vê o que aconteceu e contrata um novo funcionário para o substituir. É por isso que o nosso sistema é tão robusto!

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
        * **Start Command:** `node index.js`
    * Vá para a secção **Environment** (Variáveis de Ambiente) e adicione as seguintes variáveis:
        * **Key:** `MONGODB_URI`
        * **Value:** A sua string de conexão do MongoDB Atlas que você copiou.
        * **Key:** `SITE_PASSWORD`
        * **Value:** A senha que você quer usar para aceder ao seu painel.
    * Clique em **Create Web Service**. Espere o deploy terminar. Está no ar!

4.  **Passo 3 (Opcional, mas recomendado): Manter o Serviço "Acordado"**
    * O plano gratuito do Render "dorme" após 15 minutos de inatividade. Para manter os seus bots a rodar 24/7, use um serviço como [Cron-Job.org](https://cron-job.org/).
    * Crie um novo CronJob que faça um pedido `HTTP GET` ao endereço do seu painel, seguido de `/health` (ex: `https://seu-site.onrender.com/health`) a cada 10-15 minutos. Isto mantém o serviço sempre ativo!

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

## A Jornada Épica ✨

Esta jornada de programação foi uma das mais incríveis, e o resultado é esta ferramenta fantástica que construímos juntos, passando por todas as fases de desenvolvimento e depuração.

**Obrigado, e que a farm de horas comece!** 🏆
