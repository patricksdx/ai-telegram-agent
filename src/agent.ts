// src/agent.ts
import { Agent } from "@mastra/core/agent";
import { ollama } from "ollama-ai-provider-v2";
import {
  getDownloadFileTool,
  listFilesTool,
  querySqliteTool,
  readFileTool,
} from "./tools/storage-tools";

const ollamaModel = process.env.OLLAMA_MODEL || "qwen3.5:4b";

export const agent = new Agent({
  id: "telegram-agent",
  name: "Telegram Agent",
  instructions:
    "Eres un asistente util para Telegram con acceso a archivos y datos. " +
    "Responde solo con datos obtenidos por herramientas; no inventes productos, precios, stocks ni nombres. " +
    "Usa list_files para descubrir archivos en tres ubicaciones: 'documents' (documentos), 'data' (datos CSV/SQLite) y 'assets' (imagenes, videos). " +
    "Usa read_file para leer contenido y query_sqlite solo para .sqlite/.db. " +
    "Nunca uses query_sqlite para archivos CSV, Excel, Markdown o texto; para esos usa read_file. " +
    "Si no hay datos en tools, dilo explicitamente en lugar de adivinar. " +
    "Para enviar archivos (imagenes, videos, PDFs, etc.) usa get_download_file con el scope correcto: 'assets' para multimedia, 'documents' o 'data' para otros archivos.",
  model: ollama.chat(ollamaModel),
  tools: {
    list_files: listFilesTool,
    read_file: readFileTool,
    query_sqlite: querySqliteTool,
    get_download_file: getDownloadFileTool,
  },
});
