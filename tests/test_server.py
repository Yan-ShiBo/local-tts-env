import asyncio
import subprocess
import sys
import unittest
import warnings
from unittest.mock import patch

import numpy as np

warnings.filterwarnings(
    "ignore",
    message="Using `httpx` with `starlette.testclient` is deprecated",
)
from fastapi.testclient import TestClient

import server


class FakePipeline:
    def __init__(self, segments=None, error=None):
        self.segments = segments or [np.array([0.0, 0.25, -0.25, 0.0], dtype=np.float32)]
        self.error = error
        self.calls = []

    def __call__(self, text, voice, speed):
        self.calls.append((text, voice, speed))
        if self.error:
            raise self.error
        for segment in self.segments:
            yield None, None, segment


class AudioCoreTests(unittest.TestCase):
    def test_lifespan_validates_ffmpeg_before_loading_model(self):
        from audio_encoding import AudioEncodingError

        async def exercise():
            with patch.object(
                server,
                "validate_ffmpeg",
                create=True,
                side_effect=AudioEncodingError("FFmpeg is unavailable"),
            ):
                async with server.lifespan(server.app):
                    pass

        with self.assertRaises(AudioEncodingError):
            asyncio.run(exercise())

    def test_server_module_can_import_without_torch(self):
        script = """
import builtins
real_import = builtins.__import__
def guarded_import(name, *args, **kwargs):
    if name == "torch":
        raise ImportError("blocked for unit test")
    return real_import(name, *args, **kwargs)
builtins.__import__ = guarded_import
import server
assert server.torch is None
"""
        result = subprocess.run(
            [sys.executable, "-c", script],
            cwd=server.os.path.dirname(server.__file__),
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_combines_segments_with_silence(self):
        combined = server._combine_audio_segments(
            [
                np.array([1.0, 2.0], dtype=np.float32),
                np.array([3.0], dtype=np.float32),
            ],
            sample_rate=1000,
            silence_ms=100,
            fade_ms=0,
        )

        self.assertEqual(len(combined), 103)
        np.testing.assert_array_equal(combined[:2], [1.0, 2.0])
        np.testing.assert_array_equal(combined[2:102], np.zeros(100))
        self.assertEqual(combined[-1], 3.0)

    def test_fade_does_not_mutate_input(self):
        original = np.ones(100, dtype=np.float32)
        faded = server._apply_fade(original, sample_rate=1000, fade_ms=10)

        self.assertTrue(np.all(original == 1.0))
        self.assertEqual(faded[0], 0.0)
        self.assertEqual(faded[-1], 0.0)

    def test_empty_segments_fail(self):
        with self.assertRaisesRegex(RuntimeError, "模型未生成任何音频"):
            server._combine_audio_segments([])


    def test_translation_cleanup_removes_qwen_thinking(self):
        cleaned = server._clean_translation_response(
            "<think>reasoning</think>\n你好，世界"
        )

        self.assertEqual(cleaned, "你好，世界")


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.print_patcher = patch("builtins.print")
        self.print_patcher.start()
        self.original_pipeline = server.pipeline
        self.original_british_pipeline = server.british_pipeline
        self.original_inference_lock = server.inference_lock
        server.pipeline = FakePipeline()
        server.british_pipeline = FakePipeline()
        server.inference_lock = asyncio.Lock()
        server.actual_device = "cpu"
        self.client = TestClient(server.app)

    def tearDown(self):
        server.pipeline = self.original_pipeline
        server.british_pipeline = self.original_british_pipeline
        server.inference_lock = self.original_inference_lock
        self.print_patcher.stop()

    def test_tts_returns_wav_and_uses_requested_settings(self):
        response = self.client.post(
            "/tts",
            json={"text": "Hello world", "voice": "af_bella", "speed": 1.0},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "audio/wav")
        self.assertTrue(response.content.startswith(b"RIFF"))
        self.assertEqual(
            server.pipeline.calls,
            [("Hello world", "af_bella", 1.0)],
        )

    def test_ogg_query_returns_opus(self):
        response = self.client.post(
            "/tts?format=ogg",
            json={"text": "Hello world", "voice": "af_bella", "speed": 1.0},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "audio/ogg")
        self.assertTrue(response.content.startswith(b"OggS"))
        self.assertIn(b"OpusHead", response.content[:256])
        self.assertEqual(
            server.pipeline.calls,
            [("Hello world", "af_bella", 1.0)],
        )

    def test_accept_ogg_returns_opus(self):
        response = self.client.post(
            "/tts",
            headers={"Accept": "audio/ogg"},
            json={"text": "Hello world"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "audio/ogg")
        self.assertTrue(response.content.startswith(b"OggS"))

    def test_query_format_overrides_accept_header(self):
        response = self.client.post(
            "/tts?format=wav",
            headers={"Accept": "audio/ogg"},
            json={"text": "Hello world"},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "audio/wav")
        self.assertTrue(response.content.startswith(b"RIFF"))

    def test_unsupported_audio_format_returns_406(self):
        cases = [
            ("/tts?format=mp3", {}),
            ("/tts", {"Accept": "audio/mpeg"}),
        ]

        for path, headers in cases:
            with self.subTest(path=path, headers=headers):
                response = self.client.post(
                    path,
                    headers=headers,
                    json={"text": "Hello world"},
                )

                self.assertEqual(response.status_code, 406)
        self.assertEqual(server.pipeline.calls, [])

    def test_boundary_text_reaches_pipeline_unchanged(self):
        cases = [
            "...?!",
            "I have 42 cats",
            "Visit https://example.com/docs",
            "Hello 世界 42",
        ]

        for text in cases:
            with self.subTest(text=text):
                response = self.client.post("/tts", json={"text": text})

                self.assertEqual(response.status_code, 200)
                self.assertEqual(server.pipeline.calls[-1][0], text)

    def test_ogg_encoding_errors_are_not_exposed(self):
        from audio_encoding import AudioEncodingError

        with patch.object(
            server,
            "encode_ogg_opus",
            create=True,
            side_effect=AudioEncodingError(r"C:\secret\ffmpeg.exe"),
        ):
            response = self.client.post(
                "/tts?format=ogg",
                json={"text": "Hello world"},
            )

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "语音生成失败")
        self.assertNotIn("secret", response.text)

    def test_invalid_requests_do_not_reach_pipeline(self):
        cases = [
            {"text": "Hello", "voice": "not-a-voice"},
            {"text": "Hello", "speed": 0},
            {"text": "Hello", "speed": "NaN"},
            {"text": "Hello", "unexpected": True},
            {"text": "x" * 10001},
        ]

        for payload in cases:
            with self.subTest(payload=list(payload)):
                response = self.client.post("/tts", json=payload)
                self.assertEqual(response.status_code, 422)

        self.assertEqual(server.pipeline.calls, [])

    def test_british_voice_uses_british_pipeline(self):
        response = self.client.post(
            "/tts",
            json={"text": "Schedule", "voice": "bf_emma", "speed": 0.8},
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(server.pipeline.calls, [])
        self.assertEqual(
            server.british_pipeline.calls,
            [("Schedule", "bf_emma", 0.8)],
        )

    def test_blank_text_is_rejected(self):
        response = self.client.post("/tts", json={"text": "   "})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(server.pipeline.calls, [])

    def test_internal_error_is_not_exposed(self):
        server.pipeline = FakePipeline(error=RuntimeError("secret path"))
        response = self.client.post("/tts", json={"text": "Hello"})

        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json()["detail"], "语音生成失败")
        self.assertNotIn("secret path", response.text)

    def test_translate_uses_local_ollama_settings(self):
        with patch.object(
            server,
            "_call_ollama_translate_raw",
            create=True,
            return_value="你好，世界",
        ) as call:
            response = self.client.post(
                "/translate",
                json={
                    "text": "Hello, world",
                    "model": "translategemma:4b",
                    "target_language": "Simplified Chinese",
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["translated_text"], "你好，世界")
        self.assertEqual(payload["model"], "translategemma:4b")
        self.assertEqual(payload["target_language"], "Simplified Chinese")
        call.assert_called_once_with(
            "Hello, world",
            "translategemma:4b",
            "Simplified Chinese",
        )

    def test_translate_rejects_blank_text(self):
        response = self.client.post("/translate", json={"text": "   "})

        self.assertEqual(response.status_code, 400)

    def test_translate_normalizes_selection_linebreaks(self):
        with patch.object(
            server,
            "_call_ollama_translate_raw",
            create=True,
            return_value="formula description",
        ) as call:
            response = self.client.post(
                "/translate",
                json={
                    "text": "B\n0\n(x)\n->\nD\nw\n\n中文说明",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["model"], "translategemma:4b")
        call.assert_called_once_with(
            "B 0 (x) -> D w\n\n中文说明",
            "translategemma:4b",
            "Simplified Chinese",
        )

    def test_translate_hides_ollama_errors(self):
        with patch.object(
            server,
            "_call_ollama_translate_raw",
            create=True,
            side_effect=RuntimeError("secret model path"),
        ):
            response = self.client.post(
                "/translate",
                json={"text": "Hello"},
            )

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"], "Local Ollama translation failed")
        self.assertNotIn("secret model path", response.text)

    def test_translate_restores_formula_symbol_with_chinese_description(self):
        with patch.object(
            server,
            "_call_ollama_translate_raw",
            create=True,
            return_value="该阶段使用 __MATH_0__。",
        ) as translate_call:
            response = self.client.post(
                "/translate",
                json={
                    "text": "This stage uses [[MATH: D_w \\rightarrow \\hat{B}(x)]].",
                    "model": "translategemma:4b",
                    "target_language": "Simplified Chinese",
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("D_w → B̂(x)", payload["translated_text"])
        self.assertIn("D的下角标w指向B的估计值关于x的函数", payload["translated_text"])
        self.assertNotIn("__MATH_0__", payload["translated_text"])
        translate_call.assert_called_once_with(
            "This stage uses __MATH_0__.",
            "translategemma:4b",
            "Simplified Chinese",
        )

    def test_translate_english_formula_description_for_read_fallback(self):
        with patch.object(
            server,
            "_call_ollama_translate_raw",
            create=True,
            return_value="This stage uses __MATH_0__.",
        ), patch.object(
            server,
            "_call_ollama_formula_verbalization",
            create=True,
            return_value=["D sub w maps to B hat of x"],
        ) as verbalize_call:
            response = self.client.post(
                "/translate",
                json={
                    "text": "This stage uses [[MATH: D_w \\rightarrow \\hat{B}(x)]].",
                    "target_language": "English",
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("D_w → B̂(x)", payload["translated_text"])
        self.assertIn("D sub w maps to B hat of x", payload["translated_text"])
        self.assertNotIn("下标", payload["translated_text"])
        verbalize_call.assert_called_once_with(
            ["[[MATH: D_w \\rightarrow \\hat{B}(x)]]"],
            "translategemma:4b",
            None,
        )

    def test_translate_describes_dataset_arrow_without_mapping_wording(self):
        with patch.object(
            server,
            "_call_ollama_translate_raw",
            create=True,
            return_value="公式为 __MATH_0__。",
        ):
            response = self.client.post(
                "/translate",
                json={
                    "text": r"[[MATH: B_\theta(x)\rightarrow D_w=\{(x_i,B_\theta(x_i),w_i)\}]]",
                    "target_language": "Simplified Chinese",
                },
            )

        self.assertEqual(response.status_code, 200)
        translated = response.json()["translated_text"]
        self.assertIn("B_θ(x) → D_w={(x_i,B_θ(x_i),w_i)}", translated)
        self.assertIn("由B的下角标theta关于x的函数得到D的下角标w", translated)
        self.assertIn("D的下角标w定义为由三元组", translated)
        self.assertNotIn("映射到", translated)

    def test_read_prepare_uses_translategemma_by_default(self):
        with patch.object(
            server,
            "_call_ollama_read_prepare",
            create=True,
            return_value="This stage uses B zero of x mapped to D w.",
        ) as call:
            response = self.client.post(
                "/read/prepare",
                json={
                    "text": "这一阶段是：\n\nB\n0\n(x)\n->\nD\nw",
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["model"], "translategemma:4b")
        self.assertEqual(
            payload["prepared_text"],
            "This stage uses B zero of x mapped to D w.",
        )
        call.assert_called_once_with(
            "这一阶段是：\n\nB 0 (x) -> D w",
            "translategemma:4b",
        )

    def test_read_prepare_hides_ollama_errors(self):
        with patch.object(
            server,
            "_call_ollama_read_prepare",
            create=True,
            side_effect=RuntimeError("secret read prompt"),
        ):
            response = self.client.post(
                "/read/prepare",
                json={"text": "中文 and $x^2$"},
            )

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"], "Local read preparation failed")
        self.assertNotIn("secret read prompt", response.text)

    def test_read_prepare_final_cleanup_removes_remaining_chinese(self):
        cleaned = server._remove_remaining_cjk_for_tts(
            "其中 B sub zero of x is a neural barrier candidate."
        )

        self.assertEqual(
            cleaned,
            "where B sub zero of x is a neural barrier candidate.",
        )
        self.assertFalse(server._contains_cjk(cleaned))

    def test_formula_verbalize_uses_local_ollama(self):
        with patch.object(
            server,
            "_call_ollama_formula_verbalization",
            create=True,
            return_value=["x squared plus y squared equals z squared"],
        ) as call:
            response = self.client.post(
                "/formula/verbalize",
                json={
                    "formulas": ["x^2 + y^2 = z^2"],
                    "context": "Pythagorean theorem",
                    "model": "translategemma:4b",
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(
            payload["verbalizations"],
            ["x squared plus y squared equals z squared"],
        )
        self.assertEqual(payload["model"], "translategemma:4b")
        call.assert_called_once_with(
            ["x^2 + y^2 = z^2"],
            "translategemma:4b",
            "Pythagorean theorem",
        )

    def test_formula_verbalize_hides_ollama_errors(self):
        with patch.object(
            server,
            "_call_ollama_formula_verbalization",
            create=True,
            side_effect=RuntimeError("secret formula prompt"),
        ):
            response = self.client.post(
                "/formula/verbalize",
                json={"formulas": ["\\begin{matrix}a&b\\end{matrix}"]},
            )

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"], "Local formula verbalization failed")
        self.assertNotIn("secret formula prompt", response.text)

    def test_formula_verbalization_parser_accepts_json_array(self):
        parsed = server._parse_formula_verbalizations(
            '["x squared", "alpha over beta"]',
            2,
        )

        self.assertEqual(parsed, ["x squared", "alpha over beta"])

    def test_translate_request_validation(self):
        cases = [
            {"text": "Hello", "model": "bad model"},
            {"text": "Hello", "target_language": ""},
            {"text": "x" * 12001},
            {"text": "Hello", "unexpected": True},
        ]

        for payload in cases:
            with self.subTest(payload=list(payload)):
                response = self.client.post("/translate", json=payload)
                self.assertEqual(response.status_code, 422)

    def test_translate_health_reports_model_state(self):
        def fake_ollama_json(path):
            if path == "/api/tags":
                return {"models": [{"name": "qwen3:14b"}, {"name": "translategemma:4b"}]}
            if path == "/api/ps":
                return {"models": [{"name": "translategemma:4b"}]}
            raise AssertionError(path)

        with patch.object(
            server,
            "_call_ollama_json",
            create=True,
            side_effect=fake_ollama_json,
        ):
            response = self.client.get("/translate/health")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "running")
        self.assertEqual(payload["model"], "translategemma:4b")
        self.assertTrue(payload["ollama_reachable"])
        self.assertTrue(payload["model_available"])
        self.assertTrue(payload["model_running"])

    def test_translate_health_handles_ollama_offline(self):
        with patch.object(
            server,
            "_call_ollama_json",
            create=True,
            side_effect=RuntimeError("secret connection details"),
        ):
            response = self.client.get("/translate/health")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "error")
        self.assertFalse(payload["ollama_reachable"])
        self.assertFalse(payload["model_available"])
        self.assertFalse(payload["model_running"])
        self.assertNotIn("secret connection details", response.text)

    def test_health_identifies_service(self):
        response = self.client.get("/health")
        payload = response.json()

        self.assertEqual(payload["service"], "kokoro-tts")
        self.assertTrue(payload["ready"])
        self.assertEqual(payload["default_translate_model"], server.OLLAMA_TRANSLATE_MODEL)
        self.assertEqual(payload["default_read_model"], server.OLLAMA_READ_MODEL)
        self.assertEqual(payload["default_formula_model"], server.OLLAMA_FORMULA_MODEL)

    def test_openapi_declares_wav_response(self):
        content = server.app.openapi()["paths"]["/tts"]["post"]["responses"]["200"][
            "content"
        ]
        self.assertIn("audio/wav", content)
        self.assertIn("audio/ogg", content)
        self.assertNotIn("application/json", content)

    def test_test_page_exposes_streaming_mode(self):
        response = self.client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertIn('id="streamMode"', response.text)
        self.assertIn("/tts/stream", response.text)
        self.assertIn("MediaSource", response.text)

    def test_cors_does_not_allow_arbitrary_websites(self):
        response = self.client.get(
            "/health",
            headers={"Origin": "https://example.com"},
        )
        self.assertNotIn("access-control-allow-origin", response.headers)

    def test_busy_server_rejects_second_request(self):
        async def exercise():
            await server.inference_lock.acquire()
            try:
                request = server.TTSRequest(text="Hello")
                with self.assertRaises(Exception) as raised:
                    await server.tts_endpoint(request)
                self.assertEqual(raised.exception.status_code, 429)
            finally:
                server.inference_lock.release()

        asyncio.run(exercise())


if __name__ == "__main__":
    unittest.main()
