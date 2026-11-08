param(
  [Parameter(Mandatory=$true)][string]$Uri,
  [Parameter(Mandatory=$true)][string]$Destination,
  [Parameter(Mandatory=$true)][long]$ExpectedSize,
  [string]$MirrorHost = ''
)
$ErrorActionPreference = 'Stop'
$allowed = @('github.com','release-assets.githubusercontent.com','objects.githubusercontent.com')
if ($MirrorHost) { $allowed += $MirrorHost }
for ($attempt = 0; $attempt -lt 3; $attempt++) {
  try {
    [long]$offset = 0
    if (Test-Path -LiteralPath $Destination) { $offset = (Get-Item -LiteralPath $Destination).Length }
    if ($offset -gt $ExpectedSize) { Remove-Item -LiteralPath $Destination; $offset = 0 }
    if ($offset -eq $ExpectedSize) { exit 0 }
    $target = [Uri]$Uri
    for ($redirect = 0; $redirect -lt 6; $redirect++) {
      if ($target.Scheme -ne 'https' -or $target.UserInfo -or $target.Port -ne 443 -or $target.Host -notin $allowed) { throw 'Invalid public package redirect' }
      $request = [System.Net.HttpWebRequest]::Create($target)
      $request.AllowAutoRedirect = $false
      $request.Timeout = 20000
      $request.ReadWriteTimeout = 30000
      $request.UserAgent = 'dsh-shiguang'
      if ($offset -gt 0) { $request.AddRange($offset) }
      $response = $request.GetResponse()
      if ([int]$response.StatusCode -in @(301,302,303,307,308)) {
        $next = $response.Headers['Location']; $response.Close()
        if (!$next) { throw 'Missing redirect' }
        $target = New-Object Uri($target, $next)
        continue
      }
      break
    }
    if ($redirect -ge 6) { throw 'Too many redirects' }
    if ($offset -gt 0 -and [int]$response.StatusCode -eq 206) {
      $expected = '^bytes ' + $offset + '-[0-9]+/' + $ExpectedSize + '$'
      if ($response.Headers['Content-Range'] -notmatch $expected) { throw 'Invalid byte range' }
    } else { $offset = 0 }
    $mode = if ($offset -gt 0) { [IO.FileMode]::Append } else { [IO.FileMode]::Create }
    $file = New-Object IO.FileStream($Destination,$mode,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try {
      $stream = $response.GetResponseStream(); $buffer = New-Object byte[] 65536
      [long]$size = $offset
      while (($count = $stream.Read($buffer,0,$buffer.Length)) -gt 0) {
        $size += $count
        if ($size -gt $ExpectedSize) { throw 'Package exceeds declared size' }
        $file.Write($buffer,0,$count)
      }
      if ($size -ne $ExpectedSize) { throw 'Incomplete package' }
    } finally { $file.Dispose(); $response.Close() }
    exit 0
  } catch { if ($attempt -ge 2) { throw }; Start-Sleep -Milliseconds 300 }
}
