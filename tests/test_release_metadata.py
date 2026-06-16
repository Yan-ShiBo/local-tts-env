from pathlib import Path

import server


def test_release_versions_are_current():
    userscript = Path("tts-userscript.js").read_text(encoding="utf-8")

    assert server.app.version == "1.2.0"
    assert "// @version      1.4.2" in userscript
