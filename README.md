# ai-pr-review

Revisão de Pull Requests do **Azure DevOps** com IA, para repositórios **Angular** e **C#**.
Roda na sua máquina com o **seu PAT**: não precisa de pipeline, extensão nem permissão de administrador.

```
PR (Azure DevOps) ──► diff com nº de linha ──► IA + regras do time ──► relatório local
                                                                   └─► (--post) comentários no PR
```

## Requisitos

- Node.js 20 ou superior
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) para entrar com o seu usuário Microsoft
- Acesso a uma IA, de uma destas formas:
  - **Azure OpenAI com o seu usuário (sem API key)**: seu usuário precisa da função
    **Cognitive Services OpenAI User** no recurso; você também precisa do *endpoint* e do *nome do deployment*
  - ou uma API key de Azure OpenAI, Anthropic ou OpenAI

## Configuração recomendada: GitHub Copilot + seu login Microsoft

Nenhuma API key e nenhum PAT: o Azure DevOps é lido com o seu `az login` e a IA é a sua licença do Copilot.

```bash
npm install -g @github/copilot
copilot                           # 1ª vez: /login com a conta GitHub da licença; depois /exit
echo "responda apenas: ok" | copilot -s    # deve imprimir "ok"
az login
```

No `.env`:

```ini
AZDO_AUTH=entra
AI_PROVIDER=copilot
COPILOT_MODEL=                    # opcional; veja os modelos com /model dentro do copilot
```

O script roda a CLI do Copilot numa pasta temporária vazia, envia o diff pela entrada padrão e
**não** libera nenhuma ferramenta: ela não executa comandos nem altera arquivos, só responde.

## Autenticação com o seu usuário (sem API key e sem PAT)

```bash
az login                          # ou: az login --tenant <id-do-tenant-da-empresa>
```

No `.env`:

```ini
AZDO_AUTH=entra                   # Azure DevOps com o seu login
AI_PROVIDER=azure-openai
AZURE_OPENAI_ENDPOINT=https://<recurso>.openai.azure.com
AZURE_OPENAI_DEPLOYMENT=<nome-do-deployment>
AZURE_OPENAI_API_KEY=             # vazio = usa o seu login
```

O script pede tokens ao `az` (ou ao `azd` / Azure PowerShell, se você usar um deles). Sem nenhum deles,
defina `AZURE_AUTH_INTERACTIVE=true` para logar pelo navegador.

> `AZDO_AUTH=entra` funciona no Azure DevOps Services (`dev.azure.com` / `*.visualstudio.com`).
> No Azure DevOps Server on-premises, use `AZDO_AUTH=pat` com um PAT.
> Com PAT, os escopos são **Code (Read)** para revisar e **Code (Read & write)** para postar.

## Instalação

```bash
npm install
cp .env.example .env    # preencha conforme a seção acima
```

## Uso

```bash
# 1) Simulação: revisa e salva o relatório em ./reviews, sem tocar no PR
npm run review -- https://dev.azure.com/org/Projeto/_git/Repo/pullrequest/123

# 2) Publica os comentários no PR (aparecem em seu nome)
npm run review -- https://dev.azure.com/org/Projeto/_git/Repo/pullrequest/123 --post
```

| Opção | Padrão | O que faz |
|---|---|---|
| `--post` | desligado | Publica os comentários no PR |
| `--min-severity` | `minor` | `critical`, `major`, `minor` ou `suggestion` |
| `--max-comments` | `25` | Limite de comentários de linha por execução |
| `--no-summary` | desligado | Não posta o comentário de resumo |
| `--out` | `./reviews` | Pasta do relatório (`.md` e `.json`) |
| `--rules` | `./rules` | Pasta com as regras do time |

Também aceita URLs `*.visualstudio.com` e Azure DevOps Server on-premises (`https://servidor/tfs/Colecao/...`).

## Como funciona

1. Lê o PR, a última iteração e os arquivos alterados pela REST API.
2. Compara cada arquivo entre o **merge-base** e o último commit do PR e monta um diff com o número da linha nova.
3. Ignora lock files, arquivos gerados (`*.Designer.cs`, migrations, `dist`, `bin/obj`), binários e arquivos removidos.
4. Detecta a stack de cada arquivo e envia à IA, em lotes, junto com `rules/common.md` e `rules/angular.md` e/ou `rules/csharp.md`.
5. **Valida cada achado**: descarta arquivos que não estão no PR e ajusta linhas que a IA errou por pouco. Achados sem linha válida vão para o comentário de resumo.
6. Com `--post`, cria um comentário por achado na linha certa e um resumo geral. Rodar de novo **não duplica** comentários já postados (marcador `fp:` no rodapé).

## Personalizando

- **Regras do time**: edite os arquivos em `rules/`. É aqui que a qualidade da revisão realmente melhora.
- **Ignorar mais arquivos**: `REVIEW_EXTRA_IGNORE=**/generated/**,**/*.spec.ts`
- **Idioma**: `REVIEW_LANGUAGE=English`
- **Gateway corporativo**: `ANTHROPIC_BASE_URL` (Anthropic) ou use `AI_PROVIDER=azure-openai`.

## Problemas comuns

| Mensagem | Causa provável |
|---|---|
| `Comando "copilot" não encontrado` | Rode `npm install -g @github/copilot` e abra um terminal novo |
| `A CLI "copilot" terminou com código 1` | Rode `copilot` interativo e faça `/login`; confira se a licença permite a CLI |
| `não respondeu em 600s` | PR grande: reduza `REVIEW_BATCH_CHARS` ou aumente `COPILOT_TIMEOUT_SECONDS` |
| `Não consegui autenticar com seu usuário Microsoft` | Rode `az login` (com `--tenant` se tiver mais de um) |
| `IA recusou o acesso (401/403)` | Seu usuário não tem a função *Cognitive Services OpenAI User* no recurso |
| `IA respondeu 404` | Endpoint ou nome do deployment errado |
| `redirecionou para login` / `401` no Azure DevOps | PAT inválido, ou login de um tenant diferente do da organização (`AZURE_TENANT_ID`) |
| `403 Sem permissão` | PAT sem o escopo necessário (para `--post`: Code Read & write) |
| `unable to get local issuer certificate` | Proxy corporativo com certificado próprio: `export NODE_EXTRA_CA_CERTS=/caminho/ca-empresa.pem` |
| Comentário em `(linha aproximada)` | A IA citou uma linha fora do diff e o script a aproximou |

## Segurança

- O código do PR é enviado **somente** ao provedor de IA configurado no `.env`.
- Nunca versione o `.env` (já há `.gitignore`).
- Os comentários são **sugestões de IA**: a aprovação do PR continua sendo humana.
