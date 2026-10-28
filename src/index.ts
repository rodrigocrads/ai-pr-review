#!/usr/bin/env node
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AzDoClient, parsePrUrl } from "./azdo.js";
import { getEntraToken, SCOPE_AZURE_DEVOPS } from "./auth.js";
import { collectDiffs } from "./diff.js";
import { createLlm } from "./llm.js";
import { runReview, SEVERITIES, type Finding, type ReviewResult, type Severity } from "./review.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MARK = "ai-pr-review";
const ICON: Record<Severity, string> = { critical: "🔴", major: "🟠", minor: "🟡", suggestion: "💡" };

const HELP = `
Uso:
  npm run review -- <url-do-PR> [opções]

Opções:
  --post                 Publica os comentários no PR (padrão: só mostra, sem postar)
  --min-severity <nível> critical | major | minor | suggestion   (padrão: minor)
  --max-comments <n>     Máximo de comentários de linha a postar  (padrão: 25)
  --no-summary           Não posta o comentário geral de resumo
  --out <pasta>          Onde salvar o relatório                 (padrão: ./reviews)
  --rules <pasta>        Pasta com common.md, angular.md, csharp.md (padrão: ./rules)
  -h, --help             Mostra esta ajuda

Exemplo:
  npm run review -- https://dev.azure.com/org/Projeto/_git/Repo/pullrequest/123
  npm run review -- https://dev.azure.com/org/Projeto/_git/Repo/pullrequest/123 --post
`;

const log = (msg: string) => process.stderr.write(`› ${msg}\n`);

function formatComment(f: Finding): string {
  const lines = [`**${ICON[f.severity]} ${f.severity.toUpperCase()}** · ${f.category}`, "", f.comment];
  if (f.anchor === "snapped") lines.push("", "_(linha aproximada)_");
  if (f.suggestion) lines.push("", "Sugestão:", "```", f.suggestion, "```");
  lines.push("", `_${MARK} · fp:${f.fingerprint}_`);
  return lines.join("\n");
}

function formatSummary(result: ReviewResult, fileLevel: Finding[], iterationId: number, llmName: string): string {
  const count = (s: Severity) => result.findings.filter((f) => f.severity === s).length;
  const lines = [
    `## 🤖 Revisão automática (IA)`,
    "",
    result.summary || "_Sem resumo._",
    "",
    `| ${SEVERITIES.map((s) => `${ICON[s]} ${s}`).join(" | ")} |`,
    `|${SEVERITIES.map(() => "---").join("|")}|`,
    `| ${SEVERITIES.map((s) => count(s)).join(" | ")} |`,
  ];
  if (fileLevel.length) {
    lines.push("", "**Observações gerais por arquivo:**");
    for (const f of fileLevel) lines.push(`- ${ICON[f.severity]} \`${f.file}\`: ${f.comment}`);
  }
  lines.push(
    "",
    `_Comentários gerados por IA (${llmName}) para apoiar a revisão humana; podem conter erros._`,
    `_${MARK} · fp:summary-it${iterationId}_`,
  );
  return lines.join("\n");
}

function toMarkdownReport(prUrl: string, title: string, result: ReviewResult, skipped: { path: string; reason: string }[]) {
  const lines = [`# Revisão IA: ${title}`, "", prUrl, "", "## Resumo", "", result.summary || "_Sem resumo._", "", "## Achados", ""];
  if (!result.findings.length) lines.push("Nenhum achado relevante.");
  for (const f of result.findings) {
    lines.push(`### ${ICON[f.severity]} ${f.severity} · ${f.category} — \`${f.file}${f.line ? `:${f.line}` : ""}\``, "", f.comment);
    if (f.suggestion) lines.push("", "```", f.suggestion, "```");
    lines.push("");
  }
  if (skipped.length) {
    lines.push("## Arquivos não revisados", "");
    for (const s of skipped) lines.push(`- \`${s.path}\`: ${s.reason}`);
  }
  return lines.join("\n");
}

function printConsole(result: ReviewResult) {
  console.log("\n━━━ Resumo ━━━\n" + (result.summary || "(sem resumo)"));
  console.log(`\n━━━ Achados (${result.findings.length}) ━━━`);
  for (const f of result.findings) {
    console.log(`\n${ICON[f.severity]} [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ""}  (${f.category})`);
    console.log(`   ${f.comment.replace(/\n/g, "\n   ")}`);
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      post: { type: "boolean", default: false },
      "min-severity": { type: "string", default: "minor" },
      "max-comments": { type: "string", default: "25" },
      "no-summary": { type: "boolean", default: false },
      out: { type: "string", default: "reviews" },
      rules: { type: "string", default: join(ROOT, "rules") },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || !positionals[0]) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const minSeverity = values["min-severity"] as Severity;
  if (!SEVERITIES.includes(minSeverity)) throw new Error(`--min-severity inválido: ${minSeverity}`);
  const maxComments = Number(values["max-comments"]);

  const prUrl = positionals[0];
  const ref = parsePrUrl(prUrl);

  // Azure DevOps: PAT (padrão) ou o seu login Microsoft (AZDO_AUTH=entra)
  const azdoAuth = (process.env.AZDO_AUTH ?? "pat").trim().toLowerCase();
  let client: AzDoClient;
  if (azdoAuth === "entra") {
    client = new AzDoClient(ref, () => getEntraToken(SCOPE_AZURE_DEVOPS));
    log("Azure DevOps: autenticando com seu usuário Microsoft (Entra ID)");
  } else {
    const pat = process.env.AZDO_PAT?.trim();
    if (!pat) throw new Error("Defina AZDO_PAT no .env, ou use AZDO_AUTH=entra para entrar com seu usuário.");
    client = new AzDoClient(ref, pat);
  }
  const llm = createLlm();

  log(`PR #${ref.pullRequestId} em ${ref.project}/${ref.repository}`);
  const pr = await client.getPullRequest();
  const iteration = await client.getLatestIteration();
  const changes = await client.getChanges(iteration.id);
  log(`"${pr.title}" — iteração ${iteration.id}, ${changes.length} arquivo(s) alterado(s)`);

  const { files, skipped } = await collectDiffs(client, iteration, changes, {
    extraIgnore: (process.env.REVIEW_EXTRA_IGNORE ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    maxFileLines: Number(process.env.REVIEW_MAX_FILE_LINES ?? 3000),
    onProgress: log,
  });
  if (skipped.length) log(`${skipped.length} arquivo(s) ignorado(s)`);
  if (!files.length) {
    log("Nada para revisar.");
    return;
  }
  const stacks = [...new Set(files.map((f) => f.stack))].join(", ");
  log(`Revisando ${files.length} arquivo(s) [${stacks}] com ${llm.name}`);

  const result = await runReview({
    llm,
    pr,
    files,
    rulesDir: resolve(values.rules!),
    language: process.env.REVIEW_LANGUAGE?.trim() || "português do Brasil",
    batchChars: Number(process.env.REVIEW_BATCH_CHARS ?? 60000),
    onProgress: log,
  });

  // filtro por severidade
  const threshold = SEVERITIES.indexOf(minSeverity);
  result.findings = result.findings.filter((f) => SEVERITIES.indexOf(f.severity) <= threshold);
  if (result.discarded) log(`${result.discarded} achado(s) descartado(s) por citar arquivo fora do PR`);

  // relatório local
  const outDir = resolve(values.out!);
  await mkdir(outDir, { recursive: true });
  const base = join(outDir, `pr-${ref.pullRequestId}-it${iteration.id}`);
  await writeFile(`${base}.json`, JSON.stringify({ pr: { id: pr.pullRequestId, title: pr.title, url: prUrl }, ...result, skipped }, null, 2));
  await writeFile(`${base}.md`, toMarkdownReport(prUrl, pr.title, result, skipped));
  printConsole(result);
  log(`Relatório salvo em ${base}.md`);

  if (!values.post) {
    log("Modo simulação: nada foi postado. Use --post para publicar no PR.");
    return;
  }

  // ─── publicação ───
  const existing = await client.getThreads();
  const posted = new Set<string>();
  for (const t of existing) {
    for (const c of t.comments ?? []) {
      for (const m of (c.content ?? "").matchAll(/fp:([0-9a-f]{10}|summary-it\d+)/g)) posted.add(m[1]);
    }
  }

  const lineFindings = result.findings.filter((f) => f.line !== null);
  const fileLevel = result.findings.filter((f) => f.line === null);
  const trackingIds = new Map(files.map((f) => [f.path, f.changeTrackingId]));

  let created = 0;
  let duplicates = 0;
  for (const f of lineFindings) {
    if (posted.has(f.fingerprint!)) {
      duplicates++;
      continue;
    }
    if (created >= maxComments) break;
    await client.createThread({
      content: formatComment(f),
      file: { path: f.file, line: f.line!, changeTrackingId: trackingIds.get(f.file)!, iterationId: iteration.id },
    });
    created++;
  }

  const summaryFp = `summary-it${iteration.id}`;
  if (!values["no-summary"] && !posted.has(summaryFp)) {
    await client.createThread({ content: formatSummary(result, fileLevel, iteration.id, llm.name) });
    log("Comentário de resumo publicado.");
  }

  log(`${created} comentário(s) de linha publicado(s)` + (duplicates ? `, ${duplicates} já existia(m)` : ""));
  const remaining = lineFindings.length - created - duplicates;
  if (remaining > 0) log(`${remaining} achado(s) não publicados por causa de --max-comments (estão no relatório).`);
}

main().catch((err) => {
  console.error(`\n✖ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
