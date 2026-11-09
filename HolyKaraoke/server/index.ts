import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { connectVosk } from "./vosk";

const PORT = 3001;
const SONGS_FOLDER = path.join(process.cwd(), "songs");
const DEEPGRAM_URL =
  "wss://api.deepgram.com/v1/listen?model=nova-3&language=es&interim_results=true&punctuate=false&endpointing=false";
const app = express();

// Devuelve todas las canciones guardadas en la carpeta "songs"
app.get("/api/songs", (_req, res) => {
  const files = fs.readdirSync(SONGS_FOLDER).filter((file) => file.endsWith(".json"));
  const songs = files.map((file) => {
    const song = JSON.parse(fs.readFileSync(path.join(SONGS_FOLDER, file), "utf-8"));
    return { id: file.replace(".json", ""), ...song };
  });
  res.json(songs);
});

// Palabras que aparecen en una sola estrofa: son las que distinguen una estrofa de otra.
// Se las pasamos a Deepgram para que las reconozca mejor.
function exclusiveWords(songId: string): string[] {
  const file = path.join(SONGS_FOLDER, `${path.basename(songId)}.json`);
  if (!fs.existsSync(file)) return [];
  const stanzas: string[][] = JSON.parse(fs.readFileSync(file, "utf-8")).estrofas;
  const stanzasPerWord = new Map<string, Set<number>>();
  stanzas.forEach((verses, index) => {
    const words = verses.join(" ").toLowerCase().match(/[a-záéíóúñü]{4,}/g) ?? [];
    words.forEach((word) => {
      if (!stanzasPerWord.has(word)) stanzasPerWord.set(word, new Set());
      stanzasPerWord.get(word)!.add(index);
    });
  });
  return [...stanzasPerWord].filter(([, where]) => where.size === 1).map(([word]) => word).slice(0, 50);
}

const server = app.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
});

// El navegador nos manda audio por /listen, nosotros se lo pasamos a Deepgram
// y le devolvemos al navegador el texto que Deepgram escuchó.
// Así la API key nunca sale del servidor.
const wss = new WebSocketServer({ server, path: "/listen" });

wss.on("connection", (browser, request) => {
  const params = new URL(request.url ?? "", "http://localhost").searchParams;
  const rate = Number(params.get("rate") ?? 48000);
  const engine = params.get("engine") ?? "deepgram";
  if (!Number.isInteger(rate) || rate < 8000 || rate > 192000
    || (engine !== "deepgram" && engine !== "vosk")) {
    console.error("Parametros de reconocimiento invalidos.");
    browser.send(JSON.stringify({ error: "Motor o frecuencia de audio invalido." }));
    browser.close();
    return;
  }
  if (engine === "vosk") {
    const grammar = params.get("grammar") ?? "song";
    if (grammar !== "song" && grammar !== "general") {
      console.error("Vosk: modo de vocabulario invalido.");
      browser.send(JSON.stringify({ error: "Vosk: modo de vocabulario invalido." }));
      browser.close();
      return;
    }
    connectVosk(browser, rate, grammar === "song" ? params.get("song") ?? "" : undefined);
    return;
  }
  if (!process.env.DEEPGRAM_API_KEY) {
    browser.send(JSON.stringify({ error: "Falta DEEPGRAM_API_KEY en el archivo .env" }));
    browser.close();
    return;
  }

  console.log("Navegador conectado: escuchando...");

  // El navegador manda audio sin comprimir (PCM de 16 bits) y nos dice su frecuencia de muestreo
  const keyterms = exclusiveWords(params.get("song") ?? "")
    .map((word) => `&keyterm=${encodeURIComponent(word)}`)
    .join("");

  const deepgram = new WebSocket(`${DEEPGRAM_URL}&encoding=linear16&sample_rate=${rate}&channels=1${keyterms}`, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });

  // Audio que llega antes de que Deepgram esté conectado (no se debe perder)
  const waitingAudio: Buffer[] = [];

  deepgram.on("open", () => {
    if (browser.readyState !== WebSocket.OPEN) {
      deepgram.close();
      return;
    }
    waitingAudio.forEach((audio) => deepgram.send(audio));
    waitingAudio.length = 0;
    browser.send(JSON.stringify({ ready: true }));
  });

  browser.on("message", (audio: Buffer) => {
    if (deepgram.readyState === WebSocket.OPEN) deepgram.send(audio);
    else waitingAudio.push(audio);
  });

  deepgram.on("message", (message) => {
    const data = JSON.parse(message.toString());
    const text = data.channel?.alternatives?.[0]?.transcript;
    if (typeof text === "string" && browser.readyState === WebSocket.OPEN) {
      browser.send(JSON.stringify({ text, isFinal: data.is_final }));
    }
  });

  // Si Deepgram rechaza la conexión (key incorrecta, red, etc.) avisamos al navegador
  deepgram.on("error", (error) => {
    console.error("Error de Deepgram:", error.message);
    if (browser.readyState === WebSocket.OPEN) {
      browser.send(JSON.stringify({ error: `Deepgram: ${error.message}` }));
    }
  });
  browser.on("error", (error) => console.error("Error del navegador:", error.message));

  // Deepgram cortó por su cuenta: avisamos y cerramos la conexión del navegador
  // (el navegador se vuelve a conectar solo)
  deepgram.on("close", (code, reason) => {
    if (browser.readyState !== WebSocket.OPEN) return; // la cerramos nosotros, todo normal
    console.log(`Deepgram cortó la conexión (código ${code}) ${reason.toString()}`);
    browser.close();
  });

  // El navegador se fue (botón Detener, recarga o pestaña cerrada): cerramos Deepgram
  browser.on("close", () => {
    if (deepgram.readyState === WebSocket.CLOSED) return; // ya la había cortado Deepgram
    console.log("El navegador dejó de escuchar (botón Detener, recarga o pestaña cerrada)");
    deepgram.close();
  });
});
