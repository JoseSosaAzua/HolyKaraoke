import argparse
import json
import queue
import sys
import time
from contextlib import closing
from pathlib import Path

import sounddevice as sd
from vosk import KaldiRecognizer, Model


DEFAULT_MODEL = Path("models/vosk-model-small-es-0.42")


class TranscriptionMetrics:
    def __init__(self, sample_rate):
        self.sample_rate = sample_rate
        self.audio_origin = None
        self.audio_seconds = 0.0
        self.processing_seconds = 0.0
        self.blocks = 0
        self.visible_words = []
        self.last_partial = ""
        self.timing_reliable = True
        self.word_latencies = []

    def record_block(self, frames, captured_at, processing_seconds, status=None):
        if self.audio_origin is None:
            self.audio_origin = captured_at
        duration = frames / self.sample_rate
        self.audio_seconds += duration
        self.processing_seconds += processing_seconds
        self.blocks += 1
        if status:
            self.timing_reliable = False

    def print_partial(self, result):
        partial = result.get("partial", "")
        if partial == self.last_partial:
            return
        self.last_partial = partial
        tokens = partial.split()
        common = 0
        for token, (previous, _) in zip(tokens, self.visible_words):
            if token != previous:
                break
            common += 1
        self.visible_words = self.visible_words[:common]
        if partial:
            print(f"[Parcial] {partial}", flush=True)
            displayed_at = time.perf_counter()
            self.visible_words.extend(
                (token, displayed_at) for token in tokens[common:]
            )

    def print_result(self, result, interrupted=False):
        text = result.get("text", "")
        if not text:
            self.visible_words = []
            self.last_partial = ""
            return
        print(f"[Final] {text}", flush=True)
        displayed_at = time.perf_counter()
        observations = self.visible_words
        self.visible_words = []
        self.last_partial = ""
        words = result.get("result", [])
        if not words or self.audio_origin is None:
            print("[Métricas frase] Sin marcas de tiempo de audio disponibles.")
            return
        if not self.timing_reliable:
            print(
                "[Métricas frase] Latencias no disponibles: el estado del audio "
                "impide garantizar la continuidad de las marcas de tiempo."
            )
            return
        duration = words[-1]["end"] - words[0]["start"]
        latency = displayed_at - (self.audio_origin + words[-1]["end"])
        label = "cierre por Ctrl+C" if interrupted else "confirmación"
        print(
            f"[Métricas frase] duración de voz: {duration:.3f} s | "
            f"fin de voz -> {label} (estimado): {latency * 1000:.1f} ms"
        )
        matching_prefix = True
        for index, word in enumerate(words):
            matching_prefix = (
                matching_prefix
                and index < len(observations)
                and observations[index][0] == word["word"]
            )
            first_seen = observations[index][1] if matching_prefix else displayed_at
            word_latency = first_seen - (self.audio_origin + word["end"])
            if word_latency < 0:
                print(
                    f"[Métricas palabra] {word['word']!r}: no disponible; "
                    "marca de audio posterior a la primera aparición."
                )
                continue
            source = "parcial" if matching_prefix else "final"
            self.word_latencies.append(word_latency)
            print(
                f"[Métricas palabra] {word['word']!r} | "
                f"fin de palabra -> primera aparición ({source}, estimado): "
                f"{word_latency * 1000:.1f} ms"
            )

    def print_summary(self):
        if not self.blocks:
            print("[Métricas resumen] No se procesaron bloques de audio.")
            return
        print(
            f"[Métricas resumen] bloques: {self.blocks} | "
            f"audio: {self.audio_seconds:.3f} s | "
            f"procesamiento: {self.processing_seconds * 1000:.1f} ms | "
            f"promedio por bloque: "
            f"{self.processing_seconds * 1000 / self.blocks:.1f} ms | "
            f"RTF global: {self.processing_seconds / self.audio_seconds:.3f}"
        )
        if self.word_latencies:
            print(
                "[Métricas resumen] fin de palabra -> primera aparición: "
                f"promedio {sum(self.word_latencies) * 1000 / len(self.word_latencies):.1f} ms | "
                f"máximo {max(self.word_latencies) * 1000:.1f} ms | "
                f"palabras medidas: {len(self.word_latencies)}"
            )


def parse_args():
    parser = argparse.ArgumentParser(
        description="Transcribe voz desde el micrófono usando Vosk en local."
    )
    parser.add_argument(
        "--model",
        type=Path,
        default=DEFAULT_MODEL,
        help=f"Ruta al modelo Vosk (por defecto: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--device",
        type=int,
        help="Índice del micrófono que se usará (consulta --list-devices).",
    )
    parser.add_argument(
        "--list-devices",
        action="store_true",
        help="Muestra los dispositivos de audio disponibles y termina.",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    if args.list_devices:
        print(sd.query_devices())
        return

    if not args.model.is_dir():
        print(
            f"No se encontró el modelo Vosk en: {args.model}\n"
            "Descarga y extrae el modelo español siguiendo las instrucciones del README.",
            file=sys.stderr,
        )
        return 1

    try:
        device_info = sd.query_devices(args.device, "input")
        sample_rate = int(device_info["default_samplerate"])
        sd.check_input_settings(
            device=args.device, channels=1, dtype="int16", samplerate=sample_rate
        )
    except (sd.PortAudioError, ValueError) as error:
        print(f"No se pudo configurar el micrófono: {error}", file=sys.stderr)
        return 1

    print(f"Micrófono: {device_info['name']} ({sample_rate} Hz)")
    recognizer = None
    audio_queue = queue.Queue()
    metrics = TranscriptionMetrics(sample_rate)

    def audio_callback(indata, frames, time_info, status):
        # PortAudio timestamps share a clock; map the first sample to perf_counter.
        captured_at = time.perf_counter() - (
            time_info.currentTime - time_info.inputBufferAdcTime
        )
        audio_queue.put(
            (bytes(indata), str(status) if status else None, frames, captured_at)
        )

    try:
        with closing(
            sd.RawInputStream(
                samplerate=sample_rate,
                blocksize=0,
                device=args.device,
                dtype="int16",
                channels=1,
                callback=audio_callback,
            )
        ) as stream:
            print(f"Cargando modelo: {args.model}")
            load_started = time.perf_counter()
            model = Model(str(args.model))
            model_seconds = time.perf_counter() - load_started
            recognizer_started = time.perf_counter()
            recognizer = KaldiRecognizer(model, sample_rate)
            recognizer.SetWords(True)
            recognizer_seconds = time.perf_counter() - recognizer_started
            print(
                f"[Métricas inicio] carga del modelo: {model_seconds:.3f} s | "
                f"inicialización del reconocedor: {recognizer_seconds:.3f} s"
            )
            stream.start()
            print("Escuchando. Habla en español; pulsa Ctrl+C para terminar.")
            while True:
                audio_data, status, frames, captured_at = audio_queue.get()
                if status:
                    print(f"Estado del audio: {status}", file=sys.stderr)
                processing_started = time.perf_counter()
                accepted = recognizer.AcceptWaveform(audio_data)
                if accepted:
                    result = json.loads(recognizer.Result())
                else:
                    result = json.loads(recognizer.PartialResult())
                finished_at = time.perf_counter()
                metrics.record_block(
                    frames, captured_at, finished_at - processing_started, status
                )
                if accepted:
                    metrics.print_result(result)
                else:
                    metrics.print_partial(result)
    except KeyboardInterrupt:
        if recognizer is not None:
            final_started = time.perf_counter()
            result = json.loads(recognizer.FinalResult())
            finished_at = time.perf_counter()
            metrics.print_result(result, interrupted=True)
            print(
                "[Métricas cierre] procesamiento de FinalResult: "
                f"{(finished_at - final_started) * 1000:.1f} ms"
            )
        print("\nTranscripción finalizada.")
        metrics.print_summary()
    except sd.PortAudioError as error:
        print(
            f"No se pudo abrir o usar el micrófono: {error}\n"
            "Consulta --list-devices y prueba otra entrada "
            "(Windows WASAPI o Windows DirectSound).\n"
            "Revisa también los permisos del micrófono para aplicaciones "
            "de escritorio en Configuración de Windows.",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
