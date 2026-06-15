import asyncio
import unittest

import numpy as np
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


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.original_pipeline = server.pipeline
        self.original_british_pipeline = server.british_pipeline
        server.pipeline = FakePipeline()
        server.british_pipeline = FakePipeline()
        server.actual_device = "cpu"
        self.client = TestClient(server.app)

    def tearDown(self):
        server.pipeline = self.original_pipeline
        server.british_pipeline = self.original_british_pipeline

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

    def test_health_identifies_service(self):
        response = self.client.get("/health")
        payload = response.json()

        self.assertEqual(payload["service"], "kokoro-tts")
        self.assertTrue(payload["ready"])

    def test_openapi_declares_wav_response(self):
        content = server.app.openapi()["paths"]["/tts"]["post"]["responses"]["200"][
            "content"
        ]
        self.assertIn("audio/wav", content)
        self.assertNotIn("application/json", content)

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
