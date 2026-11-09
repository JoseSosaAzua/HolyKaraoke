import argparse
import json
import re
import struct
import sys
import unicodedata
from pathlib import Path


def emit(message):
    print(json.dumps(message, ensure_ascii=True), flush=True)


def read_exact(stream, size):
    data = bytearray()
    while len(data) < size:
        chunk = stream.read(size - len(data))
        if not chunk:
            if not data:
                return None
            raise ValueError("Bloque de audio incompleto.")
        data.extend(chunk)
    return bytes(data)


def load_grammar(song_path):
    with song_path.open(encoding="utf-8-sig") as song_file:
        song = json.load(song_file)
    stanzas = song.get("estrofas") if isinstance(song, dict) else None
    if not isinstance(stanzas, list) or not stanzas:
        raise ValueError("La cancion debe contener estrofas.")
    phrases = []
    for stanza in stanzas:
        if not isinstance(stanza, list) or not stanza:
            raise ValueError("Cada estrofa debe contener versos.")
        for verse in stanza:
            if not isinstance(verse, str):
                raise ValueError("Los versos de la cancion deben ser texto.")
            normalized = unicodedata.normalize("NFC", verse.lower())
            phrase = " ".join(re.findall(r"[a-záéíóúñü0-9]+", normalized))
            if phrase and phrase not in phrases:
                phrases.append(phrase)
    if not phrases:
        raise ValueError("La cancion no contiene palabras para Vosk.")
    return phrases + ["[unk]"]


def create_recognizer(model, rate, recognizer_type, grammar=None):
    if grammar is None:
        return recognizer_type(model, rate)
    words = {word for phrase in grammar if phrase != "[unk]" for word in phrase.split()}
    if not any(model.vosk_model_find_word(word) >= 0 for word in words):
        raise ValueError("Ninguna palabra de la cancion existe en el modelo Vosk.")
    # Native Vosk logs individual out-of-vocabulary words to stderr.
    try:
        return recognizer_type(model, rate, json.dumps(grammar, ensure_ascii=False))
    except Exception as error:
        raise RuntimeError(f"El modelo no pudo activar la gramatica de la cancion: {error}") from error


def transcribe(stream, recognizer):
    previous_partial = ""
    while True:
        header = read_exact(stream, 4)
        if header is None:
            return
        size = struct.unpack("<I", header)[0]
        if size == 0 or size > 1024 * 1024 or size % 2:
            raise ValueError("Tamano de audio PCM invalido.")
        audio = read_exact(stream, size)
        if audio is None:
            raise ValueError("Falta el audio del bloque.")
        if recognizer.AcceptWaveform(audio):
            result = json.loads(recognizer.Result())
            emit({"text": result.get("text", ""), "isFinal": True})
            previous_partial = ""
        else:
            result = json.loads(recognizer.PartialResult())
            partial = result.get("partial", "")
            if partial != previous_partial:
                emit({"text": partial, "isFinal": False})
                previous_partial = partial


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--rate", type=int, required=True)
    parser.add_argument("--song", type=Path)
    args = parser.parse_args()
    try:
        from vosk import KaldiRecognizer, Model

        if not args.model.is_dir():
            raise ValueError(f"No se encontro el modelo Vosk: {args.model}")
        grammar = load_grammar(args.song) if args.song else None
        # Vosk raises plain Exception when its native model loader fails.
        try:
            model = Model(str(args.model))
        except Exception as error:
            raise RuntimeError(f"No se pudo cargar el modelo: {error}") from error
        recognizer = create_recognizer(model, args.rate, KaldiRecognizer, grammar)
        emit({"ready": True})
        transcribe(sys.stdin.buffer, recognizer)
    except (ImportError, OSError, ValueError, RuntimeError) as error:
        print(f"Vosk: {error}", file=sys.stderr, flush=True)
        emit({"error": f"Vosk: {error}"})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
