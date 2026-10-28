import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { FileDiff, Stack } from "./diff.js";
import type { LlmClient } from "./llm.js";
import type { PullRequest } from "./azdo.js";

export const SEVERITIES = ["critical", "major", "minor", "suggestion"] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface Finding {
  file: string;
  line: number | null;
  severity: Severity;
  category: string;
  comment: string;
  suggestion?: string;
  /** Preenchido na validação: como a linha foi ajustada. */
  anchor?: "exact" | "snapped" | "file";
  fingerprint?: string;
}

export interface ReviewResult {
  summary: string;
  findings: Finding[];
  /** Achados descartados por citar arquivo fora do PR. */
  discarded: number;
}

// ─── Regras ────────────────────────────────────────────────────────

async function loadRules(rulesDir: string, stacks: Set<Stack>): Promise<string> {
  const parts: string[] = [];
  const read = async (name: string) => {
    const p = join(rulesDir, `${name}.md`);
    if (existsSync(p)) parts.push((await readFile(p, "utf8")).trim());
  };
  await read("common");
  if (stacks.has("angular")) await read("angular");
  if (stacks.has("csharp")) await read("csharp");
  return parts.join("\n\n---\n\n");
}

function systemPrompt(rules: string, language: string): string {
  return `Você é um revisor de código sênior fazendo code review de um Pull Request no Azure DevOps.
Responda SEMPRE em ${language}.

Você recebe diffs anotados assim:
  "+   42 | código"  → linha adicionada/alterada, número 42 no arquivo novo
  "    41 | código"  → contexto inalterado
  "-      | código"  → linha removida (não tem número no arquivo novo)

Regras do time:
${rules}

Instruções de saída:
- Comente APENAS problemas reais e acionáveis, priorizando linhas adicionadas (+).
- "line" deve ser o número exibido à esquerda do "|" (arquivo novo). Use null se o comentário for sobre o arquivo como um todo.
- "file" deve ser exatamente o caminho mostrado no cabeçalho "### Arquivo:".
- severity: "critical" (bug grave/segurança), "major" (bug provável ou problema sério), "minor" (melhoria relevante), "suggestion" (opcional).
- "suggestion" (opcional): trecho de código corrigido, só quando ajudar.
- Se não houver nada relevante, retorne "findings": [].
- Seja conciso: cada comentário em no máximo 3 frases.

Responda SOMENTE com um JSON válido, sem texto fora dele, neste formato:
{
  "summary": "visão geral do lote em 1-3 frases",
  "findings": [
    { "file": "/src/app/x.ts", "line": 42, "severity": "major", "category": "bug", "comment": "...", "suggestion": "..." }
  ]
}`;
}

function userPrompt(pr: PullRequest, batch: FileDiff[], index: number, total: number): string {
  const header = [
    `PR #${pr.pullRequestId}: ${pr.title}`,
    `Branch: ${pr.sourceRefName.replace("refs/heads/", "")} → ${pr.targetRefName.replace("refs/heads/", "")}`,
    pr.description ? `Descrição do PR:\n${pr.description.slice(0, 2000)}` : "",
    total > 1 ? `(Lote ${index + 1} de ${total})` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const body = batch
    .map((f) => `### Arquivo: ${f.path}  [${f.changeType}] [stack: ${f.stack}]\n\`\`\`diff\n${f.annotated}\n\`\`\``)
    .join("\n\n");

  return `${header}\n\n${body}`;
}

// ─── Lotes ─────────────────────────────────────────────────────────

/** Agrupa arquivos em lotes por tamanho; arquivo maior que o limite vai sozinho. */
export function makeBatches(files: FileDiff[], maxChars: number): FileDiff[][] {
  const batches: FileDiff[][] = [];
  let current: FileDiff[] = [];
  let size = 0;
  for (const f of files) {
    const len = f.annotated.length + f.path.length + 50;
    if (current.length && size + len > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(f);
    size += len;
  }
  if (current.length) batches.push(current);
  return batches;
}

// ─── Parse e validação ─────────────────────────────────────────────

export function extractJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("A IA não retornou JSON.");
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeSeverity(s: unknown): Severity {
  const v = String(s ?? "").toLowerCase();
  return (SEVERITIES as readonly string[]).includes(v) ? (v as Severity) : "minor";
}

function normPath(p: string): string {
  return "/" + p.trim().replace(/^\.?\/+/, "");
}

/**
 * Garante que cada achado aponte para um arquivo do PR e uma linha que existe no diff.
 * Linha fora do diff → ancora na linha alterada mais próxima; sem linha → comentário de arquivo.
 */
export function validateFindings(raw: any[], files: FileDiff[]): { valid: Finding[]; discarded: number } {
  const byPath = new Map(files.map((f) => [f.path.toLowerCase(), f]));
  const valid: Finding[] = [];
  let discarded = 0;

  for (const r of raw ?? []) {
    if (!r || typeof r.comment !== "string" || !r.comment.trim()) continue;
    const file = byPath.get(normPath(String(r.file ?? "")).toLowerCase());
    if (!file) {
      discarded++;
      continue;
    }

    const finding: Finding = {
      file: file.path,
      line: null,
      severity: normalizeSeverity(r.severity),
      category: String(r.category ?? "geral"),
      comment: r.comment.trim(),
      suggestion: typeof r.suggestion === "string" && r.suggestion.trim() ? r.suggestion.trim() : undefined,
      anchor: "file",
    };

    const line = Number(r.line);
    if (Number.isInteger(line) && line > 0) {
      if (file.commentableLines.includes(line)) {
        finding.line = line;
        finding.anchor = "exact";
      } else {
        // a IA errou a linha por pouco: aproxima da linha alterada mais próxima (até 10 linhas)
        const candidates = file.addedLines.size ? [...file.addedLines] : file.commentableLines;
        const nearest = candidates.reduce((a, b) => (Math.abs(b - line) < Math.abs(a - line) ? b : a));
        if (Math.abs(nearest - line) <= 10) {
          finding.line = nearest;
          finding.anchor = "snapped";
        }
      }
    }

    // estável entre execuções (a IA reescreve o texto a cada vez): arquivo + linha + categoria
    finding.fingerprint = createHash("sha1")
      .update(`${finding.file}|${finding.line}|${finding.category.toLowerCase()}`)
      .digest("hex")
      .slice(0, 10);
    valid.push(finding);
  }
  return { valid, discarded };
}

// ─── Orquestração ──────────────────────────────────────────────────

export async function runReview(args: {
  llm: LlmClient;
  pr: PullRequest;
  files: FileDiff[];
  rulesDir: string;
  language: string;
  batchChars: number;
  onProgress?: (msg: string) => void;
}): Promise<ReviewResult> {
  const { llm, pr, files } = args;
  const stacks = new Set(files.map((f) => f.stack));
  const system = systemPrompt(await loadRules(args.rulesDir, stacks), args.language);
  const batches = makeBatches(files, args.batchChars);

  const summaries: string[] = [];
  const findings: Finding[] = [];
  let discarded = 0;

  for (const [i, batch] of batches.entries()) {
    args.onProgress?.(`IA revisando lote ${i + 1}/${batches.length} (${batch.length} arquivo(s))`);
    const text = await args.llm.complete(system, userPrompt(pr, batch, i, batches.length));

    let parsed: any;
    try {
      parsed = extractJson(text);
    } catch {
      // uma segunda tentativa pedindo só o JSON
      const retry = await llm.complete(
        system,
        userPrompt(pr, batch, i, batches.length) + "\n\nIMPORTANTE: responda apenas com o JSON pedido.",
      );
      parsed = extractJson(retry);
    }

    if (typeof parsed.summary === "string" && parsed.summary.trim()) summaries.push(parsed.summary.trim());
    const { valid, discarded: d } = validateFindings(parsed.findings, batch);
    findings.push(...valid);
    discarded += d;
  }

  const order = (s: Severity) => SEVERITIES.indexOf(s);
  findings.sort((a, b) => order(a.severity) - order(b.severity) || a.file.localeCompare(b.file));

  return { summary: summaries.join("\n\n"), findings, discarded };
}
