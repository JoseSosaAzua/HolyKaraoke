import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { WebSocket } from "ws";

export function connectVosk(browser: WebSocket, rate: number, songId?: string) {
  if (songId !== undefined && (!songId || path.basename(songId) !== songId)) {
    console.error("Vosk: identificador de cancion invalido.");
    browser.send(JSON.stringify({ error: "Vosk: selecciona una cancion valida." }));
    browser.close();
    return;
  }
  const python = process.env.VOSK_PYTHON ?? path.resolve(".venv", "Scripts", "python.exe");
  const model = process.env.VOSK_MODEL_PATH ?? path.resolve("models", "vosk-model-small-es-0.42");
  const worker = spawn(python, [
    "-u", path.resolve("server", "vosk_worker.py"), "--model", model, "--rate", String(rate),
    ...(songId === undefined ? [] : ["--song", path.resolve("songs", `${songId}.json`)]),
  ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stopped = false;
  let ready = false;
  let blocked = false;

  function fail(message: string) {
    if (stopped) return;
    console.error(message);
    if (browser.readyState === WebSocket.OPEN) {
      browser.send(JSON.stringify({ error: message }));
      browser.close();
    }
    cleanup();
  }

  const timeout = setTimeout(() => fail("Vosk: el modelo no estuvo listo en 60 segundos."), 60_000);
  const lines = createInterface({ input: worker.stdout });
  function cleanup() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    lines.close();
    worker.stdin.destroy();
    worker.kill();
  }

  worker.stderr.on("data", (data: Buffer) => console.error(data.toString().trimEnd()));
  worker.on("error", (error) => fail(`Vosk: no se pudo iniciar Python. ${error.message}`));
  worker.stdin.on("error", (error) => fail(`Vosk: error enviando audio. ${error.message}`));
  worker.stdin.on("drain", () => { blocked = false; });
  worker.on("exit", (code) => fail(`Vosk: el proceso termino inesperadamente (codigo ${code}).`));

  lines.on("line", (line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      fail(`Vosk: respuesta JSON invalida. ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (typeof message !== "object" || message === null) {
      fail("Vosk: respuesta invalida.");
      return;
    }
    if ("error" in message && typeof message.error === "string") {
      fail(message.error);
      return;
    }
    if ("ready" in message && message.ready === true) {
      ready = true;
      clearTimeout(timeout);
    } else if (!("text" in message && typeof message.text === "string"
      && "isFinal" in message && typeof message.isFinal === "boolean")) {
      fail("Vosk: formato de transcripcion invalido.");
      return;
    }
    if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(message));
  });

  browser.on("message", (audio: Buffer, isBinary) => {
    if (stopped) return;
    if (!ready || !isBinary || !audio.length || audio.length % 2 || audio.length > 1024 * 1024) {
      fail("Vosk: se esperaba audio PCM de 16 bits despues de iniciar el modelo.");
      return;
    }
    if (blocked && worker.stdin.writableLength > rate * 2 * 5) {
      fail("Vosk: el procesamiento acumulo mas de 5 segundos de audio. Deten y vuelve a probar.");
      return;
    }
    const header = Buffer.alloc(4);
    header.writeUInt32LE(audio.length);
    blocked = !worker.stdin.write(Buffer.concat([header, audio]));
  });
  browser.on("error", (error) => {
    console.error("Error del navegador:", error.message);
    cleanup();
  });
  browser.on("close", cleanup);
}
