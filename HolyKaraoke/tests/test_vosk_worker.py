import io
import json
import struct
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock

from server.vosk_worker import create_recognizer, load_grammar, read_exact, transcribe


def frame(audio=b"\0\0" * 256):
    return struct.pack("<I", len(audio)) + audio


class WorkerTests(unittest.TestCase):
    def grammar_for(self, song):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "song.json"
            path.write_text(json.dumps(song, ensure_ascii=False), encoding="utf-8-sig")
            return load_grammar(path)

    def test_grammar_normalizes_and_deduplicates_all_stanzas(self):
        self.assertEqual(self.grammar_for({"estrofas": [
            ["¡HOLA, corazón!", "Nueva—mañana", "hola corazo\u0301n"],
            ["GRACIAS a ti", "..."],
        ]}), ["hola corazón", "nueva mañana", "gracias a ti", "[unk]"])

    def test_invalid_songs_do_not_fall_back_to_general_recognition(self):
        for song in [None, {}, {"estrofas": []}, {"estrofas": "hola"},
                     {"estrofas": [[]]}, {"estrofas": [None]},
                     {"estrofas": [[1]]}, {"estrofas": [["...", " "]]}]:
            with self.subTest(song=song), self.assertRaises(ValueError):
                self.grammar_for(song)

    def test_missing_and_malformed_song_files(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "song.json"
            with self.assertRaises(FileNotFoundError):
                load_grammar(path)
            path.write_text("{", encoding="utf-8")
            with self.assertRaises(json.JSONDecodeError):
                load_grammar(path)

    def test_song_grammar_reaches_recognizer_without_losing_accents(self):
        model = Mock()
        model.vosk_model_find_word.return_value = 1
        factory = Mock()
        grammar = ["hola corazón", "[unk]"]
        self.assertIs(create_recognizer(model, 16000, factory, grammar), factory.return_value)
        args = factory.call_args.args
        self.assertEqual(args[:2], (model, 16000))
        self.assertEqual(json.loads(args[2]), grammar)

    def test_general_mode_keeps_original_constructor(self):
        model = Mock()
        factory = Mock()
        create_recognizer(model, 16000, factory)
        factory.assert_called_once_with(model, 16000)
        model.vosk_model_find_word.assert_not_called()

    def test_unknown_vocabulary_and_unsupported_models_fail_explicitly(self):
        model = Mock()
        model.vosk_model_find_word.return_value = -1
        factory = Mock()
        with self.assertRaisesRegex(ValueError, "Ninguna palabra"):
            create_recognizer(model, 16000, factory, ["xyz", "[unk]"])
        factory.assert_not_called()
        model.vosk_model_find_word.return_value = 1
        factory.side_effect = Exception("Unsupported grammar")
        with self.assertRaisesRegex(RuntimeError, "gramatica"):
            create_recognizer(model, 16000, factory, ["hola", "[unk]"])

    def test_partial_corrections_empty_reset_and_final(self):
        recognizer = Mock()
        recognizer.AcceptWaveform.side_effect = [False, False, False, False, True]
        recognizer.PartialResult.side_effect = [
            '{"partial":"hola"}', '{"partial":"hola"}',
            '{"partial":"ola"}', '{"partial":""}',
        ]
        recognizer.Result.return_value = '{"text":"hola mundo"}'
        output = io.StringIO()
        with redirect_stdout(output):
            transcribe(io.BytesIO(frame() * 5), recognizer)
        self.assertEqual([json.loads(line) for line in output.getvalue().splitlines()], [
            {"text": "hola", "isFinal": False},
            {"text": "ola", "isFinal": False},
            {"text": "", "isFinal": False},
            {"text": "hola mundo", "isFinal": True},
        ])

    def test_empty_final_clears_segment(self):
        recognizer = Mock()
        recognizer.AcceptWaveform.return_value = True
        recognizer.Result.return_value = '{"text":""}'
        output = io.StringIO()
        with redirect_stdout(output):
            transcribe(io.BytesIO(frame()), recognizer)
        self.assertEqual(json.loads(output.getvalue()), {"text": "", "isFinal": True})

    def test_rejects_invalid_or_truncated_frames(self):
        for data in [b"\x00", struct.pack("<I", 0), struct.pack("<I", 3),
                     struct.pack("<I", 1024 * 1024 + 2), struct.pack("<I", 2), b"\x04\0\0\0\0\0"]:
            with self.subTest(data=data), self.assertRaises(ValueError):
                transcribe(io.BytesIO(data), Mock())

    def test_read_exact_handles_short_reads(self):
        class ShortReader(io.BytesIO):
            def read(self, size):
                return super().read(min(size, 1))
        self.assertEqual(read_exact(ShortReader(b"abcd"), 4), b"abcd")
        self.assertIsNone(read_exact(io.BytesIO(), 4))


if __name__ == "__main__":
    unittest.main()
