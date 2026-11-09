import contextlib
import io
import unittest
from unittest.mock import Mock, patch

import main


class MicrophoneTests(unittest.TestCase):
    def setUp(self):
        self.output = io.StringIO()
        self.errors = io.StringIO()
        self.enterContext(contextlib.redirect_stdout(self.output))
        self.enterContext(contextlib.redirect_stderr(self.errors))
        self.enterContext(
            patch("sys.argv", ["main.py", "--model", ".", "--device", "12"])
        )
        self.devices = self.enterContext(
            patch.object(
                main.sd,
                "query_devices",
                return_value={"name": "Test microphone", "default_samplerate": 48000},
            )
        )
        self.settings = self.enterContext(patch.object(main.sd, "check_input_settings"))
        self.model = self.enterContext(patch.object(main, "Model"))
        self.recognizer = self.enterContext(patch.object(main, "KaldiRecognizer"))
        self.recognizer.return_value.FinalResult.return_value = '{"text": ""}'
        self.stream = self.enterContext(patch.object(main.sd, "RawInputStream"))
        self.audio_queue = self.enterContext(patch.object(main.queue, "Queue"))

    def test_native_rate_is_used_for_stream_and_recognizer(self):
        self.audio_queue.return_value.get.side_effect = KeyboardInterrupt
        self.assertEqual(main.main(), 0)
        self.devices.assert_called_once_with(12, "input")
        self.settings.assert_called_once_with(
            device=12, channels=1, dtype="int16", samplerate=48000
        )
        self.recognizer.assert_called_once_with(self.model.return_value, 48000)
        self.assertEqual(self.stream.call_args.kwargs["samplerate"], 48000)
        self.assertEqual(self.stream.call_args.kwargs["blocksize"], 0)
        self.assertIn("Escuchando", self.output.getvalue())

    def test_open_error_is_reported_without_claiming_to_listen(self):
        self.stream.side_effect = main.sd.PortAudioError("MME error 11")
        self.assertEqual(main.main(), 1)
        self.assertIn("MME error 11", self.errors.getvalue())
        self.assertIn("Windows WASAPI", self.errors.getvalue())
        self.assertNotIn("Escuchando", self.output.getvalue())
        self.model.assert_not_called()

    def test_device_opens_before_model_and_starts_after_recognizer(self):
        order = Mock()
        order.attach_mock(self.stream, "open")
        order.attach_mock(self.model, "model")
        order.attach_mock(self.recognizer, "recognizer")
        self.audio_queue.return_value.get.side_effect = KeyboardInterrupt
        self.assertEqual(main.main(), 0)
        calls = [call[0] for call in order.mock_calls]
        self.assertLess(calls.index("open"), calls.index("model"))
        self.assertLess(calls.index("recognizer"), calls.index("open().start"))
        self.stream.return_value.close.assert_called_once()

    def test_model_failure_closes_device_without_starting_capture(self):
        self.model.side_effect = RuntimeError("Invalid model")
        with self.assertRaisesRegex(RuntimeError, "Invalid model"):
            main.main()
        self.stream.return_value.start.assert_not_called()
        self.stream.return_value.close.assert_called_once()

    def test_invalid_input_is_reported_before_loading_model(self):
        self.devices.side_effect = ValueError("Invalid input device")
        self.assertEqual(main.main(), 1)
        self.assertIn("Invalid input device", self.errors.getvalue())
        self.model.assert_not_called()

    def test_transcription_reports_processing_and_phrase_latency(self):
        self.audio_queue.return_value.get.side_effect = [
            (b"\0\0" * 48000, None, 48000, 8.0),
            KeyboardInterrupt,
        ]
        self.recognizer.return_value.AcceptWaveform.return_value = True
        self.recognizer.return_value.Result.return_value = (
            '{"text": "hola", "result": [{"word": "hola", "start": 0.1, "end": 0.7}]}'
        )
        with patch.object(
            main.time, "perf_counter",
            side_effect=[0, 1, 1, 1.25, 10, 10.02, 10.03, 12, 12.005],
        ):
            self.assertEqual(main.main(), 0)
        self.recognizer.return_value.SetWords.assert_called_once_with(True)
        output = self.output.getvalue()
        self.assertIn("carga del modelo: 1.000 s", output)
        self.assertIn("inicialización del reconocedor: 0.250 s", output)
        self.assertIn("procesamiento: 20.0 ms", output)
        self.assertNotIn("Métricas bloque", output)
        self.assertIn("duración de voz: 0.600 s", output)
        self.assertIn("confirmación (estimado): 1330.0 ms", output)
        self.assertIn("primera aparición (final, estimado): 1330.0 ms", output)
        self.assertIn("FinalResult: 5.0 ms", output)
        self.assertIn("RTF global: 0.020", output)

    def test_partial_and_manual_final_keep_transcription(self):
        self.audio_queue.return_value.get.side_effect = [
            (b"\0\0" * 48000, None, 48000, 8.0),
            KeyboardInterrupt,
        ]
        self.recognizer.return_value.AcceptWaveform.return_value = False
        self.recognizer.return_value.PartialResult.return_value = '{"partial": "hola"}'
        self.recognizer.return_value.FinalResult.return_value = (
            '{"text": "hola mundo", "result": ['
            '{"word": "hola", "start": 0.1, "end": 0.4},'
            '{"word": "mundo", "start": 0.5, "end": 0.7}]}'
        )
        with patch.object(
            main.time, "perf_counter",
            side_effect=[0, 1, 1, 1.25, 10, 10.02, 10.03, 12, 12.005, 12.01],
        ):
            self.assertEqual(main.main(), 0)
        self.assertIn("hola", self.output.getvalue())
        self.assertIn("hola mundo", self.output.getvalue())
        self.assertIn("cierre por Ctrl+C (estimado): 3310.0 ms", self.output.getvalue())
        self.assertIn("primera aparición (parcial, estimado): 1630.0 ms", self.output.getvalue())

    def test_callback_maps_capture_clock_to_monotonic_clock(self):
        def start_capture():
            callback = self.stream.call_args.kwargs["callback"]
            timing = Mock(currentTime=50.0, inputBufferAdcTime=49.9)
            callback(b"\0\0" * 480, 480, timing, None)

        self.stream.return_value.start.side_effect = start_capture
        self.audio_queue.return_value.get.side_effect = KeyboardInterrupt
        with patch.object(main.time, "perf_counter", return_value=100.0):
            self.assertEqual(main.main(), 0)
        data, status, frames, captured_at = self.audio_queue.return_value.put.call_args.args[0]
        self.assertEqual(data, b"\0\0" * 480)
        self.assertIsNone(status)
        self.assertEqual(frames, 480)
        self.assertAlmostEqual(captured_at, 99.9)


class MetricsTests(unittest.TestCase):
    def setUp(self):
        self.output = io.StringIO()
        self.enterContext(contextlib.redirect_stdout(self.output))
        self.metrics = main.TranscriptionMetrics(48000)

    def test_summary_uses_total_audio_not_unweighted_block_ratios(self):
        self.metrics.record_block(4800, 100, 0.02)
        self.metrics.record_block(48000, 100.1, 0.09)
        self.metrics.print_summary()
        output = self.output.getvalue()
        self.assertIn("audio: 1.100 s", output)
        self.assertIn("promedio por bloque: 55.0 ms", output)
        self.assertIn("RTF global: 0.100", output)
        self.assertEqual(self.metrics.audio_origin, 100)

    def test_later_phrase_uses_original_audio_origin(self):
        self.metrics.record_block(48000, 100, 0.01)
        self.metrics.record_block(48000, 101, 0.01)
        with patch.object(main.time, "perf_counter", return_value=102.3):
            self.metrics.print_result(
                {"text": "segunda", "result": [
                    {"word": "segunda", "start": 1.2, "end": 1.8}
                ]},
            )
        self.assertIn("confirmación (estimado): 500.0 ms", self.output.getvalue())

    def test_missing_timestamps_and_no_audio_are_explicit(self):
        self.metrics.print_result({"text": "hola"})
        self.metrics.print_summary()
        self.assertIn("Sin marcas de tiempo", self.output.getvalue())
        self.assertIn("No se procesaron bloques", self.output.getvalue())

    def test_empty_result_does_not_report_a_phrase(self):
        self.metrics.print_result({"text": ""})
        self.assertEqual(self.output.getvalue(), "")

    def test_partial_is_printed_only_when_changed_and_not_overwritten(self):
        for _ in range(200):
            self.metrics.record_block(480, 100, 0.0002)
        with patch.object(main.time, "perf_counter", return_value=101):
            for _ in range(200):
                self.metrics.print_partial({"partial": "hola"})
        self.assertEqual(self.output.getvalue(), "[Parcial] hola\n")
        self.assertEqual(self.metrics.visible_words, [("hola", 101)])

    def test_revised_suffix_does_not_reuse_wrong_word_appearance(self):
        self.metrics.record_block(48000, 100, 0.01)
        with patch.object(main.time, "perf_counter", side_effect=[101, 102, 103]):
            self.metrics.print_partial({"partial": "hola martes"})
            self.metrics.print_partial({"partial": "hola mundo"})
            self.metrics.print_result({"text": "hola mundo", "result": [
                {"word": "hola", "start": 0.1, "end": 0.5},
                {"word": "mundo", "start": 0.6, "end": 0.9},
            ]})
        self.assertIn("'hola' | fin de palabra -> primera aparición (parcial, estimado): 500.0 ms", self.output.getvalue())
        self.assertIn("'mundo' | fin de palabra -> primera aparición (parcial, estimado): 1100.0 ms", self.output.getvalue())
        self.assertEqual(self.metrics.visible_words, [])
        self.assertEqual(self.metrics.last_partial, "")

    def test_empty_partial_invalidates_previous_hypothesis(self):
        with patch.object(main.time, "perf_counter", side_effect=[101, 102]):
            self.metrics.print_partial({"partial": "hola"})
            self.metrics.print_partial({"partial": ""})
            self.metrics.print_partial({"partial": "hola"})
        self.assertEqual(self.metrics.visible_words, [("hola", 102)])

    def test_audio_status_disables_latency_but_keeps_text(self):
        self.metrics.record_block(48000, 100, 0.01, "input overflow")
        self.metrics.print_result({"text": "hola", "result": [
            {"word": "hola", "start": 0.1, "end": 0.5}
        ]})
        self.assertIn("[Final] hola", self.output.getvalue())
        self.assertIn("Latencias no disponibles", self.output.getvalue())
        self.assertEqual(self.metrics.word_latencies, [])

    def test_final_correction_is_measured_at_final_display(self):
        self.metrics.record_block(48000, 100, 0.01)
        with patch.object(main.time, "perf_counter", side_effect=[101, 102]):
            self.metrics.print_partial({"partial": "martes"})
            self.metrics.print_result({"text": "mundo", "result": [
                {"word": "mundo", "start": 0.1, "end": 0.5}
            ]})
        self.assertIn("primera aparición (final, estimado): 1500.0 ms", self.output.getvalue())

    def test_inconsistent_word_time_is_reported_not_clamped(self):
        self.metrics.record_block(48000, 100, 0.01)
        with patch.object(main.time, "perf_counter", side_effect=[100.1, 102]):
            self.metrics.print_partial({"partial": "hola"})
            self.metrics.print_result({"text": "hola", "result": [
                {"word": "hola", "start": 0.1, "end": 0.5}
            ]})
        self.assertIn("marca de audio posterior", self.output.getvalue())
        self.assertEqual(self.metrics.word_latencies, [])


if __name__ == "__main__":
    unittest.main()
