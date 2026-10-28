/**
 * Provedores de IA via fetch (sem SDKs). Troque o provedor pela variável AI_PROVIDER.
 * O diff vai SOMENTE para o endpoint do provedor configurado aqui.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEntraToken, SCOPE_AZURE_OPENAI } from "./auth.js";

export interface LlmClient {
  name: string;
  complete(system: string, user: string): Promise<string>;
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Variável de ambiente ${name} não definida (veja .env.example).`);
  return v;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    // limite de taxa / sobrecarga: tenta de novo com espera crescente
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 4) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 2000 * attempt;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `IA recusou o acesso (${res.status}). Com login Entra ID, seu usuário precisa da função ` +
          `"Cognitive Services OpenAI User" no recurso Azure OpenAI. Detalhe: ${text.slice(0, 300)}`,
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`IA respondeu ${res.status}: ${text.slice(0, 500)}`);
    }
    return res.json();
  }
}

function anthropic(): LlmClient {
  const key = required("ANTHROPIC_API_KEY");
  const model = process.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-5-5";
  // permite apontar para um gateway/proxy corporativo
  const baseUrl = (process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
  return {
    name: `anthropic:${model}`,
    async complete(system, user) {
      const data = await postJson(
        `${baseUrl}/v1/messages`,
        { "x-api-key": key, "anthropic-version": "2023-06-01" },
        { model, max_tokens: 8000, system, messages: [{ role: "user", content: user }] },
      );
      return (data.content ?? [])
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");
    },
  };
}

function openai(): LlmClient {
  const key = required("OPENAI_API_KEY");
  const model = required("OPENAI_MODEL");
  return {
    name: `openai:${model}`,
    async complete(system, user) {
      const data = await postJson(
        "https://api.openai.com/v1/chat/completions",
        { Authorization: `Bearer ${key}` },
        {
          model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
      );
      return data.choices?.[0]?.message?.content ?? "";
    },
  };
}

function azureOpenai(): LlmClient {
  const endpoint = required("AZURE_OPENAI_ENDPOINT").replace(/\/+$/, "");
  const deployment = required("AZURE_OPENAI_DEPLOYMENT");
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION?.trim() || "2024-10-21";
  // Sem API key → usa o seu login Microsoft (Entra ID).
  const key = process.env.AZURE_OPENAI_API_KEY?.trim();
  const authHeaders = async (): Promise<Record<string, string>> =>
    key ? { "api-key": key } : { Authorization: `Bearer ${await getEntraToken(SCOPE_AZURE_OPENAI)}` };

  return {
    name: `azure-openai:${deployment} (${key ? "api-key" : "seu usuário Entra ID"})`,
    async complete(system, user) {
      const data = await postJson(
        `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${apiVersion}`,
        await authHeaders(),
        {
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
      );
      return data.choices?.[0]?.message?.content ?? "";
    },
  };
}

export function createLlm(): LlmClient {
  const provider = (process.env.AI_PROVIDER ?? "anthropic").trim().toLowerCase();
  switch (provider) {
    case "anthropic":
      return anthropic();
    case "openai":
      return openai();
    case "azure-openai":
    case "azure":
      return azureOpenai();
    case "copilot":
      return copilotCli();
    default:
      throw new Error(`AI_PROVIDER desconhecido: ${provider} (use copilot, azure-openai, anthropic ou openai).`);
  }
}

// ─── GitHub Copilot CLI (usa o SEU login do GitHub, sem API key) ──────

function copilotCli(): LlmClient {
  const bin = process.env.COPILOT_BIN?.trim() || "copilot";
  const model = process.env.COPILOT_MODEL?.trim();
  const timeoutMs = Number(process.env.COPILOT_TIMEOUT_SECONDS ?? 600) * 1000;

  // -s: só a resposta, sem estatísticas. Sem --allow-*: a CLI não pode rodar comandos nem editar arquivos.
  const args = ["-s", ...(model ? [`--model=${model}`] : [])];

  return {
    name: `copilot-cli${model ? `:${model}` : ""} (seu login do GitHub)`,
    async complete(system, user) {
      // O prompt vai pela entrada padrão (sem limite de tamanho de linha de comando).
      const prompt = `${system}\n\n=====\n\n${user}`;
      // Pasta vazia: a CLI não enxerga nenhum repositório seu, só o diff enviado.
      const cwd = await mkdtemp(join(tmpdir(), "ai-pr-review-"));
      try {
        return await runProcess(bin, args, prompt, cwd, timeoutMs);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}

function runProcess(bin: string, args: string[], input: string, cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, {
      cwd,
      // no Windows o executável instalado pelo npm é um .cmd, que precisa de shell
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`A CLI "${bin}" não respondeu em ${timeoutMs / 1000}s (ajuste COPILOT_TIMEOUT_SECONDS).`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        e.code === "ENOENT"
          ? new Error(`Comando "${bin}" não encontrado. Instale com: npm install -g @github/copilot`)
          : e,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && out.trim()) return resolvePromise(out);
      const detail = (err || out).trim().slice(0, 800);
      const hint = /auth|login|token|sign in|unauthori/i.test(detail)
        ? "\n  Faça login: rode `copilot` uma vez e use /login com a conta do GitHub ligada à licença."
        : "";
      reject(new Error(`A CLI "${bin}" terminou com código ${code}.${hint}\n  ${detail}`));
    });

    child.stdin.on("error", () => {}); // processo pode fechar antes de ler tudo; o erro real vem no "close"
    child.stdin.end(input);
  });
}
