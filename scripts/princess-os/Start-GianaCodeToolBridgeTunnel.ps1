[CmdletBinding()]
param(
  [int]$VmId = 900,
  [int]$Port = 18644
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-SshExecutable {
  $command = Get-Command ssh.exe -ErrorAction Stop
  return $command.Source
}

function Invoke-SshCapture {
  param([string[]]$Arguments)
  $sshArguments = @(
    '-o', 'ConnectionAttempts=1',
    '-o', 'ServerAliveInterval=2',
    '-o', 'ServerAliveCountMax=2'
  ) + @($Arguments)
  $output = & $script:SshPath @sshArguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "SSH command failed with exit code $LASTEXITCODE"
  }
  return @($output | ForEach-Object { [string]$_ })
}

function Get-GianaOsVmAddress {
  $config = Invoke-SshCapture @(
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    'r5300', "qm config $VmId"
  )
  $match = [regex]::Match(($config -join "`n"), 'net0:\s+\S+=([0-9A-Fa-f:]{17})')
  if (-not $match.Success) {
    throw "Unable to resolve VM $VmId MAC address"
  }
  $mac = $match.Groups[1].Value.ToLowerInvariant()
  $neighbours = Invoke-SshCapture @(
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    'r5300', 'ip neigh show'
  )
  foreach ($line in $neighbours) {
    if ($line.ToLowerInvariant().Contains("lladdr $mac") -and -not $line.Contains('FAILED')) {
      $address = ($line -split '\s+')[0]
      $parsed = $null
      if ([System.Net.IPAddress]::TryParse($address, [ref]$parsed)) {
        return $address
      }
    }
  }
  throw "Unable to resolve the current address for VM $VmId"
}

function Test-LocalOuterTunnel {
  $needle = "127.0.0.1:$Port`:127.0.0.1:$Port"
  $processes = Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" -ErrorAction SilentlyContinue
  foreach ($process in $processes) {
    $line = [string]$process.CommandLine
    if ($line.Contains($needle) -and $line.Contains('r5300')) {
      return $true
    }
  }
  return $false
}

function Test-VmListener {
  param([string]$VmAddress)
  $arguments = @(
    '-o', 'ConnectionAttempts=1',
    '-o', 'ServerAliveInterval=2',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    'r5300',
    'ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    "debian@$VmAddress", 'ss', '-H', '-ltn'
  )
  $output = & $script:SshPath @arguments 2>$null
  if ($LASTEXITCODE -ne 0) { return $false }
  return (($output | Out-String) -match "127\.0\.0\.1:$Port")
}

function Test-VmEndToEndRoute {
  param([string]$VmAddress)
  $arguments = @(
    '-o', 'ConnectionAttempts=1',
    '-o', 'ServerAliveInterval=2',
    '-o', 'ServerAliveCountMax=2',
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    'r5300',
    'ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    "debian@$VmAddress",
    'curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'POST',
    "http://127.0.0.1:$Port/mcp/tool-runtime"
  )
  $output = & $script:SshPath @arguments 2>$null
  if ($LASTEXITCODE -ne 0) { return $false }
  return (($output | Out-String).Trim() -eq '401')
}

$script:SshPath = Get-SshExecutable
$vmAddress = Get-GianaOsVmAddress

# The VM listener can outlive the outer PRDG -> R5300 tunnel. Treat the chain
# as reusable only while both forwarding hops are still present.
if ((Test-LocalOuterTunnel) -and (Test-VmListener $vmAddress) -and (Test-VmEndToEndRoute $vmAddress)) {
  [pscustomobject]@{
    state = 'READY'
    vmId = $VmId
    port = $Port
    scope = 'numeric-loopback-only'
  } | ConvertTo-Json -Compress
  exit 0
}

if (-not (Test-LocalOuterTunnel)) {
  $arguments = @(
    '-N', '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-R', "127.0.0.1:$Port`:127.0.0.1:$Port",
    'r5300'
  )
  Start-Process -FilePath $script:SshPath -ArgumentList $arguments -WindowStyle Hidden | Out-Null
  Start-Sleep -Milliseconds 750
}

$innerCommand = @(
  # Keep candidate ports independent from the preserved runtime bridge.
  'nohup', 'flock', '-n', "/tmp/giana-code-tool-bridge-vm$VmId-port$Port.lock",
  'ssh', '-N', '-T',
  '-o', 'BatchMode=yes',
  '-o', 'ExitOnForwardFailure=yes',
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=3',
  '-R', "127.0.0.1:$Port`:127.0.0.1:$Port",
  "debian@$vmAddress",
  ">/tmp/giana-code-tool-bridge-vm$VmId-port$Port.log", '2>&1', '</dev/null', '&'
) -join ' '

$outerArguments = @(
  '-o', 'ConnectionAttempts=1',
  '-o', 'ServerAliveInterval=2',
  '-o', 'ServerAliveCountMax=2',
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
  'r5300', $innerCommand
)
& $script:SshPath @outerArguments 2>$null
if ($LASTEXITCODE -ne 0) {
  throw 'Unable to start the R5300 to GianaOS VM tool bridge'
}

$deadline = [DateTime]::UtcNow.AddSeconds(20)
do {
  if ((Test-LocalOuterTunnel) -and (Test-VmListener $vmAddress) -and (Test-VmEndToEndRoute $vmAddress)) {
    [pscustomobject]@{
      state = 'READY'
      vmId = $VmId
      port = $Port
      scope = 'numeric-loopback-only'
    } | ConvertTo-Json -Compress
    exit 0
  }
  Start-Sleep -Milliseconds 500
} while ([DateTime]::UtcNow -lt $deadline)

throw 'GianaOS VM tool bridge listener did not become ready'
