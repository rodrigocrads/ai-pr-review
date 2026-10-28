import { structuredPatch } from "diff";
import picomatch from "picomatch";
import type { AzDoClient, ChangeEntry, Iteration } from "./azdo.js";

export type Stack = "angular" | "csharp" | "other";

export interface FileDiff {
  path: string;
  changeType: string;
  changeTrackingId: number;
  stack: Stack;
  /** Diff anotado com o número da linha nova, no formato enviado à IA. */
  annotated: string;
  /** Linhas (do arquivo novo) que aparecem no diff: onde um comentário pode ser ancorado. */
  commentableLines: number[];
  /** Linhas adicionadas/alteradas (preferidas para ancorar comentários). */
  addedLines: Set<number>;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

const DEFAULT_IGNORE = [
  // dependências e lock files
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/packages.lock.json",
  // gerados / build
  "**/dist/**",
  "**/bin/**",
  "**/obj/**",
  "**/node_modules/**",
  "**/*.min.js",
  "**/*.min.css",
  "**/*.map",
  "**/*.Designer.cs",
  "**/*.g.cs",
  "**/*.g.i.cs",
  "**/Migrations/*.cs",
  "**/*ModelSnapshot.cs",
  // não-código
  "**/*.{png,jpg,jpeg,gif,ico,svg,webp,woff,woff2,ttf,eot,pdf,zip,dll,exe}",
  "**/*.{sln,suo,user}",
];

export function detectStack(path: string): Stack {
  const p = path.toLowerCase();
  if (/\.(cs|csx|razor|cshtml|csproj)$/.test(p)) return "csharp";
  if (/\.(ts|tsx|html|scss|css|sass|less)$/.test(p) || /(^|\/)angular\.json$/.test(p)) return "angular";
  return "other";
}

/**
 * Gera o diff com número de linha à esquerda, para a IA citar linhas reais:
 *   "+  42 | código adicionado"
 *   "   41 | contexto"
 *   "-     | código removido"
 */
export function buildAnnotatedDiff(oldText: string, newText: string, context = 4) {
  const patch = structuredPatch("a", "b", oldText, newText, "", "", { context });
  const out: string[] = [];
  const commentable: number[] = [];
  const added = new Set<number>();

  for (const hunk of patch.hunks) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      const tag = line[0];
      const text = line.slice(1);
      if (tag === "\\") continue; // "\ No newline at end of file"
      if (tag === "-") {
        out.push(`-      | ${text}`);
      } else if (tag === "+") {
        out.push(`+${String(newLine).padStart(5)} | ${text}`);
        commentable.push(newLine);
        added.add(newLine);
        newLine++;
      } else {
        out.push(` ${String(newLine).padStart(5)} | ${text}`);
        commentable.push(newLine);
        newLine++;
      }
    }
  }
  return { annotated: out.join("\n"), commentableLines: commentable, addedLines: added };
}

/** Normaliza o changeType do Azure DevOps ("edit, rename" → ["edit","rename"]). */
function changeKinds(ct: string): string[] {
  return ct
    .toLowerCase()
    .split(",")
    .map((s) => s.trim());
}

export async function collectDiffs(
  client: AzDoClient,
  iteration: Iteration,
  changes: ChangeEntry[],
  opts: { extraIgnore: string[]; maxFileLines: number; onProgress?: (msg: string) => void },
): Promise<{ files: FileDiff[]; skipped: SkippedFile[] }> {
  const isIgnored = picomatch([...DEFAULT_IGNORE, ...opts.extraIgnore], { nocase: true, dot: true });
  const headCommit = iteration.sourceRefCommit.commitId;
  // merge-base: o que o PR realmente muda em relação ao destino
  const baseCommit = iteration.commonRefCommit?.commitId ?? iteration.targetRefCommit?.commitId;

  const files: FileDiff[] = [];
  const skipped: SkippedFile[] = [];

  for (const change of changes) {
    const path = change.item.path;
    if (change.item.isFolder || change.item.gitObjectType === "tree") continue;

    const kinds = changeKinds(change.changeType);
    if (kinds.includes("delete")) {
      skipped.push({ path, reason: "arquivo removido" });
      continue;
    }
    if (isIgnored(path.replace(/^\//, ""))) {
      skipped.push({ path, reason: "ignorado por padrão de arquivo" });
      continue;
    }

    opts.onProgress?.(`lendo ${path}`);
    const newText = await client.getFileContent(path, headCommit);
    if (newText === null) {
      skipped.push({ path, reason: "binário ou não encontrado" });
      continue;
    }
    const lineCount = newText.split("\n").length;
    if (lineCount > opts.maxFileLines) {
      skipped.push({ path, reason: `muito grande (${lineCount} linhas)` });
      continue;
    }

    let oldText = "";
    if (!kinds.includes("add") && baseCommit) {
      const oldPath = change.originalPath ?? path;
      oldText = (await client.getFileContent(oldPath, baseCommit)) ?? "";
    }

    const { annotated, commentableLines, addedLines } = buildAnnotatedDiff(oldText, newText);
    if (!commentableLines.length) {
      skipped.push({ path, reason: "sem alterações de conteúdo (só rename/modo)" });
      continue;
    }

    files.push({
      path,
      changeType: change.changeType,
      changeTrackingId: change.changeTrackingId,
      stack: detectStack(path),
      annotated,
      commentableLines,
      addedLines,
    });
  }

  return { files, skipped };
}
