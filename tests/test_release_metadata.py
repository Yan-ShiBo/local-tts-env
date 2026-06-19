from pathlib import Path

import server


def test_release_versions_are_current():
    userscript = Path("tts-userscript.js").read_text(encoding="utf-8")

    assert server.app.version == "1.7.5"
    assert "// @version      1.12.0" in userscript
    assert "// @name         本地划词听译助手" in userscript
    assert "// @license      MIT" in userscript
    assert "// @homepageURL  https://github.com/Yan-ShiBo/LocalReadTranslate" in userscript
    assert "// @supportURL   https://github.com/Yan-ShiBo/LocalReadTranslate/issues" in userscript
