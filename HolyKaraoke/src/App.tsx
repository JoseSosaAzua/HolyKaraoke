import { useEffect, useRef, useState } from "react";
import { findBestStanza, findCurrentWord, toWords } from "./matcher";

type Song = { id: string; titulo: string; estrofas: string[][] };
type Engine = "deepgram" | "vosk";

const WORDS_TO_COMPARE = 6; // cuántas de las últimas palabras escuchadas usamos

// Pequeño programa que corre junto al audio del micrófono: junta ~16 ms de sonido,
// lo convierte a números enteros de 16 bits (PCM) y lo manda a la página.
const MICROPHONE_PROCESSOR = `
class Capture extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = []; }
  process(inputs) {
    const samples = inputs[0][0];
    if (samples) this.buffer.push(...samples);
    if (this.buffer.length >= 256) {
      const pcm = new Int16Array(this.buffer.length);
      this.buffer.forEach((x, i) => (pcm[i] = Math.max(-1, Math.min(1, x)) * 32767));
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
      this.buffer = [];
    }
    return true;
  }
}
registerProcessor("capture", Capture);
`;

export default function App() {
  const [songs, setSongs] = useState<Song[]>([]);
  const [song, setSong] = useState<Song | null>(null);
  const [current, setCurrent] = useState(0);
  const [heardWords, setHeardWords] = useState<string[]>([]);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const [engine, setEngine] = useState<Engine>("deepgram");
  const [useSongGrammar, setUseSongGrammar] = useState(true);
  const [followWords, setFollowWords] = useState(true);
  const [wordPosition, setWordPosition] = useState<{ stanza: number; index: number } | null>(null);
  const [status, setStatus] = useState("Detenido");

  const finalWords = useRef<string[]>([]);
  const socket = useRef<WebSocket | null>(null);
  const wantsToListen = useRef(false);
  const songId = useRef(""); // canción actual, para que las reconexiones usen la correcta
  songId.current = song?.id ?? "";

  const connection = useRef(0);
  const cleanupAudio = useRef<(() => void) | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    wantsToListen.current = false;
    connection.current++;
    if (retry.current !== null) clearTimeout(retry.current);
    socket.current?.close();
    cleanupAudio.current?.();
  }, []);

  // Cargar las canciones al abrir la página
  useEffect(() => {
    fetch("/api/songs")
      .then((response) => response.json())
      .then((data: Song[]) => {
        setSongs(data);
        setSong(data[0] ?? null);
      });
  }, []);

  // Cada vez que escuchamos palabras nuevas, buscamos la estrofa que más se parece
  useEffect(() => {
    if (!song || heardWords.length === 0) {
      setWordPosition(null);
      return;
    }
    const best = findBestStanza(heardWords, song.estrofas, current);
    if (best !== current) setCurrent(best);
    if (followWords) {
      setWordPosition((previous) => ({
        stanza: best,
        index: findCurrentWord(heardWords, song.estrofas[best] ?? [],
          previous?.stanza === best ? previous.index : -1),
      }));
    } else {
      setWordPosition(null);
    }
  }, [heardWords]);

  // Flechas del teclado para cambiar de estrofa manualmente si hace falta
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!song) return;
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") setWordPosition(null);
      if (event.key === "ArrowRight") setCurrent((i) => Math.min(i + 1, song.estrofas.length - 1));
      if (event.key === "ArrowLeft") setCurrent((i) => Math.max(i - 1, 0));
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [song]);

  function chooseSong(id: string) {
    setSong(songs.find((s) => s.id === id) ?? null);
    setCurrent(0);
    finalWords.current = [];
    setHeardWords([]);
  }

  // Botón "Escuchar"
  function start() {
    if (wantsToListen.current) return;
    wantsToListen.current = true;
    setListening(true);
    setError("");
    finalWords.current = [];
    setHeardWords([]);
    void connect();
  }

  // Botón "Detener"
  function stop() {
    wantsToListen.current = false;
    connection.current++;
    if (retry.current !== null) clearTimeout(retry.current);
    retry.current = null;
    socket.current?.close();
    socket.current = null;
    cleanupAudio.current?.();
    cleanupAudio.current = null;
    setListening(false);
    setStatus("Detenido");
  }

  async function connect() {
    const id = ++connection.current;
    const active = () => wantsToListen.current && connection.current === id;
    setStatus(engine === "vosk" ? "Iniciando Vosk..." : "Conectando Deepgram...");
    let stream: MediaStream | undefined;
    let audioContext: AudioContext | undefined;
    let capture: AudioWorkletNode | undefined;
    let microphone: MediaStreamAudioSourceNode | undefined;
    let closed = false;
    function closeAudio() {
      if (closed) return;
      closed = true;
      capture?.disconnect();
      microphone?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      if (audioContext && audioContext.state !== "closed") {
        void audioContext.close().catch((cause: unknown) => {
          console.error("Error cerrando audio:", cause);
        });
      }
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!active()) { closeAudio(); return; }
      audioContext = new AudioContext({ sampleRate: 16000, latencyHint: "interactive" });
      cleanupAudio.current = closeAudio;
      await audioContext.resume();
      const workletUrl = URL.createObjectURL(
        new Blob([MICROPHONE_PROCESSOR], { type: "text/javascript" })
      );
      try {
        await audioContext.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
      if (!active()) { closeAudio(); return; }
      microphone = audioContext.createMediaStreamSource(stream);
      capture = new AudioWorkletNode(audioContext, "capture");
      const protocol = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(
        `${protocol}://${location.host}/listen?rate=${audioContext.sampleRate}`
        + `&song=${encodeURIComponent(songId.current)}&engine=${engine}`
        + `&grammar=${useSongGrammar ? "song" : "general"}`
      );
      socket.current = ws;
      const processor = capture;
      const source = microphone;
      const context = audioContext;
      let capturing = false;
      processor.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (!active() || ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > context.sampleRate * 2 * 5) {
          setError("Se acumularon más de 5 segundos de audio en la conexión.");
          stop();
          return;
        }
        ws.send(event.data);
      };
      processor.onprocessorerror = () => {
        if (!active()) return;
        setError("Falló la captura de audio del micrófono.");
        stop();
      };
      ws.onmessage = (event) => {
        if (!active()) return;
        try {
          const message: unknown = JSON.parse(event.data);
          if (typeof message !== "object" || message === null) {
            throw new Error("Respuesta inválida del servidor.");
          }
          if ("error" in message && typeof message.error === "string") {
            throw new Error(message.error);
          }
          if ("ready" in message && message.ready === true) {
            if (!capturing) {
              source.connect(processor);
              // Mantiene el worklet activo sin reproducir el micrófono.
              const muted = context.createGain();
              muted.gain.value = 0;
              processor.connect(muted).connect(context.destination);
              capturing = true;
            }
            setError("");
            setStatus(`Escuchando con ${engine === "vosk" ? "Vosk" : "Deepgram"}`);
            return;
          }
          if (!("text" in message && typeof message.text === "string"
            && "isFinal" in message && typeof message.isFinal === "boolean")) {
            throw new Error("Formato de transcripción inválido.");
          }
          const words = toWords(message.text);
          if (message.isFinal) {
            finalWords.current = [...finalWords.current, ...words].slice(-60);
          }
          const all = message.isFinal ? finalWords.current : [...finalWords.current, ...words];
          setHeardWords(all.slice(-WORDS_TO_COMPARE));
        } catch (cause) {
          console.error("Error de reconocimiento:", cause);
          setError(cause instanceof Error ? cause.message : String(cause));
          stop();
        }
      };
      ws.onerror = () => {
        if (active()) setError("Error de conexión con el servidor de reconocimiento.");
      };
      ws.onclose = () => {
        closeAudio();
        if (!active()) return;
        setError("Se perdió la conexión. Reintentando...");
        setStatus("Reconectando...");
        finalWords.current = [];
        setHeardWords([]);
        retry.current = setTimeout(() => {
          retry.current = null;
          if (active()) void connect();
        }, 1000);
      };
    } catch (cause) {
      closeAudio();
      if (!active()) return;
      console.error("Error iniciando audio:", cause);
      setError(cause instanceof Error ? cause.message : String(cause));
      stop();
    }
  }

  const stanza = song?.estrofas[current] ?? [];
  let wordIndex = 0;

  return (
    <div className="page">
      <div className="controls">
        <select aria-label="Canción" disabled={listening} value={song?.id ?? ""} onChange={(e) => chooseSong(e.target.value)}>
          {songs.map((s) => (
            <option key={s.id} value={s.id}>
              {s.titulo}
            </option>
          ))}
        </select>
        <select aria-label="Motor de reconocimiento" disabled={listening} value={engine}
          onChange={(event) => {
            setEngine(event.target.value === "vosk" ? "vosk" : "deepgram");
            finalWords.current = [];
            setHeardWords([]);
            setCurrent(0);
            setError("");
          }}>
          <option value="deepgram">Deepgram (nube)</option>
          <option value="vosk">Vosk (local)</option>
        </select>
        {engine === "vosk" && (
          <label>
            <input type="checkbox" disabled={listening} checked={useSongGrammar}
              onChange={(event) => {
                setUseSongGrammar(event.target.checked);
                finalWords.current = [];
                setHeardWords([]);
                setCurrent(0);
                setError("");
              }} />
            Usar letra como vocabulario
          </label>
        )}
        <label>
          <input type="checkbox" checked={followWords}
            onChange={(event) => {
              const enabled = event.target.checked;
              setFollowWords(enabled);
              setWordPosition(enabled ? {
                stanza: current,
                index: findCurrentWord(heardWords, stanza,
                  wordPosition?.stanza === current ? wordPosition.index : -1),
              } : null);
            }} />
          Seguir palabras
        </label>
        <button disabled={!song} onClick={listening ? stop : start}>{listening ? "Detener" : "Escuchar"}</button>
        <span role="status">{status}</span>
        <span>
          Estrofa {current + 1} / {song?.estrofas.length ?? 0}
        </span>
        <span className="heard">Escuchado: {heardWords.join(" ")}</span>
        {error && <span className="error">{error}</span>}
      </div>

      <div className="stanza">
        {stanza.map((verse, verseIndex) => (
          <p key={verseIndex}>
            {followWords ? verse.split(/([\p{L}\p{M}\p{N}]+)/u).map((part, partIndex) => {
              if (toWords(part).length === 0) return part;
              const index = wordIndex++;
              const active = wordPosition?.stanza === current && wordPosition.index === index;
              return <span key={partIndex} className={active ? "word-active" : undefined}
                aria-current={active ? "true" : undefined}>{part}</span>;
            }) : verse}
          </p>
        ))}
      </div>
    </div>
  );
}
