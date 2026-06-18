from pathlib import Path

import server


def test_release_versions_are_current():
    userscript = Path("tts-userscript.js").read_text(encoding="utf-8")

    assert server.app.version == "1.6.1"
    assert "// @version      1.10.1" in userscript
    assert "// @name         本地划词听译助手" in userscript
    assert "// @license      MIT" in userscript
    assert "// @homepageURL  https://github.com/Yan-ShiBo/local-tts-env" in userscript
    assert "// @supportURL   https://github.com/Yan-ShiBo/local-tts-env/issues" in userscript
