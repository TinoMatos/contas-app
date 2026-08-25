# Janela de manutenção — patch do PostgreSQL 18.6

Contexto: o Postgres de produção roda uma versão anterior a 18.6 e está
exposto às 28 CVEs corrigidas no lote de 13/08/2026. Janela combinada:
**Sáb 10:00 → Dom 18:00 UTC**. Snapshot de volume retido por 30 dias.

## Antes

- [ ] Confirmar a versão atual: `SELECT version();`
- [ ] Tirar o snapshot do volume e **verificar que ele aparece na lista**
      antes de seguir. Snapshot não confirmado não conta.
- [ ] Atualizar o `psql`/`pg_dump` da sua máquina para 18.6 também.
      CVE-2026-18408 (8.8) e CVE-2026-6464 (8.1) atingem o *cliente*, não o
      servidor: um `pg_dump` desatualizado contra um servidor hostil executa
      código na sua máquina. O passo de backup é o momento de exposição.
- [ ] Anotar a connection string atual e onde ela está configurada.

## Patch

- [ ] Aplicar o update no console do Railway (serviço Postgres → última
      release 18.x).
- [ ] Aguardar o serviço voltar a `healthy`.

## Verificação

- [ ] `SELECT version();` → deve mostrar 18.6 ou superior.
- [ ] App sobe sem erro nos logs. Atenção especial a falha de TLS: a
      validação de certificado passou a ser exigida fora da rede interna
      (ver README). Se aparecer `self signed certificate`, aponte o CA em
      `PGSSLROOTCERT`.
- [ ] Login funciona.
- [ ] Um lançamento é criado e aparece no extrato.
- [ ] Contagem de linhas bate com antes:
      `SELECT count(*) FROM users; SELECT count(*) FROM transactions;`

## Rollback

Restaurar o snapshot. Como o patch é dentro da mesma major (18.x), não há
mudança de formato no diretório de dados — o rollback é direto. Se fosse
upgrade de major, seria outra história.

## Pendência separada: privilégio do usuário do banco

Verificar com que usuário a aplicação conecta:

```sql
SELECT current_user, usesuper FROM pg_user WHERE usename = current_user;
```

Se for superuser, várias dessas CVEs — as de "escalada para superuser" —
ficam sem sentido: o atacante que chegar a executar SQL já está lá. Criar um
usuário com `SELECT/INSERT/UPDATE/DELETE` apenas nas tabelas da aplicação
protege mais do que o patch. Isso é trabalho separado, não faça na mesma
janela.
