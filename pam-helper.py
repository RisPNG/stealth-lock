#!/usr/bin/env python3
"""
PAM Authentication Helper for Stealth Lock Extension

This script verifies user passwords using PAM (Pluggable Authentication Modules).
It reads the password from stdin and exits with:
  0 - Authentication successful
  1 - Authentication failed
"""

import sys
import os
import pwd

try:
    import pam
    HAS_PAM = True
except ImportError:
    HAS_PAM = False

def verify_with_pam_module(username: str, password: str) -> bool:
    """Verify password using python-pam module."""
    if not HAS_PAM:
        return False
    
    p = pam.pam()
    return p.authenticate(username, password, service='login')

def verify_with_subprocess(username: str, password: str) -> bool:
    """Verify password using su command as fallback."""
    import subprocess
    
    try:
        # Use su to verify the password
        proc = subprocess.Popen(
            ['su', '-c', 'true', username],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        proc.communicate(input=(password + '\n').encode(), timeout=5)
        return proc.returncode == 0
    except Exception:
        return False

def verify_with_unix_chkpwd(username: str, password: str) -> bool:
    """Verify password using unix_chkpwd (requires appropriate permissions)."""
    import subprocess
    
    try:
        proc = subprocess.Popen(
            ['/sbin/unix_chkpwd', username, 'nullok'],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        proc.communicate(input=(password + '\n').encode(), timeout=5)
        return proc.returncode == 0
    except Exception:
        return False

def verify_with_pam_auth_helper(username: str, password: str) -> bool:
    """
    Verify password using ctypes to call PAM directly.
    This is the most reliable method but requires libpam.
    """
    import ctypes
    from ctypes import (
        c_char_p,
        c_int,
        c_size_t,
        c_void_p,
        CFUNCTYPE,
        POINTER,
        Structure,
        cast,
        pointer,
    )
    
    try:
        libpam = ctypes.CDLL('libpam.so.0')
    except OSError:
        try:
            libpam = ctypes.CDLL('libpam.so')
        except OSError:
            return False

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
    
    # PAM conversation structure
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
    
    # Conversation callback type
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
    
    # PAM constants
    PAM_SUCCESS = 0
    PAM_AUTH_ERR = 7
    PAM_USER_UNKNOWN = 10
    PAM_MAXTRIES = 11
    PAM_CONV_ERR = 19

    PAM_PROMPT_ECHO_OFF = 1
    PAM_PROMPT_ECHO_ON = 2
    
    # Store password for callback
    password_buf = ctypes.create_string_buffer(password.encode('utf-8'))
    
    def conversation(num_msg, msg, resp, appdata_ptr):
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
    
    # Create conversation structure
    conv_func = CONV_FUNC(conversation)
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
        pam_handle = c_void_p()

        ret = libpam.pam_start(service, username_bytes, pointer(pam_conv), pointer(pam_handle))
        if ret != PAM_SUCCESS:
            continue

        ret_auth = ret
        try:
            ret_auth = libpam.pam_authenticate(pam_handle, 0)
            if ret_auth == PAM_SUCCESS:
                try:
                    libpam.pam_acct_mgmt(pam_handle, 0)
                except Exception:
                    pass
                return True

            # If the service is valid and the password is wrong, stop early.
            if ret_auth in (PAM_AUTH_ERR, PAM_USER_UNKNOWN, PAM_MAXTRIES):
                return False
        finally:
            try:
                libpam.pam_end(pam_handle, ret_auth)
            except Exception:
                pass

    return False

def main():
    # Get current username
    try:
        username = pwd.getpwuid(os.getuid()).pw_name
    except KeyError:
        username = os.environ.get('USER', '')
    
    if not username:
        print("Could not determine username", file=sys.stderr)
        sys.exit(1)
    
    # Read password from stdin
    try:
        password = sys.stdin.readline().rstrip('\n')
    except Exception as e:
        print(f"Failed to read password: {e}", file=sys.stderr)
        sys.exit(1)
    
    if not password:
        print("No password provided", file=sys.stderr)
        sys.exit(1)
    
    # Try different authentication methods
    authenticated = False
    
    # Method 1: python-pam module (if available)
    if HAS_PAM:
        authenticated = verify_with_pam_module(username, password)
    
    # Method 2: Direct PAM via ctypes
    if not authenticated:
        authenticated = verify_with_pam_auth_helper(username, password)
    
    # Method 3: unix_chkpwd (fallback)
    if not authenticated:
        authenticated = verify_with_unix_chkpwd(username, password)
    
    # Exit with appropriate code
    sys.exit(0 if authenticated else 1)

if __name__ == '__main__':
    main()
