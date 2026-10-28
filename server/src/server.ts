import { config } from "dotenv";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { attachWebSocketServer } from "./websocket/websocketServer.js";

// Load the repo-root .env regardless of the process's cwd (npm workspaces run
// this with cwd = server/, so the default "dotenv/config" lookup would miss it).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, "../../.env") });

const PORT = Number(process.env.PORT ?? 3001);

if (!process.env.GEMINI_API_KEY) {
  console.warn("[server] GEMINI_API_KEY is not set - Gemini Live calls will fail.");
}
if (!process.env.TYPESAFE_API_KEY) {
  console.warn("[server] TYPESAFE_API_KEY is not set - JEV calls will fail and fall back to no-switch.");
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("JEV + Gemini Live language-switching POC server");
});

attachWebSocketServer(server);

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});
