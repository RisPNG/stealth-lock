import ctypes
import json
import os
import pathlib
import shutil
import signal
import subprocess
import tempfile
import time
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
HELPER = ROOT / "helpers" / "visual-renderer.py"
API = ROOT / "shared" / "visual-api.js"


class VisualRendererTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ctypes.CDLL("libjavascriptcoregtk-6.0.so.1")

    def render(self, code, events=("init",), timeout=3):
        requests = []
        for index, event in enumerate(events):
            request = {
                "event": event,
                "width": 1920,
                "height": 1080,
                "monitors": [{"x": 0, "y": 0, "width": 1920, "height": 1080}],
                "colors": {"foreground": [0.1, 0.8, 0.3, 1]},
                "now": index * 50,
                "delta": 50 if index else 0,
                "reducedMotion": False,
            }
            if event in ("check", "init"):
                request["code"] = code
            requests.append(json.dumps(request, ensure_ascii=False))
        result = subprocess.run(
            ["/usr/bin/python3", "-I", str(HELPER), "--scope", str(ROOT), str(os.getpid())],
            input=("\n".join(requests) + "\n").encode(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
        frames = [json.loads(line) for line in result.stdout.splitlines()]
        return result, frames

    def test_program_has_no_gjs_system_browser_or_node_capabilities(self):
        result, frames = self.render("""
const denied = [typeof imports, typeof global, typeof print, typeof fetch,
    typeof require, typeof process, typeof window, typeof document,
    typeof Gio, typeof Shell, typeof System];
ctx.draw.text(denied.join(','), 0, 0);
ctx.draw.text(Function('return typeof imports')(), 0, 20);
ctx.draw.text(ctx.draw.paint.constructor('return typeof process')(), 0, 40);
ctx.draw.text(Object.keys(ctx).sort().join(','), 0, 60);
""")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(frames[0]["commands"][0][1], ",".join(["undefined"] * 11))
        self.assertEqual(frames[0]["commands"][1][1], "undefined")
        self.assertEqual(frames[0]["commands"][2][1], "undefined")
        self.assertEqual(frames[0]["commands"][3][1],
                         "blur,clock,colors,delta,draw,event,height,monitors,now,reducedMotion,state,width")

    def test_state_lifecycle_and_visual_declarations_are_shared_for_every_program(self):
        result, frames = self.render("""
if (ctx.event === 'init') {
    ctx.state.count = 0;
    ctx.blur(20, 0.8);
    ctx.clock({seconds: false, align: 'right'});
}
ctx.state.count++;
ctx.draw.text(ctx.event + ':' + ctx.state.count, 2, 4, 18, 'monospace');
if (ctx.event === 'destroy') {
    ctx.blur(null);
    ctx.clock(null);
}
""", events=("init", "update", "destroy"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([frame["commands"][0][1] for frame in frames],
                         ["init:1", "update:2", "destroy:3"])
        self.assertEqual(frames[0]["blur"], {"radius": 20, "brightness": 0.8})
        self.assertEqual(frames[1]["blur"], frames[0]["blur"])
        self.assertEqual(frames[1]["clock"], {"visible": True, "seconds": False, "align": "right"})
        self.assertIsNone(frames[2]["clock"])
        self.assertIsNone(frames[2]["blur"])

    def test_every_drawing_operation_emits_only_data(self):
        result, frames = self.render("""
const cr = ctx.draw;
cr.setOperator('source'); cr.setSourceRGBA(0, 0, 0, 1); cr.paint();
cr.save(); cr.rectangle(1, 2, 3, 4); cr.fill(); cr.restore();
cr.setLineWidth(2); cr.moveTo(5, 6); cr.lineTo(7, 8); cr.stroke();
cr.text('hello', 10, 20);
""")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(frames[0]["commands"], [
            ["setOperator", "source"], ["setSourceRGBA", 0, 0, 0, 1], ["paint"],
            ["save"], ["rectangle", 1, 2, 3, 4], ["fill"], ["restore"],
            ["setLineWidth", 2], ["moveTo", 5, 6], ["lineTo", 7, 8], ["stroke"],
            ["text", "hello", 10, 20, 16, "monospace"],
        ])

    def test_check_compiles_without_running_the_program(self):
        result, frames = self.render("while (true) {}", events=("check",))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(frames, [{"valid": True}])
        failed, frames = self.render("if (", events=("check",))
        self.assertEqual(failed.returncode, 2)
        self.assertEqual(frames, [{"error": "Visual program could not be processed"}])

    def test_infinite_loop_is_terminated_without_waiting_for_js_to_return(self):
        started = time.monotonic()
        result, frames = self.render("while (true) {}")
        self.assertIn(result.returncode, (-signal.SIGALRM, -signal.SIGPROF,
                                         128 + signal.SIGALRM, 128 + signal.SIGPROF))
        self.assertEqual(frames, [])
        self.assertLess(time.monotonic() - started, 2)

    def test_command_text_and_numeric_limits_stop_oversized_frames(self):
        for code in (
            "for (let i=0;i<2049;i++) ctx.draw.paint();",
            "ctx.draw.text('x'.repeat(257),0,0);",
            "ctx.draw.moveTo(Infinity,0);",
            "ctx.draw.rectangle(NaN,0,1,1);",
        ):
            with self.subTest(code=code):
                result, frames = self.render(code)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(frames, [{"error": "Visual program could not be processed"}])

    def test_serialized_output_limit_survives_user_prototype_changes(self):
        result, frames = self.render("Object.prototype.toJSON = () => 'x'.repeat(300000);")
        self.assertEqual(result.returncode, 2)
        self.assertEqual(frames, [{"error": "Visual program could not be processed"}])

    def test_errors_never_echo_program_source_or_exception_text(self):
        result, frames = self.render("throw new Error('PRIVATE_UNTRUSTED_PROGRAM_TEXT');")
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(b"PRIVATE_UNTRUSTED_PROGRAM_TEXT", result.stdout + result.stderr)
        self.assertEqual(frames, [{"error": "Visual program could not be processed"}])

    def test_script_limit_and_nul_are_rejected(self):
        for code in ("x" * (512 * 1024 + 1), "\0"):
            with self.subTest(code=code[:8]):
                result, frames = self.render(code, events=("check",))
                self.assertEqual(result.returncode, 2)
                self.assertEqual(frames, [{"error": "Visual program could not be processed"}])

    def test_update_requires_one_initialization(self):
        for events in (("update",), ("destroy",), ("init", "init"), ("init", "check")):
            with self.subTest(events=events):
                result, frames = self.render("", events=events)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(frames[-1], {"error": "Visual program could not be processed"})

    def test_globals_cannot_replace_native_request_dispatch(self):
        result, frames = self.render("""
if (ctx.event === 'init') {
    JSON.parse = () => {throw new Error('replaced parser');};
    JSON.stringify = () => {throw new Error('replaced serializer');};
}
ctx.draw.text(ctx.event,0,0);
""", events=("init", "update"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([frame["commands"][0][1] for frame in frames], ["init", "update"])

    def test_native_allocation_abuse_hits_the_process_memory_limit(self):
        command = ["/usr/bin/python3", "-I", str(HELPER), "--scope", str(ROOT), str(os.getpid())]
        with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as worker:
            try:
                initial = {
                    "event": "init", "width": 16, "height": 16,
                    "code": "ctx.state.buffers ??= []; ctx.state.buffers.push(new Uint8Array(8*1024*1024).fill(1)); ctx.draw.paint();",
                }
                worker.stdin.write((json.dumps(initial) + "\n").encode())
                worker.stdin.flush()
                self.assertEqual(json.loads(worker.stdout.readline())["commands"], [["paint"]])
                membership = next(line[3:] for line in pathlib.Path(f"/proc/{worker.pid}/cgroup").read_text().splitlines()
                                  if line.startswith("0::"))
                group = pathlib.Path("/sys/fs/cgroup") / membership.lstrip("/")
                self.assertEqual((group / "memory.max").read_text().strip(), str(512 * 1024 * 1024))
                self.assertEqual((group / "memory.swap.max").read_text().strip(), "0")
                with (group / "memory.events").open() as events:
                    completed = 1
                    for _ in range(100):
                        try:
                            worker.stdin.write(b'{"event":"update","width":16,"height":16}\n')
                            worker.stdin.flush()
                        except BrokenPipeError:
                            break
                        frame = worker.stdout.readline()
                        if not frame:
                            break
                        self.assertEqual(json.loads(frame)["commands"], [["paint"]])
                        completed += 1
                    self.assertNotEqual(worker.wait(timeout=3), 0)
                    counters = dict(line.split() for line in events.read().splitlines())
                self.assertGreaterEqual(int(counters["oom_kill"]), 1)
                self.assertLess(completed, 65)
            finally:
                if worker.poll() is None:
                    worker.kill()
                    worker.wait(timeout=3)

    def test_unprotected_interpreter_and_stale_request_owner_are_rejected(self):
        for arguments in (
            ["--render", str(API)],
            ["--scope", str(ROOT), str(os.getpid() + 1)],
        ):
            with self.subTest(arguments=arguments):
                result = subprocess.run(["/usr/bin/python3", "-I", str(HELPER), *arguments],
                                        input=b'{"event":"check","code":"return;"}\n',
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(json.loads(result.stdout), {"error": "Visual program could not be processed"})

    def test_request_owner_death_terminates_a_pending_scope_registration(self):
        with tempfile.TemporaryDirectory(prefix="stealth-lock-scope-parent-") as directory:
            staging = pathlib.Path(directory)
            manager = staging / "systemd-run"
            manager.write_text(
                "#!/usr/bin/python3\nimport os,sys,time\nsys.stdout.write(str(os.getpid())+'\\n')\n"
                "sys.stdout.flush()\ntime.sleep(10)\n", encoding="utf-8")
            manager.chmod(0o755)
            parent = staging / "parent.py"
            parent.write_text(
                "import os,subprocess,sys\n"
                "worker=subprocess.Popen(['/usr/bin/python3','-I','/renderer.py','--scope','/extension',str(os.getpid())],"
                "stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)\n"
                "sys.stdout.buffer.write(worker.stdout.readline());sys.stdout.buffer.flush();os._exit(0)\n",
                encoding="utf-8")
            command = ["bwrap", "--unshare-user", "--ro-bind", "/usr", "/usr", "--proc", "/proc", "--dev", "/dev"]
            for name in ("/lib", "/lib64", "/bin", "/sbin"):
                path = pathlib.Path(name)
                if path.is_symlink():
                    command.extend(["--symlink", str(path.readlink()), name])
                elif path.exists():
                    command.extend(["--ro-bind", name, name])
            command.extend([
                "--ro-bind", str(manager), "/usr/bin/systemd-run", "--ro-bind", str(HELPER), "/renderer.py",
                "--ro-bind", str(parent), "/parent.py", "--", "/usr/bin/python3", "-I", "/parent.py",
            ])
            result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
            self.assertEqual(result.returncode, 0, result.stderr)
            pid = int(result.stdout)
            try:
                descriptor = os.pidfd_open(pid)
            except ProcessLookupError:
                return
            try:
                status = pathlib.Path(f"/proc/{pid}/status")
                for _ in range(100):
                    if not status.exists() or "State:\tZ" in status.read_text():
                        break
                    time.sleep(0.01)
                else:
                    self.fail("Visual worker survived its owner during scope registration")
            finally:
                try:
                    signal.pidfd_send_signal(descriptor, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                os.close(descriptor)

    def test_production_sandbox_runs_without_home_session_or_network_environment(self):
        self.assertIsNotNone(shutil.which("bwrap"), "bubblewrap is required for visual programs")
        result, frames = self.render("ctx.draw.paint();", events=("check",))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(frames, [{"valid": True}])
        with tempfile.TemporaryDirectory(prefix="stealth-lock-visual-secret-") as directory:
            secret = pathlib.Path(directory) / "secret"
            secret.write_text("secret remains outside sandbox", encoding="utf-8")
            extension = pathlib.Path(directory) / "extension"
            (extension / "helpers").mkdir(parents=True)
            (extension / "shared").mkdir()
            shutil.copyfile(API, extension / "shared" / "visual-api.js")
            assertion = (
                "assert not pathlib.Path(" + repr(str(secret)) + ").exists(); "
                "assert not pathlib.Path('/run/user').exists(); "
                "assert not pathlib.Path('/home').exists(); "
                "assert not any(key in os.environ for key in ('DISPLAY','WAYLAND_DISPLAY',"
                "'DBUS_SESSION_BUS_ADDRESS','SSH_AUTH_SOCK')); "
                "assert list(pathlib.Path('/sys/class/net').glob('*')) == []; "
                "assert os.statvfs('/memory.max').f_flag & os.ST_RDONLY; "
                "assert os.statvfs('/memory.swap.max').f_flag & os.ST_RDONLY; "
                "sys.stdout.write('{\"isolated\":true}\\n'); sys.exit(0)"
            )
            source = HELPER.read_text().replace("        program = VisualProgram(framework)", "        " + assertion)
            self.assertIn(assertion, source)
            fixture = extension / "helpers" / "visual-renderer.py"
            fixture.write_text(source, encoding="utf-8")
            isolated = subprocess.run(["/usr/bin/python3", "-I", str(fixture), "--scope", str(extension), str(os.getpid())],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
            self.assertEqual(isolated.returncode, 0, isolated.stderr)
            self.assertEqual(json.loads(isolated.stdout), {"isolated": True})

    def test_actual_starter_entries_run_in_native_jsc_with_and_without_motion(self):
        source = (
            "import {DEFAULT_EFFECT_PRESETS} from './shared/starter-programs.js'; "
            "process.stdout.write(JSON.stringify(DEFAULT_EFFECT_PRESETS));"
        )
        exported = subprocess.run(["mise", "exec", "--", "node", "--input-type=module", "-e", source],
                                  cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        colors = {
            "background": [0, 0, 0, 1], "foreground": [0.1, 0.8, 0.3, 1],
            "head": [0.8, 1, 0.9, 1], "glitch": [1, 1, 1, 1], "blur": [0, 0, 0, 0.15],
            "palette": [[0, 1, 1, 1], [0, 1, 0.5, 1], [1, 0.6, 0, 1]],
        }
        for preset in json.loads(exported.stdout):
            for reduced in (False, True):
                with self.subTest(preset=preset["name"], reduced=reduced):
                    requests = []
                    events = ("init",) + ("update",) * 20 + ("destroy",)
                    for index, event in enumerate(events):
                        request = {"event": event, "width": 1920, "height": 1080, "monitors": [],
                                   "colors": colors, "now": index * 50, "delta": 50 if index else 0,
                                   "reducedMotion": reduced}
                        if event == "init":
                            request["code"] = preset["code"]
                        requests.append(json.dumps(request))
                    result = subprocess.run(["/usr/bin/python3", "-I", str(HELPER), "--scope", str(ROOT), str(os.getpid())],
                                            input=("\n".join(requests) + "\n").encode(),
                                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    frames = [json.loads(line) for line in result.stdout.splitlines()]
                    self.assertEqual(len(frames), len(events))
                    self.assertGreater(len(frames[0]["commands"]), 0)
                    self.assertTrue(all(len(frame["commands"]) <= 2048 for frame in frames))
                    self.assertTrue(all(len(line) <= 256 * 1024 for line in result.stdout.splitlines()))


if __name__ == "__main__":
    unittest.main()
