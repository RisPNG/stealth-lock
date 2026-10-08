# Source releases

The supported distribution is the source installer. A release archive contains committed source; users extract it and run `mise exec -- bash install.sh`. `package.sh` builds the separate slim GNOME runtime archive.

## Build an archive

Run the checks and commit the reviewed changes first. The release script rejects tracked changes because its input is committed `HEAD`.

```sh
mise exec -- npm run check
mise exec -- npm run test:shell
mise exec -- bash scripts/release.sh --unsigned
```

The default output is `dist/stealth-lock-<version-name>.tar.gz`. `git archive` supplies the source and `gzip -n` removes variable gzip metadata, so the same commit produces the same archive bytes. CI's native matrix tests committed source on GNOME 45–51; inspect actual results before claiming each release is verified.

## Create a signing key

An OpenPGP signature lets recipients check that the exact archive was signed by the holder of your key. It detects changes to the download. Recipients also need an independently trusted copy of your public-key fingerprint; a public key bundled with a download alone does not establish your identity. Signing does not change runtime authentication or make an untested build secure.

The maintainer's current signing fingerprint is `5B33C2F5445A05EB4600CB3A4C5D246614732607`, for Ris Peng `<hello@rispeng.com>`, expiring 2027-10-08. Check this fingerprint through a trusted copy of the repository before using the exported release public key.

Install GnuPG if it is unavailable, then run these commands in your own terminal:

```sh
mise exec -- gpg --quick-generate-key 'Ris Peng <hello@rispeng.com>' ed25519 sign 1y
mise exec -- gpg --fingerprint 'hello@rispeng.com'
```

Use the local pinentry prompt to choose a passphrase. Keep the private key, passphrase and generated revocation certificate private and backed up. The public fingerprint and public key can be shared. The key expires after one year; renew it before signing later releases. If you already have an appropriate signing key, use its fingerprint instead of creating another.

The commands follow [GnuPG's key-management documentation](https://www.gnupg.org/documentation/manuals/gnupg/OpenPGP-Key-Management.html). No project command creates your identity key automatically.

## Sign and verify

Replace `YOUR_FULL_FINGERPRINT` with the full 40- or 64-hex-digit public fingerprint:

```sh
mise exec -- bash scripts/release.sh --sign-key YOUR_FULL_FINGERPRINT
```

The script writes the archive, an ASCII-armored detached signature (`.asc`) and an exported public key (`.key.asc`). It verifies the result with `gpgv` in a temporary private keyring before writing the release files. Your private key stays in your existing GnuPG installation.

Publish the source archive and signature together. Publish the public fingerprint through a channel recipients already trust, and make the public key available. A recipient first checks that public key against the trusted fingerprint, then runs:

```sh
mise exec -- gpg --show-keys --with-fingerprint trusted-maintainer-key.asc
mise exec -- bash scripts/release.sh --verify trusted-maintainer-key.asc stealth-lock-1.0.1.tar.gz
```

The signature must be beside the archive as `stealth-lock-1.0.1.tar.gz.asc`. Verification uses a temporary keyring and leaves the recipient's personal keyring unchanged. A changed archive or a different signing key fails verification.

For example, if a mirror changes even one byte in your signed archive, verification fails. A valid signature from a key whose fingerprint you have never trusted still requires checking who owns that key.
