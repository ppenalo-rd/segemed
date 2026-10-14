const { spawn } = require('node:child_process');
const path = require('node:path');

const WINDOWS_DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  Add-Type -AssemblyName System.Security
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
  $pathField = if ($request.operation -match 'License') { 'licensePathBase64' } else { 'statePathBase64' }
  $filePath = [System.IO.Path]::GetFullPath([System.Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String([string]$request.$pathField)
  ))
  $directory = [System.IO.Path]::GetDirectoryName($filePath)
  if (-not $directory) { throw 'La ruta del almacén no contiene directorio.' }

  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $userSid = $identity.User
  $systemSid = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                 [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  $allow = [System.Security.AccessControl.AccessControlType]::Allow
  $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl

  if (-not [System.IO.Directory]::Exists($directory)) {
    [void][System.IO.Directory]::CreateDirectory($directory)
  }
  $directoryAcl = New-Object System.Security.AccessControl.DirectorySecurity
  $directoryAcl.SetAccessRuleProtection($true, $false)
  $directoryAcl.SetOwner($userSid)
  $directoryAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($userSid, $fullControl, $inheritance, $propagation, $allow)))
  $directoryAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, $fullControl, $inheritance, $propagation, $allow)))
  [System.IO.Directory]::SetAccessControl($directory, $directoryAcl)

  $isLicense = $request.operation -match 'License'
  $entropy = if ($isLicense) {
    [System.Text.Encoding]::UTF8.GetBytes('SIGEMED|signed-license|v1')
  } else {
    [System.Text.Encoding]::UTF8.GetBytes('SIGEMED|license-clock-state|v1')
  }
  $header = if ($isLicense) { 'SIGEMED-DPAPI-LICENSE-v1' } else { 'SIGEMED-DPAPI-STATE-v1' }

  if ($request.operation -eq 'load' -or $request.operation -eq 'loadLicense') {
    if (-not [System.IO.File]::Exists($filePath)) {
      [Console]::Out.WriteLine('NULL')
      exit 0
    }
    $fileAcl = New-Object System.Security.AccessControl.FileSecurity
    $fileAcl.SetAccessRuleProtection($true, $false)
    $fileAcl.SetOwner($userSid)
    $fileAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($userSid, $fullControl, $allow)))
    $fileAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, $fullControl, $allow)))
    [System.IO.File]::SetAccessControl($filePath, $fileAcl)

    $content = [System.IO.File]::ReadAllText($filePath, [System.Text.Encoding]::ASCII)
    $prefix = $header + [Environment]::NewLine
    if (-not $content.StartsWith($prefix, [StringComparison]::Ordinal)) {
      throw 'El archivo de estado tiene un formato desconocido o está dañado.'
    }
    $protectedBytes = [Convert]::FromBase64String($content.Substring($prefix.Length).Trim())
    $plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $protectedBytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $outputPrefix = if ($isLicense) { 'LICENSE:' } else { 'STATE:' }
    [Console]::Out.WriteLine($outputPrefix + [Convert]::ToBase64String($plainBytes))
    exit 0
  }

  if ($request.operation -eq 'save' -or $request.operation -eq 'saveLicense') {
    if ($isLicense) {
      $plainBytes = [Convert]::FromBase64String([string]$request.licenseContentBase64)
    } else {
      $plainBytes = [System.Text.Encoding]::UTF8.GetBytes(
        (ConvertTo-Json -InputObject $request.state -Compress -Depth 10)
      )
    }
    $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
      $plainBytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $content = $header + [Environment]::NewLine + [Convert]::ToBase64String($protectedBytes) + [Environment]::NewLine
    $tempPath = $filePath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    $fileStream = New-Object System.IO.FileStream(
      $tempPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None,
      4096,
      [System.IO.FileOptions]::WriteThrough
    )
    try {
      $bytes = [System.Text.Encoding]::ASCII.GetBytes($content)
      $fileStream.Write($bytes, 0, $bytes.Length)
      $fileStream.Flush($true)
    } finally {
      $fileStream.Dispose()
    }

    $tempAcl = New-Object System.Security.AccessControl.FileSecurity
    $tempAcl.SetAccessRuleProtection($true, $false)
    $tempAcl.SetOwner($userSid)
    $tempAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($userSid, $fullControl, $allow)))
    $tempAcl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($systemSid, $fullControl, $allow)))
    [System.IO.File]::SetAccessControl($tempPath, $tempAcl)

    try {
      if ([System.IO.File]::Exists($filePath)) {
        $backupPath = $filePath + '.' + [Guid]::NewGuid().ToString('N') + '.bak'
        [System.IO.File]::Replace($tempPath, $filePath, $backupPath, $true)
        if ([System.IO.File]::Exists($backupPath)) {
          [System.IO.File]::Delete($backupPath)
        }
      } else {
        [System.IO.File]::Move($tempPath, $filePath)
      }
    } finally {
      if ([System.IO.File]::Exists($tempPath)) {
        [System.IO.File]::Delete($tempPath)
      }
    }
    [Console]::Out.WriteLine('OK')
    exit 0
  }

  throw 'Operación de almacén de licencia no reconocida.'
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

function validateState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
      || state.version !== 1
      || typeof state.installationId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(state.installationId)
      || typeof state.lastSeenAt !== 'string'
      || !Number.isFinite(Date.parse(state.lastSeenAt))
      || new Date(Date.parse(state.lastSeenAt)).toISOString() !== state.lastSeenAt
      || Object.keys(state).length !== 3
      || !['version', 'installationId', 'lastSeenAt'].every((key) => Object.hasOwn(state, key))) {
    throw new TypeError('El estado local de licencia no tiene el formato admitido.');
  }
}

function runPowerShell({ executable, timeoutMs, request }) {
  const encodedScript = Buffer.from(WINDOWS_DPAPI_SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      encodedScript,
    ], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error('Se agotó el tiempo al acceder al almacén DPAPI de licencias.'));
    }, timeoutMs);

    function finish(error, output) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(output);
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code !== 0) {
        return finish(new Error(`Falló el almacén DPAPI de licencias: ${stderr.trim() || `PowerShell salió con código ${code}.`}`));
      }
      finish(null, stdout.trim());
    });
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}

/**
 * Creates a Windows CurrentUser-DPAPI state store with a protected directory and atomic updates.
 */
function createWindowsLicenseStateStore({
  filePath = path.join(process.env.ProgramData || '', 'SIGEMED', 'License', 'clock-state.bin'),
  licensePath = path.join(process.env.ProgramData || '', 'SIGEMED', 'License', 'license.bin'),
  powershellPath = 'powershell.exe',
  timeoutMs = 10000,
} = {}) {
  if (process.platform !== 'win32') {
    throw new Error('El almacén DPAPI de licencias solo está disponible en Windows.');
  }
  if (!path.win32.isAbsolute(filePath)) {
    throw new TypeError('filePath debe ser una ruta absoluta de Windows.');
  }
  if (!path.win32.isAbsolute(licensePath)) {
    throw new TypeError('licensePath debe ser una ruta absoluta de Windows.');
  }
  if (typeof powershellPath !== 'string' || !powershellPath.trim()) {
    throw new TypeError('powershellPath debe identificar PowerShell.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new RangeError('timeoutMs debe estar entre 1000 y 60000.');
  }

  const absolutePath = path.win32.normalize(filePath);
  const absoluteLicensePath = path.win32.normalize(licensePath);
  const execute = async (operation, state, licenseContent) => {
    const request = { operation };
    if (operation.endsWith('License')) {
      request.licensePathBase64 = Buffer.from(absoluteLicensePath, 'utf8').toString('base64');
    } else {
      request.statePathBase64 = Buffer.from(absolutePath, 'utf8').toString('base64');
    }
    if (operation === 'save') request.state = state;
    if (operation === 'saveLicense') {
      request.licenseContentBase64 = Buffer.from(licenseContent, 'utf8').toString('base64');
    }
    return runPowerShell({
      executable: powershellPath,
      timeoutMs,
      request,
    });
  };

  return Object.freeze({
    async load() {
      const output = await execute('load');
      if (output === 'NULL') return null;
      if (!output.startsWith('STATE:')) {
        throw new Error('PowerShell devolvió una respuesta inválida al cargar el estado DPAPI.');
      }
      const json = Buffer.from(output.slice('STATE:'.length), 'base64').toString('utf8');
      try {
        return JSON.parse(json);
      } catch (error) {
        throw new Error('El estado DPAPI descifrado no contiene JSON válido.', { cause: error });
      }
    },
    async save(state) {
      validateState(state);
      const output = await execute('save', state);
      if (output !== 'OK') {
        throw new Error('PowerShell no confirmó la escritura atómica del estado DPAPI.');
      }
    },
    async loadLicense() {
      const output = await execute('loadLicense');
      if (output === 'NULL') return null;
      if (!output.startsWith('LICENSE:')) {
        throw new Error('PowerShell devolvió una respuesta inválida al cargar la licencia DPAPI.');
      }
      return Buffer.from(output.slice('LICENSE:'.length), 'base64').toString('utf8');
    },
    async saveLicense(licenseContent) {
      if (typeof licenseContent !== 'string'
          || Buffer.byteLength(licenseContent, 'utf8') > 16 * 1024) {
        throw new TypeError('El archivo de licencia debe ser texto de hasta 16 KB.');
      }
      const output = await execute('saveLicense', null, licenseContent);
      if (output !== 'OK') {
        throw new Error('PowerShell no confirmó la escritura atómica de la licencia DPAPI.');
      }
    },
  });
}

module.exports = {
  createWindowsLicenseStateStore,
};
