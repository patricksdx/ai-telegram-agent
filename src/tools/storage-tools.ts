import fs from "node:fs/promises";
import path from "node:path";
import { createTool } from "@mastra/core/tools";
import { Database } from "bun:sqlite";
import * as XLSX from "xlsx";
import { z } from "zod";

const PROJECT_SRC = path.resolve(process.cwd(), "src");
const DOCUMENTS_ROOT = path.join(PROJECT_SRC, "documents");
const DATA_ROOT = path.join(PROJECT_SRC, "data");
const ASSETS_ROOT = path.join(PROJECT_SRC, "assets");

const READABLE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".csv",
  ".json",
  ".xlsx",
  ".xls",
]);

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
]);

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);

const DOWNLOADABLE_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".csv",
  ".json",
  ".xlsx",
  ".xls",
  ".pdf",
  ".doc",
  ".docx",
  ".sqlite",
  ".db",
  ".sql",
  ".ico",
  ...IMAGE_EXTENSIONS,
  ...VIDEO_EXTENSIONS,
]);

function getRoot(scope: "documents" | "data" | "assets") {
  if (scope === "documents") return DOCUMENTS_ROOT;
  if (scope === "data") return DATA_ROOT;
  return ASSETS_ROOT;
}

function safeResolve(
  scope: "documents" | "data" | "assets",
  relativePath: string,
) {
  const root = getRoot(scope);
  const normalizedInput = relativePath
    .replaceAll("\\", "/")
    .replace(/^\/+/, "");
  let normalizedPath = normalizedInput;

  if (scope === "data") {
    normalizedPath = normalizedPath
      .replace(/^src\/data\//i, "")
      .replace(/^data\//i, "");
  }

  if (scope === "documents") {
    normalizedPath = normalizedPath
      .replace(/^src\/documents\//i, "")
      .replace(/^documents\//i, "");
  }

  if (scope === "assets") {
    normalizedPath = normalizedPath
      .replace(/^src\/assets\//i, "")
      .replace(/^assets\//i, "");
  }

  const absolutePath = path.resolve(root, normalizedPath);

  if (!absolutePath.startsWith(root)) {
    throw new Error("Ruta fuera de la carpeta permitida.");
  }

  return absolutePath;
}

async function resolveExistingPath(
  scope: "documents" | "data" | "assets",
  relativePath: string,
) {
  const directPath = safeResolve(scope, relativePath);

  try {
    await fs.access(directPath);
    return directPath;
  } catch {
    if (/\.cvs$/i.test(relativePath)) {
      const csvPath = safeResolve(
        scope,
        relativePath.replace(/\.cvs$/i, ".csv"),
      );
      await fs.access(csvPath);
      return csvPath;
    }
    throw new Error(`No se encontro el archivo: ${relativePath}`);
  }
}

async function listFilesRecursive(
  rootPath: string,
  prefix = "",
): Promise<string[]> {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(rootPath, entry.name);

    if (entry.isDirectory()) {
      const nested = await listFilesRecursive(abs, rel);
      files.push(...nested);
      continue;
    }

    if (entry.isFile()) {
      files.push(rel);
    }
  }

  return files;
}

function toSimpleTable(rows: Array<Record<string, unknown>>, maxRows: number) {
  const sliced = rows.slice(0, maxRows);
  return {
    rows: sliced,
    totalRows: rows.length,
    returnedRows: sliced.length,
  };
}

export const listFilesTool = createTool({
  id: "list_files",
  description:
    "Lista archivos disponibles en src/documents, src/data o src/assets. Usa esta herramienta antes de leer o descargar. En assets encontrarás imágenes, videos y otros archivos multimedia.",
  inputSchema: z.object({
    scope: z.enum(["documents", "data", "assets"]),
    contains: z.string().optional(),
  }),
  execute: async ({ scope, contains }) => {
    const root = getRoot(scope);
    const files = await listFilesRecursive(root);
    const filtered = contains
      ? files.filter((file) =>
          file.toLowerCase().includes(contains.toLowerCase()),
        )
      : files;

    return {
      scope,
      count: filtered.length,
      files: filtered,
    };
  },
});

export const readFileTool = createTool({
  id: "read_file",
  description:
    "Lee contenido de archivos legibles (.md, .txt, .csv, .json, .xlsx, .xls). Para PDF/DOCX/imágenes/videos recomienda descarga.",
  inputSchema: z.object({
    scope: z.enum(["documents", "data", "assets"]),
    relativePath: z.string(),
    maxChars: z.number().int().positive().max(40000).default(12000),
    maxRows: z.number().int().positive().max(500).default(100),
  }),
  execute: async ({ scope, relativePath, maxChars, maxRows }) => {
    const fullPath = await resolveExistingPath(scope, relativePath);
    const ext = path.extname(fullPath).toLowerCase();

    if (!READABLE_EXTENSIONS.has(ext)) {
      return {
        scope,
        relativePath,
        kind: "not-readable",
        message:
          "Este tipo de archivo no tiene lectura directa en el bot. Puedes solicitar la descarga del archivo.",
      };
    }

    if (ext === ".xlsx" || ext === ".xls") {
      const wb = XLSX.read(await fs.readFile(fullPath));
      const firstSheet = wb.SheetNames[0];

      if (!firstSheet) {
        return {
          scope,
          relativePath,
          kind: "excel",
          message: "El archivo Excel no contiene hojas.",
        };
      }

      const sheet = wb.Sheets[firstSheet];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
      });

      return {
        scope,
        relativePath,
        kind: "excel",
        sheet: firstSheet,
        ...toSimpleTable(rows, maxRows),
      };
    }

    if (ext === ".csv") {
      const wb = XLSX.read(await fs.readFile(fullPath), { type: "buffer" });
      const firstSheet = wb.SheetNames[0];

      if (!firstSheet) {
        return {
          scope,
          relativePath,
          kind: "csv",
          message: "El archivo CSV no contiene datos.",
        };
      }

      const sheet = wb.Sheets[firstSheet];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
        defval: "",
      });

      return {
        scope,
        relativePath,
        kind: "csv",
        ...toSimpleTable(rows, maxRows),
      };
    }

    const raw = await fs.readFile(fullPath, "utf8");
    const content = raw.slice(0, maxChars);

    return {
      scope,
      relativePath,
      kind: "text",
      content,
      truncated: raw.length > maxChars,
      totalChars: raw.length,
    };
  },
});

export const querySqliteTool = createTool({
  id: "query_sqlite",
  description:
    "Ejecuta consultas SELECT sobre bases SQLite dentro de src/data y devuelve filas.",
  inputSchema: z.object({
    relativePath: z
      .string()
      .describe("Ruta de .sqlite o .db dentro de src/data"),
    sql: z.string().describe("Consulta SQL. Solo SELECT."),
    limit: z.number().int().positive().max(1000).default(200),
  }),
  execute: async ({ relativePath, sql, limit }) => {
    if (!/^\s*select\b/i.test(sql)) {
      throw new Error("Solo se permiten consultas SELECT.");
    }

    const fullPath = await resolveExistingPath("data", relativePath);
    const ext = path.extname(fullPath).toLowerCase();

    if (ext !== ".sqlite" && ext !== ".db") {
      if (ext === ".csv") {
        throw new Error(
          "Ese archivo es CSV. Usa read_file con scope=data y relativePath del CSV en lugar de query_sqlite.",
        );
      }

      throw new Error("El archivo debe ser .sqlite o .db");
    }

    const db = new Database(fullPath, { readonly: true, create: false });

    try {
      const normalizedSql = sql.replace(/;+\s*$/, "");
      const limitedSql = `${normalizedSql} LIMIT ${limit};`;
      const rows = db.query(limitedSql).all() as Array<Record<string, unknown>>;

      return {
        relativePath,
        query: limitedSql,
        ...toSimpleTable(rows, limit),
      };
    } finally {
      db.close();
    }
  },
});

export const getDownloadFileTool = createTool({
  id: "get_download_file",
  description:
    "Valida y prepara un archivo de documents/data/assets para ser enviado por Telegram. Úsalo para imágenes, videos, PDFs y cualquier archivo descargable.",
  inputSchema: z.object({
    scope: z.enum(["documents", "data", "assets"]),
    relativePath: z.string(),
  }),
  execute: async ({ scope, relativePath }) => {
    const fullPath = await resolveExistingPath(scope, relativePath);
    const ext = path.extname(fullPath).toLowerCase();

    if (!DOWNLOADABLE_EXTENSIONS.has(ext)) {
      throw new Error("Tipo de archivo no permitido para descarga.");
    }

    await fs.access(fullPath);

    return {
      scope,
      relativePath,
      fullPath,
      fileName: path.basename(fullPath),
      mimeHint: ext,
    };
  },
});
