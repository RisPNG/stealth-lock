#!/usr/bin/python3

import ctypes
import json
import os
import pathlib
import resource
import signal
import sys


MAX_SCRIPT_BYTES = 512 * 1024
MAX_REQUEST_BYTES = 768 * 1024
MAX_FRAME_BYTES = 256 * 1024
MAX_MEMORY_BYTES = 512 * 1024 * 1024
MAX_ADDRESS_SPACE_BYTES = 136 * 1024 * 1024 * 1024
REQUEST_DEADLINE_SECONDS = 0.5
FRAME_CPU_SECONDS = 0.025


class VisualProgram:
    def __init__(self, framework):
        self.library = ctypes.CDLL("libjavascriptcoregtk-6.0.so.1")
        signatures = {
            "jsc_options_set_boolean": ([ctypes.c_char_p, ctypes.c_int], ctypes.c_int),
            "jsc_options_set_uint": ([ctypes.c_char_p, ctypes.c_uint], ctypes.c_int),
            "JSGlobalContextCreate": ([ctypes.c_void_p], ctypes.c_void_p),
            "JSGlobalContextRelease": ([ctypes.c_void_p], None),
            "JSStringCreateWithUTF8CString": ([ctypes.c_char_p], ctypes.c_void_p),
            "JSStringRelease": ([ctypes.c_void_p], None),
            "JSEvaluateScript": ([ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                  ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)], ctypes.c_void_p),
            "JSObjectMakeFunction": ([ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint,
                                      ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.c_void_p,
                                      ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)], ctypes.c_void_p),
            "JSObjectCallAsFunction": ([ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                                        ctypes.c_size_t, ctypes.POINTER(ctypes.c_void_p),
                                        ctypes.POINTER(ctypes.c_void_p)], ctypes.c_void_p),
            "JSValueMakeString": ([ctypes.c_void_p, ctypes.c_void_p], ctypes.c_void_p),
            "JSValueProtect": ([ctypes.c_void_p, ctypes.c_void_p], None),
            "JSValueUnprotect": ([ctypes.c_void_p, ctypes.c_void_p], None),
            "JSValueToStringCopy": ([ctypes.c_void_p, ctypes.c_void_p,
                                     ctypes.POINTER(ctypes.c_void_p)], ctypes.c_void_p),
            "JSStringGetMaximumUTF8CStringSize": ([ctypes.c_void_p], ctypes.c_size_t),
            "JSStringGetUTF8CString": ([ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t], ctypes.c_size_t),
        }
        for name, (arguments, result) in signatures.items():
            function = getattr(self.library, name)
            function.argtypes = arguments
            function.restype = result
        for option in (b"useJIT", b"useWasm", b"useConcurrentGC", b"useParallelMarkingConstraintSolver"):
            if not self.library.jsc_options_set_boolean(option, 0):
                raise RuntimeError("JavaScript interpreter could not be configured")
        if not self.library.jsc_options_set_uint(b"numberOfGCMarkers", 1):
            raise RuntimeError("JavaScript collector could not be configured")
        self.context = self.library.JSGlobalContextCreate(None)
        self.program = None
        script = self.library.JSStringCreateWithUTF8CString(framework.encode("utf-8"))
        exception = ctypes.c_void_p()
        try:
            self.runner = self.library.JSEvaluateScript(self.context, script, None, None, 1, ctypes.byref(exception))
        finally:
            self.library.JSStringRelease(script)
        if exception.value or not self.runner:
            self.library.JSGlobalContextRelease(self.context)
            raise RuntimeError("Visual drawing API could not be initialized")
        self.library.JSValueProtect(self.context, self.runner)

    def compile(self, code):
        if not isinstance(code, str) or "\0" in code or len(code.encode("utf-8")) > MAX_SCRIPT_BYTES:
            raise ValueError("Visual program must contain at most 512 KiB of JavaScript without NUL")
        body = self.library.JSStringCreateWithUTF8CString(code.encode("utf-8"))
        parameter = self.library.JSStringCreateWithUTF8CString(b"ctx")
        parameters = (ctypes.c_void_p * 1)(parameter)
        exception = ctypes.c_void_p()
        try:
            program = self.library.JSObjectMakeFunction(
                self.context, None, 1, parameters, body, None, 1, ctypes.byref(exception))
        finally:
            self.library.JSStringRelease(body)
            self.library.JSStringRelease(parameter)
        if exception.value or not program:
            raise ValueError("Visual program contains invalid JavaScript")
        if self.program:
            self.library.JSValueUnprotect(self.context, self.program)
        self.program = program
        self.library.JSValueProtect(self.context, self.program)

    def frame(self, request):
        if not self.program:
            raise ValueError("Visual program is not initialized")
        encoded = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        text = self.library.JSStringCreateWithUTF8CString(encoded)
        exception = ctypes.c_void_p()
        result_text = None
        try:
            arguments = (ctypes.c_void_p * 2)(self.program, self.library.JSValueMakeString(self.context, text))
            value = self.library.JSObjectCallAsFunction(
                self.context, self.runner, None, 2, arguments, ctypes.byref(exception))
            if exception.value or not value:
                raise ValueError("Visual program failed while drawing")
            result_text = self.library.JSValueToStringCopy(self.context, value, ctypes.byref(exception))
            if exception.value or not result_text:
                raise ValueError("Visual program did not produce a frame")
            size = self.library.JSStringGetMaximumUTF8CStringSize(result_text)
            if size > MAX_FRAME_BYTES * 3 + 1:
                raise ValueError("Visual frame exceeds 256 KiB")
            output = ctypes.create_string_buffer(size)
            self.library.JSStringGetUTF8CString(result_text, output, size)
            if len(output.value) > MAX_FRAME_BYTES:
                raise ValueError("Visual frame exceeds 256 KiB")
            return output.value
        finally:
            self.library.JSStringRelease(text)
            if result_text:
                self.library.JSStringRelease(result_text)

    def close(self):
        if self.program:
            self.library.JSValueUnprotect(self.context, self.program)
        self.library.JSValueUnprotect(self.context, self.runner)
        self.library.JSGlobalContextRelease(self.context)


if __name__ == "__main__":
    program = None
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_AS, (MAX_ADDRESS_SPACE_BYTES, MAX_ADDRESS_SPACE_BYTES))
        resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
        resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        signal.signal(signal.SIGALRM, signal.SIG_DFL)
        signal.signal(signal.SIGPROF, signal.SIG_DFL)
        if len(sys.argv) == 4 and sys.argv[1] == "--scope":
            parent = int(sys.argv[3])
            if parent <= 0 or os.getppid() != parent:
                raise RuntimeError("Visual request owner is unavailable")
            libc = ctypes.CDLL(None, use_errno=True)
            libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
            libc.prctl.restype = ctypes.c_int
            if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
                raise OSError(ctypes.get_errno(), "Visual request owner could not be protected")
            if os.getppid() != parent:
                raise RuntimeError("Visual request owner is unavailable")
            command = [
                "/usr/bin/systemd-run", "--user", "--scope", "--quiet", "--collect", "--slice-inherit",
                "--expand-environment=no", "--property=MemoryMax=512M", "--property=MemorySwapMax=0",
                "--", "/usr/bin/python3", "-I", str(pathlib.Path(__file__).resolve()), "--sandbox", sys.argv[2],
            ]
            os.execve(command[0], command, {"XDG_RUNTIME_DIR": "/run/user/" + str(os.getuid())})
        if len(sys.argv) == 3 and sys.argv[1] == "--sandbox":
            membership = next((line[3:] for line in pathlib.Path("/proc/self/cgroup").read_text().splitlines()
                               if line.startswith("0::")), None)
            if membership is None:
                raise RuntimeError("Visual programs require the unified memory controller")
            root = pathlib.Path("/sys/fs/cgroup").resolve()
            group = (root / membership.lstrip("/")).resolve()
            group.relative_to(root)
            if ((group / "memory.max").read_text().strip() != str(MAX_MEMORY_BYTES)
                    or (group / "memory.swap.max").read_text().strip() != "0"):
                raise RuntimeError("Visual program memory limits are unavailable")
            command = [
                "/usr/bin/bwrap", "--clearenv", "--unshare-all", "--unshare-user", "--die-with-parent",
                "--new-session", "--cap-drop", "ALL", "--disable-userns", "--ro-bind", "/usr", "/usr",
            ]
            for name in ("/lib", "/lib64", "/bin", "/sbin"):
                path = pathlib.Path(name)
                if path.is_symlink():
                    command.extend(["--symlink", str(path.readlink()), name])
                elif path.is_dir():
                    command.extend(["--ro-bind", name, name])
            command.extend([
                "--proc", "/proc", "--dev", "/dev", "--size", "4194304", "--tmpfs", "/tmp",
                "--ro-bind", str(pathlib.Path(__file__).resolve()), "/renderer.py",
                "--ro-bind", str(pathlib.Path(sys.argv[2]) / "shared" / "visual-api.js"), "/visual-api.js",
                "--ro-bind", str(group / "memory.max"), "/memory.max",
                "--ro-bind", str(group / "memory.swap.max"), "/memory.swap.max",
                "--chdir", "/", "--", "/usr/bin/python3", "-I", "/renderer.py", "--render", "/visual-api.js",
            ])
            os.execve(command[0], command, {})
        if len(sys.argv) != 3 or sys.argv[1] != "--render":
            raise ValueError("Visual renderer launch mode is required")
        if (pathlib.Path("/memory.max").read_text().strip() != str(MAX_MEMORY_BYTES)
                or pathlib.Path("/memory.swap.max").read_text().strip() != "0"):
            raise RuntimeError("Visual program memory limits are unavailable")
        signal.setitimer(signal.ITIMER_REAL, REQUEST_DEADLINE_SECONDS)
        framework = pathlib.Path(sys.argv[2]).read_text(encoding="utf-8")
        program = VisualProgram(framework)
        signal.setitimer(signal.ITIMER_REAL, 0)
        initialized = False
        while True:
            payload = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
            if not payload:
                break
            if len(payload) > MAX_REQUEST_BYTES or not payload.endswith(b"\n"):
                raise ValueError("Visual request is too large or incomplete")
            signal.setitimer(signal.ITIMER_REAL, REQUEST_DEADLINE_SECONDS)
            request = json.loads(payload)
            if not isinstance(request, dict) or request.get("event") not in ("check", "init", "update", "destroy"):
                raise ValueError("Visual request event is invalid")
            if request["event"] in ("check", "init"):
                if initialized:
                    raise ValueError("Visual program is already initialized")
                program.compile(request.get("code"))
                del request["code"]
            if request["event"] == "check":
                output = b'{"valid":true}'
            else:
                if request["event"] == "init":
                    initialized = True
                elif not initialized:
                    raise ValueError("Visual program is not initialized")
                signal.setitimer(signal.ITIMER_PROF, FRAME_CPU_SECONDS)
                output = program.frame(request)
                signal.setitimer(signal.ITIMER_PROF, 0)
            signal.setitimer(signal.ITIMER_REAL, 0)
            sys.stdout.buffer.write(output + b"\n")
            sys.stdout.buffer.flush()
            if request["event"] in ("check", "destroy"):
                break
    except (OSError, UnicodeError, ValueError, RuntimeError, RecursionError):
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.setitimer(signal.ITIMER_PROF, 0)
        sys.stdout.write('{"error":"Visual program could not be processed"}\n')
        sys.exit(2)
    finally:
        if program:
            program.close()
