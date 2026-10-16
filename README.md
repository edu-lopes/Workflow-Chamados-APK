# Workflow Datapar — Fluxo de E-mails e Chamados

App (Expo / React Native) + API (Node.js / Express / MySQL) que lê os e-mails do
Workflow no Gmail, transforma em tickets com histórico de interações e avisa a
equipe por push.

```
.
├── app/                 Telas (Expo Router)
│   ├── _layout.tsx      Fontes, sessão, guarda de rotas, push
│   ├── index.tsx        Redireciona para /home ou /login
│   ├── login.tsx        Login + conexão da conta Google
│   ├── home.tsx         Lista de tickets
│   ├── settings.tsx     Tema, cor do ícone, sair
│   ├── ticket/[id].tsx  Chat de interações do ticket
│   └── google-connected.tsx  Retorno do OAuth no Android
├── src/                 Lógica do app
│   ├── api.ts           Cliente HTTP único (URL, token seguro, timeout, cache offline)
│   ├── session.tsx      Sessão do usuário + preferências
│   ├── push.ts          Notificações push
│   └── ui.tsx           Componentes compartilhados
├── backend/             API
│   └── src/
│       ├── server.ts    Boot, shutdown, sincronização agendada
│       ├── app.ts       Express: segurança, logs, rotas, erros
│       ├── core.ts      Config validada, logger, banco, auth
│       ├── cli.ts       Administração de usuários
│       └── modules/     users · tickets · notifications · gmail
│   └── database/        schema.sql + migrations/
└── deploy/              Debian: setup.sh, diagnostico.sh, systemd, Caddy (HTTPS), DuckDNS
```

---

## 1. Deploy da API no Debian

### Arquitetura

```
Celular ──HTTPS :8443──▶ apkchamados.duckdns.org ──▶ roteador (8443) ──▶ Caddy :8443 ──▶ 127.0.0.1:8080 (API) ──▶ MariaDB
```

- **Servidor compartilhado:** nada usa as portas 80/443. O Caddy escuta **somente na 8443**.
- **DuckDNS** traduz o nome para o IP da internet (não é proxy) e também é usado
  para validar o certificado HTTPS **por DNS** — nenhuma porta precisa estar
  aberta para o Let's Encrypt.
- A **API** escuta só em `127.0.0.1:8080`: ninguém acessa a 8080 de fora.
- O `setup.sh` baixa o Caddy oficial com o plugin DuckDNS (o pacote do Debian
  não tem plugins) e trava o pacote com `apt-mark hold caddy`.

### Pré-requisitos

1. **Roteador:** encaminhar a porta **8443** (TCP) para o IP interno do servidor (`hostname -I`).
2. **Firewall do Debian** (se usar ufw): `sudo ufw allow 8443/tcp`
3. **Google Cloud Console → Credenciais → Cliente OAuth ("Aplicativo da Web"):**
   em *URIs de redirecionamento autorizados*, adicionar
   `https://apkchamados.duckdns.org:8443/auth/google/callback`.
4. **Token do DuckDNS** (painel duckdns.org). Se já existir um atualizador
   (`/opt/duckdns.sh`), o `setup.sh` copia o token dele automaticamente.
5. Sem **CGNAT**: o *IP WAN* do roteador deve ser igual ao IP público
   (`curl -4 https://api.ipify.org`). Com CGNAT nenhuma porta chega ao servidor.

### Instalação (e atualização)

```bash
cd /var/www/html/workflow-chamados
chmod +x deploy/*.sh                     # necessário se os arquivos vieram do Windows
sudo ./deploy/setup.sh                   # 1ª vez: cria os arquivos de configuração e para
sudo nano /etc/fluxo-api/fluxo-api.env   # DB_*, GOOGLE_*, GOOGLE_REDIRECT_URI com :8443
sudo nano /etc/fluxo-api/https.env       # HTTPS_PORT=8443 e DUCKDNS_API_TOKEN
sudo ./deploy/setup.sh                   # compila, sobe a API, configura o HTTPS e aguarda o certificado
```

Para **atualizar** depois: atualize a pasta do projeto e rode `sudo ./deploy/setup.sh`.

| Caminho | Conteúdo |
|---|---|
| `/var/www/html/workflow-chamados` | Código-fonte (de onde se roda o `setup.sh`) |
| `/var/www/html/fluxo-chamados` | API compilada que o serviço executa (gerada pelo setup) |
| `/etc/fluxo-api/fluxo-api.env` | Variáveis da API (segredos) |
| `/etc/fluxo-api/https.env` | Porta HTTPS e token DuckDNS (usado só pelo Caddy) |
| `/etc/caddy/Caddyfile` | Gerado pelo setup — não edite à mão |

> O setup para com uma mensagem clara se: a porta 8443 ou 8080 estiver ocupada
> por outro programa, o `GOOGLE_REDIRECT_URI` não for exatamente
> `https://<domínio>:<HTTPS_PORT>/auth/google/callback`, ou faltar o token.

### Passo a passo de testes

1. **No servidor:** `sudo ./deploy/diagnostico.sh apkchamados.duckdns.org` —
   o item 6 deve estar todo ✔ (API, Caddy com plugin, HTTPS local 200 e nenhum
   uso das portas 80/443).
2. **Certificado:** `journalctl -u caddy --since "10 min ago" | grep -iE "obtained|error"`
   deve mostrar `certificate obtained successfully`.
3. **De fora da rede** (celular com Wi-Fi **desligado**, no 4G):
   `https://apkchamados.duckdns.org:8443/health` → `{"status":"ok","db":"connected"...}`.

| Resultado do passo 3 | Causa provável |
|---|---|
| Responde com cadeado | Tudo certo |
| Não carrega, mas o passo 1 está ✔ | Encaminhamento da 8443 no roteador, firewall ou CGNAT |
| Erro de certificado | Certificado ainda não emitido (passo 2) |

> Testar pelo Wi-Fi da própria rede pode falhar mesmo com tudo certo (muitos
> roteadores não fazem *NAT loopback*). Teste sempre pelo 4G.

### Migrando do serviço antigo

Se a porta 8080 estiver ocupada pela versão antiga, o `setup.sh` mostra o
processo. Conforme o caso:

```bash
pm2 ls && pm2 delete NOME && pm2 save         # se estiver no pm2
sudo systemctl disable --now NOME-DO-SERVICO  # se for um serviço systemd
```

A pasta antiga (`/opt/chamados-backend`) pode ser removida depois da validação.
**Não remova `/opt/duckdns.sh`**: é o atualizador de IP do DuckDNS.

## 2. Logs e diagnóstico

| O que ver | Comando |
|---|---|
| Diagnóstico completo (rede, portas, DuckDNS, API) | `sudo ./deploy/diagnostico.sh` |
| Log da API ao vivo | `journalctl -u fluxo-api -f` |
| Últimos erros | `journalctl -u fluxo-api -p err -n 50` |
| Status do serviço | `systemctl status fluxo-api` |
| HTTPS / certificado | `journalctl -u caddy -f` |
| Acessos HTTP (Caddy) | `journalctl -u caddy -f` |
| API respondendo (local) | `curl http://127.0.0.1:8080/health` |
| API respondendo (internet) | `curl https://apkchamados.duckdns.org:8443/health` |

Cada resposta traz o cabeçalho `X-Request-Id`; procure-o no journal para achar a
requisição exata. Erros de configuração (variável faltando, senha do banco
errada, porta ocupada) aparecem **na inicialização** com mensagem explícita.

**No celular:** a tela de login mostra o servidor configurado no rodapé — toque
nele para testar a conexão. Mensagens de erro de rede incluem a URL usada.
Para log nativo do APK: `adb logcat | grep -iE "ReactNativeJS|expo"`.

---

## 3. Publicar o app

Há dois jeitos de levar uma mudança aos celulares:

| Mudou | Como publicar | Usuário precisa reinstalar? |
|---|---|---|
| Telas, textos, regras do app (`app/`, `src/`), imagens usadas nas telas | **Atualização pelo ar:** `npm run update -- --message "o que mudou"` | Não. O app baixa sozinho e pergunta se pode reiniciar |
| Ícone, splash, nome, permissões, `app.json` (parte nativa), biblioteca nova com código nativo, versão do Expo | **APK novo:** `eas build -p android --profile production` | Sim |
| Só a API (`backend/`) | `sudo bash deploy/setup.sh` no servidor | Não |

### Atualização pelo ar (EAS Update)

```bash
cd /var/www/html/workflow-chamados      # ou a pasta do projeto no seu PC
npm run update -- --message "Corrige status finalizado"
```

- O app verifica ao abrir e ao voltar para ele (no máximo a cada 10 min), baixa em
  segundo plano e mostra **"Atualização disponível — Reiniciar?"**. Se a pessoa
  escolher "Depois", a versão nova entra na próxima vez que o app for aberto.
- Em *Configurações*, o rodapé mostra a versão e a data da atualização em uso.
- **Desfazer** uma atualização com problema: `eas update:republish --channel production`
  (escolha a anterior) ou `eas update:rollback`.
- Testar antes com quem tem o APK `preview`: `npm run update:preview -- --message "..."`.
- Plano gratuito do Expo: até 1.000 usuários/mês recebendo atualizações, sem limite de publicações.

### Quando é obrigatório gerar APK novo

A atualização só chega a APKs com a **mesma versão** (`"version"` do `app.json`,
política `runtimeVersion: appVersion`). Regra prática:

1. Mudança só de código/telas → **não** mexa na versão; use `npm run update`.
2. Mudança nativa (lista acima) → **aumente** a versão no `app.json`
   (ex.: 2.1.0 → 2.2.0), gere o APK e distribua. Atualizações seguintes usam a nova versão.

A URL da API vem do `app.json` (`extra.apiUrl`) — vale para APK e atualizações.
`EXPO_PUBLIC_API_URL` (no `.env` ou no `eas.json`) tem prioridade, útil em desenvolvimento.

### Build do APK

```bash
eas build -p android --profile production   # produção (canal "production")
eas build -p android --profile preview      # teste (canal "preview")
```

### Desenvolvimento local

```bash
# API
cd backend
cp .env.example .env        # ajuste; use HOST=0.0.0.0 e NODE_ENV=development
npm install
npm run dev

# App (outro terminal, na raiz)
cp .env.example .env        # EXPO_PUBLIC_API_URL
npm install
npx expo start
```

**Celular em outra rede (via USB):** ative *Depuração USB*, conecte o cabo e rode
`adb reverse tcp:8081 tcp:8081` e `adb reverse tcp:8080 tcp:8080`. Com
`EXPO_PUBLIC_API_URL=http://localhost:8080` o app alcança a API da sua máquina.
O `adb` vem no Android SDK Platform-Tools; o build Android local exige JDK 17 64-bit.

---

## 4. Banco de dados

MariaDB 10.11, banco `fluxo_workflow`. A estrutura completa está em
`backend/database/schema.sql` (8 tabelas: `users`, `user_settings`,
`user_push_tokens`, `google_tokens`, `tickets`, `interactions`,
`notifications`, `user_notifications`).

### Banco existente — aplicar a migração de índices (uma vez)

Não altera dados nem colunas; só cria/troca índices. Pode rodar de novo sem problema.

```bash
cd fluxo-emails-chamados/backend/database
sudo mysqldump --single-transaction fluxo_workflow > ~/backup_antes_001.sql
sudo mysql fluxo_workflow < migrations/001_indices.sql
```

| Tabela | Índice | Para quê |
|---|---|---|
| `interactions` | `idx_ticket_data_tipo (ticket_id, data_evento, tipo_evento)` | Listagem, detalhe e status do ticket (substitui `ticket_id`) |
| `user_notifications` | `idx_notification_lido (notification_id, lido)` | "Lido por" (substitui `notification_id`) |
| `user_push_tokens` | `idx_push_token (expo_push_token)` | Remoção de tokens inválidos |

### Migração 002 — interações com "Texto do Evento" vazio (uma vez)

Corrige interações gravadas antes da v2.1, quando um "Texto do Evento" vazio
fazia a API gravar a linha seguinte ("Usuario Interação : ...") como texto.
Interações sem texto do **Suporte APK** passam a ser **finalizações**.
Só altera dados; mostra uma prévia antes e pode ser executada mais de uma vez.

```bash
mysqldump -h 127.0.0.1 -u root -p --single-transaction fluxo_workflow > ~/backup_antes_002.sql
mysql -h 127.0.0.1 -u root -p fluxo_workflow < backend/database/migrations/002_corrige_texto_vazio.sql
```

### Usuário do banco para a API

A API só precisa ler e gravar dados (a migração acima roda como root):

```sql
CREATE USER IF NOT EXISTS 'fluxo'@'localhost' IDENTIFIED BY 'senha-forte';
GRANT SELECT, INSERT, UPDATE, DELETE ON fluxo_workflow.* TO 'fluxo'@'localhost';
FLUSH PRIVILEGES;
```

### Instalação nova (banco vazio)

```bash
sudo mysql -e "CREATE DATABASE fluxo_workflow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
sudo mysql fluxo_workflow < backend/database/schema.sql
```

## 5. Administração de usuários

Rode no servidor, a partir da pasta da API compilada:

```bash
cd /var/www/html/fluxo-chamados
CLI="sudo -u fluxo node --env-file=/etc/fluxo-api/fluxo-api.env dist/cli.js"

$CLI list-users                                   # lista id, nome e e-mail
$CLI reset-password 3 'NovaSenha123'              # redefine a senha do usuário de ID 3
$CLI create-user "Nome Completo" email@apk.com.br # pede a senha no terminal
$CLI set-password email@apk.com.br                # redefine pelo e-mail, pedindo a senha no terminal
```

- `reset-password <id> <nova-senha>`: mínimo de 8 caracteres. Use **aspas simples**
  quando a senha tiver espaço ou caracteres como `!`, `$`, `&`.
- A senha passada como parâmetro fica no histórico do shell (`~/.bash_history`).
  Para não gravar, rode antes `export HISTCONTROL=ignorespace` e comece o comando
  com um **espaço**, ou use `set-password`, que pede a senha sem mostrá-la.
- O usuário continua logado nos aparelhos onde já estava até o token expirar
  (`JWT_EXPIRES_IN`); a senha nova vale para os próximos logins.

## 6. Referência da API

Todas as rotas, exceto `/health`, `/users/login` e `/auth/google/callback`,
exigem `Authorization: Bearer <token>`.

| Método | Rota | Descrição |
|---|---|---|
| GET | `/health` | Saúde da API e do banco |
| POST | `/users/login` | Login → `{ user, token, settings }` |
| GET / POST | `/users` | Listar / criar usuário |
| GET | `/users/settings` | Preferências |
| PUT | `/users/settings/icon-color` | `{ color: "#RRGGBB" }` |
| PUT | `/users/settings/dark-mode` | `{ enabled: boolean }` |
| POST / DELETE | `/users/push-token` | `{ expoPushToken }` |
| GET | `/tickets` | Tickets dos últimos `TICKETS_MONTHS` meses |
| GET | `/tickets/:ticketId` | Detalhe com interações e leitores |
| GET | `/notifications` | Notificações não lidas |
| GET | `/notifications/unread-tickets` | IDs dos tickets não lidos |
| PUT | `/notifications/ticket/:ticketId/read-all` | Marca o ticket como lido |
| PUT | `/notifications/:id/read` | Marca uma notificação |
| GET | `/notifications/readers/:interactionId` | Quem leu a interação |
| GET | `/auth/google?redirect=` | URL de autorização do Gmail |
| GET | `/auth/google/status` | `{ connected }` |
| POST | `/sync` | Sincroniza e-mails novos |

Erros seguem o formato `{ "error": "mensagem", "code": "CODIGO" }`
(ex.: `GOOGLE_NOT_CONNECTED`, `UNAUTHENTICATED`, `VALIDATION`).

> **Sincronização:** percorre as páginas do Gmail (mais recentes primeiro) até
> alcançar e-mails já gravados, então recupera atrasos de semanas sem lacunas
> (teto por execução: `GMAIL_SYNC_LIMIT`, padrão 3000). Quando mais de 10 e-mails
> chegam de uma vez, é enviado um único push-resumo em vez de um por e-mail.
>
> **Status "Finalizado":** a última interação do chamado é do Suporte APK com o
> "Texto do Evento" vazio (usuários configuráveis em `FINALIZACAO_USUARIOS`).
>
> **Aviso de Google desconectado:** quando a sincronização para por falta de
> autorização, todos os aparelhos recebem um push ("Sincronização de chamados
> parada"); tocar nele abre a tela de reconexão. O aviso se repete a cada
> `GOOGLE_ALERT_REMINDER_HOURS` (padrão 24h) até reconectar. Ao abrir o app, a
> Home também avisa se o Google estiver desconectado.
>
> **Erro `GOOGLE_CLIENT_INVALID`:** a credencial OAuth foi excluída no Google
> Cloud. Crie outra (tipo "Aplicativo da Web"), atualize `GOOGLE_CLIENT_ID` e
> `GOOGLE_CLIENT_SECRET` em `/etc/fluxo-api/fluxo-api.env`, reinicie a API e
> conecte o Google novamente pelo app.
>
> **Google OAuth em modo "Teste":** o Google invalida o refresh token a cada
> 7 dias. Se o app pedir para reconectar o Google toda semana, publique o app
> OAuth (Tela de consentimento → *Publicar app*).
