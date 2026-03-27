import { log } from "./index.js";

interface GitHubFile {
  name: string;
  path: string;
  type: "file" | "dir";
  download_url: string | null;
  size: number;
}

interface RepoContent {
  repoName: string;
  files: Array<{ path: string; content: string }>;
}

// File extensions to include
const INCLUDE_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".rst",           // docs
  ".ts", ".tsx", ".js", ".jsx",             // javascript/typescript
  ".py", ".pyi",                            // python
  ".go",                                     // go
  ".rs",                                     // rust
  ".java", ".kt",                           // jvm
  ".rb",                                     // ruby
  ".php",                                    // php
  ".cs",                                     // c#
  ".swift",                                  // swift
  ".vue", ".svelte",                        // frontend frameworks
  ".css", ".scss",                          // styles
  ".sql",                                    // database
  ".yaml", ".yml", ".toml", ".json",        // config
  ".env.example",                           // env template
  ".sh", ".bash",                           // scripts
]);

// Files to always include regardless of extension
const INCLUDE_FILES = new Set([
  "readme.md", "readme", "changelog.md", "contributing.md",
  "dockerfile", "docker-compose.yml", "docker-compose.yaml",
  "makefile", "procfile",
]);

// Directories to skip
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "__pycache__",
  "vendor", ".venv", "venv", "target", "bin", "obj",
  ".cache", "coverage", ".nyc_output", ".turbo",
]);

const MAX_FILE_SIZE = 100_000; // 100KB per file
const MAX_TOTAL_FILES = 200;
const GITHUB_API = "https://api.github.com";

/**
 * Parse a GitHub URL into owner and repo.
 * Supports: github.com/owner/repo, github.com/owner/repo/tree/branch/path
 */
export function parseGitHubUrl(url: string): { owner: string; repo: string; branch?: string; path?: string } | null {
  const cleaned = url.replace(/\/$/, "").replace(/\.git$/, "");

  // Match github.com/owner/repo or github.com/owner/repo/tree/branch/path
  const match = cleaned.match(
    /github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+)(?:\/(.+))?)?/
  );

  if (!match) return null;

  return {
    owner: match[1]!,
    repo: match[2]!,
    branch: match[3],
    path: match[4],
  };
}

/**
 * Fetch the contents of a GitHub repository.
 * Uses the GitHub API (no token required for public repos, rate limited to 60 req/hr).
 */
export async function fetchGitHubRepo(
  repoUrl: string,
  githubToken?: string
): Promise<RepoContent> {
  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) {
    throw new Error("Invalid GitHub URL. Use format: github.com/owner/repo");
  }

  const { owner, repo, path: subPath } = parsed;
  const repoName = `${owner}/${repo}`;

  log(`Fetching GitHub repo: ${repoName}${subPath ? `/${subPath}` : ""}`);

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "IM3-Tutor-Bot/1.0",
  };

  if (githubToken) {
    headers["Authorization"] = `Bearer ${githubToken}`;
  }

  const files: Array<{ path: string; content: string }> = [];
  const startPath = subPath ?? "";

  await crawlDirectory(owner, repo, startPath, headers, files);

  if (files.length === 0) {
    throw new Error("No readable files found in this repository");
  }

  log(`GitHub repo ${repoName}: ${files.length} files extracted`);
  return { repoName, files };
}

async function crawlDirectory(
  owner: string,
  repo: string,
  dirPath: string,
  headers: Record<string, string>,
  files: Array<{ path: string; content: string }>
): Promise<void> {
  if (files.length >= MAX_TOTAL_FILES) return;

  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${dirPath}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });

  if (!res.ok) {
    if (res.status === 403) {
      throw new Error("GitHub API rate limit exceeded. Try again later or provide a GitHub token.");
    }
    throw new Error(`GitHub API error (${res.status}) for path: ${dirPath}`);
  }

  const items = (await res.json()) as GitHubFile[];

  // Process files first, then directories
  const dirs: GitHubFile[] = [];

  for (const item of items) {
    if (files.length >= MAX_TOTAL_FILES) break;

    if (item.type === "dir") {
      if (!SKIP_DIRS.has(item.name.toLowerCase())) {
        dirs.push(item);
      }
      continue;
    }

    if (item.type === "file" && shouldIncludeFile(item)) {
      try {
        const content = await fetchFileContent(item, headers);
        if (content.trim().length > 0) {
          files.push({ path: item.path, content });
        }
      } catch (err) {
        log(`Skipping file ${item.path}: ${err}`);
      }
    }
  }

  // Recurse into directories
  for (const dir of dirs) {
    if (files.length >= MAX_TOTAL_FILES) break;
    await crawlDirectory(owner, repo, dir.path, headers, files);
  }
}

function shouldIncludeFile(file: GitHubFile): boolean {
  if (file.size > MAX_FILE_SIZE) return false;

  const name = file.name.toLowerCase();

  // Always include specific files
  if (INCLUDE_FILES.has(name)) return true;

  // Check extension
  const extMatch = name.match(/\.[^.]+$/);
  if (extMatch && INCLUDE_EXTENSIONS.has(extMatch[0])) return true;

  return false;
}

async function fetchFileContent(
  file: GitHubFile,
  headers: Record<string, string>
): Promise<string> {
  if (!file.download_url) {
    throw new Error("No download URL available");
  }

  const res = await fetch(file.download_url, {
    headers: { "User-Agent": "IM3-Tutor-Bot/1.0" },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);

  return res.text();
}

/**
 * Format repo content into a single text document suitable for chunking.
 */
export function formatRepoAsDocument(content: RepoContent): string {
  const sections: string[] = [
    `# Repository: ${content.repoName}`,
    `Total files: ${content.files.length}`,
    "",
  ];

  for (const file of content.files) {
    sections.push(`## File: ${file.path}`);
    sections.push("```");
    sections.push(file.content);
    sections.push("```");
    sections.push("");
  }

  return sections.join("\n");
}
