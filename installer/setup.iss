#define AppName "SIGEMED"
#define AppVersion "1.0.0"
#define AppPublisher "SIGEMED C.A."
#define PayloadDir GetEnv("SIGEMED_PAYLOAD_DIR")

[Setup]
AppId={{A5E4CB0F-B4D6-44A1-9B3D-3DA4E5B6318C}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\SIGEMED
DefaultGroupName=SIGEMED
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
OutputBaseFilename=SIGEMED-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
Uninstallable=yes
CloseApplications=yes
RestartApplications=no
UsePreviousAppDir=yes
UsePreviousTasks=yes
UninstallDisplayName=SIGEMED
SetupLogging=yes
; Company signing should be enabled in the release pipeline with a managed signing key.

[Languages]
Name: "spanish"; MessagesFile: "compiler:Languages\Spanish.isl"

[Tasks]
Name: "desktopicon"; Description: "Crear un acceso directo en el escritorio"; GroupDescription: "Accesos directos:"; Flags: unchecked

[Files]
Source: "{#PayloadDir}\app\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: ".env"
Source: "{#PayloadDir}\postgresql-18.6-windows-x64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall
Source: "{#PayloadDir}\sigemed-bootstrap.sql"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Icons]
Name: "{autoprograms}\SIGEMED"; Filename: "{sys}\rundll32.exe"; Parameters: "url.dll,FileProtocolHandler http://127.0.0.1:3000"
Name: "{autodesktop}\SIGEMED"; Filename: "{sys}\rundll32.exe"; Parameters: "url.dll,FileProtocolHandler http://127.0.0.1:3000"; Tasks: desktopicon
Name: "{autoprograms}\Administrar servicio SIGEMED"; Filename: "{sys}\services.msc"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
    Parameters: "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\installer\install-runtime.ps1"" -PostgresInstaller ""{tmp}\postgresql-18.6-windows-x64.exe"" -BootstrapSql ""{tmp}\sigemed-bootstrap.sql"" -InstallRoot ""{app}"" -DataRoot ""{commonappdata}\SIGEMED"" -LicensePublicKey ""{app}\config\license-public.pem"""; \
    StatusMsg: "Configurando PostgreSQL local y el servicio SIGEMED..."; \
    Flags: runhidden waituntilterminated

[Code]
function InitializeSetup(): Boolean;
begin
  Result := IsWin64;
  if not Result then
    MsgBox('SIGEMED requiere Windows de 64 bits.', mbCriticalError, MB_OK);
  if GetEnv('SIGEMED_PAYLOAD_DIR') = '' then
  begin
    MsgBox('No se definió SIGEMED_PAYLOAD_DIR. Genere el paquete mediante build-windows.ps1.', mbCriticalError, MB_OK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  ServiceWrapper: String;
begin
  Result := '';
  ServiceWrapper := ExpandConstant('{app}\service\SIGEMED.exe');
  if FileExists(ServiceWrapper) then
  begin
    if not Exec(ServiceWrapper, 'stop', ExpandConstant('{app}\service'), SW_HIDE,
      ewWaitUntilTerminated, ResultCode) then
      Result := 'No se pudo ejecutar el supervisor SIGEMED para detener el servicio. No se continuará la actualización.'
    else
    begin
      if (ResultCode <> 0) and (ResultCode <> 1062) then
        Result := 'No se pudo detener el servicio SIGEMED de forma segura. No se continuará la actualización.';
    end;
  end;
end;

function InitializeUninstall(): Boolean;
var
  ResultCode: Integer;
  ServiceWrapper: String;
begin
  Result := True;
  ServiceWrapper := ExpandConstant('{app}\service\SIGEMED.exe');
  if FileExists(ServiceWrapper) then
  begin
    if not Exec(ServiceWrapper, 'stop', ExpandConstant('{app}\service'), SW_HIDE,
      ewWaitUntilTerminated, ResultCode) then
      Result := False
    else if (ResultCode <> 0) and (ResultCode <> 1062) then
      Result := False;

    if Result then
    begin
      if not Exec(ServiceWrapper, 'uninstall', ExpandConstant('{app}\service'), SW_HIDE,
        ewWaitUntilTerminated, ResultCode) or (ResultCode <> 0) then
        Result := False;
    end;
  end;
  if not Result then
    MsgBox('No se pudo detener o retirar el servicio SIGEMED. La desinstalación se canceló y los archivos se conservaron.', mbError, MB_OK);
end;
