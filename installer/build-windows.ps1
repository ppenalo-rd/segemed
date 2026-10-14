[CmdletBinding()]
param(
    [Parameter()]
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),

    [Parameter()]
    [string]$PostgreSqlInstallerPath,

        [Parameter()]
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$PostgreSqlInstallerSha256,

        [Parameter()]
    [string]$DatabaseBootstrapSql,

        [Parameter()]
    [string]$LicensePublicKeyPath,

        [Parameter()]
    [string]$WinSWPath,

        [Parameter()]
    [ValidatePattern('^[A-Fa-f0-9]{64}$')]
    [string]$WinSWSha256,

    [Parameter()]
    [string]$InnoSetupCompilerPath,

    [Parameter()]
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:NodeVersion = '24.21.0'
$script:NodeArchiveName = "node-v$($script:NodeVersion)-win-x64.zip"
$script:NodeArchiveUrl = "https://nodejs.org/dist/v$($script:NodeVersion)/$($script:NodeArchiveName)"
$script:NodeArchiveSha256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541'
$script:PostgreSqlVersion = '18.6'
$script:PostgreSqlServiceName = 'postgresql-x64-18'

function Resolve-ExistingFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $resolved.Path -PathType Leaf)) {
        throw "$Description no es un archivo: $Path"
    }
    return $resolved.Path
}

function Resolve-InnoSetupCompiler {
    param([string]$PreferredPath)

    if (-not [string]::IsNullOrWhiteSpace($PreferredPath)) {
        return Resolve-ExistingFile -Path $PreferredPath -Description 'Compilador Inno Setup'
    }

    $command = Get-Command 'ISCC.exe' -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($command -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
        return $command.Source
    }

    $candidatePaths = @()
    foreach ($programFiles in @(
        [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),
        [Environment]::GetEnvironmentVariable('ProgramFiles'),
        [Environment]::GetEnvironmentVariable('ProgramW6432')
    )) {
        if (-not [string]::IsNullOrWhiteSpace($programFiles)) {
            $candidatePaths += Join-Path $programFiles 'Inno Setup 6\ISCC.exe'
        }
    }
    $candidatePaths += @(
        'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
        'C:\Program Files\Inno Setup 6\ISCC.exe'
    )

    foreach ($candidate in ($candidatePaths | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    foreach ($registryPath in @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )) {
        $installations = Get-ItemProperty -Path $registryPath -ErrorAction SilentlyContinue |
            Where-Object { $_.DisplayName -like 'Inno Setup*' -and $_.InstallLocation }
        foreach ($installation in $installations) {
            $candidate = Join-Path $installation.InstallLocation 'ISCC.exe'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return (Resolve-Path -LiteralPath $candidate).Path
            }
        }
    }

    throw 'No se encontró ISCC.exe. Instale Inno Setup 6, agréguelo al PATH o indique -InnoSetupCompilerPath.'
}

function Assert-Sha256 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Expected,
        [Parameter(Mandatory = $true)][string]$Description
    )

    $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
    if (-not [string]::Equals($actual, $Expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Description no coincide con el SHA-256 declarado. Esperado: $Expected; obtenido: $actual"
    }
}

function Assert-DatabaseBootstrapSchema {
    param([Parameter(Mandatory = $true)][string]$Path)

    $sql = [System.IO.File]::ReadAllText($Path)
    $requiredTables = @(
        'users',
        'patients',
        'doctors',
        'appointments',
        'medical_consultations',
        'roles',
        'user_roles',
        'soap_subjective',
        'soap_objective',
        'soap_assessment',
        'soap_plan',
        'soap_audit_logs'
    )
    foreach ($table in $requiredTables) {
        $escapedTable = [Regex]::Escape($table)
        # Match either unquoted or double-quoted table names, optional schema prefix
        $pattern = "(?im)^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[A-Za-z_][\w]*\.)?(?:\"$escapedTable\"|$escapedTable)\s*\("
        if ($sql -notmatch $pattern) {
            throw "El bootstrap SQL no declara CREATE TABLE para '$table'. Se requiere un esquema base completo y validado."
        }
    }
}

function New-InstallRuntimeScript {
    param([Parameter(Mandatory = $true)][string]$Destination)

    $content = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PostgresInstaller,
    [Parameter(Mandatory = $true)][string]$BootstrapSql,
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$DataRoot,
    [Parameter(Mandatory = $true)][string]$LicensePublicKey
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$serviceName = 'postgresql-x64-18'
$databaseName = 'sigemed_db'
$appRole = 'sigemed_app'
$postgresProgramFiles = Join-Path $env:ProgramFiles 'PostgreSQL\18'
$postgresData = Join-Path $DataRoot 'PostgreSQL\data'
$postgresBin = Join-Path $postgresProgramFiles 'bin'
$envFile = Join-Path $InstallRoot '.env'
$serviceExe = Join-Path $InstallRoot 'service\SIGEMED.exe'
$serviceXml = Join-Path $InstallRoot 'service\SIGEMED.xml'
$configDir = Join-Path $DataRoot 'Config'
$licenseDir = Join-Path $DataRoot 'License'
$clinicalFilesDir = Join-Path $DataRoot 'ClinicalFiles'
$backupDir = Join-Path $DataRoot 'Backups'
$logsDir = Join-Path $DataRoot 'Logs'
$appPassword = $null

function Invoke-CheckedProcess {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$ArgumentList,
        [Parameter(Mandatory = $true)][string]$FailureMessage
    )

    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -Wait -PassThru -NoNewWindow
    if ($process.ExitCode -ne 0) {
        throw "$FailureMessage (código $($process.ExitCode))."
    }
}

function New-RandomHexSecret {
    param([Parameter(Mandatory = $true)][ValidateRange(32, 128)][int]$ByteCount)

    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $bytes = New-Object byte[] $ByteCount
        $generator.GetBytes($bytes)
        return ([BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
    } finally {
        $generator.Dispose()
    }
}

function Set-ProtectedFileAcl {
    param([Parameter(Mandatory = $true)][string]$Path)

    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $administrators = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $localService = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-19')
    $full = [System.Security.AccessControl.FileSystemRights]::FullControl
    $read = [System.Security.AccessControl.FileSystemRights]::Read
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $acl.SetOwner($administrators)
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, $full, $allow)))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($administrators, $full, $allow)))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($localService, $read, $allow)))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Protect-NewDataDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][bool]$AllowServiceWrite
    )

    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    $system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18')
    $administrators = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $localService = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-19')
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
                   [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $allow = [System.Security.AccessControl.AccessControlType]::Allow
    $full = [System.Security.AccessControl.FileSystemRights]::FullControl
    $serviceRights = if ($AllowServiceWrite) {
        [System.Security.AccessControl.FileSystemRights]::Modify
    } else {
        [System.Security.AccessControl.FileSystemRights]::ReadAndExecute
    }
    $acl.SetOwner($administrators)
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, $full, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, $allow)))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($administrators, $full, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, $allow)))
    $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($localService, $serviceRights, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, $allow)))
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Wait-ForPostgres {
    param([Parameter(Mandatory = $true)][string]$PgIsReady)

    $deadline = [DateTime]::UtcNow.AddMinutes(3)
    do {
        $probe = Start-Process -FilePath $PgIsReady -ArgumentList @('-h', '127.0.0.1', '-p', '5432', '-U', 'postgres') -Wait -PassThru -NoNewWindow
        if ($probe.ExitCode -eq 0) { return }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'PostgreSQL no quedó disponible en 127.0.0.1:5432 dentro del tiempo esperado.'
}

$rootExisted = Test-Path -LiteralPath $DataRoot -PathType Container
if (-not $rootExisted) {
    [void](New-Item -ItemType Directory -Path $DataRoot -Force)
    Protect-NewDataDirectory -Path $DataRoot -AllowServiceWrite $false
}
foreach ($directory in @($configDir, $licenseDir, (Join-Path $DataRoot 'PostgreSQL'), $clinicalFilesDir, $backupDir, $logsDir)) {
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        [void](New-Item -ItemType Directory -Path $directory -Force)
        Protect-NewDataDirectory -Path $directory -AllowServiceWrite ($directory -in @($clinicalFilesDir, $backupDir, $logsDir))
    }
}

if (-not (Test-Path -LiteralPath $LicensePublicKey -PathType Leaf)) {
    throw "No se encuentra la clave pública del emisor: $LicensePublicKey"
}
if (-not (Test-Path -LiteralPath $BootstrapSql -PathType Leaf) -or (Get-Item -LiteralPath $BootstrapSql).Length -lt 1024) {
    throw 'No se encuentra el bootstrap SQL completo y validado para SIGEMED.'
}
$bootstrapText = [System.IO.File]::ReadAllText($BootstrapSql)
foreach ($requiredTable in @(
    'users',
    'patients',
    'doctors',
    'appointments',
    'medical_consultations',
    'roles',
    'user_roles',
    'soap_subjective',
    'soap_objective',
    'soap_assessment',
    'soap_plan',
    'soap_audit_logs'
)) {
    if ($bootstrapText -notmatch "(?im)^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?`"?$([Regex]::Escape($requiredTable))`"?\s*\(") {
        throw "El bootstrap SQL no declara la tabla '$requiredTable'; no se generará un instalador para una base incompleta."
    }
}

$postgresService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
$databaseAlreadyExists = $false
if ($postgresService) {
    if ($postgresService.Status -ne 'Running') {
        Start-Service -Name $serviceName
        $postgresService.WaitForStatus('Running', [TimeSpan]::FromMinutes(2))
    }
    $databaseAlreadyExists = $true
} else {
    if (Test-Path -LiteralPath $postgresData) {
        throw "Hay un directorio de datos PostgreSQL sin el servicio esperado. Se detiene la instalación para protegerlo: $postgresData"
    }
    if (-not (Test-Path -LiteralPath $PostgresInstaller -PathType Leaf)) {
        throw "No se encuentra el instalador PostgreSQL incluido: $PostgresInstaller"
    }

    $postgresSuperPassword = New-RandomHexSecret -ByteCount 48
    # EDB recibe la contraseña de superusuario en su línea de comandos durante la instalación;
    # el valor es aleatorio, no se registra en archivos y solo se usa para crear el rol de aplicación.
    $arguments = @(
        '--mode', 'unattended',
        '--unattendedmodeui', 'none',
        '--superpassword', $postgresSuperPassword,
        '--serverport', '5432',
        '--servicename', $serviceName,
        '--prefix', "`"$postgresProgramFiles`"",
        '--datadir', "`"$postgresData`""
    )
    Invoke-CheckedProcess -FilePath $PostgresInstaller -ArgumentList $arguments `
        -FailureMessage 'El instalador EDB de PostgreSQL falló'
    $postgresService = Get-Service -Name $serviceName -ErrorAction Stop
    if ($postgresService.Status -ne 'Running') {
        Start-Service -Name $serviceName
        $postgresService.WaitForStatus('Running', [TimeSpan]::FromMinutes(2))
    }
    $postgresConfig = Join-Path $postgresData 'postgresql.conf'
    if (-not (Test-Path -LiteralPath $postgresConfig -PathType Leaf)) {
        throw "No se encuentra la configuración de PostgreSQL recién instalada: $postgresConfig"
    }
    $configText = [System.IO.File]::ReadAllText($postgresConfig)
    if ($configText -match '(?m)^\s*#?\s*listen_addresses\s*=') {
        $configText = [Regex]::Replace($configText, '(?m)^\s*#?\s*listen_addresses\s*=.*$', "listen_addresses = '127.0.0.1'")
    } else {
        $configText += "`r`nlisten_addresses = '127.0.0.1'`r`n"
    }
    [System.IO.File]::WriteAllText($postgresConfig, $configText, (New-Object System.Text.UTF8Encoding($false)))
    Restart-Service -Name $serviceName
    $postgresService = Get-Service -Name $serviceName
    $postgresService.WaitForStatus('Running', [TimeSpan]::FromMinutes(2))
}

$pgIsReady = Join-Path $postgresBin 'pg_isready.exe'
$psql = Join-Path $postgresBin 'psql.exe'
$createdb = Join-Path $postgresBin 'createdb.exe'
foreach ($tool in @($pgIsReady, $psql, $createdb)) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) {
        throw "La instalación PostgreSQL no contiene la herramienta requerida: $tool"
    }
}
Wait-ForPostgres -PgIsReady $pgIsReady

if (-not $databaseAlreadyExists) {
    $appPassword = New-RandomHexSecret -ByteCount 48
    $env:PGPASSWORD = $postgresSuperPassword
    try {
        $roleQuery = "SELECT 1 FROM pg_roles WHERE rolname = '$appRole'"
        $roleCheck = & $psql -X -h 127.0.0.1 -p 5432 -U postgres -d postgres -tAc $roleQuery
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo comprobar el rol SIGEMED en PostgreSQL.' }
        if ($roleCheck.Trim()) {
            throw 'El rol sigemed_app ya existe, pero la base SIGEMED no se detectó. Se aborta para evitar modificar datos preexistentes.'
        }

        $quotedPassword = $appPassword.Replace("'", "''")
        $createRoleSql = "CREATE ROLE $appRole LOGIN PASSWORD '$quotedPassword'"
        $createRoleOutput = & $psql -X -h 127.0.0.1 -p 5432 -U postgres -d postgres -v ON_ERROR_STOP=1 -c $createRoleSql
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el usuario local de aplicación.' }

        $createDatabase = Start-Process -FilePath $createdb `
            -ArgumentList @('-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-O', $appRole, $databaseName) `
            -Wait -PassThru -NoNewWindow
        if ($createDatabase.ExitCode -ne 0) { throw 'No se pudo crear la base SIGEMED.' }

        $env:PGPASSWORD = $appPassword
        $env:PGCLIENTENCODING = 'UTF8'
        $bootstrapOutput = & $psql -X -h 127.0.0.1 -p 5432 -U $appRole -d $databaseName `
            -v ON_ERROR_STOP=1 -f $BootstrapSql
        if ($LASTEXITCODE -ne 0) { throw 'El bootstrap SQL falló; no se iniciará el servicio SIGEMED.' }
        Write-Output $bootstrapOutput
    } catch {
        Write-Error "La inicialización de la base falló. No se borró la base, el rol ni el directorio de datos. $($_.Exception.Message)"
        throw
    } finally {
        Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
        Remove-Item Env:\PGCLIENTENCODING -ErrorAction SilentlyContinue
    }
} else {
    Write-Output 'Se detectó el servicio PostgreSQL existente. No se ejecutará DDL, no se reinicializará ni se sobrescribirá la base.'
}

$publicKeyDestination = Join-Path $configDir 'license-public.pem'
if (-not (Test-Path -LiteralPath $publicKeyDestination)) {
    Copy-Item -LiteralPath $LicensePublicKey -Destination $publicKeyDestination
    Set-ProtectedFileAcl -Path $publicKeyDestination
}

if (-not (Test-Path -LiteralPath $envFile)) {
    if (-not $appPassword) {
        throw 'No se puede crear una configuración nueva al reutilizar una base existente. Preserve/import la configuración previa antes de reinstalar.'
    }
    $sessionSecret = New-RandomHexSecret -ByteCount 48
    $configuration = @"
NODE_ENV=production
PORT=3000
SESSION_SECRET=$sessionSecret
DB_USER=$appRole
DB_PASSWORD=$appPassword
DB_HOST=127.0.0.1
DB_PORT=5432
DB_DATABASE=$databaseName
SIGEMED_LICENSE_ENFORCEMENT=true
SIGEMED_LICENSE_PUBLIC_KEY_PATH=$publicKeyDestination
SIGEMED_LICENSE_STATE_DIR=$licenseDir
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=SIGEMED <no-reply@example.com>
"@
    [System.IO.File]::WriteAllText($envFile, $configuration, (New-Object System.Text.UTF8Encoding($false)))
    Set-ProtectedFileAcl -Path $envFile
} else {
    Write-Output 'Se conserva la configuración local existente; no se reemplaza el archivo .env.'
}

if ((-not (Test-Path -LiteralPath $serviceExe -PathType Leaf)) -or
    (-not (Test-Path -LiteralPath $serviceXml -PathType Leaf))) {
    throw 'No se encuentran el supervisor WinSW y su configuración incluidos.'
}

$existingAppService = Get-Service -Name 'SIGEMED' -ErrorAction SilentlyContinue
if ($existingAppService) {
    if ($existingAppService.Status -ne 'Stopped') {
        Stop-Service -Name 'SIGEMED' -Force
        $existingAppService.WaitForStatus('Stopped', [TimeSpan]::FromMinutes(2))
    }
    & $serviceExe uninstall
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo actualizar el registro del servicio SIGEMED.' }
}

& $serviceExe install
if ($LASTEXITCODE -ne 0) { throw 'No se pudo registrar el servicio SIGEMED.' }
& $serviceExe start
if ($LASTEXITCODE -ne 0) { throw 'No se pudo iniciar el servicio SIGEMED.' }
Write-Output 'Servicio SIGEMED instalado. La base clínica y el estado de licencia están fuera del área reemplazable del programa.'
'@

    Set-Content -LiteralPath $Destination -Value $content -Encoding UTF8
}

if ($env:OS -ne 'Windows_NT') {
    throw 'Este empaquetador debe ejecutarse en Windows x64.'
}
if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'SIGEMED para PC requiere Windows x64.'
}

$repo = (Resolve-Path -LiteralPath $RepositoryRoot).Path

# Resolve optional vendor artifacts; if missing, the build will create a payload but skip including those binaries.
if ($PostgreSqlInstallerPath) {
    $postgresInstaller = Resolve-ExistingFile -Path $PostgreSqlInstallerPath -Description 'Instalador de PostgreSQL'
    if ($PostgreSqlInstallerSha256) { Assert-Sha256 -Path $postgresInstaller -Expected $PostgreSqlInstallerSha256 -Description 'Instalador PostgreSQL' }
} else {
    Write-Warning 'No se proporcionó instalador PostgreSQL; el paquete final no incluirá PostgreSQL. Proporcione -PostgreSqlInstallerPath para incluirlo.'
}

# Determine bootstrap SQL: prefer explicit param, otherwise use repository/database/schema.sql when available
if (-not $DatabaseBootstrapSql) {
    $candidate = Join-Path $RepositoryRoot 'database\schema.sql'
    if (Test-Path -LiteralPath $candidate) {
        Write-Host "Usando $candidate como sigemed-bootstrap.sql por defecto."
        $DatabaseBootstrapSql = $candidate
    } else {
        Write-Warning 'No se proporcionó bootstrap SQL y no se encontró database\schema.sql en el repositorio. El instalador no contendrá DDL.'
    }
}

if ($DatabaseBootstrapSql) {
    $bootstrapSql = Resolve-ExistingFile -Path $DatabaseBootstrapSql -Description 'Bootstrap SQL validado'
    if ((Get-Item -LiteralPath $bootstrapSql).Length -lt 1024) {
        throw 'El bootstrap SQL parece incompleto (mínimo 1 KB). No se genera un paquete sin DDL base validado.'
    }
    Assert-DatabaseBootstrapSchema -Path $bootstrapSql
}

if ($LicensePublicKeyPath) {
    $licenseKey = Resolve-ExistingFile -Path $LicensePublicKeyPath -Description 'Clave pública de licencias'
} else {
    Write-Warning 'No se proporcionó clave pública de licencias; el instalador no incluirá license-public.pem.'
}

if ($WinSWPath) {
    $winSw = Resolve-ExistingFile -Path $WinSWPath -Description 'WinSW'
    if ($WinSWSha256) { Assert-Sha256 -Path $winSw -Expected $WinSWSha256 -Description 'WinSW' }
} else {
    Write-Warning 'No se proporcionó WinSW; el paquete no incluirá un wrapper de servicio.'
}

$iscc = Resolve-InnoSetupCompiler -PreferredPath $InnoSetupCompilerPath


$nodeArchive = Join-Path ([IO.Path]::GetTempPath()) $script:NodeArchiveName
if (-not (Test-Path -LiteralPath $nodeArchive)) {
    Invoke-WebRequest -Uri $script:NodeArchiveUrl -OutFile $nodeArchive
}
Assert-Sha256 -Path $nodeArchive -Expected $script:NodeArchiveSha256 -Description "Node.js $($script:NodeVersion)"

$output = [IO.Path]::GetFullPath($OutputDirectory)
[void](New-Item -ItemType Directory -Path $output -Force)
$buildId = Get-Date -Format 'yyyyMMdd-HHmmss'
$work = Join-Path ([IO.Path]::GetTempPath()) "SIGEMED-build-$buildId-$([Guid]::NewGuid().ToString('N'))"
$payload = Join-Path $work 'payload'
$appPayload = Join-Path $payload 'app'
$nodeRoot = Join-Path $appPayload "runtime\node-v$($script:NodeVersion)-win-x64"
[void](New-Item -ItemType Directory -Path $nodeRoot -Force)

try {
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath (Join-Path $work 'node-unpack') -Force
    $nodeExtracted = Join-Path (Join-Path $work 'node-unpack') "node-v$($script:NodeVersion)-win-x64"
    if (-not (Test-Path -LiteralPath (Join-Path $nodeExtracted 'node.exe'))) {
        throw "El ZIP de Node.js no contiene el runtime esperado: $nodeExtracted"
    }
    Copy-Item -Path (Join-Path $nodeExtracted '*') -Destination $nodeRoot -Recurse -Force

    $robocopy = Join-Path $env:SystemRoot 'System32\robocopy.exe'
    $copyArgs = @(
        $repo, $appPayload, '/E', '/COPY:DAT', '/DCOPY:DAT', '/R:2', '/W:1',
        '/XD', '.git', 'node_modules', 'coverage', 'test', 'tests', '.github', 'installer',
        '/XF', '.env', '.env.*', 'npm-debug.log*'
    )
    & $robocopy @copyArgs | Out-Host
    if ($LASTEXITCODE -ge 8) { throw "Robocopy falló al preparar la aplicación (código $LASTEXITCODE)." }

    $packageJson = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
    if ($packageJson.engines.node -notmatch '>=\s*20') {
        throw 'La versión de Node.js empaquetada no satisface la versión mínima declarada en package.json.'
    }
    $npm = Join-Path $nodeRoot 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npm)) { throw 'El runtime descargado no incluye npm.cmd.' }
    Push-Location -LiteralPath $appPayload
    try {
        & $npm ci --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm ci falló con código $LASTEXITCODE." }
    } finally {
        Pop-Location
    }

    $serviceDirectory = Join-Path $appPayload 'service'
    [void](New-Item -ItemType Directory -Path $serviceDirectory -Force)
    Copy-Item -LiteralPath $winSw -Destination (Join-Path $serviceDirectory 'SIGEMED.exe')
    $serviceXml = @'
<service>
  <id>SIGEMED</id>
  <name>SIGEMED</name>
  <description>Sistema local de gestión clínica SIGEMED</description>
  <executable>%BASE%\runtime\node-v24.21.0-win-x64\node.exe</executable>
  <arguments>"%BASE%\index.js"</arguments>
  <workingdirectory>%BASE%</workingdirectory>
  <serviceaccount>
  <username>NT AUTHORITY\LocalService</username>
  <allowservicelogon>true</allowservicelogon>
  </serviceaccount>
  <startmode>Automatic</startmode>
  <stoptimeout>30 sec</stoptimeout>
  <onfailure action="restart" delay="5 sec" />
  <onfailure action="restart" delay="15 sec" />
  <onfailure action="none" />
  <logpath>%ProgramData%\SIGEMED\Logs</logpath>
  <log mode="roll">
    <sizeThreshold>10485760</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
</service>
'@
    Set-Content -LiteralPath (Join-Path $serviceDirectory 'SIGEMED.xml') -Value $serviceXml -Encoding UTF8

    $installerDirectory = Join-Path $appPayload 'installer'
    [void](New-Item -ItemType Directory -Path $installerDirectory -Force)
    New-InstallRuntimeScript -Destination (Join-Path $installerDirectory 'install-runtime.ps1')

    $configDirectory = Join-Path $appPayload 'config'
    [void](New-Item -ItemType Directory -Path $configDirectory -Force)
    if ($licenseKey) {
        Copy-Item -LiteralPath $licenseKey -Destination (Join-Path $configDirectory 'license-public.pem')
    } else {
        Write-Warning 'No se incluyó license-public.pem en la carga útil.'
    }

    if ($postgresInstaller) {
        Copy-Item -LiteralPath $postgresInstaller -Destination (Join-Path $payload 'postgresql-18.6-windows-x64.exe')
    } else {
        Write-Warning 'No se incluyó el instalador de PostgreSQL en la carga útil.'
    }

    if ($bootstrapSql) {
        Copy-Item -LiteralPath $bootstrapSql -Destination (Join-Path $payload 'sigemed-bootstrap.sql')
    } else {
        Write-Warning 'No se incluyó sigemed-bootstrap.sql en la carga útil.'
    }

    $env:SIGEMED_PAYLOAD_DIR = $payload
    $setupFile = Join-Path $PSScriptRoot 'setup.iss'
    $installerOutput = Join-Path $output "SIGEMED-Setup-$buildId.exe"

    if (-not (Test-Path -LiteralPath $iscc -PathType Leaf)) {
        Write-Warning 'Compilador Inno Setup (ISCC.exe) no encontrado. Se ha preparado la carga útil en dist\ pero no se pudo compilar el instalador final.'
        Write-Output "Payload preparado en: $payload"
    } else {
        & $iscc "/O$(Split-Path -Parent $installerOutput)" "/F$([IO.Path]::GetFileNameWithoutExtension($installerOutput))" $setupFile
        if ($LASTEXITCODE -ne 0) { throw "ISCC terminó con código $LASTEXITCODE." }
        Write-Output "Instalador generado: $installerOutput"
        Write-Output "PostgreSQL incluido: $($script:PostgreSqlVersion); Node.js LTS incluido: $($script:NodeVersion)."
    }
} finally {
    Remove-Item Env:\SIGEMED_PAYLOAD_DIR -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $work) {
        Remove-Item -LiteralPath $work -Recurse -Force
    }
}
