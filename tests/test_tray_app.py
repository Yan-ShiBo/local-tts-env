import json
import sys
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import Mock, patch

import tray_app
from windows_startup import StartupShortcutError


class TrayOwnershipTests(unittest.TestCase):
    def make_app(self):
        with patch.object(
            tray_app,
            "find_conda_python",
            return_value=Path(sys.executable),
        ), patch.object(tray_app, "reconcile_startup_shortcut"):
            return tray_app.TrayApp()

    def test_external_server_cannot_be_stopped_by_tray(self):
        app = self.make_app()
        app.is_running = True
        app.server_process = None

        self.assertFalse(app.can_stop_server())

    def test_owned_server_can_be_stopped_by_tray(self):
        app = self.make_app()
        app.is_running = True
        app.owns_server = True

        self.assertTrue(app.can_stop_server())

    def test_quit_app_forces_process_exit_after_cleanup(self):
        app = self.make_app()
        app._stop_remote_ollama_tunnel = Mock()
        app.stop_server = Mock()
        app.tray_icon = Mock()

        with patch.object(tray_app.os, "_exit") as exit_process:
            app.quit_app()

        app._stop_remote_ollama_tunnel.assert_called_once()
        app.stop_server.assert_called_once()
        app.tray_icon.stop.assert_called_once()
        exit_process.assert_called_once_with(0)

    def test_quit_app_still_exits_when_cleanup_fails(self):
        app = self.make_app()
        app._stop_remote_ollama_tunnel = Mock(side_effect=RuntimeError("stuck"))
        app.stop_server = Mock(side_effect=RuntimeError("also stuck"))
        app.tray_icon = Mock()

        with patch.object(tray_app.os, "_exit") as exit_process:
            app.quit_app()

        app._stop_remote_ollama_tunnel.assert_called_once()
        app.stop_server.assert_called_once()
        app.tray_icon.stop.assert_called_once()
        exit_process.assert_called_once_with(0)


class TrayAutoStartTests(unittest.TestCase):
    def make_app(self):
        with patch.object(
            tray_app,
            "find_conda_python",
            return_value=Path(sys.executable),
        ), patch.object(tray_app, "reconcile_startup_shortcut"):
            return tray_app.TrayApp()

    def test_default_settings_include_auto_start_disabled(self):
        with patch.object(
            tray_app,
            "SETTINGS_FILE",
            Path("__missing_tray_settings_for_test__.json"),
        ):
            settings = tray_app.load_settings()

        self.assertIs(settings["auto_start"], False)

    def test_toggle_auto_start_saves_after_successful_shortcut_update(self):
        app = self.make_app()
        app.settings["auto_start"] = False

        with patch.object(
            tray_app,
            "inspect_startup_shortcut",
            return_value=False,
        ), patch.object(
            tray_app,
            "reconcile_startup_shortcut",
            return_value=True,
        ) as reconcile, patch.object(tray_app, "save_settings") as save:
            app.toggle_auto_start()

        reconcile.assert_called_once()
        self.assertIs(app.settings["auto_start"], True)
        save.assert_called_once_with(app.settings)

    def test_toggle_auto_start_failure_preserves_setting_and_shows_error(self):
        app = self.make_app()
        app.settings["auto_start"] = False
        app.show_error = Mock()

        with patch.object(
            tray_app,
            "inspect_startup_shortcut",
            return_value=False,
        ), patch.object(
            tray_app,
            "reconcile_startup_shortcut",
            side_effect=StartupShortcutError("boom"),
        ), patch.object(tray_app, "save_settings") as save:
            app.toggle_auto_start()

        self.assertIs(app.settings["auto_start"], False)
        save.assert_not_called()
        app.show_error.assert_called_once()

    def test_menu_contains_checked_auto_start_item(self):
        class FakeItem:
            def __init__(self, text, action=None, **kwargs):
                self.text = text
                self.action = action
                self.kwargs = kwargs

        class FakeMenu:
            SEPARATOR = object()

            def __init__(self, *items):
                self.items = items

        fake_pystray = SimpleNamespace(Menu=FakeMenu, MenuItem=FakeItem)
        app = self.make_app()
        app.is_auto_start_enabled = Mock(return_value=True)

        with patch.dict(sys.modules, {"pystray": fake_pystray}):
            menu = app._build_menu()

        auto_start_items = [
            item for item in menu.items
            if isinstance(item, FakeItem) and item.text == "Auto-start on login"
        ]
        self.assertEqual(len(auto_start_items), 1)
        item = auto_start_items[0]
        self.assertIs(item.action.__self__, app)
        self.assertIs(item.action.__func__, app.toggle_auto_start.__func__)
        self.assertTrue(item.kwargs["checked"](item))


class TrayRemoteOllamaTests(unittest.TestCase):
    def make_app(self):
        with patch.object(
            tray_app,
            "find_conda_python",
            return_value=Path(sys.executable),
        ), patch.object(tray_app, "reconcile_startup_shortcut"):
            return tray_app.TrayApp()

    def test_default_settings_include_remote_ollama(self):
        with patch.object(
            tray_app,
            "SETTINGS_FILE",
            Path("__missing_tray_settings_for_test__.json"),
        ):
            settings = tray_app.load_settings()

        self.assertEqual(
            settings["remote_ollama"],
            {
                "enabled": False,
                "name": "",
                "host": "",
                "ssh_port": 22,
                "username": "",
                "password": "",
                "ollama_host": "127.0.0.1",
                "ollama_port": 11434,
                "local_port": 0,
            },
        )

    def test_remote_source_env_omits_password(self):
        app = self.make_app()
        app.settings["remote_ollama"] = {
            "enabled": True,
            "name": "Lab Server",
            "host": "192.168.1.10",
            "ssh_port": 22,
            "username": "alice",
            "password": "secret",
            "ollama_host": "127.0.0.1",
            "ollama_port": 11434,
            "local_port": 49152,
        }
        app.remote_tunnel_local_port = 49152

        payload = app.build_remote_ollama_sources_env()

        self.assertEqual(
            json.loads(payload),
            [
                {
                    "id": "lab-server",
                    "name": "Lab Server",
                    "base_url": "http://127.0.0.1:49152",
                }
            ],
        )
        self.assertNotIn("secret", payload)

    def test_remote_service_dialog_opens_on_background_thread(self):
        app = self.make_app()
        started = []

        class FakeThread:
            def __init__(self, target=None, daemon=None):
                self.target = target
                self.daemon = daemon

            def start(self):
                started.append(self)

        def raise_if_tk_opens_synchronously():
            raise AssertionError("dialog should not open synchronously")

        fake_tkinter = SimpleNamespace(
            Tk=raise_if_tk_opens_synchronously,
            messagebox=SimpleNamespace(),
        )

        with patch.dict(sys.modules, {"tkinter": fake_tkinter}), patch.object(
            tray_app.threading,
            "Thread",
            side_effect=lambda target=None, daemon=None: FakeThread(target, daemon),
        ):
            app.open_remote_service_settings()

        self.assertEqual(len(started), 1)
        self.assertTrue(started[0].daemon)
        self.assertIs(started[0].target.__self__, app)
        self.assertIs(
            started[0].target.__func__,
            app._run_remote_service_settings_dialog.__func__,
        )


if __name__ == "__main__":
    unittest.main()
