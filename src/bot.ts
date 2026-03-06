// bot.ts
import fs from "node:fs";
import path from "node:path";
import TelegramBot from "node-telegram-bot-api";
import { Database } from "bun:sqlite";
import { agent } from "./agent";
import { readFileTool } from "./tools/storage-tools";

const token = process.env.TELEGRAM_TOKEN;

if (!token) {
  throw new Error("Missing TELEGRAM_TOKEN environment variable");
}

const bot = new TelegramBot(token, { polling: true });

const CHAT_HISTORY_DIR = path.resolve(process.cwd(), "src", "historial-chats");
const CHAT_HISTORY_DB_PATH = path.join(CHAT_HISTORY_DIR, "chat-history.sqlite");

fs.mkdirSync(CHAT_HISTORY_DIR, { recursive: true });

const historyDb = new Database(CHAT_HISTORY_DB_PATH);
historyDb.exec(`
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const insertHistoryStmt = historyDb.query(
  "INSERT INTO chat_messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)",
);

const selectHistoryStmt = historyDb.query(
  "SELECT role, content FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?",
);

function saveHistoryMessage(
  chatId: number | string,
  role: "user" | "assistant",
  content: string,
) {
  const trimmed = content.trim();
  if (!trimmed) return;
  insertHistoryStmt.run(String(chatId), role, trimmed, Date.now());
}

function getRecentHistoryMessages(chatId: number | string, limit = 14) {
  const rows = selectHistoryStmt.all(String(chatId), limit) as Array<{
    role: "user" | "assistant";
    content: string;
  }>;

  // query returns DESC; reverse to oldest -> newest for model context
  return rows
    .reverse()
    .map((row) => ({ role: row.role, content: row.content }));
}

function getRecentUserMessages(chatId: number | string, limit = 20) {
  return getRecentHistoryMessages(chatId, limit)
    .filter((m) => m.role === "user")
    .map((m) => m.content);
}

type DownloadInstruction = {
  toolName?: string;
  result?: {
    fullPath?: string;
    fileName?: string;
  };
  payload?: {
    toolName?: string;
    result?: {
      fullPath?: string;
      fileName?: string;
    };
  };
};

type ToolResultEntry = {
  toolName?: string;
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

function normalizeToolResults(toolResults: unknown): ToolResultEntry[] {
  if (!Array.isArray(toolResults)) {
    return [];
  }

  const normalized: ToolResultEntry[] = [];

  for (const item of toolResults as Array<Record<string, unknown>>) {
    const payload =
      item.payload && typeof item.payload === "object"
        ? (item.payload as Record<string, unknown>)
        : undefined;

    const toolName =
      (typeof item.toolName === "string" ? item.toolName : undefined) ||
      (payload && typeof payload.toolName === "string"
        ? payload.toolName
        : undefined);

    const args =
      (item.args && typeof item.args === "object"
        ? (item.args as Record<string, unknown>)
        : undefined) ||
      (payload?.args && typeof payload.args === "object"
        ? (payload.args as Record<string, unknown>)
        : undefined);

    const result =
      (item.result && typeof item.result === "object"
        ? (item.result as Record<string, unknown>)
        : undefined) ||
      (payload?.result && typeof payload.result === "object"
        ? (payload.result as Record<string, unknown>)
        : undefined);

    normalized.push({ toolName, args, result });
  }

  return normalized;
}

function extractDownloadPaths(
  toolResults: unknown,
): Array<{ fullPath: string; fileName: string }> {
  const downloads: Array<{ fullPath: string; fileName: string }> = [];

  for (const item of normalizeToolResults(
    toolResults,
  ) as DownloadInstruction[]) {
    const toolName = item.toolName;
    if (toolName !== "get_download_file") {
      continue;
    }

    const result = item.result;
    const fullPath = result?.fullPath;
    const fileName = result?.fileName;

    if (!fullPath) {
      continue;
    }

    downloads.push({
      fullPath,
      fileName: fileName || "archivo",
    });
  }

  return downloads;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function buildFallbackText(
  userText: string,
  toolResults: unknown,
): string | null {
  const normalized = normalizeToolResults(toolResults);
  if (normalized.length === 0) {
    return null;
  }

  const lines: string[] = [];
  const askHighestPrice = /mayor\s+precio|mas\s+caro|m[aá]ximo\s+precio/i.test(
    userText,
  );

  for (const item of normalized) {
    if (item.toolName === "list_files") {
      const scope = String(item.result?.scope ?? "");
      const files = Array.isArray(item.result?.files)
        ? (item.result?.files as unknown[])
            .filter((f): f is string => typeof f === "string")
            .slice(0, 30)
        : [];

      lines.push(
        `Archivos en ${scope || "carpeta"}: ${files.length > 0 ? files.join(", ") : "sin archivos"}`,
      );
      continue;
    }

    if (item.toolName === "read_file") {
      const kind = String(item.result?.kind ?? "");

      if (kind === "csv" || kind === "excel") {
        const rows = Array.isArray(item.result?.rows)
          ? (item.result?.rows as Array<Record<string, unknown>>)
          : [];

        if (askHighestPrice && rows.length > 0) {
          let maxRow: Record<string, unknown> | null = null;
          let maxPrice = Number.NEGATIVE_INFINITY;

          for (const row of rows) {
            const precio = toNumber(
              row.precio ?? row.Precio ?? row.price ?? row.Price,
            );
            if (precio !== null && precio > maxPrice) {
              maxPrice = precio;
              maxRow = row;
            }
          }

          if (maxRow) {
            const nombre =
              (maxRow.nombre as string | undefined) ||
              (maxRow.Nombre as string | undefined) ||
              (maxRow.producto as string | undefined) ||
              (maxRow.Producto as string | undefined) ||
              "producto";
            lines.push(
              `El producto de mayor precio es ${nombre} con precio ${maxPrice}.`,
            );
            continue;
          }
        }

        lines.push(
          `Leidos ${rows.length} registros de ${String(item.result?.relativePath ?? "archivo")}.`,
        );
        continue;
      }

      if (kind === "text") {
        const content = String(item.result?.content ?? "").trim();
        lines.push(
          content
            ? `Contenido (resumen): ${content.slice(0, 800)}`
            : "Archivo leido sin contenido visible.",
        );
      }

      continue;
    }

    if (item.toolName === "query_sqlite") {
      const rows = Array.isArray(item.result?.rows)
        ? (item.result?.rows as unknown[])
        : [];
      lines.push(`Consulta SQLite ejecutada. Filas devueltas: ${rows.length}.`);
    }
  }

  const compact = lines.filter(Boolean).join("\n").trim();
  return compact || null;
}

function inferCsvPathFromMessage(
  userText: string,
  toolResults: unknown,
): string | null {
  const explicit = userText.match(/([\w./-]+\.c(?:sv|vs))/i);
  if (explicit?.[1]) {
    return explicit[1];
  }

  const normalized = normalizeToolResults(toolResults);
  for (const item of normalized) {
    if (item.toolName !== "list_files") continue;
    const files = Array.isArray(item.result?.files)
      ? (item.result?.files as unknown[]).filter(
          (f): f is string => typeof f === "string",
        )
      : [];
    const csv = files.find((f) => /\.csv$/i.test(f));
    if (csv) return csv;
  }

  return null;
}

async function readCsvRows(relativePath: string) {
  const executeReadFile = readFileTool.execute;
  if (!executeReadFile) {
    return [] as Array<Record<string, unknown>>;
  }

  const result = await executeReadFile(
    {
      scope: "data",
      relativePath,
      maxRows: 2000,
      maxChars: 40000,
    },
    {} as never,
  );

  return result &&
    typeof result === "object" &&
    Array.isArray((result as any).rows)
    ? ((result as any).rows as Array<Record<string, unknown>>)
    : [];
}

function formatProductRow(row: Record<string, unknown>) {
  return Object.entries(row)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
}

async function buildDeterministicProductsReply(
  chatId: number | string,
  userText: string,
): Promise<string | null> {
  const text = userText.toLowerCase();

  const asksAll =
    /todos\s+los\s+productos|lista\s+de\s+productos|dame\s+todos\s+los\s+productos/i.test(
      text,
    );
  const asksHighest = /mayor\s+precio|mas\s+caro|m[aá]ximo\s+precio/i.test(
    text,
  );
  const asksLowest =
    /menor\s+precio|m[aá]s\s+barato|minimo\s+precio|y\s+el\s+de\s+menor/i.test(
      text,
    );

  if (!asksAll && !asksHighest && !asksLowest) {
    return null;
  }

  const historyText = getRecentUserMessages(chatId, 30)
    .join(" \n ")
    .toLowerCase();
  const hasProductContext = /productos?\.c(?:sv|vs)|productos?/i.test(
    `${text} ${historyText}`,
  );

  if (!hasProductContext) {
    return null;
  }

  const explicit = userText.match(/([\w./-]+\.c(?:sv|vs))/i)?.[1];
  const csvPath = explicit || "productos.csv";

  let rows: Array<Record<string, unknown>> = [];
  try {
    rows = await readCsvRows(csvPath);
  } catch {
    rows = await readCsvRows("productos.csv");
  }

  if (rows.length === 0) {
    return null;
  }

  if (asksAll) {
    const lines = rows.map((row, index) => {
      const id = String(row.id ?? row.ID ?? `#${index + 1}`);
      const nombre = String(
        row.nombre ?? row.Nombre ?? row.producto ?? "sin nombre",
      );
      const precio = String(row.precio ?? row.Precio ?? row.price ?? "N/A");
      const stock = String(row.stock ?? row.Stock ?? "N/A");
      return `${index + 1}. ${nombre} (id: ${id}) - precio: ${precio}, stock: ${stock}`;
    });

    return `Productos en ${csvPath} (${rows.length}):\n${lines.join("\n")}`;
  }

  let targetRow: Record<string, unknown> | null = null;
  let targetPrice = asksHighest
    ? Number.NEGATIVE_INFINITY
    : Number.POSITIVE_INFINITY;

  for (const row of rows) {
    const price = toNumber(row.precio ?? row.Precio ?? row.price ?? row.Price);
    if (price === null) continue;

    if (asksHighest && price > targetPrice) {
      targetPrice = price;
      targetRow = row;
    }

    if (asksLowest && price < targetPrice) {
      targetPrice = price;
      targetRow = row;
    }
  }

  if (!targetRow) {
    return null;
  }

  return asksHighest
    ? `Producto de mayor precio en ${csvPath}:\n${formatProductRow(targetRow)}`
    : `Producto de menor precio en ${csvPath}:\n${formatProductRow(targetRow)}`;
}

async function buildHighestPriceFromCsvFallback(
  userText: string,
  toolResults: unknown,
): Promise<string | null> {
  const askHighestPrice = /mayor\s+precio|mas\s+caro|m[aá]ximo\s+precio/i.test(
    userText,
  );
  const askLowestPrice =
    /menor\s+precio|m[aá]s\s+barato|minimo\s+precio|y\s+el\s+de\s+menor/i.test(
      userText,
    );

  if (!askHighestPrice && !askLowestPrice) {
    return null;
  }

  const csvPath = inferCsvPathFromMessage(userText, toolResults);
  if (!csvPath) {
    return null;
  }

  try {
    const rows = await readCsvRows(csvPath);

    if (rows.length === 0) {
      return null;
    }

    let targetRow: Record<string, unknown> | null = null;
    let targetPrice = askHighestPrice
      ? Number.NEGATIVE_INFINITY
      : Number.POSITIVE_INFINITY;

    for (const row of rows) {
      const price = toNumber(
        row.precio ?? row.Precio ?? row.price ?? row.Price,
      );
      if (price === null) {
        continue;
      }

      if (askHighestPrice && price > targetPrice) {
        targetPrice = price;
        targetRow = row;
      }

      if (askLowestPrice && price < targetPrice) {
        targetPrice = price;
        targetRow = row;
      }
    }

    if (!targetRow) {
      return null;
    }

    const productInfo = formatProductRow(targetRow);

    return askHighestPrice
      ? `Producto de mayor precio en ${csvPath}:\n${productInfo}`
      : `Producto de menor precio en ${csvPath}:\n${productInfo}`;
  } catch {
    return null;
  }
}

bot.on("message", async (msg) => {
  if (!msg.text) return;

  const chatId = msg.chat.id;
  saveHistoryMessage(chatId, "user", msg.text);

  try {
    const deterministicReply = await buildDeterministicProductsReply(
      chatId,
      msg.text,
    );
    if (deterministicReply) {
      await bot.sendMessage(chatId, deterministicReply);
      saveHistoryMessage(chatId, "assistant", deterministicReply);
      return;
    }

    const historyMessages = getRecentHistoryMessages(chatId, 18);
    const response = await agent.generate(historyMessages as never);

    const downloads = extractDownloadPaths(response.toolResults);
    let textSent = "";

    for (const file of downloads) {
      const ext = path.extname(file.fullPath).toLowerCase();
      const imageExts = new Set([
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webp",
        ".bmp",
      ]);
      const videoExts = new Set([".mp4", ".mov", ".avi", ".mkv", ".webm"]);

      if (imageExts.has(ext)) {
        await bot.sendPhoto(chatId, file.fullPath, {
          caption: `Imagen: ${file.fileName}`,
        });
      } else if (videoExts.has(ext)) {
        await bot.sendVideo(chatId, file.fullPath, {
          caption: `Video: ${file.fileName}`,
        });
      } else {
        await bot.sendDocument(chatId, file.fullPath, {
          caption: `Archivo: ${file.fileName}`,
        });
      }
    }

    if (response.text) {
      textSent = response.text;
      await bot.sendMessage(chatId, textSent);
    } else {
      const fallback = buildFallbackText(msg.text, response.toolResults);
      if (fallback) {
        textSent = fallback;
        await bot.sendMessage(chatId, textSent);
      } else {
        const csvHighestPrice = await buildHighestPriceFromCsvFallback(
          msg.text,
          response.toolResults,
        );
        if (csvHighestPrice) {
          textSent = csvHighestPrice;
          await bot.sendMessage(chatId, textSent);
        } else if (downloads.length === 0) {
          textSent = "No pude generar una respuesta.";
          await bot.sendMessage(chatId, textSent);
        }
      }
    }

    if (textSent) {
      saveHistoryMessage(chatId, "assistant", textSent);
    }
  } catch (err) {
    console.log("Error processing message:", err);
    const errorText = "Error procesando el mensaje";
    await bot.sendMessage(chatId, errorText);
    saveHistoryMessage(chatId, "assistant", errorText);
  }
});
