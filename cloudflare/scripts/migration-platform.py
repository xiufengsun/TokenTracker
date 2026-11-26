"""Platform checks for the migration operator's database tools and key files."""

import os
from pathlib import Path
import shutil
import subprocess


def local_pg_host(value):
    """Restrict restore and rehearsal connections to a local PostgreSQL."""
    value = str(value)
    if os.name == "nt":
        if value != "127.0.0.1":
            raise ValueError("Use the isolated PostgreSQL server on 127.0.0.1")
        return value
    if not Path(value).is_absolute():
        raise ValueError("Use an absolute private PostgreSQL socket directory")
    return value


def require_private_file(file):
    file = file.resolve(strict=True)
    if not file.is_file():
        raise ValueError("Expected a private regular file")
    if os.name != "nt":
        info = file.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ValueError("Use an operator-owned file with owner-only permissions")
        return
    # Windows chmod does not represent NTFS ACLs. Check inherited grants too.
    acl_check = r"""
      $ErrorActionPreference = 'Stop'
      $sidType = [System.Security.Principal.SecurityIdentifier]
      $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      $fileAcl = Get-Acl -LiteralPath $env:TT_MIGRATION_PRIVATE_FILE
      if ($fileAcl.GetOwner($sidType).Value -ne $owner) { exit 1 }
      $allowed = @($owner, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-4')
      foreach ($rule in $fileAcl.GetAccessRules($true, $true, $sidType)) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) { exit 1 }
      }
    """
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", acl_check],
        env=dict(os.environ, TT_MIGRATION_PRIVATE_FILE=str(file)),
        capture_output=True,
    )
    if result.returncode:
        raise ValueError("Use a private file owned by the current Windows user")


def npx_command():
    command = shutil.which("npx.cmd" if os.name == "nt" else "npx")
    if not command:
        raise RuntimeError("The InsForge CLI requires npx on PATH")
    return command
