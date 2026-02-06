#!/usr/bin/env python3
"""
Stealth Lock - Polkit-based Authentication Helper

This script provides a more robust authentication mechanism using
polkit (PolicyKit) for password verification. It's designed to work
on both X11 and Wayland sessions.

Usage:
    echo "password" | python3 polkit-auth-helper.py

Exit codes:
    0 - Authentication successful
    1 - Authentication failed
    2 - System error
"""

import sys
import os
import subprocess
import getpass
import ctypes
from ctypes import (
    c_char_p,
    c_int,
    c_size_t,
    c_void_p,
    CFUNCTYPE,
    POINTER,
    Structure,
    pointer,
    cast,
)

def verify_with_pam(username: str, password: str, debug: bool = False) -> bool:
    """
    Verify password using PAM (Pluggable Authentication Modules) via ctypes.
    This is the most reliable method that works without external dependencies.
    """
    
    # Try to load libpam
    try:
        libpam = ctypes.CDLL('libpam.so.0')
    except OSError:
        try:
            libpam = ctypes.CDLL('libpam.so')
        except OSError:
            return None  # PAM not available

    # libc is used for allocating memory that PAM will free().
    try:
        libc = ctypes.CDLL('libc.so.6')
    except OSError:
        libc = ctypes.CDLL(None)

    libc.calloc.argtypes = [c_size_t, c_size_t]
    libc.calloc.restype = c_void_p
    libc.free.argtypes = [c_void_p]
    libc.free.restype = None
    libc.strdup.argtypes = [c_char_p]
    libc.strdup.restype = c_void_p
    
    # Define PAM constants
    PAM_SUCCESS = 0
    PAM_AUTH_ERR = 7
    PAM_USER_UNKNOWN = 10
    PAM_MAXTRIES = 11
    PAM_CONV_ERR = 19

    PAM_PROMPT_ECHO_OFF = 1
    PAM_PROMPT_ECHO_ON = 2
    
    class PamMessage(Structure):
        _fields_ = [
            ('msg_style', c_int),
            ('msg', c_char_p),
        ]
    
    class PamResponse(Structure):
        _fields_ = [
            ('resp', c_char_p),
            ('resp_retcode', c_int),
        ]
    
    CONV_FUNC = CFUNCTYPE(
        c_int,
        c_int,
        POINTER(POINTER(PamMessage)),
        POINTER(POINTER(PamResponse)),
        c_void_p
    )
    
    class PamConv(Structure):
        _fields_ = [
            ('conv', CONV_FUNC),
            ('appdata_ptr', c_void_p),
        ]
    
    password_buf = ctypes.create_string_buffer(password.encode('utf-8'))

    def pam_conversation(num_msg, msg, resp, appdata_ptr):
        """
        Allocate responses with libc so PAM can free them safely.
        """
        if num_msg <= 0:
            resp[0] = None
            return PAM_SUCCESS

        resp_array_ptr = libc.calloc(num_msg, ctypes.sizeof(PamResponse))
        if not resp_array_ptr:
            resp[0] = None
            return PAM_CONV_ERR

        resp_array = cast(resp_array_ptr, POINTER(PamResponse))

        try:
            for i in range(num_msg):
                style = msg[i].contents.msg_style
                if style in (PAM_PROMPT_ECHO_OFF, PAM_PROMPT_ECHO_ON):
                    dup_ptr = libc.strdup(cast(password_buf, c_char_p))
                    if not dup_ptr:
                        raise MemoryError("strdup failed")
                    resp_array[i].resp = cast(dup_ptr, c_char_p)
                    resp_array[i].resp_retcode = 0
                else:
                    resp_array[i].resp = None
                    resp_array[i].resp_retcode = 0

            resp[0] = resp_array
            return PAM_SUCCESS
        except Exception:
            # Best-effort cleanup: free any strings we allocated, then the array.
            try:
                for i in range(num_msg):
                    if resp_array[i].resp:
                        libc.free(cast(resp_array[i].resp, c_void_p))
                libc.free(cast(resp_array, c_void_p))
            except Exception:
                pass
            resp[0] = None
            return PAM_CONV_ERR
    
    conv_func = CONV_FUNC(pam_conversation)
    pam_conv = PamConv(conv_func, None)
    
    # Set up function prototypes
    libpam.pam_start.argtypes = [c_char_p, c_char_p, POINTER(PamConv), POINTER(c_void_p)]
    libpam.pam_start.restype = c_int
    
    libpam.pam_authenticate.argtypes = [c_void_p, c_int]
    libpam.pam_authenticate.restype = c_int
    
    libpam.pam_acct_mgmt.argtypes = [c_void_p, c_int]
    libpam.pam_acct_mgmt.restype = c_int
    
    libpam.pam_end.argtypes = [c_void_p, c_int]
    libpam.pam_end.restype = c_int
    
    username_bytes = username.encode('utf-8')
    services = [b'gdm-password', b'login', b'system-auth', b'passwd', b'sudo']

    for service in services:
        pamh = c_void_p()
        ret = libpam.pam_start(service, username_bytes, pointer(pam_conv), pointer(pamh))
        if debug:
            print(f"DEBUG: pam_start(service={service.decode(errors='ignore')}) -> {ret}", file=sys.stderr)
        if ret != PAM_SUCCESS:
            continue

        ret_auth = ret
        try:
            ret_auth = libpam.pam_authenticate(pamh, 0)
            if debug:
                print(f"DEBUG: pam_authenticate -> {ret_auth}", file=sys.stderr)
            if ret_auth == PAM_SUCCESS:
                # Account checks can fail for reasons unrelated to password validity.
                try:
                    libpam.pam_acct_mgmt(pamh, 0)
                except Exception:
                    pass
                if debug:
                    print(f"DEBUG: auth success (service={service.decode(errors='ignore')})", file=sys.stderr)
                return True

            # If the service is valid and the password is wrong, stop early.
            if ret_auth in (PAM_AUTH_ERR, PAM_USER_UNKNOWN, PAM_MAXTRIES):
                if debug:
                    print("DEBUG: auth failed (wrong credentials)", file=sys.stderr)
                return False
        finally:
            try:
                libpam.pam_end(pamh, ret_auth)
            except Exception:
                pass

    return False

def verify_with_passwd(username: str, password: str) -> bool:
    """
    Fallback: Verify password by checking against shadow file.
    Requires root or shadow group membership.
    """
    import crypt
    import spwd
    
    try:
        shadow_entry = spwd.getspnam(username)
        stored_hash = shadow_entry.sp_pwdp
        
        # Check if account is locked
        if stored_hash.startswith('!') or stored_hash.startswith('*'):
            return False
        
        # Verify password
        computed_hash = crypt.crypt(password, stored_hash)
        return computed_hash == stored_hash
    except (KeyError, PermissionError):
        return None

def verify_with_sudo(username: str, password: str) -> bool:
    """
    Fallback: Use sudo to verify password.
    """
    try:
        proc = subprocess.Popen(
            ['sudo', '-S', '-u', username, '-k', 'true'],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, 'SUDO_ASKPASS': '/bin/false'}
        )
        _, _ = proc.communicate(input=(password + '\n').encode(), timeout=10)
        return proc.returncode == 0
    except Exception:
        return None

def main():
    debug = '--debug' in sys.argv[1:]

    # Get username
    try:
        username = getpass.getuser()
    except Exception:
        username = os.environ.get('USER', os.environ.get('LOGNAME', ''))
    
    if not username:
        print("Could not determine username", file=sys.stderr)
        sys.exit(2)
    
    # Read password from stdin
    try:
        if sys.stdin.isatty():
            password = getpass.getpass("Password: ")
        else:
            password = sys.stdin.readline().rstrip('\n\r')
    except (EOFError, KeyboardInterrupt):
        sys.exit(1)
    
    if not password:
        sys.exit(1)
    
    # Try authentication methods in order of preference
    
    # Method 1: PAM (most reliable)
    result = verify_with_pam(username, password, debug=debug)
    if result is not None:
        sys.exit(0 if result else 1)
    
    # Method 2: Shadow file (requires permissions)
    result = verify_with_passwd(username, password)
    if result is not None:
        sys.exit(0 if result else 1)
    
    # Method 3: Sudo fallback
    result = verify_with_sudo(username, password)
    if result is not None:
        sys.exit(0 if result else 1)
    
    # All methods failed
    if debug:
        print("DEBUG: no authentication method available", file=sys.stderr)
    else:
        print("No authentication method available", file=sys.stderr)
    sys.exit(2)

if __name__ == '__main__':
    main()
