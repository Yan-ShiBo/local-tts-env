import asyncio
import json
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


class FakeUrlopenResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


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

    def test_ollama_thinking_mode_disabled_for_qwen3_generation(self):
        payload = {}

        server._apply_ollama_thinking_mode(payload, "qwen3:14b")

        self.assertIs(payload["think"], False)

    def test_ollama_thinking_mode_disabled_for_other_reasoning_models(self):
        payload = {}

        server._apply_ollama_thinking_mode(payload, "deepseek-r1:8b")

        self.assertIs(payload["think"], False)

    def test_ollama_thinking_mode_unchanged_for_non_reasoning_models(self):
        payload = {}

        server._apply_ollama_thinking_mode(payload, "translategemma:4b")

        self.assertNotIn("think", payload)

    def test_ollama_thinking_mode_unchanged_for_embedding_models(self):
        payload = {}

        server._apply_ollama_thinking_mode(payload, "qwen3-embedding:4b")

        self.assertNotIn("think", payload)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.print_patcher = patch("builtins.print")
        self.print_patcher.start()
        self.original_pipeline = server.pipeline
        self.original_british_pipeline = server.british_pipeline
        self.original_inference_lock = server.inference_lock
        self.original_pinned_ollama_models = set(server.PINNED_OLLAMA_MODELS)
        server.PINNED_OLLAMA_MODELS.clear()
        server.pipeline = FakePipeline()
        server.british_pipeline = FakePipeline()
        server.inference_lock = asyncio.Lock()
        server.actual_device = "cpu"
        self.client = TestClient(server.app)

    def tearDown(self):
        server.pipeline = self.original_pipeline
        server.british_pipeline = self.original_british_pipeline
        server.inference_lock = self.original_inference_lock
        server.PINNED_OLLAMA_MODELS.clear()
        server.PINNED_OLLAMA_MODELS.update(self.original_pinned_ollama_models)
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
            None,
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
            None,
        )

    def test_translate_uses_context_for_disambiguation_with_large_model(self):
        with patch.object(
            server,
            "_call_ollama_translate_raw",
            create=True,
            return_value="屏障证书是安全的。",
        ) as call:
            response = self.client.post(
                "/translate",
                json={
                    "text": "It is safe.",
                    "context": "The paragraph discusses control theory and barrier certificates. It is safe.",
                    "model": "qwen3:14b",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["translated_text"], "屏障证书是安全的。")
        call.assert_called_once_with(
            "It is safe.",
            "qwen3:14b",
            "Simplified Chinese",
            "The paragraph discusses control theory and barrier certificates. [SELECTED_TEXT]",
        )

    def test_translate_ignores_context_for_4b_model(self):
        with patch.object(
            server,
            "_call_ollama_translate_raw",
            create=True,
            return_value="它是安全的。",
        ) as call:
            response = self.client.post(
                "/translate",
                json={
                    "text": "It is safe.",
                    "context": "The paragraph discusses control theory and barrier certificates. It is safe.",
                    "model": "translategemma:4b",
                },
            )

        self.assertEqual(response.status_code, 200)
        call.assert_called_once_with(
            "It is safe.",
            "translategemma:4b",
            "Simplified Chinese",
            None,
        )

    def test_model_context_limits_scale_by_model_size(self):
        self.assertEqual(
            server._model_context_limit("translategemma:4b", "translation"),
            0,
        )
        self.assertEqual(
            server._model_context_limit("translategemma:4b", "read_translation"),
            0,
        )
        self.assertLess(
            server._model_context_limit("translategemma:4b", "translation"),
            server._model_context_limit("glm4:9b", "translation"),
        )
        self.assertLess(
            server._model_context_limit("glm4:9b", "translation"),
            server._model_context_limit("qwen3:14b", "translation"),
        )
        self.assertLess(
            server._model_context_limit("translategemma:4b", "formula"),
            server._model_context_limit("qwen3:14b", "formula"),
        )

    def test_small_model_translation_context_is_disabled(self):
        selected = "It is safe."
        context = (
            "far before " * 200
            + "The paragraph discusses neural barrier certificates. "
            + selected
            + " The next sentence explains fitting loss and barrier loss. "
            + "far after " * 200
        )

        small = server._normalize_translation_context(
            context,
            selected,
            "translategemma:4b",
            "translation",
        )

        self.assertIsNone(small)

    def test_large_model_context_keeps_selection_marker(self):
        selected = "It is safe."
        context = (
            "far before " * 200
            + "The paragraph discusses neural barrier certificates. "
            + selected
            + " The next sentence explains fitting loss and barrier loss. "
            + "far after " * 200
        )

        large = server._normalize_translation_context(
            context,
            selected,
            "qwen3:14b",
            "translation",
        )

        self.assertIsNotNone(large)
        self.assertIn("[SELECTED_TEXT]", large)
        self.assertLessEqual(len(large), server._model_context_limit("qwen3:14b", "translation"))
        self.assertIn("barrier certificates", large)

    def test_translate_prompt_marks_context_as_reference_only(self):
        captured = {}

        def fake_urlopen(request, timeout):
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            return FakeUrlopenResponse({"response": "只翻译选中内容"})

        with patch.object(server.urllib_request, "urlopen", side_effect=fake_urlopen):
            result = server._call_ollama_translate_raw(
                "selected sentence",
                "qwen3:14b",
                "Simplified Chinese",
                "reference before [SELECTED_TEXT] reference after",
            )

        self.assertEqual(result, "只翻译选中内容")
        self.assertIs(captured["payload"]["think"], False)
        prompt = captured["payload"]["prompt"]
        system = captured["payload"]["system"]
        self.assertIn("<REFERENCE_CONTEXT_DO_NOT_TRANSLATE>", prompt)
        self.assertIn("<SELECTED_TEXT_TRANSLATE_ONLY>", prompt)
        self.assertIn("reference before [SELECTED_TEXT] reference after", prompt)
        self.assertIn("selected sentence", prompt)
        self.assertLess(prompt.index("</REFERENCE_CONTEXT_DO_NOT_TRANSLATE>"), prompt.index("<SELECTED_TEXT_TRANSLATE_ONLY>"))
        self.assertIn("Translate ONLY the content inside <SELECTED_TEXT_TRANSLATE_ONLY>", system)
        self.assertIn("Never translate or summarize anything inside <REFERENCE_CONTEXT_DO_NOT_TRANSLATE>", system)

    def test_pinned_model_generation_requests_keep_alive(self):
        captured = {}
        server.PINNED_OLLAMA_MODELS.add("qwen3:14b")

        def fake_urlopen(request, timeout):
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            return FakeUrlopenResponse({"response": "只翻译选中内容"})

        with patch.object(server.urllib_request, "urlopen", side_effect=fake_urlopen):
            result = server._call_ollama_translate_raw(
                "selected sentence",
                "qwen3:14b",
                "Simplified Chinese",
                None,
            )

        self.assertEqual(result, "只翻译选中内容")
        self.assertIs(captured["payload"]["think"], False)
        self.assertEqual(captured["payload"]["keep_alive"], server.OLLAMA_KEEP_ALIVE_PIN_VALUE)

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

    def test_translate_restores_formula_for_frontend_rendering_without_description(self):
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
        self.assertIn(r"$D_w \rightarrow \hat{B}(x)$", payload["translated_text"])
        self.assertNotIn("估计函数", payload["translated_text"])
        self.assertNotIn("__MATH_0__", payload["translated_text"])
        translate_call.assert_called_once_with(
            "This stage uses __MATH_0__.",
            "translategemma:4b",
            "Simplified Chinese",
            None,
        )

    def test_translate_english_preserves_formula_for_frontend_rendering(self):
        with patch.object(
            server,
            "_call_ollama_translate_raw",
            create=True,
            return_value="This stage uses __MATH_0__.",
        ) as translate_call, patch.object(
            server,
            "_call_ollama_formula_verbalization",
            create=True,
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
        self.assertIn(r"$D_w \rightarrow \hat{B}(x)$", payload["translated_text"])
        self.assertNotIn("D sub w maps to B hat of x", payload["translated_text"])
        self.assertNotIn("下标", payload["translated_text"])
        translate_call.assert_called_once_with(
            "This stage uses __MATH_0__.",
            "translategemma:4b",
            "English",
            None,
        )
        verbalize_call.assert_not_called()

    def test_translate_dataset_formula_keeps_renderer_formula(self):
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
        self.assertIn(r"$B_\theta(x)\rightarrow D_w=\{(x_i,B_\theta(x_i),w_i)\}$", translated)
        self.assertNotIn("下标", translated)
        self.assertNotIn("映射到", translated)

    def test_translate_normalizes_model_returned_math_wrappers(self):
        with patch.object(
            server,
            "_call_ollama_translate_raw",
            create=True,
            return_value="所得采样集合分别记为 [[MATH: D_I]]、[[MATH: D_U]] 和 [[MATH: D_D]]。",
        ):
            response = self.client.post(
                "/translate",
                json={
                    "text": r"The resulting sampled sets are denoted by [[MATH: D_I]], [[MATH: D_U]], and [[MATH: D_D]], respectively.",
                    "target_language": "Simplified Chinese",
                },
            )

        self.assertEqual(response.status_code, 200)
        translated = response.json()["translated_text"]
        self.assertIn(r"$D_I$", translated)
        self.assertIn(r"$D_U$", translated)
        self.assertIn(r"$D_D$", translated)
        self.assertNotIn("[[MATH:", translated)

    def test_translate_normalizes_unexpected_math_wrappers_without_input_formulas(self):
        with patch.object(
            server,
            "_call_ollama_translate_raw",
            create=True,
            return_value="记为 [[MATH: D_I]]。",
        ):
            response = self.client.post(
                "/translate",
                json={
                    "text": "The sampled set is denoted by D I.",
                    "target_language": "Simplified Chinese",
                },
            )

        self.assertEqual(response.status_code, 200)
        translated = response.json()["translated_text"]
        self.assertIn(r"$D_I$", translated)
        self.assertNotIn("[[MATH:", translated)

    def test_formula_description_handles_unbraced_hat(self):
        self.assertEqual(
            server._display_formula_for_translation(r"\hat B(x)"),
            "B̂(x)",
        )
        self.assertEqual(
            server._rule_describe_formula_zh(r"\hat B(x)"),
            "B的估计函数在x处的值",
        )

    def test_math_glossary_exposes_direct_and_contextual_readings(self):
        self.assertGreaterEqual(len(server.MATH_GLOSSARY["symbols"]), 50)
        self.assertEqual(
            server._glossary_candidate("right_arrow", "literal", "zh"),
            "右箭头",
        )
        self.assertEqual(
            server._glossary_candidate("hat", "unit_vector", "zh"),
            "单位向量",
        )
        prompt = server._math_glossary_prompt("zh")
        self.assertIn("映射到", prompt)
        self.assertIn("推导", prompt)
        self.assertIn("偏导数", prompt)

    def test_formula_description_chooses_arrow_semantics(self):
        self.assertIn(
            "趋向于",
            server._rule_describe_formula_zh(r"x \to 0"),
        )
        self.assertEqual(
            server._rule_describe_formula_zh(r"f: X \to Y"),
            "f是从X到Y的函数",
        )
        self.assertEqual(
            server._rule_describe_formula_zh(r"D_w \to \hat{B}(x)"),
            "由D的下标w得到B的估计函数在x处的值",
        )

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
            "",
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

    def test_read_prepare_splits_english_chinese_and_formula(self):
        def translate_side_effect(text, model, target_language, context):
            self.assertEqual(model, "translategemma:4b")
            self.assertEqual(target_language, "English")
            self.assertIsNone(context)
            if text == "其中":
                return "where"
            if text == "是候选函数。":
                return "is a candidate function."
            raise AssertionError(f"unexpected translation chunk: {text!r}")

        with patch.object(
            server,
            "_call_ollama_translate_raw",
            side_effect=translate_side_effect,
        ) as translate_call, patch.object(
            server,
            "_call_ollama_formula_verbalization",
            return_value=["B theta of x"],
        ) as formula_call:
            response = self.client.post(
                "/read/prepare",
                json={
                    "text": r"This sentence stays English. 其中 [[MATH: B_\theta(x)]] 是候选函数。",
                    "context": r"The paragraph discusses neural barrier certificates. 其中 [[MATH: B_\theta(x)]] 是候选函数。",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["prepared_text"],
            "This sentence stays English. where B theta of x is a candidate function.",
        )
        self.assertEqual(translate_call.call_count, 2)
        formula_call.assert_called_once_with(
            [r"[[MATH: B_\theta(x)]]"],
            "translategemma:4b",
            "",
        )

    def test_read_prepare_keeps_english_without_model_translation(self):
        with patch.object(server, "_call_ollama_translate_raw") as translate_call, patch.object(
            server,
            "_call_ollama_formula_verbalization",
        ) as formula_call:
            prepared = server._call_ollama_read_prepare(
                "Plain English sentence for reading.",
                "translategemma:4b",
            )

        self.assertEqual(prepared, "Plain English sentence for reading.")
        translate_call.assert_not_called()
        formula_call.assert_not_called()

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
            None,
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

    def test_small_model_formula_verbalization_prefers_conservative_rules(self):
        with patch.object(server.urllib_request, "urlopen") as urlopen:
            result = server._call_ollama_formula_verbalization(
                [r"D_I", r"B_\theta(x)", r"\hat{B}(x)", r"D_w \to \hat{B}(x)"],
                "translategemma:4b",
                "This context says arrow means data construction, but the 4B path should be conservative.",
            )

        self.assertEqual(
            result,
            [
                "D sub I",
                "B sub theta of x",
                "B hat of x",
                "D sub w to B hat of x",
            ],
        )
        urlopen.assert_not_called()

    def test_formula_verbalization_drops_context_for_small_model_remote_fallback(self):
        captured = {}

        def fake_urlopen(request, timeout):
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            return FakeUrlopenResponse({"response": '["a two row cases expression"]'})

        long_context = "near formula context " * 200
        with patch.object(server.urllib_request, "urlopen", side_effect=fake_urlopen):
            result = server._call_ollama_formula_verbalization(
                [r"\begin{cases} x & x > 0 \\ -x & x < 0 \end{cases}"],
                "translategemma:4b",
                long_context,
            )

        self.assertEqual(result, ["a two row cases expression"])
        prompt = json.loads(captured["payload"]["prompt"])
        self.assertEqual(prompt["context"], "")

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

    def test_remote_model_reference_resolves_source_and_model(self):
        original_sources = server.OLLAMA_SOURCES
        server.OLLAMA_SOURCES = {
            "local": server.OllamaSource(
                id="local",
                name="Local Ollama",
                base_url="http://127.0.0.1:11434",
                remote=False,
            ),
            "lab-server": server.OllamaSource(
                id="lab-server",
                name="Lab Server",
                base_url="http://127.0.0.1:49152",
                remote=True,
            ),
        }
        try:
            resolved = server._resolve_ollama_model_ref(
                "remote:lab-server:qwen3:14b"
            )
        finally:
            server.OLLAMA_SOURCES = original_sources

        self.assertEqual(resolved.value, "remote:lab-server:qwen3:14b")
        self.assertEqual(resolved.model, "qwen3:14b")
        self.assertEqual(resolved.source.id, "lab-server")
        self.assertEqual(resolved.source.base_url, "http://127.0.0.1:49152")

    def test_plain_model_reference_uses_local_source(self):
        resolved = server._resolve_ollama_model_ref("translategemma:4b")

        self.assertEqual(resolved.value, "translategemma:4b")
        self.assertEqual(resolved.model, "translategemma:4b")
        self.assertEqual(resolved.source.id, "local")

    def test_model_options_include_remote_source_labels(self):
        original_sources = server.OLLAMA_SOURCES
        server.OLLAMA_SOURCES = {
            "local": server.OllamaSource(
                "local",
                "Local Ollama",
                "http://127.0.0.1:11434",
                False,
            ),
            "lab-server": server.OllamaSource(
                "lab-server",
                "Lab Server",
                "http://127.0.0.1:49152",
                True,
            ),
        }

        def fake_ollama_json(path, timeout=5.0, base_url=None):
            if path == "/api/tags" and base_url == "http://127.0.0.1:49152":
                return {"models": [{"name": "qwen3:14b"}]}
            if path == "/api/tags":
                return {"models": [{"name": "translategemma:4b"}]}
            raise AssertionError((path, base_url))

        try:
            with patch.object(
                server,
                "_call_ollama_json",
                create=True,
                side_effect=fake_ollama_json,
            ):
                options = server._collect_ollama_model_options()
        finally:
            server.OLLAMA_SOURCES = original_sources

        self.assertEqual(
            options,
            [
                {
                    "value": "translategemma:4b",
                    "label": "Local Ollama / translategemma:4b",
                    "source": "local",
                    "source_name": "Local Ollama",
                    "model": "translategemma:4b",
                },
                {
                    "value": "remote:lab-server:qwen3:14b",
                    "label": "Lab Server / qwen3:14b",
                    "source": "lab-server",
                    "source_name": "Lab Server",
                    "model": "qwen3:14b",
                },
            ],
        )

    def test_remote_translate_routes_generate_to_remote_base_url(self):
        original_sources = server.OLLAMA_SOURCES
        server.OLLAMA_SOURCES = {
            "local": server.OllamaSource(
                "local",
                "Local Ollama",
                "http://127.0.0.1:11434",
                False,
            ),
            "lab-server": server.OllamaSource(
                "lab-server",
                "Lab Server",
                "http://127.0.0.1:49152",
                True,
            ),
        }
        captured = {}

        def fake_urlopen(request, timeout):
            captured["url"] = request.full_url
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            return FakeUrlopenResponse({"response": "remote result"})

        try:
            with patch.object(server.urllib_request, "urlopen", side_effect=fake_urlopen):
                result = server._call_ollama_translate_raw(
                    "Hello",
                    "remote:lab-server:qwen3:14b",
                    "Simplified Chinese",
                    None,
                )
        finally:
            server.OLLAMA_SOURCES = original_sources

        self.assertEqual(result, "remote result")
        self.assertEqual(captured["url"], "http://127.0.0.1:49152/api/generate")
        self.assertEqual(captured["payload"]["model"], "qwen3:14b")

    def test_remote_pinned_model_generation_requests_keep_alive(self):
        original_sources = server.OLLAMA_SOURCES
        server.OLLAMA_SOURCES = {
            "local": server.OllamaSource(
                "local",
                "Local Ollama",
                "http://127.0.0.1:11434",
                False,
            ),
            "lab-server": server.OllamaSource(
                "lab-server",
                "Lab Server",
                "http://127.0.0.1:49152",
                True,
            ),
        }
        server.PINNED_OLLAMA_MODELS.add("remote:lab-server:qwen3:14b")
        captured = {}

        def fake_urlopen(request, timeout):
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            return FakeUrlopenResponse({"response": "remote result"})

        try:
            with patch.object(server.urllib_request, "urlopen", side_effect=fake_urlopen):
                server._call_ollama_translate_raw(
                    "Hello",
                    "remote:lab-server:qwen3:14b",
                    "Simplified Chinese",
                )
        finally:
            server.OLLAMA_SOURCES = original_sources

        self.assertEqual(
            captured["payload"]["keep_alive"],
            server.OLLAMA_KEEP_ALIVE_PIN_VALUE,
        )

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
        self.assertFalse(payload["model_pinned"])

    def test_translate_health_reports_remote_source_metadata(self):
        original_sources = server.OLLAMA_SOURCES
        server.OLLAMA_SOURCES = {
            "local": server.OllamaSource(
                "local",
                "Local Ollama",
                "http://127.0.0.1:11434",
                False,
            ),
            "lab-server": server.OllamaSource(
                "lab-server",
                "Lab Server",
                "http://127.0.0.1:49152",
                True,
            ),
        }

        def fake_ollama_json(path, timeout=5.0, base_url=None):
            if base_url == "http://127.0.0.1:49152" and path == "/api/tags":
                return {"models": [{"name": "qwen3:14b"}]}
            if base_url == "http://127.0.0.1:49152" and path == "/api/ps":
                return {"models": [{"name": "qwen3:14b"}]}
            if path == "/api/tags":
                return {"models": [{"name": "translategemma:4b"}]}
            if path == "/api/ps":
                return {"models": []}
            raise AssertionError((path, base_url))

        try:
            with patch.object(
                server,
                "_call_ollama_json",
                create=True,
                side_effect=fake_ollama_json,
            ):
                response = self.client.get(
                    "/translate/health?model=remote:lab-server:qwen3:14b"
                )
        finally:
            server.OLLAMA_SOURCES = original_sources

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["source"], "lab-server")
        self.assertEqual(payload["source_name"], "Lab Server")
        self.assertEqual(payload["model"], "remote:lab-server:qwen3:14b")
        self.assertTrue(payload["model_running"])
        self.assertIn(
            {
                "value": "remote:lab-server:qwen3:14b",
                "label": "Lab Server / qwen3:14b",
                "source": "lab-server",
                "source_name": "Lab Server",
                "model": "qwen3:14b",
            },
            payload["available_model_options"],
        )

    def test_translate_health_reports_pinned_model(self):
        server.PINNED_OLLAMA_MODELS.add("translategemma:4b")

        def fake_ollama_json(path):
            if path == "/api/tags":
                return {"models": [{"name": "translategemma:4b"}]}
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
        self.assertTrue(response.json()["model_pinned"])

    def test_translate_model_keepalive_pins_model(self):
        def fake_ollama_json(path):
            if path == "/api/ps":
                return {"models": [{"name": "qwen3:14b"}]}
            raise AssertionError(path)

        with patch.object(
            server,
            "_call_ollama_model_keep_alive",
            create=True,
            return_value={"done_reason": "load"},
        ) as keepalive, patch.object(
            server,
            "_call_ollama_json",
            create=True,
            side_effect=fake_ollama_json,
        ):
            response = self.client.post(
                "/translate/model/keepalive",
                json={"model": "qwen3:14b"},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "pinned")
        self.assertEqual(payload["model"], "qwen3:14b")
        self.assertEqual(payload["keep_alive"], server.OLLAMA_KEEP_ALIVE_PIN_VALUE)
        self.assertTrue(payload["model_running"])
        self.assertTrue(payload["model_pinned"])
        self.assertIn("qwen3:14b", server.PINNED_OLLAMA_MODELS)
        keepalive.assert_called_once_with("qwen3:14b", server.OLLAMA_KEEP_ALIVE_PIN_VALUE)

    def test_translate_model_keepalive_checks_remote_running_state(self):
        original_sources = server.OLLAMA_SOURCES
        server.OLLAMA_SOURCES = {
            "local": server.OllamaSource(
                "local",
                "Local Ollama",
                "http://127.0.0.1:11434",
                False,
            ),
            "lab-server": server.OllamaSource(
                "lab-server",
                "Lab Server",
                "http://127.0.0.1:49152",
                True,
            ),
        }

        def fake_ollama_json(path, timeout=5.0, base_url=None):
            if path == "/api/ps" and base_url == "http://127.0.0.1:49152":
                return {"models": [{"name": "qwen3:14b"}]}
            if path == "/api/ps":
                return {"models": []}
            raise AssertionError((path, base_url))

        try:
            with patch.object(
                server,
                "_call_ollama_model_keep_alive",
                create=True,
                return_value={"done_reason": "load"},
            ) as keepalive, patch.object(
                server,
                "_call_ollama_json",
                create=True,
                side_effect=fake_ollama_json,
            ):
                response = self.client.post(
                    "/translate/model/keepalive",
                    json={"model": "remote:lab-server:qwen3:14b"},
                )
        finally:
            server.OLLAMA_SOURCES = original_sources

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["model"], "remote:lab-server:qwen3:14b")
        self.assertTrue(payload["model_running"])
        self.assertTrue(payload["model_pinned"])
        self.assertIn("remote:lab-server:qwen3:14b", server.PINNED_OLLAMA_MODELS)
        keepalive.assert_called_once_with(
            "remote:lab-server:qwen3:14b",
            server.OLLAMA_KEEP_ALIVE_PIN_VALUE,
        )

    def test_translate_model_unload_unpins_model(self):
        server.PINNED_OLLAMA_MODELS.add("qwen3:14b")

        def fake_ollama_json(path):
            if path == "/api/ps":
                return {"models": []}
            raise AssertionError(path)

        with patch.object(
            server,
            "_call_ollama_model_keep_alive",
            create=True,
            return_value={"done_reason": "unload"},
        ) as unload, patch.object(
            server,
            "_call_ollama_json",
            create=True,
            side_effect=fake_ollama_json,
        ):
            response = self.client.post(
                "/translate/model/unload",
                json={"model": "qwen3:14b"},
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "unloaded")
        self.assertEqual(payload["model"], "qwen3:14b")
        self.assertEqual(payload["keep_alive"], 0)
        self.assertFalse(payload["model_running"])
        self.assertFalse(payload["model_pinned"])
        self.assertNotIn("qwen3:14b", server.PINNED_OLLAMA_MODELS)
        unload.assert_called_once_with("qwen3:14b", 0)

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
