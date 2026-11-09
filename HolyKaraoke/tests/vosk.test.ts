import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { connectVosk } from "../server/vosk";
import { findBestStanza, findCurrentWord, toWords } from "../src/matcher";

test("Word tracking follows partial phrases across verses and normalizes lyrics", () => {
  const stanza = ["¡Canta, corazón!", "Al Señor canta"];
  assert.equal(findCurrentWord(toWords("canta"), stanza), 0);
  assert.equal(findCurrentWord(toWords("canta corazon"), stanza, 0), 1);
  assert.equal(findCurrentWord(toWords("corazon al senor"), stanza, 1), 3);
  assert.equal(findCurrentWord(toWords("al senor canta"), stanza, 3), 4);
});

test("Word tracking distinguishes repeated words by context and keeps stable partials", () => {
  const stanza = ["santo eres santo", "por siempre santo"];
  assert.equal(findCurrentWord(toWords("santo"), stanza), 0);
  assert.equal(findCurrentWord(toWords("eres santo"), stanza, 0), 2);
  assert.equal(findCurrentWord(toWords("santo"), stanza, 2), 2);
  assert.equal(findCurrentWord(toWords("siempre santo"), stanza, 2), 5);
  assert.equal(findCurrentWord(toWords("santo eres"), stanza, 5), 1);
});

test("Word tracking tolerates spelling errors without moving on silence or unrelated speech", () => {
  const stanza = ["gracia sublime es"];
  assert.equal(findCurrentWord(toWords("gracia sublim"), stanza, 0), 1);
  assert.equal(findCurrentWord(toWords("ruido"), stanza, 1), 1);
  assert.equal(findCurrentWord(toWords("[unk]"), stanza, 1), 1);
  assert.equal(findCurrentWord([], stanza), -1);
  assert.equal(findCurrentWord(toWords("gracia"), []), -1);
});

test("Word tracking starts on the newly selected slide without changing slide selection", () => {
  const stanzas = [["gracia sublime es"], ["quiero cantar hoy"]];
  const heard = toWords("sublime es quiero cantar");
  const next = findBestStanza(heard, stanzas, 0);
  assert.equal(next, 1);
  assert.equal(findCurrentWord(heard, stanzas[next]), 1);
});

async function session(songId: string | undefined = "ejemplo", general = false) {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (browser) => connectVosk(browser, 16000, general ? undefined : songId));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const browser = new WebSocket(`ws://127.0.0.1:${address.port}`);
  const messages: Record<string, unknown>[] = [];
  browser.on("message", (data) => messages.push(JSON.parse(data.toString())));
  await once(browser, "open");
  return {
    browser,
    messages,
    async waitFor(predicate: () => boolean) {
      const deadline = Date.now() + 30_000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, `Tiempo agotado: ${JSON.stringify(messages)}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async close() {
      if (browser.readyState !== WebSocket.CLOSED) {
        const closed = once(browser, "close");
        browser.close();
        await closed;
      }
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => error ? reject(error) : resolve());
      });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

test("Vosk loads song grammar with the real model and transcribes PCM silence", { timeout: 40_000 }, async () => {
  const client = await session();
  try {
    await client.waitFor(() => client.messages.some((message) => message.ready === true));
    // Feed in real-time-sized chunks; silence must produce an empty final.
    for (let block = 0; block < 160; block++) {
      client.browser.send(Buffer.alloc(1600));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await client.waitFor(() => client.messages.some((message) => message.isFinal === true));
    assert.ok(client.messages.some((message) => typeof message.text === "string"
      && toWords(message.text).length === 0 && message.isFinal === true));
    assert.ok(!client.messages.some((message) => "error" in message));
    client.browser.send(Buffer.alloc(3));
    await client.waitFor(() => client.messages.some((message) => typeof message.error === "string"));
    assert.match(String(client.messages.at(-1)?.error), /PCM/);
  } finally {
    await client.close();
  }
});

test("Unknown markers cannot trigger stanza changes", () => {
  assert.deepEqual(toWords("hola [unk] corazón [UNK]"), ["hola", "corazon"]);
  assert.equal(findBestStanza(toWords("[unk]"), [["hola"], ["punk"]], 0), 0);
});

test("Vosk general mode remains available", async () => {
  const client = await session(undefined, true);
  try {
    await client.waitFor(() => client.messages.some((message) => message.ready === true));
    assert.ok(!client.messages.some((message) => "error" in message));
  } finally {
    await client.close();
  }
});

test("Missing song is reported before recognition begins", async () => {
  const client = await session("missing-song");
  try {
    await client.waitFor(() => client.messages.some((message) => typeof message.error === "string"));
    assert.match(String(client.messages[0].error), /missing-song\.json/);
    assert.ok(!client.messages.some((message) => message.ready === true));
  } finally {
    await client.close();
  }
});

test("Empty song ID cannot silently enable general mode", async () => {
  const client = await session("");
  try {
    await client.waitFor(() => client.messages.some((message) => typeof message.error === "string"));
    assert.match(String(client.messages[0].error), /cancion valida/);
    assert.ok(!client.messages.some((message) => message.ready === true));
  } finally {
    await client.close();
  }
});

test("Missing Python is reported to the browser", async () => {
  const previous = process.env.VOSK_PYTHON;
  process.env.VOSK_PYTHON = path.resolve("missing-python.exe");
  const client = await session();
  try {
    await client.waitFor(() => client.messages.some((message) => typeof message.error === "string"));
    assert.match(String(client.messages[0].error), /no se pudo iniciar Python/);
  } finally {
    await client.close();
    if (previous === undefined) delete process.env.VOSK_PYTHON;
    else process.env.VOSK_PYTHON = previous;
  }
});

test("Missing model is reported without a readiness message", async () => {
  const previous = process.env.VOSK_MODEL_PATH;
  process.env.VOSK_MODEL_PATH = path.resolve("models", "missing-model");
  const client = await session();
  try {
    await client.waitFor(() => client.messages.some((message) => typeof message.error === "string"));
    assert.match(String(client.messages[0].error), /No se encontro el modelo/);
    assert.ok(!client.messages.some((message) => message.ready === true));
  } finally {
    await client.close();
    if (previous === undefined) delete process.env.VOSK_MODEL_PATH;
    else process.env.VOSK_MODEL_PATH = previous;
  }
});
