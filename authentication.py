#!/usr/bin/python3

import ctypes
import os
import pwd
import sys


PAM_SUCCESS = 0
PAM_SYSTEM_ERR = 4
PAM_CONV_ERR = 19
PAM_DISALLOW_NULL_AUTHTOK = 1
PAM_PROMPT_ECHO_OFF = 1
PAM_PROMPT_ECHO_ON = 2
PAM_ERROR_MSG = 3
PAM_TEXT_INFO = 4
PAM_MAX_NUM_MSG = 32


class PamMessage(ctypes.Structure):
    _fields_ = [("msg_style", ctypes.c_int), ("msg", ctypes.c_char_p)]


class PamResponse(ctypes.Structure):
    _fields_ = [("resp", ctypes.c_void_p), ("resp_retcode", ctypes.c_int)]


PamConversation = ctypes.CFUNCTYPE(
    ctypes.c_int,
    ctypes.c_int,
    ctypes.POINTER(ctypes.POINTER(PamMessage)),
    ctypes.POINTER(ctypes.POINTER(PamResponse)),
    ctypes.c_void_p,
)


class PamConv(ctypes.Structure):
    _fields_ = [("conv", PamConversation), ("appdata_ptr", ctypes.c_void_p)]


def verify_password(password):
    if not isinstance(password, str) or not password or any(
        character in password for character in ("\n", "\r", "\0")
    ):
        return False

    password_buffer = None
    handle = ctypes.c_void_p()
    started = False
    authenticated = False
    ended = False
    status = PAM_SYSTEM_ERR
    conversation_failed = False
    password_prompts = 0

    try:
        username = pwd.getpwuid(os.getuid()).pw_name.encode("utf-8")
        libpam = ctypes.CDLL("libpam.so.0")
        libc = ctypes.CDLL(None)
        libc.calloc.argtypes = [ctypes.c_size_t, ctypes.c_size_t]
        libc.calloc.restype = ctypes.c_void_p
        libc.strdup.argtypes = [ctypes.c_char_p]
        libc.strdup.restype = ctypes.c_void_p
        libc.free.argtypes = [ctypes.c_void_p]
        libc.free.restype = None

        password_buffer = ctypes.create_string_buffer(password.encode("utf-8"))

        def conversation(count, messages, response, _data):
            nonlocal conversation_failed, password_prompts
            responses = None
            allocation = None

            try:
                if not response or not messages or not 0 < count <= PAM_MAX_NUM_MSG:
                    raise ValueError("Unsupported PAM conversation")

                response[0] = None
                answers = []
                for index in range(count):
                    style = messages[index].contents.msg_style
                    if style == PAM_PROMPT_ECHO_OFF:
                        if password_prompts:
                            raise ValueError("Multiple password prompts")
                        password_prompts += 1
                        answers.append(ctypes.cast(password_buffer, ctypes.c_char_p))
                    elif style == PAM_PROMPT_ECHO_ON:
                        answers.append(username)
                    elif style in (PAM_ERROR_MSG, PAM_TEXT_INFO):
                        answers.append(None)
                    else:
                        raise ValueError("Unsupported PAM prompt")

                allocation = libc.calloc(count, ctypes.sizeof(PamResponse))
                if not allocation:
                    raise MemoryError("PAM response allocation failed")

                responses = ctypes.cast(allocation, ctypes.POINTER(PamResponse))
                for index, answer in enumerate(answers):
                    if answer is not None:
                        responses[index].resp = libc.strdup(answer)
                        if not responses[index].resp:
                            raise MemoryError("PAM answer allocation failed")

                response[0] = responses
                return PAM_SUCCESS
            except Exception:
                conversation_failed = True
                if responses is not None:
                    for index in range(count):
                        if responses[index].resp:
                            libc.free(responses[index].resp)
                if allocation:
                    libc.free(allocation)
                return PAM_CONV_ERR

        callback = PamConversation(conversation)
        conv = PamConv(callback, None)
        libpam.pam_start.argtypes = [
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.POINTER(PamConv),
            ctypes.POINTER(ctypes.c_void_p),
        ]
        libpam.pam_start.restype = ctypes.c_int
        libpam.pam_authenticate.argtypes = [ctypes.c_void_p, ctypes.c_int]
        libpam.pam_authenticate.restype = ctypes.c_int
        libpam.pam_acct_mgmt.argtypes = [ctypes.c_void_p, ctypes.c_int]
        libpam.pam_acct_mgmt.restype = ctypes.c_int
        libpam.pam_end.argtypes = [ctypes.c_void_p, ctypes.c_int]
        libpam.pam_end.restype = ctypes.c_int

        status = libpam.pam_start(b"gdm-password", username, ctypes.byref(conv), ctypes.byref(handle))
        if status == PAM_SUCCESS and handle:
            started = True
            status = libpam.pam_authenticate(handle, PAM_DISALLOW_NULL_AUTHTOK)
            if status == PAM_SUCCESS and password_prompts == 1 and not conversation_failed:
                status = libpam.pam_acct_mgmt(handle, PAM_DISALLOW_NULL_AUTHTOK)
                authenticated = status == PAM_SUCCESS and not conversation_failed
    except Exception:
        status = PAM_SYSTEM_ERR
    finally:
        if started:
            try:
                ended = libpam.pam_end(handle, status) == PAM_SUCCESS
            except Exception:
                ended = False
        if password_buffer is not None:
            ctypes.memset(password_buffer, 0, ctypes.sizeof(password_buffer))

    return authenticated and ended and not conversation_failed


if __name__ == "__main__":
    try:
        password = sys.stdin.buffer.read().decode("utf-8")
        sys.exit(0 if verify_password(password) else 1)
    except (OSError, UnicodeError):
        sys.exit(1)
