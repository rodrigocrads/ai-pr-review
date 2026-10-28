/**
 * Autenticação com o SEU usuário Microsoft (Entra ID), sem API key nem PAT.
 *
 * Ordem tentada:
 *  1. Sessão já logada: Azure CLI (`az login`), Azure Developer CLI (`azd auth login`)
 *     ou Azure PowerShell (`Connect-AzAccount`)
 *  2. Se AZURE_AUTH_INTERACTIVE=true: abre o navegador para você logar
 */
import {
  AzureCliCredential,
  AzureDeveloperCliCredential,
  AzurePowerShellCredential,
  ChainedTokenCredential,
  InteractiveBrowserCredential,
  type TokenCredential,
} from "@azure/identity";

/** Escopo do Azure OpenAI / Azure AI Services. */
export const SCOPE_AZURE_OPENAI = "https://cognitiveservices.azure.com/.default";
/** Escopo fixo do Azure DevOps (ID do recurso "Azure DevOps" no Entra). */
export const SCOPE_AZURE_DEVOPS = "499b84ac-1321-427f-aa17-267ca6975798/.default";

let credential: TokenCredential | undefined;

function getCredential(): TokenCredential {
  if (credential) return credential;
  const tenantId = process.env.AZURE_TENANT_ID?.trim() || undefined;
  // Só credenciais de usuário em máquina local (sem Managed Identity, que demora a falhar fora do Azure).
  const chain: TokenCredential[] = [
    new AzureCliCredential({ tenantId }),
    new AzureDeveloperCliCredential({ tenantId }),
    new AzurePowerShellCredential({ tenantId }),
  ];
  if ((process.env.AZURE_AUTH_INTERACTIVE ?? "").toLowerCase() === "true") {
    chain.push(new InteractiveBrowserCredential({ tenantId }));
  }
  credential = new ChainedTokenCredential(...chain);
  return credential;
}

const cache = new Map<string, { token: string; expiresAt: number }>();

/** Token Bearer para o escopo pedido, com cache até 5 min antes de expirar. */
export async function getEntraToken(scope: string): Promise<string> {
  const hit = cache.get(scope);
  if (hit && hit.expiresAt - Date.now() > 5 * 60_000) return hit.token;

  try {
    const t = await getCredential().getToken(scope);
    if (!t) throw new Error("nenhum token retornado");
    cache.set(scope, { token: t.token, expiresAt: t.expiresOnTimestamp });
    return t.token;
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(
      `Não consegui autenticar com seu usuário Microsoft (${scope}).\n` +
        "  • Rode `az login` (ou `az login --tenant <id-do-tenant>`) e tente de novo, ou\n" +
        "  • defina AZURE_AUTH_INTERACTIVE=true no .env para logar pelo navegador.\n" +
        `  Detalhe: ${detail}`,
    );
  }
}
