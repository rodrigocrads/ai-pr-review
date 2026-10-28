/**
 * Cliente mínimo da REST API do Azure DevOps (Services e Server on-premises).
 * Usa apenas o PAT do usuário: as permissões são exatamente as que você já tem.
 */

const API_VERSION = "7.1";

export interface PrRef {
  /** Ex.: https://dev.azure.com/minhaorg  ou  https://tfs.empresa.com/tfs/DefaultCollection */
  collectionUrl: string;
  project: string;
  repository: string;
  pullRequestId: number;
}

/**
 * Aceita URLs como:
 *  https://dev.azure.com/org/Projeto/_git/Repo/pullrequest/123
 *  https://org.visualstudio.com/Projeto/_git/Repo/pullrequest/123
 *  https://tfs.empresa.com/tfs/Colecao/Projeto/_git/Repo/pullrequest/123
 */
export function parsePrUrl(raw: string): PrRef {
  const url = new URL(raw.trim());
  const path = url.pathname.replace(/\/+$/, "");
  const m = path.match(/^(.*)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)$/i);
  if (!m) {
    throw new Error(
      `URL de PR não reconhecida: ${raw}\n` +
        "Formato esperado: https://dev.azure.com/<org>/<projeto>/_git/<repo>/pullrequest/<id>",
    );
  }
  const [, prefix, project, repository, id] = m;
  return {
    collectionUrl: `${url.origin}${prefix}`,
    project: decodeURIComponent(project),
    repository: decodeURIComponent(repository),
    pullRequestId: Number(id),
  };
}

export interface PullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  sourceRefName: string;
  targetRefName: string;
  createdBy: { displayName: string };
}

export interface Iteration {
  id: number;
  sourceRefCommit: { commitId: string };
  commonRefCommit?: { commitId: string };
  targetRefCommit?: { commitId: string };
}

export interface ChangeEntry {
  changeTrackingId: number;
  changeType: string; // "add", "edit", "delete", "rename", "edit, rename"...
  item: { path: string; isFolder?: boolean; gitObjectType?: string };
  originalPath?: string;
}

export interface CommentThread {
  id: number;
  isDeleted?: boolean;
  threadContext?: {
    filePath: string;
    rightFileStart?: { line: number; offset: number };
  } | null;
  comments: { content?: string; isDeleted?: boolean }[];
}

export class AzDoClient {
  private readonly auth: () => Promise<string>;
  private readonly repoApi: string;

  constructor(
    private readonly ref: PrRef,
    /** PAT (string) ou função que devolve um token Bearer do Entra ID. */
    auth: string | (() => Promise<string>),
  ) {
    this.auth =
      typeof auth === "string"
        ? async () => "Basic " + Buffer.from(`:${auth}`).toString("base64")
        : async () => "Bearer " + (await auth());
    this.repoApi =
      `${ref.collectionUrl}/${encodeURIComponent(ref.project)}` +
      `/_apis/git/repositories/${encodeURIComponent(ref.repository)}`;
  }

  private async request<T>(
    path: string,
    init: { method?: string; body?: unknown; query?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(this.repoApi + path);
    url.searchParams.set("api-version", API_VERSION);
    for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);

    const res = await fetch(url, {
      method: init.method ?? "GET",
      headers: {
        Authorization: await this.auth(),
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: "manual",
    });

    // PAT inválido/expirado costuma redirecionar para a tela de login (302/203).
    if (res.status === 203 || (res.status >= 300 && res.status < 400)) {
      throw new Error(
        "O Azure DevOps redirecionou para login: a credencial é inválida, expirou ou não tem acesso a esta organização.",
      );
    }
    if (res.status === 401)
      throw new Error(
        "401 Não autorizado: verifique o AZDO_PAT ou, com AZDO_AUTH=entra, se o seu login é do mesmo tenant da organização (AZURE_TENANT_ID).",
      );
    if (res.status === 403)
      throw new Error(`403 Sem permissão em ${path}. Confira os escopos do PAT e seu acesso ao repositório.`);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Azure DevOps ${res.status} em ${path}: ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }

  getPullRequest(): Promise<PullRequest> {
    return this.request<PullRequest>(`/pullRequests/${this.ref.pullRequestId}`);
  }

  async getLatestIteration(): Promise<Iteration> {
    const { value } = await this.request<{ value: Iteration[] }>(
      `/pullRequests/${this.ref.pullRequestId}/iterations`,
    );
    if (!value.length) throw new Error("O PR não tem iterações (nenhum push ainda?).");
    return value.reduce((a, b) => (b.id > a.id ? b : a));
  }

  /** Todas as mudanças da iteração comparadas com a base (compareTo=0), paginando. */
  async getChanges(iterationId: number): Promise<ChangeEntry[]> {
    const all: ChangeEntry[] = [];
    let skip = 0;
    for (;;) {
      const page = await this.request<{ changeEntries: ChangeEntry[]; nextSkip?: number }>(
        `/pullRequests/${this.ref.pullRequestId}/iterations/${iterationId}/changes`,
        { query: { $compareTo: "0", $top: "2000", $skip: String(skip) } },
      );
      all.push(...page.changeEntries);
      if (!page.nextSkip) break;
      skip = page.nextSkip;
    }
    return all;
  }

  /** Conteúdo de um arquivo em um commit. Retorna null se não existir ou for binário. */
  async getFileContent(path: string, commitId: string): Promise<string | null> {
    try {
      const item = await this.request<{
        content?: string;
        contentMetadata?: { isBinary?: boolean; encoding?: number };
      }>(`/items`, {
        query: {
          path,
          includeContent: "true",
          "versionDescriptor.version": commitId,
          "versionDescriptor.versionType": "commit",
        },
      });
      if (item.contentMetadata?.isBinary) return null;
      return item.content ?? "";
    } catch (err) {
      if (err instanceof Error && /Azure DevOps 404/.test(err.message)) return null;
      throw err;
    }
  }

  async getThreads(): Promise<CommentThread[]> {
    const { value } = await this.request<{ value: CommentThread[] }>(
      `/pullRequests/${this.ref.pullRequestId}/threads`,
    );
    return value;
  }

  /** Cria um comentário. Sem `file`, vira comentário geral do PR. */
  createThread(args: {
    content: string;
    file?: { path: string; line: number; changeTrackingId: number; iterationId: number };
  }): Promise<CommentThread> {
    const body: Record<string, unknown> = {
      comments: [{ parentCommentId: 0, content: args.content, commentType: 1 }],
      status: 1, // active
    };
    if (args.file) {
      const { path, line, changeTrackingId, iterationId } = args.file;
      body.threadContext = {
        filePath: path,
        rightFileStart: { line, offset: 1 },
        rightFileEnd: { line, offset: 1 },
      };
      body.pullRequestThreadContext = {
        changeTrackingId,
        iterationContext: { firstComparingIteration: 1, secondComparingIteration: iterationId },
      };
    }
    return this.request<CommentThread>(`/pullRequests/${this.ref.pullRequestId}/threads`, {
      method: "POST",
      body,
    });
  }
}
