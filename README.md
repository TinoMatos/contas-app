# Controle Financeiro

App web de finanças pessoais: lançamentos do mês, contas fixas, caixas
(carteiras), transferências e acompanhamento de investimentos.

Funciona no navegador e também instalado como app no celular (PWA), com
acesso offline à interface.

**No ar:** https://contas-app-production-28f3.up.railway.app

---

## O que dá para fazer

### Perfis
Cada conta de usuário pode ter vários **perfis** (ex.: "Tino", "Casa",
"Empresa"), cada um com seus próprios lançamentos, contas e caixas
totalmente separados. Um perfil "Principal" é criado junto com a conta.

### Lançamentos
Receitas ("Recebido") e despesas ("Pago"), cada uma com descrição,
categoria, valor, data e — opcionalmente — o caixa de onde o dinheiro
saiu ou entrou. A tela abre filtrada pelo mês corrente; "Ver tudo" mostra
o histórico inteiro.

### Contas fixas (lembretes)
Um lançamento pode ser marcado como **"Repetir todo mês"**. Ele vira uma
conta fixa com um dia de vencimento e passa a aparecer na lista de
lembretes do mês, com um botão **"Já paguei"** que gera o lançamento real
daquele mês. Contas marcadas para o dia 29, 30 ou 31 caem no último dia
de meses mais curtos, em vez de sumir.

Lembretes já quitados ficam escondidos atrás de um botão, para a lista
mostrar só o que ainda falta.

### Caixas
Caixas são onde o dinheiro fica: conta do banco, dinheiro vivo, poupança.
Cada um tem um **saldo inicial** e uma **data de referência** — lançamentos
anteriores a essa data já estão embutidos no saldo inicial e não são
descontados de novo. O card "Total que tenho" soma todos os caixas.

Um lançamento pode ser tirado do caixa sem ser apagado, quando ele não
deve mexer no saldo.

### Transferências
Mover dinheiro entre dois caixas. Transferência **não** conta como receita
nem como despesa — só muda o saldo de lado, sem poluir o total do mês.

### Investimentos
Cadastre o que está guardado (CDB, ações, fundos) e vá anotando o valor
atual de vez em quando. Comparando os dois últimos registros e a distância
em dias entre eles, o app estima **quanto rende por mês** — normalizado,
então funciona mesmo que você atualize em intervalos irregulares.

### Extras
- **Calculadora** embutida na barra de cima
- **Bloqueio biométrico** (digital/rosto) para reabrir o app
- **Cor de fundo** escolhida por você entre 8 temas, salva no aparelho

---

## Como é feito

| Camada | O que usa |
|---|---|
| Servidor | Node.js + Express ([server.js](server.js)) |
| Banco | PostgreSQL (`pg`) |
| Login | JWT (`jsonwebtoken`) + senhas em hash (`bcryptjs`) |
| Interface | HTML/CSS/JS puro, sem framework ([public/index.html](public/index.html)) |
| Offline | Service worker ([public/sw.js](public/sw.js)) |
| Hospedagem | Railway (deploy automático a cada push na `main`) |

O front-end inteiro é um arquivo só, servido como estático. Não há build:
o que está no repositório é o que roda.

As tabelas são criadas e migradas pelo próprio servidor no boot
(`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`),
então subir uma versão nova não exige rodar migração à mão.

### Tabelas

```
users ──┬── profiles ──┬── transactions ──── box_id → cash_boxes
        │              ├── recurring_bills ── box_id → cash_boxes
        │              ├── cash_boxes
        │              ├── transfers (from_box_id, to_box_id)
        │              └── investments ──── investment_snapshots
```

---

## Rodando na sua máquina

Precisa de Node.js 18+ e um PostgreSQL acessível.

```bash
npm install

# variáveis obrigatórias
export DATABASE_URL="postgresql://usuario:senha@host:5432/banco"
export JWT_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")"

npm start        # http://localhost:3000
```

### Variáveis de ambiente

| Variável | Obrigatória | Para que serve |
|---|---|---|
| `DATABASE_URL` | sim | Conexão com o PostgreSQL |
| `JWT_SECRET` | sim | Assina os tokens de login (mínimo 16 caracteres) |
| `PORT` | não | Porta do servidor (padrão `3000`) |
| `PGSSLROOTCERT` | não | Caminho para um CA próprio, se o banco usa certificado que não está no bundle do sistema |
| `DATABASE_SSL_INSECURE` | não | `true` desliga a validação do certificado do banco. Só como último recurso — deixa a conexão aberta a man-in-the-middle |

Sobre TLS: quando `DATABASE_URL` aponta para a rede interna do Railway
(`*.railway.internal`) ou `localhost`, o SSL fica desligado porque o tráfego
não sai do projeto. Para qualquer outro host o certificado **é validado**.
Se a conexão passar a falhar com `self signed certificate`, aponte o CA em
`PGSSLROOTCERT` em vez de recorrer a `DATABASE_SSL_INSECURE`.

O servidor **se recusa a subir** sem `DATABASE_URL` ou sem um `JWT_SECRET`
válido. É proposital: melhor falhar no boot do que rodar com uma chave
fraca e aceitar tokens forjados.

Nunca coloque esses valores em arquivo dentro do repositório — o
`.gitignore` já bloqueia `.env`, mas o lugar certo deles é nas variáveis
do serviço de hospedagem.

---

## Segurança

- Senhas guardadas só como hash bcrypt, nunca em texto puro
- Toda rota da API (fora de login e cadastro) exige token JWT válido
- Toda consulta filtra por `user_id` **e** `profile_id`: um usuário não
  alcança dado de outro nem trocando o id na URL
- Todas as queries são parametrizadas (`$1, $2...`), sem SQL injection
- Nenhum segredo no código ou no histórico do Git

O repositório ser público expõe o **código**, não os dados. As chaves
vivem só nas variáveis de ambiente do servidor.

---

## API

Autenticação por header `Authorization: Bearer <token>`, e o perfil ativo
vai em `X-Profile-Id`.

| Método | Rota | O que faz |
|---|---|---|
| POST | `/api/register` | Cria conta (senha de 8+ caracteres) |
| POST | `/api/login` | Devolve o token |
| GET POST PUT DELETE | `/api/profiles` `/api/profiles/:id` | Perfis |
| GET POST PUT DELETE | `/api/transactions` `/api/transactions/:id` | Lançamentos |
| GET POST PUT DELETE | `/api/recurring` `/api/recurring/:id` | Contas fixas |
| GET POST PUT DELETE | `/api/boxes` `/api/boxes/:id` | Caixas |
| GET POST DELETE | `/api/transfers` `/api/transfers/:id` | Transferências |
| GET POST PUT DELETE | `/api/investments` `/api/investments/:id` | Investimentos |
| GET POST | `/api/investments/:id/snapshots` | Valores registrados |
| DELETE | `/api/investments/:id/snapshots/:sid` | Apaga um valor |
| GET | `/health` | Checagem do serviço |

---

## Publicando uma versão

`git push` na `main` já dispara o deploy no Railway.

Um detalhe fácil de esquecer: ao mudar `index.html`, suba a versão do
cache em [public/sw.js](public/sw.js) (`const CACHE = 'fin-vNN'`). Sem
isso, quem tem o app instalado continua vendo a versão antiga guardada
no aparelho.
